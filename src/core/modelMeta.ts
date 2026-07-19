/**
 * 绘画模型家族元数据 — 按所选模型动态决定节点/面板出哪些参数
 *  - banana   Nano Banana 系列（Gemini 生图）：宽高比 + 1K/2K/4K，最多 14 张参考图
 *  - gpt      GPT Image 系列：任意宽x高（16 的倍数，1:3~3:1，最大 3840x2160）+ 质量四档
 *  - seedream 即梦 Seedream 系列（中转常见）：2K 级预设尺寸，组图参考最多 10 张
 *  - flux     FLUX 系列（schnell/dev/pro/kontext）：1K 级预设，尺寸 16 的倍数
 *  - qwen     千问/万相图像（qwen-image / wanx）：官方推荐分辨率预设
 *  - kolors   可图/可灵图像：1K 级预设
 *  - generic  其他 OpenAI 兼容生图：预设尺寸 + 自定义宽高
 */
import type { ModelCard } from "./types";

export type ImageFamily = "banana" | "gpt" | "seedream" | "flux" | "qwen" | "kolors" | "generic";

export function imageFamily(card: Pick<ModelCard, "protocol" | "model">): ImageFamily {
  const m = card.model.toLowerCase();
  if (card.protocol === "gemini" || m.includes("banana") || (m.includes("gemini") && m.includes("image"))) return "banana";
  if (m.includes("gpt-image") || m.includes("gpt_image") || m.includes("gptimage")) return "gpt";
  if (m.includes("seedream") || m.includes("seededit")) return "seedream";
  if (m.includes("flux")) return "flux";
  if (m.includes("qwen-image") || m.includes("qwen_image") || m.includes("wanx") || /(^|\W)wan2/.test(m)) return "qwen";
  if (m.includes("kolors") || m.includes("kling-image") || m.includes("kling_image")) return "kolors";
  return "generic";
}

export const FAMILY_LABEL: Record<ImageFamily, string> = {
  banana: "Nano Banana / Gemini",
  gpt: "GPT Image",
  seedream: "即梦 Seedream",
  flux: "FLUX",
  qwen: "千问/万相",
  kolors: "可图/可灵",
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

export type SizePreset = { ratio: string; w: number; h: number };

/** 通用生图预设尺寸 */
export const GENERIC_PRESETS: SizePreset[] = [
  { ratio: "1:1", w: 1024, h: 1024 },
  { ratio: "3:4", w: 768, h: 1024 },
  { ratio: "4:3", w: 1024, h: 768 },
  { ratio: "2:3", w: 1024, h: 1536 },
  { ratio: "3:2", w: 1536, h: 1024 },
  { ratio: "9:16", w: 1080, h: 1920 },
  { ratio: "16:9", w: 1920, h: 1080 },
];

/** 即梦 Seedream：2K 级（4.0 支持直出 2K~4K，中转按 WxH 传） */
const SEEDREAM_PRESETS: SizePreset[] = [
  { ratio: "1:1", w: 2048, h: 2048 },
  { ratio: "3:4", w: 1728, h: 2304 },
  { ratio: "4:3", w: 2304, h: 1728 },
  { ratio: "2:3", w: 1664, h: 2496 },
  { ratio: "3:2", w: 2496, h: 1664 },
  { ratio: "9:16", w: 1440, h: 2560 },
  { ratio: "16:9", w: 2560, h: 1440 },
];

/** FLUX：1K 级、16 的倍数 */
const FLUX_PRESETS: SizePreset[] = [
  { ratio: "1:1", w: 1024, h: 1024 },
  { ratio: "3:4", w: 864, h: 1152 },
  { ratio: "4:3", w: 1152, h: 864 },
  { ratio: "2:3", w: 832, h: 1216 },
  { ratio: "3:2", w: 1216, h: 832 },
  { ratio: "9:16", w: 768, h: 1344 },
  { ratio: "16:9", w: 1344, h: 768 },
];

/** 千问/万相：官方推荐档 */
const QWEN_PRESETS: SizePreset[] = [
  { ratio: "1:1", w: 1328, h: 1328 },
  { ratio: "3:4", w: 1140, h: 1472 },
  { ratio: "4:3", w: 1472, h: 1140 },
  { ratio: "2:3", w: 1056, h: 1584 },
  { ratio: "3:2", w: 1584, h: 1056 },
  { ratio: "9:16", w: 928, h: 1664 },
  { ratio: "16:9", w: 1664, h: 928 },
];

/** 该家族在面板上展示的预设尺寸组（banana/gpt 走各自专用面板，不用这个） */
export function familyPresets(f: ImageFamily): SizePreset[] {
  switch (f) {
    case "seedream":
      return SEEDREAM_PRESETS;
    case "flux":
      return FLUX_PRESETS;
    case "qwen":
      return QWEN_PRESETS;
    default:
      return GENERIC_PRESETS;
  }
}

/** 单次最多生成张数 */
export function familyMaxCount(f: ImageFamily): number {
  if (f === "gpt") return 10;
  if (f === "seedream") return 6;
  return 4;
}

/** 最多接收的上游参考图张数 */
export function familyMaxRef(f: ImageFamily): number {
  if (f === "banana") return 14;
  if (f === "gpt") return 16;
  if (f === "seedream") return 10;
  return 8;
}
