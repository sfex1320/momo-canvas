/**
 * 节点运行引擎：收集上游 → 调用对应服务 → 结果写回节点 + 收录资产库
 */
import { NODE_LABEL, useBoard } from "./stores/boardStore";
import { useSettings, resolveModelCard, modelKey } from "./stores/settingsStore";
import { useComfy } from "./stores/comfyStore";
import { pushError, toast, useUi } from "./stores/uiStore";
import { useAssets } from "./stores/assetStore";
import { usePromptHist } from "./stores/promptHistStore";
import { chatStream, chatOnce, OPTIMIZE_SYSTEM } from "./services/llm";
import { generateImage } from "./services/imageGen";
import { generateVideo } from "./services/videoGen";
import { webSearch, searchContext } from "./services/webSearch";
import { runComfyTemplate } from "./services/comfy";
import { autoSaveImage } from "./services/imageSaver";
import { gptSize, imageFamily, nearestAspect, parseRatio } from "./modelMeta";
import { videoFamily, videoMeta } from "./videoMeta";
import { imageDims } from "./imageInfo";
import { resampleImage, resizeTextOut, targetSize } from "./resizeMath";
import { buildAnglePrompt, buildRelightPrompt } from "./cameraLight";
import { charAnalysisSystem, DELIV_LABEL } from "./charPresets";
import { annotateMaskOnImage, buildOutpaintCanvas, cropByRect, maskCoverage, maskToOpenAiMask } from "./maskCanvas";
import {
  creativityPhrase,
  enhanceInstruct,
  inpaintInstruct,
  inpaintMaskPrompt,
  mattingInstruct,
  outpaintInstruct,
  outpaintMaskPrompt,
} from "./editPrompts";
import { errMsg, parseJsonLoose } from "./utils";
import { notifyDone } from "./sound";
import { concatVideos, grabFrame, trimVideo } from "./videoEdit";
import type {
  AssetGenMeta,
  CaptionData,
  CharCardData,
  CharDeliverable,
  CharProfile,
  ChatData,
  ChatMsg,
  ComfyData,
  CombineData,
  CropData,
  EnhanceData,
  ImageData,
  ImageGenData,
  InpaintData,
  LlmTextData,
  MattingData,
  MultiAngleData,
  NodeKind,
  OutpaintData,
  PromptData,
  RelightData,
  ResizeData,
  StylePresetData,
  StoryboardData,
  VideoGenData,
  FrameData,
  VideoTrimData,
  VideoConcatData,
} from "./types";

const SEPARATORS: Record<CombineData["separator"], string> = {
  comma: ", ",
  newline: "\n",
  space: " ",
};

/* ---------- 上游收集 ----------
   直接前驱取值；纯文本节点（拼接/风格预设）会向上递归物化自己的输出；
   组节点按成员位置顺序聚合；「忽略」的节点不向下游传递 */

/** 单个节点自身的输出（文本 / 图片） */
function nodeOutput(
  src: { id: string; type?: string; data: unknown },
  visited: Set<string>,
): { texts: string[]; images: string[]; videos: string[] } {
  const texts: string[] = [];
  const images: string[] = [];
  const videos: string[] = [];
  const kind = src.type as NodeKind;
  const d = src.data as Record<string, unknown>;
  switch (kind) {
    case "prompt": {
      const t = ((d as PromptData).text ?? "").trim();
      if (t) texts.push(t);
      break;
    }
    case "chat": {
      const msgs = (d as ChatData).messages ?? [];
      const last = [...msgs].reverse().find((m) => m.role === "assistant");
      if (last?.text) texts.push(last.text.trim());
      break;
    }
    case "caption": {
      const t = ((d as CaptionData).result ?? "").trim();
      if (t) texts.push(t);
      break;
    }
    case "llmText": {
      const t = ((d as LlmTextData).result ?? "").trim();
      if (t) texts.push(t);
      break;
    }
    case "combine": {
      const cd = d as CombineData;
      const up = collectUpstream(src.id, visited);
      const parts = [...up.texts, (cd.extra ?? "").trim()].filter(Boolean);
      if (parts.length) texts.push(parts.join(SEPARATORS[cd.separator] ?? ", "));
      break;
    }
    case "stylePreset": {
      const sel = (d as StylePresetData).selected ?? [];
      if (sel.length) texts.push(sel.join(", "));
      break;
    }
    case "image": {
      const s = (d as ImageData).src;
      if (s) images.push(s);
      break;
    }
    case "imageGen": {
      const g = d as ImageGenData;
      const s = g.results?.[g.picked ?? 0];
      if (s) images.push(s);
      break;
    }
    case "comfy": {
      const g = d as ComfyData;
      const s = g.results?.[g.picked ?? 0];
      if (s) images.push(s);
      for (const v of g.videoResults ?? []) videos.push(v);
      break;
    }
    case "inpaint":
    case "outpaint":
    case "matting":
    case "enhance": {
      const g = d as { results?: string[]; picked?: number };
      const s = g.results?.[g.picked ?? 0];
      if (s) images.push(s);
      break;
    }
    case "crop": {
      const g = d as CropData;
      if (g.result) images.push(g.result);
      break;
    }
    case "relight": {
      const g = d as RelightData;
      if (g.outMode === "prompt") {
        // 提示词模式：不出图，直接向下游物化构造好的打光指令（上游文本作为补充要求并入）
        const up = collectUpstream(src.id, visited);
        texts.push(buildRelightPrompt(g, up.texts));
      } else {
        const s = g.results?.[g.picked ?? 0];
        if (s) images.push(s);
      }
      break;
    }
    case "multiAngle": {
      const g = d as MultiAngleData;
      if (g.outMode === "prompt") {
        const up = collectUpstream(src.id, visited);
        texts.push(buildAnglePrompt(g, up.texts));
      } else {
        const s = g.results?.[g.picked ?? 0];
        if (s) images.push(s);
      }
      break;
    }
    case "resize": {
      const g = d as ResizeData;
      if ((g.out ?? "image") === "image") {
        if (g.result) images.push(g.result);
      } else {
        // 尺寸文本样式：由已测得的上游尺寸即时推导
        const t = resizeTextOut(g);
        if (t) texts.push(t);
      }
      break;
    }
    case "charCard": {
      const g = d as CharCardData;
      const order: CharDeliverable[] = ["turnaround", "closeup", "expressions", "poses", "portrait", "sheet"];
      if (charOutMode(g) === "prompt") {
        // 提示词模式：把勾选素材的提示词逐条输出（下游可接生成图像等节点）
        for (const k of order) {
          const t = (g.prompts?.[k] ?? "").trim();
          if (t && g.deliverables.includes(k)) texts.push(t);
        }
      } else {
        // 出图模式：输出一张代表图（优先立绘 > 三视图 > 近景 > 其余）
        const pref: CharDeliverable[] = ["portrait", "turnaround", "closeup", "expressions", "poses", "sheet"];
        for (const k of pref) {
          const s = g.results?.[k]?.[0];
          if (s) {
            images.push(s);
            break;
          }
        }
      }
      break;
    }
    case "storyboard": {
      const g = d as StoryboardData;
      if (g.shots?.length) texts.push(g.shots.map((sh) => `【${sh.time}】${sh.prompt}`).join("\n"));
      break;
    }
    case "videoGen":
    case "videoTrim":
    case "videoConcat": {
      const u = (d as { resultUrl?: string }).resultUrl;
      if (u) videos.push(u);
      break;
    }
    case "frame": {
      const g = d as FrameData;
      if (g.result) images.push(g.result);
      break;
    }
    default:
      break;
  }
  return { texts, images, videos };
}

type LiteN = { id: string; type?: string; parentId?: string; position: { x: number; y: number }; data: unknown };

/** 指向 nodeId 的连线，按上游节点画布位置（上→下、左→右）排序 —— 图1/段1 的顺序由此决定，可拖动节点调整 */
export function orderedInEdges(
  nodeId: string,
  nodes: LiteN[],
  edges: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }[],
) {
  const absPos = (n: LiteN) => {
    const p = n.parentId ? nodes.find((x) => x.id === n.parentId) : undefined;
    return { x: n.position.x + (p?.position.x ?? 0), y: n.position.y + (p?.position.y ?? 0) };
  };
  return edges
    .filter((e) => e.target === nodeId)
    .sort((a, b) => {
      const na = nodes.find((n) => n.id === a.source);
      const nb = nodes.find((n) => n.id === b.source);
      if (!na || !nb) return 0;
      const pa = absPos(na);
      const pb = absPos(nb);
      return pa.y - pb.y || pa.x - pb.x;
    });
}

