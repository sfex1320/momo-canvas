import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { IcTrash } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import type { NoteData } from "../../../core/types";

const COLORS: NoteData["color"][] = ["yellow", "blue", "pink", "green"];

export const NoteNode = memo(function NoteNode({ id, data, selected }: NodeProps) {
  const d = data as NoteData;
  const upd = useBoard((s) => s.updateData);
  const removeNode = useBoard((s) => s.removeNode);

  return (
    <div className={`note-card ${d.color} ${selected ? "sel" : ""}`}>
      <div className="note-head nodrag">
        <span className="note-dots">
          {COLORS.map((c) => (
            <button
              key={c}
              className={`note-dot ${c} ${d.color === c ? "on" : ""}`}
              onClick={() => upd(id, { color: c })}
            />
          ))}
        </span>
        <button className="icon-btn danger" style={{ width: 26, height: 26 }} onClick={() => removeNode(id)}>
          <IcTrash size={14} />
        </button>
      </div>
      <textarea
        className="note-text nodrag nowheel"
        placeholder="备注…"
        value={d.text}
        onChange={(e) => upd(id, { text: e.target.value })}
      />
    </div>
  );
});
