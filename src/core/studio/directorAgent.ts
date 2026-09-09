/**
 * AI 导演智能内核（导演台 3.2 · 方案 §3）
 *
 * AI 导演 ≠ 创作助手：它不聊单张图方案，而是理解整个项目（剧本/角色/片段/参考/
 * Take/质检/配方/生产状态），做导演诊断，产出结构化提案与生产计划——所有写入
 * 都以对象级提案（DirectorProposal）经用户确认后应用；它没有 image/video 生成动作，
 * 执行交给 H3/MV/制图等专业工位的现有函数（§3.4 只计划不执行）。
 *
 * 分层上下文（§3.1）：第 1 层项目导演摘要常驻；第 2 层当前选中对象全量；第 3 层
 * 确定性分析结果（checkContinuity / projectProgress / collectBatchTasks /
 * qualityReports / precheckBatch）——LLM 负责把真实状态组织成导演判断，禁止虚构。
 * 对话基础设施复用通用 chatStream（流式/中断/视觉输入/错误上报，§5.1），
 * 但会话数据独立持久化在 project.directorSession（§5.2 不共享业务状态）。
 */
import { chatStream } from "../services/llm";
import { resolveModelCard } from "../stores/settingsStore";
import { chatCaps } from "../modelMeta";
import { useDirector } from "../stores/directorStore";
import { useAssets } from "../stores/assetStore";
import { projectProgress } from "../directorEngine";
import { checkContinuity } from "../directorAnalysis";
import { collectBatchTasks } from "../directorQueue";
import { precheckBatch } from "../directorPrecheck";
import { reportForSegment } from "../directorQuality";
import { capsuleFor } from "../directorContinuity";
import { routeSkillBindings } from "./skillRoute";
import { recipeCapabilityNote } from "./capabilityProfile";
import { assetToBlobUrl } from "../services/assetFiles";
import { grabFrame } from "../videoEdit";
import { uid } from "../utils";
import type { DirectorFinding, DirectorMsg, DirectorProject, DirectorProposal, DirectorResponse, DirectorSegment } from "../types";

/* ---------------- 系统提示词（角色 + 输出契约 + 安全边界） ---------------- */

const RESPONSE_CONTRACT = `每次回复必须输出一个 JSON 对象（可包在 \`\`\`json 围栏里），结构：
{
  "reply": "给用户看的导演说明（中文，简洁、有判断，不要客套）",
  "findings": [{"severity":"info|warning|blocker","category":"story|continuity|prompt|reference|engine|quality|delivery","targetId":"片段/角色/场景 id（可省）","evidence":"依据（引用给出的项目事实）","suggestion":"建议"}],
  "proposals": [{"title":"一句话标题","targetType":"script|scene|segment|shot|characterState|prompt|slot|recipe|timeline","targetId":"目标对象 id","reason":"为什么改","evidence":["依据"],"patch":{"字段":"值"}}],
  "plan": [{"action":"analyze|refine|precheck|generate|probe|upscale|bind-ref|manual","title":"步骤说明","targetIds":["片段id"],"note":"补充"}],
  "questions": [{"id":"q1","text":"需要用户拍板的问题","options":["选项A","选项B"]}]
}
规则：
- 只有确实有发现/提案/计划/问题时才带对应字段，全部可省；
- patch 是对象级局部修改：segment 支持 {summary,durationSec,dialogue[],continuityIn,continuityOut}；shot 支持 {shotId,shotSize,camera,action,audio}；characterState 支持 {characterId,continuity,identity,appearanceAnchors}；prompt 支持 {text}（写入片段提示词覆盖，不碰锁定最终稿）；script 支持 {title,body}（存入剧本库新版本，不直接替换项目正文）；scene 支持 {location,continuityRule}；slot/recipe/timeline 只做建议性提案（用户到对应工位手动执行）；
- 严禁虚构：生成状态、引擎状态、质检结果只能引用上下文里给出的「项目事实」，没有就说不知道；
- 你没有 image/video 生成动作，不要承诺直接出图出片——生产建议放进 plan 交给专业工位。`;

const DIRECTOR_SYSTEM = `你是「MOMO AI 制片工作站」的 AI 导演——一位真正看过项目全部材料的总导演，不是聊天助手。

你的职责（按优先级）：
1. 项目理解：基于每轮提供的「项目事实」（分层摘要 + 当前对象 + 确定性分析结果）理解剧本、角色、片段、参考、Take、质量与生产状态；
2. 项目诊断：叙事结构、片段节奏、角色连续性、相邻段可接性、参考/配方风险、生产阻塞与费用预估；
3. 结构化提案：把修改意见写成对象级 patch 提案（用户会逐条审核），不做全文倾倒；
4. 生产计划：给出交给专业工位执行的步骤计划（精读/精炼/预检/试跑/质检/放大），不直接生成。

${RESPONSE_CONTRACT}`;