export function collectUpstream(
  nodeId: string,
  visited = new Set<string>(),
): { texts: string[]; images: string[]; videos: string[] } {
  const { nodes, edges } = useBoard.getState();
  const texts: string[] = [];
  const images: string[] = [];
  const videos: string[] = [];
  if (visited.has(nodeId)) return { texts, images, videos };
  visited.add(nodeId);

  for (const e of orderedInEdges(nodeId, nodes, edges)) {
    const src = nodes.find((n) => n.id === e.source);
    if (!src) continue;
    if ((src.data as Record<string, unknown>).ignored) continue;
    if (src.type === "group") {
      // 组：成员按位置（上→下、左→右）依次输出；按出口类型分流
      const members = nodes
        .filter((n) => n.parentId === src.id && !(n.data as Record<string, unknown>).ignored)
        .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
      for (const m of members) {
        const o = nodeOutput(m, visited);
        if (e.sourceHandle === "out-image") images.push(...o.images);
        else texts.push(...o.texts);
        videos.push(...o.videos);
      }
      continue;
    }
    // 分镜单镜端口：只输出该镜的提示词
    if (src.type === "storyboard" && e.sourceHandle?.startsWith("shot-")) {
      const g = src.data as StoryboardData;
      const t = g.shots?.[Number(e.sourceHandle.slice(5))]?.prompt?.trim();
      if (t) texts.push(t);
      continue;
    }
    // 角色卡单素材端口：只输出对应素材（提示词模式给提示词，出图模式给首图）
    if (src.type === "charCard" && e.sourceHandle?.startsWith("dl-")) {
      const g = src.data as CharCardData;
      const k = e.sourceHandle.slice(3) as CharDeliverable;
      if (charOutMode(g) === "prompt") {
        const t = (g.prompts?.[k] ?? "").trim();
        if (t) texts.push(t);
      } else {
        const s = g.results?.[k]?.[0];
        if (s) images.push(s);
      }
      continue;
    }
    const o = nodeOutput(src, visited);
    texts.push(...o.texts);
    images.push(...o.images);
    videos.push(...o.videos);
  }
  return { texts, images, videos };
}

/* ---------- 上游明细（节点上「传入」徽标的弹窗预览用） ---------- */
export type UpstreamPart = { from: string; kind: "text" | "image"; value: string };

function nodeTitle(n: LiteN): string {
  const d = n.data as Record<string, unknown>;
  const extra =
    (typeof d.name === "string" && d.name) || (d.profile as { name?: string } | undefined)?.name || "";
  const base = NODE_LABEL[n.type as NodeKind] ?? String(n.type);
  return extra ? `${base} · ${String(extra).slice(0, 14)}` : base;
}

/** 与 collectUpstream 完全同序的上游明细，逐段标注来源节点 */
export function collectUpstreamParts(nodeId: string): UpstreamPart[] {
  const { nodes, edges } = useBoard.getState();
  const out: UpstreamPart[] = [];
  const push = (label: string, o: { texts: string[]; images: string[] }, only?: "text" | "image") => {
    if (only !== "image") for (const t of o.texts) out.push({ from: label, kind: "text", value: t });
    if (only !== "text") for (const s of o.images) out.push({ from: label, kind: "image", value: s });
  };
  for (const e of orderedInEdges(nodeId, nodes, edges)) {
    const src = nodes.find((n) => n.id === e.source);
    if (!src || (src.data as Record<string, unknown>).ignored) continue;
    if (src.type === "group") {
      const members = nodes
        .filter((n) => n.parentId === src.id && !(n.data as Record<string, unknown>).ignored)
        .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
      for (const m of members)
        push(`组 · ${nodeTitle(m)}`, nodeOutput(m, new Set([nodeId])), e.sourceHandle === "out-image" ? "image" : "text");
      continue;
    }
    if (src.type === "charCard" && e.sourceHandle?.startsWith("dl-")) {
      const g = src.data as CharCardData;
      const k = e.sourceHandle.slice(3) as CharDeliverable;
      if (charOutMode(g) === "prompt") {
        const t = (g.prompts?.[k] ?? "").trim();
        if (t) out.push({ from: `${nodeTitle(src)} · ${DELIV_LABEL[k]}`, kind: "text", value: t });
      } else {
        const s = g.results?.[k]?.[0];
        if (s) out.push({ from: `${nodeTitle(src)} · ${DELIV_LABEL[k]}`, kind: "image", value: s });
      }
      continue;
    }
    push(nodeTitle(src), nodeOutput(src, new Set([nodeId])));
  }
  return out;
}

const upd = (id: string, patch: Record<string, unknown>) => useBoard.getState().updateData(id, patch);

/** 角色卡输出模式（兼容旧字段 genImages） */
function charOutMode(d: CharCardData): "image" | "prompt" {
  return d.outMode ?? (d.genImages === false ? "prompt" : "image");
}

/** 提示词语言处理：lang === "en" 时先译成英文（失败则用原文） */
async function localizePrompt(prompt: string, lang?: string): Promise<string> {
  if (lang !== "en" || !prompt.trim()) return prompt;
  try {
    const card = resolveModelCard("chat");
    const en = await chatOnce(card, LLM_TEXT_SYSTEMS.zh2en, prompt);
    return en.trim() || prompt;
  } catch {
    return prompt;
  }
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

/** 收录进资产库（后台静默）；gen = 生成参数快照，资产卡「Remix」按它还原生成节点 */
function collectToLibrary(
  kind: "image" | "video",
  srcs: string[],
  meta: { prompt?: string; model?: string; gen?: AssetGenMeta },
) {
  for (const src of srcs) {
    void useAssets.getState().collect({ src, kind, prompt: meta.prompt, model: meta.model, gen: meta.gen });
  }
}

/** 把提示词里的 @图片名 替换成「图N」，N 与实际传给模型的参考图顺序一致（模型不认识 @名字） */
function resolveAtRefs(prompt: string, nodeId: string): string {
  if (!prompt.includes("@")) return prompt;
  const { nodes, edges } = useBoard.getState();
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const e of orderedInEdges(nodeId, nodes, edges)) {
    if (e.targetHandle !== "in-image" || seen.has(e.source)) continue;
    const n = nodes.find((x) => x.id === e.source);
    if (!n) continue;
    const nd = n.data as Record<string, unknown>;
    const has = n.type === "image" ? !!nd.src : !!(nd.results as string[] | undefined)?.length;
    if (!has) continue;
    seen.add(e.source);
    const raw = n.type === "image" && nd.name ? String(nd.name).replace(/\.\w+$/, "") : "";
    labels.push(raw ? raw.slice(0, 12) : `图${labels.length + 1}`);
  }
  let out = prompt;
  labels.forEach((lab, i) => {
    out = out.split(`@${lab}`).join(`图${i + 1}`);
  });
  return out;
}

/* ---------- 生成图像 ---------- */

/** 上游「尺寸指令」文本（尺寸调整节点输出的 "1024x768" / "16:9"）：不进提示词，转为尺寸设置 */
const SIZE_DIR_RE = /^\s*(\d{2,5})\s*[x×X]\s*(\d{2,5})\s*$/;
const RATIO_DIR_RE = /^\s*\d{1,4}(?:\.\d+)?\s*[:：]\s*\d{1,4}(?:\.\d+)?\s*$/;
function isSizeDirective(t: string): boolean {
  return SIZE_DIR_RE.test(t) || RATIO_DIR_RE.test(t);
}
function applySizeDirective(dir: string, family: string, tier?: string): { size?: string; aspect?: string } {
  const m = dir.match(SIZE_DIR_RE);
  if (m) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    return family === "banana" ? { aspect: nearestAspect(w / h) } : { size: `${w}x${h}` };
  }
  const ratio = dir.trim().replace("：", ":");
  const r = parseRatio(ratio);
  if (!r) return {};
  if (family === "banana") return { aspect: nearestAspect(r) };
  const s = gptSize(ratio, tier ?? "1K");
  return s ? { size: `${s.w}x${s.h}` } : {};
}

