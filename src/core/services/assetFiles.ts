/**
 * 资产文件层 — 落盘、缩略图、格式识别
 * 文件存放：AppData/assets/  缩略图：AppData/assets/thumbs/
 * 浏览器预览模式退化为 blob URL（不落盘）
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import type { AssetKind } from "../types";
import { dataUrlToBytes, isTauri, uid } from "../utils";
import { xfetch } from "./http";

export const EXT_KIND: Record<string, AssetKind> = {
  png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image",
  avif: "image", bmp: "image", svg: "image", ico: "image", tif: "image", tiff: "image",
  mp4: "video", webm: "video", mov: "video", mkv: "video", m4v: "video",
  mp3: "audio", wav: "audio", ogg: "audio", flac: "audio", m4a: "audio", aac: "audio",
  pdf: "pdf",
};

export function kindFromExt(ext: string): AssetKind {
  return EXT_KIND[ext.toLowerCase()] ?? "other";
}

export function mimeFromExt(ext: string): string {
  const e = ext.toLowerCase();
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
    gif: "image/gif", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4",
    pdf: "application/pdf",
  };
  return map[e] ?? "application/octet-stream";
}

export function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
    "image/avif": "avif", "image/bmp": "bmp", "image/svg+xml": "svg",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac",
    "application/pdf": "pdf",
  };
  return map[mime.split(";")[0]] ?? "bin";
}

/** 按文件头魔数识别真实格式 —— 中转站常返回 application/octet-stream，不能只信 mime */
export function sniffExt(bytes: Uint8Array): string | null {
  const at = (i: number, ...sig: number[]) => sig.every((b, k) => bytes[i + k] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp"; // RIFF....WEBP
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x41, 0x56, 0x45)) return "wav"; // RIFF....WAVE
  if (at(0, 0x42, 0x4d)) return "bmp";
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return "pdf"; // %PDF
  if (at(4, 0x66, 0x74, 0x79, 0x70)) return "mp4"; // ....ftyp（mp4/mov 家族按 mp4 处理）
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return "webm";
  if (at(0, 0x49, 0x44, 0x33) || at(0, 0xff, 0xfb)) return "mp3";
  if (at(0, 0x4f, 0x67, 0x67, 0x53)) return "ogg";
  if (at(0, 0x66, 0x4c, 0x61, 0x43)) return "flac";
  return null;
}

/* ---------------- 磁盘目录 ---------------- */
let assetsDirCache: string | null = null;

export async function assetsDir(): Promise<string> {
  if (assetsDirCache) return assetsDirCache;
  const { appDataDir, join } = await import("@tauri-apps/api/path");
  const { mkdir, exists } = await import("@tauri-apps/plugin-fs");
  const root = await appDataDir();
  const dir = await join(root, "assets");
  const thumbs = await join(dir, "thumbs");
  if (!(await exists(thumbs))) await mkdir(thumbs, { recursive: true });
  assetsDirCache = dir;
  return dir;
}

/** 任意来源 → 字节 + mime（dataURL / blob: / http(s) / 已是字节） */
export async function fetchBytes(src: string): Promise<{ bytes: Uint8Array; mime: string }> {
  if (src.startsWith("data:")) {
    const mime = src.match(/^data:([^;]+)/)?.[1] ?? "application/octet-stream";
    return { bytes: dataUrlToBytes(src), mime };
  }
  const resp = src.startsWith("blob:") ? await fetch(src) : await xfetch(src);
  if (!resp.ok) throw new Error(`下载资源失败 ${resp.status}`);
  const mime = resp.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
  return { bytes: new Uint8Array(await resp.arrayBuffer()), mime };
}

export type StoredFile = {
  path: string; // 绝对路径（浏览器模式为 blob URL）
  thumb?: string;
  size: number;
  width?: number;
  height?: number;
};

/** 生成图片缩略图 dataURL（webp, 最长边 360），并带回原始尺寸 */
function makeImageThumb(blobUrl: string): Promise<{ thumb: string; width: number; height: number } | null> {
  return new Promise((res) => {
    const img = new Image();
    const timer = setTimeout(() => res(null), 8000);
    img.onload = () => {
      clearTimeout(timer);
      try {
        const scale = Math.min(1, 360 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.naturalWidth * scale));
        c.height = Math.max(1, Math.round(img.naturalHeight * scale));
        c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
        res({ thumb: c.toDataURL("image/webp", 0.8), width: img.naturalWidth, height: img.naturalHeight });
      } catch {
        res(null);
      }
    };
    img.onerror = () => {
      clearTimeout(timer);
      res(null);
    };
    img.src = blobUrl;
  });
}

