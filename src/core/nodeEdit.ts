/**
 * 节点图片直接编辑引擎 — 悬浮工具条「编辑」的执行层：
 *  聚焦裁剪：节点图上框选 → 裁出局部，输出一个新图片节点（保持连线语境）；
 *  局部重绘：节点图上涂抹蒙版 → 只重绘选区，结果就地写回本节点；
 *  扩图 / 尺寸调整 / 高清增强：弹卡参数 → 结果就地写回本节点。
 * 「就地写回」规则：图片节点换 src；生成/打光/多角度等节点替换当前选中的结果图（commit 入撤销历史，Ctrl+Z 可回退）。
 */
import { useBoard } from "./stores/boardStore";
import { resolveModelCard, useSettings } from "./stores/settingsStore";
import { pushError, toast, useUi } from "./stores/uiStore";
import { useAssets } from "./stores/assetStore";
import { generateImage } from "./services/imageGen";
import { autoSaveImage } from "./services/imageSaver";
import { imageDims } from "./imageInfo";
import { imageFamily, nearestAspect } from "./modelMeta";
import { presetById, buildGridPrompt, gridSizePatch } from "./gridPresets";
import { pixelGrid, tileLayout } from "./gridGeometry";
import { stitchGrid } from "./stitchCanvas";
import type { AiPreset } from "./aiPresets";
import { annotateMaskOnImage, buildOutpaintCanvas, chromaKey, cropByRect, loadImg, flattenToSolid, maskCoverage, maskToOpenAiMask } from "./maskCanvas";
import { resampleImage, targetSize } from "./resizeMath";
import { elementRedrawSelfPrompt, elementTextPrompt, enhanceInstruct, inpaintInstruct, inpaintMaskPrompt, outpaintInstruct, outpaintMaskPrompt } from "./editPrompts";
import { errMsg } from "./utils";
import { notifyDone } from "./sound";
import { composeMarkedImage } from "./markCanvas";
import type { AppNode, EditChannel, EnhanceParams, ImageData, OutpaintPads, ResizeParams } from "./types";

/** 节点当前主图：图片节点 = src；生成/打光/多角度/ComfyUI 等 = results[picked] */
export function nodeMainImage(node: AppNode | undefined): string | undefined {
  if (!node) return undefined;
  const d = node.data as Record<string, unknown>;
  if (node.type === "image") return d.src as string | undefined;
  const results = d.results as string[] | undefined;
  return results?.length ? results[(d.picked as number | undefined) ?? 0] : undefined;
}

/** 就地写回主图（commit：可 Ctrl+Z 撤销到编辑前） */
function writeMainImage(id: string, url: string) {
  const s = useBoard.getState();
  const node = s.nodes.find((n) => n.id === id);
  if (!node) return;
  const d = node.data as Record<string, unknown>;
  if (node.type === "image") {
    s.updateData(id, { src: url, status: "done", error: undefined }, { commit: true });
    return;
  }
  const results = [...((d.results as string[] | undefined) ?? [])];
  const picked = (d.picked as number | undefined) ?? 0;
  if (!results.length) results.push(url);
  else results[picked] = url;
  s.updateData(id, { results, status: "done", error: undefined }, { commit: true });
}

async function maybeAutoSave(images: string[], meta: { prompt?: string; model?: string }) {
  const { save } = useSettings.getState().settings;
  if (!save.autoSave) return;
  try {
    let last = "";
    for (const img of images) last = await autoSaveImage(img, save, meta);
    if (last) toast(`已自动保存 ${images.length} 张 → ${last}`, "ok");
  } catch (e) {
    toast(`自动保存失败：${errMsg(e)}`, "err");
  }
}

/** 模型类编辑通用收尾：生成记录 + 资产库 + 自动保存 + 完成提示 */
function finishNodeEdit(id: string, source: string, results: string[], prompt: string, cardName: string, cardModel: string) {
  for (const src of results) {
    useUi.getState().addGallery({ kind: "image", src, prompt, model: cardModel, nodeId: id });
    void useAssets.getState().collect({ src, kind: "image", prompt: `${source}：${prompt}`, model: cardName });
  }
  void maybeAutoSave(results, { prompt, model: cardModel });
  notifyDone(source);
}

const setStatus = (id: string, patch: Record<string, unknown>) => useBoard.getState().updateData(id, patch);

