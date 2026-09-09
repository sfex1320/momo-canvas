/**
 * videoSpec 解析器快测（node --experimental-strip-types 直接跑，tsc 已过类型）
 * 覆盖：标题三段式 / 元数据 / 正文兜底 / 时码排除 / 帧率语义要求 / 档位归一化
 */
import { parseVideoSpecFromSegment, normalizeResolution, normalizeFps, normalizeDuration, resolveVideoSpec } from "./videoSpec.ts";

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failed++;
    console.error(`✗ ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  } else console.log(`✓ ${name}`);
};

// 归一化
eq("档位 1080p", normalizeResolution("1080p"), { label: "1080p", width: 1920, height: 1080 });
eq("宽×高", normalizeResolution("1920×1080"), { label: "1920×1080", width: 1920, height: 1080 });
eq("4k 别名", normalizeResolution("UHD").label, "4K");
eq("孤立数字不是帧率", normalizeFps("段 03"), null);
eq("帧率语义", normalizeFps("24fps"), 24);
eq("中文帧率", normalizeFps("帧率：25"), 25);
eq("时长语义", normalizeDuration("15 秒"), 15);
eq("镜头时码不当时长", normalizeDuration("0-3s"), null);

// 标题三段式
const t1 = parseVideoSpecFromSegment("## H3-01｜雨夜失路｜15秒｜1080p｜24fps\n正文……", "## H3-01｜雨夜失路｜15秒｜1080p｜24fps");
eq("标题:分辨率", t1.resolution?.label, "1080p");
eq("标题:帧率", t1.fps, 24);
eq("标题:时长", t1.durationSec, 15);
eq("标题:来源", t1.sources?.resolution?.kind, "segment-title");

// 元数据行
const t2 = parseVideoSpecFromSegment("## 第03段\n分辨率：1920×1080\n帧率: 25 fps\n时长：12 秒\n正文", "## 第03段");
eq("元数据:分辨率", t2.resolution?.label, "1920×1080");
eq("元数据:帧率", t2.fps, 25);
eq("元数据:时长", t2.durationSec, 12);
eq("元数据:来源", t2.sources?.fps?.kind, "segment-metadata");

// 正文兜底 + 时码排除
const t3 = parseVideoSpecFromSegment("## 第04段\nShot 1: 0-3s camera push\n24fps, 1920x1080", "## 第04段");
eq("正文:帧率兜底", t3.fps, 24);
eq("正文:分辨率兜底", t3.resolution?.label, "1920×1080");
eq("正文:时长不认时码", t3.durationSec, undefined);

// resolveVideoSpec：分段值逐项优先，未识别项继承项目默认
const proj = {
  id: "x", nodeId: "", boardId: "", name: "t", createdAt: 0, updatedAt: 0, targetDurationSec: 60, aspect: "16:9",
  script: "", characters: [], scenes: [], recipes: [], globalSlots: [], timeline: [],
  schemaVersion: 4,
  videoSpecDefaults: { resolution: { label: "1080p", width: 1920, height: 1080 }, fps: 24, durationSec: 12 },
} as never as Parameters<typeof resolveVideoSpec>[0];
const seg = {
  id: "s1", sceneId: "c", durationSec: 10, summary: "", dialogue: [], shots: [], approvedTakeId: null, takes: [],
  videoSpec: { fps: 30, sources: { fps: { kind: "segment-title", raw: "30fps" } } },
} as never as Parameters<typeof resolveVideoSpec>[1];
const r = resolveVideoSpec(proj, seg);
eq("解析:fps 用分段值", r.applied.fps, 30);
eq("解析:分辨率继承默认", r.applied.resolution.label, "1080p");
eq("解析:时长用结构化值", r.applied.durationSec, 10);
eq("解析:来源", r.source.fps, "segment-title");


// —— 3.5 P0 补充：fps 不支持 / step 对齐后再钳制 / user 与 prefix 来源 ——
const proj2 = {
  ...proj,
  videoSpecFromPrefix: { resolution: { label: "720p", width: 1280, height: 720 }, fps: 25, durationSec: 10, sources: { fps: { kind: "project-prefix", raw: "25fps" } } },
} as never as Parameters<typeof resolveVideoSpec>[0];
const seg2 = {
  id: "s2", sceneId: "c", durationSec: 12, summary: "", dialogue: [], shots: [], approvedTakeId: null, takes: [],
} as never as Parameters<typeof resolveVideoSpec>[1];

// fps: null（引擎无直出参数）：不发送 + adjustment 明确「未应用」，applied 不含 fps
const rFpsNull = resolveVideoSpec(proj2, seg2, { fps: null });
eq("fps:null→applied 无 fps", rFpsNull.applied.fps, undefined);
eq("fps:null→adjustment 记录未应用", rFpsNull.adjustments.some((a) => a.field === "fps" && a.applied === null && /帧率直出/.test(a.reason)), true);
eq("fps:null→requested 保留原值", rFpsNull.requested.fps, 25);

// 前言来源：分段未识别时逐项落到 project-prefix
eq("prefix→source.fps", rFpsNull.source.fps, "project-prefix");
const rPrefixRes = resolveVideoSpec(proj2, seg2);
eq("prefix→分辨率", rPrefixRes.applied.resolution?.label, "720p");
eq("prefix→时长", rPrefixRes.applied.durationSec, 12); // segment.durationSec(12) 优先于前言 10

// step 对齐后超过 max 必须再钳制（min=4 max=15 step=2，15 → 对齐 16 → 钳回 15）
const rStep = resolveVideoSpec({ ...proj2, videoSpecFromPrefix: undefined } as never as Parameters<typeof resolveVideoSpec>[0], { ...seg2, durationSec: 15 } as never, { duration: { min: 4, max: 15, step: 2 } });
eq("step 对齐后再钳制", rStep.applied.durationSec, 15);

// step 对齐向上取（13 → 14，在 max 内正常对齐）
const rStep2 = resolveVideoSpec({ ...proj2, videoSpecFromPrefix: undefined } as never as Parameters<typeof resolveVideoSpec>[0], { ...seg2, durationSec: 13 } as never, { duration: { min: 4, max: 15, step: 2 } });
eq("step 对齐就近", rStep2.applied.durationSec, 14);

// 用户手改：source 必须变 user，且逐项优先
const segUser = { ...seg2, durationSec: 8, videoSpec: { user: { fps: 60, durationSec: 9, resolution: { label: "4K", width: 3840, height: 2160 } } } } as never as Parameters<typeof resolveVideoSpec>[1];
const rUser = resolveVideoSpec(proj2, segUser);
eq("user→fps", rUser.applied.fps, 60);
eq("user→分辨率", rUser.applied.resolution?.label, "4K");
eq("user→时长", rUser.applied.durationSec, 9);
eq("user→source.fps", rUser.source.fps, "user");
eq("user→source.durationSec", rUser.source.durationSec, "user");
eq("user→source.resolution", rUser.source.resolution, "user");

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
