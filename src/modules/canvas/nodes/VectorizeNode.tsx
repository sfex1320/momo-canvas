/**
 * 智能矢量节点 — 本地 VTracer 位图转矢量 SVG（非破坏）
 *
 * 输入：image。产物：SVG 文件 + SVG 文本（导出 AI/CDR/PDF 在底部面板）。终端节点（不出位图口）。
 * 参数（类型/精度/分层/几何图元…）与 导出 SVG/PDF/AI/CDR、收入资产库 全部收在底部「智能矢量」面板
 * （EditPanels.tsx，选中本节点时出现），节点本体只留 预览 / 运行状态 / 空态。
 */
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortIn } from "../NodeShell";
import { IcImage, IcLoading, IcVector } from "../../../ui/icons";
import { useUi } from "../../../core/stores/uiStore";
import type { VectorizeData } from "../../../core/types";

export const VectorizeNode = memo(function VectorizeNode({ id, data, selected }: NodeProps) {
  const d = data as VectorizeData;
  const setLightbox = useUi((s) => s.setLightbox);
  const running = d.status === "running";
  const previewSrc = d.svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(d.svg)}` : undefined;

  return (
    <NodeShell
      id={id}
      title="矢量"
      icon={<IcVector size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={330}
      hideUpstream
      media
    >
      <div className="mnode-body">
        {running ? (
          <div className="enh-running">
            {/* 本地矢量化无百分比：阶段文案 + loading 图标（沿用既有 class，不新增样式） */}
            <div className="progress-line">
              <IcLoading size={14} />
              {d.progress ?? "矢量化中…"}
            </div>
          </div>
        ) : previewSrc ? (
          <div className="media-main">
            {/* SVG 刻意例外不用 Thumb：位图缩略管线会把 SVG 栅格化，全项目唯一 <img> 直塞 */}
            <img className="img-main vec-preview" src={previewSrc} alt="" title="点击预览" onClick={() => d.result && setLightbox(d.result)} />
            {d.report ? (
              <div className="enh-report" title={d.reportDetail}>
                {d.report}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="gen-empty">
            <IcImage size={24} />
            <span>
              连接一张图片（Logo/插画等）
              <br />
              选中后在底部面板点「矢量化」
            </span>
          </div>
        )}
      </div>
      <PortIn />
    </NodeShell>
  );
});
