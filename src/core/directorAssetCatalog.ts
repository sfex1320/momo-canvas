/**
 * 导演台双语资产册（MOMO_ASSET_CATALOG_V1）解析器。
 *
 * 资产册是项目唯一素材源的可读清单：每项一张真实图片、一份中文提示词、
 * 一份英文提示词，并可声明使用分段。站位图还能携带双语空间锁；图片槽不足时
 * 执行层只丢弃站位图本身，仍保留文字空间约束。
 */

export type DirectorAssetCatalogEntry = {
  id: string;
  name: string;
  file: string;
  type: string;
  /** 媒体类别按扩展名推断：图片/视频/音频条目都能按「使用分段」自动绑参考槽 */
  media: "image" | "video" | "audio";
  role: "appearance" | "spatialLayout";
  /** 全片顺序中的 1-based 分段号；空数组表示只入资产库、不自动绑定 */
  segments: number[];
  /** 所有使用分段共用的静态 Picture 顺序；分段专用顺序优先于它。 */
  referenceOrder?: number;
  /** 少数资产在不同分段占不同槽位时使用：分段号 → 1-based Picture 顺序。 */
  segmentReferenceOrders: Record<number, number>;
  promptZh: string;
  promptEn: string;
  spatialLockZh?: string;
  spatialLockEn?: string;
};

export type DirectorAssetCatalog = {
  version: "MOMO_ASSET_CATALOG_V1";
  entries: DirectorAssetCatalogEntry[];
  warnings: string[];
};

const cleanInline = (v: string) => v.trim().replace(/^`|`$/g, "").trim();

/** Markdown 图片路径只接受资产册目录内的相对路径，防止误读其它项目。 */
export function normalizeCatalogRelativePath(raw: string): string | null {
  let value = cleanInline(raw).replace(/^<|>$/g, "").trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    // 非 URL 编码路径原样继续。
  }
  value = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!value || /^([a-z]:|\/|\\)/i.test(value) || /(^|\/)\.\.(\/|$)/.test(value)) return null;
  return value;
}

