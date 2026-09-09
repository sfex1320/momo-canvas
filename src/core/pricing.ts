/**
 * 单价表 + 花费估算 — 按模型名前缀匹配（最长前缀优先），用户可在设置覆盖。
 * 价格是粗略估算（CNY），只为让用户对"今天烧了多少"有个量级概念，不作为计费依据。
 */
import { useSettings } from "./stores/settingsStore";
import type { UnitPrice } from "./types";

/** 内置单价（CNY）：key 是模型名前缀（小写），最长前缀优先匹配 */
export const DEFAULT_PRICING: Record<string, UnitPrice> = {
  "gpt-image": { perImage: 0.12 },
  "dall-e-3": { perImage: 0.12 },
  banana: { perImage: 0.05 },
  "gemini-image": { perImage: 0.05 },
  gemini: { perImage: 0.05, perIn1K: 0.0035, perOut1K: 0.0105 },
  seedream: { perImage: 0.06 },
  flux: { perImage: 0.03 },
  "qwen-image": { perImage: 0.04 },
  wanx: { perImage: 0.04 },
  kolors: { perImage: 0.04 },
  cogvideo: { perVideoSec: 0.3 },
  sora: { perVideoSec: 0.5 },
  kling: { perVideoSec: 0.35 },
  seedance: { perVideoSec: 0.35 },
  hunyuan: { perVideoSec: 0.3 },
  "tts-1": { perAudioSec: 0.008 },
  "gpt-4o-mini-tts": { perAudioSec: 0.012 },
  "gpt-5": { perIn1K: 0.04, perOut1K: 0.15 },
  "gpt-4o": { perIn1K: 0.018, perOut1K: 0.072 },
  "gpt-4.1": { perIn1K: 0.018, perOut1K: 0.072 },
  claude: { perIn1K: 0.024, perOut1K: 0.09 },
  "glm-4": { perIn1K: 0.0005, perOut1K: 0.0005 },
  glm: { perIn1K: 0.001, perOut1K: 0.001 },
  qwen: { perIn1K: 0.0004, perOut1K: 0.0012 },
  deepseek: { perIn1K: 0.001, perOut1K: 0.002 },
  minimax: { perIn1K: 0.001, perOut1K: 0.001 },
  kimi: { perIn1K: 0.012, perOut1K: 0.012 },
};

/** 取某模型的有效单价：用户覆盖（最长前缀）优先，否则内置表，再否则空（不计费） */
export function unitPriceFor(model: string): UnitPrice {
  const m = (model ?? "").toLowerCase();
  if (!m) return {};
  const overrides = useSettings.getState().settings.pricing.overrides;
  const pick = (table: Record<string, UnitPrice>): UnitPrice | null => {
    let bestKey = "";
    let best: UnitPrice | null = null;
    for (const [k, v] of Object.entries(table)) {
      if (m.startsWith(k.toLowerCase()) && k.length > bestKey.length) {
        bestKey = k;
        best = v;
      }
    }
    return best;
  };
  return pick(overrides) ?? pick(DEFAULT_PRICING) ?? {};
}

/** 按维度算一次调用的预估花费（CNY） */
export function estimateCost(
  model: string,
  opts: { images?: number; videoSec?: number; audioSec?: number; inTok?: number; outTok?: number },
): number {
  if (model === "codex-image") return 0; // 共享会员额度，不换算成 API 人民币余额
  const p = unitPriceFor(model);
  const c =
    (p.perImage ?? 0) * (opts.images ?? 0) +
    (p.perVideoSec ?? 0) * (opts.videoSec ?? 0) +
    (p.perAudioSec ?? 0) * (opts.audioSec ?? 0) +
    (p.perIn1K ?? 0) * ((opts.inTok ?? 0) / 1000) +
    (p.perOut1K ?? 0) * ((opts.outTok ?? 0) / 1000);
  return Math.round(c * 10000) / 10000;
}
