/**
 * 导演台项目 Store — 独立持久化到 director-projects.json
 *
 * 设计要点（方案 §8.2）：
 *  - 节点 data 只保存 projectId（DirectorData），完整项目数据存这里
 *  - 原因：画布 undo/redo 会复制 node.data，大项目会让快照膨胀；生成队列持续更新会频繁触发画布持久化
 *  - 使用 loadJSON/saveJSON + 序号守卫（与 boardStore 同款），防止慢的旧快照覆盖新快照
 *  - 删除导演台节点时默认把项目移入「归档」，不直接删除素材
 */
import { create } from "zustand";
import { loadJSON, saveJSON } from "../persist";
import { uid } from "../utils";
import { migrateDirectorProjects, DIRECTOR_SCHEMA_VERSION } from "../directorMigration";
import { DEFAULT_UI_STATE } from "../directorContext";
import type { DirectorProject } from "../types";

type PersistShape = {
  projects: DirectorProject[];
  archived: DirectorProject[];
  /** 桌面端媒体工具偏好（ffmpeg/ffprobe 路径；渲染引擎用，方案 §12.1） */
  mediaTool?: { ffmpegPath?: string; ffprobePath?: string };
  schemaVersion: number;
};

type DirectorState = {
  projects: DirectorProject[];
  /** 归档项目（节点删除后移入这里，不删素材） */
  archived: DirectorProject[];
  loaded: boolean;
  /** 桌面端 ffmpeg/ffprobe 路径偏好（找不到系统 PATH 里的 ffmpeg 时让用户手动指定） */
  mediaTool: { ffmpegPath?: string; ffprobePath?: string };
  init: () => Promise<void>;
  /** 新建项目（新建导演台节点时调用） */
  createProject: (nodeId: string, boardId: string, name?: string) => DirectorProject;
  /** 导入项目包后落库（新项目置顶；nodeId 留空 = 未挂画布节点） */
  addImportedProject: (project: DirectorProject) => void;
  /** 更新项目字段 */
  updateProject: (id: string, patch: Partial<DirectorProject>) => void;
  /** 片段级更新：只改一个 segment（大项目避免整树 map 的样板代码散落各页） */
  patchSegment: (projectId: string, segmentId: string, patch: Partial<DirectorProject["scenes"][number]["segments"][number]>) => void;
  /** 删除项目 → 移入归档（不删素材） */
  archiveProject: (id: string) => void;
  /** 彻底删除归档项目 */
  purgeArchived: (id: string) => void;
  /** 媒体工具偏好（渲染引擎找不到 ffmpeg 时由用户指定） */
  setMediaTool: (patch: { ffmpegPath?: string; ffprobePath?: string }) => void;
  getById: (id: string) => DirectorProject | undefined;
  getByNodeId: (nodeId: string) => DirectorProject | undefined;
};

let saveSeq = 0;
let initOnce: Promise<void> | null = null;

function persist(state: { projects: DirectorProject[]; archived: DirectorProject[]; mediaTool?: { ffmpegPath?: string; ffprobePath?: string } }) {
  const mySeq = ++saveSeq;
  const data = {
    projects: state.projects,
    archived: state.archived,
    mediaTool: state.mediaTool,
    schemaVersion: DIRECTOR_SCHEMA_VERSION,
  } satisfies PersistShape;
  // 序号守卫（与 boardStore 同款）：saveJSON 是异步的，高频调用时慢的旧快照不能覆盖新快照。
  // 用 setTimeout(0) 让出微任务，等同步代码里可能触发的后续 persist 都 ++saveSeq 后再检查。
  setTimeout(() => {
    if (mySeq !== saveSeq) return; // 已有更新的保存发起，丢弃这一份
    void saveJSON("director-projects.json", "v1", data);
  }, 0);
}

