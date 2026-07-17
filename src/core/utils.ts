import { nanoid } from "nanoid";

export const uid = (n = 10) => nanoid(n);

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

export function fmtTime(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** File → dataURL */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

/** dataURL → Uint8Array */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.split(",")[1] ?? "";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** dataURL → Blob */
export function dataUrlToBlob(dataUrl: string): Blob {
  const mime = dataUrl.match(/^data:([^;]+)/)?.[1] ?? "image/png";
  const buf = dataUrlToBytes(dataUrl);
  const copy = new Uint8Array(buf); // 独立 ArrayBuffer，避免 SharedArrayBuffer 类型问题
  return new Blob([copy.buffer], { type: mime });
}

/** 任意图片源（url / dataURL）→ dataURL */
export async function toDataUrl(src: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (src.startsWith("data:")) return src;
  const resp = await fetcher(src);
  const blob = await resp.blob();
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

/** 图片格式转换（dataURL → 指定格式 dataURL） */
export function convertImage(dataUrl: string, format: "png" | "jpeg" | "webp", quality = 0.92): Promise<string> {
  if (dataUrl.startsWith(`data:image/${format}`)) return Promise.resolve(dataUrl);
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d")!;
      if (format === "jpeg") {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
      }
      ctx.drawImage(img, 0, 0);
      res(c.toDataURL(`image/${format}`, quality));
    };
    img.onerror = () => rej(new Error("图片解码失败"));
    img.src = dataUrl;
  });
}

/** 文件名安全化 */
export function sanitizeFilename(s: string, max = 40) {
  return s
    .replace(/[\\/:*?"<>|\r\n]+/g, " ")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, max);
}

/** 命名模板 → 文件名（不含扩展名） */
export function buildFilename(pattern: string, meta: { model?: string; prompt?: string; seed?: string | number }) {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const tokens: Record<string, string> = {
    date: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`,
    time: `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`,
    model: sanitizeFilename(meta.model ?? "model", 24),
    prompt: sanitizeFilename(meta.prompt ?? "", 24) || "untitled",
    seed: String(meta.seed ?? ""),
  };
  let out = pattern.replace(/\{(\w+)\}/g, (_, k) => tokens[k] ?? "");
  out = sanitizeFilename(out, 120) || `momo_${tokens.date}_${tokens.time}`;
  return out;
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
