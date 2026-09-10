/** 先识别图片编码，再解析 URL，裸 PNG/JPEG 不能被拼成中转站下载地址。 */
export function normalizeImageResult(value: string, baseUrl: string): string {
  const s = value.trim();
  if (/^(https?:|data:image\/|blob:)/i.test(s)) return s;
  const mime = s.startsWith("iVBORw0KGgo") ? "image/png"
    : s.startsWith("/9j/") ? "image/jpeg"
    : s.startsWith("R0lGOD") ? "image/gif"
    : s.startsWith("UklGR") ? "image/webp"
    : s.startsWith("Qk") ? "image/bmp" : undefined;
  if (mime) {
    const b64 = s.replace(/\s/g, "");
    if (b64.length >= 16 && /^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return `data:${mime};base64,${b64}`;
  }
  if (s.startsWith("//")) return `https:${s}`;
  if (!baseUrl) return s;
  return new URL(s, `${baseUrl.replace(/\/+$/, "")}/`).toString();
}
