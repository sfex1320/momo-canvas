/**
 * 分层导出（PSD / 多页分层 TIFF / 单层透明 PNG）与本地背景遮挡补全。
 * 3.6 元素工坊重构：伪分割蒙版管线已删 —— 元素识别与拆解编排见 elementSplit.ts，
 * 抠图走 maskCanvas.chromaKey（色键）；本文件只保留「导出」与「背景补全」两件事，
 * 导出吃图层数组（元素工坊拆解到画布后，从图层组成员按 y 序读取）。
 */
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile, remove } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { assetsDir } from "./services/assetFiles";
import { loadImg } from "./maskCanvas";
import { dataUrlToBytes, isTauri, uid } from "./utils";

/** 待导出图层：透明 PNG dataURL + 图层名；box（原图归一化位置）存在时 PSD 按原位放置（高清层中心对齐 box 中心） */
export type ExportLayer = { name: string; src: string; box?: [number, number, number, number] };

function makeCanvas(w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("无法创建分层画布");
  return { canvas, ctx };
}

/**
 * 背景遮挡补全（本地 BFS 边界扩散）：把各元素 bbox（膨胀 1.5% 容差）视为遮挡区，
 * 从遮挡区边界取色向内扩散填充；未遮挡像素保持原图。纯色/渐变海报背景效果良好，
 * 复杂纹理建议改用重绘档生成背景。全分辨率单趟，调用前让出一帧给渲染。
 */
export async function completeBackgroundToDataUrl(src: string, boxes: Array<[number, number, number, number]>): Promise<string> {
  const image = await loadImg(src);
  const W = image.naturalWidth;
  const H = image.naturalHeight;
  const { ctx: workCtx } = makeCanvas(W, H);
  workCtx.drawImage(image, 0, 0);
  const work = workCtx.getImageData(0, 0, W, H);
  const pixels = work.data;

  // 遮挡蒙版：元素 bbox 各向外膨胀 1.5%（视觉模型的框普遍贴边，略扩防止残留元素边缘）
  const { ctx: maskCtx } = makeCanvas(W, H);
  maskCtx.fillStyle = "#fff";
  for (const [bx, by, bw, bh] of boxes) {
    const pad = 0.015;
    const x0 = Math.max(0, Math.floor((bx - bw * pad) * W));
    const y0 = Math.max(0, Math.floor((by - bh * pad) * H));
    const x1 = Math.min(W, Math.ceil((bx + bw * (1 + pad)) * W));
    const y1 = Math.min(H, Math.ceil((by + bh * (1 + pad)) * H));
    maskCtx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
  const maskData = maskCtx.getImageData(0, 0, W, H).data;

  const size = W * H;
  const union = new Uint8Array(size);
  for (let i = 0; i < size; i++) if (maskData[i * 4 + 3] > 52) union[i] = 1;
  const queue = new Int32Array(union.reduce((n, v) => n + (v ? 1 : 0), 0));
  const queued = new Uint8Array(size);
  let head = 0;
  let tail = 0;
  const offsets = [-1, 1, -W, W];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!union[i]) continue;
      for (const d of offsets) {
        if (!union[i + d]) {
          const a = i * 4;
          const b = (i + d) * 4;
          pixels[a] = pixels[b];
          pixels[a + 1] = pixels[b + 1];
          pixels[a + 2] = pixels[b + 2];
          pixels[a + 3] = 255;
          queued[i] = 1;
          queue[tail++] = i;
          break;
        }
      }
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % W;
    const y = Math.floor(i / W);
    for (const d of offsets) {
      const j = i + d;
      if (j < 0 || j >= size || queued[j] || !union[j]) continue;
      const jx = j % W;
      const jy = Math.floor(j / W);
      if (Math.abs(jx - x) + Math.abs(jy - y) !== 1) continue;
      const a = j * 4;
      const b = i * 4;
      pixels[a] = pixels[b];
      pixels[a + 1] = pixels[b + 1];
      pixels[a + 2] = pixels[b + 2];
      pixels[a + 3] = 255;
      queued[j] = 1;
      queue[tail++] = j;
    }
  }
  workCtx.putImageData(work, 0, 0);
  return workCtx.canvas.toDataURL("image/png");
}

