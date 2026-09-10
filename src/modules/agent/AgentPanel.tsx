/**
 * 侧边创作助手 —— 合并原「对话节点」与「Agent 模式」：
 *   聊天：多模态对话（可附图、可联网），流式回复；任何回答可一键「在画布生图」；
 *        多轮讨论上下文锁定，超出窗口的较早对话自动压缩成前情摘要延续；
 *   Agent：描述需求，AI 内部搜索/抉择/出图出片，结果一键发到画布。
 * 面板停靠在画布右侧，聊天与画布操作互不遮挡；支持把图片（作参考图）、视频（落画布）、文字直接拖入。
 */
import { useEffect, useRef, useState } from "react";
import { CodexConsole } from "./CodexConsole";
import { useAgent } from "../../core/stores/agentStore";
import { generationRefs } from "../../core/agentTurn";
import { useUi } from "../../core/stores/uiStore";
import { useBoard } from "../../core/stores/boardStore";
import { useAssets } from "../../core/stores/assetStore";
import { stopAssistant, answerAgentQuestion, canvasCenterPos, genImageOnCanvas, sendAgentMessage, sendResultToCanvas, sendSideChat } from "../../core/agentEngine";
import { assetToDataUrl, assetUrl } from "../../core/services/assetFiles";
import { videoDuration } from "../../core/videoEdit";
import { errMsg, fileToDataUrl } from "../../core/utils";
import { chatCaps } from "../../core/modelMeta";
import { canUseMiniMaxSearch } from "../../core/services/webSearch";
import { resolveModelCard } from "../../core/stores/settingsStore";
import { startVoiceCall, stopVoiceCall, subscribeVoice, voiceInputOnce, voiceState, type VoiceState } from "../../core/voiceChat";
import { getNativeDragAsset } from "../assets/dragState";
import { importVideoFile } from "../canvas/nodes/VideoNode";
import { ModelPicker } from "../../ui/ModelPicker";
import { Thumb } from "../../ui/Thumb";
import { ContextMenu, type CmItem } from "../canvas/ContextMenu";
import {
  IcBrain,
  IcChat,
  IcCheck,
  IcClose,
  IcCopy,
  IcGlobe,
  IcImage,
  IcLoading,
  IcMic,
  IcNote,
  IcPlus,
  IcSend,
  IcSparkles,
  IcText,
  IcTrash,
  IcVideo,
  IcActivity,
} from "../../ui/icons";
import { toast } from "../../core/stores/uiStore";
import type { AgentMsg, AgentResult, AgentStep } from "../../core/types";
import "./agent.css";

const CHAT_SUGGESTIONS = [
  "帮我把这个想法完善成一段绘画提示词：雨后的森林小径",
  "图片里的场景换成夜景会是什么效果？帮我写提示词",
  "给我 3 个「猫咪宇航员」的画面创意",
];

const AGENT_SUGGESTIONS = [
  "帮我做一张赛博朋克风格的城市夜景海报",
  "搜一下最近流行的 UI 配色，做一张App启动页插画",
  "给我家的猫生成一段 5 秒的短视频",
  "做一组极简风的产品宣传图，3 个方案对比",
];

const VOICE_PHASE_TEXT: Record<VoiceState["phase"], string> = {
  idle: "已挂断",
  listening: "在听，请说…",
  recognizing: "识别中…",
  thinking: "助手思考中…",
  speaking: "助手在说（开口即可打断）",
};

/** 通话浮层：波形环 + 当前状态 + 上一句听到的内容 + 挂断 */
function VoiceCallOverlay({ v, onHangup }: { v: VoiceState; onHangup: () => void }) {
  const scale = 1 + Math.min(v.level * 3.2, 0.9);
  return (
    <div className="ag-call">
      <div className={`ag-call-orb ${v.phase}`} style={{ transform: `scale(${scale})` }}>
        <IcMic size={26} />
      </div>
      <div className="ag-call-phase">{VOICE_PHASE_TEXT[v.phase]}</div>
      {v.heard ? <div className="ag-call-heard">「{v.heard}」</div> : null}
      <button className="btn ag-call-hangup" onClick={onHangup}>
        <IcClose size={15} /> 挂断
      </button>
    </div>
  );
}

