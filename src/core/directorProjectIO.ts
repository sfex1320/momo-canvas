/**
 * 可移植项目包（.momoproject）导入导出（方案 §16.3 / §20.2）
 *
 * 导出：收集项目引用的全部资产（内容指纹去重）+ 项目数据 + 模板快照 → Rust pack_export 落目录。
 *   不含 API Key（settings 不入包）；ComfyUI 模板只记录快照与校验信息，不打包模型文件。
 * 导入：Rust pack_import 读取 → 资产按指纹去重复用（本地命中即不重复拷贝）→ 缺失模板报告/补回 →
 *   重链接资产 id（manifest 携带导出端资产 id → 包内 rel → 本机新 id）→ 项目落库（新 id，不覆盖原项目）。
 */
import { useAssets } from "./stores/assetStore";
import { useDirector } from "./stores/directorStore";
import { useComfy } from "./stores/comfyStore";
import { assetToDataUrl } from "./services/assetFiles";
import { isTauri } from "./utils";
import { uid } from "./utils";
import { migrateDirectorProject } from "./directorMigration";
import type { DirectorProject } from "./types";

export type PackReport = {
  dir: string;
  assetCopied: number;
  assetReused: number;
  missingTemplates: string[];
  importedProject?: DirectorProject;
};

type ManifestAsset = { rel: string; hash: string; kind: string; assetId?: string };

/** 收集项目引用的全部资产 id（全局槽/片段槽/Take/音频轨/导出成片/角色含服装与视图/MV/制图历史；跳过接力占位 id） */
function collectAssetIds(project: DirectorProject): string[] {
  const ids = new Set<string>();
  const push = (id?: string) => {
    if (id && !id.startsWith("__")) ids.add(id);
  };
  for (const s of project.globalSlots ?? []) for (const a of s.assetIds) push(a);
  for (const d of project.assetDefinitions ?? []) for (const a of d.assetIds) push(a);
  for (const sc of project.scenes) {
    for (const seg of sc.segments) {
      for (const s of seg.slots ?? []) for (const a of s.assetIds) push(a);
      for (const t of seg.takes ?? []) push(t.assetId);
    }
  }
  for (const tr of project.audioTracks ?? []) {
    push(tr.assetId);
    for (const t of tr.takes ?? []) push(t.assetId);
  }
  // 3.4：角色（含服装组/分类参考视图）、MV（音乐/区间图/区间 Take）、AI 制图历史此前漏收
  for (const c of project.characters) {
    for (const a of c.assetIds ?? []) push(a);
    for (const o of c.outfits ?? []) for (const a of o.assetIds ?? []) push(a);
    for (const list of Object.values(c.refViews ?? {})) for (const a of list) push(a);
  }
  for (const mv of project.mvProjects ?? []) {
    push(mv.musicAssetId);
    for (const r of mv.regions ?? []) {
      for (const a of r.imageAssetIds ?? []) push(a);
      for (const t of r.takes ?? []) push(t.assetId);
    }
  }
  for (const rec of project.imageStudio?.history ?? []) {
    for (const a of rec.assetIds ?? []) push(a);
    for (const a of rec.inputAssetIds ?? []) push(a);
  }
  push(project.exportAssetId);
  return [...ids];
}

