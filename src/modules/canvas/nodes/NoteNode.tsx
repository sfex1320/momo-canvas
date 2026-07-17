import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { IcLock, IcTrash, IcUnlock } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import type { NoteData } from "../../../core/types";

const COLORS: NoteData["color"][] = ["yellow", "blue", "pink", "green"];

export const NoteNode = memo(function NoteNode({ id, data, selected }: NodeProps) {
  const d = data as NoteData;
  const upd = useBoard((s) => s.updateData);
  const removeNode = useBoard((s) => s.removeNode);

  return (
    // 锁定时整卡 nodrag 不可拖动；未锁定时头部/边缘可拖（文本区仍不参与拖拽）
    <div className={`note-card ${d.color} ${selected ? "sel" : ""} ${d.locked ? "nodrag locked" : ""}`}>
      <div className="note-head">
        <span className="note-dots nodrag">
          {COLORS.map((c) => (
            <button
              key={c}
              className={`note-dot ${c} ${d.color === c ? "on" : ""}`}
              onClick={() => upd(id, { color: c })}
            />
          ))}
        </span>
        <span style={{ display: "flex", gap: 2 }} className="nodrag">
          <button
            className={`icon-btn ${d.locked ? "on-warn" : ""}`}
            style={{ width: 26, height: 26 }}
            title={d.locked ? "解除锁定（恢复可拖动）" : "锁定（不可拖动）"}
            onClick={() => upd(id, { locked: !d.locked })}
          >
            {d.locked ? <IcLock size={14} /> : <IcUnlock size={14} />}
          </button>
          <button className="icon-btn danger" style={{ width: 26, height: 26 }} onClick={() => removeNode(id)}>
            <IcTrash size={14} />
          </button>
        </span>
      </div>
      <textarea
        className="note-text nodrag nowheel"
        placeholder="备注…（按住顶部空白或边缘拖动）"
        value={d.text}
        onChange={(e) => upd(id, { text: e.target.value })}
      />
    </div>
  );
});