export const useDirector = create<DirectorState>((set, get) => ({
  projects: [],
  archived: [],
  loaded: false,
  mediaTool: {},

  init: () =>
    (initOnce ??= (async () => {
      const saved = await loadJSON<PersistShape>("director-projects.json", "v1");
      // 加载即迁移（v1→v2 唯一入口 directorMigration）；归档项目同样迁移，恢复回来不炸
      const projects = migrateDirectorProjects(saved?.projects ?? []);
      const archived = migrateDirectorProjects(saved?.archived ?? []);
      // 3.4 迁移：createProject 曾经不幂等，同一 nodeId 可能积累多份项目（一份有片段 + 若干空壳）。
      // 按 nodeId 分组保留片段最多的一份，其余移入归档（可恢复，不删数据）
      const byNode = new Map<string, DirectorProject[]>();
      for (const p of projects) {
        const list = byNode.get(p.nodeId) ?? [];
        list.push(p);
        byNode.set(p.nodeId, list);
      }
      const kept: DirectorProject[] = [];
      const dupArchived: DirectorProject[] = [];
      for (const [nodeId, list] of byNode) {
        if (list.length === 1 || !nodeId) {
          kept.push(...list);
          continue;
        }
        const best = [...list].sort(
          (a, b) => b.scenes.reduce((n, s) => n + s.segments.length, 0) - a.scenes.reduce((n, s) => n + s.segments.length, 0),
        )[0];
        kept.push(best);
        dupArchived.push(...list.filter((x) => x.id !== best.id));
      }
      if (dupArchived.length) console.warn(`[导演台] 去重迁移：${dupArchived.length} 个重复项目移入归档`);
      set({
        projects: kept,
        archived: [...archived, ...dupArchived],
        mediaTool: saved?.mediaTool ?? {},
        loaded: true,
      });
    })()),

  createProject: (nodeId, boardId, name) => {
    // 幂等（3.4）：同一画布节点只持有一个项目——历史非幂等曾造成重复项目（init 有去重迁移兜底）
    const exist = get().projects.find((p) => p.nodeId === nodeId && p.boardId === boardId);
    if (exist) return exist;
    const now = Date.now();
    const project: DirectorProject = {
      id: uid(10),
      nodeId,
      boardId,
      name: name || "未命名项目",
      createdAt: now,
      updatedAt: now,
      targetDurationSec: 120,
      aspect: "16:9",
      script: "",
      characters: [],
      scenes: [],
      recipes: [],
      globalSlots: [],
      timeline: [],
      workspaceMode: "pro",
      uiState: { ...DEFAULT_UI_STATE },
      postTimeline: { clipOverrides: {}, titleCards: [], subtitles: [], fit: "contain" },
      // 3.0 工位态：新项目直接落在 H3 导演台（主工位）
      scripts: [],
      mvProjects: [],
      imageStudio: {},
      studioUi: { station: "h3", segId: null },
      schemaVersion: DIRECTOR_SCHEMA_VERSION,
    };
    const projects = [project, ...get().projects];
    set({ projects });
    persist(get());
    return project;
  },

  addImportedProject: (project) => {
    set({ projects: [project, ...get().projects] });
    persist(get());
  },

  updateProject: (id, patch) => {
    const s = get();
    const projects = s.projects.map((p) => (p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p));
    set({ projects });
    persist(get());
  },

  patchSegment: (projectId, segmentId, patch) => {
    const s = get();
    const projects = s.projects.map((p) =>
      p.id !== projectId
        ? p
        : {
            ...p,
            updatedAt: Date.now(),
            scenes: p.scenes.map((sc) => ({
              ...sc,
              segments: sc.segments.map((seg) => (seg.id === segmentId ? { ...seg, ...patch } : seg)),
            })),
          },
    );
    set({ projects });
    persist(get());
  },

  archiveProject: (id) => {
    const s = get();
    const proj = s.projects.find((p) => p.id === id);
    if (!proj) return;
    const projects = s.projects.filter((p) => p.id !== id);
    const archived = [proj, ...s.archived];
    set({ projects, archived });
    persist(get());
  },

  purgeArchived: (id) => {
    const s = get();
    const archived = s.archived.filter((p) => p.id !== id);
    set({ archived });
    persist(get());
  },

  setMediaTool: (patch) => {
    set({ mediaTool: { ...get().mediaTool, ...patch } });
    persist(get());
  },

  getById: (id) => get().projects.find((p) => p.id === id),

  getByNodeId: (nodeId) => get().projects.find((p) => p.nodeId === nodeId),
}));
