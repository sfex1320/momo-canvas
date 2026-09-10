/** 模型目录只证明站点声明可用，不代替真实生成验收。报价不从内部估算表冒充实时报价。 */
import type { ProviderCard } from "./types";
import { xfetch, trimBase } from "./services/http";
import { useSettings } from "./stores/settingsStore";
import { loadJSON, saveJSON } from "./persist";
import { grsaiGptRoute } from "./modelMeta";
import { isTauri } from "./utils";

export type CatalogModel = { id: string; price: string };
export type ModelRefreshResult = { id: string; name: string; models: string[]; note: string };
export const isGpt25 = (name: string) => /^gpt[-_]?image[-_]?2\.5(?:$|[-_])/i.test(name);

/** 只有带单位、币种的显式报价才展示；无单位的倍率/数字不能换算成用户费用。 */
export function catalogPrice(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "站点未返回可核实的报价";
  const p = raw as Record<string, unknown>;
  const pricing = (p.pricing ?? p.price) as Record<string, unknown> | undefined;
  if (!pricing || typeof pricing !== "object") return "站点未返回可核实的报价";
  const currency = pricing.currency;
  const unit = pricing.unit;
  if (typeof currency !== "string" || typeof unit !== "string" || currency.length > 12 || unit.length > 48) return "站点报价缺少币种或计费单位";
  const fields = [["amount", "价格"], ["input", "输入"], ["output", "输出"], ["cached_input", "缓存输入"]] as const;
  const values = fields.flatMap(([key, label]) => {
    const value = pricing[key];
    return (typeof value === "number" && Number.isFinite(value) && value >= 0) || (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) ? [`${label} ${value}`] : [];
  });
  return values.length ? `${values.join(" · ")} ${currency}/${unit}（站点目录报价，实际扣费以账单为准）` : "站点未返回可核实的报价";
}

export async function fetchProviderCatalog(p: ProviderCard): Promise<CatalogModel[]> {
  if (!/^https?:\/\//i.test(p.baseUrl)) throw Error("该服务商没有网络模型目录");
  const base = trimBase(p.baseUrl);
  const urls = [`${base}/models`, ...(base.endsWith("/v1") ? [] : [`${base}/v1/models`])];
  let error = "目录为空";
  for (const url of urls) {
    try {
      const response = await xfetch(url, { headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {} }, { timeoutMs: 15000 });
      if (!response.ok) { error = `HTTP ${response.status}`; continue; }
      const data = await response.json();
      const rows = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
      const models: CatalogModel[] = rows.flatMap((r: Record<string, unknown>) => {
        const id = r.id ?? r.name;
        return typeof id === "string" && id.length < 180 ? [{ id, price: catalogPrice(r) }] : [];
      });
      if (models.length) return models;
    } catch { error = "网络请求失败或超时"; }
  }
  throw Error(`模型目录不可用（${error}），不代表生图接口不可用`);
}

/** 只复用已经配置 GPT Image 的入口，避免把 GPT 名称塞入 Banana 专用协议。 */
export function canRefreshGpt(p: ProviderCard): boolean {
  const slot = p.models.image;
  if (!slot || !/^https?:/.test(p.baseUrl)) return false;
  if (slot.models.some(m => /^gpt[-_]?image/i.test(m))) return true;
  const probe = { ...p, role: "image" as const, model: "gpt-image-2.5", protocol: slot.protocol };
  return grsaiGptRoute(probe) !== probe;
}

export function appendImageModels(p: ProviderCard, names: string[]): ProviderCard {
  const slot = p.models.image;
  return slot ? { ...p, models: { ...p.models, image: { ...slot, models: [...new Set([...slot.models, ...names.filter(isGpt25)])] } } } : p;
}

export async function refreshGptProviders(): Promise<ModelRefreshResult[]> {
  const providers = useSettings.getState().settings.models.providers.filter(canRefreshGpt);
  const results: ModelRefreshResult[] = [];
  // 两条请求队列，避免同时给所有站点施压。
  let index = 0;
  await Promise.all([0, 1].map(async () => {
    while (index < providers.length) {
      const p = providers[index++];
      try {
        const catalog = await fetchProviderCatalog(p);
        const matches = catalog.filter(m => isGpt25(m.id));
        results.push({ id: p.id, name: p.name, models: matches.map(m => m.id), note: matches.length ? matches.map(m => `${m.id}：${m.price}`).join("\n") : "目录未列出 2.5，保留现有配置" });
      } catch (e) { results.push({ id: p.id, name: p.name, models: [], note: e instanceof Error ? e.message : "查询失败" }); }
    }
  }));
  const current = useSettings.getState().settings.models;
  useSettings.getState().update("models", { ...current, providers: current.providers.map(p => {
    const original = providers.find(o => o.id === p.id);
    const row = results.find(r => r.id === p.id);
    return row && original?.baseUrl === p.baseUrl && original.models.image?.protocol === p.models.image?.protocol ? appendImageModels(p, row.models) : p;
  }) });
  return results.sort((a, b) => providers.findIndex(p => p.id === a.id) - providers.findIndex(p => p.id === b.id));
}

type UpgradePlan = { id: string; applied?: boolean; refreshCatalog?: boolean; providers: { id: string; baseUrl: string; protocol: string; models: string[]; note?: string }[] };
/** 消费用户明确要求的一次性本机导入单；普通安装没有此文件，不会自动改模型列表。 */
export async function applyPendingModelUpgrade() {
  if (isTauri) {
    const { LazyStore } = await import("@tauri-apps/plugin-store");
    await new LazyStore("model-upgrade-plan.json", { defaults: {} }).reload();
  }
  const plan = await loadJSON<UpgradePlan>("model-upgrade-plan.json", "v1");
  if (!plan || plan.applied || !Array.isArray(plan.providers)) return;
  const current = useSettings.getState().settings.models;
  const results: string[] = [];
  const providers = current.providers.map(p => {
    const row = plan.providers.find(r => r.id === p.id && r.baseUrl === p.baseUrl && r.protocol === p.models.image?.protocol);
    if (!row || !Array.isArray(row.models) || !canRefreshGpt(p)) return p;
    results.push(`${p.name}：${row.models.filter(isGpt25).join("、")}；${row.note ?? "已导入"}`);
    return appendImageModels(p, row.models);
  });
  useSettings.getState().update("models", { ...current, providers });
  await saveJSON("model-upgrade-plan.json", "v1", { ...plan, applied: true });
  const catalog = plan.refreshCatalog ? await refreshGptProviders() : undefined;
  await saveJSON("model-upgrade-result.json", "v1", { id: plan.id, appliedAt: Date.now(), results, catalog });
}
