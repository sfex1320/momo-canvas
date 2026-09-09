/**
 * 导演台参考图管线 — 画布上游图片 ↔ 素材槽（globalSlots / segment.slots）的同步与消费
 *
 * 数据流：
 *  画布上游图片节点 →（collectUpstream）→ dataURL 列表
 *    → syncRefSlots 收录为资产（contentHash 去重，同一图反复同步不会重复落盘）
 *    → 新图追加到 project.globalSlots 尾部；上游断开的图从所有槽位移除
 *  生成时 resolveSlotImages：全局槽（保序）+ 片段槽（追加在后；首帧/尾帧单例语义可覆盖全局）
 *    → dataURL 列表 → imageGen.refImages / videoGen.image+lastFrame+refImages / ComfyUI upstreamImages
 *
 * 顺序语义：globalSlots 数组顺序 = 喂给模型的顺序（用户在导演台参考图卡里上下移动调整）。
 */
import { useAssets } from "./stores/assetStore";
import { useDirector } from "./stores/directorStore";
import { assetToDataUrl } from "./services/assetFiles";
import { hashDataUrl } from "./utils";
import type { AssetKind, ComfySemantic, DirectorProject, DirectorSegment, DirectorSlotValue } from "./types";

// hashDataUrl 已从 utils 导入（头/中/尾三段指纹，同尺寸图片不会撞签名）
export { hashDataUrl };

/** 参考图可绑的接入点（语义槽），参考图卡的下拉选项 */
export const REF_SEMANTICS: Array<{ value: ComfySemantic; label: string }> = [
  { value: "referenceImage", label: "参考图" },
  { value: "firstFrame", label: "首帧" },
  { value: "lastFrame", label: "尾帧" },
  { value: "poseGuide", label: "姿势参考" },
  { value: "layoutGuide", label: "布局参考" },
  { value: "characterRef", label: "角色参考" },
  { value: "shotScale", label: "景别参考" },
  { value: "lighting", label: "光线参考" },
];

/** 视频/音频参考的语义标签（分镜卡片的视/音槽用，不进图片接入点下拉） */
export const MEDIA_SEMANTIC_LABEL: Partial<Record<ComfySemantic, string>> = {
  referenceVideo: "视频参考",
  referenceAudio: "音频参考",
};

/** 单例语义：首帧/尾帧只生效第一张，且片段槽可覆盖全局同名单例槽 */
const SINGLETON_SEMANTICS = new Set<ComfySemantic>(["firstFrame", "lastFrame"]);

/** 画布上游媒体集合（collectUpstream 的三类产物，均为 dataURL） */
export type UpstreamMedia = { images: string[]; videos?: string[]; audios?: string[] };

/** 上游三类素材的收录配置：资产类型 + 默认语义槽 */
const MEDIA_CONF: Array<{ key: keyof UpstreamMedia; kind: AssetKind; semantic: ComfySemantic; name: string }> = [
  { key: "images", kind: "image", semantic: "referenceImage", name: "导演台参考图" },
  { key: "videos", kind: "video", semantic: "referenceVideo", name: "导演台参考视频" },
  { key: "audios", kind: "audio", semantic: "referenceAudio", name: "导演台参考音频" },
];

/**
 * 把画布上游素材同步进项目素材槽：
 *  - 上游图/视/音收录为资产（内容哈希去重），新素材追加全局槽尾部（按类型给默认接入点）
 *  - 已在槽位中的素材保持原顺序/语义/作用域不变
 *  - 上游断开的同步槽素材从全局槽与所有片段槽移除；手动槽（auto=false）整槽保留
 *  - refExcluded 里的资产不再自动加入（用户在导演台手动排除的）
 */
export function syncRefSlots(projectId: string, upstream: UpstreamMedia): Promise<void> {
  // 并发安全：DirectorNode 与 RefSlotsCard 各有一份同步 effect，同一项目的同步按调用顺序串行——
  // 否则两个调用都在 collect 的 await 让出期间读不到对方刚落盘的资产，会重复收录 + 重复建槽
  const prev = syncLocks.get(projectId) ?? Promise.resolve();
  const next = prev.then(() => doSyncRefSlots(projectId, upstream));
  // 吞掉链上异常，不让一次失败卡死后续同步
  syncLocks.set(projectId, next.catch(() => {}));
  return next;
}

/** 每项目一条同步链（模块级，跨组件共享） */
const syncLocks = new Map<string, Promise<void>>();

