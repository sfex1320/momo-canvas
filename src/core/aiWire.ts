/**
 * AI 布线助手 — 用一句话生成节点工作流：
 *  意图 → 对话模型产出 JSON 方案 → 本地校验（类型/端口/成环）→ 预览确认 → 实例化落画布
 * 设计原则（Krea Node Agent / Flora Fauna 的共识）：AI 只出「方案」，落画布前用户可见可拒绝，
 * 落下后全部是普通节点，可继续手工调整 —— 不做黑箱。
 */
import type { Edge } from "@xyflow/react";
import type { AppNode, NodeKind, PortType } from "./types";
import { defaultData, edgeClassFor, NODE_INPUTS, NODE_LABEL, outPortType, useBoard } from "./stores/boardStore";
import { resolveModelCard } from "./stores/settingsStore";
import { chatOnce } from "./services/llm";
import { parseJsonLoose, uid } from "./utils";

/** 允许 AI 编排的节点类型（局部重绘/聚焦需要手动画蒙版、ComfyUI 依赖本地模板，不参与自动布线） */
const WIRABLE: NodeKind[] = [
  "image",
  "video",
  "audio",
  "audioGen",
  "videoDub",
  "prompt",
  "stylePreset",
  "note",
  "caption",
  "llmText",
  "combine",
  "storyboard",
  "imageGen",
  "videoGen",
  "frame",
  "videoTrim",
  "videoConcat",
  "outpaint",
  "matting",
  "enhance",
  "resize",
  "relight",
  "multiAngle",
  "charCard",
];

/** 每种节点允许 AI 预填的字段（白名单，其余一律丢弃） */
const DATA_WHITELIST: Partial<Record<NodeKind, string[]>> = {
  prompt: ["text"],
  note: ["text"],
  imageGen: ["prompt", "count"],
  videoGen: ["prompt"],
  llmText: ["op", "custom"],
  caption: ["mode"],
  matting: ["subject", "bg"],
  enhance: ["factor", "focus"],
  combine: ["separator", "extra"],
  storyboard: ["story", "count", "shotSec", "style"],
  frame: ["point", "timeSec"],
  videoTrim: ["start", "end"],
  audioGen: ["text", "voice"],
  videoDub: ["mode"],
};

export type WirePlan = {
  /** 方案总述（给用户看的） */
  summary: string;
  nodes: { ref: string; kind: NodeKind; note: string; data: Record<string, unknown> }[];
  edges: { from: string; to: string; port: PortType }[];
};

const SYSTEM = `你是 MOMO 智能画布的工作流规划师。用户描述创作意图，你输出一个节点工作流方案（JSON）。

可用节点类型（kind）：
- image 图片（用户稍后自己导入图片，不能预填内容）
- video 视频（用户稍后自己导入本地视频，不能预填内容）
- audio 音频（用户稍后自己导入本地音频，不能预填内容）
- prompt 提示词（data.text 预填提示词）
- stylePreset 风格预设（用户自己点选风格，不能预填）
- note 备注（data.text 说明文字）
- caption 反推描述：上游图片→提示词（data.mode: "prompt"|"detail"|"tags"）
- llmText 文本处理：上游文本→LLM加工（data.op: "optimize"|"zh2en"|"expand"|"shorten"|"custom"；op=custom 时 data.custom 填加工指令）
- combine 拼接文本：多路上游文本合并
- storyboard 分镜：故事→完善→拆 N 镜逐镜提示词（data.story 故事；data.count 分镜数 2-24；data.shotSec 每镜秒数；data.style 风格定调）
- imageGen 生成图像（data.prompt 可留空=自动用上游文本；data.count 张数1-4）
- videoGen 生成视频（data.prompt 可留空=自动用上游文本；第 1 路上游图=首帧）
- frame 视频取帧：上游视频→抽一帧图片（data.point: "first"|"last"|"custom"，custom 配 data.timeSec；末帧接下一段视频可无限续接）
- videoTrim 视频取段：本地截取片段（data.start/data.end 秒）
- videoConcat 视频拼接：多路上游视频按顺序合成一条成片（自带时间线粗剪）
- audioGen 生成音频：TTS 朗读/音乐（data.text 文本留空=自动用上游文本；data.voice 音色）
- videoDub 视频配音：上游视频+音频本地混音（data.mode: "replace"|"mix"）
- outpaint 扩图（上游需图片）
- matting 抠图（data.subject 主体描述；data.bg: "transparent"|"white"|"green"|"black"）
- enhance 高清增强（data.factor: 2|4；data.focus: "detail"|"face"|"none"）
- resize 尺寸调整（上游需图片）
- relight 打光（上游需图片）
- multiAngle 多角度（上游需图片）
- charCard 角色卡（上游接人物图片或文字描述，产出三视图/表情/立绘/设定卡）

连线规则：
- 端口分 text（文本）、image（图片）、video（视频）、audio（音频）四类，只能同类相连。
- 各节点输出类型：prompt/caption/llmText/combine/stylePreset/storyboard→text；image/imageGen/outpaint/matting/enhance/resize/relight/multiAngle/charCard/frame→image；video/videoGen/videoTrim/videoConcat/videoDub→video；audio/audioGen→audio；note 无输出。
- 各节点可接收：imageGen/relight/multiAngle/charCard/storyboard/outpaint 可接 text+image；videoGen 可接 text+image+video+audio；caption/matting/enhance/resize 只接 image；llmText/combine/audioGen 只接 text；frame/videoTrim/videoConcat 只接 video；videoDub 接 video+audio；image/video/audio/prompt/stylePreset/note 无输入。
- 生成图像的提示词留空时会自动使用上游文本；接了上游图片会自动转图生图。
- 典型视频链：storyboard→videoGen（多个）→videoConcat 成片；videoGen→frame（末帧）→下一个 videoGen 首帧实现续接；audioGen→videoDub 给成片配音。
- 不允许成环。

只输出 JSON（不要代码块围栏、不要多余文字），格式：
{"summary":"一句话概括方案","nodes":[{"ref":"n1","kind":"prompt","note":"这个节点的作用","data":{"text":"..."}}],"edges":[{"from":"n1","to":"n2","port":"text"}]}
ref 用 n1/n2/n3… 简短编号。节点数量按需要来（一般 2-8 个），方案要能直接跑通、贴合用户意图。`;

