/**
 * 剧本深解析器（3.4）—— 拖入/导入剧本时不只看文件名，而是把内容里的信息全部读出来：
 *  文档级：三态类型（成品提示词包 / 已分段脚本 / 完整剧本）、前言主标题（自动命名第一优先级）、
 *          全局风格、分段数、总时长；
 *  分段级：分段名、时长、衔接模式（开篇/同场接力/硬切）、模型与工作流线索、
 *          提示词围栏与字数、<Picture/Video/Audio N> 计数、参考图文件提及、<d> 对白、空间锁。
 * 全部确定性正则、零模型调用；分段边界复用 directorEngine 的三态函数，保证与「送入项目」一致。
 */
import { collectSegmentMarks, detectScriptKind, extractGlobalStyle, parseSegmentTitle, structuredSplit } from "./directorEngine";
import { useDirector } from "./stores/directorStore";
import { uid } from "./utils";
import type { DirectorScene, DirectorSegment, ScriptDocument } from "./types";

export type ScriptSegmentInfo = {
  index: number;
  title: string;
  durationSec?: number;
  /** 开篇 / 同场接力 / 硬切（衔接模式声明） */
  mode?: string;
  /** 模型/工作流线索：显式「模型:/配方:/工作流:」行，或 Ref2VA/T2VA 等模式关键词 */
  engine?: string;
  /** 有显式提示词围栏（<<<PROMPT_START>>> 或 ```text） */
  hasFence: boolean;
  /** 提示词正文字数（围栏内容；无围栏时为正文减结构行的估算） */
  promptChars: number;
  /** <Picture N> 最大 N */
  pictures: number;
  videos: number;
  audios: number;
  /** 提及的参考图文件（RefImgN_空间站位图.png / 01_场景.jpg 等） */
  refImages: string[];
  /** <d>[语言]...</d> 对白原文 */
  dialogue: string[];
  hasSpatialLock: boolean;
};

export type ScriptInspection = {
  kind: "prompts" | "segmented" | "full";
  kindLabel: string;
  /** 前言主标题——自动命名的第一优先级，文件名只做兜底 */
  title?: string;
  fileName?: string;
  globalStyle?: string;
  /** 识别出的分段时长合计；识别不出为 0 */
  totalSec: number;
  segments: ScriptSegmentInfo[];
  warnings: string[];
};

export const SCRIPT_KIND_LABEL: Record<ScriptInspection["kind"], string> = {
  prompts: "成品提示词包",
  segmented: "已分段脚本",
  full: "完整剧本",
};

/** 按三态把正文切成「前言 + 分段原文」；full 不切。边界函数与「送入项目」同源。 */
function splitIntoParts(body: string, kind: ScriptInspection["kind"]): { prefix: string; parts: string[] } {
  if (kind === "full") return { prefix: body.slice(0, 600), parts: [] };
  if (kind === "segmented") {
    try {
      return { prefix: "", parts: structuredSplit(body, 12).scenes.flatMap((s) => s.parts) };
    } catch {
      return { prefix: "", parts: [] };
    }
  }
  const t = body.trim();
  const marks = collectSegmentMarks(t);
  if (!marks.length) return { prefix: t.slice(0, 600), parts: [] };
  return {
    prefix: t.slice(0, marks[0]),
    parts: marks.map((start, i) => t.slice(start, i + 1 < marks.length ? marks[i + 1] : t.length).trim()).filter(Boolean),
  };
}

function maxRefN(text: string, tag: string): number {
  let n = 0;
  for (const m of text.matchAll(new RegExp(`<${tag}\\s+(\\d+)`, "gi"))) n = Math.max(n, Number(m[1]));
  return n;
}

