import { useEffect } from "react";
import { create } from "zustand";
import type { ComfyTemplate, ComfyVariant } from "../types";
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
  test: (host: string) => Promise<{ ok: boolean; err?: string }>;
};

/**
 * 归一化模板：无 variants 的老模板（v1）派生一个 default 分支，保留原运行行为。
 * default 分支 = 整个工作流，沿用顶层 params/outputNodeId/disabledNodes。
 * 只作用在内存，不主动回写磁盘——下次 upsert 落盘时自然带上 variants。
 */
function normalizeTemplate(t: ComfyTemplate): ComfyTemplate {
  if (Array.isArray(t.variants) && t.variants.length) return t;
  const def: ComfyVariant = {
    id: "default",
    name: "默认",
    color: "blue",
    nodeIds: Object.keys(t.workflow),
    outputNodeIds: t.outputNodeId ? [t.outputNodeId] : [],
    disabledNodes: t.disabledNodes,
    params: t.params,
    slots: [],
  };
  return { ...t, variants: [def] };
}

let initOnce: Promise<void> | null = null;

/** 落盘防抖：同步引擎/批量导入会连续 upsert 多个模板（全量 JSON 每次都重写），
 *  300ms 合并成一次保存；set 仍即时生效，UI 不会看到延迟 */
let saveTimer: number | null = null;
function scheduleSave() {
  if (saveTimer !== null) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void saveJSON("comfy-templates.json", "v1", useComfy.getState().templates);
  }, 300);
}

export const useComfy = create<ComfyState>((set, get) => ({
  templates: [],
  online: "unknown",
  onlineInfo: "",
  loaded: false,

  init: () =>
    (initOnce ??= (async () => {
      const saved = await loadJSON<ComfyTemplate[]>("comfy-templates.json", "v1");
      const list = (saved ?? []).map(normalizeTemplate);
      set({ templates: list, loaded: true });
    })()),

  upsert: (tpl) => {
    if (!get().loaded) {
      // HMR 可能重建本 store（内存列表清空、loaded=false）。未加载前禁止直接落盘：
      // 先从磁盘恢复再执行本次写操作，防止把全量模板覆盖成空表
      void get().init().then(() => get().upsert(tpl));
      return;
    }
    const list = get().templates.filter((t) => t.id !== tpl.id);
    const next = [tpl, ...list];
    set({ templates: next });
    scheduleSave();
  },

  remove: (id) => {
    if (!get().loaded) {
      // 同上：先恢复再删，防止空表覆盖磁盘
      void get().init().then(() => get().remove(id));
      return;
    }
    const next = get().templates.filter((t) => t.id !== id);
    set({ templates: next });
    scheduleSave();
  },

  test: async (host) => {
    set({ online: "unknown", onlineInfo: "" });
    const r = await pingComfy(host);
    set({ online: r.ok ? "ok" : "down", onlineInfo: r.info ?? "" });
    return { ok: r.ok, err: r.err };
  },
}));

/**
 * 订阅模板列表的自愈入口：开发期 Vite HMR 会重建本 store 模块（内存列表清空、loaded 归 false），
 * 而 App 只在启动时调一次 init——用本 hook 替代 useComfy((s) => s.templates)，
 * 发现未加载时自动从磁盘重新加载，模板列表不会再凭空消失。
 */
export function useComfyTemplates() {
  const templates = useComfy((s) => s.templates);
  const loaded = useComfy((s) => s.loaded);
  useEffect(() => {
    if (!loaded) void useComfy.getState().init();
  }, [loaded]);
  return templates;
}
