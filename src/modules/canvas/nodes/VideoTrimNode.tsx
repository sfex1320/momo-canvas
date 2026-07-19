/**
 * 视频取段节点 —「5 秒里只有 2 秒能用」场景：本地重编码截取一段
 *  实验性：实时录制方案，处理耗时 ≈ 片段时长；输出 webm
 */
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortOut, PortVideoIn } from "../NodeShell";
import { IcDownload, IcFilmCut, IcLoading } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { useSettings } from "../../../core/stores/settingsStore";
import { toast } from "../../../core/stores/uiStore";
import { runFlow } from "../../../core/runner";
import { saveVideoAs } from "../../../core/services/imageSaver";
import { errMsg } from "../../../core/utils";
import { VideoThumb } from "../../../ui/VideoThumb";
import type { VideoTrimData } from "../../../core/types";

export const VideoTrimNode = memo(function VideoTrimNode({ id, data, selected }: NodeProps) {
  const d = data as VideoTrimData;
  const upd = useBoard((s) => s.updateData);
  const running = d.status === "running";

  const save = async () => {
    if (!d.resultUrl) return;
    try {
      const p = await saveVideoAs(d.resultUrl, useSettings.getState().settings.save, { model: "取段" });
      if (p) toast(`已保存 → ${p}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  return (
    <NodeShell
      id={id}
      title="视频取段"
      icon={<IcFilmCut size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={290}
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
        <div className="ctl-row nodrag">
          <span>起点(秒)</span>
          <input
            className="input"
            type="number"
            min={0}
            step={0.1}
            style={{ width: 92, minHeight: 32 }}
            value={d.start ?? 0}
            onChange={(e) => upd(id, { start: Math.max(0, Number(e.target.value)) })}
          />
          <span>终点</span>
          <input
            className="input"
            type="number"
            min={0}
            step={0.1}
            style={{ width: 92, minHeight: 32 }}
            placeholder="到结尾"
            value={d.end ?? ""}
            onChange={(e) => upd(id, { end: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) })}
          />
        </div>
        <p className="hint" style={{ fontSize: 11.5, color: "var(--text-3)", margin: 0, lineHeight: 1.6 }}>
          实验性：本地实时重编码（耗时约等于片段时长），输出 webm{d.srcDur ? ` · 上游视频约 ${d.srcDur.toFixed(1)}s` : ""}
        </p>
        <button className="btn primary nodrag" disabled={running} onClick={() => void runFlow(id)}>
          {running ? <IcLoading size={17} /> : <IcFilmCut size={16} />}
          {running ? "重编码中…" : "截取片段"}
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
      <PortOut kind="video" />
    </NodeShell>
  );
});
