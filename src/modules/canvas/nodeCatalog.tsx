/**
 * 节点目录 — 添加坞 / 快速添加菜单 / Spotlight 共用
 */
import type { ReactNode } from "react";
import type { HotkeyAction, NodeKind } from "../../core/types";
import {
  IcBrush,
  IcBulb,
  IcChat,
  IcCrop,
  IcEnhance,
  IcExpand,
  IcFlow,
  IcIdCard,
  IcImage,
  IcNote,
  IcOrbit,
  IcPalette,
  IcResize,
  IcScan,
  IcScissors,
  IcSparkles,
  IcText,
  IcVideo,
  IcWand,
  IcClapper,
  IcFilmFrame,
  IcFilmCut,
  IcFilmJoin,
} from "../../ui/icons";

export type CatalogItem = {
  kind: NodeKind;
  label: string;
  desc: string;
  icon: ReactNode;
  group: "输入" | "智能" | "生成" | "编辑" | "视频" | "角色";
  /** 对应的「添加节点」快捷键动作（设置 → 快捷键 可自定义） */
  hotkey: HotkeyAction;
  /** 不在底部工具坞显示（避免坞过宽；双击菜单 / Spotlight 仍可添加） */
  dockHidden?: boolean;
};

/** 按类型分组：输入（素材/文字）→ 智能（LLM 加工）→ 生成（从无到有）→ 编辑（改已有图片）→ 角色 */
export const NODE_CATALOG: CatalogItem[] = [
  { kind: "image", label: "图片", desc: "导入 / 拖入 / 粘贴一张图片", icon: <IcImage size={18} />, group: "输入", hotkey: "addImage" },
  { kind: "prompt", label: "提示词", desc: "编写提示词，可 AI 扩写优化", icon: <IcText size={18} />, group: "输入", hotkey: "addPrompt" },
  { kind: "stylePreset", label: "风格预设", desc: "内置风格片段库，点选叠加输出", icon: <IcPalette size={18} />, group: "输入", hotkey: "addStylePreset" },
  { kind: "note", label: "备注", desc: "画布便签，整理思路", icon: <IcNote size={18} />, group: "输入", hotkey: "addNote" },
  { kind: "chat", label: "对话", desc: "多模态对话 · 思考 · 联网搜索", icon: <IcChat size={18} />, group: "智能", hotkey: "addChat" },
  { kind: "caption", label: "反推描述", desc: "图片 → 视觉模型 → 提示词/描述", icon: <IcScan size={18} />, group: "智能", hotkey: "addCaption" },
  { kind: "llmText", label: "文本处理", desc: "优化 / 翻译 / 扩写 / 自定义指令", icon: <IcWand size={18} />, group: "智能", hotkey: "addLlmText" },
  { kind: "storyboard", label: "分镜", desc: "故事→完善→按风格定调拆分镜（带时间轴），逐镜输出口 + 一键铺生成节点", icon: <IcClapper size={18} />, group: "智能", hotkey: "addStoryboard" },
  { kind: "imageGen", label: "生成图像", desc: "调用绘画模型文生图 / 图生图", icon: <IcSparkles size={18} />, group: "生成", hotkey: "addImageGen" },
  { kind: "videoGen", label: "生成视频", desc: "调用视频模型生成短片", icon: <IcVideo size={18} />, group: "生成", hotkey: "addVideoGen" },
  { kind: "comfy", label: "ComfyUI", desc: "运行本地 ComfyUI 工作流模板", icon: <IcFlow size={18} />, group: "生成", hotkey: "addComfy" },
  { kind: "inpaint", label: "局部重绘", desc: "涂抹/框选上游图片的区域，按提示词只重绘该区域", icon: <IcBrush size={18} />, group: "编辑", hotkey: "addInpaint" },
  { kind: "outpaint", label: "扩图", desc: "向四周延伸扩展上游图片的画面", icon: <IcExpand size={18} />, group: "编辑", hotkey: "addOutpaint" },
  { kind: "matting", label: "抠图", desc: "抠出主体：透明底（GPT Image）或纯色底", icon: <IcScissors size={18} />, group: "编辑", hotkey: "addMatting" },
  { kind: "enhance", label: "高清增强", desc: "重绘增强细节并放大分辨率（2×/4×）", icon: <IcEnhance size={18} />, group: "编辑", hotkey: "addEnhance" },
  { kind: "crop", label: "聚焦裁剪", desc: "框选上游图片的局部输出：给下游更精准的参考", icon: <IcCrop size={18} />, group: "编辑", hotkey: "addCrop" },
  { kind: "resize", label: "尺寸调整", desc: "真实压缩/放大图片像素，或输出推荐比例/分辨率给生成节点", icon: <IcResize size={18} />, group: "编辑", hotkey: "addResize" },
  { kind: "relight", label: "打光", desc: "为上游图片重新打光：方向/亮度/颜色/轮廓光", icon: <IcBulb size={18} />, group: "编辑", hotkey: "addRelight" },
  { kind: "multiAngle", label: "多角度", desc: "换机位重拍上游图片：环绕/俯仰/景别", icon: <IcOrbit size={18} />, group: "编辑", hotkey: "addMultiAngle" },
  { kind: "frame", label: "视频取帧", desc: "抽首帧/末帧/任意帧输出图片：末帧接下一段视频可无限续接", icon: <IcFilmFrame size={18} />, group: "视频", hotkey: "addFrame" },
  { kind: "videoTrim", label: "视频取段", desc: "本地截取视频片段（实验性，输出 webm）", icon: <IcFilmCut size={18} />, group: "视频", hotkey: "addVideoTrim" },
  { kind: "videoConcat", label: "视频拼接", desc: "多段视频按顺序合成一条成片（实验性）", icon: <IcFilmJoin size={18} />, group: "视频", hotkey: "addVideoConcat" },
  { kind: "charCard", label: "角色卡", desc: "分析人物图片/描述，一键产出三视图/表情/立绘/设定卡", icon: <IcIdCard size={18} />, group: "角色", hotkey: "addCharCard" },
];
