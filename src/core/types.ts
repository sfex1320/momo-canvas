import type { Node } from "@xyflow/react";

/* ---------------- 节点 ---------------- */
export type NodeKind =
  | "image"
  | "prompt"
  | "chat"
  | "imageGen"
  | "videoGen"
  | "comfy"
  | "caption"
  | "llmText"
  | "combine"
  | "stylePreset"
  | "note"
  | "group"
  | "relight"
  | "multiAngle"
  | "charCard"
  | "resize"
  | "inpaint"
  | "outpaint"
  | "matting"
  | "enhance"
  | "crop"
  | "frame"
  | "videoTrim"
  | "videoConcat";

export type RunStatus = "idle" | "running" | "done" | "error";

export type SearchHit = { title: string; url: string; snippet: string };

export type ChatMsg = {
  role: "user" | "assistant";
  text: string;
  images?: string[];
  reasoning?: string;
  sources?: SearchHit[];
};

export type ImageData = {
  status: RunStatus;
  error?: string;
  src?: string;
  name?: string;
};

export type PromptData = {
  status: RunStatus;
  error?: string;
  text: string;
  optimizing?: boolean;
};

export type ChatData = {
  status: RunStatus;
  error?: string;
  messages: ChatMsg[];
  draft: string;
  webSearch: boolean;
  showThinking: boolean;
  modelId?: string;
};

export type ImageGenData = {
  status: RunStatus;
  error?: string;
  prompt: string;
  /** 通用家族预设尺寸（"default" = 跟随服务商配置） */
  size: string;
  count: number;
  results: string[];
  picked: number;
  modelId?: string;
  /** 创意度 0-100（仅图生图生效）：低 = 忠于参考图微调；高 = 大胆重新演绎。50 = 不干预 */
  creativity?: number;
  /** Nano Banana：宽高比（auto/1:1/16:9…） */
  aspect?: string;
  /** Nano Banana：分辨率档（1K/2K/4K） */
  resolution?: string;
  /** GPT Image：质量（auto/high/medium/low） */
  quality?: string;
  /** GPT Image / 通用：自定义宽高（同时填写才生效） */
  width?: number;
  height?: number;
  /** 提示词语言：zh 原文直发（默认）/ en 生成前先译成英文 */
  lang?: "zh" | "en";
};

export type VideoGenData = {
  status: RunStatus;
  error?: string;
  prompt: string;
  resultUrl?: string;
  progress?: string;
  modelId?: string;
  /** 提示词语言：zh 原文直发（默认）/ en 生成前先译成英文 */
  lang?: "zh" | "en";
  /** 时长档（按模型家族枚举，如 "5" / "10"，videoMeta 定义） */
  duration?: string;
  /** 分辨率档（如 "720p" / "1080p"，按家族） */
  resolution?: string;
  /** 宽高比（如 "16:9"，按家族） */
  aspect?: string;
  /** 生成音频（支持的家族才显示） */
  audio?: boolean;
  /** 第二路上游图片作为尾帧（家族支持首尾帧时可开） */
  useTail?: boolean;
};

/** 视频取帧：从上游视频抽一帧输出为图片（本地抽帧，零成本） */
export type FrameData = {
  status: RunStatus;
  error?: string;
  /** 取帧位置：首帧 / 末帧 / 自定义秒数 */
  point: "first" | "last" | "custom";
  timeSec?: number;
  result?: string;
  /** 上游视频时长（秒，抽帧时顺带记录，供 UI 展示） */
  srcDur?: number;
};

/** 视频取段：本地重编码截取上游视频的一段（实验性：实时录制，时长≈片段时长） */
export type VideoTrimData = {
  status: RunStatus;
  error?: string;
  start: number;
  end?: number;
  resultUrl?: string;
  progress?: string;
  srcDur?: number;
};

/** 视频拼接：把多路上游视频按连线顺序合成一条（实验性：实时录制重编码） */
export type VideoConcatData = {
  status: RunStatus;
  error?: string;
  resultUrl?: string;
  progress?: string;
};

export type ComfyData = {
  status: RunStatus;
  error?: string;
  templateId?: string;
  params: Record<string, string | number>;
  results: string[];
  picked: number;
  /** 工作流的文本输出（ShowText 等节点），多段用空行分隔 */
  textOut?: string;
  /** 工作流的视频输出（VHS 合成等，blob URL） */
  videoResults?: string[];
  progress?: string;
  /** 实时进度百分比 0-100（WebSocket 可用时才有） */
  progressPct?: number;
};

