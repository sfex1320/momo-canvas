import type { Node } from "@xyflow/react";
import type { SkillBinding, SkillRunSnapshot } from "./skillTypes";

/* ---------------- 节点 ---------------- */
export type NodeKind =
  | "image"
  | "video"
  | "audio"
  | "audioGen"
  | "videoDub"
  | "prompt"
  | "chat"
  | "imageGen"
  | "videoGen"
  | "comfy"
  | "llmText"
  | "combine"
  | "stylePreset"
  | "note"
  | "group"
  | "relight"
  | "multiAngle"
  | "charCard"
  | "storyboard"
  | "enhanceLocal"
  | "vectorize"
  | "ecomImage"
  | "director";

export type RunStatus = "idle" | "running" | "done" | "error";

export type SearchHit = { title: string; url: string; snippet: string };

export type ChatMsg = {
  role: "user" | "assistant";
  text: string;
  images?: string[];
  reasoning?: string;
  sources?: SearchHit[];
};

/* ---------------- Agent 模式（侧边创作助手：聊天 / 搜索 → 抉择 → 生图/生视频） ---------------- */
export type AgentStepKind = "search" | "think" | "ask" | "image" | "video" | "tool";

/** 一次工具调用的过程轨迹（展示在助手消息里） */
export type AgentStep = {
  id: string;
  kind: AgentStepKind;
  /** 展示文案，如「搜索：赛博朋克 参考」 */
  text: string;
  status: "running" | "done" | "error";
};

export type AgentResult = { kind: "image" | "video"; src: string; prompt?: string };

/** Agent 向用户发起的抉择（点选项或自由输入回答） */
export type AgentQuestion = { text: string; options: string[]; answer?: string };

export type AgentMsg = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** 用户附带的参考图（dataURL） */
  images?: string[];
  /** 本轮生成是否允许使用图片参考；缺省沿用自动策略。 */
  referenceMode?: "auto" | "none";
  /** 助手消息的思考过程（聊天模式，可折叠展示） */
  reasoning?: string;
  /** 过程轨迹：搜索 / 思考 / 提问 / 生成 */
  steps?: AgentStep[];
  question?: AgentQuestion;
  /** 生成结果（内联展示，同时已收录资产库） */
  results?: AgentResult[];
  /** 这条助手消息由哪种模式产生：决定用哪种气泡渲染，切换面板模式后历史不会变形/消失 */
  kind?: "chat" | "agent";
  time: number;
};

/** 元素工坊识别出的元素角色（elemMeta 挂在拆解产物图片节点上，驱动「元素重绘 / 改字」入口） */
export type ElementRole = "text" | "subject" | "logo" | "decoration";

/** 元素拆解的输出规格；毫米是用户指定画板尺寸，不从效果图推测工程尺寸。 */
export type ElementFlatOptions = {
  view: "front" | "back" | "bottom";
  backColor: string; bottomColor: string; background: string; transparent: boolean;
  width: number; height: number; unit: "px" | "mm"; dpi: number; modelId?: string;
};

export type ImageData = {
  /** 立体转平面矢量的溯源；与抠图图层元数据分开。 */
  planarSheet?: { sourceNodeId: string; prompt: string; modelId?: string; width: number; height: number };
  status: RunStatus;
  error?: string;
  src?: string;
  name?: string;
  /** 元素工坊拆解产物的元数据：有它 = 这是一个图层元素节点（透明 PNG），role=text 时 text 存识别出的原文；box 存原图归一化位置（按原位拼回/PSD 原位导出用） */
  elemMeta?: { role: ElementRole; text?: string; box?: [number, number, number, number] };
  /** 分镜组切片：渲染输入口，原图 → 切片的连线可见（纯溯源展示，不参与取值） */
  flatMeta?: ElementFlatOptions & { sourceNodeId: string; elementName: string; pixelWidth: number; pixelHeight: number };
  storyTile?: boolean;
  /** 切片显示尺寸：整组共用缩放，避免各节点按比例独立缩放而错缝。 */
  tileSize?: { w: number; h: number };
};

/** 视频源节点：承载本地/生成的视频（对标图片节点）。src 在 Tauri 下为资产文件的 asset: URL（跨重启有效），浏览器预览为 blob URL（会话内有效） */
export type VideoData = {
  status: RunStatus;
  error?: string;
  src?: string;
  name?: string;
  /** 时长（秒，导入时测得，供角标显示） */
  dur?: number;
};

/** 音频源节点：本地音频文件（配乐/配音/参考音频）。src 在 Tauri 下为资产文件的 asset: URL */
export type AudioData = {
  status: RunStatus;
  error?: string;
  src?: string;
  name?: string;
  /** 时长（秒） */
  dur?: number;
};

/** 生成音频：TTS 朗读 / 音乐生成（音频模型角色；OpenAI /audio/speech 或自定义协议） */
export type AudioGenData = {
  status: RunStatus;
  error?: string;
  /** 朗读文本 / 音乐描述（留空自动取上游文本，含分镜台词） */
  text: string;
  /** 音色（openai 协议的 voice 字段，如 alloy；自定义协议用 {{voice}} 占位） */
  voice?: string;
  resultUrl?: string;
  progress?: string;
  modelId?: string;
  /** 由备用模型生成时记录其名（徽标展示） */
  fallbackModel?: string;
};

