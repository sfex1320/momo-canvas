/**
 * 轻量持久化适配层：
 * - Tauri 环境 → tauri-plugin-store（JSON 文件存 AppData）
 * - 纯浏览器预览 → localStorage 兜底
 */
import { isTauri } from "./utils";

type LazyStoreT = import("@tauri-apps/plugin-store").LazyStore;

const stores = new Map<string, LazyStoreT>();

async function getStore(file: string): Promise<LazyStoreT> {
  let s = stores.get(file);
  if (!s) {
    const { LazyStore } = await import("@tauri-apps/plugin-store");
    s = new LazyStore(file, { autoSave: false, defaults: {} });
    stores.set(file, s);
  }
  return s;
}

export async function loadJSON<T>(file: string, key: string): Promise<T | null> {
  try {
    if (isTauri) {
      const s = await getStore(file);
      const v = await s.get<T>(key);
      return (v as T) ?? null;
    }
    const raw = localStorage.getItem(`momo:${file}:${key}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (e) {
    console.warn("[persist] load failed", file, key, e);
    return null;
  }
}

export async function saveJSON(file: string, key: string, value: unknown): Promise<void> {
  try {
    if (isTauri) {
      const s = await getStore(file);
      await s.set(key, value);
      await s.save();
      return;
    }
    localStorage.setItem(`momo:${file}:${key}`, JSON.stringify(value));
  } catch (e) {
    console.warn("[persist] save failed", file, key, e);
  }
}
