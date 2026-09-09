/**
 * 统一任务中心（导演台 3.0 · 方案 §9.4）
 *
 * 所有耗时操作（生成 / 微参考提取 / 渲染 / 音乐分析 / 制图 / 音频）进入同一份
 * 可观察记录：planned → prechecking → queued → running → reviewing → done，
 * cancelled / failed / blocked / stale 为分支状态。
 * 单段失败不阻断其他片段（runBatch 语义天然如此）；远程任务 cancellable=false
 * 提示「已提交部分无法撤销计费」。会话级状态不落盘（重启后 stale 由各引擎自标）。
 */
import { create } from "zustand";
import { uid } from "../utils";
import type { JobRecord } from "../types";

type JobCenterState = {
  jobs: JobRecord[];
  /** 任务中心面板开合（导航底部「任务中心」） */
  panelOpen: boolean;
  setPanelOpen: (v: boolean) => void;
  /** 建任务后立刻返回句柄；句柄方法内部自动更新与完结 */
  begin: (init: Omit<JobRecord, "id" | "createdAt" | "status"> & { status?: JobRecord["status"] }) => JobHandle;
  patch: (id: string, patch: Partial<JobRecord>) => void;
  /** 把超过 24h 的终态记录清出列表（打开面板时收尾） */
  sweep: () => void;
};

export type JobHandle = {
  id: string;
  stage: (stage: string, pct?: number) => void;
  pct: (pct: number) => void;
  queued: () => void;
  running: () => void;
  reviewing: () => void;
  done: (msg?: string) => void;
  fail: (err: string) => void;
  cancel: () => void;
  block: (why: string) => void;
};

export const useJobCenter = create<JobCenterState>((set, get) => {
  const upd = (id: string, patch: Partial<JobRecord>) =>
    set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) }));
  return {
    jobs: [],
    panelOpen: false,
    setPanelOpen: (v) => set({ panelOpen: v }),
    begin: (init) => {
      const id = uid(10);
      const job: JobRecord = { id, createdAt: Date.now(), status: init.status ?? "running", ...init };
      set((s) => ({ jobs: [job, ...s.jobs].slice(0, 200) }));
      const live = () => {
        const j = get().jobs.find((x) => x.id === id);
        return j && !["done", "failed", "cancelled"].includes(j.status);
      };
      return {
        id,
        stage: (stage, pct) => live() && upd(id, { stage, pct, status: "running" }),
        pct: (pct) => live() && upd(id, { pct }),
        queued: () => live() && upd(id, { status: "queued" }),
        running: () => live() && upd(id, { status: "running" }),
        reviewing: () => live() && upd(id, { status: "reviewing" }),
        done: (msg) => live() && upd(id, { status: "done", finishedAt: Date.now(), pct: 100, stage: msg }),
        fail: (err) => live() && upd(id, { status: "failed", finishedAt: Date.now(), error: err }),
        cancel: () => live() && upd(id, { status: "cancelled", finishedAt: Date.now() }),
        block: (why) => live() && upd(id, { status: "blocked", error: why }),
      };
    },
    patch: upd,
    sweep: () => {
      const now = Date.now();
      set((s) => ({
        jobs: s.jobs.filter((j) => now - j.createdAt < 86_400_000 || !j.finishedAt),
      }));
    },
  };
});

/** 非 React 环境入口（core 层服务用） */
export const jobCenter = {
  begin: (init: Parameters<JobCenterState["begin"]>[0]) => useJobCenter.getState().begin(init),
};

export const JOB_STATUS_LABEL: Record<JobRecord["status"], string> = {
  planned: "计划",
  prechecking: "预检",
  queued: "排队",
  running: "运行中",
  reviewing: "待复核",
  done: "完成",
  cancelled: "已取消",
  failed: "失败",
  blocked: "受阻",
  stale: "已过期",
};

/** 运行中任务条（顶栏 JobStrip）显示用的聚合 */
export function activeJobs(jobs: JobRecord[]): JobRecord[] {
  return jobs.filter((j) => ["planned", "prechecking", "queued", "running", "reviewing"].includes(j.status));
}
