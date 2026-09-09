/** 取景框和导出共用同一裁切矩形，坐标使用画布像素。 */
export function stageFrame(width: number, height: number, aspect: string) {
  const [a, b] = aspect.split(":").map(Number);
  const ratio = Number.isFinite(a / b) && a > 0 && b > 0 ? a / b : 16 / 9;
  const w = Math.max(1, Math.round(Math.min(width * 0.62, height * 0.7 * ratio)));
  const h = Math.max(1, Math.round(w / ratio));
  return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h };
}
