/**
 * 画布缩略图系统 — 大图只在节点上显示降采样缩略图，原图仅在预览/保存/传给模型时使用。
 * 解决大图（数 MB dataURL）直接塞进 <img> 导致画布拖动/缩放掉帧的问题。
 */
import { useEffect, useState, type CSSProperties } from "react";
import { useImageDims } from "../core/imageInfo";

/** 低于此字节数的 dataURL 直接原样显示，不值得降采样 */
const SMALL_ENOUGH = 120_000;
/** 缩略图缓存上限（条），超出后淘汰最早的 */
const CACHE_MAX = 400;

const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

function remember(src: string, thumb: string) {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(src, thumb);
}

/** 同步查缓存（避免已生成过的缩略图闪烁） */
export function thumbSync(src: string): string | null {
  if (src.length < SMALL_ENOUGH || !src.startsWith("data:image")) return src;
  return cache.get(src) ?? null;
}

/** 生成降采样缩略图（长边 ≤ max），结果缓存复用 */
export function makeThumb(src: string, max = 512): Promise<string> {
  if (src.length < SMALL_ENOUGH || !src.startsWith("data:image")) return Promise.resolve(src);
  const hit = cache.get(src);
  if (hit) return Promise.resolve(hit);
  const inflight = pending.get(src);
  if (inflight) return inflight;

  const p = (async () => {
    try {
      // createImageBitmap：解码 + 缩放大部分在主线程之外完成，大图拖入不再冻结画布
      const blob = await (await fetch(src)).blob();
      const probe = await createImageBitmap(blob);
      const scale = Math.min(1, max / Math.max(probe.width, probe.height));
      if (scale >= 1) {
        probe.close();
        remember(src, src);
        return src;
      }
      const w = Math.max(1, Math.round(probe.width * scale));
      const h = Math.max(1, Math.round(probe.height * scale));
      probe.close();
      const bmp = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: "medium" });
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      if (!ctx) {
        bmp.close();
        return src;
      }
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      const t = c.toDataURL("image/webp", 0.82);
      remember(src, t);
      return t;
    } catch {
      return src; // 解码失败就退回原图，至少能显示
    } finally {
      pending.delete(src);
    }
  })();
  pending.set(src, p);
  return p;
}

/** hook 版：任意组件里拿某图片源的缩略图（如 SVG <image> 内嵌用） */
export function useThumb(src?: string): string | null {
  const [t, setT] = useState<string | null>(() => (src ? thumbSync(src) : null));
  useEffect(() => {
    if (!src) {
      setT(null);
      return;
    }
    let on = true;
    setT(thumbSync(src));
    void makeThumb(src, 256).then((r) => {
      if (on) setT(r);
    });
    return () => {
      on = false;
    };
  }, [src]);
  return t;
}

/** 分辨率角标：读原图像素宽高（Thumb res 模式内部用） */
function ResBadge({ src }: { src: string }) {
  const d = useImageDims(src);
  if (!d) return null;
  return (
    <span className="res-badge" title={`原图分辨率 ${d.w} × ${d.h}`}>
      {d.w}×{d.h}
    </span>
  );
}

/** 节点内图片：自动用缩略图渲染；点击等交互仍由调用方拿原图处理；res = 右下角显示原图分辨率角标 */
export function Thumb({
  src,
  className,
  style,
  alt = "",
  onClick,
  title,
  res,
}: {
  src: string;
  className?: string;
  style?: CSSProperties;
  alt?: string;
  onClick?: () => void;
  title?: string;
  res?: boolean;
}) {
  const [t, setT] = useState<string | null>(() => thumbSync(src));
  useEffect(() => {
    let on = true;
    setT(thumbSync(src));
    void makeThumb(src).then((r) => {
      if (on) setT(r);
    });
    return () => {
      on = false;
    };
  }, [src]);
  if (!t) return <div className={`${className ?? ""} thumb-ph`} style={style} title={title} />;
  const img = <img className={className} style={style} src={t} alt={alt} onClick={onClick} title={title} loading="lazy" />;
  if (!res) return img;
  return (
    <span className="thumb-wrap">
      {img}
      <ResBadge src={src} />
    </span>
  );
}
