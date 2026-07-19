/**
 * 角色卡 / 角色库 共享定义
 *  - 角色卡可产出的素材种类与说明（节点 UI / runner 共用）
 *  - 设定卡整版排版风格
 *  - 视觉模型分析用的系统提示词（输出严格 JSON：档案 + 各素材生图提示词）
 *  - 角色库内置预设：风格形象统一（写实棚拍人像基调），应用后即可直接生成整套素材
 */
import type { CharCardStyle, CharDeliverable, CharProfile } from "./types";

/* ---------------- 素材种类 ---------------- */
export const CHAR_DELIVERABLES: { value: CharDeliverable; label: string; desc: string }[] = [
  { value: "turnaround", label: "三视图", desc: "正/侧/背全身三视图 + 头部多角度" },
  { value: "closeup", label: "脸部近景", desc: "上半身正面近景肖像" },
  { value: "expressions", label: "表情九宫格", desc: "3×3 九种表情参考" },
  { value: "poses", label: "动作姿态", desc: "6 种全身动作姿态" },
  { value: "portrait", label: "角色立绘", desc: "单张全身立绘" },
  { value: "sheet", label: "角色设定卡", desc: "整版设定卡排版（档案/色卡/服装拆解）" },
];

export const DELIV_LABEL: Record<CharDeliverable, string> = Object.fromEntries(
  CHAR_DELIVERABLES.map((d) => [d.value, d.label]),
) as Record<CharDeliverable, string>;

/** 各素材的版式要求（分析提示词与预设模板共用） */
const DELIV_SPEC: Record<CharDeliverable, string> = {
  turnaround:
    "全身正面、侧面、背面三个站立视图排成一行，右侧配头部正面/四分之三侧/正侧/背面等多角度特写，纯白背景，角色设定参考图版式，同一角色外貌完全一致",
  closeup: "上半身正面近景肖像，看向镜头自然微笑，面部细节清晰，纯白背景，均匀柔光",
  expressions:
    "3×3 网格排列九种表情：平静、微笑、大笑、眨眼、惊讶、生气、难过、哭泣、思考，同一角色头部特写，纯白背景，格与格之间留白分隔",
  poses: "同一角色六种不同全身动作姿态：自然站立、双手插兜、行走、回头、挥手打招呼、坐姿，排版整齐，纯白背景",
  portrait: "单张全身立绘，自然站姿、放松微笑，纯白背景，影棚均匀柔光",
  sheet:
    "一整张角色设定卡排版设计，版块包含：角色名大标题（中英文）、基本信息栏（年龄/身高/生日/星座/职业）、外貌特征列表、气质关键词、全身三视图、表情格、服装单品拆解、配饰展示、色卡（附 hex 色号）、角色简介与手写签名，文字排版清晰可读",
};

/* ---------------- 设定卡排版风格 ---------------- */
export const CARD_STYLES: { value: CharCardStyle; label: string; desc: string }[] = [
  {
    value: "auto",
    label: "自动",
    desc: "由模型根据角色的画风与气质自动匹配版面（古风→水墨宣纸卷轴、赛博→霓虹 HUD、甜美→奶油手账、职场→极简杂志…）",
  },
  { value: "clean", label: "简约留白", desc: "大量留白、白底黑字、优雅衬线体大标题、细分割线的极简高级杂志排版" },
  { value: "magazine", label: "时尚杂志", desc: "时尚杂志大片排版，大幅人物图配文字栏，现代无衬线字体，黑白灰高对比配色" },
  { value: "letter", label: "信纸手账", desc: "米色信纸质感底、花朵与花边点缀、圆角卡片版块、温柔的手账风排版" },
  { value: "dossier", label: "机密档案", desc: "牛皮纸/做旧纸张拼贴、胶带与回形针元素、CONFIDENTIAL 印章、档案袋风格排版" },
];

