import { create } from "zustand";
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
} from "@xyflow/react";
import type { AppNode, BoardMeta, NodeKind, PortType } from "../types";
import { uid } from "../utils";
import { loadJSON, saveJSON } from "../persist";
import { STYLE_CATEGORIES } from "../stylePresets";

/* ---------- 节点默认数据 ---------- */
export function defaultData(kind: NodeKind): Record<string, unknown> {
  switch (kind) {
    case "image":
      return { status: "idle" };
    case "prompt":
      return { status: "idle", text: "" };
    case "chat":
      return { status: "idle", messages: [], draft: "", webSearch: false, showThinking: true };
    case "imageGen":
      return { status: "idle", prompt: "", size: "default", count: 1, results: [], picked: 0 };
    case "videoGen":
      return { status: "idle", prompt: "" };
    case "comfy":
      return { status: "idle", params: {}, results: [], picked: 0 };
    case "caption":
      return { status: "idle", mode: "prompt", result: "" };
    case "llmText":
      return { status: "idle", op: "optimize", custom: "", result: "" };
    case "combine":
      return { status: "idle", separator: "comma", extra: "" };
    case "stylePreset":
      return { status: "idle", category: STYLE_CATEGORIES[0], selected: [] };
    case "note":
      return { status: "idle", text: "", color: "yellow" };
    case "group":
      return { status: "idle" };
  }
}

/* ---------- 端口能力 ---------- */
export function outPortType(kind: NodeKind): PortType | null {
  switch (kind) {
    case "image":
    case "imageGen":
    case "comfy":
      return "image";
    case "prompt":
    case "chat":
    case "caption":
    case "llmText":
    case "combine":
    case "stylePreset":
      return "text";
    case "videoGen":
    case "note":
    case "group": // 组有 out-text / out-image 两个出口，走专门逻辑
      return null;
  }
}

/** 各节点的输入端口能力（自动连线 / 快速添加过滤共用） */
export const NODE_INPUTS: Record<NodeKind, { text?: boolean; image?: boolean }> = {
  image: {},
  prompt: {},
  stylePreset: {},
  note: {},
  chat: { text: true, image: true },
  imageGen: { text: true, image: true },
  videoGen: { text: true, image: true },
  comfy: { text: true, image: true },
  caption: { image: true },
  llmText: { text: true },
  combine: { text: true },
  group: {},
};

export const NODE_LABEL: Record<NodeKind, string> = {
  image: "图片",
  prompt: "提示词",
  chat: "对话",
  imageGen: "生成图像",
  videoGen: "生成视频",
  comfy: "ComfyUI",
  caption: "反推描述",
  llmText: "文本处理",
  combine: "拼接文本",
  stylePreset: "风格预设",
  note: "备注",
  group: "组",
};

type BoardRecord = { meta: BoardMeta; nodes: AppNode[]; edges: Edge[] };

type PersistShape = {
  order: string[];
  activeId: string;
  boards: Record<string, BoardRecord>;
};

type Snapshot = { nodes: AppNode[]; edges: Edge[] };

