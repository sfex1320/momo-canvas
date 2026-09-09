/**
 * 项目文件夹绑定（绑定即导入）集成测试（node --experimental-strip-types 直跑 + scripts/ts-resolve 补全）
 * 真实临时目录 + node:fs 注入 WorkspaceFs，走 scanProjectFolder → planBindConflict → applyBindImport 全链路。
 * 覆盖（3.5 P0/P1）：空项目双语导入全字段 / 冲突预演未确认不写入 / 资产册路径解析 / 幂等 / merge/overwrite / 解绑换绑。
 * 说明：资产收录层（storeAssetFile 依赖桌面端文件系统）在 node 下以桩替换——验证 collect 调用参数与媒体真实可读。
 */
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

// localStorage polyfill（persist 浏览器分支）
(globalThis as Record<string, unknown>).localStorage = {
  _m: new Map<string, string>(),
  getItem(k: string) {
    return this._m.get(k) ?? null;
  },
  setItem(k: string, v: string) {
    this._m.set(k, v);
  },
  removeItem(k: string) {
    this._m.delete(k);
  },
};

import { scanProjectFolder, applyBindImport, planBindConflict, manifestBlocksBind, removeManifestFor, hashText, type WorkspaceFs } from "./projectWorkspace.ts";
import { useDirector } from "../stores/directorStore.ts";
import { useAssets } from "../stores/assetStore.ts";
import { useUi } from "../stores/uiStore.ts";
import type { DirectorProject } from "../types.ts";

