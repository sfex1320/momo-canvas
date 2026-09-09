/**
 * ComfyUI 服务 — HTTP REST 直连
 *  探活 /system_stats · 提交 /prompt · 轮询 /history/{id} · 取图 /view · 传图 /upload/image
 *  进度：/ws WebSocket 实时节点级进度（连不上时静默退回轮询文案）
 */
import type { ComfyExposedParam, ComfyParamKind, ComfyTemplate, ComfyVariant, ComfyWfNode } from "../types";
import { xfetch, trimBase, readErrorBody } from "./http";
import { dataUrlToBlob, toDataUrl, uid } from "../utils";
import { zhNode } from "../../modules/comfy/wfGraph";

export function normalizeHost(host: string): string {
  let h = host.trim();
  if (!h) return "";
  if (!/^https?:\/\//i.test(h)) h = `http://${h}`;
  return trimBase(h);
}

export async function pingComfy(host: string): Promise<{ ok: boolean; info?: string; err?: string }> {
  try {
    const resp = await xfetch(`${normalizeHost(host)}/system_stats`);
    if (!resp.ok) return { ok: false, err: `HTTP ${resp.status}` };
    const j = await resp.json();
    const dev = j.devices?.[0];
    return { ok: true, info: dev ? `${dev.name ?? ""}`.trim() : "已连接" };
  } catch (e) {
    // 把底层真实原因带出去（权限拦截 / 拒绝连接 / 超时……），别只说"连不上"
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

/** 采样 ComfyUI 空闲显存/内存（/system_stats，多卡显存求和）；读不到返回 null，不阻塞清理流程 */
async function sampleFree(host: string): Promise<{ vram: number; ram: number } | null> {
  try {
    const r = await xfetch(`${normalizeHost(host)}/system_stats`, { method: "GET" });
    if (!r.ok) return null;
    const j = (await r.json()) as { system?: { ram_free?: number }; devices?: { vram_free?: number }[] };
    if (!j?.system || !Array.isArray(j.devices)) return null;
    return { vram: j.devices.reduce((n, d) => n + (d.vram_free ?? 0), 0), ram: j.system.ram_free ?? 0 };
  } catch {
    return null;
  }
}

/** 清理结果文案：有采样数据带释放量，没有就一句话 */
export function freeResultText(r: Awaited<ReturnType<typeof freeComfyMemory>>): string {
  if (!r.ok) return `清理失败${r.err ? `：${r.err}` : ""}`;
  const parts: string[] = [];
  if (r.vramFreedMB !== undefined) parts.push(`显存 ${(r.vramFreedMB / 1024).toFixed(1)} GB`);
  if (r.ramFreedMB !== undefined) parts.push(`内存 ${(r.ramFreedMB / 1024).toFixed(1)} GB`);
  return parts.length ? `已释放 ${parts.join(" · ")} ✓` : "已清理 ComfyUI 显存与内存 ✓";
}

/** 清理 ComfyUI 显存与内存：卸载模型 + 释放缓存（/free 的 unload_models + free_memory 双参数），
 *  前后各采样一次 /system_stats 报告释放量（采样失败不影响清理结果）；大工作流连跑多段时防显存堆积，代价是下次运行重新加载模型 */
export async function freeComfyMemory(
  host: string,
): Promise<{ ok: boolean; err?: string; vramFreedMB?: number; ramFreedMB?: number }> {
  if (!normalizeHost(host)) return { ok: false, err: "未配置 ComfyUI 地址" };
  const before = await sampleFree(host);
  try {
    const resp = await xfetch(`${normalizeHost(host)}/free`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    });
    if (!resp.ok) return { ok: false, err: `HTTP ${resp.status}: ${await readErrorBody(resp)}` };
    // 内存归还给系统有延迟，稍等再采样
    await new Promise((res) => setTimeout(res, 400));
    const after = await sampleFree(host);
    if (!before || !after) return { ok: true };
    return {
      ok: true,
      vramFreedMB: Math.max(0, Math.round((after.vram - before.vram) / 1048576)),
      ramFreedMB: Math.max(0, Math.round((after.ram - before.ram) / 1048576)),
    };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

/** 强制停止 ComfyUI：中断当前执行（/interrupt）+ 清空排队任务（/queue clear，防止中断后下一个立刻顶上）。
 *  导演台「停止」按钮用；尽力而为，失败只返回 err 不抛异常 */
export async function interruptComfy(host: string): Promise<{ ok: boolean; err?: string }> {
  if (!normalizeHost(host)) return { ok: false, err: "未配置 ComfyUI 地址" };
  try {
    const resp = await xfetch(`${normalizeHost(host)}/interrupt`, { method: "POST" });
    if (!resp.ok) return { ok: false, err: `HTTP ${resp.status}: ${await readErrorBody(resp)}` };
    await xfetch(`${normalizeHost(host)}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clear: true }),
    }).catch(() => {});
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

/* ---------------- 工作流解析 ---------------- */

export function isApiWorkflow(json: unknown): json is Record<string, ComfyWfNode> {
  if (!json || typeof json !== "object" || Array.isArray(json)) return false;
  const entries = Object.entries(json as Record<string, unknown>);
  if (!entries.length) return false;
  return entries.every(
    ([, v]) => !!v && typeof v === "object" && typeof (v as any).class_type === "string" && typeof (v as any).inputs === "object",
  );
}

const isConnection = (v: unknown): v is [string, number] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === "string";

export const isImageLoaderClass = (ct: string) => /loadimage/i.test(ct);

/** imageSlotMap 的哨兵值：明确「这个入口不喂图」（区别于 undefined = 走默认顺序分配） */
export const COMFY_SLOT_NONE = "__none__";
export const isOutputClass = (ct: string) => /saveimage|previewimage|save|preview/i.test(ct);

function guessKind(node: ComfyWfNode, input: string, value: unknown): ComfyParamKind {
  const name = input.toLowerCase();
  if (isImageLoaderClass(node.class_type) && name === "image") return "image";
  if (name.includes("seed")) return "seed";
  if (typeof value === "boolean") return "toggle";
  if (typeof value === "number") return "number";
  return "text";
}

/* ---------------- 能力识别 / 忽略节点 ---------------- */

export type WfTextEntry = { nodeId: string; input: string; negative: boolean };

export type WfCaps = {
  /** 图片入口：LoadImage 类节点 id（数字序） */
  imageEntries: string[];
  /** 提示词入口：带文本控件的节点（negative = 被接到负面条件上） */
  textEntries: WfTextEntry[];
  /** 输出候选：保存/预览类节点 */
  outputs: string[];
};

/** 识别工作流的图片/提示词入口与输出候选 */
export function analyzeCaps(wf: Record<string, ComfyWfNode>): WfCaps {
  const ids = Object.keys(wf).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  const imageEntries = ids.filter((id) => isImageLoaderClass(wf[id].class_type));
  const outputs = ids.filter((id) => isOutputClass(wf[id].class_type));

  const negativeSet = new Set<string>();
  for (const n of Object.values(wf)) {
    for (const [input, v] of Object.entries(n.inputs ?? {})) {
      if (isConnection(v) && /negative/i.test(input)) negativeSet.add(v[0]);
    }
  }

  const textEntries: WfTextEntry[] = [];
  for (const id of ids) {
    const n = wf[id];
    for (const [input, v] of Object.entries(n.inputs ?? {})) {
      if (isConnection(v) || typeof v !== "string") continue;
      const looksText =
        (n.class_type === "CLIPTextEncode" && input === "text") ||
        ["text", "prompt", "caption", "positive_prompt", "negative_prompt"].includes(input.toLowerCase());
      if (!looksText) continue;
      const negative =
        negativeSet.has(id) || /negative|负面/i.test(n._meta?.title ?? "") || /negative/i.test(input);
      textEntries.push({ nodeId: id, input, negative });
    }
  }
  textEntries.sort((a, b) => Number(a.negative) - Number(b.negative) || Number(a.nodeId) - Number(b.nodeId));
  return { imageEntries, textEntries, outputs };
}

/* ---------------- 能力识别 v3（结合 object_info + 拓扑，自动识别全部语义入口） ---------------- */

export type WfCapsV3 = WfCaps & {
  /** 视频入口：LoadVideo / VHS 类节点 id */
  videoEntries: string[];
  /** 音频入口：LoadAudio 类节点 id */
  audioEntries: string[];
  /** APP Mode / 子图声明（部分新版 ComfyUI 工作流自带） */
  appMode?: string;
  /** 子图声明：节点 id → 所属子图名 */
  subgraphMap?: Record<string, string>;
  /** 自动推断的语义槽（直接可用于 ComfyVariant.slots） */
  autoSlots?: Array<{ semantic: string; media: string; nodeId: string; input: string; label: string; required: boolean }>;
};

/** 音频加载器类名匹配（LoadAudio / AudioLoad 等） */
export const isAudioLoaderClass = (ct: string) => /loadaudio|audioload/i.test(ct);

/**
 * 能力识别 v3（方案 §阶段0）：优先读取 APP Mode / 子图声明，
 * 再结合节点类型与拓扑自动识别图片、视频、音频、正/负提示词、首尾帧、多参考和主/辅助输出，
 * 并把识别结果映射成可直接使用的语义槽。
 *
 * @param wf 工作流
 * @param objectInfo 可选：ComfyUI /object_info 返回（有则用输入类型精确判定 media）
 */
export function analyzeCapsV3(
  wf: Record<string, ComfyWfNode>,
  objectInfo?: Record<string, any> | null,
): WfCapsV3 {
  const ids = Object.keys(wf).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  const base = analyzeCaps(wf);

  // 1. 读取 APP Mode / 子图声明（部分工作流的根节点或 extra 字段里有）
  let appMode: string | undefined;
  const subgraphMap: Record<string, string> = {};
  for (const [id, node] of Object.entries(wf)) {
    // APP Mode 声明（部分工作流的 _meta 或 inputs 里带 app_mode）
    const am = (node as any)?._meta?.app_mode ?? (node as any)?.inputs?.app_mode;
    if (typeof am === "string" && !appMode) appMode = am;
    // 子图声明（_meta.subgraph 或 inputs.subgraph_name）
    const sg = (node as any)?._meta?.subgraph ?? (node as any)?.inputs?.subgraph_name;
    if (typeof sg === "string") subgraphMap[id] = sg;
  }

  // 2. 视频 / 音频入口
  const videoEntries = ids.filter((id) => isVideoLoaderClass(wf[id].class_type));
  const audioEntries = ids.filter((id) => isAudioLoaderClass(wf[id].class_type));

  // 3. 自动推断语义槽：把识别出的入口映射成首帧/尾帧/参考图/参考视频/参考音频/提示词
  const autoSlots: WfCapsV3["autoSlots"] = [];
  // 提示词（正面）
  const posText = base.textEntries.find((t) => !t.negative);
  if (posText) autoSlots.push({ semantic: "prompt", media: "text", nodeId: posText.nodeId, input: posText.input, label: "正面提示词", required: true });
  // 提示词（负面）
  const negText = base.textEntries.find((t) => t.negative);
  if (negText) autoSlots.push({ semantic: "negativePrompt", media: "text", nodeId: negText.nodeId, input: negText.input, label: "负面提示词", required: false });
  // 图片入口 → 首帧 / 尾帧 / 参考图（按节点 id 排序，前两个映射为首尾帧，其余为参考图）
  base.imageEntries.forEach((nid, i) => {
    if (i === 0) {
      autoSlots.push({ semantic: "firstFrame", media: "image", nodeId: nid, input: "image", label: "首帧", required: false });
    } else if (i === 1) {
      // 第二个图片入口：检查节点标题/输入名是否含 last/end → 尾帧，否则参考图
      const title = (wf[nid]._meta?.title ?? "").toLowerCase();
      const hasLast = /last|end|尾帧|末帧/.test(title) || /last_?frame|end_?frame/i.test(nid);
      autoSlots.push({
        semantic: hasLast ? "lastFrame" : "referenceImage",
        media: "image",
        nodeId: nid,
        input: "image",
        label: hasLast ? "尾帧" : `参考图 ${i}`,
        required: false,
      });
    } else {
      autoSlots.push({ semantic: "referenceImage", media: "image", nodeId: nid, input: "image", label: `参考图 ${i}`, required: false });
    }
  });
  // 视频入口 → 参考视频
  videoEntries.forEach((nid, i) => {
    autoSlots.push({ semantic: "referenceVideo", media: "video", nodeId: nid, input: "video", label: i === 0 ? "参考视频" : `参考视频 ${i + 1}`, required: false });
  });
  // 音频入口 → 参考音频
  audioEntries.forEach((nid, i) => {
    autoSlots.push({ semantic: "referenceAudio", media: "audio", nodeId: nid, input: "audio", label: i === 0 ? "参考音频" : `参考音频 ${i + 1}`, required: false });
  });

  // 4. 如果有 objectInfo，用输入类型精确修正 media（覆盖默认猜测）
  //    ComfyUI object_info 结构：{ [class_type]: { input: { required: {...}, optional: {...} } } }
  if (objectInfo) {
    for (const slot of autoSlots) {
      const oi = objectInfo[wf[slot.nodeId]?.class_type];
      if (!oi?.input) continue;
      // 输入定义在 required 或 optional 里，值为 [type, ...] 或 { type, ... }
      const inputDef = oi.input.required?.[slot.input] ?? oi.input.optional?.[slot.input];
      if (!inputDef) continue;
      const t = Array.isArray(inputDef) ? inputDef[0] : inputDef?.type;
      if (typeof t === "string") {
        if (/IMAGE/i.test(t)) slot.media = "image";
        else if (/VIDEO|VHS/i.test(t)) slot.media = "video";
        else if (/AUDIO/i.test(t)) slot.media = "audio";
        else if (/INT|FLOAT/i.test(t)) slot.media = "number";
        else if (/STRING/i.test(t)) slot.media = "text";
      }
    }
  }

  return {
    ...base,
    videoEntries,
    audioEntries,
    appMode,
    subgraphMap: Object.keys(subgraphMap).length ? subgraphMap : undefined,
    autoSlots,
  };
}

/** 有没有别的节点引用它（作为连线来源） */
export function hasDownstream(wf: Record<string, ComfyWfNode>, nodeId: string): boolean {
  return Object.values(wf).some((n) => Object.values(n.inputs ?? {}).some((v) => isConnection(v) && v[0] === nodeId));
}

/** 该节点第一个「连线输入」——跨接时下游改用这个来源 */
export function firstConnInput(node: ComfyWfNode): [string, number] | null {
  for (const v of Object.values(node.inputs ?? {})) if (isConnection(v)) return v;
  return null;
}

/** 能否安全忽略：末端节点随时可以；中间节点要有连线输入可跨接 */
export function canDisable(wf: Record<string, ComfyWfNode>, nodeId: string): { ok: boolean; why?: string } {
  if (!hasDownstream(wf, nodeId)) return { ok: true };
  if (firstConnInput(wf[nodeId])) return { ok: true, why: "中间节点：忽略后下游自动改接它的上游" };
  return { ok: false, why: "该节点被下游引用、又没有可跨接的上游输入，忽略会使工作流断链" };
}

/**
 * 「有则生效、无则连坐旁路」的通用剔除（素材入口级）：
 * marked 节点 + 只服务于它们的下游节点（所有输入都来自被剔除节点，如视频拆分器）整条移出工作流，
 * 消费端指向它们的链接一并摘除——REF2VA 的 ref_images/ref_videos/ref_audios 等都是可选输入，摘除即不启用。
 * 用途：模板内置的占位图/默认视音参考在没有真实素材时不参与计算（32GB 级显存顶爆的元凶）。
 */
export function pruneNodesWithServants(
  wf: Record<string, ComfyWfNode>,
  marked: Set<string>,
): Record<string, ComfyWfNode> {
  if (!marked.size) return wf;
  const all = new Set(marked);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, n] of Object.entries(wf)) {
      if (all.has(id)) continue;
      const vals = Object.values(n.inputs ?? {});
      if (!vals.length) continue;
      if (vals.every((v) => Array.isArray(v) && all.has(String(v[0])))) {
        all.add(id);
        changed = true;
      }
    }
  }
  const out: Record<string, ComfyWfNode> = {};
  for (const [id, n] of Object.entries(wf)) {
    if (all.has(id)) continue;
    const inputs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n.inputs ?? {})) {
      if (Array.isArray(v) && all.has(String(v[0]))) continue;
      inputs[k] = v;
    }
    out[id] = { ...n, inputs };
  }
  return out;
}

/** 剔除被忽略的节点：引用它的输入改接其第一个上游（链式解析），无法跨接则删除该输入 */export function pruneDisabled(
  wf: Record<string, ComfyWfNode>,
  disabled: string[] | undefined,
): Record<string, ComfyWfNode> {
  const off = new Set((disabled ?? []).filter((id) => wf[id]));
  if (!off.size) return wf;
  // 每个被忽略节点的跨接来源（顺着链条找到第一个未被忽略的上游）
  const resolve = (id: string): [string, number] | null => {
    let cur: [string, number] | null = [id, 0];
    for (let i = 0; i < 20 && cur; i++) {
      if (!off.has(cur[0])) return cur;
      cur = firstConnInput(wf[cur[0]]);
    }
    return null;
  };
  const out: Record<string, ComfyWfNode> = {};
  for (const [id, node] of Object.entries(wf)) {
    if (off.has(id)) continue;
    const inputs: Record<string, unknown> = {};
    for (const [input, v] of Object.entries(node.inputs ?? {})) {
      if (isConnection(v) && off.has(v[0])) {
        const src = resolve(v[0]);
        if (src) inputs[input] = [src[0], src[1]];
        // 无法跨接 → 丢弃该输入，交给提交前校验给出中文提示
      } else inputs[input] = v;
    }
    out[id] = { ...node, inputs };
  }
  return out;
}

/* ---------------- object_info（节点类型说明书，用于提交前校验） ---------------- */

const objectInfoCache = new Map<string, Promise<Record<string, any> | null>>();

/** 拉取并缓存 /object_info；失败返回 null（不阻断运行） */
export function fetchObjectInfo(host: string): Promise<Record<string, any> | null> {
  const base = normalizeHost(host);
  let p = objectInfoCache.get(base);
  if (!p) {
    p = xfetch(`${base}/object_info`)
      .then((r) => (r.ok ? (r.json() as Promise<Record<string, any>>) : null))
      .catch(() => null);
    objectInfoCache.set(base, p);
    // 失败的不缓存，下次重试
    void p.then((v) => {
      if (!v) objectInfoCache.delete(base);
    });
  }
  return p;
}

/**
 * 从 object_info 提取某节点某输入的 combo 可选项。
 * ComfyUI object_info 结构：{ [class_type]: { input: { required/optional: { [input]: 定义 } } } }
 * combo 类型的定义形如 [ ["选项1","选项2",...], {配置} ] → 取数组首元素为选项列表。
 * 非 combo（纯字符串/数字/布尔）→ undefined（调用方保持文本框）。
 */
export function comboOptionsFor(
  objectInfo: Record<string, any> | null,
  classType: string,
  input: string,
): string[] | undefined {
  const oi = objectInfo?.[classType]?.input;
  if (!oi) return undefined;
  const def = oi.required?.[input] ?? oi.optional?.[input];
  if (!Array.isArray(def) || !Array.isArray(def[0])) return undefined;
  const opts = def[0].filter((x: unknown): x is string => typeof x === "string");
  return opts.length ? opts : undefined;
}

/**
 * 给参数列表补上 combo 可选项（运行时从 ComfyUI 服务端拉 object_info，有缓存）。
 * 供编辑器/节点参数面板用：options 填进 ComfyExposedParam，UI 据此渲染下拉。
 * 服务端不可用或非 combo → options 留空，退化为文本框，不影响运行。
 */
export async function enrichParamsWithCombo(
  host: string,
  wf: Record<string, ComfyWfNode>,
  params: ComfyExposedParam[],
): Promise<ComfyExposedParam[]> {
  if (!params.length || !host) return params;
  const info = await fetchObjectInfo(host);
  if (!info) return params;
  return params.map((p) => {
    const opts = comboOptionsFor(info, wf[p.nodeId]?.class_type ?? "", p.input);
    if (!opts) return p;
    // 类型矫正：combo（object_info 定义是选项数组）一律按文本下拉渲染——数字枚举的 combo
    // 会被值类型误判成 number 丢掉下拉；seed/image/toggle 的语义判定不动
    return { ...p, options: opts, kind: p.kind === "text" || p.kind === "number" ? "text" : p.kind };
  });
}

export type WfInputInfo = {
  nodeId: string;
  nodeTitle: string;
  classType: string;
  input: string;
  value: unknown;
  kind: ComfyParamKind;
};

/** 列出工作流中所有「可暴露」的静态输入（排除节点间连线） */
export function listWorkflowInputs(wf: Record<string, ComfyWfNode>): WfInputInfo[] {
  const out: WfInputInfo[] = [];
  for (const [nodeId, node] of Object.entries(wf)) {
    for (const [input, value] of Object.entries(node.inputs ?? {})) {
      if (isConnection(value)) continue;
      out.push({
        nodeId,
        nodeTitle: node._meta?.title ?? node.class_type,
        classType: node.class_type,
        input,
        value,
        kind: guessKind(node, input, value),
      });
    }
  }
  return out;
}

/** 猜测输出节点（SaveImage / PreviewImage 优先） */
export function guessOutputNode(wf: Record<string, ComfyWfNode>): string | undefined {
  const entries = Object.entries(wf);
  const hit =
    entries.find(([, n]) => n.class_type.includes("SaveImage")) ??
    entries.find(([, n]) => n.class_type.includes("PreviewImage")) ??
    entries.find(([, n]) => n.class_type.toLowerCase().includes("save"));
  return hit?.[0];
}

/* ---------------- 子工作流分支提取（v2） ---------------- */
//
// 方案 §18.5：分支切换用 include-list，不复用 pruneDisabled 的自动跨接。
// pruneDisabled 适合「关掉某个可选中间节点」，但跨分支时会错误地把图像分支
// 旁路到视频分支的相邻输入，导致执行错误路径。子工作流必须严格按白名单过滤。
//
// 执行顺序（方案 §18.5）：
//   选择主模板/子分支 → 提取白名单子工作流 → 应用分支内部忽略节点
//   → 写入参数和语义素材槽 → object_info 预检 → 提交 ComfyUI

/** 从一个节点的输入里收集所有「连线来源」节点 id（去重） */
function upstreamNodeIds(node: ComfyWfNode): string[] {
  const ids: string[] = [];
  for (const v of Object.values(node.inputs ?? {})) {
    if (isConnection(v)) ids.push(v[0]);
  }
  return ids;
}

export type ExtractVariantResult = {
  /** 提取后的子工作流（只含白名单节点；连线指向白名单外的会保留，交给 object_info 报错） */
  wf: Record<string, ComfyWfNode>;
  /** 实际进入白名单的节点 id（含祖先闭包 + 显式共享） */
  allowed: string[];
  /** 连线指向了白名单外节点的输入列表（供 UI 提示「依赖未选」） */
  dangling: Array<{ from: string; input: string; missing: string }>;
};

/**
 * 按 variant 的 nodeIds + outputNodeIds 反向祖先闭包 + 显式 sharedNodeIds，
 * 从 tpl.workflow 中提取白名单子工作流。
 *
 * allowed 构成（方案 §18.5）：
 *   分支 nodeIds（用户框选的节点，全部保留）
 *   + outputNodeIds 反向无界祖先闭包（输出链上的所有必要上游，含共享的模型/文本前置）
 *   + 显式 sharedNodeIds（不在输出反链上、但分支需要引用的节点，如参数注入）
 *
 * 关于 sharedNodeIds 与闭包的关系：
 * - ComfyUI 工作流的依赖都是连线，输出反链上的共享前置（如 CheckpointLoader）会被
 *   无界闭包自动收编——这是正确的，因为输出链确实需要它们。
 * - sharedNodeIds 的真正作用是：① 供 UI 标记「多分支共享」徽标；② §18.6 的非共享节点
 *   重叠检测；③ 给那些被分支节点引用、但不在任何输出反链上的节点一个显式入口。
 * - dangling（连线指向白名单外）在正常工作流里几乎不会触发，因为闭包已经把反链全收编了；
 *   它只在「分支节点引用了非反链上的外部节点且未声明 shared」时出现，作为防御性兜底。
 *
 * 其他规则：
 * - default 分支（老模板）nodeIds 为空时，等价于整个工作流，保证老行为零回归。
 * - 正式分支（非 default）必须至少有一个 outputNodeIds，否则抛中文错误。
 */
export function extractVariantWorkflow(
  tpl: ComfyTemplate,
  variantId: string | undefined,
): ExtractVariantResult {
  const wf = tpl.workflow;
  const allIds = Object.keys(wf);
  // 找 variant：未指定 / 找不到 / 是 default 分支 → 整个工作流（老模板兼容路径）
  const variant = variantId ? tpl.variants?.find((v) => v.id === variantId) : undefined;
  const isDefaultFallback = !variant || variant.id === "default";

  // default 分支且 nodeIds 为空（老模板 normalize 出的 default）→ 等价整个工作流
  const seedNodeIds = variant && variant.nodeIds.length ? variant.nodeIds : isDefaultFallback ? allIds : [];

  // 正式分支（非 default）没有节点：报错
  if (!seedNodeIds.length) {
    const msg = variant
      ? `子工作流分支「${variant.name}」没有归属节点，请先在模板编辑器中框选节点`
      : "未选择子工作流分支，且模板没有默认分支";
    throw new Error(msg);
  }

  // 1. allowed 起点 = 分支 nodeIds + 显式 sharedNodeIds
  const allowed = new Set<string>(seedNodeIds);
  if (variant?.sharedNodeIds) for (const id of variant.sharedNodeIds) if (wf[id]) allowed.add(id);

  // 2. 输出反向无界闭包：从 outputNodeIds 出发，沿连线反向收编所有必要上游。
  //    含共享的模型/文本前置——它们是输出链必须经过的节点，方案 §18.5「反向找到的必要祖先」。
  const outputSeedsRaw = variant?.outputNodeIds?.length ? variant.outputNodeIds : [];
  if (outputSeedsRaw.length) {
    const validOutputs = outputSeedsRaw.filter((id) => wf[id]);
    if (!validOutputs.length) {
      throw new Error(
        `子工作流分支「${variant?.name}」的输出节点（${outputSeedsRaw.join(", ")}）在工作流中不存在`,
      );
    }
    const queue = [...validOutputs];
    const seen = new Set<string>(queue);
    while (queue.length) {
      const id = queue.shift()!;
      allowed.add(id);
      for (const up of upstreamNodeIds(wf[id])) {
        if (wf[up] && !seen.has(up)) {
          seen.add(up);
          queue.push(up);
        }
      }
    }
  } else if (!isDefaultFallback) {
    // 正式分支必须指定输出（方案 §18.6：不允许没有输出的正式分支）
    throw new Error(`子工作流分支「${variant?.name}」没有指定输出节点`);
  }

  // 3. 过滤工作流：只保留白名单节点；连线指向白名单外的记入 dangling（不删连线、不跨接）
  //    正常工作流里 dangling 几乎不触发（闭包已收编反链）；它防御「分支引用了非反链外部节点」。
  //    ⚠️ 必须深拷贝节点：后续 runComfyTemplate 会修改 node.inputs（写提示词/图片名/参数），
  //    不拷贝会污染 store 里的模板本体（P0-1 修复）。
  const out: Record<string, ComfyWfNode> = {};
  const dangling: ExtractVariantResult["dangling"] = [];
  for (const id of allowed) {
    const node = wf[id];
    if (!node) continue;
    out[id] = { ...node, inputs: { ...node.inputs }, _meta: node._meta ? { ...node._meta } : undefined };
    for (const [input, v] of Object.entries(node.inputs ?? {})) {
      if (isConnection(v) && !allowed.has(v[0])) {
        dangling.push({ from: id, input, missing: v[0] });
      }
    }
  }

  return { wf: out, allowed: [...allowed], dangling };
}

/** 在提取分支后，对分支内部的 disabledNodes 走 pruneDisabled（安全忽略，不跨分支） */
export function extractAndPruneVariant(
  tpl: ComfyTemplate,
  variantId: string | undefined,
): { wf: Record<string, ComfyWfNode>; dangling: ExtractVariantResult["dangling"] } {
  const { wf, dangling } = extractVariantWorkflow(tpl, variantId);
  const variant = variantId ? tpl.variants?.find((v) => v.id === variantId) : undefined;
  const pruned = pruneDisabled(wf, variant?.disabledNodes ?? tpl.disabledNodes);
  return { wf: pruned, dangling };
}

/** 获取模板的有效参数列表：指定分支优先用分支 params，否则回落顶层 params（老模板兼容） */
export function effectiveParams(tpl: ComfyTemplate, variantId?: string): ComfyExposedParam[] {
  if (variantId) {
    const v = tpl.variants?.find((x) => x.id === variantId);
    if (v) return v.params;
  }
  return tpl.params;
}

/** 获取模板的有效输出节点：指定分支优先用分支 outputNodeIds[0]，否则回落顶层 outputNodeId */
export function effectiveOutputNodeId(tpl: ComfyTemplate, variantId?: string): string | undefined {
  if (variantId) {
    const v = tpl.variants?.find((x) => x.id === variantId);
    if (v?.outputNodeIds.length) return v.outputNodeIds[0];
  }
  return tpl.outputNodeId;
}

/** 在 tpl 中按 id 查 variant（便利方法，供 UI / runner 使用） */
export function findVariant(tpl: ComfyTemplate, variantId?: string): ComfyVariant | undefined {
  if (!variantId) return undefined;
  return tpl.variants?.find((v) => v.id === variantId);
}

/**
 * 构建图片入口列表（与下方 runComfyTemplate 的默认分配顺序完全一致）：
 * 暴露的图片参数（顺序=effectiveParams）→ 未被参数占用的 LoadImage 节点（按编号排序）。
 * 入口 key 与 imageSlotMap 的 key 同构（"nodeId.input"）。输入映射弹卡与节点徽章共用。
 */
export function buildImageEntries(tpl: ComfyTemplate, variantId?: string): { key: string; label: string }[] {
  const eff = effectiveParams(tpl, variantId);
  const imgParams = eff.filter((p) => p.kind === "image");
  const occupied = new Set(imgParams.map((p) => p.nodeId));
  const { wf } = extractVariantWorkflow(tpl, variantId);
  const loaders = Object.keys(wf)
    .filter((id) => isImageLoaderClass(wf[id].class_type) && !occupied.has(id))
    .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  return [
    ...imgParams.map((p) => ({ key: p.key, label: p.label })),
    ...loaders.map((id) => ({ key: `${id}.image`, label: zhNode(wf[id]) })),
  ];
}

/* ---------------- 运行 ---------------- */

export async function uploadImageToComfy(host: string, dataUrl: string): Promise<string> {
  const fd = new FormData();
  fd.append("image", dataUrlToBlob(dataUrl), `momo_${uid(6)}.png`);
  fd.append("overwrite", "true");
  const resp = await xfetch(`${normalizeHost(host)}/upload/image`, { method: "POST", body: fd });
  if (!resp.ok) throw new Error(`上传图片到 ComfyUI 失败 ${resp.status}: ${await readErrorBody(resp)}`);
  const j = await resp.json();
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

export const isVideoLoaderClass = (ct: string) => /loadvideo/i.test(ct);

/** 上传视频到 ComfyUI 的 input 目录（/upload/image 接口对任意文件通用） */
export async function uploadVideoToComfy(host: string, src: string): Promise<string> {
  const blob = src.startsWith("data:") ? dataUrlToBlob(src) : await (await xfetch(src)).blob();
  const ext = /webm/.test(blob.type) ? "webm" : /quicktime|mov/.test(blob.type) ? "mov" : "mp4";
  const fd = new FormData();
  fd.append("image", blob, `momo_${uid(6)}.${ext}`);
  fd.append("overwrite", "true");
  const resp = await xfetch(`${normalizeHost(host)}/upload/image`, { method: "POST", body: fd });
  if (!resp.ok) throw new Error(`上传视频到 ComfyUI 失败 ${resp.status}: ${await readErrorBody(resp)}`);
  const j = await resp.json();
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

/** 上传音频到 ComfyUI 的 input 目录（与视频同一通用上传接口） */
export async function uploadAudioToComfy(host: string, src: string): Promise<string> {
  const blob = src.startsWith("data:") ? dataUrlToBlob(src) : await (await xfetch(src)).blob();
  const ext = /wav/.test(blob.type) ? "wav" : /mpeg|mp3/.test(blob.type) ? "mp3" : /ogg/.test(blob.type) ? "ogg" : /m4a|mp4|aac/.test(blob.type) ? "m4a" : "wav";
  const fd = new FormData();
  fd.append("image", blob, `momo_${uid(6)}.${ext}`);
  fd.append("overwrite", "true");
  const resp = await xfetch(`${normalizeHost(host)}/upload/image`, { method: "POST", body: fd });
  if (!resp.ok) throw new Error(`上传音频到 ComfyUI 失败 ${resp.status}: ${await readErrorBody(resp)}`);
  const j = await resp.json();
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

/** images 已回传为 dataURL（显示/下游/资产收录全链路统一）；texts 为 ShowText 等文本输出；videos 为 VHS 合成等视频输出（blob URL） */
export type ComfyRunResult = { images: string[]; texts: string[]; videos: string[]; videoSpecApplyReport?: VideoSpecApplyReport };

/**
 * 视频规格写入报告（3.5 §6.8）：runComfyTemplate 把 分辨率/帧率/时长 写进工作流后，
 * 如实报告每一项命中了哪些节点与输入。Take.appliedVideoSpec 只认这里——模板没有对应入口时
 * 该项不标记已应用，并给出 warning（预检/版本卡可见），绝不假装三项全部生效。
 */
export type VideoSpecApplyReport = {
  resolutionApplied: boolean;
  fpsApplied: boolean;
  durationApplied: boolean;
  /** 真实写入的节点与输入（nodeId.input → 值），可在进度与诊断里追溯 */
  writtenNodes: Array<{ nodeId: string; input: string; value: number | string; label: string }>;
  /** 没有匹配入口/匹配失败等异常——调用方转成 adjustment 或预检提示 */
  warnings: string[];
  /** 最终生效值（帧数按最终 fps × duration 计算） */
  actualValues: { width?: number; height?: number; mp?: number; aspect?: string; fps?: number; frames?: number; durationSec?: number };
};

/**
 * 把统一视频规格写进 ComfyUI 工作流（纯函数，测试直测）：
 *  ① 时长（秒）：暴露参数（时长/duration/秒）优先，回退标题含时长的节点字面量数字输入；
 *  ② 帧率：暴露参数（帧率/fps/frame_rate）优先；模板只收总帧数（length/frames）时按最终 fps × duration 换算；
 *  ③ 分辨率：百万像素/宽/高/比例 暴露参数优先，回退按输入名直写；aspect_ratio 下拉按选项表前缀匹配。
 * aspectOptions 注入下拉选项表（运行时来自 object_info；测试给固定表），返回 undefined 视为查不到保持模板原值。
 */
export function applyVideoSpecToWorkflow(
  wf: Record<string, ComfyWfNode>,
  params: ComfyExposedParam[],
  spec: { durationSec?: number; fps?: number; resolution?: { aspect?: string; mp?: number; width?: number; height?: number } },
  opts: {
    onProgress?: (msg: string) => void;
    aspectOptions?: (classType: string) => string[] | undefined;
  } = {},
): VideoSpecApplyReport {
  const report: VideoSpecApplyReport = {
    resolutionApplied: false,
    fpsApplied: false,
    durationApplied: false,
    writtenNodes: [],
    warnings: [],
    actualValues: {},
  };
  const nodeTitle = (nid: string) => {
    const n = wf[nid];
    return n ? n._meta?.title ?? n.class_type : nid;
  };
  const write = (nodeId: string, input: string, value: number | string) => {
    if (!wf[nodeId]) return;
    wf[nodeId].inputs[input] = value;
    report.writtenNodes.push({ nodeId, input, value, label: nodeTitle(nodeId) });
  };

  // ① 时长（秒语义槽位；帧数类输入交给 ② 的换算）
  if (spec.durationSec && spec.durationSec > 0) {
    const dur = spec.durationSec;
    const durParam = params.find((x) => x.kind === "number" && /时长|duration|秒/i.test(x.label ?? ""));
    if (durParam && wf[durParam.nodeId]) {
      write(durParam.nodeId, durParam.input, dur);
      report.durationApplied = true;
      report.actualValues.durationSec = dur;
      opts.onProgress?.(`片段时长 ${dur} 秒 → #${durParam.nodeId} ${nodeTitle(durParam.nodeId)}`);
    } else {
      let hit = false;
      for (const [nid, node] of Object.entries(wf)) {
        const title = node._meta?.title ?? "";
        if (!/时长|duration/i.test(title)) continue;
        for (const [k, v] of Object.entries(node.inputs ?? {})) {
          if (typeof v === "number") {
            write(nid, k, dur);
            hit = true;
            report.durationApplied = true;
            report.actualValues.durationSec = dur;
            opts.onProgress?.(`片段时长 ${dur} 秒 → #${nid} ${title}`);
            break;
          }
        }
        if (hit) break;
      }
    }
  }

  // ② 帧率：fps 参数直写；未暴露时回退「标题含帧率/fps 的节点字面量数字输入」（与时长兜底对称）；
  //     再否则总帧数输入按 最终 fps × duration 换算（时长入口缺失时帧数写入同时承载时长语义）
  if (spec.fps && spec.fps > 0) {
    const fpsParam = params.find((x) => x.kind === "number" && /帧率|fps|frame_?rate/i.test(x.label ?? ""));
    if (fpsParam && wf[fpsParam.nodeId]) {
      write(fpsParam.nodeId, fpsParam.input, spec.fps);
      report.fpsApplied = true;
      report.actualValues.fps = spec.fps;
      opts.onProgress?.(`帧率 ${spec.fps} fps → #${fpsParam.nodeId} ${nodeTitle(fpsParam.nodeId)}`);
    } else {
      let hit = false;
      for (const [nid, node] of Object.entries(wf)) {
        const title = node._meta?.title ?? "";
        if (!/帧率|fps|frame_?rate/i.test(title)) continue;
        for (const [k, v] of Object.entries(node.inputs ?? {})) {
          if (typeof v === "number") {
            write(nid, k, spec.fps);
            hit = true;
            report.fpsApplied = true;
            report.actualValues.fps = spec.fps;
            opts.onProgress?.(`帧率 ${spec.fps} fps → #${nid} ${title}`);
            break;
          }
        }
        if (hit) break;
      }
      if (!hit && spec.durationSec) {
        const frames = Math.round(spec.fps * spec.durationSec);
        for (const [nid, node] of Object.entries(wf)) {
          let frameHit = false;
          for (const [k, v] of Object.entries(node.inputs ?? {})) {
            if (typeof v === "number" && /^(?:length|frames|num_frames|total_frames)$/i.test(k)) {
              write(nid, k, frames);
              frameHit = true;
              report.actualValues.frames = frames;
              // 帧数入口承载了时长语义（fps × duration）；fps 本体没有独立入口，换算用的值记录在案
              report.durationApplied = true;
              opts.onProgress?.(`帧数 ${frames}（${spec.fps}fps × ${spec.durationSec}s）→ #${nid} ${nodeTitle(nid)}`);
              break;
            }
          }
          if (frameHit) break;
        }
        if (!report.actualValues.frames) {
          report.warnings.push(`模板没有帧率/帧数入口（帧率 ${spec.fps}fps 不会生效）`);
        }
      } else if (!hit) {
        report.warnings.push(`有时长无帧率入口且未提供时长——帧率 ${spec.fps}fps 未写入`);
      }
    }
  }
  if (spec.durationSec && !report.durationApplied) {
    report.warnings.push(`模板没有时长/帧数入口（时长 ${spec.durationSec}s 不会生效）`);
  }

  // ③ 分辨率：百万像素 / 宽+高 / 比例
  if (spec.resolution) {
    const res = spec.resolution;
    let mpDone = false;
    let aspectDone = false;
    let wDone = false;
    let hDone = false;
    for (const p of params) {
      if (!wf[p.nodeId]) continue;
      const label = `${p.label ?? ""} ${p.key}`;
      if (res.mp !== undefined && p.kind === "number" && /百万像素|megapixels?/i.test(label)) {
        write(p.nodeId, p.input, res.mp);
        mpDone = true;
        report.actualValues.mp = res.mp;
        opts.onProgress?.(`像素 ${res.mp} MP → ${p.label}`);
      } else if (res.aspect && p.kind === "text" && /比例|aspect/i.test(label)) {
        write(p.nodeId, p.input, res.aspect);
        aspectDone = true;
        report.actualValues.aspect = res.aspect;
        opts.onProgress?.(`画幅 ${res.aspect} → ${p.label}`);
      } else if (res.width !== undefined && p.kind === "number" && /宽|width/i.test(label) && !/高|height/i.test(label)) {
        write(p.nodeId, p.input, res.width);
        wDone = true;
      } else if (res.height !== undefined && p.kind === "number" && /高|height/i.test(label) && !/宽|width/i.test(label)) {
        write(p.nodeId, p.input, res.height);
        hDone = true;
      }
    }
    // 兜底：按节点输入名直写（ResolutionSelector 的 megapixels、EmptyLatentImage/Video 的 width/height）
    if (!mpDone && res.mp !== undefined) {
      for (const [nid, node] of Object.entries(wf)) {
        if (typeof node.inputs?.megapixels === "number") {
          write(nid, "megapixels", res.mp);
          mpDone = true;
          report.actualValues.mp = res.mp;
          opts.onProgress?.(`像素 ${res.mp} MP → #${nid} ${nodeTitle(nid)}`);
        }
      }
    }
    if (!wDone && res.width !== undefined) {
      for (const [nid, node] of Object.entries(wf)) {
        if (typeof node.inputs?.width === "number") {
          write(nid, "width", res.width);
          wDone = true;
        }
      }
    }
    if (!hDone && res.height !== undefined) {
      for (const [nid, node] of Object.entries(wf)) {
        if (typeof node.inputs?.height === "number") {
          write(nid, "height", res.height);
          hDone = true;
        }
      }
    }
    if (wDone) report.actualValues.width = res.width;
    if (hDone) report.actualValues.height = res.height;
    // aspect_ratio 是下拉控件：按选项表前缀匹配（"16:9" → "16:9 (Widescreen)"）；
    // 匹配不到保持模板原值（给下拉写非法值会被 ComfyUI 校验整单拒绝），但必须报告
    if (!aspectDone && res.aspect && opts.aspectOptions) {
      for (const [nid, node] of Object.entries(wf)) {
        if (typeof node.inputs?.aspect_ratio !== "string") continue;
        const list = opts.aspectOptions(node.class_type);
        const hit = Array.isArray(list) ? list.find((o) => String(o).startsWith(res.aspect!)) : undefined;
        if (hit !== undefined) {
          write(nid, "aspect_ratio", hit);
          aspectDone = true;
          report.actualValues.aspect = hit;
          opts.onProgress?.(`画幅 ${hit} → #${nid} ${nodeTitle(nid)}`);
          break;
        }
      }
      if (!aspectDone) {
        report.warnings.push(`比例 ${res.aspect} 不在模板下拉选项表中——保持模板原值`);
      }
    }
    report.resolutionApplied = mpDone || wDone || hDone || aspectDone;
    if (!report.resolutionApplied) {
      report.warnings.push(`模板没有分辨率入口（百万像素/宽高/比例都没有）——分辨率 ${res.width ?? ""}${res.width && res.height ? "×" : ""}${res.height ?? ""}${res.mp ? `${res.mp}MP` : ""} 不会生效`);
    }
    if (res.width && res.height && (wDone || hDone)) opts.onProgress?.(`分辨率 ${res.width}×${res.height}`);
  }

  return report;
}

/** WebSocket 实时进度：按已完成节点数 + 当前节点采样步数换算百分比，报给 onProgress */
function openProgressSocket(
  base: string,
  clientId: string,
  wf: Record<string, ComfyWfNode>,
  getPromptId: () => string | undefined,
  onProgress?: (msg: string, pct?: number) => void,
): { close: () => void; live: () => boolean } {
  let ws: WebSocket | null = null;
  let live = false;
  const total = Math.max(1, Object.keys(wf).length);
  const done = new Set<string>();
  let current: string | undefined;
  let step: { value: number; max: number } | null = null;

  const title = (nid?: string) => {
    const n = nid ? wf[nid] : undefined;
    return n ? n._meta?.title ?? n.class_type : "";
  };
  const report = () => {
    const frac = Math.min(1, (done.size + (step && step.max > 0 ? step.value / step.max : 0)) / total);
    const stepTxt = step ? ` · ${step.value}/${step.max} 步` : "";
    onProgress?.(`节点 ${Math.min(done.size + 1, total)}/${total}：${title(current) || "…"}${stepTxt}`, Math.round(frac * 100));
  };

  try {
    ws = new WebSocket(`${base.replace(/^http/i, "ws")}/ws?clientId=${clientId}`);
    ws.onopen = () => {
      live = true;
    };
    ws.onclose = ws.onerror = () => {
      live = false;
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return; // 二进制帧是预览图，忽略
      let m: { type?: string; data?: Record<string, unknown> };
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      const d = m.data ?? {};
      const pid = getPromptId();
      // 带 prompt_id 的消息只认自己这单（不带的旧版消息放行——executing/progress 本就只发给提交方）
      if (typeof d.prompt_id === "string" && pid && d.prompt_id !== pid) return;
      switch (m.type) {
        case "execution_cached":
          for (const n of (d.nodes as unknown[]) ?? []) done.add(String(n));
          report();
          break;
        case "executing":
          if (d.node === null) break; // 整单结束，交给 history 轮询收尾
          if (current && current !== String(d.node)) done.add(current);
          current = String(d.node);
          step = null;
          report();
          break;
        case "progress":
          step = { value: Number(d.value ?? 0), max: Number(d.max ?? 0) };
          if (d.node) current = String(d.node);
          report();
          break;
      }
    };
  } catch {
    ws = null;
  }
  return {
    close: () => {
      try {
        ws?.close();
      } catch {
        /* 忽略 */
      }
    },
    live: () => live,
  };
}

export async function runComfyTemplate(
  host: string,
  tpl: ComfyTemplate,
  paramValues: Record<string, string | number | boolean>,
  opts: {
    onProgress?: (msg: string, pct?: number) => void;
    signal?: AbortSignal;
    /** 上游图片（dataURL）：自动喂给图片参数 → LoadImage 节点 → 缺失的必填图片输入 */
    upstreamImages?: string[];
    /** 上游文本：模板没有文本参数时自动填入正面提示词入口 */
    upstreamTexts?: string[];
    /** 上游视频：自动上传并喂给 LoadVideo 类节点（SeedVR2 放大等视频工作流） */
    upstreamVideos?: string[];
    /** 上游音频：自动上传并喂给 LoadAudio 类节点（MiniMax H3 REF2VA 等音频参考工作流） */
    upstreamAudios?: string[];
    /** 子工作流分支 id；undefined/找不到/default → 走整个工作流（老模板兼容） */
    variantId?: string;
    /**
     * 图片输入精确映射：入口 key（"nodeId.input"，与暴露参数 key 同构）→ 上游图 dataURL。
     * 指定了的入口精确用这张图；未映射的入口仍走默认顺序分配（旧行为零回归）。
     */
    imageSlotMap?: Record<string, string>;
    /**
     * 片段时长（秒）：写入工作流的「时长槽位」——优先标签含 时长/duration/秒 的数字型暴露参数
     * （如 H3 模板的「时长（秒）」PrimitiveFloat），回退到标题含时长的节点上的字面量数字输入。
     * 只写「秒」语义槽位；帧数类输入（length/frames）交给工作流自己的秒→帧换算节点（如 H3 的自动对齐帧数）。
     */
    durationSec?: number;
  /**
   * 帧率（3.5 统一视频规格）：优先写标签含 帧率/fps/frame_rate 的数字型暴露参数；
   * 工作流只收总帧数（length/frames）时按 fps × durationSec 换算——必须用本段最终 FPS，
   * 不能沿用模板内部另一个 FPS 值（否则成片时长漂移）。
   */
  fps?: number;
    /**
     * 画幅与像素（导演台顶栏设置）：按模板暴露的参数形式写入——
     * 有「百万像素/megapixels」数字参数就写 mp；有「宽/高」数字参数对就写换算后的宽高；有「比例/aspect」文本参数就写比例串。
     */
    resolution?: { aspect?: string; mp?: number; width?: number; height?: number };
  } = {},
): Promise<ComfyRunResult> {
  const base = normalizeHost(host);
  if (!base) throw new Error("请先在「设置 → ComfyUI」中填写服务地址");

  // 1. 提取子工作流分支（include-list + 依赖闭包 + 安全忽略），再写入参数值。
  //    variantId 为空 / default / 老模板 → extractAndPruneVariant 返回整个工作流，行为零回归。
  const { wf: wfRaw, dangling } = extractAndPruneVariant(tpl, opts.variantId);
  if (dangling.length) {
    const detail = dangling.slice(0, 3).map((d) => `#${d.from}.${d.input} → #${d.missing}`).join("；");
    throw new Error(
      `子工作流分支有 ${dangling.length} 处依赖未选入分支（如 ${detail}），请在模板编辑器中补全共享节点或重新框选`,
    );
  }
  let wf: Record<string, ComfyWfNode> = wfRaw;
  const params = effectiveParams(tpl, opts.variantId);
  const outNodeId = effectiveOutputNodeId(tpl, opts.variantId);
  const nodeTitle = (nid: string) => {
    const n = wf[nid];
    return n ? n._meta?.title ?? n.class_type : nid;
  };

  // 精确映射占用的图从队列扣除，避免同一张图被默认顺序再喂给别的入口
  // （同一张图映射给两个入口是允许的：ensureUploaded 有缓存，不会重复上传；NONE 哨兵不占图）
  const mappedSrcs = new Set(Object.values(opts.imageSlotMap ?? {}).filter((s) => s !== COMFY_SLOT_NONE));
  const imgQueue = (opts.upstreamImages ?? []).filter((s) => !mappedSrcs.has(s));
  let imagesUsed = 0;
  let lastImageSrc: string | undefined;
  const uploadCache = new Map<string, string>();
  const ensureUploaded = async (dataUrl: string): Promise<string> => {
    lastImageSrc = dataUrl;
    let name = uploadCache.get(dataUrl);
    if (!name) {
      opts.onProgress?.(`上传图片到 ComfyUI…`);
      name = await uploadImageToComfy(host, dataUrl);
      uploadCache.set(dataUrl, name);
    }
    imagesUsed++;
    return name;
  };

  const imageParamNodes = new Set<string>(); // 已由图片参数占用的节点
  const unfilledImgNodes = new Set<string>(); // 没喂到素材的图片入口节点：提交前连坐旁路（不跑模板占位图）
  let videosUsed = 0;
  let audiosUsed = 0;
  let hasTextParam = false;
  let firstTextFilled = false;
  for (const p of params) {
    const node = wf[p.nodeId];
    if (!node) continue; // 节点被忽略/不存在
    const own = paramValues[p.key];
    if (p.kind === "image") {
      imageParamNodes.add(p.nodeId);
      let v = own !== undefined && own !== "" ? own : undefined;
      // 取值优先级：用户手填值 > 精确映射（imageSlotMap[p.key]）> 默认顺序（上游图队列）；NONE 哨兵 = 明确不给图
      const mapped = opts.imageSlotMap?.[p.key];
      if (typeof v === "string" && v.startsWith("data:")) v = await ensureUploaded(v);
      else if (mapped && mapped !== COMFY_SLOT_NONE) v = await ensureUploaded(mapped);
      else if (v === undefined && imgQueue.length) v = await ensureUploaded(imgQueue.shift()!);
      // 没素材的图片入口：不报错也不喂占位图——标记剔除，「有则生效、无则旁路」
      if (v === undefined) {
        unfilledImgNodes.add(p.nodeId);
        continue;
      }
      node.inputs[p.input] = v;
      continue;
    }
    if (p.kind === "text") {
      hasTextParam = true;
      const empty = own === undefined || own === "";
      if (empty && !firstTextFilled && opts.upstreamTexts?.length) {
        node.inputs[p.input] = opts.upstreamTexts.join("\n");
        firstTextFilled = true;
        continue;
      }
    }
    // 种子：留空 = 每次随机（与 ComfyUI 界面的「随机」同理）；填了数字 = 固定可复现
    if (p.kind === "seed") {
      const fixed = own !== undefined && own !== "" ? Number(own) : NaN;
      if (Number.isFinite(fixed)) node.inputs[p.input] = fixed;
      else {
        const seed = Math.floor(Math.random() * 2 ** 47);
        node.inputs[p.input] = seed;
        opts.onProgress?.(`随机种子 ${seed} → #${p.nodeId} ${nodeTitle(p.nodeId)}`);
      }
      continue;
    }
    const v = own !== undefined ? own : p.value;
    node.inputs[p.input] = p.kind === "number" ? Number(v) : v;
  }

  // 1a-2. 未暴露成参数的种子输入（noise_seed/seed）也每次随机——模板 JSON 里存的是导出那刻的具体数字，
  //       不随机的话每轮都朝同一个方向出图；想固定某个种子就把它暴露成参数并填数字（上分支）
  {
    const seedParams = new Set(params.filter((x) => x.kind === "seed").map((x) => `${x.nodeId}.${x.input}`));
    for (const [nid, node] of Object.entries(wf)) {
      for (const [k, v] of Object.entries(node.inputs ?? {})) {
        if (typeof v !== "number" || !/^(?:noise_)?seed$/i.test(k)) continue;
        if (seedParams.has(`${nid}.${k}`)) continue; // 已由暴露参数处理（固定或随机）
        const seed = Math.floor(Math.random() * 2 ** 47);
        node.inputs[k] = seed;
        opts.onProgress?.(`随机种子 ${seed} → #${nid} ${nodeTitle(nid)}`);
      }
    }
  }

  // 1b~1c. 统一视频规格（时长/帧率/分辨率）→ 工作流入口（纯函数 applyVideoSpecToWorkflow，
  //       在参数回填之后写，覆盖模板默认值与配方里的静态值——每段规格本来就各不相同）。
  //       报告每一项真实命中了哪些节点；没有入口的项进 warnings（调用方转 adjustment，绝不假装已应用）。
  let specReport: VideoSpecApplyReport | undefined;
  if (opts.durationSec || opts.fps || opts.resolution) {
    const info = opts.resolution?.aspect ? await fetchObjectInfo(host).catch(() => null) : null;
    specReport = applyVideoSpecToWorkflow(wf, params, { durationSec: opts.durationSec, fps: opts.fps, resolution: opts.resolution }, {
      onProgress: (m) => opts.onProgress?.(m),
      ...(info
        ? {
            aspectOptions: (classType: string) => {
              const spec = info[classType]?.input;
              return spec?.required?.aspect_ratio?.[0] ?? spec?.optional?.aspect_ratio?.[0];
            },
          }
        : {}),
    });
  }

  // 2a. 剩余上游图片 → 未被参数占用的 LoadImage 节点（精确映射优先，其余按编号顺序）
  {
    const fedLoaders = new Set<string>(); // 实际分到图的加载节点（其余旁路）
    const loaders = Object.keys(wf)
      .filter((id) => isImageLoaderClass(wf[id].class_type) && !imageParamNodes.has(id))
      .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    for (const id of loaders) {
      const mapped = opts.imageSlotMap?.[`${id}.image`];
      if (mapped && mapped !== COMFY_SLOT_NONE) {
        wf[id].inputs.image = await ensureUploaded(mapped);
        fedLoaders.add(id);
        continue;
      }
      if (mapped === COMFY_SLOT_NONE) continue; // 明确不给图：入口留空（工作流端自行报错或走默认）
      if (!imgQueue.length) break;
      wf[id].inputs.image = await ensureUploaded(imgQueue.shift()!);
      fedLoaders.add(id);
    }
    // 没分到图的非参数 LoadImage：模板默认占位图没有意义，一并标记旁路
    for (const id of loaders) if (!fedLoaders.has(id)) unfilledImgNodes.add(id);
  }

  // 2a-0. 「有则生效、无则连坐旁路」：没喂到素材的图片入口（含其专属下游）整条移出提交工作流，
  //        避免 REF2VA 把模板占位图当真实参考算进注意力（显存与时间都被无谓放大）
  if (unfilledImgNodes.size) {
    wf = pruneNodesWithServants(wf, unfilledImgNodes);
    opts.onProgress?.(`已旁路 ${unfilledImgNodes.size} 个无素材的图片入口`);
  }

  // 2a'. 上游视频 → LoadVideo 类节点（VHS_LoadVideo 等；输入名 video / file / video_path）。
  // 实际只保留前 N 个入口：模板里未被本次素材填充的默认 Video 2/3 必须连同拆分链旁路，
  // 否则它们会把模板自带完整视频重复送进 REF2VA，显著拖慢采样并污染动作参考。
  const vidQueue = [...(opts.upstreamVideos ?? [])];
  {
    const vLoaders = Object.keys(wf)
      .filter((id) => isVideoLoaderClass(wf[id].class_type))
      .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    const fedVideoLoaders = new Set<string>();
    for (const id of vLoaders) {
      if (!vidQueue.length) break;
      opts.onProgress?.("上传视频到 ComfyUI…");
      const name = await uploadVideoToComfy(host, vidQueue.shift()!);
      const inputs = wf[id].inputs;
      const key = ["video", "file", "video_path"].find((k) => k in inputs && !isConnection(inputs[k])) ?? "video";
      inputs[key] = name;
      fedVideoLoaders.add(id);
      opts.onProgress?.(`视频已接入 #${id} ${nodeTitle(id)}`);
    }
    if (vidQueue.length) {
      throw new Error(
        "已连接上游视频，但该工作流没有足够的视频加载节点（LoadVideo）。请在模板里加 VHS_LoadVideo 类节点，或断开视频连线。",
      );
    }
    videosUsed = fedVideoLoaders.size;
    const unfilledVideoNodes = new Set(vLoaders.filter((id) => !fedVideoLoaders.has(id)));
    if (unfilledVideoNodes.size) {
      wf = pruneNodesWithServants(wf, unfilledVideoNodes);
      opts.onProgress?.(`已旁路 ${unfilledVideoNodes.size} 个未使用的视频入口`);
    }
  }

  // 2a''. 上游音频 → LoadAudio 类节点；与视频相同，只保留真实填充的前 N 个入口。
  const audQueue = [...(opts.upstreamAudios ?? [])];
  {
    const aLoaders = Object.keys(wf)
      .filter((id) => isAudioLoaderClass(wf[id].class_type))
      .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    const fedAudioLoaders = new Set<string>();
    for (const id of aLoaders) {
      if (!audQueue.length) break;
      opts.onProgress?.("上传音频到 ComfyUI…");
      const name = await uploadAudioToComfy(host, audQueue.shift()!);
      const inputs = wf[id].inputs;
      const key = ["audio", "file", "audio_path"].find((k) => k in inputs && !isConnection(inputs[k])) ?? "audio";
      inputs[key] = name;
      fedAudioLoaders.add(id);
      opts.onProgress?.(`音频已接入 #${id} ${nodeTitle(id)}`);
    }
    if (audQueue.length) {
      throw new Error(
        "已连接上游音频，但该工作流没有足够的音频加载节点（LoadAudio）。请在模板里加 LoadAudio 节点，或断开音频连线。",
      );
    }
    audiosUsed = fedAudioLoaders.size;
    const unfilledAudioNodes = new Set(aLoaders.filter((id) => !fedAudioLoaders.has(id)));
    if (unfilledAudioNodes.size) {
      wf = pruneNodesWithServants(wf, unfilledAudioNodes);
      opts.onProgress?.(`已旁路 ${unfilledAudioNodes.size} 个未使用的音频入口`);
    }
  }
  opts.onProgress?.(`参考入口已对齐：图片 ${imagesUsed} 路、视频 ${videosUsed} 路、音频 ${audiosUsed} 路；其余入口已旁路`);

  // 2b. 模板没有文本参数时，把上游文本填入正面提示词入口
  if (!hasTextParam && opts.upstreamTexts?.length) {
    const entry = analyzeCaps(wf).textEntries.find((t) => !t.negative);
    if (entry) {
      wf[entry.nodeId].inputs[entry.input] = opts.upstreamTexts.join("\n");
      opts.onProgress?.(`上游文本已填入 #${entry.nodeId} ${nodeTitle(entry.nodeId)}`);
    }
  }

  // 2c. 提交前校验（object_info 说明书）：补默认值 / 自动注入图片入口 / 中文报缺
  const info = await fetchObjectInfo(host);
  if (info) {
    const problems: string[] = [];
    let inj = 0;
    for (const [nid, node] of Object.entries(wf)) {
      const spec = info[node.class_type];
      if (!spec) {
        problems.push(`#${nid} ${nodeTitle(nid)}：本机 ComfyUI 未安装节点类型「${node.class_type}」，请先安装对应的自定义节点插件`);
        continue;
      }
      const required = (spec.input?.required ?? {}) as Record<string, unknown[]>;
      for (const [input, def] of Object.entries(required)) {
        const cur = node.inputs[input];
        // AUTOGROW 类自定义输入（如 ComfyMathExpression 的 values）：前端格式里子输入槽名是「values.a」
        // 带点形式，object_info 登记的却是「values」——带点子输入在即视为已提供，原样交给 ComfyUI 校验
        // （同一工作流在 ComfyUI 界面能跑，服务端自然认这种槽名）
        const dottedChild =
          cur === undefined && Object.keys(node.inputs).some((k) => k.startsWith(`${input}.`));
        const broken = (cur === undefined && !dottedChild) || (isConnection(cur) && !wf[cur[0]]);
        if (!broken) continue;
        const t = def?.[0];
        if (Array.isArray(t)) {
          if (t.length) node.inputs[input] = t[0]; // 下拉选项 → 取第一项
          continue;
        }
        const dflt = (def?.[1] as { default?: unknown } | undefined)?.default;
        if (dflt !== undefined) {
          node.inputs[input] = dflt; // 普通控件 → 用默认值
          continue;
        }
        if (t === "IMAGE") {
          // 缺图片输入：自动注入一个 LoadImage 节点接上游图片
          const src = imgQueue.shift() ?? lastImageSrc;
          if (src) {
            const name = await ensureUploaded(src);
            const iid = `momo_in_${++inj}`;
            wf[iid] = { class_type: "LoadImage", inputs: { image: name, upload: "image" }, _meta: { title: "MOMO 传入图片" } };
            node.inputs[input] = [iid, 0];
            opts.onProgress?.(`已自动补入图片 → #${nid} ${nodeTitle(nid)}`);
          } else {
            problems.push(`#${nid} ${nodeTitle(nid)}：必填图片输入「${input}」没有来源——请连接上游图片节点`);
          }
        } else if (typeof t === "string") {
          problems.push(`#${nid} ${nodeTitle(nid)}：必填输入「${input}」（${t}）缺失或指向被忽略的节点`);
        }
      }
    }
    if (problems.length) throw new Error(`工作流无法运行：\n${problems.join("\n")}`);
  }

  // 2d. 上游连了图片却全程没用上 → 明确报错（否则模型只会"看不见"图，产出无关结果）
  if ((opts.upstreamImages?.length ?? 0) > 0 && imagesUsed === 0) {
    throw new Error(
      "已连接上游图片，但该工作流没有任何图片入口（无 LoadImage 节点、也没有空缺的图片输入）。请在模板编辑器的示意图中检查，或断开图片连线。",
    );
  }

  // 3. 先开 WebSocket（提交前连上才能收到从头开始的执行消息），再提交
  const clientId = `momo-${uid(8)}`;
  let promptId: string | undefined;
  const sock = openProgressSocket(base, clientId, wf, () => promptId, opts.onProgress);
  try {
    const resp = await xfetch(`${base}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: wf, client_id: clientId }),
    });
    if (!resp.ok) throw new Error(`ComfyUI 任务提交失败 ${resp.status}: ${await readErrorBody(resp)}`);
    const j = await resp.json();
    if (j.error) throw new Error(`ComfyUI 拒绝了工作流: ${JSON.stringify(j.error).slice(0, 300)}`);
    promptId = j.prompt_id;
    if (!promptId) throw new Error("ComfyUI 未返回 prompt_id");
    opts.onProgress?.("已加入队列…");

    // 4. 轮询 history 收尾（完成判定始终以 history 为准，WS 只负责进度展示）
    const sleep = (ms: number) =>
      new Promise<void>((res, rej) => {
        const t = setTimeout(res, ms);
        opts.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          rej(new Error("已取消"));
        });
      });

    // 30 分钟上限（2500 × 1.2s）：H3 一段 ~500s，叠加排队等待与「每段后清显存」的模型重载，
    // 旧的 12 分钟上限会在长任务上误判超时 → 报错重试 → 队列越堆越卡（恶性循环）
    for (let i = 0; i < 2500; i++) {
      await sleep(1200);
      const hr = await xfetch(`${base}/history/${promptId}`);
      if (!hr.ok) continue;
      const hj = await hr.json();
      const entry = hj[promptId];
      if (!entry) {
        // 尚未完成；WS 不可用时才用队列位置凑合个文案
        if (!sock.live() && i % 4 === 0) {
          try {
            const q = await (await xfetch(`${base}/queue`)).json();
            const pending = (q.queue_pending ?? []).length;
            const running = (q.queue_running ?? []).length;
            opts.onProgress?.(pending > 0 ? `排队中（前面还有 ${pending} 个任务）` : running > 0 ? "正在生成…" : "等待中…");
          } catch {
            /* 忽略 */
          }
        }
        continue;
      }
      const status = entry.status?.status_str;
      if (status === "error") {
        const msg = JSON.stringify(entry.status?.messages ?? []).slice(0, 300);
        throw new Error(`ComfyUI 执行出错: ${msg}`);
      }
      // 收集输出：图片取指定输出节点（未指定则全部）；文本/视频一律扫全部输出节点
      const urls: string[] = [];
      const vurls: string[] = [];
      const texts: string[] = [];
      const outputs = entry.outputs ?? {};
      const viewUrl = (f: { filename: string; subfolder?: string; type?: string }) => {
        const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder ?? "", type: f.type ?? "output" });
        return `${base}/view?${q.toString()}`;
      };
      const nodeIds = outNodeId && outputs[outNodeId] ? [outNodeId] : Object.keys(outputs);
      // 分类按扩展名而非所在键：H3 的自定义 SaveVideo 会把 .mp4 登记在 images 键下，
      // 只认 videos/gifs 键会漏收视频（应用端报「视频生成未返回结果」，服务端其实已出片）
      const isVideoFile = (f: { filename: string }) => /\.(mp4|webm|mov|mkv|m4v|avi)$/i.test(f.filename);
      for (const nid of nodeIds) {
        for (const img of outputs[nid]?.images ?? []) (isVideoFile(img) ? vurls : urls).push(viewUrl(img));
      }
      for (const nid of Object.keys(outputs)) {
        const out = outputs[nid] ?? {};
        for (const t of [...(out.text ?? []), ...(out.string ?? []), ...(out.strings ?? [])]) {
          if (typeof t === "string" && t.trim()) texts.push(t.trim());
        }
        // VHS_VideoCombine 等视频合成节点的输出叫 gifs（历史命名，内容是视频文件）
        for (const g of [...(out.gifs ?? []), ...(out.videos ?? [])]) {
          if (g?.filename) vurls.push(viewUrl(g));
        }
      }
      if (!urls.length && !texts.length && !vurls.length)
        throw new Error("工作流执行完成，但未在输出节点找到图片、视频或文本");

      // /view 是临时直链（ComfyUI 重启即失效）：图片回传 dataURL、视频回传 blob URL，
      // 进入统一管线（节点显示、下游使用、资产收录、自动保存）
      const images: string[] = [];
      for (const [i, u] of urls.entries()) {
        opts.onProgress?.(urls.length > 1 ? `回传生成结果 ${i + 1}/${urls.length}…` : "回传生成结果…");
        try {
          images.push(await toDataUrl(u, (i2, init) => xfetch(i2 as string, init)));
        } catch {
          images.push(u); // 回传失败保底用直链，至少当场能预览
        }
      }
      const videos: string[] = [];
      for (const u of vurls) {
        opts.onProgress?.("回传视频结果…");
        try {
          videos.push(URL.createObjectURL(await (await xfetch(u)).blob()));
        } catch {
          videos.push(u);
        }
      }
      return { images, texts, videos, videoSpecApplyReport: specReport };
    }
    throw new Error("ComfyUI 执行超时");
  } finally {
    sock.close();
  }
}

/** 把暴露参数转为默认值映射 */
export function defaultParamValues(params: ComfyExposedParam[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const p of params) out[p.key] = p.value as string | number | boolean;
  return out;
}
