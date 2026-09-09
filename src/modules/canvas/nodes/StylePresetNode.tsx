import { memo, useState } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortOut } from "../NodeShell";
import { IcPalette, IcPoster, IcInk, IcLens, IcSun, IcBox, IcMoon, IcClose } from "../../../ui/icons";
import { OptGrid } from "../../../ui/kit";
import { useBoard } from "../../../core/stores/boardStore";
import { STYLE_CATEGORIES, STYLE_PRESETS, type StyleEntry } from "../../../core/stylePresets";
import type { StylePresetData } from "../../../core/types";

const CATEGORY_ICONS = [IcPoster, IcInk, IcSun, IcLens, IcBox, IcMoon, IcPalette];
const CATEGORY_OPTIONS = STYLE_CATEGORIES.map((c, i) => {
  const Icon = CATEGORY_ICONS[i] ?? IcPalette;
  return { value: c, label: c === "艺术风格" ? "绘画" : c, icon: <Icon size={15} /> };
});
const LABELS = new Map(Object.values(STYLE_PRESETS).flat().map(e => [e.value, e.label]));
const LENS_GROUPS: Record<string, string> = { 特写: "景别", 广角全景: "景别", 俯拍航拍: "视角", 低角度仰拍: "视角", 微距: "光学", 鱼眼: "光学", 移轴微缩: "光学", 长焦压缩: "光学" };

export const StylePresetNode = memo(function StylePresetNode({ id, data, selected }: NodeProps) {
  const d = data as StylePresetData;
  const upd = useBoard((s) => s.updateData);
  const [query, setQuery] = useState("");
  const entries = STYLE_PRESETS[d.category] ?? [];
  const filtered = entries.filter(e => `${e.label} ${e.value} ${e.group ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  const groups = new Map<string, StyleEntry[]>();
  for (const e of filtered) {
    const key = e.group ?? (d.category === "镜头" ? LENS_GROUPS[e.label] : undefined) ?? "风格";
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
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
            onClick={() => upd(id, { selected: [] })}
          >
            清空 {sel.size}
          </button>
        ) : undefined
      }
    >
      <div className="mnode-body">
        <OptGrid options={CATEGORY_OPTIONS} value={d.category} onChange={(v) => { upd(id, { category: v }); setQuery(""); }} cols={4} />
        <input className="input nodrag" aria-label="搜索风格" placeholder={`搜索${d.category === "艺术风格" ? "绘画" : d.category} · ${entries.length} 项`} value={query} onChange={e => setQuery(e.target.value)} />
        <div className="style-preset-list nodrag nowheel">
          {[...groups].map(([group, options]) => <section key={group}>
          {groups.size > 1 && <div className="ne-section-label">{group}</div>}
          <div className="chips">{options.map((e) => (
            <button
              key={e.value}
              className={`chip ${sel.has(e.value) ? "on" : ""}`}
              title={e.value}
              onClick={() => toggle(e.value)}
            >
              {e.label}
            </button>
          ))}</div></section>)}
          {!filtered.length && <div className="style-preset-hint">没有匹配的预设</div>}
        </div>
        {sel.size ? (
          <div className="style-preset-picked nodrag nowheel">
            <div className="ne-section-label">已选 {sel.size} · 点击移除</div>
            <div className="chips">{[...sel].map(value => <button key={value} className="chip on" title={value} onClick={() => toggle(value)}>{LABELS.get(value) ?? "自定义风格"}<IcClose size={10} /></button>)}</div>
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: "var(--text-3)" }}>点选风格片段，可跨分类叠加，输出给下游节点</div>
        )}
      </div>
      <PortOut kind="text" />
    </NodeShell>
  );
});
