/**
 * 节点内模型选择器 — 列出配置了该用途模型的服务商 + 「默认」
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
  const providers = useSettings((s) => s.settings.models.providers);
  const defaults = useSettings((s) => s.settings.models.defaults);
  const mine = providers.filter((p) => p.models[role]?.model);
  const def = mine.find((p) => p.id === defaults[role]) ?? mine[0];
  return (
    <select
      className="select nodrag model-picker"
      value={value ?? ""}
      title="该节点使用的模型"
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      <option value="">{def ? `默认 · ${def.name} · ${def.models[role]!.model}` : "默认（尚未配置模型）"}</option>
      {mine.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} · {p.models[role]!.model}
        </option>
      ))}
    </select>
  );
}