/** 反推描述：图片 → 视觉模型 → 文本 */
export type CaptionData = {
  status: RunStatus;
  error?: string;
  mode: "prompt" | "detail" | "tags";
  result: string;
  modelId?: string;
};

/** 文本处理：上游文本 → LLM 指令加工 → 文本 */
export type LlmTextOp = "optimize" | "zh2en" | "expand" | "shorten" | "custom";
export type LlmTextData = {
  status: RunStatus;
  error?: string;
  op: LlmTextOp;
  custom: string;
  result: string;
  modelId?: string;
};

/** 拼接文本：多路上游文本合并输出 */
export type CombineData = {
  status: RunStatus;
  error?: string;
  separator: "comma" | "newline" | "space";
  extra: string;
};

/** 风格预设：内置提示词片段库，多选输出 */
export type StylePresetData = {
  status: RunStatus;
  error?: string;
  category: string;
  selected: string[];
};

/** 备注：画布便签，无端口 */
export type NoteData = {
  status: RunStatus;
  error?: string;
  text: string;
  color: "yellow" | "blue" | "pink" | "green";
  /** 锁定后不可拖动（默认关闭） */
  locked?: boolean;
};

/** 组（主节点）：把区域内节点打包，按位置顺序聚合成员的文本/图片输出 */
export type GroupData = {
  status: RunStatus;
  error?: string;
  title?: string;
};

/** 生成类编辑节点的输出模式：image = 生成并输出图片；prompt = 不出图，向下游输出构造好的提示词 */
export type OutMode = "image" | "prompt";

/** 打光：上游图片 → 按光源参数重新打光（图生图，内容不变只改光影） */
export type RelightData = {
  status: RunStatus;
  error?: string;
  /** 输出模式（默认 image） */
  outMode?: OutMode;
  /** 水平方位角：0 = 正前方（相机方向），负值偏左、正值偏右，±180 = 背后 */
  azimuth: number;
  /** 垂直仰角：正值从上方照射、负值从下方照射 */
  elevation: number;
  /** 亮度 0-100（50 = 正常曝光） */
  brightness: number;
  /** 光源颜色 hex；空 = 自然光不指定 */
  color: string;
  /** 轮廓光（rim light） */
  rim: boolean;
  /** 智能模式：让模型自行设计最佳打光方案（忽略方向/亮度/颜色） */
  smart: boolean;
  results: string[];
  picked: number;
  modelId?: string;
};

/** 多角度：上游图片 → 换机位重新取景（图生图，主体一致只改视角） */
export type AnglePreset = "custom" | "fisheye" | "dutch" | "topdown" | "lowangle" | "aerial" | "back";
export type MultiAngleData = {
  status: RunStatus;
  error?: string;
  /** 输出模式（默认 image） */
  outMode?: OutMode;
  preset: AnglePreset;
  /** 水平环绕角 -180..180（0 = 原机位，正值向右环绕） */
  yaw: number;
  /** 垂直俯仰 -60..60（正值俯拍、负值仰拍） */
  pitch: number;
  /** 景别 0-4：特写/近景/中景/全景/远景 */
  shot: number;
  results: string[];
  picked: number;
  modelId?: string;
};

/* ---------------- 角色卡 / 角色库 ---------------- */
/** 角色档案：视觉模型分析上传图片得出，或来自角色库预设 */
export type CharProfile = {
  name: string;
  nameEn?: string;
  age?: string;
  occupation?: string;
  intro: string;
  appearance: string[];
  outfit: string[];
  accessories?: string[];
  /** 配色（hex） */
  palette: string[];
  /** 气质关键词 */
  keywords: string[];
  /** 画风/氛围概述（各素材生成时保持统一） */
  artStyle?: string;
};

/** 设定卡整版的排版风格；auto = 模型按角色画风/气质自动匹配版面 */
export type CharCardStyle = "auto" | "clean" | "magazine" | "letter" | "dossier";
/** 角色卡可产出的素材种类 */
export type CharDeliverable = "turnaround" | "closeup" | "expressions" | "poses" | "portrait" | "sheet";

