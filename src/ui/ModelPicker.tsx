/**
 * 节点内模型选择器 — LibLib 式浮层：图标 + 模型名 + 服务商描述 + 选中勾。
 * 值为复合键「providerId::model」；兼容旧数据里只存服务商 id 的情况。
 * 列表经 providersOfRole 取数：本地 GGUF 模型（虚拟服务商 local-gguf）也一并列出。
 */
import type { ReactNode } from "react";
import { modelKey, splitModelKey, providersOfRole } from "../core/stores/settingsStore";
import { useSettings } from "../core/stores/settingsStore";
import { useLocalGguf } from "../core/stores/localGgufStore";
import type { ModelRole } from "../core/types";
import { PopSelect, type PopOption } from "./PopSelect";
import { IcBrain, IcImage, IcMic, IcMusic, IcSparkles, IcVideo } from "./icons";

const ROLE_ICON: Record<ModelRole, ReactNode> = {
  chat: <IcBrain size={16} />,
  image: <IcImage size={16} />,
  video: <IcVideo size={16} />,
  audio: <IcMusic size={16} />,
  asr: <IcMic size={16} />,
};

export function ModelPicker({
  role,
  value,
  onChange,
  up,
}: {
  role: ModelRole;
  value?: string;
  onChange: (key?: string) => void;
  /** 向上弹出（底部生成栏等贴近屏幕下缘的场景） */
  up?: boolean;
}) {
  // 订阅整份模型配置：服务商增删/改名/改槽位都要刷新列表
  useSettings((s) => s.settings.models);
  const defaults = useSettings((s) => s.settings.models.defaults);
  // 本地 GGUF 注册表增删也触发刷新（providersOfRole 内部注入虚拟服务商）
  useLocalGguf((s) => s.models);
  const providers = providersOfRole(role);

  const entries = providers.flatMap((p) =>
    (p.models[role]?.models ?? []).map((m) => ({ key: modelKey(p.id, m), model: m==="codex-image"?"Codex 生图":m, provider: p.name })),
  );
  const defEntry = entries.find((e) => e.key === defaults[role]) ?? entries[0];

  // 旧数据只存了服务商 id → 映射到该服务商的第一个模型，保证能正确回显
  let current = value ?? "";
  if (current && !current.includes("::")) {
    const { pid } = splitModelKey(current);
    const first = providers.find((p) => p.id === pid)?.models[role]?.models[0];
    current = first ? modelKey(pid!, first) : "";
  }

  const options: PopOption[] = [
    {
      value: "",
      label: "默认",
      desc: defEntry ? `跟随角色默认 · ${defEntry.provider} ${defEntry.model}` : "尚未配置模型",
      icon: <IcSparkles size={16} />,
    },
    ...entries.map((e) => ({
      value: e.key,
      label: e.model,
      desc: e.provider,
      icon: ROLE_ICON[role],
    })),
  ];

  return (
    <PopSelect
      className="nodrag model-picker"
      layerClassName="mp-layer"
      title="模型选择"
      value={current}
      options={options}
      placeholder="选择模型…"
      onChange={(v) => onChange(v || undefined)}
      up={up}
    />
  );
}
