/**
 * 导演台生成队列 — 批量生成调度 + 跨重启恢复
 *
 * 方案 §7.8：任务粒度 = 一个 Segment + 一个生成目标 + 一个 Take。
 * 状态机：草稿→排队中→执行→成功待选 / 失败可重试 / 已取消。
 *
 * 队列规则（方案 §7.8）：
 *  - 本地 ComfyUI 默认并发 1（避免显存竞争）
 *  - 远程 API 按服务商并发
 *  - 支持「生成所选/缺失/重试失败」
 *  - 跨重启恢复：运行中的 Take 标「中断」，不静默重置
 *
 * 本轮实现：
 *  ① 单 Take 执行（图片/视频配方）
 *  ② 批量操作（生成缺失/重试失败/生成所选）
 *  ③ 中断恢复（启动时把 running 标 interrupted）
 */
import { useDirector } from "./stores/directorStore";
import { jobCenter } from "./studio/jobCenter";
import { resolveVideoSpec } from "./studio/videoSpec";
import { specCapabilityFor, mergeAdapterReport, mergeComfySpecReport } from "./studio/specCapability";
import type { AdapterSpecReport } from "./services/videoGen";
import { mirrorProjectAsset } from "./studio/projectAssetRouter";
import { useAssets } from "./stores/assetStore";
import { useSettings } from "./stores/settingsStore";
import { useComfy } from "./stores/comfyStore";
import { resolveModelCard } from "./stores/settingsStore";
import { budgetGate } from "./capability/budget";
import { estimateCost } from "./pricing";
import { useUsage } from "./stores/usageStore";
import { toast } from "./stores/uiStore";
import { generateImage } from "./services/imageGen";
import { generateVideo } from "./services/videoGen";
import { runComfyTemplate, analyzeCapsV3, isImageLoaderClass, isVideoLoaderClass, freeComfyMemory, freeResultText, interruptComfy, defaultParamValues } from "./services/comfy";
import { compilePrompt, compileNegative, segmentShotContexts } from "./directorPrompt";
import { authoredText, shouldRelay } from "./studio/authoring";
import { directorError, createTake, isH3ReadyPrompt, isOfficialH3Prompt, mpToSize } from "./directorEngine";
import {isOfficialH3BasePrompt} from "./studio/h3AuthoringCore";
import { constrainPictureCapacity, refsNoteFromSnapshot, resolveSlotMedia, rewriteOmittedSpatialPictureRefs, type ResolvedMedia } from "./directorRefs";
import { recordCapsule } from "./directorContinuity";
import { directorReferenceSupport, type DirectorReferenceSupport } from "./directorRecipeSupport";
import { routeCtxOfRecipe, routeSkillBindings } from "./studio/skillRoute";
import { useSkills } from "./stores/skillStore";
import { assetToDataUrl, assetToBlobUrl, assetUrl } from "./services/assetFiles";
import { grabFrame, trimVideo } from "./videoEdit";
import type { SkillRunSnapshot } from "./skillTypes";
import type { DirectorProject, DirectorSegment, DirectorTake, DirectorPostRecipe, DirectorRecipe, DirectorSlotValue, ComfyTemplate } from "./types";

type RelayBundle = { frame: string; clip?: string; sourceTakeId: string };

/** 从相邻上一段成功 Take 生成空间接力包：稳定桥接帧 + 可选末尾 2 秒动作参考视频。 */
async function takeRelayBundle(take: DirectorTake, includeClip: boolean): Promise<RelayBundle | null> {
  if (!take.assetId) return null;
  const asset = useAssets.getState().items.find((a) => a.id === take.assetId);
  if (!asset) return null;
  try {
    if (asset.kind === "video") {
      // 视频源优先转 blob URL：WebView2 的 asset:// 协议不支持 Range 请求，直接 seek 抽帧会定位超时
      const src = await assetToBlobUrl(asset.path, asset.mime).catch(() => assetUrl(asset.path));
      const tail = await grabFrame(src, "last");
      // 真正最后一帧容易遇到编码结束黑帧/半帧；优先取结尾前 0.25 秒作为稳定桥接帧。
      const stable = tail.duration > 0.35
        ? await grabFrame(src, "custom", Math.max(0, tail.duration - 0.25)).catch(() => tail)
        : tail;
      let clip: string | undefined;
      // H3 参考视频兼容下限按 2 秒处理；源视频不足 2 秒时只保留桥接帧。
      if (includeClip && tail.duration >= 2.05) {
        clip = await trimVideo(src, Math.max(0, tail.duration - 2), tail.duration).catch(() => undefined);
      }
      return { frame: stable.dataUrl, clip, sourceTakeId: take.id };
    }
    return { frame: await assetToDataUrl(asset.path, asset.mime), sourceTakeId: take.id };
  } catch {
    return null;
  }
}

/** 尾帧接力槽的展示名/识别标记：持久化进下一段参考槽（分镜卡可见）与 Take 快照里都靠它辨认 */
const RELAY_LABEL = "上一段稳定桥接帧（自动接力）";
const RELAY_CLIP_LABEL = "上一段末尾 2 秒（自动接力）";
/** 兜底注入路径的虚拟槽占位资产 id（接力帧未能落槽位时仅进快照，让 refsNote 编号与实际投喂顺序一致） */
const RELAY_ASSET_ID = "__relay_tail_frame__";

/** 模板是否有标题标注「首帧」的图片入口（FL2VA 类，与 withOptionalFrameDrop 同源判定）：
 *  有则接力帧走首帧语义（buildSlotMap 精确映射 + 不被缺首帧降级剔除）；
 *  无（REF2VA 的「Picture N」参考图标题不含首帧字样）则接力帧作最后一张参考图按序投喂，
 *  refsNote 的「图N」编号即模板实际的 Picture 位，不错位 */
function hasFirstFrameEntry(tpl: ComfyTemplate): boolean {
  return Object.values(tpl.workflow).some(
    (n) => isImageLoaderClass(n.class_type) && /首帧|first/i.test(n._meta?.title ?? ""),
  );
}

/** 当前片段配方能接收几条参考视频；非 R2V/无视频入口时返回 0。 */
function referenceVideoCapacity(project: DirectorProject, segment: DirectorSegment): number {
  const recipe = resolveRecipe(project, segment);
  // 当前远程 generateVideo 协议尚未透传参考视频；只对实际有媒体入口的 ComfyUI 配方启用桥接片段。
  if (recipe?.engine !== "comfy") return 0;
  const snap = recipe?.capabilitySnapshot?.referenceVideos;
  if (typeof snap === "number") return Math.max(0, snap);
  if (recipe.templateId) {
    const tpl = useComfy.getState().templates.find((t) => t.id === recipe.templateId);
    if (tpl) return Object.values(tpl.workflow).filter((n) => isVideoLoaderClass(n.class_type)).length;
  }
  return 0;
}

/** 当前配方真实可接收的图片数；未声明容量的远程配方不在 MOMO 侧截断。 */
function referenceImageCapacity(recipe: DirectorRecipe | undefined, tpl?: ComfyTemplate): number | undefined {
  if (tpl) {
    const n = Object.values(tpl.workflow).filter((node) => isImageLoaderClass(node.class_type)).length;
    return n || undefined;
  }
  const n = recipe?.capabilitySnapshot?.referenceImages;
  return typeof n === "number" && n > 0 ? n : undefined;
}

/**
 * 按当前配方能力裁掉不支持的参考类别。灰色槽里的素材仍保存在项目中，切回兼容配方即可恢复，
 * 但不会进入提示词编号、Take 快照或 ComfyUI 上传队列。
 */
function filterMediaBySupport(media: ResolvedMedia | null, support: DirectorReferenceSupport): ResolvedMedia | null {
  if (!media) return null;
  const slotAllowed = (slot: DirectorSlotValue) => {
    if (slot.semantic === "firstFrame") return support.firstFrame;
    if (slot.semantic === "lastFrame") return support.lastFrame;
    if (slot.semantic === "referenceVideo") return support.video;
    if (slot.semantic === "referenceAudio") return support.audio;
    return support.referenceImage;
  };
  const entries = media.images.entries.filter((e) => slotAllowed(e.slot));
  const snapshot = media.snapshot.filter(slotAllowed);
  const images = {
    orderedAll: entries.map((e) => e.url),
    refs: entries.filter((e) => e.slot.semantic !== "firstFrame" && e.slot.semantic !== "lastFrame").map((e) => e.url),
    firstFrame: support.firstFrame ? entries.find((e) => e.slot.semantic === "firstFrame")?.url : undefined,
    lastFrame: support.lastFrame ? entries.find((e) => e.slot.semantic === "lastFrame")?.url : undefined,
    entries,
    snapshot,
  };
  const videos = support.video ? media.videos : [];
  const audios = support.audio ? media.audios : [];
  if (!images.orderedAll.length && !videos.length && !audios.length) return null;
  return { images, videos, audios, snapshot };
}