async function doSyncRefSlots(projectId: string, upstreamMedia: UpstreamMedia): Promise<void> {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  // 1) 上游图/视/音 → 资产 id（contentHash 命中即复用，不重复收录落盘；同一素材被两个上游节点引用时只留一份）
  const entries: Array<{ id: string; semantic: ComfySemantic }> = [];
  const seen = new Set<string>();
  for (const conf of MEDIA_CONF) {
    for (const src of upstreamMedia[conf.key] ?? []) {
      const h = hashDataUrl(src);
      // 每次查找前重读 items：本循环内 collect 落盘的资产要对后续查找可见（旧快照会 miss 导致重复收录）
      const hit = useAssets.getState().items.find((i) => i.contentHash === h);
      const a =
        hit ??
        (await useAssets.getState().collect({
          src,
          kind: conf.kind,
          name: conf.name,
          contentHash: h,
          director: { projectId, role: "reference" },
        }));
      if (a && !seen.has(a.id)) {
        seen.add(a.id);
        entries.push({ id: a.id, semantic: conf.semantic });
      }
    }
  }
  // 2) 对账（重读项目：collect 是异步的，期间项目可能已被更新）
  const cur = useDirector.getState().getById(projectId);
  if (!cur) return;
  const upstream = new Set(entries.map((e) => e.id));
  const excluded = new Set(cur.refExcluded ?? []);
  // 手动槽（auto === false）整槽保留；同步槽只留仍在上游的资产
  const prune = (slots: DirectorSlotValue[]) =>
    slots
      .map((s) => (s.auto === false ? s : { ...s, assetIds: s.assetIds.filter((id) => upstream.has(id)) }))
      .filter((s) => s.assetIds.length > 0);
  const keptGlobal = prune(cur.globalSlots ?? []);
  // 已在任意槽位（全局或片段）里的素材不重复追加
  const inSlots = new Set<string>();
  for (const s of keptGlobal) for (const id of s.assetIds) inSlots.add(id);
  for (const sc of cur.scenes)
    for (const seg of sc.segments)
      for (const s of seg.slots ?? []) for (const id of s.assetIds) inSlots.add(id);
  // 新素材接入点取语义记忆（断开重连恢复原配置），无记忆按素材类型默认
  const semMemory = cur.refSemMemory ?? {};
  const added: DirectorSlotValue[] = entries
    .filter((e) => !inSlots.has(e.id) && !excluded.has(e.id))
    .map((e) => ({ semantic: semMemory[e.id] ?? e.semantic, assetIds: [e.id], auto: true }));
  const globalSlots = [...keptGlobal, ...added];
  // 片段槽：清掉已断开的上游图
  let scenesChanged = false;
  const scenes = cur.scenes.map((sc) => ({
    ...sc,
    segments: sc.segments.map((seg) => {
      if (!seg.slots?.length) return seg;
      const slots = prune(seg.slots);
      if (JSON.stringify(slots) === JSON.stringify(seg.slots)) return seg;
      scenesChanged = true;
      return { ...seg, slots };
    }),
  }));
  // 语义记忆：本轮被 prune 掉的槽位把 assetId → semantic 存下来，重连时可恢复
  let memChanged = false;
  const nextMem = { ...semMemory };
  const remember = (slots: DirectorSlotValue[]) => {
    for (const s of slots)
      for (const id of s.assetIds)
        if (!upstream.has(id) && nextMem[id] !== s.semantic) {
          nextMem[id] = s.semantic;
          memChanged = true;
        }
  };
  remember(cur.globalSlots ?? []);
  for (const sc of cur.scenes) for (const seg of sc.segments) remember(seg.slots ?? []);
  const globalChanged = JSON.stringify(globalSlots) !== JSON.stringify(cur.globalSlots ?? []);
  if (!globalChanged && !scenesChanged && !memChanged) return;
  useDirector.getState().updateProject(projectId, { globalSlots, scenes, refSemMemory: nextMem });
}

/** 把生效槽位快照转成提示词引用说明，编号与模型实际收到的素材顺序严格一致：
 *  - image（生图）：所有图进 refImages（orderedAll 顺序），首尾帧也编「图N」——图1=第一张槽位图
 *  - video（生视频）：首帧/尾帧是具名参数（image/lastFrame），用专名「首帧/尾帧」；其余参考图按 refs 顺序编「图N」
 *  - 视频/音频参考单独编号：视频N（<Video N>）、音频N（<Audio N>），与 H3 REF2VA 标签体系一致
 *  分镜批量生成时前置拼进 prompt，模型写提示词可用「图N」或「首帧/尾帧」指代具体参考图。 */
