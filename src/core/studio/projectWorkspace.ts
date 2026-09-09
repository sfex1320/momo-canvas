/**
 * 项目文件夹绑定（3.5 P2 · 方案 §3）——「锁定」= 路径 + 指纹 + 状态，不是 OS 排他锁。
 *
 * 绑定目录后（绑定即导入）：
 *  - 确定性扫描（§3.4 顺序）→ 预演确认（含与已有片段的冲突预演，写入前展示）→ 写 .momo/project.json manifest；
 *  - 英文分段直录进项目（importPromptSegments）、中文稿按稳定键配对进 h3Prompt.zh、完整剧本入剧本库、
 *    资产册按「使用分段」绑定参考槽——全部走 applyBindImport，幂等（内容指纹没变就跳过对应步骤）；
 *  - Take 等产物按 projectAssetRouter 写入项目目录（见 projectAssetRouter.ts）。
 * 未绑定时保持 AppData 托管，UI 明示「托管项目」。
 *
 * fs 通过 WorkspaceFs 注入（默认 Tauri plugin-fs；集成测试注入 node:fs 实现，可跑真实临时目录）。
 */
import { useDirector } from "../stores/directorStore";
import { useUi } from "../stores/uiStore";
import { isTauri, errMsg } from "../utils";
import { collectSegmentMarks } from "../segmentParse.ts";
import { pairBilingualDocs } from "./h3BilingualCore.ts";
import { parseVideoSpecFromSegment } from "./videoSpec";
import type { DirectorProject } from "../types";

const join = (a: string, b: string) => `${a.replace(/[\\/]+$/, "")}/${b.replace(/^[\\/]+/, "")}`;

/** 文件系统原语（Tauri plugin-fs 形状；node:fs 可包装成同形注入） */
export type WorkspaceFs = {
  readTextFile: (path: string) => Promise<string>;
  exists: (path: string) => Promise<boolean>;
  readDir: (path: string) => Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean }>>;
  writeFile: (path: string, data: Uint8Array) => Promise<void>;
  mkdir: (path: string, opts?: { recursive?: boolean }) => Promise<void>;
  readFile: (path: string) => Promise<Uint8Array>;
  remove: (path: string) => Promise<void>;
};

/** 默认 fs = Tauri plugin-fs（动态 import，浏览器/测试环境不加载） */
async function tauriFs(): Promise<WorkspaceFs> {
  const fs = await import("@tauri-apps/plugin-fs");
  return {
    readTextFile: (p) => fs.readTextFile(p),
    exists: (p) => fs.exists(p),
    readDir: async (p) => {
      const entries = await fs.readDir(p);
      return entries.map((e) => ({ name: e.name, isDirectory: !!e.isDirectory, isFile: !!e.isFile }));
    },
    writeFile: (p, d) => fs.writeFile(p, d),
    mkdir: (p, o) => fs.mkdir(p, o),
    readFile: (p) => fs.readFile(p),
    remove: (p) => fs.remove(p),
  };
}

/** 文本内容指纹（FNV-1a 32bit hex）：绑定导入幂等的依据——内容没变不重复导入 */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0") + `_${text.length.toString(36)}`;
}

export type FolderScan = {
  rootPath: string;
  /** .momo/project.json 已存在（重复绑定检测） */
  manifestProjectId?: string;
  fullScript?: string;
  segZh?: string;
  segEn?: string;
  /** 资产册相对路径（相对 rootPath，如 "资产提示词.md" / "全部素材/资产提示词.md"）——绝不存 Markdown 内容 */
  assetCatalogPath?: string;
  /** 资产册内容缓存（apply 免二次读盘；可缺省） */
  assetCatalogText?: string;
  segmentDirs: string[];
  mediaCount: number;
  summary: string;
};

