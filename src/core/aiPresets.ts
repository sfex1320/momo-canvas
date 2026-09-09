/**
 * AI 模板预设库 — 图片节点「编辑 → AI 模板」的分类玩法菜单（对标 LibTV「九宫格 ▾」大面板）。
 * 每个模板 = 一段围绕参考图的提示词模板 + 默认画幅；选中后在下游铺一个生成节点（**不自动跑**）：
 * 参考图经连线自动带入，用户在节点上补场景描述、调画幅画质后自己点「生成」。
 * grid 类复用宫格抽卡 GRID_PRESETS（一次生成 N×N 整图，之后可宫格切分 → 分镜组）；single 类直出单图。
 */
import type { GridAspect } from "./types";

export type AiPresetGroup = "分镜叙事" | "质感调节" | "空间与机位" | "设定图";

export const AI_PRESET_GROUPS: AiPresetGroup[] = ["分镜叙事", "质感调节", "空间与机位", "设定图"];

export type AiPreset = {
  id: string;
  label: string;
  desc: string;
  group: AiPresetGroup;
  /** grid = 一次生成 N×N 网格整图（写 gridPresetId，之后可宫格切分）；single = 单图 */
  kind: "grid" | "single";
  /** kind=grid：指向宫格抽卡模板（决定 N×N 与尺寸档） */
  gridPresetId?: string;
  /** 默认画幅（grid 类每格比例 = 整图比例） */
  aspect: GridAspect;
  /** kind=single：围绕参考图的提示词模板（参数为用户场景描述，可为空） */
  prompt?: (scene: string) => string;
};

const scene = (s: string, fallback: string) => {
  const t = s.trim();
  return t ? `【Scene】${t}` : `【Scene】${fallback}`;
};

