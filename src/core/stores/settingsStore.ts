import { create } from "zustand";
import { DEFAULT_SETTINGS, type Settings } from "../types";
import { loadJSON, saveJSON } from "../persist";

type SettingsState = {
  settings: Settings;
  loaded: boolean;
  init: () => Promise<void>;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
};

function applyTheme(theme: Settings["theme"]) {
  document.documentElement.setAttribute("data-theme", theme);
}

let initOnce: Promise<void> | null = null;

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,

  init: () =>
    (initOnce ??= (async () => {
    const saved = await loadJSON<Partial<Settings>>("settings.json", "v1");
    const merged: Settings = { ...DEFAULT_SETTINGS };
    if (saved) {
      for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
        const v = saved[k];
        if (v === undefined) continue;
        (merged as Record<string, unknown>)[k] =
          typeof v === "object" && v !== null ? { ...(DEFAULT_SETTINGS[k] as object), ...v } : v;
      }
    }
    applyTheme(merged.theme);
    set({ settings: merged, loaded: true });
    })()),

  update: (key, value) => {
    const next = { ...get().settings, [key]: value };
    set({ settings: next });
    if (key === "theme") applyTheme(next.theme);
    void saveJSON("settings.json", "v1", next);
  },
}));
