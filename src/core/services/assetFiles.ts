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
