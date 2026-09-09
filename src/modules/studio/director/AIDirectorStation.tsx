/**
 * AI 导演工位（导演台 3.2 · 方案 §6）— 项目级理解 / 诊断 / 提案 / 计划
 *
 * ┌ 左：导演记忆与任务 │ 中：对话与结构化提案 │ 右：项目诊断 ┐
 *  - 会话持久化在 project.directorSession（切工位/重启不丢，与创作助手完全隔离 §5.2）；
 *  - 复用通用 chatStream（流式渲染 + 中断 + 视觉输入），但 system 与输出是导演契约；
 *  - 快捷入口是八个「导演任务」（体检/结构/场景/连续性/审片/风险/计划/复盘），不是泛化生成；
 *  - 回复按 DirectorResponse 渲染：findings 问题卡 / proposals 提案卡（依据·影响·采用/驳回/去执行）/
 *    plan 计划卡 / questions 决策卡——自由文本永远不直接写项目（§8.1）；
 *  - 右栏诊断是确定性分析（checkContinuity/进度/质检）的实时投影，AI 只组织不重算。
 */
import { useMemo, useRef, useState } from "react";
import { useDirector } from "../../../core/stores/directorStore";
import { useDirectorCtx } from "../../../core/directorContext";
import { resolveModelCard } from "../../../core/stores/settingsStore";
import { useUi } from "../../../core/stores/uiStore";
import { projectProgress } from "../../../core/directorEngine";
import {
  DIRECTOR_TASKS, applyDirectorProposal, deterministicFindings, proposalImpact,
  rejectDirectorProposal, runDirector, runVisualReview,
} from "../../../core/studio/directorAgent";
import { useAgentProposals } from "../../../core/studio/agentGateway";
import { buildObjectIndex } from "../../../core/studio/objectIndex";
import { useJobCenter } from "../../../core/studio/jobCenter";
import { errMsg } from "../../../core/utils";
import { clearDirectorChat } from "../../../core/directorEngine";
import { AskCard } from "../../director/AskCard";
import { DockPanel } from "../shared/DockPanel";
import { SkillStationBadge } from "../shared/SkillBindingCard";
import {
  IcSend, IcSparkles, IcLoading, IcCheck, IcClose, IcBrain, IcWarn, IcStop, IcScan, IcLink, IcClapper,
} from "../../../ui/icons";
import type { DirectorFinding, DirectorMsg, DirectorPlanItem, DirectorProject, DirectorProposal } from "../../../core/types";

