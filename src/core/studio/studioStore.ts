/**
 * 工位界面态（导演台 3.0 · 方案 §4.3）
 *
 * 持久态（当前工位/选中片段/面板宽度）写回 project.studioUi（directorStore 落盘），
 * 这里只提供薄封装 + 会话级状态（任务面板、剧本差异确认弹层等）。
 */
import { create } from "zustand";
import { useDirector } from "../stores/directorStore";
import { useDirectorCtx } from "../directorContext";
import type { StudioUiState } from "../types";

/** 读项目的 studioUi（迁移兜底：默认 H3 导演台） */
export function studioUiOf(projectId: string): StudioUiState {
  const p = useDirector.getState().getById(projectId);
  return p?.studioUi ?? { station: "h3", segId: null };
}

/** 更新工位态（patch 合并；segId 同时同步到全局选中态供监看器等共享） */
export function patchStudioUi(projectId: string, patch: Partial<StudioUiState>): void {
  const p = useDirector.getState().getById(projectId);
  if (!p) return;
  useDirector.getState().updateProject(projectId, { studioUi: { ...studioUiOf(projectId), ...patch } });
  if (patch.segId !== undefined) useDirectorCtx.getState().setSeg(patch.segId ?? null);
}

/** 会话级 UI 状态（不持久化） */
type StudioSessionState = {
  /** 任务中心面板 */
  jobsPanelOpen: boolean;
  setJobsPanelOpen: (v: boolean) => void;
  /** 剧本送入项目的差异确认弹层（AI 导演/剧本库共用，方案 §6.2） */
  scriptMergeDraft: {
    projectId: string;
    docId: string;
    versionId: string;
  } | null;
  openScriptMerge: (projectId: string, docId: string, versionId: string) => void;
  closeScriptMerge: () => void;
};

export const useStudioSession = create<StudioSessionState>((set) => ({
  jobsPanelOpen: false,
  setJobsPanelOpen: (v) => set({ jobsPanelOpen: v }),
  scriptMergeDraft: null,
  openScriptMerge: (projectId, docId, versionId) => set({ scriptMergeDraft: { projectId, docId, versionId } }),
  closeScriptMerge: () => set({ scriptMergeDraft: null }),
}));
