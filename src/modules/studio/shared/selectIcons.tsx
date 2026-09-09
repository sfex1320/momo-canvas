/**
 * 工位下拉的语义图标（导演台 3.0 UI 规范：下拉选项一律「图标 + 文字」）
 * 全部复用 src/ui/icons.tsx 手绘 SVG；studio 内新增下拉从这里取，不自造第三套。
 */
import type { ReactNode } from "react";
import {
  IcFilter, IcCheck, IcTimer, IcLoading, IcWarn, IcText, IcHistory, IcFilmJoin, IcScissors,
  IcRotate, IcMusic, IcImage, IcGlobe, IcFlow, IcLayers, IcCrop, IcEdit, IcFolder, IcSparkles,
  IcVideo, IcWand, IcLibrary,
} from "../../../ui/icons";

/** 「选项 + 图标」构造器：pop(label, icon) → { value, label, icon } */
export function opt<T extends string | number>(value: T, label: string, icon: ReactNode) {
  return { value: String(value), label, icon };
}

/** H3 片段状态筛选 */
export const SEG_STATUS_ICONS: Record<string, ReactNode> = {
  all: <IcFilter size={14} />,
  approved: <IcCheck size={14} />,
  pending: <IcTimer size={14} />,
  running: <IcLoading size={14} />,
  failed: <IcWarn size={14} />,
  missing: <IcText size={14} />,
  stale: <IcHistory size={14} />,
};

/** 引擎/通道 */
export const ENGINE_ICONS = {
  provider: <IcGlobe size={14} />,
  comfy: <IcFlow size={14} />,
  local: <IcFlow size={14} />,
  remote: <IcGlobe size={14} />,
  all: <IcSparkles size={14} />,
};

/** 通用语义图标（按用途取） */
export const SI = {
  music: <IcMusic size={14} />,
  image: <IcImage size={14} />,
  video: <IcVideo size={14} />,
  layers: <IcLayers size={14} />,
  crop: <IcCrop size={14} />,
  edit: <IcEdit size={14} />,
  check: <IcCheck size={14} />,
  folder: <IcFolder size={14} />,
  history: <IcHistory size={14} />,
  join: <IcFilmJoin size={14} />,
  cut: <IcScissors size={14} />,
  rotate: <IcRotate size={14} />,
  flow: <IcFlow size={14} />,
  globe: <IcGlobe size={14} />,
  wand: <IcWand size={14} />,
  library: <IcLibrary size={14} />,
  loading: <IcLoading size={14} />,
};
