import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortImageIn, PortOut } from "../NodeShell";
import { IcLoading, IcScan } from "../../../ui/icons";
import { ModelPicker } from "../../../ui/ModelPicker";
import { useBoard } from "../../../core/stores/boardStore";
import { runCaption } from "../../../core/runner";
import type { CaptionData } from "../../../core/types";

export const CaptionNode = memo(function CaptionNode({ id, data, selected }: NodeProps) {
  const d = data as CaptionData;
  const upd = useBoard((s) => s.updateData);
  const running = d.status === "running";

  return (
    <NodeShell
      id={id}
      title="反推描述"
      icon={<IcScan size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={300}
    >
      <div className="mnode-body">
        <div style={{ display: "flex", gap: 7 }}>
          <select
            className="select nodrag"
            style={{ flex: 1, minHeight: 33 }}
            value={d.mode}
            onChange={(e) => upd(id, { mode: e.target.value })}
          >
            <option value="prompt">输出：绘画提示词</option>
            <option value="detail">输出：详细描述</option>
            <option value="tags">输出：英文标签词</option>
          </select>
        </div>
        <ModelPicker role="chat" value={d.modelId} onChange={(v) => upd(id, { modelId: v })} />
        <button className="btn primary nodrag" disabled={running} onClick={() => void runCaption(id)}>
          {running ? <IcLoading size={17} /> : <IcScan size={17} />}
          {running ? "识别中…" : "反推（需连接上游图片）"}
        </button>
        {d.result || running ? (
          <textarea
            className="textarea nodrag nowheel"
            rows={5}
            value={d.result}
            placeholder="识别结果…"
            onChange={(e) => upd(id, { result: e.target.value })}
          />
        ) : null}
      </div>
      <PortImageIn top={26} />
      <PortOut kind="text" />
    </NodeShell>
  );
});