/** 确定性扫描（§3.4 顺序：manifest → 完整剧本 → 双语分段 → 资产册 → 分段目录 → 媒体计数）。Rust 只给原语，业务分类在这里。 */
export async function scanProjectFolder(rootPath: string, fsIn?: WorkspaceFs): Promise<FolderScan> {
  const fs = fsIn ?? (await tauriFs());
  const out: FolderScan = { rootPath, segmentDirs: [], mediaCount: 0, summary: "" };
  // ① manifest：已有 MOMO 项目
  const manifestPath = join(rootPath, ".momo/project.json");
  if (await fs.exists(manifestPath)) {
    try {
      out.manifestProjectId = (JSON.parse(await fs.readTextFile(manifestPath)) as { projectId?: string }).projectId;
    } catch {
      /* manifest 损坏按未绑定处理 */
    }
  }
  // ②~④ 主剧本 / 双语分段对 / 资产册（资产册只记路径；内容另存缓存字段，两者绝不混用）
  const tryRead = async (p: string) => ((await fs.exists(p)) ? await fs.readTextFile(p) : undefined);
  out.fullScript = await tryRead(join(rootPath, "完整剧本.md"));
  out.segZh = await tryRead(join(rootPath, "分段剧本-中.md"));
  out.segEn = await tryRead(join(rootPath, "分段剧本-英.md"));
  for (const rel of ["资产提示词.md", "全部素材/资产提示词.md"]) {
    const abs = join(rootPath, rel);
    if (await fs.exists(abs)) {
      out.assetCatalogPath = rel;
      out.assetCatalogText = await fs.readTextFile(abs);
      break;
    }
  }
  // ⑤ 分段资产库目录
  const segRoot = join(rootPath, "分段资产库");
  if (await fs.exists(segRoot)) {
    for (const e of await fs.readDir(segRoot)) {
      if (e.isDirectory && /^\d{1,3}/.test(e.name)) out.segmentDirs.push(e.name);
    }
  }
  // ⑥ 媒体计数（全部素材 + 分段资产库下的图片/视频/音频）
  const countMedia = async (dir: string): Promise<number> => {
    if (!(await fs.exists(dir))) return 0;
    let n = 0;
    for (const e of await fs.readDir(dir)) {
      if (e.isFile && /\.(png|jpe?g|webp|gif|mp4|mov|webm|mkv|mp3|wav|m4a|flac)$/i.test(e.name)) n++;
      else if (e.isDirectory) n += await countMedia(join(dir, e.name));
    }
    return n;
  };
  out.mediaCount = (await countMedia(join(rootPath, "全部素材"))) + (await countMedia(segRoot));
  const bits: string[] = [];
  if (out.fullScript) bits.push("完整剧本");
  if (out.segZh) bits.push("分段剧本-中");
  if (out.segEn) bits.push("分段剧本-英");
  if (out.assetCatalogPath) bits.push(out.assetCatalogPath);
  if (out.segmentDirs.length) bits.push(`${out.segmentDirs.length} 个分段目录`);
  if (out.mediaCount) bits.push(`${out.mediaCount} 个媒体文件`);
  out.summary = bits.length ? bits.join(" · ") : "未识别到任何 MOMO/H3 项目结构（可绑定空目录，产物仍会按目录规范落盘）";
  return out;
}

/** 绑定导入模式：merge = 保留已有片段（只补剧本库/资产册/留档）；overwrite = 英文分段整包替换（破坏性，需确认） */
export type BindImportMode = "auto" | "merge" | "overwrite";

/** 冲突预演（写入前展示，绝不写完才 toast） */
export type BindConflict = {
  /** 项目已有片段数 */
  existing: number;
  /** 本次扫描将导入的英文分段数 */
  incoming: number;
  notes: string[];
};

/** 扫描结果 + 项目现状 → 冲突预演（纯函数，测试直测）。undefined = 无冲突（空项目可直接导入）。
 *  中英分段之间的视频规格冲突也在这里检出（写入之前展示，不写完才 toast；英文执行稿是请求真相）。 */
export function planBindConflict(scan: FolderScan, project: DirectorProject): BindConflict | undefined {
  const existing = project.scenes.reduce((n, sc) => n + sc.segments.length, 0);
  const specClashes = scan.segZh && scan.segEn ? specClashesOf(scan.segZh, scan.segEn) : [];
  if (!scan.segEn || existing === 0) {
    if (!specClashes.length) return undefined;
    // 空项目但双语规格有冲突：仍给预演提示（可导入，但先把差异亮出来）
    return { existing: 0, incoming: countSegmentParts(scan.segEn!), notes: specClashes };
  }
  const incoming = countSegmentParts(scan.segEn);
  const notes = [
    `项目已有 ${existing} 个片段，目录识别到 ${incoming} 个英文分段`,
    "覆盖导入会用目录内容替换全部片段（已有 Take 与手改将丢失）；合并导入保留现有片段，只补剧本库与资产册",
    ...specClashes,
  ];
  if (scan.segZh) notes.push("中文审阅稿配对只在覆盖导入时执行（合并导入不动现有片段的双语稿）");
  return { existing, incoming, notes };
}