/** 导出项目包（桌面端；返回包目录与统计） */
export async function exportProjectPackage(project: DirectorProject): Promise<PackReport> {
  if (!isTauri) throw new Error("项目包导出只在桌面端可用（浏览器预览没有本机文件系统）");
  const { invoke } = await import("@tauri-apps/api/core");
  const { open } = await import("@tauri-apps/plugin-dialog");
  const dir = await open({ directory: true, multiple: false, title: "选择项目包保存位置（将创建 项目名.momoproject 目录）" });
  if (!dir || typeof dir !== "string") throw new Error("已取消导出");

  const items = useAssets.getState().items;
  const byId = new Map(items.map((a) => [a.id, a]));
  const assets: ManifestAsset[] = [];
  const sources: Array<{ src: string; rel: string }> = [];
  let n = 0;
  for (const id of collectAssetIds(project)) {
    const a = byId.get(id);
    if (!a?.path || /^(blob:|data:)/i.test(a.path)) continue;
    const ext = (a.path.match(/\.([^.]+)$/)?.[1] ?? "bin").toLowerCase();
    const rel = `assets/${String(n).padStart(4, "0")}_${a.kind}.${ext}`;
    n++;
    assets.push({ rel, hash: a.contentHash ?? "", kind: a.kind, assetId: id });
    sources.push({ src: a.path, rel });
  }
  // 模板快照：项目配方引用到的 ComfyUI 模板
  const templates = useComfy.getState().templates.filter((t) =>
    project.recipes.some((r) => r.templateId === t.id),
  );
  const r = await invoke<{ dir: string; fileCount: number }>("pack_export", {
    outDir: dir,
    projectName: project.name,
    projectJson: JSON.stringify(project, null, 2),
    templatesJson: templates.length ? JSON.stringify(templates, null, 2) : null,
    assets,
    assetSources: sources,
  });
  return { dir: r.dir, assetCopied: sources.length, assetReused: 0, missingTemplates: [] };
}

