/**
 * 媒体探测与质量报告（方案 §15.4 / §20.2）
 *
 * 桌面端：Rust media_probe（ffprobe：时长/分辨率/帧率/音轨/损坏）。
 * 浏览器预览：video 元素降级（只有时长/分辨率/音轨近似）。
 * 质量问题先形成报告（project.qualityReports）；是否重新生成/放大由用户确认，不自动花费费用。
 */
import { useAssets } from "./stores/assetStore";
import { useDirector } from "./stores/directorStore";
import { isTauri, errMsg } from "./utils";
import type { DirectorProject, DirectorQualityReport } from "./types";

export type ProbeResult = {
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
  corrupt?: boolean;
};

/** 探测单个资产文件（path 为空/未落盘时返回 null） */
export async function probeAsset(assetId: string): Promise<ProbeResult | null> {
  const a = useAssets.getState().items.find((x) => x.id === assetId);
  if (!a?.path || /^(blob:|data:)/i.test(a.path)) return null;
  if (isTauri) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const mediaTool = useDirector.getState().mediaTool;
      return await invoke<ProbeResult>("media_probe", {
        input: a.path,
        ffprobePath: mediaTool.ffprobePath ?? null,
      });
    } catch (e) {
      throw new Error(`媒体探测失败：${errMsg(e)}`);
    }
  }
  // 浏览器降级：<video>/<audio> 元素读 metadata
  return await new Promise((resolve) => {
    const url = a.path;
    const el = document.createElement(a.kind === "audio" ? "audio" : "video");
    el.preload = "metadata";
    el.muted = true;
    const done = (r: ProbeResult | null) => {
      el.src = "";
      resolve(r);
    };
    el.onloadedmetadata = () => {
      const v = el as HTMLVideoElement;
      done({
        durationSec: Number.isFinite(el.duration) ? el.duration : undefined,
        width: v.videoWidth || undefined,
        height: v.videoHeight || undefined,
        hasAudio: a.kind === "audio" || !!v.videoWidth,
      });
    };
    el.onerror = () => done({ corrupt: true });
    el.src = url;
  });
}

/** 判定质量问题（确定性规则，与 directorAnalysis.checkQuality 同口径的轻量版，含黑帧以外的全部项） */
function judge(report: Omit<DirectorQualityReport, "issues">, project: DirectorProject): NonNullable<DirectorQualityReport["issues"]> {
  const issues: NonNullable<DirectorQualityReport["issues"]> = [];
  const seg = project.scenes.flatMap((s) => s.segments).find((s) =>
    (s.takes ?? []).some((t) => t.id === report.takeId),
  );
  if (report.corrupt) issues.push({ level: "error", message: "文件无法读取（可能损坏或被移动）" });
  if (report.width && report.height) {
    const min = Math.min(report.width, report.height);
    if (min < 720) issues.push({ level: "warning", message: `分辨率 ${report.width}×${report.height} 低于 720p，建议高清放大` });
  }
  if (report.fps !== undefined && report.fps < 24) issues.push({ level: "warning", message: `帧率 ${report.fps.toFixed(1)} 低于 24fps` });
  if (seg && report.durationSec !== undefined && Math.abs(report.durationSec - seg.durationSec) > 2) {
    issues.push({ level: "warning", message: `实际时长 ${report.durationSec.toFixed(1)}s 与计划 ${seg.durationSec}s 偏差超过 2s` });
  }
  if (report.hasAudio === false) issues.push({ level: "info", message: "无音轨（若需原声请检查配方）" });
  return issues;
}

/**
 * 探测一个项目的全部采用 Take 并写回 qualityReports（幂等：按 takeId 覆盖）。
 * 返回新增问题总数，供 UI 提示。
 */
export async function probeApprovedTakes(projectId: string, onProgress?: (done: number, total: number) => void): Promise<{ reports: DirectorQualityReport[]; problems: number }> {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return { reports: [], problems: 0 };
  const tasks: Array<{ segId: string; takeId: string; assetId?: string }> = [];
  for (const sc of proj.scenes) {
    for (const seg of sc.segments) {
      const t = (seg.takes ?? []).find((x) => x.id === seg.approvedTakeId && x.status === "done" && x.assetId);
      if (t) tasks.push({ segId: seg.id, takeId: t.id, assetId: t.assetId });
    }
  }
  const reports: DirectorQualityReport[] = [];
  let problems = 0;
  for (let i = 0; i < tasks.length; i++) {
    onProgress?.(i, tasks.length);
    const t = tasks[i];
    const base: DirectorQualityReport = {
      takeId: t.takeId,
      segmentId: t.segId,
      assetId: t.assetId,
      probedAt: Date.now(),
    };
    try {
      const probe = t.assetId ? await probeAsset(t.assetId) : null;
      if (probe) Object.assign(base, probe);
      else base.corrupt = true;
    } catch {
      base.corrupt = true;
    }
    const issues = judge(base, proj);
    base.issues = issues;
    problems += issues.filter((x) => x.level !== "info").length;
    reports.push(base);
  }
  onProgress?.(tasks.length, tasks.length);
  // 写回（保留非采用 Take 的历史报告）
  const cur = useDirector.getState().getById(projectId);
  if (cur) {
    const byTake = new Map(reports.map((r) => [r.takeId, r]));
    const kept = (cur.qualityReports ?? []).filter((r) => !byTake.has(r.takeId));
    useDirector.getState().updateProject(projectId, { qualityReports: [...kept, ...reports] });
  }
  return { reports, problems };
}

/** 某片段最新质量报告（检查器/成片页显示用） */
export function reportForSegment(project: DirectorProject, segmentId: string): DirectorQualityReport | undefined {
  return (project.qualityReports ?? []).filter((r) => r.segmentId === segmentId).sort((a, b) => b.probedAt - a.probedAt)[0];
}
