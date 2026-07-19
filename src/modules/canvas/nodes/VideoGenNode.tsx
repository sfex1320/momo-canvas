/**
 * 生成视频 — LibLib 式精简节点：画布上只留结果；
 * 描述/模型/时长/分辨率等全部在选中后的底部生成面板里编辑。
 */
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortAudioIn, PortImageIn, PortOut, PortTextIn, PortVideoIn } from "../NodeShell";
import { IcDownload, IcLoading, IcVideo } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { resolveModelCard, useSettings } from "../../../core/stores/settingsStore";
import { toast } from "../../../core/stores/uiStore";
import { collectUpstream, runFlow } from "../../../core/runner";
import { saveVideoAs } from "../../../core/services/imageSaver";
import { errMsg } from "../../../core/utils";
import { VideoThumb } from "../../../ui/VideoThumb";
import type { VideoGenData } from "../../../core/types";

export const VideoGenNode = memo(function VideoGenNode({ id, data, selected }: NodeProps) {
  const d = data as VideoGenData;
  const hasUpText = useBoard(() => collectUpstream(id).texts.length > 0);
  const running = d.status === "running";
  const preview = (d.prompt ?? "").trim();

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
        {running ? (
          <div className="skeleton">
            <span>{d.progress || "正在生成视频…"}</span>
          </div>
        ) : d.resultUrl ? (
          <VideoThumb className="img-main nodrag" src={d.resultUrl} />
        ) : (
          <div className="gen-empty">
            <IcVideo size={24} />
            <span>选中节点，在底部面板输入描述</span>
          </div>
        )}
        <div className="gen-foot nodrag">
          <span className="gf-prompt" title={preview || undefined}>
            {preview || (hasUpText ? "使用上游文本" : "未填描述")}
          </span>
          <button className="btn sm primary" disabled={running} onClick={() => void runFlow(id)}>
            {running ? <IcLoading size={15} /> : <IcVideo size={15} />}
            {running ? "生成中" : "生成"}
          </button>
        </div>
      </div>
      <PortTextIn />
      <PortImageIn />
      <PortVideoIn top={90} />
      <PortAudioIn top={122} />
      <PortOut kind="video" />
    </NodeShell>
  );
});
