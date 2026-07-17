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
  | "note";

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
  /** Nano Banana：宽高比（auto/1:1/16:9…） */
  aspect?: string;
  /** Nano Banana：分辨率档（1K/2K/4K） */
  resolution?: string;
  /** GPT Image：质量（auto/high/medium/low） */
  quality?: string;
  /** GPT Image / 通用：自定义宽高（同时填写才生效） */
  width?: number;
  height?: number;
};

export type VideoGenData = {
  status: RunStatus;
  error?: string;
  prompt: string;
  resultUrl?: string;
  progress?: string;
  modelId?: string;
};

export type ComfyData = {
  status: RunStatus;
  error?: string;
  templateId?: string;
  params: Record<string, string | number>;
  results: string[];
  picked: number;
  progress?: string;
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

/** 服务商卡片里某一角色的模型槽位（模型名留空 = 该角色未启用） */
export type RoleSlot = {
  protocol: AnyProtocol;
  model: string;
  /** 绘画槽位：默认尺寸 */
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
  protocol: AnyProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  size?: string;
};

export type ModelsCfg = {
  providers: ProviderCard[];
  /** 各角色默认使用哪家服务商（provider id） */
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

export type Settings = {
  models: ModelsCfg;
  search: SearchCfg;
  save: SaveCfg;
  comfy: ComfyCfg;
  theme: ThemeName;
};

export const DEFAULT_SETTINGS: Settings = {
  models: { providers: [], defaults: {} },
  search: { provider: "tavily", apiKey: "", baseUrl: "", maxResults: 5 },
  save: { dir: "", format: "png", pattern: "{date}_{time}_{model}", autoSave: false },
  comfy: { host: "http://127.0.0.1:8188" },
  theme: "dark",
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
  createdAt: number;
};

/* ---------------- 画板 ---------------- */
export type BoardMeta = { id: string; name: string; updatedAt: number };

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
  /** 来源：canvas 生成 / import 导入 */
  source: "canvas" | "import";
  createdAt: number;
};

export type AssetFolder = { id: string; name: string };
