/**
 * 生成图像 — LibLib 式精简节点：画布上只留结果图；
 * 提示词/参考图 @ 引用/模型/尺寸等全部在选中后的底部生成面板里编辑。
 */
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortImageIn, PortOut, PortTextIn } from "../NodeShell";
import { IcDownload, IcImage, IcLoading, IcSparkles } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { resolveModelCard, useSettings } from "../../../core/stores/settingsStore";
import { toast, useUi } from "../../../core/stores/uiStore";
import { collectUpstream, runFlow } from "../../../core/runner";
import { saveImageAs } from "../../../core/services/imageSaver";
import { errMsg } from "../../../core/utils";
import { Thumb } from "../../../ui/Thumb";
import type { ImageGenData } from "../../../core/types";

export const ImageGenNode = memo(function ImageGenNode({ id, data, selected }: NodeProps) {
  const d = data as ImageGenData;
  const upd = useBoard((s) => s.updateData);
  const setLightbox = useUi((s) => s.setLightbox);
  const hasUpText = useBoard(() => collectUpstream(id).texts.length > 0);
  const running = d.status === "running";
  const main = d.results?.[d.picked ?? 0];
  const preview = (d.prompt ?? "").trim();

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
        ) : (
          <div className="gen-empty">
            <IcImage size={24} />
            <span>选中节点，在底部面板输入提示词</span>
          </div>
        )}
        <div className="gen-foot nodrag">
          <span className="gf-prompt" title={preview || undefined}>
            {preview || (hasUpText ? "使用上游提示词" : "未填提示词")}
          </span>
          <button className="btn sm primary" disabled={running} onClick={() => void runFlow(id)}>
            {running ? <IcLoading size={15} /> : <IcSparkles size={15} />}
            {running ? "生成中" : "生成"}
          </button>
        </div>
      </div>
      <PortTextIn />
      <PortImageIn />
      <PortOut kind="image" />
    </NodeShell>
  );
});