export async function runImageGen(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as ImageGenData;
  if (data.status === "running") return;
  const { texts, images } = collectUpstream(id);
  const sizeDirectives = texts.filter(isSizeDirective);
  const promptTexts = texts.filter((t) => !isSizeDirective(t));
  const prompt = (data.prompt ?? "").trim() || promptTexts.join("\n");
  if (!prompt && !images.length) {
    toast("请输入提示词，或连接一个提示词/对话节点", "err");
    return;
  }
  upd(id, { status: "running", error: undefined });
  try {
    const card = resolveModelCard("image", data.modelId);
    const family = imageFamily(card);
    let finalPrompt = await localizePrompt(resolveAtRefs(prompt, id), data.lang);
    // 创意度（仅图生图）：翻译成模型能懂的力度描述，附在提示词末尾
    const cv = images.length ? creativityPhrase(data.creativity) : null;
    if (cv) finalPrompt = `${finalPrompt}\n${cv}`;
    // 自定义宽高优先；Nano Banana 走 aspect/resolution，不传 size
    const customSize = data.width && data.height ? `${data.width}x${data.height}` : undefined;
    let size = family === "banana" ? undefined : customSize ?? (data.size === "default" ? card.size : data.size);
    let aspect = family === "banana" ? data.aspect : undefined;
    const dir = sizeDirectives[sizeDirectives.length - 1];
    if (dir) {
      // 1) 上游尺寸指令（尺寸调整节点）优先替换本节点尺寸设置
      const o = applySizeDirective(dir, family, data.resolution);
      if (o.aspect) aspect = o.aspect;
      if (o.size) size = o.size;
    } else if (images.length) {
      // 2) auto：未手动指定尺寸时，跟随第一张参考图的比例；没图才落回服务商配置
      const autoBanana = family === "banana" && (!aspect || aspect === "auto");
      const autoOther = family !== "banana" && !customSize && data.size === "default";
      if (autoBanana || autoOther) {
        const dm = await imageDims(images[0]);
        if (dm) {
          if (family === "banana") aspect = nearestAspect(dm.w / dm.h);
          else {
            const s = gptSize(`${dm.w}:${dm.h}`, family === "gpt" ? (data.resolution ?? "1K") : "1K");
            if (s) size = `${s.w}x${s.h}`;
          }
        }
      }
    }
    const results = await generateImage(card, {
      prompt: finalPrompt,
      size,
      n: data.count ?? 1,
      refImages: images.length ? images : undefined,
      aspect,
      resolution: family === "banana" ? data.resolution : undefined,
      quality: family === "gpt" ? data.quality : undefined,
    });
    upd(id, { status: "done", results, picked: 0 });
    usePromptHist.getState().record(prompt);
    for (const src of results) {
      useUi.getState().addGallery({ kind: "image", src, prompt, model: card.model, nodeId: id });
    }
    collectToLibrary("image", results, {
      prompt,
      model: card.name,
      gen: {
        nodeKind: "imageGen",
        prompt: (data.prompt ?? "").trim() || prompt,
        modelId: modelKey(card.id, card.model),
        size: data.size,
        aspect: data.aspect,
        resolution: data.resolution,
        quality: data.quality,
        width: data.width,
        height: data.height,
        lang: data.lang,
        creativity: data.creativity,
      },
    });
    void maybeAutoSave(results, { prompt, model: card.model });
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e) });
    pushError("生成图像", errMsg(e));
  }
}

/** 多模型对比：以该生成节点为母版，为每个所选模型克隆一个节点（继承参数 + 复制上游连线），并行出图横向对比 */
export async function runModelCompare(id: string, keys: string[]) {
  const s = useBoard.getState();
  const node = s.nodes.find((n) => n.id === id);
  if (!node || node.type !== "imageGen" || !keys.length) return;
  const base = node.data as ImageGenData;
  const parent = node.parentId ? s.nodes.find((n) => n.id === node.parentId) : undefined;
  const baseX = node.position.x + (parent?.position.x ?? 0);
  const baseY = node.position.y + (parent?.position.y ?? 0);
  const w = node.measured?.width ?? 310;
  const inEdges = s.edges.filter((e) => e.target === id);
  const ids: string[] = [];
  keys.forEach((key, i) => {
    const bs = useBoard.getState();
    const nid = bs.addNode(
      "imageGen",
      { x: baseX + (w + 70) * (i + 1), y: baseY },
      { ...base, modelId: key, status: "idle", error: undefined, results: [], picked: 0 },
    );
    for (const e of inEdges) bs.connectNodes(e.source, nid, e.targetHandle ?? "in-text", e.sourceHandle ?? "out");
    ids.push(nid);
  });
  toast(`已按 ${keys.length} 个模型建立对比节点，并行生成中…`, "info");
  await Promise.all(ids.map((nid) => runImageGen(nid)));
  notifyDone("多模型对比");
}

/**
 * 批量出图（按提示词）：每行克隆一个生成节点并行运行。
 * 共用前缀：节点自己的提示词 + 上游文本（风格/定调）会附加到每一条前面——
 * 「1 条共用 + N 条细节」场景直接把共用的写在节点/上游，细节逐行贴进来。
 */
export async function runBatchPrompts(id: string, lines: string[]) {
  const s = useBoard.getState();
  const node = s.nodes.find((n) => n.id === id);
  const prompts = lines.map((l) => l.trim()).filter(Boolean);
  if (!node || (node.type !== "imageGen" && node.type !== "videoGen") || !prompts.length) return;
  const isVideo = node.type === "videoGen";
  const runOne = isVideo ? runVideoGen : runImageGen;
  const resetFields = isVideo
    ? { resultUrl: undefined, progress: undefined }
    : { results: [], picked: 0 };
  const base = node.data as ImageGenData;
  // 共用前缀 = 节点提示词 + 上游文本（尺寸指令除外）
  const upTexts = collectUpstream(id).texts.filter((t) => !isSizeDirective(t));
  const shared = [(base.prompt ?? "").trim(), ...upTexts].filter(Boolean).join("\n");
  const parent = node.parentId ? s.nodes.find((n) => n.id === node.parentId) : undefined;
  const baseX = node.position.x + (parent?.position.x ?? 0);
  const baseY = node.position.y + (parent?.position.y ?? 0);
  const w = node.measured?.width ?? 310;
  const h = node.measured?.height ?? 320;
  // 继承图片连线（参考图共用）；文本已物化进各条提示词，不再连文本边
  const inEdges = s.edges.filter((e) => e.target === id && e.targetHandle === "in-image");
  const ids: string[] = [];
  const COLS = 4;
  prompts.forEach((line, i) => {
    const bs = useBoard.getState();
    const nid = bs.addNode(
      node.type as NodeKind,
      { x: baseX + (w + 70) * ((i % COLS) + 1), y: baseY + Math.floor(i / COLS) * (h + 90) },
      { ...base, prompt: shared ? `${shared}\n${line}` : line, status: "idle", error: undefined, ...resetFields },
    );
    for (const e of inEdges) bs.connectNodes(e.source, nid, e.targetHandle ?? "in-image", e.sourceHandle ?? "out");
    ids.push(nid);
  });
  toast(`批量生成：已建立 ${prompts.length} 个节点，并行生成中…${shared ? "（共用提示词已附加到每条）" : ""}`, "info");
  await Promise.all(ids.map((nid) => runOne(nid)));
  notifyDone("批量生成");
}

/** 批量出图（按参考图）：每路上游图片克隆一个生成节点单独处理（文本连线全部继承），并行运行 */
export async function runBatchImages(id: string) {
  const s = useBoard.getState();
  const node = s.nodes.find((n) => n.id === id);
  if (!node || (node.type !== "imageGen" && node.type !== "videoGen")) return;
  const isVideo = node.type === "videoGen";
  const runOne = isVideo ? runVideoGen : runImageGen;
  const resetFields = isVideo ? { resultUrl: undefined, progress: undefined } : { results: [], picked: 0 };
  const imgEdges = s.edges.filter((e) => e.target === id && e.targetHandle === "in-image");
  if (imgEdges.length < 2) {
    toast("按参考图批量需要接入至少 2 路上游图片", "err");
    return;
  }
  const base = node.data as ImageGenData;
  const parent = node.parentId ? s.nodes.find((n) => n.id === node.parentId) : undefined;
  const baseX = node.position.x + (parent?.position.x ?? 0);
  const baseY = node.position.y + (parent?.position.y ?? 0);
  const w = node.measured?.width ?? 310;
  const h = node.measured?.height ?? 320;
  const textEdges = s.edges.filter((e) => e.target === id && e.targetHandle !== "in-image");
  const ids: string[] = [];
  const COLS = 4;
  imgEdges.forEach((imgEdge, i) => {
    const bs = useBoard.getState();
    const nid = bs.addNode(
      node.type as NodeKind,
      { x: baseX + (w + 70) * ((i % COLS) + 1), y: baseY + Math.floor(i / COLS) * (h + 90) },
      { ...base, status: "idle", error: undefined, ...resetFields },
    );
    bs.connectNodes(imgEdge.source, nid, imgEdge.targetHandle ?? "in-image", imgEdge.sourceHandle ?? "out");
    for (const e of textEdges) bs.connectNodes(e.source, nid, e.targetHandle ?? "in-text", e.sourceHandle ?? "out");
    ids.push(nid);
  });
  toast(`按参考图批量：${imgEdges.length} 路图片各建一个生成节点，并行生成中…`, "info");
  await Promise.all(ids.map((nid) => runOne(nid)));
  notifyDone("按参考图批量");
}

