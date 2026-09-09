/**
 * h3BilingualCore 纯函数快测（node --experimental-strip-types 直跑；零依赖模块）
 * 3.5 P1 补充：pairBilingualDocs 稳定键配对（缺段/乱序/重复编号/时长与对白冲突）+ validateZhAgainstEn 中文稿校验
 */
import { parseH3PromptBody, extractDialogue, extractContinuityMode, pairBilingualDocs, validateZhAgainstEn } from "./h3BilingualCore.ts";

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failed++;
    console.error(`✗ ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  } else console.log(`✓ ${name}`);
};

const LEGACY_EN = [
  "subject_definitions:",
  "- 宁采臣 <Subject 1>: 白衣书生，眉目清朗",
  "- 聂小倩 <Subject 2>: 素衣女鬼",
  "- 兰若寺大殿 <Subject 10>: 幽暗佛殿",
  "- 金钵 <Subject 20>: 黄铜法器",
  "summary: 三十字内的本段摘要",
  "retention_analysis: 延续上段的雨夜氛围",
  "detailed_description: 宁采臣推门而入。camera: 缓慢推近。 <d>[中文]姑娘为何独自在此？</d> <d>[中文]公子莫问。</d>",
  "overall_soundscape: 雨声与木鱼",
  "non_diegetic_music: N/A",
].join("\n");

const r = parseH3PromptBody(LEGACY_EN, "雨夜古寺");
eq("旧版兼容:人物编号", r.characters, "宁采臣 <Subject 1>: 白衣书生，眉目清朗\n聂小倩 <Subject 2>: 素衣女鬼");
eq("旧版兼容:场景编号", r.scene, "兰若寺大殿 <Subject 10>: 幽暗佛殿");
eq("旧版兼容:道具编号", r.props, "金钵 <Subject 20>: 黄铜法器");
eq("对白提取", r.dialogue, ["姑娘为何独自在此？", "公子莫问。"]);
eq("相机", /缓慢推近/.test(r.camera ?? ""), true);
eq("summary 兜底标题", parseH3PromptBody(LEGACY_EN).title, "三十字内的本段摘要");

const OFFICIAL_EN = [
  "subject_definitions:",
  "<Subject 1> is the vertical maintenance-shaft environment shown in <Picture 1>, with the west platform screen-left and the ladder screen-right.",
  "<Subject 2> is Mira, the female courier character shown in <Picture 2>.",
  "<Subject 3> is Ash, the male doctor character shown in <Picture 3>.",
  "<Subject 4> is K-9, the male corporate enforcer character shown in <Picture 4>.",
  "<Subject 5> is the single triangular key prop shown in <Picture 5>.",
  "<Picture 6> is a spatial-planning reference for geometry only.",
  "summary:",
  "Mira falls while Ash catches the cable.",
  "retention_analysis:",
  "Preserve each referenced identity and the non-mirrored environment geometry.",
  "detailed_description:",
  "Continuity mode: hard_cut. [Shot 1] At 00:01.250, <Subject 2> shouts (S1) <d>[Chinese]抓住绳子！</d>.",
  "overall_soundscape:",
  "Cable strain and rain.",
  "non_diegetic_music:",
  "Low electronic pulse.",
].join("\n");

const official = parseH3PromptBody(OFFICIAL_EN, "坠井");
eq("官方格式:无项目符号场景", official.scene?.startsWith("<Subject 1> is the vertical maintenance-shaft environment"), true);
eq("官方格式:紧凑编号人物", official.characters?.split("\n").length, 3);
eq("官方格式:紧凑编号道具", official.props?.startsWith("<Subject 5> is the single triangular key prop"), true);
eq("官方格式:真实参考槽", official.referenceOrder, ["<Picture 1>", "<Picture 2>", "<Picture 3>", "<Picture 4>", "<Picture 5>", "<Picture 6>"]);
eq("官方格式:语言标签对白", official.dialogue, ["抓住绳子！"]);

eq("对白提取器", extractDialogue("前文 <d>[中文]你好</d> 中间 <d>[EN]Hello</d>"), ["你好", "Hello"]);
eq("衔接-开篇", extractContinuityMode("衔接模式：opening/开篇"), "opening");
eq("衔接-接力", extractContinuityMode("continuity_mode: continuity_relay"), "continuity_relay");
eq("衔接-硬切", extractContinuityMode("衔接模式：hard_cut/硬切"), "hard_cut");
eq("衔接-未声明", extractContinuityMode("正文没有声明"), undefined);

// 六段式之外的补充行
const r2 = parseH3PromptBody("**Purpose**: 深夜初遇\n承接上段：雨中赶路后抵达\n结束状态：二人对视\n空间锁：佛像居左，门在右\n<d>[中文]台词甲</d>");
eq("Purpose", r2.purpose, "深夜初遇");
eq("承接上段", r2.continuityIn, "雨中赶路后抵达");
eq("结束状态", r2.continuityOut, "二人对视");
eq("空间锁", r2.spatialLock, "佛像居左，门在右");

/* ---------------- pairBilingualDocs 稳定键配对（3.5 P1） ---------------- */

const seg = (no: number, title: string, dur: number, body: string) => `## H3-${String(no).padStart(2, "0")}｜${title}｜${dur}秒\n${body}`;
const mkZh = (n: number) => seg(n, `段${n}`, 11, `中文正文${n} <d>[中文]第${n}段台词</d>`);
const mkEn = (n: number) => seg(n, `段${n}`, 11, `english body ${n} <d>[中文]第${n}段台词</d>`);

// 基础：三对三，干净配对
const okPair = pairBilingualDocs([1, 2, 3].map(mkZh).join("\n\n"), [1, 2, 3].map(mkEn).join("\n\n"));
eq("配对:段数", okPair.pairs.length, 3);
eq("配对:无警告", okPair.warnings.length, 0);
eq("配对:双侧齐", okPair.pairs.every((p) => p.zh && p.en), true);
eq("配对:无差异", okPair.pairs.every((p) => p.warnings.length === 0), true);

// 中间缺一段（中文缺第 2 段）：后续不能错位——第 3 段必须配第 3 段
const missPair = pairBilingualDocs([mkZh(1), mkZh(3)].join("\n\n"), [1, 2, 3].map(mkEn).join("\n\n"));
eq("缺段:中文缺段警告", missPair.warnings.some((w) => /中文稿缺 1 段/.test(w)), true);
eq("缺段:H3-03 配中文三", /中文正文3/.test(missPair.pairs.find((p) => p.key === "3")?.zh ?? ""), true);
eq("缺段:H3-03 无差异", missPair.pairs.find((p) => p.key === "3")?.warnings.length, 0);
eq("缺段:H3-02 缺中文侧", missPair.pairs.find((p) => p.key === "2")?.warnings.includes("缺中文侧"), true);

// 顺序打乱（英文 03 在 01 前）：按编号配对，主序随英文文档
const shufPair = pairBilingualDocs([1, 2, 3].map(mkZh).join("\n\n"), [mkEn(3), mkEn(1), mkEn(2)].join("\n\n"));
eq("乱序:H3-01 配中文一", /中文正文1/.test(shufPair.pairs.find((p) => p.key === "1")?.zh ?? ""), true);
eq("乱序:H3-03 配中文三", /中文正文3/.test(shufPair.pairs.find((p) => p.key === "3")?.zh ?? ""), true);
eq("乱序:主序随英文文档", shufPair.pairs.map((p) => p.key), ["3", "1", "2"]);

// 重复编号：键不可靠 → 警告 + 退化顺序配对
const dupPair = pairBilingualDocs([mkZh(1), seg(1, "段1b", 11, "中文一b <d>[中文]一b</d>")].join("\n\n"), [1, 2].map(mkEn).join("\n\n"));
eq("重复:警告", dupPair.warnings.some((w) => /重复段号/.test(w)), true);
eq("重复:退化顺序配对", dupPair.pairs.length, 2);

// 时长冲突 / 对白冲突：pair.warnings 标记，不算干净配对
const durPair = pairBilingualDocs(seg(1, "段1", 12, "中文一 <d>[中文]一</d>"), seg(1, "段1", 11, "english one <d>[中文]一</d>"));
eq("时长冲突", durPair.pairs[0].warnings.some((w) => /时长不一致/.test(w)), true);
const dialPair = pairBilingualDocs(seg(1, "段1", 11, "中文一 <d>[中文]被改了</d>"), seg(1, "段1", 11, "english one <d>[中文]一</d>"));
eq("对白冲突", dialPair.pairs[0].warnings.some((w) => /对白原文存在差异/.test(w)), true);

// 「# 第N分段」中文编号与「01-标题-11秒」裸标题编号互通
const cnPair = pairBilingualDocs("# 第一分段\n段甲\n\n# 第二分段\n段乙", "01-段甲-11秒\nenglish A\n\n02-段乙-11秒\nenglish B");
eq("编号互通", cnPair.pairs.filter((p) => p.zh && p.en).length, 2);

/* ---------------- validateZhAgainstEn：中文生成稿改了对白不能过 ---------------- */

const enBody = "subject_definitions:\n- A <Subject 1>: x\nsummary: s\ndetailed_description: d <d>[中文]你好</d> <d>[中文]再见</d>";
// 中文审阅稿保持英文小节 key（六段式结构标签），只有内容是中文——这是 generateZhReview 的合同
const zhOk = "subject_definitions:\n- 甲 <Subject 1>: 某某\nsummary: 摘要\ndetailed_description: 描述 <d>[中文]你好</d> <d>[中文]再见</d>";
eq("校验:结构对齐+对白一致通过", validateZhAgainstEn(zhOk, enBody), []);
eq(
  "校验:改对白不通过",
  validateZhAgainstEn("subject_definitions:\nsummary: s\ndetailed_description: d <d>[中文]你好</d> <d>[中文]改了</d>", enBody).some((p) => /第 2 句对白被改/.test(p)),
  true,
);
eq("校验:句数不一致", validateZhAgainstEn("subject_definitions:\nsummary: s\ndetailed_description: d <d>[中文]你好</d>", enBody).some((p) => /句数不一致/.test(p)), true);
eq("校验:缺结构小节", validateZhAgainstEn("正文", enBody).some((p) => /缺结构小节/.test(p)), true);
eq("校验:时长冲突", validateZhAgainstEn(enBody, enBody, 11, 12).some((p) => /时长不一致/.test(p)), true);

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
