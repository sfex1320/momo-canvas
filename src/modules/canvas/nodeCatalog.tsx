/**
 * 节点目录 — 添加坞 / 快速添加菜单 / Spotlight 共用
 */
import type { ReactNode } from "react";
import type { HotkeyAction, NodeKind } from "../../core/types";
import {
  IcBulb,
  IcDub,
  IcEcom,
  IcMic,
  IcMusic,
  IcFlow,
  IcIdCard,
  IcImage,
  IcNote,
  IcOrbit,
  IcPalette,
  IcSparkles,
  IcMerge,
  IcText,
  IcUpscale,
  IcVector,
  IcVideo,
  IcClapper,
  IcFilmFrame,
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
  { kind: "video", label: "视频", desc: "导入 / 拖入一段视频：接生成视频参考、配音、ComfyUI", icon: <IcVideo size={18} />, group: "输入", hotkey: "addVideo" },
  { kind: "audio", label: "音频", desc: "导入 / 拖入一段音频：接视频配音或生成视频的参考音频", icon: <IcMusic size={18} />, group: "输入", hotkey: "addAudio", dockHidden: true },
  { kind: "prompt", label: "提示词", desc: "编写提示词，AI 工具可优化/扩写/反推", icon: <IcText size={18} />, group: "输入", hotkey: "addPrompt" },
  { kind: "stylePreset", label: "风格预设", desc: "内置风格片段库，点选叠加输出", icon: <IcPalette size={18} />, group: "输入", hotkey: "addStylePreset" },
  { kind: "note", label: "备注", desc: "画布便签，整理思路", icon: <IcNote size={18} />, group: "输入", hotkey: "addNote" },
  // 对话：已并入右侧「创作助手」（标题栏图标打开），目录不再提供添加；旧画布上的节点仍可运行
  // 文本处理：功能已并入提示词弹窗的「AI 工具」（就地编辑不新增节点），目录不再提供添加；旧画布上的节点仍可运行
  { kind: "combine", label: "拼接文本", desc: "多路上游文本按位置顺序合并输出（逗号/换行/空格）", icon: <IcMerge size={18} />, group: "智能", hotkey: "addCombine", dockHidden: true },
  { kind: "storyboard", label: "分镜", desc: "故事→完善→按风格定调拆分镜（带时间轴），逐镜输出口 + 一键铺生成节点", icon: <IcClapper size={18} />, group: "智能", hotkey: "addStoryboard" },
  { kind: "imageGen", label: "生成图像", desc: "调用绘画模型文生图 / 图生图", icon: <IcSparkles size={18} />, group: "生成", hotkey: "addImageGen" },
  { kind: "ecomImage", label: "电商长图", desc: "产品拍照图 → 视觉分析提属性/写介绍 → 按比例切分统一风格生成 → 拼接成完整长图（H5 / 详情页）", icon: <IcEcom size={18} />, group: "生成", hotkey: "addEcomImage" },
  { kind: "videoGen", label: "生成视频", desc: "调用视频模型生成短片", icon: <IcVideo size={18} />, group: "生成", hotkey: "addVideoGen" },
  { kind: "comfy", label: "ComfyUI", desc: "运行本地 ComfyUI 工作流模板", icon: <IcFlow size={18} />, group: "生成", hotkey: "addComfy" },
  { kind: "relight", label: "打光", desc: "为上游图片重新打光：方向/亮度/颜色/轮廓光", icon: <IcBulb size={18} />, group: "编辑", hotkey: "addRelight" },
  { kind: "multiAngle", label: "多角度", desc: "换机位重拍上游图片：环绕/俯仰/景别", icon: <IcOrbit size={18} />, group: "编辑", hotkey: "addMultiAngle" },
  { kind: "audioGen", label: "生成音频", desc: "TTS 朗读 / 音乐生成：文本留空自动取上游（分镜台词可直通）", icon: <IcMic size={18} />, group: "生成", hotkey: "addAudioGen", dockHidden: true },
  { kind: "videoDub", label: "视频配音", desc: "把上游音频混入/替换视频原声（本地重编码，零成本）", icon: <IcDub size={18} />, group: "视频", hotkey: "addVideoDub", dockHidden: true },
  { kind: "director", label: "导演台", desc: "项目级复合节点：剧本→分镜→生成调度→选片→串片预演→剪辑交付", icon: <IcFilmFrame size={18} />, group: "视频", hotkey: "addDirector" },
  { kind: "charCard", label: "角色卡", desc: "分析人物图片/描述，一键产出三视图/表情/立绘/设定卡", icon: <IcIdCard size={18} />, group: "角色", hotkey: "addCharCard" },
  { kind: "enhanceLocal", label: "本地放大", desc: "本地 GPU（DirectML）多模型融合超分：4K/8K/印刷尺寸，非破坏、可取消、自动 Tile", icon: <IcUpscale size={18} />, group: "编辑", hotkey: "addEnhanceLocal" },
  { kind: "vectorize", label: "矢量", desc: "本地 VTracer 位图转矢量 SVG：Logo/打卡框/文化墙/扁平插画，非破坏，可导出 AI/CDR", icon: <IcVector size={18} />, group: "编辑", hotkey: "addVectorize" },
];
