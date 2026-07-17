/**
 * 联网搜索服务 — 三种可选提供商适配
 *  - Tavily   https://api.tavily.com/search
 *  - 博查Bocha https://api.bochaai.com/v1/web-search
 *  - SearXNG  自建实例 /search?format=json
 */
import type { SearchCfg, SearchHit } from "../types";
import { xfetch, trimBase, readErrorBody } from "./http";

export async function webSearch(cfg: SearchCfg, query: string): Promise<SearchHit[]> {
  const n = cfg.maxResults || 5;
  switch (cfg.provider) {
    case "tavily": {
      if (!cfg.apiKey) throw new Error("请在「设置 → 联网搜索」填写 Tavily API Key");
      const resp = await xfetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: cfg.apiKey, query, max_results: n }),
      });
      if (!resp.ok) throw new Error(`Tavily 搜索失败 ${resp.status}: ${await readErrorBody(resp)}`);
      const j = await resp.json();
      return (j.results ?? []).map((r: any) => ({
        title: r.title ?? r.url,
        url: r.url,
        snippet: (r.content ?? "").slice(0, 300),
      }));
    }
    case "bocha": {
      if (!cfg.apiKey) throw new Error("请在「设置 → 联网搜索」填写博查 API Key");
      const resp = await xfetch("https://api.bochaai.com/v1/web-search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({ query, count: n, summary: true }),
      });
      if (!resp.ok) throw new Error(`博查搜索失败 ${resp.status}: ${await readErrorBody(resp)}`);
      const j = await resp.json();
      const items = j.data?.webPages?.value ?? [];
      return items.map((r: any) => ({
        title: r.name ?? r.url,
        url: r.url,
        snippet: (r.summary ?? r.snippet ?? "").slice(0, 300),
      }));
    }
    case "searxng": {
      if (!cfg.baseUrl) throw new Error("请在「设置 → 联网搜索」填写 SearXNG 实例地址");
      const u = `${trimBase(cfg.baseUrl)}/search?q=${encodeURIComponent(query)}&format=json`;
      const resp = await xfetch(u);
      if (!resp.ok) throw new Error(`SearXNG 搜索失败 ${resp.status}`);
      const j = await resp.json();
      return (j.results ?? []).slice(0, n).map((r: any) => ({
        title: r.title ?? r.url,
        url: r.url,
        snippet: (r.content ?? "").slice(0, 300),
      }));
    }
  }
}

/** 把搜索结果拼成可注入对话的上下文块 */
export function searchContext(hits: SearchHit[]): string {
  if (!hits.length) return "";
  const lines = hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.url}\n${h.snippet}`);
  return `以下是与用户问题相关的实时网络搜索结果，请结合它们回答，并在引用处标注 [序号]：\n\n${lines.join("\n\n")}`;
}