/* ---------- 标记：透明标记层与原图合成 → 就地写回，不产生新节点 ---------- */
export async function applyMark(id: string) {
  const me = useUi.getState().mediaEdit;
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  const src = nodeMainImage(node);
  if (!node || !src) {
    toast("当前节点还没有可标记的图片", "err");
    return;
  }
  if (!me?.mark) {
    toast("请先在图片上添加标记", "err");
    return;
  }
  setStatus(id, { status: "running", error: undefined });
  try {
    const result = await composeMarkedImage(src, me.mark);
    writeMainImage(id, result);
    finishNodeEdit(id, "图片标记", [result], "原图与标记已本地合成", "MOMO 本地工具", "local/markup");
    useUi.getState().closeMediaEdit();
    toast("标记已与原图合成；下游生成模型将直接接收这张标记图", "ok");
  } catch (e) {
    setStatus(id, { status: "error", error: errMsg(e) });
    pushError("图片标记", errMsg(e));
  }
}

/* ---------- 聚焦裁剪：框选局部 → 输出新图片节点 ---------- */
export async function applyCropToNewNode(srcId: string, rect: { x: number; y: number; w: number; h: number }) {
  const s = useBoard.getState();
  const srcNode = s.nodes.find((n) => n.id === srcId);
  const src = nodeMainImage(srcNode);
  if (!srcNode || !src) {
    toast("当前节点还没有可编辑的图片", "err");
    return;
  }
  try {
    const out = await cropByRect(src, rect);
    const parent = srcNode.parentId ? s.nodes.find((n) => n.id === srcNode.parentId) : undefined;
    const absX = srcNode.position.x + (parent?.position.x ?? 0);
    const absY = srcNode.position.y + (parent?.position.y ?? 0);
    const w = srcNode.measured?.width ?? 300;
    const baseName = (srcNode.data as Record<string, unknown>).name;
    const nid = s.addNode(
      "image",
      { x: absX + w + 140, y: absY },
      { src: out.dataUrl, name: `${typeof baseName === "string" && baseName ? baseName : "图片"} · 裁剪 ${out.w}×${out.h}`, status: "done" },
    );
    s.connectNodes(srcId, nid, "in", "out");
    useUi.getState().closeMediaEdit();
    toast(`已裁出 ${out.w}×${out.h} 的局部，生成新图片节点`, "ok");
  } catch (e) {
    toast(errMsg(e), "err");
  }
}

/* ---------- 宫格切分：整张网格图 → N×M 独立图片节点（九宫格抽卡配套） ---------- */
export async function applyGridSplit(srcId: string, rows: number, cols: number) {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows * cols > 100) {
    toast("宫格行列数须为正整数，总数不超过 100", "err"); return;
  }
  return applyGridSplitFractional(srcId, Array.from({ length: cols - 1 }, (_, i) => (i + 1) / cols), Array.from({ length: rows - 1 }, (_, i) => (i + 1) / rows));
}

/* ---------- 宫格切分会话（图上拖线调格）：按归一化切割线切格 → 全部拆出 / 创建分镜组 ---------- */

/** 一块切好的格子：dataUrl + 像素宽高 + 原行列号 */
export type GridCell = { dataUrl: string; w: number; h: number; r: number; c: number };

/** 共用整数边界裁切：原图只解码一次，不裁掉内容、不重叠像素。 */
export async function splitGridCells(src: string, xs: number[], ys: number[]): Promise<GridCell[]> {
  const img = await loadImg(src);
  return pixelGrid(img.naturalWidth, img.naturalHeight, xs, ys).map(cell => {
    const canvas = document.createElement("canvas");
    canvas.width = cell.w; canvas.height = cell.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建切片画布");
    ctx.drawImage(img, cell.x, cell.y, cell.w, cell.h, 0, 0, cell.w, cell.h);
    return { ...cell, dataUrl: canvas.toDataURL("image/png") };
  });
}

