/**
 * 生成音频节点 — TTS 朗读 / 音乐生成（音频模型角色）：
 * 文本留空自动取上游（分镜台词可直通）；openai 协议走 /audio/speech，
 * 中转站的音乐/克隆音色接口走自定义协议（{{prompt}} / {{voice}} 占位）。
 */
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortOut, PortTextIn } from "../NodeShell";
import { IcDownload, IcLoading, IcMic } from "../../../ui/icons";
import { ModelPicker } from "../../../ui/ModelPicker";
import { useBoard } from "../../../core/stores/boardStore";
import { useSettings } from "../../../core/stores/settingsStore";
import { toast } from "../../../core/stores/uiStore";
import { collectUpstream, runFlow } from "../../../core/runner";
import { saveAudioAs } from "../../../core/services/imageSaver";
import { errMsg } from "../../../core/utils";
import type { AudioGenData } from "../../../core/types";

export const AudioGenNode = memo(function AudioGenNode({ id, data, selected }: NodeProps) {
  const d = data as AudioGenData;
  const upd = useBoard((s) => s.updateData);
  // 上游已接入文本 → 文本框隐藏（运行时自动取上游；已手写的优先级更高）
  const hasUpText = useBoard(() => collectUpstream(id).texts.length > 0);
  const running = d.status === "running";

  const save = async () => {
    if (!d.resultUrl) return;
    try {
      const p = await saveAudioAs(d.resultUrl, useSettings.getState().settings.save, { prompt: d.text });
      if (p) toast(`已保存 → ${p}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  return (
    <NodeShell
      id={id}
      title="生成音频"
      icon={<IcMic size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={300}
      headExtra={
        d.resultUrl ? (
          <span className="acts nodrag" style={{ opacity: 1 }}>
            <button className="icon-btn" title="保存到本地" onClick={save}>
              <IcDownload size={17} />
            </button>
          </span>
        ) : undefined
      }
    >
      <div className="mnode-body">
        <div style={{ display: "flex", gap: 7 }}>
          <div style={{ flex: 1 }}>
            <ModelPicker role="audio" value={d.modelId} onChange={(v) => upd(id, { modelId: v })} />
          </div>
          <input
            className="input nodrag"
            style={{ flex: 0.8 }}
            placeholder="音色（如 alloy）"
            title="openai 协议 = voice 字段（alloy/echo/nova…）；自定义协议用 {{voice}} 占位"
            value={d.voice ?? ""}
            onChange={(e) => upd(id, { voice: e.target.value || undefined })}
          />
        </div>
        {hasUpText && !(d.text ?? "").trim() ? null : (
          <textarea
            className="textarea nodrag nowheel"
            rows={3}
            placeholder="朗读文本 / 音乐描述（留空自动取上游文本，分镜台词可直通）"
            value={d.text}
            onChange={(e) => upd(id, { text: e.target.value })}
          />
        )}
        <button className="btn primary nodrag" disabled={running} onClick={() => void runFlow(id)}>
          {running ? <IcLoading size={17} /> : <IcMic size={16} />}
          {running ? "合成中…" : "生成音频"}
        </button>
        {running && d.progress ? (
          <div className="progress-line">
            <IcLoading size={14} />
            {d.progress}
          </div>
        ) : null}
        {d.resultUrl && !running ? <audio className="audio-main nodrag" src={d.resultUrl} controls preload="none" /> : null}
      </div>
      <PortTextIn />
      <PortOut kind="audio" />
    </NodeShell>
  );
});
