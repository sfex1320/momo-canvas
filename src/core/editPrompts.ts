/**
 * 图片编辑类节点的指令构造 — 中转站模型能力参差，全部走「参考图 + 中文指令」的通用通道；
 * GPT Image 家族另有真 mask 通道（runner 里按家族分流）。
 */
import type { EnhanceParams, OutpaintPads } from "./types";

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

/** 高清增强指令 */
export function enhanceInstruct(focus: EnhanceParams["focus"]): string {
  if(focus==="flat")return "请把参考图清理重绘为用于美陈、文化墙制作的平面部件图。保留原有构图、每个部件的轮廓比例、孔洞、文字字形与颜色关系；清理 JPEG 方块、杂色、模糊重影和边缘毛刺，填充均匀纯色，边界连续闭合。不得添加照片纹理、立体厚度、透视、阴影、装饰或新的零件。不要猜写不清楚的文字。背景保持参考图原色；透明区域保持透明。本次只做平面清理，不创造细节。";
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

/** 元素重绘（元素工坊重绘档 / 图层节点「元素重绘」共用）：只画这一个元素，背景纯白（回来色键抠图） */
export function elementRedrawPrompt(desc: string): string {
  return [
    `请单独绘制这一个设计元素：${desc.trim() || "保持参考图中该元素的原样"}。`,
    "参考图1是这个元素的局部特写（含少量周边背景，仅供理解风格与光影），输出只包含这一个元素本身，不要包含画面中的其他元素或文字。",
    "背景必须是纯净的纯白色（#FFFFFF），不要阴影投在背景上、不要渐变、不要边框；元素细节、配色、质感与参考保持一致。",
    "输出完整元素，边缘干净不裁切。",
  ].join("\n");
}

/** 元素重绘（图层节点自身版）：参考图就是元素的白底图，按描述调整后仍输出纯白背景 */
export function elementRedrawSelfPrompt(desc: string): string {
  return [
    `请重新绘制参考图中的这个设计元素：${desc.trim() || "提升细节质量，保持原样"}。`,
    "保持元素的形态、配色、光影与质感与参考图一致，除非描述中明确要求改变。",
    "背景必须是纯净的纯白色（#FFFFFF），不要阴影投在背景上、不要渐变、不要边框。",
    "输出完整元素，边缘干净不裁切。",
  ].join("\n");
}

/** 改字（图层文字元素）：换字但保字体风格，背景纯白（回来色键抠图） */
export function elementTextPrompt(orig: string, next: string): string {
  return [
    `图中的文字「${orig}」请替换为「${next}」。`,
    "保持原图文字的字体、字形风格、颜色、描边、阴影与排版位置不变，只改变文字内容本身。",
    "背景保持纯白（#FFFFFF），文字以外的区域不要出现任何其他内容。",
    "若新文字更长或更短，允许适当调整字号与间距以保持视觉平衡。",
  ].join("\n");
}

/** 图层组 AI 合成（组右键「AI 合成海报」建 imageGen 节点的模板提示词；参考图 = 组成员按层序聚合） */
export function elementComposePrompt(): string {
  return [
    "参考图按顺序是一张海报的各图层（第一张通常是背景层，其余是透明背景的前景元素）。",
    "请把它们组合成一张完整、协调的平面海报：合理安排版式与视觉层级，自然融合各元素的光影与色调，",
    "保持每个元素本身的外观特征不变形、不丢失；可以补充必要的背景延伸与氛围光，但不要新增未提供的主体。",
    "输出合成后的完整海报。",
  ].join("\n");
}
