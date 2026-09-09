/**
 * 统一视频规格（3.5 · 方案 §6）——严格限定三项：分辨率、帧率、时长。
 *
 * 三层结构：
 *  ① 归一化解析（parseVideoSpecFromSegment）：从分段标题 / 显式元数据 / 正文确定性识别，保留命中原文；
 *  ② 解析优先级（resolveVideoSpec）：用户手改 > 分段明确值 > 项目前言 > 项目默认 > 配方默认，逐项独立；
 *  ③ 引擎映射：外部模型与 ComfyUI 都只消费 ResolvedVideoSpec，不在适配器里各自定默认。
 *
 * 铁律（§12）：不把规格扩张成画幅/音频/Seed 大杂烩；不把镜头内时码（0-3s）误认成本段时长；
 * 只扫描本分段边界内的文本；中英文冲突不静默选择（由调用方在预演中呈现）。
 */

import type { DirectorProject, DirectorSegment, ResolvedVideoSpec, SegmentVideoSpec, VideoResolution } from "../types";

/* ---------------- 归一化 ---------------- */

const RES_PRESETS: Array<{ re: RegExp; label: string; w: number; h: number }> = [
  { re: /\b(2160p|4k|uhd)\b/i, label: "4K", w: 3840, h: 2160 },
  { re: /\b1440p|2k\b/i, label: "2K", w: 2560, h: 1440 },
  { re: /\b1080p|full\s*hd|fhd\b/i, label: "1080p", w: 1920, h: 1080 },
  { re: /\b720p|hd\b/i, label: "720p", w: 1280, h: 720 },
  { re: /\b480p|sd\b/i, label: "480p", w: 854, h: 480 },
];
const KNOWN_FPS = new Set([23.976, 24, 25, 29.97, 30, 50, 60]);

/** 文本 → 标准分辨率（480p~4K 档位 + 宽×高写法）；认不出返回 null */
export function normalizeResolution(raw: string): VideoResolution | null {
  const t = raw.trim();
  const dim = t.match(/(\d{3,5})\s*[x×*]\s*(\d{3,5})/i);
  if (dim) {
    const w = Number(dim[1]);
    const h = Number(dim[2]);
    if (w >= 200 && h >= 200 && w <= 8192 && h <= 8192) return { label: `${w}×${h}`, width: w, height: h };
  }
  for (const p of RES_PRESETS) {
    if (p.re.test(t)) return { label: p.label, width: p.w, height: p.h };
  }
  return null;
}

/** 文本 → 帧率：必须带 fps/帧率/frame rate 语义；孤立数字不识别（§6.3） */
export function normalizeFps(raw: string): number | null {
  const m = raw.match(/(\d{2}(?:\.\d+)?)\s*(?:fps|帧率|帧\/秒|frame\s*rate)/i) ?? raw.match(/(?:fps|帧率)[:：]?\s*(\d{2}(?:\.\d+)?)/i);
  if (!m) return null;
  const v = Number(m[1]);
  if (KNOWN_FPS.has(v)) return v; // 精确档位优先：24 就是 24，不吸到 23.976
  const near = [...KNOWN_FPS].find((k) => Math.abs(k - v) < 0.05); // 23.98 → 23.976 这类写法归档
  return near ?? (v >= 12 && v <= 120 ? Math.round(v * 1000) / 1000 : null);
}

/** 文本 → 时长（秒）；必须带 秒/s/sec/Duration 语义 */
export function normalizeDuration(raw: string): number | null {
  const m =
    raw.match(/(?<![\d-])(\d{1,3}(?:\.\d+)?)\s*(?:秒|s\b|sec\b|seconds?)/i) ??
    raw.match(/(?:时长|duration)[:：]?\s*(\d{1,3}(?:\.\d+)?)/i);
  if (!m) return null;
  const v = Number(m[1]);
  return v >= 2 && v <= 60 ? Math.round(v * 10) / 10 : null;
}

/* ---------------- 分段识别 ---------------- */