export type CharCardData = {
  status: RunStatus;
  error?: string;
  progress?: string;
  /** 输出模式（默认 image）；prompt = 只分析出提示词，不调绘画模型 */
  outMode?: OutMode;
  /** 生图提示词语言 */
  lang: "zh" | "en";
  /** 设定卡整版排版风格 */
  style: CharCardStyle;
  /** 勾选要产出的素材 */
  deliverables: CharDeliverable[];
  /** 旧字段（已由 outMode 取代，读档兼容用） */
  genImages?: boolean;
  profile?: CharProfile;
  /** 每种素材的生图提示词（分析后可手动编辑） */
  prompts: Partial<Record<CharDeliverable, string>>;
  /** 每种素材的生成结果 */
  results: Partial<Record<CharDeliverable, string[]>>;
  /** 来自角色库预设时的预设名 */
  presetName?: string;
  chatModelId?: string;
  imageModelId?: string;
};

/* ---------------- 尺寸调整 ---------------- */
/** 缩放方式：mp = 目标总像素（百万）· side = 单边定长 · scale = 倍率 */
export type ResizeMode = "mp" | "side" | "scale";
/** side 模式的参照边 */
export type ResizeSideRef = "long" | "short" | "width" | "height";
/** 输出内容：image = 处理后的图片；其余为尺寸文本（可接生成节点替换其尺寸设置） */
export type ResizeOut = "image" | "recAspect" | "recRes" | "actAspect" | "actRes";

/** 尺寸调整：真实重采样上游图片的像素（非虚值），或向下游输出比例/分辨率文本 */
export type ResizeData = {
  status: RunStatus;
  error?: string;
  mode: ResizeMode;
  /** mp 模式：目标总像素（单位百万，如 1 = 约 100 万像素） */
  mp: number;
  /** side 模式：参照边 + 目标边长（另一边按比例自动算） */
  sideRef: ResizeSideRef;
  sideLen: number;
  /** scale 模式：缩放百分比（100 = 原尺寸；>100 放大） */
  scalePct: number;
  out: ResizeOut;
  /** 处理后的图片（image 输出模式） */
  result?: string;
  outW?: number;
  outH?: number;
  /** 上游原图尺寸（接入时自动测量，供展示与文本输出推导） */
  srcW?: number;
  srcH?: number;
};

/* ---------------- 图片编辑类节点（局部重绘 / 扩图 / 抠图 / 增强 / 聚焦） ---------------- */

/** 重绘/扩图的模型通道：
 *  auto = GPT 家族走真蒙版、其余走指令式；mask = 强制真蒙版（images/edits 的 mask 参数，需中转站如实转发）；
 *  instruct = 强制指令式（发原图 + 红色标注图，走普通图生图通道，兼容性最好） */
export type EditChannel = "auto" | "mask" | "instruct";

/** 局部重绘：上游图片 + 蒙版（画笔/框选涂抹）→ 只重绘标注区域 */
export type InpaintData = {
  status: RunStatus;
  error?: string;
  prompt: string;
  /** 蒙版 PNG dataURL（与原图同尺寸：标注处白色不透明，其余全透明） */
  mask?: string;
  /** 模型通道（默认 auto；中转站蒙版转发不可靠时切 instruct） */
  channel?: EditChannel;
  /** 生成张数（多候选选卡） */
  count: number;
  results: string[];
  picked: number;
  modelId?: string;
  lang?: "zh" | "en";
};

/** 扩图方向幅度：每边扩展比例（0 = 不扩） */
export type OutpaintPads = { left: number; right: number; up: number; down: number };

/** 扩图：上游图片 → 向四周延伸画面
 *  GPT Image 走真实 mask 外扩；其余家族按目标比例 + 指令降级 */
export type OutpaintData = {
  status: RunStatus;
  error?: string;
  /** 每边扩展比例（0-1 连续值，可视化编辑器拖拽/比例档设置） */
  pads: OutpaintPads;
  /** 补充提示词（希望扩展区域出现什么，可留空自然延伸） */
  prompt: string;
  /** 模型通道（同局部重绘） */
  channel?: EditChannel;
  count: number;
  results: string[];
  picked: number;
  modelId?: string;
};

/** 图片编辑节点的执行引擎：model = 绘画模型；comfy = 本地 ComfyUI 模板（rembg 抠图 / 专业放大等，效果更专业） */
export type EditEngine = "model" | "comfy";

/** 抠图/去背：上游图片 → 主体抠出
 *  推荐 ComfyUI 引擎（rembg/BiRefNet 等真抠图）；绘画模型引擎只能重绘换底（GPT Image 可出透明 PNG） */
