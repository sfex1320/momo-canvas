import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortImageIn, PortOut, PortTextIn } from "../NodeShell";
import { IcDownload, IcGear, IcLoading, IcSparkles } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { resolveModelCard, useSettings } from "../../../core/stores/settingsStore";
import { imageFamily } from "../../../core/modelMeta";
import { toast, useUi } from "../../../core/stores/uiStore";
import { collectUpstream, runFlow } from "../../../core/runner";
import { saveImageAs } from "../../../core/services/imageSaver";
import { errMsg } from "../../../core/utils";
import { Thumb } from "../../../ui/Thumb";
import { PromptHistoryBtn } from "../../../ui/PromptHistory";
import { AtTextArea, useOwnUpstreamImageRefs } from "../../../ui/AtTextArea";
import type { ImageGenData } from "../../../core/types";

export const ImageGenNode = memo(function ImageGenNode({ id, data, selected }: NodeProps) {
  const d = data as ImageGenData;
  const upd = useBoard((s) => s.updateData);
  const models = useSettings((s) => s.settings.models);
  const setLightbox = useUi((s) => s.setLightbox);
  // 上游已接入文本 → 提示词框隐藏（运行时自动取上游；节点里已手写的提示词优先级更高，保留显示）
  const hasUpText = useBoard(() => collectUpstream(id).texts.length > 0);
  const atRefs = useOwnUpstreamImageRefs(id);
  const running = d.status === "running";
  const main = d.results?.[d.picked ?? 0];

  // 参数摘要（详细调控在左下角面板）
  let summary = "";
  try {
    const card = resolveModelCard("image", d.modelId);
    const fam = imageFamily(card);
    const size =
      fam === "banana"
        ? `${d.aspect ?? "auto"} · ${d.resolution ?? "1K"}`
        : d.width && d.height
          ? `${d.width}×${d.height}`
          : d.size === "default"
            ? (card.size ?? "auto")
            : d.size;
    summary = `${card.model} · ${size} · ${d.count ?? 1}张`;
  } catch {
    summary = "尚未配置绘画模型";
  }
  void models; // 订阅设置变化以刷新摘要

  const save = async () => {
    if (!main) return;
    try {
      let model: string | undefined;
      try {
        model = resolveModelCard("image", d.modelId).model;
      } catch {
        /* 未配置模型时仅影响文件命名 */
      }
      const p = await saveImageAs(main, useSettings.getState().settings.save, { prompt: d.prompt, model });
      if (p) toast(`已保存 → ${p}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  return (
    <NodeShell
      id={id}
      title="生成图像"
      icon={<IcSparkles size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={310}
      headExtra={
        main ? (
          <span className="acts nodrag" style={{ opacity: 1 }}>
            <button className="icon-btn" title="保存到本地" onClick={save}>
              <IcDownload size={17} />
            </button>
          </span>
        ) : undefined
      }
    >
      <div className="mnode-body">
        {hasUpText && !(d.prompt ?? "").trim() ? null : (
          <div style={{ position: "relative" }}>
            <AtTextArea
              rows={3}
              placeholder="提示词（留空则自动使用上游提示词/对话结果）"
              value={d.prompt}
              onChange={(t) => upd(id, { prompt: t })}
              refs={atRefs}
            />
            <div style={{ position: "absolute", right: 5, bottom: 5 }}>
              <PromptHistoryBtn onPick={(t) => upd(id, { prompt: t })} />
            </div>
          </div>
        )}
        <div className="gen-sum nodrag" title="选中节点后，在画布左下角的「生成设置」面板中调整模型/尺寸/数量">
          <IcGear size={13} />
          <span>{summary}</span>
        </div>
        <button className="btn primary nodrag" disabled={running} onClick={() => void runFlow(id)}>
          {running ? <IcLoading size={17} /> : <IcSparkles size={17} />}
          {running ? "生成中…" : "生成"}
        </button>
        {running ? (
          <div className="skeleton">
            <span>正在绘制…</span>
          </div>
        ) : main ? (
          <>
            <Thumb className="img-main nodrag" src={main} alt="" res onClick={() => setLightbox(main)} />
            {d.results.length > 1 ? (
              <div className="thumbs nodrag">
                {d.results.map((s, i) => (
                  <Thumb
                    key={i}
                    src={s}
                    className={i === (d.picked ?? 0) ? "on" : ""}
                    onClick={() => upd(id, { picked: i })}
                    alt=""
                  />
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      <PortTextIn />
      <PortImageIn />
      <PortOut kind="image" />
    </NodeShell>
  );
});
