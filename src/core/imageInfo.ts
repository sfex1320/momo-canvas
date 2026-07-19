/**
 * 图片尺寸信息 — 读取 dataURL/URL 的像素宽高（带缓存）
 * 供分辨率角标、尺寸调整节点、生图 auto 尺寸推导共用。
 * 说明：img 的 load 事件只需解析文件头即可拿到 naturalWidth，不会触发整图光栅化，开销很小。
 */
import { useEffect, useState } from "react";

export type ImgDims = { w: number; h: number };

const CACHE_MAX = 600;
const cache = new Map<string, ImgDims>();
const pending = new Map<string, Promise<ImgDims | null>>();

function remember(src: string, d: ImgDims) {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(src, d);
}

export function imageDimsSync(src: string): ImgDims | null {
  return cache.get(src) ?? null;
}

export function imageDims(src: string): Promise<ImgDims | null> {
  const hit = cache.get(src);
  if (hit) return Promise.resolve(hit);
  const inflight = pending.get(src);
  if (inflight) return inflight;
  const p = new Promise<ImgDims | null>((res) => {
    const img = new Image();
    const timer = setTimeout(() => res(null), 8000);
    img.onload = () => {
      clearTimeout(timer);
      const d = { w: img.naturalWidth, h: img.naturalHeight };
      if (d.w && d.h) remember(src, d);
      res(d.w && d.h ? d : null);
    };
    img.onerror = () => {
      clearTimeout(timer);
      res(null);
    };
    img.src = src;
  }).finally(() => pending.delete(src));
  pending.set(src, p);
  return p;
}

/** hook 版：组件里拿某图片的像素尺寸（未就绪时为 null） */
export function useImageDims(src?: string): ImgDims | null {
  const [d, setD] = useState<ImgDims | null>(() => (src ? imageDimsSync(src) : null));
  useEffect(() => {
    if (!src) {
      setD(null);
      return;
    }
    let on = true;
    setD(imageDimsSync(src));
    void imageDims(src).then((r) => {
      if (on) setD(r);
    });
    return () => {
      on = false;
    };
  }, [src]);
  return d;
}

/** 求最大公约数，用于把宽高化成最简比例 */
function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** 宽高 → 最简比例串；化简后仍很大（如 1774:887 → 2:1 才算正常）就返回约数近似 */
export function exactRatio(w: number, h: number): string {
  const g = gcd(w, h) || 1;
  const rw = w / g;
  const rh = h / g;
  if (rw <= 50 && rh <= 50) return `${rw}:${rh}`;
  // 化不出简洁比例：保留两位小数的单边比
  const r = w / h;
  return r >= 1 ? `${r.toFixed(2)}:1` : `1:${(1 / r).toFixed(2)}`;
}
