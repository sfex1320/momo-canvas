/**
 * 生成图像 — LibLib 式精简节点：画布上只留结果图；
 * 提示词/参考图 @ 引用/模型/尺寸等全部在选中后的底部生成面板里编辑。
 */
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { mediaNodeWidth, NodeShell, PortIn, PortOut } from "../NodeShell";
import { EditSurface } from "../EditSurface";
import { IcDownload, IcImage, IcLoading, IcRows, IcScan, IcSparkles } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { resolveModelCard, useSettings } from "../../../core/stores/settingsStore";
import { toast, useUi } from "../../../core/stores/uiStore";
import { runFlow } from "../../../core/runner";
import { saveImageAs } from "../../../core/services/imageSaver";
import { errMsg } from "../../../core/utils";
import { useImageDims } from "../../../core/imageInfo";
import { Thumb } from "../../../ui/Thumb";
import type { ImageGenData } from "../../../core/types";

export const ImageGenNode = memo(function ImageGenNode({ id, data, selected }: NodeProps) {
  const d = data as ImageGenData;
  const upd = useBoard((s) => s.updateData);
  const setLightbox = useUi((s) => s.setLightbox);
  const running = d.status === "running";
  const main = d.results?.[d.picked ?? 0];
  // 宽度随结果图比例自适应（竖图窄、横图宽）
  const dims = useImageDims(main);

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
      width={mediaNodeWidth(dims, 330)}
      hideUpstream
      media
      headExtra={
        <>
          <button className="nt-btn primary" disabled={running} title="生成（上游未运行的节点会按依赖顺序先自动运行）" onClick={() => void runFlow(id)}>
            {running ? <IcLoading size={14} /> : <IcSparkles size={14} />}
            {running ? "生成中" : "生成"}
          </button>
          {main ? (
            <>
              <button className="nt-btn" title="放大预览" onClick={() => setLightbox(main)}>
                <IcScan size={14} /> 放大
              </button>
              <button className="nt-btn" title="保存到本地" onClick={save}>
                <IcDownload size={14} /> 保存
              </button>
            </>
          ) : null}
        </>
      }
    >
      <div className="mnode-body">
        {running ? (
          <div className="skeleton">
            <span>{d.progress??"正在绘制…"}</span>
          </div>
        ) : main ? (
          <div className="media-main">
            <EditSurface id={id} src={main}>
              <Thumb className="img-main" src={main} alt="" res onClick={() => setLightbox(main)} />
            </EditSurface>
            {d.results.length > 1 ? (
              <div className="media-thumbs nodrag">
                {d.results.map((s, i) => (
                  <Thumb
                    key={i}
                    src={s}
                    className={i === (d.picked ?? 0) ? "on" : ""}
                    onClick={() => upd(id, { picked: i })}
                    alt=""
                  />
                ))}
                <button
                  className="icon-btn"
                  title={`对比视图：${d.results.length} 张并排挑图`}
                  aria-label="对比视图"
                  onClick={() => useUi.getState().setLightboxList(d.results)}
                >
                  <IcRows size={13} />
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="gen-empty">
            <IcImage size={24} />
            <span>选中节点，在底部面板输入提示词</span>
          </div>
        )}
      </div>
      <PortIn />
      <PortOut kind="image" />
    </NodeShell>
  );
});
