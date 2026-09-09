/**
 * 分段切点与标题解析（纯函数，零依赖）—— 从 directorEngine 提取，
 * 供 node 直跑测试与 h3BilingualCore 配对复用；directorEngine 对外 re-export 保持兼容。
 */

/** 「序号-标题-时长」裸标题行（01-古刹闻客-11秒 / 02｜青衣叩门｜11s）：无围栏成品提示词包的段头特征 */
export const BARE_TITLE_SRC = "^\\d{1,3}\\s*[-－—–|｜][^\\n]{1,60}?[-－—–|｜]\\s*\\d+(?:\\.\\d+)?\\s*(?:秒|s|sec)\\s*$";
export const isBareTitleLine = (l: string) => new RegExp(BARE_TITLE_SRC, "i").test(l);
/** 纯分段序号头（# 第一分段 / 共十五分段）：只承载序号，真实标题（01-古刹闻客-11秒）在其后一行。
 *  允许「（共六分段）」类括号后缀与「/／说明」后缀。 */
export const INDEX_HEAD_RE = /^#{1,4}\s*第\s*[0-9一二三四五六七八九十百零两]+\s*(?:分段|场|幕)(?:\s*[/／][^\n]*)?(?:\s*[（(][^\n）)]*[）)])?$/;

/** 段头后的纯元信息行（共六分段 / 分段数：6 / 总时长 60 秒 / 每段 10 秒）——不是标题，标题解析时跳过 */
export const SEGMENT_META_LINE_RE =
  /^(?:共\s*[0-9一二三四五六七八九十百零两]+\s*(?:分段|段|场|幕)(?:[（(][^\n）)]*[）)])?|分段数\s*[:：]?\s*\d+|总时长\s*[:：]?\s*[\d.]+\s*(?:秒|s)?|每段\s*[\d.]+\s*(?:秒|s)|共\s*[\d.]+\s*(?:秒|s))$/i;
export const isSegmentMetaLine = (l: string) => SEGMENT_META_LINE_RE.test(l.trim());

/** 统计「序号-标题-时长」裸标题行数量（无围栏成品包的段头） */
export function countBareTitleHeads(t: string): number {
  return [...t.matchAll(new RegExp(BARE_TITLE_SRC, "gim"))].length;
}

/**
 * 把围栏内容替换为等长空白（``` 行与 <<<PROMPT_START/END>>> 标记行本身保留，外部索引不变）。
 * 标题/标记扫描用遮罩文本，防止提示词正文里的 `## xxx` 行被误认成小节头把一段提示词切碎；
 * 围栏行保留意味着「正文带围栏块」的判定在遮罩文本上同样成立。
 */
export function maskFencedBodies(t: string): string {
  return t
    .replace(/<<<PROMPT_START>>>([\s\S]*?)<<<PROMPT_END>>>/gi, (_all, body: string) => "<<<PROMPT_START>>>" + body.replace(/[^\n]/g, " ") + "<<<PROMPT_END>>>")
    .replace(/(^|\n)([ \t]*```[^\n]*\n)([\s\S]*?)([ \t]*```[ \t]*(?=\n|$))/g, (_all, nl: string, open: string, body: string, close: string) =>
      nl + open + body.replace(/[^\n]/g, " ") + close,
    );
}

/** 显式提示词围栏 <<<PROMPT_START>>> 的出现次数（一对 START/END = 一个片段） */
export const countPromptMarks = (t: string): number => t.match(/<<<PROMPT_START>>>/gi)?.length ?? 0;

