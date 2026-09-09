/**
 * 导演台项目迁移唯一入口（方案 §16.4 / §20.3；3.0 方案 §12.3 v2→v3）
 *
 * DirectorProject.schemaVersion 升级必须在这里加明确迁移步骤，不再依赖散落各处的缺省字段修补。
 * 当前链路：v1 → v2（导演台 2.0）→ v3（制片工作站：剧本库 / MV / 制图历史 / studioUi）。
 * 迁移是幂等的——已是目标版本的项目原样返回（只兜底必填数组）。
 * v2 → v3 映射（方案 §12.3）：
 *  - script → 首个 ScriptDocument（origin: project，正式状态），script 正文不动；
 *  - workspaceMode / cockpitView 不迁移到产品状态，只留在数据里（UI 已退役，不再读取）。
 */
import type { DirectorProject, ScriptDocument } from "./types";
import { uid } from "./utils";
import { parseVideoSpecFromSegment } from "./studio/videoSpec";
import { parseH3PromptBody } from "./studio/h3Bilingual";
import { isH3ReadyPrompt } from "./directorEngine";
import { collectSegmentMarks } from "./segmentParse";
import type { H3BilingualPrompt, SegmentLocks } from "./types";

export const DIRECTOR_SCHEMA_VERSION = 6;

/** v1 → v2：补 2.0 可选字段安全缺省（内联在 v3 链路里，老数据一步到位） */
function ensureV2(p: DirectorProject): DirectorProject {
  return {
    ...p,
    script: p.script ?? "",
    characters: p.characters ?? [],
    scenes: p.scenes ?? [],
    recipes: p.recipes ?? [],
    globalSlots: p.globalSlots ?? [],
    timeline: p.timeline ?? [],
    workspaceMode: p.workspaceMode ?? "pro",
    uiState: p.uiState ?? {
      workspace: "planning",
      inspectorTab: "content",
      cockpitView: "cockpit",
      treeCollapsed: false,
      segId: null,
    },
    postTimeline: p.postTimeline ?? { clipOverrides: {}, titleCards: [], subtitles: [], fit: "contain" },
    promptRevisions: p.promptRevisions ?? [],
    continuityCapsules: p.continuityCapsules ?? [],
    qualityReports: p.qualityReports ?? [],
    schemaVersion: 2,
  };
}

/** v2 → v3：正文转首个剧本库文档；工位态缺省 H3 导演台；新实体给空数组 */
function v2ToV3(p: DirectorProject): DirectorProject {
  const now = Date.now();
  const firstDoc: ScriptDocument | null = p.script?.trim()
    ? {
        id: uid(10),
        title: p.name || "项目剧本",
        status: "official",
        targetDurationSec: p.targetDurationSec,
        versions: [{ id: uid(10), label: "项目初始剧本", body: p.script, createdAt: now }],
        origin: "project",
        createdAt: now,
        updatedAt: now,
      }
    : null;
  return {
    ...p,
    scripts: p.scripts ?? (firstDoc ? [firstDoc] : []),
    mvProjects: p.mvProjects ?? [],
    imageStudio: p.imageStudio ?? {},
    studioUi: p.studioUi ?? { station: "h3", segId: null },
    schemaVersion: 3,
  };
}

/** v3 → v4（3.5）：主剧本推断 + 统一视频规格默认值（旧散落规格收敛）+ 直录段重扫识别分段规格 */
function v3ToV4(p: DirectorProject): DirectorProject {
  // 主剧本优先级（§8.1）：studioUi.scriptId > 最新 official > 第一份
  const primary =
    p.scripts?.find((d) => d.id === p.studioUi?.scriptId)?.id ??
    p.scripts?.find((d) => d.status === "official")?.id ??
    p.scripts?.[0]?.id;
  // 旧散落规格收敛为 videoSpecDefaults（resolutionMP → 分辨率档；ruleSet.generation.fps/resolution 补齐）
  const mp = p.resolutionMP ?? 1;
  const resLabel = mp >= 3.5 ? "4K" : mp >= 1.8 ? "2K" : mp >= 0.95 ? "1080p" : "720p";
  const genRes = (p as { ruleSet?: { generation?: { resolution?: string; fps?: number } } }).ruleSet?.generation;
  return {
    ...p,
    primaryScriptId: p.primaryScriptId ?? primary,
    videoSpecDefaults: p.videoSpecDefaults ?? {
      resolution: { label: genRes?.resolution ?? resLabel },
      fps: genRes?.fps ?? 24,
    },
    // 直录段（scriptText/promptOverride 承载原文）重扫三项规格——只填空，不覆盖已有手改
    scenes: p.scenes.map((sc) => ({
      ...sc,
      segments: sc.segments.map((seg) => {
        if (seg.videoSpec) return seg;
        const raw = seg.scriptText ?? seg.promptOverride ?? "";
        if (!raw) return seg;
        const spec = parseVideoSpecFromSegment(raw);
        return Object.keys(spec.sources ?? {}).length ? { ...seg, videoSpec: spec } : seg;
      }),
    })),
    schemaVersion: 4,
  };
}

