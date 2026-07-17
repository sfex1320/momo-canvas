/**
 * 节点目录 — 添加坞 / 快速添加菜单共用
 */
import type { ReactNode } from "react";
import type { NodeKind } from "../../core/types";
import {
  IcChat,
  IcFlow,
  IcImage,
  IcNote,
  IcPalette,
  IcScan,
  IcSparkles,
  IcText,
  IcVideo,
  IcWand,
} from "../../ui/icons";

export type CatalogItem = {
  kind: NodeKind;
  label: string;
  desc: string;
  icon: ReactNode;
  group: "输入" | "智能" | "生成";
};

export const NODE_CATALOG: CatalogItem[] = [
  { kind: "image", label: "图片", desc: "导入 / 拖入 / 粘贴一张图片", icon: <IcImage size={18} />, group: "输入" },
  { kind: "prompt", label: "提示词", desc: "编写提示词，可 AI 扩写优化", icon: <IcText size={18} />, group: "输入" },
  { kind: "stylePreset", label: "风格预设", desc: "内置风格片段库，点选叠加输出", icon: <IcPalette size={18} />, group: "输入" },
  { kind: "note", label: "备注", desc: "画布便签，整理思路", icon: <IcNote size={18} />, group: "输入" },
  { kind: "chat", label: "对话", desc: "多模态对话 · 思考 · 联网搜索", icon: <IcChat size={18} />, group: "智能" },
  { kind: "caption", label: "反推描述", desc: "图片 → 视觉模型 → 提示词/描述", icon: <IcScan size={18} />, group: "智能" },
  { kind: "llmText", label: "文本处理", desc: "优化 / 翻译 / 扩写 / 自定义指令", icon: <IcWand size={18} />, group: "智能" },
  { kind: "imageGen", label: "生成图像", desc: "调用绘画模型文生图 / 图生图", icon: <IcSparkles size={18} />, group: "生成" },
  { kind: "videoGen", label: "生成视频", desc: "调用视频模型生成短片", icon: <IcVideo size={18} />, group: "生成" },
  { kind: "comfy", label: "ComfyUI", desc: "运行本地 ComfyUI 工作流模板", icon: <IcFlow size={18} />, group: "生成" },
];
