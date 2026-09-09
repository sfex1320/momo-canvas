/**
 * H3 六段式纯解析（3.5 P3）—— 零依赖模块，供 node 直跑快测与 h3Bilingual 复用。
 * 双稿配对（pairBilingualDocs）与中文稿校验（validateZhAgainstEn）也在这里：纯函数、按稳定键配对，
 * 中间缺一段不会把后续全部错配。
 */
import type { DirectorSegment, H3BilingualPrompt, H3PromptLanguageData } from "../types";
import { collectSegmentMarks, parseSegmentTitle, segmentKeyOfTitle } from "../segmentParse.ts";

/** 已知的六段式小节键（中英文稿都可能出现；顺序不敏感，未知的归 _rest） */
const SECTION_KEYS = [
  "subject_definitions",
  "summary",
  "retention_analysis",
  "detailed_description",
  "overall_soundscape",
  "non_diegetic_music",
] as const;

/** 按小节键切正文：返回 key → 内容（未匹配键的内容留在 _rest） */
function splitSections(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = body.split(/\r?\n/);
  let cur = "_rest";
  for (const ln of lines) {
    const inline = ln.match(/^(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music)\s*:\s*(.*)$/i);
    if (inline && (SECTION_KEYS as readonly string[]).includes(inline[1].toLowerCase())) {
      cur = inline[1].toLowerCase();
      if (inline[2].trim()) out[cur] = (out[cur] ?? "") + inline[2] + "\n";
      continue;
    }
    out[cur] = (out[cur] ?? "") + ln + "\n";
  }
  for (const k of Object.keys(out)) out[k] = out[k].trim();
  return out;
}

/** `<d>[语言]台词</d>` 对白提取（中英文稿都必须保留原文，不翻译） */
export function extractDialogue(text: string): string[] {
  return [...text.matchAll(/<d>(?:\[[^\]]*\])?([^<]+)<\/d>/g)]
    .map((m) => m[1].trim())
    .filter(Boolean);
}

/** 衔接模式声明：衔接模式：opening/开篇 | continuity_relay/同场接力 | hard_cut/硬切 */
export function extractContinuityMode(text: string): H3PromptLanguageData["continuityMode"] {
  const m = text.match(/(?:衔接模式|continuity[_ ]?mode)\s*[:：]\s*(opening|开篇|continuity[_ ]?relay|同场接力|hard[_ ]?cut|硬切)/i);
  if (!m) return undefined;
  const v = m[1].toLowerCase();
  if (/opening|开篇/.test(v)) return "opening";
  if (/relay|接力/.test(v)) return "continuity_relay";
  if (/hard|硬切/.test(v)) return "hard_cut";
  return undefined;
}

type SubjectKind = "character" | "scene" | "prop";

/**
 * 官方 H3 的 Subject 编号只表示本段内的复用标签，不携带人物/场景/道具类型。
 * 类型优先从定义正文判断；数字区间仅用于兼容 3.5 之前的历史项目包。
 */
function subjectKindOf(line: string, subjectNo: number): SubjectKind {
  const text = line.toLowerCase();
  const explicitScene = /\b(?:scene|environment|location|setting|interior|exterior)\b|(?:场景|环境|地点|室内|室外|空景)/i;
  const explicitProp = /\b(?:prop|object|item|weapon|key|wafer|device|baton)\b|(?:道具|物件|物体|武器|钥匙|晶体|薄片|设备|伸缩棍)/i;
  const explicitCharacter = /\b(?:character|person|man|woman|courier|doctor|hacker|enforcer|officer)\b|(?:人物|角色|男人|女人|男性|女性|快递员|医生|黑客|执行官)/i;
  if (explicitScene.test(text)) return "scene";
  if (explicitProp.test(text)) return "prop";
  if (explicitCharacter.test(text)) return "character";
  if (subjectNo >= 20) return "prop";
  if (subjectNo >= 10) return "scene";
  return "character";
}

