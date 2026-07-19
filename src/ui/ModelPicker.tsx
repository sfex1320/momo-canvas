/**
 * 节点内模型选择器 — 平铺全部「服务商 - 模型」组合 + 「默认」
 * 值为复合键「providerId::model」；兼容旧数据里只存服务商 id 的情况。
 */
import { modelKey, splitModelKey } from "../core/stores/settingsStore";
import { useSettings } from "../core/stores/settingsStore";
import type { ModelRole } from "../core/types";

export function ModelPicker({
  role,
  value,
  onChange,
}: {
  role: ModelRole;
  value?: string;
  onChange: (key?: string) => void;
}) {
  const providers = useSettings((s) => s.settings.models.providers);
  const defaults = useSettings((s) => s.settings.models.defaults);

  const entries = providers.flatMap((p) =>
    (p.models[role]?.models ?? []).map((m) => ({ key: modelKey(p.id, m), label: `${p.name} - ${m}` })),
  );
  const defEntry = entries.find((e) => e.key === defaults[role]) ?? entries[0];

  // 旧数据只存了服务商 id → 映射到该服务商的第一个模型，保证下拉框能正确回显
  let current = value ?? "";
  if (current && !current.includes("::")) {
    const { pid } = splitModelKey(current);
    const first = providers.find((p) => p.id === pid)?.models[role]?.models[0];
    current = first ? modelKey(pid!, first) : "";
  }

  return (
    <select
      className="select nodrag model-picker"
      value={current}
      title="该节点使用的模型"
      onChange={(e) => onChange(e.target.value || undefined)}
    >
      <option value="">{defEntry ? `默认 · ${defEntry.label}` : "默认（尚未配置模型）"}</option>
      {entries.map((e) => (
        <option key={e.key} value={e.key}>
          {e.label}
        </option>
      ))}
    </select>
  );
}
