import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortOut, PortTextIn } from "../NodeShell";
import { IcMerge } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import type { CombineData } from "../../../core/types";

export const CombineNode = memo(function CombineNode({ id, data, selected }: NodeProps) {
  const d = data as CombineData;
  const upd = useBoard((s) => s.updateData);
  const inputCount = useBoard((s) => s.edges.filter((e) => e.target === id).length);

  return (
    <NodeShell
      id={id}
      title="拼接文本"
      icon={<IcMerge size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={280}
    >
      <div className="mnode-body">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-2)", flex: "none" }}>连接符</span>
          <select
            className="select nodrag"
            style={{ minHeight: 33 }}
            value={d.separator}
            onChange={(e) => upd(id, { separator: e.target.value })}
          >
            <option value="comma">逗号 ,</option>
            <option value="newline">换行</option>
            <option value="space">空格</option>
          </select>
        </div>
        <textarea
          className="textarea nodrag nowheel"
          rows={3}
          placeholder="附加文本（拼在上游文本之后，可留空）"
          value={d.extra}
          onChange={(e) => upd(id, { extra: e.target.value })}
        />
        <div style={{ fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.6 }}>
          已连接 {inputCount} 路上游文本；输出 = 上游文本 + 附加文本，供下游生成节点使用。
        </div>
      </div>
      <PortTextIn />
      <PortOut kind="text" />
    </NodeShell>
  );
});