type BoardState = {
  loaded: boolean;
  boards: Record<string, BoardRecord>;
  order: string[];
  activeId: string;
  nodes: AppNode[];
  edges: Edge[];
  canUndo: boolean;
  canRedo: boolean;

  init: () => Promise<void>;
  onNodesChange: (changes: NodeChange<AppNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (conn: Connection) => void;
  addNode: (kind: NodeKind, pos: { x: number; y: number }, init?: Record<string, unknown>) => string;
  updateData: (id: string, patch: Record<string, unknown>) => void;
  removeNode: (id: string) => void;
  duplicateNode: (id: string) => void;
  connectNodes: (source: string, target: string, targetHandle: string, sourceHandle?: string) => void;
  /** 拖拽结束后：贴近左右两侧的节点自动连线 */
  proximityConnect: (id: string) => void;
  /** 把当前多选的节点打包成一个组（组框大小匹配所选范围） */
  groupSelected: () => void;
  /** 在画布指定区域建组：区域内节点入组并自动排布 */
  groupInRect: (rect: { x: number; y: number; w: number; h: number }) => void;
  /** 忽略/恢复所选节点（忽略的节点半透明，不向下游传递数据） */
  toggleIgnoreSelected: () => void;
  /** 选中与矩形（flow 坐标）相交的连线（Ctrl 框选连线用） */
  selectEdgesInRect: (rect: { x: number; y: number; w: number; h: number }) => void;
  snapshot: () => void;
  undo: () => void;
  redo: () => void;

  newBoard: () => void;
  switchBoard: (id: string) => void;
  renameBoard: (id: string, name: string) => void;
  deleteBoard: (id: string) => void;
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let initOnce: Promise<void> | null = null;
let past: Snapshot[] = [];
let future: Snapshot[] = [];
let lastSnapAt = 0;

function makeBoard(name: string): BoardRecord {
  return { meta: { id: uid(8), name, updatedAt: Date.now() }, nodes: [], edges: [] };
}

/** 载入时清洗：运行态重置、失效的 blob 链接清空 */
function sanitizeNodes(nodes: AppNode[]): AppNode[] {
  return nodes.map((n) => {
    const d = { ...(n.data as Record<string, unknown>) };
    if (d.status === "running") d.status = "idle";
    d.progress = undefined;
    if (typeof d.resultUrl === "string" && d.resultUrl.startsWith("blob:")) d.resultUrl = undefined;
    return { ...n, data: d };
  });
}

export function edgeClassFor(port: PortType | null): string {
  return port ? `edge-${port}` : "";
}

/** 线段与矩形是否相交（Liang-Barsky 裁剪），用于框选连线 */
function segIntersectsRect(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  r: { x: number; y: number; w: number; h: number },
): boolean {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return (
    clip(-dx, p1.x - r.x) &&
    clip(dx, r.x + r.w - p1.x) &&
    clip(-dy, p1.y - r.y) &&
    clip(dy, r.y + r.h - p1.y)
  );
}

/** 连 source→target 是否会成环（target 沿下游已能回到 source，含互连） */
export function wouldCycle(edges: Edge[], source: string, target: string): boolean {
  if (source === target) return true;
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === source) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const e of edges) if (e.source === cur) stack.push(e.target);
  }
  return false;
}

/* ---------- 贴近/覆盖 自动连线 ---------- */
const PROX_GAP_MAX = 130; // 左右贴近的最大间距
const PROX_V_OVERLAP = 24; // 需要的最小纵向重叠
const PROX_SNAP_GAP = 48; // 覆盖放置后自动摆开的间距

type ProxPair = { up: AppNode; down: AppNode; sourceHandle: string; targetHandle: string; overlap: boolean; dist: number };

/** up→down 是否可连（端口类型匹配、尚无同款边、不会成环），可连则返回两端端口 */
function linkHandles(
  up: AppNode,
  down: AppNode,
  edges: Edge[],
  nodes: AppNode[],
): { sourceHandle: string; targetHandle: string } | null {
  if (down.type === "group") return null;
  const ins = NODE_INPUTS[down.type as NodeKind];
  let sourceHandle = "out";
  let targetHandle: string | null = null;
  if (up.type === "group") {
    // 组：按成员构成与下游能力选择文本/图片出口
    const members = nodes.filter((n) => n.parentId === up.id);
    const hasText = members.some((m) => outPortType(m.type as NodeKind) === "text");
    const hasImage = members.some((m) => outPortType(m.type as NodeKind) === "image");
    targetHandle = ins.text && hasText ? "in-text" : ins.image && hasImage ? "in-image" : null;
    if (!targetHandle) return null;
    sourceHandle = targetHandle === "in-text" ? "out-text" : "out-image";
  } else {
    const pt = outPortType(up.type as NodeKind);
    if (!pt || pt === "video") return null;
    targetHandle = pt === "image" ? (ins.image ? "in-image" : null) : ins.text ? "in-text" : null;
    if (!targetHandle) return null;
  }
  if (edges.some((e) => e.source === up.id && e.target === down.id && e.targetHandle === targetHandle)) return null;
  if (wouldCycle(edges, up.id, down.id)) return null;
  return { sourceHandle, targetHandle };
}