/** 从 subject_definitions 接受官方无项目符号格式，也兼容旧版 `- 名称 <Subject N>:`。 */
function parseSubjectDefinitions(section: string): Array<{ no: number; line: string; kind: SubjectKind }> {
  const out: Array<{ no: number; line: string; kind: SubjectKind }> = [];
  for (const raw of section.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*]\s+/, "");
    if (!line) continue;
    const hit = line.match(/<Subject\s+(\d+)\s*>/i);
    if (!hit) continue;
    const no = Number(hit[1]);
    if (!Number.isFinite(no) || no < 1) continue;
    out.push({ no, line, kind: subjectKindOf(line, no) });
  }
  return out;
}

/** 解析一段 H3 提示词正文为结构化数据（六段式 + 对白 + 接力 + 空间锁 + Purpose） */
export function parseH3PromptBody(body: string, fallbackTitle = ""): H3PromptLanguageData {
  const sections = splitSections(body);
  const full = body.trim();

  // Subject 编号是本段局部标签；人物/场景/道具按定义语义归类。
  const chars: string[] = [];
  const scene: string[] = [];
  const props: string[] = [];
  const refOrder: string[] = [];
  for (const def of parseSubjectDefinitions(sections.subject_definitions ?? "")) {
    if (def.kind === "prop") props.push(def.line);
    else if (def.kind === "scene") scene.push(def.line);
    else chars.push(def.line);
  }

  // 参考顺序只记录真实上传槽；Subject 是内容标签，不是上传槽。
  for (const m of full.matchAll(/(<(?:Picture|Video|Audio)\s+\d+>|RefImg\d+[^\s，。;；,.)】]*|\b[\w\u4e00-\u9fa5-]+\.(?:png|jpe?g|webp|mp4|mov|webm|mp3|wav|m4a))/gi)) {
    if (!refOrder.includes(m[1])) refOrder.push(m[1]);
  }

  const dialogue = extractDialogue(full);
  const continuityMode = extractContinuityMode(full);
  const purpose =
    full.match(/^\s*\*\*Purpose\*\*\s*[:：]?\s*(.+)$/im)?.[1]?.trim() ??
    full.match(/^\s*(?:目的|用途|Purpose)\s*[:：]\s*(.+)$/im)?.[1]?.trim() ??
    undefined;
  const continuityIn =
    full.match(/^\s*(?:承接上段|接力进入|continuity[_ ]?(?:bridge[_ ]?)?in|进入状态)\s*[:：]\s*(.+)$/im)?.[1]?.trim() ??
    undefined;
  const continuityOut =
    full.match(/^\s*(?:结束状态|本段结束|continuity[_ ]?(?:bridge[_ ]?)?out|结束时的状态)\s*[:：]\s*(.+)$/im)?.[1]?.trim() ??
    undefined;
  const spatialLock =
    full.match(/^\s*(?:空间锁|空间站位说明|spatial[_ ]?lock)\s*[:：]\s*(.+)$/im)?.[1]?.trim() ??
    (sections.retention_analysis?.match(/(?:空间锁|spatial lock)[:：]\s*([^\n]+)/i)?.[1]?.trim() ?? undefined);
  const camera =
    full.match(/^\s*(?:镜头|相机路径|camera(?:\s*path)?)\s*[:：]\s*(.+)$/im)?.[1]?.trim() ??
    (sections.detailed_description?.match(/\b(?:camera|镜头)\s*[:：]\s*([^\n.]{4,80})/i)?.[1]?.trim() ?? undefined);

  const title =
    fallbackTitle ||
    full.match(/^#{1,4}\s*(.+)$/m)?.[1]?.trim() ||
    sections.summary?.split(/[。.\n]/)[0]?.slice(0, 30) ||
    "";

  return {
    title,
    purpose,
    continuityMode,
    continuityIn,
    continuityOut,
    spatialLock,
    referenceOrder: refOrder.length ? refOrder : undefined,
    characters: chars.length ? chars.join("\n") : undefined,
    scene: scene.length ? scene.join("\n") : undefined,
    props: props.length ? props.join("\n") : undefined,
    dialogue: dialogue.length ? dialogue : undefined,
    camera,
    promptBody: full,
  };
}

/* ---------------- 双稿配对（§4.4 · 稳定键） ---------------- */