export type MattingData = {
  status: RunStatus;
  error?: string;
  progress?: string;
  engine?: EditEngine;
  /** ComfyUI 引擎：所选模板 id */
  comfyTemplateId?: string;
  /** 目标背景；transparent 仅 GPT Image / ComfyUI 支持，其余家族自动降级为白底 */
  bg: MattingBg;
  /** 主体描述（留空 = 自动识别最显著主体） */
  subject: string;
  results: string[];
  picked: number;
  modelId?: string;
};
export type MattingBg = "transparent" | "white" | "green" | "black";

/** 高清增强：上游图片 → 提升分辨率与细节
 *  推荐 ComfyUI 引擎（UltimateSDUpscale / 放大模型等专业放大）；绘画模型引擎为重绘式增强 */
export type EnhanceData = {
  status: RunStatus;
  error?: string;
  progress?: string;
  engine?: EditEngine;
  comfyTemplateId?: string;
  /** 放大倍率（2 / 4） */
  factor: number;
  /** 增强侧重：detail = 细节纹理；face = 人物面部；none = 纯放大不加戏 */
  focus: "detail" | "face" | "none";
  results: string[];
  picked: number;
  modelId?: string;
};

/** 聚焦裁剪：框选上游图片的局部作为输出（纯本地裁剪，不调模型）——精准引用参考图局部 */
export type CropData = {
  status: RunStatus;
  error?: string;
  /** 框选区域（相对原图的归一化坐标 0-1） */
  rect?: { x: number; y: number; w: number; h: number };
  result?: string;
  srcW?: number;
  srcH?: number;
};

export type AppNode = Node<Record<string, unknown>, NodeKind>;

/* 端口数据类型 */
export type PortType = "text" | "image" | "video";

/* ---------------- 模型配置（服务商卡片） ---------------- */
export type ModelRole = "chat" | "image" | "video";

export type ChatProtocol = "openai" | "anthropic" | "gemini";
export type ImageProtocol = "openai" | "gemini";
export type VideoProtocol = "zhipu" | "siliconflow" | "openai";
export type AnyProtocol = ChatProtocol | ImageProtocol | VideoProtocol;
/** 协议标识：内置协议，或自定义协议 "custom:<id>"（协议执行器） */
export type ProtocolId = AnyProtocol | (string & {});

/** 服务商卡片里某一角色的模型槽位（models 为空 = 该角色未启用），同一用途可配置多个模型 */
export type RoleSlot = {
  protocol: ProtocolId;
  models: string[];
};

/** v3 单模型槽位旧结构，用于迁移 */
export type LegacyRoleSlotV3 = {
  protocol: AnyProtocol;
  model?: string;
  models?: string[];
  size?: string;
};

/** 一张服务商（中转站）卡片：共用 Base URL / API Key，可同时配置 对话 / 绘画 / 视频 3 套模型 */
export type ProviderCard = {
  id: string;
  /** 显示名，例如「中转A」「智谱官方」 */
  name: string;
  baseUrl: string;
  apiKey: string;
  models: Partial<Record<ModelRole, RoleSlot>>;
};

/** 运行期扁平化的模型配置（由服务商卡片 + 角色解析而来，服务层直接消费） */
export type ModelCard = {
  id: string;
  role: ModelRole;
  name: string;
  protocol: ProtocolId;
  baseUrl: string;
  apiKey: string;
  model: string;
  size?: string;
};

export type ModelsCfg = {
  providers: ProviderCard[];
  /** 各角色默认模型，复合键「providerId::model」（旧数据可能只有 providerId，加载时会规整） */
  defaults: Partial<Record<ModelRole, string>>;
};

/** v2（按角色平铺多卡片）旧结构，用于迁移 */
export type LegacyModelsV2 = {
  cards: ModelCard[];
  defaults: Partial<Record<ModelRole, string>>;
};

export const ROLE_LABEL: Record<ModelRole, string> = {
  chat: "对话模型",
  image: "绘画模型",
  video: "视频模型",
};