/* ---------------- 分层项目上下文（§3.1） ---------------- */

export type DirectorCtxOpts = { station?: string; segId?: string | null };

/** 第 1 层：项目导演摘要（常驻） */
function layerSummary(project: DirectorProject): string {
  const progress = projectProgress(project);
  const segs = project.scenes.flatMap((s) => s.segments);
  const totalDur = segs.reduce((n, s) => n + s.durationSec, 0);
  const errs = segs.flatMap((s) => (s.takes ?? []).filter((t) => t.status === "error"));
  return [
    `【项目】${project.name} · ${project.aspect} · 目标 ${project.targetDurationSec}s（当前片段合计 ${Math.round(totalDur)}s）`,
    project.ruleSet?.positive.style ? `【风格】${project.ruleSet.positive.style}` : "【风格】未设置",
    `【进度】片段 ${progress.total} 个：已采用 ${progress.approved}、缺片 ${progress.missing}；失败任务 ${errs.length} 个`,
    `【角色表】${project.characters.map((c) => `${c.name}（${(c.continuity || c.identity || "").slice(0, 50)}）`).join("；") || "无"}`,
    `【剧本摘要】${project.script.slice(0, 800)}${project.script.length > 800 ? "…（完整剧本可要求查看）" : ""}`,
  ].join("\n");
}

/** 第 2 层：当前选中对象（动态） */
function layerCurrent(project: DirectorProject, segId?: string | null): string {
  const flat = project.scenes.flatMap((s) => s.segments);
  const idx = segId ? flat.findIndex((s) => s.id === segId) : -1;
  const seg: DirectorSegment | undefined = idx >= 0 ? flat[idx] : flat[0];
  if (!seg) return "【当前片段】无（项目还没有片段）";
  const prev = flat[idx - 1];
  const next = flat[idx + 1];
  const approved = (seg.takes ?? []).find((t) => t.id === seg.approvedTakeId);
  const quality = reportForSegment(project, seg.id);
  const capsule = capsuleFor(project, seg.id);
  const slots = (seg.slots ?? []).map((s) => `${s.label ?? s.semantic}×${s.assetIds.length}`).join("、");
  return [
    `【当前片段 ${String(idx + 1).padStart(2, "0")}/${flat.length}】${seg.summary}`,
    `时长 ${seg.durationSec}s · 对白 ${seg.dialogue.length} 句 · 镜头 ${seg.shots.length} 个`,
    seg.dialogue.length ? `对白：${seg.dialogue.slice(0, 5).join(" / ")}` : "",
    seg.shots.length ? `镜头：${seg.shots.map((s) => `${s.startSec}-${s.endSec}s ${s.shotSize}/${s.camera} ${s.action.slice(0, 30)}`).join("；")}` : "",
    `承接上段：${seg.continuityIn ?? "无"}；结束状态：${seg.continuityOut ?? "无"}`,
    `参考槽：${slots || "无"}；配方：${seg.recipeId ?? project.defaultRecipeId ?? "远程默认"}`,
    seg.promptFinalOverride ? `提示词：已锁定最终稿（${seg.promptFinalOverride.length} 字，提案不得改写）` : seg.promptOverride ? `提示词覆盖：${seg.promptOverride.slice(0, 200)}` : "提示词：自动编译",
    `Take：共 ${(seg.takes ?? []).length} 个，采用 ${approved ? "有" : "无"}${quality?.issues?.length ? `；质检 ${quality.issues.length} 项（${quality.issues.slice(0, 3).map((i) => i.message).join("；")}）` : ""}`,
    capsule ? `接力胶囊：来自段 ${capsule.sourceSegmentId.slice(-4)}${capsule.stale ? "（已过期）" : ""}${capsule.microFrames ? ` · 末 ${capsule.microFrames} 帧微参考` : ""}` : "接力胶囊：无",
    prev ? `上一段：${prev.summary}（结束状态 ${prev.continuityOut ?? "无"}）` : "（本段是第一段）",
    next ? `下一段：${next.summary}（承接 ${next.continuityIn ?? "无"}）` : "（本段是最后一段）",
  ].filter(Boolean).join("\n");
}