/** 从一个分段的标题行 / 元数据行 / 正文识别三项规格（保留原文与行号；只扫本段边界内文本） */
export function parseVideoSpecFromSegment(rawSegment: string, titleLine?: string): SegmentVideoSpec {
  const spec: SegmentVideoSpec = { sources: {} };
  const lines = rawSegment.split(/\r?\n/);

  // ① 标题：`## H3-01｜雨夜失路｜15秒｜1080p｜24fps`（全角｜与 | 都认）
  if (titleLine) {
    const parts = titleLine.split(/[|｜]/);
    for (const part of parts) {
      if (!spec.resolution) {
        const r = normalizeResolution(part);
        if (r) spec.resolution = r, (spec.sources ??= {}).resolution = { kind: "segment-title", raw: part.trim() };
      }
      if (spec.fps === undefined) {
        const f = normalizeFps(part);
        if (f !== null) spec.fps = f, (spec.sources ??= {}).fps = { kind: "segment-title", raw: part.trim() };
      }
      if (spec.durationSec === undefined) {
        const d = normalizeDuration(part);
        if (d !== null) spec.durationSec = d, (spec.sources ??= {}).durationSec = { kind: "segment-title", raw: part.trim() };
      }
    }
  }

  // ② 显式元数据行：分辨率：1920×1080 / 帧率: 24 fps / Duration: 15s（中英都认）
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/(?:分辨率|resolution|帧率|fps|frame\s*rate|时长|duration)/i.test(l)) continue;
    if (spec.resolution === undefined && /(?:分辨率|resolution)/i.test(l)) {
      const r = normalizeResolution(l);
      if (r) spec.resolution = r, (spec.sources ??= {}).resolution = { kind: "segment-metadata", raw: l.trim(), line: i + 1 };
    }
    if (spec.fps === undefined && /(?:帧率|fps|frame\s*rate)/i.test(l)) {
      const f = normalizeFps(l);
      if (f !== null) spec.fps = f, (spec.sources ??= {}).fps = { kind: "segment-metadata", raw: l.trim(), line: i + 1 };
    }
    if (spec.durationSec === undefined && /(?:时长|duration)/i.test(l)) {
      const d = normalizeDuration(l);
      if (d !== null) spec.durationSec = d, (spec.sources ??= {}).durationSec = { kind: "segment-metadata", raw: l.trim(), line: i + 1 };
    }
    if (spec.resolution && spec.fps !== undefined && spec.durationSec !== undefined) break;
  }

  // ③ 正文明确句：`24fps, 1920x1080, duration 15 seconds`（只在缺项时兜底；排除镜头时码行）
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // 镜头内部时间轴（0-3s / 00:00-00:06）不是本段总时长——只对 fps/resolution 兜底，时长不认正文
    if (spec.fps === undefined && /(?:fps|帧率)/i.test(l)) {
      const f = normalizeFps(l);
      if (f !== null) spec.fps = f, (spec.sources ??= {}).fps = { kind: "segment-body", raw: l.trim(), line: i + 1 };
    }
    if (spec.resolution === undefined && /\d{3,5}\s*[x×*]\s*\d{3,5}/i.test(l)) {
      const r = normalizeResolution(l);
      if (r) spec.resolution = r, (spec.sources ??= {}).resolution = { kind: "segment-body", raw: l.trim(), line: i + 1 };
    }
    if (spec.resolution && spec.fps !== undefined) break;
  }

  if (!Object.keys(spec.sources ?? {}).length) delete spec.sources;
  return spec;
}

/** 项目前言统一规格识别（作为项目默认值候选；§6.3：分段明确值优先于它） */
export function parseVideoSpecFromPrefix(prefix: string): SegmentVideoSpec {
  return parseVideoSpecFromSegment(prefix, undefined);
}

/* ---------------- 解析优先级 ---------------- */

export type SpecCapability = {
  /** 引擎支持的分辨率档（空 = 任意）；命中才原值提交，否则就近调整 */
  resolutions?: string[];
  /**
   * 帧率能力：{ min, max } = 支持区间；null = 引擎没有 FPS 直出参数
   * （不发送 fps 字段、adjustments 记录「未应用」，交付阶段可补帧/转帧率）
   */
  fps?: { min: number; max: number } | null;
  duration?: { min: number; max: number; step?: number };
};

const FALLBACK_RES: VideoResolution = { label: "1080p", width: 1920, height: 1080 };
const FALLBACK_FPS = 24;

