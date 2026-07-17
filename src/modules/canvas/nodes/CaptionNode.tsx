import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortImageIn, PortOut } from "../NodeShell";
import { IcFilter, IcLoading, IcScan, IcText } from "../../../ui/icons";
import { ModelPicker } from "../../../ui/ModelPicker";
import { OptGrid } from "../../../ui/kit";
import { useBoard } from "../../../core/stores/boardStore";
import { runCaption } from "../../../core/runner";
import type { CaptionData } from "../../../core/types";

const MODES = [
  { value: "prompt", label: "绘画提示词", icon: <IcText size={16} /> },
  { value: "detail", label: "详细描述", icon: <IcScan size={16} /> },
  { value: "tags", label: "英文标签", icon: <IcFilter size={16} /> },
];

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
        <OptGrid options={MODES} value={d.mode} onChange={(v) => upd(id, { mode: v })} cols={3} />
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
