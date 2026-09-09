/**
 * 成片时间线纯数据操作（方案 §11 / §20.2）
 *
 * 时间线本体始终由 deriveTimeline 从「采用版本 + 片段顺序」派生（不持久化整条时间线，
 * 防止采用变化后漂移）；这里管理的是叠在它上面的后期数据：
 *  - 片段级覆盖（入出点 / 转场 / 原声音量）：postTimeline.clipOverrides[segmentId]
 *  - 标题卡 / 字幕
 *  - 片段排序（场景树与 Sequence Dock 共用的 reorder）
 *  - 成片时间轴视图（buildPostTimeline：把派生时间线 + 覆盖 + 标题卡 + 音频轨排成一条轴）
 */
import { useDirector } from "./stores/directorStore";
import { useAssets } from "./stores/assetStore";
import { deriveTimeline } from "./directorEngine";
import { storySegments } from "./directorContinuity";
import { uid } from "./utils";
import type {
  DirectorAudioTrack,
  DirectorProject,
  DirectorSegment,
  DirectorTimelineEntry,
  PostClipOverride,
  PostSubtitle,
  PostTitleCard,
  PostTimelineData,
} from "./types";

/** postTimeline 安全缺省（迁移兜底；老项目/新字段缺失时统一走这里） */
export function ensurePostTimeline(project: DirectorProject): PostTimelineData {
  return project.postTimeline ?? { clipOverrides: {}, titleCards: [], subtitles: [], fit: "contain" };
}

/** 读取片段的后期覆盖（无则空对象，不写库） */
export function clipOverrideOf(project: DirectorProject, segmentId: string): PostClipOverride {
  return ensurePostTimeline(project).clipOverrides[segmentId] ?? { segmentId };
}

/** 写片段覆盖（合并写回 postTimeline） */
export function patchClipOverride(projectId: string, segmentId: string, patch: Partial<PostClipOverride>): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  const pt = ensurePostTimeline(proj);
  const cur = pt.clipOverrides[segmentId] ?? { segmentId };
  useDirector.getState().updateProject(projectId, {
    postTimeline: { ...pt, clipOverrides: { ...pt.clipOverrides, [segmentId]: { ...cur, ...patch, segmentId } } },
  });
}

/* ---------------- 片段排序（场景树 / Sequence Dock 共用） ---------------- */

/**
 * 把片段移动到目标场景的目标位置（拖动排序）。
 * 返回受连续性影响的下游片段描述（UI 提示「接力将过期」用，方案 §6.2）。
 */
export function reorderSegment(
  projectId: string,
  segId: string,
  targetSceneId: string,
  targetIndex: number,
): { affected: string[] } {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return { affected: [] };
  const before = storySegments(proj).map((s) => s.id);
  // 摘出片段
  let moved: DirectorSegment | undefined;
  const scenes = proj.scenes.map((sc) => ({
    ...sc,
    segments: sc.segments.filter((seg) => {
      if (seg.id === segId) {
        moved = seg;
        return false;
      }
      return true;
    }),
  }));
  if (!moved) return { affected: [] };
  const target = scenes.find((sc) => sc.id === targetSceneId) ?? scenes[0];
  if (!target) return { affected: [] };
  const idx = Math.max(0, Math.min(targetIndex, target.segments.length));
  target.segments.splice(idx, 0, { ...moved, sceneId: target.id });
  // 涉及场景重建（splice 直接改了新数组，安全：filter 已产出新数组）
  const nextScenes = scenes.map((sc) => (sc.id === target.id ? { ...sc, segments: [...target.segments] } : sc));
  useDirector.getState().updateProject(projectId, { scenes: nextScenes });
  // 影响范围：移动前后顺序变化的片段，其下游接力可能失配（不自动作废，只提示）
  const after = nextScenes.flatMap((sc) => sc.segments).map((s) => s.id);
  const changed = after.filter((id, i) => before[i] !== id);
  return { affected: changed.filter((id) => id !== segId) };
}

/** 上移/下移片段（无障碍替代入口，方案 §19） */
export function nudgeSegment(projectId: string, segId: string, dir: -1 | 1): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  for (const sc of proj.scenes) {
    const i = sc.segments.findIndex((s) => s.id === segId);
    if (i < 0) continue;
    const j = i + dir;
    if (j < 0 || j >= sc.segments.length) return; // 不跨场景移动（跨场景用拖动）
    const segs = [...sc.segments];
    [segs[i], segs[j]] = [segs[j], segs[i]];
    useDirector.getState().updateProject(projectId, {
      scenes: proj.scenes.map((x) => (x.id === sc.id ? { ...x, segments: segs } : x)),
    });
    return;
  }
}

/* ---------------- 成片时间轴视图（预演 / 导出共用） ---------------- */

export type PostClipView = {
  entry: DirectorTimelineEntry;
  segment: DirectorSegment;
  /** 应用入出点后的时长 */
  durSec: number;
  /** 成片时间轴上的起点 */
  startSec: number;
  override: PostClipOverride;
};

export type PostAudioView = {
  track: DirectorAudioTrack;
  /** 成片时间轴起点（绑定片段 = 片段起点；场景/全局 = 0） */
  startSec: number;
  /** 估算时长（无音频资产时按绑定片段时长） */
  durSec: number;
};