/** 请求对话模型生成布线方案，并做本地强校验；问题多时抛中文错误 */
export async function buildWirePlan(intent: string): Promise<WirePlan> {
  const card = resolveModelCard("chat");
  const text = await chatOnce(card, SYSTEM, intent);
  const raw = parseJsonLoose<{
    summary?: string;
    nodes?: { ref?: string; kind?: string; note?: string; data?: Record<string, unknown> }[];
    edges?: { from?: string; to?: string; port?: string }[];
  }>(text);
  if (!raw?.nodes?.length) throw new Error("模型没有返回有效的工作流方案，请换个说法或换个对话模型再试");

  const nodes: WirePlan["nodes"] = [];
  const seen = new Set<string>();
  for (const n of raw.nodes) {
    const kind = n.kind as NodeKind;
    if (!n.ref || seen.has(n.ref) || !WIRABLE.includes(kind)) continue;
    seen.add(n.ref);
    const allow = DATA_WHITELIST[kind] ?? [];
    const data: Record<string, unknown> = {};
    for (const k of allow) {
      const v = n.data?.[k];
      if (v !== undefined && (typeof v === "string" || typeof v === "number")) data[k] = v;
    }
    nodes.push({ ref: n.ref, kind, note: (n.note ?? "").slice(0, 60), data });
  }
  if (!nodes.length) throw new Error("方案里没有可用的节点类型，请重试");

  const byRef = new Map(nodes.map((n) => [n.ref, n]));
  const edges: WirePlan["edges"] = [];
  for (const e of raw.edges ?? []) {
    const from = e.from ? byRef.get(e.from) : undefined;
    const to = e.to ? byRef.get(e.to) : undefined;
    if (!from || !to || from === to) continue;
    // 端口按上游实际输出类型定（模型给的 port 仅作参考）
    const pt = outPortType(from.kind, defaultData(from.kind));
    if (!pt) continue;
    const ins = NODE_INPUTS[to.kind];
    if (!(pt === "text" ? ins.text : pt === "video" ? ins.video : pt === "audio" ? ins.audio : ins.image)) continue;
    if (edges.some((x) => x.from === from.ref && x.to === to.ref)) continue;
    edges.push({ from: from.ref, to: to.ref, port: pt });
  }
  // 防环：沿 edges 做拓扑检查，有环则丢弃回边
  const safe: WirePlan["edges"] = [];
  const reaches = (a: string, b: string): boolean => {
    const stack = [b];
    const vis = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === a) return true;
      if (vis.has(cur)) continue;
      vis.add(cur);
      for (const x of safe) if (x.from === cur) stack.push(x.to);
    }
    return false;
  };
  for (const e of edges) if (!reaches(e.from, e.to)) safe.push(e);

  return { summary: (raw.summary ?? "").slice(0, 120) || "AI 生成的工作流方案", nodes, edges: safe };
}

/** 方案实例化：拓扑分层布局（上游在左），整体落到 at 位置并选中 */
export function applyWirePlan(plan: WirePlan, at: { x: number; y: number }) {
  // Kahn 分层
  const layer = new Map<string, number>();
  for (const n of plan.nodes) layer.set(n.ref, 0);
  for (let pass = 0; pass < plan.nodes.length; pass++) {
    let changed = false;
    for (const e of plan.edges) {
      const want = (layer.get(e.from) ?? 0) + 1;
      if ((layer.get(e.to) ?? 0) < want) {
        layer.set(e.to, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const perLayerIdx = new Map<number, number>();
  const refToId = new Map<string, string>();
  const nodes: AppNode[] = plan.nodes.map((pn) => {
    const L = layer.get(pn.ref) ?? 0;
    const idx = perLayerIdx.get(L) ?? 0;
    perLayerIdx.set(L, idx + 1);
    const id = `n_${uid(8)}`;
    refToId.set(pn.ref, id);
    return {
      id,
      type: pn.kind,
      position: { x: at.x + L * 380, y: at.y + idx * 300 },
      data: { ...defaultData(pn.kind), ...pn.data },
      selected: true,
    };
  });
  const edges: Edge[] = plan.edges.map((e) => ({
    id: `e_${uid(8)}`,
    source: refToId.get(e.from)!,
    target: refToId.get(e.to)!,
    sourceHandle: "out",
    targetHandle: e.port === "image" ? "in-image" : e.port === "video" ? "in-video" : e.port === "audio" ? "in-audio" : "in-text",
    className: edgeClassFor(e.port),
    interactionWidth: 28,
  }));
  useBoard.getState().insertFragment(nodes, edges);
}

export function wireNodeLabel(kind: NodeKind): string {
  return NODE_LABEL[kind] ?? kind;
}
