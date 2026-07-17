import { create } from "zustand";
import {
  DEFAULT_SETTINGS,
  ROLE_LABEL,
  type LegacySettingsV1,
  type ModelCard,
  type ModelRole,
  type Settings,
} from "../types";
import { loadJSON, saveJSON } from "../persist";
import { uid } from "../utils";

type SettingsState = {
  settings: Settings;
  loaded: boolean;
  init: () => Promise<void>;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  upsertCard: (card: ModelCard) => void;
  removeCard: (id: string) => void;
  setDefault: (role: ModelRole, id: string) => void;
};

function applyTheme(theme: Settings["theme"]) {
  document.documentElement.setAttribute("data-theme", theme);
}

/** v1 单套配置 → v2 多卡片迁移 */
function migrateV1(old: LegacySettingsV1): Settings {
  const cards: ModelCard[] = [];
  const defaults: Settings["models"]["defaults"] = {};
  if (old.chat?.baseUrl || old.chat?.model) {
    const c: ModelCard = { id: uid(8), role: "chat", name: "对话 · 默认", protocol: "openai", baseUrl: old.chat.baseUrl ?? "", apiKey: old.chat.apiKey ?? "", model: old.chat.model ?? "" };
    cards.push(c);
    defaults.chat = c.id;
  }
  if (old.image?.baseUrl || old.image?.model) {
    const c: ModelCard = { id: uid(8), role: "image", name: "绘画 · 默认", protocol: "openai", baseUrl: old.image.baseUrl ?? "", apiKey: old.image.apiKey ?? "", model: old.image.model ?? "", size: old.image.size ?? "1024x1024" };
    cards.push(c);
    defaults.image = c.id;
  }
  if (old.video?.baseUrl || old.video?.model) {
    const c: ModelCard = { id: uid(8), role: "video", name: "视频 · 默认", protocol: (old.video.style as ModelCard["protocol"]) ?? "zhipu", baseUrl: old.video.baseUrl ?? "", apiKey: old.video.apiKey ?? "", model: old.video.model ?? "" };
    cards.push(c);
    defaults.video = c.id;
  }
  return {
    models: { cards, defaults },
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
    void saveJSON("settings.json", "v2", next);
  };

  return {
    settings: DEFAULT_SETTINGS,
    loaded: false,

    init: () =>
      (initOnce ??= (async () => {
        let merged: Settings | null = null;
        const v2 = await loadJSON<Partial<Settings>>("settings.json", "v2");
        if (v2) {
          merged = {
            models: { cards: v2.models?.cards ?? [], defaults: v2.models?.defaults ?? {} },
            search: { ...DEFAULT_SETTINGS.search, ...(v2.search ?? {}) },
            save: { ...DEFAULT_SETTINGS.save, ...(v2.save ?? {}) },
            comfy: { ...DEFAULT_SETTINGS.comfy, ...(v2.comfy ?? {}) },
            theme: v2.theme ?? "dark",
          };
        } else {
          const v1 = await loadJSON<LegacySettingsV1>("settings.json", "v1");
          if (v1) {
            merged = migrateV1(v1);
            void saveJSON("settings.json", "v2", merged);
          }
        }
        const final = merged ?? DEFAULT_SETTINGS;
        applyTheme(final.theme);
        set({ settings: final, loaded: true });
      })()),

    update: (key, value) => {
      const next = { ...get().settings, [key]: value };
      if (key === "theme") applyTheme(next.theme);
      commit(next);
    },

    upsertCard: (card) => {
      const s = get().settings;
      const cards = [...s.models.cards.filter((c) => c.id !== card.id), card];
      const defaults = { ...s.models.defaults };
      if (!defaults[card.role]) defaults[card.role] = card.id; // 该角色第一张卡自动设为默认
      commit({ ...s, models: { cards, defaults } });
    },

    removeCard: (id) => {
      const s = get().settings;
      const cards = s.models.cards.filter((c) => c.id !== id);
      const defaults = { ...s.models.defaults };
      for (const role of Object.keys(defaults) as ModelRole[]) {
        if (defaults[role] === id) defaults[role] = cards.find((c) => c.role === role)?.id;
      }
      commit({ ...s, models: { cards, defaults } });
    },

    setDefault: (role, id) => {
      const s = get().settings;
      commit({ ...s, models: { ...s.models, defaults: { ...s.models.defaults, [role]: id } } });
    },
  };
});

/** 解析节点应使用的模型卡片：节点指定 > 角色默认 > 该角色第一张 */
export function resolveModelCard(role: ModelRole, modelId?: string): ModelCard {
  const { cards, defaults } = useSettings.getState().settings.models;
  const card =
    (modelId ? cards.find((c) => c.id === modelId && c.role === role) : undefined) ??
    cards.find((c) => c.id === defaults[role] && c.role === role) ??
    cards.find((c) => c.role === role);
  if (!card) throw new Error(`还没有可用的${ROLE_LABEL[role]}：请到「设置 → 模型配置」添加一张配置卡`);
  return card;
}

/** 某角色的全部卡片（供节点模型选择器使用） */
export function cardsOfRole(role: ModelRole): ModelCard[] {
  return useSettings.getState().settings.models.cards.filter((c) => c.role === role);
}