/** 会话内「全部拆出」：按当前切割线把整图拆成独立图片节点，阅读序紧凑摆在原图下方 */
export async function applyGridSplitFractional(srcId: string, xs: number[], ys: number[]) {
  const s = useBoard.getState();
  const srcNode = s.nodes.find((n) => n.id === srcId);
  const src = nodeMainImage(srcNode);
  if (!srcNode || !src) {
    toast("当前节点还没有可切分的图片", "err");
    return;
  }
  try {
    // 先并行裁完全部格子再同步建节点：全部落在同一个撤销快照合并窗口里
    const cells = await splitGridCells(src, xs, ys);
    const parent = srcNode.parentId ? s.nodes.find((n) => n.id === srcNode.parentId) : undefined;
    const absX = srcNode.position.x + (parent?.position.x ?? 0);
    const absY = srcNode.position.y + (parent?.position.y ?? 0);
    const topY = absY + (srcNode.measured?.height ?? 320) + 120;
    const baseName = (srcNode.data as Record<string, unknown>).name;
    const base = typeof baseName === "string" && baseName ? baseName : "图片";
    const cols = xs.length + 1;
    const lay = tileLayout(cells, cols, 320 / Math.max(...cells.map(c => c.w)));
    // 阅读序（行优先）摆放：与下游「首尾帧连拍」的 y→x 取序天然一致
    cells.forEach((cell, i) => {
      s.addNode(
        "image",
        { x: absX + lay.positions[i].x, y: topY + lay.positions[i].y },
        { src: cell.dataUrl, name: `${base} · 宫格 ${cell.r + 1}-${cell.c + 1}`, status: "done", storyTile: true, tileSize: { w: lay.positions[i].w, h: lay.positions[i].h } },
      );
    });
    toast(`已切出 ${cells.length} 张图片节点（Ctrl+Z 可一步撤销）`, "ok");
  } catch (e) {
    toast(errMsg(e), "err");
  }
}

/** 会话内「创建分镜组」：勾选的格子按点击顺序包进一个无框组（整组可拖），每片与原图连一条溯源线。
 *  保留切片原比例；按阅读序全选时，可无损还原原图，手选顺序仍然保留。 */
export async function createStoryboardGroup(srcId: string, picked: string[], xs: number[], ys: number[]) {
  const s = useBoard.getState();
  const srcNode = s.nodes.find((n) => n.id === srcId);
  const src = nodeMainImage(srcNode);
  if (!srcNode || !src) {
    toast("当前节点还没有可切分的图片", "err");
    return;
  }
  if (!picked.length) {
    toast("请先在图上点击勾选要进组的宫格", "err");
    return;
  }
  try {
    const allCells = await splitGridCells(src, xs, ys);
    const cols0 = Math.max(...allCells.map(c => c.c)) + 1;
    const byKey = new Map(allCells.map(cell => [`${cell.r}-${cell.c}`, cell]));
    const cells = [...new Set(picked)].map(k => byKey.get(k)).filter((c): c is GridCell => !!c);
    if (!cells.length) throw new Error("所选格子已失效，请重新选择");
    const parent = srcNode.parentId ? s.nodes.find((n) => n.id === srcNode.parentId) : undefined;
    const absX = srcNode.position.x + (parent?.position.x ?? 0);
    const absY = srcNode.position.y + (parent?.position.y ?? 0);
    const baseName = (srcNode.data as Record<string, unknown>).name;
    const base = typeof baseName === "string" && baseName ? baseName : "图片";
    const contentX = absX + (srcNode.measured?.width ?? 320) + 140;
    const contentY = absY;
    const cols = Math.min(cols0, cells.length);
    const lay = tileLayout(cells, cols, 300 / Math.max(...cells.map(c => c.w)));
    // 先同步建好全部切片（直接摆在严格网格位上）+ 溯源连线，再包组归位——同撤销快照窗口
    const ids = cells.map((cell, i) => {
      const pos = lay.positions[i];
      return s.addNode(
        "image",
        { x: contentX + pos.x, y: contentY + pos.y },
        { src: cell.dataUrl, name: `${base} · 分镜 ${i + 1}`, status: "done", storyTile: true, tileSize: { w: pos.w, h: pos.h } },
      );
    });
    for (const id of ids) s.connectNodes(srcId, id, "in", "out");
    if (ids.length >= 2) {
      // 复用元素拆解的建组路径：反选 → 只选新片 → groupSelected → placeGroupMembers 严格网格归位
      const bs = useBoard.getState();
      bs.onNodesChange([
        ...bs.nodes.map((n) => ({ type: "select" as const, id: n.id, selected: false })),
        ...ids.map((id) => ({ type: "select" as const, id, selected: true })),
      ]);
      useBoard.getState().groupSelected();
      const s3 = useBoard.getState();
      const gid = s3.nodes.find((n) => n.id === ids[0])?.parentId;
      if (gid) {
        // 组内内容区从 (24, 56) 起（避开组头）；整组挪到原图右侧
        const pos: Record<string, { x: number; y: number }> = {};
        cells.forEach((_, i) => {
          pos[ids[i]] = { x: 24 + lay.positions[i].x, y: 56 + lay.positions[i].y };
        });
        s3.placeGroupMembers(gid, pos, { w: lay.w + 48, h: lay.h + 80 });
        s3.onNodesChange([{ type: "position", id: gid, position: { x: contentX - 24, y: contentY - 56 }, dragging: false }]);
        s3.updateData(gid, {
          layerGroup: true,
          frameless: true,
          title: `分镜组 · ${base}`,
          storyOrder: ids,
          storyCols: cols,
          showOrder: false,
        });
      }
    }
    toast(`已创建分镜组（${cells.length} 格，保留完整像素、无缝排列），整组可拖动；Ctrl+Z 一步撤销`, "ok");
  } catch (e) {
    toast(errMsg(e), "err");
  }
}

