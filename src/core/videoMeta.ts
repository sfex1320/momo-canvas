/**
 * 视频模型家族元数据 — 按所选模型动态决定视频节点/面板出哪些参数
 *  各家 API 的时长/分辨率格式完全不同（Sora "4"+尺寸、Veo 数字+720p 档、Luma "5s"、
 *  可灵 5/10+档位…），这里统一成 UI 枚举，由服务层按协议翻译成对应字段。
 *  数据来源：官方 API 文档 + 主流中转站文档（2026-07 核实，Sora/Veo/Luma 逐字段核对）。
 */
import type { ModelCard } from "./types";

export type VideoFamily =
  | "sora"
  | "veo"
  | "luma"
  | "kling"
  | "seedance"
  | "wan"
  | "vidu"
  | "hailuo"
  | "cogvideo"
  | "pixverse"
  | "generic";

export function videoFamily(card: Pick<ModelCard, "model">): VideoFamily {
  const m = card.model.toLowerCase();
  if (/sora/.test(m)) return "sora";
  if (/veo/.test(m)) return "veo";
  if (/luma|ray[-_.]?\d|dream[-_]?machine/.test(m)) return "luma";
  if (/kling|keling/.test(m)) return "kling";
  if (/seedance|doubao[-_]?seed/.test(m)) return "seedance";
  if (/wan[-_.]?\d|wanx/.test(m)) return "wan";
  if (/vidu/.test(m)) return "vidu";
  if (/hailuo|minimax|(^|\W)[ti]2v-01/.test(m)) return "hailuo";
  if (/cogvideo/.test(m)) return "cogvideo";
  if (/pixverse/.test(m)) return "pixverse";
  return "generic";
}

export type VideoFamilyMeta = {
  label: string;
  /** 时长档（值 = 秒数字符串，服务层按协议转格式） */
  durations: string[];
  defaultDuration: string;
  resolutions: string[];
  defaultResolution: string;
  /** 宽高比档；空数组 = 该家族不支持独立比例（由尺寸/模型决定） */
  aspects: string[];
  /** 显示「生成音频」开关 */
  audioToggle: boolean;
  /** 支持尾帧（首尾帧过渡） */
  tail: boolean;
  /** 连续时长范围（秒）：有则面板显示滑块+自定义输入（如 Seedance 2.0 支持 4-15 任意秒） */
  durationRange?: { min: number; max: number };
  note?: string;
};

