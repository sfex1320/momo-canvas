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
  connectNodes: (source: string, target: string, targetHandle: string) => void;
  /** 拖拽结束后：贴近左右两侧的节点自动连线 */
  proximityConnect: (id: string) => void;
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

type ProxPair = { up: AppNode; down: AppNode; handle: string; overlap: boolean; dist: number };

/** up→down 是否可连（端口类型匹配、尚无同款边、不会成环），可连则返回目标端口 */
function linkHandle(up: AppNode, down: AppNode, edges: Edge[]): string | null {
  const pt = outPortType(up.type as NodeKind);
  if (!pt || pt === "video") return null;
  const ins = NODE_INPUTS[down.type as NodeKind];
  const handle = pt === "image" ? (ins.image ? "in-image" : null) : ins.text ? "in-text" : null;
  if (!handle) return null;
  if (edges.some((e) => e.source === up.id && e.target === down.id && e.targetHandle === handle)) return null;
  if (wouldCycle(edges, up.id, down.id)) return null;
  return handle;
}

/** 找到被拖节点最合适的连线对象：贴近左右两侧，或直接拖到节点上方（按中心决定方向） */
export function findProximityPair(nodes: AppNode[], edges: Edge[], id: string): ProxPair | null {
  const moved = nodes.find((n) => n.id === id);
  if (!moved?.measured?.width) return null;
  const mb = { x: moved.position.x, y: moved.position.y, w: moved.measured.width ?? 0, h: moved.measured.height ?? 0 };
  let best: ProxPair | null = null;
  const consider = (up: AppNode, down: AppNode, overlap: boolean, dist: number) => {
    if (best && dist >= best.dist) return;
    const handle = linkHandle(up, down, edges);
    if (handle) best = { up, down, handle, overlap, dist };
  };
  for (const other of nodes) {
    if (other.id === id || !other.measured?.width) continue;
    const ob = { x: other.position.x, y: other.position.y, w: other.measured.width ?? 0, h: other.measured.height ?? 0 };
    const vOverlap = Math.min(mb.y + mb.h, ob.y + ob.h) - Math.max(mb.y, ob.y);
    if (vOverlap < PROX_V_OVERLAP) continue;
    const hOverlap = Math.min(mb.x + mb.w, ob.x + ob.w) - Math.max(mb.x, ob.x);
    if (hOverlap > 16) {
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
      set({ nodes: applyNodeChanges(changes, get().nodes) });
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
      const port = src ? outPortType(src.type as NodeKind) : null;
      set({
        edges: addEdge({ ...conn, id: `e_${uid(8)}`, className: edgeClassFor(port), interactionWidth: 28 }, get().edges),
      });
      persist();
    },

    connectNodes: (source, target, targetHandle) => {
      const src = get().nodes.find((n) => n.id === source);
      const port = src ? outPortType(src.type as NodeKind) : null;
      set({
        edges: addEdge(
          { source, target, sourceHandle: "out", targetHandle, id: `e_${uid(8)}`, className: edgeClassFor(port), interactionWidth: 28 },
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
      connectNodes(best.up.id, best.down.id, best.handle);
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
      set({
        nodes: get().nodes.filter((n) => n.id !== id),
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
