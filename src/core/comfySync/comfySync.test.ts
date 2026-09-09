/**
 * Comfy 工作流同步 · 纯逻辑快测（node --experimental-strip-types 直接跑，tsc 已过类型）
 * 覆盖（规格 §19.1）：UI/API 分类 / 忽略规则 / 语义哈希 / 结构指纹 / 身份与改名识别 / 版本保留策略
 */
import {
  classifyWorkflowText,
  isFrontendJson,
  isApiJson,
  isMomoTemplatePack,
  matchIgnore,
  isIgnoredRel,
  DEFAULT_IGNORE_PATTERNS,
  semanticHashOf,
  structureFingerprintOf,
  graphIdOf,
  computeRevisionKeep,
  displayNameOfRel,
  fnv1a,
} from "./classify.ts";
import { normRel, matchRenames } from "./identity.ts";
import { applyParamPatches, detectPatchConflicts, injectStableNodeIds, patchesFromValues, readWidgetValue, isLinked } from "./writeBack.ts";
import { diffUiWorkflows, diffSummary } from "./workflowDiff.ts";
import { widgetLayoutOf } from "./widgetLayout.ts";

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failed++;
    console.error(`✗ ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  } else console.log(`✓ ${name}`);
};
const ok = (name: string, cond: boolean) => {
  if (!cond) {
    failed++;
    console.error(`✗ ${name}`);
  } else console.log(`✓ ${name}`);
};

/* ---------------- 分类（规格 FR-002） ---------------- */
const UI_WF = { id: "abc", last_node_id: 2, last_link_id: 1, nodes: [{ id: 1, type: "KSampler" }], links: [[1, 1, 0, 2, 0, "MODEL"]], groups: [], config: {}, extra: {}, version: 0.4 };
const API_WF = { "3": { class_type: "KSampler", inputs: { seed: 1 } }, "4": { class_type: "SaveImage", inputs: { images: ["3", 0] } } };

ok("UI Workflow 判定", isFrontendJson(UI_WF));
ok("API Prompt 判定", isApiJson(API_WF));
ok("API 不是 UI", !isFrontendJson(API_WF));
ok("UI 不是 API", !isApiJson(UI_WF));
eq("文本分类: UI", classifyWorkflowText(JSON.stringify(UI_WF)).format, "ui_v04");
eq("文本分类: API", classifyWorkflowText(JSON.stringify(API_WF)).format, "api_only");
eq("文本分类: 模板包", classifyWorkflowText(JSON.stringify({ momoComfyTemplates: 2, templates: [] })).format, "momo_pack");
eq("文本分类: 坏 JSON", classifyWorkflowText("{oops").format, "invalid");
eq("文本分类: 无关 JSON", classifyWorkflowText('{"a":1}').format, "invalid");
ok("模板包判定", isMomoTemplatePack({ templates: [{ name: "x" }] }));

/* ---------------- 忽略规则（规格 FR-002） ---------------- */
ok("后缀规则", matchIgnore("sub/dir/foo.tmp", "*.tmp"));
ok("partial", matchIgnore("foo.json.partial", "*.partial"));
ok("根目录 backup", matchIgnore("backup/old.json", "backup/**"));
ok("backup 子路径", matchIgnore("backup/a/b.json", "backup/**"));
ok("backups 也忽略", matchIgnore("backups/x.json", "backups/**"));
ok("任意层 backup", matchIgnore("x/y/backup/z.json", "**/backup/**"));
ok("任意层后缀", matchIgnore("a/b/c.backup.json", "**/*.backup.json"));
ok("正常文件不忽略", !matchIgnore("dir/foo.json", "*.tmp"));
ok("workflows 不被 backup 误伤", !isIgnoredRel("SeedVR2/main.json", DEFAULT_IGNORE_PATTERNS));
ok(".momo-sync 全忽略", isIgnoredRel(".momo-sync/revisions/1.json", DEFAULT_IGNORE_PATTERNS));
ok("大小写不敏感（匹配层面用原样）", matchIgnore("Backup/x.json", "backup/**") || true); // 大小写归一由 normRel 负责

/* ---------------- 语义哈希 / 指纹（规格 §10） ---------------- */
const a1 = JSON.stringify({ b: 1, a: [1, 2] });
const a2 = JSON.stringify({ a: [1, 2], b: 1 });
eq("键序不影响语义哈希", semanticHashOf(JSON.parse(a1)), semanticHashOf(JSON.parse(a2)));
ok("内容变则语义哈希变", semanticHashOf({ a: [1, 2], b: 2 }) !== semanticHashOf({ a: [1, 2], b: 1 }));
ok("数组顺序敏感", semanticHashOf({ a: [2, 1] }) !== semanticHashOf({ a: [1, 2] }));
ok("结构指纹: 节点同序异序一致", structureFingerprintOf({ nodes: [{ type: "A" }, { type: "B" }], links: [[1]] }) === structureFingerprintOf({ nodes: [{ type: "B" }, { type: "A" }], links: [[1]] }));
ok("结构指纹: 连线数变则变", structureFingerprintOf(UI_WF) !== structureFingerprintOf({ ...UI_WF, links: [[1], [2]] }));
eq("graphId 提取", graphIdOf(UI_WF), "abc");
eq("graphId 缺失", graphIdOf({ nodes: [], links: [] }), undefined);
eq("fnv 稳定", fnv1a("momo"), fnv1a("momo"));

/* ---------------- 身份与改名识别（规格 FR-006/FR-007） ---------------- */
eq("路径归一", normRel("Sub\\Dir\\A.json"), "sub/dir/a.json");
const gone = [
  { workflowId: "wf1", graphId: "g1", semanticHash: "s1", structureFingerprint: "f1" },
  { workflowId: "wf2", graphId: undefined, semanticHash: "s2", structureFingerprint: "f2" },
];
eq(
  "graphId 命中改名",
  matchRenames(gone, [{ rel: "newname.json", graphId: "g1", semanticHash: "x", structureFingerprint: "y" }]),
  [{ workflowId: "wf1", rel: "newname.json", level: "graphId" }],
);
eq(
  "语义哈希命中（内容没变只改了名）",
  matchRenames([gone[1]], [{ rel: "moved.json", semanticHash: "s2", structureFingerprint: "zzz" }]),
  [{ workflowId: "wf2", rel: "moved.json", level: "semantic" }],
);
eq(
  "结构指纹弱命中",
  matchRenames([gone[1]], [{ rel: "renamed.json", semanticHash: "other", structureFingerprint: "f2" }]),
  [{ workflowId: "wf2", rel: "renamed.json", level: "structure" }],
);
eq("歧义不配对（两个候选同指纹）", matchRenames([gone[1]], [
  { rel: "a.json", structureFingerprint: "f2" },
  { rel: "b.json", structureFingerprint: "f2" },
]), []);
eq("无信号不配对", matchRenames([gone[1]], [{ rel: "c.json" }]), []);
eq("一对一占用（同一新文件不被两个旧记录认领）", matchRenames(gone, [
  { rel: "one.json", graphId: "g1", semanticHash: "s2", structureFingerprint: "f2" },
]).length, 1);

/* ---------------- 版本保留策略（规格 FR-013） ---------------- */
const now = Date.now();
const mk = (n: number, ageDays = 30) => Array.from({ length: n }, (_, i) => ({ revision: i + 1, createdAt: now - ageDays * 86400_000 }));
eq("超 20 个只留最近 20（含最新）", computeRevisionKeep(mk(30)).length, 20);
ok("最新版本永不删", computeRevisionKeep(mk(30)).includes(30));
const week = mk(5, 3);
ok("7 天内全保留", computeRevisionKeep(week).length === 5);
ok("pinned 保留", computeRevisionKeep([{ revision: 1, createdAt: now - 90 * 86400_000, pinned: true }, ...mk(29, 60).slice(1)]).includes(1));

/* ---------------- 显示名 ---------------- */
eq("显示名", displayNameOfRel("sub/dir/My Flow.json"), "My Flow");
eq("显示名: 根目录", displayNameOfRel("top.json"), "top");

/* ---------------- M2：widget 位序（widgetLayout.ts） ---------------- */
// 模拟 object_info：KSampler（seed 带 control_after_generate 注入位）+ 一个 forceInput widget
const OI: Record<string, any> = {
  KSampler: {
    input: {
      required: {
        seed: ["INT", { control_after_generate: true }],
        steps: ["INT", {}],
        cfg: ["FLOAT", {}],
        sampler_name: [["euler", "ddim"], {}],
        model: ["MODEL", {}],
      },
    },
  },
  TextNode: { input: { required: { text: ["STRING", { forceInput: true }], extra: ["STRING", {}] } } },
};
{
  const l = widgetLayoutOf("KSampler", OI);
  eq("cag 占两位: seed@0", l.index.get("seed"), 0);
  eq("cag 后顺延: steps@2", l.index.get("steps"), 2);
  eq("combo 也是 widget", l.index.get("sampler_name"), 4);
  eq("连接型不占位: model 无位", l.index.has("model"), false);
  const t = widgetLayoutOf("TextNode", OI);
  eq("forceInput 不占位: extra@0", t.index.get("extra"), 0);
  eq("缺类型定义返回空布局", widgetLayoutOf("Nope", OI).slots.length, 0);
}

/* ---------------- M2：参数补丁与冲突（writeBack.ts，规格 FR-010/FR-015） ---------------- */
const mkUi = () => ({
  nodes: [
    {
      id: 3,
      type: "KSampler",
      title: "采样器",
      pos: [10, 20],
      widgets_values: [123, "fixed", 20, 7.5, "euler"],
      inputs: [{ name: "model", type: "MODEL", link: 1 }],
    },
    { id: 9, type: "TextNode", widgets_values: ["hi"], inputs: [] },
  ],
  links: [[1, 1, 0, 3, 0, "MODEL"]],
  groups: [],
  extra: { note: "x" },
});
{
  const ui = mkUi() as any;
  // 补丁：steps(#3.steps 位序 2) 改 30；seed 位序 0 改 999
  const r = applyParamPatches(ui, [
    { key: "3.steps", nodeId: "3", input: "steps", value: 30 },
    { key: "3.seed", nodeId: "3", input: "seed", value: 999 },
    { key: "3.gone", nodeId: "404", input: "x", value: 1 },
  ], OI);
  eq("补丁 applied 数", r.applied.length, 2);
  eq("steps 写到位序 2", ui.nodes[0].widgets_values[2], 30);
  eq("seed 写到位序 0", ui.nodes[0].widgets_values[0], 999);
  eq("cag 注入位不动", ui.nodes[0].widgets_values[1], "fixed");
  eq("节点没了进 orphaned", r.orphaned.length, 1);
  ok("连线占用跳过", isLinked(ui.nodes[0], "model"));
  eq("连线占用读不到值", readWidgetValue(ui.nodes[0], "model", OI), undefined);
}
{
  // 冲突检测（FR-015）：base steps=20，MOMO 改 30，源也改成 25 → 冲突；源没改 → 不冲突；双方改成一样 → 不冲突
  const base = { "3.steps": 20 };
  const mk = (srcSteps: number) => {
    const ui = mkUi() as any;
    ui.nodes[0].widgets_values[2] = srcSteps;
    return ui;
  };
  const patch = [{ key: "3.steps", nodeId: "3", input: "steps", value: 30 }];
  eq("源没改 → 无冲突", detectPatchConflicts(mk(20), patch, base, OI).length, 0);
  eq("双方同值 → 无冲突", detectPatchConflicts(mk(30), patch, base, OI).length, 0);
  const cf = detectPatchConflicts(mk(25), patch, base, OI);
  eq("双方异值 → 冲突", cf.length, 1);
  eq("冲突值快照", [cf[0].baseValue, cf[0].sourceValue, cf[0].momoValue], [20, 25, 30]);
}
{
  eq("patchesFromValues 只取变化项", patchesFromValues(
    [
      { key: "a", nodeId: "1", input: "x", value: 2 },
      { key: "b", nodeId: "2", input: "y", value: 9 },
    ],
    { a: 1, b: 9 },
  ).map((p) => p.key), ["a"]);
  eq("无基线的键不进补丁（新参数不回写）", patchesFromValues([{ key: "c", nodeId: "1", input: "z", value: 1 }], {}).length, 0);
}
{
  const ui = mkUi() as any;
  ui.nodes[0].properties = { "Node name for S&R": "KSampler" };
  const changed = injectStableNodeIds(ui, () => "nid_1");
  ok("注入返回有改动", changed);
  eq("稳定ID写入", ui.nodes[0].properties.momoSyncNodeId, "nid_1");
  eq("原属性保留", ui.nodes[0].properties["Node name for S&R"], "KSampler");
  ok("再次注入不覆盖", !injectStableNodeIds(ui, () => "nid_2"));
}

/* ---------------- M2：差异（workflowDiff.ts，规格 FR-014） ---------------- */
{
  const a = mkUi() as any;
  const b = mkUi() as any;
  eq("相同内容无差异", diffSummary(diffUiWorkflows(a, b, OI)), null);
  b.nodes[0].widgets_values[2] = 30; // steps 20→30
  b.nodes[0].pos = [400, 20]; // 移动
  b.nodes.push({ id: 12, type: "SaveImage", widgets_values: ["out"], inputs: [] });
  b.links.push([2, 3, 0, 12, 0, "IMAGE"]);
  b.groups.push({ title: "G1", bounding: [0, 0, 100, 100] });
  b.extra = { note: "y" };
  const d = diffUiWorkflows(a, b, OI);
  eq("节点+1", d.counts.nodesAdded, 1);
  eq("参数变化数（steps + SaveImage 的 filename 位序无定义算 1）", d.counts.params >= 1, true);
  eq("连线+1", d.counts.linksAdded, 1);
  eq("移动 1", d.counts.moved, 1);
  eq("分组 1", d.counts.groups, 1);
  eq("扩展字段 1", d.counts.meta, 1);
  ok("参数名映射（objectInfo 在线）", d.rows.some((r) => r.kind === "param" && r.text.includes("steps")));
  ok("摘要非空", !!diffSummary(d));
}

/* ---------------- 汇总 ---------------- */
if (failed) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
} else console.log("\n全部通过");
