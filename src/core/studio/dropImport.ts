/**
 * 导演台拖拽导入（3.4）— 资源管理器的文件/文件夹直接拖进任意工位即可入链：
 *  - 含 资产提示词.md 的目录 → 资产册导入（图片/视频/音频条目按「使用分段」自动绑参考槽，对白/旁白等另入混音轨）；
 *  - 其它 .md / .txt / .json → 存入剧本库草稿（到剧本库工位「送入项目」完成三态拆分）；
 *  - 图片/视频/音频散文件 → 入资产库；文件名或所在子目录带分段号
 *    （01-xxx / 03_xxx / 第03段 / H3-02 / 分段资产库/01_标题/RefImg2_空间站位图.png）的自动绑到对应分段参考槽。
 * 应用内部拖拽（画布节点、参考槽 chip）不带外部文件条目，天然不触发。
 */
import { useDirector } from "../stores/directorStore";
import { useAssets } from "../stores/assetStore";
import { useUi } from "../stores/uiStore";
import { uid } from "../utils";
import { importCatalogFromFileList } from "../directorAssetCatalog";
import { importPromptSegments, structuredSplit } from "../directorEngine";
import { createScriptDoc, inspectionSummary, structuredToScenes, matchZhCounterpartDoc, type ScriptInspection } from "../scriptInspect";
import type { ComfySemantic, DirectorAudioKind, DirectorAudioTrack, DirectorSegment } from "../types";

export type DroppedEntry = { file: File; rel: string };

const MEDIA_RE = /\.(png|jpe?g|webp|gif|bmp|mp4|mov|webm|mkv|m4v|mp3|wav|m4a|ogg|flac|aac|opus)$/i;
const SCRIPT_RE = /\.(md|txt|json)$/i;

/** 拖拽条目枚举：优先 webkitGetAsEntry（支持整个文件夹），逐层递归展开相对路径。
 *  注意必须先同步取完 entry/file——拖拽事件结束后 DataTransferItem 会失效。 */
export async function entriesFromDataTransfer(dt: DataTransfer): Promise<DroppedEntry[] | null> {
  if ([...dt.types].some((t) => t.startsWith("momo/"))) return null; // 应用内部拖拽（节点/资产 chip）
  const items = [...(dt.items ?? [])];
  if (!items.some((i) => i.kind === "file") && !dt.files?.length) return null;
  const grabbed = items
    .filter((i) => i.kind === "file")
    .map((i) => ({ entry: i.webkitGetAsEntry?.() ?? null, file: i.getAsFile() }));
  const out: DroppedEntry[] = [];
  const fileOf = (e: FileSystemFileEntry) => new Promise<File | null>((res) => e.file((f) => res(f), () => res(null)));
  const readDir = async (dir: FileSystemDirectoryEntry, base: string): Promise<void> => {
    const reader = dir.createReader();
    for (;;) {
      // readEntries 每批最多返回约 100 条，读到空数组才是目录末尾
      const batch = await new Promise<FileSystemEntry[]>((res) => reader.readEntries((es) => res(es), () => res([])));
      if (!batch.length) break;
      for (const e of batch) {
        if (e.isFile) {
          const f = await fileOf(e as FileSystemFileEntry);
          if (f) out.push({ file: f, rel: base + e.name });
        } else if (e.isDirectory) {
          await readDir(e as FileSystemDirectoryEntry, `${base}${e.name}/`);
        }
      }
    }
  };
  for (const { entry, file } of grabbed) {
    if (entry?.isDirectory) await readDir(entry as FileSystemDirectoryEntry, `${entry.name}/`);
    else if (entry?.isFile) {
      const f = await fileOf(entry as FileSystemFileEntry);
      if (f) out.push({ file: f, rel: entry.name });
    } else if (file) {
      out.push({ file, rel: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name });
    }
  }
  return out.length ? out : null;
}

/** 给拖来的 File 补 webkitRelativePath，直接复用资产册的文件列表导入通道 */
function attachRel(file: File, relPath: string): File {
  try {
    Object.defineProperty(file, "webkitRelativePath", { value: relPath, configurable: true });
  } catch {
    /* 只读属性时静默放弃，回退按文件名匹配 */
  }
  return file;
}