/** 优先采用已选版本，否则取最近一次成功视频版本。 */
function relaySourceTake(segment: DirectorSegment): DirectorTake | undefined {
  const done = (segment.takes ?? []).filter((t) => t.status === "done" && t.kind === "video" && t.assetId);
  return done.find((t) => t.id === segment.approvedTakeId) ?? done.sort((a, b) => b.createdAt - a.createdAt)[0];
}

/** 已有同源接力时直接读取桥接帧，避免再次截取和重复保存 2 秒片段。 */
async function existingRelayFrame(segment: DirectorSegment, sourceTakeId: string, needClip: boolean): Promise<string | null> {
  const slots = segment.slots ?? [];
  const frameSlot = slots.find((s) => s.relayKind === "frame" && s.relaySourceTakeId === sourceTakeId);
  const hasClip = slots.some((s) => s.relayKind === "clip" && s.relaySourceTakeId === sourceTakeId);
  if (!frameSlot || (needClip && !hasClip)) return null;
  const asset = useAssets.getState().items.find((a) => a.id === frameSlot.assetIds[0]);
  if (!asset) return null;
  return assetToDataUrl(asset.path, asset.mime).catch(() => null);
}

/**
 * 把接力帧填进下一段参考槽末位（尾帧接力的持久化部分，runBatch 抽帧后调用）：
 * 收录为参考资产 → 追加到该段 slots 尾部（referenceImage 语义 + RELAY_LABEL 标记，auto:false 防同步对账清掉）。
 * 分镜卡参考图区最后一格即时可见，用户可删可拖；同段重跑先摘除旧接力槽再追加，不叠加。
 * 成功后同时记录连续性上下文胶囊（方案 §10：来源片段/Take + 状态摘要，UI 显示「继承自 06 · Take 2」）。
 */
async function fillRelaySlots(
  projectId: string,
  segmentId: string,
  sourceSegmentId: string,
  bundle: RelayBundle,
): Promise<void> {
  const frameAsset = await useAssets.getState().collect({
    src: bundle.frame,
    kind: "image",
    name: "空间接力帧",
    director: { projectId, segmentId, role: "reference" },
  });
  if (frameAsset) void mirrorProjectAsset({ projectId, segmentId, category: "relay", assetId: frameAsset.id });
  let clipAssetId: string | undefined;
  if (bundle.clip) {
    try {
      const clipAsset = await useAssets.getState().collect({
        src: bundle.clip,
        kind: "video",
        name: "空间接力片段_末尾2秒",
        director: { projectId, segmentId, role: "reference" },
      });
      if (clipAsset) void mirrorProjectAsset({ projectId, segmentId, category: "relay", assetId: clipAsset.id });
      clipAssetId = clipAsset?.id;
    } finally {
      if (bundle.clip.startsWith("blob:")) URL.revokeObjectURL(bundle.clip);
    }
  }
  if (!frameAsset) return;
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  useDirector.getState().updateProject(projectId, {
    scenes: proj.scenes.map((s) => ({
      ...s,
      segments: s.segments.map((g) => {
        if (g.id !== segmentId) return g;
        const slots = (g.slots ?? []).filter((x) => !x.relayKind && x.label !== RELAY_LABEL && x.label !== RELAY_CLIP_LABEL);
        const relaySlots: DirectorSlotValue[] = [
          {
            semantic: "referenceImage",
            assetIds: [frameAsset.id],
            auto: false,
            label: RELAY_LABEL,
            relayKind: "frame",
            relaySourceTakeId: bundle.sourceTakeId,
          },
        ];
        if (clipAssetId) relaySlots.push({
          semantic: "referenceVideo",
          assetIds: [clipAssetId],
          auto: false,
          label: RELAY_CLIP_LABEL,
          relayKind: "clip",
          relaySourceTakeId: bundle.sourceTakeId,
        });
        return { ...g, slots: [...slots, ...relaySlots] };
      }),
    })),
  });
  // 胶囊记录（方案 §10）：来源 + 状态摘要，上游换版本时可标记过期
  recordCapsule(projectId, segmentId, sourceSegmentId, bundle.sourceTakeId);
}

/** 摘除片段里的自动接力槽；资产本体保留在资产库，避免误删历史参考。 */
function clearRelaySlots(projectId: string, segmentId: string, kind?: "frame" | "clip"): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  const scenes = proj.scenes.map((scene) => ({
    ...scene,
    segments: scene.segments.map((segment) => {
      if (segment.id !== segmentId) return segment;
      const slots = (segment.slots ?? []).filter((slot) => {
        const legacyRelay = /自动接力/.test(slot.label ?? "");
        if (!slot.relayKind && !legacyRelay) return true;
        return kind ? slot.relayKind !== kind : false;
      });
      return { ...segment, slots };
    }),
  }));
  useDirector.getState().updateProject(projectId, { scenes });
}

type SegmentContinuityMode = "opening" | "continuity_relay" | "hard_cut";

/**
 * 从双语执行提示中读取接力策略。旧项目没有显式标记时保持原有“同场接力”行为，
 * 但新版项目可用 opening / hard_cut 阻止跨场景桥接素材误入本段。
 */
function segmentContinuityMode(segment: DirectorSegment): SegmentContinuityMode {
  const text = [
    segment.promptFinalOverride,
    segment.promptOverride,
    segment.scriptText,
    segment.summary,
    segment.continuityIn,
  ].filter(Boolean).join("\n");
  if (/Continuity mode:\s*hard[_ -]?cut/i.test(text) || /衔接模式[：:]\s*硬切/.test(text)) return "hard_cut";
  if (/Continuity mode:\s*opening/i.test(text) || /衔接模式[：:]\s*开篇/.test(text)) return "opening";
  if (/Continuity mode:\s*continuity[_ -]?relay/i.test(text) || /衔接模式[：:]\s*同场接力/.test(text)) return "continuity_relay";
  return "continuity_relay";
}

/**
 * 尾帧接力注入：把上一段尾帧并入本段参考素材（项目开关开启时 runBatch 才会传入 relay）。
 * 接力帧正常已被 fillRelaySlot 持久化进本段参考槽末位，这里只做执行层语义适配：
 *  - 已在槽位里（orderedAll 含接力帧）：保持「最后一张参考图」原位投喂；仅当目标吃首帧语义
 *    （namedFirstFrame：远程视频 image 具名参数 / 模板有「首帧」入口）且本段无显式首帧时，
 *    把它从参考图里摘下提升为首帧（buildSlotMap 精确映射，具名槽吃掉的帧会被 runComfyTemplate
 *    从顺序队列扣除，不重复投喂），快照槽语义同步改成 firstFrame
 *  - 不在槽位里（持久化失败的兜底）：并入参考素材末尾——远程图 refImages 末位 / REF2VA 类模板的
 *    最后一个 Picture N；兜底走首帧语义时置队首由具名槽扣除
 *  - refsNote 的「首帧/图N」编号与模型实际收到的顺序严格一致
 *  - 视频目标本段已有显式首帧时用户已指定开头画面，接力帧不抢（显式优先，留在参考图末位）
 */
function withRelayFrame(
  media: ResolvedMedia | null,
  relay: string | undefined,
  opts: { target: "image" | "video"; namedFirstFrame: boolean },
): ResolvedMedia | null {
  if (!relay) return media;
  if (opts.target === "video" && media?.images.firstFrame) return media;
  const asFirst = !media?.images.firstFrame && opts.namedFirstFrame;
  // 已持久化进片段槽：原位保留；吃首帧语义时提升为首帧
  if (media && media.images.orderedAll.includes(relay)) {
    if (!asFirst) return media;
    const promote = (slots: DirectorSlotValue[]) =>
      slots.map((s) => (s.relayKind === "frame" && s.assetIds.length === 1 ? { ...s, semantic: "firstFrame" as const } : s));
    return {
      images: {
        orderedAll: media.images.orderedAll,
        refs: media.images.refs.filter((u) => u !== relay),
        firstFrame: relay,
        lastFrame: media.images.lastFrame,
        entries: media.images.entries.map((e) =>
          e.slot.relayKind === "frame" ? { ...e, slot: { ...e.slot, semantic: "firstFrame" as const } } : e,
        ),
        snapshot: promote(media.images.snapshot),
      },
      videos: media.videos,
      audios: media.audios,
      snapshot: promote(media.snapshot),
    };
  }
  // 兜底：接力帧没进槽位，直接并入参考素材（参考图情况放末位）
  const slot: DirectorSlotValue = {
    semantic: asFirst ? "firstFrame" : "referenceImage",
    assetIds: [RELAY_ASSET_ID],
    auto: true,
    label: RELAY_LABEL,
    relayKind: "frame",
  };
  const images = asFirst
    ? {
        orderedAll: [relay, ...(media?.images.orderedAll ?? [])],
        refs: media?.images.refs ?? [],
        firstFrame: relay,
        lastFrame: media?.images.lastFrame,
        entries: [{ url: relay, assetId: RELAY_ASSET_ID, slot }, ...(media?.images.entries ?? [])],
        snapshot: [slot, ...(media?.images.snapshot ?? [])],
      }
    : {
        orderedAll: [...(media?.images.orderedAll ?? []), relay],
        refs: [...(media?.images.refs ?? []), relay],
        firstFrame: media?.images.firstFrame,
        lastFrame: media?.images.lastFrame,
        entries: [...(media?.images.entries ?? []), { url: relay, assetId: RELAY_ASSET_ID, slot }],
        snapshot: [...(media?.images.snapshot ?? []), slot],
      };
  return {
    images,
    videos: media?.videos ?? [],
    audios: media?.audios ?? [],
    snapshot: asFirst ? [slot, ...(media?.snapshot ?? [])] : [...(media?.snapshot ?? []), slot],
  };
}