/* ---------- 生成视频 ---------- */
export async function runVideoGen(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as VideoGenData;
  if (data.status === "running") return;
  const { texts, images } = collectUpstream(id);
  const prompt = (data.prompt ?? "").trim() || texts.join("\n");
  if (!prompt && !images.length) {
    toast("请输入视频描述，或连接提示词/图片节点", "err");
    return;
  }
  upd(id, { status: "running", error: undefined, progress: "提交任务…", resultUrl: undefined });
  try {
    const card = resolveModelCard("video", data.modelId);
    const meta = videoMeta(videoFamily(card));
    const finalPrompt = await localizePrompt(prompt, (data as { lang?: string }).lang);
    // 第 1 路上游图 = 首帧；第 2 路 = 尾帧（家族支持且未关闭时）
    const lastFrame = meta.tail && (data.useTail ?? true) && images.length >= 2 ? images[1] : undefined;
    const url = await generateVideo(card, {
      prompt: finalPrompt,
      image: images[0],
      lastFrame,
      duration: data.duration,
      resolution: data.resolution,
      aspect: data.aspect,
      audio: meta.audioToggle ? data.audio : undefined,
      onProgress: (m) => upd(id, { progress: m }),
    });
    upd(id, { status: "done", resultUrl: url, progress: undefined });
    usePromptHist.getState().record(prompt);
    useUi.getState().addGallery({ kind: "video", src: url, prompt, model: card.model, nodeId: id });
    collectToLibrary("video", [url], {
      prompt,
      model: card.name,
      gen: { nodeKind: "videoGen", prompt: (data.prompt ?? "").trim() || prompt, modelId: modelKey(card.id, card.model), lang: data.lang },
    });
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e), progress: undefined });
    pushError("生成视频", errMsg(e));
  }
}

/* ---------- ComfyUI ---------- */
export async function runComfy(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as ComfyData;
  if (data.status === "running") return;
  const tpl = useComfy.getState().templates.find((t) => t.id === data.templateId);
  if (!tpl) {
    toast("请先为该节点选择一个 ComfyUI 模板", "err");
    return;
  }
  const settings = useSettings.getState().settings;
  const { texts, images, videos: upVideos } = collectUpstream(id);
  upd(id, { status: "running", error: undefined, progress: "准备参数…", progressPct: undefined });
  try {
    // 只收集用户在节点上手填的值；上游图/文交给服务层自动识别入口（图片参数 → LoadImage → 缺失图片输入自动注入）
    const values: Record<string, string | number | boolean> = {};
    for (const p of tpl.params) {
      const own = data.params?.[p.key];
      if (own !== undefined && own !== "") values[p.key] = own;
    }
    const { images: results, texts: outTexts, videos: outVideos } = await runComfyTemplate(settings.comfy.host, tpl, values, {
      onProgress: (m, pct) => upd(id, { progress: m, ...(pct !== undefined ? { progressPct: pct } : {}) }),
      upstreamImages: images,
      upstreamTexts: texts,
      upstreamVideos: upVideos,
    });
    upd(id, {
      status: "done",
      results,
      picked: 0,
      textOut: outTexts.length ? outTexts.join("\n\n") : undefined,
      videoResults: outVideos.length ? outVideos : undefined,
      progress: undefined,
      progressPct: undefined,
    });
    const promptText = String(values[tpl.params.find((p) => p.kind === "text")?.key ?? ""] ?? texts.join("\n") ?? "");
    if (results.length) {
      for (const src of results) {
        useUi.getState().addGallery({ kind: "image", src, prompt: promptText, model: tpl.name, nodeId: id });
      }
      collectToLibrary("image", results, { prompt: promptText, model: `ComfyUI · ${tpl.name}` });
      void maybeAutoSave(results, { prompt: promptText, model: tpl.name });
    }
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e), progress: undefined, progressPct: undefined });
    pushError("ComfyUI", errMsg(e));
  }
}

/* ---------- 对话 ---------- */
export async function sendChat(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as ChatData;
  if (data.status === "running") return;
  const draft = (data.draft ?? "").trim();
  if (!draft) return;
  const settings = useSettings.getState().settings;
  const { texts, images } = collectUpstream(id);

  const userMsg: ChatMsg = { role: "user", text: draft, images: images.length ? images : undefined };
  let history: ChatMsg[] = [...(data.messages ?? []), userMsg];
  upd(id, { status: "running", error: undefined, draft: "", messages: history });

  try {
    const card = resolveModelCard("chat", data.modelId);
    let system: string | undefined;
    let sources: ChatMsg["sources"];
    if (data.webSearch) {
      upd(id, { messages: [...history, { role: "assistant", text: "", reasoning: "正在联网搜索…" }] });
      try {
        sources = await webSearch(settings.search, draft);
        system = searchContext(sources ?? []);
      } catch (e) {
        toast(`联网搜索失败，将直接回答：${errMsg(e)}`, "err");
      }
    }

    const assistant: ChatMsg = { role: "assistant", text: "", reasoning: "", sources };
    const commit = () => upd(id, { messages: [...history, { ...assistant }] });
    commit();

    // 上游文本作为对话上下文（此前端口画了却被无视：接了提示词等文本节点毫无作用）
    const upCtx = texts.length ? `画布上游节点传入的参考内容，回答时请结合：\n${texts.join("\n---\n")}` : undefined;
    system = [upCtx, system].filter(Boolean).join("\n\n") || undefined;

    await chatStream(card, history, {
      system,
      onText: (full) => {
        assistant.text = full;
        commit();
      },
      onReasoning: (full) => {
        assistant.reasoning = full;
        commit();
      },
    });
    history = [...history, { ...assistant }];
    upd(id, { status: "done", messages: history });
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e), messages: history });
    pushError("对话", errMsg(e));
  }
}

/* ---------- 提示词 AI 优化 ---------- */
export async function optimizePrompt(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as PromptData;
  const text = (data.text ?? "").trim();
  if (!text) {
    toast("先写一点想法，再让 AI 帮你扩写", "err");
    return;
  }
  upd(id, { optimizing: true });
  try {
    const card = resolveModelCard("chat");
    const optimized = await chatOnce(card, OPTIMIZE_SYSTEM, text);
    upd(id, { text: optimized, optimizing: false });
  } catch (e) {
    upd(id, { optimizing: false });
    toast(errMsg(e), "err");
  }
}

/* ---------- 反推描述 ---------- */
const CAPTION_SYSTEMS: Record<CaptionData["mode"], string> = {
  prompt:
    "你是图像反推提示词专家。仔细观察用户发来的图片，输出一段可直接用于 AI 绘画复现该图的中文提示词：主体、构图、风格、光影、色彩、镜头、质感。只输出提示词本身。",
  detail: "你是图像分析师。详细描述用户发来的图片：主体内容、场景、风格、构图、色彩与值得注意的细节。用中文分段描述。",
  tags: "观察用户发来的图片，输出 15-25 个英文标签词（danbooru 风格，逗号分隔），从主体到风格到质感排列。只输出标签。",
};

export async function runCaption(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as CaptionData;
  if (data.status === "running") return;
  const { images } = collectUpstream(id);
  if (!images.length) {
    toast("请先连接一个上游图片节点", "err");
    return;
  }
  upd(id, { status: "running", error: undefined });
  try {
    const card = resolveModelCard("chat", data.modelId);
    const { text } = await chatStream(
      card,
      [{ role: "user", text: "请分析这张图片。", images: [images[0]] }],
      {
        system: CAPTION_SYSTEMS[data.mode] ?? CAPTION_SYSTEMS.prompt,
        onText: (full) => upd(id, { result: full }),
      },
    );
    upd(id, { status: "done", result: text.trim() });
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e) });
    pushError("反推描述", errMsg(e));
  }
}

