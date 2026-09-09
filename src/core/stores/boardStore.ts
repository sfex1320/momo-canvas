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
import type { AppNode, BoardMeta, GroupData, NodeKind, PortType } from "../types";
import { uid } from "../utils";
import { loadJSON, loadJSONChecked, saveJSON } from "../persist";
import { externalizeBoards, gcBlobs, hydrateBoards } from "../blobStore";
import { STYLE_CATEGORIES } from "../stylePresets";
import { useUi } from "./uiStore";
import { genPrefFor, useGenPref } from "./genPrefStore";
import { useDirector } from "./directorStore";

/** 拖动吸附对齐的阈值（flow 坐标 px） */
const ALIGN_SNAP = 6;
/** 拖出脱组的越界阈值：成员拖离组框超过该距离才脱组（防止贴边微调时误脱） */
const GROUP_ESCAPE = 96;

/* ---------- 节点默认数据 ---------- */
export function defaultData(kind: NodeKind): Record<string, unknown> {
  switch (kind) {
    case "image":
    case "video":
    case "audio":
      return { status: "idle" };
    case "audioGen":
      return { status: "idle", text: "" };
    case "videoDub":
      return { status: "idle", mode: "replace" };
    case "prompt":
      return { status: "idle", text: "" };
    case "chat":
      return { status: "idle", messages: [], draft: "", webSearch: false, showThinking: true };
    case "imageGen":
      return { status: "idle", prompt: "", size: "default", count: 1, results: [], picked: 0 };
    case "videoGen":
      return { status: "idle", prompt: "" };
    case "storyboard":
      return { status: "idle", story: "", count: 4, shotSec: 5, style: "", tone: "", shots: [] };
    case "enhanceLocal":
      return { status: "idle", preset: "balanced", target: "4k", tileSize: 0, detailStrength: 0, contentMode: "auto", dejpeg: "auto", bitDepth: 8, faceRestore: "identity", outputFormat: "png" };
    case "vectorize":
      return { status: "idle", preset: "auto", colorMode: "auto", hierarchical: "stacked", colorPrecision: 0, filterSpeckle: 0, pathPrecision: 2, geometry: false, quality: "balanced" };
    case "comfy":
      return { status: "idle", params: {}, results: [], picked: 0 };
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
        deliverables: ["turnaround", "expressions", "outfits", "portrait", "sheet"],
        prompts: {},
        results: {},
      };
    case "ecomImage":
      return {
        status: "idle",
        outMode: "image",
        mode: "product",
        sliceCount: 6,
        aspect: "3:4",
        styleTone: "",
        h5StyleTone: "",
        productDesc: "",
        userRefs: [],
        slides: [],
      };
    case "director":
      return { status: "idle" };
  }
}

/* ---------- 端口能力 ---------- */
/** 节点输出端口类型；打光/多角度/角色卡按输出模式（出图/提示词）动态切换，需传入节点 data */
export function outPortType(kind: NodeKind, data?: Record<string, unknown>): PortType | null {
  switch (kind) {
    case "image":
    case "imageGen":
    case "enhanceLocal":
      return "image";
    case "vectorize":
      return null; // 矢量产物是 SVG（导出用），不作位图串到下游（避免 SVG 喂超分解码失败）
    case "comfy": {
      // 最近一次只产出视频（如 SeedVR2 放大）→ 视频出口；否则图片出口
      const vids = (data?.videoResults as string[] | undefined)?.length ?? 0;
      const imgs = (data?.results as string[] | undefined)?.length ?? 0;
      return vids && !imgs ? "video" : "image";
    }
    case "relight":
    case "multiAngle":
    case "charCard":
    case "ecomImage":
      return data?.outMode === "prompt" ? "text" : "image";
    case "prompt":
    case "chat":
    case "llmText":
    case "combine":
    case "stylePreset":
    case "storyboard":
      return "text";
    case "video":
    case "videoGen":
    case "videoDub":
      return "video";
    case "audio":
    case "audioGen":
      return "audio";
    case "note":
    case "group": // 组有 out-text / out-image 两个出口，走专门逻辑
      return null;
    case "director":
      // 有成片输出时是视频口；尚未导出时不向下游传值（返回 null）
      return data?.outputUrl ? "video" : null;
  }
}

/** 各节点的输入端口能力（自动连线 / 快速添加过滤共用） */
export const NODE_INPUTS: Record<NodeKind, { text?: boolean; image?: boolean; video?: boolean; audio?: boolean }> = {
  image: {},
  video: {},
  audio: {},
  audioGen: { text: true },
  videoDub: { video: true, audio: true },
  prompt: {},
  stylePreset: {},
  note: {},
  chat: { text: true, image: true },
  imageGen: { text: true, image: true },
  videoGen: { text: true, image: true, video: true, audio: true },
  comfy: { text: true, image: true, video: true },
  llmText: { text: true, image: true },
  combine: { text: true },
  group: {},
  relight: { text: true, image: true },
  multiAngle: { text: true, image: true },
  charCard: { text: true, image: true },
  ecomImage: { text: true, image: true },
  storyboard: { text: true, image: true },
  enhanceLocal: { image: true },
  vectorize: { image: true },
  director: { text: true, image: true, video: true, audio: true },
};

/** 成组自动排布时的类别顺序：输入 → 智能处理 → 生成 → 备注 */
const KIND_RANK: Record<NodeKind, number> = {
  image: 0,
  video: 0.5,
  audio: 0.6,
  prompt: 1,
  stylePreset: 2,
  chat: 3,
  llmText: 5,
  combine: 6,
  storyboard: 6.5,
  imageGen: 7,
  relight: 8,
  multiAngle: 9,
  enhanceLocal: 8.5,
  vectorize: 8.6,
  charCard: 10,
  ecomImage: 10.5,
  videoGen: 11,
  audioGen: 11.5,
  videoDub: 11.6,
  comfy: 12,
  note: 13,
  group: 14,
  director: 15,
};
function kindRank(kind: NodeKind): number {
  return KIND_RANK[kind] ?? 99;
}

