/**
 * 节点目录 — 添加坞 / 快速添加菜单共用
 */
import type { ReactNode } from "react";
import type { NodeKind } from "../../core/types";
import { IcChat, IcFlow, IcImage, IcSparkles, IcText, IcVideo } from "../../ui/icons";

export type CatalogItem = {
  kind: NodeKind;
  label: string;
  desc: string;
  icon: ReactNode;
  /** 是否有输入端口（决定拖线快速添加时是否可选） */
  hasInput: boolean;
};

export const NODE_CATALOG: CatalogItem[] = [
  { kind: "image", label: "图片", desc: "导入 / 拖入 / 粘贴一张图片", icon: <IcImage size={18} />, hasInput: false },
  { kind: "prompt", label: "提示词", desc: "编写提示词，可 AI 扩写优化", icon: <IcText size={18} />, hasInput: false },
  { kind: "chat", label: "对话", desc: "多模态对话 · 思考 · 联网搜索", icon: <IcChat size={18} />, hasInput: true },
  { kind: "imageGen", label: "生成图像", desc: "调用绘画模型文生图 / 图生图", icon: <IcSparkles size={18} />, hasInput: true },
  { kind: "videoGen", label: "生成视频", desc: "调用视频模型生成短片", icon: <IcVideo size={18} />, hasInput: true },
  { kind: "comfy", label: "ComfyUI", desc: "运行本地 ComfyUI 工作流模板", icon: <IcFlow size={18} />, hasInput: true },
];