/**
 * 为 segment 编译生成提示词：
 *  1. 基础 = segment.promptOverride ?? compilePrompt（模型无关镜头结构）
 *  2. 追加项目级 Skill 栈的指令（方案 §17.8：项目 Skill 作用于所有片段）
 *  3. 追加负向规则（compileNegative）
 * 返回编译后的真实请求文本 + 实际执行的 Skill 快照（方案 §17.4：写进 Take 可追溯）。
 */
export function compileSegmentPrompt(
  project: DirectorProject,
  segment: DirectorSegment,
  target: "image-t2i" | "video-t2v",
): { prompt: string; snapshots: SkillRunSnapshot[] } {
  // 最终提示词覆盖：用户在「预览最终提示词」弹窗里改定的整段最终文本，原样发送
  // （风格/Skill/负向都已在文本里，不再自动拼接；参考素材编号说明由执行层按当前素材槽前置）
  if (segment.promptFinalOverride?.trim()) return { prompt: segment.promptFinalOverride, snapshots: [] };
  // 官方六段执行稿已经包含完整风格、保留策略与声音设计，必须原样发送；
  // 项目风格、Skill 原文或通用负向词再次包裹都会制造第二套语法。
  if (segment.promptOverride?.trim() && (isOfficialH3Prompt(segment.promptOverride)||isOfficialH3BasePrompt(segment.promptOverride))) {
    return { prompt: segment.promptOverride, snapshots: [] };
  }
  const ctxs = segmentShotContexts(project, segment);
  // 导演台 2.0（§13.1）：编译片段内全部 Shot（多镜头逐时段），角色按本段出场过滤（segmentShotContexts 内完成）
  let prompt = segment.promptOverride ?? (segment.characterIds !== undefined ? authoredText(project, segment) : ctxs.length ? compilePrompt(ctxs, target) : segment.summary);
  // 全局风格锚定：编译路径的 compilePrompt 已消费 ruleSet.positive.style；promptOverride（H3 成品/直录）路径这里补拼
  const gStyle = project.ruleSet?.positive.style?.trim();
  if ((segment.promptOverride || segment.characterIds !== undefined) && gStyle) prompt = `${gStyle}\n\n${prompt}`;
  const snapshots: SkillRunSnapshot[] = [];
  const recipe = resolveRecipe(project, segment);
  // 3.3 §7（阶段化硬规则）：**Skill instructions 原文一律不进最终提示词**——
  // 指令是给「写提示词的 LLM」（精炼阶段）看的规范，视频模型只需要阶段产物：
  //  - 已精炼/直录段：promptOverride 本身就是 model-adapter 阶段产物，直发；
  //  - 未精炼段：自动编译结果直发（用户想上模型方言 → 走「Skill 精炼提示词」）。
  // 这里只做「当前路线生效的 Skill 栈」快照记录（Take 可追溯），不再拼接文本。
  const h3Ready = !!segment.promptOverride && isH3ReadyPrompt(segment.promptOverride);
  if (!h3Ready) {
    const stack = routeSkillBindings(project, routeCtxOfRecipe(project, recipe), undefined, { excludePlanning: true });
    if (stack.length) {
      snapshots.push(
        ...stack.map(({ binding, skillName }) => {
          const sk = useSkills.getState().getById(binding.skillId);
          return {
            skillId: binding.skillId,
            name: skillName,
            version: sk?.version ?? "",
            instructionFingerprint: sk?.instructionFingerprint ?? "",
            values: binding.values,
          } satisfies SkillRunSnapshot;
        }),
      );
    }
  }
  // 负向规则
  if (ctxs.length) {
    const neg = compileNegative(ctxs[0]);
    if (neg) prompt = `${prompt}\n\n负向：${neg}`;
  }
  return { prompt, snapshots };
}

/**
 * 把 MOMO 的真实槽位/容量降级说明放进官方 detailed_description 内，保持六段结构不被前缀破坏。
 * 非官方提示词仍沿用历史的前置说明形式。
 */
function composeRuntimePrompt(prompt: string, runtimeNotes: string[]): string {
  const notes = runtimeNotes.filter(Boolean).join("\n");
  if (!notes) return prompt;
  if(isOfficialH3BasePrompt(prompt))return prompt.replace(/^(integrated_multimodal_description\s*:)/m,`$1\nRuntime reference binding supplied by MOMO for this request only:\n${notes}\n`);
  if (!isOfficialH3Prompt(prompt)) return [notes, prompt].join("\n\n");
  return prompt.replace(
    /^(detailed_description\s*:)\s*$/im,
    `$1\nRuntime reference binding supplied by MOMO for this request only:\n${notes}`,
  );
}

/**
 * 预览某片段的最终生成提示词：与批量生成实际发送的文本完全同构
 * （参考素材编号说明 + 风格锚定 + Skill 栈指令 + 负向规则），供分镜卡在生成前核对。
 */
export async function previewSegmentPrompt(project: DirectorProject, segment: DirectorSegment): Promise<string> {
  const { prompt } = compileSegmentPrompt(project, segment, "video-t2v");
  const recipe = resolveRecipe(project, segment);
  const tpl = recipe?.engine === "comfy" && recipe.templateId
    ? useComfy.getState().templates.find((t) => t.id === recipe.templateId)
    : undefined;
  const supported = filterMediaBySupport(
    await resolveSlotMedia(project, segment),
    directorReferenceSupport(recipe, tpl),
  );
  const capped = constrainPictureCapacity(supported, referenceImageCapacity(recipe, tpl));
  const media = capped.media;
  const note = media ? refsNoteFromSnapshot(media.snapshot, "video") : "";
  const runtimePrompt = rewriteOmittedSpatialPictureRefs(prompt, capped.omittedPictureNumbers);
  return composeRuntimePrompt(runtimePrompt, [note, capped.spatialTextNote]);
}

/** 片段当前生效配方：片段 recipeId > 项目默认（无配方的老项目返回 undefined，走远程默认模型） */
export function resolveRecipe(project: DirectorProject, segment: DirectorSegment): DirectorRecipe | undefined {
  const rid = segment.recipeId ?? project.defaultRecipeId;
  if (rid) return project.recipes.find((r) => r.id === rid);
  return undefined;
}

/** 片段预估时长（秒）：手改规格 > 分段默认（估算用，真实执行以 resolveVideoSpec 为准） */
export function estDurationSec(segment: DirectorSegment): number {
  return segment.videoSpec?.user?.durationSec ?? segment.durationSec ?? 5;
}

/**
 * 批量生成的花费预估（runBatch 预检与能力层 director.run_batch 的 estimate 共用）：
 * 本地 ComfyUI 配方不计费；远程配方按模型单价 × 时长/张数累加。
 * 拿不到可用模型（未配置）时按 0 估——真正的报错留给执行时的 resolveModelCard。
 */
export function estimateBatchTasks(
  project: DirectorProject,
  tasks: Array<{ segment: DirectorSegment; kind: "image" | "video" }>,
): { cost: number; remote: number } {
  let cost = 0;
  let remote = 0;
  for (const t of tasks) {
    const recipe = resolveRecipe(project, t.segment);
    if (recipe?.engine === "comfy" && recipe.templateId) continue;
    try {
      const card = recipe?.providerModelKey
        ? resolveModelCard(t.kind === "image" ? "image" : "video", recipe.providerModelKey)
        : resolveModelCard(t.kind === "image" ? "image" : "video");
      cost += estimateCost(card.model, t.kind === "image" ? { images: 1 } : { videoSec: estDurationSec(t.segment) });
      remote++;
    } catch {
      /* 未配模型：计 0，执行时自有中文报错 */
    }
  }
  return { cost, remote };
}

/**
 * 按语义把首帧/尾帧精确映射到模板图片入口（FL2VA 的 first_frame/last_frame）。
 * 无首尾帧素材时返回空表——全部图片走默认顺序分配（REF2VA 的 LoadImage 节点 id 序 = Picture 1..4 槽序，天然一一对应）。
 */
