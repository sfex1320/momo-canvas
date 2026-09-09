/**
 * FR-014 差异查看 · 纯逻辑：两份 UI Workflow JSON 的结构化差异
 *  - 节点：新增/删除（id+类型+标题）；同节点参数（widgets_values 逐位）、位置、尺寸变化
 *  - 连线：增删计数 + 明细（源→目标，限 20 条）
 *  - 分组：增删/标题变化
 *  - 顶层未知扩展字段（extra/config/…）变化摘要（键名 + 新旧尺寸）
 * 不需要 object_info 也能出结果（有则把 widgets 位序映射成参数名，可读性更好）。
 */
import { widgetLayoutOf } from "./widgetLayout.ts";
import type { UiGraph, UiNode } from "./writeBack";

export type DiffRow = { kind: "node+" | "node-" | "param" | "move" | "resize" | "link" | "group" | "meta"; text: string; detail?: string };

export type WfDiff = {
  rows: DiffRow[];
  counts: { nodesAdded: number; nodesRemoved: number; params: number; moved: number; resized: number; linksAdded: number; linksRemoved: number; groups: number; meta: number };
};

const num2 = (v: unknown): [number, number] | undefined => {
  if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number") return [v[0], v[1]];
  if (v && typeof v === "object" && typeof (v as any)[0] === "number" && typeof (v as any)[1] === "number")
    return [(v as any)[0], (v as any)[1]];
  return undefined;
};

const nodeLabel = (n: UiNode): string => `#${n.id} ${n.title || n.type}`;

type LinkTuple = [number, number, number, number, number] | { id: number; origin_id: number; origin_slot: number; target_id: number; target_slot: number };

function normLinkKey(l: LinkTuple): string {
  const a = Array.isArray(l) ? l : [l.id, l.origin_id, l.origin_slot, l.target_id, l.target_slot];
  return `${a[1]}.${a[2]}→${a[3]}.${a[4]}`;
}

function normLinkText(l: LinkTuple): string {
  const a = Array.isArray(l) ? l : [l.id, l.origin_id, l.origin_slot, l.target_id, l.target_slot];
  return `#${a[1]}[out${a[2]}] → #${a[3]}[in${a[4]}]`;
}

/** widget 位 → 参数名（尽力而为：object_info 缺该类型时退化为 `值#位`） */
function widgetNameOf(node: UiNode, idx: number, objectInfo?: Record<string, any> | null): string {
  if (!objectInfo) return `参数#${idx}`;
  const layout = widgetLayoutOf(node.type, objectInfo);
  let acc = 0;
  for (const s of layout.slots) {
    if (acc === idx) return s.name;
    acc += s.cag ? 2 : 1;
  }
  return `参数#${idx}`;
}

const fmtV = (v: unknown): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined) return "（空）";
  return s.length > 42 ? `${s.slice(0, 42)}…` : s;
};