function StepIcon({ s }: { s: AgentStep }) {
  if (s.status === "running") return <IcLoading size={14} />;
  if (s.status === "error") return <IcClose size={14} />;
  if (s.kind === "search") return <IcGlobe size={14} />;
  if (s.kind === "think") return <IcBrain size={14} />;
  if (s.kind === "ask") return <IcChat size={14} />;
  if (s.kind === "image") return <IcImage size={14} />;
  if (s.kind === "tool") return <IcActivity size={14} />;
  return <IcVideo size={14} />;
}

function ResultCard({ r }: { r: AgentResult }) {
  const running = useAgent(s => s.running);
  const setLightbox = useUi((s) => s.setLightbox);
  return (
    <div className="ag-result">
      {r.kind === "video" ? (
        <video src={r.src} controls preload="metadata" />
      ) : (
        <span onClick={() => setLightbox(r.src, null, "image")}>
          <Thumb src={r.src} alt="" />
        </span>
      )}
      {r.prompt ? <div className="ag-res-prompt" title={r.prompt}>{r.prompt}</div> : null}
      <div className="ag-res-acts">
        {r.kind === "image" ? <button className="btn sm" disabled={running} onClick={() => { const state = useAgent.getState(); state.setMode("agent"); useAgent.setState({ attachments: [r.src], referenceMode: "auto" }); if (!state.draft.trim()) state.setDraft("基于这张图，"); }}><IcImage size={13} /> 以此图继续</button> : null}
        <button className="btn sm" onClick={() => sendResultToCanvas(r)}>
          <IcPlus size={13} /> 发到画布
        </button>
        {r.kind === "video" ? (
          <button className="btn sm" onClick={() => setLightbox(r.src, null, "video")}>
            放大预览
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** 可框选的消息气泡：文字可选中，右键可把选中文字建成提示词/备注节点；acts 为额外的整条操作 */
function MsgBubble({ text, acts }: { text: string; acts?: CmItem[] }) {
  const [menu, setMenu] = useState<{ x: number; y: number; sel: string } | null>(null);

  const onCtx = (e: React.MouseEvent) => {
    e.preventDefault();
    // 右键时读取当前框选内容（右键本身不会取消框选）
    const sel = (window.getSelection()?.toString() ?? "").trim();
    setMenu({ x: e.clientX, y: e.clientY, sel });
  };

  const createNode = (kind: "prompt" | "note", t: string) => {
    useBoard.getState().addNode(kind, canvasCenterPos(), { text: t });
    toast(`已创建${kind === "prompt" ? "提示词" : "备注"}节点（${t.slice(0, 14)}${t.length > 14 ? "…" : ""}）`, "ok");
  };

  return (
    <>
      <div className="ag-bubble" onContextMenu={onCtx}>
        {text}
      </div>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: "把选中文字建成提示词节点",
              icon: <IcText size={14} />,
              disabled: !menu.sel,
              onClick: () => createNode("prompt", menu.sel),
            },
            {
              label: "把选中文字建成备注节点",
              icon: <IcNote size={14} />,
              disabled: !menu.sel,
              onClick: () => createNode("note", menu.sel),
            },
            {
              label: "复制选中文字",
              icon: <IcCopy size={14} />,
              disabled: !menu.sel,
              onClick: () => void navigator.clipboard.writeText(menu.sel).then(() => toast("已复制", "ok")),
            },
            ...(acts?.length ? [{ sep: true } as CmItem, ...acts] : []),
          ]}
        />
      ) : null}
    </>
  );
}

