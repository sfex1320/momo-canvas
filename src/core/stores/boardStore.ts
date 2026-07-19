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
import { externalizeBoards, gcBlobs, hydrateBoards } from "../blobStore";
import { STYLE_CATEGORIES } from "../stylePresets";

/* ---------- 节点默认数据 ---------- */
export function defaultData(kind: NodeKind): Record<string, unknown> {
  switch (kind) {
    case "image":
    case "video":
      return { status: "idle" };
    case "prompt":
      return { status: "idle", text: "" };
    case "chat":
      return { status: "idle", messages: [], draft: "", webSearch: false, showThinking: true };
    case "imageGen":
      return { status: "idle", prompt: "", size: "default", count: 1, results: [], picked: 0 };
    case "videoGen":
      return { status: "idle", prompt: "" };
    case "frame":
      return { status: "idle", point: "last" };
    case "storyboard":
      return { status: "idle", story: "", count: 4, shotSec: 5, style: "", tone: "", shots: [] };
    case "videoTrim":
      return { status: "idle", start: 0 };
    case "videoConcat":
      return { status: "idle" };
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
    case "relight":
      return { status: "idle", outMode: "image", azimuth: 0, elevation: 0, brightness: 50, color: "", rim: false, smart: false, results: [], picked: 0 };
    case "multiAngle":
      return { status: "idle", outMode: "image", preset: "custom", yaw: 0, pitch: 0, shot: 2, results: [], picked: 0 };
    case "charCard":
      return {
        status: "idle",
        outMode: "image",
        lang: "zh",
        style: "auto",
        deliverables: ["turnaround", "expressions", "portrait", "sheet"],
        prompts: {},
        results: {},
      };
    case "resize":
      return { status: "idle", mode: "mp", mp: 1, sideRef: "long", sideLen: 1024, scalePct: 50, out: "image" };
    case "inpaint":
      return { status: "idle", prompt: "", count: 1, results: [], picked: 0 };
    case "outpaint":
      return { status: "idle", pads: { left: 0.25, right: 0.25, up: 0, down: 0 }, prompt: "", count: 1, results: [], picked: 0 };
    case "matting":
      return { status: "idle", bg: "transparent", subject: "", results: [], picked: 0 };
    case "enhance":
      return { status: "idle", factor: 2, focus: "detail", results: [], picked: 0 };
    case "crop":
      return { status: "idle" };
  }
}

/* ---------- 端口能力 ---------- */
/** 节点输出端口类型；打光/多角度/角色卡按输出模式（出图/提示词）动态切换，需传入节点 data */
export function outPortType(kind: NodeKind, data?: Record<string, unknown>): PortType | null {
  switch (kind) {
    case "image":
    case "imageGen":
    case "inpaint":
    case "outpaint":
    case "matting":
    case "enhance":
    case "crop":
      return "image";
    case "comfy": {
      // 最近一次只产出视频（如 SeedVR2 放大）→ 视频出口；否则图片出口
      const vids = (data?.videoResults as string[] | undefined)?.length ?? 0;
      const imgs = (data?.results as string[] | undefined)?.length ?? 0;
      return vids && !imgs ? "video" : "image";
    }
    case "relight":
    case "multiAngle":
    case "charCard":
      return data?.outMode === "prompt" ? "text" : "image";
    case "resize":
      // image = 输出处理后的图片；其余样式输出尺寸/比例文本
      return data?.out === "image" || data?.out === undefined ? "image" : "text";
    case "prompt":
    case "chat":
    case "caption":
    case "llmText":
    case "combine":
    case "stylePreset":
    case "storyboard":
      return "text";
    case "video":
    case "videoGen":
    case "videoTrim":
    case "videoConcat":
      return "video";
    case "frame":
      return "image";
    case "note":
    case "group": // 组有 out-text / out-image 两个出口，走专门逻辑
      return null;
  }
}

