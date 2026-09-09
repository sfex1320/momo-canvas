/**
 * 批量生成一键预检（方案 §9.4 / §15.1）
 *
 * 开始批量生成前自动检查：ComfyUI 在线、模板存在、参考素材是否超容量、时长/画幅合法、
 * 提示词引用编号正确、是否存在远程计费配方。预检失败只阻止受影响片段，其余允许继续。
 */
import { useComfy } from "./stores/comfyStore";
import { useSettings, resolveModelCard } from "./stores/settingsStore";
import { xfetch } from "./services/http";
import { directorReferenceSupport } from "./directorRecipeSupport";
import { profileForRecipe } from "./studio/capabilityProfile";
import { resolveVideoSpec } from "./studio/videoSpec";
import { specCapabilityFor } from "./studio/specCapability";
import { compilePrompt, segmentShotContexts, validateRefTags } from "./directorPrompt";
import { collectBatchTasks, type BatchOp } from "./directorQueue";
import { storySegments } from "./directorContinuity";
import { unrefinedSegments } from "./directorEngine";
import type { DirectorProject, DirectorSegment } from "./types";

export type PrecheckIssue = {
  level: "blocker" | "warn" | "info";
  scope: "project" | "segment";
  segmentId?: string;
  message: string;
};

export type PrecheckResult = {
  issues: PrecheckIssue[];
  /** 被阻止生成的片段（blocker 命中） */
  blockedSegIds: Set<string>;
  /** 任务计划摘要（§15.1 统一任务计划的预检版） */
  summary: string;
  /** 引擎分布（§9.4：ComfyUI 离线只拦本地片段，远程片段可照常执行） */
  comfyCount: number;
  remoteCount: number;
};

/** 片段生效配方（与 directorQueue.resolveRecipe 同规则：片段 > 项目默认 > 远程） */
function segRecipe(project: DirectorProject, segment: DirectorSegment) {
  const rid = segment.recipeId ?? project.defaultRecipeId;
  return rid ? project.recipes.find((r) => r.id === rid) : undefined;
}

