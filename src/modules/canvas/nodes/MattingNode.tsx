/**
 * 抠图节点 — 两种引擎：
 *  ComfyUI 模板（推荐）：rembg / BiRefNet 等真·抠图，发丝级、真透明
 *  绘画模型：重绘式换底（GPT Image 可出透明 PNG；其余模型只能纯色底）
 */
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortImageIn, PortOut } from "../NodeShell";
import { IcLoading, IcScissors } from "../../../ui/icons";
import { ModelPicker } from "../../../ui/ModelPicker";
import { useBoard } from "../../../core/stores/boardStore";
import { useComfy } from "../../../core/stores/comfyStore";
import { useUi } from "../../../core/stores/uiStore";
import { runFlow } from "../../../core/runner";
import { MATTING_BG_LABEL } from "../../../core/editPrompts";
import { Thumb } from "../../../ui/Thumb";
import type { EditEngine, MattingBg, MattingData } from "../../../core/types";

const BGS: MattingBg[] = ["transparent", "white", "green", "black"];

export const MattingNode = memo(function MattingNode({ id, data, selected }: NodeProps) {
  const d = data as MattingData;
  const upd = useBoard((s) => s.updateData);
  const setLightbox = useUi((s) => s.setLightbox);
  const templates = useComfy((s) => s.templates);
  const setTemplateMgr = useUi((s) => s.setTemplateMgr);
  const running = d.status === "running";
  const main = d.results?.[d.picked ?? 0];
  const engine: EditEngine = d.engine ?? "model";

  return (
    <NodeShell id={id} title="抠图" icon={<IcScissors size={17} />} status={d.status} error={d.error} selected={selected} width={300}>
      <div className="mnode-body">
        <div
          className="ctl-row nodrag"
          title={"ComfyUI（推荐）：用 rembg/BiRefNet 等专业抠图工作流，发丝级、真透明\n绘画模型：重绘式换底，效果取决于模型（GPT Image 可出透明底，其余只能纯色底）"}
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
              <option value="">选择抠图工作流模板…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          ) : (
            <button className="btn nodrag" onClick={() => setTemplateMgr(true)}>
              还没有模板 → 打开模板管理器导入抠图工作流
            </button>
          )
        ) : (
          <>
            <input
              className="input nodrag"
              placeholder="要抠的主体（留空 = 自动识别最显著主体）"
              value={d.subject}
              onChange={(e) => upd(id, { subject: e.target.value })}
            />
            <div className="ctl-row nodrag" title="透明底需要 GPT Image 系模型；其他模型会自动降级为纯白底">
              <span>背景</span>
              <span className="lang-seg">
                {BGS.map((b) => (
                  <button key={b} className={(d.bg ?? "transparent") === b ? "on" : ""} onClick={() => upd(id, { bg: b })}>
                    {MATTING_BG_LABEL[b].replace("纯", "").replace("底", "").replace("幕", "")}
                  </button>
                ))}
              </span>
            </div>
            <ModelPicker role="image" value={d.modelId} onChange={(v) => upd(id, { modelId: v })} />
          </>
        )}
        <button className="btn primary nodrag" disabled={running} onClick={() => void runFlow(id)}>
          {running ? <IcLoading size={17} /> : <IcScissors size={17} />}
          {running ? "抠图中…" : "抠出主体"}
        </button>
        {running ? (
          <div className="skeleton">
            <span>{d.progress || "正在分离主体…"}</span>
          </div>
        ) : main ? (
          <Thumb className="img-main checker nodrag" src={main} alt="" res onClick={() => setLightbox(main)} />
        ) : null}
      </div>
      <PortImageIn top={26} />
      <PortOut kind="image" />
    </NodeShell>
  );
});
