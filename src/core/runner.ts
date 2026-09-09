/**
 * 节点运行引擎：收集上游 → 调用对应服务 → 结果写回节点 + 收录资产库
 */
import { NODE_LABEL, outPortType, useBoard } from "./stores/boardStore";
import { useSettings, resolveModelCard, modelKey } from "./stores/settingsStore";
import { useComfy } from "./stores/comfyStore";
import { pushError, toast, useUi } from "./stores/uiStore";
import { useAssets } from "./stores/assetStore";
import { usePromptHist } from "./stores/promptHistStore";
import { chatStream, chatOnce, OPTIMIZE_SYSTEM } from "./services/llm";
import { brandPrompt } from "./stores/designStore";
import { generateImage } from "./services/imageGen";
import { generateVideo } from "./services/videoGen";
import { generateAudio } from "./services/audioGen";
import { webSearch, searchContext } from "./services/webSearch";
import { runComfyTemplate, effectiveParams, freeComfyMemory } from "./services/comfy";
import { autoSaveImage } from "./services/imageSaver";
import { chatCaps, familyMaxCount, familyMaxRef, gptSize, imageFamily, nearestAspect, parseRatio } from "./modelMeta";
import { videoFamily, videoMeta } from "./videoMeta";
import { imageDims } from "./imageInfo";
import { buildAnglePrompt, buildRelightPrompt } from "./cameraLight";
import { charAnalysisSystem, DELIV_LABEL, DELIV_VARIATIONS } from "./charPresets";
import { ecomAnalysisSystem, h5AnalysisSystem, parseEcomAnalysis } from "./ecomPresets";
import { stitchVertical } from "./stitchCanvas";
import { creativityPhrase } from "./editPrompts";
import { errMsg, isTauri, parseJsonLoose, uid } from "./utils";
import { abortNode, acquireSlot, beginTask, endTask, isAbortError, taskSignal } from "./runControl";
import { runGenWithFallback } from "./retry";
import { budgetGate } from "./capability/budget";
import { useUsage } from "./stores/usageStore";
import { estimateCost } from "./pricing";
import { nodeMainImage } from "./nodeEdit";
import { renderToMp4, type RenderClipPlan, type RenderPlan } from "./directorRender";
import { estimateEnhanceResources } from "./enhanceEstimate";
import { assetUrl, fetchBytes, assetsDir } from "./services/assetFiles";
import { notifyDone } from "./sound";
import { dubVideo } from "./videoEdit";
import { Channel, invoke } from "@tauri-apps/api/core";
import { getStatus as getLocalLlmStatus, stopModel as stopLocalLlmModel } from "./services/localLlm";
import type {
  AssetGenMeta,
  AudioGenData,
  VideoDubData,
  CharCardData,
  CharDeliverable,
  CharProfile,
  ChatData,
  ChatMsg,
  ComfyData,
  EnhanceLocalData,
  VectorizeData,
  CombineData,
  GenHistoryEntry,
  EcomAnalysis,
  EcomImageData,
  EcomSlide,
  ImageData,
  ImageGenData,
  LlmTextData,
  ModelCard,
  MultiAngleData,
  NodeKind,
  PromptData,
  RelightData,
  StylePresetData,
  StoryboardData,
  VideoGenData,
  DirectorData,
} from "./types";

const SEPARATORS: Record<CombineData["separator"], string> = {
  comma: ", ",
  newline: "\n",
  space: " ",
};

/* ---------- 上游收集 ----------
   直接前驱取值；纯文本节点（拼接/风格预设）会向上递归物化自己的输出；
   组节点按成员位置顺序聚合；「忽略」的节点不向下游传递 */

/**
 * GPU 大任务（ComfyUI / 远程视频生成）前的显存释放检查。
 *
 * 本地 GGUF 模型（llama-server）会占用显存，和 ComfyUI/视频生成争抢。
 * 任务前检查：若有 MOMO 启动的本地模型在跑，提示用户确认后释放。
 * 只停 MOMO 自己启动的（localLlm.stopModel 只按 modelId 查 Rust running map），
 * 不影响用户在 MOMO 外部启动的进程。
 *
 * 生成结束后不自动重载模型（用户下次对话时按需启动）。
 */
async function releaseLocalGpuIfOccupied(taskLabel: string): Promise<void> {
  if (!isTauri) return; // 浏览器预览无本地进程
  try {
    const status = await getLocalLlmStatus();
    const running = status.filter((s) => s.running);
    if (!running.length) return;
    const names = running.map((s) => s.modelName).join("、");
    if (!confirm(`当前本地模型「${names}」占用显存，执行${taskLabel}前建议先释放。是否立即释放？`)) {
      return; // 用户拒绝：继续执行任务（不阻塞）
    }
    for (const s of running) {
      await stopLocalLlmModel(s.modelId);
    }
    toast("已释放本地模型显存", "ok");
  } catch {
    // 释放失败不阻塞主任务
  }
}