function buildSlotMap(tpl: ComfyTemplate, media: ResolvedMedia): Record<string, string> | undefined {
  if (!media.images.firstFrame && !media.images.lastFrame) return undefined;
  const caps = analyzeCapsV3(tpl.workflow);
  const map: Record<string, string> = {};
  for (const slot of caps.autoSlots ?? []) {
    if (slot.media !== "image") continue;
    const key = `${slot.nodeId}.${slot.input}`;
    if (slot.semantic === "firstFrame" && media.images.firstFrame) map[key] = media.images.firstFrame;
    else if (slot.semantic === "lastFrame" && media.images.lastFrame) map[key] = media.images.lastFrame;
  }
  return Object.keys(map).length ? map : undefined;
}

/**
 * 首尾帧工作流的按需降级（FL2VA）：本段没有首帧/尾帧素材时，把标题明确标注「首帧/尾帧」的
 * LoadImage 节点临时忽略——pruneDisabled 会删掉 H3 节点的 first_frame/last_frame 可选输入，
 * 退化为文生视频/仅首帧模式，避免 LoadImage 占位图（1.png）不存在导致执行报错。
 * 判定只看节点标题（REF2VA 的「Picture N」参考图标题不含首尾帧字样，不会被误剔）。
 */
function withOptionalFrameDrop(tpl: ComfyTemplate, media: ResolvedMedia): ComfyTemplate {
  const drop: string[] = [];
  for (const [nid, node] of Object.entries(tpl.workflow)) {
    if (!isImageLoaderClass(node.class_type)) continue;
    const title = node._meta?.title ?? "";
    if (/首帧|first/i.test(title) && !media.images.firstFrame) drop.push(nid);
    else if (/尾帧|末帧|last|end/i.test(title) && !media.images.lastFrame) drop.push(nid);
  }
  if (!drop.length) return tpl;
  return { ...tpl, disabledNodes: [...(tpl.disabledNodes ?? []), ...drop] };
}

/** 标记某 Take 状态 */
function patchTake(projectId: string, segmentId: string, takeId: string, patch: Partial<DirectorTake>): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  // 进入终态（完成/失败/取消）时记录结束时间：版本卡的「生成耗时」= finishedAt - createdAt
  const withEnd =
    patch.status && patch.status !== "queued" && patch.status !== "running" && patch.finishedAt === undefined
      ? { finishedAt: Date.now() }
      : {};
  const scenes = proj.scenes.map((s) => ({
    ...s,
    segments: s.segments.map((seg) =>
      seg.id === segmentId
        ? { ...seg, takes: (seg.takes ?? []).map((t) => (t.id === takeId ? { ...t, ...patch, ...withEnd } : t)) }
        : seg,
    ),
  }));
  useDirector.getState().updateProject(projectId, { scenes });
}

/**
 * 执行单个 Take 的图片生成。
 * recipe 为空或 engine=provider 时走远程 imageGen；engine=comfy 走 ComfyUI（后续接通）。
 */