export const PROTOCOLS: Record<ModelRole, { value: string; label: string }[]> = {
  chat: [
    { value: "openai", label: "OpenAI 兼容" },
    { value: "anthropic", label: "Anthropic Claude" },
    { value: "gemini", label: "Google Gemini" },
  ],
  image: [
    { value: "openai", label: "OpenAI 兼容 (images API)" },
    { value: "gemini", label: "Gemini 生图 (nano banana)" },
  ],
  video: [
    { value: "zhipu", label: "智谱 CogVideoX" },
    { value: "siliconflow", label: "硅基流动" },
    { value: "openai", label: "OpenAI 兼容 (任务轮询)" },
  ],
};

/* ---------------- 其他设置 ---------------- */
export type SearchProvider = "tavily" | "bocha" | "searxng";
export type SearchCfg = { provider: SearchProvider; apiKey: string; baseUrl: string; maxResults: number };
export type ImgFormat = "png" | "jpeg" | "webp";
export type SaveCfg = { dir: string; format: ImgFormat; pattern: string; autoSave: boolean };
export type ComfyCfg = { host: string };
export type ThemeName = "light" | "dark";

/* ---------------- 音效提醒 ---------------- */
export type SoundCfg = {
  /** 总开关 */
  enabled: boolean;
  /** 语音播报：系统 TTS 念出节点名与结果（"生成图像完成" / "生成视频出错"） */
  speak: boolean;
  /** 音量 0-1 */
  volume: number;
  /** 自定义完成提示音（dataURL；留空用内置合成音） */
  doneAudio?: string;
  /** 自定义报错提示音（dataURL；留空用内置合成音） */
  errAudio?: string;
};

/* ---------------- 快捷键 ---------------- */
export type HotkeyAction =
  | "moveTool"
  | "group"
  | "ignore"
  | "popLock"
  | "fitView"
  | "zen"
  | "undo"
  | "redo"
  | "duplicate"
  | "delete"
  | "runAll"
  | "zoomIn"
  | "zoomOut"
  | "assets"
  | "gallery"
  | "search"
  | "spotlight"
  // 下方工具坞：添加各类节点到视图中心（与 nodeCatalog 的条目一一对应）
  | "addImage"
  | "addPrompt"
  | "addStylePreset"
  | "addNote"
  | "addChat"
  | "addCaption"
  | "addLlmText"
  | "addImageGen"
  | "addVideoGen"
  | "addComfy"
  | "addResize"
  | "addRelight"
  | "addMultiAngle"
  | "addCharCard"
  | "addInpaint"
  | "addOutpaint"
  | "addMatting"
  | "addEnhance"
  | "addCrop"
  | "addFrame"
  | "addVideoTrim"
  | "addVideoConcat";

export const HOTKEY_LABEL: Record<HotkeyAction, string> = {
  moveTool: "移动工具（激活/取消）",
  group: "建组（框画区域 / 打包所选）",
  ignore: "忽略/恢复所选节点",
  popLock: "弹窗锁定（上游传入预览不自动收起）",
  fitView: "视图适应全部节点",
  zoomIn: "放大画布",
  zoomOut: "缩小画布",
  assets: "打开/关闭资产库",
  gallery: "打开/关闭生成记录",
  search: "画布内搜索节点",
  spotlight: "快速添加（搜索节点/模板）",
  zen: "沉浸模式",
  undo: "撤销",
  redo: "重做",
  duplicate: "创建副本",
  delete: "删除所选（请绑定单键）",
  runAll: "运行全部工作流",
  addImage: "添加节点：图片",
  addPrompt: "添加节点：提示词",
  addStylePreset: "添加节点：风格预设",
  addNote: "添加节点：备注",
  addChat: "添加节点：对话",
  addCaption: "添加节点：反推描述",
  addLlmText: "添加节点：文本处理",
  addImageGen: "添加节点：生成图像",
  addVideoGen: "添加节点：生成视频",
  addComfy: "添加节点：ComfyUI",
  addResize: "添加节点：尺寸调整",
  addRelight: "添加节点：打光",
  addMultiAngle: "添加节点：多角度",
  addCharCard: "添加节点：角色卡",
  addInpaint: "添加节点：局部重绘",
  addOutpaint: "添加节点：扩图",
  addMatting: "添加节点：抠图",
  addEnhance: "添加节点：高清增强",
  addCrop: "添加节点：聚焦裁剪",
  addFrame: "添加节点：视频取帧",
  addVideoTrim: "添加节点：视频取段",
  addVideoConcat: "添加节点：视频拼接",
};

