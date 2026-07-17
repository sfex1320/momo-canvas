import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortOut } from "../NodeShell";
import { IcLoading, IcSparkles, IcText } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { optimizePrompt } from "../../../core/runner";
import type { PromptData } from "../../../core/types";

export const PromptNode = memo(function PromptNode({ id, data, selected }: NodeProps) {
  const d = data as PromptData;
  const upd = useBoard((s) => s.updateData);

  return (
    <NodeShell
      id={id}
      title="提示词"
      icon={<IcText size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={290}
    >
      <div className="mnode-body">
        <textarea
          className="textarea nodrag nowheel"
          rows={5}
          placeholder="描述你想要的画面…"
          value={d.text}
          onChange={(e) => upd(id, { text: e.target.value })}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>{d.text.length} 字</span>
          <button className="btn sm nodrag" disabled={!!d.optimizing} onClick={() => void optimizePrompt(id)}>
            {d.optimizing ? <IcLoading size={15} /> : <IcSparkles size={15} />}
            AI 扩写优化
          </button>
        </div>
      </div>
      <PortOut kind="text" />
    </NodeShell>
  );
});