export type PostTimelineView = {
  clips: PostClipView[];
  titleCards: PostTitleCard[];
  subtitles: PostSubtitle[];
  audio: PostAudioView[];
  totalSec: number;
  fit: PostTimelineData["fit"];
};

/**
 * 构建成片时间轴视图：派生时间线 + 入出点/转场覆盖 + 标题卡 + 音频轨。
 * 缺片片段跳过（与 SRT/XML 的 deriveTimeline 游标语义一致，缺片不错位）。
 */
export function buildPostTimeline(project: DirectorProject): PostTimelineView {
  const pt = ensurePostTimeline(project);
  const entries = deriveTimeline(project);
  const segById = new Map(storySegments(project).map((s) => [s.id, s]));
  const clips: PostClipView[] = [];
  let cursor = 0;
  for (const e of entries) {
    const seg = segById.get(e.segmentId);
    if (!seg) continue;
    const ov = pt.clipOverrides[e.segmentId] ?? { segmentId: e.segmentId };
    const inS = Math.max(0, ov.inSec ?? e.inSec ?? 0);
    const outS = Math.min(e.durationSec, ov.outSec ?? e.outSec ?? e.durationSec);
    const dur = Math.max(0.1, outS - inS);
    clips.push({ entry: { ...e, inSec: inS, outSec: outS }, segment: seg, durSec: dur, startSec: cursor, override: ov });
    cursor += dur;
  }
  // 音频轨：片段级绑定对齐片段起点；场景/全局从 0 起
  const clipStart = new Map(clips.map((c) => [c.segment.id, c.startSec]));
  const audio: PostAudioView[] = [];
  for (const tr of project.audioTracks ?? []) {
    if (!tr.text?.trim() && !tr.assetId) continue;
    const startSec = tr.segmentId ? (clipStart.get(tr.segmentId) ?? 0) : 0;
    const seg = tr.segmentId ? segById.get(tr.segmentId) : undefined;
    audio.push({ track: tr, startSec, durSec: seg?.durationSec ?? project.targetDurationSec });
  }
  return {
    clips,
    titleCards: [...pt.titleCards].sort((a, b) => a.atSec - b.atSec),
    subtitles: [...pt.subtitles].sort((a, b) => a.startSec - b.startSec),
    audio,
    totalSec: Math.max(cursor, 0.1),
    fit: pt.fit,
  };
}

/* ---------------- 标题卡 / 字幕 / 画幅适配 ---------------- */

export function addTitleCard(projectId: string, card: Omit<PostTitleCard, "id">): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  const pt = ensurePostTimeline(proj);
  useDirector.getState().updateProject(projectId, {
    postTimeline: { ...pt, titleCards: [...pt.titleCards, { ...card, id: uid(8) }] },
  });
}

export function removeTitleCard(projectId: string, cardId: string): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  const pt = ensurePostTimeline(proj);
  useDirector.getState().updateProject(projectId, {
    postTimeline: { ...pt, titleCards: pt.titleCards.filter((c) => c.id !== cardId) },
  });
}

export function addSubtitle(projectId: string, startSec: number, endSec: number, text: string): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  const pt = ensurePostTimeline(proj);
  useDirector.getState().updateProject(projectId, {
    postTimeline: { ...pt, subtitles: [...pt.subtitles, { id: uid(8), startSec, endSec, text }] },
  });
}

export function patchSubtitle(projectId: string, id: string, patch: Partial<PostSubtitle>): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  const pt = ensurePostTimeline(proj);
  useDirector.getState().updateProject(projectId, {
    postTimeline: { ...pt, subtitles: pt.subtitles.map((s) => (s.id === id ? { ...s, ...patch } : s)) },
  });
}

export function removeSubtitle(projectId: string, id: string): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  const pt = ensurePostTimeline(proj);
  useDirector.getState().updateProject(projectId, {
    postTimeline: { ...pt, subtitles: pt.subtitles.filter((s) => s.id !== id) },
  });
}

export function setTimelineFit(projectId: string, fit: PostTimelineData["fit"]): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  useDirector.getState().updateProject(projectId, { postTimeline: { ...ensurePostTimeline(proj), fit } });
}

/* ---------------- 音轨混音参数（挂在 audioTracks 条目上） ---------------- */

export function patchAudioTrack(projectId: string, trackId: string, patch: Partial<DirectorAudioTrack> & object): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  useDirector.getState().updateProject(projectId, {
    audioTracks: (proj.audioTracks ?? []).map((t) => (t.id === trackId ? { ...t, ...patch } : t)),
  });
}

/** 计划文本（方案 §15.1）：范围 / 引擎 / 接力 / 后处理一览，任务条与确认卡共用 */
export function audioAssetUrls(project: DirectorProject): string[] {
  const urls: string[] = [];
  for (const tr of project.audioTracks ?? []) {
    if (tr.muted) continue;
    if (!tr.assetId) continue;
    const a = useAssets.getState().items.find((x) => x.id === tr.assetId);
    if (a) urls.push(a.path);
  }
  return urls;
}