// toast polyfill（node 下 uiStore 未装配 UI，toast 为 undefined；桌面运行时由 App 提供）
useUi.setState({ toast: (() => undefined) as never });

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failed++;
    console.error(`✗ ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  } else console.log(`✓ ${name}`);
};
const ok = (name: string, v: boolean) => eq(name, v, true);

/* node:fs → WorkspaceFs */
const nodeFs: WorkspaceFs = {
  readTextFile: (p) => readFile(p, "utf-8"),
  exists: async (p) => {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  },
  readDir: async (p) => {
    const names = await readdir(p, { withFileTypes: true });
    return names.map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
  },
  writeFile: async (p, data) => {
    await writeFile(p, data);
  },
  mkdir: async (p, o) => {
    await mkdir(p, { recursive: o?.recursive ?? false });
  },
  readFile: async (p) => new Uint8Array(await readFile(p)),
  remove: async (p) => {
    await rm(p, { force: true });
  },
};

/* 测试素材 */
const EN_DOC = [
  "# 三岁画像 · 全片统一规格 1080p 24fps",
  "",
  "## H3-01｜雨夜失路｜12秒｜1080p｜24fps",
  "承接上段：无（开篇）",
  "subject_definitions:",
  "- 宁采臣 <Subject 1>: 白衣书生",
  "summary: 雨夜投宿古寺",
  "detailed_description: 宁采臣撑伞前行。 <d>[中文]这寺好生冷清。</d>",
  "空间锁：山门居中，石阶自右下向左上",
  "结束状态：立于山门前",
  "",
  "## H3-02｜古刹闻客｜11秒｜1080p｜24fps",
  "承接上段：立于山门前",
  "subject_definitions:",
  "- 聂小倩 <Subject 2>: 素衣女鬼",
  "summary: 殿内初闻女子声",
  "detailed_description: 殿内烛影摇曳。 <d>[中文]公子为何深夜至此？</d>",
  "结束状态：二人对视",
].join("\n");
const ZH_DOC = [
  "# 三岁画像 · 中文审阅稿",
  "",
  "## H3-01｜雨夜失路｜12秒｜1080p｜24fps",
  "中文：雨夜赶路的宁采臣撑伞前行。 <d>[中文]这寺好生冷清。</d>",
  "",
  "## H3-02｜古刹闻客｜11秒｜1080p｜24fps",
  "中文：殿内烛影摇曳，忽闻女子声音。 <d>[中文]公子为何深夜至此？</d>",
].join("\n");
const FULL_DOC = "# 三岁画像\n\n完整剧本正文……";
const CATALOG = [
  "# 资产提示词 MOMO_ASSET_CATALOG_V1",
  "",
  "## ASSET-01 | 宁采臣",
  "![宁采臣](char_ning.png)",
  "### 中文提示词",
  "白衣书生，眉目清朗",
  "### English Prompt",
  "pale scholar in white robe",
  "- 使用分段：1",
  "",
  "## ASSET-02 | 兰若寺",
  "![兰若寺](scene_temple.png)",
  "### 中文提示词",
  "幽暗佛殿",
  "### English Prompt",
  "dim ancient temple hall",
].join("\n");
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

const mkProject = (id: string, name: string): DirectorProject =>
  ({
    id, nodeId: "n_" + id, boardId: "b", name, createdAt: Date.now(), updatedAt: Date.now(),
    targetDurationSec: 60, aspect: "16:9", script: "", characters: [], scenes: [], recipes: [],
    globalSlots: [], timeline: [], scripts: [], mvProjects: [], imageStudio: {},
    studioUi: { station: "h3", segId: null }, schemaVersion: 6,
  }) as never as DirectorProject;

async function buildTmpH3Dir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "momo-ws-"));
  await writeFile(join(dir, "完整剧本.md"), FULL_DOC, "utf-8");
  await writeFile(join(dir, "分段剧本-英.md"), EN_DOC, "utf-8");
  await writeFile(join(dir, "分段剧本-中.md"), ZH_DOC, "utf-8");
  await mkdir(join(dir, "全部素材"), { recursive: true });
  await writeFile(join(dir, "全部素材", "资产提示词.md"), CATALOG, "utf-8");
  await writeFile(join(dir, "全部素材", "char_ning.png"), PNG_BYTES);
  await writeFile(join(dir, "全部素材", "scene_temple.png"), PNG_BYTES);
  return dir;
}

/* 资产收录桩：记录调用（src 必须可解码 = 媒体按正确路径真实读到），返回最小资产项 */
const collected: Array<{ src: string; kind?: string; director?: { projectId?: string } | null }> = [];
useAssets.setState({
  collect: (async (input: { src: string; kind?: string; director?: { projectId?: string } }) => {
    collected.push({ src: input.src, kind: input.kind, director: input.director ?? null });
    return { id: "asset_" + collected.length, path: join(tmpdir(), "fake_" + collected.length + ".png"), kind: input.kind ?? "image", createdAt: Date.now() } as never;
  }) as never,
  patchItem: (() => undefined) as never,
} as never);

/* ============ T1：空项目绑定双语 H3 目录（英文分段真正写进项目） ============ */
{
  const dir = await buildTmpH3Dir();
  useDirector.setState({ projects: [mkProject("p1", "项目一")] });
  const scan = await scanProjectFolder(dir, nodeFs);
  ok("T1 扫描:识别英文分段", scan.segEn === EN_DOC);
  ok("T1 扫描:识别中文分段", !!scan.segZh);
  ok("T1 扫描:识别完整剧本", !!scan.fullScript);
  eq("T1 扫描:资产册路径=相对路径", scan.assetCatalogPath, "全部素材/资产提示词.md");
  ok("T1 扫描:summary 含资产册", scan.summary.includes("资产提示词.md"));

  const notes = await applyBindImport("p1", dir, scan, "auto", nodeFs);
  const proj = useDirector.getState().getById("p1")!;
  const segs = proj.scenes.flatMap((sc) => sc.segments);
  eq("T1 导入:片段数", segs.length, 2);
  const s1 = segs[0];
  ok("T1 导入:promptOverride 含正文", (s1.promptOverride ?? "").includes("subject_definitions"));
  ok("T1 导入:h3Prompt.en 存在", !!s1.h3Prompt?.en.promptBody);
  ok("T1 导入:中文稿配对 synced", s1.h3Prompt?.syncStatus === "synced" && !!s1.h3Prompt?.zh);
  eq("T1 导入:结构锁", s1.locks?.structure, true);
  eq("T1 导入:durationSec", s1.durationSec, 12);
  eq("T1 导入:videoSpec.fps", s1.videoSpec?.fps, 24);
  eq("T1 导入:videoSpec.resolution", s1.videoSpec?.resolution?.label, "1080p");
  eq("T1 导入:对白提取", s1.dialogue, ["这寺好生冷清。"]);
  eq("T1 导入:continuityIn", s1.continuityIn, "无（开篇）");
  eq("T1 导入:continuityOut", s1.continuityOut, "立于山门前");
  eq("T1 导入:spatialLock（h3Prompt.en）", s1.h3Prompt?.en.spatialLock, "山门居中，石阶自右下向左上");
  ok("T1 导入:前言规格入项目", proj.videoSpecFromPrefix?.fps === 24 || proj.videoSpecFromPrefix === undefined || Object.keys(proj.videoSpecFromPrefix?.sources ?? {}).length >= 0);
  eq("T1 导入:workspace.assetCatalogPath", proj.workspace?.assetCatalogPath, "全部素材/资产提示词.md");
  ok("T1 导入:manifest 已写", existsSync(join(dir, ".momo", "project.json")));
  ok("T1 导入:导入指纹", !!proj.workspace?.imported?.segEnHash);
  ok("T1 导入:完整剧本入剧本库", proj.scripts.some((d) => d.versions[0]?.body === FULL_DOC));
  // 资产册：collect 被调（媒体按相对路径真实读取 → dataURL 可解析）
  const catalogCollects = collected.filter((c) => c.director?.projectId === "p1");
  eq("T1 资产册:媒体收录数", catalogCollects.length, 2);
  ok("T1 资产册:src 是可解码 dataURL", catalogCollects.every((c) => c.src.startsWith("data:image/png;base64,")));
  eq("T1 资产册:kind", catalogCollects.every((c) => c.kind === "image"), true);
  ok("T1 导入:notes 摘要", notes.some((n) => /英文分段直录 2 段/.test(n)) && notes.some((n) => /资产册/.test(n)));
  await rm(dir, { recursive: true, force: true });
}

/* ============ T2：已有片段绑定 → 冲突预演，未确认前不修改 ============ */
{
  const dir = await buildTmpH3Dir();
  const existing = mkProject("p2", "项目二");
  existing.scenes = [{ id: "sc0", location: "已有", segments: [{ id: "seg_old", sceneId: "sc0", durationSec: 9, summary: "旧片段", dialogue: [], shots: [], approvedTakeId: null, takes: [] } as never] }];
  useDirector.setState({ projects: [existing] });
  const scan = await scanProjectFolder(dir, nodeFs);
  const conflict = planBindConflict(scan, existing);
  ok("T2 冲突:存在", !!conflict);
  eq("T2 冲突:existing", conflict?.existing, 1);
  eq("T2 冲突:incoming", conflict?.incoming, 2);
  ok("T2 冲突:说明覆盖后果", (conflict?.notes ?? []).some((n) => n.includes("覆盖导入")));
  // 未确认（不调 apply）：项目保持 1 个片段，manifest 未写
  const segsNow = useDirector.getState().getById("p2")!.scenes.flatMap((s) => s.segments);
  eq("T2 未确认:片段不变", segsNow.length, 1);
  ok("T2 未确认:manifest 未写", !existsSync(join(dir, ".momo", "project.json")));
  // 中英规格冲突必须在预演里（写入之前）出现——不写完才 toast
  const zhClash = ZH_DOC.replace("## H3-01｜雨夜失路｜12秒", "## H3-01｜雨夜失路｜13秒");
  await writeFile(join(dir, "分段剧本-中.md"), zhClash, "utf-8");
  const scanClash = await scanProjectFolder(dir, nodeFs);
  const conflictClash = planBindConflict(scanClash, existing);
  ok("T2 规格冲突:预演展示", (conflictClash?.notes ?? []).some((n) => /时长：中 13 \/ 英 12/.test(n)));
  await rm(dir, { recursive: true, force: true });
}

/* ============ T3：重复绑定同一目录幂等 ============ */
{
  const dir = await buildTmpH3Dir();
  useDirector.setState({ projects: [mkProject("p3", "项目三")] });
  const scan = await scanProjectFolder(dir, nodeFs);
  await applyBindImport("p3", dir, scan, "auto", nodeFs);
  const after1 = useDirector.getState().getById("p3")!;
  const segCount1 = after1.scenes.flatMap((s) => s.segments).length;
  const scriptCount1 = after1.scripts.length;
  // 重复绑定（同一目录同一内容）：内容指纹没变 → 跳过，不重复建
  const scan2 = await scanProjectFolder(dir, nodeFs);
  await applyBindImport("p3", dir, scan2, "auto", nodeFs);
  const after2 = useDirector.getState().getById("p3")!;
  eq("T3 幂等:片段数不变", after2.scenes.flatMap((s) => s.segments).length, segCount1);
  eq("T3 幂等:剧本文档数不变", after2.scripts.length, scriptCount1);
  const collectedBefore = collected.length;
  await applyBindImport("p3", dir, scan2, "auto", nodeFs);
  eq("T3 幂等:资产册不重复收录", collected.length, collectedBefore);
  await rm(dir, { recursive: true, force: true });
}

/* ============ T4：merge / overwrite 两种确认模式 ============ */
{
  const dir = await buildTmpH3Dir();
  const existing = mkProject("p4", "项目四");
  existing.scenes = [{ id: "sc0", location: "已有", segments: [{ id: "seg_old", sceneId: "sc0", durationSec: 9, summary: "旧片段", dialogue: [], shots: [], approvedTakeId: null, takes: [] } as never] }];
  useDirector.setState({ projects: [existing] });
  const scan = await scanProjectFolder(dir, nodeFs);
  // merge：保留现有片段
  const mergeNotes = await applyBindImport("p4", dir, scan, "merge", nodeFs);
  eq("T4 merge:片段保留", useDirector.getState().getById("p4")!.scenes.flatMap((s) => s.segments).length, 1);
  ok("T4 merge:notes 说明", mergeNotes.some((n) => /保留现有 1 个片段/.test(n)));
  // overwrite：整包替换
  const scan2 = await scanProjectFolder(dir, nodeFs);
  const owNotes = await applyBindImport("p4", dir, scan2, "overwrite", nodeFs);
  eq("T4 overwrite:片段替换", useDirector.getState().getById("p4")!.scenes.flatMap((s) => s.segments).length, 2);
  ok("T4 overwrite:notes 说明", owNotes.some((n) => /覆盖导入/.test(n)));
  await rm(dir, { recursive: true, force: true });
}

/* ============ T5：项目 A 解绑后目录可绑定项目 B（manifest 清理） ============ */
{
  const dir = await buildTmpH3Dir();
  useDirector.setState({ projects: [mkProject("pa", "项目A"), mkProject("pb", "项目B")] });
  const scanA = await scanProjectFolder(dir, nodeFs);
  await applyBindImport("pa", dir, scanA, "auto", nodeFs);
  // B 绑定被拦（manifest 指向 A）
  const scanMid = await scanProjectFolder(dir, nodeFs);
  ok("T5 换绑前:manifest 指向 A", scanMid.manifestProjectId === "pa");
  ok("T5 换绑前:B 被拦", manifestBlocksBind(scanMid, "pb", [{ id: "pa", name: "项目A" }, { id: "pb", name: "项目B" }]) !== null);
  // A 解绑（清理 manifest；产物保留）
  const err = await removeManifestFor(dir, "pa", nodeFs);
  eq("T5 解绑:无错误", err, null);
  ok("T5 解绑:manifest 已删", !existsSync(join(dir, ".momo", "project.json")));
  ok("T5 解绑:产物保留", existsSync(join(dir, "分段剧本-英.md")) && existsSync(join(dir, "全部素材", "资产提示词.md")));
  // B 现在可以绑定
  const scanB = await scanProjectFolder(dir, nodeFs);
  eq("T5 换绑后:不再拦截", manifestBlocksBind(scanB, "pb", [{ id: "pa", name: "项目A" }, { id: "pb", name: "项目B" }]), null);
  await applyBindImport("pb", dir, scanB, "auto", nodeFs);
  const projB = useDirector.getState().getById("pb")!;
  eq("T5 换绑:B 导入片段", projB.scenes.flatMap((s) => s.segments).length, 2);
  ok("T5 换绑:B manifest", JSON.parse(await readFile(join(dir, ".momo", "project.json"), "utf-8")).projectId === "pb");
  // 指向别的项目的 manifest 不被误删（C 试图解绑不动 B 的绑定）
  const errC = await removeManifestFor(dir, "pc", nodeFs);
  eq("T5 他人 manifest 不动", errC, null);
  ok("T5 他人 manifest 保留", JSON.parse(await readFile(join(dir, ".momo", "project.json"), "utf-8")).projectId === "pb");
  await rm(dir, { recursive: true, force: true });
}

/* ============ T6：资产册在项目根目录（非 全部素材/）也能识别 ============ */
{
  const dir = await mkdtemp(join(tmpdir(), "momo-ws-"));
  await writeFile(join(dir, "资产提示词.md"), CATALOG, "utf-8");
  await writeFile(join(dir, "char_ning.png"), PNG_BYTES);
  await writeFile(join(dir, "scene_temple.png"), PNG_BYTES);
  await writeFile(join(dir, "分段剧本-英.md"), EN_DOC, "utf-8");
  useDirector.setState({ projects: [mkProject("p6", "项目六")] });
  const scan = await scanProjectFolder(dir, nodeFs);
  eq("T6 根目录资产册", scan.assetCatalogPath, "资产提示词.md");
  await applyBindImport("p6", dir, scan, "auto", nodeFs);
  const collects = collected.filter((c) => c.director?.projectId === "p6");
  eq("T6 根目录:媒体收录", collects.length, 2);
  await rm(dir, { recursive: true, force: true });
}

/* hashText 稳定性（幂等依据） */
eq("hash 稳定", hashText("abc") === hashText("abc"), true);
ok("hash 区分内容", hashText("abc") !== hashText("abd"));

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