/** 各节点的输入端口能力（自动连线 / 快速添加过滤共用） */
export const NODE_INPUTS: Record<NodeKind, { text?: boolean; image?: boolean; video?: boolean }> = {
  image: {},
  video: {},
  prompt: {},
  stylePreset: {},
  note: {},
  chat: { text: true, image: true },
  imageGen: { text: true, image: true },
  videoGen: { text: true, image: true, video: true },
  comfy: { text: true, image: true, video: true },
  caption: { image: true },
  llmText: { text: true },
  combine: { text: true },
  group: {},
  relight: { text: true, image: true },
  multiAngle: { text: true, image: true },
  charCard: { text: true, image: true },
  resize: { image: true },
  inpaint: { text: true, image: true },
  outpaint: { text: true, image: true },
  matting: { image: true },
  enhance: { image: true },
  crop: { image: true },
  storyboard: { text: true, image: true },
  frame: { video: true },
  videoTrim: { video: true },
  videoConcat: { video: true },
};

/** 成组自动排布时的类别顺序：输入 → 智能处理 → 生成 → 备注 */
const KIND_RANK: Record<NodeKind, number> = {
  image: 0,
  video: 0.5,
  prompt: 1,
  stylePreset: 2,
  chat: 3,
  caption: 4,
  llmText: 5,
  combine: 6,
  storyboard: 6.5,
  imageGen: 7,
  resize: 7.5,
  crop: 7.6,
  inpaint: 7.7,
  outpaint: 7.8,
  matting: 7.9,
  enhance: 7.95,
  relight: 8,
  multiAngle: 9,
  charCard: 10,
  videoGen: 11,
  frame: 11.2,
  videoTrim: 11.3,
  videoConcat: 11.4,
  comfy: 12,
  note: 13,
  group: 14,
};
function kindRank(kind: NodeKind): number {
  return KIND_RANK[kind] ?? 99;
}

export const NODE_LABEL: Record<NodeKind, string> = {
  image: "图片",
  video: "视频",
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
  relight: "打光",
  multiAngle: "多角度",
  charCard: "角色卡",
  resize: "尺寸调整",
  inpaint: "局部重绘",
  outpaint: "扩图",
  matting: "抠图",
  enhance: "高清增强",
  crop: "聚焦裁剪",
  storyboard: "分镜",
  frame: "视频取帧",
  videoTrim: "视频取段",
  videoConcat: "视频拼接",
};

type BoardRecord = { meta: BoardMeta; nodes: AppNode[]; edges: Edge[] };

type PersistShape = {
  order: string[];
  activeId: string;
  boards: Record<string, BoardRecord>;
  /** 画布历史（关闭的画布，可恢复/彻底删除） */
  archived?: Record<string, BoardRecord>;
};

type Snapshot = { nodes: AppNode[]; edges: Edge[] };