/** 从相对路径推断分段号（故事顺序 1-based）：目录层优先（分段资产库/01_标题/…），文件名兜底 */
function segmentNumberFromRel(relPath: string): number | null {
  const norm = relPath.replace(/\\/g, "/");
  for (const part of norm.split("/").slice(0, -1)) {
    const m = part.match(/^\s*第\s*0*(\d{1,3})\s*段/) ?? part.match(/^\s*0*(\d{1,3})\s*(?:段|集)?[\s_．.、-]/);
    if (m) return Number(m[1]);
  }
  const stem = norm.split("/").pop() ?? "";
  const m = stem.match(/^\s*第\s*0*(\d{1,3})\s*段/) ?? stem.match(/^\s*H3[-_ ]?0*(\d{1,3})/i) ?? stem.match(/^\s*0*(\d{1,3})\s*(?:段|集)?[-_.．\s]/);
  return m ? Number(m[1]) : null;
}

/**
 * 同一分段的同类型素材可能有多稿（用户 1.0 习惯：每段预先做好 首尾帧稿 / 403 稿 / 103 稿）。
 * 稿别序决定入槽顺序——<Video 1> = 首尾帧稿、<Video 2> = 403、<Video 3> = 103，其余按文件名序；
 * 未标稿别的排最后（字母序稳定），保证参考编号不随文件系统顺序漂移。
 */
export function draftRankOf(relPath: string): number {
  const n = relPath.replace(/\\/g, "/");
  if (/首尾帧/.test(n)) return 0;
  if (/(?:^|[^0-9])403(?:[^0-9]|$)/.test(n) || /四百零三|四〇三/.test(n)) return 1;
  if (/(?:^|[^0-9])103(?:[^0-9]|$)/.test(n) || /一百零三|一〇三/.test(n)) return 2;
  return 3;
}

/**
 * 媒体散料 → 参考槽语义（3.5 §4.1：首尾帧也要自动入对应卡槽）：
 *  - 图片名含「首帧/first frame」→ firstFrame、「尾帧/末帧/last frame」→ lastFrame（模板有具名首尾帧入口时精确映射）；
 *  - 「首尾帧」三字（整稿名，如视频的首尾帧稿）不算首帧也不算尾帧——双帧是两个入口，一条资产进哪边都会错；
 *  - 图片名含「站位/空间/layout」→ layoutGuide；其余按类型走 referenceImage/Video/Audio。
 */
export function semanticForMediaRel(relPath: string, kind: "image" | "video" | "audio"): ComfySemantic {
  const n = relPath.replace(/\\/g, "/");
  if (kind === "video") return "referenceVideo";
  if (kind === "audio") return "referenceAudio";
  if (/首尾帧|first.?last/i.test(n)) return "referenceImage"; // 整稿名（多见于视频三稿）不占首/尾帧语义
  if (/首帧|起始帧|first.?frame|start.?frame/i.test(n)) return "firstFrame";
  if (/尾帧|末帧|结束帧|last.?frame|end.?frame/i.test(n)) return "lastFrame";
  if (/站位|空间|layout/i.test(n)) return "layoutGuide";
  return "referenceImage";
}

const AUDIO_KIND_MATCH: Array<[RegExp, DirectorAudioKind]> = [
  [/对白|dialogue/i, "dialogue"],
  [/旁白|narration/i, "narration"],
  [/音效|sfx/i, "sfx"],
  [/音乐|music|bgm/i, "music"],
  [/环境|氛围|ambient/i, "ambient"],
];

