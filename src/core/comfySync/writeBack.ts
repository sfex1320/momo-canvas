/**
 * M2 双向写回 · 纯逻辑：参数补丁定位/应用、字段冲突检测、节点稳定 ID 注入
 *
 * 定位规则与 convertFrontendWorkflow 完全同源（widgetLayoutOf 是唯一位序来源；
 * 「连接槽带 widget」的补偿位按出现序排在布局末尾），保证读回与写回落在同一格。
 * MOMO 在 M2 只写参数值（规格 FR-010 第一版范围：已暴露参数值 / 完整替换 / 显示名），
 * 图结构（nodes/links/groups）永远以 ComfyUI 源为权威，不从 API Prompt 反向生成。
 */
import { widgetLayoutOf } from "./widgetLayout.ts";

export type UiNode = {
  id: number | string;
  type: string;
  title?: string;
  pos?: unknown;
  size?: unknown;
  mode?: number;
  widgets_values?: unknown[];
  inputs?: Array<{ name: string; link?: number | null; widget?: { name: string } }>;
  properties?: Record<string, unknown>;
};

export type UiGraph = { nodes: UiNode[]; links?: unknown[]; groups?: unknown[]; [k: string]: unknown };

/** 一条待写回的参数补丁（key = `${nodeId}.${input}`） */
export type ParamPatch = { key: string; nodeId: string; input: string; value: unknown; label?: string };

/** 某节点 input 名 → widgets_values 下标（布局位 + asWidget 补偿位，与读入路径一致） */
export function widgetIndexOf(node: UiNode, input: string, objectInfo: Record<string, any>): number | undefined {
  const layout = widgetLayoutOf(node.type, objectInfo);
  const wvLen = layout.slots.reduce((s, x) => s + (x.cag ? 2 : 1), 0);
  let extra = 0;
  for (const inp of node.inputs ?? []) {
    const w = inp.widget?.name;
    if (w && !layout.index.has(w)) {
      if (w === input) return wvLen + extra;
      extra++;
    }
  }
  return layout.index.get(input);
}

/** 该输入当前是否被连线占用（widget 转成了输入口——写回没有意义，只能跳过） */
export function isLinked(node: UiNode, input: string): boolean {
  return (node.inputs ?? []).some((i) => i.name === input && i.link != null);
}

/** 读 UI 节点某 widget 的当前值；被连线占用/越界返回 undefined */
export function readWidgetValue(node: UiNode, input: string, objectInfo: Record<string, any>): unknown {
  if (isLinked(node, input)) return undefined;
  const idx = widgetIndexOf(node, input, objectInfo);
  if (idx === undefined) return undefined;
  const wv = node.widgets_values ?? [];
  return idx < wv.length ? wv[idx] : undefined;
}

/** 把补丁写到 widgets_values 对应位（就地修改 nodes 数组；只动命中格，其余原样） */
export function applyParamPatches(
  ui: UiGraph,
  patches: ParamPatch[],
  objectInfo: Record<string, any>,
): { applied: ParamPatch[]; orphaned: ParamPatch[]; skipped: Array<ParamPatch & { reason: string }> } {
  const byId = new Map(ui.nodes.map((n) => [String(n.id), n]));
  const applied: ParamPatch[] = [];
  const orphaned: ParamPatch[] = [];
  const skipped: Array<ParamPatch & { reason: string }> = [];
  for (const p of patches) {
    const node = byId.get(p.nodeId);
    if (!node) {
      orphaned.push(p); // 节点已被 ComfyUI 侧删除（规格 FR-009：进孤立列表，不硬写）
      continue;
    }
    if (isLinked(node, p.input)) {
      skipped.push({ ...p, reason: "该输入已改为连线（值由上游决定）" });
      continue;
    }
    const idx = widgetIndexOf(node, p.input, objectInfo);
    if (idx === undefined) {
      skipped.push({ ...p, reason: "在当前节点定义里找不到该参数（自定义节点可能已更新）" });
      continue;
    }
    const wv = (node.widgets_values ??= []);
    while (wv.length < idx) wv.push(null); // 布局变长时补位，防越界写
    wv[idx] = p.value;
    applied.push(p);
  }
  return { applied, orphaned, skipped };
}

export type PatchConflict = {
  patch: ParamPatch;
  /** 上次同步时的值（双方共同基线） */
  baseValue: unknown;
  /** ComfyUI 源文件里的当前值 */
  sourceValue: unknown;
  /** MOMO 侧要写的新值 */
  momoValue: unknown;
};

/**
 * 字段级冲突检测（规格 FR-015）：源也改了同一字段且与新值不同 → 冲突。
 * 只有 MOMO 改 / 只有源改 / 双方改成一样 → 不冲突（自动合并）。
 */
export function detectPatchConflicts(
  ui: UiGraph,
  patches: ParamPatch[],
  baseValues: Record<string, unknown>,
  objectInfo: Record<string, any>,
): PatchConflict[] {
  const byId = new Map(ui.nodes.map((n) => [String(n.id), n]));
  const out: PatchConflict[] = [];
  for (const p of patches) {
    const node = byId.get(p.nodeId);
    if (!node || isLinked(node, p.input)) continue; // 孤儿/连线占用由 apply 阶段处理
    const sourceValue = readWidgetValue(node, p.input, objectInfo);
    const baseValue = baseValues[p.key];
    if (sourceValue === undefined || sourceValue === baseValue) continue; // 源没改这个字段
    if (sourceValue !== p.value) out.push({ patch: p, baseValue, sourceValue, momoValue: p.value });
  }
  return out;
}

/**
 * 节点稳定 ID 注入（规格 §10.3）：properties.momoSyncNodeId，只在缺失时补；
 * 必须保留节点原有全部属性。返回是否有改动（决定要不要计入写回内容）。
 */
export function injectStableNodeIds(ui: UiGraph, newId: () => string): boolean {
  let changed = false;
  for (const n of ui.nodes) {
    if (n.properties && typeof n.properties.momoSyncNodeId === "string") continue;
    n.properties = { ...(n.properties ?? {}), momoSyncNodeId: newId() };
    changed = true;
  }
  return changed;
}

/** 从模板 params 值表算补丁：与基线不同的项（值全等比较） */
export function patchesFromValues(
  params: Array<{ key: string; nodeId: string; input: string; value: unknown; label?: string }>,
  baseValues: Record<string, unknown>,
): ParamPatch[] {
  return params
    .filter((p) => p.key in baseValues && !valuesEqual(baseValues[p.key], p.value))
    .map((p) => ({ key: p.key, nodeId: p.nodeId, input: p.input, value: p.value, label: p.label }));
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