export const AI_PRESETS: AiPreset[] = [
  /* ---------- 分镜叙事 ---------- */
  {
    id: "ai-time9",
    label: "时间演进九宫格",
    desc: "同一镜头下 9 个连续时间点，切分后相邻两帧可连拍成片",
    group: "分镜叙事",
    kind: "grid",
    gridPresetId: "time9",
    aspect: "16:9",
  },
  {
    id: "ai-story4",
    label: "剧情推演四宫格",
    desc: "同一画面的 4 条剧情走向，挑一条最有戏的分支往下走",
    group: "分镜叙事",
    kind: "grid",
    gridPresetId: "story4",
    aspect: "16:9",
  },
  {
    id: "ai-board25",
    label: "25宫格连贯分镜",
    desc: "一场戏从头到尾 25 帧连环分镜（每格分辨率低，建议先超清放大）",
    group: "分镜叙事",
    kind: "grid",
    gridPresetId: "board25",
    aspect: "16:9",
  },
  {
    id: "ai-after3",
    label: "画面推演 · 3秒后",
    desc: "同一镜头自然推进 3 秒后的下一瞬间",
    group: "分镜叙事",
    kind: "single",
    aspect: "16:9",
    prompt: (s) =>
      `Continue this exact scene about 3 seconds LATER. Same characters, outfits, props, location, camera framing, lighting and art style as the reference image — only the pose/action has progressed naturally by roughly 3 seconds. One single image, no collage, no borders, no text or watermark.\n${scene(s, "让动作沿当前趋势自然推进（按参考图自行构思）")}`,
  },
  {
    id: "ai-before5",
    label: "画面推演 · 5秒前",
    desc: "回溯同一镜头 5 秒之前的瞬间",
    group: "分镜叙事",
    kind: "single",
    aspect: "16:9",
    prompt: (s) =>
      `Rewind this exact scene to about 5 seconds EARLIER. Same characters, outfits, props, location, camera framing, lighting and art style as the reference image — the pose/action is at the natural earlier stage of the same motion. One single image, no collage, no borders, no text or watermark.\n${scene(s, "让动作回到当前趋势的前一阶段（按参考图自行构思）")}`,
  },

  /* ---------- 质感调节 ---------- */
  {
    id: "ai-portrait",
    label: "人像质感调节",
    desc: "皮肤纹理与微细节精修，保持人物长相与构图不变",
    group: "质感调节",
    kind: "single",
    aspect: "16:9",
    prompt: (s) =>
      `Refine the portrait quality of the reference image: natural skin texture with pores kept real (no plastic smoothing), finer hair strands and fabric micro-detail, professional soft lighting and clean color separation. Keep the person's identity, face, pose, outfit and composition EXACTLY the same. One single image, no text or watermark.\n${scene(s, "整体提质感，不改内容")}`,
  },
  {
    id: "ai-cinema",
    label: "电影级光影校正",
    desc: "电影感调色与光比，构图内容原样保留",
    group: "质感调节",
    kind: "single",
    aspect: "16:9",
    prompt: (s) =>
      `Apply cinematic color grading to the reference image: filmic contrast curve, teal-and-orange or natural movie palette, controlled highlights and rich shadows, subtle atmospheric depth and film grain. Keep composition, subjects and content EXACTLY the same — only light and color change. One single image, no text or watermark.\n${scene(s, "按电影质感统一调色")}`,
  },

  /* ---------- 空间与机位 ---------- */
  {
    id: "ai-shot9",
    label: "多机位九宫格",
    desc: "同一场景 9 个机位与景别（远景/特写/俯仰…），挑两帧连拍即得运镜",
    group: "空间与机位",
    kind: "grid",
    gridPresetId: "shot9",
    aspect: "16:9",
  },
  {
    id: "ai-pano",
    label: "720° 全景",
    desc: "把当前场景扩展成环视全景长图",
    group: "空间与机位",
    kind: "single",
    aspect: "16:9",
    prompt: (s) =>
      `Expand the reference image into a wide panoramic view of the SAME location: extend the environment seamlessly to the left and right as if turning the camera around, consistent architecture, props, lighting and art style throughout the panorama. One single wide image, no visible seams, no text or watermark.\n${scene(s, "沿当前场景向两侧延展环视")}`,
  },

  /* ---------- 设定图 ---------- */
  {
    id: "ai-face3",
    label: "角色脸部三视图",
    desc: "同一角色面部的正面/侧脸/45° 三视角",
    group: "设定图",
    kind: "single",
    aspect: "16:9",
    prompt: (s) =>
      `Character face reference sheet of the SAME person in the reference image: three head-and-shoulders views arranged side by side on one clean background — front view, 45° view and profile view. Identical face, hairstyle and lighting across all three views, neutral expression, consistent art style. No text or labels.\n${scene(s, "以参考图人物为准")}`,
  },
  {
    id: "ai-char3",
    label: "角色三视图",
    desc: "全身正面/侧面/背面 turnaround 立绘",
    group: "设定图",
    kind: "single",
    aspect: "16:9",
    prompt: (s) =>
      `Full-body character turnaround sheet of the SAME character in the reference image: front, side and back views standing side by side in the same pose scale on one clean background. Identical outfit, proportions, colors and art style across all views, neutral standing pose. No text or labels.\n${scene(s, "以参考图角色为准")}`,
  },
  {
    id: "ai-char-sheet",
    label: "角色设定图",
    desc: "角色设计定稿页：表情/服装/道具小图组合",
    group: "设定图",
    kind: "single",
    aspect: "16:9",
    prompt: (s) =>
      `Character design sheet of the SAME character in the reference image: one main full-body illustration plus a few small supporting studies (facial expressions, key outfit details, signature props) arranged neatly on one clean background. Consistent design, proportions and art style throughout. No text or labels.\n${scene(s, "以参考图角色为准补充设计细节")}`,
  },
  {
    id: "ai-scene-sheet",
    label: "场景设定图",
    desc: "环境概念设定：全景 + 局部细节组合",
    group: "设定图",
    kind: "single",
    aspect: "16:9",
    prompt: (s) =>
      `Environment concept design sheet of the SAME location as the reference image: one main wide establishing view plus 2-3 small detail studies (key props, materials, lighting mood) arranged neatly on one background. Consistent architecture, palette and art style. No text or labels.\n${scene(s, "以参考图场景为准")}`,
  },
  {
    id: "ai-product-sheet",
    label: "产品设定图",
    desc: "产品多角度设定：主视角 + 细节 + 多角度",
    group: "设定图",
    kind: "single",
    aspect: "16:9",
    prompt: (s) =>
      `Product design sheet of the SAME product as the reference image: one hero shot plus side/top/detail views arranged neatly on a clean studio background, consistent materials, proportions, logo placement and lighting across all views. Commercial product-photography look. No text or labels.\n${scene(s, "以参考图产品为准")}`,
  },
];

export function aiPresetById(id: string | undefined): AiPreset | undefined {
  return id ? AI_PRESETS.find((p) => p.id === id) : undefined;
}
