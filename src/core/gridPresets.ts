/**
 * 九宫格抽卡预设 — 生图面板「更多 → 九宫格抽卡」的模板库。
 * 打法（LibTV 多机位九宫格同款）：一次生成一张 N×N 网格图，容纳同一场景的 N² 个机位/时间点关键帧——
 * 同次生成保证各格主体/风格/光照天然连贯（连生成 N 次给不了）；生成后「宫格切分」拆成独立图片节点，
 * 相邻两帧作首尾帧即可连拍成片。单图网格的代价是每格分辨率低，切分后可先本地超分再连拍。
 *
 * 画幅：N×N 等分网格每格比例恒等于整图比例，因此整图画幅直接跟随目标视频画幅（默认 16:9 横屏，
 * 与 LibTV 一致；竖屏短视频选 9:16）。预设里存 16:9 基准宽高，其他画幅由 gridDims 换算。
 */
import type { GridAspect, ImageGenData } from "./types";

export type GridPreset = {
  id: string;
  label: string;
  desc: string;
  /** 网格边长（N×N 等分） */
  n: number;
  /** 16:9 基准整图尺寸（像素）：非 banana 家族写 width/height；banana 家族折算 aspect + resolution 档 */
  w: number;
  h: number;
  /** banana 家族对应的分辨率档 */
  resolution: string;
  /** 逐格取值说明（阅读序）；空数组 = 模板自己描述各格关系（如 25 宫格连贯分镜） */
  cells: string[];
  /** 各格之间的连贯性要求（追加在指令末尾） */
  coherence: string;
};

/** 抽卡画幅选项（整图 = 每格比例，跟随下游视频画幅选） */
export const GRID_ASPECTS: { value: GridAspect; label: string }[] = [
  { value: "16:9", label: "16:9 横屏" },
  { value: "9:16", label: "9:16 竖屏" },
  { value: "1:1", label: "1:1 方形" },
];

export const GRID_PRESETS: GridPreset[] = [
  {
    id: "shot9",
    label: "多机位九宫格",
    desc: "同一场景的 9 个机位与景别（远景/特写/俯仰…），挑两帧连拍即得运镜",
    n: 3,
    w: 2560,
    h: 1440,
    resolution: "2K",
    cells: [
      "wide establishing shot of the whole scene",
      "medium shot, subject from knees up",
      "close-up of the subject's face",
      "low angle shot looking up at the subject",
      "high angle / bird's-eye view of the scene",
      "over-the-shoulder shot from behind the subject",
      "dutch angle (tilted camera) medium shot",
      "profile side view of the subject",
      "extreme close-up of a key detail (hand, object or eyes)",
    ],
    coherence: "Same moment in time in every cell, as if several cameras were filming the scene at once. Keep camera height and lens feel natural for each shot type.",
  },
  {
    id: "time9",
    label: "时间演进九宫格",
    desc: "同一镜头下 9 个连续时间点，专为「全选 → 首尾帧连拍」成一段连贯动作设计",
    n: 3,
    w: 2560,
    h: 1440,
    resolution: "2K",
    cells: Array.from({ length: 9 }, (_, i) => `moment ${i + 1} of 9: roughly ${(100 / 9) * i}% through the action`),
    coherence: "This is ONE continuous camera shot: identical camera position, framing and lens in every cell. Only the subject's pose and the action progress from cell to cell, like consecutive frames of a single motion — cell 1 is the earliest moment, cell 9 the latest.",
  },
  {
    id: "story4",
    label: "剧情推演四宫格",
    desc: "同一画面的 4 个不同剧情走向，抽卡挑一条最有戏的分支",
    n: 2,
    w: 2560,
    h: 1440,
    resolution: "2K",
    cells: ["story branch A — the expected, straightforward continuation", "story branch B — a sudden twist or interruption", "story branch C — a quiet, emotional turn", "story branch D — an exaggerated, dramatic escalation"],
    coherence: "Each cell starts from the same situation but develops it differently; keep the same cast, location and art style in all four branches.",
  },
  {
    id: "board25",
    label: "连贯分镜 25 宫格",
    desc: "一场戏从头到尾的 25 帧连环分镜；每格分辨率低，切分后建议先「超清放大」再连拍",
    n: 5,
    w: 3840,
    h: 2160,
    resolution: "4K",
    cells: [],
    coherence: `The 25 cells read row by row as consecutive storyboard frames of one continuous scene, from beginning through middle to end. Same characters, location and art style in every cell; the action flows naturally from one cell to the next, and camera framing may vary shot to shot like a real storyboard.`,
  },
];

