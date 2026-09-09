/**
 * 渲染计划与桌面端命令适配（方案 §12 / §20.2）
 *
 * 桌面端（Tauri）：buildRenderPlan 把「派生时间线 + 入出点/转场/音量覆盖 + 标题卡 + 音频轨 + 字幕」
 * 组装成纯数据计划，交给 Rust media_render（外部 ffmpeg 管线：分段裁切规范化 → 拼接 → 混音 →
 * 字幕烧录 → H.264 MP4；临时文件 + 原子落位，失败不覆盖旧成片）。
 * 浏览器预览：降级为 MediaRecorder 拼接（concatVideos），高级特性（入出点/字幕烧录/混音）不可用。
 */
import { useAssets } from "./stores/assetStore";
import { useDirector } from "./stores/directorStore";
import { isTauri, errMsg } from "./utils";
import { buildPostTimeline, type PostTimelineView } from "./directorTimeline";
import { mpToSize } from "./directorEngine";
import type { DirectorProject } from "./types";

/* ---------------- 输出预设（§12.2） ---------------- */

export type ExportPreset = {
  id: string;
  label: string;
  desc: string;
  mp: number;
  /** 画幅覆盖（不覆盖 = 用项目画幅） */
  aspect?: string;
};

export const EXPORT_PRESETS: ExportPreset[] = [
  { id: "1080h", label: "1080p 横屏", desc: "约 1920×1080 · 通用成片（宽高对齐 16 的倍数）", mp: 2.07, aspect: "16:9" },
  { id: "1080v", label: "1080p 竖屏", desc: "约 1080×1920 · 短视频通用", mp: 2.07, aspect: "9:16" },
  { id: "2k", label: "2K 高质量", desc: "约 2560×1440 · 高清交付", mp: 3.69 },
  { id: "4k", label: "4K 高质量", desc: "约 3840×2160 · 母版留存", mp: 8.29 },
  { id: "xhs", label: "小红书", desc: "约 1080×1440 · 3:4 竖版", mp: 1.56, aspect: "3:4" },
  { id: "dy", label: "抖音/视频号", desc: "约 1080×1920 · 9:16 竖屏", mp: 2.07, aspect: "9:16" },
];

/* ---------------- 渲染计划 ---------------- */

export type RenderClipPlan = {
  path: string;
  inSec: number;
  outSec: number;
  durSec: number;
  fadeIn?: number;
  fadeOut?: number;
  volume: number;
  muted: boolean;
  /* —— 3.0 基础变换（方案 §6.7：真实进入预演与 MP4）—— */
  flipH?: boolean;
  flipV?: boolean;
  rotate?: 0 | 90 | 180 | 270;
  /* —— 3.4：与下一段的转场真实进入渲染（fade=对称淡化近似交叉淡化）—— */
  transition?: "cut" | "fade";
  transitionDur?: number;
};

export type RenderAudioPlan = {
  path: string;
  atSec: number;
  volume: number;
  muted: boolean;
  fadeIn?: number;
  fadeOut?: number;
};

export type RenderTitlePlan = {
  atSec: number;
  durSec: number;
  kind: "title" | "black" | "image";
  text?: string;
  imagePath?: string;
};

export type RenderPlan = {
  clips: RenderClipPlan[];
  audio: RenderAudioPlan[];
  titles: RenderTitlePlan[];
  /** SRT 字幕全文（烧录用） */
  srt: string;
  width: number;
  height: number;
  fps: number;
  fit: "contain" | "cover" | "blur";
  /** 预计总时长（进度换算） */
  totalSec: number;
  /** 计划内引用的资产文件数（磁盘占用提示） */
  assetCount: number;
};

/** SRT 时间戳格式化（00:00:01,500） */
function srtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

