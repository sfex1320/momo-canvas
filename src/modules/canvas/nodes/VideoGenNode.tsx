import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortImageIn, PortTextIn } from "../NodeShell";
import { IcDownload, IcLoading, IcVideo } from "../../../ui/icons";
import { ModelPicker } from "../../../ui/ModelPicker";
import { useBoard } from "../../../core/stores/boardStore";
import { resolveModelCard, useSettings } from "../../../core/stores/settingsStore";
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
      let model: string | undefined;
      try {
        model = resolveModelCard("video", d.modelId).model;
      } catch {
        /* 未配置模型时仅影响文件命名 */
      }
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
        <div style={{ display: "flex", gap: 7 }}>
          <div style={{ flex: 1 }}>
            <ModelPicker role="video" value={d.modelId} onChange={(v) => upd(id, { modelId: v })} />
          </div>
          <div className="lang-seg nodrag" title="提示词语言：中文直发 / 生成前译成英文">
            <button className={(d.lang ?? "zh") === "zh" ? "on" : ""} onClick={() => upd(id, { lang: "zh" })}>
              中
            </button>
            <button className={d.lang === "en" ? "on" : ""} onClick={() => upd(id, { lang: "en" })}>
              EN
            </button>
          </div>
        </div>
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
