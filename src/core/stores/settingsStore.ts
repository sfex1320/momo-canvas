import { create } from "zustand";
import {
  DEFAULT_HOTKEYS,
  DEFAULT_SETTINGS,
  PROTOCOLS,
  ROLE_LABEL,
  type LegacyModelsV2,
  type LegacyRoleSlotV3,
  type LegacySettingsV1,
  type ModelCard,
  type ModelRole,
  type ModelsCfg,
  type ProviderCard,
  type RoleSlot,
  type Settings,
} from "../types";
import { loadJSON, saveJSON } from "../persist";
import { uid } from "../utils";

/** 「服务商 + 模型」复合键（节点选择 / 角色默认 都用它） */
export function modelKey(providerId: string, model: string) {
  return `${providerId}::${model}`;
}

export function splitModelKey(key?: string): { pid?: string; model?: string } {
  if (!key) return {};
  const i = key.indexOf("::");
  if (i < 0) return { pid: key }; // 旧数据：只有服务商 id
  return { pid: key.slice(0, i), model: key.slice(i + 2) };
}

/** 兼容 v3 单模型槽位：model → models[]，顺带去重去空 */
function normalizeSlot(raw: LegacyRoleSlotV3 | RoleSlot): RoleSlot {
  const legacy = raw as LegacyRoleSlotV3;
  const list = (legacy.models ?? (legacy.model ? [legacy.model] : []))
    .map((m) => m.trim())
    .filter(Boolean);
  return { protocol: raw.protocol, models: [...new Set(list)] };
}

function normalizeProviders(providers: ProviderCard[]): ProviderCard[] {
  return providers.map((p) => {
    const models: ProviderCard["models"] = {};
    for (const role of ROLES) {
      const slot = p.models?.[role];
      if (!slot) continue;
      const fixed = normalizeSlot(slot);
      if (fixed.models.length) models[role] = fixed;
    }
    return { ...p, models };
  });
}

type SettingsState = {
  settings: Settings;
  loaded: boolean;
  init: () => Promise<void>;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  upsertProvider: (p: ProviderCard) => void;
  removeProvider: (id: string) => void;
  setDefault: (role: ModelRole, id: string) => void;
  /** 从导出的 JSON 恢复整套配置 */
  importSettings: (raw: unknown) => void;
};

/** 任意来源的部分配置 → 规整为完整 Settings（缺项补默认，槽位/默认键规整为新结构） */
function normalize(v: Partial<Settings>): Settings {
  return {
    models: fixDefaults({ providers: normalizeProviders(v.models?.providers ?? []), defaults: v.models?.defaults ?? {} }),
    search: { ...DEFAULT_SETTINGS.search, ...(v.search ?? {}) },
    save: { ...DEFAULT_SETTINGS.save, ...(v.save ?? {}) },
    comfy: { ...DEFAULT_SETTINGS.comfy, ...(v.comfy ?? {}) },
    theme: v.theme ?? "dark",
    gpuBoost: v.gpuBoost ?? true,
    sound: { ...DEFAULT_SETTINGS.sound, ...(v.sound ?? {}) },
    protoSelfHeal: v.protoSelfHeal ?? true,
    hotkeys: { ...DEFAULT_HOTKEYS, ...(v.hotkeys ?? {}) },
    shortcuts: v.shortcuts ?? [],
    // 旧数据的协议没有 role 或 role 非法 → 一律归为图片（可在「设置 → 协议」编辑改用途）
    customProtocols: (v.customProtocols ?? []).map((p) => ({
      ...p,
      role: p.role === "video" ? ("video" as const) : p.role === "audio" ? ("audio" as const) : ("image" as const),
    })),
  };
}

function applyTheme(theme: Settings["theme"]) {
  document.documentElement.setAttribute("data-theme", theme);
}

/** 画布 GPU 加速开关 → 根元素 class（canvas.css 按 .gpu-boost 作用域生效） */
function applyGpu(on: boolean) {
  document.documentElement.classList.toggle("gpu-boost", on);
}

const ROLES: ModelRole[] = ["chat", "image", "video", "audio"];

