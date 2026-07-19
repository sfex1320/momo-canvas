/**
 * 生成面板提示词栏 — LibLib 式画布交互：
 * 提示词 / 参考图胶囊 / 发送按钮集中在底部生成面板顶部一整行，节点上只留结果。
 * 生成图像的参考图胶囊可点击在光标处插入 @ 引用；生成视频的第 1/2 路胶囊标注首帧/尾帧。
 */
import { useRef } from "react";
import { useBoard } from "../../core/stores/boardStore";
import { collectUpstream, runFlow } from "../../core/runner";
import { Thumb } from "../../ui/Thumb";
import { PromptHistoryBtn } from "../../ui/PromptHistory";
import { AtTextArea, useOwnUpstreamImageRefs, type AtTextAreaHandle } from "../../ui/AtTextArea";
import { IcLoading, IcSend } from "../../ui/icons";

export function GenPromptBar({ nodeId, kind }: { nodeId: string; kind: "imageGen" | "videoGen" | "audioGen" }) {
  const node = useBoard((s) => s.nodes.find((n) => n.id === nodeId));
  const upd = useBoard((s) => s.updateData);
  const refs = useOwnUpstreamImageRefs(nodeId);
  const hasUpText = useBoard(() => collectUpstream(nodeId).texts.length > 0);
  const editorRef = useRef<AtTextAreaHandle>(null);
  if (!node) return null;
  const d = node.data as Record<string, unknown>;
  const field = kind === "audioGen" ? "text" : "prompt";
  const value = (d[field] as string | undefined) ?? "";
  const running = d.status === "running";
  const set = (t: string) => upd(nodeId, { [field]: t });
  const placeholder =
    kind === "imageGen"
      ? hasUpText
        ? "已接上游文本，留空自动使用；在此输入则优先生效…"
        : "描述你想生成的画面…"
      : kind === "videoGen"
        ? hasUpText
          ? "已接上游文本，留空自动使用；在此输入则优先生效…"
          : "描述你想生成的视频画面与运动…"
        : hasUpText
          ? "已接上游文本（分镜台词可直通），留空自动朗读…"
          : "输入要朗读的文本 / 音乐描述…";
  return (
    <div className="gd-prompt">
      {refs.length ? (
        <div className="gd-refs">
          {refs.map((r, i) => (
            <button
              key={`${r.label}_${i}`}
              className={`gd-ref ${kind === "imageGen" ? "" : "static"}`}
              title={
                kind === "imageGen"
                  ? `点击在光标处插入 @${r.label}（发给模型时按「图${i + 1}」编号）`
                  : kind === "videoGen"
                    ? i === 0
                      ? "第 1 路上游图 = 首帧"
                      : i === 1
                        ? "第 2 路上游图 = 尾帧（家族支持时）"
                        : `第 ${i + 1} 路上游图`
                    : undefined
              }
              onClick={kind === "imageGen" ? () => editorRef.current?.insertToken(r.label) : undefined}
            >
              <Thumb src={r.src} alt="" />
              <b>{i + 1}</b>
              {kind === "videoGen" && i < 2 ? <span className="gd-tag">{i === 0 ? "首帧" : "尾帧"}</span> : null}
            </button>
          ))}
          {kind === "imageGen" ? <span className="gd-hint">点击胶囊在提示词中 @ 引用</span> : null}
        </div>
      ) : null}
      <div className="gd-row">
        <AtTextArea
          ref={editorRef}
          rows={2}
          placeholder={placeholder}
          value={value}
          onChange={set}
          refs={kind === "imageGen" ? refs : []}
          style={{ flex: 1 }}
        />
        <div className="gd-side">
          {kind !== "audioGen" ? <PromptHistoryBtn onPick={set} /> : null}
          <button
            className="gd-send"
            disabled={!!running}
            title="生成（上游未运行的节点会按依赖顺序先自动运行）"
            onClick={() => void runFlow(nodeId)}
          >
            {running ? <IcLoading size={18} /> : <IcSend size={18} />}
          </button>
        </div>
      </div>
    </div>
  );
}
