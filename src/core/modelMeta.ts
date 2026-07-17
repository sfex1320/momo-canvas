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

/** GPT Image 常用尺寸预设（宽高均为 16 的倍数），也可在面板里自定义 */
export const GPT_PRESETS: { ratio: string; tag?: string; w: number; h: number }[] = [
  { ratio: "1:1", w: 1024, h: 1024 },
  { ratio: "3:2", w: 1536, h: 1024 },
  { ratio: "2:3", w: 1024, h: 1536 },
  { ratio: "4:3", w: 1360, h: 1024 },
  { ratio: "3:4", w: 1024, h: 1360 },
  { ratio: "16:9", w: 1792, h: 1008 },
  { ratio: "9:16", w: 1008, h: 1792 },
  { ratio: "1:1", tag: "2K", w: 2048, h: 2048 },
  { ratio: "16:9", tag: "2K", w: 2560, h: 1440 },
  { ratio: "9:16", tag: "2K", w: 1440, h: 2560 },
  { ratio: "16:9", tag: "4K", w: 3840, h: 2160 },
];

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