/* ---------- 分镜组操作（无框组头工具条）：重排 / 拼接 / 序号 / 转普通组 ---------- */

/** 读取分镜组的有效数据；不是分镜组返回 null */
function storyboardInfo(gid: string): { g: AppNode; order: string[]; cols: number } | null {
  const n = useBoard.getState().nodes.find((x) => x.id === gid && x.type === "group");
  const d = n?.data as GroupDataLike | undefined;
  if (!n || !d?.frameless || !d.storyOrder?.length) return null;
  return { g: n, order: d.storyOrder.filter((id) => useBoard.getState().nodes.some((m) => m.id === id)), cols: d.storyCols ?? 3 };
}
type GroupDataLike = { frameless?: boolean; storyOrder?: string[]; storyCols?: number; showOrder?: boolean };

/** 严格网格重排：按分镜顺序把切片摆成每行 cols 格（切片统一尺寸，吸附整行整列） */
export function reflowStoryboardGroup(gid: string, cols: number) {
  const info = storyboardInfo(gid);
  if (!info) return;
  const useBoardNodes = useBoard.getState().nodes;
  const members = info.order.map((id) => useBoardNodes.find((m) => m.id === id)).filter((m): m is AppNode => !!m);
  if (!members.length) return;
  cols = Math.max(1, Math.min(members.length, Math.floor(cols) || 1));
  const lay = tileLayout(members.map(m => (m.data as ImageData).tileSize ?? { w: m.measured?.width ?? 320, h: m.measured?.height ?? 320 }), cols, 1);
  const pos: Record<string, { x: number; y: number }> = {};
  members.forEach((m, i) => { pos[m.id] = { x: 24 + lay.positions[i].x, y: 56 + lay.positions[i].y }; });
  useBoard.getState().placeGroupMembers(gid, pos, { w: lay.w + 48, h: lay.h + 80 });
  useBoard.getState().updateData(gid, { storyCols: cols });
}

/** 拼接：按分镜顺序把全部切片拼成一张 R×C 网格长边 2K 的整图，作为新图片节点放到组下方 */
export async function stitchStoryboardGroup(gid: string) {
  const info = storyboardInfo(gid);
  if (!info) return;
  const nodes = useBoard.getState().nodes;
  const srcs = info.order
    .map((id) => (nodes.find((m) => m.id === id)?.data as { src?: string } | undefined)?.src)
    .filter((s): s is string => !!s);
  if (srcs.length < 1) {
    toast("组里至少要有一张切片才能拼接", "err");
    return;
  }
  try {
    const out = await stitchGrid(srcs, info.cols, { longEdge: 2048 });
    const s = useBoard.getState();
    const title = ((info.g.data as { title?: string }).title ?? "分镜组").replace(/^分镜组 · /, "");
    s.addNode(
      "image",
      { x: info.g.position.x + 24, y: info.g.position.y + (info.g.style?.height as number ?? 600) + 90 },
      { src: out.dataUrl, name: `${title} · 拼接 ${out.w}×${out.h}`, status: "done" },
    );
    toast(`已拼接 ${srcs.length} 张切片（长边 2K），生成新图片节点`, "ok");
  } catch (e) {
    toast(errMsg(e), "err");
  }
}

