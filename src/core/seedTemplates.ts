/**
 * 内置示例工作流 — 「播种画布」：新手不用面对空白画布，插入即得连好线的可跑工作流
 * （Flora 模板播种 / Freepik 模板库的桌面端形态；不落盘、不可删除）
 */
import type { BoardTemplate, TemplateEdge, TemplateNode } from "./types";

function n(tid: string, kind: TemplateNode["kind"], x: number, y: number, data: Record<string, unknown> = {}): TemplateNode {
  return { tid, kind, x, y, data };
}
function e(sourceTid: string, targetTid: string, targetHandle: "in-text" | "in-image"): TemplateEdge {
  return { sourceTid, targetTid, sourceHandle: "out", targetHandle };
}

export const SEED_TEMPLATES: BoardTemplate[] = [
  {
    id: "seed_txt2img",
    name: "示例 · 文生图 + 高清放大",
    builtin: true,
    createdAt: 0,
    nodes: [
      n("p", "prompt", 0, 0, { text: "一只银渐层猫咪蹲在窗台上，黄昏逆光，毛发蓬松，浅景深，电影感画面" }),
      n("g", "imageGen", 360, 0),
      n("u", "enhance", 730, 0, { factor: 2, focus: "detail" }),
    ],
    edges: [e("p", "g", "in-text"), e("g", "u", "in-image")],
  },
  {
    id: "seed_img2img",
    name: "示例 · 参考图反推再创作",
    builtin: true,
    createdAt: 0,
    nodes: [
      n("i", "image", 0, 40),
      n("c", "caption", 340, 0, { mode: "prompt" }),
      n("s", "stylePreset", 340, 330),
      n("g", "imageGen", 720, 120),
    ],
    edges: [e("i", "c", "in-image"), e("c", "g", "in-text"), e("s", "g", "in-text"), e("i", "g", "in-image")],
  },
  {
    id: "seed_char",
    name: "示例 · 角色三视图/设定卡",
    builtin: true,
    createdAt: 0,
    nodes: [
      n("i", "image", 0, 40),
      n("cc", "charCard", 380, 0, { deliverables: ["turnaround", "expressions", "portrait", "sheet"] }),
    ],
    edges: [e("i", "cc", "in-image")],
  },
  {
    id: "seed_story",
    name: "示例 · 剧情拆分镜出图",
    builtin: true,
    createdAt: 0,
    nodes: [
      n("p", "prompt", 0, 0, { text: "深夜便利店，一只会说话的橘猫开始了它的第一天打工" }),
      n("l", "llmText", 340, 0, {
        op: "custom",
        custom: "把输入的剧情拆解成 4 个连贯分镜，每个分镜输出一行可直接用于 AI 绘画的中文提示词（含镜头/构图/光线），行与行之间用换行分隔，只输出这 4 行。",
      }),
      n("g", "imageGen", 720, 0, { count: 4 }),
    ],
    edges: [e("p", "l", "in-text"), e("l", "g", "in-text")],
  },
];