/* ---------- 文本处理 ---------- */
const LLM_TEXT_SYSTEMS: Record<Exclude<LlmTextData["op"], "custom">, string> = {
  optimize: OPTIMIZE_SYSTEM,
  zh2en: "把用户输入的绘画提示词翻译成地道的英文 AI 绘画提示词，保留专业术语，只输出翻译结果。",
  expand: "把用户输入的文字扩写得更丰富具体（补充细节、场景、氛围），保持原意，中文输出，只输出扩写结果。",
  shorten: "把用户输入的文字精简压缩，保留核心信息与关键词，只输出精简结果。",
};

export async function runLlmText(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as LlmTextData;
  if (data.status === "running") return;
  const { texts } = collectUpstream(id);
  const input = texts.join("\n").trim();
  if (!input) {
    toast("请先连接上游文本节点（提示词/对话等）", "err");
    return;
  }
  upd(id, { status: "running", error: undefined });
  try {
    const card = resolveModelCard("chat", data.modelId);
    const system =
      data.op === "custom"
        ? (data.custom ?? "").trim() || "按用户期望处理输入文本，只输出处理结果。"
        : LLM_TEXT_SYSTEMS[data.op];
    const { text } = await chatStream(card, [{ role: "user", text: input }], {
      system,
      onText: (full) => upd(id, { result: full }),
    });
    upd(id, { status: "done", result: text.trim() });
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e) });
    pushError("文本处理", errMsg(e));
  }
}

/* ---------- 打光 ---------- */
export async function runRelight(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as RelightData;
  if (data.status === "running") return;
  if (data.outMode === "prompt") {
    // 提示词模式：输出由参数即时推导（nodeOutput），无需调用模型
    upd(id, { status: "done", error: undefined });
    return;
  }
  const { texts, images } = collectUpstream(id);
  if (!images.length) {
    toast("请先连接一个上游图片节点（打光需要一张原图）", "err");
    return;
  }
  upd(id, { status: "running", error: undefined });
  try {
    const card = resolveModelCard("image", data.modelId);
    const prompt = buildRelightPrompt(data, texts);
    const results = await generateImage(card, { prompt, n: 1, refImages: [images[0]] });
    upd(id, { status: "done", results, picked: 0 });
    for (const src of results) {
      useUi.getState().addGallery({ kind: "image", src, prompt, model: card.model, nodeId: id });
    }
    collectToLibrary("image", results, { prompt: "打光：" + prompt.split("\n")[1], model: card.name });
    void maybeAutoSave(results, { prompt, model: card.model });
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e) });
    pushError("打光", errMsg(e));
  }
}

/* ---------- 多角度 ---------- */
export async function runMultiAngle(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as MultiAngleData;
  if (data.status === "running") return;
  if (data.outMode === "prompt") {
    upd(id, { status: "done", error: undefined });
    return;
  }
  const { texts, images } = collectUpstream(id);
  if (!images.length) {
    toast("请先连接一个上游图片节点（多角度需要一张原图）", "err");
    return;
  }
  upd(id, { status: "running", error: undefined });
  try {
    const card = resolveModelCard("image", data.modelId);
    const prompt = buildAnglePrompt(data, texts);
    const results = await generateImage(card, { prompt, n: 1, refImages: [images[0]] });
    upd(id, { status: "done", results, picked: 0 });
    for (const src of results) {
      useUi.getState().addGallery({ kind: "image", src, prompt, model: card.model, nodeId: id });
    }
    collectToLibrary("image", results, { prompt: "多角度：" + prompt.split("\n")[0], model: card.name });
    void maybeAutoSave(results, { prompt, model: card.model });
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e) });
    pushError("多角度", errMsg(e));
  }
}

/* ---------- 尺寸调整 ---------- */
export async function runResize(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as ResizeData;
  if (data.status === "running") return;
  const { images } = collectUpstream(id);
  const src = images[0];
  if (!src) {
    toast("请先连接一个上游图片节点", "err");
    return;
  }
  upd(id, { status: "running", error: undefined });
  try {
    const dims = await imageDims(src);
    if (!dims) throw new Error("无法读取上游图片尺寸");
    upd(id, { srcW: dims.w, srcH: dims.h });
    if ((data.out ?? "image") !== "image") {
      // 尺寸文本输出：由参数即时推导（nodeOutput），无需真正处理图片
      upd(id, { status: "done" });
      return;
    }
    const t = targetSize(data, dims.w, dims.h);
    const result = await resampleImage(src, t.w, t.h);
    upd(id, { status: "done", result, outW: t.w, outH: t.h });
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e) });
    pushError("尺寸调整", errMsg(e));
  }
}

/* ---------- 图片编辑类节点（局部重绘 / 扩图 / 抠图 / 增强 / 聚焦）
   GPT Image 家族走 images/edits 的真 mask/background 通道；
   Banana / 通用家族走「参考图 + 中文指令」降级通道（中转站模型能力所限） ---------- */

/** 编辑类节点通用收尾：写回结果 + 生成记录 + 资产库 + 自动保存 */
function finishEdit(id: string, source: string, results: string[], prompt: string, cardName: string, cardModel: string) {
  upd(id, { status: "done", results, picked: 0, progress: undefined });
  for (const src of results) {
    useUi.getState().addGallery({ kind: "image", src, prompt, model: cardModel, nodeId: id });
  }
  collectToLibrary("image", results, { prompt: `${source}：${prompt.split("\n")[0]}`, model: cardName });
  void maybeAutoSave(results, { prompt, model: cardModel });
}

export async function runInpaint(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as InpaintData;
  if (data.status === "running") return;
  const { texts, images } = collectUpstream(id);
  const src = images[0];
  if (!src) {
    toast("请先连接一个上游图片节点（局部重绘需要一张原图）", "err");
    return;
  }
  if (!data.mask) {
    toast("请先点击「编辑蒙版」，涂抹或框选要重绘的区域", "err");
    return;
  }
  upd(id, { status: "running", error: undefined });
  try {
    if ((await maskCoverage(data.mask)) < 0.001) throw new Error("蒙版是空的：请先涂抹或框选要重绘的区域");
    const card = resolveModelCard("image", data.modelId);
    const family = imageFamily(card);
    const channel = data.channel ?? "auto";
    // 真蒙版通道仅 OpenAI 协议的 images/edits 有 mask 参数；且不少中转站转发时会丢 mask —— 出问题就切指令式
    const useMask = channel === "mask" || (channel === "auto" && family === "gpt");
    if (channel === "mask" && card.protocol === "gemini")
      throw new Error("Gemini 协议没有蒙版参数：请把通道切成「指令式」，或换 OpenAI 协议的绘画模型");
    const userPrompt = (data.prompt ?? "").trim() || texts.filter((t) => !isSizeDirective(t)).join("\n");
    const finalPrompt = await localizePrompt(userPrompt, data.lang);
    const n = data.count ?? 1;
    let results: string[];
    if (useMask && card.protocol !== "gemini") {
      const dims = await imageDims(src);
      if (!dims) throw new Error("无法读取原图尺寸");
      const mask = await maskToOpenAiMask(data.mask, dims.w, dims.h);
      results = await generateImage(card, { prompt: inpaintMaskPrompt(finalPrompt), refImages: [src], mask, n, size: "auto" });
    } else {
      const annotated = await annotateMaskOnImage(src, data.mask);
      const dims = await imageDims(src);
      results = await generateImage(card, {
        prompt: inpaintInstruct(finalPrompt),
        refImages: [src, annotated],
        n,
        size: "auto",
        aspect: family === "banana" && dims ? nearestAspect(dims.w / dims.h) : undefined,
      });
    }
    finishEdit(id, "局部重绘", results, userPrompt || "自然修复", card.name, card.model);
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e) });
    pushError("局部重绘", errMsg(e));
  }
}

