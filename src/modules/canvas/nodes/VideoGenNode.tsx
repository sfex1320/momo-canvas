import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortImageIn, PortTextIn } from "../NodeShell";
import { IcDownload, IcLoading, IcVideo } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { useSettings } from "../../../core/stores/settingsStore";
import { toast } from "../../../core/stores/uiStore";
import { runVideoGen } from "../../../core/runner";
import { saveVideoAs } from "../../../core/services/imageSaver";
import { errMsg } from "../../../core/utils";
import type { VideoGenData } from "../../../core/types";

export const VideoGenNode = memo(function VideoGenNode({ id, data, selected }: NodeProps) {
  const d = data as VideoGenData;
  const upd = useBoard((s) => s.updateData);
  const running = d.status === "running";

  const save = async () => {
    if (!d.resultUrl) return;
    try {
      const model = useSettings.getState().settings.video.model;
      const p = await saveVideoAs(d.resultUrl, useSettings.getState().settings.save, { prompt: d.prompt, model });
      if (p) toast(`已保存 → ${p}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  return (
    <NodeShell
      id={id}
      title="生成视频"
      icon={<IcVideo size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={330}
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
        <textarea
          className="textarea nodrag nowheel"
          rows={3}
          placeholder="视频描述（可连接上游图片作为首帧参考）"
          value={d.prompt}
          onChange={(e) => upd(id, { prompt: e.target.value })}
        />
        <button className="btn primary nodrag" disabled={running} onClick={() => void runVideoGen(id)}>
          {running ? <IcLoading size={17} /> : <IcVideo size={17} />}
          {running ? "生成中…" : "生成视频"}
        </button>
        {running && d.progress ? (
          <div className="progress-line">
            <IcLoading size={14} />
            {d.progress}
          </div>
        ) : null}
        {d.resultUrl ? (
          <video className="img-main nodrag" src={d.resultUrl} controls style={{ cursor: "default" }} />
        ) : null}
      </div>
      <PortTextIn />
      <PortImageIn />
    </NodeShell>
  );
});
