/**
 * 绘画模型家族元数据 — 按所选模型动态决定节点/面板出哪些参数
 *  - banana   Nano Banana 系列（Gemini 生图：nano-banana / 2 / 2 Lite / Pro）
 *             宽高比 + 1K/2K/4K 分辨率，最多 14 张参考图
 *  - gpt      GPT Image 系列（gpt-image-1 / 2）
 *             任意宽x高（16 的倍数，比例 1:3~3:1，最大 3840x2160）+ 质量四档，最多 16 张参考图
 *  - generic  其他 OpenAI 兼容生图（seedream 等中转模型）：预设尺寸 + 自定义宽高
 */
import type { ModelCard } from "./types";

export type ImageFamily = "banana" | "gpt" | "generic";

export function imageFamily(card: Pick<ModelCard, "protocol" | "model">): ImageFamily {
  const m = card.model.toLowerCase();
  if (card.protocol === "gemini" || m.includes("banana") || (m.includes("gemini") && m.includes("image"))) return "banana";
  if (m.includes("gpt-image") || m.includes("gpt_image") || m.includes("gptimage")) return "gpt";
  return "generic";
}

export const FAMILY_LABEL: Record<ImageFamily, string> = {
  banana: "Nano Banana / Gemini",
  gpt: "GPT Image",
  generic: "通用生图",
};

/** Nano Banana 宽高比档位（imageConfig.aspectRatio） */
export const BANANA_ASPECTS = ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "21:9"];
/** Nano Banana 分辨率档位（imageConfig.imageSize） */
export const BANANA_SIZES = ["1K", "2K", "4K"];

export const GPT_QUALITIES: { value: string; label: string }[] = [
  { value: "auto", label: "自动" },
  { value: "high", label: "高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" },
];

/** GPT Image 常用宽高比（比例限制 1:3 ~ 3:1），配合分辨率档位换算实际宽高 */
export const GPT_RATIOS = ["1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "21:9", "2:1", "1:2"];
/** GPT Image 分辨率档位（按像素总量：1K ≈ 1MP · 2K ≈ 4MP · 4K ≈ 8MP） */
export const GPT_TIERS = ["1K", "2K", "4K"];
const TIER_AREA: Record<string, number> = {
  "1K": 1024 * 1024,
  "2K": 2048 * 2048,
  "4K": 3840 * 2160,
};

/** 解析 "16:9" / "16x9" / "1.85:1" 之类的比例串，返回 w/h 数值比（非法返回 null） */
export function parseRatio(ratio: string): number | null {
  const m = ratio.trim().match(/^(\d+(?:\.\d+)?)\s*[:：xX×/]\s*(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const rw = parseFloat(m[1]);
  const rh = parseFloat(m[2]);
  if (!rw || !rh) return null;
  return rw / rh;
}

/** 比例 + 分辨率档 → 实际宽高（16 的倍数，长边不超过 3840；比例超出 1:3~3:1 返回 null） */
export function gptSize(ratio: string, tier: string): { w: number; h: number } | null {
  const r = parseRatio(ratio);
  if (!r || r < 1 / 3 - 1e-6 || r > 3 + 1e-6) return null;
  const area = TIER_AREA[tier] ?? TIER_AREA["1K"];
  let h = Math.sqrt(area / r);
  let w = h * r;
  const cap = 3840;
  if (w > cap) {
    w = cap;
    h = w / r;
  }
  if (h > cap) {
    h = cap;
    w = h * r;
  }
  const to16 = (v: number) => Math.max(256, Math.round(v / 16) * 16);
  return { w: to16(w), h: to16(h) };
}

/** 给定 w/h 数值比，返回列表中最接近的比例档（默认 Banana 档位，跳过 auto） */
export function nearestAspect(r: number, list: string[] = BANANA_ASPECTS): string {
  let best = "1:1";
  let bestDiff = Infinity;
  for (const a of list) {
    const v = parseRatio(a);
    if (!v) continue;
    // 用对数距离，避免 16:9 与 9:16 之间不对称
    const diff = Math.abs(Math.log(v) - Math.log(r));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = a;
    }
  }
  return best;
}

/** 通用生图预设尺寸 */
export const GENERIC_PRESETS: { ratio: string; w: number; h: number }[] = [
  { ratio: "1:1", w: 1024, h: 1024 },
  { ratio: "3:4", w: 768, h: 1024 },
  { ratio: "4:3", w: 1024, h: 768 },
  { ratio: "2:3", w: 1024, h: 1536 },
  { ratio: "3:2", w: 1536, h: 1024 },
  { ratio: "9:16", w: 1080, h: 1920 },
  { ratio: "16:9", w: 1920, h: 1080 },
];

/** 单次最多生成张数 */
export function familyMaxCount(f: ImageFamily): number {
  return f === "gpt" ? 10 : 4;
}

/** 最多接收的上游参考图张数 */
export function familyMaxRef(f: ImageFamily): number {
  return f === "banana" ? 14 : f === "gpt" ? 16 : 8;
}
