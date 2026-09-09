/**
 * 模型能力档案（导演台 3.3 · 方案 §4.3）
 *
 * 时长/画幅/分辨率/素材边界是「模型能力」，不是 Skill 文案里的数字（§2.7）：
 * Skill 只表达「遵守能力档案」，数字统一从这里的档案读取。
 * 官方协议未贯通的家族标 officialAdapter: false——UI 标注「仅声明」，
 * 防止用户以为填模型名就等于官方 API 已接入（§2.4）。
 * 能力来源优先级（§4.3）：模板真实节点分析 > 官方适配器内置档案 > 用户覆盖 > 保守兜底；
 * 本文件是「内置档案」层，模板级覆盖由配方的 capabilitySnapshot 承担。
 */
import type { DirectorRecipe } from "../types";

/** 3.3 §4.3：模型能力档案——时长/画幅/分辨率/素材边界是「能力」不是文案 */
export type VideoCapabilityProfile = {
  family: "h3" | "ltx" | "seedance" | "wan" | "gemini-omni" | "veo" | "generic";
  channel: "local" | "remote";
  /** 官方协议适配器：true 已贯通；false 通用协议壳（UI 标注防误解，3.3 §2.4） */
  officialAdapter: boolean;
  /** 适配器代码已实现、尚待真实 Key 联调（3.3 P2 中间态标注） */
  adapterReady?: boolean;
  modes: DirectorRecipe["mode"][];
  inputs: {
    firstFrame: boolean;
    lastFrame: boolean;
    referenceImages: number;
    referenceVideos: number;
    referenceAudios: number;
    sourceVideo: boolean;
  };
  output: { nativeAudio: boolean; returnsLastFrame: boolean };
  duration: { min: number; max: number; step?: number };
  resolutions: string[];
  promptDialect: string;
};

/** 内置能力档案表（接入新家族 = 加一行 + 官方适配器，不改导演项目结构，§12.2） */
export const VIDEO_PROFILES: Record<VideoCapabilityProfile["family"], VideoCapabilityProfile> = {
  h3: {
    family: "h3",
    channel: "local",
    officialAdapter: true, // 本地 ComfyUI 通道已贯通（图/视/音槽、首尾帧、原生音频、微参考）
    modes: ["t2v", "i2v", "fl2v", "l2v", "r2v"],
    inputs: { firstFrame: true, lastFrame: true, referenceImages: 4, referenceVideos: 3, referenceAudios: 3, sourceVideo: true },
    output: { nativeAudio: true, returnsLastFrame: true },
    duration: { min: 2, max: 15 }, // MiniMax 官方当前上限 15 秒（Skill 文案里的 18s 是旧值，以此为准）
    resolutions: ["1K", "2K"],
    promptDialect: "h3",
  },
  ltx: {
    family: "ltx",
    channel: "local",
    officialAdapter: true, // 经 ComfyUI 模板接入（真实模板分析后才有参数面板，§10 P3）
    modes: ["t2v", "i2v", "audio2v", "extend", "v2v"],
    inputs: { firstFrame: true, lastFrame: false, referenceImages: 1, referenceVideos: 1, referenceAudios: 1, sourceVideo: true },
    output: { nativeAudio: true, returnsLastFrame: false },
    duration: { min: 2, max: 10 }, // 由模板帧数/显存决定；未导入真实模板前保守兜底
    resolutions: ["720p", "1080p"],
    promptDialect: "ltx",
  },
  seedance: {
    family: "seedance",
    channel: "remote",
    officialAdapter: false,
    adapterReady: true, // volcArkSeedanceAdapter 已实现（ark 协议），待 Key 联调
    modes: ["t2v", "i2v", "r2v"],
    inputs: { firstFrame: true, lastFrame: true, referenceImages: 3, referenceVideos: 1, referenceAudios: 1, sourceVideo: false },
    output: { nativeAudio: true, returnsLastFrame: true },
    duration: { min: 4, max: 15, step: 1 }, // 官方 API 整数 4–15 秒
    resolutions: ["720p", "1080p"],
    promptDialect: "seedance",
  },
  wan: {
    family: "wan",
    channel: "remote",
    officialAdapter: false,
    adapterReady: true, // dashscopeWanAdapter 已实现（dashscope 协议），待 Key 联调
    modes: ["t2v", "i2v", "fl2v", "extend", "audio2v"],
    inputs: { firstFrame: true, lastFrame: true, referenceImages: 1, referenceVideos: 1, referenceAudios: 1, sourceVideo: true },
    output: { nativeAudio: true, returnsLastFrame: false },
    duration: { min: 2, max: 15, step: 1 },
    resolutions: ["720p", "1080p"],
    promptDialect: "wan",
  },
  "gemini-omni": {
    family: "gemini-omni",
    channel: "remote",
    officialAdapter: false,
    adapterReady: true, // googleVideoAdapter 已实现（google 协议），待 Key 联调
    modes: ["t2v", "edit"],
    inputs: { firstFrame: false, lastFrame: false, referenceImages: 3, referenceVideos: 1, referenceAudios: 0, sourceVideo: true },
    output: { nativeAudio: true, returnsLastFrame: false },
    duration: { min: 4, max: 8 },
    resolutions: ["720p", "1080p"],
    promptDialect: "gemini",
  },
  veo: {
    family: "veo",
    channel: "remote",
    officialAdapter: false,
    adapterReady: true,
    modes: ["t2v", "i2v", "extend"],
    inputs: { firstFrame: true, lastFrame: true, referenceImages: 3, referenceVideos: 1, referenceAudios: 0, sourceVideo: true },
    output: { nativeAudio: true, returnsLastFrame: true },
    duration: { min: 4, max: 8 },
    resolutions: ["720p", "1080p"],
    promptDialect: "veo",
  },
  generic: {
    family: "generic",
    channel: "remote",
    officialAdapter: true, // 通用 OpenAI 兼容/SiliconFlow/智谱/自定义协议通道本身已贯通
    modes: ["t2v", "i2v"],
    inputs: { firstFrame: true, lastFrame: false, referenceImages: 3, referenceVideos: 0, referenceAudios: 0, sourceVideo: false },
    output: { nativeAudio: false, returnsLastFrame: false },
    duration: { min: 2, max: 12 },
    resolutions: ["720p", "1080p"],
    promptDialect: "generic",
  },
};

