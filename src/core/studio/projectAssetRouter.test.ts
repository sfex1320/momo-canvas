/**
 * 项目产物路由测试（node --experimental-strip-types 直跑）
 * 覆盖（3.5 P1 §3.5）：路由表目录名（真实片段编号+标题，不退化成项目名）/ 多项目镜像账本 / 非分段类别。
 */
import { relDirFor, planMirror } from "./projectAssetRouter.ts";
import type { AssetItem, DirectorProject } from "../types.ts";

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failed++;
    console.error(`✗ ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  } else console.log(`✓ ${name}`);
};
const ok = (name: string, v: boolean) => eq(name, v, true);

/* 路由表：目录名必须用真实片段编号与标题 */
eq("路由:take", relDirFor("take", 3, "古刹闻客"), "分段资产库/03_古刹闻客/Takes");
eq("路由:relay", relDirFor("relay", 12, "雪夜孤灯"), "分段资产库/12_雪夜孤灯/接力");
eq("路由:audio(分段)", relDirFor("audio", 1, "开场"), "分段资产库/01_开场/音频");
eq("路由:post", relDirFor("post", 7, "对峙"), "分段资产库/07_对峙/后处理");
eq("路由:audio(项目级)", relDirFor("audio", 0, ""), "音频");
eq("路由:character", relDirFor("character", 0, ""), "全部素材/人物");
eq("路由:scene", relDirFor("scene", 0, ""), "全部素材/场景");
eq("路由:prop", relDirFor("prop", 0, ""), "全部素材/道具");
eq("路由:image", relDirFor("image", 0, ""), "全部素材/AI制图");
eq("路由:mv", relDirFor("mv", 0, ""), "AI MV");
eq("路由:export", relDirFor("export", 0, ""), "成片");
eq("路由:标题清洗", relDirFor("take", 2, '坏名字/含:非法*字符?'), "分段资产库/02_坏名字_含_非法_字符_/Takes");
// take 没有片段号 → 不路由（绝不落成 00_项目名 的伪分段目录）
eq("路由:take 无片段号不路由", relDirFor("take", 0, "某项目"), null);
eq("路由:relay 无片段号不路由", relDirFor("relay", 0, "某项目"), null);

/* planMirror：多项目镜像账本 */
const proj = (id: string, root: string): DirectorProject =>
  ({ id, workspace: { mode: "linked", rootPath: root, manifestPath: root, status: "ready", writePolicy: "copy-into-project" } }) as never as DirectorProject;
const asset = (over: Partial<AssetItem> = {}): AssetItem =>
  ({ id: "ast1", kind: "video", path: "G:/assets/x.mp4", createdAt: 1700000000000, ...over }) as never as AssetItem;

const segsCount = 5;
const scenes = Array.from({ length: segsCount }, (_, i) => ({ id: "sc" + i, location: "", segments: [{ id: "sg" + (i + 1), sceneId: "sc" + i, durationSec: 10, summary: "", dialogue: [], shots: [], approvedTakeId: null, takes: [] }] }));
const projWithSegs = (id: string, root: string) => ({ ...proj(id, root), scenes }) as never as DirectorProject;

// 未绑定 → 不路由
eq("镜像:未绑定不路由", planMirror(undefined, asset(), { category: "take" }), null);
// 托管（mode:managed）→ 不路由
eq("镜像:managed 不路由", planMirror({ ...proj("p", "G:/x"), workspace: { mode: "managed", rootPath: "", manifestPath: "", status: "ready", writePolicy: "copy-into-project" } } as never, asset(), { category: "take" }), null);
// 离线 → 不路由
eq("镜像:missing 不路由", planMirror(({ ...proj("p", "G:/x"), workspace: { mode: "linked", rootPath: "G:/x", manifestPath: "G:/x", status: "missing", writePolicy: "copy-into-project" } }) as never, asset(), { category: "take" }), null);
// dataURL/blob 资产不路由（还没落盘）
eq("镜像:dataURL 不路由", planMirror(projWithSegs("p", "G:/projA"), asset({ path: "data:video/mp4;base64,xxx" }), { category: "take", segmentId: "sg3" }), null);

// 正常：分段 3 → 分段资产库/03_xxx/Takes，文件名带类别前缀
const planA = planMirror(projWithSegs("pA", "G:/projA"), asset(), { category: "take", segmentId: "sg3", segTitle: "古刹闻客" });
ok("镜像:目录", !!planA && planA.dir.replace(/\\/g, "/").endsWith("分段资产库/03_古刹闻客/Takes"));
ok("镜像:文件名带类别", !!planA && planA.name.startsWith("take_"));
ok("镜像:文件名带扩展", !!planA && planA.name.endsWith(".mp4"));

// 同一资产已被项目 A 镜像（projectMirrors 账本）：项目 B 仍可各自路由，项目 A 不重复
const mirrored = asset({ projectMirrors: { pA: "G:/projA/分段资产库/03_古刹闻客/Takes/take_x.mp4" } });
eq("镜像:A 已写过不重复", planMirror(projWithSegs("pA", "G:/projA"), mirrored, { category: "take", segmentId: "sg3", segTitle: "古刹闻客" }), null);
const planB = planMirror(projWithSegs("pB", "G:/projB"), mirrored, { category: "take", segmentId: "sg3", segTitle: "古刹闻客" });
ok("镜像:B 不被 A 覆盖", !!planB && planB.dir.startsWith("G:/projB"));
// 旧数据兼容：只有 projectRelPath 指向本项目
eq("镜像:旧字段兼容", planMirror(projWithSegs("pA", "G:/projA"), asset({ projectRelPath: "G:/projA/old.mp4" }), { category: "take", segmentId: "sg1" }), null);
// 旧 projectRelPath 指向别的项目 → 本项目照常路由
ok("镜像:旧字段属他项目仍路由", !!planMirror(projWithSegs("pB", "G:/projB"), asset({ projectRelPath: "G:/projA/old.mp4" }), { category: "take", segmentId: "sg1" }));

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