/** 分镜组 ↔ 普通组：转普通组后恢复虚线框、瀑布流重排等常规组行为 */
export function storyboardToNormalGroup(gid: string) {
  useBoard.getState().updateData(gid, { frameless: false, layerGroup: false, showOrder: false });
  toast("已转为普通组：恢复组框与自动排布", "ok");
}

/* ---------- AI 模板（LibTV「九宫格 ▾」式玩法菜单）：选中即在下游铺生成节点，不自动跑 ---------- */

/** 按模板铺一个下游生成节点：参考图经 spawnEdit 连线自动带入；场景描述与画幅画质都在节点上自己调 */
export function spawnAiPresetNode(srcId: string, preset: AiPreset, scene: string): string | undefined {
  const s = useBoard.getState();
  const before = new Set(s.nodes.map((n) => n.id));
  s.spawnEdit(srcId, "imageGen");
  const s2 = useBoard.getState();
  const nid = s2.nodes.find((n) => n.type === "imageGen" && n.selected && !before.has(n.id))?.id;
  if (!nid) return;
  let family = "generic";
  try {
    family = imageFamily(resolveModelCard("image", undefined));
  } catch {
    /* 未配模型：按通用家族写尺寸，生成时自会给中文报错 */
  }
  const patch: Record<string, unknown> = { count: 1, parallel: 1, status: "idle", error: undefined };
  if (preset.kind === "grid" && preset.gridPresetId) {
    const gp = presetById(preset.gridPresetId);
    if (gp) {
      patch.prompt = buildGridPrompt(gp, scene, preset.aspect);
      patch.gridPresetId = gp.id;
      patch.gridAspect = preset.aspect;
      Object.assign(patch, gridSizePatch(gp, family, preset.aspect));
    }
  } else if (preset.prompt) {
    patch.prompt = preset.prompt(scene);
  }
  s2.updateData(nid, patch);
  return nid;
}

/* ---------- 元素图层重绘：透明 PNG → 铺白底 → 图生图（纯白背景指令）→ 色键抠回 → 就地写回 ---------- */
export async function redrawElementImage(id: string, userPrompt: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  const src = nodeMainImage(node);
  if (!node || !src) {
    toast("当前节点没有可重绘的元素图", "err");
    return;
  }
  setStatus(id, { status: "running", error: undefined });
  try {
    const card = resolveModelCard("image", undefined);
    // 生图模型普遍不吃 alpha：先铺纯白底发过去，回来再色键抠掉，闭环自洽
    const flat = await flattenToSolid(src);
    const dm = await imageDims(flat);
    const results = await generateImage(card, {
      prompt: elementRedrawSelfPrompt(userPrompt),
      refImages: [flat],
      n: 1,
      size: "auto",
      aspect: imageFamily(card) === "banana" && dm ? nearestAspect(dm.w / dm.h) : undefined,
    });
    const png = await chromaKey(results[0], { key: [255, 255, 255], tolerance: 36, soft: 24 });
    writeMainImage(id, png);
    finishNodeEdit(id, "元素重绘", [png], userPrompt.trim() || "元素重绘（保持原样提升质量）", card.name, card.model);
    toast("元素已重绘并抠回透明图层（Ctrl+Z 可撤销）", "ok");
  } catch (e) {
    setStatus(id, { status: "error", error: errMsg(e) });
    pushError("元素重绘", errMsg(e));
  }
}

/* ---------- 改字：文字图层换内容保字体风格（白底闭环），写回后同步更新 elemMeta 原文 ---------- */
export async function retouchElementText(id: string, newText: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  const src = nodeMainImage(node);
  const meta = (node?.data as ImageData | undefined)?.elemMeta;
  const orig = meta?.text?.trim();
  if (!node || !src || !meta) {
    toast("当前节点不是文字元素图层", "err");
    return;
  }
  if (!orig) {
    toast("该文字元素没有识别出原文，请用「元素重绘」直接描述要改成的文字", "err");
    return;
  }
  const next = newText.trim();
  if (!next) {
    toast("请输入要替换成的新文字", "err");
    return;
  }
  setStatus(id, { status: "running", error: undefined });
  try {
    const card = resolveModelCard("image", undefined);
    const flat = await flattenToSolid(src);
    const dm = await imageDims(flat);
    const results = await generateImage(card, {
      prompt: elementTextPrompt(orig, next),
      refImages: [flat],
      n: 1,
      size: "auto",
      aspect: imageFamily(card) === "banana" && dm ? nearestAspect(dm.w / dm.h) : undefined,
    });
    const png = await chromaKey(results[0], { key: [255, 255, 255], tolerance: 36, soft: 24 });
    writeMainImage(id, png);
    useBoard.getState().updateData(id, { elemMeta: { ...meta, text: next } });
    finishNodeEdit(id, "元素改字", [png], `「${orig}」→「${next}」`, card.name, card.model);
    toast("文字已替换并抠回透明图层（Ctrl+Z 可撤销）", "ok");
  } catch (e) {
    setStatus(id, { status: "error", error: errMsg(e) });
    pushError("元素改字", errMsg(e));
  }
}