function nearestRes(label: string, list: string[]): string | null {
  const h = Number(label.match(/(\d{3,4})p/i)?.[1] ?? label.match(/(\d{3,4})×/)?.[1] ?? 0);
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of list) {
    const ch = Number(c.match(/(\d{3,4})p/i)?.[1] ?? 0);
    const d = Math.abs(ch - h);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/**
 * 逐项独立取值（§6.4：不能整包覆盖）：
 * 用户手改(user) → 分段识别 → 项目前言 → 项目统一设置 → 配方/模型默认。
 * 引擎能力处理：
 *  - 区间/档位不匹配 → 就近调整并记 adjustments（显示模型实际采用的值）；
 *  - 能力声明 null（如 FPS 无直出参数）→ 不发送、applied 不含该项、adjustments 明确「未应用」。
 */
export function resolveVideoSpec(
  project: DirectorProject,
  segment: DirectorSegment,
  capability?: SpecCapability,
): ResolvedVideoSpec {
  const d = project.videoSpecDefaults;
  const seg = segment.videoSpec;
  const user = seg?.user;
  const prefix = project.videoSpecFromPrefix;
  const src: ResolvedVideoSpec["source"] = {};
  const adj: ResolvedVideoSpec["adjustments"] = [];

  // 时长：用户手改 > segment.durationSec（结构化真源，识别值导入时已写入）> 项目前言 > 项目默认
  let durationSec = user?.durationSec ?? (segment.durationSec || prefix?.durationSec || d?.durationSec || 12);
  src.durationSec =
    user?.durationSec !== undefined
      ? "user"
      : seg?.sources?.durationSec?.kind ?? (prefix?.durationSec !== undefined ? "project-prefix" : segment.durationSec ? "segment-body" : "project-default");

  // 分辨率：用户手改 > 分段识别 > 项目前言 > 项目默认 > 兜底
  const reqRes: VideoResolution = user?.resolution ?? seg?.resolution ?? prefix?.resolution ?? d?.resolution ?? FALLBACK_RES;
  let res: VideoResolution = reqRes;
  src.resolution =
    user?.resolution
      ? "user"
      : seg?.resolution
        ? (seg.sources?.resolution?.kind ?? "segment-body")
        : prefix?.resolution
          ? "project-prefix"
          : d?.resolution
            ? "project-default"
            : "recipe-default";

  // 帧率：用户手改 > 分段识别 > 项目前言 > 项目默认 > 兜底
  const reqFps = user?.fps ?? seg?.fps ?? prefix?.fps ?? d?.fps ?? FALLBACK_FPS;
  let fps: number | undefined = reqFps;
  src.fps =
    user?.fps !== undefined
      ? "user"
      : seg?.fps !== undefined
        ? (seg.sources?.fps?.kind ?? "segment-body")
        : prefix?.fps !== undefined
          ? "project-prefix"
          : d?.fps
            ? "project-default"
            : "recipe-default";

  // 能力钳制：分辨率档位就近 / fps 区间或整项不支持 / 时长 min-max-step
  if (capability?.resolutions?.length) {
    const hit = capability.resolutions.find((c) => c.toLowerCase() === res.label.toLowerCase());
    if (!hit) {
      const near = nearestRes(res.label, capability.resolutions);
      if (near && near !== res.label) {
        adj.push({ field: "resolution", requested: res.label, applied: near, reason: `引擎只支持 ${capability.resolutions.join("/")}` });
        res = normalizeResolution(near) ?? res;
        res = { ...res, label: near };
      }
    }
  }
  if (capability?.fps === null) {
    // 引擎没有 FPS 直出参数：不发送（applied 缺省该项），明确记录未应用
    adj.push({ field: "fps", requested: fps, applied: null, reason: "该引擎没有帧率直出参数——未发送 fps，交付阶段可补帧/转帧率" });
    fps = undefined;
  } else if (capability?.fps) {
    const { min, max } = capability.fps;
    if (fps < min || fps > max) {
      const clamped = Math.min(max, Math.max(min, fps));
      adj.push({ field: "fps", requested: fps, applied: clamped, reason: `引擎帧率范围 ${min}~${max}` });
      fps = clamped;
    }
  }
  if (capability?.duration) {
    const { min, max, step } = capability.duration;
    let dur = durationSec;
    let changed = false;
    if (dur < min || dur > max) {
      dur = Math.min(max, Math.max(min, dur));
      changed = true;
    }
    if (step && (dur - min) % step > 0.01) {
      dur = Math.round((min + Math.round((dur - min) / step) * step) * 10) / 10;
      changed = true;
      // 步长对齐可能把值顶过 max（如 min=4 max=15 step=2 时 15→16）：对齐后必须再钳一次
      if (dur > max) dur = max;
    }
    if (changed) {
      adj.push({ field: "durationSec", requested: durationSec, applied: dur, reason: `引擎时长能力 ${min}~${max}s${step ? `（步进 ${step}）` : ""}` });
      durationSec = dur;
    }
  }

  const requested = { resolution: reqRes, fps: reqFps, durationSec: user?.durationSec ?? (segment.durationSec || prefix?.durationSec || d?.durationSec || 12) };
  const applied: ResolvedVideoSpec["applied"] = { durationSec };
  applied.resolution = res;
  if (fps !== undefined) applied.fps = fps;
  return { requested, applied, source: src, adjustments: adj };
}