/** 中英文分段的视频规格逐段比对（分辨率/帧率/时长）——冲突列表进预演 */
function specClashesOf(zhDoc: string, enDoc: string): string[] {
  const { pairs } = pairBilingualDocs(zhDoc, enDoc);
  const out: string[] = [];
  let n = 0;
  // 标题行的规格（H3-01｜标题｜12秒｜1080p）必须以 titleLine 语义解析，否则时长/分辨率认不出
  const titleLineOf = (body: string) => body.split("\n").find((l) => l.trim()) ?? undefined;
  for (const p of pairs) {
    if (!p.zh || !p.en) continue;
    const zs = parseVideoSpecFromSegment(p.zh, titleLineOf(p.zh));
    const es = parseVideoSpecFromSegment(p.en, titleLineOf(p.en));
    const fields: Array<["resolution" | "fps" | "durationSec", string]> = [["resolution", "分辨率"], ["fps", "帧率"], ["durationSec", "时长"]];
    for (const [k, label] of fields) {
      const zv = zs[k];
      const ev = es[k];
      if (zv === undefined || ev === undefined) continue;
      const z2 = k === "resolution" ? (zv as { label: string }).label : zv;
      const e2 = k === "resolution" ? (ev as { label: string }).label : ev;
      if (String(z2) !== String(e2)) {
        out.push(`段 ${p.index} ${label}：中 ${String(z2)} / 英 ${String(e2)}（按英文执行稿执行）`);
        n++;
      }
    }
  }
  return out.slice(0, 6);
}

/** 数英文分段文档的段数（collectSegmentMarks 同源逻辑；0 = 无段） */
function countSegmentParts(doc: string): number {
  return collectSegmentMarks(doc.trim()).length;
}

/**
 * 应用绑定导入（幂等核心，fs 可注入）：
 *  ① 写 manifest 与 workspace（含导入指纹）；
 *  ② 完整剧本 → 剧本库草稿（内容指纹没变跳过）；
 *  ③ 英文分段 → 项目片段（空项目/auto 直录；冲突时 merge 保留现有片段、overwrite 整包替换），
 *     中文稿按稳定键配对进 h3Prompt.zh（对白/时长冲突标记，不静默 synced）；
 *  ④ 资产册 → 参考槽（rootPath 已知免二次选目录）。
 * 返回给 UI 的导入摘要（notes）。
 */
