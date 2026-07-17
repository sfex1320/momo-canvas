import type { Node } from "@xyflow/react";

/* ---------------- 节点 ---------------- */
export type NodeKind = "image" | "prompt" | "chat" | "imageGen" | "videoGen" | "comfy";

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
};

export type ImageGenData = {
  status: RunStatus;
  error?: string;
  prompt: string;
  size: string;
  count: number;
  results: string[];
  picked: number;
};

export type VideoGenData = {
  status: RunStatus;
  error?: string;
  prompt: string;
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
  progress?: string;
};

export type AnyData =
  | ImageData
  | PromptData
  | ChatData
  | ImageGenData
  | VideoGenData
  | ComfyData;

export type AppNode = Node<Record<string, unknown>, NodeKind>;

/* 端口数据类型 */
export type PortType = "text" | "image" | "video";

/* ---------------- 设置 ---------------- */
export type ChatModelCfg = { baseUrl: string; apiKey: string; model: string };
export type ImageModelCfg = { baseUrl: string; apiKey: string; model: string; size: string };
export type VideoApiStyle = "zhipu" | "siliconflow" | "openai";
export type VideoModelCfg = { baseUrl: string; apiKey: string; model: string; style: VideoApiStyle };
export type SearchProvider = "tavily" | "bocha" | "searxng";
export type SearchCfg = { provider: SearchProvider; apiKey: string; baseUrl: string; maxResults: number };
export type ImgFormat = "png" | "jpeg" | "webp";
export type SaveCfg = { dir: string; format: ImgFormat; pattern: string; autoSave: boolean };
export type ComfyCfg = { host: string };
export type ThemeName = "light" | "dark";

export type Settings = {
  chat: ChatModelCfg;
  image: ImageModelCfg;
  video: VideoModelCfg;
  search: SearchCfg;
  save: SaveCfg;
  comfy: ComfyCfg;
  theme: ThemeName;
};

export const DEFAULT_SETTINGS: Settings = {
  chat: { baseUrl: "https://api.deepseek.com/v1", apiKey: "", model: "deepseek-chat" },
  image: { baseUrl: "", apiKey: "", model: "", size: "1024x1024" },
  video: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "", model: "cogvideox-3", style: "zhipu" },
  search: { provider: "tavily", apiKey: "", baseUrl: "", maxResults: 5 },
  save: { dir: "", format: "png", pattern: "{date}_{time}_{model}", autoSave: false },
  comfy: { host: "http://127.0.0.1:8188" },
  theme: "dark",
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

/* ---------------- 生成记录 ---------------- */
export type GalleryItem = {
  id: string;
  kind: "image" | "video";
  src: string;
  prompt?: string;
  model?: string;
  nodeId?: string;
  time: number;
};
