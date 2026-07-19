/**
 * 打光节点 — 上游图片重新布光：球面拖光源 / 六向按钮 / 亮度 / 颜色 / 轮廓光 / 智能模式
 */
import { memo, useMemo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, OutModeToggle, PortImageIn, PortOut, PortTextIn } from "../NodeShell";
import { IcBulb, IcCopy, IcLoading, IcRefresh } from "../../../ui/icons";
import { ModelPicker } from "../../../ui/ModelPicker";
import { Switch } from "../../../ui/kit";
import { SphereGizmo } from "../../../ui/SphereGizmo";
import { useBoard } from "../../../core/stores/boardStore";
import { toast, useUi } from "../../../core/stores/uiStore";
import { collectUpstream, runFlow } from "../../../core/runner";
import { buildRelightPrompt, LIGHT_DIRS, lightPhrase } from "../../../core/cameraLight";
import { Thumb } from "../../../ui/Thumb";
import type { RelightData } from "../../../core/types";

/** 预设光色：空 = 自然光；暖光 / 冷光 / 粉调 / 青调 */
const SWATCHES = ["#FFD9A0", "#A8C8FF", "#FF9AA2", "#9AE6D8"];

export const RelightNode = memo(function RelightNode({ id, data, selected }: NodeProps) {
  const d = data as RelightData;
  const upd = useBoard((s) => s.updateData);
  const setLightbox = useUi((s) => s.setLightbox);
  const nodes = useBoard((s) => s.nodes);
  const edges = useBoard((s) => s.edges);
  const up = useMemo(() => collectUpstream(id), [nodes, edges, id]);
  const upImage = up.images[0];
  const mode = d.outMode ?? "image";
  const running = d.status === "running";
  const main = d.results?.[d.picked ?? 0];
  const promptPreview = mode === "prompt" ? buildRelightPrompt(d, up.texts) : "";

  const reset = () =>
    upd(id, { azimuth: 0, elevation: 0, brightness: 50, color: "", rim: false, smart: false });

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(promptPreview);
      toast("打光提示词已复制", "ok");
    } catch {
      toast("复制失败", "err");
    }
  };

  return (
    <NodeShell
      id={id}
      title="打光"
      icon={<IcBulb size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={330}
      headExtra={
        <span className="acts nodrag" style={{ opacity: 1, display: "flex", alignItems: "center", gap: 5 }}>
          <OutModeToggle id={id} mode={mode} />
          <button className="icon-btn" title="重置打光参数" onClick={reset}>
            <IcRefresh size={15} />
          </button>
        </span>
      }
    >
      <div className="mnode-body">
        <div className="gizmo-row nodrag">
          <SphereGizmo
            az={d.azimuth}
            el={d.elevation}
            image={upImage}
            mode="light"
            onChange={(az, el) => upd(id, { azimuth: az, elevation: el, smart: false })}
          />
          <div className="gizmo-side">
            <div className="ctl-row" title="开启后由模型分析画面，自动设计最佳打光方案">
              <span>智能模式</span>
              <Switch on={d.smart} onChange={(v) => upd(id, { smart: v })} />
            </div>
            <div className="slider-row" title="0% 很暗 · 50% 正常曝光 · 100% 很亮">
              <span>亮度</span>
              <input
                type="range"
                className="range nodrag"
                min={0}
                max={100}
                step={5}
                value={d.brightness}
                disabled={d.smart}
                onChange={(e) => upd(id, { brightness: +e.target.value })}
              />
              <b>{d.brightness}%</b>
            </div>
            <div className="ctl-row">
              <span>颜色</span>
              <span className="swatches">
                <button
                  className={`swatch none ${!d.color ? "on" : ""}`}
                  title="自然白光（不指定颜色）"
                  onClick={() => upd(id, { color: "", smart: false })}
                />
                {SWATCHES.map((c) => (
                  <button
                    key={c}
                    className={`swatch ${d.color === c ? "on" : ""}`}
                    style={{ background: c }}
                    title={c}
                    onClick={() => upd(id, { color: c, smart: false })}
                  />
                ))}
                <label
                  className={`swatch custom ${d.color && !SWATCHES.includes(d.color) ? "on" : ""}`}
                  title="自定义光色"
                  style={d.color && !SWATCHES.includes(d.color) ? { background: d.color } : undefined}
                >
                  <input
                    type="color"
                    value={d.color || "#ffffff"}
                    onChange={(e) => upd(id, { color: e.target.value, smart: false })}
                  />
                </label>
              </span>
            </div>
            <div className="ctl-row" title="在主体边缘加一圈轮廓光，把主体从背景里分离出来">
              <span>轮廓光</span>
              <Switch on={d.rim} onChange={(v) => upd(id, { rim: v })} />
            </div>
          </div>
        </div>
        <div className={`dir-grid nodrag ${d.smart ? "dim" : ""}`}>
          {LIGHT_DIRS.map((L) => (
            <button
              key={L.label}
              className={`opt-cell ${!d.smart && d.azimuth === L.az && d.elevation === L.el ? "on" : ""}`}
              onClick={() => upd(id, { azimuth: L.az, elevation: L.el, smart: false })}
            >
              <span className="oc-lab">{L.label}</span>
            </button>
          ))}
        </div>
        <div className="gen-sum nodrag">
          <IcBulb size={13} />
          <span>
            {d.smart
              ? "智能打光：模型自动设计布光方案"
              : `主光源：${lightPhrase(d.azimuth, d.elevation)}（${d.azimuth}° / ${d.elevation}°）`}
          </span>
        </div>
        {mode === "image" ? (
          <>
            <ModelPicker role="image" value={d.modelId} onChange={(v) => upd(id, { modelId: v })} />
            <button className="btn primary nodrag" disabled={running} onClick={() => void runFlow(id)}>
              {running ? <IcLoading size={17} /> : <IcBulb size={17} />}
              {running ? "打光中…" : "生成打光效果"}
            </button>
            {running ? (
              <div className="skeleton">
                <span>正在重新布光…</span>
              </div>
            ) : main ? (
              <Thumb className="img-main nodrag" src={main} alt="" res onClick={() => setLightbox(main)} />
            ) : null}
          </>
        ) : (
          <div className="prompt-out nodrag">
            <div className="po-head">
              <span>输出的打光提示词（随参数实时更新）</span>
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