export async function runOutpaint(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as OutpaintData;
  if (data.status === "running") return;
  const { texts, images } = collectUpstream(id);
  const src = images[0];
  if (!src) {
    toast("请先连接一个上游图片节点（扩图需要一张原图）", "err");
    return;
  }
  const pads = data.pads ?? { left: 0, right: 0, up: 0, down: 0 };
  if (pads.left + pads.right + pads.up + pads.down <= 0) {
    toast("请先选择扩展方向与幅度（至少一边大于 0）", "err");
    return;
  }
  upd(id, { status: "running", error: undefined });
  try {
    const card = resolveModelCard("image", data.modelId);
    const family = imageFamily(card);
    const channel = data.channel ?? "auto";
    const useMask = (channel === "mask" || (channel === "auto" && family === "gpt")) && card.protocol !== "gemini";
    if (channel === "mask" && card.protocol === "gemini")
      throw new Error("Gemini 协议没有蒙版参数：请把通道切成「指令式」，或换 OpenAI 协议的绘画模型");
    const userPrompt = (data.prompt ?? "").trim() || texts.filter((t) => !isSizeDirective(t)).join("\n");
    const n = data.count ?? 1;
    let results: string[];
    if (useMask) {
      // 真 mask 外扩：原图摆入扩大的透明画布，透明区域由模型补全
      const built = await buildOutpaintCanvas(src, pads);
      results = await generateImage(card, { prompt: outpaintMaskPrompt(userPrompt), refImages: [built.image], mask: built.mask, n, size: "auto" });
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
        n,
        size: family === "gpt" ? `${to16(fullW)}x${to16(fullH)}` : "auto",
        aspect: family === "banana" ? nearestAspect(targetRatio) : undefined,
      });
    }
    finishEdit(id, "扩图", results, userPrompt || "自然延伸画面", card.name, card.model);
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e) });
    pushError("扩图", errMsg(e));
  }
}

/** 编辑节点的 ComfyUI 引擎：上传上游图 → 跑所选模板 → 返回图片（模板没选好时返回 null 并提示） */
async function runEditViaComfy(
  id: string,
  src: string,
  templateId: string | undefined,
  fillText?: string,
): Promise<{ images: string[]; name: string } | null> {
  const tpl = useComfy.getState().templates.find((t) => t.id === templateId);
  if (!tpl) {
    toast("请先在节点里选择一个 ComfyUI 模板（模板管理器可导入抠图/放大工作流）", "err");
    return null;
  }
  const settings = useSettings.getState().settings;
  // 图片/文本交给服务层自动喂入（图片参数 → LoadImage → 缺失图片输入自动注入），其余参数用模板默认值
  const { images } = await runComfyTemplate(settings.comfy.host, tpl, {}, {
    onProgress: (m, pct) => upd(id, { progress: pct !== undefined ? `${m} ${pct}%` : m }),
    upstreamImages: [src],
    upstreamTexts: fillText ? [fillText] : undefined,
  });
  if (!images.length) throw new Error(`模板「${tpl.name}」运行完成但没有输出图片，请检查输出节点设置`);
  return { images, name: tpl.name };
}

export async function runMatting(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as MattingData;
  if (data.status === "running") return;
  const { images } = collectUpstream(id);
  const src = images[0];
  if (!src) {
    toast("请先连接一个上游图片节点（抠图需要一张原图）", "err");
    return;
  }
  upd(id, { status: "running", error: undefined });
  try {
    // ComfyUI 引擎：rembg/BiRefNet 等真·抠图（推荐），结果一般为透明底
    if ((data.engine ?? "model") === "comfy") {
      const out = await runEditViaComfy(id, src, data.comfyTemplateId, (data.subject ?? "").trim() || undefined);
      if (!out) {
        upd(id, { status: "idle", progress: undefined });
        return;
      }
      finishEdit(id, "抠图", out.images, (data.subject ?? "").trim() || "主体抠图", `ComfyUI · ${out.name}`, out.name);
      return;
    }
    const card = resolveModelCard("image", data.modelId);
    const family = imageFamily(card);
    const transparentOk = family === "gpt";
    if (data.bg === "transparent" && !transparentOk) {
      toast("当前模型不支持透明通道，已自动改为纯白底（要真透明请把引擎切成 ComfyUI 或选 GPT Image 系模型）", "info");
    }
    const prompt = mattingInstruct(data.subject ?? "", data.bg, transparentOk);
    const dims = await imageDims(src);
    const results = await generateImage(card, {
      prompt,
      refImages: [src],
      n: 1,
      size: "auto",
      background: transparentOk && data.bg === "transparent" ? "transparent" : undefined,
      aspect: family === "banana" && dims ? nearestAspect(dims.w / dims.h) : undefined,
    });
    finishEdit(id, "抠图", results, (data.subject ?? "").trim() || "主体抠图", card.name, card.model);
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e) });
    pushError("抠图", errMsg(e));
  }
}

export async function runEnhance(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as EnhanceData;
  if (data.status === "running") return;
  const { images } = collectUpstream(id);
  const src = images[0];
  if (!src) {
    toast("请先连接一个上游图片节点（增强需要一张原图）", "err");
    return;
  }
  upd(id, { status: "running", error: undefined });
  try {
    // ComfyUI 引擎：UltimateSDUpscale / 放大模型等专业放大（推荐）
    if ((data.engine ?? "model") === "comfy") {
      const out = await runEditViaComfy(id, src, data.comfyTemplateId);
      if (!out) {
        upd(id, { status: "idle", progress: undefined });
        return;
      }
      finishEdit(id, "高清增强", out.images, "ComfyUI 放大", `ComfyUI · ${out.name}`, out.name);
      return;
    }
    const card = resolveModelCard("image", data.modelId);
    const family = imageFamily(card);
    const dims = await imageDims(src);
    if (!dims) throw new Error("无法读取原图尺寸");
    const factor = data.factor ?? 2;
    const prompt = enhanceInstruct(data.focus ?? "detail");
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
    finishEdit(id, "高清增强", results, `${factor}× 增强`, card.name, card.model);
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e) });
    pushError("高清增强", errMsg(e));
  }
}

export async function runCrop(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as CropData;
  if (data.status === "running") return;
  const { images } = collectUpstream(id);
  const src = images[0];
  if (!src) {
    toast("请先连接一个上游图片节点", "err");
    return;
  }
  if (!data.rect) {
    toast("请先点击「框选区域」，圈出要聚焦的局部", "err");
    return;
  }
  upd(id, { status: "running", error: undefined });
  try {
    const dims = await imageDims(src);
    const out = await cropByRect(src, data.rect);
    upd(id, { status: "done", result: out.dataUrl, srcW: dims?.w, srcH: dims?.h });
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e) });
    pushError("聚焦裁剪", errMsg(e));
  }
}

/* ---------- 角色卡 ---------- */
type CharAnalysis = { profile: CharProfile; prompts: Partial<Record<CharDeliverable, string>> };

/** 读取节点当前的角色卡数据（生成过程中多次写回，需要拿最新值） */
function charData(id: string): CharCardData | undefined {
  return useBoard.getState().nodes.find((n) => n.id === id)?.data as CharCardData | undefined;
}

/** 生成单个素材并写回（收录记录/资产库）；返回第一张结果 */
async function genCharDeliverable(
  id: string,
  k: CharDeliverable,
  prompt: string,
  refs: string[],
): Promise<string | undefined> {
  const data = charData(id);
  if (!data) return;
  const card = resolveModelCard("image", data.imageModelId);
  const results = await generateImage(card, { prompt, n: 1, refImages: refs.length ? refs.slice(0, 2) : undefined });
  const cur = charData(id);
  upd(id, { results: { ...(cur?.results ?? {}), [k]: results } });
  const name = `${cur?.profile?.name ?? "角色"} · ${DELIV_LABEL[k]}`;
  for (const src of results) {
    useUi.getState().addGallery({ kind: "image", src, prompt, model: card.model, nodeId: id });
    void useAssets.getState().collect({ src, kind: "image", name, prompt, model: card.name });
  }
  return results[0];
}

