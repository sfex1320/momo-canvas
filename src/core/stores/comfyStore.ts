import { create } from "zustand";
import type { ComfyTemplate } from "../types";
import { loadJSON, saveJSON } from "../persist";
import { pingComfy } from "../services/comfy";

type ComfyState = {
  templates: ComfyTemplate[];
  online: "unknown" | "ok" | "down";
  onlineInfo: string;
  loaded: boolean;
  init: () => Promise<void>;
  upsert: (tpl: ComfyTemplate) => void;
  remove: (id: string) => void;
  test: (host: string) => Promise<boolean>;
};

let initOnce: Promise<void> | null = null;

export const useComfy = create<ComfyState>((set, get) => ({
  templates: [],
  online: "unknown",
  onlineInfo: "",
  loaded: false,

  init: () =>
    (initOnce ??= (async () => {
      const saved = await loadJSON<ComfyTemplate[]>("comfy-templates.json", "v1");
      set({ templates: saved ?? [], loaded: true });
    })()),

  upsert: (tpl) => {
    const list = get().templates.filter((t) => t.id !== tpl.id);
    const next = [tpl, ...list];
    set({ templates: next });
    void saveJSON("comfy-templates.json", "v1", next);
  },

  remove: (id) => {
    const next = get().templates.filter((t) => t.id !== id);
    set({ templates: next });
    void saveJSON("comfy-templates.json", "v1", next);
  },

  test: async (host) => {
    set({ online: "unknown", onlineInfo: "" });
    const r = await pingComfy(host);
    set({ online: r.ok ? "ok" : "down", onlineInfo: r.info ?? "" });
    return r.ok;
  },
}));