export async function applyBindImport(
  projectId: string,
  dir: string,
  scan: FolderScan,
  mode: BindImportMode,
  fsIn?: WorkspaceFs,
): Promise<string[]> {
  const fs = fsIn ?? (await tauriFs());
  const { writeFile, mkdir } = fs;
  const manifestDir = join(dir, ".momo");
  await mkdir(manifestDir, { recursive: true }).catch(() => undefined);
  const proj0 = useDirector.getState().getById(projectId);
  const manifest = {
    schema: "MOMO_PROJECT_MANIFEST_V1",
    projectId,
    name: proj0?.name ?? "",
    boundAt: Date.now(),
  };
  await writeFile(join(manifestDir, "project.json"), new TextEncoder().encode(JSON.stringify(manifest, null, 2)));

  // 导入指纹：重复绑定同一目录时内容没变的步骤直接跳过（幂等——不重复建片段/剧本文档）
  const before = useDirector.getState().getById(projectId);
  const prevImported = before?.workspace?.imported;
  const hashes = {
    fullScriptHash: scan.fullScript ? hashText(scan.fullScript) : undefined,
    segEnHash: scan.segEn ? hashText(scan.segEn) : undefined,
    segZhHash: scan.segZh ? hashText(scan.segZh) : undefined,
    assetCatalogHash: scan.assetCatalogText ? hashText(scan.assetCatalogText) : undefined,
  };
  const sameAs = (k: keyof typeof hashes) => hashes[k] !== undefined && prevImported?.[k] === hashes[k];
  // 分段步骤是否真正执行（导入或留档）由 mode 决定：merge 没导入分段就**不记** segEn/segZh 指纹——
  // 否则后续 overwrite 会被误判「内容没变」跳过（merge 后想覆盖导不进去的 bug）
  const existingBefore = (before?.scenes ?? []).reduce((n, sc) => n + sc.segments.length, 0);
  const segStepRuns = !!scan.segEn && !sameAs("segEnHash") && (existingBefore === 0 || mode !== "merge");
  const newImported: NonNullable<DirectorProject["workspace"]>["imported"] = {
    ...(prevImported ?? {}),
    ...(hashes.fullScriptHash && !sameAs("fullScriptHash") ? { fullScriptHash: hashes.fullScriptHash } : {}),
    ...(segStepRuns ? { segEnHash: hashes.segEnHash, segZhHash: hashes.segZhHash } : {}),
    ...(hashes.assetCatalogHash && !sameAs("assetCatalogHash") ? { assetCatalogHash: hashes.assetCatalogHash } : {}),
    at: Date.now(),
  };

  useDirector.getState().updateProject(projectId, {
    workspace: {
      mode: "linked",
      rootPath: dir,
      manifestPath: manifestDir,
      ...(scan.assetCatalogPath ? { assetCatalogPath: scan.assetCatalogPath } : {}),
      ...(scan.segmentDirs.length ? { segmentRootPath: join(dir, "分段资产库") } : {}),
      lastIndexedAt: Date.now(),
      status: "ready",
      writePolicy: "copy-into-project",
      imported: newImported,
    },
  });

  const notes: string[] = [];

  // ① 完整剧本 → 剧本库草稿（幂等：指纹没变不重复建文档）
  if (scan.fullScript && !sameAs("fullScriptHash")) {
    const { createScriptDoc } = await import("../scriptInspect");
    createScriptDoc(projectId, "完整剧本.md", scan.fullScript);
    notes.push("完整剧本入剧本库");
  }

  // ② 双语分段：英文执行稿直录成片段，中文稿按稳定键配对进 h3Prompt.zh（§4.4）
  if (scan.segEn && !sameAs("segEnHash")) {
    const existing = useDirector.getState().getById(projectId)!.scenes.reduce((n, sc) => n + sc.segments.length, 0);
    const wantImport = existing === 0 || mode === "overwrite";
    if (wantImport) {
      const { importPromptSegments } = await import("../directorEngine");
      const r = importPromptSegments(scan.segEn, 12);
      // 3.5 §6.4：前言（第一个分段标记之前）识别出的全片统一规格作为项目级候选（分段识别值优先于它）
      const marks = collectSegmentMarks(scan.segEn.trim());
      const prefix = marks.length ? scan.segEn.slice(0, marks[0]) : scan.segEn.slice(0, 3000);
      const prefixSpec = parseVideoSpecFromSegment(prefix);
      // 真正写进项目（此前只算不写是绑定即导入失效的根因）：
      // overwrite 保留项目级字段（recipes/characters/audioTracks 等），只替换 scenes 与风格锚定
      const cur = useDirector.getState().getById(projectId)!;
      useDirector.getState().updateProject(projectId, {
        scenes: r.scenes,
        ...(Object.keys(prefixSpec.sources ?? {}).length ? { videoSpecFromPrefix: prefixSpec } : {}),
        ...(r.globalStyle ? { ruleSet: { ...(cur.ruleSet ?? { name: "默认", positive: {}, negative: {}, generation: {} }), positive: { ...(cur.ruleSet?.positive ?? {}), style: r.globalStyle } } } : {}),
      });
      notes.push(`英文分段直录 ${r.scenes[0]?.segments.length ?? 0} 段${existing > 0 ? "（覆盖导入）" : ""}`);
      // 中文稿配对（键配对：中间缺段不错位；配对差异标记 syncStatus，不静默 synced）
      if (scan.segZh) {
        await pairZhIntoSegments(projectId, scan.segZh, scan.segEn);
      }
    } else if (existing > 0) {
      // merge：保留现有片段，只做留档（不配对——不动现有片段的双语稿）
      notes.push(`保留现有 ${existing} 个片段（合并导入）`);
    }
  } else if (scan.segEn && sameAs("segEnHash")) {
    notes.push("英文分段内容未变化，跳过重复导入");
  }

  // ③ 项目剧本留档（双语汇总入剧本库；与分段步骤共用 segStepRuns 幂等闸门——merge 未执行分段时不留档不记指纹）
  const { createScriptDoc: mkDoc } = await import("../scriptInspect");
  if (segStepRuns && scan.segEn) mkDoc(projectId, "分段剧本-英.md", scan.segEn);
  if (segStepRuns && scan.segZh) mkDoc(projectId, "分段剧本-中.md", scan.segZh);

  // ④ 资产册：图片/视频/音频按「使用分段」绑定参考槽（复用资产册导入器，rootPath 已知免二次选目录）
  if (scan.assetCatalogPath && scan.assetCatalogText !== undefined && !sameAs("assetCatalogHash")) {
    const { applyAssetCatalogToProject } = await import("../directorAssetCatalog");
    const catalogRel = scan.assetCatalogPath;
    const base = catalogRel.slice(0, catalogRel.lastIndexOf("/") + 1);
    const MIME: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
      mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
      mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac", aac: "audio/aac",
    };
    const markdown = scan.assetCatalogText;
    try {
      await applyAssetCatalogToProject(projectId, markdown, catalogRel, async (rel) => {
        const path = join(join(dir, base), rel);
        const ext = (rel.match(/\.([^.]+)$/)?.[1] ?? "bin").toLowerCase();
        const buf = await fs.readFile(path);
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return `data:${MIME[ext] ?? "application/octet-stream"};base64,${btoa(bin)}`;
      });
      notes.push("资产册已绑定参考槽");
    } catch (e) {
      notes.push(`资产册导入失败：${errMsg(e)}`);
    }
  } else if (scan.assetCatalogPath && sameAs("assetCatalogHash")) {
    notes.push("资产册内容未变化，跳过重复导入");
  }
  return notes;
}

