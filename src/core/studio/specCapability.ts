/**
 * 视频规格能力组装与报告合并（3.5 §6.5/§6.8）——导演台队列与预检共用的纯函数层。
 *
 * 两个职责：
 *  ① specCapabilityFor：把「配方能力快照」与「真实适配器协议能力」合成 resolveVideoSpec 的输入
 *     （built-in capability profile 必须在所有远程配方里可靠生效，预检与执行同一份）；
 *  ② mergeAdapterReport / mergeComfySpecReport：把适配器/ComfyUI 的真实写入报告合并进解析结果——
 *     Take 的 appliedVideoSpec 以合并结果为准，未应用项变 adjustment（applied: null），绝不照抄 requested。
 */
import type { DirectorRecipe, ModelCard, ResolvedVideoSpec } from "../types";
import type { SpecCapability } from "./videoSpec";
import { normalizeResolution } from "./videoSpec";
import { videoEngineCapability, type AdapterSpecReport } from "../services/videoGen";
import type { VideoSpecApplyReport } from "../services/comfy";

/** 配方快照（用户校准值）优先，适配器协议能力兜底；时长区间取配方快照（更贴近真实校准） */
export function specCapabilityFor(recipe: Pick<DirectorRecipe, "capabilitySnapshot"> | undefined, card?: ModelCard): SpecCapability {
  const base = card ? videoEngineCapability(card) : {};
  const snap = recipe?.capabilitySnapshot;
  if (!snap) return base;
  const durList = snap.durations;
  const step = durList && durList.length > 1 ? durList[1] - durList[0] : undefined;
  return {
    ...base,
    ...(snap.resolutions?.length ? { resolutions: snap.resolutions } : {}),
    ...(snap.maxDurationSec ? { duration: { min: Math.max(2, durList?.[0] ?? 2), max: snap.maxDurationSec, step: step && step > 0 ? step : undefined } } : {}),
  };
}

/** 适配器规格报告 → 合并进解析结果（applied 只保留真实发送项；未应用项转 adjustment） */
export function mergeAdapterReport(spec: ResolvedVideoSpec, report: AdapterSpecReport): ResolvedVideoSpec {
  const applied: ResolvedVideoSpec["applied"] = { ...spec.applied };
  const adjustments = [...spec.adjustments];
  if (report.durationSec !== undefined) applied.durationSec = report.durationSec;
  else {
    adjustments.push({ field: "durationSec", requested: spec.requested.durationSec, applied: null, reason: "时长未随请求发送（协议不接收时长字段）" });
    delete applied.durationSec;
  }
  if (report.resolution !== undefined) {
    applied.resolution = applied.resolution?.label.toLowerCase() === report.resolution.toLowerCase() ? applied.resolution : (normalizeResolution(report.resolution) ?? { label: report.resolution });
  } else {
    adjustments.push({ field: "resolution", requested: spec.requested.resolution.label, applied: null, reason: "分辨率未随请求发送（协议没有对应字段）" });
    delete applied.resolution;
  }
  if (report.fps !== undefined) applied.fps = report.fps;
  else {
    if (!adjustments.some((a) => a.field === "fps")) {
      adjustments.push({ field: "fps", requested: spec.requested.fps, applied: null, reason: "帧率未随请求发送（协议没有 FPS 直出参数）" });
    }
    delete applied.fps;
  }
  for (const u of report.unapplied ?? []) {
    if (!adjustments.some((a) => a.field === u.field && a.reason === u.reason)) {
      adjustments.push({ field: u.field, requested: fieldRequested(spec, u.field), applied: null, reason: u.reason });
    }
  }
  return { ...spec, applied, adjustments };
}

/** ComfyUI 写入报告 → 合并进解析结果（无入口项从 applied 移除并转 adjustment；warning 一并记录） */
export function mergeComfySpecReport(spec: ResolvedVideoSpec, report: VideoSpecApplyReport | undefined): ResolvedVideoSpec {
  if (!report) return spec;
  const applied: ResolvedVideoSpec["applied"] = { ...spec.applied };
  const adjustments = [...spec.adjustments];
  if (!report.durationApplied) {
    adjustments.push({ field: "durationSec", requested: spec.requested.durationSec, applied: null, reason: report.warnings.find((w) => /时长/.test(w)) ?? "模板没有时长/帧数入口——时长未生效" });
    delete applied.durationSec;
  }
  if (!report.fpsApplied && !report.actualValues.frames) {
    // 没写 fps 参数、也没按帧数换算：fps 完全没有生效通道
    if (!adjustments.some((a) => a.field === "fps")) {
      adjustments.push({ field: "fps", requested: spec.requested.fps, applied: null, reason: report.warnings.find((w) => /帧率|帧数/.test(w)) ?? "模板没有帧率入口——帧率未生效" });
    }
    delete applied.fps;
  } else if (report.actualValues.frames && !report.fpsApplied) {
    // 只按 fps×duration 写了总帧数：fps 本体没有独立入口，但换算真实发生——记录换算事实
    adjustments.push({
      field: "fps",
      requested: spec.requested.fps,
      applied: spec.requested.fps,
      reason: `模板只收总帧数：已按 ${spec.applied.fps ?? spec.requested.fps}fps × ${spec.requested.durationSec}s 写入 ${report.actualValues.frames} 帧（fps 无独立入口）`,
    });
  }
  if (!report.resolutionApplied) {
    adjustments.push({ field: "resolution", requested: spec.requested.resolution.label, applied: null, reason: report.warnings.find((w) => /分辨率/.test(w)) ?? "模板没有分辨率入口——分辨率未生效" });
    delete applied.resolution;
  }
  for (const w of report.warnings) {
    const field: ResolvedVideoSpec["adjustments"][number]["field"] | null = /帧率|帧数/.test(w) ? "fps" : /时长/.test(w) ? "durationSec" : /分辨率|比例/.test(w) ? "resolution" : null;
    if (field && !adjustments.some((a) => a.field === field && a.reason === w)) {
      adjustments.push({ field, requested: fieldRequested(spec, field), applied: null, reason: w });
    }
  }
  return { ...spec, applied, adjustments };
}

function fieldRequested(spec: ResolvedVideoSpec, field: "resolution" | "fps" | "durationSec"): unknown {
  return field === "resolution" ? spec.requested.resolution.label : spec.requested[field];
}
