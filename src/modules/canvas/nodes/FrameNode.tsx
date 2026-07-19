/**
 * 视频取帧节点 — 从上游视频抽一帧输出为图片（本地抽帧，零成本）
 *  典型用法：视频A末帧 → 作为下一段视频的首帧参考 → 无限续接长视频
 */
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortOut, PortVideoIn } from "../NodeShell";
import { IcFilmFrame, IcLoading } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { useUi } from "../../../core/stores/uiStore";
import { runFlow } from "../../../core/runner";
import { Thumb } from "../../../ui/Thumb";
import type { FrameData } from "../../../core/types";

export const FrameNode = memo(function FrameNode({ id, data, selected }: NodeProps) {
  const d = data as FrameData;
  const upd = useBoard((s) => s.updateData);
  const setLightbox = useUi((s) => s.setLightbox);
  const running = d.status === "running";
  const point = d.point ?? "last";

  return (
    <NodeShell id={id} title="视频取帧" icon={<IcFilmFrame size={17} />} status={d.status} error={d.error} selected={selected} width={280}>
      <div className="mnode-body">
        <div className="ctl-row nodrag" title="末帧最常用：取出来接下一个视频节点当首帧参考，就能续写长视频">
          <span>位置</span>
          <span className="lang-seg">
            <button className={point === "first" ? "on" : ""} onClick={() => upd(id, { point: "first" })}>
              首帧
            </button>
            <button className={point === "last" ? "on" : ""} onClick={() => upd(id, { point: "last" })}>
              末帧
            </button>
            <button className={point === "custom" ? "on" : ""} onClick={() => upd(id, { point: "custom" })}>
              自定义
            </button>
          </span>
        </div>
        {point === "custom" ? (
          <div className="ctl-row nodrag">
            <span>秒数</span>
            <input
              className="input"
              type="number"
              min={0}
              step={0.1}
              style={{ width: 110, minHeight: 32 }}
              value={d.timeSec ?? 0}
              onChange={(e) => upd(id, { timeSec: Math.max(0, Number(e.target.value)) })}
            />
            {d.srcDur ? <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>共 {d.srcDur.toFixed(1)}s</span> : null}
          </div>
        ) : null}
        <button className="btn primary nodrag" disabled={running} onClick={() => void runFlow(id)}>
          {running ? <IcLoading size={17} /> : <IcFilmFrame size={16} />}
          {running ? "抽帧中…" : "取帧"}
        </button>
        {d.result && !running ? (
          <Thumb className="img-main nodrag" src={d.result} alt="" res onClick={() => setLightbox(d.result!)} />
        ) : null}
      </div>
      <PortVideoIn top={26} />
      <PortOut kind="image" />
    </NodeShell>
  );
});