const META: Record<VideoFamily, VideoFamilyMeta> = {
  sora: {
    label: "OpenAI Sora",
    durations: ["4", "8", "12"],
    defaultDuration: "4",
    resolutions: ["720p", "1080p"],
    defaultResolution: "720p",
    aspects: ["16:9", "9:16"],
    audioToggle: false,
    tail: false,
    durationRange: { min: 4, max: 20 },
    note: "自带音画同出；首帧参考图需与输出尺寸一致；1080p 档建议 pro 模型；16/20 秒为新版通道",
  },
  veo: {
    label: "Google Veo",
    durations: ["4", "6", "8"],
    defaultDuration: "8",
    resolutions: ["720p", "1080p"],
    defaultResolution: "720p",
    aspects: ["16:9", "9:16"],
    audioToggle: true,
    tail: true,
    note: "1080p 及参考图模式建议 8 秒；尾帧需与首帧同时提供",
  },
  luma: {
    label: "Luma Ray",
    durations: ["5", "9"],
    defaultDuration: "5",
    resolutions: ["540p", "720p", "1080p", "4k"],
    defaultResolution: "720p",
    aspects: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    audioToggle: false,
    tail: true,
    note: "首尾帧最灵活（keyframes），可只给尾帧做反推",
  },
  kling: {
    label: "可灵 Kling",
    durations: ["5", "10"],
    defaultDuration: "5",
    resolutions: ["720p", "1080p"],
    defaultResolution: "720p",
    aspects: ["16:9", "9:16", "1:1"],
    audioToggle: true,
    tail: true,
    durationRange: { min: 3, max: 15 },
    note: "支持首帧 + 尾帧（image_tail）；1080p 档按 pro 模式发；3.0 支持 3-15 任意秒；音频为 2.6+ 的 sound 开关",
  },
  seedance: {
    label: "即梦 Seedance",
    durations: ["5", "10"],
    defaultDuration: "5",
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "720p",
    aspects: ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    audioToggle: true,
    tail: true,
    durationRange: { min: 2, max: 15 },
    note: "adaptive = 比例自适应（图生视频推荐）；1.0 支持 2-12 秒、1.5 Pro 4-12 秒、2.0 支持 4-15 任意秒；1.5+ 音画同出",
  },
  wan: {
    label: "通义万相 Wan",
    durations: ["5", "10"],
    defaultDuration: "5",
    resolutions: ["480p", "720p", "1080p"],
    defaultResolution: "720p",
    aspects: ["16:9", "9:16", "1:1"],
    audioToggle: true,
    tail: true,
    durationRange: { min: 2, max: 15 },
    note: "2.5 支持 5/10 秒，2.6+ 支持 2-15 任意秒",
  },
  vidu: {
    label: "Vidu",
    durations: ["4", "5", "8"],
    defaultDuration: "5",
    resolutions: ["360p", "720p", "1080p"],
    defaultResolution: "720p",
    aspects: ["16:9", "9:16", "1:1"],
    audioToggle: true,
    tail: true,
    durationRange: { min: 1, max: 16 },
    note: "Q2 支持 1-10 秒、Q3 支持 1-16 秒；首尾帧即官方「首尾帧」模式；音频开关对应 bgm",
  },
  hailuo: {
    label: "海螺 MiniMax",
    durations: ["6", "10"],
    defaultDuration: "6",
    resolutions: ["512p", "768p", "1080p"],
    defaultResolution: "768p",
    aspects: [],
    audioToggle: false,
    tail: true,
    note: "比例由模型按首帧/内容决定；尾帧仅 Hailuo-02 支持；1080p 不能 10 秒",
  },
  cogvideo: {
    label: "智谱 CogVideoX",
    durations: ["5", "10"],
    defaultDuration: "5",
    resolutions: ["720p", "1080p", "4k"],
    defaultResolution: "1080p",
    aspects: ["16:9", "9:16", "1:1"],
    audioToggle: true,
    tail: false,
  },
  pixverse: {
    label: "PixVerse",
    durations: ["5", "8"],
    defaultDuration: "5",
    resolutions: ["360p", "540p", "720p", "1080p"],
    defaultResolution: "540p",
    aspects: ["16:9", "9:16", "1:1"],
    audioToggle: false,
    tail: false,
    durationRange: { min: 1, max: 15 },
    note: "v6/c1 支持 1-15 任意秒；1080p 只能 5 秒",
  },
  generic: {
    label: "通用视频",
    durations: ["5", "10"],
    defaultDuration: "5",
    resolutions: ["720p", "1080p"],
    defaultResolution: "720p",
    aspects: ["16:9", "9:16", "1:1"],
    audioToggle: false,
    tail: true,
    durationRange: { min: 1, max: 60 },
    note: "参数按常见字段透传，具体以中转站支持为准",
  },
};

export function videoMeta(f: VideoFamily): VideoFamilyMeta {
  return META[f];
}

/** 档位 + 比例 → 实际宽高（zhipu size / siliconflow image_size / Sora size 用） */
export function videoWh(resolution: string, aspect: string): { w: number; h: number } | null {
  const heights: Record<string, number> = {
    "360p": 360, "480p": 480, "540p": 540, "720p": 720, "768p": 768, "1080p": 1080, "4k": 2160,
  };
  const base = heights[resolution];
  if (!base) return null;
  const m = aspect.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  const r = m ? parseFloat(m[1]) / parseFloat(m[2]) : 16 / 9;
  const even = (v: number) => Math.round(v / 2) * 2;
  // 横构图以档位为高；竖构图以档位为宽（如 720p 竖 = 720x1280）
  if (r >= 1) return { w: even(base * r), h: base };
  return { w: base, h: even(base / r) };
}

/** Sora 官方尺寸枚举（720p: 1280x720 / 720x1280；1080p 档对应 1792x1024 / 1024x1792） */
export function soraSize(resolution: string, aspect: string): string {
  const portrait = aspect === "9:16";
  if (resolution === "1080p") return portrait ? "1024x1792" : "1792x1024";
  return portrait ? "720x1280" : "1280x720";
}