/** 从模型/模板/配方名推断家族（只做「推荐」，不再是最终真相，§4.3） */
export function familyOfName(name: string): VideoCapabilityProfile["family"] {
  const n = name.toLowerCase();
  if (/h3|t2va|i2va|fl2va|l2va|ref2va|minimax/.test(n)) return "h3";
  if (/ltx/.test(n)) return "ltx";
  if (/seedance/.test(n)) return "seedance";
  if (/\bwan\b/.test(n)) return "wan";
  if (/omni/.test(n)) return "gemini-omni";
  if (/veo/.test(n)) return "veo";
  return "generic";
}

/** 配方的能力档案：家族名推荐 → 配方快照覆盖 → 内置档案兜底 */
export function profileForRecipe(
  recipe: Pick<DirectorRecipe, "name" | "engine" | "mode" | "capabilitySnapshot"> | undefined,
  templateName?: string,
): VideoCapabilityProfile {
  const base = VIDEO_PROFILES[familyOfName(`${recipe?.name ?? ""} ${templateName ?? ""}`)];
  if (!recipe?.capabilitySnapshot) return base;
  // 配方快照覆盖（模板真实分析的结果优先于内置档案）
  const s = recipe.capabilitySnapshot;
  return {
    ...base,
    modes: recipe.mode ? [recipe.mode] : base.modes,
    inputs: {
      ...base.inputs,
      firstFrame: s.firstFrame ?? base.inputs.firstFrame,
      lastFrame: s.lastFrame ?? base.inputs.lastFrame,
      referenceImages: s.referenceImages ?? base.inputs.referenceImages,
      referenceVideos: s.referenceVideos ?? base.inputs.referenceVideos,
      referenceAudios: s.referenceAudio ?? base.inputs.referenceAudios,
    },
    output: { ...base.output, nativeAudio: s.nativeAudio ?? base.output.nativeAudio },
  };
}

/** 时长按档案钳制（step 取整）；返回钳制后的值与是否被改动 */
export function clampDuration(profile: VideoCapabilityProfile, sec: number): { sec: number; clamped: boolean; note?: string } {
  const { min, max, step } = profile.duration;
  let v = sec;
  if (step) v = Math.round(v / step) * step;
  v = Math.min(max, Math.max(min, v));
  const clamped = Math.abs(v - sec) > 0.01;
  return {
    sec: v,
    clamped,
    note: clamped ? `已按 ${profile.family.toUpperCase()} 能力档案钳制为 ${v}s（允许 ${min}–${max}${step ? `，步进 ${step}` : ""}）` : undefined,
  };
}

/** 配方下拉的能力摘要（§9.1：本地/远程 · 模式 · 最大时长 · 音画同出） */
export function recipeCapabilityNote(recipe: DirectorRecipe, templateName?: string): string {
  const p = profileForRecipe(recipe, templateName);
  const parts = [
    p.channel === "local" ? "本地" : "远程",
    MODE_LABEL[recipe.mode] ?? recipe.mode,
    `≤${p.duration.max}s`,
    p.output.nativeAudio ? "音画同出" : "无原生音频",
  ];
  if (p.channel === "remote" && !p.officialAdapter) parts.push(p.adapterReady ? "官方适配器已实现·待 Key 联调" : "通用协议（官方适配未接入）");
  return parts.join(" · ");
}

export const MODE_LABEL: Record<DirectorRecipe["mode"], string> = {
  t2i: "文生图",
  i2i: "图生图",
  t2v: "文生视频",
  i2v: "首帧生视频",
  fl2v: "首尾帧",
  l2v: "仅尾帧反推",
  r2v: "多参考",
  audio2v: "音频驱动",
  extend: "视频延展",
  v2v: "视频重绘",
  edit: "视频编辑",
};