/** 媒体类别按扩展名推断；图片是默认兜底（资产册历史条目全是图片） */
export function mediaFromPath(path: string): "image" | "video" | "audio" {
  const ext = (path.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
  if (/^(mp4|mov|webm|mkv|m4v|avi)$/.test(ext)) return "video";
  if (/^(mp3|wav|m4a|ogg|oga|flac|aac|opus)$/.test(ext)) return "audio";
  return "image";
}

function parseSegments(raw: string): number[] {  if (/全部|all/i.test(raw)) return [-1];
  const out = new Set<number>();
  for (const range of raw.matchAll(/(\d{1,3})\s*[-–—~至]\s*(\d{1,3})/g)) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (a > 0 && b >= a && b - a <= 200) for (let n = a; n <= b; n++) out.add(n);
  }
  const withoutRanges = raw.replace(/\d{1,3}\s*[-–—~至]\s*\d{1,3}/g, " ");
  for (const m of withoutRanges.matchAll(/\d{1,3}/g)) {
    const n = Number(m[0]);
    if (n > 0) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 参考顺序支持两种写法：
 * - `2` 或 `全部=2`：所有使用分段均为 Picture 2；
 * - `01=2, 03=4`：按分段单独声明。
 */
function parseReferenceOrder(raw: string): { referenceOrder?: number; segmentReferenceOrders: Record<number, number> } {
  const segmentReferenceOrders: Record<number, number> = {};
  let referenceOrder: number | undefined;
  const pairRe = /(?:第\s*)?(\d{1,3})(?:\s*段)?\s*[:=→]\s*(\d{1,2})/gi;
  for (const m of raw.matchAll(pairRe)) {
    const segment = Number(m[1]);
    const order = Number(m[2]);
    if (segment > 0 && order > 0) segmentReferenceOrders[segment] = order;
  }
  const all = raw.match(/(?:全部|all)\s*[:=→]\s*(\d{1,2})/i);
  if (all && Number(all[1]) > 0) referenceOrder = Number(all[1]);
  if (!Object.keys(segmentReferenceOrders).length && !referenceOrder) {
    const only = raw.trim().match(/^0*(\d{1,2})$/);
    if (only && Number(only[1]) > 0) referenceOrder = Number(only[1]);
  }
  return { referenceOrder, segmentReferenceOrders };
}

/** 没写参考顺序的旧资产册按常用 H3 顺序降级，保证场景不会排到人物后面。 */
function fallbackReferenceOrder(entry: Pick<DirectorAssetCatalogEntry, "type" | "role">): number {
  if (entry.role === "spatialLayout") return 4;
  if (/场景|环境|scene|location|environment/i.test(entry.type)) return 1;
  if (/人物|角色|群像|character|person|subject|team/i.test(entry.type)) return 2;
  if (/道具|物品|装备|武器|prop|item|equipment|weapon/i.test(entry.type)) return 3;
  return 5;
}

/** 返回某分段中该资产应占的 1-based Picture 顺序。 */
export function catalogReferenceOrder(entry: DirectorAssetCatalogEntry, segmentNumber: number): number {
  return entry.segmentReferenceOrders[segmentNumber] ?? entry.referenceOrder ?? fallbackReferenceOrder(entry);
}

function section(body: string, heads: RegExp): string {
  const lines = body.split(/\r?\n/);
  let active = false;
  const out: string[] = [];
  for (const line of lines) {
    const h = line.match(/^###\s+(.+?)\s*$/);
    if (h) {
      if (active) break;
      active = heads.test(h[1].trim());
      continue;
    }
    if (active) out.push(line);
  }
  return out.join("\n").trim();
}

function meta(body: string, labels: string[]): string {
  const alt = labels.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const m = body.match(new RegExp(`^\\s*[-*]\\s*(?:${alt})\\s*[:：]\\s*(.+?)\\s*$`, "im"));
  return cleanInline(m?.[1] ?? "");
}

/**
 * 识别格式：`## ID | 名称` + Markdown 图片（或媒体链接 / `文件:` 元数据）+ 元数据 + 中英文三级标题。
 * 缺媒体路径、缺任一语言提示词的条目不会导入，并以 warning 返回给 UI。
 */
export function parseDirectorAssetCatalog(markdown: string): DirectorAssetCatalog {
  const warnings: string[] = [];
  const version = /MOMO_ASSET_CATALOG_V1/.test(markdown) ? "MOMO_ASSET_CATALOG_V1" : "MOMO_ASSET_CATALOG_V1";
  const marks = [...markdown.matchAll(/^##\s+(.+?)\s*$/gm)];
  const entries: DirectorAssetCatalogEntry[] = [];
  for (let i = 0; i < marks.length; i++) {
    const rawHead = marks[i][1].trim();
    const start = (marks[i].index ?? 0) + marks[i][0].length;
    const end = i + 1 < marks.length ? (marks[i + 1].index ?? markdown.length) : markdown.length;
    const body = markdown.slice(start, end);
    const [rawId, ...nameParts] = rawHead.split(/[|｜]/).map((x) => x.trim());
    const id = rawId || `ASSET-${i + 1}`;
    const name = nameParts.join(" | ") || rawId;
    // 图片用 Markdown 图片语法；视频/音频允许普通链接或 `文件:` 元数据（GPT 批产的对白/桥接片段常这么写）
    const mediaLink = body.match(/[^!]\[[^\]]*\]\(([^)]+\.(?:mp4|mov|webm|mkv|m4v|mp3|wav|m4a|ogg|flac|aac|opus))\)/i)?.[1];
    const image = body.match(/!\[[^\]]*\]\(([^)]+)\)/)?.[1] ?? mediaLink ?? meta(body, ["文件", "File"]);
    const file = normalizeCatalogRelativePath(image ?? "");
    const promptZh = section(body, /^(中文提示词|Chinese Prompt 中文)$/i);
    const promptEn = section(body, /^(英文提示词|English Prompt)$/i);
    if (!file || !promptZh || !promptEn) {
      warnings.push(`${id}「${name}」缺少安全相对媒体路径、中文提示词或英文提示词，已跳过`);
      continue;
    }
    const media = mediaFromPath(file);
    const type = meta(body, ["类型", "Type"]) || (media === "image" ? "图片" : media === "video" ? "视频" : "音频");
    const roleRaw = meta(body, ["用途", "Role"]);
    const role = media === "image" && /站位|空间|layout|spatial/i.test(`${type} ${roleRaw}`) ? "spatialLayout" : "appearance";
    const segmentRaw = meta(body, ["使用分段", "Segments"]);
    const order = parseReferenceOrder(meta(body, ["参考顺序", "槽位顺序", "Reference Order", "Picture Order"]));
    entries.push({
      id,
      name,
      file,
      type,
      media,
      role,
      segments: parseSegments(segmentRaw),
      referenceOrder: order.referenceOrder,
      segmentReferenceOrders: order.segmentReferenceOrders,
      promptZh,
      promptEn,
      spatialLockZh: meta(body, ["中文空间锁", "Spatial Lock ZH"]) || undefined,
      spatialLockEn: meta(body, ["英文空间锁", "Spatial Lock EN"]) || undefined,
    });
  }
  if (!marks.length) warnings.push("没有找到 `## 资产编号 | 资产名称` 条目");
  return { version, entries, warnings };
}

/* ---------------- 资产册导入（从旧分镜页迁入 core，3.0 H3 工位调用） ---------------- */

import { useAssets } from "./stores/assetStore";
import { useDirector } from "./stores/directorStore";
import { useUi } from "./stores/uiStore";
import { isTauri, errMsg, uid } from "./utils";
import type { ComfySemantic, DirectorAudioKind, DirectorAudioTrack, DirectorProject } from "./types";

export type CatalogImportStats = { imported: number; bound: number; layouts: number; failed: number; warnings: number; videos: number; audios: number; tracks: number };

/** 音频条目按「类型/名称」进混音链路的类别映射；对白/旁白/音效必须绑到具体片段才有意义 */
const AUDIO_KIND_MATCH: Array<[RegExp, DirectorAudioKind]> = [
  [/对白|dialogue/i, "dialogue"],
  [/旁白|narration/i, "narration"],
  [/音效|sfx/i, "sfx"],
  [/音乐|music|bgm/i, "music"],
  [/环境|氛围|ambient/i, "ambient"],
];

/** 媒体条目 → 分段参考槽语义：视频走 <Video N>，音频走 <Audio N>，图片维持参考/站位语义 */
function slotSemanticFor(entry: DirectorAssetCatalogEntry): ComfySemantic {
  if (entry.media === "video") return "referenceVideo";
  if (entry.media === "audio") return "referenceAudio";
  // 3.5 §4.1：首帧/尾帧条目进具名单例槽（模板有首尾帧入口时精确映射）；「首尾帧」整稿名不占（双帧是两个入口）
  const n = `${entry.type} ${entry.name}`;
  if (/首尾帧|first.?last/i.test(n)) return "referenceImage";
  if (/首帧|起始帧|first.?frame|start.?frame/i.test(n)) return "firstFrame";
  if (/尾帧|末帧|结束帧|last.?frame|end.?frame/i.test(n)) return "lastFrame";
  return entry.role === "spatialLayout" ? "layoutGuide" : "referenceImage";
}

/**
 * 解析资产册并落库：图片按内容指纹只收录一次，按「使用分段」建立逻辑槽位绑定；
 * 重导按 catalogId 原位同步（先摘本册掌管的旧槽再按册序追加，Picture 编号稳定）。
 * 抛中文错误，由调用方 toast；统计返回供提示文案。
 */
export async function applyAssetCatalogToProject(
  projectId: string,
  markdown: string,
  source: string,
  readFile: (relativePath: string) => Promise<string>,
): Promise<CatalogImportStats> {
  const toast = (msg: string, type?: "ok" | "err" | "info") => useUi.getState().toast(msg, type);
  const parsed = parseDirectorAssetCatalog(markdown);
  if (!parsed.entries.length) throw new Error(parsed.warnings[0] ?? "资产册没有可导入条目");
  const project0 = useDirector.getState().getById(projectId);
  if (!project0) throw new Error("项目不存在");

  const imported: Array<{ entry: (typeof parsed.entries)[number]; assetId: string }> = [];
  const failed: string[] = [];
  for (const entry of parsed.entries) {
    try {
      const dataUrl = await readFile(entry.file);
      const asset = await useAssets.getState().collect({
        src: dataUrl,
        kind: entry.media,
        name: entry.name,
        prompt: entry.promptEn || entry.promptZh,
        promptZh: entry.promptZh,
        promptEn: entry.promptEn,
        catalogId: entry.id,
        catalogSource: source,
        catalogRole: entry.role,
        // 记录「使用分段」：剧本替换重拆后片段 id 全新，参考槽靠它把资产重新绑回（rebindCatalogSlots）
        catalogSegments: entry.segments,
        spatialLockZh: entry.spatialLockZh,
        spatialLockEn: entry.spatialLockEn,
        director: { projectId, role: "reference" },
      });
      if (asset) imported.push({ entry, assetId: asset.id });
      else failed.push(entry.id);
    } catch {
      failed.push(entry.id);
    }
  }
  if (!imported.length) throw new Error("资产册媒体均读取失败，请确认 MD 里的媒体路径相对资产册目录填写");

  const cur = useDirector.getState().getById(projectId) ?? project0;
  const segs = cur.scenes.flatMap((s) => s.segments);
  const segIndex = new Map(segs.map((s, i) => [s.id, i + 1]));
  const importedIds = new Set(imported.map((x) => x.assetId));
  const importedCatalogIds = new Set(imported.map((x) => x.entry.id));
  const scenes = cur.scenes.map((scene) => ({
    ...scene,
    segments: scene.segments.map((segment) => {
      const n = segIndex.get(segment.id) ?? 0;
      const binds = imported
        .filter(({ entry }) => entry.segments.includes(-1) || entry.segments.includes(n))
        .map((item, catalogIndex) => ({ ...item, catalogIndex }))
        .sort((a, b) => catalogReferenceOrder(a.entry, n) - catalogReferenceOrder(b.entry, n) || a.catalogIndex - b.catalogIndex);
      const kept = (segment.slots ?? [])
        .filter((slot) => !slot.catalogId || !importedCatalogIds.has(slot.catalogId))
        .map((slot) => ({ ...slot, assetIds: slot.assetIds.filter((id) => !importedIds.has(id)) }))
        .filter((slot) => slot.assetIds.length > 0);
      // 首帧/尾帧是单例语义槽：同段多条首帧（尾帧）条目只取第一条，其余降级普通参考
      const seenSingleton = new Set<string>();
      const catalogSlots = binds.map(({ entry, assetId }) => {
        let semantic = slotSemanticFor(entry);
        if ((semantic === "firstFrame" || semantic === "lastFrame") && seenSingleton.has(semantic)) semantic = "referenceImage";
        else if (semantic === "firstFrame" || semantic === "lastFrame") seenSingleton.add(semantic);
        return {
          semantic,
          assetIds: [assetId],
          auto: false,
          label: entry.role === "spatialLayout" && entry.media === "image" ? `${entry.name}（空间站位）` : entry.name,
          referenceRole: entry.media === "image" ? entry.role : undefined,
          catalogId: entry.id,
        };
      });
      return { ...segment, slots: [...kept, ...catalogSlots] };
    }),
  }));
  // 音频资产双通道：<Audio N> 参考槽照建；对白/旁白/音乐/音效/环境再按「类型」补一条混音轨（字幕「从对白生成」取词也靠它）
  const latest = useDirector.getState().getById(projectId);
  const newTracks: DirectorAudioTrack[] = [];
  for (const { entry, assetId } of imported) {
    if (entry.media !== "audio") continue;
    const kind = AUDIO_KIND_MATCH.find(([re]) => re.test(`${entry.type} ${entry.name}`))?.[1];
    if (!kind) continue;
    if ((latest?.audioTracks ?? []).some((t) => t.assetId === assetId && t.kind === kind)) continue;
    const segN = entry.segments.find((n) => n > 0 && n <= segs.length);
    const segId = segN ? segs[segN - 1]?.id : undefined;
    if ((kind === "dialogue" || kind === "narration" || kind === "sfx") && !segId) continue;
    newTracks.push({
      id: uid(8),
      kind,
      segmentId: kind === "music" || kind === "ambient" ? undefined : segId,
      text: entry.promptZh || entry.name,
      assetId,
    });
  }
  useDirector.getState().updateProject(projectId, {
    scenes,
    ...(newTracks.length ? { audioTracks: [...(latest?.audioTracks ?? []), ...newTracks] } : {}),
    assetCatalogSource: source,
    assetCatalogImportedAt: Date.now(),
  });

  // 人物条目自动进角色库（3.5）：类型/名称含 人物|角色|character 的外观条目 → DirectorCharacter
  //（continuity 用英文提示词优先——它是模型请求真相；同名角色不重复创建，已有角色只补参考图）
  const charEntries = imported.filter(({ entry }) => entry.role === "appearance" && /人物|角色|character/i.test(`${entry.type} ${entry.name}`));
  if (charEntries.length) {
    const withChars = useDirector.getState().getById(projectId) ?? project0;
    const chars = (withChars.characters ?? []).map((c) => ({ ...c }));
    let added = 0;
    for (const { entry, assetId } of charEntries) {
      const exist = chars.find((c) => c.name === entry.name);
      if (exist) {
        if (!exist.assetIds?.includes(assetId)) exist.assetIds = [...(exist.assetIds ?? []), assetId];
        continue;
      }
      chars.push({ id: uid(8), name: entry.name, continuity: entry.promptEn || entry.promptZh || entry.name, assetIds: [assetId] });
      added++;
    }
    if (added || chars.length !== (withChars.characters ?? []).length) {
      useDirector.getState().updateProject(projectId, { characters: chars });
      toast(`已从资产册创建/更新 ${charEntries.length} 个角色档案（角色库可查看）`, "ok");
    }
  }

  const stats: CatalogImportStats = {
    imported: imported.length,
    bound: imported.filter((x) => x.entry.segments.length > 0).length,
    layouts: imported.filter((x) => x.entry.media === "image" && x.entry.role === "spatialLayout").length,
    videos: imported.filter((x) => x.entry.media === "video").length,
    audios: imported.filter((x) => x.entry.media === "audio").length,
    tracks: newTracks.length,
    failed: failed.length,
    warnings: parsed.warnings.length,
  };
  toast(
    `资产册已导入 ${stats.imported} 项并绑定 ${stats.bound} 项（图 ${stats.imported - stats.videos - stats.audios} / 视频 ${stats.videos} / 音频 ${stats.audios}；站位图 ${stats.layouts}；混音轨 +${stats.tracks}）` +
      `${stats.failed ? `；${stats.failed} 项媒体读取失败` : ""}` +
      `${stats.warnings ? `；${stats.warnings} 条格式提醒` : ""}`,
    stats.failed ? "info" : "ok",
  );
  return stats;
}

/** 浏览器预览降级：从 webkitdirectory 文件列表读取资产册及其相对图片 */
export async function importCatalogFromFileList(projectId: string, files: FileList | File[]): Promise<void> {
  const toast = (msg: string, type?: "ok" | "err" | "info") => useUi.getState().toast(msg, type);
  const list = Array.from(files);
  const relOf = (f: File) => ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).replace(/\\/g, "/");
  const manifest = list.find((f) => /(^|\/)资产提示词\.md$/i.test(relOf(f)));
  if (!manifest) {
    toast("所选目录中没有找到 资产提示词.md", "err");
    return;
  }
  const manifestRel = relOf(manifest);
  const base = manifestRel.slice(0, manifestRel.lastIndexOf("/") + 1);
  const byRel = new Map(list.map((f) => [relOf(f), f]));
  try {
    await applyAssetCatalogToProject(projectId, await manifest.text(), manifestRel, async (rel) => {
      const f = byRel.get(`${base}${rel}`);
      if (!f) throw new Error(`缺少图片 ${rel}`);
      return await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error(`读取图片失败 ${rel}`));
        fr.readAsDataURL(f);
      });
    });
  } catch (e) {
    toast(`资产册导入失败：${errMsg(e)}`, "err");
  }
}