/** 第 3 层：确定性分析结果（复用现有引擎，LLM 只组织不重算，§3.2） */
export function deterministicFindings(project: DirectorProject): DirectorFinding[] {
  const out: DirectorFinding[] = [];
  for (const i of checkContinuity(project)) {
    if (i.level === "info") continue;
    out.push({
      severity: i.level === "error" ? "blocker" : "warning",
      category: i.category === "duration" ? "story" : "continuity",
      targetId: i.segmentId,
      evidence: i.message,
      suggestion: "在 H3 工位处理该片段",
    });
  }
  const progress = projectProgress(project);
  if (progress.missing > 0) {
    out.push({ severity: "warning", category: "delivery", evidence: `${progress.missing} 个片段缺片（未采用 Take）`, suggestion: "到 H3 工位批量补缺" });
  }
  const failed = collectBatchTasks(project, "failed");
  if (failed.length) {
    out.push({ severity: "warning", category: "engine", evidence: `${failed.length} 个片段最近生成失败`, suggestion: "H3 批量菜单「重跑失败」" });
  }
  const badQuality = (project.qualityReports ?? []).filter((r) => r.issues?.some((i) => i.level === "error"));
  if (badQuality.length) {
    out.push({ severity: "warning", category: "quality", targetId: badQuality[0].segmentId, evidence: `${badQuality.length} 个采用 Take 质量探测有错误级问题`, suggestion: "成片工位质量探测查看明细" });
  }
  return out;
}

function layerFindings(findings: DirectorFinding[]): string {
  if (!findings.length) return "【确定性检查】全部通过（缺片/连续性/失败任务/质检）";
  return `【确定性检查（真实结果，可直接引用）】\n${findings.slice(0, 12).map((f, i) => `${i + 1}. [${f.severity}/${f.category}] ${f.evidence}`).join("\n")}`;
}

/** 组装完整上下文（分层：摘要 + 当前对象 + 分析结果 + Skill 规范） */
export function buildDirectorContext(project: DirectorProject, opts: DirectorCtxOpts = {}): string {
  const findings = deterministicFindings(project);
  const skills = routeSkillBindings(project, { engine: "remote", model: resolveModelCard("chat").model }, ["studio.director", "director.project"]);
  return [
    layerSummary(project),
    layerCurrent(project, opts.segId ?? project.studioUi?.segId),
    layerFindings(findings),
    skills.length ? `【项目绑定的创作规范 Skill】\n${skills.map((s) => s.system.slice(0, 1200)).join("\n---\n")}` : "",
    layerRecipes(project),
  ].filter(Boolean).join("\n\n");
}

/** 配方与能力档案层（3.3 P4：模型路由建议的事实基础） */
function layerRecipes(project: DirectorProject): string {
  if (!project.recipes.length) return "【可用配方】仅远程默认模型（通用协议）";
  const lines = project.recipes.map((r) => `- ${r.name}（${r.engine === "comfy" ? "本地" : "远程"}）：${recipeCapabilityNote(r)}`);
  return `【可用配方与能力档案（真实状态）】\n${lines.join("\n")}`;
}

/* ---------------- 会话持久化与历史压缩（P1-1） ---------------- */

const KEEP_RECENT = 12;

function patchSession(projectId: string, fn: (s: NonNullable<DirectorProject["directorSession"]>) => NonNullable<DirectorProject["directorSession"]>): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  const cur = proj.directorSession ?? { messages: [], epoch: 1 };
  useDirector.getState().updateProject(projectId, { directorSession: fn(cur) });
}

export function pushDirectorMsg(projectId: string, msg: Omit<DirectorMsg, "id" | "at">): DirectorMsg {
  const full: DirectorMsg = { id: uid(8), at: Date.now(), ...msg };
  patchSession(projectId, (s) => ({ ...s, messages: [...s.messages, full] }));
  return full;
}

/** 历史压缩：消息超过阈值时把早期消息压成前情摘要（LLM 压缩，失败退化为截断拼接） */
export async function compressDirectorHistory(projectId: string): Promise<void> {
  const proj = useDirector.getState().getById(projectId);
  const s = proj?.directorSession;
  if (!s || s.messages.length <= KEEP_RECENT + 4) return;
  const old = s.messages.slice(0, s.messages.length - KEEP_RECENT);
  const recent = s.messages.slice(-KEEP_RECENT);
  const transcript = old.map((m) => `${m.role === "user" ? "用户" : "AI导演"}：${m.text.slice(0, 300)}`).join("\n");
  let summary = `${s.summary ? `${s.summary}\n` : ""}【前情】${transcript.slice(-1500)}`;
  try {
    const card = resolveModelCard("chat");
    const { chatOnce } = await import("../services/llm");
    summary = await chatOnce(card, "把以下 AI 导演工作记录压缩成 200 字以内的前情摘要：保留导演决策、已确认方案、未解决问题。只输出摘要。", `${s.summary ?? ""}\n${transcript}`.slice(0, 4000));
  } catch {
    // 压缩失败用截断拼接保底，不阻断对话
  }
  patchSession(projectId, (cur) => ({ ...cur, summary, summaryUpto: old.length, messages: recent }));
}