/** 找到被拖节点最合适的连线对象：贴近左右两侧，或直接拖到节点上方（按中心决定方向） */
export function findProximityPair(nodes: AppNode[], edges: Edge[], id: string): ProxPair | null {
  const moved = nodes.find((n) => n.id === id);
  // 组内成员坐标是相对父级的，不参与贴近连线
  if (!moved?.measured?.width || moved.parentId) return null;
  const mb = { x: moved.position.x, y: moved.position.y, w: moved.measured.width ?? 0, h: moved.measured.height ?? 0 };
  let best: ProxPair | null = null;
  const consider = (up: AppNode, down: AppNode, overlap: boolean, dist: number) => {
    if (best && dist >= best.dist) return;
    const h = linkHandles(up, down, edges, nodes);
    if (h) best = { up, down, ...h, overlap, dist };
  };
  for (const other of nodes) {
    if (other.id === id || !other.measured?.width || other.parentId) continue;
    const ob = { x: other.position.x, y: other.position.y, w: other.measured.width ?? 0, h: other.measured.height ?? 0 };
    const vOverlap = Math.min(mb.y + mb.h, ob.y + ob.h) - Math.max(mb.y, ob.y);
    if (vOverlap < PROX_V_OVERLAP) continue;
    const hOverlap = Math.min(mb.x + mb.w, ob.x + ob.w) - Math.max(mb.x, ob.x);
    // 组框只支持左右侧贴连线，叠放到组上语义不明确，跳过
    if (hOverlap > 16 && other.type !== "group" && moved.type !== "group") {
      // 直接拖到节点上方：中心偏左 → 被拖节点作上游，反之作下游；首选方向不可连则试反向
      const movedLeft = mb.x + mb.w / 2 <= ob.x + ob.w / 2;
      const dist = Math.abs(mb.x + mb.w / 2 - (ob.x + ob.w / 2));
      consider(movedLeft ? moved : other, movedLeft ? other : moved, true, dist);
      consider(movedLeft ? other : moved, movedLeft ? moved : other, true, dist + 0.1);
    } else {
      const gapFromLeft = mb.x - (ob.x + ob.w); // other 在左侧 → other 为上游
      if (gapFromLeft >= -16 && gapFromLeft <= PROX_GAP_MAX) consider(other, moved, false, Math.abs(gapFromLeft));
      const gapFromRight = ob.x - (mb.x + mb.w); // other 在右侧 → moved 为上游
      if (gapFromRight >= -16 && gapFromRight <= PROX_GAP_MAX) consider(moved, other, false, Math.abs(gapFromRight));
    }
  }
  return best;
}