/** 导入项目包（桌面端）：指纹去重 → 拷回缺失资产 → 重链接 id → 落库（新项目，不覆盖原项目） */
export async function importProjectPackage(): Promise<PackReport> {
  if (!isTauri) throw new Error("项目包导入只在桌面端可用");
  const { invoke } = await import("@tauri-apps/api/core");
  const { open } = await import("@tauri-apps/plugin-dialog");
  const dir = await open({ directory: true, multiple: false, title: "选择 .momoproject 目录（内含 project.momo.json）" });
  if (!dir || typeof dir !== "string") throw new Error("已取消导入");

  const pack = await invoke<{
    projectJson: string;
    templatesJson: string | null;
    manifest: { assets: ManifestAsset[]; templateIds: string[] };
    dir: string;
  }>("pack_import", { dir });

  // ① 资产指纹去重：本地已有同指纹资产直接复用 id；缺失的拷回本机临时目录再收录
  const items = useAssets.getState().items;
  const byHash = new Map(items.filter((a) => a.contentHash).map((a) => [a.contentHash!, a]));
  const relToId = new Map<string, string>(); // 包内 rel → 本机资产 id
  const needCopy: string[] = [];
  let reused = 0;
  for (const entry of pack.manifest.assets) {
    const hit = entry.hash ? byHash.get(entry.hash) : undefined;
    if (hit) {
      relToId.set(entry.rel, hit.id);
      reused++;
      continue;
    }
    needCopy.push(entry.rel);
  }
  const kindMap: Record<string, "image" | "video" | "audio"> = { image: "image", video: "video", audio: "audio" };
  if (needCopy.length) {
    const { tempDir, join } = await import("@tauri-apps/api/path");
    const staging = await tempDir().then((t) => join(t, `momo_pack_${Date.now()}`));
    const copies = await invoke<Array<{ rel: string; path: string; ok: boolean }>>("pack_copy_assets", {
      packDir: pack.dir,
      targetDir: staging,
      rels: needCopy,
    }).catch(() => [] as Array<{ rel: string; path: string; ok: boolean }>);
    for (const copy of copies) {
      if (!copy.ok) continue;
      const kind = kindMap[pack.manifest.assets.find((a) => a.rel === copy.rel)?.kind ?? ""] ?? "other" as never;
      try {
        const mime = kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : "image/png";
        const dataUrl = await assetToDataUrl(copy.path, mime);
        const asset = await useAssets.getState().collect({
          src: dataUrl,
          kind,
          name: copy.rel.split(/[\\/]/).pop() ?? "导入资产",
          contentHash: pack.manifest.assets.find((a) => a.rel === copy.rel)?.hash || undefined,
        });
        if (asset) relToId.set(copy.rel, asset.id);
      } catch {
        // 单个资产收录失败不阻断导入（项目里该引用会显示缺失）
      }
    }
  }

  // ② 项目数据：重链接资产 id（manifest.assetId → rel → 本机 id）并换新身份落库
  const raw = JSON.parse(pack.projectJson) as DirectorProject;
  const proj = migrateDirectorProject(raw);
  const remapId = (id?: string): string | undefined => {
    if (!id) return id;
    const rel = pack.manifest.assets.find((a) => a.assetId === id)?.rel;
    if (!rel) return id;
    return relToId.get(rel) ?? id;
  };
  proj.id = uid(10);
  proj.name = `${proj.name}（导入）`;
  proj.uiState = { ...(proj.uiState ?? { workspace: "planning", inspectorTab: "content", cockpitView: "cockpit" }), segId: null };
  proj.globalSlots = (proj.globalSlots ?? []).map((s) => ({ ...s, assetIds: s.assetIds.map(remapId).filter(Boolean) as string[] }));
  proj.assetDefinitions = proj.assetDefinitions?.map(d => ({...d,assetIds:d.assetIds.map(remapId).filter(Boolean) as string[]}));
  proj.scenes = proj.scenes.map((sc) => ({
    ...sc,
    segments: sc.segments.map((seg) => ({
      ...seg,
      slots: (seg.slots ?? []).map((s) => ({ ...s, assetIds: s.assetIds.map(remapId).filter(Boolean) as string[] })),
      takes: (seg.takes ?? []).map((t) => ({ ...t, assetId: remapId(t.assetId) })),
    })),
  }));
  proj.audioTracks = (proj.audioTracks ?? []).map((t) => ({
    ...t,
    assetId: remapId(t.assetId),
    takes: t.takes?.map((x) => ({ ...x, assetId: remapId(x.assetId) })),
  }));
  proj.exportAssetId = remapId(proj.exportAssetId);
  // 3.4：角色（含服装/视图）/ MV（音乐/区间/Take）/ 制图历史同样重链接（此前漏了，导入后引用指向导出端旧 id）
  proj.characters = (proj.characters ?? []).map((c) => ({
    ...c,
    assetIds: (c.assetIds ?? []).map(remapId).filter(Boolean) as string[],
    outfits: (c.outfits ?? []).map((o) => ({ ...o, assetIds: (o.assetIds ?? []).map(remapId).filter(Boolean) as string[] })),
    refViews: Object.fromEntries(Object.entries(c.refViews ?? {}).map(([k, v]) => [k, v.map(remapId).filter(Boolean) as string[]])),
  }));
  proj.mvProjects = (proj.mvProjects ?? []).map((mv) => ({
    ...mv,
    musicAssetId: remapId(mv.musicAssetId),
    regions: (mv.regions ?? []).map((r) => ({
      ...r,
      imageAssetIds: (r.imageAssetIds ?? []).map(remapId).filter(Boolean) as string[],
      takes: (r.takes ?? []).map((t) => ({ ...t, assetId: remapId(t.assetId) })),
    })),
  }));
  if (proj.imageStudio) {
    proj.imageStudio = {
      history: (proj.imageStudio.history ?? []).map((rec) => ({
        ...rec,
        assetIds: (rec.assetIds ?? []).map(remapId).filter(Boolean) as string[],
        inputAssetIds: (rec.inputAssetIds ?? []).map(remapId).filter(Boolean) as string[],
      })),
    };
  }

  // ③ 模板缺失报告 + 包内快照补回（§16.3：缺失模板映射）
  const haveTpl = new Set(useComfy.getState().templates.map((t) => t.id));
  const missingTemplates = (pack.manifest.templateIds ?? []).filter((id) => !haveTpl.has(id));
  let restored = 0;
  if (pack.templatesJson && missingTemplates.length) {
    try {
      const tpls = JSON.parse(pack.templatesJson) as Array<{ id: string }>;
      for (const t of tpls) {
        if (!missingTemplates.includes(t.id)) continue;
        useComfy.getState().upsert(t as never);
        restored++;
      }
    } catch {
      // 模板快照损坏：只出报告
    }
  }

  // ④ 落库（新项目，不覆盖原项目；nodeId/boardId 留空 = 未挂到画布节点）
  const withNode: DirectorProject = { ...proj, nodeId: "", boardId: "" };
  useDirector.getState().addImportedProject(withNode);
  return {
    dir: pack.dir,
    assetCopied: needCopy.length,
    assetReused: reused,
    missingTemplates: restored ? [] : missingTemplates,
    importedProject: withNode,
  };
}