/* ---------------- 视觉分析系统提示词 ---------------- */
export function charAnalysisSystem(style: CharCardStyle, lang: "zh" | "en"): string {
  const st = CARD_STYLES.find((s) => s.value === style) ?? CARD_STYLES[0];
  const sheetStyle =
    style === "auto"
      ? "请先判断角色的整体画风与气质，再自动设计最贴合的版面风格（例如：古风华服→水墨宣纸卷轴版式；赛博未来→霓虹 HUD 科技版式；甜美日常→奶油色手账版式；职场干练→高级极简杂志版式），并把选定的版面风格具体写进 sheet 提示词里"
      : st.desc;
  const langLine =
    lang === "en"
      ? "所有生图提示词用英文书写（多数绘画模型对英文更敏感），设定卡内的版面文字仍标注中英双语"
      : "所有生图提示词用中文书写";
  const specs = CHAR_DELIVERABLES.map((d) => `- ${d.value} ${d.label}：${DELIV_SPEC[d.value]}`).join("\n");
  return `你是资深角色设定师与 AI 绘画提示词专家。用户会发来一张人物图片、一段角色文字描述，或两者都有。请完成两件事：
1. 提炼（或根据文字描述设定）这个角色的完整档案（外貌、服饰、配色、气质），并为角色起一个契合气质的名字；
2. 为下列每种角色素材各写一段可直接用于 AI 绘画的高质量提示词。

所有提示词必须：以同一角色为主体，把发型发色、脸部特征、体型、服装、配饰等外貌锚点完整重复写进每一段（保证多张图角色一致）；画风与原图/描述一致（写实照片保持写实摄影质感，插画保持同风格插画；文字描述未指明画风时默认写实摄影）；${langLine}。

素材版式要求：
${specs}

sheet 设定卡的版面风格：${sheetStyle}。

严格只输出以下 JSON（不要 markdown 代码块、不要任何解释）：
{"profile":{"name":"中文名","nameEn":"英文名","age":"22","occupation":"职业","intro":"80字以内角色简介","appearance":["外貌特征"],"outfit":["服装单品"],"accessories":["配饰"],"palette":["#RRGGBB"],"keywords":["气质关键词"],"artStyle":"画风概述"},"prompts":{"turnaround":"…","closeup":"…","expressions":"…","poses":"…","portrait":"…","sheet":"…"}}`;
}

/* ---------------- 角色库内置预设 ---------------- */
export type CharPreset = {
  id: string;
  name: string;
  tags: string[];
  desc: string;
  profile: CharProfile;
  prompts: Record<CharDeliverable, string>;
};

/** 由「外貌锚点描述 + 画风短语」套用统一模板，保证整套素材角色一致、库内风格统一 */
function presetPrompts(anchor: string, styleTail: string): Record<CharDeliverable, string> {
  const mk = (spec: string) => `${anchor}。${spec}，${styleTail}`;
  return {
    turnaround: `角色三视图设定参考：${mk(DELIV_SPEC.turnaround)}`,
    closeup: mk(DELIV_SPEC.closeup),
    expressions: `角色表情九宫格参考：${mk(DELIV_SPEC.expressions)}`,
    poses: `角色动作姿态参考：${mk(DELIV_SPEC.poses)}`,
    portrait: `角色全身立绘：${mk(DELIV_SPEC.portrait)}`,
    sheet: `角色设定卡：${mk(DELIV_SPEC.sheet)}`,
  };
}

/** 库内统一画风（写实棚拍人像），保证「风格形象统一」 */
const STUDIO = "写实人像摄影质感，影棚均匀柔光，高清细节，色彩干净通透";

function preset(
  id: string,
  name: string,
  tags: string[],
  desc: string,
  anchor: string,
  profile: CharProfile,
): CharPreset {
  return { id, name, tags, desc, profile, prompts: presetPrompts(anchor, STUDIO) };
}

