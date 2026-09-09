import type { PrevizEntity } from "../../../core/types";

export const SCENE_PRESETS = [
  { id: "dialogue", name: "双人对话", detail: "两位角色＋正反打机位＋主光" },
  { id: "product", name: "产品展示", detail: "展示台＋产品占位＋主辅光" },
  { id: "wall", name: "文化墙", detail: "墙面＋立牌＋人物尺度参考" },
] as const;

/** 模板只返回新增实体，不改已有场景。相机沿实体 +Z 观察，与预演引擎约定一致。 */
export function createScenePreset(kind: typeof SCENE_PRESETS[number]["id"], makeId: () => string, offsetX = 0): PrevizEntity[] {
  const entity = (kind: PrevizEntity["kind"], name: string, preset: string | undefined, pos: [number, number, number], color: string, angle = 0, scale3: [number, number, number] = [1,1,1]): PrevizEntity => ({
    id: makeId(), kind, name, preset, pos: [pos[0] + offsetX, pos[1], pos[2]], color, angle,
    x: 50 + (pos[0] + offsetX) / .24, y: 50 + pos[2] / .24, rotDeg: [0, angle, 0], scale3,
    ...(kind === "character" ? { appearance: "costume" as const } : {}),
    ...(kind === "light" ? { intensity: 24 } : {}),
  });
  const light = entity("light", "主光", undefined, [2.5, 3.5, 3], "#fff1d6");
  const camera = entity("camera", "主摄影机", undefined, [0, 1.5, 7], "#e0a228", 180);
  if (kind === "dialogue") return [
    entity("character", "对话角色 A", "male", [-1,0,0], "#507cb0", 65),
    entity("character", "对话角色 B", "female", [1,0,0], "#be8068", -65),
    camera, entity("camera", "反打机位", undefined, [0,1.5,-5], "#cfab62"), light,
  ];
  if (kind === "product") return [
    entity("prop", "展示台", "platform", [0,0,0], "#ded5c7"),
    entity("prop", "产品占位（可替换模型）", "box", [0,.6,0], "#627d92", 20, [.65,.9,.65]),
    entity("prop", "背景墙", "wall", [0,0,-2], "#c9d1d3"), camera, light,
    entity("light", "补光", undefined, [-3,2,2], "#c8e4ff"),
  ];
  return [
    entity("prop", "文化墙基底", "wall", [0,0,0], "#c6bca4"),
    entity("prop", "主题立牌", "panel", [-1.65,0,.2], "#9b343b"),
    entity("prop", "内容立牌", "panel", [0,0,.2], "#e9e0c8"),
    entity("prop", "展示立牌", "panel", [1.65,0,.2], "#556d79"),
    entity("character", "人物尺度参考", "female", [3.5,0,.3], "#607894"), camera, light,
  ];
}