/** 角色卡完整流程：（无档案时）视觉分析 → 依次生成勾选素材；首张产出作为后续参考图保证一致 */
export async function runCharCard(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as CharCardData;
  if (data.status === "running") return;
  const { texts, images } = collectUpstream(id);
  const refImage = images[0] as string | undefined;
  let profile = data.profile;
  let prompts = { ...data.prompts };
  if (!profile && !refImage && !texts.length) {
    toast("请先连接一张人物图片或一段角色文字描述，也可以从角色库应用预设", "err");
    return;
  }
  upd(id, { status: "running", error: undefined, progress: !profile ? "模型分析角色中…" : undefined });
  try {
    if (!profile) {
      const chatCard = resolveModelCard("chat", data.chatModelId);
      // 有图分析图（文字作补充要求）；没图就按文字描述凭空设定角色
      const userText = refImage
        ? ["请分析这张人物图片并按要求输出 JSON。", texts.length ? `补充设定要求：${texts.join("；")}` : ""]
            .filter(Boolean)
            .join("\n")
        : `没有参考图片。请根据以下角色文字描述完成设定并按要求输出 JSON：\n${texts.join("\n")}`;
      const { text } = await chatStream(
        chatCard,
        [{ role: "user", text: userText, images: refImage ? [refImage] : undefined }],
        { system: charAnalysisSystem(data.style, data.lang) },
      );
      const parsed = parseJsonLoose<CharAnalysis>(text);
      if (!parsed?.profile?.name || !parsed.prompts) {
        throw new Error("角色分析结果解析失败：模型没有按 JSON 格式返回，请重试或换一个对话模型");
      }
      profile = parsed.profile;
      prompts = parsed.prompts;
      upd(id, { profile, prompts, progress: undefined });
    }
    if (charOutMode(data) === "image") {
      const list = data.deliverables.filter((k) => (prompts[k] ?? "").trim());
      if (!list.length) throw new Error("没有可生成的素材：请至少勾选一种素材（且其提示词不为空）");
      // 首张产出作为后续素材的参考图，保证整套图角色一致
      let anchor: string | undefined;
      for (let i = 0; i < list.length; i++) {
        const k = list[i];
        upd(id, { progress: `生成${DELIV_LABEL[k]}（${i + 1}/${list.length}）…` });
        const refs = [refImage, anchor].filter((x): x is string => !!x);
        const first = await genCharDeliverable(id, k, prompts[k]!, refs);
        anchor ??= first;
      }
    }
    upd(id, { status: "done", progress: undefined });
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e), progress: undefined });
    pushError("角色卡", errMsg(e));
  }
}

/** 单独重生成某一种素材（节点内每行的刷新按钮） */
export async function regenCharDeliverable(id: string, k: CharDeliverable) {
  const data = charData(id);
  if (!data || data.status === "running") return;
  const prompt = (data.prompts[k] ?? "").trim();
  if (!prompt) {
    toast("该素材还没有提示词：先运行一次「分析并生成」", "err");
    return;
  }
  upd(id, { status: "running", error: undefined, progress: `重新生成${DELIV_LABEL[k]}…` });
  try {
    const { images } = collectUpstream(id);
    // 已有的其他素材里挑一张当参考，维持角色一致
    const anchorK = (["turnaround", "portrait", "closeup"] as CharDeliverable[]).find(
      (x) => x !== k && data.results[x]?.length,
    );
    const refs = [images[0], anchorK ? data.results[anchorK]![0] : undefined].filter((x): x is string => !!x);
    await genCharDeliverable(id, k, prompt, refs);
    upd(id, { status: "done", progress: undefined });
    notifyDone(`${DELIV_LABEL[k]}生成`);
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e), progress: undefined });
    pushError("角色卡", errMsg(e));
  }
}

/* ---------- 分镜 ---------- */

const STORY_REFINE_SYSTEM =
  "你是资深编剧。把用户给出的故事/梗概完善成一段结构完整、画面感强的短片故事：补全起承转合与视觉细节，保持原设定与语言（中文进中文出）。长剧本先按情节分小节整理再连贯改写。只输出完善后的故事正文，不要任何解释。";

/** 完善故事：原文（或上游文本）→ 编剧模型 → refined */
export async function refineStory(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as StoryboardData;
  if (data.status === "running") return;
  const story = (data.story ?? "").trim() || collectUpstream(id).texts.join("\n");
  if (!story) {
    toast("请先输入故事，或连接上游文本节点", "err");
    return;
  }
  upd(id, { status: "running", error: undefined, progress: "完善故事中…" });
  try {
    const card = resolveModelCard("chat", data.chatModelId);
    const refined = await chatOnce(card, STORY_REFINE_SYSTEM, story.slice(0, 24000));
    upd(id, { status: "idle", refined: refined.trim(), progress: undefined });
    notifyDone("故事完善");
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e), progress: undefined });
    pushError("分镜 · 完善故事", errMsg(e));
  }
}

/** 拆分镜：故事 + 风格/定调 + 数量/每镜秒数 → 带时间轴的分镜提示词表 */
export async function runStoryboard(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as StoryboardData;
  if (data.status === "running") return;
  const story = (data.refined ?? "").trim() || (data.story ?? "").trim() || collectUpstream(id).texts.join("\n");
  if (!story) {
    toast("请先输入故事（或先点「完善故事」），也可以连接上游文本节点", "err");
    return;
  }
  const count = Math.max(2, Math.min(24, data.count ?? 4));
  const sec = Math.max(1, data.shotSec ?? 5);
  upd(id, { status: "running", error: undefined, progress: `拆分 ${count} 个分镜…` });
  try {
    const card = resolveModelCard("chat", data.chatModelId);
    const system =
      "你是专业分镜师。把故事拆解成给定数量的连贯分镜，只输出 JSON（不要 markdown 代码块外的任何文字）：" +
      '{"shots":[{"time":"0-5秒","prompt":"..."}]}';
    const ask = [
      `故事（若很长请先在心里分小节整理，再均衡分配到各镜）：
${story.slice(0, 24000)}`,
      `
要求：`,
      `1. 恰好拆成 ${count} 个分镜，每镜时长 ${sec} 秒，time 字段按累计时间标注（如 "0-${sec}秒"、"${sec}-${sec * 2}秒"…）`,
      `2. 每条 prompt 是一段可直接发给 AI 生图/生视频的中文提示词：包含镜头景别/构图/光线/动作，主体外观在各镜间保持一致`,
      data.style.trim() ? `3. 全片风格（织入每条 prompt 开头）：${data.style.trim()}` : "",
      data.tone.trim() ? `4. 画面定调/色调（织入每条 prompt）：${data.tone.trim()}` : "",
      `5. 分镜之间画面要能衔接（上一镜结尾与下一镜开头呼应）`,
    ].filter(Boolean).join("\n");
    const out = await chatOnce(card, system, ask);
    const j = parseJsonLoose(out) as { shots?: { time?: string; prompt?: string }[] } | null;
    const shots = (j?.shots ?? [])
      .filter((x) => (x?.prompt ?? "").trim())
      .map((x, i) => ({ time: (x.time ?? `${i * sec}-${(i + 1) * sec}秒`).trim(), prompt: x.prompt!.trim() }));
    if (!shots.length) throw new Error(`模型没有返回有效的分镜 JSON：${out.slice(0, 160)}`);
    upd(id, { status: "done", shots, progress: undefined });
    toast(`已生成 ${shots.length} 个分镜：每镜右侧有独立输出口，或点「一键铺节点」`, "ok");
    notifyDone("分镜");
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e), progress: undefined });
    pushError("分镜", errMsg(e));
  }
}

/** 一键铺节点：每个分镜建一个生成节点并连到对应单镜端口 */
export function spawnShotNodes(id: string, kind: "imageGen" | "videoGen") {
  const s = useBoard.getState();
  const node = s.nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as StoryboardData;
  if (!data.shots?.length) {
    toast("请先生成分镜", "err");
    return;
  }
  const parent = node.parentId ? s.nodes.find((n) => n.id === node.parentId) : undefined;
  const baseX = node.position.x + (parent?.position.x ?? 0) + (node.measured?.width ?? 340) + 90;
  const baseY = node.position.y + (parent?.position.y ?? 0);
  data.shots.forEach((_, i) => {
    const bs = useBoard.getState();
    const nid = bs.addNode(kind, { x: baseX, y: baseY + i * (kind === "videoGen" ? 300 : 330) });
    bs.connectNodes(id, nid, "in-text", `shot-${i}`);
  });
  toast(`已按 ${data.shots.length} 个分镜铺好${kind === "videoGen" ? "生成视频" : "生成图像"}节点（逐镜连线完成）`, "ok");
}

/* ---------- 本地视频处理：取帧 / 取段 / 拼接（零模型成本） ---------- */

export async function runFrame(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as FrameData;
  if (data.status === "running") return;
  const src = collectUpstream(id).videos[0];
  if (!src) {
    toast("请先连接上游视频节点（生成视频 / 取段 / 拼接）", "err");
    return;
  }
  upd(id, { status: "running", error: undefined });
  try {
    const { dataUrl, duration } = await grabFrame(src, data.point ?? "last", data.timeSec);
    upd(id, { status: "done", result: dataUrl, srcDur: duration });
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e) });
    pushError("视频取帧", errMsg(e));
  }
}