type BoardState = {
  loaded: boolean;
  boards: Record<string, BoardRecord>;
  order: string[];
  activeId: string;
  archived: Record<string, BoardRecord>;
  nodes: AppNode[];
  edges: Edge[];
  canUndo: boolean;
  canRedo: boolean;

  init: () => Promise<void>;
  /** 记录当前画布的视图位置（防抖持久化） */
  setViewport: (vp: { x: number; y: number; zoom: number }) => void;
  onNodesChange: (changes: NodeChange<AppNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (conn: Connection) => void;
  addNode: (kind: NodeKind, pos: { x: number; y: number }, init?: Record<string, unknown>) => string;
  /** 插入一段现成子图（模板实例化/播种用）：一次快照、整体入画布并选中 */
  insertFragment: (nodes: AppNode[], edges: Edge[]) => void;
  updateData: (id: string, patch: Record<string, unknown>) => void;
  removeNode: (id: string) => void;
  duplicateNode: (id: string) => void;
  connectNodes: (source: string, target: string, targetHandle: string, sourceHandle?: string) => void;
  /** 拖拽结束后：鼠标命中/贴近两侧的节点自动连线（mouse 为松手时指针的画布坐标） */
  proximityConnect: (id: string, mouse?: { x: number; y: number } | null) => void;
  /** 把当前多选的节点打包成一个组（组框大小匹配所选范围） */
  groupSelected: () => void;
  /** 在画布指定区域建组：区域内节点入组并自动排布 */
  groupInRect: (rect: { x: number; y: number; w: number; h: number }) => void;
  /** 忽略/恢复所选节点（忽略的节点半透明，不向下游传递数据） */
  toggleIgnoreSelected: () => void;
  /** 选中与矩形（flow 坐标）相交的连线（Ctrl 框选连线用） */
  selectEdgesInRect: (rect: { x: number; y: number; w: number; h: number }) => void;
  /** 解散所选的组（成员保留） */
  ungroupSelected: () => void;
  /** Alt+拖拽开始：原地留一份完整拷贝（含连线），被拖走的成为副本；返回被拖动的节点 id 列表 */
  altDuplicateStart: (dragId: string) => string[] | null;
  snapshot: () => void;
  undo: () => void;
  redo: () => void;
  /** 一键清空当前画布（全部节点与连线；入撤销历史，Ctrl+Z 可整体恢复） */
  clearAll: () => void;

  newBoard: () => void;
  switchBoard: (id: string) => void;
  renameBoard: (id: string, name: string) => void;
  /** 关闭画布 → 移入画布历史（可恢复） */
  archiveBoard: (id: string) => void;
  restoreBoard: (id: string) => void;
  /** 从历史中彻底删除 */
  purgeBoard: (id: string) => void;
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let initOnce: Promise<void> | null = null;
let past: Snapshot[] = [];
let future: Snapshot[] = [];
let lastSnapAt = 0;

function makeBoard(name: string): BoardRecord {
  return { meta: { id: uid(8), name, updatedAt: Date.now() }, nodes: [], edges: [] };
}

/** 上次退出时任务还在运行中的提示语（载入时标注，让中断可见而不是静默消失） */
export const INTERRUPTED_MSG =
  "任务中断：生成进行中应用被关闭或重启，结果未能写回（服务商可能已扣费）。请重新运行";

/** 载入时清洗：运行中的任务标记为中断错误、失效的 blob 链接清空 */
function sanitizeNodes(nodes: AppNode[]): AppNode[] {
  return nodes.map((n) => {
    const d = { ...(n.data as Record<string, unknown>) };
    if (d.status === "running") {
      d.status = "error";
      d.error = INTERRUPTED_MSG;
    }
    d.progress = undefined;
    d.progressPct = undefined;
    if (typeof d.resultUrl === "string" && d.resultUrl.startsWith("blob:")) d.resultUrl = undefined;
    // 视频节点的 blob 源 / ComfyUI 的 blob 视频结果同样跨会话失效
    if (n.type === "video" && typeof d.src === "string" && d.src.startsWith("blob:")) d.src = undefined;
    if (Array.isArray(d.videoResults)) {
      const keep = (d.videoResults as string[]).filter((u) => typeof u === "string" && !u.startsWith("blob:"));
      d.videoResults = keep.length ? keep : undefined;
    }
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
const PROX_GAP_MAX = 24; // 左右贴近的最大间距（需要接触或几乎贴上才判定连线）
const PROX_V_OVERLAP = 32; // 需要的最小纵向重叠
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
    // 组：按成员构成与下游能力选择文本/图片/视频出口
    const members = nodes.filter((n) => n.parentId === up.id);
    const pt = (m: AppNode) => outPortType(m.type as NodeKind, m.data as Record<string, unknown>);
    const hasText = members.some((m) => pt(m) === "text");
    const hasImage = members.some((m) => pt(m) === "image");
    const hasVideo = members.some((m) => pt(m) === "video");
    targetHandle =
      ins.text && hasText ? "in-text" : ins.image && hasImage ? "in-image" : ins.video && hasVideo ? "in-video" : null;
    if (!targetHandle) return null;
    sourceHandle = targetHandle === "in-text" ? "out-text" : targetHandle === "in-image" ? "out-image" : "out-video";
  } else {
    const pt = outPortType(up.type as NodeKind, up.data as Record<string, unknown>);
    if (!pt) return null;
    targetHandle =
      pt === "image" ? (ins.image ? "in-image" : null)
      : pt === "video" ? (ins.video ? "in-video" : null)
      : ins.text ? "in-text" : null;
    if (!targetHandle) return null;
  }
  if (edges.some((e) => e.source === up.id && e.target === down.id && e.targetHandle === targetHandle)) return null;
  if (wouldCycle(edges, up.id, down.id)) return null;
  return { sourceHandle, targetHandle };
}

/** 找到被拖节点最合适的连线对象：鼠标悬到目标节点上（指针在其左半=作上游/右半=作下游），或左右贴近 */
export function findProximityPair(
  nodes: AppNode[],
  edges: Edge[],
  id: string,
  mouse?: { x: number; y: number } | null,
): ProxPair | null {
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
    // 叠放连线以「鼠标指针命中目标节点」为准（此前按矩形重合判定，节点稍一靠近就误触）
    // 组框只支持左右侧贴连线，叠放到组上语义不明确，跳过
    if (
      mouse && other.type !== "group" && moved.type !== "group" &&
      mouse.x >= ob.x && mouse.x <= ob.x + ob.w && mouse.y >= ob.y && mouse.y <= ob.y + ob.h
    ) {
      // 指针在目标左半边 → 被拖节点作上游，右半边 → 作下游；首选方向不可连则试反向
      const movedLeft = mouse.x <= ob.x + ob.w / 2;
      const dist = Math.abs(mouse.x - (ob.x + ob.w / 2));
      consider(movedLeft ? moved : other, movedLeft ? other : moved, true, dist);
      consider(movedLeft ? other : moved, movedLeft ? moved : other, true, dist + 0.1);
      continue;
    }
    // 普通节点之间只按鼠标命中连线；贴近/接触不再自动连（组框保留左右贴近，因为不支持鼠标叠放）
    if (other.type !== "group" && moved.type !== "group") continue;
    const vOverlap = Math.min(mb.y + mb.h, ob.y + ob.h) - Math.max(mb.y, ob.y);
    if (vOverlap < PROX_V_OVERLAP) continue;
    const hOverlap = Math.min(mb.x + mb.w, ob.x + ob.w) - Math.max(mb.x, ob.x);
    // 矩形已重合 → 不判定为贴近，避免误触
    if (hOverlap > 16) continue;
    const gapFromLeft = mb.x - (ob.x + ob.w); // other 在左侧 → other 为上游
    if (gapFromLeft >= -16 && gapFromLeft <= PROX_GAP_MAX) consider(other, moved, false, Math.abs(gapFromLeft));
    const gapFromRight = ob.x - (mb.x + mb.w); // other 在右侧 → moved 为上游
    if (gapFromRight >= -16 && gapFromRight <= PROX_GAP_MAX) consider(moved, other, false, Math.abs(gapFromRight));
  }
  return best;
}

export const useBoard = create<BoardState>((set, get) => {
  const persist = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const { boards, order, activeId, archived, nodes, edges, loaded } = get();
      if (!loaded) return;
      const cur = boards[activeId];
      if (!cur) return;
      const next: PersistShape = {
        order,
        activeId,
        archived,
        boards: { ...boards, [activeId]: { ...cur, meta: { ...cur.meta, updatedAt: Date.now() }, nodes, edges } },
      };
      set({ boards: next.boards });
      // 大 dataURL 外置成文件引用后再落盘：否则 4K 图内联进 JSON，每次保存都全量序列化几十 MB 卡死主线程
      void externalizeBoards(next).then((out) => saveJSON("boards.json", "v1", out));
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
    archived: {},
    nodes: [],
    edges: [],
    canUndo: false,
    canRedo: false,

    // StrictMode 下 App 会挂载两次：init 必须单例，否则并发创建两个画布互相覆盖
    init: () =>
      (initOnce ??= (async () => {
        const raw = await loadJSON<PersistShape>("boards.json", "v1");
        // 外置的大图引用回填；并顺手清理不再被引用的外置文件
        const saved = raw ? await hydrateBoards(raw) : null;
        if (raw) void gcBlobs(raw);
        if (saved && saved.order?.length && saved.boards) {
          const activeId = saved.boards[saved.activeId] ? saved.activeId : saved.order[0];
          const cur = saved.boards[activeId];
          const nodes = sanitizeNodes(cur?.nodes ?? []);
          set({
            boards: saved.boards,
            order: saved.order,
            activeId,
            archived: saved.archived ?? {},
            nodes,
            edges: cur?.edges ?? [],
            loaded: true,
          });
          // 上次退出时有任务在运行 → 明确告知，而不是静默消失
          const cut = nodes.filter((n) => (n.data as Record<string, unknown>).error === INTERRUPTED_MSG).length;
          if (cut) {
            const { pushError } = await import("./uiStore");
            pushError("任务中断", `检测到 ${cut} 个任务在上次退出时仍在运行中，已标记为中断（节点上可见），请重新运行`);
          }
          return;
        }
        const b = makeBoard("画布 1");
        set({ boards: { [b.meta.id]: b }, order: [b.meta.id], activeId: b.meta.id, nodes: [], edges: [], loaded: true });
      })()),

    setViewport: (vp) => {
      const { boards, activeId } = get();
      const cur = boards[activeId];
      if (!cur) return;
      set({ boards: { ...boards, [activeId]: { ...cur, meta: { ...cur.meta, viewport: vp } } } });
      persist();
    },

    snapshot,

    clearAll: () => {
      if (!get().nodes.length && !get().edges.length) return;
      snapshot();
      set({ nodes: [], edges: [] });
      persist();
    },

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
            : conn.sourceHandle === "out-video"
              ? ("video" as const)
              : ("text" as const)
          : src
            ? outPortType(src.type as NodeKind, src.data as Record<string, unknown>)
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
            : sourceHandle === "out-video"
              ? ("video" as const)
              : ("text" as const)
          : src
            ? outPortType(src.type as NodeKind, src.data as Record<string, unknown>)
            : null;
      set({
        edges: addEdge(
          { source, target, sourceHandle, targetHandle, id: `e_${uid(8)}`, className: edgeClassFor(port), interactionWidth: 28 },
          get().edges,
        ),
      });
      persist();
    },

    proximityConnect: (id, mouse) => {
      const { nodes, edges, connectNodes } = get();
      const best = findProximityPair(nodes, edges, id, mouse);
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
      const GAP = 18;
      const minX = Math.min(...sel.map((n) => n.position.x));
      const minY = Math.min(...sel.map((n) => n.position.y));
      const gid = `n_${uid(8)}`;
      // 按类别（输入 → 智能 → 生成）再按原位置排序，在组内纵向等距排布
      const sorted = [...sel].sort(
        (a, b) =>
          kindRank(a.type as NodeKind) - kindRank(b.type as NodeKind) ||
          a.position.y - b.position.y ||
          a.position.x - b.position.x,
      );
      let y = HEAD + PAD;
      let maxW = 0;
      const placed = sorted.map((n) => {
        const node = { ...n, selected: false, parentId: gid, extent: "parent" as const, position: { x: PAD, y } };
        y += (n.measured?.height ?? 140) + GAP;
        maxW = Math.max(maxW, n.measured?.width ?? 260);
        return node;
      });
      const group: AppNode = {
        id: gid,
        type: "group",
        position: { x: minX - PAD, y: minY - PAD - HEAD },
        data: { status: "idle" },
        style: { width: maxW + PAD * 2, height: y - GAP + PAD },
        selected: true,
      };
      const selIds = new Set(sel.map((n) => n.id));
      set({
        nodes: [...nodes.filter((n) => !selIds.has(n.id)).map((n) => ({ ...n, selected: false })), group, ...placed],
      });
      persist();
    },

    ungroupSelected: () => {
      const groups = get().nodes.filter((n) => n.selected && n.type === "group");
      for (const g of groups) get().removeNode(g.id);
    },

    altDuplicateStart: (dragId) => {
      const { nodes, edges } = get();
      const dragged = nodes.find((n) => n.id === dragId);
      if (!dragged || dragged.parentId) return null;
      const base = dragged.selected ? nodes.filter((n) => n.selected && !n.parentId) : [dragged];
      const groupIds = new Set(base.filter((n) => n.type === "group").map((n) => n.id));
      const members = nodes.filter((n) => n.parentId && groupIds.has(n.parentId));
      const all = [...base, ...members];
      snapshot();
      const map = new Map<string, string>();
      for (const n of all) map.set(n.id, `n_${uid(8)}`);
      // 原地留下的完整拷贝（接管全部对外连线）；被拖走的原 id 集合成为“副本”
      const clones: AppNode[] = all.map((n) => ({
        ...n,
        id: map.get(n.id)!,
        selected: false,
        parentId: n.parentId ? (map.get(n.parentId) ?? n.parentId) : undefined,
        data: { ...(n.data as Record<string, unknown>) },
      }));
      const idSet = new Set(all.map((n) => n.id));
      const extraEdges: Edge[] = [];
      const remapped = edges.map((e) => {
        const sIn = idSet.has(e.source);
        const tIn = idSet.has(e.target);
        if (sIn && tIn) {
          // 内部连线：两份都要，保证工作流复制后连线不乱
          extraEdges.push({ ...e, id: `e_${uid(8)}`, source: map.get(e.source)!, target: map.get(e.target)! });
          return e;
        }
        if (sIn) return { ...e, source: map.get(e.source)! };
        if (tIn) return { ...e, target: map.get(e.target)! };
        return e;
      });
      set({ nodes: [...get().nodes, ...clones], edges: [...remapped, ...extraEdges] });
      persist();
      return all.map((n) => n.id);
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

    insertFragment: (nodes, edges) => {
      if (!nodes.length) return;
      snapshot();
      set({
        nodes: [...get().nodes.map((n) => ({ ...n, selected: false })), ...nodes],
        edges: [...get().edges, ...edges],
      });
      persist();
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

    archiveBoard: (id) => {
      const { boards, order, activeId, nodes, edges, archived } = get();
      if (!boards[id]) return;
      // 当前画布内容先落回记录，避免归档到旧快照
      const stash = { ...boards, [activeId]: { ...boards[activeId], nodes, edges } };
      const rec = { ...stash[id], meta: { ...stash[id].meta, updatedAt: Date.now() } };
      const nextBoards = { ...stash };
      delete nextBoards[id];
      let nextOrder = order.filter((x) => x !== id);
      if (!nextOrder.length) {
        const b = makeBoard("画布 1");
        nextBoards[b.meta.id] = b;
        nextOrder = [b.meta.id];
      }
      const nextArchived = { ...archived, [id]: rec };
      if (id === activeId) {
        const nid = nextOrder[0];
        const nb = nextBoards[nid];
        clearHistory();
        set({
          boards: nextBoards,
          order: nextOrder,
          activeId: nid,
          archived: nextArchived,
          nodes: sanitizeNodes(nb.nodes),
          edges: nb.edges,
        });
      } else {
        set({ boards: nextBoards, order: nextOrder, archived: nextArchived });
      }
      persist();
    },

    restoreBoard: (id) => {
      const { archived, boards, order } = get();
      const rec = archived[id];
      if (!rec) return;
      const nextArchived = { ...archived };
      delete nextArchived[id];
      set({ boards: { ...boards, [id]: rec }, order: [...order, id], archived: nextArchived });
      get().switchBoard(id);
      persist();
    },

    purgeBoard: (id) => {
      const nextArchived = { ...get().archived };
      delete nextArchived[id];
      set({ archived: nextArchived });
      persist();
    },
  };
});
