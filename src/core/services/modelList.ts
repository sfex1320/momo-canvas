/**
 * 拉取服务商可用模型列表 — 按协议适配
 *  - openai / zhipu / siliconflow  GET {base}/models（OpenAI 兼容）
 *  - anthropic                     GET {base}/v1/models
 *  - gemini                        GET {base}/v1beta/models?key=…
 */
import type { AnyProtocol } from "../types";
import { xfetch, trimBase, readErrorBody } from "./http";

export async function fetchModelList(protocol: AnyProtocol, baseUrl: string, apiKey: string): Promise<string[]> {
  let ids: string[] = [];

  if (protocol === "gemini") {
    const base = trimBase(baseUrl || "https://generativelanguage.googleapis.com");
    const root = base.includes("/v1beta") ? base : `${base}/v1beta`;
    const resp = await xfetch(`${root}/models?key=${encodeURIComponent(apiKey)}&pageSize=200`);
    if (!resp.ok) throw new Error(`拉取模型列表失败 ${resp.status}: ${await readErrorBody(resp)}`);
    const j = await resp.json();
    ids = (j.models ?? []).map((m: { name?: string }) => (m.name ?? "").replace(/^models\//, ""));
  } else if (protocol === "anthropic") {
    if (!baseUrl) throw new Error("请先填写 Base URL");
    const base = trimBase(baseUrl);
    const url = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
    const resp = await xfetch(`${url}?limit=200`, {
      headers: { "anthropic-version": "2023-06-01", ...(apiKey ? { "x-api-key": apiKey, Authorization: `Bearer ${apiKey}` } : {}) },
    });
    if (!resp.ok) throw new Error(`拉取模型列表失败 ${resp.status}: ${await readErrorBody(resp)}`);
    const j = await resp.json();
    ids = (j.data ?? []).map((m: { id?: string }) => m.id ?? "");
  } else {
    // OpenAI 兼容（openai / zhipu / siliconflow 与各类中转站）
    if (!baseUrl) throw new Error("请先填写 Base URL");
    const resp = await xfetch(`${trimBase(baseUrl)}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!resp.ok) throw new Error(`拉取模型列表失败 ${resp.status}: ${await readErrorBody(resp)}`);
    const j = await resp.json();
    const arr = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
    ids = arr.map((m: { id?: string; name?: string }) => m.id ?? m.name ?? "");
  }

  const uniq = [...new Set(ids.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (!uniq.length) throw new Error("服务商没有返回任何模型（该中转站可能未开放 /models 接口）");
  return uniq;
}
