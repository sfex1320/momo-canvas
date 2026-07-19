/**
 * 视频拼接节点 — 多路上游视频按连线位置（上→下）合成一条
 *  实验性：本地实时重编码，处理耗时 ≈ 总时长；分辨率取第一段
 */
import { memo, useMemo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortOut, PortVideoIn } from "../NodeShell";
import { IcDownload, IcFilmJoin, IcLoading } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { useSettings } from "../../../core/stores/settingsStore";
import { toast } from "../../../core/stores/uiStore";
import { collectUpstream, runFlow } from "../../../core/runner";
import { saveVideoAs } from "../../../core/services/imageSaver";
import { errMsg } from "../../../core/utils";
import { VideoThumb } from "../../../ui/VideoThumb";
import type { VideoConcatData } from "../../../core/types";

export const VideoConcatNode = memo(function VideoConcatNode({ id, data, selected }: NodeProps) {
  const d = data as VideoConcatData;
  const nodes = useBoard((s) => s.nodes);
  const edges = useBoard((s) => s.edges);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const count = useMemo(() => collectUpstream(id).videos.length, [nodes, edges, id]);
  const running = d.status === "running";

  const save = async () => {
    if (!d.resultUrl) return;
    try {
      const p = await saveVideoAs(d.resultUrl, useSettings.getState().settings.save, { model: "拼接" });
      if (p) toast(`已保存 → ${p}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  return (
    <NodeShell
      id={id}
      title="视频拼接"
      icon={<IcFilmJoin size={17} />}
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
        <p className="hint" style={{ fontSize: 12, color: "var(--text-3)", margin: 0, lineHeight: 1.7 }}>
          已接入 <b style={{ color: "var(--text-1)" }}>{count}</b> 路上游视频，按连线节点的画布位置（上→下）排序拼接。
          <br />
          实验性：本地实时重编码（耗时约等于总时长），分辨率取第一段，输出 webm。
        </p>
        <button className="btn primary nodrag" disabled={running || count < 2} onClick={() => void runFlow(id)}>
          {running ? <IcLoading size={17} /> : <IcFilmJoin size={16} />}
          {running ? "重编码中…" : `拼接成片（${count} 段）`}
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