/** 视频配音：上游视频 + 音频 → 本地重编码，把音频混入/替换原声 */
export type VideoDubData = {
  status: RunStatus;
  error?: string;
  /** replace = 替换原声（默认）；mix = 与原声混合 */
  mode: "replace" | "mix";
  resultUrl?: string;
  progress?: string;
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

/** 九宫格抽卡整图画幅：N×N 等分网格的每格比例恒等于整图比例，选横屏/竖屏跟随目标视频画幅 */
export type GridAspect = "16:9" | "9:16" | "1:1";

export type ImageGenData = {
  progress?: string;
  /** Codex：不沿用参考图片的历史会话。 */
  newConversation?: boolean;
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
  /** 目标像素（百万）：与 aspect 一起换算宽高写入工作流（模板的 megapixels/宽/高参数） */
  resolutionMP?: number;
  /** Nano Banana：分辨率档（1K/2K/4K） */
  resolution?: string;
  /** GPT Image：质量（auto/high/medium/low） */
  quality?: string;
  /** GPT Image / 通用：自定义宽高（同时填写才生效） */
  width?: number;
  height?: number;
  /** 提示词语言：zh 原文直发（默认）/ en 生成前先译成英文 */
  lang?: "zh" | "en";
  /** 并行请求数 1-3：同参数同时发多条，结果合并到 results（中转站普遍支持并发） */
  parallel?: number;
  /** 随机种子：锁定后同提示词+同参数可复现；不填 = 每次随机（仅支持的家族生效，如 seedream/flux/qwen/万相） */
  seed?: number;
  /** 负向提示词：描述不想出现的内容（如"多余手指、文字、低质量"），支持的家族生效 */
  negative?: string;
  /** 由备用模型生成时记录其名（徽标展示）；undefined = 主模型生成 */
  fallbackModel?: string;
  /** 九宫格抽卡：记录所用模板 id（gridPresets），供「更多 → 九宫格抽卡」重开时恢复切分入口 */
  gridPresetId?: string;
  /** 九宫格抽卡：整图画幅（N×N 等分网格每格比例 = 整图比例，故画幅应跟随下游视频画幅）；默认 16:9 */
  gridAspect?: GridAspect;
  /** 历次出图记录（最近 10 次） */
  history?: GenHistoryEntry[];
};

/** 超清放大（本地 DirectML 超分）节点数据 — 非破坏：输出是新资产，原图不动 */
export type EnhanceLocalData = {
  status: RunStatus;
  error?: string;
  /** 质量预设：极速(SPAN 单模型) / 海报·文化墙(Nomos+Lite 融合) / 专业印刷(保真融合+大重叠+无损容器) / 人像(RealPLKSR+人脸分支) */
  preset: "fast" | "balanced" | "professional" | "portrait";
  /** 目标长边：4k=3840 / 8k=7680 / 16k=15360；或自定义像素；或印刷物理尺寸(mm+DPI) */
  target: "4k" | "8k" | "16k" | { longEdge: number } | { mode: "print"; wMm: number; hMm: number; dpi: number };
  /** 本地模型注册表 id（留空 = 默认主模型） */
  modelId?: string;
  /** 输入 tile 边长（0 = 自动，按预设） */
  tileSize: number;
  /** 细节强度 0-100：0=自动（按内容模式查表），>0 手动覆盖双模型融合权重 detailWeight */
  detailStrength: number;
  /** 内容模式：决定细节模型融合权重查表行（面板「高级」里可调） */
  contentMode: "auto" | "photo" | "illustration" | "poster" | "portrait";
  /** 去压缩（1x-DeJPG 预处理）：auto=jpegScore>0.3 时自动跑；off=关闭；on=强制 */
  dejpeg?: "auto" | "on" | "off";
  /** 人脸处理：identity=原貌保护（默认，不生成五官）；faceup=FaceUpDAT ROI；gfpgan/codeformer=生成式修复 */
  faceRestore?: "identity" | "faceup" | "gfpgan" | "codeformer";
  /** 输出容器位深：8=普通；16=便于后续编辑的 16 位容器（模型源采样仍为 8 位，仅 PNG/TIFF 生效） */
  bitDepth?: 8 | 16;
  outputFormat: "png" | "jpeg" | "tiff";
  // 运行态（result:true 写回，不增 rev）
  progress?: string;
  progressPct?: number;
  /** 输出图（assetUrl，跨重启有效） */
  result?: string;
  resultW?: number;
  resultH?: number;
  elapsedMs?: number;
  tiles?: number;
  /** 实际推理 Tile（自动档可能因模型/显存回退而小于建议值） */
  tileSizeUsed?: number;
  /** 运行前保守显存估算，仅用于排期与风险提示 */
  estimatedVramMb?: number;
  /** 保真守卫评分：高清结果缩回源尺寸的一致性，0..100；不代表主观锐度 */
  fidelityScore?: number;
  /** 保真守卫后的源尺寸平均绝对误差，0..1 */
  sourceConsistencyMae?: number;
  /** 发生低频残差回投的源像素块比例，0..1 */
  correctedBlockRatio?: number;
  /** 候选细节因色偏/反相边缘/异常高频被明显削弱的比例，0..1 */
  rejectedCandidateRatio?: number;
  /** 生产质量门禁：通过可自动入库；警告/失败只保留节点结果，需人工确认后保存 */
  qualityGate?: "passed" | "warning" | "failed";
  /** 是否达到自动进入生产资产库的标准（当前要求保真分 >= 80 且缩回误差未增加） */
  productionReady?: boolean;
  /** 面向用户的质量门禁解释 */
  qualityMessage?: string;
  /** 是否由运行看门狗自动停止，而非用户主动取消 */
  timedOut?: boolean;
  /** 节点底部一行摘要：只放关键指标（分辨率 · 耗时），详见 reportDetail 悬停 */
  report?: string;
  /** 完整运行报告（管线/门禁/Tile/显存等），节点摘要不展示，悬停 title 查看 */
  reportDetail?: string;
  /** analysisMap JSON 资产路径（内容分析契约，供矢量化节点复用） */
  analysisMapPath?: string;
  /** vectorGuide PNG 资产路径（保结构引导图契约） */
  vectorGuidePath?: string;
};

/** 本地超清放大引擎设置（Settings 新增项；normalize 浅合并给老数据补默认） */
export type EnhanceCfg = {
  defaultTarget: "4k" | "8k" | "16k";
  tileSize: number;
  tileOverlap: number;
};

/** 智能矢量（本地 VTracer 位图→SVG）节点数据 — 非破坏：输出是新 SVG 资产 */
export type VectorizeData = {
  status: RunStatus;
  error?: string;
  /** VTracer 预设：自动 / 海报色块 / 插画漫画(锐角) / 黑白 / 照片 / 线稿 */
  preset: "auto" | "poster" | "comic" | "bw" | "photo" | "line-art" | "flat";
  /** 平面拆件聚类色数与导出设置；旧节点缺省不启用色盘清理。 */
  flatColors?: number;
  exportWidthMm?: number;
  exportScale?: number;
  colorMode: "auto" | "color" | "binary";
  hierarchical: "stacked" | "cutout";
  /** 颜色精度 0=默认(随预设) / 1..10 */
  colorPrecision: number;
  /** 小碎片过滤 0=默认 */
  filterSpeckle: number;
  /** 路径坐标小数位 */
  pathPrecision: number;
  /** 几何图元识别：把圆/矩形/椭圆/圆角矩形拟合为图元，叠在 VTracer 结果上（打卡框/文化墙更干净） */
  geometry: boolean;
  /** 质量档：fast=单候选 / balanced=3 候选评分(默认) / high-fidelity=5 候选 / few-nodes=3 候选偏简化 */
  quality?: "fast" | "balanced" | "high-fidelity" | "few-nodes";
  // 运行态（result:true 写回，不增 rev）
  progress?: string;
  /** SVG 资产 assetUrl（预览/下游/拖出） */
  result?: string;
  /** SVG 文本（导出 AI/CDR/PDF 用，避免回读） */
  svg?: string;
  resultW?: number;
  resultH?: number;
  pathCount?: number;
  /** 重渲染质量门禁：true=可直接进入生产后期；false=建议人工复核/改用高保真档 */
  productionReady?: boolean;
  qualityScore?: number;
  /** 节点底部一行摘要：只放关键指标，详见 reportDetail 悬停 */
  report?: string;
  /** 完整运行报告（路径/锚点/门禁等），悬停 title 查看 */
  reportDetail?: string;
};

/** 生成节点的「历次结果」条目：每次成功出图/出片时快照一份，可回溯「第 N 次那版最好」 */
export type GenHistoryEntry = {
  ts: number;
  prompt: string;
  modelId?: string;
  /** 当时参数快照（aspect/resolution/quality/seed/size/count/duration 等，按节点类型存） */
  params: Record<string, unknown>;
  /** 当时结果（图片 dataURL 列表 / 视频 URL 列表）；大图由 blobStore 自动外置，不内联 boards.json */
  results: string[];
};

export type VideoGenData = {
  status: RunStatus;
  error?: string;
  prompt: string;
  resultUrl?: string;
  /** 并行生成的全部结果（resultUrl = resultUrls[picked]） */
  resultUrls?: string[];
  /** 当前选中的结果下标 */
  picked?: number;
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
  /** 参考模式：frame = 首帧/尾帧（默认）；reference = 全部上游图作为角色/主体参考（家族支持时） */
  refMode?: "frame" | "reference";
  /** 并行请求数 1-3：同参数同时发多条，结果进 resultUrls 可切换 */
  parallel?: number;
  /** 由备用模型生成时记录其名（徽标展示） */
  fallbackModel?: string;
  /** 历次出片记录（最近 10 次） */
  history?: GenHistoryEntry[];
};

/** 分镜：故事/剧本 → 完善 → 按风格与定调拆分镜（带时间轴），每镜独立输出口接生成节点 */
export type StoryShot = {
  /** 时间段标注，如 "0-5秒" */
  time: string;
  /** 该镜的生图/生视频提示词（已织入风格与定调） */
  prompt: string;
  /** 台词/对白（可选，如 "橘猫：欢迎光临！"；输出时附在提示词后，支持音频的视频模型会说出来） */
  line?: string;
};
export type StoryboardData = {
  status: RunStatus;
  error?: string;
  /** 故事/剧本原文（留空自动取上游文本；长剧本会先分小节整理再拆分镜） */
  story: string;
  /** 完善后的故事（可手改；拆分镜时优先用它） */
  refined?: string;
  /** 分镜数量 */
  count: number;
  /** 每镜时长（秒），用于时间轴标注与视频节点对齐 */
  shotSec: number;
  /** 风格提示词（全片统一，织入每一镜） */
  style: string;
  /** 定调：色调/画风基调（油画、胶片…） */
  tone: string;
  shots: StoryShot[];
  progress?: string;
  chatModelId?: string;
};

export type ComfyData = {
  status: RunStatus;
  error?: string;
  templateId?: string;
  /** 当前选中的子工作流分支（多分支模板时选；单分支/老模板留空走 default） */
  variantId?: string;
  params: Record<string, string | number>;
  /** 各分支独立的参数记忆（切换分支不丢参数）；键为 variantId，值为该分支的 params */
  paramsByVariant?: Record<string, Record<string, string | number>>;
  /**
   * 输入映射：图片入口 key（"nodeId.input"，与暴露参数 key 同构）→ 上游图 dataURL。
   * 精确指定「哪张上游图进哪个入口」（深度图口 / 图生图口…）；未映射的入口走默认顺序分配（旧行为零回归）。
   */
  imageSlotMap?: Record<string, string>;
  /** 运行结束后自动清理 ComfyUI 显存（/free：卸载模型+释放缓存；大工作流防堆积，代价是下次运行重新加载模型） */
  freeAfter?: boolean;
  results: string[];
  picked: number;
  /** 工作流的文本输出（ShowText 等节点），多段用空行分隔 */
  textOut?: string;
  /** 工作流的视频输出（VHS 合成等，blob URL） */
  videoResults?: string[];
  /** 历次工作流运行记录（最近 10 次） */
  history?: GenHistoryEntry[];
  progress?: string;
  /** 实时进度百分比 0-100（WebSocket 可用时才有） */
  progressPct?: number;
};

/** 文本处理（融合原「反推描述」）：上游文本/图片 → LLM 加工 → 文本 */
/** cap* 三个操作消费上游图片，其余操作消费上游文本 */
export type LlmTextOp =
  | "optimize"
  | "zh2en"
  | "expand"
  | "shorten"
  | "custom"
  | "capPrompt"
  | "capDetail"
  | "capTags";
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
  artboard?: ArtboardSpec;
  status: RunStatus;
  error?: string;
  title?: string;
  /** 图层组：成员创建顺序为底→顶；禁止瀑布流重排，按元素框合成。 */
  layerGroup?: boolean;
  /** 图层组合成与 PSD 的输出倍率；旧图层组缺省保持原尺寸。 */
  layerOutputScale?: 1 | 2 | 4;
  /** 拆解时的原海报尺寸；更换或移除背景后，元素坐标仍使用这个基准。 */
  layerCanvasSize?: { width: number; height: number };
  /** 无框组（分镜组）：默认隐藏虚线框与组头，悬停显示，成员统一尺寸严格网格贴片 */
  frameless?: boolean;
  /** 分镜组：切片 id 的分镜顺序（点击序；重排/序号/拼接都按它） */
  storyOrder?: string[];
  /** 分镜组：当前每行格数（严格网格重排用） */
  storyCols?: number;
  /** 分镜组：是否在切片上显示顺序角标 */
  showOrder?: boolean;
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

/** 设定卡整版的排版风格；auto = 按提示词描述的风格倾向自动匹配版面，其余为预设版式 */
export type CharCardStyle = "auto" | "clean" | "magazine" | "letter" | "dossier" | "guofeng" | "illustration" | "other";
/** 角色卡可产出的素材种类（每张内容不堆砌：格子少、区域大，同主题可用「补一张」自动换组追加） */
export type CharDeliverable = "turnaround" | "closeup" | "expressions" | "poses" | "outfits" | "breakdown" | "portrait" | "sheet";

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
  /** 绘画参数（按所选绘画模型家族折算；undefined = 跟随参考图/服务端默认） */
  aspect?: string;
  resolution?: string;
  quality?: string;
  /**
   * 生成套件的参考图（dataURL 列表，与「分析用图」分离）：
   * undefined = 默认用上游传入第一张图；[] = 明确不参考图；非空 = 用这些图（支持多张局部参考）。
   * 分析（视觉提炼档案）始终用上游传入图，不受此字段影响。
   */
  genRefs?: string[];
};

/* ---------------- 电商长图设计 ---------------- */
/** 长图的一个切片（视觉分析产出，含生图提示词；生成后回填 img） */
export type EcomSlide = {
  /** 切片标题（如「主图」「卖点」「细节」「规格」「场景」） */
  title: string;
  /** 该切片的生图提示词（视觉分析产出，可手动编辑） */
  prompt: string;
  /** 配套文案（产品介绍 / 卖点 / 适用人群等，展示用） */
  copy?: string;
  /** 生成后的切片图（dataURL/assetUrl） */
  img?: string;
  /** 本片实际喂给模型的参考图缩略（生成时落盘，工作台左下展示用；历史切片为空） */
  refs?: string[];
};

/** 视觉分析 JSON 产物：产品属性 + 切片规划 */
export type EcomAnalysis = {
  product: {
    name: string;
    category?: string;
    material?: string;
    color?: string;
    /** 产品特征 */
    features?: string[];
    /** 卖点 */
    sellingPoints?: string[];
    /** 适用人群 */
    audience?: string;
    /** 风格/调性概述（各切片保持统一） */
    styleTone?: string;
  };
  /** 切片规划（长度即切片数，建议 4-8） */
  slides: EcomSlide[];
};

/** 电商长图节点：产品拍照图 → 视觉分析提属性/写介绍 → 按切片数与比例拆提示词 →
 *  统一风格逐片生成 → 纵向拼接成完整长图（H5 / 详情页长图） */
export type EcomImageData = {
  status: RunStatus;
  error?: string;
  progress?: string;
  /** 输出模式：image = 全流程出图；prompt = 只分析+规划切片脚本，不调绘画模型（先审再出图，省钱） */
  outMode?: OutMode;
  /** 工作模式：product = 产品图驱动（分析产品→营销切片）；h5 = 长文案驱动（按内容切片→每段配图） */
  mode?: "product" | "h5";
  /** 固定随机种子：全片用同一 seed 生成，锁色调/笔触基底（seedream/flux/qwen 有效） */
  seed?: number;
  /** 视觉分析模型（分析产品图、产出属性与切片提示词） */
  chatModelId?: string;
  /** 绘画模型（逐片生成） */
  imageModelId?: string;
  /** 期望切片数（作为分析的提示，实际以模型返回为准）；默认 6 */
  sliceCount?: number;
  /** 切片比例（如 "3:4" / "9:16" / "1:1"）；也作为生成 aspect */
  aspect?: string;
  resolution?: string;
  quality?: string;
  /** 风格基调（喂给分析与生成，统一调性；product 模式用此） */
  styleTone?: string;
  /** H5 模式默认切片风格（h5 模式下读这个，与 product 的 styleTone 分开存） */
  h5StyleTone?: string;
  /** 用户文字描述（产品介绍/卖点/适用人群；也可从上游文本接入） */
  productDesc?: string;
  /** Step1 中间态（视觉分析产物；改绘画模型重跑不必重新分析） */
  analysis?: EcomAnalysis;
  /** 各切片（含生成图） */
  slides?: EcomSlide[];
  /** 用户在工作台上传/指定的参考图（dataURL[]，优先级最高，与上游风格参考图合并去重） */
  userRefs?: string[];
  /** Step3 最终长图（dataURL/assetUrl） */
  result?: string;
  /** 当前一轮切片与最终长图在资产库中的组 id；重生切片按槽位替换 */
  assetGroupId?: string;
  picked?: number;
};

/* ---------------- 图片直接编辑（局部重绘 / 扩图 / 增强 / 尺寸 / 裁剪 → 作用于节点自身，见 core/nodeEdit.ts） ---------------- */

/** 重绘/扩图的模型通道：
 *  auto = GPT 家族走真蒙版、其余走指令式；mask = 强制真蒙版（images/edits 的 mask 参数，需中转站如实转发）；
 *  instruct = 强制指令式（发原图 + 红色标注图，走普通图生图通道，兼容性最好） */
export type EditChannel = "auto" | "mask" | "instruct";

/** 扩图方向幅度：每边扩展比例（0 = 不扩） */
export type OutpaintPads = { left: number; right: number; up: number; down: number };

/** 尺寸调整（直接编辑）参数：mp = 目标总像素（百万）· side = 单边定长 · scale = 倍率 */
export type ResizeParams = {
  mode: "mp" | "side" | "scale";
  /** mp 模式：目标总像素（单位百万，如 1 = 约 100 万像素） */
  mp: number;
  /** side 模式：参照边 + 目标边长（另一边按比例自动算） */
  sideRef: "long" | "short" | "width" | "height";
  sideLen: number;
  /** scale 模式：缩放百分比（100 = 原尺寸；>100 放大） */
  scalePct: number;
};

/** 高清增强（直接编辑）参数 */
export type EnhanceParams = {
  /** 放大倍率（2 / 4） */
  factor: number;
  /** 增强侧重：detail = 细节纹理；face = 人物面部；none = 纯放大不加戏 */
  focus: "detail" | "face" | "none" | "flat";
};

export type AppNode = Node<Record<string, unknown>, NodeKind>;

/* 端口数据类型 */
export type PortType = "text" | "image" | "video" | "audio";

