/**
 * 导演台项目隔离与锁行为测试（node --experimental-strip-types 直跑）
 * 覆盖（3.5 P0/P1）：
 *  - 不同剧本切换后片段/资产/Take 按 projectId 完全隔离（assetVisibleInProject 谓词与 directorStore 双项目）
 *  - 英文执行稿锁定 / 最终锁定稿 → isExecutionLocked（Skill 精炼不得覆盖）
 *  - 导演台各类产物（Take/接力/音频/后处理/成片/AI制图/AI MV）进入正确项目目录（relDirFor 路由表）
 */
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

import { assetVisibleInProject } from "./stores/assetStore.ts";
import { isExecutionLocked, importPromptSegments } from "./directorEngine.ts";
import { relDirFor, type ProjectAssetCategory } from "./studio/projectAssetRouter.ts";
import { useDirector } from "./stores/directorStore.ts";
import type { AssetItem, DirectorProject, DirectorSegment } from "./types.ts";

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failed++;
    console.error(`✗ ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  } else console.log(`✓ ${name}`);
};
const ok = (name: string, v: boolean) => eq(name, v, true);

/* ---------------- 项目资产隔离（切换剧本后过滤完全隔离） ---------------- */
const a1: AssetItem = { id: "a1", kind: "image", director: { projectId: "pa" }, createdAt: 0 } as never;
const a2: AssetItem = { id: "a2", kind: "video", director: { projectId: "pb" }, createdAt: 0 } as never;
const a3: AssetItem = { id: "a3", kind: "image", createdAt: 0 } as never; // 无导演归属（画布生成）
const all = [a1, a2, a3];

eq("隔离:A 项目视图", all.filter((i) => assetVisibleInProject(i, "pa", true)).map((i) => i.id), ["a1"]);
eq("隔离:B 项目视图", all.filter((i) => assetVisibleInProject(i, "pb", true)).map((i) => i.id), ["a2"]);
eq("隔离:全部资产视图", all.filter((i) => assetVisibleInProject(i, "pb", false)).length, 3);
eq("隔离:无项目上下文不过滤", all.filter((i) => assetVisibleInProject(i, null, true)).length, 3);
// 资产数量统计跟随当前项目（空态/计数用同一谓词）
eq("隔离:B 项目计数", all.filter((i) => assetVisibleInProject(i, "pb", true)).length, 1);

/* ---------------- directorStore 双项目数据隔离（切换不改串） ---------------- */
const mkProj = (id: string, name: string): DirectorProject =>
  ({ id, nodeId: "n_" + id, boardId: "b", name, createdAt: 0, updatedAt: 0, targetDurationSec: 60, aspect: "16:9", script: "", characters: [], scenes: [], recipes: [], globalSlots: [], timeline: [], scripts: [], mvProjects: [], imageStudio: {}, studioUi: { station: "h3", segId: null }, schemaVersion: 6 }) as never;
const segOf = (id: string): DirectorSegment => ({ id, sceneId: "sc", durationSec: 10, summary: id, dialogue: [], shots: [], approvedTakeId: null, takes: [{ id: "tk_" + id, segmentId: id, kind: "video", target: "clip", status: "done", promptSnapshot: "", createdAt: 0, assetId: "as_" + id }] }) as never;
const pa = mkProj("pa", "甲项目");
pa.scenes = [{ id: "sc", location: "", segments: [segOf("sgA")] }];
const pb = mkProj("pb", "乙项目");
pb.scenes = [{ id: "sc", location: "", segments: [segOf("sgB")] }];
useDirector.setState({ projects: [pa, pb] });
// 更新 A 的片段，B 不受影响（切换后隔离）
useDirector.getState().patchSegment("pa", "sgA", { summary: "甲片断改" });
const paNow = useDirector.getState().getById("pa")!;
const pbNow = useDirector.getState().getById("pb")!;
eq("隔离:store 甲片段更新", paNow.scenes[0].segments[0].summary, "甲片断改");
eq("隔离:store 乙片段不受影响", pbNow.scenes[0].segments[0].summary, "sgB");
eq("隔离:Take 归属", [paNow.scenes[0].segments[0].takes?.[0]?.assetId, pbNow.scenes[0].segments[0].takes?.[0]?.assetId], ["as_sgA", "as_sgB"]);

/* ---------------- 锁：英文执行稿锁定 / 最终锁定稿（Skill 精炼不得覆盖） ---------------- */
const plainSeg = { id: "s1" } as DirectorSegment;
const lockedSeg = { id: "s2", locks: { structure: false, reviewZh: false, executionEn: true } } as DirectorSegment;
const finalSeg = { id: "s3", promptFinalOverride: "最终锁定稿全文……" } as DirectorSegment;
const structOnly = { id: "s4", locked: true, locks: { structure: true, reviewZh: false, executionEn: false } } as DirectorSegment;
eq("锁:普通段可精炼", isExecutionLocked(plainSeg), false);
eq("锁:执行稿锁定", isExecutionLocked(lockedSeg), true);
eq("锁:最终锁定稿", isExecutionLocked(finalSeg), true);
eq("锁:仅结构锁不拦精炼", isExecutionLocked(structOnly), false);
// 批量精炼目标过滤行为（refineSegmentPrompts 的过滤表达式：!locked && !isExecutionLocked）
const batch = [plainSeg, lockedSeg, finalSeg, structOnly];
const runnable = batch.filter((s) => !s.locked && !isExecutionLocked(s));
// locked（成品直录）与执行稿锁/最终稿都拦精炼；仅结构锁的语义等价 locked=true 也拦——只有普通段可精炼
eq("锁:批量精炼过滤", runnable.map((s) => s.id), ["s1"]);

/* ---------------- 直录导入字段完整（绑定即导入写入项） ---------------- */
const pkg = [
  "# 项目包标题",
  "分辨率：1080p；帧率 24fps",
  "",
  "## H3-01｜山门初雪｜12秒｜1080p｜24fps",
  "subject_definitions:",
  "- 甲 <Subject 1>: 描述",
  "summary: 摘要",
  "detailed_description: 正文。 <d>[中文]台词一。</d>",
  "承接上段：开篇",
  "结束状态：入门",
  "",
  "## H3-02｜殿内对峙｜11秒",
  "subject_definitions:",
  "- 乙 <Subject 2>: 描述",
  "summary: 摘要二",
  "detailed_description: 正文二。 <d>[中文]台词二。</d>",
].join("\n");
const imported = importPromptSegments(pkg, 12);
const segs = imported.scenes.flatMap((s) => s.segments);
eq("直录:段数", segs.length, 2);
eq("直录:promptOverride", segs[0].promptOverride?.includes("subject_definitions"), true);
ok("直录:h3Prompt.en", !!segs[0].h3Prompt?.en);
eq("直录:locks.structure", segs[0].locks?.structure, true);
eq("直录:durationSec 识别", segs[0].durationSec, 12);
eq("直录:videoSpec.fps", segs[0].videoSpec?.fps, 24);
eq("直录:对白", segs[0].dialogue, ["台词一。"]);
eq("直录:continuityIn", segs[0].continuityIn, "开篇");
eq("直录:continuityOut", segs[0].continuityOut, "入门");
// 段2 无规格 → 用默认时长，不误标
eq("直录:段2 标题时长", segs[1].durationSec, 11);
eq("直录:段2 无识别规格", segs[1].videoSpec?.fps, undefined);

/* ---------------- 产物路由表：各类产物进正确项目目录 ---------------- */
const ROUTES: Array<[ProjectAssetCategory, string]> = [
  ["take", "分段资产库/01_山门初雪/Takes"],
  ["relay", "分段资产库/01_山门初雪/接力"],
  ["audio", "分段资产库/01_山门初雪/音频"],
  ["post", "分段资产库/01_山门初雪/后处理"],
  ["export", "成片"],
  ["image", "全部素材/AI制图"],
  ["mv", "AI MV"],
  ["character", "全部素材/人物"],
  ["scene", "全部素材/场景"],
  ["prop", "全部素材/道具"],
];
for (const [cat, want] of ROUTES) {
  eq(`路由表:${cat}`, relDirFor(cat, 1, "山门初雪"), want);
}


/* ---------------- 段头元信息行跳过（用户实测：# 第X分段 / 共六分段 / 01-标题-11秒 结构） ---------------- */
const pkgMeta = [
  "# 心跳倒计时 · 分段剧本-英文 H3 Ref2VA 执行稿汇总",
  "",
  "# 第一分段",
  "共六分段",
  "",
  "01-停机通知-10秒",
  "<<<PROMPT_START>>>",
  "subject_definitions:",
  "- 林晚 <Subject 1>: 值班工程师",
  "summary: 深夜机房告警",
  "detailed_description: 林晚盯着屏幕。 <d>[中文]又误报了？</d>",
  "<<<PROMPT_END>>>",
  "",
  "# 第二分段",
  "02-断电十分钟-12秒",
  "<<<PROMPT_START>>>",
  "detailed_description: 应急灯亮起。 <d>[中文]谁动的闸？</d>",
  "<<<PROMPT_END>>>",
].join("\n");
const metaSegs = importPromptSegments(pkgMeta, 12).scenes.flatMap((s) => s.segments);
eq("段名:元信息行不进段名", metaSegs[0].summary, "停机通知");
eq("段名:时长取标题尾", metaSegs[0].durationSec, 10);
eq("段名:第二段", metaSegs[1].summary, "断电十分钟");
eq("段名:第二段时长", metaSegs[1].durationSec, 12);
// 无「# 第X分段」前缀、首行直接是元信息行的包也跳过
const pkgMeta2 = ["## H3-01｜段一｜12秒", "总时长 60 秒", "01-开场-10秒", "<<<PROMPT_START>>>", "detailed_description: d", "<<<PROMPT_END>>>"].join("\n");
const metaSegs2 = importPromptSegments(pkgMeta2, 12).scenes.flatMap((s) => s.segments);
eq("段名:首行元信息也跳过", metaSegs2[0].summary, "开场");


/* ---------------- 千万像素换算 ---------------- */
import { mpToSize } from "./directorEngine.ts";
const s10 = mpToSize("16:9", 10);
eq("MP:10MP 千万像素", s10.width * s10.height >= 9_500_000, true);
eq("MP:10MP 宽高比", Math.abs(s10.width / s10.height - 16 / 9) < 0.02, true);
eq("MP:16 对齐", [s10.width % 16, s10.height % 16], [0, 0]);
const s20 = mpToSize("9:16", 20);
eq("MP:20MP 竖屏", s20.width * s20.height >= 19_000_000, true);
eq("MP:1MP 基线", mpToSize("16:9", 1), { width: 1328, height: 752 });

/* ---------------- 参考视频稿别序（首尾帧 → 403 → 103） ---------------- */
import { draftRankOf } from "./studio/dropImport.ts";
eq("稿别:首尾帧最前", draftRankOf("分段资产库/01_标题/01_首尾帧稿.mp4"), 0);
eq("稿别:403 次之", draftRankOf("01_403稿.mp4"), 1);
eq("稿别:103 第三", draftRankOf("01_103稿.mp4"), 2);
eq("稿别:未标注最后", draftRankOf("01_其他版本.mp4"), 3);
eq("稿别:数字不误伤", draftRankOf("01_标题_14033.mp4"), 3); // 14033 不是 403 稿
eq("稿别:中文数字", [draftRankOf("01_四百零三.mp4"), draftRankOf("01_一〇三.mp4")], [1, 2]);
// 有序插入逻辑（与 dropImport 绑定分支同款）：乱序拖入后槽内顺序稳定为 首尾帧→403→103
const items = [
  { id: "v103", path: "G:/assets/01_103稿.mp4" },
  { id: "vfl", path: "G:/assets/01_首尾帧稿.mp4" },
  { id: "v403", path: "G:/assets/01_403稿.mp4" },
];
const slot: string[] = [];
for (const it of items) {
  const rank = draftRankOf(it.path);
  const at = slot.findIndex((id) => draftRankOf(items.find((x) => x.id === id)!.path) > rank);
  if (at >= 0) slot.splice(at, 0, it.id);
  else slot.push(it.id);
}
eq("稿别:槽内顺序", slot, ["vfl", "v403", "v103"]);

/* ---------------- 未精炼片段检测 ---------------- */
import { unrefinedSegments } from "./directorEngine.ts";
const mkSeg = (id: string, over: Record<string, unknown> = {}) => ({ id, sceneId: "sc", durationSec: 10, summary: id, dialogue: [], shots: [], approvedTakeId: null, takes: [], ...over });
const projU = { ...mkProj("pu", "未精炼"), scenes: [{ id: "sc", location: "", segments: [
  mkSeg("u_bare"),                                                                  // 什么稿都没有 → 未精炼
  mkSeg("u_po", { promptOverride: "subject_definitions: x" }),                       // 有执行稿 → 已精炼
  mkSeg("u_final", { promptFinalOverride: "最终稿" }),                                // 最终锁定稿 → 已精炼
  mkSeg("u_h3", { h3Prompt: { en: { title: "t", promptBody: "body" }, source: "skill", syncStatus: "synced" } }), // h3.en → 已精炼
] }] } as never as Parameters<typeof unrefinedSegments>[0];
eq("未精炼:只报裸段", unrefinedSegments(projU).map((s) => s.id), ["u_bare"]);
eq("未精炼:空项目", unrefinedSegments({ ...mkProj("pe", "空"), scenes: [] } as never), []);


/* ---------------- 首尾帧语义自动入卡槽（3.5 §4.1） ---------------- */
import { semanticForMediaRel } from "./studio/dropImport.ts";
eq("语义:首帧图", semanticForMediaRel("分段资产库/01_标题/01_首帧.png", "image"), "firstFrame");
eq("语义:首帧英文", semanticForMediaRel("01_first_frame.png", "image"), "firstFrame");
eq("语义:尾帧图", semanticForMediaRel("01_尾帧.png", "image"), "lastFrame");
eq("语义:末帧/结束帧", semanticForMediaRel("01_结束帧.png", "image"), "lastFrame");
eq("语义:last frame 英文", semanticForMediaRel("01_lastframe.png", "image"), "lastFrame");
eq("语义:首尾帧整稿名不占单例槽", semanticForMediaRel("01_首尾帧稿.mp4", "video"), "referenceVideo");
eq("语义:首尾帧图片名降普通参考", semanticForMediaRel("01_首尾帧.png", "image"), "referenceImage");
eq("语义:站位图", semanticForMediaRel("01_空间站位图.png", "image"), "layoutGuide");
eq("语义:普通图片", semanticForMediaRel("01_场景.jpg", "image"), "referenceImage");
eq("语义:视频恒为参考", semanticForMediaRel("01_首帧示意.mp4", "video"), "referenceVideo");
eq("语义:音频", semanticForMediaRel("01_旁白.mp3", "audio"), "referenceAudio");

// 资产册语义（slotSemanticFor 经条目名识别——通过 applyAssetCatalogToProject 的行为验证点，这里直接测判定函数同款正则语义）
import { parseDirectorAssetCatalog } from "./directorAssetCatalog.ts";
const cat = parseDirectorAssetCatalog([
  "# 资产提示词 MOMO_ASSET_CATALOG_V1",
  "## FF-01 | 01_首帧",
  "![首帧](f.png)",
  "### 中文提示词", "开画首帧",
  "### English Prompt", "opening frame",
  "- 使用分段：1",
].join("\n"));
eq("资产册:首帧条目解析", cat.entries[0]?.file, "f.png");

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
