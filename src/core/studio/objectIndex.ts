/**
 * 对象索引（导演台 3.0 · 方案 §3.2「对象驱动」/ §6.5 片段树状态）
 *
 * 把 scenes 树压成扁平对象视图：片段带状态徽标（缺分镜/缺参考/可生成/排队/生成中/
 * 失败/待采用/已采用/来源过期），角色/剧本做反向索引（受影响片段）。
 * 只读派生，不复制数据——所有工位共享同一份 project 真相。
 */
import type { ContinuityCapsule, DirectorCharacter, DirectorProject, DirectorScene, DirectorSegment } from "../types";

/** 片段在片段树上的工作状态（方案 §6.5 左侧片段树） */
export type SegmentStatus =
  | "empty" // 缺分镜：没有摘要/提示词
  | "no-refs" // 缺参考：有文案但没有可用参考素材
  | "ready" // 可生成
  | "queued" // 排队
  | "running" // 生成中
  | "failed" // 失败（有 error Take 且无成功版本）
  | "pending" // 待采用：有完成版本但未选片
  | "approved" // 已采用
  | "stale"; // 来源已过期：接力胶囊过期（上游换了版本）

export const SEGMENT_STATUS_LABEL: Record<SegmentStatus, string> = {
  empty: "缺分镜",
  "no-refs": "缺参考",
  ready: "可生成",
  queued: "排队",
  running: "生成中",
  failed: "失败",
  pending: "待采用",
  approved: "已采用",
  stale: "来源过期",
};

/** 扁平片段视图（保留场景归属，树渲染与故事顺序都从它出） */
export type SegmentView = {
  segment: DirectorSegment;
  scene: DirectorScene;
  sceneIndex: number;
  /** 故事顺序（跨场景 0 起） */
  storyIndex: number;
  status: SegmentStatus;
  /** 采用 Take 的缩略图资产 id（树/时间线显示用） */
  posterAssetId?: string;
  /** 接力胶囊（含 22 帧微参考追溯） */
  capsule?: ContinuityCapsule;
};

export type ObjectIndex = {
  segments: SegmentView[];
  byId: Map<string, SegmentView>;
  /** 角色反向索引：角色 id → 出场片段视图列表（受影响片段，方案 §6.3） */
  segmentsOfCharacter: (characterId: string) => SegmentView[];
};

/** 片段出场角色：摘要/对白/镜头文案里按名字命中（编译链同源；名字太短防误报） */
export function charactersInSegment(project: DirectorProject, seg: DirectorSegment): DirectorCharacter[] {
  const hay = [seg.summary, ...seg.dialogue, seg.continuityIn ?? "", seg.continuityOut ?? "", seg.promptOverride ?? "", seg.promptFinalOverride ?? ""]
    .join("\n");
  return (project.characters ?? []).filter((c) => c.name.trim().length >= 2 && hay.includes(c.name));
}

function statusOf(project: DirectorProject, seg: DirectorSegment, capsule?: ContinuityCapsule): SegmentStatus {
  const takes = seg.takes ?? [];
  const running = takes.some((t) => t.status === "running" || t.status === "queued");
  if (running) return takes.some((t) => t.status === "running") ? "running" : "queued";
  if (capsule?.stale) return "stale";
  const done = takes.filter((t) => t.status === "done");
  if (seg.approvedTakeId && done.some((t) => t.id === seg.approvedTakeId)) return "approved";
  if (done.length) return "pending";
  if (takes.some((t) => t.status === "error")) return "failed";
  if (!seg.summary.trim() && !seg.promptOverride?.trim() && !seg.promptFinalOverride?.trim()) return "empty";
  const hasRefs =
    (seg.slots ?? []).some((s) => s.assetIds.length > 0) ||
    project.globalSlots.some((s) => s.assetIds.length > 0);
  return hasRefs ? "ready" : "no-refs";
}

/** 构建对象索引（useMemo 友好：依赖 project.scenes / characters / capsules） */
export function buildObjectIndex(project: DirectorProject): ObjectIndex {
  const segments: SegmentView[] = [];
  let story = 0;
  project.scenes.forEach((scene, sceneIndex) => {
    for (const segment of scene.segments) {
      const capsule = project.continuityCapsules?.find((c) => c.segmentId === segment.id);
      const approved = (segment.takes ?? []).find((t) => t.id === segment.approvedTakeId && t.status === "done");
      const latestDone = approved ?? [...(segment.takes ?? [])].filter((t) => t.status === "done").sort((a, b) => b.createdAt - a.createdAt)[0];
      segments.push({
        segment,
        scene,
        sceneIndex,
        storyIndex: story++,
        status: statusOf(project, segment, capsule),
        posterAssetId: latestDone?.assetId,
        capsule,
      });
    }
  });
  const byId = new Map(segments.map((s) => [s.segment.id, s]));
  return {
    segments,
    byId,
    segmentsOfCharacter: (characterId) => {
      const ch = (project.characters ?? []).find((c) => c.id === characterId);
      if (!ch) return [];
      return segments.filter((s) => charactersInSegment(project, s.segment).some((c) => c.id === characterId));
    },
  };
}

/** 面包屑地址：项目 / 场景 / 片段（方案 §4.3） */
export function breadcrumbFor(index: ObjectIndex, segId?: string | null): string[] {
  const v = segId ? index.byId.get(segId) : undefined;
  return v ? [v.scene.location || `场景 ${v.sceneIndex + 1}`, `片段 ${String(v.storyIndex + 1).padStart(2, "0")}`] : [];
}