export const CHAR_PRESETS: CharPreset[] = [
  preset(
    "sweet-girl",
    "甜妹 · 清新少女",
    ["女", "现代", "青年", "清新"],
    "浅蓝卫衣配白色阔腿裤的邻家甜妹，黑长微卷发，笑容治愈亲和力满分。",
    "一位 20 岁左右的中国甜美少女，黑色长卷发自然蓬松微乱，鹅蛋脸，杏眼明亮，唇色元气粉，穿浅蓝色oversize圆领卫衣、白色阔腿休闲裤、白色帆布鞋，气质清新治愈",
    {
      name: "林小甜",
      nameEn: "Lin Xiaotian",
      age: "20",
      occupation: "大学生",
      intro: "元气满满的邻家甜妹，笑起来眼睛弯弯，是朋友圈里的开心果。",
      appearance: ["黑色长卷发，自然微乱", "鹅蛋脸，杏眼明亮", "元气粉唇色", "身形匀称纤细"],
      outfit: ["浅蓝色 oversize 卫衣", "白色阔腿休闲裤", "白色帆布鞋"],
      accessories: ["细银链项链"],
      palette: ["#AECBEB", "#FFFFFF", "#F6E7E3", "#2B2B2B", "#E9A0A6"],
      keywords: ["甜美", "治愈", "元气", "亲和"],
      artStyle: "写实棚拍人像",
    },
  ),
  preset(
    "fashion-asia-f",
    "时尚感亚洲女生",
    ["女", "现代", "青年", "时尚"],
    "黑背心配紧身裤的高冷时尚亚洲女生，黑长直发，气场利落。",
    "一位 23 岁左右的时尚亚洲女生，黑色及腰长直发中分，瓜子脸，丹凤眼眼神清冷，穿黑色修身无袖背心、黑色紧身长裤、黑色短靴，身材高挑纤细，气场高冷利落",
    {
      name: "沈之夏",
      nameEn: "Shen Zhixia",
      age: "23",
      occupation: "平面模特",
      intro: "镜头前的高冷面孔，镜头后爱喝手打柠檬茶，反差感十足。",
      appearance: ["黑色及腰长直发，中分", "瓜子脸，丹凤眼", "冷白皮", "身材高挑纤细"],
      outfit: ["黑色修身无袖背心", "黑色紧身长裤", "黑色短靴"],
      accessories: ["银色耳骨夹"],
      palette: ["#101010", "#3A3A3A", "#FFFFFF", "#C9C9C9", "#8A6E5A"],
      keywords: ["高冷", "利落", "时尚", "气场"],
      artStyle: "写实棚拍人像",
    },
  ),
  preset(
    "fashion-asia-m",
    "时尚感亚洲男生",
    ["男", "现代", "青年", "时尚"],
    "黑色宽松layered穿搭的亚洲男生，黑色碎盖头，慵懒少年感。",
    "一位 22 岁左右的时尚亚洲男生，黑色蓬松碎盖发型，剑眉星目，鼻梁高挺，穿黑色宽松针织衫叠白色T恤、黑色直筒裤、黑色皮鞋，身高腿长，慵懒少年感",
    {
      name: "顾北辰",
      nameEn: "Gu Beichen",
      age: "22",
      occupation: "音乐系学生",
      intro: "弹吉他的安静少年，话不多，舞台上却是另一个人。",
      appearance: ["黑色蓬松碎盖发", "剑眉星目", "鼻梁高挺", "身高腿长"],
      outfit: ["黑色宽松针织衫", "白色打底 T 恤", "黑色直筒裤", "黑色皮鞋"],
      accessories: ["银色细项链"],
      palette: ["#151515", "#FFFFFF", "#4A4A4A", "#9C9C9C", "#6B4F3F"],
      keywords: ["慵懒", "少年感", "安静", "反差"],
      artStyle: "写实棚拍人像",
    },
  ),
  preset(
    "fashion-west-f",
    "时尚感欧美女生",
    ["女", "现代", "青年", "时尚"],
    "蜜橘色长发配黑色开衫百褶裙的欧美女生，慵懒疏离感。",
    "一位 21 岁左右的时尚欧美女生，蜜橘色（橘粉色）齐刘海长发，立体五官，浅灰绿色眼睛，穿黑色针织开衫内搭白色背心、灰色百褶短裙、黑色及膝袜与乐福鞋，慵懒疏离的时尚感",
    {
      name: "Chloe",
      nameEn: "Chloe",
      age: "21",
      occupation: "艺术学院学生",
      intro: "喜欢胶片相机和黑胶唱片，穿搭随性却总能踩中潮流。",
      appearance: ["蜜橘色齐刘海长发", "立体五官", "浅灰绿色眼睛", "白皙皮肤"],
      outfit: ["黑色针织开衫", "白色背心", "灰色百褶短裙", "黑色及膝袜", "黑色乐福鞋"],
      accessories: ["银色小圆环耳环"],
      palette: ["#F2A57B", "#111111", "#FFFFFF", "#7D8471", "#D9D3CC"],
      keywords: ["慵懒", "疏离", "复古", "潮流"],
      artStyle: "写实棚拍人像",
    },
  ),
  preset(
    "fashion-west-m",
    "时尚感欧美男生",
    ["男", "现代", "青年", "时尚"],
    "浅金短发配灰色毛衣的欧美男生，轮廓深邃温和绅士。",
    "一位 24 岁左右的时尚欧美男生，浅金色微卷短发，轮廓深邃，蓝灰色眼睛，穿浅灰色圆领羊毛衫、卡其色休闲裤、白色运动鞋，体格挺拔，温和绅士气质",
    {
      name: "Leon",
      nameEn: "Leon",
      age: "24",
      occupation: "建筑设计师",
      intro: "白天画图纸，傍晚沿河慢跑，笑容让人如沐春风。",
      appearance: ["浅金色微卷短发", "轮廓深邃", "蓝灰色眼睛", "体格挺拔"],
      outfit: ["浅灰色圆领羊毛衫", "卡其色休闲裤", "白色运动鞋"],
      accessories: ["棕色皮表带手表"],
      palette: ["#D8D8D8", "#B99B6B", "#FFFFFF", "#5C6670", "#2E2E2E"],
      keywords: ["温和", "绅士", "干净", "阳光"],
      artStyle: "写实棚拍人像",
    },
  ),
  preset(
    "little-boy",
    "小男孩",
    ["男", "现代", "儿童", "可爱"],
    "白衬衫黑短发的乖巧小男孩，圆脸大眼睛，元气可爱。",
    "一位 8 岁左右的中国小男孩，黑色短发干净利落，圆脸大眼睛，穿白色短袖衬衫、深蓝色短裤、白色运动鞋，乖巧元气",
    {
      name: "元宝",
      nameEn: "Yuanbao",
      age: "8",
      occupation: "小学生",
      intro: "班里的小机灵鬼，爱恐龙和乐高，笑声特别有感染力。",
      appearance: ["黑色干净短发", "圆脸大眼睛", "肉嘟嘟脸颊"],
      outfit: ["白色短袖衬衫", "深蓝色短裤", "白色运动鞋"],
      accessories: [],
      palette: ["#FFFFFF", "#2C3E64", "#F5D76E", "#8AB6E8", "#3A3A3A"],
      keywords: ["乖巧", "元气", "机灵", "可爱"],
      artStyle: "写实棚拍人像",
    },
  ),
  preset(
    "little-girl",
    "小女孩",
    ["女", "现代", "儿童", "可爱"],
    "黑长直配白裙的安静小女孩，齐刘海大眼睛，乖巧文静。",
    "一位 7 岁左右的中国小女孩，黑色长直发配齐刘海，圆脸大眼睛，穿白色连衣裙、白色小皮鞋，安静乖巧",
    {
      name: "念念",
      nameEn: "Niannian",
      age: "7",
      occupation: "小学生",
      intro: "喜欢画画和小猫，安静地待在角落也能自己玩一下午。",
      appearance: ["黑色长直发，齐刘海", "圆脸大眼睛", "白皙皮肤"],
      outfit: ["白色连衣裙", "白色小皮鞋"],
      accessories: ["粉色发夹"],
      palette: ["#FFFFFF", "#F5C8D0", "#2B2B2B", "#E8E3DA", "#A8C6A0"],
      keywords: ["文静", "乖巧", "软萌", "治愈"],
      artStyle: "写实棚拍人像",
    },
  ),
  preset(
    "hanfu-girl",
    "古风汉服少女",
    ["女", "古风", "青年", "国风"],
    "青绿色齐胸襦裙的古风少女，发髻步摇，温婉灵动。",
    "一位 19 岁左右的中国古风少女，黑色长发挽双环发髻垂下发丝，配银色步摇发饰，柳叶眉杏眼，穿青绿色渐变齐胸襦裙配薄纱披帛，温婉灵动的古典气质",
    {
      name: "苏青梧",
      nameEn: "Su Qingwu",
      age: "19",
      occupation: "琴师",
      intro: "抚琴时安静如水，笑起来又像三月里的风，古典与灵动并存。",
      appearance: ["黑色长发双环髻，银步摇", "柳叶眉，杏眼", "肤白唇朱"],
      outfit: ["青绿色渐变齐胸襦裙", "薄纱披帛", "绣花布鞋"],
      accessories: ["银色步摇", "玉手镯"],
      palette: ["#9DBEA9", "#DFE8DC", "#F3EFE6", "#71856F", "#B85C4A"],
      keywords: ["温婉", "灵动", "古典", "清雅"],
      artStyle: "写实棚拍人像",
    },
  ),
  preset(
    "office-lady",
    "都市职场女性",
    ["女", "现代", "青年", "职场"],
    "白衬衫黑风衣的干练职场女性，低发髻高跟鞋，气场强大。",
    "一位 26 岁左右的都市职场女性，黑发挽低发髻，眉眼锐利精致，红唇，穿白色衬衫、黑色长风衣、黑色西装裤、黑色细高跟鞋，手提黑色皮质手袋，干练强气场",
    {
      name: "夏凝",
      nameEn: "Xia Ning",
      age: "26",
      occupation: "公司主管",
      intro: "外冷内热的执行者，规则感极强，却总在关键时刻替团队扛事。",
      appearance: ["黑发低发髻", "眉眼锐利，红唇", "身姿挺拔高挑"],
      outfit: ["白色衬衫", "黑色长风衣", "黑色西装裤", "黑色细高跟鞋"],
      accessories: ["精钢腕表", "黑色皮质手袋"],
      palette: ["#111111", "#FFFFFF", "#5B5B5B", "#B0AAA2", "#7A1F2B"],
      keywords: ["干练", "高冷", "可靠", "掌控力"],
      artStyle: "写实棚拍人像",
    },
  ),
  preset(
    "cyber-girl",
    "赛博潮酷女生",
    ["女", "未来", "青年", "潮酷"],
    "银紫挑染短发配机能外套的赛博女生，未来感潮酷。",
    "一位 22 岁左右的赛博潮酷女生，银白色短发带紫色挑染，眼妆锐利带银色亮片，穿黑色机能风外套带反光条、深灰工装裤、厚底机能鞋，未来感潮酷气质",
    {
      name: "Nova",
      nameEn: "Nova",
      age: "22",
      occupation: "电子音乐制作人",
      intro: "住在霓虹灯下的夜行动物，耳机里永远是自己没发布的新曲。",
      appearance: ["银白短发带紫色挑染", "锐利眼妆带亮片", "身形利落"],
      outfit: ["黑色机能风外套（反光条）", "深灰工装裤", "厚底机能鞋"],
      accessories: ["金属耳骨钉", "战术腰包"],
      palette: ["#1A1A22", "#B18CFF", "#E6E6E6", "#5BE0D8", "#40405A"],
      keywords: ["潮酷", "未来感", "夜行", "锋利"],
      artStyle: "写实棚拍人像",
    },
  ),
];