export type BilingualPair = {
  /** 键（段号归一；顺序后备时为 `#序号`） */
  key: string;
  index: number;
  title: string;
  durationSec?: number;
  zh?: string;
  en?: string;
  warnings: string[];
};

type SplitPart = { key: string | null; title: string; body: string; durationSec?: number; order: number };

/** 切文档成段（collectSegmentMarks 边界），每段提取稳定键（H3-01 / 第03分段 / 01-标题-11秒 序号） */
function splitByKey(doc: string): SplitPart[] {
  const t = doc.trim();
  const marks = collectSegmentMarks(t);
  if (!marks.length) return [{ key: null, title: "", body: t, durationSec: undefined, order: 0 }];
  return marks.map((start, i) => {
    const raw = t.slice(start, i + 1 < marks.length ? marks[i + 1] : t.length).trim();
    const titleLine = raw.split("\n").find((l) => l.trim()) ?? "";
    const head = parseSegmentTitle(titleLine);
    return {
      key: segmentKeyOfTitle(titleLine),
      title: head.title ?? titleLine.slice(0, 30),
      body: raw,
      durationSec: head.durationSec,
      order: i,
    };
  });
}

/**
 * 按稳定键配对中英文分段（3.5 P1 修复：不再按下标配对——中间缺一段会让后续全部错配）。
 * 键优先级：显式段号（H3-01/第01分段/01-裸标题）> 顺序后备（仅当两侧全部无编号时）。
 * 检测并报告：中文缺段 / 英文缺段 / 重复编号 / 时长冲突 / 对白冲突；有冲突的 pair 不算配对成功。
 */
export function pairBilingualDocs(zhDoc: string, enDoc: string): { pairs: BilingualPair[]; warnings: string[] } {
  const zhParts = splitByKey(zhDoc);
  const enParts = splitByKey(enDoc);
  const warnings: string[] = [];

  // 重复编号检测（同侧两个段同键 → 键不可靠，退化为顺序配对）
  const dupOf = (parts: SplitPart[], label: string): boolean => {
    const seen = new Set<string>();
    let dup = false;
    for (const p of parts) {
      if (p.key === null) continue;
      if (seen.has(p.key)) {
        warnings.push(`${label}存在重复段号 ${p.key}——该侧退化为顺序配对`);
        dup = true;
      }
      seen.add(p.key);
    }
    return dup;
  };
  const zhDup = dupOf(zhParts, "中文稿");
  const enDup = dupOf(enParts, "英文稿");
  const zhKeyed = !zhDup && zhParts.length > 0 && zhParts.every((p) => p.key !== null);
  const enKeyed = !enDup && enParts.length > 0 && enParts.every((p) => p.key !== null);

  const pairs: BilingualPair[] = [];
  if (zhKeyed && enKeyed) {
    // 两侧都有完整编号：按键配对，缺一侧明确留空。
    // 主序 = 英文文档顺序（与 importPromptSegments 的切段顺序严格一致，pairs[i] 即第 i 段），
    // 中文侧多出的段（英文缺段）按文档顺序排在后面。
    const zhMap = new Map(zhParts.map((p) => [p.key as string, p]));
    const enKeys = new Set(enParts.map((p) => p.key as string));
    for (const en of enParts) {
      pairs.push(makePair(en.key as string, en.order + 1, zhMap.get(en.key as string), en));
    }
    const zhOnly = zhParts.filter((p) => !enKeys.has(p.key as string));
    for (const zh of zhOnly) {
      pairs.push(makePair(zh.key as string, zh.order + 1, zh, undefined));
    }
    if (zhOnly.length) {
      warnings.push(`英文稿缺 ${zhOnly.length} 段（中文侧多出：段号 ${zhOnly.map((p) => p.key).join("/")}）——保持未配对`);
    }
    const enMissing = enParts.filter((p) => !zhMap.has(p.key as string)).length;
    if (enMissing) {
      warnings.push(`中文稿缺 ${enMissing} 段——对应英文段保持未配对`);
    }
    return { pairs, warnings };
  }

  // 顺序后备（任一侧无编号 / 编号重复）：长度对齐按序配对，多余侧留空
  if (zhParts.length !== enParts.length) {
    warnings.push(`分段数不一致：中文 ${zhParts.length} 段 / 英文 ${enParts.length} 段——多出的一侧保持未配对`);
  }
  const n = Math.max(zhParts.length, enParts.length);
  for (let i = 0; i < n; i++) {
    const zh = zhParts[i];
    const en = enParts[i];
    const key = en?.key ?? zh?.key ?? String(i + 1);
    pairs.push(makePair(key, i + 1, zh, en));
  }
  return { pairs, warnings };
}

