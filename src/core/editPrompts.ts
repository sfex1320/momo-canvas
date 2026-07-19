/**
 * 图片编辑类节点的指令构造 — 中转站模型能力参差，全部走「参考图 + 中文指令」的通用通道；
 * GPT Image 家族另有真 mask 通道（runner 里按家族分流）。
 */
import type { EnhanceData, MattingBg, OutpaintPads } from "./types";

/** 指令式局部重绘（Banana/通用家族）：图1 原图 + 图2 红色标注图 */
export function inpaintInstruct(userPrompt: string): string {
  return [
    "图1是原图，图2在原图上用红色半透明高亮标注了需要修改的区域。",
    `请只修改红色标注对应的区域：${userPrompt.trim() || "自然修复该区域，使其与周围内容融为一体"}。`,
    "标注区域以外的所有内容必须与原图保持完全一致：构图、人物、光影、色彩、细节都不能变。",
    "输出修改后的完整图片，画面中不能残留任何红色标注痕迹。",
  ].join("\n");
}

/** GPT Image mask 通道的提示词：区域已由蒙版限定，提示词只描述要画什么 */
export function inpaintMaskPrompt(userPrompt: string): string {
  return userPrompt.trim() || "自然修复蒙版区域，使其与周围内容无缝融合";
}

const DIR_LABEL: [keyof OutpaintPads, string][] = [
  ["left", "左"],
  ["right", "右"],
  ["up", "上"],
  ["down", "下"],
];

export function padsSummary(pads: OutpaintPads): string {
  const parts = DIR_LABEL.filter(([k]) => (pads[k] ?? 0) > 0).map(([k, lab]) => `向${lab}扩展约 ${Math.round((pads[k] ?? 0) * 100)}%`);
  return parts.join("、");
}

/** 指令式扩图（Banana/通用家族）：靠目标比例 + 文字方向描述 */
export function outpaintInstruct(pads: OutpaintPads, userPrompt: string): string {
  return [
    `将这张图片的画面${padsSummary(pads) || "向四周扩展"}。`,
    "原有画面内容必须原样保留在对应位置，不得裁剪、变形或重绘；只在新增区域自然延伸场景（背景、环境、光影与原图无缝衔接）。",
    userPrompt.trim() ? `新增区域中希望出现：${userPrompt.trim()}。` : "",
    "输出扩展后的完整图片。",
  ]
    .filter(Boolean)
    .join("\n");
}

/** GPT Image mask 通道的扩图提示词 */
export function outpaintMaskPrompt(userPrompt: string): string {
  return [
    "在透明区域自然延伸画面：背景、环境、光影与已有内容无缝衔接，保持同一风格。",
    userPrompt.trim() ? `延伸区域中希望出现：${userPrompt.trim()}。` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export const MATTING_BG_LABEL: Record<MattingBg, string> = {
  transparent: "透明底",
  white: "纯白底",
  green: "纯绿幕",
  black: "纯黑底",
};

/** 抠图指令：GPT 家族配合 background=transparent；其余家族输出纯色底 */
export function mattingInstruct(subject: string, bg: MattingBg, transparentOk: boolean): string {
  const who = subject.trim() || "画面中最主要的主体";
  const bgText = bg === "transparent" && transparentOk
    ? "背景完全透明（输出带 alpha 通道的 PNG）"
    : bg === "green"
      ? "背景为纯绿色（#00B140 绿幕）"
      : bg === "black"
        ? "背景为纯黑色"
        : "背景为纯白色";
  return [
    `把${who}从画面中完整抠出：主体的形状、颜色、细节、边缘（含毛发/半透明部分）保持与原图一致，不要重绘或美化主体。`,
    `去除全部原背景，${bgText}。`,
    "输出只含主体与该背景的图片。",
  ].join("\n");
}

/** 高清增强指令 */
export function enhanceInstruct(focus: EnhanceData["focus"]): string {
  const extra =
    focus === "face"
      ? "重点修复人物面部：五官清晰自然、皮肤质感真实，不改变人物长相与表情。"
      : focus === "detail"
        ? "重点增强材质纹理与细节锐度，让模糊处变清晰。"
        : "只提升清晰度与分辨率，不添加原图没有的内容。";
  return [
    "对这张图片做高清增强：在完全保持原图构图、内容、色调与风格的前提下提升分辨率与清晰度。",
    extra,
    "不能改变画面内容、比例与风格，输出增强后的完整图片。",
  ].join("\n");
}

/** 创意度（0-100）→ 注入图生图提示词的力度短语；45-60 视为默认不干预 */
export function creativityPhrase(v?: number): string | null {
  if (v === undefined || (v > 40 && v < 65)) return null;
  if (v <= 15) return "严格保持参考图的构图、主体、姿态与细节，仅按提示词做最小限度的修改。";
  if (v <= 40) return "整体贴近参考图的构图与主体，只在提示词要求的方向上适度调整。";
  if (v <= 85) return "参考图仅作为构图与内容的大致参考，可以在风格与细节上自由发挥。";
  return "参考图仅作为灵感来源，大胆重新演绎，不必拘泥于原图的构图与细节。";
}
