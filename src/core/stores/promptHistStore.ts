/**
 * 提示词历史/收藏：生成成功时自动记录用过的提示词；可收藏置顶、搜索、一键回填。
 *  普通历史保留最近 200 条（重复文本只提升时间），收藏的不淘汰。
 */
import { create } from "zustand";
import { loadJSON, saveJSON } from "../persist";
import { uid } from "../utils";

export type PromptHistItem = {
  id: string;
  text: string;
  ts: number;
  pin: boolean;
};

const KEEP = 200;

type PromptHistState = {
  items: PromptHistItem[];
  loaded: boolean;
  init: () => Promise<void>;
  /** 记录一次使用（重复文本提升时间不重复入库） */
  record: (text: string) => void;
  togglePin: (id: string) => void;
  remove: (id: string) => void;
  clear: () => void;
};

let initOnce: Promise<void> | null = null;
const save = (items: PromptHistItem[]) => void saveJSON("prompt-history.json", "v1", items);

export const usePromptHist = create<PromptHistState>((set, get) => ({
  items: [],
  loaded: false,

  init: () =>
    (initOnce ??= (async () => {
      const saved = await loadJSON<PromptHistItem[]>("prompt-history.json", "v1");
      set({ items: saved ?? [], loaded: true });
    })()),

  record: (text) => {
    const t = text.trim();
    if (!t || t.length < 4) return;
    const items = get().items;
    const hit = items.find((i) => i.text === t);
    let next: PromptHistItem[];
    if (hit) {
      next = [{ ...hit, ts: Date.now() }, ...items.filter((i) => i.id !== hit.id)];
    } else {
      next = [{ id: uid(8), text: t, ts: Date.now(), pin: false }, ...items];
      const plain = next.filter((i) => !i.pin);
      if (plain.length > KEEP) {
        const drop = new Set(plain.slice(KEEP).map((i) => i.id));
        next = next.filter((i) => !drop.has(i.id));
      }
    }
    set({ items: next });
    save(next);
  },

  togglePin: (id) => {
    const next = get().items.map((i) => (i.id === id ? { ...i, pin: !i.pin } : i));
    set({ items: next });
    save(next);
  },

  remove: (id) => {
    const next = get().items.filter((i) => i.id !== id);
    set({ items: next });
    save(next);
  },

  clear: () => {
    const next = get().items.filter((i) => i.pin);
    set({ items: next });
    save(next);
  },
}));