/** 组装发给模型的会话消息（摘要 + 最近消息原文） */
function historyMsgs(s: DirectorProject["directorSession"]): Array<{ role: "user" | "assistant"; text: string }> {
  if (!s) return [];
  const out: Array<{ role: "user" | "assistant"; text: string }> = [];
  if (s.summary) out.push({ role: "user", text: `【前情摘要（更早的对话已压缩）】\n${s.summary}` });
  for (const m of s.messages.slice(-KEEP_RECENT)) {
    // director 消息只带 reply 文本（findings/proposals 已在 UI 呈现，回灌无意义）
    out.push({ role: m.role === "user" ? "user" : "assistant", text: m.role === "director" ? (m.response?.reply ?? m.text).slice(0, 2000) : m.text });
  }
  return out;
}

/* ---------------- 对话执行（流式 + 结构化解析） ---------------- */

/** 从模型输出中宽容提取 DirectorResponse：优先 JSON 块；失败降级为纯 reply（§8.1 不让自由文本直接改项目） */
export function parseDirectorResponse(text: string): DirectorResponse {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? (text.includes("{") && text.lastIndexOf("}") > text.indexOf("{") ? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) : "");
  if (candidate.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(candidate) as Partial<DirectorResponse>;
      if (typeof parsed.reply === "string" || parsed.proposals || parsed.findings || parsed.plan) {
        return {
          reply: parsed.reply ?? "（本轮无文字说明，见下方提案与计划）",
          findings: Array.isArray(parsed.findings) ? parsed.findings.slice(0, 12) : undefined,
          proposals: Array.isArray(parsed.proposals)
            ? parsed.proposals.slice(0, 6).map((p, i) => ({
                id: uid(8),
                title: p.title ?? `提案 ${i + 1}`,
                targetType: p.targetType ?? "segment",
                targetId: p.targetId ?? "",
                reason: p.reason ?? "",
                evidence: Array.isArray(p.evidence) ? p.evidence : [],
                patch: p.patch ?? {},
                status: "pending" as const,
                origin: "ai-director" as const,
                createdAt: Date.now(),
              }))
            : undefined,
          plan: Array.isArray(parsed.plan) ? parsed.plan.map((p, i) => ({ ...p, id: p.id ?? `step${i + 1}` })) : undefined,
          questions: Array.isArray(parsed.questions) ? parsed.questions : undefined,
        };
      }
    } catch {
      // JSON 畸形：降级纯文本
    }
  }
  return { reply: text.trim() };
}

export type RunDirectorOpts = DirectorCtxOpts & {
  onText?: (full: string) => void;
  signal?: AbortSignal;
};

/** 执行一轮导演对话：上下文 + 历史 → 流式 → 解析 → 持久化消息 + 提案入池 */
export async function runDirector(projectId: string, userText: string, opts: RunDirectorOpts = {}): Promise<DirectorMsg> {
  const project = useDirector.getState().getById(projectId);
  if (!project) throw new Error("项目不存在");
  const card = resolveModelCard("chat");
  const context = buildDirectorContext(project, opts);
  pushDirectorMsg(projectId, { role: "user", text: userText });
  let full = "";
  const { text } = await chatStream(
    card,
    [
      ...historyMsgs(project.directorSession).map((m) => ({ role: m.role, text: m.text })),
      { role: "user" as const, text: `${context}\n\n────────\n【用户本轮】${userText}` },
    ],
    {
      system: DIRECTOR_SYSTEM,
      signal: opts.signal,
      onText: (f) => {
        full = f;
        opts.onText?.(f);
      },
    },
  );
  const response = parseDirectorResponse(text.trim() || full);
  const msg = pushDirectorMsg(projectId, { role: "director", text: response.reply, response });
  // 提案入项目池（pending，等用户审）
  if (response.proposals?.length) {
    const proj = useDirector.getState().getById(projectId)!;
    useDirector.getState().updateProject(projectId, {
      directorProposals: [...(proj.directorProposals ?? []), ...response.proposals],
    });
  }
  void compressDirectorHistory(projectId).catch(() => undefined);
  return msg;
}