/** 聊天模式的助手气泡：流式文本 + 思考折叠 + 在画布生图 / 复制 */
function ChatAssistantMsg({ m }: { m: AgentMsg }) {
  const [showThink, setShowThink] = useState(false);
  return (
    <div className="ag-msg assistant">
      {m.reasoning ? (
        <div className="ag-think">
          <button className="ag-think-toggle" onClick={() => setShowThink((v) => !v)}>
            {showThink ? "▾" : "▸"} 思考过程
          </button>
          {showThink ? <div className="ag-think-body">{m.reasoning}</div> : null}
        </div>
      ) : null}
      {m.text ? (
        <>
          <MsgBubble
            text={m.text}
            acts={[
              { label: "整条回复在画布生图", icon: <IcImage size={14} />, onClick: () => genImageOnCanvas(m.text) },
              {
                label: "复制全文",
                icon: <IcCopy size={14} />,
                onClick: () => void navigator.clipboard.writeText(m.text).then(() => toast("已复制", "ok")),
              },
            ]}
          />
          <div className="ag-msg-acts">
            <button className="btn sm" title="以这条回复为提示词，在画布创建生成图像节点并运行" onClick={() => genImageOnCanvas(m.text)}>
              <IcImage size={13} /> 在画布生图
            </button>
            <button
              className="btn sm"
              title="复制全文"
              onClick={() => {
                void navigator.clipboard.writeText(m.text).then(() => toast("已复制", "ok"));
              }}
            >
              <IcCopy size={13} /> 复制
            </button>
          </div>
        </>
      ) : (
        <div className="ag-bubble dim">{m.reasoning ? "" : "思考中…"}</div>
      )}
    </div>
  );
}

function AgentAssistantMsg({ m }: { m: AgentMsg }) {
  const [custom, setCustom] = useState("");
  const pendingQ = m.question && !m.question.answer ? m.question : null;
  return (
    <div className="ag-msg assistant">
      {m.steps?.length ? (
        <div className="ag-steps">
          {m.steps.map((s) => (
            <div key={s.id} className={`ag-step ${s.status}`}>
              <StepIcon s={s} />
              <span>{s.text}</span>
            </div>
          ))}
        </div>
      ) : null}
      {m.question ? (
        <div className={`ag-question ${pendingQ ? "" : "answered"}`}>
          <div className="ag-q-text">
            <IcChat size={15} /> {m.question.text}
          </div>
          {pendingQ ? (
            <>
              <div className="ag-q-options">
                {m.question.options.map((op) => (
                  <button key={op} className="ag-q-opt" onClick={() => answerAgentQuestion(m.id, op)}>
                    {op}
                  </button>
                ))}
              </div>
              <div className="ag-q-custom">
                <input
                  className="input"
                  placeholder="或者输入你自己的想法…"
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && custom.trim()) answerAgentQuestion(m.id, custom.trim());
                  }}
                />
                <button className="btn sm primary" disabled={!custom.trim()} onClick={() => answerAgentQuestion(m.id, custom.trim())}>
                  确定
                </button>
              </div>
            </>
          ) : (
            <div className="ag-q-answer">
              <IcCheck size={14} /> {m.question.answer}
            </div>
          )}
        </div>
      ) : null}
      {m.results?.length ? (
        <div className="ag-results">
          {m.results.map((r, i) => (
            <ResultCard key={i} r={r} />
          ))}
        </div>
      ) : null}
      {m.text ? <MsgBubble text={m.text} /> : null}
      {!m.text && !m.steps?.length && !m.question ? <div className="ag-bubble dim">思考中…</div> : null}
    </div>
  );
}