export async function runVideoTrim(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as VideoTrimData;
  if (data.status === "running") return;
  const src = collectUpstream(id).videos[0];
  if (!src) {
    toast("请先连接上游视频节点", "err");
    return;
  }
  upd(id, { status: "running", error: undefined, progress: "准备重编码…", resultUrl: undefined });
  try {
    const url = await trimVideo(src, data.start ?? 0, data.end, (m) => upd(id, { progress: m }));
    upd(id, { status: "done", resultUrl: url, progress: undefined });
    notifyDone("视频取段");
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e), progress: undefined });
    pushError("视频取段", errMsg(e));
  }
}

export async function runVideoConcat(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as VideoConcatData;
  if (data.status === "running") return;
  const videos = collectUpstream(id).videos;
  if (videos.length < 2) {
    toast("视频拼接需要接入至少 2 路上游视频（按连线上下位置排序）", "err");
    return;
  }
  upd(id, { status: "running", error: undefined, progress: "准备重编码…", resultUrl: undefined });
  try {
    const url = await concatVideos(videos, (m) => upd(id, { progress: m }));
    upd(id, { status: "done", resultUrl: url, progress: undefined });
    notifyDone("视频拼接");
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e), progress: undefined });
    pushError("视频拼接", errMsg(e));
  }
}

/* ---------- 工作流链式运行 ---------- */

/** 可主动运行的节点类型 → 运行函数（对话节点需要用户输入，不参与自动链） */
const RUNNERS: Partial<Record<NodeKind, (id: string) => Promise<void>>> = {
  imageGen: runImageGen,
  videoGen: runVideoGen,
  comfy: runComfy,
  caption: runCaption,
  llmText: runLlmText,
  relight: runRelight,
  multiAngle: runMultiAngle,
  charCard: runCharCard,
  resize: runResize,
  inpaint: runInpaint,
  outpaint: runOutpaint,
  matting: runMatting,
  enhance: runEnhance,
  crop: runCrop,
  frame: runFrame,
  videoTrim: runVideoTrim,
  videoConcat: runVideoConcat,
  storyboard: runStoryboard,
};

type LiteNode = { id: string; type?: string; parentId?: string; data: unknown };
type LiteEdge = { source: string; target: string };

/** DFS 后序：把目标节点及其全部上游中「可运行」的节点按依赖先后收集（含组成员） */
function visitChain(
  id: string,
  nodes: LiteNode[],
  edges: LiteEdge[],
  seen: Set<string>,
  order: string[],
) {
  if (seen.has(id)) return;
  seen.add(id);
  const n = nodes.find((x) => x.id === id);
  if (!n || (n.data as Record<string, unknown>).ignored) return;
  for (const e of edges) if (e.target === id) visitChain(e.source, nodes, edges, seen, order);
  if (n.type === "group") {
    for (const m of nodes.filter((x) => x.parentId === id)) visitChain(m.id, nodes, edges, seen, order);
    return;
  }
  if (RUNNERS[n.type as NodeKind]) order.push(id);
}

/** 节点是否已有可用结果（上游有结果就不重复计算） */
function hasFreshOutput(n: LiteNode): boolean {
  const d = n.data as Record<string, unknown>;
  if (d.status !== "done") return false;
  switch (n.type as NodeKind) {
    case "caption":
    case "llmText":
      return !!(d.result as string | undefined)?.trim();
    case "imageGen":
    case "comfy":
    case "inpaint":
    case "outpaint":
    case "matting":
    case "enhance":
      return !!(d.results as string[] | undefined)?.length;
    case "crop":
      return !!d.result;
    case "relight":
    case "multiAngle":
      // 提示词模式的输出由参数即时推导，视为始终新鲜
      return d.outMode === "prompt" || !!(d.results as string[] | undefined)?.length;
    case "charCard": {
      const cc = d as unknown as CharCardData;
      if (charOutMode(cc) === "prompt") return Object.values(cc.prompts ?? {}).some((t) => t?.trim());
      return Object.values(cc.results ?? {}).some((v) => v?.length);
    }
    case "videoGen":
    case "videoTrim":
    case "videoConcat":
      return !!d.resultUrl;
    case "frame":
      return !!d.result;
    case "storyboard":
      return !!(d.shots as unknown[] | undefined)?.length;
    case "resize":
      // 文本样式输出由参数即时推导，测过上游尺寸即视为新鲜
      return (d.out ?? "image") === "image" ? !!d.result : !!d.srcW;
    default:
      return false;
  }
}

/** 依次运行一串节点；某个节点出错则停止后续。force = 已有结果的也重算 */
async function runSequence(ids: string[], opts: { clickedId?: string; force?: boolean } = {}): Promise<void> {
  for (const nid of ids) {
    const n = useBoard.getState().nodes.find((x) => x.id === nid);
    if (!n) continue;
    const run = RUNNERS[n.type as NodeKind];
    if (!run) continue;
    // 上游已经算过且有结果 → 直接用现成的（点击的目标节点本身总是重新跑）
    if (!opts.force && nid !== opts.clickedId && hasFreshOutput(n)) continue;
    await run(nid);
    const after = useBoard.getState().nodes.find((x) => x.id === nid);
    if ((after?.data as Record<string, unknown> | undefined)?.status === "error") {
      if (nid !== opts.clickedId) toast("上游节点运行失败，工作流后续节点已停止", "err");
      return;
    }
  }
}

/** 点击节点运行：上游按依赖顺序补齐（已有结果的直接复用），再跑自己 */
export async function runFlow(id: string) {
  const { nodes, edges } = useBoard.getState();
  const order: string[] = [];
  visitChain(id, nodes, edges, new Set(), order);
  if (!order.length) return;
  const pendingCount = order.filter((nid) => {
    if (nid === id) return true;
    const n = nodes.find((x) => x.id === nid);
    return n ? !hasFreshOutput(n) : false;
  }).length;
  if (pendingCount > 1) toast(`按工作流顺序运行 ${pendingCount} 个节点（已有结果的上游直接复用）…`, "info");
  await runSequence(order, { clickedId: id });
  // 目标节点顺利跑完 → 完成提示音/语音播报（报错音在 pushError 里统一触发）
  const after = useBoard.getState().nodes.find((n) => n.id === id);
  if ((after?.data as Record<string, unknown> | undefined)?.status === "done")
    notifyDone(NODE_LABEL[after!.type as NodeKind] ?? "任务");
}

/** 一键运行画布上的所有工作流：按连通分量并行，分量内按依赖顺序串行 */
export async function runAllFlows() {
  const { nodes, edges } = useBoard.getState();
  const runnable = nodes.filter(
    (n) => RUNNERS[n.type as NodeKind] && !(n.data as Record<string, unknown>).ignored,
  );
  if (!runnable.length) {
    toast("画布上还没有可运行的节点（生成/智能类）", "err");
    return;
  }

  // 无向连通分量：连线相连或同组的节点算同一条工作流
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    adj.set(a, [...(adj.get(a) ?? []), b]);
    adj.set(b, [...(adj.get(b) ?? []), a]);
  };
  for (const e of edges) link(e.source, e.target);
  for (const n of nodes) if (n.parentId) link(n.id, n.parentId);

  const compId = new Map<string, number>();
  let comps = 0;
  for (const n of nodes) {
    if (compId.has(n.id)) continue;
    const queue = [n.id];
    compId.set(n.id, comps);
    while (queue.length) {
      const cur = queue.pop()!;
      for (const nb of adj.get(cur) ?? []) {
        if (!compId.has(nb)) {
          compId.set(nb, comps);
          queue.push(nb);
        }
      }
    }
    comps++;
  }

  // 每个分量内：对全部节点做 DFS 后序，得到该工作流可运行节点的依赖顺序
  const flows: string[][] = [];
  for (let c = 0; c < comps; c++) {
    const members = nodes.filter((n) => compId.get(n.id) === c);
    if (!members.some((n) => RUNNERS[n.type as NodeKind] && !(n.data as Record<string, unknown>).ignored)) continue;
    const seen = new Set<string>();
    const order: string[] = [];
    for (const m of members) visitChain(m.id, nodes, edges, seen, order);
    if (order.length) flows.push(order);
  }
  if (!flows.length) {
    toast("画布上还没有可运行的工作流", "err");
    return;
  }

  toast(`开始运行 ${flows.length} 条工作流（共 ${flows.reduce((s, f) => s + f.length, 0)} 个节点，全部从头重算）`, "info");
  await Promise.all(flows.map((f) => runSequence(f, { force: true })));
  toast("全部工作流运行结束", "ok");
  notifyDone("全部工作流");
}
