/**
 * 统一 fetch：Tauri 环境走 plugin-http（绕过 webview CORS），
 * 浏览器预览退回原生 fetch。
 */
import { isTauri } from "../utils";

let tauriFetch: typeof fetch | null = null;

export async function xfetch(input: string | URL, init?: RequestInit): Promise<Response> {
  if (isTauri) {
    if (!tauriFetch) {
      const mod = await import("@tauri-apps/plugin-http");
      tauriFetch = mod.fetch as unknown as typeof fetch;
    }
    return tauriFetch(input as string, init);
  }
  return fetch(input, init);
}

/** 去尾斜杠 */
export function trimBase(url: string) {
  return url.replace(/\/+$/, "");
}

export async function readErrorBody(resp: Response): Promise<string> {
  try {
    const t = await resp.text();
    return t.slice(0, 400);
  } catch {
    return "";
  }
}
