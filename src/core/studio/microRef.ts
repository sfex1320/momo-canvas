/**
 * 22 帧微视频参考闭环（导演台 3.0 · 方案 §6.5 / §11.2）
 *
 * 上一段采用 Take
 *   → 媒体探测（时长/fps）
 *   → 从稳定结尾提取连续 22 帧（Rust/FFmpeg；浏览器预览降级 webm 截取）
 *   → 收录 micro-reference 资产（内容指纹去重）
 *   → 写入 ContinuityCapsule（来源段/Take/帧区间/fps/指纹可追溯）
 *   → 绑定下一段参考视频槽（relayKind: clip，标签显示「段 06 · Take 2 · 末 22 帧」）
 * 上游重新采用 → markStaleCapsules 标过期 → 用户预览/重取/重建。
 * 同指纹（sourceTakeId + 帧数 + 源资产）直接复用既有资产，不重复提取落盘。
 */
import { invoke } from "@tauri-apps/api/core";
import { useAssets } from "../stores/assetStore";
import { useDirector } from "../stores/directorStore";
import { assetToBlobUrl, assetUrl, fetchBytes } from "../services/assetFiles";
import { grabFrame, trimVideo } from "../videoEdit";
import { isTauri } from "../utils";
import { jobCenter } from "./jobCenter";
import type { ContinuityCapsule, DirectorProject, DirectorSegment, DirectorTake } from "../types";

export const MICRO_REF_FRAMES = 22;
const MICRO_LABEL = (storyIdx: number, takeNo: number, frames: number) =>
  `上一段末 ${frames} 帧微参考（段 ${String(storyIdx + 1).padStart(2, "0")} · Take ${takeNo}）`;

/** bytes → dataURL（collect 入口统一吃 dataURL/blob；plugin-http 不认 blob:，这里统一 dataURL） */
function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

type RustMicroRef = { outPath: string; startSec: number; endSec: number; fps: number; frames: number };

/** 桌面端：Rust/FFmpeg 提取末 N 帧（写系统临时目录，前端读回统一走资产收录） */
async function extractViaRust(srcPath: string, frames: number): Promise<RustMicroRef> {
  const out = await invoke<RustMicroRef>("extract_micro_reference", {
    src: srcPath,
    outPath: `${(await rustTmpDir())}\\momo_microref_${Date.now()}.mp4`,
    frames,
    ffmpegPath: ffmpegPref(),
  });
  return out;
}

/** 桌面端临时目录（asset 协议资产都在 AppData；微参考临时产物也放那，读完即删） */
async function rustTmpDir(): Promise<string> {
  const { assetsDir } = await import("../services/assetFiles");
  const base = await assetsDir();
  return `${base}\\microrefs`;
}

function ffmpegPref(): string | undefined {
  return useDirector.getState().mediaTool?.ffmpegPath;
}

/** 故事顺序紧邻上一段（方案 §6.5：禁止跨缺失片段乱接） */
export function prevSegmentOf(project: DirectorProject, segmentId: string): DirectorSegment | undefined {
  const flat = project.scenes.flatMap((s) => s.segments);
  const i = flat.findIndex((s) => s.id === segmentId);
  return i > 0 ? flat[i - 1] : undefined;
}

function relaySource(take: DirectorTake | undefined, segment: DirectorSegment): DirectorTake | undefined {
  if (take) return take;
  const done = (segment.takes ?? []).filter((t) => t.status === "done" && t.kind === "video" && t.assetId);
  return done.find((t) => t.id === segment.approvedTakeId) ?? done.sort((a, b) => b.createdAt - a.createdAt)[0];
}

export type MicroRefOutcome = {
  assetId: string;
  capsule: ContinuityCapsule;
  engine: "ffmpeg" | "web";
};

/**
 * 为 segmentId 提取/复用 22 帧微参考并写入胶囊 + 视频槽。
 * force = true 时忽略指纹复用强制重取（用户点「重取稳定区间」）。
 * 返回 null = 无可提取来源（首段/上一段无成功 Take）。
 */