export function AgentPanel() {
  const [codexOpen, setCodexOpen] = useState(false);
  const messages = useAgent((s) => s.messages);
  const draft = useAgent((s) => s.draft);
  const attachments = useAgent((s) => s.attachments);
  const referenceMode = useAgent(s => s.referenceMode);
  const inheritedRefs = generationRefs([...messages, { role: "user", images: [] }]);
  const running = useAgent((s) => s.running);
  const modelId = useAgent((s) => s.modelId);
  const imageModelId = useAgent((s) => s.imageModelId);
  const videoModelId = useAgent((s) => s.videoModelId);
  const mode = useAgent((s) => s.mode);
  const webSearchOn = useAgent((s) => s.webSearch);
  const thinkingOn = useAgent((s) => s.thinkingOn);
  const toggleThinking = useAgent((s) => s.toggleThinking);
  const setDraft = useAgent((s) => s.setDraft);
  const addAttachments = useAgent((s) => s.addAttachments);
  const removeAttachment = useAgent((s) => s.removeAttachment);
  const setModelId = useAgent((s) => s.setModelId);
  const setImageModelId = useAgent((s) => s.setImageModelId);
  const setVideoModelId = useAgent((s) => s.setVideoModelId);
  const setMode = useAgent((s) => s.setMode);
  const toggleWebSearch = useAgent((s) => s.toggleWebSearch);
  const clear = useAgent((s) => s.clear);
  const awaiting = useAgent((s) => !!s.resolver);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [voice, setVoice] = useState<VoiceState>(voiceState);
  const inCall = voice.phase !== "idle";

  useEffect(() => subscribeVoice(setVoice), []);
  // 面板关闭/组件卸载时确保挂断，别把麦克风一直占着
  useEffect(() => () => stopVoiceCall(), []);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, running]);

  const pickFiles = async (files: FileList | File[] | null) => {
    if (!files?.length) return;
    const imgs = await Promise.all(
      Array.from(files).filter((f) => f.type.startsWith("image/")).map((f) => fileToDataUrl(f)),
    );
    if (imgs.length) addAttachments(imgs);
  };

  /** 拖入/粘贴的视频：落进资产库拿到持久地址后在画布中心建视频节点（聊天模型看不了视频，给画布用） */
  const videoToCanvas = async (f: File) => {
    const nid = useBoard.getState().addNode("video", canvasCenterPos(-160, -120), { status: "running", name: f.name });
    try {
      const { src, dur } = await importVideoFile(f);
      useBoard.getState().updateData(nid, { src, dur, status: "done" });
      toast("视频已放到画布：可接视频参考 / 配音等节点", "ok");
    } catch (err) {
      useBoard.getState().updateData(nid, { status: "error", error: errMsg(err) });
    }
  };

  /** 面板拖放：图片→参考图附件；视频→画布视频节点；文字/文本文件→填入输入框；资产库卡片同理会意 */
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.getData("momo/node-kind")) return; // 坞里的节点类型是给画布的，不拦截
    // 多选拖拽负载取第一张（创作助手按单图理解）
    const assetId = (e.dataTransfer.getData("momo/asset-id") || getNativeDragAsset() || "").split(",")[0] ?? "";
    if (assetId) {
      const it = useAssets.getState().items.find((x) => x.id === assetId);
      if (!it) return;
      try {
        if (it.kind === "image") {
          addAttachments([await assetToDataUrl(it.path, it.mime)]);
        } else if (it.kind === "video") {
          const src = assetUrl(it.path);
          useBoard.getState().addNode("video", canvasCenterPos(-160, -120), { src, name: it.name, status: "done", dur: await videoDuration(src) });
          toast("视频已放到画布", "ok");
        } else {
          toast("助手面板支持拖入图片 / 视频资产", "err");
        }
      } catch (err) {
        toast(`读取资产失败：${errMsg(err)}`, "err");
      }
      return;
    }
    const files = Array.from(e.dataTransfer.files ?? []);
    const vids = files.filter((f) => f.type.startsWith("video/") || /\.(mp4|webm|mov|mkv|m4v)$/i.test(f.name));
    for (const v of vids) await videoToCanvas(v);
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (imgs.length) await pickFiles(imgs);
    // 文本文件 / 拖来的纯文字 → 追加进输入框
    const txts = files.filter((f) => !vids.includes(f) && !imgs.includes(f) && (f.type.startsWith("text/") || /\.(txt|md|log)$/i.test(f.name)));
    let droppedText = "";
    for (const t of txts) droppedText += `${droppedText ? "\n" : ""}${(await t.text()).trim()}`;
    if (!droppedText && !files.length) droppedText = e.dataTransfer.getData("text/plain")?.trim() ?? "";
    if (droppedText) {
      const cur = useAgent.getState().draft;
      setDraft(cur ? `${cur}\n${droppedText}` : droppedText);
    }
  };

  const send = () => void (awaiting ? sendAgentMessage() : mode === "chat" ? sendSideChat() : sendAgentMessage());
  const suggestions = mode === "chat" ? CHAT_SUGGESTIONS : AGENT_SUGGESTIONS;
  // 联网按钮的提示随实际路由变化：MiniMax 官方搜索接口 / 模型请求内联网 / 通用搜索商。
  let searchTitle =
    mode === "chat" ? "联网搜索：发送前先搜资料再回答" : "联网：让模型带着联网能力规划（关闭时仍可用内置搜索动作查资料）";
  let capsNote: string | undefined;
  try {
    const card = resolveModelCard("chat", modelId);
    const caps = chatCaps(card);
    capsNote = caps.note;
    if (canUseMiniMaxSearch(card)) searchTitle = `联网搜索：使用「${card.name} · ${card.model}」的 MiniMax Coding Plan 搜索`;
    else if (caps.builtinSearch) searchTitle = `联网搜索：优先用「${card.name} · ${card.model}」自带的联网搜索，失败自动降级为内置搜索`;
    else if (mode === "agent") searchTitle = "联网：当前模型没有自带联网，Agent 仍会用内置搜索接口查资料";
  } catch {
    /* 未配置对话模型时按默认提示 */
  }

  return (
    <div
      className={`agent-panel ${dragOver ? "ag-drag" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="ag-head">
        {codexOpen && <CodexConsole onClose={() => setCodexOpen(false)} />}
        <IcSparkles size={18} />
        <b>创作助手</b>
        <button className="btn sm" title="使用本机 Codex 会员对话或执行文件任务" onClick={() => setCodexOpen(true)}>Codex</button>
        <span className="ag-seg">
          <button className={mode === "chat" ? "on" : ""} title="多模态聊天：完善想法与提示词，一键在画布生图" onClick={() => setMode("chat")}>
            聊天
          </button>
          <button className={mode === "agent" ? "on" : ""} title="Agent：自动搜资料、定方向、出图出片" onClick={() => setMode("agent")}>
            Agent
          </button>
        </span>
        <span style={{ flex: 1 }} />
        <button className={`icon-btn ${webSearchOn ? "on" : ""}`} title={searchTitle} onClick={toggleWebSearch}>
          <IcGlobe size={16} />
        </button>
        <button
          className={`icon-btn ${thinkingOn ? "on" : ""}`}
          title={
            thinkingOn
              ? "思考模式：已开启。点一下关闭——Ollama / 本地 GGUF 等支持思考的模型将跳过思考直接回答（仅创作助手生效，画布其他节点不受影响）"
              : "思考模式：已关闭。点一下开启——模型会先输出思考过程再回答（仅创作助手生效）"
          }
          onClick={toggleThinking}
        >
          <IcBrain size={16} />
        </button>
        <button
          className={`icon-btn ${inCall ? "on" : ""}`}
          title={
            inCall
              ? "挂断语音通话"
              : "语音通话：像打电话一样说话，说完自动识别并交给助手，回复会朗读出来（需在设置里配好「语音识别」模型）"
          }
          onClick={() => (inCall ? stopVoiceCall() : void startVoiceCall())}
        >
          <IcMic size={17} />
        </button>
        {running ? <button className="btn sm" title="停止本轮思考或生成" onClick={stopAssistant}><IcClose size={14} /> 停止</button> : null}
        <button className="icon-btn" title="清空对话" onClick={clear} disabled={running}>
          <IcTrash size={17} />
        </button>
      </div>
      <div className="ag-models">
        <span className="ag-mslot" title={`对话模型（聊天/Agent 都走它）${capsNote ? ` · 能力：${capsNote}` : ""}`}>
          <IcBrain size={13} />
          <small>对话</small>
          <ModelPicker role="chat" value={modelId} onChange={setModelId} />
        </span>
        <span className="ag-mslot" title="绘画模型：Agent 出图、聊天「在画布生图」都用它">
          <IcImage size={13} />
          <small>绘画</small>
          <ModelPicker role="image" value={imageModelId} onChange={setImageModelId} />
        </span>
        <span className="ag-mslot" title="视频模型：Agent 出片用">
          <IcVideo size={13} />
          <small>视频</small>
          <ModelPicker role="video" value={videoModelId} onChange={setVideoModelId} />
        </span>
      </div>

      <div className="ag-msgs" ref={listRef}>
        {messages.length === 0 ? (
          <div className="ag-welcome">
            <IcSparkles size={40} />
            <h2>{mode === "chat" ? "聊聊，再把想法变成图" : "想做什么，直接说"}</h2>
            <p>
              {mode === "chat"
                ? "用对话模型（支持多模态）完善创意与提示词，满意后一键在画布生成图片。"
                : "我会自己查资料、完善提示词，拿不定主意时会给你几个选项，确认后直接出图/出视频。"}
            </p>
            <div className="ag-sugg">
              {suggestions.map((s) => (
                <button key={s} className="ag-sugg-chip" onClick={() => setDraft(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="ag-msg user">
                {m.images?.length ? (
                  <div className="ag-uimgs">
                    {m.images.map((s, i) => (
                      <Thumb key={i} src={s} alt="" />
                    ))}
                  </div>
                ) : null}
                {m.text ? <div className="ag-bubble">{m.text}</div> : null}
              </div>
            ) : // 按消息产生时的模式渲染（不看当前面板模式），切标签不会让轨迹/待答问题/结果消失
            (m.kind ?? mode) === "chat" && !m.steps?.length && !m.question && !m.results?.length ? (
              <ChatAssistantMsg key={m.id} m={m} />
            ) : (
              <AgentAssistantMsg key={m.id} m={m} />
            ),
          )
        )}
      </div>

      {inCall ? <VoiceCallOverlay v={voice} onHangup={stopVoiceCall} /> : null}

      <div className="ag-input-wrap">
        {mode === "agent" && !running && !attachments.length && inheritedRefs.length > 0 ? <div className="ag-reference-plan">
          <div><b>{referenceMode === "none" ? "本轮不参考图片" : "可沿用的参考图"}</b><button className="btn sm" onClick={() => useAgent.setState({ referenceMode: referenceMode === "none" ? "auto" : "none" })}>{referenceMode === "none" ? "恢复参考" : "不用旧图"}</button></div>
          {referenceMode !== "none" ? <><div className="ag-reference-images">{inheritedRefs.map((src, i) => <button key={i} title={`只使用参考图 ${i + 1}`} onClick={() => useAgent.setState({ attachments: [src], referenceMode: "auto" })}><Thumb src={src} alt={`参考图 ${i + 1}`} /></button>)}</div><small>需要改图时使用；点击缩略图可只选这一张。新任务可点“不用旧图”。</small></> : <small>仍保留文字对话，本轮生成不传入历史图片。</small>}
        </div> : null}
        {attachments.length ? (
          <div className="ag-attach">
            {attachments.map((s, i) => (
              <span key={i} className="ag-att-item">
                <Thumb src={s} alt="" />
                <button className="ag-att-del" onClick={() => removeAttachment(i)}>
                  <IcClose size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="ag-input-row">
          <span className="ag-in-tools">
            <button className="icon-btn" title="添加参考图（也可直接粘贴图片）" onClick={() => fileRef.current?.click()}>
              <IcImage size={18} />
            </button>
            <button
              className="icon-btn"
              disabled={inCall || running}
              title="语音输入：说一句话自动转成文字填进输入框（说完停顿即结束录音）"
              onClick={() => void voiceInputOnce()}
            >
              <IcMic size={17} />
            </button>
          </span>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void pickFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <textarea
            className="textarea"
            rows={4}
            placeholder={
              awaiting
                ? "正在等你的选择：点上方选项，或在这里输入自己的想法后回车…"
                : mode === "chat"
                  ? "向 AI 提问…（Enter 发送；图片/视频/文字可直接拖入或粘贴）"
                  : "描述你想做的东西…（Enter 发送；图片/视频/文字可直接拖入或粘贴）"
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                const files = Array.from(e.clipboardData.files);
                void pickFiles(files.filter((f) => f.type.startsWith("image/")));
                for (const f of files.filter((f) => f.type.startsWith("video/"))) void videoToCanvas(f);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="send-btn" disabled={(running && !awaiting) || (awaiting ? !draft.trim() : !draft.trim() && !attachments.length)} onClick={send}>
            {running && !awaiting ? <IcLoading size={18} /> : <IcSend size={18} />}
          </button>
        </div>
      </div>
    </div>
  );
}
