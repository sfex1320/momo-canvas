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
  }
}

/* ---------- 端口类型 ---------- */
export function outPortType(kind: NodeKind): PortType | null {
  switch (kind) {
    case "image":
    case "imageGen":
    case "comfy":
      return "image";
    case "prompt":
    case "chat":
      return "text";
    case "videoGen":
      return null;
  }
}

export const NODE_LABEL: Record<NodeKind, string> = {
  image: "图片",
  prompt: "提示词",
  chat: "对话",
  imageGen: "生成图像",
  videoGen: "生成视频",
  comfy: "ComfyUI",
};

type BoardRecord = { meta: BoardMeta; nodes: AppNode[]; edges: Edge[] };

type PersistShape = {
  order: string[];
  activeId: string;
  boards: Record<string, BoardRecord>;
};

type BoardState = {
  loaded: boolean;
  boards: Record<string, BoardRecord>;
  order: string[];
  activeId: string;
  nodes: AppNode[];
  edges: Edge[];

  init: () => Promise<void>;
  onNodesChange: (changes: NodeChange<AppNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (conn: Connection) => void;
  addNode: (kind: NodeKind, pos: { x: number; y: number }, init?: Record<string, unknown>) => string;
  updateData: (id: string, patch: Record<string, unknown>) => void;
  removeNode: (id: string) => void;
  duplicateNode: (id: string) => void;
  connectNodes: (source: string, target: string, targetHandle: string) => void;

  newBoard: () => void;
  switchBoard: (id: string) => void;
  renameBoard: (id: string, name: string) => void;
  deleteBoard: (id: string) => void;
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;

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

  return {
    loaded: false,
    boards: {},
    order: [],
    activeId: "",
    nodes: [],
    edges: [],

    init: async () => {
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
    },

    onNodesChange: (changes) => {
      set({ nodes: applyNodeChanges(changes, get().nodes) });
      persist();
    },

    onEdgesChange: (changes) => {
      set({ edges: applyEdgeChanges(changes, get().edges) });
      persist();
    },

    onConnect: (conn) => {
      const src = get().nodes.find((n) => n.id === conn.source);
      const port = src ? outPortType(src.type as NodeKind) : null;
      set({
        edges: addEdge(
          { ...conn, id: `e_${uid(8)}`, className: edgeClassFor(port) },
          get().edges,
        ),
      });
      persist();
    },

    connectNodes: (source, target, targetHandle) => {
      const src = get().nodes.find((n) => n.id === source);
      const port = src ? outPortType(src.type as NodeKind) : null;
      set({
        edges: addEdge(
          { source, target, sourceHandle: "out", targetHandle, id: `e_${uid(8)}`, className: edgeClassFor(port) },
          get().edges,
        ),
      });
      persist();
    },

    addNode: (kind, pos, init) => {
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
      set({
        nodes: get().nodes.filter((n) => n.id !== id),
        edges: get().edges.filter((e) => e.source !== id && e.target !== id),
      });
      persist();
    },

    duplicateNode: (id) => {
      const src = get().nodes.find((n) => n.id === id);
      if (!src) return;
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