function parseSegmentInfo(part: string, index: number): ScriptSegmentInfo {
  const text = part.replace(/(?:\r?\n[ \t]*-{3,}[ \t]*)+\s*$/, "");
  const lines = text.split("\n");
  let li = 0;
  while (li < lines.length && !lines[li].trim()) li++;
  let titleLine = (lines[li] ?? "").trim();
  // 纯分段序号头（# 第一分段 / 共十五分段）不承载标题，真标题在下一非空行
  if (/^(?:#{1,4}\s*)?第\s*[0-9一二三四五六七八九十百零两]+\s*分段/.test(titleLine) || /^#{1,4}\s*分段\s*\d*/.test(titleLine)) {
    li++;
    while (li < lines.length && !lines[li].trim()) li++;
    titleLine = (lines[li] ?? "").trim();
  }
  const head = /<<<PROMPT_START>>>/i.test(titleLine) ? {} : parseSegmentTitle(titleLine);
  const marked = part.match(/<<<PROMPT_START>>>([\s\S]*?)<<<PROMPT_END>>>/i);
  const fenced = part.match(/```text[ \t]*\r?\n([\s\S]*?)```/i) ?? part.match(/```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)```/);
  const promptBody = (marked ? marked[1] : fenced ? fenced[1] : "").trim();
  const structural = /^#{1,4}\s+\S/.test(titleLine) || /^\d{1,3}[-－—–.、)）]/.test(titleLine) || !!marked || !!fenced;
  const bodyText = promptBody || (structural ? lines.slice(li + 1).join("\n") : text);

  const durationSec = head.durationSec && head.durationSec >= 4 && head.durationSec <= 60 ? Math.round(head.durationSec) : undefined;
  const scan = `${titleLine}\n${bodyText}`;
  const mode = /开篇|opening/i.test(scan) ? "开篇" : /接力|continuity[_ ]?relay|同场/i.test(scan) ? "同场接力" : /硬切|hard[_ ]?cut/i.test(scan) ? "硬切" : undefined;
  const metaLine = text.match(/^\s*[-*]?\s*(?:模型|引擎|配方|工作流|Model|Engine|Workflow)\s*[:：]\s*(.+?)\s*$/im)?.[1]?.trim();
  const engine = metaLine || scan.match(/\b(?:Ref2VA|T2VA|I2VA|FL2VA|L2VA)\b/i)?.[0]?.toUpperCase();
  const dialogue = [...bodyText.matchAll(/<d>(?:\[[^\]]*\])?([^<]{1,100})<\/d>/g)]
    .map((m) => m[1].trim())
    .filter(Boolean)
    .slice(0, 8);
  const refImages = [...new Set([...bodyText.matchAll(/[\w\u4e00-\u9fa5-]+\.(?:png|jpe?g|webp)/gi)].map((m) => m[0]))].slice(0, 6);

  return {
    index,
    title: head.title || titleLine.replace(/^#{1,4}\s*/, "").slice(0, 40) || `提示词 ${index}`,
    durationSec,
    mode,
    engine,
    hasFence: !!(marked || fenced),
    promptChars: (promptBody || bodyText).length,
    pictures: maxRefN(bodyText, "Picture"),
    videos: maxRefN(bodyText, "Video"),
    audios: maxRefN(bodyText, "Audio"),
    refImages,
    dialogue,
    hasSpatialLock: /空间锁|subject_definitions|站位/.test(bodyText),
  };
}

/** 深解析一份剧本正文：三态识别 + 文档级与分段级全部可提取信息 */
export function inspectScript(body: string, fileName?: string): ScriptInspection {
  const kind = detectScriptKind(body);
  const { prefix, parts } = splitIntoParts(body, kind);
  const title = prefix.match(/^#{1,3}\s*(\S.+)$/m)?.[1]?.trim();
  const globalStyle = extractGlobalStyle(prefix);
  const segments =
    kind === "full"
      ? [
          {
            index: 1,
            title: title || fileName || "完整剧本",
            hasFence: false,
            promptChars: body.length,
            pictures: 0,
            videos: 0,
            audios: 0,
            refImages: [],
            dialogue: [...body.matchAll(/<d>(?:\[[^\]]*\])?([^<]{1,100})<\/d>/g)].map((m) => m[1].trim()).slice(0, 8),
            hasSpatialLock: false,
          } as ScriptSegmentInfo,
        ]
      : parts.map(parseSegmentInfo);
  const totalSec = segments.reduce((n, s) => n + (s.durationSec ?? 0), 0);
  const warnings: string[] = [];
  if (kind !== "full") {
    const noDur = segments.filter((s) => !s.durationSec).length;
    if (noDur) warnings.push(`${noDur} 段未识别时长，送入后按 12 秒计（段头写「01-标题-11秒」可识别）`);
    if (!totalSec) warnings.push("没有识别出任何分段时长");
  }
  return { kind, kindLabel: SCRIPT_KIND_LABEL[kind], title, fileName, globalStyle, totalSec, segments, warnings };
}

/** 一行人读得懂的识别摘要（toast / 列表副标题用） */
export function inspectionSummary(insp: ScriptInspection): string {
  const fenced = insp.segments.filter((s) => s.hasFence).length;
  const dialogue = insp.segments.reduce((n, s) => n + s.dialogue.length, 0);
  const refs = insp.segments.reduce((n, s) => n + s.refImages.length, 0);
  return `${insp.kindLabel} · ${insp.segments.length} 段${insp.totalSec ? ` · 总时长 ${insp.totalSec}s` : ""} · 提示词围栏 ${fenced} · 对白 ${dialogue} 句 · 参考图提及 ${refs}`;
}

/** 规则切段的场景草案 → 项目片段（原文存 scriptText 供 AI 精读）；剧本库与拖拽自动送入共用 */
export function structuredToScenes(res: ReturnType<typeof structuredSplit>, maxSegSec: number): DirectorScene[] {
  const mkSegment = (text: string, sceneId: string, idx: number): DirectorSegment => ({
    id: uid(8),
    sceneId,
    durationSec: maxSegSec,
    summary: text.slice(0, 50).replace(/\n/g, " ").trim() || `分段 ${idx}`,
    dialogue: [],
    shots: [],
    scriptRange: [0, text.length] as [number, number],
    scriptText: text,
    approvedTakeId: null,
    takes: [],
  });
  const parts = res.scenes.flatMap((s) => s.parts);
  return parts.map((text, i) => {
    const sid = uid(8);
    return { id: sid, location: text.slice(0, 20).replace(/\n/g, " ").trim() || `场景 ${i + 1}`, segments: [mkSegment(text, sid, i + 1)] };
  });
}

/** 拖入/选择/粘贴通用入口：建文档（自动命名 = 前言主标题 > 文件名）并落库，返回识别结果与文档 id */
export function createScriptDoc(projectId: string, fileName: string, body: string): { insp: ScriptInspection; docId: string } {
  const insp = inspectScript(body, fileName);
  const now = Date.now();
  const stem = fileName.split(/[\\/]/).pop()?.replace(/\.(md|txt|json)$/i, "") || "导入剧本";
  const docId = uid(10);
  const v0 = { id: uid(10), label: `导入 ${stem}`, body, createdAt: now };
  const doc: ScriptDocument = {
    id: docId,
    title: insp.title || stem,
    status: "draft",
    targetDurationSec: insp.totalSec || undefined,
    versions: [v0],
    // 必须指向首个版本：剧本库「追加拆分 / 替换并重拆」按钮按 activeVersionId 判可用——
    // 缺省会让拖入的剧本按钮全灰（必须手动编辑正文才能点，3.5 用户反馈）
    activeVersionId: v0.id,
    origin: "import",
    createdAt: now,
    updatedAt: now,
  };
  const fresh = useDirector.getState().getById(projectId);
  useDirector.getState().updateProject(projectId, { scripts: [doc, ...(fresh?.scripts ?? [])] });
  return { insp, docId };
}

/* ---------------- 中英双语稿配对（3.5：剧本库送入路径的自动对照） ---------------- */

/**
 * 剥掉标题里的语言/形态修饰词与分隔符，得到「核心标题」：
 * 「《心跳倒计时》分段剧本-英文 H3 Ref2VA 执行稿汇总」与「《心跳倒计时》分段剧本-中文审阅稿」
 * 归一后同为「《心跳倒计时》分段剧本」——core 相等且语言标记互补即视为同一故事的中英两稿。
 */
export function normalizeScriptTitle(t: string): { core: string; lang: "zh" | "en" | null } {
  const s = t
    .replace(/\.(md|txt|json)$/i, "")
    .replace(/英文|英语|执行稿|执行稿汇总|中文审阅稿|中文稿|中文|汉语|English|english|\bEN\b|\bZH\b/gi, "")
    .replace(/H3|Ref2VA|T2VA|I2VA|FL2VA|L2VA|Ref2V|T2V|I2V|汇总/gi, "")
    .replace(/[\s\-_－—·|｜/\\]+/g, "");
  const zh = /中文|汉语|审阅|zh/i.test(t);
  const en = /英文|英语|执行|en\b|english/i.test(t);
  return { core: s, lang: zh ? "zh" : en ? "en" : null };
}

/**
 * 在剧本库里找当前英文稿的中文对照稿：核心标题相同、一侧标中文一侧标英文；
 * 找不到精确的退一步——书名号主标题相同且对方标中文。返回 undefined = 没有中文侧（单语稿）。
 */
export function matchZhCounterpartDoc(
  enTitle: string,
  docs: Array<Pick<ScriptDocument, "id" | "title">>,
  excludeId?: string,
): ScriptDocument["id"] | undefined {
  const en = normalizeScriptTitle(enTitle);
  if (en.lang !== "en") return undefined; // 当前稿不是英文侧，不找
  let loose: string | undefined;
  for (const d of docs) {
    if (d.id === excludeId) continue;
    const zh = normalizeScriptTitle(d.title);
    if (zh.lang !== "zh") continue;
    if (zh.core === en.core) return d.id;
    // 书名号主标题相同（如《心跳倒计时》）也认——命名习惯不齐时的兜底
    const enBook = enTitle.match(/《([^》]+)》/)?.[1];
    const zhBook = d.title.match(/《([^》]+)》/)?.[1];
    if (enBook && zhBook && enBook === zhBook && !loose) loose = d.id;
  }
  return loose;
}