/* ---------------- 对象级提案应用器（§3.3） ---------------- */

type PatchFields = { summary?: string; durationSec?: number; dialogue?: string[]; continuityIn?: string; continuityOut?: string; promptOverride?: string };

/** 计算提案影响面：改片段 → 该段旧 Take 过期、其微参考胶囊需重建、下游接力段标记（§8.2） */
export function proposalImpact(project: DirectorProject, p: DirectorProposal): DirectorProposal["impact"] {
  const segIds = new Set<string>();
  const takeIds: string[] = [];
  const microIds: string[] = [];
  const addSegment = (segId: string) => {
    if (!segIds.has(segId)) segIds.add(segId);
    const seg = project.scenes.flatMap((s) => s.segments).find((x) => x.id === segId);
    if (seg) {
      for (const t of seg.takes ?? []) if (t.status === "done") takeIds.push(t.id);
    }
    for (const c of project.continuityCapsules ?? []) {
      if (c.sourceSegmentId === segId || c.segmentId === segId) microIds.push(c.segmentId);
    }
  };
  if (p.targetType === "segment" || p.targetType === "shot" || p.targetType === "prompt" || p.targetType === "slot") {
    if (p.targetType === "segment" || p.targetType === "prompt") addSegment(p.targetId);
    else addSegment(p.targetId); // shot/slot 的 targetId 也是片段 id（shotId 在 patch 里）
  } else if (p.targetType === "script") {
    // 剧本变更 → 全部片段的提示词来源过期（保守估计）
    for (const seg of project.scenes.flatMap((s) => s.segments)) addSegment(seg.id);
  } else if (p.targetType === "characterState") {
    const name = project.characters.find((c) => c.id === (p.patch as { characterId?: string })?.characterId)?.name
      ?? project.characters.find((c) => c.id === p.targetId)?.name;
    if (name) {
      for (const seg of project.scenes.flatMap((s) => s.segments)) {
        if ([seg.summary, ...seg.dialogue, seg.promptOverride ?? "", seg.promptFinalOverride ?? ""].join("\n").includes(name)) addSegment(seg.id);
      }
    }
  }
  return { invalidatedSegmentIds: [...segIds], staleTakeIds: takeIds, rebuildMicroRefIds: microIds };
}

