/**
 * 导演台全局选中态（方案 §4.3 导航原则）
 *
 * 「当前项目 / 场景 / 片段 / Take」是全局选中态：切换工作区后保持当前片段，不回到列表顶部。
 * 会话级状态放这里（轻量 zustand，不持久化）；需要跨会话恢复的部分（工作区/标签/选中片段）
 * 由 DirectorStudio 在切换时写进 project.uiState。
 */
import { create } from "zustand";
import type { DirectorTake } from "./types";
import type { DirectorUiState } from "./types";

type CtxState = {
  /** 当前片段 id（null = 未选） */
  segId: string | null;
  /** 显式锁定的 Take id；null = 自动（采用版本 > 最新完成版本） */
  takeId: string | null;
  /** 监看器循环播放开关 */
  loop: boolean;
  /** 监看器静音 */
  muted: boolean;
  /** Take A/B 对比：对比的另一个 Take id（null 关闭） */
  compareTakeId: string | null;
  setSeg: (segId: string | null) => void;
  setTake: (takeId: string | null) => void;
  setLoop: (v: boolean) => void;
  setMuted: (v: boolean) => void;
  setCompare: (takeId: string | null) => void;
};

export const useDirectorCtx = create<CtxState>((set) => ({
  segId: null,
  takeId: null,
  loop: false,
  muted: false,
  compareTakeId: null,
  setSeg: (segId) => set({ segId, takeId: null, compareTakeId: null }),
  setTake: (takeId) => set({ takeId }),
  setLoop: (loop) => set({ loop }),
  setMuted: (muted) => set({ muted }),
  setCompare: (compareTakeId) => set({ compareTakeId }),
}));

/** 从片段的 Take 列表解析监看器应展示的版本：显式锁定 > 采用 > 最新完成（方案 §7.1） */
export function monitorTake(
  takes: DirectorTake[] | undefined,
  approvedTakeId: string | null | undefined,
  lockedTakeId: string | null,
): DirectorTake | undefined {
  const done = (takes ?? []).filter((t) => t.status === "done");
  if (lockedTakeId) {
    const hit = done.find((t) => t.id === lockedTakeId);
    if (hit) return hit;
  }
  const approved = done.find((t) => t.id === approvedTakeId);
  if (approved) return approved;
  return [...done].sort((a, b) => b.createdAt - a.createdAt)[0];
}

/** uiState 缺省值（迁移与新建共用） */
export const DEFAULT_UI_STATE: DirectorUiState = {
  workspace: "planning",
  inspectorTab: "content",
  cockpitView: "cockpit",
  agentDockOpen: false,
  treeCollapsed: false,
  segId: null,
};