async function canvasFrom(src: string) {
  const image = await loadImg(src);
  const { canvas, ctx } = makeCanvas(image.naturalWidth, image.naturalHeight);
  ctx.drawImage(image, 0, 0);
  return canvas;
}

function triggerDownload(bytes: Uint8Array, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 导出分层 PSD：composite 为合成预览底图（可用 stitchCanvas.stackLayers 的结果）；layers 序 = 底→顶 */
export async function exportLayeredPsd(
  opts: { width: number; height: number; composite: string; layers: ExportLayer[] },
  dpi = 300,
): Promise<string> {
  if (!opts.layers.length) throw new Error("至少保留一个图层");
  const [{ writePsd }, composite, ...canvases] = await Promise.all([
    import("ag-psd"),
    canvasFrom(opts.composite),
    ...opts.layers.map((layer) => canvasFrom(layer.src)),
  ]);
  // ag-psd 的 children 顺序是图层面板从上到下；图层组内部为底→顶（数组序），因此反转。
  // 带 box 的层按原图原位放置（left/top 像素）：高清重绘层（约 2×box 尺寸）以中心对齐，PS 里直接可用
  const children = opts.layers
    .map((layer, index) => {
      const canvas = canvases[index];
      const box = layer.box;
      if (!box) return { name: layer.name, canvas, hidden: false };
      const left = Math.round(box[0] * opts.width - (canvas.width - box[2] * opts.width) / 2);
      const top = Math.round(box[1] * opts.height - (canvas.height - box[3] * opts.height) / 2);
      return { name: layer.name, canvas, hidden: false, left, top };
    })
    .reverse();
  const bytes = new Uint8Array(writePsd({
    width: opts.width,
    height: opts.height,
    canvas: composite,
    children,
    imageResources: { resolutionInfo: { horizontalResolution: dpi, horizontalResolutionUnit: "PPI", widthUnit: "Inches", verticalResolution: dpi, verticalResolutionUnit: "PPI", heightUnit: "Inches" } },
  }, { generateThumbnail: true }));
  const fileName = `MOMO分层_${Date.now()}.psd`;
  if (!isTauri) {
    triggerDownload(bytes, fileName, "image/vnd.adobe.photoshop");
    return fileName;
  }
  const path = await save({ defaultPath: fileName, filters: [{ name: "Photoshop 分层文件", extensions: ["psd"] }] });
  if (!path) throw new Error("已取消导出");
  await writeFile(path, bytes);
  return path;
}

/** 导出多页分层 TIFF（每页一个透明图层；仅桌面版） */
export async function exportLayeredTiff(layers: ExportLayer[], dpi = 300): Promise<string> {
  if (!isTauri) throw new Error("多页分层 TIFF 仅桌面版支持；浏览器预览可导出 PSD");
  if (!layers.length) throw new Error("至少保留一个图层");
  const outPath = await save({ defaultPath: `MOMO分层_${Date.now()}.tif`, filters: [{ name: "多页分层 TIFF", extensions: ["tif", "tiff"] }] });
  if (!outPath) throw new Error("已取消导出");
  const dir = await assetsDir();
  const token = uid(8);
  const temp: string[] = [];
  try {
    for (let i = 0; i < layers.length; i++) {
      const path = await join(dir, `.momo_layer_${token}_${i}.png`);
      await writeFile(path, dataUrlToBytes(layers[i].src));
      temp.push(path);
    }
    await invoke("layer_export_tiff", {
      layers: layers.map((layer, index) => ({ name: layer.name, path: temp[index] })),
      outPath,
      dpi,
    });
    return outPath;
  } finally {
    for (const path of temp) await remove(path).catch(() => undefined);
  }
}

/** 导出单个透明 PNG 图层 */
export async function exportLayerPng(src: string, name: string): Promise<string> {
  const bytes = dataUrlToBytes(src);
  const safe = name.replace(/[<>:"/\\|?*]+/g, "_").slice(0, 48) || "图层";
  const fileName = `${safe}_${Date.now()}.png`;
  if (!isTauri) {
    triggerDownload(bytes, fileName, "image/png");
    return fileName;
  }
  const path = await save({ defaultPath: fileName, filters: [{ name: "透明 PNG 图层", extensions: ["png"] }] });
  if (!path) throw new Error("已取消导出");
  await writeFile(path, bytes);
  return path;
}
