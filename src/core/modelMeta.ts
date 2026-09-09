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

/** 各家族允许的最长边（放大清晰度档时的硬上限，超了服务端会 400 或静默缩回） */
const FAMILY_EDGE_CAP: Record<ImageFamily, number> = {
  banana: 4096,
  gpt: 3840,
  seedream: 4096, // Seedream 4.0 直出 4K
  flux: 2048,
  qwen: 1664, // 万相官方推荐档上限
  kolors: 2048,
  generic: 4096,
};

/**
 * 家族预设尺寸 × 清晰度档 → 实际宽高。
 * 以前非 banana/gpt 家族拿到 resolution 直接丢掉（创作助手明说 4K 也只出 1K），
 * 这里按像素面积把预设放大到目标档，同时守住各家族的最长边上限。
 */
export function scalePresetToTier(p: SizePreset, tier: string | undefined, f: ImageFamily): { w: number; h: number } {
  const target = TIER_AREA[tier ?? "1K"];
  const area = p.w * p.h;
  // 只放大不缩小：seedream 预设本来就是 2K 级，选 1K/2K 时保持官方推荐值
  if (!target || target <= area) return { w: p.w, h: p.h };
  let k = Math.sqrt(target / area);
  const cap = FAMILY_EDGE_CAP[f];
  const long = Math.max(p.w, p.h) * k;
  if (long > cap) k = cap / Math.max(p.w, p.h);
  const to16 = (v: number) => Math.max(256, Math.round(v / 16) * 16);
  return { w: to16(p.w * k), h: to16(p.h * k) };
}

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

/* ================= 对话模型能力（视觉输入 / 自带联网搜索） ================= */
export type ChatCaps = {
  /** 支持图片输入（多模态） */
  vision: boolean;
  /** 模型自带联网搜索（请求里带 tools 即可，无需外部搜索接口） */
  builtinSearch: boolean;
  /** 能力依据说明（UI 提示用） */
  note?: string;
};

/** 按模型名/协议推断对话模型能力——名字会不断出新，规则按家族特征匹配，宁可漏判不误判 */
export function chatCaps(card: Pick<ModelCard, "id" | "protocol" | "model">): ChatCaps {
  // 本地 GGUF 模型：能力来自注册表（capabilities.vision 由 mmproj 是否存在决定），不靠名字猜
  if (card.protocol === "llamacpp" || (card.id && card.id.startsWith("local-gguf"))) {
    // 动态查 localGgufStore（避免顶层 import 造成循环依赖）
    const localModel = lookupLocalGguf(card.model);
    if (localModel) {
      return {
        vision: localModel.capabilities.vision,
        builtinSearch: false, // 本地模型不联网
        note: localModel.capabilities.vision ? "本地视觉模型" : "本地文本模型",
      };
    }
    // 注册表里找不到（可能尚未 init）：按非视觉处理，不误判
    return { vision: false, builtinSearch: false, note: "本地模型" };
  }
  const m = card.model.toLowerCase();
  // 协议本身不等于视觉能力（Anthropic 兼容端点也可能承载纯文本模型）。
  // MiniMax Anthropic 官方：M3 支持图/视频，M2.x 仅文本与工具块，因此只能精确放行 M3。
  const vision =
    card.protocol === "gemini" ||
    /(claude|gemini)/.test(m) ||
    // 明确带视觉的系列 / 视觉后缀（vl、-v、vision、omni）；纯推理模型（o1/o3）不算。
    /(gpt-4o|gpt-4\.1|gpt-4v|gpt-5|kimi|moonshot|minimax[-_ ]?m3|glm-4\.\dv|glm-4v|glm-5|qwen.*(vl|omni)|doubao.*(vision|seed-1|1\.5-vision)|step-1o|step-1v|hunyuan-vision|internvl|minicpm-v|llava|deepseek-vl|pixtral|llama.*vision|grok.*vision)/.test(
      m,
    );
  // 「自带联网」以能否真的构造出该协议下的 tools 请求体为准，判定与发送不再各说各话：
  // anthropic 协议走服务端 web_search 工具形态；gemini/ollama 没有对应形态，不注入
  const builtinSearch =
    card.protocol === "anthropic"
      ? !!anthropicWebSearchTools(card.model)
      : card.protocol !== "gemini" && card.protocol !== "ollama" && !!builtinSearchTools(card.model);
  const notes: string[] = [];
  if (vision) notes.push("视觉");
  if (builtinSearch) {
    if (/glm/.test(m)) notes.push("GLM 自带联网");
    else if (/hunyuan/.test(m)) notes.push("混元自带联网");
    else notes.push("自带联网");
  }
  return { vision, builtinSearch, note: notes.join(" · ") || undefined };
}

/**
 * OpenAI 兼容协议下，各家族「自带联网」的 tools 请求体（中转站不支持时由调用方降级）。
 * 只收录「一次请求内就能出结果」的形态；Kimi/Moonshot 的 $web_search 属于 builtin_function，
 * 需要客户端把 tool_calls 原样回传再续一轮，本项目的流式实现不做工具回传，
 * 因此不在这里登记（Kimi 走内置搜索接口，效果一致且不会中途失败）。
 */
export function builtinSearchTools(model: string): unknown[] | undefined {
  const m = model.toLowerCase();
  if (m.includes("glm")) return [{ type: "web_search", web_search: { enable: true, search_result: true } }];
  if (m.includes("hunyuan")) return [{ type: "web_search", web_search: { enable: true } }];
  return undefined;
}

/**
 * Anthropic 协议（/v1/messages）下「自带联网」的工具形态：服务端 web_search 工具。
 * MiniMax Anthropic 端点支持普通工具调用，但官方当前把 Web Search 作为外部 MCP 能力，
 * mcp_servers 参数也明确为 ignored；不能冒充 Anthropic 服务端 web_search，否则会泄漏原始 tool_call 文本。
 * GLM 的 Anthropic 兼容端点支持服务端 web_search，沿用 Anthropic 官方版本化类型。
 */
export function anthropicWebSearchTools(model: string): unknown[] | undefined {
  const m = model.toLowerCase();
  if (m.includes("glm")) {
    return [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }];
  }
  return undefined;
}

/**
 * 查 localGgufStore，按模型名找本地 GGUF 注册项。
 *
 * 直接同步 import（实际无循环依赖：localGgufStore 不 import modelMeta）。
 * 之前用动态 import 是过度保守，会导致首次调用返回 undefined，让本地视觉模型在启动竞态窗口
 * 内被误判为非视觉并抛错阻断生成。
 */
import { useLocalGguf } from "./stores/localGgufStore";

function lookupLocalGguf(name: string): { capabilities: { vision: boolean } } | undefined {
  return useLocalGguf.getState().getByName(name);
}