/** 统计「标题 + 代码围栏内容块」的小节数（通用提示词包特征；标题认 1-4 级） */
export function countFencedSections(t: string): number {
  const heads = [...maskFencedBodies(t).matchAll(/^#{1,4}\s+(.+)$/gm)];
  let n = 0;
  for (let i = 0; i < heads.length; i++) {
    const body = t.slice(heads[i].index!, i + 1 < heads.length ? heads[i + 1].index! : t.length);
    if (/```/.test(body)) n++;
  }
  return n;
}

/**
 * 通用片段标题解析：`## H3-01｜三岁的画｜12 秒` / `## 分镜1 开场` / `## 回家第一句 16s` 都认。
 * 剥掉 H3-N 序号前缀与尾部时长（全角｜/半角|/中文「秒」都行），返回净标题与时长。
 */
export function parseSegmentTitle(line: string): { title?: string; durationSec?: number } {
  let s = line.replace(/^#{1,4}\s*/, "").trim();
  // H3-01 / 分镜01 / 第一分段（中文数字）等序号前缀
  s = s.replace(/^(?:H3[-_ ]?\d+|分镜\s*\d+|第\s*[0-9一二三四五六七八九十百零两]+\s*分段?|Scene\s*\d+)\s*[|｜:：\-—]?\s*/i, "");
  // 裸序号标题（01-古刹闻客-11秒）的 NN- 前缀：只认 1-3 位数字 + 分隔符，避免误吞 1988- 这类年份
  s = s.replace(/^\d{1,3}\s*[-－—–.、)）]\s*/, "");
  // 尾部时长：｜12 秒 / | 12s / 12秒
  let durationSec: number | undefined;
  const dm = s.match(/[|｜]\s*(\d+(?:\.\d+)?)\s*(?:s|秒|sec)?\s*$/i) ?? s.match(/(\d+(?:\.\d+)?)\s*(?:秒|s|sec)\s*$/i);
  if (dm) {
    durationSec = Number(dm[1]);
    s = s.slice(0, dm.index).replace(/[|｜\s\-—]+$/, "").trim();
  }
  return { title: s || undefined, durationSec };
}

/** 收集片段起点：显式围栏 → H3 头 → subject_definitions → 通用「标题」（序号标题或带围栏块的小节，认 1-4 级） */
export function collectSegmentMarks(t: string): number[] {
  const masked = maskFencedBodies(t);
  // 显式围栏 <<<PROMPT_START>>> 每处即一段起点（最可靠，优先于一切启发式）；
  // 段起点回吃紧邻上方的标题行（## H3-01｜标题｜12 秒 / 裸标题 / # 第X分段），否则标题会落进前言或上一段
  const pm = [...masked.matchAll(/<<<PROMPT_START>>>/gi)].map((m) => m.index!);
  if (pm.length) {
    return pm.map((idx) => {
      let start = masked.lastIndexOf("\n", idx - 1) + 1; // 标记所在行的行首
      for (let k = 0; k < 3; k++) {
        if (start <= 0) break;
        const prevEnd = start - 1; // 上一行的 \n 位置
        const prevStart = masked.lastIndexOf("\n", prevEnd - 1) + 1;
        const line = masked.slice(prevStart, prevEnd).trim();
        if (!line || /^#{1,4}\s+\S/.test(line) || isBareTitleLine(line) || INDEX_HEAD_RE.test(line)) {
          start = prevStart; // 空行与标题行都回吃；遇到 PROMPT_END 或正文行即停
          continue;
        }
        break;
      }
      return start;
    });
  }
  const h3 = [...masked.matchAll(/^#{1,4}\s*H3-[\w-]+.*$/gim)].map((m) => m.index!);
  if (h3.length) return h3;
  const sd = [...masked.matchAll(/subject_definitions\s*:/g)].map((m) => m.index!);
  if (sd.length) return sd;
  // 通用提示词包：标题（1-4 级）带序号（H3-N/第N段/分镜N/Scene N/1.）或正文带围栏块的算片段；
  // 定调/风格/说明类小节永远不作片段起点（其围栏块是风格内容，不是分镜提示词），内容自然并入前言
  const STYLE_HEAD = /风格|定调|锚定|说明|规则|注意|前言|简介|资产|附录|参考|原则/;
  const heads = [...masked.matchAll(/^#{1,4}\s+(.+)$/gm)];
  const segMarks: number[] = [];
  heads.forEach((h, i) => {
    const title = h[1];
    if (STYLE_HEAD.test(title)) return;
    const body = t.slice(h.index!, i + 1 < heads.length ? heads[i + 1].index! : t.length);
    const looksSegment =
      /(?:H3[-_ ]?\d+|第\s*[0-9一二三四五六七八九十百零两]+\s*(?:分段|段|集|镜)|分镜\s*\d+|Scene\s*\d+|^\d+\s*[.、)）])/i.test(title) ||
      /```/.test(body) ||
      /subject_definitions\s*:/.test(body);
    if (looksSegment) segMarks.push(h.index!);
  });
  if (segMarks.length) return segMarks;
  // 无 markdown 头的包：「序号-标题-时长」裸标题行自己当段头
  const bare = [...masked.matchAll(new RegExp(BARE_TITLE_SRC, "gim"))].map((m) => m.index!);
  if (bare.length >= 2) return bare;
  return segMarks;
}

/** 统计成品提示词段数（识别条显示用）：显式围栏 / H3 头 / subject_definitions / 带围栏块的通用小节 */
export function countPromptSegments(script: string): number {
  const t = script.trim();
  if (!t) return 0;
  const masked = maskFencedBodies(t);
  const pm = countPromptMarks(masked);
  if (pm > 0) return pm;
  const heads = masked.match(/^#{1,4}\s*H3-/gim)?.length ?? 0;
  if (heads > 0) return heads;
  const sd = masked.match(/subject_definitions\s*:/g)?.length ?? 0;
  if (sd > 0) return sd;
  const bare = countBareTitleHeads(masked);
  if (bare > 0) return bare;
  return countFencedSections(t);
}

/** 中文数字 → 阿拉伯数字（配对键提取用；支持到百位） */
export function cnNumToArabic(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units: Record<string, number> = { 十: 10, 百: 100 };
  let n = 0;
  let cur = 0;
  for (const ch of s) {
    if (digits[ch] !== undefined) cur = digits[ch];
    else if (units[ch] !== undefined) {
      const u = units[ch];
      n += (cur || 1) * u;
      cur = 0;
      if (u >= 100) cur = 0;
    }
  }
  return n + cur;
}

/**
 * 分段标题 → 稳定配对键（编号）：H3-01 / 第03分段 / 01-标题-11秒 / # 第X分段 都归一成数字字符串。
 * 提不出编号返回 null（调用方走顺序后备）。
 */
export function segmentKeyOfTitle(titleLine: string): string | null {
  const s = titleLine.trim();
  if (!s) return null;
  const h3 = s.match(/H3[-_ ]?(\d{1,3})/i);
  if (h3) return String(Number(h3[1]));
  const cn = s.match(/第\s*([0-9一二三四五六七八九十百零两]+)\s*(?:分段|段|集|镜)/);
  if (cn) return String(cnNumToArabic(cn[1]));
  const scene = s.match(/\bScene\s*_?(\d{1,3})\b/i);
  if (scene) return String(Number(scene[1]));
  const bare = s.match(/^\d{1,3}\s*[-－—–|｜.、)）:：]/);
  if (bare) {
    const n = Number(s.match(/^\d{1,3}/)?.[0]);
    if (Number.isFinite(n) && n > 0) return String(n);
  }
  const hash = s.match(/^#{1,4}\s*第\s*([0-9一二三四五六七八九十百零两]+)/);
  if (hash) return String(cnNumToArabic(hash[1]));
  return null;
}