/** v4 → v5（3.5 P3）：锁分离 + H3 双语模型迁移（§8.3） */
function v4ToV5(p: DirectorProject): DirectorProject {
  return {
    ...p,
    scenes: p.scenes.map((sc) => ({
      ...sc,
      segments: sc.segments.map((seg) => {
        const isH3 = isH3ReadyPrompt(seg.promptOverride ?? "") || isH3ReadyPrompt(seg.promptFinalOverride ?? "");
        // 锁分离：旧 locked 只迁移为结构锁；最终稿存在 = 执行稿锁
        const locks: SegmentLocks = seg.locks ?? {
          structure: !!seg.locked,
          reviewZh: false,
          executionEn: !!seg.promptFinalOverride,
        };
        if (!seg.h3Prompt && isH3) {
          const en = parseH3PromptBody(seg.promptFinalOverride ?? seg.promptOverride ?? "", seg.summary);
          const h3: H3BilingualPrompt = {
            en,
            source: "legacy",
            // 迁移稿没有中文侧，英文即真相；中文待生成（§8.3：标记待生成，不阻塞使用）
            syncStatus: "en-newer",
            generatedAt: Date.now(),
          };
          return { ...seg, locks, h3Prompt: h3 };
        }
        return { ...seg, locks };
      }),
    })),
    schemaVersion: 5,
  };
}

/** v5 → v6（3.5 §6.4）：项目定调前言的统一视频规格识别——主剧本第一个分段标记之前的文本
 *  （定调前言常写「1080p · 24fps」全片规格），作为分段识别值之下的项目级候选 */
function v5ToV6(p: DirectorProject): DirectorProject {
  if (p.videoSpecFromPrefix) return { ...p, schemaVersion: 6 };
  // 主剧本优先（§8.1）：studioUi.scriptId > 最新 official > 第一份；都没有就退回 p.script
  const doc = p.scripts?.find((d) => d.id === p.studioUi?.scriptId) ?? p.scripts?.find((d) => d.status === "official") ?? p.scripts?.[0];
  const body = doc?.versions?.[doc.versions.length - 1]?.body ?? p.script ?? "";
  if (!body.trim()) return { ...p, schemaVersion: 6 };
  const marks = collectSegmentMarks(body.trim());
  const prefix = marks.length ? body.slice(0, marks[0]) : body.slice(0, 3000); // 无分段头就取开头（前言区）
  const spec = parseVideoSpecFromSegment(prefix);
  return {
    ...p,
    ...(Object.keys(spec.sources ?? {}).length ? { videoSpecFromPrefix: spec } : {}),
    schemaVersion: 6,
  };
}

/** 单项目迁移：v1 → v2 → v3 → v4 → v5 → v6（幂等）。 */
export function migrateDirectorProject(p: DirectorProject): DirectorProject {
  const v3 = (p.schemaVersion ?? 1) >= 3 ? p : v2ToV3(ensureV2(p));
  const v4 = (v3.schemaVersion ?? 1) >= 4 ? v3 : v3ToV4(v3);
  const v5 = (v4.schemaVersion ?? 1) >= 5 ? v4 : v4ToV5(v4);
  const v = (v5.schemaVersion ?? 1) >= 6 ? v5 : v5ToV6(v5);
  // 兜底必填数组（脏存档防白屏，任何版本都过一遍）
  return {
    ...v,
    script: v.script ?? "",
    characters: v.characters ?? [],
    scenes: v.scenes ?? [],
    recipes: v.recipes ?? [],
    globalSlots: v.globalSlots ?? [],
    timeline: v.timeline ?? [],
    scripts: v.scripts ?? [],
    mvProjects: v.mvProjects ?? [],
    imageStudio: v.imageStudio ?? {},
    studioUi: v.studioUi ?? { station: "h3", segId: null },
  };
}

/** 批量迁移（加载路径调用） */
export function migrateDirectorProjects(list: DirectorProject[]): DirectorProject[] {
  return list.map(migrateDirectorProject);
}
