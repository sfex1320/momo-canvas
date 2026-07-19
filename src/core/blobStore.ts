/**
 * 画布大数据外置存储 — 巨型 dataURL（4K 图等）不再内联进 boards.json。
 * 持久化时把超过阈值的 data: 字符串替换为 momoblob:<hash> 引用、内容写入
 * AppData/blobs/<hash>.txt；载入时回填。否则画布每次改动（拖动/打字都会触发
 * 防抖保存）都要全量序列化几十 MB JSON 再走 IPC 落盘，主线程反复被卡——
 * 这就是「放入 4K 图后整个画布开始抖动/掉帧」的根源。
 * 浏览器预览模式不外置（localStorage 保持原状）。
 */
import { isTauri } from "./utils";

/** 超过该字符数的 data: 字符串才外置（≈150KB 文件） */
const BIG = 200_000;
const REF_PREFIX = "momoblob:";

/** 字符串 → 已算好的 hash（同一引用重复保存时免二次哈希/写盘） */
const hashCache = new Map<string, string>();
/** hash → 原文（载入回填后缓存，保存时也用于判断“已写过”） */
const contentCache = new Map<string, string>();
/** 本会话已确认写到磁盘的 hash */
const written = new Set<string>();

let dirCache: string | null = null;
async function blobsDir(): Promise<string> {
  if (dirCache) return dirCache;
  const { appDataDir, join } = await import("@tauri-apps/api/path");
  const { mkdir, exists } = await import("@tauri-apps/plugin-fs");
  const dir = await join(await appDataDir(), "blobs");
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  dirCache = dir;
  return dir;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

async function ensureWritten(hash: string, content: string): Promise<void> {
  if (written.has(hash)) return;
  const { writeTextFile, exists } = await import("@tauri-apps/plugin-fs");
  const { join } = await import("@tauri-apps/api/path");
  const path = await join(await blobsDir(), `${hash}.txt`);
  if (!(await exists(path))) await writeTextFile(path, content);
  written.add(hash);
  contentCache.set(hash, content);
}

async function readBlob(hash: string): Promise<string | undefined> {
  const hit = contentCache.get(hash);
  if (hit !== undefined) return hit;
  try {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const { join } = await import("@tauri-apps/api/path");
    const content = await readTextFile(await join(await blobsDir(), `${hash}.txt`));
    contentCache.set(hash, content);
    written.add(hash);
    return content;
  } catch {
    return undefined; // 文件丢失：对应图片显示为空，不炸画布
  }
}

/** 深走结构：字符串命中条件时经 fn 替换（异步），其余原样拷贝 */
async function walk(v: unknown, fn: (s: string) => Promise<unknown>): Promise<unknown> {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = await walk(v[i], fn);
    return out;
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = await walk(val, fn);
    return out;
  }
  return v;
}

/** 保存前调用：大 data: 字符串 → momoblob 引用（内容落盘）。非 Tauri 环境原样返回 */
export async function externalizeBoards<T>(shape: T): Promise<T> {
  if (!isTauri) return shape;
  return (await walk(shape, async (s) => {
    if (s.length < BIG || !s.startsWith("data:")) return s;
    let hash = hashCache.get(s);
    if (!hash) {
      hash = await sha256Hex(s);
      hashCache.set(s, hash);
    }
    await ensureWritten(hash, s);
    return REF_PREFIX + hash;
  })) as T;
}

/** 载入后调用：momoblob 引用 → 原文（文件缺失回填 undefined） */
export async function hydrateBoards<T>(shape: T): Promise<T> {
  if (!isTauri) return shape;
  return (await walk(shape, async (s) => {
    if (!s.startsWith(REF_PREFIX)) return s;
    const content = await readBlob(s.slice(REF_PREFIX.length));
    if (content !== undefined) hashCache.set(content, s.slice(REF_PREFIX.length));
    return content;
  })) as T;
}

/** 启动清理：删掉 blobs 目录里已不被 boards.json 引用的文件（画布删图后回收磁盘） */
export async function gcBlobs(shape: unknown): Promise<void> {
  if (!isTauri) return;
  try {
    const used = new Set<string>();
    const scan = (v: unknown) => {
      if (typeof v === "string") {
        if (v.startsWith(REF_PREFIX)) used.add(v.slice(REF_PREFIX.length));
        return;
      }
      if (Array.isArray(v)) for (const x of v) scan(x);
      else if (v && typeof v === "object") for (const x of Object.values(v)) scan(x);
    };
    scan(shape);
    const { readDir, remove } = await import("@tauri-apps/plugin-fs");
    const { join } = await import("@tauri-apps/api/path");
    const dir = await blobsDir();
    for (const ent of await readDir(dir)) {
      if (!ent.isFile || !ent.name.endsWith(".txt")) continue;
      const hash = ent.name.slice(0, -4);
      if (!used.has(hash)) await remove(await join(dir, ent.name));
    }
  } catch (e) {
    console.warn("[blobStore] gc failed", e);
  }
}
