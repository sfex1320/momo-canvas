/**
 * 尺寸调整节点的目标尺寸推导 / 推荐比例分辨率 / 真实重采样 — runner 与节点 UI 共用
 */
import { BANANA_ASPECTS, gptSize, nearestAspect } from "./modelMeta";
import { exactRatio } from "./imageInfo";
import type { ResizeData } from "./types";

/** 推荐比例候选（常用档 + 2:1/1:2 超宽） */
const REC_ASPECTS = [...BANANA_ASPECTS.filter((a) => a !== "auto"), "2:1", "1:2"];

/** 按目标模式推导输出宽高（保持比例，钳制在 16 ~ 8192） */
export function targetSize(d: ResizeData, srcW: number, srcH: number): { w: number; h: number } {
  const ratio = srcW / srcH;
  let w = srcW;
  let h = srcH;
  if (d.mode === "mp") {
    const area = Math.max(0.01, d.mp || 1) * 1_000_000;
    const s = Math.sqrt(area / (srcW * srcH));
    w = srcW * s;
    h = srcH * s;
  } else if (d.mode === "side") {
    const len = Math.max(16, d.sideLen || 1024);
    const refIsW =
      d.sideRef === "width" || (d.sideRef === "long" ? srcW >= srcH : d.sideRef === "short" ? srcW < srcH : false);
    if (refIsW) {
      w = len;
      h = len / ratio;
    } else {
      h = len;
      w = len * ratio;
    }
  } else {
    const s = Math.max(1, d.scalePct || 100) / 100;
    w = srcW * s;
    h = srcH * s;
  }
  const clamp = (v: number) => Math.max(16, Math.min(8192, Math.round(v)));
  return { w: clamp(w), h: clamp(h) };
}

/** 最接近的常用比例（如 1774×887 → 2:1） */
export function recommendAspect(w: number, h: number): string {
  return nearestAspect(w / h, REC_ASPECTS);
}

/** 最接近的常用分辨率：按面积就近取 1K/2K/4K 档，再按推荐比例换算宽高 */
export function recommendRes(w: number, h: number): { w: number; h: number } {
  const area = w * h;
  const tiers: [string, number][] = [
    ["1K", 1024 * 1024],
    ["2K", 2048 * 2048],
    ["4K", 3840 * 2160],
  ];
  let tier = "1K";
  let best = Infinity;
  for (const [t, a] of tiers) {
    const diff = Math.abs(Math.log(a) - Math.log(area));
    if (diff < best) {
      best = diff;
      tier = t;
    }
  }
  const s = gptSize(recommendAspect(w, h), tier);
  return s ?? { w: 1024, h: 1024 };
}

/** 尺寸文本输出（out 为文本样式时向下游物化的内容） */
export function resizeTextOut(d: ResizeData): string | null {
  if (!d.srcW || !d.srcH) return null;
  switch (d.out) {
    case "recAspect":
      return recommendAspect(d.srcW, d.srcH);
    case "recRes": {
      const r = recommendRes(d.srcW, d.srcH);
      return `${r.w}x${r.h}`;
    }
    case "actAspect":
      return exactRatio(d.srcW, d.srcH);
    case "actRes":
      return `${d.srcW}x${d.srcH}`;
    default:
      return null;
  }
}

/** 真实重采样：createImageBitmap 解码缩放（主线程外），输出 dataURL（png 保留透明，其余转 jpeg） */
export async function resampleImage(src: string, w: number, h: number): Promise<string> {
  const blob = await (await fetch(src)).blob();
  const bmp = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) {
    bmp.close();
    throw new Error("创建画布上下文失败");
  }
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return src.startsWith("data:image/png") ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.92);
}
