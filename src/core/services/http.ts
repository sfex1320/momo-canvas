/**
 * 统一 fetch：Tauri 环境走 plugin-http（绕过 webview CORS），
 * 浏览器预览退回原生 fetch。
 *
 * 本机/局域网地址在 Tauri 下强制直连：开着 Clash 等系统代理时，Rust 侧 reqwest
 * 默认会把请求交给系统代理，代理节点上并没有你的 127.0.0.1:8188，于是回 502。
 * 浏览器对 localhost 是硬编码绕过代理的，这里给 plugin-http 补上同样的行为——
 * 挂一个"永不命中"的显式代理并把目标主机放进 noProxy：reqwest 见到显式代理就
 * 禁用系统代理，noProxy 又命中目标主机，实际效果 = 直连。
 */
import { isTauri } from "../utils";

let tauriFetch: typeof fetch | null = null;

/** 本机/局域网主机 → 返回主机名（作 noProxy 用）；公网主机 → null（照常走系统代理） */
function privateHost(input: string | URL): string | null {
  try {
    const host = new URL(String(input)).hostname.replace(/^\[|\]$/g, "");
    if (host.includes(":")) return host === "::1" || /^(fe80:|f[cd])/i.test(host) ? host : null; // IPv6 只认环回/链路本地/ULA
    if (host === "localhost" || host.endsWith(".local") || !host.includes(".")) return host; // 单段主机名 = 内网机器名
    if (/^(127|10|0)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return host;
    const m = host.match(/^172\.(\d+)\./);
    if (m && +m[1] >= 16 && +m[1] <= 31) return host;
    return null;
  } catch {
    return null;
  }
}

export async function xfetch(input: string | URL, init?: RequestInit): Promise<Response> {
  if (isTauri) {
    if (!tauriFetch) {
      const mod = await import("@tauri-apps/plugin-http");
      tauriFetch = mod.fetch as unknown as typeof fetch;
    }
    const host = privateHost(input);
    if (host) {
      // ① 摘掉 Origin：ComfyUI 等本地服务默认开 DNS-rebinding 防护，见到与 Host 不一致的
      //    Origin 直接 403；插件会强塞 webview 的 Origin，传空串是官方留的"显式移除"口子
      //    （需 Cargo.toml 里给 tauri-plugin-http 开 unsafe-headers 特性）。
      // ② 显式代理 + noProxy 命中目标 = 强制直连，防止系统/环境变量代理截胡本机地址。
      const headers = new Headers(init?.headers);
      headers.set("Origin", "");
      const bypass = { proxy: { all: { url: "http://127.0.0.1:1", noProxy: host } } };
      return tauriFetch(input as string, { ...init, headers, ...bypass } as RequestInit);
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