export function AIDirectorStation({ project }: { project: DirectorProject }) {
  const updateProject = useDirector((s) => s.updateProject);
  const ctxSegId = useDirectorCtx((s) => s.segId);
  const setSeg = useDirectorCtx((s) => s.setSeg);
  const session = project.directorSession;
  const messages = session?.messages ?? [];
  const [input, setInput] = useState("");
  const [streamText, setStreamText] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const index = useMemo(() => buildObjectIndex(project), [project]);
  const segView = ctxSegId ? index.byId.get(ctxSegId) : undefined;
  // 无 chat 模型时 resolveModelCard 会抛——这里只是探测可用性
  const chatReady = (() => {
    try {
      return !!resolveModelCard("chat").model;
    } catch {
      return false;
    }
  })();

  const proposals = (project.directorProposals ?? []).filter((p) => p.status === "pending");
  // zustand v5 + React 19：选择器每次返回新数组会被 useSyncExternalStore 判定快照变化 → 无限重渲染白屏，过滤必须在 useMemo 里做
  const allAgentProposals = useAgentProposals((s) => s.proposals);
  const externalPending = useMemo(
    () => allAgentProposals.filter((p) => p.projectId === project.id && p.status === "pending"),
    [allAgentProposals, project.id],
  );
  const findings = useMemo(() => deterministicFindings(project), [project]);
  const planItems = useMemo<DirectorPlanItem[]>(() => {
    // 待执行计划：最近一条 director 消息的 plan（未被标记完成的步骤）
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "director" && m.response?.plan?.length) return m.response.plan.filter((x) => !x.done);
    }
    return [];
  }, [messages]);
  const history = useMemo(() => (project.directorProposals ?? []).filter((p) => p.status !== "pending").slice(-8).reverse(), [project.directorProposals]);

  const busy = streamText !== null;
  const [ask, setAsk] = useState<{ text: React.ReactNode; run: () => void } | null>(null);

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setInput("");
    setStreamText("");
    abortRef.current = new AbortController();
    try {
      await runDirector(project.id, text, {
        segId: ctxSegId,
        signal: abortRef.current.signal,
        onText: (f) => {
          setStreamText(f);
          requestAnimationFrame(() => listRef.current?.scrollTo({ top: 1e9 }));
        },
      });
    } catch (e) {
      useUi.getState().toast?.(errMsg(e), "err");
    } finally {
      setStreamText(null);
      requestAnimationFrame(() => listRef.current?.scrollTo({ top: 1e9 }));
    }
  };

  const runTask = async (taskId: string) => {
    if (busy) return;
    const task = DIRECTOR_TASKS.find((t) => t.id === taskId);
    if (!task) return;
    if (task.id === "review") {
      // 视觉审片走专用通道（抽帧 + vision 模型，P4 最小实现）
      if (!segView) return void useUi.getState().toast?.("请先在 H3 工位选中一个片段", "err");
      setStreamText("");
      try {
        await runVisualReview(project.id, segView.segment.id, { onText: setStreamText });
      } catch (e) {
        useUi.getState().toast?.(errMsg(e), "err");
      } finally {
        setStreamText(null);
      }
      return;
    }
    const prompt = await task.build(project, ctxSegId);
    await send(prompt);
  };

  const gotoSegment = (segId?: string) => {
    if (!segId) return;
    setSeg(segId);
    updateProject(project.id, { studioUi: { ...(project.studioUi ?? { station: "h3" }), station: "h3", segId } });
  };

  return (
    <>
      {/* 左：导演记忆与任务 */}
      <DockPanel className="ai-left" title="AI 导演" projectId={project.id} widthKey="aiLeft" width={project.studioUi?.panelWidths?.aiLeft ?? 230}>
        <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="st-hint">导演任务（基于真实项目状态，不是泛化模板）</span>
          {DIRECTOR_TASKS.map((t) => (
            <button key={t.id} className="st-btn" disabled={busy || !chatReady} title={t.desc} onClick={() => void runTask(t.id)}>
              <IcSparkles size={13} /> {t.label}
            </button>
          ))}
          {!chatReady ? <span className="st-hint">未配置 chat 角色模型——请到设置 → 模型配置</span> : null}
        </div>
        <div style={{ borderTop: "1px solid var(--studio-border)", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="st-hint">待执行计划（{planItems.length} 步）</span>
          {planItems.length === 0 ? <span className="st-hint">暂无——让 AI 导演「制定生产计划」</span> : null}
          {planItems.slice(0, 6).map((step, i) => (
            <div key={step.id} className="st-hint" style={{ display: "flex", gap: 6 }}>
              <b style={{ color: "var(--studio-text-2)" }}>{i + 1}.</b>
              <span style={{ flex: 1 }}>{step.title}</span>
              {step.targetIds.length ? (
                <button className="st-btn sm ghost" style={{ height: 20, padding: "0 4px" }} title="到 H3 定位目标片段" onClick={() => gotoSegment(step.targetIds[0])}>
                  去
                </button>
              ) : null}
            </div>
          ))}
        </div>
        {history.length ? (
          <div style={{ borderTop: "1px solid var(--studio-border)", padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="st-hint">历史决策（审计）</span>
            {history.map((p) => (
              <div key={p.id} className="st-hint" style={{ display: "flex", gap: 4, alignItems: "center" }}>
                {p.status === "applied" ? <IcCheck size={10} style={{ color: "var(--ok)" }} /> : <IcClose size={10} style={{ color: "var(--text-3)" }} />}
                <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.title}</span>
              </div>
            ))}
          </div>
        ) : null}
      </DockPanel>

      {/* 中：对话与结构化提案 */}
      <section className="ai-canvas">
        <div className="st-panel-h">
          <IcBrain size={13} /> 导演对话
          <span className="st-hint" style={{ marginLeft: 8 }}>回复含提案/计划时逐条审核——自由文本不会直接写项目</span>
          <span style={{ marginLeft: "auto" }}><SkillStationBadge project={project} context="studio.director" /></span>
          {messages.length ? (
            <button
              className="st-btn sm ghost"
              title="清空导演对话与前情摘要（提案与历史决策审计保留）"
              onClick={() =>
                setAsk({
                  text: (
                    <>
                      清空与 AI 导演的对话（{messages.length} 条消息 + 前情摘要）？
                      <div className="st-hint" style={{ marginTop: 4 }}>提案与「历史决策」审计记录保留，不受影响。此操作不可撤销。</div>
                    </>
                  ),
                  run: () => clearDirectorChat(project.id),
                })
              }
            >
              <IcClose size={11} /> 清空对话
            </button>
          ) : null}
          {session?.summary ? (
            <span className="st-hint" title={session.summary.slice(0, 200)}>已压缩前情 · {messages.length} 条</span>
          ) : null}
        </div>
        <div className="ai-msgs" ref={listRef}>
          {messages.length === 0 && !busy ? (
            <div className="st-empty" style={{ margin: "auto" }}>
              <IcBrain size={30} />
              <b>AI 导演已就绪</b>
              <span>它读过你的剧本、片段、Take 与质检结果。点左侧「全项目体检」开始，或直接问项目问题。</span>
            </div>
          ) : null}
          {messages.map((m) => (
            <MessageCard key={m.id} msg={m} project={project} onGoto={gotoSegment} />
          ))}
          {busy ? (
            <div className="ai-msg bot">
              <span className="who">AI 导演 · 输入中…</span>
              <div className="bubble">
                {streamText ? streamText : <IcLoading size={14} />}
              </div>
            </div>
          ) : null}
        </div>
        <div className="ai-input">
          <textarea
            className="st-area"
            placeholder={segView ? `问当前项目或片段「${segView.segment.summary.slice(0, 14)}」…（Enter 发送）` : "问项目任何状态——剧本/片段/连续性/生产计划…（Enter 发送）"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
          />
          {busy ? (
            <button className="st-btn" title="中断本轮回答" onClick={() => abortRef.current?.abort()}>
              <IcStop size={13} /> 停止
            </button>
          ) : (
            <button className="st-btn primary" disabled={!input.trim()} onClick={() => void send(input)}>
              <IcSend size={13} /> 发送
            </button>
          )}
        </div>
      </section>

      {/* 右：项目诊断（确定性分析的实时投影，§6.1） */}
      <DockPanel
        className="ai-right"
        title={`项目诊断（${findings.length}）`}
        projectId={project.id}
        widthKey="aiRight"
        width={project.studioUi?.panelWidths?.aiRight ?? 280}
        headExtra={
          <button className="st-btn sm ghost" style={{ marginLeft: "auto" }} title="立即重跑确定性检查（连续性/缺片/失败/质检）" onClick={() => useJobCenter.getState().setPanelOpen(true)}>
            <IcScan size={11} />
          </button>
        }
      >
        <DiagnosticsPanel project={project} findings={findings} onGoto={gotoSegment} />
        {/* 待审提案（项目池 + 外部 Agent，统一入口 §4.1） */}
        {proposals.length || externalPending.length ? (
          <div style={{ borderTop: "1px solid var(--studio-border)", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="st-hint">待审提案（{proposals.length + externalPending.length}）</span>
            {proposals.map((p) => (
              <ProposalCard key={p.id} proposal={p} project={project} onGoto={gotoSegment} />
            ))}
            {externalPending.map((p) => (
              <ExternalProposalCard key={p.id} projectId={project.id} proposal={p} onGoto={gotoSegment} />
            ))}
          </div>
        ) : null}
      </DockPanel>
        {ask ? (
      <AskCard
        text={ask.text}
        okText="确认清空"
        danger
        onConfirm={() => {
          ask.run();
          setAsk(null);
        }}
        onCancel={() => setAsk(null)}
      />
    ) : null}
</>
  );
}

/* ---------------- 消息卡：reply + findings + proposals + plan + questions ---------------- */

function MessageCard({ msg, project, onGoto }: { msg: DirectorMsg; project: DirectorProject; onGoto: (id?: string) => void }) {
  if (msg.role === "user") {
    return (
      <div className="ai-msg user">
        <span className="who">我 · {new Date(msg.at).toLocaleTimeString()}</span>
        <div className="bubble">{msg.text}</div>
      </div>
    );
  }
  const r = msg.response;
  return (
    <div className="ai-msg bot">
      <span className="who">AI 导演 · {new Date(msg.at).toLocaleTimeString()}</span>
      <div className="bubble">
        {msg.text}
        {msg.images?.length ? (
          <div className="ai-imgs">
            {msg.images.map((img, i) => (
              <img key={i} src={img} alt={`审片帧 ${i + 1}`} />
            ))}
          </div>
        ) : null}
        {r?.questions?.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
            {r.questions.map((q) => (
              <div key={q.id} style={{ border: "1px solid var(--studio-border)", borderRadius: 5, padding: "6px 8px", fontSize: 12 }}>
                <b>❓ {q.text}</b>
                {q.options?.length ? <div className="st-hint">{q.options.join(" / ")}</div> : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {r?.findings?.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%" }}>
          {r.findings.slice(0, 6).map((f, i) => (
            <FindingRow key={i} f={f} onGoto={onGoto} />
          ))}
        </div>
      ) : null}
      {r?.proposals?.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%" }}>
          {r.proposals.map((p) => (
            <ProposalCard key={p.id} proposal={{ ...p, status: (project.directorProposals ?? []).find((x) => x.id === p.id)?.status ?? p.status }} project={project} onGoto={onGoto} />
          ))}
        </div>
      ) : null}
      {r?.plan?.length ? (
        <div style={{ border: "1px solid var(--studio-border)", borderRadius: 5, padding: "6px 8px", width: "100%", display: "flex", flexDirection: "column", gap: 4 }}>
          <b style={{ fontSize: 12 }}>📋 建议执行计划（到各工位执行）</b>
          {r.plan.map((step, i) => (
            <div key={step.id} className="st-hint" style={{ display: "flex", gap: 6 }}>
              <span>{i + 1}. {step.title}</span>
              {step.targetIds.length ? (
                <button className="st-btn sm ghost" style={{ height: 18, padding: "0 4px", fontSize: 10 }} onClick={() => onGoto(step.targetIds[0])} title="到 H3 定位">
                  <IcClapper size={9} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FindingRow({ f, onGoto }: { f: DirectorFinding; onGoto: (id?: string) => void }) {
  const sev = f.severity === "blocker" ? "err" : f.severity === "warning" ? "warn" : "";
  return (
    <div className={`po-issue lv-${f.severity === "blocker" ? "error" : f.severity === "warning" ? "warning" : "info"}`} style={{ cursor: f.targetId ? "pointer" : "default" }} onClick={() => onGoto(f.targetId)}>
      <IcWarn size={12} style={{ flex: "none", marginTop: 2, color: f.severity === "blocker" ? "var(--danger)" : f.severity === "warning" ? "var(--warn)" : "var(--text-3)" }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12 }}>{f.evidence}</div>
        <div className="st-hint">{f.suggestion}</div>
      </div>
      <span className={`st-pill ${sev}`} style={{ marginLeft: "auto", flex: "none" }}>{f.category}</span>
    </div>
  );
}

/* ---------------- 提案卡（§3.3：依据 / 影响 / 采用 / 驳回 / 去执行） ---------------- */

function ProposalCard({ proposal: p, project, onGoto }: { proposal: DirectorProposal; project: DirectorProject; onGoto: (id?: string) => void }) {
  const [detail, setDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const impact = useMemo(() => p.impact ?? proposalImpact(project, p), [project, p]);
  const applied = p.status === "applied";
  const rejected = p.status === "rejected";
  const segLabel = useMemo(() => {
    if (!p.targetId) return null;
    const v = buildObjectIndex(project).byId.get(p.targetId);
    return v ? `段 ${String(v.storyIndex + 1).padStart(2, "0")}` : null;
  }, [project, p.targetId]);

  const apply = async () => {
    setBusy(true);
    try {
      const note = applyDirectorProposal(project.id, p);
      useUi.getState().toast?.(note, "ok");
    } catch (e) {
      useUi.getState().toast?.(errMsg(e), "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ border: `1px solid ${applied ? "color-mix(in srgb, var(--ok) 40%, transparent)" : rejected ? "var(--studio-border)" : "var(--studio-border)"}`, borderRadius: 6, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6, opacity: rejected ? 0.55 : 1 }}>
      <div className="st-row between">
        <b style={{ fontSize: 12.5 }}>
          <IcLink size={11} style={{ verticalAlign: -1, marginRight: 4, color: "var(--studio-accent)" }} />
          {p.title}
        </b>
        <span className={`st-pill ${applied ? "ok" : rejected ? "" : "accent"}`}>{applied ? "已应用" : rejected ? "已驳回" : p.targetType}</span>
      </div>
      {p.reason ? <span className="st-hint" style={{ lineHeight: 1.6 }}>{p.reason}</span> : null}
      {p.evidence.length ? (
        <details onToggle={(e) => setDetail((e.target as HTMLDetailsElement).open)}>
          <summary className="st-hint" style={{ cursor: "pointer" }}>
            依据 {p.evidence.length} 条 · 影响：{(impact?.invalidatedSegmentIds ?? []).length} 片段 / {(impact?.staleTakeIds ?? []).length} Take / {(impact?.rebuildMicroRefIds ?? []).length} 微参考
            {detail ? "（点收起）" : ""}
          </summary>
          <ul style={{ margin: "6px 0 0 16px", display: "flex", flexDirection: "column", gap: 2 }}>
            {p.evidence.map((e, i) => (
              <li key={i} className="st-hint">{e}</li>
            ))}
          </ul>
          <div className="st-hint" style={{ marginTop: 6 }}>变更内容（patch，应用前可核对）：</div>
          <pre style={{ margin: "4px 0 0", fontSize: 10.5, lineHeight: 1.5, whiteSpace: "pre-wrap", background: "var(--studio-panel-2)", borderRadius: 4, padding: 6, maxHeight: 160, overflow: "auto" }}>
            {JSON.stringify(p.patch, null, 2)}
          </pre>
        </details>
      ) : null}
      {p.status === "pending" ? (
        <div className="st-row">
          <button className="st-btn sm primary" disabled={busy} onClick={() => void apply()}>
            <IcCheck size={12} /> 采用
          </button>
          <button className="st-btn sm" disabled={busy} title="驳回（保留审计记录）" onClick={() => rejectDirectorProposal(project.id, p.id)}>
            <IcClose size={12} /> 驳回
          </button>
          {segLabel ? (
            <button className="st-btn sm ghost" title="到 H3 查看目标片段" onClick={() => onGoto(p.targetId)}>
              <IcClapper size={11} /> {segLabel}
            </button>
          ) : null}
        </div>
      ) : null}
      {rejected && p.rejectReason ? <span className="st-hint">驳回原因：{p.rejectReason}</span> : null}
    </div>
  );
}

/* ---------------- 右栏：确定性诊断投影 ---------------- */

function DiagnosticsPanel({ project, findings, onGoto }: { project: DirectorProject; findings: DirectorFinding[]; onGoto: (id?: string) => void }) {
  const progress = projectProgress(project);
  const groups = useMemo(() => {
    const g: Record<string, DirectorFinding[]> = {};
    for (const f of findings) (g[f.category] ??= []).push(f);
    return g;
  }, [findings]);
  const LABEL: Record<string, string> = { story: "叙事", continuity: "连续性", prompt: "提示词", reference: "参考", engine: "引擎", quality: "质量", delivery: "交付" };
  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 12 }}>
        <span>片段 <b>{progress.total}</b></span>
        <span>已采用 <b>{progress.approved}</b></span>
        <span>缺片 <b>{progress.missing}</b></span>
        <span>问题 <b>{findings.length}</b></span>
      </div>
      {findings.length === 0 ? (
        <div className="st-empty" style={{ padding: 16 }}>
          <IcCheck size={20} style={{ color: "var(--ok)" }} />
          <b>确定性检查全部通过</b>
          <span>缺片 / 连续性 / 失败任务 / 质检均无问题。</span>
        </div>
      ) : null}
      {Object.entries(groups).map(([cat, list]) => (
        <div key={cat} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="st-hint">{LABEL[cat] ?? cat}（{list.length}）</span>
          {list.map((f, i) => (
            <FindingRow key={i} f={f} onGoto={onGoto} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* 外部 Agent 提案卡（agentGateway 的 before/after 文本提案；应用走受控应用器） */
function ExternalProposalCard({ projectId, proposal: p, onGoto }: { projectId: string; proposal: import("../../../core/studio/agentGateway").AgentProposal; onGoto: (id?: string) => void }) {
  const decide = useAgentProposals((s) => s.decide);
  const apply = async (kind: import("../../../core/studio/agentGateway").AgentProposal["kind"]) => {
    try {
      if (kind === "script") {
        const { applyScriptProposal } = await import("../../../core/studio/agentGateway");
        applyScriptProposal(projectId, p.title, p.after);
      } else if (kind === "character" && p.targetId) {
        const { applyCharacterProposal } = await import("../../../core/studio/agentGateway");
        applyCharacterProposal(projectId, p.targetId, p.after);
      } else if (kind === "shot" && p.targetId) {
        try {
          const { applyShotProposal } = await import("../../../core/studio/agentGateway");
          applyShotProposal(projectId, p.targetId, JSON.parse(p.after) as { summary?: string; dialogue?: string[] });
        } catch {
          const { applyShotProposal } = await import("../../../core/studio/agentGateway");
          applyShotProposal(projectId, p.targetId, { summary: p.after });
        }
      } else if (kind === "prompt" && p.targetId) {
        const { applyPromptProposal } = await import("../../../core/studio/agentGateway");
        applyPromptProposal(projectId, p.targetId, p.after);
      }
      decide(p.id, true);
      useUi.getState().toast?.("外部提案已应用（锁定最终稿不受影响）", "ok");
    } catch (e) {
      useUi.getState().toast?.(errMsg(e), "err");
    }
  };
  return (
    <div style={{ border: "1px dashed var(--studio-border)", borderRadius: 6, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="st-row between">
        <b style={{ fontSize: 12.5 }}>🔌 {p.title}</b>
        <span className="st-pill">{p.from}</span>
      </div>
      <span className="st-hint">{p.summary}</span>
      <details>
        <summary className="st-hint" style={{ cursor: "pointer" }}>差异</summary>
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <pre style={{ flex: 1, margin: 0, fontSize: 10.5, whiteSpace: "pre-wrap", color: "var(--studio-text-3)", maxHeight: 110, overflow: "auto" }}>{p.before.slice(0, 400) || "（空）"}</pre>
          <pre style={{ flex: 1, margin: 0, fontSize: 10.5, whiteSpace: "pre-wrap", maxHeight: 110, overflow: "auto" }}>{p.after.slice(0, 400)}</pre>
        </div>
      </details>
      <div className="st-row">
        <button className="st-btn sm primary" onClick={() => void apply(p.kind)}><IcCheck size={12} /> 应用</button>
        <button className="st-btn sm" onClick={() => decide(p.id, false)}><IcClose size={12} /> 驳回</button>
        {p.targetId ? (
          <button className="st-btn sm ghost" title="定位目标片段" onClick={() => onGoto(p.targetId)}><IcClapper size={11} /> 定位</button>
        ) : null}
      </div>
    </div>
  );
}
