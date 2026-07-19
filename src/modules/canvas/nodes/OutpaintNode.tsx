/**
 * 扩图节点 — 可视化取景（拖边缘 / 按比例）向四周延伸画面
 * GPT Image 走真蒙版外扩；其余按目标比例 + 指令降级；通道可手动切换
 */
import { memo, useMemo, useState } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortImageIn, PortOut, PortTextIn } from "../NodeShell";
import { IcExpand, IcLoading } from "../../../ui/icons";
import { ModelPicker } from "../../../ui/ModelPicker";
import { useBoard } from "../../../core/stores/boardStore";
import { toast, useUi } from "../../../core/stores/uiStore";
import { collectUpstream, runFlow } from "../../../core/runner";
import { padsSummary } from "../../../core/editPrompts";
import { OutpaintEditor } from "../OutpaintEditor";
import { Thumb } from "../../../ui/Thumb";
import type { OutpaintData, OutpaintPads } from "../../../core/types";

/** 一键预设：横向全景 / 纵向长图 / 四周均扩 */
const PRESETS: { label: string; title: string; pads: OutpaintPads }[] = [
  { label: "横向", title: "左右各扩 50%（竖图变横图/全景）", pads: { left: 0.5, right: 0.5, up: 0, down: 0 } },
  { label: "纵向", title: "上下各扩 50%（横图变竖图/长图）", pads: { left: 0, right: 0, up: 0.5, down: 0.5 } },
  { label: "四周", title: "四周各扩 25%（主体不变，场景变大）", pads: { left: 0.25, right: 0.25, up: 0.25, down: 0.25 } },
];

export const OutpaintNode = memo(function OutpaintNode({ id, data, selected }: NodeProps) {
  const d = data as OutpaintData;
  const upd = useBoard((s) => s.updateData);
  const setLightbox = useUi((s) => s.setLightbox);
  const nodes = useBoard((s) => s.nodes);
  const edges = useBoard((s) => s.edges);
  const up = useMemo(() => collectUpstream(id), [nodes, edges, id]);
  const upImage = up.images[0];
  const [editing, setEditing] = useState(false);
  const running = d.status === "running";
  const main = d.results?.[d.picked ?? 0];
  const pads = d.pads ?? { left: 0, right: 0, up: 0, down: 0 };
  const hasPads = pads.left + pads.right + pads.up + pads.down > 0;
  const samePads = (a: OutpaintPads, b: OutpaintPads) =>
    a.left === b.left && a.right === b.right && a.up === b.up && a.down === b.down;

  const openEditor = () => {
    if (!upImage) {
      toast("请先连接一个上游图片节点", "err");
      return;
    }
    setEditing(true);
  };

  return (
    <NodeShell id={id} title="扩图" icon={<IcExpand size={17} />} status={d.status} error={d.error} selected={selected} width={310}>
      <div className="mnode-body">
        <button className={`btn nodrag ${hasPads ? "" : "primary"}`} onClick={openEditor}>
          <IcExpand size={16} />
          {hasPads ? "调整扩图范围" : "取景扩图（拖边缘 / 选比例）"}
        </button>
        {hasPads ? (
          <div className="gen-sum nodrag" title="当前扩展范围（点上方按钮可视化调整）">
            <span>{padsSummary(pads)}</span>
          </div>
        ) : null}
        <div className="ctl-row nodrag">
          <span>预设</span>
          <span className="lang-seg">
            {PRESETS.map((p) => (
              <button key={p.label} className={samePads(pads, p.pads) ? "on" : ""} title={p.title} onClick={() => upd(id, { pads: p.pads })}>
                {p.label}
              </button>
            ))}
          </span>
        </div>
        <textarea
          className="textarea nodrag nowheel"
          rows={2}
          placeholder="扩展区域希望出现什么（留空 = 自然延伸场景）"
          value={d.prompt}
          onChange={(e) => upd(id, { prompt: e.target.value })}
        />
        <div className="ctl-row nodrag">
          <span>张数</span>
          <span className="lang-seg">
            {[1, 2, 3, 4].map((n) => (
              <button key={n} className={(d.count ?? 1) === n ? "on" : ""} onClick={() => upd(id, { count: n })}>
                {n}
              </button>
            ))}
          </span>
        </div>
        <div
          className="ctl-row nodrag"
          title={
            "真蒙版：原图摆入扩大的透明画布走 images/edits（需中转站如实转发 mask）\n" +
            "指令式：发原图 + 目标比例/尺寸 + 文字指令，兼容性最好\n" +
            "自动：GPT Image 系用真蒙版，其余模型用指令式"
          }
        >
          <span>通道</span>
          <span className="lang-seg">
            {([
              ["auto", "自动"],
              ["mask", "真蒙版"],
              ["instruct", "指令式"],
            ] as const).map(([v, lab]) => (
              <button key={v} className={(d.channel ?? "auto") === v ? "on" : ""} onClick={() => upd(id, { channel: v })}>
                {lab}
              </button>
            ))}
          </span>
        </div>
        <ModelPicker role="image" value={d.modelId} onChange={(v) => upd(id, { modelId: v })} />
        <button className="btn primary nodrag" disabled={running} onClick={() => void runFlow(id)}>
          {running ? <IcLoading size={17} /> : <IcExpand size={17} />}
          {running ? "扩图中…" : "扩展画面"}
        </button>
        {running ? (
          <div className="skeleton">
            <span>正在延伸画面…</span>
          </div>
        ) : main ? (
          <>
            <Thumb className="img-main nodrag" src={main} alt="" res onClick={() => setLightbox(main, upImage)} />
            {d.results.length > 1 ? (
              <div className="thumbs nodrag">
                {d.results.map((s, i) => (
                  <Thumb key={i} src={s} className={i === (d.picked ?? 0) ? "on" : ""} onClick={() => upd(id, { picked: i })} alt="" />
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      {editing && upImage ? (
        <OutpaintEditor src={upImage} initial={pads} onSave={(p) => upd(id, { pads: p })} onClose={() => setEditing(false)} />
      ) : null}
      <PortTextIn />
      <PortImageIn />
      <PortOut kind="image" />
    </NodeShell>
  );
});