/** 抓取视频首帧缩略图 */
function makeVideoThumb(url: string): Promise<{ thumb: string; width: number; height: number } | null> {
  return new Promise((res) => {
    const v = document.createElement("video");
    const timer = setTimeout(() => res(null), 10000);
    v.muted = true;
    v.preload = "auto";
    v.onloadeddata = () => {
      v.currentTime = Math.min(0.3, (v.duration || 1) / 3);
    };
    v.onseeked = () => {
      clearTimeout(timer);
      try {
        const scale = Math.min(1, 360 / Math.max(v.videoWidth, v.videoHeight));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(v.videoWidth * scale));
        c.height = Math.max(1, Math.round(v.videoHeight * scale));
        c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
        res({ thumb: c.toDataURL("image/webp", 0.8), width: v.videoWidth, height: v.videoHeight });
      } catch {
        res(null);
      }
      v.src = "";
    };
    v.onerror = () => {
      clearTimeout(timer);
      res(null);
    };
    v.src = url;
  });
}

/** 把字节写入资产目录并生成缩略图 */
export async function storeAssetFile(bytes: Uint8Array, ext: string, kind: AssetKind): Promise<StoredFile> {
  const mime = mimeFromExt(ext);
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  const blobUrl = URL.createObjectURL(blob);

  if (!isTauri) {
    // 浏览器预览：内存态
    let meta: { thumb: string; width: number; height: number } | null = null;
    if (kind === "image") meta = await makeImageThumb(blobUrl);
    if (kind === "video") meta = await makeVideoThumb(blobUrl);
    return { path: blobUrl, thumb: meta?.thumb, size: bytes.length, width: meta?.width, height: meta?.height };
  }

  const { writeFile } = await import("@tauri-apps/plugin-fs");
  const { join } = await import("@tauri-apps/api/path");
  const dir = await assetsDir();
  const name = `${Date.now()}_${uid(6)}.${ext}`;
  const path = await join(dir, name);
  await writeFile(path, bytes);

  let thumbPath: string | undefined;
  let width: number | undefined;
  let height: number | undefined;
  try {
    let meta: { thumb: string; width: number; height: number } | null = null;
    if (kind === "image") meta = await makeImageThumb(blobUrl);
    if (kind === "video") meta = await makeVideoThumb(blobUrl);
    if (meta) {
      width = meta.width;
      height = meta.height;
      thumbPath = await join(dir, "thumbs", `${name}.webp`);
      await writeFile(thumbPath, dataUrlToBytes(meta.thumb));
    }
  } catch (e) {
    console.warn("[assets] thumb failed", e);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
  return { path, thumb: thumbPath, size: bytes.length, width, height };
}

export async function deleteAssetFile(path: string, thumb?: string) {
  if (!isTauri) {
    if (path.startsWith("blob:")) URL.revokeObjectURL(path);
    return;
  }
  const { remove, exists } = await import("@tauri-apps/plugin-fs");
  try {
    if (await exists(path)) await remove(path);
    if (thumb && (await exists(thumb))) await remove(thumb);
  } catch (e) {
    console.warn("[assets] delete failed", e);
  }
}

/** 本地路径 → 可在 webview 中加载的 URL（asset: 协议） */
export function assetUrl(path: string): string {
  if (!isTauri || path.startsWith("blob:") || path.startsWith("data:") || path.startsWith("http")) return path;
  return convertFileSrc(path);
}

/** 资产文件 → dataURL（拖入画布建图片节点用；节点 src 全程按 dataURL 约定） */
export async function assetToDataUrl(path: string, mime?: string): Promise<string> {
  if (path.startsWith("data:")) return path;
  let blob: Blob;
  if (isTauri && !path.startsWith("blob:") && !path.startsWith("http")) {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const bytes = await readFile(path);
    blob = new Blob([new Uint8Array(bytes)], { type: mime ?? mimeFromExt(path.split(".").pop() ?? "") });
  } else {
    blob = await (await fetch(path)).blob();
  }
  return await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(new Error("读取资产文件失败"));
    r.readAsDataURL(blob);
  });
}