/** 中文稿按稳定键配对进项目片段（键配对修复：中间缺段不会让后续错位；冲突标 conflict 不静默 synced）。
 *  剧本库「替换并重拆」送入路径与文件夹绑定路径共用。 */
export async function pairZhIntoSegments(projectId: string, zhDoc: string, enDoc: string): Promise<void> {
  const { pairBilingualDocs } = await import("./h3BilingualCore");
  const { parseH3PromptBody } = await import("./h3BilingualCore");
  const { parseVideoSpecFromSegment } = await import("./videoSpec");
  const { useUi: ui } = await import("../stores/uiStore");
  const { pairs, warnings } = pairBilingualDocs(zhDoc, enDoc);
  const cur = useDirector.getState().getById(projectId);
  if (!cur) return;
  const specConflicts: string[] = [];
  const scenes = cur.scenes.map((sc) => ({
    ...sc,
    segments: sc.segments.map((sg, idx) => {
      const pair = pairs[idx];
      if (!pair?.zh || !sg.h3Prompt) return sg;
      const zh = parseH3PromptBody(pair.zh, sg.summary);
      // §6.3：中英文分段规格冲突进入预演提示，不静默选择（英文执行稿是请求真相，以英文为准）
      if (pair.en) {
        const titleLine = (body: string) => body.split("\n").find((l) => l.trim()) ?? undefined;
        const zs = parseVideoSpecFromSegment(pair.zh, titleLine(pair.zh));
        const es = sg.videoSpec ?? parseVideoSpecFromSegment(pair.en, titleLine(pair.en));
        const clash = (k: "resolution" | "fps" | "durationSec") => {
          const zv = zs[k];
          const ev = es[k];
          if (zv === undefined || ev === undefined) return;
          const zs2 = k === "resolution" ? (zv as { label: string }).label : zv;
          const es2 = k === "resolution" ? (ev as { label: string }).label : ev;
          if (String(zs2) !== String(es2)) specConflicts.push(`段${idx + 1} ${k === "resolution" ? "分辨率" : k === "fps" ? "帧率" : "时长"}：中 ${String(zs2)} / 英 ${String(es2)}（按英文执行）`);
        };
        clash("resolution");
        clash("fps");
        clash("durationSec");
      }
      // 配对有差异（时长/对白/缺段）→ conflict 待人工核对；干净配对才 synced
      const syncStatus = pair.warnings.length ? ("conflict" as const) : ("synced" as const);
      return {
        ...sg,
        h3Prompt: { ...sg.h3Prompt, zh, syncStatus },
        // 中文标题对中文用户更友好；时长冲突以英文执行稿为准（它是请求真相）
        summary: pair.title || sg.summary,
      };
    }),
  }));
  useDirector.getState().updateProject(projectId, { scenes });
  const pairWarn = pairs.filter((p) => p.warnings.length).length + warnings.length;
  if (pairWarn) ui.getState().toast?.(`双语配对 ${pairWarn} 处差异（时长/对白/缺段，片段标记为待核对）`, "info");
  if (specConflicts.length) {
    ui.getState().toast?.(`中英视频规格冲突 ${specConflicts.length} 处：${specConflicts.slice(0, 2).join("；")}…（以英文执行稿为准，可在片段卡核对）`, "info");
  }
}