/* ---------------- 模型配置（服务商卡片） ---------------- */
/** asr = 语音识别（语音输入/通话模式用）；纯新增角色，旧配置里没有该键，加载时按未配置处理 */
export type ModelRole = "chat" | "image" | "video" | "audio" | "asr";

export type ChatProtocol = "openai" | "anthropic" | "gemini" | "ollama" | "llamacpp";
export type ImageProtocol = "openai" | "gemini";
export type VideoProtocol = "zhipu" | "siliconflow" | "openai" | "ark" | "dashscope" | "google";
export type AudioProtocol = "openai";
export type AsrProtocol = "openai";
export type AnyProtocol = ChatProtocol | ImageProtocol | VideoProtocol | AudioProtocol | AsrProtocol;
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
  /** logo：URL / dataURL / 单字符文字徽标（预设导入时携带，可空） */
  logo?: string;
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

/* ---------------- 本地 GGUF 模型（llama-server 后端） ---------------- */
// 设计原则（§5）：
//  - 独立于 ProviderCard，本地模型注册表存独立 JSON（local-gguf-models.json）
//  - 运行期通过虚拟服务商（id 前缀 "local-gguf"）注入到 resolveModelCard，复用全链路
//  - 协议 "llamacpp"：对话时由 ensureRunning 启动 llama-server，动态注入 baseUrl
//  - 不复制/移动用户的 GGUF 文件，只保存路径

/** GPU 层卸载策略：auto 让 llama-server 自行决定；正整数表示指定层数 */
export type GpuLayers = "auto" | number;

/** 推理模式：auto = 跟随模型默认；on = 强制输出 reasoning；off = 不输出 */
export type ReasoningMode = "auto" | "on" | "off";

/** 一个本地 GGUF 模型的完整注册项 */
export type LocalGgufModel = {
  /** 稳定唯一 ID（uid），也是虚拟服务商复合键的 model 段 */
  id: string;
  /** MOMO 中显示的名称（默认从文件名推断，可改） */
  name: string;
  /** GGUF 主权重文件的绝对路径 */
  ggufPath: string;
  /** 视觉投影文件（mmproj）的绝对路径；有则视为视觉模型 */
  mmprojPath?: string;
  /** 文件大小（字节，来自 fs.stat） */
  sizeBytes?: number;
  /** 量化标识（如 Q4_K_M，来自 analyzeGguf 文件名解析） */
  quantization?: string;
  /** 架构标识（如 qwen / llama，来自 analyzeGguf 文件名解析） */
  architecture?: string;
  /** 能力标记：vision 由 mmprojPath 是否存在决定，不靠模型名猜 */
  capabilities: {
    chat: true;
    vision: boolean;
    reasoning: boolean;
  };
  /** 推理后端，当前固定 llama-server */
  runtime: "llama-server";
  /** 上下文长度（默认 4096） */
  contextSize: number;
  /** GPU 卸载层数（默认 auto） */
  gpuLayers: GpuLayers;
  /** 推理模式（默认 auto） */
  reasoningMode: ReasoningMode;
  /** 上次使用的端口（优先复用，避免每次变端口） */
  port?: number;
  /** llama-server 可执行文件路径（记录上次成功用的路径；为空则用全局设置） */
  executablePath?: string;
  createdAt: number;
  updatedAt: number;
};

/** llama-server 运行期状态（来自 Rust get_local_llm_status） */
export type LocalLlmStatus = {
  modelId: string;
  modelName: string;
  running: boolean;
  port?: number;
  pid?: number;
  startedAt?: number;
};

/** 本地 GGUF 引擎配置（llama-server 路径，一次性配置后所有本地模型复用） */
export type LocalLlmCfg = {
  /** llama-server 可执行文件路径；为空表示未配置（首次使用时引导用户选择） */
  executablePath?: string;
  /** 上次探测到的版本号（诊断展示用） */
  version?: string;
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
  audio: "音频模型",
  asr: "语音识别",
};

export const PROTOCOLS: Record<ModelRole, { value: string; label: string }[]> = {
  chat: [
    { value: "openai", label: "OpenAI 兼容" },
    { value: "anthropic", label: "Anthropic Claude" },
    { value: "gemini", label: "Google Gemini" },
    { value: "ollama", label: "Ollama 本地" },
  ],
  image: [
    { value: "openai", label: "OpenAI 兼容 (images API)" },
    { value: "gemini", label: "Gemini 生图 (nano banana)" },
  ],
  video: [
    { value: "zhipu", label: "智谱 CogVideoX" },
    { value: "siliconflow", label: "硅基流动" },
    { value: "openai", label: "OpenAI 兼容 (任务轮询)" },
    // 3.3 §8 官方协议适配器（适配器已实现，填入对应 Key 后即可联调）
    { value: "ark", label: "火山方舟 Seedance（官方）" },
    { value: "dashscope", label: "阿里云 DashScope Wan（官方）" },
    { value: "google", label: "Google Gemini/Veo 视频（官方）" },
  ],
  audio: [{ value: "openai", label: "OpenAI 兼容 (audio/speech 朗读)" }],
  asr: [{ value: "openai", label: "OpenAI 兼容 (audio/transcriptions 转写)" }],
};

/* ---------------- 其他设置 ---------------- */
export type SearchProvider = "tavily" | "bocha" | "searxng" | "zhipu" | "langsearch" | "serper" | "jina";
export type SearchCfg = { provider: SearchProvider; apiKey: string; baseUrl: string; maxResults: number };
export type ImgFormat = "png" | "jpeg" | "webp";
export type SaveCfg = {
  dir: string;
  format: ImgFormat;
  pattern: string;
  autoSave: boolean;
  /** PNG 保存时嵌入元信息（提示词/模型/seed/时间，iTXt 文本块，不重编码图像） */
  embedMeta: boolean;
};
export type ComfyCfg = {
  host: string;
  /** ComfyUI 的用户工作流目录（如 …/ComfyUI/user/default/workflows）：模板往返编辑的落点 */
  workflowDir?: string;
  /** Comfy 工作流无感同步总开关（规格 §16.3 的功能开关；关掉回退旧读取路径，数据不动） */
  syncV2Enabled?: boolean;
};
export type ThemeName = "light" | "dark" | "black";

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
  | "runSelected"
  | "zoomIn"
  | "zoomOut"
  | "assets"
  | "gallery"
  | "search"
  | "spotlight"
  | "align"
  // 标题栏功能：与右上角那排按钮一一对应
  | "agent"
  | "charLib"
  | "settings"
  | "errCenter"
  | "runLog"
  | "theme"
  | "newBoard"
  | "voiceCall"
  | "director"
  // 下方工具坞：添加各类节点到视图中心（与 nodeCatalog 的条目一一对应）
  | "addImage"
  | "addVideo"
  | "addAudio"
  | "addAudioGen"
  | "addVideoDub"
  | "addPrompt"
  | "addStylePreset"
  | "addNote"
  | "addChat"
  | "addLlmText"
  | "addCombine"
  | "addImageGen"
  | "addVideoGen"
  | "addComfy"
  | "addRelight"
  | "addMultiAngle"
  | "addCharCard"
  | "addStoryboard"
  | "addEnhanceLocal"
  | "addVectorize"
  | "addEcomImage"
  | "addDirector"
  // 导演台 2.0 监看器（导演工作区内生效，方案 §7.3；数字键 1~9 切 Take 为内置行为不入表）
  | "dirPlayPause"
  | "dirPrevFrame"
  | "dirNextFrame"
  | "dirPrevSeg"
  | "dirNextSeg"
  | "dirSetIn"
  | "dirSetOut"
  | "dirApprove"
  | "dirRegen"
  | "dirPrompt";

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
  align: "对齐所选节点（多选按主轴对齐，单选吸到网格）",
  zen: "沉浸模式",
  agent: "打开/关闭创作助手",
  charLib: "打开/关闭角色库",
  settings: "打开设置",
  errCenter: "打开/关闭报错中心",
  runLog: "打开/关闭运行日志",
  theme: "切换主题（云白 → 深空蓝 → 深邃黑）",
  newBoard: "新建画布",
  voiceCall: "语音通话（开始/挂断）",
  director: "打开/关闭导演台",
  undo: "撤销",
  redo: "重做",
  duplicate: "创建副本",
  delete: "删除所选（请绑定单键）",
  runAll: "运行全部工作流",
  runSelected: "运行选中节点（焦点不在输入框时）",
  addImage: "添加节点：图片",
  addVideo: "添加节点：视频",
  addAudio: "添加节点：音频",
  addAudioGen: "添加节点：生成音频",
  addVideoDub: "添加节点：视频配音",
  addPrompt: "添加节点：提示词",
  addStylePreset: "添加节点：风格预设",
  addNote: "添加节点：备注",
  addChat: "添加节点：对话（已并入右侧「创作助手」，此绑定不再生效）",
  addLlmText: "添加节点：文本处理（已并入提示词弹窗「AI 工具」，此绑定不再生效）",
  addCombine: "添加节点：拼接文本",
  addImageGen: "添加节点：生成图像",
  addVideoGen: "添加节点：生成视频",
  addComfy: "添加节点：ComfyUI",
  addRelight: "添加节点：打光",
  addMultiAngle: "添加节点：多角度",
  addCharCard: "添加节点：角色卡",
  addEcomImage: "添加节点：电商长图",
  addStoryboard: "添加节点：分镜",
  addDirector: "添加节点：导演台",
  addEnhanceLocal: "添加节点：超清放大",
  addVectorize: "添加节点：智能矢量",
  dirPlayPause: "导演台监看器：播放/暂停",
  dirPrevFrame: "导演台监看器：上一帧",
  dirNextFrame: "导演台监看器：下一帧",
  dirPrevSeg: "导演台监看器：上一片段",
  dirNextSeg: "导演台监看器：下一片段",
  dirSetIn: "导演台监看器：设置入点",
  dirSetOut: "导演台监看器：设置出点",
  dirApprove: "导演台监看器：采用当前版本",
  dirRegen: "导演台监看器：重新生成本段",
  dirPrompt: "导演台监看器：打开最终提示词",
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
  runSelected: "enter",
  zoomIn: "=",
  zoomOut: "-",
  assets: "b",
  gallery: "h",
  search: "ctrl+f",
  spotlight: "ctrl+k",
  align: "a",
  // 标题栏功能（默认全走 Ctrl+Shift，避免和画布单键/浏览器快捷键打架）
  agent: "ctrl+shift+a",
  charLib: "ctrl+shift+c",
  settings: "ctrl+,",
  errCenter: "ctrl+shift+e",
  runLog: "ctrl+shift+l",
  theme: "ctrl+shift+t",
  newBoard: "ctrl+shift+n",
  voiceCall: "ctrl+shift+v",
  director: "ctrl+shift+d",
  // 工具坞按排列顺序对应 1~9、0，编辑/角色类用 Alt+数字
  addImage: "1",
  addVideo: "6",
  addAudio: "alt+1",
  addAudioGen: "alt+0",
  addVideoDub: "alt+v",
  addPrompt: "2",
  addStylePreset: "3",
  addNote: "4",
  addChat: "",
  addLlmText: "",
  addCombine: "alt+c",
  addImageGen: "8",
  addVideoGen: "9",
  addComfy: "0",
  addRelight: "alt+2",
  addMultiAngle: "alt+3",
  addCharCard: "alt+4",
  addEcomImage: "alt+6",
  addStoryboard: "alt+7",
  addDirector: "alt+5",
  addEnhanceLocal: "alt+8",
  addVectorize: "alt+9",
  // 导演台监看器（只在导演工作区生效；Space/箭头/IO/ARP 与 NLE 惯例一致，数字键 1~9 切 Take 为内置）
  dirPlayPause: "space",
  dirPrevFrame: "arrowleft",
  dirNextFrame: "arrowright",
  dirPrevSeg: "shift+arrowleft",
  dirNextSeg: "shift+arrowright",
  dirSetIn: "i",
  dirSetOut: "o",
  dirApprove: "a",
  dirRegen: "r",
  dirPrompt: "p",
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
   视频类：{{duration}} {{resolution}} {{aspect}} {{audio}} · {{video}} 参考视频 · {{refAudio}} 参考音频
   音频类：{{voice}} 音色
   条件块：{{?var}}…{{/var}} 变量非空时保留；{{^var}}…{{/var}} 变量为空时保留（端点切换/可选字段用） */