/** 应用一条提案（对象级 patch 写回；锁定最终稿永不被覆盖）。返回结果文案。 */
export function applyDirectorProposal(projectId: string, proposal: DirectorProposal): string {
  const project = useDirector.getState().getById(projectId);
  if (!project) throw new Error("项目不存在");
  const patch = (proposal.patch ?? {}) as Record<string, unknown>;
  // 3.4 应用前校验：目标必须存在、补丁必须有可应用内容——否则抛错保持「待审」，绝不假标「已应用」
  const segExists = (id?: string) => !!id && !!project.scenes.flatMap((s) => s.segments).find((x) => x.id === id);
  if (proposal.targetType === "segment" || proposal.targetType === "prompt" || proposal.targetType === "shot") {
    if (!segExists(proposal.targetId)) throw new Error("目标片段不存在（可能已被删除）——提案保持待审");
  } else if (proposal.targetType === "characterState") {
    const charId = String(patch.characterId ?? proposal.targetId);
    if (!project.characters.some((c) => c.id === charId)) throw new Error("目标角色不存在（可能已被删除）——提案保持待审");
  } else if (proposal.targetType === "scene") {
    if (!project.scenes.some((sc) => sc.id === proposal.targetId)) throw new Error("目标场景不存在（可能已被删除）——提案保持待审");
  } else if (proposal.targetType === "script") {
    if (typeof patch.body !== "string" || !patch.body.trim()) throw new Error("提案正文为空，无可存入内容——提案保持待审");
  }
  let result = "";
  switch (proposal.targetType) {
    case "segment": {
      const fields: PatchFields = {};
      if (typeof patch.summary === "string") fields.summary = patch.summary;
      if (typeof patch.durationSec === "number") fields.durationSec = Math.max(2, patch.durationSec);
      if (Array.isArray(patch.dialogue)) fields.dialogue = (patch.dialogue as unknown[]).map(String).filter((x) => x.trim());
      if (typeof patch.continuityIn === "string") fields.continuityIn = patch.continuityIn;
      if (typeof patch.continuityOut === "string") fields.continuityOut = patch.continuityOut;
      if (!Object.keys(fields).length) throw new Error("提案补丁没有可应用的字段——提案保持待审");
      useDirector.getState().patchSegment(projectId, proposal.targetId, fields);
      result = `已更新片段 ${proposal.targetId.slice(-4)} 的 ${Object.keys(fields).join("/")}`;
      break;
    }
    case "prompt": {
      const text = typeof patch.text === "string" ? patch.text : "";
      const seg = project.scenes.flatMap((s) => s.segments).find((x) => x.id === proposal.targetId);
      if (seg?.promptFinalOverride) {
        throw new Error("该片段已锁定最终稿——请先在 H3 检查器解锁，AI 不会静默覆盖锁定稿");
      }
      useDirector.getState().patchSegment(projectId, proposal.targetId, { promptOverride: text });
      result = `已写入片段提示词覆盖（${text.length} 字）`;
      break;
    }
    case "shot": {
      const seg = project.scenes.flatMap((s) => s.segments).find((x) => x.id === proposal.targetId);
      if (!seg) throw new Error("目标片段不存在");
      const shotId = String(patch.shotId ?? "");
      const shots = seg.shots.map((sh) =>
        sh.id === shotId
          ? {
              ...sh,
              ...(typeof patch.shotSize === "string" ? { shotSize: patch.shotSize } : {}),
              ...(typeof patch.camera === "string" ? { camera: patch.camera } : {}),
              ...(typeof patch.action === "string" ? { action: patch.action } : {}),
              ...(typeof patch.audio === "string" ? { audio: patch.audio } : {}),
            }
          : sh,
      );
      useDirector.getState().patchSegment(projectId, proposal.targetId, { shots });
      result = `已更新镜头 ${shotId.slice(-4)}`;
      break;
    }
    case "characterState": {
      const charId = String(patch.characterId ?? proposal.targetId);
      const fields: Record<string, unknown> = {};
      if (typeof patch.continuity === "string") fields.continuity = patch.continuity;
      if (typeof patch.identity === "string") fields.identity = patch.identity;
      if (typeof patch.appearanceAnchors === "string") fields.appearanceAnchors = patch.appearanceAnchors;
      if (!Object.keys(fields).length) throw new Error("提案补丁没有可应用的角色字段——提案保持待审");
      useDirector.getState().updateProject(projectId, {
        characters: project.characters.map((c) => (c.id === charId ? { ...c, ...fields, rev: (c.rev ?? 1) + 1, updatedAt: Date.now() } : c)),
      });
      result = `已更新角色档案（rev+1，出场片段将提示「角色来源已更新」）`;
      break;
    }
    case "scene": {
      useDirector.getState().updateProject(projectId, {
        scenes: project.scenes.map((sc) => {
          if (sc.id !== proposal.targetId) return sc;
          return {
            ...sc,
            ...(typeof patch.location === "string" ? { location: patch.location } : {}),
            ...(typeof patch.continuityRule === "string" ? { continuityRule: patch.continuityRule } : {}),
          };
        }),
      });
      result = `已更新场景 ${proposal.targetId.slice(-4)}`;
      break;
    }
    case "script": {
      const body = typeof patch.body === "string" ? patch.body : "";
      const title = typeof patch.title === "string" ? patch.title : `AI 导演 · ${proposal.title}`;
      const now = Date.now();
      const version = { id: uid(10), label: title, body, createdAt: now };
      const first = project.scripts?.[0];
      if (first) {
        useDirector.getState().updateProject(projectId, {
          scripts: project.scripts!.map((d) => (d.id === first.id ? { ...d, versions: [...d.versions, version], activeVersionId: version.id, updatedAt: now } : d)),
        });
      } else {
        useDirector.getState().updateProject(projectId, {
          scripts: [{ id: uid(10), title: "项目剧本", status: "official" as const, versions: [version], activeVersionId: version.id, origin: "ai-director" as const, createdAt: now, updatedAt: now }],
        });
      }
      result = `已存入剧本库新版本「${title}」——送入项目仍需在剧本库确认`;
      break;
    }
    default:
      // slot/recipe/timeline：建议性提案，不自动执行
      throw new Error(`${proposal.targetType} 类提案是建议——请到对应工位手动执行（提案保留作参考）`);
  }
  // 记录状态（审计）
  const proj2 = useDirector.getState().getById(projectId)!;
  useDirector.getState().updateProject(projectId, {
    directorProposals: (proj2.directorProposals ?? []).map((x) =>
      x.id === proposal.id ? { ...x, status: "applied" as const, appliedAt: Date.now() } : x,
    ),
  });
  return result;
}