export const NODE_LABEL: Record<NodeKind, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  audioGen: "生成音频",
  videoDub: "视频配音",
  prompt: "提示词",
  chat: "对话",
  imageGen: "生成图像",
  videoGen: "生成视频",
  comfy: "ComfyUI",
  llmText: "文本处理",
  combine: "拼接文本",
  stylePreset: "风格预设",
  note: "备注",
  group: "组",
  relight: "打光",
  multiAngle: "多角度",
  charCard: "角色卡",
  ecomImage: "电商长图",
  storyboard: "分镜",
  enhanceLocal: "超清放大",
  vectorize: "智能矢量",
  director: "导演台",
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
  /** 悬浮工具条「编辑处理」：在该节点下游新建一个处理节点（尺寸/裁剪/增强/扩图/重绘…）并连线、选中 */
  spawnEdit: (srcId: string, kind: NodeKind) => void;
  /** 插入一段现成子图（模板实例化/播种用）：一次快照、整体入画布并选中 */
  insertFragment: (nodes: AppNode[], edges: Edge[]) => void;
  updateData: (id: string, patch: Record<string, unknown>, opts?: { commit?: boolean; result?: boolean; bumpRev?: boolean }) => void;
  removeNode: (id: string) => void;
  duplicateNode: (id: string) => void;
  /** Alt+拖拽复制：整体复制给定节点（选中组时成员一并复制、组内互相连线保留、跨选集连线不带），
   *  副本落在原位置（调用方随即拖动副本），返回 旧id→新id 映射；一次快照 = 一步撤销 */
  cloneNodes: (ids: string[]) => Map<string, string>;
  connectNodes: (source: string, target: string, targetHandle: string, sourceHandle?: string) => void;
  /** 拖拽结束后：鼠标命中/贴近两侧的节点自动连线（mouse 为松手时指针的画布坐标） */
  proximityConnect: (id: string, mouse?: { x: number; y: number } | null) => void;
  /** 把当前多选的节点打包成一个组（组框大小匹配所选范围） */
  groupSelected: () => void;
  /** 在画布指定区域建组：区域内节点入组并自动排布 */
  groupInRect: (rect: { x: number; y: number; w: number; h: number }) => void;
  /** 重排组内成员（瀑布流）并重算组框尺寸——成员拖动/尺寸变化后自适应 */
  relayoutGroup: (gid: string) => void;
  /** 组框自适应成员（只扩不缩）：成员拖动/尺寸变化后由组节点自动调用，解决「元素过大被固定区域关住」 */
  fitGroupToMembers: (gid: string) => void;
  /** 图层组原位摆放：按「成员 id → 组内坐标」映射写成员位置并设定组框尺寸（元素拆解「位置即语义」布局） */
  placeGroupMembers: (gid: string, pos: Record<string, { x: number; y: number }>, size: { w: number; h: number }, recordUndo?: boolean) => void;
  /** 忽略/恢复所选节点（忽略的节点半透明，不向下游传递数据） */
  toggleIgnoreSelected: () => void;
  /** 快捷键强制对齐：≥2 个所选顶层节点按主轴对齐（横向铺开 → 顶对齐成一排；纵向铺开 → 左对齐成一列）；单选吸到 20px 网格 */
  alignSelected: () => void;
  /** 选中与矩形（flow 坐标）相交的连线（Ctrl 框选连线用） */
  selectEdgesInRect: (rect: { x: number; y: number; w: number; h: number }) => void;
  /** 解散所选的组（成员保留） */
  ungroupSelected: () => void;
  snapshot: () => void;
  undo: () => void;
  /** 导演台 undo/redo 恢复：把快照里 director 节点的项目从归档移回 */
  restoreDirectorProjects: (nodes: AppNode[]) => void;
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
/** 保护模式：boards.json 读取失败且备份也救不回来时置位——本次运行不再写盘，
 *  以免一次保存把可能还能手工抢救的数据整份覆盖（settings 有三层回退，画布以前一层都没有） */
let protectMode = false;
/** 滚动备份节流：最多每 10 分钟随主保存写一份 */
let lastRollingBackup = 0;
const BACKUP_ROLLING = "boards.backup.rolling.json";
const BACKUP_STARTUP = "boards.backup.startup.json";
/** 落盘序号：externalize 是异步深走，慢的旧快照不能覆盖新快照 */
let saveSeq = 0;
/** 拖动最后一帧的吸附偏移：松手那次 position 变更要复用它，否则节点弹回未吸附坐标 */
let lastSnap: { ids: Set<string>; dx: number; dy: number } | null = null;
let initOnce: Promise<void> | null = null;
let past: Snapshot[] = [];
let future: Snapshot[] = [];
let lastSnapAt = 0;
let lastSoftSnapAt = 0; // 文本/参数编辑的软快照节流：1 秒内合并为一步，避免逐字入历史

function makeBoard(name: string): BoardRecord {
  return { meta: { id: uid(8), name, updatedAt: Date.now() }, nodes: [], edges: [] };
}

/** 上次退出时任务还在运行中的提示语（载入时标注，让中断可见而不是静默消失） */
export const INTERRUPTED_MSG =
  "任务中断：生成进行中应用被关闭或重启，结果未能写回（服务商可能已扣费）。请重新运行";

/** 已删除的节点类型：旧画布载入时直接丢弃（连着相关边一起清掉） */
const REMOVED_KINDS = new Set(["frame", "videoTrim", "videoConcat", "matting"]);

/** 已改为「节点上直接编辑」的旧编辑节点类型 + 已下线的宫格节点：旧画布载入时转成图片节点（结果图落进去，来源写进名字） */
const LEGACY_EDIT_LABEL: Record<string, string> = {
  inpaint: "局部重绘",
  outpaint: "扩图",
  enhance: "高清增强",
  crop: "聚焦裁剪",
  resize: "尺寸调整",
  grid: "宫格",
};

/** 载入时清洗：运行中的任务标记为中断错误、失效的 blob 链接清空、已删除的节点类型丢弃、反推描述迁移进文本处理
 *  @param markInterrupted 仅跨进程载入（init）时为 true；切换画布时本会话的任务还在跑，不能标成中断 */
