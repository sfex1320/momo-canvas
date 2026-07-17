import { memo, useEffect, useRef } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortImageIn, PortOut, PortTextIn } from "../NodeShell";
import { IcBrain, IcChat, IcGlobe, IcLoading, IcSend, IcTrash } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { sendChat } from "../../../core/runner";
import { openExternal } from "../../../core/external";
import type { ChatData } from "../../../core/types";

export const ChatNode = memo(function ChatNode({ id, data, selected }: NodeProps) {
  const d = data as ChatData;
  const upd = useBoard((s) => s.updateData);
  const listRef = useRef<HTMLDivElement>(null);
  const running = d.status === "running";

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [d.messages]);

  return (
    <NodeShell
      id={id}
      title="对话助手"
      icon={<IcChat size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={390}
      headExtra={
        <span className="acts nodrag" style={{ opacity: 1 }}>
          <button
            className={`icon-btn ${d.webSearch ? "on" : ""}`}
            title={d.webSearch ? "联网搜索：开" : "联网搜索：关"}
            onClick={() => upd(id, { webSearch: !d.webSearch })}
          >
            <IcGlobe size={17} />
          </button>
          <button
            className={`icon-btn ${d.showThinking ? "on" : ""}`}
            title={d.showThinking ? "显示思考过程：开" : "显示思考过程：关"}
            onClick={() => upd(id, { showThinking: !d.showThinking })}
          >
            <IcBrain size={17} />
          </button>
          <button
            className="icon-btn"
            title="清空对话"
            onClick={() => upd(id, { messages: [], status: "idle", error: undefined })}
          >
            <IcTrash size={17} />
          </button>
        </span>
      }
    >
      <div className="mnode-body">
        <div className="chat-msgs nodrag nowheel" ref={listRef}>
          {d.messages.map((m, i) => (
            <MsgView key={i} m={m} showThinking={d.showThinking} />
          ))}
        </div>
        <div className="chat-input-row nodrag">
          <textarea
            className="textarea nowheel"
            rows={2}
            placeholder="向 AI 提问…（Enter 发送，可连接上游图片作为视觉输入）"
            value={d.draft}
            onChange={(e) => upd(id, { draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void sendChat(id);
              }
            }}
          />
          <button className="send-btn" disabled={running || !d.draft.trim()} onClick={() => void sendChat(id)}>
            {running ? <IcLoading size={18} /> : <IcSend size={18} />}
          </button>
        </div>
      </div>
      <PortTextIn />
      <PortImageIn />
      <PortOut kind="text" />
    </NodeShell>
  );
});

function MsgView({ m, showThinking }: { m: ChatData["messages"][number]; showThinking: boolean }) {
  return (
    <>
      {m.role === "assistant" && showThinking && m.reasoning ? (
        <details className="think">
          <summary>思考过程</summary>
          <div className="think-body">{m.reasoning}</div>
        </details>
      ) : null}
      {m.text || m.role === "user" ? (
        <div className={`bubble ${m.role}`}>
          {m.images?.length ? (
            <div className="bimgs">
              {m.images.map((s, i) => (
                <img key={i} src={s} alt="" />
              ))}
            </div>
          ) : null}
          {m.text || (m.role === "assistant" ? "…" : "")}
        </div>
      ) : m.role === "assistant" && !m.reasoning ? (
        <div className="bubble assistant">…</div>
      ) : null}
      {m.sources?.length ? (
        <div className="src-chips">
          {m.sources.map((s, i) => (
            <a key={i} title={s.title} onClick={() => void openExternal(s.url)}>
              [{i + 1}] {s.title}
            </a>
          ))}
        </div>
      ) : null}
    </>
  );
}