/** 驳回提案（保留审计记录） */
export function rejectDirectorProposal(projectId: string, proposalId: string, reason?: string): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  useDirector.getState().updateProject(projectId, {
    directorProposals: (proj.directorProposals ?? []).map((x) =>
      x.id === proposalId ? { ...x, status: "rejected" as const, rejectReason: reason } : x,
    ),
  });
}

/* ---------------- 八个导演任务（§6.2 快捷入口是导演任务，不是泛化生成） ---------------- */

export type DirectorTask = { id: string; label: string; desc: string; build: (project: DirectorProject, segId?: string | null) => Promise<string> };

export const DIRECTOR_TASKS: DirectorTask[] = [
  {
    id: "health",
    label: "全项目体检",
    desc: "先读确定性检查（缺片/连续性/失败/质检），再给综合判断与优先级",
    build: async (p) => { void p; return `请做全项目体检：基于给出的确定性检查结果与项目事实，按严重度归纳问题（叙事/连续性/参考/引擎/交付各维度），给出最多 3 条最优先行动，并对可修改处给出对象级提案。`; },
  },
  {
    id: "structure",
    label: "剧本结构复盘",
    desc: "开场/冲突/高潮/结尾是否成立，片段密度与信息重复",
    build: async (p) => { void p; return `请复盘剧本结构：开场钩子、冲突递进、高潮与结尾是否成立；片段是否过密/过松/超时/信息重复；给出分段结构诊断与结构级提案（scene/segment patch）。`; },
  },
  {
    id: "scene",
    label: "当前场景导演",
    desc: "当前选中片段所在场景的整体调度建议",
    build: async (p, segId) => { void p; void segId; return `请针对当前选中片段所在场景做导演分析：本场戏剧任务、各片段节奏与镜头语言、调度改进建议；产出该场景内片段的修改提案。`; },
  },
  {
    id: "continuity",
    label: "片段连续性复核",
    desc: "当前段与相邻段在动作/空间/光线/声音上是否可接",
    build: async (p, segId) => { void p; void segId; return `请复核当前片段与相邻片段的连续性：动作承接、空间轴线、光线时段、声音环境、服装道具；结合确定性检查结果给出 continuity 类 findings 与提案。`; },
  },
  {
    id: "review",
    label: "选中 Take 视觉审片",
    desc: "抽取首/中/尾帧与相邻帧给视觉模型判断视觉连续性（P4）",
    build: async (p, segId) => { void p; void segId; return `请基于当前片段的质检报告与接力状态做审片前分析，并说明哪些连续性问题需要视觉确认。`; },
  },
  {
    id: "risk",
    label: "生成前风险检查",
    desc: "预检引擎/模板/时长/画幅/参考容量与计费风险",
    build: async (p) => {
      const r = await precheckBatch(p, "missing").catch(() => null);
      const pre = r ? `\n【批量预检（真实结果）】${r.summary}${r.issues.length ? `\n问题：${r.issues.slice(0, 8).map((i) => `[${i.level}] ${i.message}`).join("；")}` : "无阻塞"}` : "\n【批量预检】未能执行";
      return `请做生成前风险检查：结合下面的预检结果，评估任务量、时长/画幅兼容性、参考容量与计费风险，给出试跑计划（先跑哪几段、确认什么后再全量）。${pre}`;
    },
  },
  {
    id: "routing",
    label: "模型路由建议",
    desc: "按任务/素材/时长/成本推荐各片段用哪条通道（只建议，不自动切换）",
    build: async (p) => { void p; return `请做模型路由建议：基于给出的「可用配方与能力档案」、各片段的素材构成（有无首尾帧/参考视频/音频）与时长需求，建议每类片段走哪条通道（本地 H3 各模式 / LTX / Seedance / Wan / Veo），说明依据与费用影响；产出 plan（targetIds 指向片段，action=generate 的 note 写建议配方），不自动切换模型。`; },
  },
  {
    id: "plan",
    label: "生产顺序与试跑计划",
    desc: "排一个可执行的制作顺序（精读→精炼→试跑→全量→质检）",
    build: async (p) => { void p; return `请制定生产计划：基于项目进度与缺片/失败状态，按「精读 → 补参考 → Skill 精炼 → 试跑 2-3 段确认风格 → 全量生成 → 连续性/质检」的骨架给出具体步骤计划（plan），指明每步的目标片段。`; },
  },
  {
    id: "delivery",
    label: "成片节奏与交付复盘",
    desc: "时长偏差、节奏分布与交付风险",
    build: async (p) => {
      const segs = p.scenes.flatMap((sc) => sc.segments);
      const total = segs.reduce((n, s) => n + s.durationSec, 0);
      return `请做成片复盘：当前合计 ${Math.round(total)}s vs 目标 ${p.targetDurationSec}s（偏差 ${Math.round(total - p.targetDurationSec)}s）；已采用片段的节奏分布是否头重脚轻；结合质量报告给出交付风险与后期建议（放大/音轨/字幕）。`;
    },
  },
];

