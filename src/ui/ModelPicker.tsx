/**
 * 节点内模型选择器 — 该角色的所有配置卡 + 「默认」
 */
import { useSettings } from "../core/stores/settingsStore";
import type { ModelRole } from "../core/types";

export function ModelPicker({
  role,
  value,
  onChange,
}: {
  role: ModelRole;
  value?: string;
  onChange: (id?: string) => void;
}) {
  const cards = useSettings((s) => s.settings.models.cards);
  const defaults = useSettings((s) => s.settings.models.defaults);
  const mine = cards.filter((c) => c.role === role);
  const defCard = mine.find((c) => c.id === defaults[role]) ?? mine[0];
  return (
    <select
      className="select nodrag model-picker"
      value={value ?? ""}
      title="该节点使用的模型"
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      <option value="">{defCard ? `默认 · ${defCard.name}` : "默认（尚未配置模型）"}</option>
      {mine.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}