/** 组合键格式：修饰键小写用 + 连接，如 "ctrl+z" / "ctrl+shift+s"；单键直接写键名 */
export const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  moveTool: "v",
  group: "g",
  ignore: "i",
  popLock: "l",
  fitView: "f",
  zen: "Tab",
  undo: "ctrl+z",
  redo: "ctrl+y",
  duplicate: "ctrl+d",
  delete: "Delete",
  runAll: "ctrl+Enter",
  zoomIn: "=",
  zoomOut: "-",
  assets: "b",
  gallery: "h",
  search: "ctrl+f",
  spotlight: "ctrl+k",
  // 工具坞按排列顺序对应 1~9、0，编辑/角色类用 Alt+数字
  addImage: "1",
  addPrompt: "2",
  addStylePreset: "3",
  addNote: "4",
  addChat: "5",
  addCaption: "6",
  addLlmText: "7",
  addImageGen: "8",
  addVideoGen: "9",
  addComfy: "0",
  addResize: "alt+1",
  addRelight: "alt+2",
  addMultiAngle: "alt+3",
  addCharCard: "alt+4",
  addInpaint: "alt+5",
  addOutpaint: "alt+6",
  addMatting: "alt+7",
  addEnhance: "alt+8",
  addCrop: "alt+9",
  addFrame: "",
  addVideoTrim: "",
  addVideoConcat: "",
};

/* ---------------- 快捷方式（资产库侧边栏） ---------------- */
export type ShortcutItem = {
  id: string;
  name: string;
  /** exe / 文件夹的绝对路径 */
  path: string;
  kind: "app" | "folder";
};

/* ---------------- 自定义生成协议（协议执行器） ----------------
   模板占位符：{{baseUrl}} {{apiKey}} {{model}} {{prompt}} {{size}} {{n}} {{taskId}}
   图片类：{{image}} 首图 dataURL · {{image2}} 第二图 · {{images}} 全部参考图 JSON 数组（不加引号）· {{mask}} 蒙版 PNG dataURL
   条件块：{{?var}}…{{/var}} 变量非空时保留；{{^var}}…{{/var}} 变量为空时保留（端点切换/可选字段用） */
export type CustomProtocol = {
  id: string;
  name: string;
  /** 用途：图片生成 / 视频生成（决定出现在哪个模型槽位、结果按图片还是视频处理） */
  role: "image" | "video";
  /** 提交请求：url/headers/body 均为模板字符串，body 是 JSON 文本 */
  submit: { url: string; method?: "POST" | "GET"; headers?: Record<string, string>; body?: string };
  /** 提交响应里任务 id 的 JSON 路径（如 "task_id" / "data.id"）；留空 = 同步接口 */
  taskIdPath?: string;
  /** 异步轮询：查询请求 + 状态判定 */
  poll?: {
    url: string;
    method?: "POST" | "GET";
    headers?: Record<string, string>;
    body?: string;
    intervalMs?: number;
    /** 状态字段 JSON 路径与完成/失败取值 */
    statusPath: string;
    doneValue: string;
    failValue?: string;
  };
  /** 最终响应里图片的 JSON 路径（url 或 base64；支持数组，如 "data[].url"） */
  resultPath: string;
  /** 最近一次真实测试通过的时间戳（校准成功 / 自愈成功时盖章；无 = 从未验证过） */
  verifiedAt?: number;
};

export type Settings = {
  models: ModelsCfg;
  search: SearchCfg;
  save: SaveCfg;
  comfy: ComfyCfg;
  theme: ThemeName;
  /** 画布 GPU 加速：节点提升为合成层，平移/缩放走 GPU（默认开；遇显卡兼容问题可关） */
  gpuBoost: boolean;
  /** 任务完成/报错音效与语音播报 */
  sound: SoundCfg;
  /** 协议自愈：自定义协议运行失败时，AI 依据执行现场自动修协议并重试一次（默认开） */
  protoSelfHeal: boolean;
  hotkeys: Record<HotkeyAction, string>;
  /** 资产库侧边栏快捷方式 */
  shortcuts: ShortcutItem[];
  /** 自定义协议（协议助手生成或手写） */
  customProtocols: CustomProtocol[];
};

export const DEFAULT_SETTINGS: Settings = {
  models: { providers: [], defaults: {} },
  search: { provider: "tavily", apiKey: "", baseUrl: "", maxResults: 5 },
  save: { dir: "", format: "png", pattern: "{date}_{time}_{model}", autoSave: false },
  comfy: { host: "http://127.0.0.1:8188" },
  theme: "dark",
  gpuBoost: true,
  sound: { enabled: true, speak: false, volume: 0.6 },
  protoSelfHeal: true,
  hotkeys: DEFAULT_HOTKEYS,
  shortcuts: [],
  customProtocols: [],
};