export function refsNoteFromSnapshot(slots: DirectorSlotValue[], target: "image" | "video"): string {
  const semLabel = new Map(REF_SEMANTICS.map((s) => [s.value, s.label]));
  const lines: string[] = [];
  let n = 0;
  let vn = 0;
  let an = 0;
  let relayFrameRef = "";
  let relayClipRef = "";
  const spatialLayoutRefs: string[] = [];
  for (const slot of slots) {
    for (const _aid of slot.assetIds) {
      if (slot.semantic === "referenceVideo" || slot.semantic === "referenceAudio") {
        if (target === "image") continue; // 生图不吃视/音参考，不列进说明
        if (slot.semantic === "referenceVideo") {
          vn++;
          lines.push(`视频${vn}：${slot.label ?? "视频参考"}（H3 标签 <Video ${vn}>）`);
          if (slot.relayKind === "clip") relayClipRef = `<Video ${vn}>`;
        } else {
          an++;
          lines.push(`音频${an}：${slot.label ?? "音频参考"}（H3 标签 <Audio ${an}>）`);
        }
        continue;
      }
      const label = slot.label ?? semLabel.get(slot.semantic) ?? slot.semantic;
      if (target === "video" && (slot.semantic === "firstFrame" || slot.semantic === "lastFrame")) {
        // 视频首尾帧是具名参数，不占「图N」序号；自定义 label（尾帧接力虚拟槽）带上语义前缀
        lines.push(slot.label ? `${semLabel.get(slot.semantic)}：${slot.label}` : label);
        if (slot.relayKind === "frame" && slot.semantic === "firstFrame") relayFrameRef = "the bound first frame";
      } else {
        n++;
        lines.push(target === "video" ? `图${n}：${label}（H3 标签 <Picture ${n}>）` : `图${n}：${label}`);
        if (target === "video" && slot.relayKind === "frame") relayFrameRef = `<Picture ${n}>`;
        if (target === "video" && (slot.referenceRole === "spatialLayout" || slot.semantic === "layoutGuide")) {
          spatialLayoutRefs.push(`<Picture ${n}>`);
        }
      }
    }
  }
  if (target === "video" && spatialLayoutRefs.length) {
    lines.push(
      `Spatial layout guide: use ${spatialLayoutRefs.join(", ")} only for relative positions, camera origin and viewing direction, left-right/front-back landmarks, start/end positions, and movement vectors. Do not reproduce its top-down diagram style, labels, arrows, icons, borders, legend, or text; the output must keep the requested cinematic viewpoint.`,
    );
  }
  if (target === "video" && (relayFrameRef || relayClipRef)) {
    const anchor = relayFrameRef
      ? `Treat ${relayFrameRef} as the opening spatial anchor: preserve camera position, viewing direction, horizon, left-right landmarks, teammate positions, and visible equipment.`
      : "";
    const motion = relayClipRef
      ? ` Continue the final motion direction and camera momentum shown in ${relayClipRef}; do not reverse the axis or introduce a new viewpoint.`
      : "";
    lines.push(`Continuity relay: ${anchor}${motion} During 00:00-00:01, reproduce this state before beginning the next action.`);
  }
  const hint = target === "video" ? "图N 或 首帧/尾帧" : "图N";
  return lines.length ? `参考素材（按序，提示词可用「${hint}」引用）：\n${lines.join("\n")}` : "";
}

/** resolveSlotImages 的结果：按生效顺序解析好的 dataURL 列表 + 槽位快照 */
export type ResolvedRefs = {
  /** 全部参考图按生效顺序（ComfyUI upstreamImages / 图片多参考用） */
  orderedAll: string[];
  /** 首帧（视频 i2v/fl2v 用） */
  firstFrame?: string;
  /** 尾帧（视频 fl2v 用） */
  lastFrame?: string;
  /** 除首帧/尾帧外的参考图（视频 r2v 用） */
  refs: string[];
  /** 图片与其来源槽的逐项对应，用于槽位容量裁剪时优先移除规划站位图 */
  entries: Array<{ url: string; assetId: string; slot: DirectorSlotValue }>;
  /** 生效的槽位快照（写进 Take 可追溯，方案 §7.9） */
  snapshot: DirectorSlotValue[];
};

