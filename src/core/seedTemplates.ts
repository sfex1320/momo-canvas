/**
 * 内置示例工作流 — 「播种画布」：新手不用面对空白画布，插入即得连好线的可跑工作流
 * （Flora 模板播种 / Freepik 模板库的桌面端形态；不落盘、不可删除）
 */
import type { BoardTemplate, TemplateEdge, TemplateNode } from "./types";

function n(tid: string, kind: TemplateNode["kind"], x: number, y: number, data: Record<string, unknown> = {}): TemplateNode {
  return { tid, kind, x, y, data };
}
function e(sourceTid: string, targetTid: string, targetHandle: "in-text" | "in-image" | "in-video"): TemplateEdge {
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
    id: "seed_film",
    name: "示例 · 分镜短片流水线（图→视频→续接→成片）",
    builtin: true,
    createdAt: 0,
    nodes: [
      n("style", "prompt", 0, 240, { text: "整体风格：吉卜力水彩动画，柔和晨光，胶片颗粒（全片统一，改这里定调）" }),
      n("s1", "prompt", 380, 0, { text: "分镜1：小船驶出晨雾弥漫的港口，镜头缓慢推进" }),
      n("s2", "prompt", 380, 480, { text: "分镜2：海面跃出一群飞鱼，镜头右移跟随" }),
      n("g1", "imageGen", 760, 60),
      n("g2", "imageGen", 760, 540),
      n("v1", "videoGen", 1140, 60, { prompt: "" }),
      n("v2", "videoGen", 1140, 540, { prompt: "" }),
      n("f1", "frame", 1520, 300, { point: "last" }),
      n("cat", "videoConcat", 1520, 60),
      n("tip", "note", 0, 0, {
        text: "分镜短片流水线：\n① 风格提示词全片共用，分镜各写各的\n② 每镜先出图（可挑）再图生视频\n③ 「视频取帧」抽第 1 镜末帧 → 连给第 2 镜生视频节点当首帧参考 = 镜头衔接\n④ 全部生成后点「视频拼接」合成一条\n（想要更多分镜：框选一列节点 Alt+拖拽复制）",
        color: "blue",
      }),
    ],
    edges: [
      e("style", "g1", "in-text"),
      e("style", "g2", "in-text"),
      e("s1", "g1", "in-text"),
      e("s2", "g2", "in-text"),
      e("g1", "v1", "in-image"),
      e("g2", "v2", "in-image"),
      e("v1", "f1", "in-video"),
      e("f1", "v2", "in-image"),
      e("v1", "cat", "in-video"),
      e("v2", "cat", "in-video"),
    ],
  },
  {
    id: "seed_story",
    name: "示例 · 分镜节点拆故事",
    builtin: true,
    createdAt: 0,
    nodes: [
      n("p", "prompt", 0, 60, { text: "深夜便利店，一只会说话的橘猫开始了它的第一天打工" }),
      n("sb", "storyboard", 380, 0, {
        count: 4,
        shotSec: 5,
        style: "温暖治愈的深夜便利店，主角橘猫外观全片一致",
        tone: "日系动画",
      }),
      n("tip", "note", 380, -240, {
        text: "分镜节点用法：\n① 点「完善故事」把梗概补成完整故事（可编辑）\n② 设风格/定调/分镜数 → 点「生成分镜」\n③ 每镜右侧有独立输出口，或点「一键铺生图/铺视频」自动建好 N 个节点逐镜连线\n④ 时间轴按每镜秒数标注，和视频节点的时长设置对齐",
        color: "blue",
      }),
    ],
    edges: [e("p", "sb", "in-text")],
  },
];
