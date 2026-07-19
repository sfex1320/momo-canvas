/**
 * 蒙版/画布像素工具 — 局部重绘、扩图、聚焦裁剪共用（纯本地 canvas 操作）
 *
 * 蒙版统一约定：与原图同尺寸的 PNG dataURL，标注处为不透明白色，其余全透明。
 * 由它派生两种模型输入：
 *  - OpenAI images/edits 的 mask：标注处透明（= 允许重绘），其余不透明
 *  - 指令式降级（Banana/通用）：原图 + 红色高亮标注图，让模型「只改红色区域」
 */

export function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("图片解码失败"));
    img.src = src;
  });
}

function canvasOf(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("无法创建画布上下文");
  return [c, ctx];
}

/** 蒙版 → OpenAI images/edits 的 mask（标注处透明 = 允许重绘，其余不透明黑） */
export async function maskToOpenAiMask(maskPng: string, w: number, h: number): Promise<string> {
  const mask = await loadImg(maskPng);
  const [c, ctx] = canvasOf(w, h);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = "destination-out";
  ctx.drawImage(mask, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

/** 原图 + 蒙版 → 红色高亮标注图（指令式局部重绘给模型看「改哪里」） */
export async function annotateMaskOnImage(src: string, maskPng: string): Promise<string> {
  const [img, mask] = await Promise.all([loadImg(src), loadImg(maskPng)]);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  // 蒙版染成纯红
  const [mc, mctx] = canvasOf(w, h);
  mctx.drawImage(mask, 0, 0, w, h);
  mctx.globalCompositeOperation = "source-in";
  mctx.fillStyle = "#ff2222";
  mctx.fillRect(0, 0, w, h);
  const [c, ctx] = canvasOf(w, h);
  ctx.drawImage(img, 0, 0, w, h);
  ctx.globalAlpha = 0.55;
  ctx.drawImage(mc, 0, 0);
  ctx.globalAlpha = 1;
  return c.toDataURL("image/png");
}

/** 蒙版覆盖率（0-1），用于「蒙版是不是空的」校验；按缩样估算，开销极小 */
export async function maskCoverage(maskPng: string): Promise<number> {
  const mask = await loadImg(maskPng);
  const [, ctx] = canvasOf(64, 64);
  ctx.drawImage(mask, 0, 0, 64, 64);
  const data = ctx.getImageData(0, 0, 64, 64).data;
  let hit = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 24) hit++;
  return hit / (64 * 64);
}

/** 按归一化矩形裁剪图片（聚焦裁剪节点） */
export async function cropByRect(src: string, rect: { x: number; y: number; w: number; h: number }): Promise<{ dataUrl: string; w: number; h: number }> {
  const img = await loadImg(src);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const x = Math.max(0, Math.min(W - 1, Math.round(rect.x * W)));
  const y = Math.max(0, Math.min(H - 1, Math.round(rect.y * H)));
  const w = Math.max(8, Math.min(W - x, Math.round(rect.w * W)));
  const h = Math.max(8, Math.min(H - y, Math.round(rect.h * H)));
  const [canvas, ctx] = canvasOf(w, h);
  ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
  return { dataUrl: canvas.toDataURL("image/png"), w, h };
}

export type OutpaintPadsPx = { l: number; r: number; t: number; b: number };

/** 扩图画布：原图按 pads 摆入扩大的透明画布；mask 为「原图区域不透明、新区域透明」（OpenAI 语义：透明 = 待生成）
 *  长边超过 cap 时整体等比缩小，避免超出 GPT Image 尺寸上限 */
export async function buildOutpaintCanvas(
  src: string,
  pads: { left: number; right: number; up: number; down: number },
  cap = 3072,
): Promise<{ image: string; mask: string; w: number; h: number }> {
  const img = await loadImg(src);
  let W = img.naturalWidth;
  let H = img.naturalHeight;
  let l = Math.round(W * pads.left);
  let r = Math.round(W * pads.right);
  let t = Math.round(H * pads.up);
  let b = Math.round(H * pads.down);
  let fullW = W + l + r;
  let fullH = H + t + b;
  const scale = Math.min(1, cap / Math.max(fullW, fullH));
  if (scale < 1) {
    W = Math.round(W * scale);
    H = Math.round(H * scale);
    l = Math.round(l * scale);
    r = Math.round(r * scale);
    t = Math.round(t * scale);
    b = Math.round(b * scale);
    fullW = W + l + r;
    fullH = H + t + b;
  }
  // 宽高取 16 的倍数（多数生图接口的粒度要求），差值补到右/下边
  const to16 = (v: number) => Math.max(256, Math.ceil(v / 16) * 16);
  const outW = to16(fullW);
  const outH = to16(fullH);
  const [ic, ictx] = canvasOf(outW, outH);
  ictx.drawImage(img, l, t, W, H);
  const [mc, mctx] = canvasOf(outW, outH);
  mctx.fillStyle = "#000";
  // 原图区域向内收 2px，让边缘也参与重绘，接缝更自然
  mctx.fillRect(l + 2, t + 2, W - 4, H - 4);
  return { image: ic.toDataURL("image/png"), mask: mc.toDataURL("image/png"), w: outW, h: outH };
}
