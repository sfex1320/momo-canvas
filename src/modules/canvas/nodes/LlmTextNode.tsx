import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortOut, PortTextIn } from "../NodeShell";
import { IcLoading, IcWand } from "../../../ui/icons";
import { ModelPicker } from "../../../ui/ModelPicker";
import { useBoard } from "../../../core/stores/boardStore";
import { runLlmText } from "../../../core/runner";
import type { LlmTextData } from "../../../core/types";

export const LlmTextNode = memo(function LlmTextNode({ id, data, selected }: NodeProps) {
  const d = data as LlmTextData;
  const upd = useBoard((s) => s.updateData);
  const running = d.status === "running";

  return (
    <NodeShell
      id={id}
      title="文本处理"
      icon={<IcWand size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={300}
    >
      <div className="mnode-body">
        <select
          className="select nodrag"
          style={{ minHeight: 33 }}
          value={d.op}
          onChange={(e) => upd(id, { op: e.target.value })}
        >
          <option value="optimize">AI 扩写优化（绘画提示词）</option>
          <option value="zh2en">中文 → 英文提示词</option>
          <option value="expand">扩写丰富</option>
          <option value="shorten">精简压缩</option>
          <option value="custom">自定义指令…</option>
        </select>
        {d.op === "custom" ? (
          <textarea
            className="textarea nodrag nowheel"
            rows={2}
            placeholder="例如：把这段话改写成小红书文案风格"
            value={d.custom}
            onChange={(e) => upd(id, { custom: e.target.value })}
          />
        ) : null}
        <ModelPicker role="chat" value={d.modelId} onChange={(v) => upd(id, { modelId: v })} />
        <button className="btn primary nodrag" disabled={running} onClick={() => void runLlmText(id)}>
          {running ? <IcLoading size={17} /> : <IcWand size={17} />}
          {running ? "处理中…" : "处理（读取上游文本）"}
        </button>
        {d.result || running ? (
          <textarea
            className="textarea nodrag nowheel"
            rows={5}
            value={d.result}
            placeholder="处理结果…"
            onChange={(e) => upd(id, { result: e.target.value })}
          />
        ) : null}
      </div>
      <PortTextIn />
      <PortOut kind="text" />
    </NodeShell>
  );
});