/** 把时间线渲染成 SRT 文本（烧录与导出共用） */
export function buildSrt(view: PostTimelineView): string {
  if (view.subtitles.length) {
    return view.subtitles
      .map((s, i) => `${i + 1}\n${srtTime(s.startSec)} --> ${srtTime(s.endSec)}\n${s.text}\n`)
      .join("\n");
  }
  // 无手写字幕时从对白轨自动生成（§12.3：对白必须真正进入成片）
  const lines: string[] = [];
  let i = 0;
  for (const a of view.audio) {
    if (a.track.kind !== "dialogue" && a.track.kind !== "narration") continue;
    if (!a.track.text.trim()) continue;
    i++;
    lines.push(`${i}\n${srtTime(a.startSec)} --> ${srtTime(Math.min(a.startSec + a.durSec, a.startSec + Math.max(1.5, a.track.text.length / 5)))}\n${a.track.text}\n`);
  }
  return lines.join("\n");
}

/** 资产路径解析：必须是可读文件路径（桌面渲染管线不吃 data:/blob:） */
function assetPath(assetId?: string): string | undefined {
  if (!assetId) return undefined;
  const a = useAssets.getState().items.find((x) => x.id === assetId);
  if (!a?.path || /^(blob:|data:)/i.test(a.path)) return undefined;
  return a.path;
}

/** 组装渲染计划（预检 + 实际渲染都用它；缺资产的片段直接跳过并计入 skipped） */
export function buildRenderPlan(project: DirectorProject, presetId?: string): { plan: RenderPlan; skipped: number; missing: string[] } {
  const view = buildPostTimeline(project);
  const preset = EXPORT_PRESETS.find((p) => p.id === presetId);
  const aspect = preset?.aspect ?? project.aspect;
  const mp = preset?.mp ?? project.resolutionMP ?? 1;
  const size = mpToSize(aspect, mp);
  const clips: RenderClipPlan[] = [];
  const missing: string[] = [];
  for (const c of view.clips) {
    const take = c.segment.takes?.find((t) => t.id === c.entry.takeId);
    const path = assetPath(take?.assetId);
    if (!path) {
      missing.push(c.segment.summary.slice(0, 12));
      continue;
    }
    clips.push({
      path,
      inSec: c.entry.inSec ?? 0,
      outSec: c.entry.outSec ?? c.entry.durationSec,
      durSec: c.durSec,
      fadeIn: c.override.fadeIn,
      fadeOut: c.override.fadeOut,
      volume: c.override.muted ? 0 : (c.override.volume ?? 1),
      muted: !!c.override.muted,
      flipH: c.override.flipH || undefined,
      flipV: c.override.flipV || undefined,
      rotate: c.override.rotate || undefined,
      transition: c.override.transition,
      transitionDur: c.override.transitionDur,
    });
  }
  const audio: RenderAudioPlan[] = [];
  for (const a of view.audio) {
    if (a.track.muted) continue;
    const path = assetPath(a.track.assetId);
    if (!path) continue;
    audio.push({
      path,
      atSec: a.startSec,
      volume: a.track.volume ?? 1,
      muted: false,
      fadeIn: a.track.fadeIn,
      fadeOut: a.track.fadeOut,
    });
  }
  const titles: RenderTitlePlan[] = view.titleCards.map((t) => ({
    atSec: t.atSec,
    durSec: t.durSec,
    kind: t.kind,
    text: t.text,
    imagePath: assetPath(t.assetId),
  }));
  const assetSet = new Set<string>([...clips.map((c) => c.path), ...audio.map((a) => a.path), ...titles.map((t) => t.imagePath).filter(Boolean) as string[]]);
  return {
    plan: {
      clips,
      audio,
      titles,
      srt: buildSrt(view),
      width: size.width,
      height: size.height,
      fps: project.ruleSet?.generation?.fps ?? 30,
      fit: view.fit,
      totalSec: clips.reduce((n, c) => n + c.durSec, 0) + titles.reduce((n, t) => n + t.durSec, 0),
      assetCount: assetSet.size,
    },
    skipped: view.clips.length - clips.length,
    missing,
  };
}

