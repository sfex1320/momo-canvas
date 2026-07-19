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
export async function toDataUrl(src: string, fetcher: typeof fetch = (...args) => fetch(...args)): Promise<string> {
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

/** 视觉输入压缩：长边 ≤maxSide、JPEG 重编码，避免超出视觉模型的图片大小限制（如 Claude 协议 10MB） */
export async function shrinkForVision(dataUrl: string, maxSide = 1600): Promise<string> {
  if (!dataUrl.startsWith("data:image")) return dataUrl;
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("图片解码失败"));
      img.src = dataUrl;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    // 尺寸不大且体积也不大 → 原样发送
    if (scale >= 1 && dataUrl.length < 2_500_000) return dataUrl;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = c.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85);
  } catch {
    return dataUrl;
  }
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
export type FilenameMeta = {
  model?: string;
  prompt?: string;
  seed?: string | number;
  /** 分辨率，如 2560x1440 */
  size?: string;
  /** 比例，如 16x9（文件名不能用冒号） */
  ratio?: string;
  /** 序号：同前缀依次递增（由保存服务填入） */
  n?: number;
};

export function buildFilename(pattern: string, meta: FilenameMeta) {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const tokens: Record<string, string> = {
    date: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`,
    time: `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`,
    model: sanitizeFilename(meta.model ?? "model", 24),
    prompt: sanitizeFilename(meta.prompt ?? "", 24) || "untitled",
    seed: String(meta.seed ?? ""),
    size: meta.size ?? "",
    ratio: meta.ratio ?? "",
    n: meta.n !== undefined ? String(meta.n) : "",
  };
  let out = pattern.replace(/\{(\w+)\}/g, (_, k) => tokens[k] ?? "");
  out = sanitizeFilename(out, 120) || `momo_${tokens.date}_${tokens.time}`;
  return out;
}

/** 图片实际宽高 → { size: "2560x1440", ratio: "16x9" } */
export async function imageSizeMeta(dataUrl: string): Promise<{ size: string; ratio: string }> {
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("decode"));
      img.src = dataUrl;
    });
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
    const g = gcd(w, h) || 1;
    return { size: `${w}x${h}`, ratio: `${w / g}x${h / g}` };
  } catch {
    return { size: "", ratio: "" };
  }
}

/** 键盘事件是否命中组合键描述（"ctrl+z" / "Delete" / "Tab"…），修饰键需精确匹配 */
export function matchHotkey(e: KeyboardEvent, combo: string): boolean {
  if (!combo) return false;
  const parts = combo.toLowerCase().split("+").filter(Boolean);
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  const k = e.key.toLowerCase();
  return (
    k === key &&
    mods.has("ctrl") === (e.ctrlKey || e.metaKey) &&
    mods.has("shift") === e.shiftKey &&
    mods.has("alt") === e.altKey
  );
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** 宽容解析模型返回的 JSON：剥掉代码块围栏，截取首个 { 到最后一个 } */
export function parseJsonLoose<T>(text: string): T | null {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