/** 计算片段生效槽位：全局槽（保序）+ 片段槽（追加在后；首帧/尾帧单例语义片段覆盖全局） */
export function effectiveSlots(project: DirectorProject, segment: DirectorSegment): DirectorSlotValue[] {
  const continuityText = [
    segment.promptFinalOverride,
    segment.promptOverride,
    segment.scriptText,
    segment.summary,
    segment.continuityIn,
  ].filter(Boolean).join("\n");
  const relayForbidden =
    /Continuity mode:\s*(?:opening|hard[_ -]?cut)/i.test(continuityText)
    || /衔接模式[：:]\s*(?:开篇|硬切)/.test(continuityText);
  // 接力关闭或本段为开篇/硬切时保留已截取资产，方便人工检查，但绝不把它们投喂给模型。
  const active = (slots: DirectorSlotValue[]) =>
    project.tailFrameRelay && !relayForbidden
      ? slots
      : slots.filter((s) => !s.relayKind && !/自动接力/.test(s.label ?? ""));
  const segSlots = active(segment.slots ?? []);
  const segSingletons = new Set(segSlots.map((s) => s.semantic).filter((s) => SINGLETON_SEMANTICS.has(s)));
  return [
    ...active(project.globalSlots ?? []).filter(
      (g) => !(SINGLETON_SEMANTICS.has(g.semantic) && segSingletons.has(g.semantic)),
    ),
    ...segSlots,
  ];
}

/**
 * 解析片段生效的参考图：全局槽（保序）+ 片段槽（追加在后）。
 * 首帧/尾帧是单例语义：片段定义了同名槽时覆盖全局的；同语义取第一张。
 * 没有配置任何槽位（或引用的资产都读不到）时返回 null，生成走纯文本路径。
 */
export async function resolveSlotImages(
  project: DirectorProject,
  segment: DirectorSegment,
): Promise<ResolvedRefs | null> {
  const effSlots = effectiveSlots(project, segment);
  if (!effSlots.length) return null;
  const items = useAssets.getState().items;
  const res: ResolvedRefs = { orderedAll: [], refs: [], entries: [], snapshot: effSlots };
  for (const slot of effSlots) {
    if (slot.semantic === "referenceVideo" || slot.semantic === "referenceAudio") continue;
    for (const aid of slot.assetIds) {
      const a = items.find((x) => x.id === aid);
      if (!a) continue;
      let url: string | null = null;
      try {
        url = await assetToDataUrl(a.path, a.mime);
      } catch {
        continue; // 资产文件读不到（被清理/移动）→ 跳过这张图，不阻塞生成
      }
      if (!url) continue;
      res.entries.push({ url, assetId: aid, slot });
      res.orderedAll.push(url);
      if (slot.semantic === "firstFrame") {
        if (!res.firstFrame) res.firstFrame = url;
      } else if (slot.semantic === "lastFrame") {
        if (!res.lastFrame) res.lastFrame = url;
      } else {
        res.refs.push(url);
      }
    }
  }
  if (!res.orderedAll.length) return null;
  return res;
}

/** resolveSlotMedia 的结果：图/视/音三类参考按生效槽序解析（MiniMax H3 REF2VA 等多模态参考工作流用） */
export type ResolvedMedia = {
  /** 图片参考（首尾帧/参考图语义；无图时 orderedAll 为空） */
  images: ResolvedRefs;
  /** 视频参考（dataURL，槽序即 <Video N> 编号序） */
  videos: string[];
  /** 音频参考（dataURL，槽序即 <Audio N> 编号序） */
  audios: string[];
  /** 生效的槽位快照（含视/音槽，写进 Take 可追溯） */
  snapshot: DirectorSlotValue[];
};

/**
 * 解析片段生效的全部参考素材（图/视/音三类）。
 * 槽序即编号序：图片 → <Picture N>，视频 → <Video N>，音频 → <Audio N>。
 * 三类全空（或资产都读不到）时返回 null。
 */
export async function resolveSlotMedia(
  project: DirectorProject,
  segment: DirectorSegment,
): Promise<ResolvedMedia | null> {
  const effSlots = effectiveSlots(project, segment);
  if (!effSlots.length) return null;
  const items = useAssets.getState().items;
  const images: ResolvedRefs = { orderedAll: [], refs: [], entries: [], snapshot: effSlots };
  const videos: string[] = [];
  const audios: string[] = [];
  for (const slot of effSlots) {
    for (const aid of slot.assetIds) {
      const a = items.find((x) => x.id === aid);
      if (!a) continue;
      let url: string | null = null;
      try {
        url = await assetToDataUrl(a.path, a.mime);
      } catch {
        continue; // 资产文件读不到（被清理/移动）→ 跳过，不阻塞生成
      }
      if (!url) continue;
      if (slot.semantic === "referenceVideo") {
        videos.push(url);
        continue;
      }
      if (slot.semantic === "referenceAudio") {
        audios.push(url);
        continue;
      }
      images.entries.push({ url, assetId: aid, slot });
      images.orderedAll.push(url);
      if (slot.semantic === "firstFrame") {
        if (!images.firstFrame) images.firstFrame = url;
      } else if (slot.semantic === "lastFrame") {
        if (!images.lastFrame) images.lastFrame = url;
      } else {
        images.refs.push(url);
      }
    }
  }
  if (!images.orderedAll.length && !videos.length && !audios.length) return null;
  return { images, videos, audios, snapshot: effSlots };
}