export async function importDroppedEntries(projectId: string, list: DroppedEntry[], opts?: { autoSendScripts?: boolean }): Promise<void> {
  const toast = (msg: string, type?: "ok" | "err" | "info") => useUi.getState().toast(msg, type);
  if (!list.length) return;
  const relOf = (e: DroppedEntry) => e.rel.replace(/\\/g, "/");

  // ① 资产册：任一层级的 资产提示词.md 命中 → 整个来源目录走册导入，其余散料不再重复入链
  const manifest = list.find((e) => /(^|\/)资产提示词\.md$/i.test(relOf(e)));
  if (manifest) {
    const base = relOf(manifest).slice(0, relOf(manifest).lastIndexOf("/") + 1);
    const members = list
      .filter((e) => relOf(e).startsWith(base))
      .map((e) => attachRel(e.file, relOf(e).slice(base.length)));
    await importCatalogFromFileList(projectId, members);
    return;
  }

  const cur = useDirector.getState().getById(projectId);
  if (!cur) return;
  const segs = cur.scenes.flatMap((s) => s.segments);
  let imported = 0;
  let failed = 0;
  let bound = 0;
  const newTracks: DirectorAudioTrack[] = [];
  const slotPatch = new Map<string, DirectorSegment["slots"]>();
  const scriptItems: Array<{ body: string; insp: ScriptInspection }> = [];

  // 先剧本后散料，路径即分段依据
  const ordered = [...list].sort((a, b) => relOf(a).localeCompare(relOf(b), "zh-Hans-CN", { numeric: true }));
  for (const e of ordered) {
    const rel = relOf(e);
    if (SCRIPT_RE.test(rel)) {
      try {
        // 自动命名（前言主标题 > 文件名）+ 深解析（时长/模式/引擎/围栏/参考图/对白）在 createScriptDoc 内完成
        const body = await e.file.text();
        const { insp } = createScriptDoc(projectId, rel, body);
        scriptItems.push({ body, insp });
      } catch {
        failed++;
      }
      continue;
    }
    if (!MEDIA_RE.test(rel)) continue;
    const item = await useAssets.getState().importFileGetItem(e.file);
    if (!item) {
      failed++;
      continue;
    }
    imported++;
    useAssets.getState().patchItem(item.id, { director: { projectId, role: item.kind === "audio" ? "audio" : "reference" } });

    const segN = segmentNumberFromRel(rel);
    const target = segN && segN >= 1 && segN <= segs.length ? segs[segN - 1] : undefined;
    if (target) {
      let semantic = semanticForMediaRel(rel, item.kind === "audio" ? "audio" : item.kind === "video" ? "video" : "image");
      const slots = [...(slotPatch.get(target.id) ?? target.slots ?? [])];
      // 首帧/尾帧是单例语义槽（一个入口一张图）：已有图时第二张降级普通参考，不往单例槽里堆
      if ((semantic === "firstFrame" || semantic === "lastFrame") && slots.some((s) => s.semantic === semantic && s.assetIds.length)) {
        semantic = "referenceImage";
      }
      const slot = slots.find((s) => s.semantic === semantic && s.auto === false && !s.catalogId);
      if (slot) {
        // 多稿有序入槽（3.5：首尾帧稿 → Video 1、403 → Video 2、103 → Video 3）：
        // 按稿别序插入，参考编号与 <Video N> 严格一致、不随文件系统顺序漂移
        const rank = draftRankOf(rel);
        const at = slot.assetIds.findIndex((id) => {
          const other = useAssets.getState().items.find((i) => i.id === id);
          return other ? draftRankOf(other.path ?? other.name ?? "") > rank : false;
        });
        if (at >= 0) slot.assetIds.splice(at, 0, item.id);
        else slot.assetIds.push(item.id);
      } else slots.push({ semantic, assetIds: [item.id], auto: false });
      slotPatch.set(target.id, slots);
      bound++;
    }
    // 音频散料按文件名归类混音轨（与资产册同规则）：对白/旁白/音效必须落到具体片段
    if (item.kind === "audio") {
      const kind = AUDIO_KIND_MATCH.find(([re]) => re.test(rel))?.[1];
      const segId = segN && segN >= 1 && segN <= segs.length ? segs[segN - 1]?.id : undefined;
      const bindable = kind === "music" || kind === "ambient" || !!segId;
      if (kind && bindable && !newTracks.some((t) => t.assetId === item.id && t.kind === kind)) {
        newTracks.push({
          id: uid(8),
          kind,
          segmentId: kind === "music" || kind === "ambient" ? undefined : segId,
          text: rel.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "拖入音频",
          assetId: item.id,
        });
      }
    }
  }

  if (slotPatch.size || newTracks.length) {
    const fresh = useDirector.getState().getById(projectId);
    if (fresh) {
      const scenes = slotPatch.size
        ? fresh.scenes.map((scene) => ({ ...scene, segments: scene.segments.map((seg) => (slotPatch.has(seg.id) ? { ...seg, slots: slotPatch.get(seg.id) } : seg)) }))
        : fresh.scenes;
      useDirector.getState().updateProject(projectId, {
        scenes,
        ...(newTracks.length ? { audioTracks: [...(fresh.audioTracks ?? []), ...newTracks] } : {}),
      });
    }
  }

  const parts: string[] = [];
  // 剧本「自动处理」：确定性拆分（提示词包/分段脚本）且项目还没有片段 → 直接送入；完整剧本或已有片段 → 留草稿给剧本库确认
  if (scriptItems.length) {
    for (const { body, insp } of scriptItems) {
      if (!opts?.autoSendScripts) {
        parts.push(`「${insp.title ?? "剧本"}」${inspectionSummary(insp)}——到剧本库「送入项目」完成拆分`);
        continue;
      }
      if (insp.kind === "full") {
        parts.push(`「${insp.title ?? "剧本"}」是完整剧本——到剧本库点「送入项目」由 AI 拆分`);
        continue;
      }
      const curNow = useDirector.getState().getById(projectId);
      if (!curNow) break;
      if (curNow.scenes.length) {
        parts.push(`「${insp.title ?? "剧本"}」${inspectionSummary(insp)}——项目已有片段，到剧本库选「追加拆分 / 替换并重拆」`);
        continue;
      }
      const scenes = insp.kind === "prompts" ? importPromptSegments(body, 12).scenes : structuredToScenes(structuredSplit(body, 12), 12);
      const total = scenes.reduce((n, s) => n + s.segments.reduce((m, g) => m + g.durationSec, 0), 0);
      // 前言统一规格（3.5 §6.4）：第一个分段标记之前识别出的全片规格作为项目级候选
      const { collectSegmentMarks } = await import("../segmentParse");
      const { parseVideoSpecFromSegment } = await import("./videoSpec");
      const marks = collectSegmentMarks(body.trim());
      const prefix = marks.length ? body.slice(0, marks[0]) : body.slice(0, 3000);
      const prefixSpec = parseVideoSpecFromSegment(prefix);
      useDirector.getState().updateProject(projectId, {
        script: body,
        scenes,
        ...(total ? { targetDurationSec: total } : {}),
        ...(Object.keys(prefixSpec.sources ?? {}).length ? { videoSpecFromPrefix: prefixSpec } : {}),
        ...(insp.globalStyle
          ? {
              ruleSet: {
                ...(curNow.ruleSet ?? { name: "全局规则", positive: {}, negative: {}, generation: {} }),
                positive: { ...(curNow.ruleSet?.positive ?? {}), style: insp.globalStyle },
              },
            }
          : {}),
      });
      // 同批拖入的中文对照稿自动配对（3.5）：《X》分段剧本-英 直录时找《X》…中文…稿按稳定键配对进 h3Prompt.zh
      const extras: string[] = [];
      const zhDoc = scriptItems.find(
        (o) => o !== undefined && matchZhCounterpartDoc(insp.title ?? "", [{ id: "x", title: o.insp.title ?? "" }]) !== undefined,
      );
      if (zhDoc && zhDoc.body.trim()) {
        const { pairZhIntoSegments } = await import("./projectWorkspace");
        await pairZhIntoSegments(projectId, zhDoc.body, body);
        extras.push(`中文对照稿「${zhDoc.insp.title}」已配对`);
      }
      parts.push(`「${insp.title ?? "剧本"}」已自动送入项目（${insp.segments.length} 段 · ${total || insp.totalSec || "?"}s${insp.globalStyle ? " · 风格已锚定" : ""}${extras.length ? " · " + extras.join("；") : ""}），到 H3 导演台开始生成`);
    }
  }
  if (imported) parts.push(`素材 ${imported} 项入资产库${bound ? `、自动绑定 ${bound} 处分段参考` : "（文件名未带分段号，只入库不绑定）"}`);
  if (newTracks.length) parts.push(`混音轨 +${newTracks.length}`);
  if (!parts.length) {
    toast("没有可识别的资产：支持资产册目录（含 资产提示词.md）、.md/.txt 剧本、图片/视频/音频文件", "err");
    return;
  }
  toast(`拖入完成：${parts.join("；")}${failed ? `；${failed} 项失败` : ""}`, failed ? "info" : "ok");
}