function sanitizeNodes(nodes: AppNode[], markInterrupted = true): { nodes: AppNode[]; freshlyInterrupted: number } {
  let freshlyInterrupted = 0;
  const out: AppNode[] = [];
  for (const n of nodes) {
    if (REMOVED_KINDS.has(n.type as string)) continue;
    let type = n.type;
    let d = { ...(n.data as Record<string, unknown>) };
    // 反推描述已并入文本处理：mode → op（节点 id 不变，连线保留）
    if (type === ("caption" as string)) {
      type = "llmText" as typeof type;
      d.op = ({ prompt: "capPrompt", detail: "capDetail", tags: "capTags" } as Record<string, string>)[d.mode as string] ?? "capPrompt";
      d.mode = undefined;
      d.custom = d.custom ?? "";
    }
    // 旧编辑节点（局部重绘/扩图/增强/裁剪/尺寸）与已下线的宫格节点 → 图片节点：整图保留为节点内容
    if (LEGACY_EDIT_LABEL[type as string]) {
      const results = d.results as string[] | undefined;
      const src = (d.src as string | undefined) ?? (d.result as string | undefined) ?? results?.[(d.picked as number | undefined) ?? 0];
      d = { status: src ? "done" : "idle", src, name: LEGACY_EDIT_LABEL[type as string] };
      type = "image" as typeof type;
    }
    if (d.status === "running" && markInterrupted) {
      d.status = "error";
      d.error = INTERRUPTED_MSG;
      // 只统计"这次载入新检测到的"中断；避免持久化的 error 字段导致每次启动重复弹窗+报错音
      freshlyInterrupted++;
    }
    // 运行中的任务（切板场景）保留进度显示，别把正在跑的节点擦成空白
    if (d.status !== "running") {
      d.progress = undefined;
      d.progressPct = undefined;
    }
    if (typeof d.resultUrl === "string" && d.resultUrl.startsWith("blob:")) d.resultUrl = undefined;
    // 视频/音频节点的 blob 源 / ComfyUI 的 blob 视频结果同样跨会话失效
    if ((type === "video" || type === "audio") && typeof d.src === "string" && d.src.startsWith("blob:")) d.src = undefined;
    if (Array.isArray(d.videoResults)) {
      const keep = (d.videoResults as string[]).filter((u) => typeof u === "string" && !u.startsWith("blob:"));
      d.videoResults = keep.length ? keep : undefined;
    }
    out.push({ ...n, type, data: d });
  }
  return { nodes: out, freshlyInterrupted };
}

/** 老的细分端口句柄 → 统一单口（输入 in / 输出 out）。
 *  分镜 shot-N 子端口原样保留；角色卡 dl-xx 子端口已取消（统一单口输出整套素材），迁移为 out。幂等：已是 in/out 不再变动。 */
const IN_HANDLE_LEGACY = new Set(["in-text", "in-image", "in-video", "in-audio"]);
const OUT_HANDLE_LEGACY = new Set(["out-text", "out-image", "out-video"]);
function normInHandle(h?: string | null): string {
  return h && IN_HANDLE_LEGACY.has(h) ? "in" : h ?? "in";
}
function normOutHandle(h?: string | null): string {
  if (h && (OUT_HANDLE_LEGACY.has(h) || h.startsWith("dl-"))) return "out";
  return h ?? "out";
}

/** 连线清洗：丢弃两端已不存在的边；把老画布细分句柄迁移到统一单口；
 *  单口后同一(源,源句柄,目标)只保留一条——老画布里同对多类型边会塌缩，避免重影（分镜 shot-N 因源句柄不同仍可并存）；
 *  句柄非法（如目标句柄写成了 out/随机值）的边 React Flow 不会渲染但数据还在——表现为「传入 N 却看不见线」的幽灵边，一并丢弃。 */
