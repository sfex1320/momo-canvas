/**
 * 打光 / 多角度 共享元数据与提示词构造
 *  节点 UI 与 runner 共用：UI 只存参数，运行时在这里拼成对图像编辑模型友好的指令
 */
import type { AnglePreset, MultiAngleData, RelightData } from "./types";

/* ---------------- 打光 ---------------- */

/** 主光源方向按钮（与打光面板一致）：方位角/仰角预设 */
export const LIGHT_DIRS: { label: string; az: number; el: number }[] = [
  { label: "左侧", az: -90, el: 0 },
  { label: "顶部", az: 0, el: 65 },
  { label: "右侧", az: 90, el: 0 },
  { label: "前方", az: 0, el: 0 },
  { label: "底部", az: 0, el: -65 },
  { label: "后方", az: 180, el: 0 },
];

/** 方位角/仰角 → 人话（模型对方位描述比纯数字更敏感，两者都给） */
export function lightPhrase(az: number, el: number): string {
  const a = ((az % 360) + 360) % 360;
  const horiz =
    a <= 25 || a >= 335
      ? "正前方（相机方向）"
      : a < 155
        ? a < 65
          ? "右前方"
          : a < 115
            ? "正右侧"
            : "右后方"
        : a <= 205
          ? "正后方（逆光）"
          : a < 295
            ? a < 245
              ? "左后方"
              : "正左侧"
            : "左前方";
  const vert =
    el >= 55 ? "接近顶光" : el >= 20 ? "略高于主体" : el > -20 ? "与主体基本水平" : el > -55 ? "略低于主体" : "接近底光";
  return `${horiz}、${vert}`;
}

export function buildRelightPrompt(d: RelightData, extraTexts: string[]): string {
  const lines: string[] = [
    "对这张图片重新打光（relight）：保持主体的身份、姿态、表情、服装、构图与背景内容完全不变，只改变光照方向、阴影与整体影调。",
  ];
  if (d.smart) {
    lines.push(
      "智能打光：请分析画面内容与氛围，自动设计最能突出主体质感与情绪的专业打光方案（如伦勃朗光、蝴蝶光、黄金时刻逆光、霓虹氛围光等），并直接应用到画面。",
    );
  } else {
    lines.push(`主光源方向：${lightPhrase(d.azimuth, d.elevation)}（水平方位角 ${d.azimuth}°，垂直仰角 ${d.elevation}°）。`);
    const b = d.brightness;
    const mood = b < 30 ? "整体偏暗、低调氛围" : b < 45 ? "略暗于正常曝光" : b <= 60 ? "正常曝光" : b <= 80 ? "明亮通透" : "高调明亮、接近过曝的通透感";
    lines.push(`光照强度：约 ${b}%（50% 为正常曝光），${mood}。`);
    lines.push(d.color ? `光源颜色：${d.color}（十六进制色值），让光线带上这种色调。` : "光源颜色：自然白光，不加色偏。");
  }
  if (d.rim) lines.push("在主体边缘添加清晰的轮廓光（rim light），把主体从背景中分离出来。");
  lines.push("光影过渡自然真实、符合物理规律，呈现电影级打光质感。");
  if (extraTexts.length) lines.push(`补充要求：${extraTexts.join("；")}`);
  return lines.join("\n");
}

/* ---------------- 多角度 ---------------- */

export const ANGLE_PRESETS: { value: AnglePreset; label: string; prompt: string }[] = [
  { value: "custom", label: "自定义", prompt: "" },
  { value: "fisheye", label: "鱼眼视角", prompt: "改用鱼眼超广角镜头拍摄，画面带明显鱼眼畸变，主体位于画面中心，视觉冲击力强" },
  { value: "dutch", label: "倾斜视角", prompt: "改用荷兰角（倾斜构图）拍摄，相机明显侧倾，画面充满张力与动感" },
  { value: "topdown", label: "正面俯拍", prompt: "改为正面俯拍视角，相机从主体前上方约 45° 俯视拍摄" },
  { value: "lowangle", label: "正面仰拍", prompt: "改为正面仰拍视角，相机从主体前下方仰视拍摄，主体显得高大有气势" },
  { value: "aerial", label: "全景俯拍", prompt: "改为高空俯瞰的全景鸟瞰视角，展示主体与周围环境的全貌" },
  { value: "back", label: "背面视角", prompt: "转到主体正后方拍摄背面视角，展示主体的背影与身后的场景" },
];

export const SHOT_LABELS = ["特写", "近景", "中景", "全景", "远景"] as const;

const SHOT_PROMPTS: Record<(typeof SHOT_LABELS)[number], string> = {
  特写: "特写景别（主体面部/局部占满画面）",
  近景: "近景景别（胸部以上）",
  中景: "中景景别（膝盖以上）",
  全景: "全景景别（完整全身与少量环境）",
  远景: "远景景别（主体较小，环境为主）",
};

export function buildAnglePrompt(d: MultiAngleData, extraTexts: string[]): string {
  const lines: string[] = [];
  const preset = ANGLE_PRESETS.find((p) => p.value === d.preset);
  if (preset && preset.value !== "custom") {
    lines.push(`换一个机位重新拍摄这张图片中的主体：${preset.prompt}。`);
  } else {
    const yawTxt =
      Math.abs(d.yaw) < 5
        ? "保持原机位方向"
        : Math.abs(Math.abs(d.yaw) - 180) < 10
          ? "环绕到主体正后方（背面视角）"
          : `围绕主体水平环绕 ${Math.abs(d.yaw)}°（向${d.yaw > 0 ? "右" : "左"}侧移动机位）`;
    const pitchTxt =
      Math.abs(d.pitch) < 5 ? "相机与主体基本水平" : d.pitch > 0 ? `相机升高俯视约 ${d.pitch}°（俯拍）` : `相机降低仰视约 ${Math.abs(d.pitch)}°（仰拍）`;
    const shot = SHOT_LABELS[d.shot] ?? "中景";
    lines.push(`换一个机位重新拍摄这张图片中的主体：${yawTxt}；${pitchTxt}；取景调整为${SHOT_PROMPTS[shot]}。`);
  }
  lines.push("必须保持主体的身份、外貌、发型、服装、材质与场景内容完全一致，光照风格一致，只改变相机角度与取景构图。被新视角显露的部分要合理自然地补全。");
  if (extraTexts.length) lines.push(`补充要求：${extraTexts.join("；")}`);
  return lines.join("\n");
}