export async function ensureMicroReference(
  projectId: string,
  segmentId: string,
  opts: { frames?: number; force?: boolean } = {},
): Promise<MicroRefOutcome | null> {
  const frames = opts.frames ?? MICRO_REF_FRAMES;
  const project = useDirector.getState().getById(projectId);
  if (!project) return null;
  const seg = project.scenes.flatMap((s) => s.segments).find((s) => s.id === segmentId);
  const prev = prevSegmentOf(project, segmentId);
  if (!seg || !prev) return null;
  const source = relaySource(undefined, prev);
  if (!source?.assetId) return null;

  const storyIdx = project.scenes.flatMap((s) => s.segments).findIndex((s) => s.id === prev.id);
  const takeNo = Math.max(1, (prev.takes ?? []).filter((t) => t.status === "done").findIndex((t) => t.id === source.id) + 1);
  const prevSegTakes = prev.takes ?? [];
  const fingerprint = `${source.id}#${frames}`;

  // ① 同指纹复用：胶囊未过期且资产仍存在 → 直接补绑（不重复提取）
  const existing = project.continuityCapsules?.find((c) => c.segmentId === segmentId);
  if (!opts.force && existing && existing.microFingerprint === fingerprint && existing.microReferenceAssetId) {
    const alive = useAssets.getState().items.find((a) => a.id === existing.microReferenceAssetId);
    if (alive) {
      bindMicroSlot(projectId, segmentId, alive.id, source.id, storyIdx, takeNo, frames, prevSegTakes.length);
      return { assetId: alive.id, capsule: existing, engine: existing.microEngine ?? "ffmpeg" };
    }
  }

  const srcAsset = useAssets.getState().items.find((a) => a.id === source.assetId);
  if (!srcAsset || srcAsset.kind !== "video") return null;

  const job = jobCenter.begin({ projectId, segmentId, kind: "microref", label: `提取末 ${frames} 帧微参考（段 ${storyIdx + 1}）` });
  try {
    let assetId: string;
    let engine: "ffmpeg" | "web";
    let range: [number, number];
    let fps = 25;
    if (isTauri && !srcAsset.path.startsWith("blob:")) {
      // ② 桌面端完整链：FFmpeg 提取（区间由 Rust 端按源时长钳制）
      job.stage("FFmpeg 提取末 22 帧");
      const r = await extractViaRust(srcAsset.path, frames);
      const { bytes } = await fetchBytes(assetUrl(r.outPath));
      const asset = await useAssets.getState().collect({
        src: bytesToDataUrl(bytes, "video/mp4"),
        kind: "video",
        name: `微参考_段${String(storyIdx + 1).padStart(2, "0")}_末${r.frames}帧`,
        director: { projectId, segmentId, role: "reference" },
        contentHash: fingerprint,
      });
      if (!asset) throw new Error("微参考资产收录失败");
      assetId = asset.id;
      engine = "ffmpeg";
      range = [r.startSec, r.endSec];
      fps = r.fps;
    } else {
      // ③ 浏览器预览降级：Web 抽帧定位 + MediaRecorder 截取（webm，时长≈frames/fps）
      job.stage("浏览器降级截取（Web）");
      const src = await assetToBlobUrl(srcAsset.path, srcAsset.mime).catch(() => assetUrl(srcAsset.path));
      const meta = await grabFrame(src, "last");
      fps = 25;
      const span = Math.min(frames / fps, meta.duration - 0.05);
      const clipBlobUrl = await trimVideo(src, Math.max(0, meta.duration - 0.04 - span), meta.duration - 0.04);
      const asset = await useAssets.getState().collect({
        src: clipBlobUrl,
        kind: "video",
        name: `微参考_段${String(storyIdx + 1).padStart(2, "0")}_降级`,
        director: { projectId, segmentId, role: "reference" },
        contentHash: fingerprint,
      });
      URL.revokeObjectURL(clipBlobUrl);
      if (!asset) throw new Error("微参考资产收录失败（降级路径）");
      assetId = asset.id;
      engine = "web";
      range = [Math.max(0, meta.duration - 0.04 - span), meta.duration - 0.04];
    }

    // ④ 胶囊：来源 + 帧区间 + fps + 指纹（过期/重建判定全靠它）
    const capsule: ContinuityCapsule = existing ?? {
      segmentId,
      sourceSegmentId: prev.id,
      sourceTakeId: source.id,
      stateSummary: seg.continuityIn ?? "",
      createdAt: Date.now(),
    };
    const updated: ContinuityCapsule = {
      ...capsule,
      sourceSegmentId: prev.id,
      sourceTakeId: source.id,
      microReferenceAssetId: assetId,
      microFrames: frames,
      microRangeSec: range,
      microFps: fps,
      microFingerprint: fingerprint,
      microEngine: engine,
      stale: false,
      createdAt: Date.now(),
    };
    const capsules = [
      ...(useDirector.getState().getById(projectId)?.continuityCapsules ?? []).filter((c) => c.segmentId !== segmentId),
      updated,
    ];
    useDirector.getState().updateProject(projectId, { continuityCapsules: capsules });
    // ⑤ 绑定视频槽（替换同源旧 clip 接力槽，不叠加）
    bindMicroSlot(projectId, segmentId, assetId, source.id, storyIdx, takeNo, frames, prevSegTakes.length);
    job.done(`微参考就绪（段 ${String(storyIdx + 1).padStart(2, "0")} · Take ${takeNo} · 末 ${frames} 帧）`);
    return { assetId, capsule: updated, engine };
  } catch (e) {
    job.fail(e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/** 微参考槽绑定：referenceVideo 语义 + relayKind clip（runBatch 的同源复用判定天然命中） */
function bindMicroSlot(
  projectId: string,
  segmentId: string,
  assetId: string,
  sourceTakeId: string,
  storyIdx: number,
  takeNo: number,
  frames: number,
  _takeCount: number,
): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  const label = MICRO_LABEL(storyIdx, takeNo, frames);
  useDirector.getState().updateProject(projectId, {
    scenes: proj.scenes.map((s) => ({
      ...s,
      segments: s.segments.map((g) => {
        if (g.id !== segmentId) return g;
        // 摘掉旧微参考/接力 clip 槽（帧槽保留——桥接帧职责不变），再追加新微参考
        const slots = (g.slots ?? []).filter(
          (x) => !(x.relayKind === "clip") && !/微参考|末尾 2 秒/.test(x.label ?? ""),
        );
        return {
          ...g,
          slots: [
            ...slots,
            {
              semantic: "referenceVideo" as const,
              assetIds: [assetId],
              auto: false,
              label,
              relayKind: "clip" as const,
              relaySourceTakeId: sourceTakeId,
            },
          ],
        };
      }),
    })),
  });
}

/** 胶囊显示文案：来源「段 06 / Take 2 / 末 22 帧」（方案 §6.5） */
export function microRefLabel(project: DirectorProject, capsule: ContinuityCapsule | undefined): string | null {
  if (!capsule?.microReferenceAssetId) return null;
  const flat = project.scenes.flatMap((s) => s.segments);
  const idx = flat.findIndex((s) => s.id === capsule.sourceSegmentId);
  const srcSeg = flat.find((s) => s.id === capsule.sourceSegmentId);
  const takeNo = srcSeg ? Math.max(1, (srcSeg.takes ?? []).findIndex((t) => t.id === capsule.sourceTakeId) + 1) : 1;
  return `段 ${String(idx + 1).padStart(2, "0")} / Take ${takeNo} / 末 ${capsule.microFrames ?? MICRO_REF_FRAMES} 帧`;
}
