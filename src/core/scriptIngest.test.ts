/**
 * 剧本库送入链路增强测试（node --experimental-strip-types 直跑）
 * 覆盖：中英双语稿标题匹配（matchZhCounterpartDoc）/ 剧本替换重拆后资产册参考槽重绑（rebindCatalogSlots 幂等）。
 */
(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

import { normalizeScriptTitle, matchZhCounterpartDoc } from "./scriptInspect.ts";
import { rebindCatalogSlots } from "./directorAssetCatalog.ts";
import { useDirector } from "./stores/directorStore.ts";
import { useAssets } from "./stores/assetStore.ts";
import type { DirectorProject } from "./types.ts";

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failed++;
    console.error(`✗ ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  } else console.log(`✓ ${name}`);
};
const ok = (name: string, v: boolean) => eq(name, v, true);

/* ---------------- 标题归一与中英对照匹配 ---------------- */
eq("归一:英稿 core", normalizeScriptTitle("《心跳倒计时》分段剧本-英文 H3 Ref2VA 执行稿汇总").core, "《心跳倒计时》分段剧本");
eq("归一:英稿 lang", normalizeScriptTitle("《心跳倒计时》分段剧本-英文 H3 Ref2VA 执行稿汇总").lang, "en");
eq("归一:中稿 core", normalizeScriptTitle("《心跳倒计时》分段剧本-中文审阅稿").core, "《心跳倒计时》分段剧本");
eq("归一:中稿 lang", normalizeScriptTitle("《心跳倒计时》分段剧本-中文审阅稿").lang, "zh");

const docs = [
  { id: "d1", title: "倩女幽魂 新时代" },
  { id: "d2", title: "《心跳倒计时》分段剧本-中文审阅稿" },
  { id: "d3", title: "《心跳倒计时》分段剧本-英文 H3 Ref2VA 执行稿汇总" },
  { id: "d4", title: "《心跳倒计时》英文台本" }, // 另一份英文稿（不应被当作中文侧）
];
eq("配对:英稿找到中文稿", matchZhCounterpartDoc("《心跳倒计时》分段剧本-英文 H3 Ref2VA 执行稿汇总", docs), "d2");
eq("配对:排除自身不影响命中", matchZhCounterpartDoc("《心跳倒计时》分段剧本-英文 H3 Ref2VA 执行稿汇总", docs, "d3"), "d2");
eq("配对:当前稿是中文不找", matchZhCounterpartDoc("《心跳倒计时》分段剧本-中文审阅稿", docs), undefined);
eq("配对:书名号兜底", matchZhCounterpartDoc("《心跳倒计时》英文台本", [{ id: "z", title: "《心跳倒计时》中文稿" }]), "z");
eq("配对:无中文侧", matchZhCounterpartDoc("《心跳倒计时》分段剧本-英文 H3 Ref2VA 执行稿汇总", [{ id: "d4", title: "《心跳倒计时》英文台本" }]), undefined);
eq("配对:完全无关", matchZhCounterpartDoc("雨夜失路英文执行稿", [{ id: "x", title: "古刹闻客中文稿" }]), undefined);

/* ---------------- rebindCatalogSlots：重拆后资产册参考槽重绑 ---------------- */
const mkProj = (id: string, name: string): DirectorProject =>
  ({ id, nodeId: "n", boardId: "b", name, createdAt: 0, updatedAt: 0, targetDurationSec: 60, aspect: "16:9", script: "", characters: [], scenes: [], recipes: [], globalSlots: [], timeline: [], scripts: [], mvProjects: [], imageStudio: {}, studioUi: { station: "h3", segId: null }, schemaVersion: 6 }) as never;

const seg = (id: string) => ({ id, sceneId: "sc", durationSec: 10, summary: id, dialogue: [], shots: [], approvedTakeId: null, takes: [] });
const proj = mkProj("p1", "心跳倒计时");
proj.scenes = [{ id: "sc", location: "", segments: [seg("new_1"), seg("new_2")] }];
useDirector.setState({ projects: [proj] });

const asset = (id: string, over: Record<string, unknown>) =>
  ({ id, kind: "image", name: id, createdAt: 0, ...over }) as never;
useAssets.setState({
  items: [
    asset("a_scene", { catalogId: "SCENE-01", catalogSegments: [1], catalogRole: "appearance" }),
    asset("a_global", { catalogId: "STYLE-01", catalogSegments: [-1], catalogRole: "appearance" }),
    asset("a_oob", { catalogId: "FAR-01", catalogSegments: [5] }), // 越界段号不绑
    asset("a_layout", { catalogId: "LAYOUT-01", catalogSegments: [2], catalogRole: "spatialLayout" }),
    asset("a_nocat", {}), // 无 catalogId 不参与
  ],
} as never);

const n1 = rebindCatalogSlots("p1");
eq("重绑:数量", n1, 4);
const projNow = useDirector.getState().getById("p1")!;
const s1 = projNow.scenes[0].segments[0];
const s2 = projNow.scenes[0].segments[1];
ok("重绑:段1 有场景资产", s1.slots?.some((s) => s.catalogId === "SCENE-01" && s.assetIds[0] === "a_scene"));
ok("重绑:段1 有全局资产", s1.slots?.some((s) => s.catalogId === "STYLE-01" && s.assetIds[0] === "a_global"));
ok("重绑:段2 有全局资产", s2.slots?.some((s) => s.catalogId === "STYLE-01"));
ok("重绑:段2 站位图走 layoutGuide", s2.slots?.find((s) => s.catalogId === "LAYOUT-01")?.semantic === "layoutGuide");
ok("重绑:槽 auto:false", s1.slots?.every((s) => s.auto === false));
ok("重绑:越界资产不绑", !s1.slots?.some((s) => s.catalogId === "FAR-01") && !s2.slots?.some((s) => s.catalogId === "FAR-01"));
ok("重绑:无 catalogId 资产不绑", !s1.slots?.some((s) => s.assetIds.includes("a_nocat")));
// 幂等：再跑一遍不再追加
const n2 = rebindCatalogSlots("p1");
eq("重绑:幂等", n2, 0);
const s1Again = useDirector.getState().getById("p1")!.scenes[0].segments[0];
eq("重绑:段1 槽数不变", s1Again.slots?.length, s1.slots?.length);

// 空项目/无资产安全
eq("重绑:项目不存在", rebindCatalogSlots("ghost"), 0);
useAssets.setState({ items: [] } as never);
eq("重绑:无资产", rebindCatalogSlots("p1"), 0);

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