export const useBoard = create<BoardState>((set, get) => {
  const persist = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const { boards, order, activeId, nodes, edges, loaded } = get();
      if (!loaded) return;
      const cur = boards[activeId];
      if (!cur) return;
      const next: PersistShape = {
        order,
        activeId,
        boards: { ...boards, [activeId]: { ...cur, meta: { ...cur.meta, updatedAt: Date.now() }, nodes, edges } },
      };
      set({ boards: next.boards });
      void saveJSON("boards.json", "v1", next);
    }, 700);
  };

  const clearHistory = () => {
    past = [];
    future = [];
    set({ canUndo: false, canRedo: false });
  };

  const snapshot = () => {
    // 同一动作可能触发多个变更回调（如删节点连带删边），300ms 内合并为一步
    const now = Date.now();
    if (now - lastSnapAt < 300) return;
    lastSnapAt = now;
    past.push({ nodes: get().nodes, edges: get().edges });
    if (past.length > 60) past.shift();
    future = [];
    set({ canUndo: true, canRedo: false });
  };

  return {
    loaded: false,
    boards: {},
    order: [],
    activeId: "",
    nodes: [],
    edges: [],
    canUndo: false,
    canRedo: false,

    // StrictMode 下 App 会挂载两次：init 必须单例，否则并发创建两个画布互相覆盖
    init: () =>
      (initOnce ??= (async () => {
        const saved = await loadJSON<PersistShape>("boards.json", "v1");
        if (saved && saved.order?.length && saved.boards) {
          const activeId = saved.boards[saved.activeId] ? saved.activeId : saved.order[0];
          const cur = saved.boards[activeId];
          set({
            boards: saved.boards,
            order: saved.order,
            activeId,
            nodes: sanitizeNodes(cur?.nodes ?? []),
            edges: cur?.edges ?? [],
            loaded: true,
          });
          return;
        }
        const b = makeBoard("画布 1");
        set({ boards: { [b.meta.id]: b }, order: [b.meta.id], activeId: b.meta.id, nodes: [], edges: [], loaded: true });
      })()),

    snapshot,

    undo: () => {
      const snap = past.pop();
      if (!snap) return;
      future.push({ nodes: get().nodes, edges: get().edges });
      set({ nodes: snap.nodes, edges: snap.edges, canUndo: past.length > 0, canRedo: true });
      persist();
    },

    redo: () => {
      const snap = future.pop();
      if (!snap) return;
      past.push({ nodes: get().nodes, edges: get().edges });
      set({ nodes: snap.nodes, edges: snap.edges, canUndo: true, canRedo: future.length > 0 });
      persist();
    },

    onNodesChange: (changes) => {
      if (changes.some((c) => c.type === "remove")) snapshot();
      let nodes = get().nodes;
      // 删除组 = 解散：xyflow 会把成员一并列入删除，这里拦下成员的删除并转回绝对坐标
      const removedGroups = changes
        .filter((c) => c.type === "remove")
        .map((c) => nodes.find((n) => n.id === (c as { id: string }).id))
        .filter((n): n is AppNode => !!n && n.type === "group");
      if (removedGroups.length) {
        const childIds = new Set(
          nodes.filter((n) => n.parentId && removedGroups.some((g) => g.id === n.parentId)).map((n) => n.id),
        );
        changes = changes.filter((c) => !(c.type === "remove" && childIds.has((c as { id: string }).id)));
        for (const g of removedGroups) {
          nodes = nodes.map((n) =>
            n.parentId === g.id
              ? {
                  ...n,
                  parentId: undefined,
                  extent: undefined,
                  position: { x: n.position.x + g.position.x, y: n.position.y + g.position.y },
                }
              : n,
          );
        }
      }
      set({ nodes: applyNodeChanges(changes, nodes) });
      persist();
    },

    onEdgesChange: (changes) => {
      if (changes.some((c) => c.type === "remove")) snapshot();
      set({ edges: applyEdgeChanges(changes, get().edges) });
      persist();
    },

    onConnect: (conn) => {
      snapshot();
      const src = get().nodes.find((n) => n.id === conn.source);
      const port =
        src?.type === "group"
          ? conn.sourceHandle === "out-image"
            ? ("image" as const)
            : ("text" as const)
          : src
            ? outPortType(src.type as NodeKind)
            : null;
      set({
        edges: addEdge({ ...conn, id: `e_${uid(8)}`, className: edgeClassFor(port), interactionWidth: 28 }, get().edges),
      });
      persist();
    },

    connectNodes: (source, target, targetHandle, sourceHandle = "out") => {
      const src = get().nodes.find((n) => n.id === source);
      const port =
        src?.type === "group"
          ? sourceHandle === "out-image"
            ? ("image" as const)
            : ("text" as const)
          : src
            ? outPortType(src.type as NodeKind)
            : null;
      set({
        edges: addEdge(
          { source, target, sourceHandle, targetHandle, id: `e_${uid(8)}`, className: edgeClassFor(port), interactionWidth: 28 },
          get().edges,
        ),
      });
      persist();
    },

    proximityConnect: (id) => {
      const { nodes, edges, connectNodes } = get();
      const best = findProximityPair(nodes, edges, id);
      if (!best) return;
      snapshot();
      if (best.overlap) {
        // 直接拖到节点上方松手：把被拖节点自动摆到上游/下游一侧再连线
        const moved = nodes.find((n) => n.id === id)!;
        const isDown = best.down.id === id;
        const anchor = isDown ? best.up : best.down;
        const newX = isDown
          ? anchor.position.x + (anchor.measured?.width ?? 0) + PROX_SNAP_GAP
          : anchor.position.x - (moved.measured?.width ?? 0) - PROX_SNAP_GAP;
        const newY = Math.abs(moved.position.y - anchor.position.y) < 24 ? anchor.position.y : moved.position.y;
        set({
          nodes: get().nodes.map((n) => (n.id === id ? { ...n, position: { x: newX, y: newY } } : n)),
        });
      }
      connectNodes(best.up.id, best.down.id, best.targetHandle, best.sourceHandle);
    },

    groupSelected: () => {
      const { nodes } = get();
      const sel = nodes.filter((n) => n.selected && n.type !== "group" && !n.parentId);
      if (sel.length < 2) return;
      snapshot();
      const PAD = 26;
      const HEAD = 40;
      const minX = Math.min(...sel.map((n) => n.position.x)) - PAD;
      const minY = Math.min(...sel.map((n) => n.position.y)) - PAD - HEAD;
      const maxX = Math.max(...sel.map((n) => n.position.x + (n.measured?.width ?? 260))) + PAD;
      const maxY = Math.max(...sel.map((n) => n.position.y + (n.measured?.height ?? 140))) + PAD;
      const gid = `n_${uid(8)}`;
      const group: AppNode = {
        id: gid,
        type: "group",
        position: { x: minX, y: minY },
        data: { status: "idle" },
        style: { width: maxX - minX, height: maxY - minY },
        selected: true,
      };
      const selIds = new Set(sel.map((n) => n.id));
      set({
        nodes: [
          ...nodes.filter((n) => !selIds.has(n.id)).map((n) => ({ ...n, selected: false })),
          group,
          ...sel.map((n) => ({
            ...n,
            selected: false,
            parentId: gid,
            extent: "parent" as const,
            position: { x: n.position.x - minX, y: n.position.y - minY },
          })),
        ],
      });
      persist();
    },

    groupInRect: (rect) => {
      const { nodes } = get();
      const inside = nodes.filter((n) => {
        if (n.type === "group" || n.parentId || !n.measured?.width) return false;
        const cx = n.position.x + (n.measured.width ?? 0) / 2;
        const cy = n.position.y + (n.measured.height ?? 0) / 2;
        return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
      });
      snapshot();
      const PAD = 26;
      const HEAD = 40;
      const GAP = 18;
      const gid = `n_${uid(8)}`;
      // 成员按原位置（上→下、左→右）排序后，在组内纵向自动排布
      const sorted = [...inside].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
      let y = HEAD + PAD;
      let maxW = 0;
      const placed = sorted.map((n) => {
        const node = { ...n, selected: false, parentId: gid, extent: "parent" as const, position: { x: PAD, y } };
        y += (n.measured?.height ?? 140) + GAP;
        maxW = Math.max(maxW, n.measured?.width ?? 260);
        return node;
      });
      const w = Math.max(rect.w, maxW + PAD * 2, 240);
      const h = Math.max(inside.length ? y - GAP + PAD : rect.h, 150);
      const group: AppNode = {
        id: gid,
        type: "group",
        position: { x: rect.x, y: rect.y },
        data: { status: "idle" },
        style: { width: w, height: h },
        selected: true,
      };
      const ids = new Set(inside.map((n) => n.id));
      set({
        nodes: [...get().nodes.filter((n) => !ids.has(n.id)).map((n) => ({ ...n, selected: false })), group, ...placed],
      });
      persist();
    },

    toggleIgnoreSelected: () => {
      const { nodes } = get();
      const sel = nodes.filter((n) => n.selected && n.type !== "group");
      if (!sel.length) return;
      snapshot();
      const allIgnored = sel.every((n) => (n.data as Record<string, unknown>).ignored);
      const ids = new Set(sel.map((n) => n.id));
      set({
        nodes: nodes.map((n) => (ids.has(n.id) ? { ...n, data: { ...n.data, ignored: !allIgnored } } : n)),
      });
      persist();
    },

    selectEdgesInRect: (rect) => {
      const { nodes, edges } = get();
      const abs = (n: AppNode) => {
        const p = n.parentId ? nodes.find((x) => x.id === n.parentId) : undefined;
        return { x: n.position.x + (p?.position.x ?? 0), y: n.position.y + (p?.position.y ?? 0) };
      };
      const hit = new Set<string>();
      for (const e of edges) {
        const s = nodes.find((n) => n.id === e.source);
        const t = nodes.find((n) => n.id === e.target);
        if (!s?.measured?.width || !t?.measured?.width) continue;
        const sp = abs(s);
        const tp = abs(t);
        const p1 = {
          x: sp.x + (s.measured.width ?? 0),
          y: sp.y + (s.type === "group" ? (e.sourceHandle === "out-image" ? 58 : 26) : (s.measured.height ?? 0) / 2),
        };
        const p2 = { x: tp.x, y: tp.y + (e.targetHandle === "in-image" ? 58 : 26) };
        if (segIntersectsRect(p1, p2, rect)) hit.add(e.id);
      }
      if (!hit.size) return;
      set({ edges: edges.map((e) => (hit.has(e.id) ? { ...e, selected: true } : e)) });
    },

    addNode: (kind, pos, init) => {
      snapshot();
      const id = `n_${uid(8)}`;
      const node: AppNode = {
        id,
        type: kind,
        position: pos,
        data: { ...defaultData(kind), ...(init ?? {}) },
        selected: false,
      };
      set({ nodes: [...get().nodes.map((n) => ({ ...n, selected: false })), { ...node, selected: true }] });
      persist();
      return id;
    },

    updateData: (id, patch) => {
      set({
        nodes: get().nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)),
      });
      persist();
    },

    removeNode: (id) => {
      snapshot();
      const target = get().nodes.find((n) => n.id === id);
      let nodes = get().nodes;
      if (target?.type === "group") {
        // 删除组 = 解散：成员转回绝对坐标保留在画布上
        nodes = nodes.map((n) =>
          n.parentId === id
            ? {
                ...n,
                parentId: undefined,
                extent: undefined,
                position: { x: n.position.x + target.position.x, y: n.position.y + target.position.y },
              }
            : n,
        );
      }
      set({
        nodes: nodes.filter((n) => n.id !== id),
        edges: get().edges.filter((e) => e.source !== id && e.target !== id),
      });
      persist();
    },

    duplicateNode: (id) => {
      const src = get().nodes.find((n) => n.id === id);
      if (!src) return;
      snapshot();
      const d = { ...(src.data as Record<string, unknown>) };
      if (d.status === "running") d.status = "idle";
      const copy: AppNode = {
        ...src,
        id: `n_${uid(8)}`,
        position: { x: src.position.x + 40, y: src.position.y + 40 },
        data: d,
        selected: true,
      };
      set({ nodes: [...get().nodes.map((n) => ({ ...n, selected: false })), copy] });
      persist();
    },

    newBoard: () => {
      const { boards, order, activeId, nodes, edges } = get();
      const stash = { ...boards, [activeId]: { ...boards[activeId], nodes, edges } };
      const b = makeBoard(`画布 ${order.length + 1}`);
      clearHistory();
      set({
        boards: { ...stash, [b.meta.id]: b },
        order: [...order, b.meta.id],
        activeId: b.meta.id,
        nodes: [],
        edges: [],
      });
      persist();
    },

    switchBoard: (id) => {
      const { boards, activeId, nodes, edges } = get();
      if (id === activeId || !boards[id]) return;
      const stash = { ...boards, [activeId]: { ...boards[activeId], nodes, edges } };
      const next = stash[id];
      clearHistory();
      set({ boards: stash, activeId: id, nodes: sanitizeNodes(next.nodes), edges: next.edges });
      persist();
    },

    renameBoard: (id, name) => {
      const { boards } = get();
      if (!boards[id]) return;
      set({ boards: { ...boards, [id]: { ...boards[id], meta: { ...boards[id].meta, name } } } });
      persist();
    },

    deleteBoard: (id) => {
      const { boards, order, activeId } = get();
      if (order.length <= 1) return;
      const nextOrder = order.filter((x) => x !== id);
      const nextBoards = { ...boards };
      delete nextBoards[id];
      if (id === activeId) {
        const nid = nextOrder[0];
        const nb = nextBoards[nid];
        clearHistory();
        set({
          boards: nextBoards,
          order: nextOrder,
          activeId: nid,
          nodes: sanitizeNodes(nb.nodes),
          edges: nb.edges,
        });
      } else {
        set({ boards: nextBoards, order: nextOrder });
      }
      persist();
    },
  };
});
