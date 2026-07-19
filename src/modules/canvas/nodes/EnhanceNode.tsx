/**
 * 高清增强节点 — 两种引擎：
 *  ComfyUI 模板（推荐）：UltimateSDUpscale / 放大模型等专业放大工作流
 *  绘画模型：重绘式增强（模型按原图重画一张更高分辨率的，细节可能有偏差）
 */
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortImageIn, PortOut } from "../NodeShell";
import { IcEnhance, IcLoading } from "../../../ui/icons";
import { ModelPicker } from "../../../ui/ModelPicker";
import { useBoard } from "../../../core/stores/boardStore";
import { useComfy } from "../../../core/stores/comfyStore";
import { useUi } from "../../../core/stores/uiStore";
import { runFlow } from "../../../core/runner";
import { Thumb } from "../../../ui/Thumb";
import type { EditEngine, EnhanceData } from "../../../core/types";

const FOCUS: { value: EnhanceData["focus"]; label: string; title: string }[] = [
  { value: "detail", label: "细节", title: "增强材质纹理与锐度，让模糊处变清晰" },
  { value: "face", label: "人脸", title: "重点修复人物面部，不改变长相" },
  { value: "none", label: "纯放大", title: "只提升分辨率，不添加原图没有的内容" },
];

export const EnhanceNode = memo(function EnhanceNode({ id, data, selected }: NodeProps) {
  const d = data as EnhanceData;
  const upd = useBoard((s) => s.updateData);
  const setLightbox = useUi((s) => s.setLightbox);
  const templates = useComfy((s) => s.templates);
  const setTemplateMgr = useUi((s) => s.setTemplateMgr);
  const running = d.status === "running";
  const main = d.results?.[d.picked ?? 0];
  const engine: EditEngine = d.engine ?? "model";

  return (
    <NodeShell id={id} title="高清增强" icon={<IcEnhance size={17} />} status={d.status} error={d.error} selected={selected} width={300}>
      <div className="mnode-body">
        <div
          className="ctl-row nodrag"
          title={"ComfyUI（推荐）：跑你导入的专业放大工作流（UltimateSDUpscale、放大模型等），像素级可控\n绘画模型：让模型重画一张更高分辨率的，观感增强但细节可能与原图有偏差"}
        >
          <span>引擎</span>
          <span className="lang-seg">
            <button className={engine === "comfy" ? "on" : ""} onClick={() => upd(id, { engine: "comfy" })}>
              ComfyUI
            </button>
            <button className={engine === "model" ? "on" : ""} onClick={() => upd(id, { engine: "model" })}>
              绘画模型
            </button>
          </span>
        </div>
        {engine === "comfy" ? (
          templates.length ? (
            <select
              className="select nodrag"
              value={d.comfyTemplateId ?? ""}
              onChange={(e) => upd(id, { comfyTemplateId: e.target.value || undefined })}
            >
              <option value="">选择放大工作流模板…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          ) : (
            <button className="btn nodrag" onClick={() => setTemplateMgr(true)}>
              还没有模板 → 打开模板管理器导入放大工作流
            </button>
          )
        ) : (
          <>
            <div className="ctl-row nodrag">
              <span>倍率</span>
              <span className="lang-seg">
                {[2, 4].map((f) => (
                  <button key={f} className={(d.factor ?? 2) === f ? "on" : ""} onClick={() => upd(id, { factor: f })}>
                    {f}×
                  </button>
                ))}
              </span>
            </div>
            <div className="ctl-row nodrag">
              <span>侧重</span>
              <span className="lang-seg">
                {FOCUS.map((f) => (
                  <button key={f.value} className={(d.focus ?? "detail") === f.value ? "on" : ""} title={f.title} onClick={() => upd(id, { focus: f.value })}>
                    {f.label}
                  </button>
                ))}
              </span>
            </div>
            <ModelPicker role="image" value={d.modelId} onChange={(v) => upd(id, { modelId: v })} />
          </>
        )}
        <button className="btn primary nodrag" disabled={running} onClick={() => void runFlow(id)}>
          {running ? <IcLoading size={17} /> : <IcEnhance size={17} />}
          {running ? "增强中…" : "高清增强"}
        </button>
        {running ? (
          <div className="skeleton">
            <span>{d.progress || "正在增强细节…"}</span>
          </div>
        ) : main ? (
          <Thumb className="img-main nodrag" src={main} alt="" res onClick={() => setLightbox(main)} />
        ) : null}
      </div>
      <PortImageIn top={26} />
      <PortOut kind="image" />
    </NodeShell>
  );
});
