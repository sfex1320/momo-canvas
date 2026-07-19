/**
 * 局部重绘节点 — 涂抹/框选上游图片的区域，按提示词只重绘该区域
 * GPT Image 走 images/edits 真蒙版；Banana/通用走「原图+红色标注图+指令」降级
 */
import { memo, useMemo, useState } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortImageIn, PortOut, PortTextIn } from "../NodeShell";
import { IcBrush, IcLoading } from "../../../ui/icons";
import { ModelPicker } from "../../../ui/ModelPicker";
import { useBoard } from "../../../core/stores/boardStore";
import { toast, useUi } from "../../../core/stores/uiStore";
import { collectUpstream, runFlow } from "../../../core/runner";
import { MaskEditor } from "../MaskEditor";
import { Thumb } from "../../../ui/Thumb";
import type { InpaintData } from "../../../core/types";

export const InpaintNode = memo(function InpaintNode({ id, data, selected }: NodeProps) {
  const d = data as InpaintData;
  const upd = useBoard((s) => s.updateData);
  const setLightbox = useUi((s) => s.setLightbox);
  const nodes = useBoard((s) => s.nodes);
  const edges = useBoard((s) => s.edges);
  const up = useMemo(() => collectUpstream(id), [nodes, edges, id]);
  const upImage = up.images[0];
  const [editing, setEditing] = useState(false);
  const running = d.status === "running";
  const main = d.results?.[d.picked ?? 0];

  const openEditor = () => {
    if (!upImage) {
      toast("请先连接一个上游图片节点", "err");
      return;
    }
    setEditing(true);
  };

  return (
    <NodeShell id={id} title="局部重绘" icon={<IcBrush size={17} />} status={d.status} error={d.error} selected={selected} width={310}>
      <div className="mnode-body">
        <button className={`btn nodrag ${d.mask ? "" : "primary"}`} onClick={openEditor}>
          <IcBrush size={16} />
          {d.mask ? "重新编辑蒙版" : "编辑蒙版（涂抹要重绘的区域）"}
        </button>
        {d.mask ? (
          <div className="gen-sum nodrag" title="已有蒙版：红色区域将被重绘，可点上方按钮修改">
            <span>✓ 蒙版已设置 · 仅重绘标注区域</span>
            <button
              className="link-btn nodrag"
              onClick={() => upd(id, { mask: undefined })}
              title="清除蒙版"
            >
              清除
            </button>
          </div>
        ) : null}
        <textarea
          className="textarea nodrag nowheel"
          rows={2}
          placeholder="选区要改成什么（留空 = 自动取上游文本 / 自然修复）"
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
            "真蒙版：走 images/edits 的 mask 参数，需要中转站如实转发（不少站会丢参数，表现为输出和原图毫无关系）\n" +
            "指令式：发「原图 + 红色标注图」走普通图生图通道，兼容性最好\n" +
            "自动：GPT Image 系模型用真蒙版，其余模型用指令式"
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
          {running ? <IcLoading size={17} /> : <IcBrush size={17} />}
          {running ? "重绘中…" : "局部重绘"}
        </button>
        {running ? (
          <div className="skeleton">
            <span>正在重绘选区…</span>
          </div>
        ) : main ? (
          <>
            <Thumb className="img-main nodrag" src={main} alt="" res onClick={() => setLightbox(main)} />
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
        <MaskEditor src={upImage} initialMask={d.mask} onSave={(mask) => upd(id, { mask })} onClose={() => setEditing(false)} />
      ) : null}
      <PortTextIn />
      <PortImageIn />
      <PortOut kind="image" />
    </NodeShell>
  );
});