/** ComfyUI 是否在线（/system_stats，4s 超时；浏览器预览模式直接探测会 CORS，吞掉按离线处理） */
async function comfyOnline(host: string): Promise<boolean> {
  if (!host) return false;
  try {
    const r = await Promise.race([
      xfetch(`${host.replace(/[/]+$/, "")}/system_stats`, { method: "GET" }),
      new Promise<Response>((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
    ]);
    return r.ok;
  } catch {
    return false;
  }
}

/** 素材槽图片/视频/音频计数（不读文件，按槽数估计） */
function slotCounts(segment: DirectorSegment): { pictures: number; videos: number; audios: number } {
  let pictures = 0;
  let videos = 0;
  let audios = 0;
  for (const s of segment.slots ?? []) {
    if (s.relayKind) continue; // 接力素材运行时注入，不占静态计数
    if (s.semantic === "referenceVideo") videos += s.assetIds.length;
    else if (s.semantic === "referenceAudio") audios += s.assetIds.length;
    else pictures += s.assetIds.length;
  }
  return { pictures, videos, audios };
}

/**
 * 批量生成预检。op/selectedIds 与 runBatch 同参——预检通过的部分直接交给 runBatch 执行。
 */
export async function precheckBatch(
  project: DirectorProject,
  op: BatchOp,
  selectedIds?: string[],
): Promise<PrecheckResult> {
  const issues: PrecheckIssue[] = [];
  const blocked = new Set<string>();
  const tasks = collectBatchTasks(project, op, selectedIds);
  const templates = useComfy.getState().templates;
  const segs = storySegments(project);

  // 计划摘要（§15.1）
  const comfyCount = tasks.filter((t) => segRecipe(project, t.segment)?.engine === "comfy").length;
  const remoteCount = tasks.length - comfyCount;
  const relayCount = project.tailFrameRelay
    ? tasks.filter((t) => {
        const idx = segs.findIndex((s) => s.id === t.segment.id);
        return idx > 0 && (segs[idx - 1].takes ?? []).some((tk) => tk.status === "done" && tk.assetId);
      }).length
    : 0;
  const summary = tasks.length
    ? `范围：${tasks.length} 个片段 · 引擎：本地 ComfyUI ${comfyCount} 个${remoteCount ? `，远程 API ${remoteCount} 个` : ""}` +
      `${relayCount ? ` · 连续性：${relayCount} 个片段使用上段接力` : ""}` +
      `${project.freeMemBetween ? " · 后处理：每段生成后清理显存" : ""}`
    : "没有需要生成的片段";

  if (!tasks.length) return { issues, blockedSegIds: blocked, summary, comfyCount, remoteCount };

  // ① 引擎在线性：本地任务存在时检查 ComfyUI。离线只拦「本地片段」（合同：只阻止受影响片段），
  //    远程片段照常执行——被拦片段记入 blockedSegIds 由调用方过滤
  if (comfyCount > 0) {
    const host = useSettings.getState().settings.comfy.host;
    if (!host) {
      issues.push({ level: "blocker", scope: "project", message: "未配置 ComfyUI 地址——本地片段无法执行（设置 → ComfyUI）" });
      for (const t of tasks) if (segRecipe(project, t.segment)?.engine === "comfy") blocked.add(t.segment.id);
    } else if (!(await comfyOnline(host))) {
      issues.push({ level: "blocker", scope: "project", message: `ComfyUI 离线（${host}）——本地片段无法执行，远程片段不受影响` });
      for (const t of tasks) if (segRecipe(project, t.segment)?.engine === "comfy") blocked.add(t.segment.id);
    }
  }
  if (remoteCount > 0) {
    issues.push({ level: "warn", scope: "project", message: `有 ${remoteCount} 个片段走远程计费接口——按服务商计费，任务提交后不可撤销` });
  }

  // 3.5：批量前置检查——没有英文执行稿的段会走「摘要自动编译」（质量弱于 Skill 精炼）。
  // 不静默自动精炼（LLM 调用有费用，遵循防自动扣费铁律），只在预演时提示 + 引导批量菜单。
  const unrefined = unrefinedSegments(project).filter((seg) => tasks.some((t) => t.segment.id === seg.id));
  if (unrefined.length) {
    issues.push({
      level: "warn",
      scope: "project",
      message: `${unrefined.length} 个片段没有英文执行稿（将按摘要自动编译）——建议先在批量菜单执行「Skill 精炼提示词」再生成`,
    });
  }

  for (const t of tasks) {
    const seg = t.segment;
    const recipe = segRecipe(project, seg);
    const tpl = recipe?.engine === "comfy" && recipe.templateId ? templates.find((x) => x.id === recipe.templateId) : undefined;

    // ② 模板存在
    if (recipe?.engine === "comfy" && recipe.templateId && !tpl) {
      issues.push({ level: "blocker", scope: "segment", segmentId: seg.id, message: `配方「${recipe.name}」的模板已不存在——请重新导入或换配方` });
      blocked.add(seg.id);
      continue;
    }

    // ③ 时长合法：通用 2~60s + 配方能力档案（min/max/step——远程超限会被服务端直接拒绝）
    if (!(seg.durationSec >= 2 && seg.durationSec <= 60)) {
      issues.push({ level: "blocker", scope: "segment", segmentId: seg.id, message: `时长 ${seg.durationSec}s 不在 2~60s 范围内` });
      blocked.add(seg.id);
    } else {
      const prof = profileForRecipe(recipe, tpl?.name);
      if (seg.durationSec < prof.duration.min || seg.durationSec > prof.duration.max) {
        issues.push({ level: "blocker", scope: "segment", segmentId: seg.id, message: `时长 ${seg.durationSec}s 超出配方能力（${prof.duration.min}~${prof.duration.max}s）——提交后会被拒绝` });
        blocked.add(seg.id);
      } else if (prof.duration.step && (seg.durationSec - prof.duration.min) % prof.duration.step > 0.01) {
        issues.push({ level: "warn", scope: "segment", segmentId: seg.id, message: `时长 ${seg.durationSec}s 不在配方步进上（步进 ${prof.duration.step}s），服务端可能就近取整` });
      }
    }

    // ④ 画幅：配方声明画幅集合时不匹配的拦下
    const aspects = recipe?.capabilitySnapshot?.aspects;
    if (aspects?.length && !aspects.includes(project.aspect)) {
      issues.push({ level: "warn", scope: "segment", segmentId: seg.id, message: `项目画幅 ${project.aspect} 不在配方支持列表（${aspects.join("/")}）内，可能被服务端拒绝` });
    }

    // ⑤ 参考素材容量 + 提示词编号
    const sup = directorReferenceSupport(recipe, tpl);
    const counts = slotCounts(seg);
    // 全局参考槽（全局资产册/全局绑定）同样占用参考容量，此前只统计片段槽会低估
    for (const g of project.globalSlots ?? []) {
      if (g.relayKind) continue;
      if (g.semantic === "referenceVideo") counts.videos += g.assetIds.length;
      else if (g.semantic === "referenceAudio") counts.audios += g.assetIds.length;
      else counts.pictures += g.assetIds.length;
    }
    if (!sup.video && counts.videos > 0) {
      issues.push({ level: "warn", scope: "segment", segmentId: seg.id, message: `${counts.videos} 条视频参考不会被投喂（当前配方没有视频参考入口）` });
    }
    if (!sup.audio && counts.audios > 0) {
      issues.push({ level: "warn", scope: "segment", segmentId: seg.id, message: `${counts.audios} 条音频参考不会被投喂（当前配方没有音频参考入口）` });
    }
    if (!sup.firstFrame && (seg.slots ?? []).some((s) => s.semantic === "firstFrame" && s.assetIds.length)) {
      issues.push({ level: "warn", scope: "segment", segmentId: seg.id, message: "配置了开场画面但当前配方没有首帧入口，会转为普通参考图" });
    }
    // 统一视频规格（3.5 §6.8）：解析并报告来源与调整——引擎不直接支持的项说明实际处理方式。
    // 能力 = 配方快照 + 真实适配器协议（远程配方解析 ModelCard；无 FPS 直出参数的引擎报「未发送 fps」）
    const remoteFallback = !recipe; // 无配方 = 默认远程模型
    let capForSeg: Parameters<typeof resolveVideoSpec>[2];
    if (recipe?.engine === "provider" || remoteFallback) {
      try {
        capForSeg = specCapabilityFor(recipe, recipe?.providerModelKey ? resolveModelCard("video", recipe.providerModelKey) : resolveModelCard("video"));
      } catch {
        capForSeg = specCapabilityFor(recipe);
      }
    } else {
      capForSeg = specCapabilityFor(recipe);
    }
    const spec = resolveVideoSpec(project, seg, capForSeg);
    for (const a of spec.adjustments) {
      issues.push({
        level: "warn",
        scope: "segment",
        segmentId: seg.id,
        message: `${a.field === "durationSec" ? "时长" : a.field === "fps" ? "帧率" : "分辨率"} ${String(a.requested)} → ${a.applied === null || a.applied === undefined ? "未应用" : String(a.applied)}（${a.reason}）`,
      });
    }

    // 参考容量：能力档案声明上限时，超量素材运行时会被按序静默裁掉——预检提前说明
    const cap = recipe?.capabilitySnapshot;
    if (cap) {
      if (cap.referenceImages > 0 && counts.pictures > cap.referenceImages) {
        issues.push({ level: "warn", scope: "segment", segmentId: seg.id, message: `参考图 ${counts.pictures} 张超过配方容量 ${cap.referenceImages}——超出的会被按序裁掉` });
      }
      if (cap.referenceVideos > 0 && counts.videos > cap.referenceVideos) {
        issues.push({ level: "warn", scope: "segment", segmentId: seg.id, message: `参考视频 ${counts.videos} 条超过配方容量 ${cap.referenceVideos}——超出的会被按序裁掉` });
      }
    }
    if (!seg.promptFinalOverride?.trim()) {
      // 提示词编号校验（§8.2）：静态编译文本 + 槽位计数
      const ctxs = segmentShotContexts(project, seg);
      const base = seg.promptOverride ?? (ctxs.length ? compilePrompt(ctxs, "video-t2v") : seg.summary);
      const problems = validateRefTags(base, counts);
      for (const p of problems) {
        issues.push({ level: "warn", scope: "segment", segmentId: seg.id, message: `提示词${p}` });
      }
    }
  }

  return { issues, blockedSegIds: blocked, summary, comfyCount, remoteCount };
}