/** 绑定项目文件夹：选目录 → 扫描 → 预演确认（调用方渲染 AskCard，含冲突预演）→ apply(mode) */
export async function bindProjectFolderFlow(
  projectId: string,
): Promise<{ scan: FolderScan; conflict?: BindConflict; apply: (mode?: BindImportMode) => Promise<void>; cancel: () => void } | null> {
  if (!isTauri) {
    useUi.getState().toast?.("项目文件夹绑定只在桌面端可用（浏览器预览为托管模式）", "err");
    return null;
  }
  const toast = (m: string, t?: "ok" | "err" | "info") => useUi.getState().toast(m, t);
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, multiple: false, title: "选择项目文件夹（含 完整剧本.md / 全部素材 / 分段资产库 的 H3 包目录，或空目录）" });
    if (!dir || typeof dir !== "string") return null;
    const scan = await scanProjectFolder(dir);
    const blockMsg = manifestBlocksBind(scan, projectId, useDirector.getState().projects.map((p) => ({ id: p.id, name: p.name })));
    if (blockMsg) {
      toast(blockMsg, "err");
      return null;
    }
    // 冲突预演（写入之前）：空项目无冲突直接导入；已有片段由用户选合并/覆盖
    const proj = useDirector.getState().getById(projectId);
    const conflict = proj ? planBindConflict(scan, proj) : undefined;
    const apply = async (mode: BindImportMode = "auto") => {
      const notes = await applyBindImport(projectId, dir, scan, mode);
      // 绑定后立即校验工作区（目录在线性）
      void checkWorkspace(projectId);
      toast(`已绑定项目文件夹${notes.length ? `：${notes.join("；")}` : ""}——Take/成片将写入项目目录`, "ok");
    };
    return { scan, conflict, apply, cancel: () => undefined };
  } catch (e) {
    toast(`绑定失败：${errMsg(e)}`, "err");
    return null;
  }
}

/** manifest 是否阻止绑定（纯函数，测试直测）：目录已绑其他项目 → 返回错误文案；null = 可以绑定 */
export function manifestBlocksBind(scan: FolderScan, projectId: string, projects: Array<{ id: string; name: string }>): string | null {
  if (!scan.manifestProjectId || scan.manifestProjectId === projectId) return null;
  const other = projects.find((p) => p.id === scan.manifestProjectId);
  return `该目录已绑定「${other?.name ?? "另一个项目"}」——一个文件夹只绑一个项目；如需转移请先在原项目解除绑定`;
}

/**
 * 解绑核心（fs 可注入，测试直测）：删除指向本项目的 .momo/project.json（保留产物文件与用户资产）。
 * 返回 null = 清理成功；返回 Error = 目录不可达（调用方记待清理状态）。
 */