function makePair(key: string, index: number, zh: SplitPart | undefined, en: SplitPart | undefined): BilingualPair {
  const pw: string[] = [];
  if (!zh || !en) {
    pw.push(zh ? "缺英文侧" : "缺中文侧");
  } else {
    if (zh.durationSec && en.durationSec && zh.durationSec !== en.durationSec) pw.push(`时长不一致（中 ${zh.durationSec}s / 英 ${en.durationSec}s）`);
    const zd = extractDialogue(zh.body);
    const ed = extractDialogue(en.body);
    if (zd.length !== ed.length) pw.push(`对白句数不一致（中 ${zd.length} / 英 ${ed.length}）`);
    else if (zd.some((d, k) => d !== ed[k])) pw.push("对白原文存在差异——必须逐字一致");
  }
  const pair: BilingualPair = {
    key,
    index,
    title: (zh?.title || en?.title || `分段 ${index}`).trim(),
    durationSec: en?.durationSec ?? zh?.durationSec,
    zh: zh?.body,
    en: en?.body,
    warnings: pw,
  };
  return pair;
}

/* ---------------- 应用到片段 ---------------- */

/** 解析结果 → 片段补丁（对白/接力/空间锁进结构化字段；英文执行稿进 h3Prompt.en） */
export function h3PatchForSegment(enBody: string, zhBody: string | undefined, fallbackTitle: string): Partial<DirectorSegment> {
  const en = parseH3PromptBody(enBody, fallbackTitle);
  const zh = zhBody ? parseH3PromptBody(zhBody, fallbackTitle) : undefined;
  const h3: H3BilingualPrompt = {
    en,
    ...(zh ? { zh } : {}),
    source: "paired-files",
    syncStatus: zh ? "synced" : "en-newer",
    generatedAt: Date.now(),
  };
  return {
    dialogue: en.dialogue ?? [],
    ...(en.continuityIn ? { continuityIn: en.continuityIn } : {}),
    ...(en.continuityOut ? { continuityOut: en.continuityOut } : {}),
    promptOverride: en.promptBody,
    h3Prompt: h3,
    locked: true,
    locks: { structure: true, reviewZh: false, executionEn: false },
  };
}

/* ---------------- 中文审阅稿校验（§5.3 路径 3） ---------------- */

/**
 * 中文审阅稿生成后的一致性校验（纯函数）：对白必须逐字一致（含语言、标点、顺序），
 * 时长/结构（六段式小节齐备）也核对。返回问题清单——空数组才允许标 synced。
 */
export function validateZhAgainstEn(zhBody: string, enBody: string, enDurationSec?: number, zhDurationSec?: number): string[] {
  const problems: string[] = [];
  const zd = extractDialogue(zhBody);
  const ed = extractDialogue(enBody);
  if (zd.length !== ed.length) {
    problems.push(`对白句数不一致（中 ${zd.length} / 英 ${ed.length}）`);
  } else {
    for (let i = 0; i < zd.length; i++) {
      if (zd[i] !== ed[i]) problems.push(`第 ${i + 1} 句对白被改：原文「${ed[i].slice(0, 30)}」→ 生成稿「${zd[i].slice(0, 30)}」`);
    }
  }
  const secs = (t: string) => (["subject_definitions", "summary", "detailed_description"] as const).filter((k) => !t.includes(k));
  const missing = secs(zhBody);
  if (missing.length) problems.push(`中文稿缺结构小节：${missing.join("/")}`);
  if (enDurationSec && zhDurationSec && enDurationSec !== zhDurationSec) problems.push(`时长不一致（中 ${zhDurationSec}s / 英 ${enDurationSec}s）`);
  return problems;
}
