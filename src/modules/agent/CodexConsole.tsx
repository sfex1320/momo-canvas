import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { codexText, type CodexTextMessage } from "../../core/codexBridge";
import { isTauri, errMsg } from "../../core/utils";
import { IcClose, IcFolder, IcSend, IcStop } from "../../ui/icons";
import "./codex-console.css";

/** 本机会话与项目任务独立于画布 Agent，避免把文件权限带入普通聊天。 */
export function CodexConsole({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<"chat" | "task">("chat");
  const [folder, setFolder] = useState("");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<CodexTextMessage[]>([]);
  const [live, setLive] = useState("");
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const mask = useRef<HTMLDivElement>(null);
  const draftInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const background = Array.from(document.body.children).filter((el): el is HTMLElement => el instanceof HTMLElement && el !== mask.current && !el.inert);
    background.forEach(el => { el.inert = true; });
    draftInput.current?.focus();
    return () => { background.forEach(el => { el.inert = false; }); previous?.focus(); };
  }, []);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { transcript.current?.scrollTo({ top: transcript.current.scrollHeight }); }, [messages, live]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape" && !running) { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [running, onClose]);
  const chooseFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const p = await open({ directory: true, title: "选择允许 Codex 修改的任务文件夹" });
      if (typeof p === "string") { setFolder(p); setMessages([]); }
    } catch (e) { setError(errMsg(e)); }
  };
  const run = async () => {
    if (!draft.trim() || running || (mode === "task" && !folder)) return;
    const next: CodexTextMessage[] = [...messages, { role: "user", text: draft.trim() }];
    setMessages(next); setDraft(""); setLive(""); setError(""); setRunning(true); setStage("连接本机 Codex…");
    const abort = new AbortController(); controller.current = abort;
    try {
      const result = await codexText({ mode, workspace: mode === "task" ? folder : undefined, messages: next.slice(-12) }, abort.signal, event => {
        if (event.delta) setLive(v => v + event.delta);
        if (event.stage) setStage(event.stage);
      });
      setMessages(v => [...v, { role: "assistant", text: result.text }]); setLive(""); setStage("已完成");
    } catch (e) { setError(errMsg(e)); setStage(abort.signal.aborted ? "已停止" : "未完成"); }
    finally { setRunning(false); controller.current = null; }
  };
  return createPortal(<div ref={mask} className="codex-console-mask" onMouseDown={e => e.stopPropagation()} onKeyDown={e => {
    e.stopPropagation();
    if (e.key !== "Tab") return;
    const controls = mask.current?.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),input:not(:disabled),[tabindex="0"]');
    if (!controls?.length) return;
    const first = controls[0], last = controls[controls.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }}>
    <section className="codex-console" role="dialog" aria-modal="true" aria-label="Codex 助手">
      <header><div><b>Codex 助手</b><span>本机会员 · 共享额度</span></div><button className="icon-btn" aria-label="关闭 Codex 助手" disabled={running} onClick={onClose}><IcClose size={18} /></button></header>
      <div className="cc-tools"><div className="cc-modes">{(["chat", "task"] as const).map(m => <button key={m} className={mode === m ? "on" : ""} disabled={running} onClick={() => { setMode(m); setMessages([]); setLive(""); setError(""); }}>{m === "chat" ? "对话" : "任务"}</button>)}</div>
        <button className="btn sm" disabled={running || !messages.length} onClick={() => { setMessages([]); setLive(""); setError(""); }}>新对话</button></div>
      {mode === "task" ? <div className="cc-scope"><button className="btn sm" disabled={running || !isTauri} onClick={() => void chooseFolder()}><IcFolder size={15} />任务文件夹</button><span title={folder}>{folder || "先选择文件夹，再描述任务"}</span><small>执行可修改此文件夹并运行命令；不开放网络。需要额外交互授权时会停止。</small></div> : <p className="cc-note">讨论方案、整理提示词与分析文字。使用最近 12 条消息作为上下文；关闭窗口会清空本次对话。</p>}
      <div className="cc-transcript" ref={transcript} aria-live="polite">
        {!messages.length && <div className="cc-empty"><b>{mode === "chat" ? "从一个想法开始" : "让 Codex 处理项目文件"}</b><p>{mode === "chat" ? "例如：帮我把文化墙设计需求整理成绘图提示词。" : "例如：整理本文件夹中的素材清单，生成一份 Markdown 报告。"}</p></div>}
        {messages.map((m, i) => <article key={i} className={`cc-message ${m.role}`}><small>{m.role === "user" ? "你" : "Codex"}</small><div>{m.text}</div></article>)}
        {live && <article className="cc-message assistant"><small>Codex</small><div>{live}</div></article>}
      </div>
      <footer>{error && <p role="alert">{error}</p>}<textarea ref={draftInput} className="input" aria-label="发给 Codex 的内容" placeholder={mode === "chat" ? "输入你的想法…" : "描述要完成的任务…"} value={draft} disabled={running} onChange={e => setDraft(e.target.value)} />
        <div><span role="status">{stage || (isTauri ? "沿用 Codex 登录，不使用中转站 API Key" : "请在 MOMO 桌面端使用")}</span>{running ? <button className="btn sm" onClick={() => controller.current?.abort()}><IcStop size={14} />停止</button> : <button className="btn sm primary" disabled={!isTauri || !draft.trim() || (mode === "task" && !folder)} onClick={() => void run()}><IcSend size={14} />{mode === "task" ? "执行" : "发送"}</button>}</div>
      </footer>
    </section>
  </div>, document.body);
}