/* ---------------- 执行渲染 ---------------- */

export type RenderProgress = { msg: string; pct?: number };

export type RenderResult = { url: string; path?: string; engine: "ffmpeg" | "webm-degrade" };

/** 桌面端 ffmpeg 定位（Rust 探测 PATH/常见位置；用户指定的路径优先） */
export async function locateFfmpeg(): Promise<{ ffmpeg?: string; ffprobe?: string }> {
  if (!isTauri) return {};
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const custom = useDirector.getState().mediaTool;
    return await invoke("media_locate", { custom: custom.ffmpegPath ?? null });
  } catch {
    return {};
  }
}

/**
 * 渲染成片。桌面端走 Rust ffmpeg 管线（原子落位）；浏览器预览降级 MediaRecorder 拼接
 * （无入出点/字幕/混音，仅串联）。outPath 为桌面端目标绝对路径。
 */
export async function renderToMp4(
  plan: RenderPlan,
  outPath: string,
  onProgress?: (p: RenderProgress) => void,
  /** 与 PostStation 的取消按钮对齐：不传则内部自生成（旧调用方兼容） */
  taskId?: string,
): Promise<RenderResult> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    const { Channel } = await import("@tauri-apps/api/core");
    const chan = new Channel<RenderProgress>();
    chan.onmessage = (m) => onProgress?.(m);
    const mediaTool = useDirector.getState().mediaTool;
    const r = await invoke<{ outPath: string }>("media_render", {
      taskId: taskId ?? `render_${Date.now()}`,
      plan: {
        clips: plan.clips.map((c) => ({
          path: c.path,
          inSec: c.inSec,
          outSec: c.outSec,
          durSec: c.durSec,
          fadeIn: c.fadeIn ?? null,
          fadeOut: c.fadeOut ?? null,
          volume: c.volume,
          muted: c.muted,
          flipH: c.flipH ?? false,
          flipV: c.flipV ?? false,
          rotate: c.rotate ?? 0,
          transition: c.transition ?? null,
          transitionDur: c.transitionDur ?? null,
        })),
        audio: plan.audio.map((a) => ({
          path: a.path,
          atSec: a.atSec,
          volume: a.volume,
          muted: a.muted,
          fadeIn: a.fadeIn ?? null,
          fadeOut: a.fadeOut ?? null,
        })),
        titles: plan.titles.map((t) => ({
          atSec: t.atSec,
          durSec: t.durSec,
          kind: t.kind,
          text: t.text ?? null,
          imagePath: t.imagePath ?? null,
        })),
        srt: plan.srt || null,
        width: plan.width,
        height: plan.height,
        fps: plan.fps,
        fit: plan.fit,
      },
      outPath,
      ffmpegPath: mediaTool.ffmpegPath ?? null,
    }, );
    return { url: `file://${r.outPath}`.replace(/\\/g, "/"), path: r.outPath, engine: "ffmpeg" };
  }
  // 浏览器降级：MediaRecorder 串联（videoEdit 内部处理 blob/data URL）
  onProgress?.({ msg: "浏览器预览模式：使用降级拼接（不含入出点/字幕/混音）" });
  const { concatVideos } = await import("./videoEdit");
  const urls = plan.clips.map((c) => {
    const a = useAssets.getState().items.find((x) => x.path === c.path);
    return a ? (a.path.startsWith("data:") || a.path.startsWith("blob:") ? a.path : c.path) : c.path;
  });
  const url = await concatVideos(urls, (msg) => onProgress?.({ msg }));
  return { url, engine: "webm-degrade" };
}

/** 取消渲染（杀 ffmpeg 子进程） */
export async function cancelRender(taskId: string): Promise<void> {
  if (!isTauri) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("media_render_cancel", { taskId });
  } catch (e) {
    throw new Error(`取消失败：${errMsg(e)}`);
  }
}
