/**
 * 图片/视频保存服务 — 依据「设置 → 图片保存」写入磁盘
 * PNG 保存可选嵌入元信息（提示词/模型/seed/时间）到 iTXt 文本块，纯字节操作不重编码图像。
 */
import type { SaveCfg } from "../types";
import { buildFilename, convertImage, dataUrlToBytes, imageSizeMeta, isTauri, toDataUrl, type FilenameMeta } from "../utils";
import { xfetch } from "./http";

export type SaveMeta = { prompt?: string; model?: string; seed?: string | number };

/* ---------------- PNG 元信息（iTXt 文本块） ---------------- */

/** CRC32（PNG chunk 校验用，标准多项式 0xEDB88320） */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, from: number, len: number): number {
  let c = 0xffffffff;
  for (let i = from; i < from + len; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 把元信息（时间/提示词/模型/seed）嵌进 PNG 字节流的 iTXt 文本块（插在第一个 IDAT 之前）。
 * iTXt 支持 UTF-8（中文提示词不损坏）；纯字节操作不重编码图像数据，画质零损失、体积增量可忽略。
 * 非 PNG 或结构异常 → 原样返回（静默降级，不阻塞保存）。
 */
export function embedPngMeta(png: Uint8Array, meta: SaveMeta): Uint8Array {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.length < 40) return png;
  for (let i = 0; i < 8; i++) if (png[i] !== SIG[i]) return png;
  // 定位第一个 IDAT：8 字节签名后依次 chunk（len[4] type[4] data[len] crc[4]）
  let idatAt = -1;
  let off = 8;
  while (off + 8 <= png.length) {
    const len = new DataView(png.buffer, png.byteOffset + off, 4).getUint32(0, false);
    const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
    if (type === "IDAT") {
      idatAt = off;
      break;
    }
    off += 12 + len;
  }
  if (idatAt < 0) return png;

  const te = new TextEncoder();
  const fields: [string, string][] = [["momo-time", String(Date.now())]];
  if (meta.prompt) fields.push(["momo-prompt", meta.prompt]);
  if (meta.model) fields.push(["momo-model", meta.model]);
  if (meta.seed !== undefined && meta.seed !== "") fields.push(["momo-seed", String(meta.seed)]);

  const chunks: Uint8Array[] = [];
  for (const [kw, text] of fields) {
    const kwB = te.encode(kw);
    const txtB = te.encode(text);
    // iTXt：keyword\0 + compressionFlag(1) + compressionMethod(1) + languageTag\0 + translatedKeyword\0 + text
    const data = new Uint8Array(kwB.length + 5 + txtB.length);
    let p = 0;
    data.set(kwB, p);
    p += kwB.length;
    data[p++] = 0; // keyword 结束符
    data[p++] = 0; // compressionFlag（不压缩）
    data[p++] = 0; // compressionMethod
    data[p++] = 0; // languageTag 空串
    data[p++] = 0; // translatedKeyword 空串
    data.set(txtB, p);
    const chunk = new Uint8Array(12 + data.length);
    new DataView(chunk.buffer).setUint32(0, data.length, false);
    chunk[4] = 0x69; // 'i'
    chunk[5] = 0x54; // 'T'
    chunk[6] = 0x58; // 'X'
    chunk[7] = 0x74; // 't'
    chunk.set(data, 8);
    new DataView(chunk.buffer).setUint32(8 + data.length, crc32(chunk, 4, 4 + data.length), false);
    chunks.push(chunk);
  }

  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(png.length + total);
  out.set(png.subarray(0, idatAt), 0);
  let q = idatAt;
  for (const c of chunks) {
    out.set(c, q);
    q += c.length;
  }
  out.set(png.subarray(idatAt), q);
  return out;
}

async function ensureDataUrl(src: string): Promise<string> {
  // 已生成的结果图下载放宽超时（慢线路 4K 大图 90 秒可能不够）
  return toDataUrl(src, (u, i) => xfetch(u as string, i, { timeoutMs: 300_000 }));
}

/** 自动保存（需已设置保存目录）；返回完整路径。{n} 序号同前缀依次递增 */
export async function autoSaveImage(src: string, cfg: SaveCfg, meta: SaveMeta = {}): Promise<string> {
  if (!isTauri) throw new Error("浏览器预览模式不支持写盘保存");
  if (!cfg.dir) throw new Error("请先在「设置 → 图片保存」中选择保存文件夹");
  const { writeFile, mkdir, exists } = await import("@tauri-apps/plugin-fs");
  if (!(await exists(cfg.dir))) await mkdir(cfg.dir, { recursive: true });
  const dataUrl = await convertImage(await ensureDataUrl(src), cfg.format);
  const full: FilenameMeta = { ...meta, ...(await imageSizeMeta(dataUrl)) };
  const ext = cfg.format === "jpeg" ? "jpg" : cfg.format;
  let path = "";
  if (cfg.pattern.includes("{n}")) {
    // 显式序号：同前缀找到第一个不存在的编号
    for (let i = 1; ; i++) {
      path = `${cfg.dir}\\${buildFilename(cfg.pattern, { ...full, n: i })}.${ext}`;
      if (!(await exists(path))) break;
    }
  } else {
    path = `${cfg.dir}\\${buildFilename(cfg.pattern, full)}.${ext}`;
    for (let i = 2; await exists(path); i++) {
      path = `${cfg.dir}\\${buildFilename(cfg.pattern, full)}_${i}.${ext}`;
    }
  }
  const raw = dataUrlToBytes(dataUrl);
  await writeFile(path, cfg.format === "png" && cfg.embedMeta ? embedPngMeta(raw, meta) : raw);
  return path;
}

/** 手动另存为（弹出系统保存框）；返回路径，取消返回 null */
export async function saveImageAs(src: string, cfg: SaveCfg, meta: SaveMeta = {}): Promise<string | null> {
  if (!isTauri) {
    // 浏览器兜底：a 标签下载
    const a = document.createElement("a");
    a.href = await ensureDataUrl(src);
    a.download = `${buildFilename(cfg.pattern, meta)}.${cfg.format === "jpeg" ? "jpg" : cfg.format}`;
    a.click();
    return null;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const ext = cfg.format === "jpeg" ? "jpg" : cfg.format;
  const path = await save({
    defaultPath: `${cfg.dir ? cfg.dir + "\\" : ""}${buildFilename(cfg.pattern, meta)}.${ext}`,
    filters: [{ name: "图片", extensions: ["png", "jpg", "webp"] }],
  });
  if (!path) return null;
  const target = (path.split(".").pop() ?? ext).toLowerCase();
  const fmt = target === "jpg" || target === "jpeg" ? "jpeg" : target === "webp" ? "webp" : "png";
  const dataUrl = await convertImage(await ensureDataUrl(src), fmt);
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  const raw = dataUrlToBytes(dataUrl);
  await writeFile(path, fmt === "png" && cfg.embedMeta ? embedPngMeta(raw, meta) : raw);
  return path;
}

/** 保存音频（asset/远程/blob/dataURL → 磁盘） */
export async function saveAudioAs(url: string, cfg: SaveCfg, meta: SaveMeta = {}): Promise<string | null> {
  const fetchBytes = async () => {
    if (url.startsWith("data:")) return dataUrlToBytes(url);
    const resp = url.startsWith("blob:") ? await fetch(url) : await xfetch(url);
    return new Uint8Array(await resp.arrayBuffer());
  };
  const ext = /(\.|\/)(wav)\b/i.test(url) ? "wav" : "mp3";
  if (!isTauri) {
    const a = document.createElement("a");
    a.href = url;
    a.download = `${buildFilename(cfg.pattern, meta)}.${ext}`;
    a.click();
    return null;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: `${cfg.dir ? cfg.dir + "\\" : ""}${buildFilename(cfg.pattern, meta)}.${ext}`,
    filters: [{ name: "音频", extensions: ["mp3", "wav", "m4a", "ogg"] }],
  });
  if (!path) return null;
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  await writeFile(path, await fetchBytes());
  return path;
}

/** 保存视频（远程 url / blob url → 磁盘） */
export async function saveVideoAs(url: string, cfg: SaveCfg, meta: SaveMeta = {}): Promise<string | null> {
  const fetchBytes = async () => {
    const resp = url.startsWith("blob:") ? await fetch(url) : await xfetch(url);
    return new Uint8Array(await resp.arrayBuffer());
  };
  if (!isTauri) {
    const a = document.createElement("a");
    a.href = url;
    a.download = `${buildFilename(cfg.pattern, meta)}.mp4`;
    a.click();
    return null;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: `${cfg.dir ? cfg.dir + "\\" : ""}${buildFilename(cfg.pattern, meta)}.mp4`,
    filters: [{ name: "视频", extensions: ["mp4"] }],
  });
  if (!path) return null;
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  await writeFile(path, await fetchBytes());
  return path;
}
