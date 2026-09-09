/**
 * 外部 Agent 受控动作网关（导演台 3.0 · 方案 §6.1）
 *
 * Codex Harness 等外部 Agent 不直接改存储文件，只提交「提案」（propose_*）：
 *   read_project_context   — 读项目上下文摘要（无写入）
 *   propose_script_patch   — 剧本草案（进入剧本库差异确认）
 *   propose_character_patch— 角色修订（进入角色库差异确认）
 *   propose_shot_patch     — 分镜/镜头调整（按片段进入检查器差异确认）
 *   propose_prompt_patch   — 提示词草案（不动锁定最终稿）
 *   explain_generation_error — 失败归因（只读）
 * 提案进池 → 用户在 MOMO 内看差异 → 确认才写入（§10.2 AI 写入可审计）。
 * 传输层第一版是本模块 API（前端/桥接进程直接调用），后续包装成 MCP Server。
 */
import { create } from "zustand";
import { useDirector } from "../stores/directorStore";
import { uid } from "../utils";
import type { DirectorProject } from "../types";

export type AgentProposalKind =
  | "script"
  | "character"
  | "shot"
  | "prompt"
  | "note";

export type AgentProposal = {
  id: string;
  projectId: string;
  kind: AgentProposalKind;
  title: string;
  /** 变更说明（Agent 自己给的一句话摘要，进确认卡） */
  summary: string;
  /** 原文（patch 前）与提案文本（patch 后）；character/shot 为 JSON 序列化 diff 视图 */
  before: string;
  after: string;
  /** 应用目标（角色 id / 片段 id / 剧本版本 id） */
  targetId?: string;
  status: "pending" | "applied" | "rejected";
  from: string;
  createdAt: number;
  appliedAt?: number;
};

type ProposalState = {
  proposals: AgentProposal[];
  submit: (p: Omit<AgentProposal, "id" | "status" | "createdAt">) => AgentProposal;
  decide: (id: string, accept: boolean) => void;
  pendingOf: (projectId: string) => AgentProposal[];
};

export const useAgentProposals = create<ProposalState>((set, get) => ({
  proposals: [],
  submit: (p) => {
    const proposal: AgentProposal = { id: uid(10), status: "pending", createdAt: Date.now(), ...p };
    set((s) => ({ proposals: [proposal, ...s.proposals].slice(0, 100) }));
    return proposal;
  },
  decide: (id, accept) =>
    set((s) => ({
      proposals: s.proposals.map((p) =>
        p.id === id ? { ...p, status: accept ? "applied" : "rejected", appliedAt: accept ? Date.now() : undefined } : p,
      ),
    })),
  pendingOf: (projectId) => get().proposals.filter((p) => p.projectId === projectId && p.status === "pending"),
}));

/** 项目上下文摘要（read_project_context 的数据面：摘要级，不带媒体字节） */
export function readProjectContext(project: DirectorProject): string {
  const segs = project.scenes.flatMap((s) => s.segments);
  const approved = segs.filter((s) => s.approvedTakeId).length;
  return [
    `项目：${project.name} · ${project.aspect} · 目标 ${project.targetDurationSec}s`,
    `剧本：${project.script.slice(0, 600)}${project.script.length > 600 ? "…" : ""}`,
    `角色：${project.characters.map((c) => `${c.name}（${c.continuity.slice(0, 60)}）`).join("；") || "无"}`,
    `片段：${segs.length} 个（已采用 ${approved}）`,
    ...segs.slice(0, 30).map(
      (s, i) => `${String(i + 1).padStart(2, "0")} ${s.summary.slice(0, 60)} · ${s.durationSec}s${s.approvedTakeId ? " · 已采用" : ""}`,
    ),
  ].join("\n");
}

/* ---------------- 提案应用器（用户点「应用」后真正写入项目） ---------------- */

/** 应用剧本提案：写入剧本库新版本（不直接覆盖项目正文——送入项目仍走剧本库差异确认） */
export function applyScriptProposal(projectId: string, title: string, body: string): string {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) throw new Error("项目不存在");
  const now = Date.now();
  const docId = proj.scripts?.[0]?.id;
  const version = { id: uid(10), label: `AI 导演 · ${title}`, body, createdAt: now };
  if (docId) {
    useDirector.getState().updateProject(projectId, {
      scripts: (proj.scripts ?? []).map((d) =>
        d.id === docId ? { ...d, versions: [...d.versions, version], activeVersionId: version.id, updatedAt: now } : d,
      ),
    });
  } else {
    useDirector.getState().updateProject(projectId, {
      scripts: [{ id: uid(10), title: "项目剧本", status: "official", versions: [version], activeVersionId: version.id, origin: "ai-director" as const, createdAt: now, updatedAt: now }],
    });
  }
  return version.id;
}

/** 应用角色提案：写入角色修订（rev+1；受影响片段由角色库按 rev 差异提示，不静默改提示词） */
export function applyCharacterProposal(projectId: string, characterId: string, continuity: string): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  useDirector.getState().updateProject(projectId, {
    characters: proj.characters.map((c) =>
      c.id === characterId ? { ...c, continuity, rev: (c.rev ?? 1) + 1, updatedAt: Date.now() } : c,
    ),
  });
}

/** 应用片段提案：改摘要/对白（不动 promptFinalOverride 锁定稿） */
export function applyShotProposal(
  projectId: string,
  segmentId: string,
  patch: { summary?: string; dialogue?: string[]; continuityIn?: string },
): void {
  useDirector.getState().patchSegment(projectId, segmentId, patch);
}

/** 应用提示词提案：写 promptOverride（最终锁定稿 promptFinalOverride 永不被 AI 静默改写） */
export function applyPromptProposal(projectId: string, segmentId: string, prompt: string): void {
  useDirector.getState().patchSegment(projectId, segmentId, { promptOverride: prompt });
}