export type PictureCapacityResult = {
  media: ResolvedMedia | null;
  /** 因图片槽不足而未投喂的站位图所提供的文字空间锁 */
  spatialTextNote: string;
  omittedSpatialCount: number;
  /** 被移除站位图在裁剪前对应的正式 Picture 编号，用于清理静态提示词中的旧标签。 */
  omittedPictureNumbers: number[];
};

/** 站位图运行时转文字后，不能让静态 `<Picture N>` 误指向随后补位的桥接帧。 */
export function rewriteOmittedSpatialPictureRefs(prompt: string, pictureNumbers: number[]): string {
  let out = prompt;
  for (const n of [...new Set(pictureNumbers)].sort((a, b) => b - a)) {
    out = out.replace(new RegExp(`<Picture\\s+${n}>`, "gi"), "the text-only spatial plan (runtime layout image omitted)");
  }
  return out;
}

/**
 * 参考图超出配方容量时只优先移除“空间站位规划图”，真实桥接帧与人物/场景外观参考不动。
 * 被移除站位图的英文空间锁继续进入提示词，避免四图工作流在加入桥接帧后既爆槽又丢空间信息。
 */
export function constrainPictureCapacity(media: ResolvedMedia | null, maxPictures?: number): PictureCapacityResult {
  if (!media || !maxPictures || maxPictures < 1 || media.images.entries.length <= maxPictures) {
    return { media, spatialTextNote: "", omittedSpatialCount: 0, omittedPictureNumbers: [] };
  }
  const removableIndexes = media.images.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.slot.referenceRole === "spatialLayout" || entry.slot.semantic === "layoutGuide")
    .map(({ index }) => index);
  const removeCount = Math.min(removableIndexes.length, media.images.entries.length - maxPictures);
  if (!removeCount) return { media, spatialTextNote: "", omittedSpatialCount: 0, omittedPictureNumbers: [] };
  // 后加入的站位图通常位于静态参考末位；从末尾移除，保持其余 Picture 编号稳定。
  const removedIndexes = new Set(removableIndexes.slice(-removeCount));
  const keptEntries = media.images.entries.filter((_, index) => !removedIndexes.has(index));
  const removedEntries = media.images.entries.filter((_, index) => removedIndexes.has(index));
  let pictureNumber = 0;
  const omittedPictureNumbers: number[] = [];
  media.images.entries.forEach((entry, index) => {
    if (entry.slot.semantic === "firstFrame" || entry.slot.semantic === "lastFrame") return;
    pictureNumber++;
    if (removedIndexes.has(index)) omittedPictureNumbers.push(pictureNumber);
  });
  const removedAssetIds = new Set(removedEntries.map((e) => e.assetId));
  const cleanSlots = (slots: DirectorSlotValue[]) =>
    slots
      .map((slot) => ({ ...slot, assetIds: slot.assetIds.filter((id) => !removedAssetIds.has(id)) }))
      .filter((slot) => slot.assetIds.length > 0);
  const items = useAssets.getState().items;
  const locks = removedEntries
    .map((entry) => {
      const asset = items.find((a) => a.id === entry.assetId);
      return asset?.spatialLockEn?.trim() || asset?.spatialLockZh?.trim() || "";
    })
    .filter(Boolean);
  const images: ResolvedRefs = {
    orderedAll: keptEntries.map((e) => e.url),
    refs: keptEntries.filter((e) => e.slot.semantic !== "firstFrame" && e.slot.semantic !== "lastFrame").map((e) => e.url),
    firstFrame: keptEntries.find((e) => e.slot.semantic === "firstFrame")?.url,
    lastFrame: keptEntries.find((e) => e.slot.semantic === "lastFrame")?.url,
    entries: keptEntries,
    snapshot: cleanSlots(media.images.snapshot),
  };
  const snapshot = cleanSlots(media.snapshot);
  const spatialTextNote = locks.length
    ? `Spatial plan converted from ${removeCount} planning guide image${removeCount > 1 ? "s" : ""} because the picture slots are full. Treat this text as geometry only; do not render diagram labels, arrows, icons, borders, or top-down style:\n${locks.join("\n")}`
    : "";
  return {
    media: { ...media, images, snapshot },
    spatialTextNote,
    omittedSpatialCount: removeCount,
    omittedPictureNumbers,
  };
}