/** 修补 defaults：规整为「pid::model」，指向不存在的服务商/模型时退回第一个可用的 */
function fixDefaults(cfg: ModelsCfg): ModelsCfg {
  const defaults = { ...cfg.defaults };
  for (const role of ROLES) {
    const { pid, model } = splitModelKey(defaults[role]);
    const p = cfg.providers.find((x) => x.id === pid && x.models[role]?.models.length);
    if (p) {
      const slot = p.models[role]!;
      defaults[role] = modelKey(p.id, model && slot.models.includes(model) ? model : slot.models[0]);
    } else {
      const first = cfg.providers.find((x) => x.models[role]?.models.length);
      defaults[role] = first ? modelKey(first.id, first.models[role]!.models[0]) : undefined;
    }
  }
  return { ...cfg, defaults };
}

/** v2 平铺卡片 → v3 服务商卡片：同 baseUrl+apiKey 的卡合并为一家，角色冲突则另立一家 */
function migrateModelsV2(old: LegacyModelsV2): ModelsCfg {
  const providers: ProviderCard[] = [];
  const cardToProvider = new Map<string, string>();
  for (const c of old.cards ?? []) {
    const slot: RoleSlot = { protocol: c.protocol, models: c.model ? [c.model] : [] };
    const home = providers.find(
      (p) => p.baseUrl === c.baseUrl && p.apiKey === c.apiKey && !p.models[c.role],
    );
    if (home) {
      home.models[c.role] = slot;
      cardToProvider.set(c.id, home.id);
    } else {
      providers.push({ id: c.id, name: c.name, baseUrl: c.baseUrl, apiKey: c.apiKey, models: { [c.role]: slot } });
      cardToProvider.set(c.id, c.id);
    }
  }
  const defaults: ModelsCfg["defaults"] = {};
  for (const role of ROLES) {
    const d = old.defaults?.[role];
    if (d && cardToProvider.has(d)) defaults[role] = cardToProvider.get(d);
  }
  return fixDefaults({ providers, defaults });
}

/** v1 单套配置 → v3 */
function migrateV1(old: LegacySettingsV1): Partial<Settings> {
  const cards: ModelCard[] = [];
  if (old.chat?.baseUrl || old.chat?.model)
    cards.push({ id: uid(8), role: "chat", name: "中转站 A", protocol: "openai", baseUrl: old.chat.baseUrl ?? "", apiKey: old.chat.apiKey ?? "", model: old.chat.model ?? "" });
  if (old.image?.baseUrl || old.image?.model)
    cards.push({ id: uid(8), role: "image", name: "中转站 A", protocol: "openai", baseUrl: old.image.baseUrl ?? "", apiKey: old.image.apiKey ?? "", model: old.image.model ?? "", size: old.image.size ?? "1024x1024" });
  if (old.video?.baseUrl || old.video?.model)
    cards.push({ id: uid(8), role: "video", name: "中转站 A", protocol: (old.video.style as ModelCard["protocol"]) ?? "zhipu", baseUrl: old.video.baseUrl ?? "", apiKey: old.video.apiKey ?? "", model: old.video.model ?? "" });
  return {
    models: migrateModelsV2({ cards, defaults: {} }),
    search: { ...DEFAULT_SETTINGS.search, ...(old.search ?? {}) },
    save: { ...DEFAULT_SETTINGS.save, ...(old.save ?? {}) },
    comfy: { ...DEFAULT_SETTINGS.comfy, ...(old.comfy ?? {}) },
    theme: old.theme ?? "dark",
  };
}

let initOnce: Promise<void> | null = null;