/**
 * 桌面端原生目录导入：选择「全部素材」文件夹或项目根目录，自动寻找唯一资产册
 * （资产提示词.md 或 全部素材/资产提示词.md）。浏览器环境返回 false 让 UI 走文件列表降级。
 */
export async function importCatalogFromDirectory(projectId: string): Promise<boolean> {
  if (!isTauri) return false;
  const toast = (msg: string, type?: "ok" | "err" | "info") => useUi.getState().toast(msg, type);
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false, title: "选择全部素材文件夹（或项目根目录）" });
    if (!selected || typeof selected !== "string") return true; // 用户取消，视为已处理
    const { exists, readFile, readTextFile } = await import("@tauri-apps/plugin-fs");
    const join = (a: string, b: string) => `${a.replace(/[\\/]+$/, "")}/${b.replace(/^[\\/]+/, "")}`;
    const direct = join(selected, "资产提示词.md");
    const nested = join(selected, "全部素材/资产提示词.md");
    const manifestPath = (await exists(direct)) ? direct : (await exists(nested)) ? nested : "";
    if (!manifestPath) {
      toast("所选目录中没有找到 资产提示词.md 或 全部素材/资产提示词.md", "err");
      return true;
    }
    const base = manifestPath.slice(0, manifestPath.lastIndexOf("/") + 1);
    const MIME: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp",
      mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", m4v: "video/mp4",
      mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac", aac: "audio/aac",
    };
    await applyAssetCatalogToProject(projectId, await readTextFile(manifestPath), manifestPath, async (rel) => {
      const path = join(base, rel);
      const ext = (rel.match(/\.([^.]+)$/)?.[1] ?? "png").toLowerCase();
      const buf = await readFile(path);
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return `data:${MIME[ext] ?? "application/octet-stream"};base64,${btoa(bin)}`;
    });
    return true;
  } catch (e) {
    toast(`读取资产册失败：${errMsg(e)}`, "err");
    return true;
  }
}