function sanitizeEdges(edges: Edge[], nodes: AppNode[]): Edge[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // 无输入口的类型（源素材/便签）：指向它们的边一律是旧数据残留（如旧编辑节点转成图片节点后的入边），丢弃；
  // 分镜切片图片节点（storyTile）带可见输入口（连线来自原图，纯溯源展示），例外保留
  const noInput = new Set(
    nodes
      .filter(
        (n) =>
          n.type !== "group" &&
          !Object.keys(NODE_INPUTS[n.type as NodeKind] ?? {}).length &&
          !(n.data as Record<string, unknown> | undefined)?.storyTile,
      )
      .map((n) => n.id),
  );
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    if (noInput.has(e.target)) continue;
    const sh = normOutHandle(e.sourceHandle);
    const th = normInHandle(e.targetHandle);
    // 句柄存在性校验：源句柄只有 out；目标句柄 in 或分镜 shot-N（否则该边画不出来）
    if (sh !== "out") continue;
    if (th !== "in" && !(byId.get(e.target)!.type === "storyboard" && /^shot-\d+$/.test(th))) continue;
    const key = `${e.source}|${sh}|${e.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sh === e.sourceHandle && th === e.targetHandle ? e : { ...e, sourceHandle: sh, targetHandle: th });
  }
  return out;
}

/** 端口统一单色后，连线不再按类型上色；保留函数供旧调用点引用，统一返回空类名 */
export function edgeClassFor(_port: PortType | null): string {
  return "";
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
export function wouldCycle(edges: Edge[], source: string, target: string, nodes?: AppNode[]): boolean {
  if (source === target) return true;
  // 组也是一条数据通路：组的输出 = 成员输出的聚合，所以「组 → 成员」同样算一条隐式边，
  // 只看连线会漏掉「成员 → 外部 → 本组」这类经由组成员关系闭合的环
  const groupKids = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  for (const n of nodes ?? []) {
    if (!n.parentId) continue;
    parentOf.set(n.id, n.parentId);
    const arr = groupKids.get(n.parentId) ?? [];
    arr.push(n.id);
    groupKids.set(n.parentId, arr);
  }
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === source) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const e of edges) if (e.source === cur) stack.push(e.target);
    // 组 → 其成员（组的输出来自成员）
    for (const k of groupKids.get(cur) ?? []) stack.push(k);
    // 成员 → 所属组（成员的输出会经组出口向下游传）
    const p = parentOf.get(cur);
    if (p) stack.push(p);
  }
  return false;
}

/* ---------- 贴近/覆盖 自动连线 ---------- */
const PROX_GAP_MAX = 24; // 左右贴近的最大间距（需要接触或几乎贴上才判定连线）
const PROX_V_OVERLAP = 32; // 需要的最小纵向重叠
const PROX_SNAP_GAP = 48; // 覆盖放置后自动摆开的间距

/* 组节点瀑布流排布常量（3 列最短列优先，成员按高度填充最矮列） */
const GP_PAD = 28; // 组内左右内边距
const GP_HEAD = 44; // 标题栏预留高度
const GP_GAP_X = 24; // 列间距（横向，防撞车）
const GP_GAP_Y = 26; // 行间距（纵向）
const GP_COL_W = 280; // 固定列宽
const GP_COLS_MAX = 3; // 最大列数

type ProxPair = { up: AppNode; down: AppNode; sourceHandle: string; targetHandle: string; overlap: boolean; dist: number };

/** up→down 是否可连（单口统一：up 能产出、down 有输入、尚无同款边、不会成环） */
function linkHandles(
  up: AppNode,
  down: AppNode,
  edges: Edge[],
  nodes: AppNode[],
): { sourceHandle: string; targetHandle: string } | null {
  if (down.type === "group") return null; // 组不能作下游
  const ins = NODE_INPUTS[down.type as NodeKind];
  if (!ins || Object.keys(ins).length === 0) return null; // 下游无输入能力
  if (up.type === "group") {
    // 组：有成员即可（成员产出类型由 runner 按各自 nodeOutput 分流）
    if (!nodes.some((n) => n.parentId === up.id)) return null;
  } else if (!outPortType(up.type as NodeKind, up.data as Record<string, unknown>)) {
    return null; // 上游无输出
  }
  // 单口：同一(源,目标)只一条边（源句柄固定 out）
  if (edges.some((e) => e.source === up.id && e.target === down.id)) return null;
  if (wouldCycle(edges, up.id, down.id, nodes as AppNode[])) return null;
  return { sourceHandle: "out", targetHandle: "in" };
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

/** 组成员瀑布流排布（最短列优先，最多 3 列，超宽成员跨 2 列）；返回成员相对组的位置 + 组尺寸 */
function layoutMembers(members: AppNode[]): { placed: { id: string; position: { x: number; y: number } }[]; groupW: number; groupH: number } {
  const cols = Math.min(GP_COLS_MAX, Math.max(1, Math.ceil(Math.sqrt(members.length))));
  const colX = Array.from({ length: cols }, (_, i) => GP_PAD + i * (GP_COL_W + GP_GAP_X));
  const colBottomY = new Array(cols).fill(GP_HEAD + GP_GAP_Y);
  const placed: { id: string; position: { x: number; y: number } }[] = [];
  for (const n of members) {
    const w = n.measured?.width ?? 260;
    const h = n.measured?.height ?? 140;
    const spans = w > GP_COL_W * 1.4 && cols >= 2 ? 2 : 1; // 超宽成员跨 2 列
    let bestCol = 0;
    let bestY = Infinity;
    for (let c = 0; c <= cols - spans; c++) {
      if (colBottomY[c] < bestY) { bestY = colBottomY[c]; bestCol = c; }
    }
    placed.push({ id: n.id, position: { x: colX[bestCol], y: colBottomY[bestCol] } });
    const newBottom = colBottomY[bestCol] + h + GP_GAP_Y;
    for (let c = bestCol; c < bestCol + spans; c++) colBottomY[c] = newBottom;
  }
  const groupW = GP_PAD * 2 + cols * GP_COL_W + (cols - 1) * GP_GAP_X;
  const groupH = Math.max(...colBottomY) - GP_GAP_Y + GP_PAD;
  return { placed, groupW, groupH };
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
      // 序号守卫：externalize 耗时随图量波动，慢的旧快照不能覆盖已经落盘的新快照
      const mySeq = ++saveSeq;
      void externalizeBoards(next).then(async (out) => {
        if (mySeq !== saveSeq) return; // 已有更新的保存发起，丢弃这一份
        if (protectMode) return; // 保护模式：数据现场保持原样，等用户手工处理
        await saveJSON("boards.json", "v1", out);
        // 滚动备份：跟着主保存走、10 分钟节流一份（外置大图只存引用壳，备份几乎不占空间）
        if (Date.now() - lastRollingBackup > 10 * 60_000) {
          lastRollingBackup = Date.now();
          void saveJSON(BACKUP_ROLLING, "v1", out);
        }
      });
    }, 700);
  };

  const clearHistory = () => {
    past = [];
    future = [];
    set({ canUndo: false, canRedo: false });
  };

  /**
   * 快照瘦身：清掉一份快照里的媒体大字段（results/src/视频等 dataURL）。
   * 撤销历史占内存的大头是图片；undo 回 30 步以内图片完整，更早的步骤结构与文本参数仍在。
   * 只替换该快照数组内的节点对象，不影响其它快照/当前画布共享的原对象。
   */
  const stripMedia = (snap: { nodes: AppNode[]; edges: Edge[] }) => {
    snap.nodes = snap.nodes.map((n) => {
      const d = n.data as Record<string, unknown> | undefined;
      if (!d) return n;
      let changed = false;
      const nd: Record<string, unknown> = { ...d };
      for (const k of ["results", "src", "textOut", "videoResults"]) {
        if (k in nd) {
          nd[k] = undefined;
          changed = true;
        }
      }
      return changed ? { ...n, data: nd } : n;
    });
  };

  const snapshot = () => {
    // 同一动作可能触发多个变更回调（如删节点连带删边），300ms 内合并为一步
    const now = Date.now();
    if (now - lastSnapAt < 300) return;
    lastSnapAt = now;
    past.push({ nodes: get().nodes, edges: get().edges });
    if (past.length > 60) past.shift();
    if (past.length > 30) stripMedia(past[0]);
    future = [];
    set({ canUndo: true, canRedo: false });
  };

  /** 文本/参数编辑的软快照：1 秒内的连续编辑合并为一步撤销，避免逐字污染历史栈 */
  const snapshotSoft = () => {
    const now = Date.now();
    if (now - lastSoftSnapAt < 1000) return;
    lastSoftSnapAt = now;
    past.push({ nodes: get().nodes, edges: get().edges });
    if (past.length > 60) past.shift();
    if (past.length > 30) stripMedia(past[0]);
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
        // 区分「没存过」与「读坏了」：读坏了绝不能当首次启动——那样第一次落盘就会覆盖全部画布
        const res = await loadJSONChecked<PersistShape>("boards.json", "v1");
        let raw = res.ok ? res.value : null;
        let restoredFrom: string | null = null;
        if (!res.ok) {
          for (const f of [BACKUP_ROLLING, BACKUP_STARTUP]) {
            const b = await loadJSONChecked<PersistShape>(f, "v1");
            if (b.ok && b.value?.order?.length && b.value.boards) {
              raw = b.value;
              restoredFrom = f === BACKUP_ROLLING ? "滚动备份" : "上次启动备份";
              break;
            }
          }
          if (!raw) protectMode = true;
          const { pushError } = await import("./uiStore");
          pushError(
            "画布数据",
            restoredFrom
              ? `boards.json 读取失败（${res.reason.slice(0, 120)}），已自动从${restoredFrom}恢复画布`
              : `boards.json 读取失败（${res.reason.slice(0, 120)}），且没有可用备份。已进入保护模式：本次运行的改动不会写盘，避免覆盖可能还能抢救的数据——请到 AppData 目录手工备份 boards.json 后重启`,
          );
        }
        // 外置的大图引用回填；并顺手清理不再被引用的外置文件
        const saved = raw ? await hydrateBoards(raw) : null;
        if (raw && !protectMode) {
          // GC 的引用集合要把备份也算进去：只扫主文件会把"仅备份还引用"的图当孤儿删掉，备份就废了
          const rawRef = raw;
          void (async () => {
            const shapes: unknown[] = [rawRef];
            for (const f of [BACKUP_ROLLING, BACKUP_STARTUP]) {
              const b = await loadJSON<PersistShape>(f, "v1");
              if (b) shapes.push(b);
            }
            void gcBlobs(shapes);
          })();
          // 每次启动留一份"上一个已知良好状态"：本次会话中途写坏也有得退
          void saveJSON(BACKUP_STARTUP, "v1", rawRef);
        }
        if (saved && saved.order?.length && saved.boards) {
          const activeId = saved.boards[saved.activeId] ? saved.activeId : saved.order[0];
          const cur = saved.boards[activeId];
          const { nodes, freshlyInterrupted } = sanitizeNodes(cur?.nodes ?? []);
          set({
            boards: saved.boards,
            order: saved.order,
            activeId,
            archived: saved.archived ?? {},
            nodes,
            edges: sanitizeEdges(cur?.edges ?? [], nodes),
            loaded: true,
          });
          // 上次退出时有任务在运行 → 明确告知，而不是静默消失。
          // 只对"这次新检测到的中断"弹一次（freshlyInterrupted），不再扫持久的 error 字段——
          // 否则首次标记后 error 被落盘，之后每次启动都会重复弹窗+报错音（死循环）。
          if (freshlyInterrupted > 0) {
            const { pushError } = await import("./uiStore");
            pushError("任务中断", `检测到 ${freshlyInterrupted} 个任务在上次退出时仍在运行中，已标记为中断（节点上可见），请重新运行`);
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

    // 导演台 undo/redo 恢复：快照里存在的 director 节点，其项目可能因删除时归档了，需移回
    // 同时，快照里不存在但当前画布上的 director 节点被删了，其项目应归档（redo 删除场景）
    // 为简单起见：只处理「快照里有但归档里也有」的情况（移回 projects）
    // （redo 的反向场景由 removeNode 的 archive 触发，不再重复）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    restoreDirectorProjects: (nodes) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const directorIds = (nodes as any[])
        .filter((n) => n.type === "director")
        .map((n) => (n.data as import("../types").DirectorData).projectId)
        .filter(Boolean) as string[];
      if (!directorIds.length) return;
      const s = useDirector.getState();
      const toRestore = s.archived.filter((p) => directorIds.includes(p.id));
      if (toRestore.length) {
        const archived = s.archived.filter((p) => !directorIds.includes(p.id));
        const projects = [...toRestore, ...s.projects];
        useDirector.setState({ archived, projects });
        void saveJSON("director-projects.json", "v1", { projects, archived, schemaVersion: 1 });
      }
    },

    undo: () => {
      const snap = past.pop();
      if (!snap) return;
      future.push({ nodes: get().nodes, edges: get().edges });
      set({ nodes: snap.nodes, edges: snap.edges, canUndo: past.length > 0, canRedo: true });
      // 导演台 undo 恢复：被删的 director 节点回来了，把项目从归档移回
      get().restoreDirectorProjects(snap.nodes);
      persist();
    },

    redo: () => {
      const snap = future.pop();
      if (!snap) return;
      past.push({ nodes: get().nodes, edges: get().edges });
      set({ nodes: snap.nodes, edges: snap.edges, canUndo: true, canRedo: future.length > 0 });
      get().restoreDirectorProjects(snap.nodes);
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
      // 拖动吸附对齐：被拖节点（多选时取包围盒）的 边/中线 靠近其他顶层节点的 边/中线 时吸过去并画参考线
      const dragChanges = changes.filter(
        (c): c is Extract<NodeChange<AppNode>, { type: "position" }> =>
          c.type === "position" && !!c.dragging && !!c.position,
      );
      // 拖出脱组：成员被拖离组框越界超过阈值 → 立即脱组（转绝对坐标），Figma 式「拖出即出组」
      if (dragChanges.length) {
        const escapes = new Map<string, { x: number; y: number }>();
        for (const c of dragChanges) {
          const n = nodes.find((nn) => nn.id === c.id);
          if (!n?.parentId || !c.position) continue;
          const g = nodes.find((gg) => gg.id === n.parentId && gg.type === "group");
          if (!g) continue;
          const gw = Number(g.style?.width) || g.measured?.width || 0;
          const gh = Number(g.style?.height) || g.measured?.height || 0;
          const w = n.measured?.width ?? 0;
          const h = n.measured?.height ?? 0;
          const { x, y } = c.position;
          if (x < -GROUP_ESCAPE || y < -GROUP_ESCAPE || x + w > gw + GROUP_ESCAPE || y + h > gh + GROUP_ESCAPE) {
            escapes.set(n.id, { x: x + g.position.x, y: y + g.position.y });
          }
        }
        if (escapes.size) {
          nodes = nodes.map((n) =>
            escapes.has(n.id) ? { ...n, parentId: undefined, extent: undefined, position: escapes.get(n.id)! } : n,
          );
          // 脱组后坐标系从「相对组」变「绝对」：本轮及松手帧的 position 变更须换成绝对坐标，否则节点会跳回相对位置
          changes = changes.map((c) => {
            const abs = c.type === "position" && c.position ? escapes.get(c.id) : undefined;
            return abs ? { ...c, position: { x: abs.x, y: abs.y } } : c;
          });
        }
      }
      if (dragChanges.length) {
        const ids = new Set(dragChanges.map((c) => c.id));
        const dragged = dragChanges
          .map((c) => ({ c, n: nodes.find((nn) => nn.id === c.id) }))
          .filter((x): x is { c: (typeof dragChanges)[number]; n: AppNode } => !!x.n && !x.n.parentId);
        if (dragged.length) {
          let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
          for (const { c, n } of dragged) {
            bx0 = Math.min(bx0, c.position!.x);
            by0 = Math.min(by0, c.position!.y);
            bx1 = Math.max(bx1, c.position!.x + (n.measured?.width ?? 0));
            by1 = Math.max(by1, c.position!.y + (n.measured?.height ?? 0));
          }
          const bcx = (bx0 + bx1) / 2;
          const bcy = (by0 + by1) / 2;
          const vLines: number[] = [];
          const hLines: number[] = [];
          for (const o of nodes) {
            if (ids.has(o.id) || o.parentId) continue;
            const w = o.measured?.width ?? 0;
            const h = o.measured?.height ?? 0;
            vLines.push(o.position.x, o.position.x + w / 2, o.position.x + w);
            hLines.push(o.position.y, o.position.y + h / 2, o.position.y + h);
          }
          let dx: number | null = null;
          let gx: number | null = null;
          for (const L of vLines) {
            for (const edge of [bx0, bcx, bx1]) {
              const d = L - edge;
              if (Math.abs(d) <= ALIGN_SNAP && (dx === null || Math.abs(d) < Math.abs(dx))) {
                dx = d;
                gx = L;
              }
            }
          }
          let dy: number | null = null;
          let gy: number | null = null;
          for (const L of hLines) {
            for (const edge of [by0, bcy, by1]) {
              const d = L - edge;
              if (Math.abs(d) <= ALIGN_SNAP && (dy === null || Math.abs(d) < Math.abs(dy))) {
                dy = d;
                gy = L;
              }
            }
          }
          if (dx !== null || dy !== null) {
            changes = changes.map((c) =>
              c.type === "position" && c.position && ids.has(c.id)
                ? { ...c, position: { x: c.position.x + (dx ?? 0), y: c.position.y + (dy ?? 0) } }
                : c,
            );
            // 记住这一帧的吸附偏移：React Flow 松手时会用它内部的纯指针坐标再发一次
            // dragging=false 的 position 变更，不补上同样的偏移，节点就会原地弹回（吸附白做）
            lastSnap = { ids, dx: dx ?? 0, dy: dy ?? 0 };
          } else {
            lastSnap = null;
          }
          useUi.getState().setAlignGuides(gx !== null || gy !== null ? { x: gx, y: gy } : null);
        }
      } else if (changes.some((c) => c.type === "position")) {
        // 松手（dragging=false 的 position 变更）：补上最后一帧的吸附偏移，再收起参考线
        if (lastSnap) {
          const snap = lastSnap;
          const endIds = changes
            .filter((c): c is Extract<NodeChange<AppNode>, { type: "position" }> => c.type === "position" && !!c.position)
            .map((c) => c.id);
          if (endIds.length && endIds.every((id) => snap.ids.has(id))) {
            changes = changes.map((c) =>
              c.type === "position" && c.position
                ? { ...c, position: { x: c.position.x + snap.dx, y: c.position.y + snap.dy } }
                : c,
            );
          }
          lastSnap = null;
        }
        useUi.getState().setAlignGuides(null);
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
      // 单口统一：连线不再按类型上色（className 留空，走默认 var(--edge)）
      set({
        edges: addEdge({ ...conn, id: `e_${uid(8)}`, className: "", interactionWidth: 28 }, get().edges),
      });
      persist();
    },

    connectNodes: (source, target, targetHandle = "in", sourceHandle = "out") => {
      set({
        edges: addEdge(
          { source, target, sourceHandle, targetHandle, id: `e_${uid(8)}`, className: "", interactionWidth: 28 },
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
      const minX = Math.min(...sel.map((n) => n.position.x));
      const minY = Math.min(...sel.map((n) => n.position.y));
      const gid = `n_${uid(8)}`;
      // 按类别（输入 → 智能 → 生成）再按原位置排序，瀑布流排布（3 列最短列优先）
      const sorted = [...sel].sort(
        (a, b) =>
          kindRank(a.type as NodeKind) - kindRank(b.type as NodeKind) ||
          a.position.y - b.position.y ||
          a.position.x - b.position.x,
      );
      const { placed, groupW, groupH } = layoutMembers(sorted);
      const posById = new Map(placed.map((p) => [p.id, p.position]));
      const placedNodes = sorted.map((n) => ({
        ...n,
        selected: false,
        parentId: gid,
        // 不写 extent:"parent"：成员不再被硬锁在组框内（元素拆解产物常比组框大），越界由 fitGroupToMembers 扩组兜底，拖出脱组在 onNodesChange
        position: posById.get(n.id)!,
      }));
      const group: AppNode = {
        id: gid,
        type: "group",
        position: { x: minX - GP_PAD, y: minY - GP_PAD - GP_HEAD },
        data: { status: "idle" },
        style: { width: groupW, height: groupH },
        selected: true,
      };
      const selIds = new Set(sel.map((n) => n.id));
      set({
        nodes: [...nodes.filter((n) => !selIds.has(n.id)).map((n) => ({ ...n, selected: false })), group, ...placedNodes],
      });
      persist();
    },

    ungroupSelected: () => {
      const groups = get().nodes.filter((n) => n.selected && n.type === "group");
      for (const g of groups) get().removeNode(g.id);
    },

    relayoutGroup: (gid) => {
      const { nodes } = get();
      const g = nodes.find((n) => n.id === gid && n.type === "group");
      if (!g) return;
      // 图层组的 y 序就是图层 z 序，瀑布流重排（kindRank 优先）会打乱层序——直接跳过
      if ((g.data as GroupData).layerGroup) return;
      const members = nodes
        .filter((n) => n.parentId === gid)
        .sort(
          (a, b) =>
            kindRank(a.type as NodeKind) - kindRank(b.type as NodeKind) ||
            a.position.y - b.position.y ||
            a.position.x - b.position.x,
        );
      if (!members.length) return;
      const { placed, groupW, groupH } = layoutMembers(members);
      const posById = new Map(placed.map((p) => [p.id, p.position]));
      set({
        nodes: nodes.map((n) => {
          if (n.id === gid) return { ...n, style: { ...n.style, width: groupW, height: groupH } };
          const np = posById.get(n.id);
          return np && (n.position.x !== np.x || n.position.y !== np.y) ? { ...n, position: np } : n;
        }),
      });
      persist();
    },

    fitGroupToMembers: (gid) => {
      const { nodes } = get();
      const g = nodes.find((n) => n.id === gid && n.type === "group");
      if (!g || (g.data as GroupData).artboard) return;
      const members = nodes.filter((n) => n.parentId === gid);
      if (!members.length) return;
      let maxX = 0;
      let maxY = 0;
      for (const m of members) {
        maxX = Math.max(maxX, m.position.x + (m.measured?.width ?? 0));
        maxY = Math.max(maxY, m.position.y + (m.measured?.height ?? 0));
      }
      const w = Math.max(Number(g.style?.width) || 0, Math.ceil(maxX + GP_PAD));
      const h = Math.max(Number(g.style?.height) || 0, Math.ceil(maxY + GP_PAD));
      const cw = g.style?.width as number | undefined;
      const ch = g.style?.height as number | undefined;
      if (w === cw && h === ch) return;
      set({ nodes: nodes.map((n) => (n.id === gid ? { ...n, style: { ...n.style, width: w, height: h } } : n)) });
      persist();
    },

    placeGroupMembers: (gid, pos, size, recordUndo=true) => {
      const { nodes } = get();
      const g = nodes.find((n) => n.id === gid && n.type === "group");
      if (!g) return;
      if(recordUndo)snapshot();
      set({
        nodes: nodes.map((n) => {
          if (n.id === gid) return { ...n, style: { ...n.style, width: size.w, height: size.h } };
          const p = pos[n.id];
          return p ? { ...n, position: p } : n;
        }),
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
      const gid = `n_${uid(8)}`;
      // 成员按原位置（上→下、左→右）排序后，瀑布流排布
      const sorted = [...inside].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
      const { placed, groupW, groupH } = layoutMembers(sorted);
      const posById = new Map(placed.map((p) => [p.id, p.position]));
      const placedNodes = sorted.map((n) => ({
        ...n,
        selected: false,
        parentId: gid,
        position: posById.get(n.id)!,
      }));
      // 组宽至少容纳瀑布流内容；框选区比内容大时取框宽（成员贴左上，右侧留白）
      const w = Math.max(rect.w, groupW, 240);
      const h = Math.max(inside.length ? groupH : rect.h, 150);
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
        nodes: [...get().nodes.filter((n) => !ids.has(n.id)).map((n) => ({ ...n, selected: false })), group, ...placedNodes],
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

    alignSelected: () => {
      const { nodes } = get();
      const sel = nodes.filter((n) => n.selected && !n.parentId && n.type !== "group");
      if (!sel.length) return;
      snapshot();
      if (sel.length === 1) {
        // 单选：吸到 20px 网格
        const n = sel[0];
        const gx = Math.round(n.position.x / 20) * 20;
        const gy = Math.round(n.position.y / 20) * 20;
        if (gx !== n.position.x || gy !== n.position.y) {
          set({ nodes: nodes.map((x) => (x.id === n.id ? { ...x, position: { x: gx, y: gy } } : x)) });
          persist();
        }
        return;
      }
      // 多选：横向铺开（总宽 > 总高）→ 顶对齐成一排；纵向铺开 → 左对齐成一列
      const minX = Math.min(...sel.map((n) => n.position.x));
      const maxX = Math.max(...sel.map((n) => n.position.x + (n.measured?.width ?? 0)));
      const minY = Math.min(...sel.map((n) => n.position.y));
      const maxY = Math.max(...sel.map((n) => n.position.y + (n.measured?.height ?? 0)));
      const ids = new Set(sel.map((n) => n.id));
      if (maxX - minX >= maxY - minY) {
        set({ nodes: nodes.map((n) => (ids.has(n.id) ? { ...n, position: { x: n.position.x, y: minY } } : n)) });
      } else {
        set({ nodes: nodes.map((n) => (ids.has(n.id) ? { ...n, position: { x: minX, y: n.position.y } } : n)) });
      }
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
        // 单口居中：源/目标端口都位于节点垂直中点
        const p1 = { x: sp.x + (s.measured.width ?? 0), y: sp.y + (s.measured.height ?? 0) / 2 };
        const p2 = { x: tp.x, y: tp.y + (t.measured.height ?? 0) / 2 };
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
        // 全节点参数记忆：用上次同类节点的配置落地（角色卡勾选/便签颜色/打光角度/生成参数等）
        data: { ...defaultData(kind), ...genPrefFor(kind), ...(init ?? {}) },
        selected: false,
      };
      set({ nodes: [...get().nodes.map((n) => ({ ...n, selected: false })), { ...node, selected: true }] });
      persist();
      return id;
    },

    spawnEdit: (srcId, kind) => {
      const s = get();
      const src = s.nodes.find((n) => n.id === srcId);
      if (!src) return;
      snapshot();
      // 组内成员：按绝对坐标摆到组外右侧（处理链脱离组框，不挤组内布局）
      const parent = src.parentId ? s.nodes.find((n) => n.id === src.parentId) : undefined;
      const absX = src.position.x + (parent?.position.x ?? 0);
      const absY = src.position.y + (parent?.position.y ?? 0);
      const w = src.measured?.width ?? 300;
      const id = `n_${uid(8)}`;
      const node: AppNode = {
        id,
        type: kind,
        position: { x: absX + w + 140, y: absY },
        // 与 addNode 一致：编辑链节点（打光/矢量/超清…）也用上次参数落地
        data: { ...defaultData(kind), ...genPrefFor(kind) },
        selected: true,
      };
      set({
        nodes: [...s.nodes.map((n) => ({ ...n, selected: false })), node],
        edges: addEdge(
          { source: srcId, target: id, sourceHandle: "out", targetHandle: "in", id: `e_${uid(8)}`, className: "", interactionWidth: 28 },
          s.edges,
        ),
      });
      persist();
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

    updateData: (id, patch, opts) => {
      // commit:true = 用户主动编辑（提示词文本等），入历史栈可撤销；运行结果等程序化写入默认不入
      if (opts?.commit) snapshotSoft();
      // rev：脏标记计数器。result=true（runner 写回 status/results/progress/inputSig 等）不增；
      // bumpRev=true 强制 +1；缺省（UI 改提示词/参数）+1。下游据此判断「上游是否已变更」
      const merge = (oldData: Record<string, unknown>): Record<string, unknown> => {
        const d: Record<string, unknown> = { ...oldData, ...patch };
        if (opts?.bumpRev || (opts?.result !== true && Object.keys(patch).length)) {
          if (!("rev" in patch)) d.rev = ((oldData.rev as number) ?? 0) + 1;
        }
        return d;
      };
      const s = get();
      // 配置记忆：用户主动修改（非 runner 结果写回）时按节点类型记「上次设置」，
      // 新建同类节点由 addNode 的 genPrefFor(kind) 落地；内容/运行态字段在 remember 内过滤
      if (opts?.result !== true) {
        const kind = s.nodes.find((n) => n.id === id)?.type as NodeKind | undefined;
        if (kind) useGenPref.getState().remember(kind, patch, defaultData(kind));
      }
      if (s.nodes.some((n) => n.id === id)) {
        set({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: merge(n.data as Record<string, unknown>) } : n)) });
        persist();
        return;
      }
      // 节点不在当前画布：用户在任务运行期间切走了画布。写回它所属的那张画布，
      // 否则生成结果（已扣费）会静默丢失，切回去还只剩一个「任务中断」的红节点
      const bid = Object.keys(s.boards).find((k) => s.boards[k].nodes.some((n) => n.id === id));
      if (!bid) return;
      const b = s.boards[bid];
      set({
        boards: {
          ...s.boards,
          [bid]: {
            ...b,
            meta: { ...b.meta, updatedAt: Date.now() },
            nodes: b.nodes.map((n) => (n.id === id ? { ...n, data: merge(n.data as Record<string, unknown>) } : n)),
          },
        },
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
      // 导演台节点删除时归档项目（同步调用，避免 undo 竞态，P2-8 修复）
      if (target?.type === "director") {
        const d = target.data as import("../types").DirectorData;
        if (d.projectId) {
          useDirector.getState().archiveProject(d.projectId);
        }
      }
      set({
        nodes: nodes.filter((n) => n.id !== id),
        edges: get().edges.filter((e) => e.source !== id && e.target !== id),
      });
      persist();
    },

    // 复制 = cloneNodes 的薄封装 + 整体平移：组会连成员一起复制、成员间连线保留
    //（旧实现单独 map 一个节点：复制组得到空组、复制组成员会塞回原组并与原件重叠）
    duplicateNode: (id) => {
      const map = get().cloneNodes([id]);
      if (!map.size) return;
      const ids = new Set(map.values());
      set({
        nodes: get().nodes.map((n) =>
          // 组成员（parentId 也在副本集内）用相对坐标，跟着组一起挪，不重复偏移
          ids.has(n.id) && !(n.parentId && ids.has(n.parentId))
            ? { ...n, position: { x: n.position.x + 40, y: n.position.y + 40 } }
            : n,
        ),
      });
      persist();
    },

    cloneNodes: (ids) => {
      const s = get();
      const idSet = new Set(ids);
      // 选中了组 → 成员一并复制（即便没单独选中成员）
      const extraMembers = s.nodes.filter((n) => n.parentId && idSet.has(n.parentId)).map((n) => n.id);
      const allIds = new Set([...ids, ...extraMembers]);
      const sources = s.nodes.filter((n) => allIds.has(n.id));
      const map = new Map<string, string>();
      if (!sources.length) return map;
      snapshot();
      for (const n of sources) map.set(n.id, `n_${uid(8)}`);
      const clones: AppNode[] = sources.map((n) => {
        const d = { ...(n.data as Record<string, unknown>) };
        if (d.status === "running") d.status = "idle";
        // 副本清掉脏标记签名：新节点该重算，不能冒充原件的「上游未变更」
        delete d.inputSig;
        delete d.rev;
        delete d.fallbackModel;
        // 导演台副本清空 projectId，让 DirectorNode 的 effect 自动建新项目（避免两节点共用一个项目）
        if (n.type === "director") {
          delete d.projectId;
          delete d.outputUrl;
          delete d.cover;
        }
        const keepParent = n.parentId && map.has(n.parentId);
        // 组成员单独被复制（组没跟着复制）→ 转绝对坐标落到组外，避免位置错乱
        const parent = n.parentId ? s.nodes.find((x) => x.id === n.parentId) : undefined;
        return {
          ...n,
          id: map.get(n.id)!,
          parentId: keepParent ? map.get(n.parentId!) : undefined,
          extent: keepParent ? n.extent : undefined,
          position: keepParent
            ? { ...n.position }
            : { x: n.position.x + (parent?.position.x ?? 0), y: n.position.y + (parent?.position.y ?? 0) },
          data: d,
          selected: true,
        } as AppNode;
      });
      // 只保留两端都在复制集内的连线（跨选集的连线不带，不干扰原节点的外部连接）
      const cloneEdges = s.edges
        .filter((e) => map.has(e.source) && map.has(e.target))
        .map((e) => ({ ...e, id: `e_${uid(8)}`, source: map.get(e.source)!, target: map.get(e.target)!, selected: false }));
      set({
        nodes: [...s.nodes.map((n) => ({ ...n, selected: false })), ...clones],
        edges: [...s.edges, ...cloneEdges],
      });
      persist();
      return map;
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
      // markInterrupted=false：本会话切走时仍在跑的任务还会继续（updateData 会写回它所属画布），
      // 切回来不能把它误标成「任务中断」
      const { nodes: nextNodes } = sanitizeNodes(next.nodes, false);
      set({ boards: stash, activeId: id, nodes: nextNodes, edges: sanitizeEdges(next.edges, nextNodes) });
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
        const { nodes: nbNodes } = sanitizeNodes(nb.nodes);
        set({
          boards: nextBoards,
          order: nextOrder,
          activeId: nid,
          archived: nextArchived,
          nodes: nbNodes,
          edges: sanitizeEdges(nb.edges, nbNodes),
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