/* ---------- 局部重绘：蒙版选区 → 就地写回 ---------- */
export async function applyInpaint(id: string) {
  const me = useUi.getState().mediaEdit;
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  const src = nodeMainImage(node);
  if (!node || !src) {
    toast("当前节点还没有可编辑的图片", "err");
    return;
  }
  if (!me?.mask) {
    toast("请先在图片上涂抹要重绘的区域", "err");
    return;
  }
  if (node.data.status === "running") return;
  setStatus(id, { status: "running", error: undefined });
  try {
    if ((await maskCoverage(me.mask)) < 0.001) throw new Error("蒙版是空的：请先涂抹或框选要重绘的区域");
    const card = resolveModelCard("image", undefined);
    const family = imageFamily(card);
    const channel: EditChannel = me.channel ?? "auto";
    // 真蒙版通道仅 OpenAI 协议的 images/edits 有 mask 参数；不少中转站转发丢 mask —— 出问题就切指令式
    const useMask = channel === "mask" || (channel === "auto" && family === "gpt");
    if (channel === "mask" && card.protocol === "gemini")
      throw new Error("Gemini 协议没有蒙版参数：请把通道切成「指令式」，或换 OpenAI 协议的绘画模型");
    const userPrompt = (me.prompt ?? "").trim();
    let results: string[];
    if (useMask && card.protocol !== "gemini") {
      const dims = await imageDims(src);
      if (!dims) throw new Error("无法读取原图尺寸");
      const mask = await maskToOpenAiMask(me.mask, dims.w, dims.h);
      results = await generateImage(card, { prompt: inpaintMaskPrompt(userPrompt), refImages: [src], mask, n: 1, size: "auto" });
    } else {
      const annotated = await annotateMaskOnImage(src, me.mask);
      const dims = await imageDims(src);
      results = await generateImage(card, {
        prompt: inpaintInstruct(userPrompt),
        refImages: [src, annotated],
        n: 1,
        size: "auto",
        aspect: family === "banana" && dims ? nearestAspect(dims.w / dims.h) : undefined,
      });
    }
    writeMainImage(id, results[0]);
    finishNodeEdit(id, "局部重绘", results, userPrompt || "自然修复", card.name, card.model);
    useUi.getState().closeMediaEdit();
  } catch (e) {
    // 失败不关闭涂抹会话：蒙版还在，可调整后重试
    setStatus(id, { status: "error", error: errMsg(e) });
    pushError("局部重绘", errMsg(e));
  }
}

