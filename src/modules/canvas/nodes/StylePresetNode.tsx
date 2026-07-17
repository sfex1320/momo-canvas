import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortOut } from "../NodeShell";
import { IcPalette } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { STYLE_CATEGORIES, STYLE_PRESETS } from "../../../core/stylePresets";
import type { StylePresetData } from "../../../core/types";

export const StylePresetNode = memo(function StylePresetNode({ id, data, selected }: NodeProps) {
  const d = data as StylePresetData;
  const upd = useBoard((s) => s.updateData);
  const entries = STYLE_PRESETS[d.category] ?? [];
  const sel = new Set(d.selected ?? []);

  const toggle = (value: string) => {
    const next = new Set(sel);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    upd(id, { selected: [...next] });
  };

  return (
    <NodeShell
      id={id}
      title="风格预设"
      icon={<IcPalette size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={330}
      headExtra={
        sel.size ? (
          <button
            className="btn sm nodrag"
            style={{ marginRight: 2 }}
            onClick={() => upd(id, { selected: [] })}
          >
            清空 {sel.size}
          </button>
        ) : undefined
      }
    >
      <div className="mnode-body">
        <select
          className="select nodrag"
          style={{ minHeight: 33 }}
          value={d.category}
          onChange={(e) => upd(id, { category: e.target.value })}
        >
          {STYLE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <div className="chips nodrag nowheel">
          {entries.map((e) => (
            <button
              key={e.value}
              className={`chip ${sel.has(e.value) ? "on" : ""}`}
              title={e.value}
              onClick={() => toggle(e.value)}
            >
              {e.label}
            </button>
          ))}
        </div>
        {sel.size ? (
          <div style={{ fontSize: 12, color: "var(--text-3)", lineHeight: 1.5, maxHeight: 54, overflowY: "auto" }} className="nowheel">
            {[...sel].join(", ")}
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: "var(--text-3)" }}>点选风格片段，可跨分类叠加，输出给下游节点</div>
        )}
      </div>
      <PortOut kind="text" />
    </NodeShell>
  );
});
