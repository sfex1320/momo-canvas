/**
 * 多角度节点 — 换机位重拍上游图片：预设视角 / 球面拖机位 / 水平环绕 / 垂直俯仰 / 景别
 */
import { memo, useMemo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, OutModeToggle, PortImageIn, PortOut, PortTextIn } from "../NodeShell";
import { IcCopy, IcLoading, IcOrbit, IcRefresh } from "../../../ui/icons";
import { ModelPicker } from "../../../ui/ModelPicker";
import { SphereGizmo } from "../../../ui/SphereGizmo";
import { useBoard } from "../../../core/stores/boardStore";
import { toast, useUi } from "../../../core/stores/uiStore";
import { collectUpstream, runFlow } from "../../../core/runner";
import { ANGLE_PRESETS, buildAnglePrompt, SHOT_LABELS } from "../../../core/cameraLight";
import { Thumb } from "../../../ui/Thumb";
import type { MultiAngleData } from "../../../core/types";

export const MultiAngleNode = memo(function MultiAngleNode({ id, data, selected }: NodeProps) {
  const d = data as MultiAngleData;
  const upd = useBoard((s) => s.updateData);
  const setLightbox = useUi((s) => s.setLightbox);
  const nodes = useBoard((s) => s.nodes);
  const edges = useBoard((s) => s.edges);
  const up = useMemo(() => collectUpstream(id), [nodes, edges, id]);
  const upImage = up.images[0];
  const mode = d.outMode ?? "image";
  const running = d.status === "running";
  const main = d.results?.[d.picked ?? 0];
  const presetMeta = ANGLE_PRESETS.find((p) => p.value === d.preset);
  const promptPreview = mode === "prompt" ? buildAnglePrompt(d, up.texts) : "";

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(promptPreview);
      toast("视角提示词已复制", "ok");
    } catch {
      toast("复制失败", "err");
    }
  };

  return (
    <NodeShell
      id={id}
      title="多角度"
      icon={<IcOrbit size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={330}
      headExtra={
        <span className="acts nodrag" style={{ opacity: 1, display: "flex", alignItems: "center", gap: 5 }}>
          <OutModeToggle id={id} mode={mode} />
          <button
            className="icon-btn"
            title="重置视角参数"
            onClick={() => upd(id, { preset: "custom", yaw: 0, pitch: 0, shot: 2 })}
          >
            <IcRefresh size={15} />
          </button>
        </span>
      }
    >
      <div className="mnode-body">
        <div className="chips nodrag" style={{ maxHeight: "none" }}>
          {ANGLE_PRESETS.map((p) => (
            <button
              key={p.value}
              className={`chip ${d.preset === p.value ? "on" : ""}`}
              title={p.prompt || "用下方球面/滑杆自定义机位"}
              onClick={() => upd(id, { preset: p.value })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="gizmo-row nodrag">
          <SphereGizmo
            az={d.yaw}
            el={d.pitch}
            image={upImage}
            mode="camera"
            onChange={(az, el) => upd(id, { yaw: az, pitch: Math.max(-60, Math.min(60, el)), preset: "custom" })}
          />
          <div className="gizmo-side">
            <div className="slider-row" title="围绕主体水平环绕机位：0° 原机位，±180° 背面">
              <span>水平环绕</span>
              <input
                type="range"
                className="range nodrag"
                min={-180}
                max={180}
                step={5}
                value={d.yaw}
                onChange={(e) => upd(id, { yaw: +e.target.value, preset: "custom" })}
              />
              <b>{d.yaw}°</b>
            </div>
            <div className="slider-row" title="正值俯拍（相机升高），负值仰拍（相机降低）">
              <span>垂直俯仰</span>
              <input
                type="range"
                className="range nodrag"
                min={-60}
                max={60}
                step={5}
                value={d.pitch}
                onChange={(e) => upd(id, { pitch: +e.target.value, preset: "custom" })}
              />
              <b>{d.pitch}°</b>
            </div>
            <div className="slider-row" title="取景远近：特写 → 远景">
              <span>景别缩放</span>
              <input
                type="range"
                className="range nodrag"
                min={0}
                max={4}
                step={1}
                value={d.shot}
                onChange={(e) => upd(id, { shot: +e.target.value, preset: "custom" })}
              />
              <b>{SHOT_LABELS[d.shot] ?? "中景"}</b>
            </div>
          </div>
        </div>
        <div className="gen-sum nodrag">
          <IcOrbit size={13} />
          <span>
            {d.preset !== "custom" && presetMeta
              ? `预设视角：${presetMeta.label}`
              : `自定义机位：环绕 ${d.yaw}° · 俯仰 ${d.pitch}° · ${SHOT_LABELS[d.shot] ?? "中景"}`}
          </span>
        </div>
        {mode === "image" ? (
          <>
            <ModelPicker role="image" value={d.modelId} onChange={(v) => upd(id, { modelId: v })} />
            <button className="btn primary nodrag" disabled={running} onClick={() => void runFlow(id)}>
              {running ? <IcLoading size={17} /> : <IcOrbit size={17} />}
              {running ? "换机位中…" : "生成新视角"}
            </button>
            {running ? (
              <div className="skeleton">
                <span>正在移动机位重拍…</span>
              </div>
            ) : main ? (
              <Thumb className="img-main nodrag" src={main} alt="" res onClick={() => setLightbox(main, upImage)} />
            ) : null}
          </>
        ) : (
          <div className="prompt-out nodrag">
            <div className="po-head">
              <span>输出的视角提示词（随参数实时更新）</span>
              <button className="icon-btn" title="复制提示词" onClick={() => void copyPrompt()}>
                <IcCopy size={14} />
              </button>
            </div>
            <textarea className="textarea nowheel" rows={5} readOnly value={promptPreview} />
          </div>
        )}
      </div>
      <PortTextIn />
      <PortImageIn />
      <PortOut kind={mode === "prompt" ? "text" : "image"} />
    </NodeShell>
  );
});