export function presetById(id: string | undefined): GridPreset | undefined {
  return id ? GRID_PRESETS.find((p) => p.id === id) : undefined;
}

/** 生成模式未指定模板时按宫格数自动匹配：2→剧情推演、5→连贯分镜、其余→多机位（其连贯性约束对任意 N 通用） */
export function presetForN(n: number): GridPreset {
  if (n === 2) return presetById("story4")!;
  if (n === 5) return presetById("board25")!;
  return presetById("shot9")!;
}

/** 预设基准（16:9）按目标画幅换算整图尺寸：竖屏翻转、方形面积守恒取 64 倍数 */
export function gridDims(preset: GridPreset, aspect: GridAspect): { w: number; h: number } {
  if (aspect === "9:16") return { w: preset.h, h: preset.w };
  if (aspect === "1:1") {
    const side = Math.max(64, Math.round(Math.sqrt(preset.w * preset.h) / 64) * 64);
    return { w: side, h: side };
  }
  return { w: preset.w, h: preset.h };
}

/** 组装抽卡提示词：整图网格约束 + 画幅构图 + 用户场景 + 逐格分工 + 连贯性要求；n 可覆盖模板默认（宫格节点自定义行列时用，逐格分工仅在 n 与模板一致时下发） */
export function buildGridPrompt(preset: GridPreset, userDesc: string, aspect: GridAspect, n = preset.n): string {
  const total = n * n;
  const aspectLine =
    aspect === "9:16"
      ? "The whole image is a tall 9:16 portrait image, so every cell is a 9:16 portrait frame — compose each cell like a vertical-video shot."
      : aspect === "1:1"
        ? "The whole image is a square 1:1 image, so every cell is a square frame."
        : "The whole image is a wide 16:9 landscape image, so every cell is a 16:9 landscape frame — compose each cell like a cinematic widescreen shot.";
  const lines = [
    `Generate ONE single image laid out as a ${n}×${n} grid with exactly ${total} equal cells (each cell shares the aspect ratio of the whole image): no gaps, no borders, no drawn grid lines, no watermark, no text or number labels anywhere in the image.`,
    aspectLine,
    "All cells depict the SAME scene and subject described below — keep character design, outfit, props, lighting, color palette and art style perfectly consistent across every cell.",
    `【Scene】${userDesc.trim() || "（按当前节点与上游素材自行构思一个连贯场景）"}`,
  ];
  if (preset.cells.length === total) {
    lines.push("Cell assignment (reading order, row by row):");
    preset.cells.forEach((c, i) => lines.push(`- cell ${i + 1}: ${c}`));
  }
  lines.push(preset.coherence);
  return lines.join("\n");
}

/** 抽卡时写到节点上的尺寸参数：非 banana 家族显式 width/height（优先级最高，参考图比例不会覆盖）；banana 家族 aspect + 分辨率档 */
export function gridSizePatch(
  preset: GridPreset,
  family: string,
  aspect: GridAspect,
): Pick<ImageGenData, "width" | "height" | "size" | "aspect" | "resolution"> {
  if (family === "banana") {
    return { width: undefined, height: undefined, size: "default", aspect, resolution: preset.resolution };
  }
  const d = gridDims(preset, aspect);
  return { width: d.w, height: d.h, size: "default", aspect: undefined, resolution: undefined };
}