/** 单个节点自身的输出（文本 / 图片 / 视频 / 音频） */
function nodeOutput(
  src: { id: string; type?: string; data: unknown },
  visited: Set<string>,
): { texts: string[]; images: string[]; videos: string[]; audios: string[] } {
  const texts: string[] = [];
  const images: string[] = [];
  const videos: string[] = [];
  const audios: string[] = [];
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
    case "enhanceLocal": {
      const r = (d as EnhanceLocalData).result;
      if (r) images.push(r);
      break;
    }
    case "comfy": {
      const g = d as ComfyData;
      const s = g.results?.[g.picked ?? 0];
      if (s) images.push(s);
      for (const v of g.videoResults ?? []) videos.push(v);
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
    case "charCard": {
      const g = d as CharCardData;
      const order: CharDeliverable[] = ["turnaround", "closeup", "expressions", "poses", "outfits", "portrait", "sheet"];
      if (charOutMode(g) === "prompt") {
        // 提示词模式：把勾选素材的提示词逐条输出（下游可接生成图像等节点）
        for (const k of order) {
          const t = (g.prompts?.[k] ?? "").trim();
          if (t && g.deliverables.includes(k)) texts.push(t);
        }
      } else {
        // 出图模式：勾选素材的首图全部输出（下游拿整套设定参考，角色一致性更稳）
        const seenImg = new Set<string>();
        for (const k of order) {
          if (!g.deliverables.includes(k)) continue;
          const s = g.results?.[k]?.[0];
          if (s && !seenImg.has(s)) {
            seenImg.add(s);
            images.push(s);
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
    case "ecomImage": {
      const g = d as EcomImageData;
      if (g.outMode === "prompt") {
        // 提示词模式：各切片提示词逐条输出（下游可接生成图像节点自行出图）
        for (const s of g.analysis?.slides ?? []) {
          const t = (s.prompt ?? "").trim();
          if (t) texts.push(t);
        }
      } else {
        const r = g.result;
        if (r) images.push(r);
      }
      break;
    }
    case "video": {
      const s = (d as { src?: string }).src;
      if (s) videos.push(s);
      break;
    }
    case "audio": {
      const s = (d as { src?: string }).src;
      if (s) audios.push(s);
      break;
    }
    case "audioGen": {
      const u = (d as { resultUrl?: string }).resultUrl;
      if (u) audios.push(u);
      break;
    }
    case "videoGen":
    case "videoDub": {
      const u = (d as { resultUrl?: string }).resultUrl;
      if (u) videos.push(u);
      break;
    }
    case "director": {
      // 导演台成片：有 outputUrl 时输出视频，否则不向下游传值
      const u = (d as DirectorData).outputUrl;
      if (u) videos.push(u);
      break;
    }
    default:
      break;
  }
  return { texts, images, videos, audios };
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
): { texts: string[]; images: string[]; videos: string[]; audios: string[] } {
  const { nodes, edges } = useBoard.getState();
  const texts: string[] = [];
  const images: string[] = [];
  const videos: string[] = [];
  const audios: string[] = [];
  // 防环用「当前递归路径」而不是全局已访问集：同一个上游节点被两条路径共同引用是正常拓扑
  //（如一个提示词节点同时喂给拼接和生成），用全局集会让第二条路径拿到空结果
  if (visited.has(nodeId)) return { texts, images, videos, audios };
  visited.add(nodeId);

  for (const e of orderedInEdges(nodeId, nodes, edges)) {
    const src = nodes.find((n) => n.id === e.source);
    if (!src) continue;
    if ((src.data as Record<string, unknown>).ignored) continue;
    if (src.type === "group") {
      // 组单 out：成员按位置（上→下、左→右）依次产出，按各自 nodeOutput 类型全分流（不再按出口过滤）
      const members = nodes
        .filter((n) => n.parentId === src.id && !(n.data as Record<string, unknown>).ignored)
        .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
      for (const m of members) {
        const o = nodeOutput(m, visited);
        texts.push(...o.texts);
        images.push(...o.images);
        videos.push(...o.videos);
        audios.push(...o.audios);
      }
      continue;
    }
    // 分镜单镜端口：只输出该镜的提示词
    if (src.type === "storyboard" && e.sourceHandle?.startsWith("shot-")) {
      const g = src.data as StoryboardData;
      const sh = g.shots?.[Number(e.sourceHandle.slice(5))];
      const t = sh?.prompt?.trim();
      if (t) texts.push(sh?.line?.trim() ? t + "\n对白台词：「" + sh.line.trim() + "」" : t);
      continue;
    }
    const o = nodeOutput(src, visited);
    texts.push(...o.texts);
    images.push(...o.images);
    videos.push(...o.videos);
    audios.push(...o.audios);
  }
  // 退出本节点：只在「当前路径」上防环，兄弟分支仍能正常展开同一个上游
  visited.delete(nodeId);
  return { texts, images, videos, audios };
}

/* ---------- 上游明细（节点上「传入」徽标的弹窗预览用） ---------- */
export type UpstreamPart = { from: string; nodeId: string; kind: "text" | "image"; value: string };

function nodeTitle(n: LiteN): string {
  const d = n.data as Record<string, unknown>;
  const extra =
    (typeof d.name === "string" && d.name) || (d.profile as { name?: string } | undefined)?.name || "";
  const base = NODE_LABEL[n.type as NodeKind] ?? String(n.type);
  return extra ? `${base} · ${String(extra).slice(0, 14)}` : base;
}

/** 与 collectUpstream 完全同序的上游明细，逐段标注来源节点（nodeId 供弹窗点击定位） */
export function collectUpstreamParts(nodeId: string): UpstreamPart[] {
  const { nodes, edges } = useBoard.getState();
  const out: UpstreamPart[] = [];
  const push = (label: string, srcId: string, o: { texts: string[]; images: string[] }, only?: "text" | "image") => {
    if (only !== "image") for (const t of o.texts) out.push({ from: label, nodeId: srcId, kind: "text", value: t });
    if (only !== "text") for (const s of o.images) out.push({ from: label, nodeId: srcId, kind: "image", value: s });
  };
  for (const e of orderedInEdges(nodeId, nodes, edges)) {
    const src = nodes.find((n) => n.id === e.source);
    if (!src || (src.data as Record<string, unknown>).ignored) continue;
    if (src.type === "group") {
      const members = nodes
        .filter((n) => n.parentId === src.id && !(n.data as Record<string, unknown>).ignored)
        .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
      for (const m of members) push(`组 · ${nodeTitle(m)}`, m.id, nodeOutput(m, new Set([nodeId])));
      continue;
    }
    push(nodeTitle(src), src.id, nodeOutput(src, new Set([nodeId])));
  }
  return out;
}

// runner 写回的都是运行态（status/results/progress…），走 result:true 不增 rev；
// UI 改提示词/参数（不经 upd）才会增 rev，下游脏标记据此判断「上游是否已变更」
const upd = (id: string, patch: Record<string, unknown>) => useBoard.getState().updateData(id, patch, { result: true });

/** 本节点直接上游的「签名」：编码走过的上游 id+rev+端口。gated 成功后盖章进 data.inputSig，
 *  hasFreshOutput 据此判断上游是否已变更（改了提示词/换了参考图/重排了组成员 → 签名变 → 重算）。
 *  与 collectUpstream 同序（orderedInEdges + 组成员按位置），保证 @图N 编号一致 */
function upstreamSig(id: string): string {
  const { nodes, edges } = useBoard.getState();
  const parts: string[] = [];
  for (const e of orderedInEdges(id, nodes, edges)) {
    const src = nodes.find((n) => n.id === e.source);
    if (!src || (src.data as Record<string, unknown>).ignored) continue;
    if (src.type === "group") {
      const members = nodes
        .filter((n) => n.parentId === src.id && !(n.data as Record<string, unknown>).ignored)
        .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
      for (const m of members) parts.push(`${m.id}:${(m.data as Record<string, unknown>).rev ?? 0}`);
    } else if (src.type === "storyboard" && e.sourceHandle?.startsWith("shot-")) {
      parts.push(`${src.id}:${e.sourceHandle}:${(src.data as Record<string, unknown>).rev ?? 0}`);
    } else {
      parts.push(`${src.id}:${(src.data as Record<string, unknown>).rev ?? 0}:${e.targetHandle ?? ""}`);
    }
  }
  return parts.join("|");
}

/** 本节点自身参数的「签名」（仅对参数会影响输出的节点有意义，如超清放大的倍率/目标/tile）。
 *  upstreamSig 只编码上游 → 改本节点参数不会被感知 → 会给出旧结果（文档 §10.2 缓存键隐患）。
 *  sigOf = upstreamSig + selfSig，让 hasFreshOutput/isNodeDirty 在参数变更时也判脏 → 重算。
 *  无自身参数的节点返回空串，行为与原先完全一致。 */
function selfSig(id: string): string {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return "";
  if (node.type === "enhanceLocal") {
    const d = node.data as EnhanceLocalData;
    const tObj = d.target as { mode?: "print"; wMm?: number; hMm?: number; dpi?: number; longEdge?: number };
    const t = typeof d.target === "string"
      ? d.target
      : tObj.mode === "print"
        ? `print:${tObj.wMm}×${tObj.hMm}@${tObj.dpi}`
        : `c${tObj.longEdge ?? 0}`;
    return `^self:${d.preset ?? ""}:${t}:${d.modelId ?? ""}:${d.tileSize ?? 0}:${d.outputFormat ?? "png"}:${d.contentMode ?? "auto"}:${d.detailStrength ?? 0}:${d.dejpeg ?? "auto"}:${d.faceRestore ?? ""}:${d.bitDepth ?? 8}`;
  }
  if (node.type === "vectorize") {
    const d = node.data as VectorizeData;
    return `^self:vec:${d.preset}:${d.colorMode}:${d.hierarchical}:${d.colorPrecision}:${d.filterSpeckle}:${d.pathPrecision}:${d.geometry ? 1 : 0}:${d.quality ?? "balanced"}:${d.flatColors??12}`;
  }
  return "";
}
function sigOf(id: string): string {
  return upstreamSig(id) + selfSig(id);
}

/** 推进节点级生成历史（最近 10 次）：成功出图/出片时快照本轮参数+结果，可回溯「第 N 次那版最好」。
 *  结果走 result:true 写回，不增 rev（历史是运行态产物，不该触发下游脏标记） */
function pushHistory(id: string, entry: Omit<GenHistoryEntry, "ts">) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const d = node.data as Record<string, unknown>;
  const hist: GenHistoryEntry[] = ((d.history as GenHistoryEntry[] | undefined) ?? []).slice();
  hist.unshift({ ts: Date.now(), ...entry });
  while (hist.length > 10) hist.pop();
  useBoard.getState().updateData(id, { history: hist }, { result: true });
}

/** 该节点的上游是否已变更（记录的 inputSig 与当前 upstreamSig 不符）。老数据无 inputSig 视为未变更。
 *  NodeShell 据此显示「上游已变更」角标；hasFreshOutput 据此决定是否重算 */
export function isNodeDirty(id: string): boolean {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  const sig = (node?.data as Record<string, unknown> | undefined)?.inputSig;
  return typeof sig === "string" && sig !== sigOf(id);
}

/**
 * 单个可运行节点的预估费用（「全部运行」批量账单用）：
 * 按节点参数 × 模型单价估算；ComfyUI 等无法预估或模型未配置的返回 0（真跑时会各自报错/记账）。
 */
function estimateNodeCost(nid: string, nodes: LiteNode[]): number {
  const n = nodes.find((x) => x.id === nid);
  if (!n) return 0;
  const d = n.data as Record<string, unknown>;
  try {
    switch (n.type) {
      case "imageGen": {
        const card = resolveModelCard("image", d.modelId as string | undefined);
        return estimateCost(card.model, { images: Number(d.count ?? 1) });
      }
      case "charCard": {
        const card = resolveModelCard("image", d.imageModelId as string | undefined);
        return estimateCost(card.model, { images: (d.deliverables as unknown[] | undefined)?.length ?? 3 });
      }
      case "videoGen": {
        const card = resolveModelCard("video", d.modelId as string | undefined);
        return estimateCost(card.model, { videoSec: Number(d.duration ?? 5) * Number(d.parallel ?? 1) });
      }
      case "audioGen": {
        const card = resolveModelCard("audio", d.modelId as string | undefined);
        const text = String(d.prompt ?? d.text ?? "");
        return estimateCost(card.model, { audioSec: Math.max(1, Math.round(text.length / 5)) });
      }
    }
  } catch {
    return 0;
  }
  return 0;
}

/** 预算闸已抽到能力层统一入口（capability/budget.ts）：画布与创作助手共用同一道门，perRunCap 在此生效 */

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
  meta: {
    prompt?: string;
    model?: string;
    gen?: AssetGenMeta;
    nodeId?: string;
    /** 生成耗时（毫秒），资产卡角标显示用 */
    durationMs?: number;
    group?: {
      groupId?: string;
      groupLabel?: string;
      groupKind?: "generation" | "ecom";
      groupSlot?: string;
      groupCover?: boolean;
    };
  },
) {
  const autoGroup: NonNullable<typeof meta.group> | undefined = !meta.group && srcs.length > 1
    ? { groupId: `gen-${uid(12)}`, groupLabel: meta.prompt?.trim() || "批量生成", groupKind: "generation" as const }
    : undefined;
  const baseGroup = meta.group ?? autoGroup;
  for (const [index, src] of srcs.entries()) {
    const group = baseGroup
      ? { ...baseGroup, groupSlot: baseGroup.groupSlot ?? `result:${index}` }
      : undefined;
    void useAssets.getState().collect({ src, kind, prompt: meta.prompt, model: meta.model, gen: meta.gen, nodeId: meta.nodeId, durationMs: meta.durationMs, group });
  }
}

/** 取一个节点作为参考图来源时的代表图（image 节点取原图，生成节点取当前选中结果） */
function imageSrcOf(n: LiteN): string | undefined {
  const nd = n.data as Record<string, unknown>;
  if (n.type === "image") return nd.src as string | undefined;
  const results = nd.results as string[] | undefined;
  return results?.length ? results[(nd.picked as number | undefined) ?? 0] : undefined;
}

/** 参考图可读名（image 节点用文件名去扩展名，否则 图N）；idx 为该图在序列中的下标 */
function imageLabelOf(n: LiteN, idx: number): string {
  const nd = n.data as Record<string, unknown>;
  if (n.type === "image" && nd.name) {
    const raw = String(nd.name).replace(/\.\w+$/, "");
    if (raw) return raw.slice(0, 12);
  }
  return `图${idx + 1}`;
}

/** 这条入边的源节点输出类型（端口统一后，"这条边传的是图/文/视频/音频"由源节点决定，替代旧 targetHandle 判断） */
function srcOutType(e: { source: string }, nodes: { id: string; type: string; data: unknown }[]) {
  const src = nodes.find((n) => n.id === e.source);
  return src ? outPortType(src.type as NodeKind, src.data as Record<string, unknown>) : null;
}

/**
 * 某节点的图类型上游参考图，与 collectUpstream 完全同序（含组节点成员展开）。
 * @引用胶囊显示、@→图N 解析、提示词同路图 chips 三处共用，保证「图1/图2…」编号一致。
 * 关键：端口统一后不再靠 targetHandle 过滤，改为按 source 输出类型(outPortType)判断是否图源；
 *       组节点成员图、角色卡整套素材首图按画布位置依次计入编号。
 */
export function collectImageRefsFor(nodeId: string): { src: string; label: string }[] {
  const { nodes, edges } = useBoard.getState();
  const out: { src: string; label: string }[] = [];
  const seen = new Set<string>();
  const pushNode = (n: LiteN): boolean => {
    const s = imageSrcOf(n);
    if (!s) return false;
    out.push({ src: s, label: imageLabelOf(n, out.length) });
    return true;
  };
  // 角色卡：出图模式下整套素材首图依次计入图编号（角色卡·三视图 = 图1 …）
  // 直连与「组内成员」两条路径共用，否则组里的角色卡会被当成单图节点漏掉，@图N 编号与实际传图错位
  const pushCharCard = (n: LiteN) => {
    const g = n.data as CharCardData;
    if (charOutMode(g) === "prompt") return; // 提示词模式不产图
    const order: CharDeliverable[] = ["turnaround", "closeup", "expressions", "poses", "outfits", "portrait", "sheet"];
    for (const k of order) {
      if (!g.deliverables.includes(k)) continue;
      const s = g.results?.[k]?.[0];
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push({ src: s, label: `${imageLabelOf(n, out.length)}·${DELIV_LABEL[k]}` });
      }
    }
  };
  for (const e of orderedInEdges(nodeId, nodes, edges)) {
    const src = nodes.find((n) => n.id === e.source);
    if (!src || (src.data as Record<string, unknown>).ignored) continue;
    // 端口统一后不再靠 targetHandle 过滤；按 source 输出类型判断是否图源
    // 角色卡：出图模式下整套素材首图依次计入图编号（角色卡·三视图 = 图1 …）
    if (src.type === "charCard") {
      pushCharCard(src);
      continue;
    }
    // 分镜 shot- 子端口只输出文本，不是图源
    if (src.type === "storyboard" && e.sourceHandle?.startsWith("shot-")) continue;
    if (src.type === "group") {
      // 组：成员按画布位置依次取图（仅图类型成员），与 collectUpstream 同序
      const members = nodes
        .filter((n) => n.parentId === src.id && !(n.data as Record<string, unknown>).ignored)
        .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
      for (const m of members) {
        if (seen.has(m.id)) continue;
        // 组内角色卡同样按整套素材展开（与 collectUpstream 的组分支同序）
        if (m.type === "charCard") {
          pushCharCard(m);
          seen.add(m.id);
          continue;
        }
        if (outPortType(m.type as NodeKind, m.data as Record<string, unknown>) === "image" && pushNode(m)) seen.add(m.id);
      }
      continue;
    }
    // 普通节点：输出类型为 image 才计入图编号
    if (outPortType(src.type as NodeKind, src.data as Record<string, unknown>) !== "image") continue;
    if (seen.has(src.id)) continue;
    if (pushNode(src)) seen.add(src.id);
  }
  return out;
}

/** 把提示词里的 @图片名 替换成「图N」，N 与实际传给模型的参考图顺序一致（模型不认识 @名字） */
function resolveAtRefs(prompt: string, nodeId: string): string {
  if (!prompt.includes("@")) return prompt;
  const refs = collectImageRefsFor(nodeId);
  let out = prompt;
  refs.forEach((r, i) => {
    out = out.split(`@${r.label}`).join(`图${i + 1}`);
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

/** 与画布提交预览同源；英文模式的远程翻译在执行阶段完成。 */
export function imagePromptInput(id:string){
  const data=useBoard.getState().nodes.find(n=>n.id===id)?.data as ImageGenData|undefined;if(!data)return "";
  const {texts,images}=collectUpstream(id),raw=(data.prompt??"").trim()||texts.filter(t=>!isSizeDirective(t)).join("\n");
  const prompt=resolveAtRefs(raw?brandPrompt(useBoard.getState().activeId,raw):"",id);
  const cv=images.length?creativityPhrase(data.creativity):null;
  return cv?`${prompt}\n${cv}`:prompt;
}

export async function runImageGen(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as ImageGenData;
  if (data.status === "running") return;
  const { texts, images } = collectUpstream(id);
  const sizeDirectives = texts.filter(isSizeDirective);
  const promptTexts = texts.filter((t) => !isSizeDirective(t));
  const rawPrompt = (data.prompt ?? "").trim() || promptTexts.join("\n");
  const prompt = rawPrompt ? brandPrompt(useBoard.getState().activeId,rawPrompt) : "";
  if (!prompt && !images.length) {
    toast("请输入提示词，或连接一个提示词/对话节点", "err");
    return;
  }
  upd(id, { status: "running", error: undefined, progress:undefined });
  let primaryCard: ModelCard | null = null;
  const t0 = Date.now();
  try {
    const card = resolveModelCard("image", data.modelId);
    primaryCard = card;
    let finalPrompt = await localizePrompt(resolveAtRefs(prompt, id), data.lang);
    // 创意度（仅图生图）：翻译成模型能懂的力度描述，附在提示词末尾
    const cv = images.length ? creativityPhrase(data.creativity) : null;
    if (cv) finalPrompt = `${finalPrompt}\n${cv}`;

    // 预算护栏：超日预算阻断、超确认阈值弹确认（生成类才预拦；返回 idle 不算错误）
    const gate = budgetGate(estimateCost(card.model, { images: data.count ?? 1 }),undefined,{billing:card.protocol==="codex"?"subscription":undefined});
    if (gate.block) throw new Error(gate.block);
    if (gate.confirm && !window.confirm(gate.confirm)) {
      upd(id, { status: "idle", error: undefined });
      return;
    }

    // 一次完整生成尝试：主模型瞬时错误按设置重试 → 耗尽换备用模型。
    // run 回调用当前 card 重算家族相关字段（备用模型可能不同家族，参数要适配）
    const { result: batch, card: usedCard, usedFallback } = await runGenWithFallback("image", card, taskSignal(id), async (c) => {
      const family = imageFamily(c);
      const customSize = data.width && data.height ? `${data.width}x${data.height}` : undefined;
      let size = family === "banana" ? undefined : customSize ?? (data.size === "default" ? c.size : data.size);
      let aspect = family === "banana" ? data.aspect : undefined;
      const dir = sizeDirectives[sizeDirectives.length - 1];
      if (dir) {
        const o = applySizeDirective(dir, family, data.resolution);
        if (o.aspect) aspect = o.aspect;
        if (o.size) size = o.size;
      } else if (images.length) {
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
      const parallel = Math.max(1, Math.min(3, Math.round(data.parallel ?? 1)));
      if(c.protocol==="codex"&&(parallel>1||data.count>1))throw Error("Codex 会员通道请设置单路、每次 1 张，避免重复扣用额度");
      const req = {
        newConversation: data.newConversation,
        onProgress: (stage:string) => upd(id,{progress:stage}),
        prompt: finalPrompt,
        size,
        n: Math.max(1, Math.min(data.count ?? 1, familyMaxCount(family))),
        refImages: images.length ? images : undefined,
        aspect,
        resolution: family === "banana" ? data.resolution : undefined,
        quality: family === "gpt" ? data.quality : undefined,
        seed: data.seed,
        negative: data.negative?.trim() || undefined,
        signal: taskSignal(id),
      };
      const settled = await Promise.allSettled(Array.from({ length: parallel }, () => generateImage(c, req)));
      const results = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
      if (!results.length) {
        const firstErr = settled.find((r) => r.status === "rejected");
        throw (firstErr as PromiseRejectedResult | undefined)?.reason ?? new Error("生成失败：未返回任何图片");
      }
      return { settled, results };
    });
    const { settled, results } = batch;
    // 部分失败：保留已成功结果，但失败原因要能查（进报错中心，不是一句裸 toast 就没了）
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (rejected.length) {
      const reasons = [...new Set(rejected.map((r) => errMsg(r.reason)))].join("；");
      pushError("生成图像（并行）", `${rejected.length}/${settled.length} 条并行请求失败，已保留 ${results.length} 张成功结果。失败原因：${reasons}`);
    }
    if (usedFallback) {
      upd(id, { fallbackModel: usedCard.name });
      toast(`主模型失败，已由备用模型「${usedCard.name}」生成`, "info");
    } else {
      upd(id, { fallbackModel: undefined });
    }
    pushHistory(id, {
      prompt,
      modelId: modelKey(usedCard.id, usedCard.model),
      params: {
        size: data.size, aspect: data.aspect, resolution: data.resolution, quality: data.quality,
        width: data.width, height: data.height, count: data.count, parallel: data.parallel,
        creativity: data.creativity, seed: data.seed, negative: data.negative, lang: data.lang,
      },
      results,
    });
    upd(id, { status: "done", results, picked: 0 });
    usePromptHist.getState().record(prompt);
    for (const src of results) {
      useUi.getState().addGallery({ kind: "image", src, prompt, model: usedCard.model, nodeId: id });
    }
    collectToLibrary("image", results, {
      prompt,
      model: usedCard.name,
      nodeId: id,
      durationMs: Date.now() - t0,
      gen: {
        nodeKind: "imageGen",
        prompt: (data.prompt ?? "").trim() || prompt,
        modelId: modelKey(usedCard.id, usedCard.model),
        size: data.size,
        aspect: data.aspect,
        resolution: data.resolution,
        quality: data.quality,
        width: data.width,
        height: data.height,
        lang: data.lang,
        creativity: data.creativity,
        seed: data.seed,
        negative: data.negative?.trim() || undefined,
      },
    });
    useUsage.getState().record(usedCard, { ok: true, images: results.length, durMs: Date.now() - t0 });
    void maybeAutoSave(results, { prompt, model: usedCard.model });
  } catch (e) {
    // 用户主动停止：不算错误，恢复待机（也不进报错中心响铃）
    if (isAbortError(e)) {
      upd(id, { status: "idle", error: undefined });
      toast("已停止生成", "info");
      return;
    }
    if (primaryCard) useUsage.getState().record(primaryCard, { ok: false, durMs: Date.now() - t0 });
    upd(id, { status: "error", error: errMsg(e) });
    pushError("生成图像", errMsg(e));
  }
}

/** 超清放大（本地）：取上游图 → 调 Rust enhance_upscale（ort + DirectML + 笨 Tile）→ 输出新资产（非破坏，原图不动）。
 *  进度经 Channel 回写 data.progress/progressPct；用户停止 → 桥接 enhance_cancel，Rust 在下一 tile 边界返回「已取消」。
 *  首跑缺模型时由 resolveLocalModel 自动从镜像下载 + SHA-256 校验。 */
export async function runEnhanceLocal(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as EnhanceLocalData;
  if (data.status === "running") return;
  if (!isTauri) { toast("超清放大仅桌面版支持", "err"); return; }
  const { images } = collectUpstream(id);
  const input = images[0];
  if (!input) { toast("请把一张图片连到「超清放大」节点的左侧入口", "err"); return; }
  const tObj = data.target as { mode?: "print"; wMm?: number; hMm?: number; dpi?: number; longEdge?: number };
  const targetLong = typeof data.target === "string"
    ? ({ "4k": 3840, "8k": 7680, "16k": 15360 } as Record<string, number>)[data.target]
    : tObj.mode === "print"
      ? Math.round((Math.max(tObj.wMm ?? 0, tObj.hMm ?? 0) / 25.4) * (tObj.dpi ?? 300))
      : (tObj.longEdge ?? 0);
  if (!Number.isFinite(targetLong) || targetLong < 64) {
    toast("目标尺寸无效，请检查像素尺寸或印刷尺寸与 DPI", "err");
    return;
  }
  upd(id, {
    status: "running", error: undefined, progress: "准备中…", progressPct: 0, result: undefined, report: undefined,
    fidelityScore: undefined, sourceConsistencyMae: undefined, correctedBlockRatio: undefined,
    rejectedCandidateRatio: undefined, qualityGate: undefined, productionReady: undefined,
    qualityMessage: undefined, timedOut: undefined,
  });
  let automaticTimeout = false;
  try {
    const enhance = useSettings.getState().settings.enhance;
    const inputSize = await imageDims(input);
    if (!inputSize) throw new Error("无法读取输入图片尺寸，请换用有效的 PNG、JPEG、WebP 或 TIFF 图片");
    const estimate = estimateEnhanceResources(inputSize.w, inputSize.h, data, enhance.tileOverlap);
    // 16K 横竖图仍可运行；只拦截会让最终像素缓冲和融合工作集失控的异常自定义/印刷尺寸。
    if (estimate.pixels > 268_000_000 || estimate.ramMb > 24_000 || estimate.width > 32_768 || estimate.height > 32_768) {
      throw new Error(
        `目标 ${estimate.width}×${estimate.height} 预计需要约 ${(estimate.ramMb / 1024).toFixed(1)}GB 内存，超出生产安全上限。请降低尺寸/DPI，或分区放大后再拼接。`,
      );
    }
    const { bytes } = await fetchBytes(input);
    const { resolveLocalModel, modelStatus, modelFilePath } = await import("./localModelRegistry");
    // 四档路由：默认优先保真。海报/人像先走单主模型，只有用户手动增加细节或印刷精修才启用第二模型。
    const ROUTE: Record<string, { main: string; detail?: string }> = {
      fast: { main: "nomosuni-span-multijpg-fp32" },
      balanced: { main: "nomoswebphoto-esrgan-fp32", detail: "ultrasharpv2-lite-fp32" },
      portrait: { main: "nomoswebphoto-realplksr-fp32", detail: "ultrasharpv2-lite-fp32" },
      // 专业档默认仍走单主模型 + 确定性多算法保真链；第二神经模型只在手动开启时运行。
      professional: { main: "nomoswebphoto-esrgan-fp32", detail: "ultrasharpv2-lite-fp32" },
    };
    const route = ROUTE[data.preset] ?? ROUTE.balanced;
    const main = await resolveLocalModel(route.main);
    let detailPath: string | undefined;
    let detailWeight = 0;
    let detailNote = "";
    const requestedDetail = data.detailStrength === 45 ? 0 : data.detailStrength;
    const targetRatio = targetLong / Math.max(inputSize.w, inputSize.h);
    // UltraSharp V2 公开权重为非商业许可：不能作为生产档的静默默认依赖。
    // 仅在用户明确把细节强度调到 >0 时启用；默认生产链由主模型 + 硬边结构保护完成。
    const manualDetail = requestedDetail > 0;
    const allowDetail = manualDetail && Boolean(route.detail) && targetRatio <= 8;
    if (route.detail && allowDetail) {
      const cm = data.contentMode ?? "auto";
      const ds = requestedDetail;
      // DAT2 耗时高且可能制造纹理，仅在用户明确选择插画并手动增强时启用。
      const useManualDat2 = manualDetail && data.preset === "professional" && cm === "illustration";
      const detail = await resolveLocalModel(useManualDat2 ? "ultrasharpv2-dat2-fp32" : route.detail);
      detailPath = detail.path;
      detailNote = ` · 手动细节:${detail.model.displayName}（${detail.model.license}，不可作为商业内置模型）`;
      // [海报·文化墙, 专业印刷]，按内容类型（文档 §4.6 初始参数；平滑区会被内容掩膜再压到 0）
      const W: Record<string, [number, number]> = {
        // DAT2 的高频贡献显著强于 Lite，专业档不能沿用“档位越高权重越大”的直觉。
        // 这些保守初值再叠加 Rust 侧逐像素质量守卫，优先避免渐变网纹、文字双边和皮肤砂纸化。
        auto: [0.14, 0.14], photo: [0.1, 0.1], illustration: [0.22, 0.22], poster: [0.18, 0.18], portrait: [0.08, 0.08],
      };
      const [b, p] = W[cm] ?? W.auto;
      // 细节强度 >0 = 手动覆盖融合权重（封顶 0.8 防塑料感）；0 = 自动查表。
      // 旧数据的占位默认是 45（当时无 UI、从未生效）→ 视同 0=自动，保持老画布行为不变
      const manualCap = data.preset === "professional" ? 0.45 : 0.65;
      const autoWeight = data.preset === "professional" ? p : b;
      // 负数是 Rust 管线内部约定：绝对值为基准，结合本次真实内容分析再调权；显式内容模式/手动强度保持正数。
      detailWeight = manualDetail ? Math.min(ds / 100, manualCap) : cm === "auto" ? -autoWeight : autoWeight;
    } else if (route.detail) {
      detailNote = targetRatio > 8
        ? " · 目标超过源图 8×，已关闭细节模型以避免文字/皮肤伪纹理"
        : " · 生产保真：单主模型 + 文字/几何硬边保护（细节模型仅手动开启）";
    }
    const outDir = await assetsDir();
    const { join } = await import("@tauri-apps/api/path");
    const ext = data.outputFormat === "tiff" ? "tif" : data.outputFormat === "jpeg" ? "jpg" : "png";
    const outPath = await join(outDir, `${Date.now()}_${uid(6)}.${ext}`);
    // 去压缩预处理（批次2）：auto=按 jpegScore 自动 / on=强制 / off=关闭；模型缺失仅降级不阻断
    let dejpgPath: string | undefined;
    if ((data.dejpeg ?? "auto") !== "off") {
      dejpgPath = await resolveLocalModel("dejpg-realplksr-1x").then((r) => r.path).catch(() => undefined);
    }
    // 人脸分支（人像档，文档 §11）：SCRFD 检测 + FaceUpDAT 中脸增强；GFPGAN/CodeFormer 为可选模型——
    // 只在已在位时传路径（不触发 ~350MB 的静默下载），未下载时 Rust 侧记日志降级
    let faceDetectPath: string | undefined;
    let faceUpscalePath: string | undefined;
    let faceRestorePath: string | undefined;
    if (data.preset === "portrait") {
      faceDetectPath = await resolveLocalModel("scrfd-2.5g").then((r) => r.path).catch(() => undefined);
      const fr = data.faceRestore ?? "identity";
      if (fr === "faceup") {
        faceUpscalePath = await resolveLocalModel("faceupdat-4x-fp32").then((r) => r.path).catch(() => undefined);
      }
      if (fr === "gfpgan" || fr === "codeformer") {
        const optId = fr === "gfpgan" ? "gfpgan-v1.4" : "codeformer";
        const st = await modelStatus(optId);
        if (st.downloaded) faceRestorePath = (await modelFilePath(optId)) ?? undefined;
      }
    }
    const cfg = {
      scale: main.model.scale,
      tileSize: estimate.tileSize,
      // 专业印刷档 overlap 48（文档 §21.3），其余档用全局设置（默认 32）
      tileOverlap: data.preset === "professional" ? 48 : enhance.tileOverlap,
      targetLongEdge: targetLong,
      detailModelPath: detailPath,
      detailWeight,
      dejpeg: data.dejpeg ?? "auto",
      dejpegModelPath: dejpgPath,
      bitDepth: data.bitDepth ?? 8,
      faceDetectModelPath: faceDetectPath,
      faceUpscaleModelPath: faceUpscalePath,
      faceRestore: data.faceRestore ?? "identity",
      faceRestoreModelPath: faceRestorePath,
      outputFormat: data.outputFormat,
      outputDpi: typeof data.target !== "string" && tObj.mode === "print" ? tObj.dpi ?? 300 : 72,
      emitAssets: true,
    };
    type SrEvent = { kind: "stage"; data: { stage: string; pct: number } } | { kind: "progress"; data: { pct: number } } | { kind: "log"; data: { msg: string } };
    const onEvent = new Channel<SrEvent>();
    onEvent.onmessage = (e: SrEvent) => {
      if (e.kind === "stage") upd(id, { progress: e.data.stage, progressPct: Math.round(e.data.pct * 100) });
      else if (e.kind === "progress") upd(id, { progressPct: Math.round(e.data.pct * 100) });
    };
    // 取消桥接：节点 AbortController 触发 → 调 enhance_cancel；Rust 在下一个 tile 边界抛「已取消」
    const signal = taskSignal(id);
    let watchdog = 0;
    const onCancel = () => {
      window.clearTimeout(watchdog);
      void invoke("enhance_cancel", { taskId: id });
    };
    signal?.addEventListener("abort", onCancel);
    // 依据本次尺寸、Tile 和历史耗时给出动态看门狗；最少 5 分钟、最多 15 分钟。
    // 超时只在 Tile 边界生效，避免强杀 DirectML；手动细节模型另有 Rust 侧更短的自动回退预算。
    const overallTimeoutMs = Math.min(15 * 60_000, Math.max(5 * 60_000, Math.ceil(estimate.secondsHigh * 1.6 * 1000)));
    watchdog = window.setTimeout(() => {
      automaticTimeout = true;
      void invoke("enhance_cancel", { taskId: id });
    }, overallTimeoutMs);
    try {
      const result = await invoke<{
        outPath: string; width: number; height: number; elapsedMs: number; tiles: number; tileSizeUsed: number; estimatedVramMb: number; backend: string;
        pipeline: string; quality: { contentType: string; jpegScore: number; edgeDensity: number; hardEdgeRatio: number; flatRatio: number; noise: number; blur: number } | null;
        fidelity: { sourceMaeBefore: number; sourceMaeAfter: number; correctedBlockRatio: number; candidateRejectedRatio: number; maxCorrection: number; score: number } | null;
        analysisPath: string | null; vectorGuidePath: string | null; faceReport: string | null;
      }>("enhance_upscale", { taskId: id, inputBytes: bytes, outPath, modelPath: main.path, config: cfg, onEvent });
      const url = assetUrl(result.outPath);
      const q = result.quality;
      // 目标不大于源图时 Rust 只做无损重采样，不产生 fidelity；这条路径按 100 分通过。
      const fidelityScore = result.fidelity ? Math.round(result.fidelity.score * 100) : 100;
      const consistencyWorse = Boolean(result.fidelity && result.fidelity.sourceMaeAfter > result.fidelity.sourceMaeBefore + 0.001);
      const qualityGate: NonNullable<EnhanceLocalData["qualityGate"]> = consistencyWorse || fidelityScore < 70
        ? "failed"
        : fidelityScore < 80 ? "warning" : "passed";
      const productionReady = qualityGate === "passed";
      const qualityMessage = qualityGate === "passed"
        ? `生产门禁通过（保真 ${fidelityScore}）`
        : qualityGate === "warning"
          ? `保真 ${fidelityScore}：需要人工检查文字、Logo 和细线，结果未自动入库`
          : `保真 ${fidelityScore}：未通过生产门禁，建议改用单主模型/降低细节强度后重跑`;
      const qLine = q ? ` · 类型:${q.contentType} 边缘:${Math.round(q.edgeDensity * 100)}% 硬边:${Math.round(q.hardEdgeRatio * 100)}% 色块:${Math.round(q.flatRatio * 100)}% 压缩:${Math.round(q.jpegScore * 100)}%` : "";
      const assetLine = result.analysisPath ? " · 已输出矢量引导/分析资产" : "";
      const faceLine = result.faceReport ? ` · ${result.faceReport}` : "";
      upd(id, {
        status: "done", result: url, resultW: result.width, resultH: result.height,
        elapsedMs: result.elapsedMs, tiles: result.tiles, tileSizeUsed: result.tileSizeUsed, estimatedVramMb: result.estimatedVramMb, progress: undefined, progressPct: 100,
        fidelityScore,
        sourceConsistencyMae: result.fidelity?.sourceMaeAfter,
        correctedBlockRatio: result.fidelity?.correctedBlockRatio,
        rejectedCandidateRatio: result.fidelity?.candidateRejectedRatio,
        qualityGate, productionReady, qualityMessage, timedOut: false,
        analysisMapPath: result.analysisPath ?? undefined,
        vectorGuidePath: result.vectorGuidePath ?? undefined,
        // 节点不再显示底部报告行（关键信息已有分辨率/保真角标），完整诊断保留在数据里备查
        reportDetail: `${result.pipeline}${detailNote} · ${qualityMessage} · Tile ${result.tileSizeUsed}×${result.tiles} · 显存估算${result.estimatedVramMb}MB · ${(result.elapsedMs / 1000).toFixed(1)}s · ${result.width}×${result.height}${qLine}${assetLine}${faceLine}`,
      });
      // 只有通过生产门禁的结果自动入库；警告/失败结果仍保留在节点，可预览或人工确认后保存。
      if (productionReady) {
        try {
          const { assetToDataUrl } = await import("./services/assetFiles");
          const dataUrl = await assetToDataUrl(result.outPath);
          collectToLibrary("image", [dataUrl], { prompt: `超清放大 ${result.width}×${result.height}`, model: main.model.displayName, nodeId: id, durationMs: result.elapsedMs });
        } catch (e) {
          console.warn("[超清放大] 资产库收录失败", e);
        }
      } else {
        toast(qualityMessage, qualityGate === "failed" ? "err" : "info");
        if (qualityGate === "failed") pushError("超清放大 · 质量门禁", qualityMessage);
      }
      notifyDone("超清放大");
    } finally {
      window.clearTimeout(watchdog);
      signal?.removeEventListener("abort", onCancel);
    }
  } catch (e) {
    if (automaticTimeout) {
      const msg = "超清放大超过动态安全时限，已在 Tile 边界自动停止。请改用更小 Tile、较低目标尺寸，或关闭手动细节模型后重试。";
      upd(id, { status: "error", error: msg, progress: undefined, progressPct: undefined, timedOut: true, productionReady: false, qualityGate: "failed", qualityMessage: msg });
      pushError("超清放大 · 超时保护", msg);
      return;
    }
    if (isAbortError(e)) {
      upd(id, { status: "idle", error: undefined, progress: undefined, progressPct: undefined });
      toast("已停止增强", "info");
      return;
    }
    upd(id, { status: "error", error: errMsg(e), progress: undefined, progressPct: undefined });
    pushError("超清放大", errMsg(e));
  }
}

/** 智能矢量（本地 VTracer）：取上游图 → Rust vectorize_image → SVG 资产（非破坏，原图不动）。
 *  产物是 SVG 文本（存在 data.svg，导出 AI/CDR/PDF 用）+ SVG 文件（预览/拖出）。
 *  不自动收录资产库：面板「收入资产库」按钮点击后才以 SVG 格式入「矢量」分类。 */
export async function runVectorize(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as VectorizeData;
  if (data.status === "running") return;
  if (!isTauri) { toast("智能矢量仅桌面版支持", "err"); return; }
  const { images } = collectUpstream(id);
  const input = images[0];
  if (!input) { toast("请把一张图片连到「智能矢量」节点的左侧入口", "err"); return; }
  upd(id, { status: "running", error: undefined, progress: "矢量化中…", result: undefined, svg: undefined, report: undefined });
  try {
    // 读上游超清节点的 analysisMap（文档 §5.3 跨节点复用）：auto 档按内容类型选预设；
    // flatRatio/edgeDensity 传给 Rust 自动微调参数；jpegScore 高 → 报告提示先去压缩
    let upType: string | undefined;
    let amFlat: number | undefined;
    let amEdge: number | undefined;
    let amJpeg: number | undefined;
    const upEdge = useBoard.getState().edges.find((e) => e.target === id);
    const upNode = upEdge ? useBoard.getState().nodes.find((n) => n.id === upEdge.source) : undefined;
    const amPath = upNode?.type === "enhanceLocal" ? ((upNode.data as Record<string, unknown>)?.analysisMapPath as string | undefined) : undefined;
    const guidePath = upNode?.type === "enhanceLocal" ? ((upNode.data as Record<string, unknown>)?.vectorGuidePath as string | undefined) : undefined;
    if (amPath) {
      try {
        const { readTextFile } = await import("@tauri-apps/plugin-fs");
        const am = JSON.parse(await readTextFile(amPath)) as { content?: { type?: string; flatRatio?: number; edgeDensity?: number }; degradation?: { jpegScore?: number } };
        upType = am?.content?.type;
        amFlat = am?.content?.flatRatio;
        amEdge = am?.content?.edgeDensity;
        amJpeg = am?.degradation?.jpegScore;
      } catch {
        /* 读不到忽略，回退默认 */
      }
    }
    // 超清节点的最终图带学习型锐化，不适合作为唯一描边依据；优先消费其保结构 guide，
    // 读不到时无声回退当前连线图片，保证矢量节点仍可独立运行。
    const sourceBytes = (await fetchBytes(input)).bytes;
    let bytes = sourceBytes;
    let usedGuide = false;
    if (guidePath) {
      try {
        const { readFile } = await import("@tauri-apps/plugin-fs");
        bytes = await readFile(guidePath);
        usedGuide = true;
      } catch {
        /* guide 缺失/被清理：继续使用连线图 */
      }
    }
    let preset = data.preset;
    let autoNote = "";
    if (preset === "auto") {
      preset = upType === "photo" ? "photo" : upType === "illustration" ? "comic" : "poster"; // photo→照片；illustration→漫画锐角；其余→海报
      autoNote = `（自动:${upType ?? "未知"}→${preset === "photo" ? "照片" : preset === "comic" ? "漫画" : "海报"}）`;
    }
    const outDir = await assetsDir();
    const { join } = await import("@tauri-apps/api/path");
    const outPath = await join(outDir, `${Date.now()}_${uid(6)}.svg`);
    // 进度事件（批次5）：分析/候选 k/N/评分/后处理/完成
    type VecEvent = { kind: "stage"; data: { stage: string; pct: number } } | { kind: "progress"; data: { pct: number } } | { kind: "log"; data: { msg: string } };
    const onEvent = new Channel<VecEvent>();
    onEvent.onmessage = (e: VecEvent) => {
      if (e.kind === "stage") upd(id, { progress: e.data.stage, progressPct: Math.round(e.data.pct * 100) });
      else if (e.kind === "progress") upd(id, { progressPct: Math.round(e.data.pct * 100) });
    };
    const signal = taskSignal(id);
    const onCancel = () => { void invoke("vectorize_cancel", { taskId: id }); };
    signal?.addEventListener("abort", onCancel);
    let result: {
      svgPath: string; svg: string; width: number; height: number; pathCount: number; shapeCount: number; elapsedMs: number;
      candidates: number; anchors: number; anchorBudget: number; score: number | null; selected: string; hint: string | null;
      qualityPassed: boolean | null; rmse: number | null; edgeIou: number | null; alphaIou: number | null;
    };
    try {
      result = await invoke<typeof result>("vectorize_image", {
        taskId: id,
        inputBytes: bytes,
        referenceBytes: usedGuide ? sourceBytes : null,
        outPath,
        config: {
          preset,
          colorMode: data.colorMode,
          hierarchical: data.hierarchical,
          colorPrecision: data.colorPrecision,
          filterSpeckle: data.filterSpeckle,
          pathPrecision: data.pathPrecision,
          geometry: data.geometry,
          quality: data.quality ?? "balanced",
          flatRatio: amFlat,
          edgeDensity: amEdge,
          jpegScore: amJpeg,
          flatColors: data.flatColors ?? 12,
        },
        onEvent,
      });
    } finally {
      signal?.removeEventListener("abort", onCancel);
    }
    const url = assetUrl(result.svgPath);
    const budgetPct = result.anchorBudget > 0 ? Math.round((result.anchors / result.anchorBudget) * 100) : 0;
    const candLine = result.candidates > 1 ? ` · 候选${result.candidates}选「${result.selected}」` : "";
    const hintLine = result.hint ? ` · ⚠ ${result.hint}` : "";
    const gateLine = result.qualityPassed == null
      ? " · 未回评（极速档）"
      : result.qualityPassed
        ? ` · 描摹一致性检查通过${result.edgeIou != null ? `（边缘${Math.round(result.edgeIou * 100)}%）` : ""}，请核对字形与生产尺寸`
        : " · ⚠ 描摹一致性检查未通过";
    upd(id, {
      status: "done", result: url, svg: result.svg, resultW: result.width, resultH: result.height,
      pathCount: result.pathCount, productionReady: result.qualityPassed ?? undefined, qualityScore: result.score ?? undefined, progress: undefined, progressPct: 100,
      // 节点底部只放一行关键指标；完整诊断收进 reportDetail 悬停查看
      report: `${result.pathCount} 路径 · ${result.width}×${result.height} · ${(result.elapsedMs / 1000).toFixed(1)}s`,
      reportDetail: `${result.pathCount} 条路径 · ${result.anchors} 锚点(预算${budgetPct}%) · ${result.width}×${result.height} · ${(result.elapsedMs / 1000).toFixed(1)}s${result.shapeCount ? ` · ${result.shapeCount} 图元` : ""}${candLine}${autoNote}${usedGuide ? " · 保结构引导+源图回评" : ""}${gateLine}${hintLine}`,
    });
    // 不自动收录资产库：由面板「收入资产库」按钮按需入「矢量」分类
    notifyDone("智能矢量");
  } catch (e) {
    if (isAbortError(e)) {
      upd(id, { status: "idle", progress: undefined });
      toast("已停止", "info");
      return;
    }
    upd(id, { status: "error", error: errMsg(e), progress: undefined });
    pushError("智能矢量", errMsg(e));
  }
}

/** 多模型对比：以该生成节点为母版，为每个所选模型克隆一个节点（继承参数 + 复制上游连线），并行出图/出片横向对比 */
export async function runModelCompare(id: string, keys: string[]) {
  const s = useBoard.getState();
  const node = s.nodes.find((n) => n.id === id);
  if (!node || (node.type !== "imageGen" && node.type !== "videoGen") || !keys.length) return;
  const isVideo = node.type === "videoGen";
  const runOne = RUNNERS[node.type as NodeKind]!; // 经统一闸门：克隆节点也纳入停止通道与并发限流
  const resetFields = isVideo ? { resultUrl: undefined, resultUrls: undefined, picked: 0, progress: undefined } : { results: [], picked: 0 };
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
      node.type as NodeKind,
      { x: baseX + (w + 70) * (i + 1), y: baseY },
      { ...base, modelId: key, status: "idle", error: undefined, ...resetFields },
    );
    for (const e of inEdges) bs.connectNodes(e.source, nid, "in", e.sourceHandle ?? "out");
    ids.push(nid);
  });
  toast(`已按 ${keys.length} 个模型建立对比节点，并行生成中…`, "info");
  await Promise.all(ids.map((nid) => runOne(nid)));
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
  const runOne = RUNNERS[node.type as NodeKind]!; // 经统一闸门：克隆节点也纳入停止通道与并发限流
  const resetFields = isVideo
    ? { resultUrl: undefined, resultUrls: undefined, picked: 0, progress: undefined }
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
  // 端口统一后：图输入边 = 源节点输出 image（参考图共用；文本已物化进各条提示词，不再连文本边）
  const inEdges = s.edges.filter((e) => e.target === id && srcOutType(e, s.nodes) === "image");
  const ids: string[] = [];
  const COLS = 4;
  prompts.forEach((line, i) => {
    const bs = useBoard.getState();
    const nid = bs.addNode(
      node.type as NodeKind,
      { x: baseX + (w + 70) * ((i % COLS) + 1), y: baseY + Math.floor(i / COLS) * (h + 90) },
      { ...base, prompt: shared ? `${shared}\n${line}` : line, status: "idle", error: undefined, ...resetFields },
    );
    for (const e of inEdges) bs.connectNodes(e.source, nid, "in", e.sourceHandle ?? "out");
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
  const runOne = RUNNERS[node.type as NodeKind]!; // 经统一闸门：克隆节点也纳入停止通道与并发限流
  const resetFields = isVideo ? { resultUrl: undefined, resultUrls: undefined, picked: 0, progress: undefined } : { results: [], picked: 0 };
  const imgEdges = s.edges.filter((e) => e.target === id && srcOutType(e, s.nodes) === "image");
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
  const textEdges = s.edges.filter((e) => e.target === id && srcOutType(e, s.nodes) === "text");
  const ids: string[] = [];
  const COLS = 4;
  imgEdges.forEach((imgEdge, i) => {
    const bs = useBoard.getState();
    const nid = bs.addNode(
      node.type as NodeKind,
      { x: baseX + (w + 70) * ((i % COLS) + 1), y: baseY + Math.floor(i / COLS) * (h + 90) },
      { ...base, status: "idle", error: undefined, ...resetFields },
    );
    bs.connectNodes(imgEdge.source, nid, "in", imgEdge.sourceHandle ?? "out");
    for (const e of textEdges) bs.connectNodes(e.source, nid, "in", e.sourceHandle ?? "out");
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
  const { texts, images, videos, audios } = collectUpstream(id);
  const prompt = (data.prompt ?? "").trim() || texts.join("\n");
  if (!prompt && !images.length) {
    toast("请输入视频描述，或连接提示词/图片节点", "err");
    return;
  }
  upd(id, { status: "running", error: undefined, progress: "提交任务…", resultUrl: undefined, resultUrls: undefined, picked: 0 });
  let primaryCard: ModelCard | null = null;
  const t0 = Date.now();
  try {
    const card = resolveModelCard("video", data.modelId);
    primaryCard = card;
    const finalPrompt = await localizePrompt(prompt, (data as { lang?: string }).lang);
    // 预算护栏（视频按秒数 × 张数预估）
    const gate = budgetGate(estimateCost(card.model, { videoSec: Number(data.duration ?? "5") * (data.parallel ?? 1) }));
    if (gate.block) throw new Error(gate.block);
    if (gate.confirm && !window.confirm(gate.confirm)) {
      upd(id, { status: "idle", error: undefined, progress: undefined });
      return;
    }
    // 主模型瞬时重试 → 备用模型；run 回调用当前 card 重算家族 meta（备用可能不同家族）
    const { result: urls, card: usedCard, usedFallback } = await runGenWithFallback("video", card, taskSignal(id), async (c) => {
      const meta = videoMeta(videoFamily(c));
      const useRef = data.refMode === "reference" && (meta.maxRef ?? 0) > 0 && images.length > 0;
      const lastFrame = !useRef && meta.tail && (data.useTail ?? true) && images.length >= 2 ? images[1] : undefined;
      // GPU 大任务前检查本地 LLM 显存占用（远程视频生成通常也吃本地推理显存）
      await releaseLocalGpuIfOccupied("视频生成");
      const baseReq = {
        prompt: finalPrompt,
        image: useRef ? undefined : images[0],
        lastFrame,
        refImages: useRef ? images.slice(0, meta.maxRef) : undefined,
        video: videos[0],
        refAudio: audios[0],
        duration: data.duration ?? meta.defaultDuration,
        resolution: data.resolution ?? meta.defaultResolution,
        aspect: data.aspect ?? meta.aspects[0],
        audio: meta.audioToggle ? (data.audio ?? true) : undefined,
        signal: taskSignal(id),
      };
      const parallel = Math.max(1, Math.min(3, Math.round(data.parallel ?? 1)));
      const slotMsg = Array.from({ length: parallel }, () => "排队中…");
      let doneCount = 0;
      const settled = await Promise.allSettled(
        Array.from({ length: parallel }, (_, i) =>
          generateVideo(c, {
            ...baseReq,
            onProgress: (m) => {
              slotMsg[i] = m;
              upd(id, {
                progress: parallel > 1 ? `并行 ${parallel} 条 · 完成 ${doneCount}/${parallel} · ${i + 1}# ${slotMsg[i]}` : m,
              });
            },
          }).then((url) => {
            doneCount += 1;
            return url;
          }),
        ),
      );
      const urls = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      if (!urls.length) {
        const firstErr = settled.find((r) => r.status === "rejected");
        throw (firstErr as PromiseRejectedResult | undefined)?.reason ?? new Error("生成失败：未返回任何视频");
      }
      return urls;
    });
    if (usedFallback) {
      upd(id, { fallbackModel: usedCard.name });
      toast(`主模型失败，已由备用模型「${usedCard.name}」生成`, "info");
    } else {
      upd(id, { fallbackModel: undefined });
    }
    upd(id, { status: "done", resultUrl: urls[0], resultUrls: urls, picked: 0, progress: undefined });
    usePromptHist.getState().record(prompt);
    pushHistory(id, {
      prompt,
      modelId: modelKey(usedCard.id, usedCard.model),
      params: {
        duration: data.duration, resolution: data.resolution, aspect: data.aspect,
        parallel: data.parallel, refMode: data.refMode, useTail: data.useTail, audio: data.audio, lang: data.lang,
      },
      results: urls,
    });
    // 收录资产库后把节点地址换成本地文件：blob URL 重启即失效、中转站直链一般 24 小时过期
    const savedUrls: string[] = [];
    for (const url of urls) {
      useUi.getState().addGallery({ kind: "video", src: url, prompt, model: usedCard.model, nodeId: id });
      const saved = await useAssets.getState().collect({
        src: url,
        kind: "video",
        prompt,
        model: usedCard.name,
        nodeId: id,
        durationMs: Date.now() - t0,
        gen: { nodeKind: "videoGen", prompt: (data.prompt ?? "").trim() || prompt, modelId: modelKey(usedCard.id, usedCard.model), lang: data.lang },
      });
      savedUrls.push(saved && isTauri ? assetUrl(saved.path) : url);
    }
    upd(id, { resultUrls: savedUrls, resultUrl: savedUrls[0] });
    useUsage.getState().record(usedCard, { ok: true, videoSec: Number(data.duration ?? "5") * urls.length, durMs: Date.now() - t0 });
  } catch (e) {
    if (isAbortError(e)) {
      upd(id, { status: "idle", error: undefined, progress: undefined });
      toast("已停止生成（已提交到服务商的任务无法追回，可能仍会计费）", "info");
      return;
    }
    if (primaryCard) useUsage.getState().record(primaryCard, { ok: false, durMs: Date.now() - t0 });
    upd(id, { status: "error", error: errMsg(e), progress: undefined });
    pushError("生成视频", errMsg(e));
  }
}

/* ---------- 首尾帧连拍：多张有序图片 → 相邻两两配对批量生成视频（可选拼接成片） ---------- */

/**
 * 画布位置即时间序（上→下、左→右，与 orderedInEdges 取上游图的规则一致）：
 * 第 i 张作首帧、第 i+1 张作尾帧建一个视频节点，全部并行运行；成功段可一键 ffmpeg 拼接成片。
 * 九宫格抽卡 → 宫格切分 → 框选全部切片 → 右键连拍，即 LibTV「多机位九宫格」同款动线。
 */
export async function runTailSequence(imgIds: string[]) {
  const s = useBoard.getState();
  const nodes = imgIds
    .map((id) => s.nodes.find((n) => n.id === id))
    .filter((n): n is NonNullable<typeof n> => !!n && !!nodeMainImage(n));
  if (nodes.length < 2) {
    toast("首尾帧连拍需要至少 2 张带图的图片节点", "err");
    return;
  }
  const abs = (n: (typeof nodes)[number]) => {
    const p = n.parentId ? s.nodes.find((x) => x.id === n.parentId) : undefined;
    return { x: n.position.x + (p?.position.x ?? 0), y: n.position.y + (p?.position.y ?? 0) };
  };
  const sorted = [...nodes].sort((a, b) => {
    const pa = abs(a);
    const pb = abs(b);
    return pa.y - pb.y || pa.x - pb.x || a.id.localeCompare(b.id);
  });

  // 预检模型（节点 init 显式清 modelId 走角色默认，与此一致）；无尾帧能力的家族直接拦下
  let card: ModelCard;
  try {
    card = resolveModelCard("video");
  } catch (e) {
    toast(errMsg(e), "err");
    return;
  }
  const meta = videoMeta(videoFamily(card));
  if (!meta.tail) {
    toast(`视频模型「${card.model}」不支持首尾帧，请在设置中把视频角色模型换成可灵 / Vidu / Wan / 海螺 Hailuo-02 等支持尾帧的模型`, "err");
    return;
  }
  const pairs = sorted.slice(0, -1).map((n, i) => [n, sorted[i + 1]] as const);
  const durationSec = Number(meta.defaultDuration ?? "5") || 5;
  const est = estimateCost(card.model, { videoSec: durationSec }) * pairs.length;
  const msg = `将按画布位置（上→下、左→右）把 ${sorted.length} 张图连成 ${pairs.length} 段视频：相邻两帧作首尾帧，每段约 ${durationSec} 秒。`
    + `${est > 0 ? `\n预估费用：约 ¥${est.toFixed(2)}（按「${card.model}」单价）。` : ""}\n确定开始连拍？`;
  let go: boolean;
  if (isTauri) {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    go = await ask(msg, { title: "首尾帧连拍", kind: "warning" });
  } else {
    go = window.confirm(msg);
  }
  if (!go) return;

  const base = abs(sorted[0]);
  const w = sorted[0].measured?.width ?? 300;
  const ids: string[] = [];
  pairs.forEach(([a, b], i) => {
    const bs = useBoard.getState();
    const nid = bs.addNode(
      "videoGen",
      { x: base.x + w + 160, y: base.y + i * 420 },
      { status: "idle", prompt: "", modelId: undefined, useTail: true, parallel: 1 },
    );
    // 连边顺序不决定输入序（orderedInEdges 按源节点位置 y→x），sorted 的位置序保证前者=首帧
    bs.connectNodes(a.id, nid, "in", "out");
    bs.connectNodes(b.id, nid, "in", "out");
    ids.push(nid);
  });
  toast(`已建立 ${pairs.length} 个视频节点（相邻图作首尾帧），并行生成中…`, "info");
  const runOne = RUNNERS["videoGen"]!;
  await Promise.all(ids.map((nid) => runOne(nid)));
  notifyDone("首尾帧连拍");

  // 拼接成片：只拼成功段，失败/停止段跳过（失败原因已进报错中心）
  const s2 = useBoard.getState();
  const segUrls = ids
    .map((nid) => {
      const d = s2.nodes.find((n) => n.id === nid)?.data as VideoGenData | undefined;
      if (!d || d.status !== "done") return undefined;
      return (d.resultUrls?.length ? d.resultUrls[d.picked ?? 0] : d.resultUrl) ?? undefined;
    })
    .filter((u): u is string => !!u);
  const failed = pairs.length - segUrls.length;
  if (segUrls.length < 2) {
    toast(`连拍结束：成功 ${segUrls.length} 段${failed ? `、失败 ${failed} 段` : ""}，不足 2 段无法拼接`, failed ? "info" : "ok");
    return;
  }
  const smsg = `连拍完成：成功 ${segUrls.length} 段${failed ? `、失败 ${failed} 段（已跳过）` : ""}。\n把成功的段按顺序拼接成一条视频？`;
  let stitch: boolean;
  if (isTauri) {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    stitch = await ask(smsg, { title: "拼接成片", kind: "info" });
  } else {
    stitch = window.confirm(smsg);
  }
  if (!stitch) return;
  await stitchTailClips(segUrls, { x: base.x + w + 160, y: base.y + pairs.length * 420 });
}

/** 连拍成片拼接：各段生成时已收录资产库（桌面端为本地文件），probe 实际时长后交 ffmpeg 拼接；浏览器降级 MediaRecorder */
async function stitchTailClips(urls: string[], pos: { x: number; y: number }) {
  try {
    const assets = useAssets.getState().items;
    const paths = urls.map((u) => assets.find((a) => a.path && assetUrl(a.path) === u)?.path ?? (/^asset:/i.test(u) ? "" : u));
    const usable = paths.filter(Boolean);
    if (usable.length < 2) {
      toast("可拼接的本地视频不足 2 段（资产文件不可读）", "err");
      return;
    }
    // 桌面端逐段 probe 真实时长/分辨率（模型标 5 秒未必正好 5.0s）；首段定输出规格
    let width = 1280;
    let height = 720;
    let fps = 30;
    const clips: RenderClipPlan[] = [];
    for (let i = 0; i < usable.length; i++) {
      let dur = 5;
      if (isTauri && !/^(blob:|data:|https?:)/i.test(usable[i])) {
        try {
          const mediaTool = (await import("./stores/directorStore")).useDirector.getState().mediaTool;
          const p = await invoke<{ duration_sec: number; width: number; height: number; fps: number }>("media_probe", {
            input: usable[i],
            ffprobePath: mediaTool.ffprobePath ?? null,
          });
          dur = p.duration_sec || 5;
          if (i === 0 && p.width && p.height) {
            width = p.width - (p.width % 2);
            height = p.height - (p.height % 2);
            fps = Math.round(p.fps) || 30;
          }
        } catch {
          /* probe 失败按 5 秒兜底，不阻塞拼接 */
        }
      }
      clips.push({ path: usable[i], inSec: 0, outSec: dur, durSec: dur, volume: 1, muted: false, transition: "cut" });
    }
    const plan: RenderPlan = {
      clips,
      audio: [],
      titles: [],
      srt: "",
      width,
      height,
      fps,
      fit: "contain",
      totalSec: clips.reduce((n, c) => n + c.durSec, 0),
      assetCount: clips.length,
    };
    let outPath = `momo_tailseq_${Date.now()}.mp4`;
    if (isTauri) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const picked = await save({
        title: "拼接成片",
        defaultPath: `首尾帧连拍_${new Date().toISOString().slice(0, 10)}.mp4`,
        filters: [{ name: "MP4 视频", extensions: ["mp4"] }],
      });
      if (!picked || typeof picked !== "string") return;
      outPath = picked;
    }
    toast("拼接渲染中…（ffmpeg 逐段规范化后串联）", "info");
    const r = await renderToMp4(plan, outPath);
    if (r.path && isTauri) {
      const asset = await useAssets.getState().collect({ src: r.path, kind: "video", prompt: "首尾帧连拍成片" });
      if (asset) {
        useBoard.getState().addNode("video", pos, { src: assetUrl(asset.path), name: "首尾帧连拍成片", status: "done" });
      }
      toast(`成片已导出：${r.path}`, "ok");
    } else {
      toast("浏览器降级拼接完成（webm，无字幕/转场）", "ok");
    }
  } catch (e) {
    toast(`拼接失败：${errMsg(e)}`, "err");
    pushError("首尾帧连拍", `拼接失败：${errMsg(e)}`);
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
    // 陈旧 variantId 守卫：模板编辑/undo 后 variantId 可能指向已删除的分支，静默回落会丢参数
    let variantId = data.variantId;
    if (variantId && !tpl.variants?.some((v) => v.id === variantId)) {
      toast(`该模板已无「${variantId}」分支，已切回默认`, "err");
      variantId = undefined;
      upd(id, { variantId: undefined });
    }
    // 按当前分支的有效参数收集用户填值；paramsByVariant 优先（分支参数记忆），回落 data.params
    const effParams = effectiveParams(tpl, variantId);
    const branchStore = variantId ? data.paramsByVariant?.[variantId] : undefined;
    const branchParams = branchStore ?? data.params ?? {};
    const values: Record<string, string | number | boolean> = {};
    for (const p of effParams) {
      const own = branchParams[p.key];
      if (own !== undefined && own !== "") values[p.key] = own;
    }
    // GPU 大任务前检查本地 LLM 显存占用（ComfyUI 与 llama-server 争抢显存）
    await releaseLocalGpuIfOccupied("ComfyUI 工作流");
    const { images: results, texts: outTexts, videos: outVideos } = await runComfyTemplate(settings.comfy.host, tpl, values, {
      onProgress: (m, pct) => upd(id, { progress: m, ...(pct !== undefined ? { progressPct: pct } : {}) }),
      upstreamImages: images,
      upstreamTexts: texts,
      upstreamVideos: upVideos,
      variantId,
      imageSlotMap: data.imageSlotMap,
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
    const promptText = String(values[effParams.find((p) => p.kind === "text")?.key ?? ""] ?? texts.join("\n") ?? "");
    pushHistory(id, {
      prompt: promptText,
      modelId: `comfy:${tpl.id}${variantId ? `/${variantId}` : ""}`,
      params: { templateId: tpl.id, ...(variantId ? { variantId } : {}), ...branchParams },
      results: [...results, ...outVideos],
    });
    if (outVideos.length) {
      // 视频结果落盘换持久地址（/view 转出的 blob URL 活不过重启），并进画廊/资产库
      const savedUrls: string[] = [];
      for (const v of outVideos) {
        const it = await useAssets.getState().collect({ src: v, kind: "video", prompt: promptText, model: `ComfyUI · ${tpl.name}` });
        const stable = it && isTauri ? assetUrl(it.path) : v;
        savedUrls.push(stable);
        useUi.getState().addGallery({ kind: "video", src: stable, prompt: promptText, model: tpl.name, nodeId: id });
      }
      upd(id, { videoResults: savedUrls });
    }
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
  } finally {
    // 运行结束后按节点开关清理显存（成功/失败都清——失败时显存可能已被占用）
    if (data.freeAfter) {
      const host = useSettings.getState().settings.comfy.host;
      if (host) {
        const r = await freeComfyMemory(host);
        if (!r.ok) console.warn("[ComfyUI] 清理显存失败：", r.err);
      }
    }
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

/* ---------- 文本处理（融合反推描述）：文本类操作吃上游文本，cap* 反推类操作吃上游图片 ---------- */
const LLM_TEXT_SYSTEMS: Record<Exclude<LlmTextData["op"], "custom">, string> = {
  optimize: OPTIMIZE_SYSTEM,
  zh2en: "把用户输入的绘画提示词翻译成地道的英文 AI 绘画提示词，保留专业术语，只输出翻译结果。",
  expand: "把用户输入的文字扩写得更丰富具体（补充细节、场景、氛围），保持原意，中文输出，只输出扩写结果。",
  shorten: "把用户输入的文字精简压缩，保留核心信息与关键词，只输出精简结果。",
  capPrompt:
    "你是图像反推提示词专家。仔细观察用户发来的图片，输出一段可直接用于 AI 绘画复现该图的中文提示词：主体、构图、风格、光影、色彩、镜头、质感。只输出提示词本身。",
  capDetail: "你是图像分析师。详细描述用户发来的图片：主体内容、场景、风格、构图、色彩与值得注意的细节。用中文分段描述。",
  capTags: "观察用户发来的图片，输出 15-25 个英文标签词（danbooru 风格，逗号分隔），从主体到风格到质感排列。只输出标签。",
};

/** cap* 开头的操作是反推类（消费图片） */
export const isCaptionOp = (op: string) => op.startsWith("cap");

/**
 * 「自定义指令」的系统提示：把用户的一句话指令（如「改成赛博朋克」「换个配色」）框成
 * 对已有文本的编辑操作，而不是让模型自由创作——否则模型会把指令当人设、把原文当新需求，
 * 生成一大段与原文无关的内容。原文始终作为 user 消息传入。
 */
function customEditSystem(instruction: string): string {
  return [
    "你是提示词编辑器。用户会发来一段已有文本，请严格按照下方的修改指令编辑它，输出编辑后的完整文本。",
    "规则：",
    "- 只改动修改指令涉及的部分；指令没提到的内容（措辞、结构、语言、长度）一律原样保留",
    "- 不要新增指令之外的内容，不要扩写、不要补充细节",
    "- 不解释、不加任何前后缀或标题，只输出编辑后的文本",
    "",
    `修改指令：${instruction}`,
  ].join("\n");
}

/** 提示词 AI 工具（生成弹窗 / 提示词节点共用）：对一段文本做单次 LLM 变换，返回结果文本（就地替换用） */
export async function llmTextTransform(
  op: LlmTextData["op"],
  custom: string,
  text: string,
  image?: string,
): Promise<string> {
  const card = resolveModelCard("chat");
  const caption = isCaptionOp(op);
  const system =
    op === "custom" ? customEditSystem((custom ?? "").trim() || "在不改变原意的前提下理顺文本") : LLM_TEXT_SYSTEMS[op];
  const { text: out } = await chatStream(
    card,
    [{ role: "user", text: caption ? "请分析这张图片。" : text, images: caption && image ? [image] : undefined }],
    { system },
  );
  return out.trim();
}

export async function runLlmText(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as LlmTextData;
  if (data.status === "running") return;
  const { texts, images } = collectUpstream(id);
  const caption = isCaptionOp(data.op);
  if (caption && !images.length) {
    toast("反推需要先连接一个上游图片节点", "err");
    return;
  }
  const input = texts.join("\n").trim();
  if (!caption && !input) {
    toast("请先连接上游文本节点（提示词/对话等）", "err");
    return;
  }
  upd(id, { status: "running", error: undefined });
  try {
    const card = resolveModelCard("chat", data.modelId);
    const system =
      data.op === "custom"
        ? customEditSystem((data.custom ?? "").trim() || "在不改变原意的前提下理顺文本")
        : LLM_TEXT_SYSTEMS[data.op];
    const { text } = await chatStream(
      card,
      [{ role: "user", text: caption ? "请分析这张图片。" : input, images: caption ? [images[0]] : undefined }],
      {
        system,
        signal: taskSignal(id),
        onText: (full) => upd(id, { result: full }),
      },
    );
    upd(id, { status: "done", result: text.trim() });
  } catch (e) {
    if (isAbortError(e)) {
      upd(id, { status: "idle", error: undefined });
      toast("已停止", "info");
      return;
    }
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


/* ---------- 角色卡 ---------- */
type CharAnalysis = { profile: CharProfile; prompts: Partial<Record<CharDeliverable, string>> };

/** 读取节点当前的角色卡数据（生成过程中多次写回，需要拿最新值） */
function charData(id: string): CharCardData | undefined {
  return useBoard.getState().nodes.find((n) => n.id === id)?.data as CharCardData | undefined;
}

/** 表情集网格：按所选画幅推导 cols×rows —— 越接近正方形越接近 2×2，越扁加列、越长加行，
 *  让表情数量随比例自适应（1:1→4，3:4→6，16:9→8，9:16→8…）。 */
function expressionGrid(aspect?: string): { cols: number; rows: number } {
  const r = aspect && aspect !== "auto" ? parseRatio(aspect) : null;
  const rr = r && r > 0 ? r : 1;
  const cols = Math.max(2, Math.min(5, Math.round(rr * 2)));
  const rows = Math.max(2, Math.min(5, Math.round(2 / rr)));
  return { cols, rows };
}

/** 把外貌锚点 / 用户文字描述 / 半身→全身补全指令拼进单条素材提示词。
 *  修复「生成不参考用户描述」「半身照补不出全身」：runner 出图不能只靠分析阶段把描述烧进 prompts
 *  （视觉模型遵守度不稳），这里显式把 profile 外貌锚点与上游用户描述逐字重复进每条 prompt，
 *  并要求三视图/立绘必须全身（参考图仅为半身时合理扩展补全）。改这一处同时覆盖整套生成与「补一张/重生」。 */
function enrichCharPrompt(id: string, data: CharCardData, k: CharDeliverable, base: string): string {
  const p = data.profile;
  const parts: string[] = [base];
  if (p) {
    const anchor = [p.appearance, p.outfit, p.accessories ?? []].flat().filter(Boolean).join("；");
    if (anchor) parts.push(`角色外貌锚点（多张图必须逐字保持一致）：${anchor}`);
    if (p.artStyle) parts.push(`画风：${p.artStyle}`);
  }
  const texts = collectUpstream(id).texts;
  if (texts.length) parts.push(`用户补充设定（必须体现在画面中）：${texts.join("；")}`);
  if (k === "expressions") {
    const g = expressionGrid(data.aspect);
    parts.push(
      `本图比例为 ${data.aspect && data.aspect !== "auto" ? data.aspect : "1:1"}，请用 ${g.cols}×${g.rows} 网格排列 ${g.cols * g.rows} 种互不相同、差异明显的表情（而非默认 2×2 四种），每格区域充足、五官细节清晰。`,
    );
  }
  if (k === "turnaround" || k === "portrait") {
    parts.push("必须为完整全身画面（若参考图仅为半身，合理扩展补全下半身至全身，保持人物一致）");
  }
  return parts.join("\n");
}

/** 生成单个素材并写回（收录记录/资产库）；append = 追加到该素材已有图之后（「补一张」）；返回第一张结果 */
async function genCharDeliverable(
  id: string,
  k: CharDeliverable,
  prompt: string,
  refs: string[],
  opts?: { append?: boolean },
): Promise<string | undefined> {
  const data = charData(id);
  if (!data) return;
  const card = resolveModelCard("image", data.imageModelId);
  const finalPrompt = enrichCharPrompt(id, data, k, prompt);
  const results = await generateImage(card, {
    prompt: finalPrompt,
    n: 1,
    // 多张局部参考（脸/腿/胸…）最多带 6 张；各协议内部再自行裁剪
    refImages: refs.length ? refs.slice(0, 6) : undefined,
    aspect: data.aspect && data.aspect !== "auto" ? data.aspect : undefined,
    resolution: data.resolution,
    quality: data.quality,
  });
  const cur = charData(id);
  const merged = opts?.append ? [...(cur?.results?.[k] ?? []), ...results] : results;
  upd(id, { results: { ...(cur?.results ?? {}), [k]: merged } });
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
        // 参考图取最新 data：genRefs（用户在参数栏指定的清晰图/局部图）> 上游传入第一张图
        const cur = charData(id) ?? data;
        const refs = [...(cur.genRefs ?? (refImage ? [refImage] : [])), anchor].filter((x): x is string => !!x);
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

/** 单独重生成某一种素材（节点内每行的刷新按钮）；append = 「补一张」：表情/动作/服装自动换下一组内容后追加 */
export async function regenCharDeliverable(id: string, k: CharDeliverable, opts?: { append?: boolean }) {
  const data = charData(id);
  if (!data || data.status === "running") return;
  const base = (data.prompts[k] ?? "").trim();
  if (!base) {
    toast("该素材还没有提示词：先运行一次「分析并生成」", "err");
    return;
  }
  // 「补一张」：按已有张数循环取下一组内容，逐张补全设定而不是堆砌在一张里
  let prompt = base;
  const sets = DELIV_VARIATIONS[k];
  if (opts?.append && sets?.length) {
    const idx = Math.max(0, (data.results[k]?.length ?? 1) - 1) % sets.length;
    prompt = `${base}\n注意：本次画面内容换成另一组：${sets[idx]}；版式、角色一致性与其余要求不变。`;
  }
  upd(id, { status: "running", error: undefined, progress: `${opts?.append ? "补一张" : "重新生成"}${DELIV_LABEL[k]}…` });
  try {
    const { images } = collectUpstream(id);
    // 已有的其他素材里挑一张当参考，维持角色一致
    const anchorK = (["turnaround", "portrait", "closeup"] as CharDeliverable[]).find(
      (x) => x !== k && data.results[x]?.length,
    );
    // 参考图取 genRefs（参数栏指定的清晰图/局部图）> 上游传入第一张图
    const refs = [
      ...(data.genRefs ?? (images[0] ? [images[0]] : [])),
      anchorK ? data.results[anchorK]![0] : undefined,
    ].filter((x): x is string => !!x);
    await genCharDeliverable(id, k, prompt, refs, { append: opts?.append });
    upd(id, { status: "done", progress: undefined });
    notifyDone(`${DELIV_LABEL[k]}生成`);
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e), progress: undefined });
    pushError("角色卡", errMsg(e));
  }
}

/* ---------- 电商长图 ---------- */

/** 读取电商节点当前 data */
function ecomData(id: string): EcomImageData | undefined {
  return useBoard.getState().nodes.find((n) => n.id === id)?.data as EcomImageData | undefined;
}

/** 拼接单片生图提示词：画面提示词 + 产品/内容锚点 + 风格调性 + 风格参考提示 + 卖点文案（写进画面） */
function ecomEnriched(slide: EcomSlide, prod: EcomAnalysis["product"] | undefined, hasRef: boolean): string {
  const anchorBits = prod
    ? [prod.name, prod.category, prod.material, prod.color, ...(prod.features ?? [])].filter(Boolean).join("，")
    : "";
  const parts: string[] = [slide.prompt];
  if (anchorBits) parts.push(`产品/内容一致性锚点（必须与其它切片保持同一主体、同一品牌调性）：${anchorBits}`);
  if (prod?.styleTone) parts.push(`风格调性：${prod.styleTone}`);
  if (hasRef) parts.push("请参考所附参考图的整体风格、配色与版式质感，与其它切片保持统一。");
  if (slide.copy) {
    parts.push(`请把以下文案以电商海报排版直接写进画面（产品旁空白区，清晰可读、不乱码不溢出）：「${slide.copy}」`);
  }
  return parts.join("\n");
}

/** 从切片提示词里解析用户 @引用的上游图（@图名 → src），顺序与 collectImageRefsFor 一致 */
function atRefsFromPrompt(prompt: string | undefined, nodeId: string): string[] {
  if (!prompt || !prompt.includes("@")) return [];
  const all = collectImageRefsFor(nodeId);
  return all.filter((r) => prompt.includes(`@${r.label}`)).map((r) => r.src);
}

/** 选参考图：该片提示词里 @引用的图 > 上一片(过渡) > 首张产出(风格锚)；product 模式保底塞 1 张产品图防丢主体；去重取前 max 张 */
function ecomRefs(o: {
  atRefs?: string[];
  prev?: string;
  anchor?: string;
  productImg?: string;
  mode: "product" | "h5";
  max: number;
}): string[] {
  const max = Math.max(1, o.max);
  // product 模式保底留 1 张产品图槽：用户 @的参考图再多也不丢主体一致性
  const reserve = o.mode === "product" && o.productImg ? 1 : 0;
  const head = [...(o.atRefs ?? []), o.prev, o.anchor].filter((x): x is string => !!x);
  const dedupHead = [...new Set(head)].slice(0, Math.max(0, max - reserve));
  const chain = reserve && o.productImg ? [...dedupHead, o.productImg] : dedupHead;
  return [...new Set(chain)].slice(0, max);
}

/** 把切片提示词里的 @图名 替换成「图N」，N 与该片刻实际传给模型的 refs 顺序一致（模型按图N 引用） */
function ecomResolvePrompt(prompt: string | undefined, refs: string[], nodeId: string): string {
  if (!prompt || !prompt.includes("@")) return prompt ?? "";
  const all = collectImageRefsFor(nodeId);
  let out = prompt;
  for (const r of all) {
    if (!out.includes(`@${r.label}`)) continue;
    const idx = refs.indexOf(r.src);
    if (idx >= 0) out = out.split(`@${r.label}`).join(`图${idx + 1}`);
  }
  return out;
}

/** 把参考图缩成长边 256 的等比 jpeg 小图（最多 maxCount 张），落盘到 slide.refs 供工作台左下展示；缩失败回退原图 */
async function refsToThumbs(refs: string[], maxCount = 4, longSide = 256): Promise<string[]> {
  const out: string[] = [];
  for (const r of refs.slice(0, maxCount)) {
    try {
      const blob = await (await fetch(r)).blob();
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, longSide / Math.max(bmp.width, bmp.height));
      const w = Math.max(16, Math.round(bmp.width * scale));
      const h = Math.max(16, Math.round(bmp.height * scale));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      if (!ctx) {
        bmp.close();
        out.push(r);
        continue;
      }
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close();
      out.push(c.toDataURL("image/jpeg", 0.85));
    } catch {
      out.push(r); // 外置 blob 等读取失败时回退原图
    }
  }
  return out;
}

/** Phase 1：分析 / 切片规划 —— 用对话模型产出「切片脚本」（标题 + 提示词 + 文案），不调绘画模型。
 *  产物写回 data.analysis + data.slides（可在工作台里编辑提示词），等你确认后再 generateEcom。 */
export async function analyzeEcom(id: string) {
  const data = ecomData(id);
  if (!data || data.status === "running") return;
  const { texts, images } = collectUpstream(id);
  const mode = data.mode ?? "product";
  const tone = mode === "h5" ? (data.h5StyleTone ?? "") : (data.styleTone ?? "");
  const productImg = images[0];
  const longText = (data.productDesc ?? "").trim() || texts.join("\n").trim();
  if (mode === "product") {
    if (!productImg && !data.analysis) {
      toast("请先连接一张产品拍照图（或商品图）到电商长图节点", "err");
      return;
    }
  } else if (!longText && !data.analysis) {
    toast("H5 模式：请在「文案」里粘贴长文案，或连接上游文本节点", "err");
    return;
  }
  upd(id, { status: "running", error: undefined, progress: mode === "h5" ? "按内容切片长文中…" : "分析产品图中…" });
  try {
    const chatCard = resolveModelCard("chat", data.chatModelId);
    let text: string;
    if (mode === "product") {
      if (!productImg) throw new Error("没有产品图可供分析：请连接一张产品拍照图");
      if (!chatCaps(chatCard).vision) {
        throw new Error(`当前对话模型「${chatCard.name}」不支持视觉输入，请在「设置」换一个多模态模型`);
      }
      text = (
        await chatStream(
          chatCard,
          [{ role: "user", text: "请分析这张产品拍照图并按要求输出 JSON。", images: [productImg] }],
          {
            system: ecomAnalysisSystem({ styleTone: tone, sliceCount: data.sliceCount, aspect: data.aspect, productDesc: longText }),
            signal: taskSignal(id),
          },
        )
      ).text;
    } else {
      text = (
        await chatStream(
          chatCard,
          [{ role: "user", text: `请把下面这篇文案按要求切成若干长图切片并输出 JSON：\n\n${longText}` }],
          { system: h5AnalysisSystem({ styleTone: tone, sliceCount: data.sliceCount, aspect: data.aspect }), signal: taskSignal(id) },
        )
      ).text;
    }
    const analysis = parseEcomAnalysis(text);
    if (!analysis) {
      throw new Error(
        `分析结果解析失败：模型没有按 JSON 格式返回（请重试，或在「设置」换一个遵循 JSON 的对话模型）。模型回复前 200 字：${text.slice(0, 200).replace(/\s+/g, " ")}`,
      );
    }
    const slides: EcomSlide[] = analysis.slides.map((s) => ({ title: s.title, prompt: s.prompt, copy: s.copy }));
    // 只规划：清掉旧图，保留可编辑的提示词脚本，等用户确认后再生成长图
    upd(id, { status: "done", analysis, slides, result: undefined, progress: undefined });
    notifyDone(mode === "h5" ? "切片规划" : "产品分析");
  } catch (e) {
    if (isAbortError(e)) {
      upd(id, { status: "idle", error: undefined, progress: undefined });
      return;
    }
    upd(id, { status: "error", error: errMsg(e), progress: undefined });
    pushError("电商长图", errMsg(e));
  }
}

/** Phase 2：生成长图 —— 按 data.slides（可能已被编辑过的提示词）逐片统一风格生成 → 纵向拼接。 */
export async function generateEcom(id: string) {
  const data = ecomData(id);
  if (!data || data.status === "running") return;
  const analysis = data.analysis;
  const src = data.slides;
  if (!analysis || !src || !src.length) {
    toast("请先点「分析并规划」生成切片脚本，再生成长图", "err");
    return;
  }
  const { images } = collectUpstream(id);
  const mode = data.mode ?? "product";
  const productImg = images[0];
  let maxRef = 8;
  try {
    maxRef = familyMaxRef(imageFamily(resolveModelCard("image", data.imageModelId)));
  } catch {
    /* 无可用绘画模型时回落到默认上限 */
  }
  upd(id, { status: "running", error: undefined, progress: "生成切片中…" });
  try {
    const imgCard = resolveModelCard("image", data.imageModelId);
    const groupId = `ecom-${uid(12)}`;
    const groupLabel = `${analysis.product.name || "电商长图"} · ${src.length} 片`;
    upd(id, { assetGroupId: groupId });
    const seed = data.seed;
    // 浅拷贝保留旧 img/refs：循环内逐片覆盖，中途失败时未到达的切片仍保留旧图（不丢已扣费结果）
    const slides: EcomSlide[] = src.map((s) => ({ ...s }));
    let prev: string | undefined;
    let anchor: string | undefined;
    for (let i = 0; i < slides.length; i++) {
      if (taskSignal(id)?.aborted) throw new DOMException("Aborted", "AbortError");
      upd(id, { progress: `生成切片 ${i + 1}/${slides.length}：${slides[i].title}…` });
      const refs = ecomRefs({ atRefs: atRefsFromPrompt(slides[i].prompt, id), prev, anchor, productImg, mode, max: maxRef });
      const enriched = ecomEnriched({ ...slides[i], prompt: ecomResolvePrompt(slides[i].prompt, refs, id) }, analysis.product, refs.length > 0);
      const results = await generateImage(imgCard, {
        prompt: enriched,
        n: 1,
        refImages: refs.length ? refs : undefined,
        aspect: data.aspect && data.aspect !== "auto" ? data.aspect : undefined,
        resolution: data.resolution,
        quality: data.quality,
        seed,
        signal: taskSignal(id),
      });
      slides[i] = { ...slides[i], img: results[0], refs: await refsToThumbs(refs, Math.min(refs.length, 8)) };
      anchor ??= results[0];
      prev = results[0];
      upd(id, { slides: [...slides] });
      useUi.getState().addGallery({ kind: "image", src: results[0], prompt: enriched, model: imgCard.model, nodeId: id });
      collectToLibrary("image", [results[0]], {
        prompt: `${analysis.product.name || "电商长图"} · 切片 ${i + 1} · ${slides[i].title}`,
        model: imgCard.name,
        nodeId: id,
        group: { groupId, groupLabel, groupKind: "ecom", groupSlot: `slice:${i}` },
      });
    }

    // 默认不再自动拼接：只写切片，长图由工作台「拼接」按钮显式触发（见 stitchEcomResult）
    upd(id, { status: "done", slides, result: undefined, progress: undefined });
    notifyDone("切片生成");
  } catch (e) {
    if (isAbortError(e)) {
      upd(id, { status: "idle", error: undefined, progress: undefined });
      return;
    }
    upd(id, { status: "error", error: errMsg(e), progress: undefined });
    pushError("电商长图", errMsg(e));
  }
}

/** 电商长图主入口（runFlow / 全部运行 用）：没规划过就先规划；规划过就生成。
 *  outMode=prompt 时只规划不生成（先审脚本）。 */
export async function runEcomImage(id: string) {
  const data = ecomData(id);
  if (!data || data.status === "running") return;
  if (!data.analysis || !data.slides?.length) return analyzeEcom(id);
  if (data.outMode === "prompt") return; // 提示词模式：只规划
  return generateEcom(id);
}

/** 工作台：调整切片顺序（from→to），同步更新拼接顺序；有图则重新拼接长图 */
export async function reorderEcomSlides(id: string, from: number, to: number) {
  const data = ecomData(id);
  if (!data || data.status === "running") return;
  const slides = data.slides ?? [];
  if (from === to || from < 0 || to < 0 || from >= slides.length || to >= slides.length) return;
  const next = [...slides];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  // 调序后旧长图与新顺序不一致：清掉 result（默认不自动重拼，需手动点「拼接」）
  upd(id, { slides: next, result: undefined });
}

/** 工作台「拼接」按钮：把当前 slides[].img 纵向拼成完整长图，写 data.result（供下游节点 + 保存长图）。
 *  默认不拼接：generate/regen/reorder 都只产切片不写 result，只有本函数写。 */
export async function stitchEcomResult(id: string) {
  const data = ecomData(id);
  if (!data || data.status === "running") return;
  const slides = data.slides ?? [];
  const imgs = slides.map((s) => s.img).filter((x): x is string => !!x);
  if (!imgs.length) {
    toast("还没有切片图，先「生成长图」", "err");
    return;
  }
  upd(id, { status: "running", error: undefined, progress: "拼接长图中…" });
  try {
    let modelName = "未知模型";
    try {
      modelName = resolveModelCard("image", data.imageModelId).name;
    } catch {
      /* 拼接是纯本地 canvas 操作，不依赖模型；仅在元数据里回落占位名 */
    }
    const longImg = await stitchVertical(imgs, { width: "min", gap: 0, capHeight: 8192 });
    const name = data.analysis?.product.name ?? "电商长图";
    const groupId = data.assetGroupId ?? `ecom-${uid(12)}`;
    const groupLabel = `${name} · ${imgs.length} 片`;
    upd(id, { status: "done", result: longImg.dataUrl, progress: undefined, assetGroupId: groupId });
    pushHistory(id, {
      prompt: `${name} · ${imgs.length} 片拼接`,
      params: { aspect: data.aspect, n: imgs.length },
      results: [longImg.dataUrl],
    });
    // 兼容升级前已生成但尚未分组的切片：第一次拼接时补收录全部切片。
    if (!data.assetGroupId) {
      imgs.forEach((src, index) => collectToLibrary("image", [src], {
        prompt: `${name} · 切片 ${index + 1}`,
        model: modelName,
        nodeId: id,
        group: { groupId, groupLabel, groupKind: "ecom", groupSlot: `slice:${index}` },
      }));
    }
    collectToLibrary("image", [longImg.dataUrl], {
      prompt: `${name} · ${imgs.length} 片拼接`,
      model: modelName,
      nodeId: id,
      group: { groupId, groupLabel, groupKind: "ecom", groupSlot: "final", groupCover: true },
    });
    void maybeAutoSave([longImg.dataUrl], { prompt: name, model: modelName });
    notifyDone("长图拼接");
  } catch (e) {
    if (isAbortError(e)) {
      upd(id, { status: "idle", error: undefined, progress: undefined });
      return;
    }
    upd(id, { status: "error", error: errMsg(e), progress: undefined });
    pushError("电商长图 · 拼接", errMsg(e));
  }
}

/** 单独重新生成某一片（工作台面板用）；默认不再自动拼接，需到工作台点「拼接」 */
export async function regenEcomSlide(id: string, index: number) {
  const data = ecomData(id);
  if (!data || data.status === "running") return;
  const slides = data.slides ?? [];
  const slide = slides[index];
  if (!slide) {
    toast("该切片不存在", "err");
    return;
  }
  const { images } = collectUpstream(id);
  const mode = data.mode ?? "product";
  const productImg = images[0];
  let maxRef = 8;
  try {
    maxRef = familyMaxRef(imageFamily(resolveModelCard("image", data.imageModelId)));
  } catch {
    /* 无可用绘画模型时回落 */
  }
  upd(id, { status: "running", error: undefined, progress: `重新生成切片 ${index + 1}…` });
  try {
    const imgCard = resolveModelCard("image", data.imageModelId);
    const anchor = slides.find((s) => s.img)?.img;
    const prev = index > 0 ? slides[index - 1]?.img : undefined;
    const refs = ecomRefs({ atRefs: atRefsFromPrompt(slide.prompt, id), prev, anchor, productImg, mode, max: maxRef });
    const enriched = ecomEnriched({ ...slide, prompt: ecomResolvePrompt(slide.prompt, refs, id) }, data.analysis?.product, refs.length > 0);
    const results = await generateImage(imgCard, {
      prompt: enriched,
      n: 1,
      refImages: refs.length ? refs : undefined,
      aspect: data.aspect && data.aspect !== "auto" ? data.aspect : undefined,
      resolution: data.resolution,
      quality: data.quality,
      seed: data.seed,
      signal: taskSignal(id),
    });
    slides[index] = { ...slide, img: results[0], refs: await refsToThumbs(refs, Math.min(refs.length, 8)) };
    const groupId = data.assetGroupId ?? `ecom-${uid(12)}`;
    const groupLabel = `${data.analysis?.product.name || "电商长图"} · ${slides.length} 片`;
    upd(id, { slides: [...slides], assetGroupId: groupId });
    useUi.getState().addGallery({ kind: "image", src: results[0], prompt: enriched, model: imgCard.model, nodeId: id });
    collectToLibrary("image", [results[0]], {
      prompt: `${data.analysis?.product.name || "电商长图"} · 切片 ${index + 1} · ${slide.title}`,
      model: imgCard.name,
      nodeId: id,
      group: { groupId, groupLabel, groupKind: "ecom", groupSlot: `slice:${index}` },
    });

    // 重生后旧长图与该片不一致：清掉 result（默认不自动重拼，需手动点「拼接」）
    upd(id, { status: "done", progress: undefined, result: undefined });
    notifyDone("切片生成");
  } catch (e) {
    if (isAbortError(e)) {
      upd(id, { status: "idle", error: undefined, progress: undefined });
      return;
    }
    upd(id, { status: "error", error: errMsg(e), progress: undefined });
    pushError("电商长图", errMsg(e));
  }
}

/* ---------- 分镜 ---------- */

const STORY_REFINE_SYSTEM =
  "你是资深编剧兼美术指导。把用户给出的故事/梗概完善成结构完整、画面感强的短片故事（补全起承转合与视觉细节，保持原设定，中文进中文出；长剧本先按情节分小节整理再连贯改写），并为全片提炼一行「风格与定调」词（画风/色调/光线/质感，如：日系动画，暖黄胶片色调，柔和逆光）。" +
  '只输出 JSON：{"story":"完善后的故事正文","styleTone":"风格与定调一行"}';

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
    const out = await chatOnce(card, STORY_REFINE_SYSTEM, story.slice(0, 24000));
    const j = parseJsonLoose(out) as { story?: string; styleTone?: string } | null;
    const refined = (j?.story ?? out).trim();
    // 自动定调：用户没手填风格时，把提炼出的风格定调填进去（手填的不覆盖）
    const style = (data.style ?? "").trim() || (j?.styleTone ?? "").trim();
    upd(id, { status: "idle", refined, style, progress: undefined });
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
      '{"shots":[{"time":"0-5秒","prompt":"画面提示词","line":"角色名：台词（该镜无对白则省略此字段）"}]}';
    const ask = [
      `故事（若很长请先在心里分小节整理，再均衡分配到各镜）：
${story.slice(0, 24000)}`,
      `
要求：`,
      `1. 恰好拆成 ${count} 个分镜，每镜时长 ${sec} 秒，time 字段按累计时间标注（如 "0-${sec}秒"、"${sec}-${sec * 2}秒"…）`,
      `2. 每条 prompt 是一段可直接发给 AI 生图/生视频的中文提示词：包含镜头景别/构图/光线/动作，主体外观在各镜间保持一致`,
      [data.style, data.tone].filter((x) => x?.trim()).length
        ? `3. 全片风格与定调（织入每条 prompt 开头，保持全片统一）：${[data.style, data.tone].filter((x) => x?.trim()).join("，")}`
        : "",
      `4. 有对白的镜头输出 line 字段（"角色名：台词"），没有就省略；台词要短、口语化`,
      `5. 分镜之间画面要能衔接（上一镜结尾与下一镜开头呼应），主角外观全片一致`,
    ].filter(Boolean).join("\n");
    const out = await chatOnce(card, system, ask);
    const j = parseJsonLoose(out) as { shots?: { time?: string; prompt?: string; line?: string }[] } | null;
    const shots = (j?.shots ?? [])
      .filter((x) => (x?.prompt ?? "").trim())
      .map((x, i) => ({
        time: (x.time ?? `${i * sec}-${(i + 1) * sec}秒`).trim(),
        prompt: x.prompt!.trim(),
        line: (x as { line?: string }).line?.trim() || undefined,
      }));
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
  // 分镜节点上游接入的图片（角色卡/角色图）同步连给每个生成节点 → 全片角色/风格一致
  const refEdges = s.edges.filter((ed) => ed.target === id && srcOutType(ed, s.nodes) === "image");
  data.shots.forEach((_, i) => {
    const bs = useBoard.getState();
    const nid = bs.addNode(kind, { x: baseX, y: baseY + i * (kind === "videoGen" ? 300 : 330) });
    bs.connectNodes(id, nid, "in", `shot-${i}`);
    for (const re of refEdges) bs.connectNodes(re.source, nid, "in", re.sourceHandle ?? "out");
  });
  toast(
    `已按 ${data.shots.length} 个分镜铺好${kind === "videoGen" ? "生成视频" : "生成图像"}节点${refEdges.length ? "（角色参考图已连给每一镜）" : ""}`,
    "ok",
  );
}

/* ---------- 生成音频（TTS / 音乐） ---------- */
export async function runAudioGen(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as AudioGenData;
  if (data.status === "running") return;
  const text = (data.text ?? "").trim() || collectUpstream(id).texts.join("\n");
  if (!text) {
    toast("请输入朗读文本/音乐描述，或连接上游文本节点（分镜台词也可以）", "err");
    return;
  }
  upd(id, { status: "running", error: undefined, progress: "合成中…", resultUrl: undefined });
  let primaryCard: ModelCard | null = null;
  const t0 = Date.now();
  try {
    const card = resolveModelCard("audio", data.modelId);
    primaryCard = card;
    // 预算护栏（音频按文本长度粗估秒数）
    const gate = budgetGate(estimateCost(card.model, { audioSec: Math.max(1, Math.round(text.length / 5)) }));
    if (gate.block) throw new Error(gate.block);
    if (gate.confirm && !window.confirm(gate.confirm)) {
      upd(id, { status: "idle", error: undefined, progress: undefined });
      return;
    }
    // 主模型瞬时重试 → 备用模型（音频 TTS 直链常因签名过期/限流失败）
    const { result: url, card: usedCard, usedFallback } = await runGenWithFallback("audio", card, taskSignal(id), (c) =>
      generateAudio(c, {
        text,
        voice: data.voice,
        signal: taskSignal(id),
        onProgress: (m) => upd(id, { progress: m }),
      }),
    );
    if (usedFallback) {
      upd(id, { fallbackModel: usedCard.name });
      toast(`主模型失败，已由备用模型「${usedCard.name}」生成`, "info");
    } else {
      upd(id, { fallbackModel: undefined });
    }
    upd(id, { status: "done", resultUrl: url, progress: undefined });
    // 收进资产库并换持久地址（dataURL 大、远程直链会过期）
    const saved = await useAssets.getState().collect({
      src: url, kind: "audio", prompt: text.slice(0, 80), model: usedCard.name, nodeId: id,
    });
    if (saved && isTauri) upd(id, { resultUrl: assetUrl(saved.path) });
    useUsage.getState().record(usedCard, { ok: true, audioSec: Math.max(1, Math.round(text.length / 5)), durMs: Date.now() - t0 });
    notifyDone("音频生成");
  } catch (e) {
    if (isAbortError(e)) {
      upd(id, { status: "idle", error: undefined, progress: undefined });
      toast("已停止", "info");
      return;
    }
    if (primaryCard) useUsage.getState().record(primaryCard, { ok: false, durMs: Date.now() - t0 });
    upd(id, { status: "error", error: errMsg(e), progress: undefined });
    pushError("生成音频", errMsg(e));
  }
}

/* ---------- 视频配音（本地混音重编码） ---------- */
export async function runVideoDub(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as VideoDubData;
  if (data.status === "running") return;
  const { videos, audios } = collectUpstream(id);
  if (!videos.length) {
    toast("请先连接上游视频", "err");
    return;
  }
  if (!audios.length) {
    toast("请先连接上游音频（音频节点或生成音频）", "err");
    return;
  }
  upd(id, { status: "running", error: undefined, progress: "准备重编码…", resultUrl: undefined });
  try {
    const url = await dubVideo(videos[0], audios[0], data.mode ?? "replace", (m) => upd(id, { progress: m }));
    upd(id, { status: "done", resultUrl: url, progress: undefined });
    const saved = await useAssets.getState().collect({ src: url, kind: "video", name: "视频配音", model: "本地处理" });
    if (saved && isTauri) upd(id, { resultUrl: assetUrl(saved.path) });
    notifyDone("视频配音");
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e), progress: undefined });
    pushError("视频配音", errMsg(e));
  }
}

/* ---------- 工作流链式运行 ---------- */

/**
 * 统一闸门：注册停止通道（节点/标题栏可随时停）+ 占全局并发额度。
 * runAllFlows 按连通分量并行、批量出图一次克隆十几个节点——不限流会对中转站打出 429 雪崩。
 */
const gated = (kind: NodeKind, fn: (id: string) => Promise<void>) => async (id: string) => {
  // 已在运行中的节点由各 runner 自行短路，不重复注册/占额度
  const cur = useBoard.getState().nodes.find((n) => n.id === id);
  if ((cur?.data as Record<string, unknown> | undefined)?.status === "running") return fn(id);
  const signal = beginTask(id, kind);
  try {
    const release = await acquireSlot(signal);
    try {
      await fn(id);
      // 成功收尾：盖「本次实际走过的上游签名」+ bumpRev，让下游脏标记感知到本节点内容已更新
      // （上游重算 → 上游 bumpRev → 本节点 upstreamSig 变 → 本节点重算 → 本节点 bumpRev → 逐级传递）
      useBoard.getState().updateData(id, { inputSig: sigOf(id) }, { bumpRev: true });
    } finally {
      release();
    }
  } catch (e) {
    if (!isAbortError(e)) throw e; // 排队中被取消 → 静默返回（节点还没开始跑）
  } finally {
    endTask(id);
  }
};

/** 可主动运行的节点类型 → 运行函数（对话节点需要用户输入，不参与自动链） */
const RUNNERS: Partial<Record<NodeKind, (id: string) => Promise<void>>> = {
  imageGen: gated("imageGen", runImageGen),
  videoGen: gated("videoGen", runVideoGen),
  comfy: gated("comfy", runComfy),
  llmText: gated("llmText", runLlmText),
  relight: gated("relight", runRelight),
  multiAngle: gated("multiAngle", runMultiAngle),
  charCard: gated("charCard", runCharCard),
  ecomImage: gated("ecomImage", runEcomImage),
  storyboard: gated("storyboard", runStoryboard),
  audioGen: gated("audioGen", runAudioGen),
  videoDub: gated("videoDub", runVideoDub),
  enhanceLocal: gated("enhanceLocal", runEnhanceLocal),
  vectorize: gated("vectorize", runVectorize),
};

/**
 * 可自动运行的节点类型 —— UI 判断「能否运行/显示运行按钮」的唯一来源。
 * ⚠ 勿再手抄第二张表（曾经 UI 与引擎各一份：ecomImage 漏掉、combine 多出，两处漂移出 bug）。
 * 新增可运行节点 = 往 RUNNERS 加一行，UI 自动跟上。
 */
export const RUNNABLE_KINDS = Object.keys(RUNNERS) as NodeKind[];

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
  // 脏标记：记录的上游签名与当前不一致 → 上游已变更，必须重算。
  // 老数据无 inputSig（升级前）视为新鲜，避免打开旧画布触发全量重算
  if (d.inputSig !== undefined && d.inputSig !== sigOf(n.id)) return false;
  switch (n.type as NodeKind) {
    case "llmText":
      return !!(d.result as string | undefined)?.trim();
    case "imageGen":
    case "comfy":
      return !!(d.results as string[] | undefined)?.length;
    case "enhanceLocal":
    case "vectorize":
      return !!(d.result as string | undefined);
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
    case "videoDub":
    case "audioGen":
      return !!d.resultUrl;
    case "storyboard":
      return !!(d.shots as unknown[] | undefined)?.length;
    default:
      return false;
  }
}

/** 依次运行一串节点；某个节点出错则停止后续。force = 已有结果的也重算 */
async function runSequence(ids: string[], opts: { clickedId?: string; force?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  for (const nid of ids) {
    opts.signal?.throwIfAborted();
    const n = useBoard.getState().nodes.find((x) => x.id === nid);
    if (!n) continue;
    const run = RUNNERS[n.type as NodeKind];
    if (!run) continue;
    // 上游已经算过且有结果 → 直接用现成的（点击的目标节点本身总是重新跑）
    if (!opts.force && nid !== opts.clickedId && hasFreshOutput(n)) continue;
    const stop=()=>{abortNode(nid);};
    opts.signal?.addEventListener("abort",stop,{once:true});
    try { await run(nid); } finally {opts.signal?.removeEventListener("abort",stop);}
    opts.signal?.throwIfAborted();
    const after = useBoard.getState().nodes.find((x) => x.id === nid);
    const st = (after?.data as Record<string, unknown> | undefined)?.status;
    if (st !== "done" && st !== "running") {
      if (nid !== opts.clickedId) toast("上游节点运行失败，工作流后续节点已停止", "err");
      return;
    }
    // 该节点已在别处运行中（runner 内部短路直接返回）：此时它还没有输出，
    // 继续往下跑只会让下游拿着空上游生成，直接停机等它跑完
    if (st === "running" && nid !== opts.clickedId) {
      toast("上游节点仍在运行，已暂停后续节点——等它出结果后再点一次运行", "err");
      return;
    }
  }
}

/** 点击节点运行：上游按依赖顺序补齐（已有结果的直接复用），再跑自己 */
export async function runFlow(id: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
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
  await runSequence(order, { clickedId: id, signal });
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

  // 一键全跑是最烧钱的操作（force 全量重算）：先把账单摊开确认，别一句 toast 就把请求全发出去
  const all = flows.flat();
  const typeOf = (nid: string) => nodes.find((n) => n.id === nid)?.type as NodeKind | undefined;
  const imgN = all.filter((nid) => ["imageGen", "comfy", "relight", "multiAngle", "charCard"].includes(typeOf(nid) ?? "")).length;
  const vidN = all.filter((nid) => typeOf(nid) === "videoGen").length;
  const audN = all.filter((nid) => typeOf(nid) === "audioGen").length;
  if (imgN + vidN + audN > 0) {
    // 批量费用预估：按每个生成节点的参数与模型单价汇总（ComfyUI 等无法预估的项不计入，消息里明说）
    const total = all.reduce((s, nid) => s + estimateNodeCost(nid, nodes), 0);
    const money = total > 0 ? `\n预估费用：约 ¥${total.toFixed(2)}（未含 ComfyUI 等无法预估项）` : "";
    const msg = `将从头重算 ${all.length} 个节点（生图类 ${imgN} · 视频 ${vidN} · 音频 ${audN}），生成类请求会计费。${money}\n确定全部运行？`;
    let go: boolean;
    if (isTauri) {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      go = await ask(msg, { title: "一键运行全部", kind: "warning" });
    } else {
      go = window.confirm(msg);
    }
    if (!go) return;
  }

  toast(`开始运行 ${flows.length} 条工作流（共 ${all.length} 个节点，全部从头重算）`, "info");
  await Promise.all(flows.map((f) => runSequence(f, { force: true })));
  toast("全部工作流运行结束", "ok");
  notifyDone("全部工作流");
}