export async function removeManifestFor(rootPath: string, projectId: string, fsIn?: WorkspaceFs): Promise<Error | null> {
  try {
    const fs = fsIn ?? (await tauriFs());
    const manifest = join(rootPath, ".momo/project.json");
    if (await fs.exists(manifest)) {
      const body = JSON.parse(await fs.readTextFile(manifest)) as { projectId?: string };
      if (body.projectId === projectId) await fs.remove(manifest);
      // 指向别的项目：不动（那是别的项目的绑定，不属于本次解绑）
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

/**
 * 解除绑定：保留产物文件与用户资产，删除（或标记待清理）.momo/project.json——
 * manifest 残留会把目录锁死在旧项目上，之后绑不了新项目（3.5 P1 修复）。
 */
export async function unbindProjectFolder(projectId: string): Promise<void> {
  const p = useDirector.getState().getById(projectId);
  const w = p?.workspace;
  useDirector.getState().updateProject(projectId, { workspace: undefined });
  if (!w || !isTauri) {
    useUi.getState().toast?.("已解除项目文件夹绑定（文件保留在原处；新产物回到 AppData 托管）", "info");
    return;
  }
  const err = await removeManifestFor(w.rootPath, projectId);
  if (!err) {
    useUi.getState().toast?.("已解除绑定并清理目录里的 .momo/project.json（产物文件保留；新产物回到 AppData 托管；该目录可绑定新项目）", "ok");
    return;
  }
  // 目录离线/占用：记待清理状态，目录重新上线时 checkWorkspace 自动补删
  const cur = useDirector.getState().getById(projectId);
  const pending = [...new Set([...(cur?.pendingManifestCleanups ?? []), w.rootPath])];
  useDirector.getState().updateProject(projectId, { pendingManifestCleanups: pending });
  useUi.getState().toast?.(
    `已解除绑定，但目录离线没能清理 .momo/project.json（${errMsg(err)}）——目录重新上线后打开项目会自动清理；期间该目录暂不能绑定新项目`,
    "info",
  );
}

/** 目录重新上线后补清理待删 manifest（解绑时离线的兜底）；返回清理掉的路径数 */
export async function cleanPendingManifests(projectId: string, fsIn?: WorkspaceFs): Promise<number> {
  const p = useDirector.getState().getById(projectId);
  const pending = p?.pendingManifestCleanups;
  if (!pending?.length) return 0;
  const fs = fsIn ?? (await tauriFs());
  let cleaned = 0;
  const remain: string[] = [];
  for (const root of pending) {
    try {
      const manifest = join(root, ".momo/project.json");
      if (await fs.exists(manifest)) {
        const body = JSON.parse(await fs.readTextFile(manifest)) as { projectId?: string };
        // 只删指向本项目的 manifest（目录可能已被别的项目接管）
        if (body.projectId === projectId) {
          await fs.remove(manifest);
          cleaned++;
          continue;
        }
        continue; // 已属于其他项目：不再挂在本项目待清理列表里
      }
      cleaned++; // 文件已不在（用户手删/重新格式化）也算清理完成
    } catch {
      remain.push(root); // 仍离线：保留待下次
    }
  }
  if (remain.length !== pending.length) {
    useDirector.getState().updateProject(projectId, { pendingManifestCleanups: remain.length ? remain : undefined });
  }
  return cleaned;
}

/** 启动校验：目录离线不清数据，只标状态（§11.5）；上线时顺手补清理待删 manifest */
export async function checkWorkspace(projectId: string): Promise<void> {
  const p = useDirector.getState().getById(projectId);
  const w = p?.workspace;
  if (!w || !isTauri) return;
  try {
    const { exists } = await import("@tauri-apps/plugin-fs");
    const ok = await exists(w.rootPath);
    useDirector.getState().updateProject(projectId, { workspace: { ...w, status: ok ? "ready" : "missing" } });
    if (ok) await cleanPendingManifests(projectId);
  } catch {
    /* 校验失败保持原状态 */
  }
}

/** 项目内故事顺序片段号（1-based；路由 Take 落盘用） */
export function segmentNumber(project: DirectorProject, segmentId: string): number {
  let n = 0;
  for (const sc of project.scenes) for (const sg of sc.segments) {
    n++;
    if (sg.id === segmentId) return n;
  }
  return 0;
}
