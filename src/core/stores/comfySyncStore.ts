/**
 * Comfy 工作流同步 · 状态与索引持久化
 *  - 来源 / 工作流索引 / 事件日志（最近 120 条）存内存；索引持久化到 comfy-sync.json
 *    （tauri-plugin-store；浏览器预览退回 localStorage）
 *  - UI Workflow 正文与版本快照不在本 store：由 Rust 命令读写 AppData/comfy-sync/，
 *    避免大 JSON 常驻 WebView 内存（规格 NFR-004）
 *  - 落盘带防抖：同步循环会高频 updateWorkflow，500ms 合并一次；来源增删立即落
 */
import { create } from "zustand";
import type { ComfySyncConflict, ComfySyncEventLog, ComfySyncSource, ComfySyncedWorkflow } from "../types";
import { loadJSON, saveJSON } from "../persist";
import { DEFAULT_IGNORE_PATTERNS } from "../comfySync/classify";
import { uid } from "../utils";

const INDEX_FILE = "comfy-sync.json";
const INDEX_KEY = "v1";
const MAX_EVENTS = 120;

type PersistShape = {
  sources?: ComfySyncSource[];
  workflows?: ComfySyncedWorkflow[];
  conflicts?: ComfySyncConflict[];
};

type ComfySyncState = {
  sources: ComfySyncSource[];
  workflows: ComfySyncedWorkflow[];
  conflicts: ComfySyncConflict[];
  events: ComfySyncEventLog[];
  loaded: boolean;
  /** 同步引擎是否已启动（App ready 后由 engine.start() 置位） */
  running: boolean;

  init: () => Promise<void>;
  setRunning: (v: boolean) => void;

  upsertSource: (s: ComfySyncSource) => void;
  patchSource: (id: string, patch: Partial<ComfySyncSource>) => void;
  /** 删除来源：索引里的工作流保留（改挂 detached），正文/模板/画布实例都不动（规格 FR-001） */
  removeSource: (id: string) => void;

  upsertWorkflow: (w: ComfySyncedWorkflow) => void;
  patchWorkflow: (id: string, patch: Partial<ComfySyncedWorkflow>) => void;
  removeWorkflow: (id: string) => void;

  upsertConflict: (c: ComfySyncConflict) => void;
  patchConflict: (id: string, patch: Partial<ComfySyncConflict>) => void;

  log: (e: Omit<ComfySyncEventLog, "id" | "createdAt">) => void;
};

const persistNow = (get: () => ComfySyncState) => {
  const s = get();
  void saveJSON(INDEX_FILE, INDEX_KEY, { sources: s.sources, workflows: s.workflows, conflicts: s.conflicts });
};

let persistTimer: number | null = null;
function schedulePersist(get: () => ComfySyncState) {
  if (persistTimer !== null) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    persistNow(get);
  }, 500);
}

let initOnce: Promise<void> | null = null;

export const useComfySync = create<ComfySyncState>((set, get) => ({
  sources: [],
  workflows: [],
  conflicts: [],
  events: [],
  loaded: false,
  running: false,

  init: () =>
    (initOnce ??= (async () => {
      const saved = await loadJSON<PersistShape>(INDEX_FILE, INDEX_KEY);
      set({
        sources: (saved?.sources ?? []).map((s) => ({
        ...s,
        ignorePatterns: s.ignorePatterns?.length ? s.ignorePatterns : [...DEFAULT_IGNORE_PATTERNS],
        })),
        workflows: saved?.workflows ?? [],
        conflicts: saved?.conflicts ?? [],
        loaded: true,
      });
    })()),

  setRunning: (v) => set({ running: v }),

  upsertSource: (s) => {
    const list = get().sources.filter((x) => x.id !== s.id);
    set({ sources: [...list, s] });
    persistNow(get);
  },

  patchSource: (id, patch) => {
    set({ sources: get().sources.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
    schedulePersist(get);
  },

  removeSource: (id) => {
    set({
      sources: get().sources.filter((s) => s.id !== id),
      workflows: get().workflows.map((w) => (w.sourceId === id ? { ...w, status: "detached" } : w)),
    });
    persistNow(get);
  },

  upsertWorkflow: (w) => {
    const list = get().workflows.filter((x) => x.workflowId !== w.workflowId);
    set({ workflows: [...list, w] });
    schedulePersist(get);
  },

  patchWorkflow: (id, patch) => {
    set({ workflows: get().workflows.map((w) => (w.workflowId === id ? { ...w, ...patch } : w)) });
    schedulePersist(get);
  },

  removeWorkflow: (id) => {
    set({ workflows: get().workflows.filter((w) => w.workflowId !== id) });
    persistNow(get);
  },

  upsertConflict: (c) => {
    const list = get().conflicts.filter((x) => x.id !== c.id && x.status === "open");
    set({ conflicts: [...list, c] });
    schedulePersist(get);
  },

  patchConflict: (id, patch) => {
    set({ conflicts: get().conflicts.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
    schedulePersist(get);
  },

  log: (e) => {
    const ev: ComfySyncEventLog = { ...e, id: uid(8), createdAt: Date.now() };
    const list = [ev, ...get().events].slice(0, MAX_EVENTS);
    set({ events: list });
  },
}));

/** 新建来源的默认形状（规格 §9.1；默认 comfy_master、不写回，规格 §5.5） */
export function newSyncSource(rootPath: string, name: string, kind: ComfySyncSource["kind"]): ComfySyncSource {
  return {
    id: `src_${uid(8)}`,
    name,
    rootPath,
    kind,
    enabled: true,
    includeSubdirectories: true,
    autoTrackNewWorkflows: true,
    defaultPolicy: "comfy_master",
    allowWriteBack: false,
    ignorePatterns: [...DEFAULT_IGNORE_PATTERNS],
    status: "online",
  };
}