/** v1（单套配置）旧结构，用于迁移 */
export type LegacySettingsV1 = {
  chat?: { baseUrl: string; apiKey: string; model: string };
  image?: { baseUrl: string; apiKey: string; model: string; size?: string };
  video?: { baseUrl: string; apiKey: string; model: string; style?: string };
  search?: SearchCfg;
  save?: SaveCfg;
  comfy?: ComfyCfg;
  theme?: ThemeName;
};

/* ---------------- ComfyUI 模板 ---------------- */
export type ComfyWfNode = {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
};

export type ComfyParamKind = "text" | "number" | "seed" | "image" | "toggle";

export type ComfyExposedParam = {
  key: string; // `${nodeId}.${input}`
  nodeId: string;
  input: string;
  label: string;
  kind: ComfyParamKind;
  value: string | number | boolean;
};

export type ComfyTemplate = {
  id: string;
  name: string;
  workflow: Record<string, ComfyWfNode>;
  params: ComfyExposedParam[];
  outputNodeId?: string;
  /** 被忽略的节点：运行时剔除，下游自动跨接到其上游 */
  disabledNodes?: string[];
  createdAt: number;
};

/* ---------------- 画布模板（组/所选打包保存，可反复实例化） ---------------- */
/** 模板内节点：位置为相对模板左上角的偏移；data 已清洗（无运行结果/大图） */
export type TemplateNode = {
  /** 模板内的局部 id（实例化时重新生成） */
  tid: string;
  kind: NodeKind;
  x: number;
  y: number;
  data: Record<string, unknown>;
  /** 组成员：父节点的 tid */
  parentTid?: string;
  /** 组框尺寸 */
  w?: number;
  h?: number;
};
export type TemplateEdge = { sourceTid: string; targetTid: string; sourceHandle?: string; targetHandle?: string };
export type BoardTemplate = {
  id: string;
  name: string;
  nodes: TemplateNode[];
  edges: TemplateEdge[];
  /** 内置示例模板（不可删除、不落盘） */
  builtin?: boolean;
  createdAt: number;
};

/* ---------------- 画板 ---------------- */
export type BoardMeta = {
  id: string;
  name: string;
  updatedAt: number;
  /** 上次的视图位置/缩放（重开软件或切回画布时恢复） */
  viewport?: { x: number; y: number; zoom: number };
};

/* ---------------- 生成记录（会话内时间线） ---------------- */
export type GalleryItem = {
  id: string;
  kind: "image" | "video";
  src: string;
  prompt?: string;
  model?: string;
  nodeId?: string;
  time: number;
};

/* ---------------- 资产库 ---------------- */
export type AssetKind = "image" | "video" | "audio" | "pdf" | "other";

/** 生成参数快照：画布生成物收录时随资产落盘，「Remix」可据此还原一个配置好的生成节点 */
export type AssetGenMeta = {
  /** 还原成哪种节点 */
  nodeKind: "imageGen" | "videoGen";
  /** 发给模型的最终提示词 */
  prompt?: string;
  /** 复合键 providerId::model */
  modelId?: string;
  size?: string;
  aspect?: string;
  resolution?: string;
  quality?: string;
  width?: number;
  height?: number;
  lang?: "zh" | "en";
  creativity?: number;
};

export type AssetItem = {
  id: string;
  kind: AssetKind;
  /** 显示名 */
  name: string;
  /** 磁盘绝对路径（浏览器预览模式下为 blob/data URL） */
  path: string;
  /** 缩略图路径（图片/视频有；浏览器模式为 dataURL） */
  thumb?: string;
  mime: string;
  /** 字节数 */
  size: number;
  width?: number;
  height?: number;
  prompt?: string;
  model?: string;
  folderId?: string | null;
  /** 标签（去重、保序） */
  tags?: string[];
  /** 来源：canvas 生成 / import 导入 */
  source: "canvas" | "import";
  /** 生成参数快照（画布生成物才有）：资产卡「Remix」按此还原生成节点 */
  gen?: AssetGenMeta;
  createdAt: number;
};

export type AssetFolder = { id: string; name: string };
