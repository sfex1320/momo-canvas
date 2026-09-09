/**
 * 连续性上下文胶囊（方案 §10）— 尾帧接力的显式状态包与失效传播
 *
 * 素材基础沿用现有接力槽（segment.slots 里 relayKind=frame/clip 的槽，资产已持久化）；
 * 胶囊在此基础上补三件事：
 *  ① 显式记录「继承自 06 · Take 2」的来源与状态摘要（UI 可读）；
 *  ② 上游重新采用 Take 时把紧邻下游的胶囊标记「已过期」，由用户确认重建，绝不静默沿用；
 *  ③ 关闭接力时素材保留、只停止投喂（effectiveSlots 已有该语义，这里只负责胶囊状态一致）。
 *
 * 硬约束（方案 §10.3）：只有故事顺序中紧邻的上一段能被自动串接；非相邻片段不自动串。
 */
import { useDirector } from "./stores/directorStore";
import { toast } from "./stores/uiStore";
import type { ContinuityCapsule, DirectorProject, DirectorSegment, DirectorTake } from "./types";

/** 故事顺序平铺（场景顺序 → 片段顺序） */
export function storySegments(project: DirectorProject): DirectorSegment[] {
  return project.scenes.flatMap((s) => s.segments);
}

/** 片段在故事顺序中的序号（1 起；找不到返回 -1） */
export function storyIndex(project: DirectorProject, segmentId: string): number {
  return storySegments(project).findIndex((s) => s.id === segmentId);
}

/** 取某片段的胶囊（按 segmentId 归属查找） */
export function capsuleFor(project: DirectorProject, segmentId: string): ContinuityCapsule | undefined {
  return (project.continuityCapsules ?? []).find((c) => c.segmentId === segmentId);
}

/** 生成胶囊的状态摘要：上游片段的结束状态 + 场景规则（人物姿势/朝向/机位/光线等写在 continuityOut 里） */
function summarizeState(prevSeg: DirectorSegment, sourceTake: DirectorTake): string {
  const bits = [
    prevSeg.continuityOut?.trim(),
    `上游画面：${sourceTake.kind === "video" ? "视频" : "图片"} Take（${new Date(sourceTake.createdAt).toLocaleString()} 生成）`,
  ].filter(Boolean);
  return bits.join("；");
}

/**
 * 记录/刷新胶囊（fillRelaySlots 成功提取接力素材后调用）。
 * 桥接帧/动作片段资产 id 从槽位读取；stateSummary 以上游 continuityOut 为主。
 */
export function recordCapsule(
  projectId: string,
  segmentId: string,
  sourceSegmentId: string,
  sourceTakeId: string,
): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  const seg = storySegments(proj).find((s) => s.id === segmentId);
  const prevSeg = storySegments(proj).find((s) => s.id === sourceSegmentId);
  const sourceTake = prevSeg?.takes?.find((t) => t.id === sourceTakeId);
  if (!seg || !prevSeg || !sourceTake) return;
  const frameAssetId = (seg.slots ?? []).find((s) => s.relayKind === "frame")?.assetIds[0];
  const clipAssetId = (seg.slots ?? []).find((s) => s.relayKind === "clip")?.assetIds[0];
  const capsule: ContinuityCapsule = {
    segmentId,
    sourceSegmentId,
    sourceTakeId,
    bridgeFrameAssetId: frameAssetId,
    motionClipAssetId: clipAssetId,
    stateSummary: summarizeState(prevSeg, sourceTake),
    characterState: prevSeg.dialogue.length ? [`${prevSeg.summary.slice(0, 30)} 中出场的角色状态`] : undefined,
    cameraState: prevSeg.shots.length ? prevSeg.shots[prevSeg.shots.length - 1].camera : undefined,
    environmentState: proj.scenes.find((sc) => sc.id === prevSeg.sceneId)?.continuityRule,
    createdAt: Date.now(),
    stale: false,
  };
  const rest = (proj.continuityCapsules ?? []).filter((c) => c.segmentId !== segmentId);
  useDirector.getState().updateProject(projectId, { continuityCapsules: [...rest, capsule] });
}

/**
 * 失效传播（方案 §10.3 / §13.3）：上游片段的采用版本变化后，紧邻下游的胶囊标记过期。
 * 只标紧邻下游——上游的上游素材没变，不需要级联（重建下游时会重新提取最新上游）。
 */
export function markStaleCapsules(projectId: string, changedSegmentId: string): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  const segs = storySegments(proj);
  const idx = segs.findIndex((s) => s.id === changedSegmentId);
  if (idx < 0) return;
  const nextId = segs[idx + 1]?.id;
  if (!nextId) return;
  const capsules = proj.continuityCapsules ?? [];
  const hit = capsules.find((c) => c.segmentId === nextId && !c.stale);
  if (!hit) return;
  useDirector.getState().updateProject(projectId, {
    continuityCapsules: capsules.map((c) => (c.segmentId === nextId ? { ...c, stale: true } : c)),
  });
  toast(
    `片段 ${idx + 2} 的连续性接力已过期（上游采用了新版本）——生成前会自动重建，或在片段上点「重建接力」确认`,
    "info",
  );
}

/**
 * 重建胶囊：清掉过期标记与旧接力槽（资产保留在库），下次生成本段时按紧邻上游重新提取。
 * 用户显式确认的入口（片段树右键 / 检查器接力卡）。
 */
export function rebuildCapsule(projectId: string, segmentId: string): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  // 摘除接力槽（与 runBatch 内 clearRelaySlots 同语义；资产本体保留）
  const scenes = proj.scenes.map((sc) => ({
    ...sc,
    segments: sc.segments.map((seg) =>
      seg.id !== segmentId
        ? seg
        : { ...seg, slots: (seg.slots ?? []).filter((s) => !s.relayKind && !/自动接力/.test(s.label ?? "")) },
    ),
  }));
  const capsules = (proj.continuityCapsules ?? []).filter((c) => c.segmentId !== segmentId);
  useDirector.getState().updateProject(projectId, { scenes, continuityCapsules: capsules });
  toast("已清除旧的连续性接力素材，下次生成本段时会按紧邻上一段重新提取", "ok");
}

/** 胶囊状态的 UI 文案（片段树/检查器/Sequence Dock 共用） */
export function capsuleStatusLabel(project: DirectorProject, segmentId: string): { text: string; stale: boolean } | null {
  const cap = capsuleFor(project, segmentId);
  if (!cap) {
    // 没有胶囊但有接力开关时，显示「待接力」（首段/上游无成片）
    return null;
  }
  const n = storyIndex(project, cap.sourceSegmentId) + 1;
  const takeNo = ((storySegments(project).find((s) => s.id === cap.sourceSegmentId)?.takes ?? []).findIndex(
    (t) => t.id === cap.sourceTakeId,
  ) + 1) || 1;
  return {
    text: cap.stale ? `接力已过期（原自 ${String(n).padStart(2, "0")} · Take ${takeNo}）` : `继承自 ${String(n).padStart(2, "0")} · Take ${takeNo}`,
    stale: !!cap.stale,
  };
}
