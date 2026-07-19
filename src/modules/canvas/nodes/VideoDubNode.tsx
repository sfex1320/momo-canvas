/**
 * 视频配音节点 — 上游视频（绿口）+ 音频（橙口）→ 本地重编码：
 * 替换原声（默认）或与原声混合；配完自动落进资产库。零模型成本。
 */
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortAudioIn, PortOut, PortVideoIn } from "../NodeShell";
import { IcDownload, IcDub, IcLoading } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { useSettings } from "../../../core/stores/settingsStore";
import { toast } from "../../../core/stores/uiStore";
import { runFlow } from "../../../core/runner";
import { saveVideoAs } from "../../../core/services/imageSaver";
import { errMsg } from "../../../core/utils";
import { VideoThumb } from "../../../ui/VideoThumb";
import type { VideoDubData } from "../../../core/types";

export const VideoDubNode = memo(function VideoDubNode({ id, data, selected }: NodeProps) {
  const d = data as VideoDubData;
  const upd = useBoard((s) => s.updateData);
  const running = d.status === "running";

  const save = async () => {
    if (!d.resultUrl) return;
    try {
      const p = await saveVideoAs(d.resultUrl, useSettings.getState().settings.save, { model: "配音" });
      if (p) toast(`已保存 → ${p}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  return (
    <NodeShell
      id={id}
      title="视频配音"
      icon={<IcDub size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={300}
      headExtra={
        d.resultUrl ? (
          <span className="acts nodrag" style={{ opacity: 1 }}>
            <button className="icon-btn" title="保存到本地" onClick={() => void save()}>
              <IcDownload size={17} />
            </button>
          </span>
        ) : undefined
      }
    >
      <div className="mnode-body">
        <div className="lang-seg nodrag" title="替换 = 只保留新音频；混合 = 原声与新音频叠加">
          <button className={(d.mode ?? "replace") === "replace" ? "on" : ""} onClick={() => upd(id, { mode: "replace" })}>
            替换原声
          </button>
          <button className={d.mode === "mix" ? "on" : ""} onClick={() => upd(id, { mode: "mix" })}>
            与原声混合
          </button>
        </div>
        <p className="hint" style={{ fontSize: 11.5, color: "var(--text-3)", margin: 0, lineHeight: 1.6 }}>
          绿口接视频、橙口接音频（音频/生成音频节点）。本地实时重编码（耗时约等于视频时长），输出 webm。
          音频短于视频则后段静音，长于视频则截断。
        </p>
        <button className="btn primary nodrag" disabled={running} onClick={() => void runFlow(id)}>
          {running ? <IcLoading size={17} /> : <IcDub size={16} />}
          {running ? "重编码中…" : "开始配音"}
        </button>
        {running && d.progress ? (
          <div className="progress-line">
            <IcLoading size={14} />
            {d.progress}
          </div>
        ) : null}
        {d.resultUrl && !running ? <VideoThumb className="img-main nodrag" src={d.resultUrl} /> : null}
      </div>
      <PortVideoIn top={26} />
      <PortAudioIn top={58} />
      <PortOut kind="video" />
    </NodeShell>
  );
});