export const useSettings = create<SettingsState>((set, get) => {
  const commit = (next: Settings) => {
    set({ settings: next });
    void saveJSON("settings.json", "v3", next);
  };

  return {
    settings: DEFAULT_SETTINGS,
    loaded: false,

    init: () =>
      (initOnce ??= (async () => {
        let merged: Settings | null = null;
        const v3 = await loadJSON<Partial<Settings>>("settings.json", "v3");
        if (v3) {
          merged = normalize(v3);
        } else {
          // v3 不存在时依次回退：v2 → v1 → 上次自动备份（升级/异常后的兜底恢复）
          const v2 = await loadJSON<{ models?: LegacyModelsV2 } & Partial<Omit<Settings, "models">>>("settings.json", "v2");
          if (v2) {
            merged = normalize({ ...v2, models: undefined });
            merged = { ...merged, models: migrateModelsV2(v2.models ?? { cards: [], defaults: {} }) };
          } else {
            const v1 = await loadJSON<LegacySettingsV1>("settings.json", "v1");
            if (v1) merged = normalize(migrateV1(v1));
            else {
              const bak = await loadJSON<Partial<Settings>>("settings.backup.json", "v3");
              if (bak) merged = normalize(bak);
            }
          }
          if (merged) void saveJSON("settings.json", "v3", merged);
        }
        const final = merged ?? DEFAULT_SETTINGS;
        applyTheme(final.theme);
        applyGpu(final.gpuBoost);
        set({ settings: final, loaded: true });
        // 每次启动写一份备份，任何升级/迁移出问题都能从备份找回
        if (merged) void saveJSON("settings.backup.json", "v3", final);
      })()),

    importSettings: (raw) => {
      if (!raw || typeof raw !== "object") throw new Error("配置文件格式不正确");
      const next = normalize(raw as Partial<Settings>);
      applyTheme(next.theme);
      applyGpu(next.gpuBoost);
      commit(next);
    },

    update: (key, value) => {
      const next = { ...get().settings, [key]: value };
      if (key === "theme") applyTheme(next.theme);
      if (key === "gpuBoost") applyGpu(next.gpuBoost);
      commit(next);
    },

    upsertProvider: (p) => {
      const s = get().settings;
      const exists = s.models.providers.some((x) => x.id === p.id);
      const providers = exists ? s.models.providers.map((x) => (x.id === p.id ? p : x)) : [...s.models.providers, p];
      commit({ ...s, models: fixDefaults({ providers, defaults: s.models.defaults }) });
    },

    removeProvider: (id) => {
      const s = get().settings;
      const providers = s.models.providers.filter((p) => p.id !== id);
      commit({ ...s, models: fixDefaults({ providers, defaults: s.models.defaults }) });
    },

    setDefault: (role, id) => {
      const s = get().settings;
      commit({ ...s, models: { ...s.models, defaults: { ...s.models.defaults, [role]: id } } });
    },
  };
});

/** 服务商卡片 + 角色（+ 指定模型，缺省取该槽第一个）→ 扁平化模型配置（服务层消费） */
export function flattenCard(p: ProviderCard, role: ModelRole, model?: string): ModelCard | null {
  const slot = p.models[role];
  if (!slot?.models.length) return null;
  return {
    id: p.id,
    role,
    name: p.name,
    protocol: slot.protocol,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: model && slot.models.includes(model) ? model : slot.models[0],
  };
}

/** 解析节点应使用的模型：节点指定的「pid::model」 > 角色默认 > 第一家配了该角色的。兼容旧数据的纯 pid。 */
export function resolveModelCard(role: ModelRole, key?: string): ModelCard {
  const { providers, defaults } = useSettings.getState().settings.models;
  const sel = splitModelKey(key);
  const def = splitModelKey(defaults[role]);
  const hasRole = (x: ProviderCard) => !!x.models[role]?.models.length;
  let p: ProviderCard | undefined;
  let model: string | undefined;
  if (sel.pid) {
    p = providers.find((x) => x.id === sel.pid && hasRole(x));
    model = sel.model;
  }
  if (!p) {
    p = providers.find((x) => x.id === def.pid && hasRole(x));
    model = def.model;
  }
  if (!p) {
    p = providers.find(hasRole);
    model = undefined;
  }
  const card = p ? flattenCard(p, role, model) : null;
  if (!card) throw new Error(`还没有可用的${ROLE_LABEL[role]}：请到「设置 → 模型配置」添加服务商并配置模型`);
  return card;
}

/** 配置了某角色模型的全部服务商（供节点模型选择器使用） */
export function providersOfRole(role: ModelRole): ProviderCard[] {
  return useSettings.getState().settings.models.providers.filter((p) => p.models[role]?.models.length);
}

/** 该角色的默认协议（新建槽位时用） */
export function defaultProtocol(role: ModelRole) {
  return PROTOCOLS[role][0].value as ModelCard["protocol"];
}