export type CustomProtocol = {
  id: string;
  name: string;
  /** 用途：图片 / 视频 / 音频生成（决定出现在哪个模型槽位、结果按哪种媒体处理） */
  role: "image" | "video" | "audio";
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

/* ---------------- 重试 / 用量 / 预算（稳定性与成本控制） ---------------- */
/** 重试与备用模型配置：幂等请求自动重试 + 生成类显式重试 + 耗尽换备用模型 */
export type RetryCfg = {
  /** 幂等请求（轮询/列表/搜索/下载）自动重试次数，0=关 */
  idempotentMax: number;
  /** 生成类 POST 瞬时错误重试次数，0=关（默认关：生成重试有重复扣费风险，需用户显式开） */
  submitMax: number;
  /** 退避基数 / 上限（毫秒），指数退避 + ±20% 抖动 */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** 备用模型复合键 pid::model；主模型重试耗尽后换卡再试一次。空 = 不兜底 */
  fallbackImage: string;
  fallbackVideo: string;
  fallbackAudio: string;
};

/** 单项单价（CNY），任一维度留空 = 该维度不计费 */
export type UnitPrice = {
  perCall?: number;
  perImage?: number;
  perVideoSec?: number;
  perAudioSec?: number;
  /** 每千输入 / 输出 Token */
  perIn1K?: number;
  perOut1K?: number;
};

/** 预算护栏：日预算 / 单次上限 / 确认阈值，0 = 不限制 */
export type Budget = {
  dailyCap: number;
  perRunCap: number;
  confirmOverCost: number;
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
  hotkeys: Record<HotkeyAction, string>;
  /** 资产库侧边栏快捷方式 */
  shortcuts: ShortcutItem[];
  /** 生成协议（内置预设自动绑定；.momoflow 分享包也可能携带） */
  customProtocols: CustomProtocol[];
  /** 重试与备用模型（稳定性：中转站 429/5xx/网络抖动不再让工作流白跑） */
  retry: RetryCfg;
  /** 预算护栏（超阈值确认 / 超日预算阻断） */
  budget: Budget;
  /** 单价覆盖（key=模型名前缀，最长前缀优先匹配；空 = 用内置估算） */
  pricing: { overrides: Record<string, UnitPrice> };
  /** 本地超清放大引擎（DirectML 本地推理，非破坏） */
  enhance: EnhanceCfg;
  /** 本地 GGUF 引擎配置（llama-server 路径，一次性配置） */
  localLlm: LocalLlmCfg;
  /** MOMO × Eagle 资产桥 */
  eagle: EagleCfg;
  /** MCP 服务器（Streamable HTTP；工具进能力层） */
  mcp: { servers: McpServerCfg[] };
};

export const DEFAULT_SETTINGS: Settings = {
  models: { providers: [], defaults: {} },
  search: { provider: "tavily", apiKey: "", baseUrl: "", maxResults: 5 },
  save: { dir: "", format: "png", pattern: "{date}_{time}_{model}", autoSave: false, embedMeta: true },
  comfy: { host: "http://127.0.0.1:8188", syncV2Enabled: true },
  theme: "dark",
  gpuBoost: true,
  sound: { enabled: true, speak: false, volume: 0.6 },
  hotkeys: DEFAULT_HOTKEYS,
  shortcuts: [],
  customProtocols: [],
  // submitMax 默认 0：生成类重试有重复扣费风险，需用户显式开；幂等 GET 默认重试 2 次无此问题
  retry: { idempotentMax: 2, submitMax: 0, backoffBaseMs: 500, backoffMaxMs: 8000, fallbackImage: "", fallbackVideo: "", fallbackAudio: "" },
  budget: { dailyCap: 0, perRunCap: 0, confirmOverCost: 0 },
  pricing: { overrides: {} },
  enhance: { defaultTarget: "4k", tileSize: 0, tileOverlap: 32 },
  localLlm: {},
  // 默认全关：首次启用必须明确目标根文件夹，自动写第三方软件由用户主动开启
  eagle: {
    enabled: false,
    host: "http://127.0.0.1:41595",
    apiToken: "",
    syncMode: "manual",
    autoPushGenerated: false,
    autoPullLinked: false,
    rootFolderName: "MOMO",
    pollIntervalMs: 5000,
    metadata: { name: "newer", annotation: "newer", tags: "union", rating: "newer" },
  },
  mcp: { servers: [] },
};

/* ---------------- Eagle 远端 DTO（Web API V2 宽容解析） ---------------- */

/** Eagle 单条素材的最小 DTO（raw 里没有的字段一律 optional，normalizeRemoteItem 兜底） */
export type EagleRemoteItem = {
  id: string;
  name: string;
  ext: string;
  size: number;
  width?: number;
  height?: number;
  /** Eagle 库内文件路径（V2 raw 不带，按 {库}/images/{id}.{ext} 推导） */
  filePath?: string;
  tags: string[];
  folders: string[];
  annotation?: string;
  url?: string;
  star: number;
  btime?: number;
  mtime?: number;
  modificationTime?: number;
  /** Eagle 端"任何修改"都会前移的时间戳（实测改名/评分只动它，不动 modificationTime）——增量扫描主游标 */
  lastModified?: number;
  isDeleted?: boolean;
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

/* ---------------- ComfyUI 模板（v2：支持子工作流分支） ---------------- */
export type ComfyWfNode = {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
  /** 节点在 ComfyUI 画布上的位置（前端格式导入/往返编辑时保留；API 格式导入为自动布局估算值） */
  pos?: [number, number];
  /** 节点在 ComfyUI 画布上的尺寸（同上，推回 ComfyUI 时不至于全部默认尺寸堆叠） */
  size?: [number, number];
};

export type ComfyParamKind = "text" | "number" | "seed" | "image" | "toggle";

export type ComfyExposedParam = {
  key: string; // `${nodeId}.${input}`
  nodeId: string;
  input: string;
  label: string;
  kind: ComfyParamKind;
  value: string | number | boolean;
  /** combo 类型参数的可选项（来自 ComfyUI /object_info；有则渲染为下拉选择器，否则文本框） */
  options?: string[];
};

/** 子工作流分支的语义色名（样式通过主题 token + color-mix 生成，不硬编码 rgba） */
export type ComfyVariantColor = "blue" | "green" | "orange" | "purple" | "cyan" | "pink";

/** 子工作流分支的输入/输出能力标识，供后续导演台配方与绑定向导使用 */
export type ComfyCapability =
  | "text-to-image"
  | "image-to-image"
  | "text-to-video"
  | "image-to-video"
  | "first-last-to-video"
  | "reference-to-video"
  | "video-to-video"
  | "custom";

/** 语义槽标识：首帧/尾帧/角色参考/提示词等，供后续语义绑定使用 */
export type ComfySemantic =
  | "prompt"
  | "negativePrompt"
  | "firstFrame"
  | "lastFrame"
  | "referenceImage"
  | "referenceVideo"
  | "referenceAudio"
  | "layoutGuide"
  | "poseGuide"
  | "characterRef"
  | "shotScale"
  | "lighting"
  | "controlVideo"
  | "duration"
  | "width"
  | "height"
  | "fps"
  | "seed"
  | "loraName"
  | "loraStrength"
  | "custom";

/** 语义槽在 ComfyUI 工作流中的具体绑定位置 */
export type ComfySlotBinding = {
  nodeId: string;
  input: string;
  index?: number;
};

/** 一个语义槽的完整定义（属于具体 variant，不挂在整个模板上） */
export type ComfySemanticSlot = {
  id: string;
  label: string;
  semantic: ComfySemantic;
  media: "text" | "image" | "video" | "audio" | "number" | "boolean";
  required: boolean;
  maxItems?: number;
  bindings: ComfySlotBinding[];
};

/** 子工作流分支：一个工作流文件可拆成多个可命名、着色、独立运行的分支 */
export type ComfyVariant = {
  id: string;
  name: string;
  color: ComfyVariantColor;
  /** 归属此分支的节点 id（其余节点不参与本分支提交） */
  nodeIds: string[];
  /** 本分支的输出节点 id（可多个） */
  outputNodeIds: string[];
  /** 被多个分支共享的节点 id（如模型加载节点） */
  sharedNodeIds?: string[];
  /** 本分支内仍需忽略的节点（沿用现有 pruneDisabled 安全逻辑） */
  disabledNodes?: string[];
  /** 本分支暴露的可调参数（与顶层 params 同构） */
  params: ComfyExposedParam[];
  /** 语义槽（首版为空数组，阶段 1+ 的绑定向导填充） */
  slots?: ComfySemanticSlot[];
  /** 分支能力标识（阶段 1+ 填充） */
  capability?: ComfyCapability;
  /** 语义槽校验时间戳（工作流指纹变化后失效） */
  verifiedAt?: number;
  /** 工作流结构指纹（用于检测工作流内容变化后让 verifiedAt 失效） */
  fingerprint?: string;
};

export type ComfyTemplate = {
  id: string;
  name: string;
  workflow: Record<string, ComfyWfNode>;
  /** v1 兼容字段：无 variants 时作为「默认分支」的参数来源 */
  params: ComfyExposedParam[];
  /** v1 兼容字段：无 variants 时作为「默认分支」的输出节点 */
  outputNodeId?: string;
  /** v1 兼容字段：被忽略的节点，运行时剔除，下游自动跨接到其上游 */
  disabledNodes?: string[];
  createdAt: number;
  /** v2：子工作流分支。无此字段或空数组时，comfyStore 加载会生成一个 default 分支 */
  variants?: ComfyVariant[];
  /** Comfy 工作流同步：关联的同步工作流 id（有值 = 该模板由同步服务派生/维护，源文件改了自动跟） */
  workflowId?: string;
};

/* ---------------- Comfy 工作流无感同步（插件规格 v1.0 · M1） ---------------- */

/** 同步模式（规格 §8）：默认 comfy_master（ComfyUI 主控，MOMO 只读，绝不写回） */
export type ComfySyncPolicy = "comfy_master" | "bidirectional" | "momo_master" | "manual";

/** 工作流同步状态（规格 §6.4） */
export type ComfySyncStatus =
  | "untracked" // 扫描发现但用户尚未勾选同步
  | "pending_import" // 已勾选、排队首次入库
  | "syncing" // 正在同步
  | "synced" // 已同步，与源一致
  | "source_changed" // 源有改动待同步（自动模式会立刻消费掉，通常停留极短）
  | "invalid" // 源文件当前不是有效 JSON / 不被识别（旧版本继续可用）
  | "source_offline" // 所属来源离线
  | "source_deleted" // 源文件被删除（快照与模板保留）
  | "detached" // 所属来源被删除（数据保留为 MOMO 本地副本，可重新关联）
  | "paused" // 用户暂停同步
  | "derive_failed"; // UI Workflow 已入库但 API Prompt 派生失败（多为 ComfyUI 离线/缺节点）

/** 来源路径形态 */
export type ComfySyncSourceKind = "local" | "removable" | "mapped_drive" | "unc";

/** 同步来源（规格 §9.1）：一个 ComfyUI 工作流目录 */
export type ComfySyncSource = {
  id: string;
  name: string;
  /** workflows 目录的绝对路径 */
  rootPath: string;
  kind: ComfySyncSourceKind;
  enabled: boolean;
  includeSubdirectories: boolean;
  /** 自动跟踪该来源新增的工作流（用户授权后才开，规格 FR-003） */
  autoTrackNewWorkflows: boolean;
  defaultPolicy: ComfySyncPolicy;
  /** 是否允许写回（M1 恒为 false；M2 双向同步的开关位） */
  allowWriteBack: boolean;
  ignorePatterns: string[];
  lastScanAt?: number;
  lastOnlineAt?: number;
  status: "online" | "offline" | "permission_denied" | "scanning";
};

/** 同步工作流的索引记录（正文与版本快照在 AppData/comfy-sync，由 Rust 读写） */
export type ComfySyncedWorkflow = {
  workflowId: string;
  sourceId: string;
  relativePath: string;
  absolutePath: string;
  displayName: string;
  format: "ui_v04" | "api_only";
  policy: ComfySyncPolicy;
  status: ComfySyncStatus;
  /** 源文件当前内容 SHA-256 */
  sourceHash: string;
  /** 上次成功入库的内容哈希（同步基线） */
  baseHash: string;
  /** 语义哈希（键排序后；识别“仅格式化/无关字段变化”与改名对账用） */
  semanticHash?: string;
  /** 结构指纹（节点类型序列+连线数；改名/移动识别的弱匹配信号） */
  structureFingerprint?: string;
  /** UI Workflow 自带的顶层 id（ComfyUI 1.x 保存通常有；身份识别优先级之一） */
  graphId?: string;
  revision: number;
  sourceModifiedAt: number;
  syncedAt?: number;
  /** 文件 stat 快照（mtime/size 变了才读正文算哈希，省 IO） */
  statSize?: number;
  statMtimeMs?: number;
  warnings: string[];
  /** 用户标记永久保留的版本号（版本清理策略，规格 FR-013） */
  pinnedRevisions?: number[];
  /** 由该工作流派生的模板 id（comfy-templates 里的关联） */
  templateId?: string;
  /** M2：上次派生时的参数基线值（key=`nodeId.input`→值）。写回时与模板当前值 diff 出补丁；
   *  也是字段级三方合并里「双方共同基线」（规格 FR-015） */
  baseParamValues?: Record<string, unknown>;
}

/** M2 写回的一条参数补丁（与 writeBack.ts 的 ParamPatch 同构；types 为唯一类型源） */
export type ComfyParamPatch = {
  key: string;
  nodeId: string;
  input: string;
  value: unknown;
  label?: string;
};

/** M2 写回冲突（规格 FR-015 / §11.3）。正文不落索引：基线从版本快照取、源文本解决时现读 */
export type ComfySyncConflict = {
  id: string;
  workflowId: string;
  createdAt: number;
  /** 基线对应的版本号（快照即双方上次同步内容） */
  baseRevision: number;
  /** MOMO 侧待写回的参数补丁 */
  patches: ComfyParamPatch[];
  /** 字段级冲突明细（双方同字段不同值） */
  fields: Array<{ key: string; label?: string; baseValue: unknown; sourceValue: unknown; momoValue: unknown }>;
  status: "open" | "resolved";
  resolvedAt?: number;
  resolution?: "source" | "momo" | "exported" | "later";
};;

/** 同步中心可见的一次同步事件（最近事件列表，规格 NFR-005） */
export type ComfySyncEventLog = {
  id: string;
  workflowId?: string;
  sourceId?: string;
  level: "info" | "warn" | "error";
  event: string;
  message: string;
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

/* ---------------- .momoflow 分享包（v2：可内嵌素材） ---------------- */
/** 导入时检测对方缺少的服务商配置 */
export type MomoflowRequires = {
  /** 需要的模型名列表（提示对方在「模型配置」补齐） */
  models: string[];
  /** 随包附带的协议（密钥留空，对方按需填） */
  protocols?: CustomProtocol[];
};
/** .momoflow 文件载荷：v1 纯模板；v2 可内嵌素材（大图收进 assets，节点 data 用 momoblob:<hash> 引用） */
export type MomoflowPayload = {
  app: "momo-canvas";
  type: "boardflow";
  version: 2;
  template: BoardTemplate;
  /** hash → dataURL（含素材导出时存在；导入时回填到节点 data） */
  assets?: Record<string, string>;
  /** 对方导入时缺这些配置会被提示 */
  requires?: MomoflowRequires;
};
/** 导入结果：用于在 UI 提示缺失的服务商/协议配置 */
export type ImportResult = {
  name: string;
  missing: { models: string[]; protocols: CustomProtocol[] };
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
/** vector = 矢量文件（SVG）：智能矢量节点产物 / 导入的 .svg，单独分类 */
export type AssetKind = "image" | "video" | "audio" | "pdf" | "vector" | "other";

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
  /** 随机种子（Remix/复现用） */
  seed?: number;
  /** 负向提示词 */
  negative?: string;
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
  /** 资产册中的中文生成提示词；与 promptEn 成对保存，不互相覆盖 */
  promptZh?: string;
  /** 资产册中的英文生成提示词；H3/MOMO 执行时优先使用英文空间说明 */
  promptEn?: string;
  /** 资产册稳定编号，如 SCENE-01 / LAYOUT-03 */
  catalogId?: string;
  /** 资产册来源 MD 的绝对路径或浏览器相对标识 */
  catalogSource?: string;
  /** 资产册声明的用途：普通外观参考或仅用于空间规划的站位图 */
  catalogRole?: "appearance" | "spatialLayout";
  /** 资产册「使用分段」（1-based 片段序号；-1 = 全部片段）——剧本重拆后按它把资产重新绑回参考槽 */
  catalogSegments?: number[];
  /** 站位图的中文空间锁；不等同于生图提示词 */
  spatialLockZh?: string;
  /** 站位图的英文空间锁；图片槽不足时转为文字继续约束视频 */
  spatialLockEn?: string;
  model?: string;
  folderId?: string | null;
  /** 标签（去重、保序） */
  tags?: string[];
  /** 来源：canvas 生成 / import 导入 / eagle 拉回 */
  source: "canvas" | "import" | "eagle";
  /** Eagle 端评分（0~5，未同步过无此字段） */
  rating?: number;
  /** Eagle 端说明（annotation 的本地镜像，双向按策略合并） */
  annotation?: string;
  /** 生成参数快照（画布生成物才有）：资产卡「Remix」按此还原生成节点 */
  gen?: AssetGenMeta;
  /** 该资产来自哪个画布生成节点（资产卡「定位到画布节点」用；老资产无此字段） */
  nodeId?: string;
  /** 同一次生成的多个结果共用；资产库据此折叠成一张组卡片 */
  groupId?: string;
  /** 组卡片标题；同组成员保持一致 */
  groupLabel?: string;
  /** 普通多图生成 / 电商长图切片组 */
  groupKind?: "generation" | "ecom";
  /** 组内稳定槽位；电商切片重生时替换原槽位，避免同组堆积旧版本 */
  groupSlot?: string;
  /** 组卡封面优先级：电商最终长图为 true */
  groupCover?: boolean;
  /** 导演台来源（可选，资产库可按导演项目/片段分组定位，方案 §8.3） */
  director?: {
    projectId: string;
    sceneId?: string;
    segmentId?: string;
    takeId?: string;
    role?: "firstFrame" | "lastFrame" | "reference" | "generated" | "export" | "previz" | "audio";
  };
  /** 内容指纹（导演台参考图去重用：同一 dataURL 反复同步只收录一次） */
  contentHash?: string;
  /** 3.5 P2：项目文件夹镜像路径（绑定目录后产物写入项目目录的绝对路径；未绑定为空） */
  projectRelPath?: string;
  /** 3.5：多项目镜像账本（同一去重资产被多个项目引用时，每个项目各自的落盘路径；键 = projectId） */
  projectMirrors?: Record<string, string>;
  /** 收藏：资产库「收藏」筛选置顶展示 */
  fav?: boolean;
  /** 回收站时间戳：非空 = 在回收站里（删除不再直接删文件，等彻底清理） */
  deletedAt?: number;
  /** 生成耗时（毫秒，画布生成物才有；老资产无此字段，卡片角标判空） */
  durationMs?: number;
  /** Eagle 绑定信息（同步过才写；重启后据此恢复绑定） */
  eagle?: EagleAssetLink;
  /** 版本谱系（Eagle 端编辑拉回/衍生导入时保留原资产并挂到谱系上） */
  lineage?: AssetLineage;
  createdAt: number;
};

/* ---------------- MOMO × Eagle 资产桥 ---------------- */

/** 同步模式：manual 手动 / push 只推送 / bidirectional 双向 */
export type EagleSyncMode = "manual" | "push" | "bidirectional";

/** 元数据冲突策略（字段级：谁赢 / 合并） */
export type EagleMetaPolicy = {
  name: "momo" | "eagle" | "newer";
  annotation: "momo" | "eagle" | "newer";
  tags: "union" | "momo" | "eagle";
  rating: "momo" | "eagle" | "newer";
};

export type EagleCfg = {
  enabled: boolean;
  host: string;
  /** Eagle API Token（Eagle 偏好 → 开发者里可查；非空时 DPAPI 加密落盘） */
  apiToken: string;
  syncMode: EagleSyncMode;
  autoPushGenerated: boolean;
  autoPullLinked: boolean;
  rootFolderId?: string;
  rootFolderName: string;
  pollIntervalMs: number;
  metadata: EagleMetaPolicy;
};

/** MCP 服务器（Streamable HTTP）——连接后工具自动注册进能力层，创作助手 tool 动作可调 */
export type McpServerCfg = {
  id: string;
  name: string;
  /** Streamable HTTP 端点（如 https://example.com/mcp）；stdio 服务器暂不支持 */
  url: string;
  enabled: boolean;
  /** 附加请求头（远程 MCP 的鉴权，如 { Authorization: "Bearer xxx" }） */
  headers?: Record<string, string>;
};

/** 资产 ↔ Eagle 项目 的绑定状态机 */
export type EagleLinkState =
  | "synced"
  | "queued"
  | "pushing"
  | "pulling"
  | "local-dirty"
  | "remote-dirty"
  | "conflict"
  | "offline"
  | "error";

export type EagleAssetLink = {
  /** 对素材库路径规范化后的稳定指纹，不假设 Eagle 提供 libraryId */
  libraryKey: string;
  libraryName?: string;
  itemId: string;
  /** MOMO 生成的配对标识（主账本在本地映射） */
  pairId: string;
  linkedAt: number;
  lastRemoteModifiedAt?: number;
  lastLocalFingerprint?: string;
  lastRemoteFingerprint?: string;
  state: EagleLinkState;
  /** 最近一次错误摘要（角标 hover 说明用） */
  error?: string;
};

/** 非破坏版本谱系：原资产保留，新版本沿 parentAssetId 挂链 */
export type AssetLineage = {
  parentAssetId?: string;
  rootAssetId: string;
  revision: number;
  reason?: "eagle-edit" | "momo-regenerate" | "plugin-derived" | "manual-import";
};

export type AssetFolder = { id: string; name: string };

/* ---------------- 导演台（Director）---------------- */
//
// 方案 §5 数据层级：Project → Scene → Segment → Shot → Take
// 本轮（项目壳切片）只实现最小结构，后续切片逐步填充 scenes/segments/takes/recipes/timeline。
// 节点 data 只保存项目引用（projectId），完整项目数据由 directorStore 独立持久化到 director-projects.json。

/** 画布上的导演台节点 data（极简：只存项目引用 + 摘要字段） */
export type DirectorData = {
  status: RunStatus;
  error?: string;
  /** 关联的导演项目 id（directorStore 里的 DirectorProject.id） */
  projectId?: string;
  /** 当前成片地址（导出后写回，作为视频输出口的值） */
  outputUrl?: string;
  /** 成片封面 */
  cover?: string;
  /** 进度文案（如「生成中 3/8」） */
  progress?: string;
};

/** 导演角色（人物连续性描述） */
export type DirectorCharacter = {
  id: string;
  name: string;
  /** 外观与服装说明（连续性约束） */
  continuity: string;
  /** 角色参考图资产 id（可选，从角色卡/资产库拖入） */
  assetIds?: string[];
  /* —— 3.0 角色库实体扩展（全部可选，v2 数据无感升级，方案 §6.3）—— */
  /** 基础身份一句话（年龄/体型/气质锚点） */
  identity?: string;
  /** 外貌锚点（五官/发型/肤色等固定特征，独立于服装） */
  appearanceAnchors?: string;
  /** 服装组（多套外观，如 日常 / 夜行 / 受伤），每套含说明与参考图 */
  outfits?: Array<{ id: string; name: string; desc: string; assetIds?: string[] }>;
  /** 参考图分类槽：正面/侧面/全身/表情/动作 */
  refViews?: Record<string, string[]>;
  /** 声音参考说明（音色描述/演员参考） */
  voiceDesc?: string;
  /** 默认 TTS 音色（audio 角色模型 voice） */
  ttsVoice?: string;
  /** 修订版本号（每次保存 +1；片段快照记当时的 rev，用于「角色来源已更新」判定） */
  rev?: number;
  /** 锁定身份：角色同步不覆盖其出场片段的提示词 */
  locked?: boolean;
  updatedAt?: number;
};

/** 镜头（片段内的景别/机位/剪辑变化，方案 §5） */
export type DirectorShot = {
  id: string;
  startSec: number;
  endSec: number;
  /** 景别：大全景/全景/中景/近景/特写 */
  shotSize: string;
  /** 摄影机/运镜 */
  camera: string;
  /** 动作描述 */
  action: string;
  /** 音频提示（对白/音效/音乐） */
  audio: string;
};

/** 生成片段（一次视频模型任务，方案 §5） */
export type DirectorSegment = {
  id: string;
  sceneId: string;
  durationSec: number;
  summary: string;
  /** 对白原文（逐句） */
  dialogue: string[];
  shots: DirectorShot[];
  /** 承接上一段的连续性说明 */
  continuityIn?: string;
  /** 本段结束状态（供下一段继承） */
  continuityOut?: string;
  /** 对应的原文范围（字符起止，防 LLM 丢段） */
  scriptRange?: [number, number];
  /** 用户锁定的片段（重新拆分时不覆盖） */
  locked?: boolean;
  /** 该片段采用的 Take id（null = 未选片） */
  approvedTakeId?: string | null;
  /** 该片段的所有 Take（图片/视频版本） */
  takes?: DirectorTake[];
  /** 片段级素材槽（首帧/尾帧/角色参考/动作参考，覆盖项目全局槽） */
  slots?: DirectorSlotValue[];
  /** 片段级生成配方 id（覆盖项目默认） */
  recipeId?: string;
  /** 片段级提示词覆盖 */
  promptOverride?: string;
  /** 最终提示词覆盖（编辑「预览最终提示词」所得的整段最终文本）：生成时跳过风格/Skill/负向的自动拼接，只前置参考素材编号说明 */
  promptFinalOverride?: string;
  /** 分段识别出的视频规格（分辨率/帧率/时长 + 来源原文；3.5） */
  videoSpec?: SegmentVideoSpec;
  /** H3 双语提示词（3.5 P3：中文审阅稿 + 英文执行稿；英文是模型请求真相） */
  h3Prompt?: H3BilingualPrompt;
  /** 中文写作与英文待审稿；采用前不进入模型执行请求。 */
  h3Authoring?: { zh: string; rules: string; enDraft?: string; reviewDraft?: string; baseEn?: string; context?: string; problems?: string[] };
  /** 分离锁（3.5：结构锁 ≠ 执行稿锁；旧 locked 迁移为 structure） */
  locks?: SegmentLocks;
  /** 该片段的剧本原文（规则切段时留存，供 AI 精读/重拆取全文；直录段不用——原文即 promptOverride） */
  scriptText?: string;
  /* —— 3.3 §7：model-adapter 阶段产物快照（哪版 Skill、按什么模式合同精炼的）—— */
  refinedBy?: { at: number; skills: string; mode: string };
};

/** 场景（同一地点/时间/戏剧事件，方案 §5） */
export type DirectorScene = {
  id: string;
  location: string;
  segments: DirectorSegment[];
  /** 场景级连续性规则（光线/色调/环境音） */
  continuityRule?: string;
};

/** 素材槽值（方案 §7.7） */
export type DirectorSlotValue = {
  semantic: ComfySemantic;
  /** 绑定的资产 id 列表（多参考时有序） */
  assetIds: string[];
  /**
   * 是否上游自动同步产物。缺省视为 true（旧数据槽位全是同步产物，断开上游会被清理）；
   * 手动添加的槽位必须显式设为 false，同步清理时保留。
   */
  auto?: boolean;
  /** 展示名（refsNote 编号说明里替代语义默认名；尾帧接力的虚拟槽用它标「上一段尾帧」） */
  label?: string;
  /** 普通外观参考或空间站位规划图；后者不得把俯视图、箭头、标签画进成片 */
  referenceRole?: "appearance" | "spatialLayout";
  /** 来自资产册的稳定编号，用于重复导入时原位同步而非堆叠 */
  catalogId?: string;  /** 自动空间接力素材：桥接帧或上一段末尾动作片段；关闭接力时保留资产但不参与生成 */
  relayKind?: "frame" | "clip";
  /** 接力素材来自哪个已完成 Take；相同来源重跑时复用，避免重复截取与落盘 */
  relaySourceTakeId?: string;
};

/** 生成配方（方案 §7.5 / §20.1）；3.3 §4.2：模式补全（l2v 仅尾帧反推等） */
export type DirectorRecipe = {
  id: string;
  name: string;
  engine: "comfy" | "provider";
  output: "image" | "video";
  mode: "t2i" | "i2i" | "t2v" | "i2v" | "fl2v" | "l2v" | "r2v" | "audio2v" | "extend" | "v2v" | "edit";
  /** ComfyUI 配方：模板 + 子分支 */
  templateId?: string;
  variantId?: string;
  /** 远程配方：服务商模型复合键 */
  providerModelKey?: string;
  /** 能力快照（切换配方时检查兼容性） */
  capabilitySnapshot?: {
    maxDurationSec?: number;
    durations?: number[];
    aspects?: string[];
    resolutions?: string[];
    firstFrame: boolean;
    lastFrame: boolean;
    referenceImages: number;
    referenceVideos: number;
    referenceAudio: number;
    nativeAudio: boolean;
  };
  defaultParams: Record<string, string | number | boolean>;
};

/** 版本快照（方案 §7.9，不可变） */
export type DirectorTake = {
  id: string;
  segmentId: string;
  kind: "image" | "video";
  target: "storyboard" | "firstFrame" | "lastFrame" | "clip";
  status: "queued" | "running" | "done" | "error" | "cancelled";
  assetId?: string;
  error?: string;
  promptSnapshot: string;
  recipeSnapshot?: DirectorRecipe;
  slotSnapshot?: DirectorSlotValue[];
  paramSnapshot?: Record<string, unknown>;
  /* —— 3.5：统一视频规格快照（请求值/实际值/来源/调整，可追溯）—— */
  requestedVideoSpec?: ResolvedVideoSpec["requested"];
  appliedVideoSpec?: ResolvedVideoSpec["applied"];
  videoSpecSources?: ResolvedVideoSpec["source"];
  videoSpecAdjustments?: ResolvedVideoSpec["adjustments"];
  workflowFingerprint?: string;
  createdAt: number;
  /** 开始执行时刻（区别于 createdAt 的入队时刻；耗时展示用它算，排队等待不计入） */
  startedAt?: number;
  /** 结束时间戳（done/error/cancelled 时写入；与 startedAt 差值即生成耗时，版本卡展示用） */
  finishedAt?: number;
  /** 是否标记采用（进入时间线） */
  approved?: boolean;
  /** 星标/备注 */
  starred?: boolean;
  note?: string;
  /** 派生来源：本 Take 是从哪个原始 Take 经后处理派生而来（派生链，方案 §20.5） */
  derivedFrom?: { takeId: string; postRecipeId: string; postRecipeName: string };
  /** 生成时实际执行的 Skill 栈快照（方案 §17.4：结果可追溯用的是哪个版本规则） */
  skillSnapshots?: SkillRunSnapshot[];
};

/** 全局/场景/片段规则（方案 §20.4） */
export type DirectorRuleSet = {
  name: string;
  positive: {
    style?: string;
    visualTone?: string;
    lighting?: string;
    cameraLanguage?: string;
    sceneContinuity?: string;
    promptPrefix?: string;
    promptSuffix?: string;
  };
  negative: {
    noSubtitles?: boolean;
    noWatermark?: boolean;
    noBackgroundMusic?: boolean;
    noDialogue?: boolean;
    noText?: boolean;
    extra?: string[];
  };
  generation: {
    aspect?: string;
    resolution?: string;
    fps?: number;
    nativeAudio?: boolean;
  };
};

/* —— 3.5 统一视频规格：严格限定分辨率/帧率/时长三项（方案 §6）—— */
export type VideoResolution = {
  /** 标准标签（1080p / 1920×1080） */
  label: string;
  width?: number;
  height?: number;
};

export type VideoSpecValues = {
  resolution?: VideoResolution;
  fps?: number;
  durationSec?: number;
};

export type VideoSpecSource = "segment-title" | "segment-metadata" | "segment-body" | "project-prefix" | "project-default" | "recipe-default" | "user";

/** 分段识别出的规格与命中来源（原文可核对） */
export type SegmentVideoSpec = VideoSpecValues & {
  sources?: Partial<Record<keyof VideoSpecValues, { kind: VideoSpecSource; raw: string; line?: number }>>;
  /** 用户手动覆盖的项（逐项独立；恢复自动 = 删掉对应字段）。手改后 source 必须是 "user" */
  user?: VideoSpecValues;
};

/** 项目统一默认规格（未识别出分段值时的兜底） */
export type VideoSpecDefaults = {
  resolution?: VideoResolution;
  fps?: number;
  /** 仅作为未识别出分段时长时的默认值 */
  durationSec?: number;
};

/** resolveVideoSpec 的最终结果：请求值/实际值/逐项来源/引擎调整。
 *  applied 只写「真实注入成功」的项——引擎不支持或模板没有对应入口时该项缺省，
 *  差异必须出现在 adjustments 里（applied 为 null），不允许把 requested 复制成 applied。 */
export type ResolvedVideoSpec = {
  requested: { resolution: VideoResolution; fps: number; durationSec: number };
  applied: { resolution?: VideoResolution; fps?: number; durationSec?: number };
  source: Partial<Record<keyof VideoSpecValues, VideoSpecSource>>;
  adjustments: Array<{ field: "resolution" | "fps" | "durationSec"; requested: unknown; applied: unknown; reason: string }>;
};

/* —— 3.5 P3：H3 双语提示词 —— */
/** 单语言的 H3 结构化提示词（六段式的确定性提取结果） */
export type H3PromptLanguageData = {
  title: string;
  purpose?: string;
  continuityMode?: "opening" | "continuity_relay" | "hard_cut";
  continuityIn?: string;
  spatialLock?: string;
  continuityOut?: string;
  /** 参考提及顺序（RefImgN / <Picture N> 计划） */
  referenceOrder?: string[];
  characters?: string;
  scene?: string;
  props?: string;
  /** 原语言对白（<d>[语言]…</d> 或 Dialogue 行；TTS/字幕真源） */
  dialogue?: string[];
  camera?: string;
  /** 提示词正文（英文执行稿 = 模型请求真相；中文审阅稿仅供人读） */
  promptBody: string;
};

export type H3BilingualPrompt = {
  zh?: H3PromptLanguageData;
  /** 中文审阅稿待确认草稿：模型生成后对白校验未过时暂存（不覆盖已有 zh），用户核对后升级或丢弃 */
  zhDraft?: H3PromptLanguageData;
  en: H3PromptLanguageData;
  source: "paired-files" | "skill" | "manual" | "legacy";
  syncStatus: "synced" | "zh-newer" | "en-newer" | "conflict";
  generatedAt?: number;
};

export type SegmentLocks = {
  /** 结构锁：禁止重新拆段/删除/重排（成品直录默认开） */
  structure: boolean;
  /** 中文审阅稿锁 */
  reviewZh: boolean;
  /** 英文执行稿锁：任何 Skill/角色同步都不得改写，只标过期 */
  executionEn: boolean;
};

/** 3.5 项目文件夹绑定（P2 落地；类型先行） */
export type DirectorWorkspaceBinding = {
  mode: "managed" | "linked";
  rootPath: string;
  sourceScriptPath?: string;
  sourceScriptHash?: string;
  manifestPath: string;
  /** 资产册相对路径（相对 rootPath，如 "资产提示词.md" / "全部素材/资产提示词.md"）——绝不存 Markdown 内容 */
  assetCatalogPath?: string;
  segmentRootPath?: string;
  lastIndexedAt?: number;
  indexFingerprint?: string;
  status: "ready" | "missing" | "changed" | "conflict";
  writePolicy: "copy-into-project" | "reference-in-place";
  /** 绑定即导入的指纹（重复绑定同一目录幂等：内容没变就跳过对应导入步骤） */
  imported?: {
    fullScriptHash?: string;
    segEnHash?: string;
    segZhHash?: string;
    assetCatalogHash?: string;
    at: number;
  };
};

/** 时间线条目（采用版本顺序，方案 §7.10） */
export type DirectorTimelineEntry = {
  segmentId: string;
  takeId: string;
  /** 实际时长（秒，来自采用 Take） */
  durationSec: number;
  /** 入点/出点（可选裁切，默认整段） */
  inSec?: number;
  outSec?: number;
};

/** 后处理配方（方案 §20.5）：放大/补帧/修复分支 */
export type DirectorPostRecipe = {
  id: string;
  name: string;
  kind: "upscale-image" | "upscale-video" | "interpolate" | "denoise" | "restore" | "custom";
  templateId: string;
  variantId: string;
  inputKind: "image" | "video";
  outputKind: "image" | "video";
  defaultParams: Record<string, unknown>;
};

/** 音频绑定类型（方案 §23.5） */
export type DirectorAudioKind = "dialogue" | "narration" | "sfx" | "ambient" | "music";

/** 音频绑定（绑定到镜头/场景/剧情事件，方案 §23.5） */
export type DirectorAudioTrack = {
  id: string;
  kind: DirectorAudioKind;
  /** 绑定的片段 id（dialogue/narration/sfx）；ambient/music 绑定场景，可为空 */
  segmentId?: string;
  /** 绑定的场景 id（ambient/music） */
  sceneId?: string;
  /** 文本内容（对白/旁白/音效描述） */
  text: string;
  /** 音色（TTS voice） */
  voice?: string;
  /** 语速（TTS speed） */
  speed?: number;
  /** 情绪/语气标注 */
  emotion?: string;
  /** 生成的音频资产 id */
  assetId?: string;
  /** 多版本（同一句台词的多个 Take） */
  takes?: Array<{ id: string; assetId?: string; note?: string }>;
  /** 采用的版本 id */
  approvedTakeId?: string;
  /* —— 后期混音参数（成片工作区音轨，方案 §12.3）—— */
  /** 轨道音量（0~1.5，默认 1） */
  volume?: number;
  muted?: boolean;
  /** 淡入/淡出秒数 */
  fadeIn?: number;
  fadeOut?: number;
};

/** 导演项目（保存在 directorStore，不进画布 node.data） */
export type DirectorProject = {
  id: string;
  /** 关联的画布节点 id（删除节点时用于定位项目） */
  nodeId: string;
  /** 关联的画布 id（切换画布后结果仍写回正确位置） */
  boardId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** 目标成片时长（秒） */
  targetDurationSec: number;
  /** 画幅，如 "16:9" */
  aspect: string;
  /** 目标像素（百万）：与 aspect 换算宽高，写入工作流的 megapixels/宽/高参数；缺省 1.0 */
  resolutionMP?: number;
  /** 成片检查·高清放大的参数覆盖：模板 id → 参数键值（未填的用模板默认值） */
  upscaleParams?: Record<string, Record<string, string | number | boolean>>;
  /** 剧本/故事文本 */
  script: string;
  /** 剧本导入设置（方案 §20.2） */
  scriptImport?: {
    format: "text" | "markdown" | "json";
    mode: "strict" | "preserve-and-split" | "advisory";
    /** 自定义分段标记：行内含此文本即在该行处切段 */
    delimiter?: string;
    /** 自定义分场标记：行内含此文本即在该行处切场（分层：场 → 片段） */
    sceneDelimiter?: string;
  };
  characters: DirectorCharacter[];
  scenes: DirectorScene[];
  recipes: DirectorRecipe[];
  /** 项目全局素材槽（所有片段继承） */
  globalSlots: DirectorSlotValue[];
  /** 手动排除的上游参考图资产 id（不再自动同步进槽位） */
  refExcluded?: string[];
  /** 参考图接入点记忆：资产 id → 上次配置的语义（上游断开重连后恢复原接入点，不回落默认参考图） */
  refSemMemory?: Record<string, ComfySemantic>;
  /** 项目级规则 */
  ruleSet?: DirectorRuleSet;
  /** 批量生成时每段结束后自动清理 ComfyUI 显存（大工作流防显存堆积，代价是下一段重新加载模型） */
  freeMemBetween?: boolean;
  /** 空间接力：从相邻上一段采用/最新成功 Take 自动提取稳定桥接帧，并在配方支持时截取末尾 2 秒动作视频，填入下一段参考槽；关闭时接力资产保留但不参与生成 */
  tailFrameRelay?: boolean;
  /** 最近一次导入的双语资产册来源与时间，仅用于重导提示和追溯 */
  assetCatalogSource?: string;
  assetCatalogImportedAt?: number;
  /** 项目定调前言识别出的统一规格（优先级低于分段识别，高于项目默认；3.5 §6.4） */
  videoSpecFromPrefix?: SegmentVideoSpec;
  /** 解绑时目录离线没能清理的 manifest 路径（目录重新上线后自动补清理，防止占着目录绑不了新项目） */
  pendingManifestCleanups?: string[];
  /** 项目默认生成配方 id（分镜页批量工具条选定；片段 recipeId > 项目默认 > 远程默认模型） */
  defaultRecipeId?: string;
  /** 时间线（采用版本顺序） */
  timeline: DirectorTimelineEntry[];
  /** 音频轨道（对白/旁白/音效/环境音/音乐，方案 §23.5） */
  audioTracks?: DirectorAudioTrack[];
  /** 提示词配方库（范例拆解保存的结果，随项目持久化，方案 §23.3） */
  promptRecipes?: Array<{
    id: string;
    name: string;
    category: string;
    breakdown: {
      subject: string;
      scene: string;
      action: string;
      shotSize: string;
      camera: string;
      lighting: string;
      style: string;
      negative: string[];
      modelSpecific: string;
      original: string;
    };
    createdAt: number;
  }>;
  /** 导出的成片资产 id */
  exportAssetId?: string;
  /** 3D 站位实体（持久化，方案 §23.7） */
  threedEntities?: PrevizEntity[];
  /** 项目级 Skill 绑定（作用于所有 Segment，方案 §17.8；3.0 带引擎路由 scope/modelPattern） */
  skillBindings?: SkillBinding[];
  /* —— 导演台 2.0（方案 §16.4 V2 扩展，全部可选，v1 项目经 directorMigration 升级 —— */
  /** 工作区模式：快速（隐藏技术细节）/ 专业（完整参数） */
  workspaceMode?: "quick" | "pro";
  /** 界面状态（当前工作区/检查器标签/选中片段等，跨会话恢复） */
  uiState?: DirectorUiState;
  /** 轻量后期时间线（成片工作区，方案 §11.2） */
  postTimeline?: PostTimelineData;
  /** 提示词修订历史（保存最终稿时留档，供差异对比，方案 §13.2） */
  promptRevisions?: PromptRevision[];
  /** 连续性上下文胶囊（方案 §10） */
  continuityCapsules?: ContinuityCapsule[];
  /** 质量报告（采用 Take 的确定性探测结果，方案 §15.4） */
  qualityReports?: DirectorQualityReport[];
  /** H3 快速模式的硬件档位（方案 §9.3） */
  hardwareTier?: "eco" | "balanced" | "quality" | "custom";
  /** 快速模式内置工作模式（方案 §9.2）：选择后自动匹配配方 */
  quickMode?: string;
  /* —— 导演台 3.0（MOMO AI 制片工作站，方案 §8.1 StudioProject v3 聚合）—— */
  /** 剧本库（正式内容库；正文 script 仍是主链剧本，送入项目时写入） */
  scripts?: ScriptDocument[];
  /** AI MV 项目 */
  mvProjects?: MVProject[];
  /** AI 制图历史与预设 */
  imageStudio?: { history?: ImageStudioRecord[] };
  /** AI 导演：项目级提案池（含外部 Agent 提案；应用/驳回记录持久审计，3.2 §3.3） */
  directorProposals?: DirectorProposal[];
  /** AI 导演：项目会话（跨工位/跨会话保留，3.2 P1-1） */
  directorSession?: DirectorSessionData;
  /* —— 3.5 —— */
  /** 主剧本（同故事的多文档仍是版本语义；不同故事应另建项目） */
  primaryScriptId?: string;
  /** 项目文件夹绑定（未绑定时 AppData 托管） */
  workspace?: DirectorWorkspaceBinding;
  /** 统一视频规格默认值（分辨率/帧率/时长） */
  videoSpecDefaults?: VideoSpecDefaults;
  /** 3.0 工位界面态（一壳七工位导航的恢复态；取代 workspaceMode/uiState 的导航职责） */
  studioUi?: StudioUiState;
  schemaVersion: number;
};

/** 3D 站位实体（角色/相机/光源/道具；x/y 为旧版俯视图 0-100 百分比坐标，3D 字段全部可选） */
export type PrevizEntity = {
  /** 导入骨骼的局部旋转偏移和独立关键帧；动画剪辑来自 GLB。 */
  skeletal?: { clip?: string; speed?: number; loop?: boolean; bones?: Record<string, [number, number, number]>; keys?: Array<{ time: number; bones: Record<string, [number, number, number]> }> };
  /** 仅在预演采样中填充，不作为项目时间真源。 */
  animationTime?: number;
  motion?: PrevizKeyframe[];
  id: string;
  kind: "character" | "camera" | "light" | "prop";
  name: string;
  /** 旧版 2D 俯视图坐标（0-100 百分比）；3D 页缺失 pos 时据此推导初始位置 */
  x: number;
  y: number;
  /** 朝向角度 0-360（0 = 向上/远方）；缺失 rotDeg 时作为初始偏航角 */
  angle: number;
  color: string;
  /** 体型/外形预设：male/female/strong/slim/teen/child/wide/chibi/crowd33/box/sphere/… */
  preset?: string;
  /** 3D 位置（米，地面 y=0） */
  pos?: [number, number, number];
  /** 3D 旋转（度） */
  rotDeg?: [number, number, number];
  /** 3D 三轴缩放 */
  scale3?: [number, number, number];
  /** 人偶表现风格；未指定沿用素模。 */
  appearance?: "mannequin" | "clay" | "costume";
  /** 人偶关节姿势：关节名 → 欧拉角（度），仅 character 有效 */
  pose?: Record<string, [number, number, number]>;
  /** 光源强度（仅 kind=light） */
  intensity?: number;
  /** 本地上传模型的资产路径（GLB/GLTF，经资产库落盘；blob URL 不持久化） */
  modelAssetPath?: string;
};

export type PrevizKeyframe = { time: number; pos: [number, number, number]; rotDeg: [number, number, number]; scale3: [number, number, number] };
export type BrandKit = { name: string; colors: string[]; fonts: string; rules: string; forbidden: string; logoAssetIds: string[]; enabled: boolean };
export type ArtboardSpec = { widthMm: number; heightMm: number; dpi: number; bleedMm: number; safeMm: number; scale: number; background: string };

/* ---------------- 导演台 2.0（V2 扩展类型，方案 §16.4） ---------------- */

/** 四工作区（方案 §4.1）：策划 / 导演 / 成片 / 3D */
export type DirectorWorkspaceKey = "planning" | "directing" | "post" | "threed";

/** 导演台界面状态（跨会话恢复「打开后回到上次的工作区和片段」，验收 22.1-1） */
export type DirectorUiState = {
  workspace: DirectorWorkspaceKey;
  /** 右侧检查器当前标签 */
  inspectorTab: "content" | "prompt" | "refs" | "gen";
  /** 导演工作区视图：驾驶舱（默认）/ 详细分镜表（旧版保留入口，方案 §25.7） */
  cockpitView: "cockpit" | "detail";
  /** 项目 AI 导演抽屉 */
  agentDockOpen?: boolean;
  /** 场景树折叠（窄屏降级） */
  treeCollapsed?: boolean;
  /** 当前选中片段（跨工作区保持，方案 §4.3） */
  segId?: string | null;
};

/**
 * 连续性上下文胶囊（方案 §10）：把尾帧接力升级为显式的跨段状态包。
 * 素材基础沿用现有接力槽（relayKind=frame/clip），胶囊额外携带状态摘要与过期标记。
 */
export type ContinuityCapsule = {
  /** 胶囊归属的下游片段 id */
  segmentId: string;
  sourceSegmentId: string;
  sourceTakeId: string;
  bridgeFrameAssetId?: string;
  motionClipAssetId?: string;
  /** 微视频参考资产（H3 快速模式可选 16~32 帧，默认 22 帧） */
  microReferenceAssetId?: string;
  /* —— 3.0 微参考追溯字段（方案 §6.5：资产、来源 Take、帧区间、fps 和指纹必须可追溯）—— */
  /** 微参考帧数（默认 22） */
  microFrames?: number;
  /** 微参考在源 Take 上的提取区间（秒） */
  microRangeSec?: [number, number];
  /** 源 Take 帧率 */
  microFps?: number;
  /** 来源指纹（sourceTakeId + 帧区间 + 源资产 hash），同指纹重建直接复用 */
  microFingerprint?: string;
  /** 提取引擎：ffmpeg（桌面端完整链）/ web（浏览器降级） */
  microEngine?: "ffmpeg" | "web";
  /** 状态摘要：人物姿势/朝向/服装/道具/机位/光线/环境/未完成动作 */
  stateSummary: string;
  characterState?: string[];
  cameraState?: string;
  environmentState?: string;
  createdAt: number;
  /** 上游重新采用后标记过期，由用户确认重建（方案 §10.3） */
  stale?: boolean;
};

/** 轻量后期：视频片段覆盖（入出点/转场/原声音量/镜像旋转，按 segmentId 索引；时间线本身由 deriveTimeline 派生） */
export type PostClipOverride = {
  segmentId: string;
  inSec?: number;
  outSec?: number;
  /** 与下一段之间的转场：硬切（默认）/ 短交叉淡化 */
  transition?: "cut" | "fade";
  transitionDur?: number;
  /** 片段原声音量（0~1） */
  volume?: number;
  muted?: boolean;
  fadeIn?: number;
  fadeOut?: number;
  /* —— 3.0 基础变换（方案 §6.7：真实进入预演与 MP4）—— */
  flipH?: boolean;
  flipV?: boolean;
  /** 顺时针旋转：0 / 90 / 180 / 270 */
  rotate?: 0 | 90 | 180 | 270;
};

/** 标题卡 / 黑场 / 图片卡（T1 轨，方案 §11.2） */
export type PostTitleCard = {
  id: string;
  kind: "title" | "black" | "image";
  text?: string;
  /** 图片卡的资产 id */
  assetId?: string;
  durSec: number;
  /** 在成片时间轴上的起点（秒） */
  atSec: number;
};

/** 字幕（SUB 轨；导出 SRT 或烧录进 MP4） */
export type PostSubtitle = {
  id: string;
  startSec: number;
  endSec: number;
  text: string;
};

/** 成片时间线数据（方案 §11.2：V1 采用视频 / T1 标题 / D1 N1 S1 A1 M1 音轨 / SUB 字幕） */
export type PostTimelineData = {
  /** 片段级覆盖（segmentId → 入出点/转场/音量） */
  clipOverrides: Record<string, PostClipOverride>;
  titleCards: PostTitleCard[];
  subtitles: PostSubtitle[];
  /** 画幅适配：包含（黑边）/ 裁切 / 模糊填充 */
  fit: "contain" | "cover" | "blur";
};

/** 音频轨混音参数（挂在 DirectorAudioTrack 上的扩展字段用 PostClipOverride 同构；这里只做整轨） */
export type PostAudioMix = {
  volume?: number;
  muted?: boolean;
  fadeIn?: number;
  fadeOut?: number;
};

/** 提示词修订（保存最终稿时留档，方案 §13.2） */
export type PromptRevision = {
  segmentId: string;
  /** 修订时的完整文本 */
  text: string;
  at: number;
  note?: string;
};

/** 质量报告（每个采用 Take 的确定性探测结果，方案 §15.4） */
export type DirectorQualityReport = {
  takeId: string;
  segmentId: string;
  assetId?: string;
  probedAt: number;
  width?: number;
  height?: number;
  fps?: number;
  durationSec?: number;
  hasAudio?: boolean;
  corrupt?: boolean;
  /** 音频峰值（0~1，峰值保护参考） */
  audioPeak?: number;
  /** 黑帧比例（0~1） */
  blackRatio?: number;
  issues?: Array<{ level: "error" | "warning" | "info"; message: string }>;
};

/* ==================================================================
 * 导演台 3.0 —— MOMO AI 制片工作站（方案 §8 数据模型重构 / §4 一壳七工位）
 *
 * StudioProject 不另起炉灶：DirectorProject（v2 聚合）仍是唯一存储真相，
 * 3.0 新实体（剧本库 / MV 项目 / 工位界面态 / 制图历史）作为可选字段挂在项目上，
 * schemaVersion 升到 3，迁移在 directorMigration.ts。执行层（runBatch / 参考槽 /
 * Take / 接力）完全复用，方案 §11.1「直接保留并接入新壳」。
 * ================================================================== */

/** 七个专业工位 + 底部共享工具（方案 §4.1；不编号、不表步骤，随时往返） */
export type StudioStation = "director" | "scripts" | "characters" | "image" | "h3" | "mv" | "post";
/** 共享工具位（导航底部，不参与主流程） */
export type StudioToolKey = "previz" | "assets" | "jobs" | "engine";

/** 剧本库：正式内容库实体（方案 §6.2）——不再是单页大文本框 */
export type ScriptDocument = {
  id: string;
  title: string;
  /** 草稿 / 正式 / 归档 */
  status: "draft" | "official" | "archived";
  /** 类型标签（奇幻 / 现实 / 广告 …） */
  genre?: string;
  /** 预计成片时长（秒） */
  targetDurationSec?: number;
  /** 版本时间线（追加式，最新一版即当前正文） */
  versions: ScriptVersion[];
  activeVersionId?: string;
  /** 来源：AI 导演存入 / 文件导入 / 从项目另存 */
  origin: "ai-director" | "import" | "project";
  createdAt: number;
  updatedAt: number;
};

/** 剧本版本（不可变快照；正文或结构化分段二选一携带） */
export type ScriptVersion = {
  id: string;
  label: string;
  body: string;
  note?: string;
  createdAt: number;
  /** 送入项目时拆分出的场景/片段 id 快照（传播失效判定用） */
  sceneIds?: string[];
};

/** AI MV 项目（方案 §6.6）：音乐分析 + 区间视觉绑定 + 口型支链 */
export type MVProject = {
  id: string;
  name: string;
  /** 音乐资产 id（资产库音频） */
  musicAssetId?: string;
  /** 音乐分析结果（探测 + Web Audio 节拍） */
  analysis?: MVAnalysis;
  /** 歌词（可选；LRC 导入或手填，带时间轴进字幕） */
  lyrics?: Array<{ startSec: number; endSec: number; text: string }>;
  /** 视觉区间（按音乐段落绑定图片/角色，逐区间生成） */
  regions: MVRegion[];
  /** 生成设置（与 H3 共用配方与模型体系） */
  settings: {
    recipeId?: string;
    aspect?: string;
    resolutionMP?: number;
    /** 口型配方（独立能力；未配置时口型分支明确不可用） */
    lipSyncRecipeId?: string;
  };
  /** 区间生成结果收进成片时间线的方式 */
  createdAt: number;
  updatedAt: number;
};

/** 音乐分析（方案 §6.6 首版：时长/节拍/段落/能量包络） */
export type MVAnalysis = {
  durationSec: number;
  bpm?: number;
  /** 节拍时间点（秒） */
  beats?: number[];
  /** 自动段落（副歌/主歌的粗切分，能量聚类） */
  sections?: Array<{ startSec: number; endSec: number; energy: number; label?: string }>;
  /** 能量包络（每秒 RMS，波形展示用） */
  envelope?: number[];
  analyzedAt: number;
};

/** MV 视觉区间：一段音乐绑一组图/角色，生成一段视频 */
export type MVRegion = {
  id: string;
  startSec: number;
  endSec: number;
  /** 绑定的图片资产 id（有序，进 Picture 槽） */
  imageAssetIds: string[];
  /** 绑定角色 id（角色库外观参考叠加） */
  characterIds: string[];
  /** 本区间运动/氛围提示词 */
  prompt?: string;
  /** 是否人物口型区间（需口型配方） */
  lipSync?: boolean;
  /** 区间生成结果（takeId 关联项目里一个虚拟片段或直接资产） */
  takes?: Array<{ id: string; assetId?: string; status: "queued" | "running" | "done" | "error"; error?: string }>;
  approvedTakeId?: string;
};

/** 统一任务中心记录（方案 §9.4）：所有耗时操作可观察、可恢复、可取消 */
export type JobRecord = {
  id: string;
  projectId?: string;
  /** 任务类别：生成 / 微参考提取 / 渲染 / 音乐分析 / 制图 / 音频 */
  kind: "generate" | "microref" | "render" | "analyze" | "image" | "audio" | "extract";
  label: string;
  /** 主线状态机：planned → prechecking → queued → running → reviewing → done */
  status: "planned" | "prechecking" | "queued" | "running" | "reviewing" | "done" | "cancelled" | "failed" | "blocked" | "stale";
  /** 0~100；无百分比的远程任务为 undefined（显示流动动画） */
  pct?: number;
  stage?: string;
  segmentId?: string;
  error?: string;
  /** 远程计费任务提交后不可撤销（按钮 title 提示用） */
  cancellable?: boolean;
  /** 会话内取消钩子（runBatch 等接线到自己的中止机制；不持久化） */
  cancelRun?: () => void;
  /** 失败后按原请求续跑；由任务中心展示确认再执行 */
  retryRun?: () => Promise<void>;
  retryNote?: string;
  createdAt: number;
  finishedAt?: number;
};

/** AI 制图工位（方案 §6.4）：一次生成的参数与结果（历史/预设/复用） */
export type ImageStudioRecord = {
  id: string;
  mode: "t2i" | "i2i" | "edit";
  prompt: string;
  /** 图生图/编辑的输入资产 id */
  inputAssetIds?: string[];
  /** 引擎：本地 ComfyUI 配方 or 远程 Provider 模型 */
  engine: "comfy" | "provider";
  recipeId?: string;
  providerModelKey?: string;
  params: Record<string, string | number | boolean>;
  assetIds: string[];
  createdAt: number;
  durationMs?: number;
  fav?: boolean;
};

/** 3.0 工位界面态（跨会话恢复；挂在 project.studioUi） */
export type StudioUiState = {
  /** 当前工位（七工位 + 3D 预演全屏位） */
  station: StudioStation | "previz";
  segId?: string | null;
  /** H3 检查器分组展开态 */
  inspectorOpen?: Record<string, boolean>;
  /** 各停靠面板宽度（px；拖动调宽持久化） */
  panelWidths?: Record<string, number>;
  /** 剧本库选中 */
  scriptId?: string | null;
  /** 角色库选中 */
  characterId?: string | null;
  /** 制图工位模式 */
  imageMode?: "t2i" | "i2i" | "edit";
  /** MV 工位选中项目 */
  mvId?: string | null;
};

/* ---------------- AI 导演（3.2 方案 §3：项目级理解 / 诊断 / 提案 / 计划） ---------------- */

/** AI 导演的问题发现（有证据、可定位对象） */
export type DirectorFinding = {
  severity: "info" | "warning" | "blocker";
  category: "story" | "continuity" | "prompt" | "reference" | "engine" | "quality" | "delivery";
  targetId?: string;
  evidence: string;
  suggestion: string;
};

/** 对象级提案 patch：targetType 决定 patch 的结构（见 directorAgent.applyDirectorProposal） */
export type DirectorProposal = {
  id: string;
  /** 提案标题（一句话） */
  title: string;
  targetType: "script" | "scene" | "segment" | "shot" | "characterState" | "prompt" | "slot" | "recipe" | "timeline";
  /** 目标对象 id（script 可空 = 新剧本草稿） */
  targetId: string;
  /** 为什么这么改（给用户看） */
  reason: string;
  /** 依据（引用项目事实/分析结果） */
  evidence: string[];
  /** 对象级变更（结构与 targetType 对应；应用前用户可编辑） */
  patch: unknown;
  /** 影响面（应用前计算展示；片段失效 / Take 过期 / 微参考重建） */
  impact?: {
    invalidatedSegmentIds: string[];
    staleTakeIds: string[];
    rebuildMicroRefIds: string[];
    estimatedRemoteJobs?: number;
  };
  status: "pending" | "applied" | "rejected";
  /** 驳回原因（审计） */
  rejectReason?: string;
  origin: "ai-director" | "external-agent";
  createdAt: number;
  appliedAt?: number;
};

/** 生产计划条目：交给专业工位执行的一步（AI 导演只计划不执行，3.2 §3.4） */
export type DirectorPlanItem = {
  id: string;
  /** 执行动作（对应现有专用函数/工位入口） */
  action: "analyze" | "refine" | "precheck" | "generate" | "probe" | "upscale" | "bind-ref" | "manual";
  title: string;
  /** 目标片段/对象 id 列表 */
  targetIds: string[];
  note?: string;
  /** 执行状态回流（工位完成后写回，§8.2） */
  done?: boolean;
  result?: string;
};

/** AI 导演每轮的结构化输出契约（3.2 §3.3） */
export type DirectorResponse = {
  reply: string;
  findings?: DirectorFinding[];
  proposals?: DirectorProposal[];
  plan?: DirectorPlanItem[];
  questions?: Array<{ id: string; text: string; options?: string[] }>;
};

/** AI 导演会话消息（持久化在 project.directorSession，与创作助手完全隔离） */
export type DirectorMsg = {
  id: string;
  role: "user" | "director";
  text: string;
  at: number;
  /** 本轮结构化输出（director 消息携带；解析失败降级为纯文本） */
  response?: DirectorResponse;
  /** 视觉审片附帧（dataURL，仅存引用不落库） */
  images?: string[];
};

/** 项目级导演会话（3.2 P1-1：按 projectId 持久化 + 前情摘要压缩） */
export type DirectorSessionData = {
  messages: DirectorMsg[];
  /** 前情摘要（旧消息压缩产物；epoch 守卫防旧摘要覆盖新会话） */
  summary?: string;
  summaryUpto?: number;
  epoch: number;
};
