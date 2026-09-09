/**
 * 纵向拼接长图（电商详情页 / H5 长图）— 纯本地 canvas 操作，与 markCanvas.ts / resizeMath.ts 平级。
 * 把 N 张切片沿 y 轴拼成一张长图：统一宽度（默认取最窄，其余等比缩，避免放大模糊）+
 * 可选片间间距 / 背景色 / 总高上限（超限整体等比缩，守住 canvas 单边与内存上限）。
 *
 * 复用：loadImg（maskCanvas）、resampleImage（resizeMath，整图兜底缩放）。
 * 长图 dataURL 必然大，调用方直接塞节点 data 即可 —— blobStore 会自动外置（>200k 字符转 momoblob:）。
 */
import { tileLayout } from "./gridGeometry";
import { loadImg } from "./maskCanvas";

export type StitchOptions = {
  /** 统一片宽：数字 = 固定像素；"min" = 取最窄（默认，不放大）；"max" = 取最宽（会放大窄图） */
  width?: number | "min" | "max";
  /** 片间垂直间距（像素），默认 0（无缝） */
  gap?: number;
  /** 整图背景色（如 "#ffffff"），默认透明（仅 png 有意义） */
  background?: string;
  /** 总高上限（像素），超出按宽等比整体缩放，默认 8192（守 canvas 单边与内存上限） */
  capHeight?: number;
  /** 输出格式，默认 png（保透明）；纯照片长图可传 jpeg 省体量 */
  format?: "png" | "jpeg";
};

/** 纵向拼接 N 张图 → { dataUrl, w, h }。空数组抛中文错误。 */
export async function stitchVertical(
  srcs: string[],
  opts: StitchOptions = {},
): Promise<{ dataUrl: string; w: number; h: number }> {
  if (!srcs.length) throw new Error("没有可拼接的切片：请先生成切片图");
  const gap = Math.max(0, opts.gap ?? 0);
  const format = opts.format ?? "png";
  const capHeight = Math.max(256, opts.capHeight ?? 8192);

  const imgs = await Promise.all(srcs.map(loadImg));

  // 1) 统一片宽
  const nats = imgs.map((im) => ({ w: im.naturalWidth || 1, h: im.naturalHeight || 1 }));
  let targetW: number;
  const mode = opts.width ?? "min";
  if (mode === "min") targetW = Math.min(...nats.map((n) => n.w));
  else if (mode === "max") targetW = Math.max(...nats.map((n) => n.w));
  else targetW = Math.max(64, mode);
  targetW = Math.round(targetW);

  // 2) 每片等比缩放到 targetW 后的高度，累加得总高
  let totalH = 0;
  const slices = nats.map((n) => {
    const sh = Math.max(1, Math.round((n.h * targetW) / n.w));
    totalH += sh;
    return sh;
  });
  totalH += gap * (imgs.length - 1);

  // 3) 总高超 capHeight：整体等比缩（含宽度），守 canvas 单边与内存上限
  if (totalH > capHeight) {
    const k = capHeight / totalH;
    targetW = Math.max(64, Math.round(targetW * k));
    for (let i = 0; i < slices.length; i++) slices[i] = Math.max(1, Math.round(slices[i] * k));
    totalH = slices.reduce((a, b) => a + b, 0) + gap * (imgs.length - 1);
  }

  // 4) 建画布、铺背景、逐片贴入
  const c = document.createElement("canvas");
  c.width = targetW;
  c.height = Math.round(totalH);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("无法创建拼接画布上下文");
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  let y = 0;
  for (let i = 0; i < imgs.length; i++) {
    const sh = slices[i];
    ctx.drawImage(imgs[i], 0, y, targetW, sh);
    y += sh + gap;
  }

  const dataUrl = format === "jpeg" ? c.toDataURL("image/jpeg", 0.92) : c.toDataURL("image/png");
  return { dataUrl, w: c.width, h: c.height };
}

/** 网格拼接（分镜组「拼接」）：N 张等尺寸切片按每行 cols 张排成 R×C 网格，长边缩到 longEdge（默认 2048）。
 *  以第一张的宽高为格尺寸（分镜组切片本就统一尺寸），不足整行的末行留空。空数组抛中文错误。 */
export async function stitchGrid(
  srcs: string[],
  cols: number,
  opts: { longEdge?: number; gap?: number } = {},
): Promise<{ dataUrl: string; w: number; h: number }> {
  if (!srcs.length) throw new Error("没有可拼接的切片：请先创建分镜组");
  const cols1 = Math.max(1, Math.min(cols, srcs.length));
  const gap = Math.max(0, opts.gap ?? 0);
  const longEdge = Math.max(256, opts.longEdge ?? 2048);
  const imgs = await Promise.all(srcs.map(loadImg));
  const sizes = imgs.map(im => ({ w: im.naturalWidth, h: im.naturalHeight }));
  const natural = tileLayout(sizes.map(s => ({ w: s.w + gap, h: s.h + gap })), cols1, 1);
  const k = Math.min(1, longEdge / Math.max(natural.w - gap, natural.h - gap));
  const W = Math.max(1, Math.round((natural.w - gap) * k));
  const H = Math.max(1, Math.round((natural.h - gap) * k));
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("无法创建拼接画布上下文");
  imgs.forEach((im, i) => {
    const p = natural.positions[i];
    const left = Math.round(p.x * k), top = Math.round(p.y * k);
    ctx.drawImage(im, left, top, Math.round((p.x + sizes[i].w) * k) - left, Math.round((p.y + sizes[i].h) * k) - top);
  });
  return { dataUrl: c.toDataURL("image/png"), w: W, h: H };
}

/** 图层叠加合成（元素工坊「合成图层」）：N 张（多为透明 PNG）按数组序 = z 序（底→顶）叠成一张。
 *  画布尺寸默认取第一张（调用方把背景层放首位）；各层小于画布时左上对齐，大于画布时等比缩到画布内居中。 */
export async function stackLayers(
  srcs: string[],
  opts: { width?: number; height?: number; background?: string } = {},
): Promise<{ dataUrl: string; w: number; h: number }> {
  if (!srcs.length) throw new Error("没有可合成的图层：请先拆解元素或放入图片");
  const imgs = await Promise.all(srcs.map(loadImg));
  const nats = imgs.map((im) => ({ w: im.naturalWidth || 1, h: im.naturalHeight || 1 }));
  let W = opts.width ?? nats[0].w;
  let H = opts.height ?? nats[0].h;
  // 守 canvas 单边与内存上限（与 stitchVertical 的 capHeight 同款守卫）
  const cap = 8192;
  const k = Math.min(1, cap / Math.max(W, H));
  if (k < 1) {
    W = Math.max(64, Math.round(W * k));
    H = Math.max(64, Math.round(H * k));
  }
  const c = document.createElement("canvas");
  c.width = Math.round(W);
  c.height = Math.round(H);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("无法创建合成画布上下文");
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  for (let i = 0; i < imgs.length; i++) {
    const n = nats[i];
    // 等比适配画布（不放大超过原尺寸的层，防止糊）；居中摆放
    const fit = Math.min(c.width / n.w, c.height / n.h, 1);
    const dw = n.w * fit;
    const dh = n.h * fit;
    ctx.drawImage(imgs[i], Math.round((c.width - dw) / 2), Math.round((c.height - dh) / 2), Math.round(dw), Math.round(dh));
  }
  return { dataUrl: c.toDataURL("image/png"), w: c.width, h: c.height };
}
