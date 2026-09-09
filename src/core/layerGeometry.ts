/** 合成图与 PSD 共用同一套整数像素位置，避免高清图层原尺寸越界。 */
export function layerRect(box: [number, number, number, number], width: number, height: number) {
  const left = Math.round(box[0] * width), top = Math.round(box[1] * height);
  return { left, top, width: Math.max(1, Math.round((box[0] + box[2]) * width) - left), height: Math.max(1, Math.round((box[1] + box[3]) * height) - top) };
}

/** 限制单次浏览器画布内存；倍数仅定义输出尺寸，细节取决于源图层。 */
export function layerOutputSize(width: number, height: number, scale = 1) {
  const requested = scale === 2 || scale === 4 ? scale : 1;
  const factor = Math.min(requested, 8192 / Math.max(width, height), Math.sqrt(24_000_000 / (width * height)));
  return { width: Math.max(1, Math.floor(width * factor)), height: Math.max(1, Math.floor(height * factor)) };
}