export function diffUiWorkflows(a: UiGraph, b: UiGraph, objectInfo?: Record<string, any> | null): WfDiff {
  const rows: DiffRow[] = [];
  const c = { nodesAdded: 0, nodesRemoved: 0, params: 0, moved: 0, resized: 0, linksAdded: 0, linksRemoved: 0, groups: 0, meta: 0 };

  const aById = new Map((a.nodes ?? []).map((n) => [String(n.id), n]));
  const bById = new Map((b.nodes ?? []).map((n) => [String(n.id), n]));

  for (const [id, n] of aById) {
    if (!bById.has(id)) {
      c.nodesRemoved++;
      rows.push({ kind: "node-", text: `删除节点 ${nodeLabel(n)}` });
    }
  }
  for (const [id, n] of bById) {
    if (!aById.has(id)) {
      c.nodesAdded++;
      rows.push({ kind: "node+", text: `新增节点 ${nodeLabel(n)}` });
    }
  }
  for (const [id, aNode] of aById) {
    const bNode = bById.get(id);
    if (!bNode) continue;
    // 参数（widgets_values 逐位）
    const aw = (aNode.widgets_values ?? []) as unknown[];
    const bw = (bNode.widgets_values ?? []) as unknown[];
    const len = Math.max(aw.length, bw.length);
    for (let i = 0; i < len; i++) {
      const va = aw[i];
      const vb = bw[i];
      if (JSON.stringify(va) === JSON.stringify(vb)) continue;
      c.params++;
      const name = widgetNameOf(bNode, i, objectInfo);
      rows.push({ kind: "param", text: `${nodeLabel(bNode)} · ${name}`, detail: `${fmtV(va)} → ${fmtV(vb)}` });
    }
    // 位置 / 尺寸（>1px 才报，避免浮点噪音）
    const pa = num2(aNode.pos);
    const pb = num2(bNode.pos);
    if (pa && pb && (Math.abs(pa[0] - pb[0]) > 1 || Math.abs(pa[1] - pb[1]) > 1)) {
      c.moved++;
      rows.push({ kind: "move", text: `${nodeLabel(bNode)} 移动`, detail: `(${pa[0]}, ${pa[1]}) → (${pb[0]}, ${pb[1]})` });
    }
    const sa = num2(aNode.size);
    const sb = num2(bNode.size);
    if (sa && sb && (Math.abs(sa[0] - sb[0]) > 1 || Math.abs(sa[1] - sb[1]) > 1)) {
      c.resized++;
      rows.push({ kind: "resize", text: `${nodeLabel(bNode)} 尺寸`, detail: `${sa[0]}×${sa[1]} → ${sb[0]}×${sb[1]}` });
    }
  }

  // 连线
  const aLinks = ((a.links ?? []) as LinkTuple[]).map(normLinkKey);
  const bLinks = ((b.links ?? []) as LinkTuple[]).map(normLinkKey);
  const aSet = new Set(aLinks);
  const bSet = new Set(bLinks);
  const removedLinks = ((a.links ?? []) as LinkTuple[]).filter((l) => !bSet.has(normLinkKey(l)));
  const addedLinks = ((b.links ?? []) as LinkTuple[]).filter((l) => !aSet.has(normLinkKey(l)));
  c.linksAdded = addedLinks.length;
  c.linksRemoved = removedLinks.length;
  for (const l of removedLinks.slice(0, 10)) rows.push({ kind: "link", text: `删除连线 ${normLinkText(l)}` });
  for (const l of addedLinks.slice(0, 10)) rows.push({ kind: "link", text: `新增连线 ${normLinkText(l)}` });

  // 分组（标题 + 位置比对，够用）
  const groupKey = (g: unknown) => {
    const t = (g as any)?.title ?? "";
    const b = num2((g as any)?.bounding) ?? [0, 0, 0, 0];
    return `${t}@${b.join(",")}`;
  };
  const aGroups = new Set(((a.groups ?? []) as unknown[]).map(groupKey));
  const bGroups = new Set(((b.groups ?? []) as unknown[]).map(groupKey));
  for (const g of aGroups) if (!bGroups.has(g)) { c.groups++; rows.push({ kind: "group", text: `分组变化：移除「${g.split("@")[0]}」` }); }
  for (const g of bGroups) if (!aGroups.has(g)) { c.groups++; rows.push({ kind: "group", text: `分组变化：新增「${g.split("@")[0]}」` }); }

  // 顶层扩展字段（extra/config/未知键；跳过结构性的 nodes/links/groups 与自增计数）
  const SKIP = new Set(["nodes", "links", "groups", "version", "last_node_id", "last_link_id", "revision", "id"]);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (SKIP.has(k)) continue;
    if (JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
    c.meta++;
    rows.push({ kind: "meta", text: `扩展字段「${k}」变化`, detail: `${fmtV(a[k])} → ${fmtV(b[k])}` });
  }

  return { rows, counts: c };
}

/** 差异摘要一句话（无变化返回 null） */
export function diffSummary(d: WfDiff): string | null {
  const { counts: c } = d;
  const parts: string[] = [];
  if (c.nodesAdded) parts.push(`+${c.nodesAdded} 节点`);
  if (c.nodesRemoved) parts.push(`-${c.nodesRemoved} 节点`);
  if (c.params) parts.push(`${c.params} 参数`);
  if (c.linksAdded) parts.push(`+${c.linksAdded} 连线`);
  if (c.linksRemoved) parts.push(`-${c.linksRemoved} 连线`);
  if (c.moved) parts.push(`${c.moved} 位置`);
  if (c.groups) parts.push(`${c.groups} 分组`);
  if (c.meta) parts.push(`${c.meta} 扩展字段`);
  return parts.length ? parts.join(" · ") : null;
}