export async function executeImageTake(
  projectId: string,
  segment: DirectorSegment,
  take: DirectorTake,
  project: DirectorProject,
  relayFirstFrame?: string,
  onSub?: (msg: string, pct?: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  patchTake(projectId, segment.id, take.id, { status: "running", error: undefined, startedAt: Date.now() });
  try {
    const recipe = resolveRecipe(project, segment);
    const { prompt, snapshots } = compileSegmentPrompt(project, segment, "image-t2i");
    // 参考素材槽位：全局槽（保序）+ 片段槽；图/视/音三类按语义分流（图片生成通常只用图）
    const mediaRaw = await resolveSlotMedia(project, segment);
    // ComfyUI 配方先取模板：接力注入需要知道模板有没有具名首帧入口
    const useComfyEngine = recipe?.engine === "comfy" && !!recipe.templateId;
    const comfyTpl = useComfyEngine
      ? useComfy.getState().templates.find((t) => t.id === recipe!.templateId)
      : undefined;
    if (useComfyEngine && !comfyTpl) throw new Error(`配方「${recipe!.name}」的模板不存在`);
    // 尾帧接力：上一段尾帧并入参考素材（已落参考槽末位，作最后一张参考图；ComfyUI 有「首帧」入口走首帧映射）
    const injectedMedia = withRelayFrame(mediaRaw, relayFirstFrame, {
      target: "image",
      namedFirstFrame: comfyTpl ? hasFirstFrameEntry(comfyTpl) : false,
    });
    const supportedMedia = filterMediaBySupport(injectedMedia, directorReferenceSupport(recipe, comfyTpl));
    const capped = constrainPictureCapacity(supportedMedia, referenceImageCapacity(recipe, comfyTpl));
    const media = capped.media;
    // 前置引用说明：图N / 视频N / 音频N 编号与模型实际收到的素材顺序严格一致
    const refNote = media ? refsNoteFromSnapshot(media.snapshot, "image") : "";
    const runtimePrompt = rewriteOmittedSpatialPictureRefs(prompt, capped.omittedPictureNumbers);
    const finalPrompt = composeRuntimePrompt(runtimePrompt, [refNote, capped.spatialTextNote]);
    let results: string[];
    let modelLabel: string;
    if (comfyTpl) {
      // ComfyUI 配方：走 runComfyTemplate
      // 首尾帧模板按需降级：缺首帧/尾帧素材时忽略对应 LoadImage，退化为 T2V/I2V（接力帧顶上的 firstFrame 不算缺）
      const tpl = media ? withOptionalFrameDrop(comfyTpl, media) : comfyTpl;
      const host = useSettings.getState().settings.comfy.host;
      if (!host) throw new Error("请先配置 ComfyUI 地址");
      const r = await runComfyTemplate(host, tpl, recipe!.defaultParams as Record<string, string | number | boolean>, {
        variantId: recipe!.variantId,
        onProgress: onSub,
        signal,
        upstreamImages: media?.images.orderedAll,
        upstreamVideos: media?.videos.length ? media.videos : undefined,
        upstreamAudios: media?.audios.length ? media.audios : undefined,
        upstreamTexts: [finalPrompt],
        imageSlotMap: media ? buildSlotMap(tpl, media) : undefined,
      });
      results = r.images;
      modelLabel = `ComfyUI · ${tpl.name}`;
    } else {
      // 远程配方或无配方：走 generateImage（接力帧已在 orderedAll 末位，与本段参考图一起投喂）
      onSub?.("已提交远程生成任务…");
      const card = recipe?.providerModelKey
        ? resolveModelCard("image", recipe.providerModelKey)
        : resolveModelCard("image");
      const t0 = Date.now();
      results = await generateImage(card, { prompt: finalPrompt, aspect: project.aspect, n: 1, refImages: media?.images.orderedAll });
      // 用量记账（与画布/助手同一本账）
      useUsage.getState().record(card, { ok: true, images: results.length, durMs: Date.now() - t0 });
      modelLabel = card.model;
    }
    if (!results.length) throw new Error("图片生成未返回结果");
    // 落资产库
    const asset = await useAssets.getState().collect({
      src: results[0],
      kind: "image",
      prompt,
      model: modelLabel,
      director: { projectId, segmentId: segment.id, takeId: take.id, role: "generated" },
    });
    if (!asset) throw new Error("资产收录失败");
    // 3.5 P2：图片 Take 同样镜像进项目目录（分段资产库/NN_标题/Takes/）
    void mirrorProjectAsset({ projectId, segmentId: segment.id, category: "take", assetId: asset.id, segTitle: segment.summary.slice(0, 20) });
    // 完整快照写入（方案 §7.9：保存编译后的真实请求提示词 + 配方 + Skill 栈快照）
    patchTake(projectId, segment.id, take.id, {
      status: "done",
      assetId: asset.id,
      promptSnapshot: finalPrompt,
      recipeSnapshot: recipe,
      paramSnapshot: recipe?.defaultParams,
      skillSnapshots: snapshots.length ? snapshots : undefined,
      slotSnapshot: media?.snapshot,
    });
  } catch (e) {
    // 「停止」按钮主动掐断：标取消、不进报错中心、不计失败
    if (signal?.aborted) {
      patchTake(projectId, segment.id, take.id, { status: "cancelled", error: "已手动停止" });
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    // 失败也记账（远程配方才可能计费；本地 ComfyUI 失败无 API 费）
    try {
      const r = resolveRecipe(project, segment);
      if (!(r?.engine === "comfy" && r.templateId)) {
        const card = r?.providerModelKey ? resolveModelCard("image", r.providerModelKey) : resolveModelCard("image");
        useUsage.getState().record(card, { ok: false });
      }
    } catch {
      /* 模型都解析不到时无从记账 */
    }
    patchTake(projectId, segment.id, take.id, { status: "error", error: msg });
    directorError(`片段 ${segment.summary.slice(0, 12)}`, msg);
  }
}

/**
 * 执行单个 Take 的视频生成。
 */
export async function executeVideoTake(
  projectId: string,
  segment: DirectorSegment,
  take: DirectorTake,
  project: DirectorProject,
  relayFirstFrame?: string,
  onSub?: (msg: string, pct?: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  patchTake(projectId, segment.id, take.id, { status: "running", error: undefined, startedAt: Date.now() });
  try {
    const recipe = resolveRecipe(project, segment);
    const { prompt, snapshots } = compileSegmentPrompt(project, segment, "video-t2v");
    // 参考素材槽位：首帧/尾帧单例语义 + 其余参考图（保序）+ 视频/音频参考（REF2VA 等多模态工作流）
    const mediaRaw = await resolveSlotMedia(project, segment);
    // ComfyUI 配方先取模板：接力注入需要知道模板有没有具名首帧入口
    const useComfyEngine = recipe?.engine === "comfy" && !!recipe.templateId;
    const comfyTpl = useComfyEngine
      ? useComfy.getState().templates.find((t) => t.id === recipe!.templateId)
      : undefined;
    if (useComfyEngine && !comfyTpl) throw new Error(`配方「${recipe!.name}」的模板不存在`);
    // 尾帧接力：接力帧已落本段参考槽末位（最后一张参考图，REF2VA 类无首帧入口的模板按序投喂最后一个 Picture N）；
    // 本段无显式首帧且目标吃首帧语义时提升为首帧（远程走 image 具名参数；ComfyUI 有「首帧」入口走精确映射）；
    // 本段有显式首帧则显式优先、接力帧留在参考图末位
    const injectedMedia = withRelayFrame(mediaRaw, relayFirstFrame, {
      target: "video",
      namedFirstFrame: comfyTpl ? hasFirstFrameEntry(comfyTpl) : true,
    });
    const supportedMedia = filterMediaBySupport(injectedMedia, directorReferenceSupport(recipe, comfyTpl));
    const capped = constrainPictureCapacity(supportedMedia, referenceImageCapacity(recipe, comfyTpl));
    const media = capped.media;
    // 前置引用说明：图N / 视频N / 音频N 编号与模型实际收到的素材顺序严格一致
    const refNote = media ? refsNoteFromSnapshot(media.snapshot, "video") : "";
    const runtimePrompt = rewriteOmittedSpatialPictureRefs(prompt, capped.omittedPictureNumbers);
    const finalPrompt = composeRuntimePrompt(runtimePrompt, [refNote, capped.spatialTextNote]);
    let videoUrl: string;
    let modelLabel: string;
    let remoteParams: Record<string, string | number | boolean> | undefined;
    let resolvedSpec: ReturnType<typeof resolveVideoSpec> | undefined;
    const t0 = Date.now();
    if (comfyTpl) {
      // ComfyUI 配方：走 runComfyTemplate（视频分支；提示词 + 图/视/音参考全部透传模板）
      // 首尾帧模板按需降级：缺首帧/尾帧素材时忽略对应 LoadImage，退化为 T2V/I2V（接力帧顶上的 firstFrame 不算缺）
      const tpl = media ? withOptionalFrameDrop(comfyTpl, media) : comfyTpl;
      const host = useSettings.getState().settings.comfy.host;
      if (!host) throw new Error("请先配置 ComfyUI 地址");
      // 3.5 统一视频规格：ComfyUI 通道同样只消费 resolveVideoSpec（与远程通道同一份解析结果）。
      // 分辨率优先用解析出的宽高；无宽高（只有档位标签）时沿用项目 MP 换算——两条路径都保留画幅。
      const comfySpec = resolveVideoSpec(project, segment, specCapabilityFor(recipe));
      const r = await runComfyTemplate(host, tpl, recipe!.defaultParams as Record<string, string | number | boolean>, {
        variantId: recipe!.variantId,
        onProgress: onSub,
        signal,
        upstreamImages: media?.images.orderedAll,
        upstreamVideos: media?.videos.length ? media.videos : undefined,
        upstreamAudios: media?.audios.length ? media.audios : undefined,
        upstreamTexts: [finalPrompt],
        imageSlotMap: media ? buildSlotMap(tpl, media) : undefined,
        // 分辨率：解析值（宽高）> 项目 MP 换算（兜底保画幅）
        resolution: (() => {
          const applied = comfySpec.applied.resolution;
          if (applied?.width && applied.height) return { aspect: project.aspect, width: applied.width, height: applied.height };
          const size = mpToSize(project.aspect, project.resolutionMP ?? 1);
          return { aspect: project.aspect, mp: project.resolutionMP ?? 1, width: size.width, height: size.height };
        })(),
        // 时长与帧率：解析结果（帧数换算在 runComfyTemplate 内用 fps × duration 完成）
        durationSec: comfySpec.applied.durationSec,
        fps: comfySpec.applied.fps,
      });
      videoUrl = r.videos[0] ?? "";
      modelLabel = `ComfyUI · ${tpl.name}`;
      // 3.5 §6.8：Take 的 appliedVideoSpec 只认工作流真实注入结果（模板没入口的项转 adjustment，不假装已应用）
      resolvedSpec = mergeComfySpecReport(comfySpec, r.videoSpecApplyReport);
    } else {
      // 远程配方或无配方：走 generateVideo；时长按配方能力 clamp，不能超上限（方案 §7.6）
      onSub?.("已提交远程生成任务…");
      const card = recipe?.providerModelKey
        ? resolveModelCard("video", recipe.providerModelKey)
        : resolveModelCard("video");
      // 3.5 统一视频规格：远程通道只消费 resolveVideoSpec——能力 = 配方快照 + 适配器协议（无 FPS 直出参数的引擎不发 fps）
      const spec = resolveVideoSpec(project, segment, specCapabilityFor(recipe, card));
      const duration = spec.applied.durationSec !== undefined ? String(spec.applied.durationSec) : undefined;
      let adapterReport: AdapterSpecReport | undefined;
      // 首帧 = 本段显式首帧 ?? 上一段尾帧（显式优先已在接力注入时处理）
      videoUrl = await generateVideo(card, {
        prompt: finalPrompt,
        aspect: project.aspect,
        duration,
        // 3.5：分辨率与帧率真正随请求提交（此前远程通道从未传过，分段写了 1080p/24fps 也只留在文本里）
        resolution: spec.applied.resolution?.label,
        fps: spec.applied.fps,
        image: media?.images.firstFrame,
        lastFrame: media?.images.lastFrame,
        refImages: media?.images.refs.length ? media.images.refs : undefined,
        // 3.3 §2.5：参考视频/音频与原生音频从导演片段贯通（VideoGenReq 早已预留，此前从未传入）；
        // 官方适配器（ark/dashscope/google）真实消费，通用协议按家族尽力透传
        video: media?.videos[0],
        refAudio: media?.audios[0],
        audio: recipe?.capabilitySnapshot?.nativeAudio ? true : undefined,
        // 3.5 §6.8：适配器构造完请求体如实上报发送值（含内部钳制）——Take 快照消费，不照抄 requested
        onSpecApplied: (rep) => {
          adapterReport = rep;
        },
        // 3.4：硬停止真正可中断远程轮询、细粒度进度回流任务条（此前两者都没传）
        signal,
        onProgress: (m) => onSub?.(m),
      });
      // 用量记账（与画布/助手同一本账）：远程 Take 不再游离在用量看板之外
      useUsage.getState().record(card, { ok: true, videoSec: duration ? Number(duration) : estDurationSec(segment), durMs: Date.now() - t0 });
      modelLabel = card.model;
      resolvedSpec = adapterReport ? mergeAdapterReport(spec, adapterReport) : spec;
      // 3.4：远程配方的 paramSnapshot 记录实际请求参数（此前照抄 defaultParams，与真实请求不一致）
      remoteParams = {
        aspect: project.aspect,
        ...(duration ? { duration } : {}),
        ...(spec.applied.resolution ? { resolution: spec.applied.resolution.label } : {}),
        ...(spec.applied.fps !== undefined ? { fps: spec.applied.fps } : {}),
        ...(recipe?.capabilitySnapshot?.nativeAudio ? { audio: true } : {}),
      };
    }
    if (!videoUrl) throw new Error("视频生成未返回结果");
    // 落资产库
    const asset = await useAssets.getState().collect({
      src: videoUrl,
      kind: "video",
      prompt,
      model: modelLabel,
      director: { projectId, segmentId: segment.id, takeId: take.id, role: "generated" },
    });
    if (!asset) throw new Error("资产收录失败");
    // 3.5 P2：绑定项目文件夹时镜像落盘到 分段资产库/NN_标题/Takes/（失败不阻断）
    void mirrorProjectAsset({ projectId, segmentId: segment.id, category: "take", assetId: asset.id, segTitle: segment.summary.slice(0, 20) });
    // 完整快照写入（方案 §7.9：编译后的真实请求提示词 + 配方 + Skill 栈快照）
    patchTake(projectId, segment.id, take.id, {
      status: "done",
      assetId: asset.id,
      promptSnapshot: finalPrompt,
      recipeSnapshot: recipe,
      paramSnapshot: remoteParams ?? recipe?.defaultParams,
      skillSnapshots: snapshots.length ? snapshots : undefined,
      slotSnapshot: media?.snapshot,
      requestedVideoSpec: resolvedSpec?.requested,
      appliedVideoSpec: resolvedSpec?.applied,
      videoSpecSources: resolvedSpec?.source,
      videoSpecAdjustments: resolvedSpec?.adjustments,
    });
    } catch (e) {
      // 「停止」按钮主动掐断：标取消、不进报错中心、不计失败
      if (signal?.aborted) {
        patchTake(projectId, segment.id, take.id, { status: "cancelled", error: "已手动停止" });
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      // 失败也记账（远程配方才可能计费；本地 ComfyUI 失败无 API 费）
      try {
        const r = resolveRecipe(project, segment);
        if (!(r?.engine === "comfy" && r.templateId)) {
          const card = r?.providerModelKey ? resolveModelCard("video", r.providerModelKey) : resolveModelCard("video");
          useUsage.getState().record(card, { ok: false });
        }
      } catch {
        /* 模型都解析不到时无从记账 */
      }
      patchTake(projectId, segment.id, take.id, { status: "error", error: msg });
      directorError(`片段 ${segment.summary.slice(0, 12)}`, msg);
    }
}

/** 批量操作类型 */
export type BatchOp = "selected" | "missing" | "failed" | "modified";

/** 批量取消信号 */
let batchAbort: AbortController | null = null;
export function cancelBatch(): void {
  batchAbort?.abort();
  // 不置 null：runBatch 循环靠 batchAbort?.signal.aborted 判断，置 null 后 ?. 短路返回 undefined（falsy），取消无效
}

/** 在途生成的硬中断信号（「停止」按钮用）：与 batchAbort 分设——batchAbort 只在片段间断点生效，这个直接掐断在途的 ComfyUI 轮询等待 */
let runAbort: AbortController | null = null;
let batchRunning = false; // 批量重入锁（3.4）

/**
 * 停止按钮（硬停止）：立即中断在途生成 + 强停 ComfyUI（/interrupt + 清空排队）+ 清空显存内存（/free）。
 * 与 cancelBatch 的区别：cancelBatch 是当前段跑完后才停，这个立刻停。
 * 远程计费任务已提交的部分无法撤销，只能终止本地等待与后续队列。返回给 UI toast 用的文案。
 */
export async function stopBatchHard(): Promise<string> {
  batchAbort?.abort();
  runAbort?.abort();
  const host = useSettings.getState().settings.comfy.host;
  if (!host) return "已停止（未配置 ComfyUI 地址；远程计费任务已提交部分无法撤销）";
  const ir = await interruptComfy(host);
  if (!ir.ok) return `已停止本地队列，但强制停止 ComfyUI 失败：${ir.err}`;
  const fr = await freeComfyMemory(host);
  return `已停止并强制中断 ComfyUI · ${freeResultText(fr)}`;
}

/** 收集需要批量处理的片段（返回 segment + 新建或现有的 pending/error Take） */
export function collectBatchTasks(project: DirectorProject, op: BatchOp, selectedIds?: string[]): Array<{
  segment: DirectorSegment;
  kind: "image" | "video";
}> {
  const tasks: Array<{ segment: DirectorSegment; kind: "image" | "video" }> = [];
  for (const scene of project.scenes) {
    for (const seg of scene.segments) {
      if (op === "selected" && !selectedIds?.includes(seg.id)) continue;
      const takes = seg.takes ?? [];
      const hasDone = takes.some((t) => t.status === "done");
      if (op === "missing" && hasDone) continue;
      if (op === "failed" && (hasDone || !takes.some((t) => t.status === "error" || t.status === "cancelled"))) continue;
      // modified: 提示词/配方相对采用 Take 已变化的片段（promptOverride 改过、或没有采用版本）
      if (op === "modified") {
        const approved = takes.find((t) => t.id === seg.approvedTakeId);
        if (approved && seg.promptOverride && approved.promptSnapshot !== seg.promptOverride) {
          // 提示词改过，需重生成
        } else if (approved) {
          continue; // 采用版本没变，跳过
        }
      }
      tasks.push({ segment: seg, kind: "video" }); // 默认生成视频片段
    }
  }
  return tasks;
}

/**
 * 批量执行：按队列顺序执行多个片段的视频生成（本地串行，避免显存竞争）。
 * 每个 segment 新建一个 Take。
 */
export async function runBatch(
  projectId: string,
  op: BatchOp,
  selectedIds?: string[],
  onProgress?: (done: number, total: number, current: string, detail?: { msg?: string; pct?: number }) => void,
  /** 预检未通过的片段（§9.4 合同：只跑通过预检的部分） */
  excludeIds?: string[],
  signal?: AbortSignal,
): Promise<{ done: number; failed: number; cancelled: number }> {
  const project = useDirector.getState().getById(projectId);
  if (!project) return { done: 0, failed: 0, cancelled: 0 };
  // 重入锁（3.4）：快速双击/确认卡打开期间再点，绝不允许两个批次并存（模块级 AbortController 会被后批覆盖）
  signal?.throwIfAborted();
  if (batchRunning) throw new Error("已有批量生成在运行——请等它结束或先在任务中心取消");
  batchRunning = true;
  const stopOwnedBatch=()=>{batchAbort?.abort();runAbort?.abort();};
  signal?.addEventListener("abort",stopOwnedBatch,{once:true});
  try {
  const all = collectBatchTasks(project, op, selectedIds);
  const tasks = excludeIds?.length ? all.filter((t) => !excludeIds.includes(t.segment.id)) : all;
  if (!tasks.length) return { done: 0, failed: 0, cancelled: 0 };
  // 统一预算闸（capability/budget，与画布/助手同一道门）：日预算按整批预估预检（skipPerRunCap——
  // 单次上限的语义是「单次生成」，逐段在循环里查，不能拿整批总和去比）。
  // 确认阈值在 UI 直点路径以提示告知（能力层路径由信封的确认卡承接）。
  const est = estimateBatchTasks(project, tasks);
  if (est.cost > 0) {
    const gate = budgetGate(est.cost, `批量生成 ${tasks.length} 段（远程 ${est.remote} 段）`, { skipPerRunCap: true });
    if (gate.block) throw new Error(gate.block);
    if (gate.confirm) toast(gate.confirm + "（可在设置 → 用量调整阈值）", "info");
  }
  // 3.4：H3 批量生成进统一任务中心（可观察 + 任务级取消——跑完当前段后停止，不掐正在提交的计费）
  const opLabel = op === "selected" ? "生成所选" : op === "missing" ? "补缺" : "重跑失败";
  const job = jobCenter.begin({
    projectId,
    kind: "generate",
    label: `${opLabel} · ${tasks.length} 段`,
    status: "running",
    cancellable: true,
    cancelRun: () => cancelBatch(),
    retryNote:"只重跑本批尚无成功结果的失败或取消片段，远程提交可能计费。",
    retryRun:async()=>{const latest=useDirector.getState().getById(projectId);if(!latest)return;const ids=latest.scenes.flatMap(s=>s.segments).filter(g=>tasks.some(t=>t.segment.id===g.id)&&!(g.takes??[]).some(t=>t.status==="done")).map(g=>g.id);if(ids.length)await runBatch(projectId,"selected",ids);},
  });

  // 先为每个 task 创建 Take 并入项目
  const newTakesBySeg = new Map<string, DirectorTake>();
  for (const t of tasks) {
    const take = createTake(t.segment.id, t.kind, "clip", t.segment.promptOverride ?? t.segment.summary);
    newTakesBySeg.set(t.segment.id, take);
  }
  // 批量写入项目
  const scenes = project.scenes.map((s) => ({
    ...s,
    segments: s.segments.map((seg) => {
      const nt = newTakesBySeg.get(seg.id);
      return nt ? { ...seg, takes: [...(seg.takes ?? []), nt] } : seg;
    }),
  }));
  useDirector.getState().updateProject(projectId, { scenes });

  // 串行执行（本地默认并发 1）
  let done = 0;
  let failed = 0;
  let cancelled = 0;
  const total = tasks.length;
  batchAbort = new AbortController();
  runAbort = new AbortController();
  if(signal?.aborted)stopOwnedBatch();
  let aborted = false;
  // 空间接力：每个任务只读取故事顺序中紧邻的上一段，绝不把「所选/缺失」列表中非相邻任务串接。
  const storyOrder = project.scenes.flatMap((s) => s.segments).map((s) => s.id);
  for (let i = 0; i < tasks.length; i++) {
    if (batchAbort?.signal.aborted) { aborted = true; break; }
    const t = tasks[i];
    const take = newTakesBySeg.get(t.segment.id)!;
    onProgress?.(i, total, t.segment.summary.slice(0, 20));
    job.stage(`第 ${i + 1}/${total} 段 · ${t.segment.summary.slice(0, 16)}`, Math.round((i / total) * 100));
    // 单次上限/日预算逐段预检（中途日预算被其他任务吃满也在此拦）：超标段标失败并说明原因，不拦整批
    const taskEst = estimateBatchTasks(project, [t]);
    if (taskEst.cost > 0) {
      const segGate = budgetGate(taskEst.cost, `片段「${t.segment.summary.slice(0, 12)}」生成`);
      if (segGate.block) {
        patchTake(projectId, t.segment.id, take.id, { status: "error", error: segGate.block });
        directorError(`片段 ${t.segment.summary.slice(0, 12)}`, segGate.block);
        failed++;
        continue;
      }
    }
    // 细粒度进度（ComfyUI 节点/步数百分比、上传/参数写入各阶段）续在段级进度上
    const sub = (msg: string, pct?: number) => onProgress?.(i, total, t.segment.summary.slice(0, 20), { msg, pct });
    // 重新读项目（每轮可能被更新）。执行前从真正相邻的上一段准备接力包；首段不接力。
    let curProj = useDirector.getState().getById(projectId);
    if (!curProj) break;
    let curSeg = curProj.scenes.flatMap((s) => s.segments).find((s) => s.id === t.segment.id);
    if (!curSeg) continue;
    let relayFrame: string | undefined;
    const continuityMode = segmentContinuityMode(curSeg);
    const relayAllowed = shouldRelay(curProj, curSeg) && (curSeg.relayMode !== undefined || continuityMode === "continuity_relay");
    if (!relayAllowed && (curSeg.slots ?? []).some((s) => s.relayKind || /自动接力/.test(s.label ?? ""))) {
      // 开篇和硬切换场必须清掉历史接力槽，防止上一次运行留下的图片/视频继续污染新空间。
      clearRelaySlots(projectId, curSeg.id);
      curProj = useDirector.getState().getById(projectId);
      curSeg = curProj?.scenes.flatMap((s) => s.segments).find((s) => s.id === t.segment.id);
      if (!curProj || !curSeg) break;
    }
    if (continuityMode === "hard_cut") {
      sub("硬切换场：已忽略上一段桥接图片与视频");
    }
    if (relayAllowed) {
      const pos = storyOrder.indexOf(curSeg.id);
      const prevId = pos > 0 ? storyOrder[pos - 1] : undefined;
      const prevSeg = prevId ? curProj.scenes.flatMap((s) => s.segments).find((s) => s.id === prevId) : undefined;
      const sourceTake = prevSeg ? relaySourceTake(prevSeg) : undefined;
      if (sourceTake) {
        const cap = referenceVideoCapacity(curProj, curSeg);
        const usedVideos = [...(curProj.globalSlots ?? []), ...(curSeg.slots ?? [])]
          .filter((s) => s.semantic === "referenceVideo" && !s.relayKind)
          .reduce((n, s) => n + s.assetIds.length, 0);
        const needClip = cap > usedVideos;
        // 配方已无视频槽时摘除旧桥接视频，防止历史槽继续参与本轮工作流。
        if (!needClip && (curSeg.slots ?? []).some((s) => s.relayKind === "clip")) {
          clearRelaySlots(projectId, curSeg.id, "clip");
          curProj = useDirector.getState().getById(projectId);
          curSeg = curProj?.scenes.flatMap((s) => s.segments).find((s) => s.id === t.segment.id);
          if (!curProj || !curSeg) break;
        }
        onProgress?.(i, total, "准备空间接力…", { msg: needClip ? "提取稳定桥接帧与末尾 2 秒…" : "提取稳定桥接帧…" });
        relayFrame = (await existingRelayFrame(curSeg, sourceTake.id, needClip)) ?? undefined;
        if (!relayFrame) {
          // 来源变化或已有素材损坏时先摘掉旧槽；提取失败也不能把旧段错误接到当前段。
          clearRelaySlots(projectId, curSeg.id);
          const bundle = await takeRelayBundle(sourceTake, needClip);
          if (bundle) {
            relayFrame = bundle.frame;
            await fillRelaySlots(projectId, curSeg.id, prevSeg!.id, bundle);
            // 槽位刚回填，刷新项目/片段，让本轮 resolveSlotMedia 立即读到桥接视频。
            curProj = useDirector.getState().getById(projectId);
            curSeg = curProj?.scenes.flatMap((s) => s.segments).find((s) => s.id === t.segment.id);
            if (!curProj || !curSeg) break;
          }
        }
      } else if ((curSeg.slots ?? []).some((s) => s.relayKind || /自动接力/.test(s.label ?? ""))) {
        // 相邻上一段没有成功Take：不得沿用历史或非相邻接力素材。
        clearRelaySlots(projectId, curSeg.id);
        curProj = useDirector.getState().getById(projectId);
        curSeg = curProj?.scenes.flatMap((s) => s.segments).find((s) => s.id === t.segment.id);
        if (!curProj || !curSeg) break;
      }
    }
    if (t.kind === "video") {
      await executeVideoTake(projectId, curSeg, take, curProj, relayFrame, sub, runAbort?.signal);
    } else {
      await executeImageTake(projectId, curSeg, take, curProj, relayFrame, sub, runAbort?.signal);
    }
    // 检查执行后的状态（被「停止」掐断的 cancelled 不算失败）
    const finalProj = useDirector.getState().getById(projectId);
    const finalTake = finalProj?.scenes.flatMap((s) => s.segments).flatMap((seg) => seg.takes ?? []).find((tk) => tk.id === take.id);
    if (finalTake?.status === "done") {
      done++;
    } else if (finalTake?.status === "cancelled") {
      cancelled++;
    } else {
      failed++;
    }
    // 每段结束后按项目开关清理 ComfyUI 显存（无论成败；失败不阻断队列，下一段会重新加载模型）
    if (curProj.freeMemBetween) {
      const host = useSettings.getState().settings.comfy.host;
      if (host) {
        onProgress?.(i + 1, total, "清理显存…");
        const r = await freeComfyMemory(host);
        if (!r.ok) console.warn("[导演台] 清理显存失败：", r.err);
      }
    }
  }
  // 取消后：仍未执行的（status 仍为 queued）Take 标 cancelled（P1-6 修复）
  if (aborted) {
    const curProj = useDirector.getState().getById(projectId);
    if (curProj) {
      // 本轮 batch 新建的 take id 集合
      const batchTakeIds = new Set(Array.from(newTakesBySeg.values()).map((tk) => tk.id));
      const scenes = curProj.scenes.map((s) => ({
        ...s,
        segments: s.segments.map((seg) => ({
          ...seg,
          takes: (seg.takes ?? []).map((tk) => {
            // 只处理本轮 batch 创建的、状态仍是 queued 的（未执行）
            if (batchTakeIds.has(tk.id) && tk.status === "queued") {
              cancelled++;
              return { ...tk, status: "cancelled" as const };
            }
            return tk;
          }),
        })),
      }));
      useDirector.getState().updateProject(projectId, { scenes });
    }
  }
  onProgress?.(total, total, "");
  batchAbort = null;
  runAbort = null;
  if (aborted) job.cancel();
  else if (failed) job.fail(`完成 ${done}/${total}，失败 ${failed}`);
  else job.done(`完成 ${done}/${total}`);
  return { done, failed, cancelled };
  } finally {
    // 无论中途抛什么（单段失败已内部消化，这里兜意外异常），重入锁必须释放
    signal?.removeEventListener("abort",stopOwnedBatch);
    batchAbort=null;runAbort=null;
    batchRunning = false;
  }
}

/**
 * 跨重启恢复：应用启动时调用。把所有 running 的 Take 标「中断」（方案 §7.8）。
 * 不能静默重置为 queued——用户需要知道上次中断了。
 */
export function recoverInterruptedTasks(): number {
  let count = 0;
  const projects = useDirector.getState().projects;
  for (const proj of projects) {
    let dirty = false;
    const scenes = proj.scenes.map((s) => ({
      ...s,
      segments: s.segments.map((seg) => ({
        ...seg,
        takes: (seg.takes ?? []).map((t) => {
          if (t.status === "running") {
            dirty = true;
            count++;
            return { ...t, status: "error" as const, error: "上次运行中断（应用退出/崩溃）" };
          }
          return t;
        }),
      })),
    }));
    if (dirty) useDirector.getState().updateProject(proj.id, { scenes });
  }
  return count;
}

/* ---------------- 后处理派生链（方案 §20.5） ---------------- */

/**
 * 对一个已采用 Take 执行后处理（放大/补帧/修复），产出派生 Take。
 *
 * 流程：
 *  1. 取原始 Take 的资产地址
 *  2. 喂给 ComfyUI 后处理分支（recipe.templateId + variantId）
 *  3. 结果落资产库
 *  4. 创建派生 Take，记录 derivedFrom 链
 *  5. 派生 Take 不自动采用（用户决定是否替换时间线上的原版）
 */
export async function executePostProcess(
  projectId: string,
  segmentId: string,
  sourceTakeId: string,
  recipe: DirectorPostRecipe,
): Promise<DirectorTake | null> {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return null;
  const seg = proj.scenes.flatMap((s) => s.segments).find((x) => x.id === segmentId);
  if (!seg) return null;
  const sourceTake = (seg.takes ?? []).find((t) => t.id === sourceTakeId);
  if (!sourceTake?.assetId) {
    directorError("后处理", `原始 Take ${sourceTakeId} 没有资产，无法后处理`);
    return null;
  }
  // 取资产地址
  const asset = useAssets.getState().items.find((a) => a.id === sourceTake.assetId);
  if (!asset) {
    directorError("后处理", `资产 ${sourceTake.assetId} 不在资产库`);
    return null;
  }
  const inputUrl = await assetToDataUrl(asset.path);

  // 创建派生 Take（先标 running）
  const derived = createTake(segmentId, recipe.outputKind, sourceTake.target, sourceTake.promptSnapshot);
  derived.status = "running";
  derived.derivedFrom = { takeId: sourceTakeId, postRecipeId: recipe.id, postRecipeName: recipe.name };
  // 写入项目
  const writeDerived = (take: DirectorTake) => {
    const p = useDirector.getState().getById(projectId);
    if (!p) return;
    const scenes = p.scenes.map((s) => ({
      ...s,
      segments: s.segments.map((x) =>
        x.id === segmentId ? { ...x, takes: [...(x.takes ?? []).filter((t) => t.id !== take.id), take] } : x,
      ),
    }));
    useDirector.getState().updateProject(projectId, { scenes });
  };
  writeDerived(derived);

  try {
    // 调 ComfyUI 后处理分支
    const tpl = useComfy.getState().templates.find((t) => t.id === recipe.templateId);
    if (!tpl) throw new Error(`后处理配方「${recipe.name}」的模板 ${recipe.templateId} 不存在`);
    const host = useSettings.getState().settings.comfy.host;
    if (!host) throw new Error("请先在设置里配置 ComfyUI 地址");
    const { images, videos } = await runComfyTemplate(host, tpl, recipe.defaultParams as Record<string, string | number | boolean>, {
      variantId: recipe.variantId,
      upstreamImages: recipe.inputKind === "image" ? [inputUrl] : [],
      upstreamVideos: recipe.inputKind === "video" ? [inputUrl] : [],
    });
    const resultUrl = recipe.outputKind === "image" ? images[0] : videos[0];
    if (!resultUrl) throw new Error(`后处理配方「${recipe.name}」未返回结果`);
    // 落资产
    const newAsset = await useAssets.getState().collect({
      src: resultUrl,
      kind: recipe.outputKind,
      prompt: `${sourceTake.promptSnapshot}（后处理：${recipe.name}）`,
      model: `ComfyUI · ${recipe.name}`,
      // 3.5 P2：后处理派生 Take 同样带 director 归属并镜像进项目目录（分段资产库/NN_标题/后处理/）
      director: { projectId, segmentId, takeId: derived.id, role: "generated" },
    });
    if (newAsset) {
      void mirrorProjectAsset({ projectId, segmentId, category: "post", assetId: newAsset.id, segTitle: seg.summary.slice(0, 20) });
    }
    derived.status = "done";
    derived.assetId = newAsset?.id;
    derived.note = `由「${sourceTake.note ?? "原始版本"}」经 ${recipe.name} 派生`;
    writeDerived(derived);
    return derived;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    derived.status = "error";
    derived.error = msg;
    writeDerived(derived);
    directorError(`后处理 · ${recipe.name}`, msg);
    return null;
  }
}

/**
 * 批量后处理：把所有采用版本按后处理配方跑一遍。
 * 通常用于「放大所有低于目标分辨率的片段」。
 */
export async function runBatchPostProcess(
  projectId: string,
  recipe: DirectorPostRecipe,
  predicate?: (seg: DirectorSegment, take: DirectorTake) => boolean,
  onProgress?: (done: number, total: number) => void,
): Promise<{ done: number; failed: number }> {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return { done: 0, failed: 0 };
  // 收集需要后处理的（采用版本 + 满足谓词）
  const tasks: Array<{ segmentId: string; takeId: string }> = [];
  for (const scene of proj.scenes) {
    for (const seg of scene.segments) {
      const take = (seg.takes ?? []).find((t) => t.id === seg.approvedTakeId);
      if (!take || take.status !== "done") continue;
      // 排除已经是派生版本的（避免无限派生）
      if (take.derivedFrom) continue;
      if (predicate && !predicate(seg, take)) continue;
      tasks.push({ segmentId: seg.id, takeId: take.id });
    }
  }
  let done = 0;
  let failed = 0;
  for (let i = 0; i < tasks.length; i++) {
    onProgress?.(i, tasks.length);
    const result = await executePostProcess(projectId, tasks[i].segmentId, tasks[i].takeId, recipe);
    if (result?.status === "done") done++;
    else failed++;
    // 与批量生成同一开关：每段后处理结束也清理显存
    if (proj.freeMemBetween) {
      const host = useSettings.getState().settings.comfy.host;
      if (host) await freeComfyMemory(host);
    }
  }
  onProgress?.(tasks.length, tasks.length);
  return { done, failed };
}

/**
 * 批量高清放大（成片检查通过后）：把每个片段的采用版本视频逐条送入指定 ComfyUI 放大模板，
 * 成功后派生新版本并自动切换采用——成片预览/成片检查/片段卡即刻显示高清版（原版本保留在版本列表可回退）。
 * 模板必须带视频入口（LoadVideo 类节点）；图片版放大模板会在这里被明确拦下。
 */
export async function runBatchUpscale(
  projectId: string,
  templateId: string,
  onProgress?: (done: number, total: number, name: string) => void,
  paramOverride?: Record<string, string | number | boolean>,
): Promise<{ done: number; failed: number }> {
  const tpl = useComfy.getState().templates.find((t) => t.id === templateId);
  if (!tpl) throw new Error("放大模板不存在，请先在「设置 → ComfyUI 模板」导入");
  const hasVideoEntry = Object.values(tpl.workflow).some((n) => isVideoLoaderClass(n.class_type));
  if (!hasVideoEntry) {
    throw new Error(
      `模板「${tpl.name}」没有视频入口（LoadVideo 类节点），吃不了视频——请导入带 LoadVideo 的视频放大工作流（图片版放大模板不行）`,
    );
  }
  const recipe: DirectorPostRecipe = {
    id: `upscale_${tpl.id}`,
    name: `${tpl.name} · 高清放大`,
    kind: "upscale-video",
    templateId: tpl.id,
    variantId: "default",
    inputKind: "video",
    outputKind: "video",
    defaultParams: { ...defaultParamValues(tpl.params), ...(paramOverride ?? {}) },
  };
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return { done: 0, failed: 0 };
  const tasks: Array<{ segmentId: string; takeId: string; name: string }> = [];
  for (const scene of proj.scenes) {
    for (const seg of scene.segments) {
      const take = (seg.takes ?? []).find((t) => t.id === seg.approvedTakeId);
      if (!take || take.status !== "done" || take.kind !== "video" || !take.assetId) continue;
      if (take.derivedFrom?.postRecipeId === recipe.id) continue; // 已是本模板的放大版，跳过防循环
      tasks.push({ segmentId: seg.id, takeId: take.id, name: seg.summary.slice(0, 12) });
    }
  }
  if (!tasks.length) return { done: 0, failed: 0 };
  let done = 0;
  let failed = 0;
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    onProgress?.(i, tasks.length, t.name);
    const derived = await executePostProcess(projectId, t.segmentId, t.takeId, recipe);
    if (derived?.status === "done" && derived.assetId) {
      done++;
      // 替换：采用版本切到高清派生版（成片预览/成片检查/片段卡即刻生效；原版本保留可回退）
      const cur = useDirector.getState().getById(projectId);
      if (cur) {
        const scenes = cur.scenes.map((s) => ({
          ...s,
          segments: s.segments.map((x) => (x.id === t.segmentId ? { ...x, approvedTakeId: derived.id } : x)),
        }));
        useDirector.getState().updateProject(projectId, { scenes });
      }
    } else {
      failed++;
    }
  }
  onProgress?.(tasks.length, tasks.length, "");
  return { done, failed };
}