/* ---------- 扩图：四边外扩 → 就地写回 ---------- */
export async function applyOutpaint(id: string, pads: OutpaintPads, prompt: string, channel: EditChannel) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  const src = nodeMainImage(node);
  if (!node || !src) {
    toast("当前节点还没有可编辑的图片", "err");
    return;
  }
  if (pads.left + pads.right + pads.up + pads.down <= 0) {
    toast("请先选择扩展方向与幅度（至少一边大于 0）", "err");
    return;
  }
  if (node.data.status === "running") return;
  setStatus(id, { status: "running", error: undefined });
  try {
    const card = resolveModelCard("image", undefined);
    const family = imageFamily(card);
    const useMask = (channel === "mask" || (channel === "auto" && family === "gpt")) && card.protocol !== "gemini";
    if (channel === "mask" && card.protocol === "gemini")
      throw new Error("Gemini 协议没有蒙版参数：请把通道切成「指令式」，或换 OpenAI 协议的绘画模型");
    const userPrompt = prompt.trim();
    let results: string[];
    if (useMask) {
      // 真 mask 外扩：原图摆入扩大的透明画布，透明区域由模型补全
      const built = await buildOutpaintCanvas(src, pads);
      results = await generateImage(card, { prompt: outpaintMaskPrompt(userPrompt), refImages: [built.image], mask: built.mask, n: 1, size: "auto" });
    } else {
      const dims = await imageDims(src);
      if (!dims) throw new Error("无法读取原图尺寸");
      const fullW = dims.w * (1 + pads.left + pads.right);
      const fullH = dims.h * (1 + pads.up + pads.down);
      const targetRatio = fullW / fullH;
      // 指令式：Banana 用比例档；GPT 用换算出的目标宽高（16 倍数、长边 ≤3840）；通用交给站点默认
      const capScale = Math.min(1, 3840 / Math.max(fullW, fullH));
      const to16 = (v: number) => Math.max(256, Math.round((v * capScale) / 16) * 16);
      results = await generateImage(card, {
        prompt: outpaintInstruct(pads, userPrompt),
        refImages: [src],
        n: 1,
        size: family === "gpt" ? `${to16(fullW)}x${to16(fullH)}` : "auto",
        aspect: family === "banana" ? nearestAspect(targetRatio) : undefined,
      });
    }
    writeMainImage(id, results[0]);
    finishNodeEdit(id, "扩图", results, userPrompt || "自然延伸画面", card.name, card.model);
  } catch (e) {
    setStatus(id, { status: "error", error: errMsg(e) });
    pushError("扩图", errMsg(e));
  }
}

/* ---------- 高清增强：重绘式增强 + 放大（绘画模型引擎） → 就地写回 ---------- */
export async function applyEnhance(id: string, params: EnhanceParams) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  const src = nodeMainImage(node);
  if (!node || !src) {
    toast("当前节点还没有可编辑的图片", "err");
    return;
  }
  if (node.data.status === "running") return;
  setStatus(id, { status: "running", error: undefined });
  try {
    const card = resolveModelCard("image", undefined);
    const family = imageFamily(card);
    const dims = await imageDims(src);
    if (!dims) throw new Error("无法读取原图尺寸");
    const factor = params.factor ?? 2;
    const prompt = enhanceInstruct(params.focus ?? "detail");
    // 目标尺寸：原图 × 倍率，长边不超过 3840，取 16 的倍数
    const capScale = Math.min(factor, 3840 / Math.max(dims.w, dims.h));
    const to16 = (v: number) => Math.max(256, Math.round(v / 16) * 16);
    const tw = to16(dims.w * capScale);
    const th = to16(dims.h * capScale);
    const results = await generateImage(card, {
      prompt,
      refImages: [src],
      n: 1,
      size: family === "banana" ? "auto" : `${tw}x${th}`,
      aspect: family === "banana" ? nearestAspect(dims.w / dims.h) : undefined,
      resolution: family === "banana" ? (factor >= 4 || Math.max(tw, th) > 2048 ? "4K" : "2K") : undefined,
      quality: family === "gpt" ? "high" : undefined,
    });
    writeMainImage(id, results[0]);
    finishNodeEdit(id, "高清增强", results, `${factor}× 增强`, card.name, card.model);
  } catch (e) {
    setStatus(id, { status: "error", error: errMsg(e) });
    pushError("高清增强", errMsg(e));
  }
}

/* ---------- 尺寸调整：本地真实重采样（不调模型） → 就地写回 ---------- */
export async function applyResize(id: string, params: ResizeParams) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  const src = nodeMainImage(node);
  if (!node || !src) {
    toast("当前节点还没有可编辑的图片", "err");
    return;
  }
  setStatus(id, { status: "running", error: undefined });
  try {
    const dims = await imageDims(src);
    if (!dims) throw new Error("无法读取原图尺寸");
    const t = targetSize(params, dims.w, dims.h);
    if (t.w === dims.w && t.h === dims.h) {
      setStatus(id, { status: "done" });
      toast(`原图已是 ${t.w}×${t.h}，无需调整`, "info");
      return;
    }
    const result = await resampleImage(src, t.w, t.h);
    writeMainImage(id, result);
    setStatus(id, { status: "done" });
    toast(`已重采样：${dims.w}×${dims.h} → ${t.w}×${t.h}`, "ok");
  } catch (e) {
    setStatus(id, { status: "error", error: errMsg(e) });
    pushError("尺寸调整", errMsg(e));
  }
}
