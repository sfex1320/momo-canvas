/**
 * 超清放大节点 — 本地 DirectML 超分放大（非破坏：输出是新资产，原图不动）
 *
 * 输入：image（上游图片）；输出：image（放大后的新资产）。
 * 参数（目标/质量/格式/高级）全部收在底部「超清放大」面板（EditPanels.tsx，选中本节点时出现），
 * 节点本体只留 预览 / 运行进度 / 空态。
 * 运行走 runner.runEnhanceLocal → Rust enhance_upscale（ort + DirectML + 笨 Tile）。
 */
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { mediaNodeWidth, NodeShell, PortIn, PortOut } from "../NodeShell";
import { IcDownload, IcImage, IcUpscale } from "../../../ui/icons";
import { toast, useUi } from "../../../core/stores/uiStore";
import { saveImageAs } from "../../../core/services/imageSaver";
import { useSettings } from "../../../core/stores/settingsStore";
import { errMsg } from "../../../core/utils";
import { useImageDims } from "../../../core/imageInfo";
import { Thumb } from "../../../ui/Thumb";
import type { EnhanceLocalData } from "../../../core/types";

export const EnhanceLocalNode = memo(function EnhanceLocalNode({ id, data, selected }: NodeProps) {
  const d = data as EnhanceLocalData;
  const setLightbox = useUi((s) => s.setLightbox);
  const running = d.status === "running";
  const main = d.result;
  const dims = useImageDims(main);

  const save = async () => {
    if (!main) return;
    if (d.productionReady === false && !window.confirm(`${d.qualityMessage ?? "这张图片未通过生产质量门禁"}\n\n仍要保存到本地吗？`)) return;
    try {
      const p = await saveImageAs(main, useSettings.getState().settings.save, { model: "本地放大" });
      if (p) toast(`已保存 → ${p}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  return (
    <NodeShell
      id={id}
      title="本地放大"
      icon={<IcUpscale size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={mediaNodeWidth(dims, 330)}
      hideUpstream
      media
      headExtra={
        main ? (
          <>
            <button className="nt-btn" title="放大预览" onClick={() => setLightbox(main)}>
              <IcUpscale size={14} /> 放大
            </button>
            <button className="nt-btn" title="保存到本地" onClick={save}>
              <IcDownload size={14} /> 保存
            </button>
          </>
        ) : null
      }
    >
      <div className="mnode-body">
        {running ? (
          <div className="enh-running">
            <div className="enh-stage">{d.progress ?? "准备中…"}</div>
            <div className="enh-bar">
              <div className="enh-bar-fill" style={{ width: `${d.progressPct ?? 0}%` }} />
            </div>
            <div className="enh-pct">{d.progressPct ?? 0}%</div>
          </div>
        ) : main ? (
          <div className="media-main">
            <Thumb className="img-main" src={main} alt="" res onClick={() => setLightbox(main)} />
            {typeof d.fidelityScore === "number" ? (
              <div
                className={`enh-fidelity ${d.qualityGate ?? "passed"}`}
                title="缩回源尺寸的一致性评分；用于发现色偏、结构漂移和错误细节，不等同于主观锐度"
              >
                {d.qualityGate === "failed" ? "未通过" : d.qualityGate === "warning" ? "需检查" : "保真"} {d.fidelityScore}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="gen-empty">
            <IcImage size={24} />
            <span>
              连接一张图片到左侧
              <br />
              选中后在底部面板点「增强」
            </span>
          </div>
        )}
      </div>
      <PortIn />
      <PortOut kind="image" />
    </NodeShell>
  );
});