/** 项目当前资产册来源提示（重导对账用） */
export function catalogSourceNote(project: DirectorProject): string | null {
  if (!project.assetCatalogSource) return null;
  return `${project.assetCatalogSource}${project.assetCatalogImportedAt ? ` · ${new Date(project.assetCatalogImportedAt).toLocaleString()}` : ""}`;
}

/**
 * 剧本重拆后的资产册参考槽重绑（3.5：剧本库「替换并重拆」路径）。
 *
 * 替换 scenes 后片段 id 全新，旧片段上的资产册槽（catalogId）随片段一起消失——
 * 资产还在库里（带 catalogId + catalogSegments「使用分段」），按分段序号把资产重新绑到新片段槽。
 * 同步规则：目标片段已有同 catalogId 的槽不重复；与资产册导入同款语义（-1 = 全部片段、auto:false、
 * 站位图走 layoutGuide）。返回重绑的资产数（供 toast）。
 */
export function rebindCatalogSlots(projectId: string): number {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return 0;
  const items = useAssets.getState().items.filter((i) => i.catalogId && !i.deletedAt);
  if (!items.length) return 0;
  let n = 0;
  const scenes = proj.scenes.map((scene) => ({
    ...scene,
    segments: scene.segments.map((segment) => {
      // 片段序号 = 故事顺序（与 applyAssetCatalogToProject 的 segIndex 同一语义）
      const flat = proj.scenes.flatMap((s) => s.segments);
      const order = flat.findIndex((s) => s.id === segment.id) + 1;
      const binds = items.filter((i) => {
        const segs = i.catalogSegments ?? [];
        return segs.includes(-1) || segs.includes(order);
      });
      if (!binds.length) return segment;
      const have = new Set((segment.slots ?? []).map((s) => s.catalogId).filter(Boolean));
      const fresh = binds
        .filter((i) => !have.has(i.catalogId!))
        .map((i) => ({
          semantic: (i.kind === "video" ? "referenceVideo" : i.kind === "audio" ? "referenceAudio" : i.catalogRole === "spatialLayout" ? "layoutGuide" : "referenceImage") as ComfySemantic,
          assetIds: [i.id],
          auto: false,
          label: i.catalogRole === "spatialLayout" && i.kind === "image" ? `${i.name}（空间站位）` : i.name,
          referenceRole: i.kind === "image" ? i.catalogRole : undefined,
          catalogId: i.catalogId,
        }));
      if (!fresh.length) return segment;
      n += fresh.length;
      return { ...segment, slots: [...(segment.slots ?? []), ...fresh] };
    }),
  }));
  if (n) useDirector.getState().updateProject(projectId, { scenes });
  return n;
}