/* ---------------- P4 最小实现：视觉审片（§3.5） ---------------- */

/**
 * 选中 Take 视觉审片：抽当前段采用 Take 的首/中/尾帧 + 上一段尾帧 + 下一段首帧，
 * 交给具备 vision 的 chat 模型判断角色外观/空间/光线/动作/轴线连续性。
 * 只产出 findings 与提案，不自动重生（§3.5）。
 */
export async function runVisualReview(projectId: string, segmentId: string, opts: { onText?: (f: string) => void } = {}): Promise<DirectorResponse> {
  const project = useDirector.getState().getById(projectId);
  if (!project) throw new Error("项目不存在");
  const card = resolveModelCard("chat");
  if (!chatCaps(card).vision) {
    throw new Error(`当前对话模型「${card.name}」不支持视觉输入——请在设置里为 chat 角色选择 vision 模型（如 GLM-4.5V / Qwen-VL）`);
  }
  const flat = project.scenes.flatMap((s) => s.segments);
  const idx = flat.findIndex((s) => s.id === segmentId);
  const seg = flat[idx];
  if (!seg) throw new Error("片段不存在");
  const prev = flat[idx - 1];
  const assetOf = (s?: DirectorSegment) => {
    const done = (s?.takes ?? []).filter((t) => t.status === "done" && t.assetId);
    const take = done.find((t) => t.id === s?.approvedTakeId) ?? done[done.length - 1];
    return take?.assetId ? useAssets.getState().items.find((a) => a.id === take.assetId) : undefined;
  };
  const cur = assetOf(seg);
  if (!cur || cur.kind !== "video") throw new Error("当前片段还没有采用的视频 Take——先在 H3 工位生成并采用");
  const src = await assetToBlobUrl(cur.path, cur.mime).catch(() => cur.path);
  const meta = await grabFrame(src, "last");
  const frames: string[] = [];
  const pick = async (t: number, label: string) => {
    try {
      const f = await grabFrame(src, "custom", Math.max(0.02, Math.min(t, meta.duration - 0.05)));
      frames.push(f.dataUrl);
      return label;
    } catch {
      return "";
    }
  };
  await pick(0.05, "首帧");
  await pick(meta.duration / 2, "中帧");
  await pick(meta.duration - 0.25, "尾帧");
  const prevAsset = assetOf(prev);
  if (prevAsset?.kind === "video") {
    const psrc = await assetToBlobUrl(prevAsset.path, prevAsset.mime).catch(() => prevAsset.path);
    const pm = await grabFrame(psrc, "last");
    try {
      frames.push((await grabFrame(psrc, "custom", Math.max(0, pm.duration - 0.25))).dataUrl);
    } catch { /* 上一段尾帧失败不阻断 */ }
  }
  const quality = reportForSegment(project, seg.id);
  const system = `你是审片导演。给你当前片段的首/中/尾帧${prev ? "与上一段的尾帧" : ""}。请判断：角色外观与服装连续性、空间轴线与机位方向、光线时段、动作衔接、画面质量。只报告有证据的问题，并给出 ${RESPONSE_CONTRACT}`;
  const user = `当前片段：${seg.summary}\n${seg.continuityIn ? `承接要求：${seg.continuityIn}\n` : ""}${prev ? `上一段：${prev.summary}（结束：${prev.continuityOut ?? "无"}）\n` : ""}${quality?.issues?.length ? `已有质检问题：${quality.issues.map((i) => i.message).join("；")}\n` : ""}请输出审片结论（findings + 如需修改给 proposals：targetType=segment/prompt）。`;
  let full = "";
  const { text } = await chatStream(card, [{ role: "user", text: user, images: frames }], {
    system,
    onText: (f) => {
      full = f;
      opts.onText?.(f);
    },
  });
  const response = parseDirectorResponse(text.trim() || full);
  const msg = pushDirectorMsg(projectId, {
    role: "director",
    text: `【视觉审片】${response.reply}`,
    response,
    images: frames.slice(0, 3),
  });
  if (response.proposals?.length) {
    const proj = useDirector.getState().getById(projectId)!;
    useDirector.getState().updateProject(projectId, { directorProposals: [...(proj.directorProposals ?? []), ...response.proposals] });
  }
  void msg;
  return response;
}
