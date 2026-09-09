/**
 * Comfy 工作流同步 · 纯逻辑：分类 / 语义哈希 / 结构指纹 / 忽略规则 / 版本保留策略
 *
 * 本文件不 import 任何带 Tauri/store 依赖的模块（判定逻辑与 comfy.ts 的 isApiWorkflow、
 * frontendConvert.ts 的 isFrontendWorkflow 语义一致，此处独立实现保证可被 node 直跑测试）。
 */

/* ---------------- 工作流 JSON 分类（规格 FR-002） ---------------- */

/** 前端格式（完整 UI Workflow）：nodes + links 数组 */
export function isFrontendJson(json: unknown): boolean {
  const j = json as Record<string, unknown>;
  return (
    !!j && typeof j === "object" && !Array.isArray(j) && Array.isArray(j.nodes) && Array.isArray(j.links)
  );
}

/** API 格式（API Prompt）：{ "3": { class_type, inputs }, … } 且值都带 class_type */
export function isApiJson(json: unknown): boolean {
  if (!json || typeof json !== "object" || Array.isArray(json)) return false;
  const vals = Object.values(json as Record<string, unknown>);
  if (!vals.length) return false;
  return vals.every(
    (v) => !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as any).class_type === "string",
  );
}

/** MOMO 模板包：{ templates: [...] }（同步时标记为不自动导入，引导走模板管理；在 frontend/api 之后判定） */
export function isMomoTemplatePack(json: unknown): boolean {
  const j = json as Record<string, unknown>;
  return !!j && typeof j === "object" && Array.isArray(j.templates);
}

export type WfFormat = "ui_v04" | "api_only" | "momo_pack" | "invalid";

/** 解析并分类一段工作流 JSON 文本 */
export function classifyWorkflowText(text: string): {
  format: WfFormat;
  json?: unknown;
  error?: string;
} {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { format: "invalid", error: `SYNC_INVALID_JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (isFrontendJson(json)) return { format: "ui_v04", json };
  if (isApiJson(json)) return { format: "api_only", json };
  if (isMomoTemplatePack(json)) return { format: "momo_pack", json };
  return { format: "invalid", error: "SYNC_UNSUPPORTED_FORMAT: 不是可识别的工作流 JSON" };
}

/* ---------------- 语义哈希与结构指纹（规格 §10） ---------------- */

/** FNV-1a 32 位字符串哈希（语义/结构指纹只作辅助匹配信号，不需要密码学强度） */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 键排序序列化（数组保序；对象键排序）——语义哈希的规范化形态 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** 语义哈希：识别「仅格式化/缩进/无关字段」变化（规格 §10.2） */
export function semanticHashOf(json: unknown): string {
  return fnv1a(canonicalJson(json));
}

/** UI Workflow 顶层 id（ComfyUI 1.x 保存通常带；身份识别的强信号） */
export function graphIdOf(json: unknown): string | undefined {
  const j = json as Record<string, unknown>;
  const id = j && typeof j === "object" ? j.id : undefined;
  return typeof id === "string" && id ? id : undefined;
}

/**
 * 结构指纹：节点类型序列 + 连线数 + 分组数（改名/移动识别的弱匹配信号，规格 §10.3 第 3 级）。
 * 只对前端格式有意义；API 格式退化为 class_type 序列。
 */
export function structureFingerprintOf(json: unknown): string {
  if (isFrontendJson(json)) {
    const j = json as any;
    const types = (j.nodes as Array<{ type?: string }>)
      .map((n) => String(n?.type ?? "?"))
      .sort()
      .join("|");
    return fnv1a(`ui:${types}:${(j.links as unknown[]).length}:${(j.groups ?? []).length}`);
  }
  if (isApiJson(json)) {
    const types = Object.values(json as Record<string, { class_type: string }>)
      .map((n) => n.class_type)
      .sort()
      .join("|");
    return fnv1a(`api:${types}`);
  }
  return "";
}

/* ---------------- 忽略规则（规格 FR-002，glob 子集） ---------------- */

/** `*` 通配匹配（不跨 `/`；`?` 不支持，保持最小实现） */
function wildmatch(seg: string, pat: string): boolean {
  // 经典双指针回溯
  let si = 0;
  let pi = 0;
  let star = -1;
  let mark = 0;
  while (si < seg.length) {
    if (pi < pat.length && (pat[pi] === seg[si] || pat[pi] === "*")) {
      if (pat[pi] === "*") {
        star = pi++;
        mark = si;
      } else {
        si++;
        pi++;
      }
    } else if (star >= 0) {
      pi = star + 1;
      si = ++mark;
    } else {
      return false;
    }
  }
  while (pi < pat.length && pat[pi] === "*") pi++;
  return pi === pat.length;
}

// 匹配一条忽略规则。支持的最小 glob 集（规格 FR-002 默认规则够用）：
//  - "*.tmp"            不含斜杠的模式：按文件名匹配（任意目录下）
//  - "backup" + "/**"   来源根下 backup 目录内的一切
//  - "**" 开头          任意层级前缀（如任意位置的 backup 目录、任意目录下的 .backup.json）
export function matchIgnore(rel: string, pattern: string): boolean {
  const p = pattern.trim().replace(/^\.?\//, "").replace(/\/+$/, "");
  if (!p || !rel) return false;
  if (!p.includes("/")) return wildmatch(rel.split("/").pop() ?? rel, p);
  const anyPrefix = p.startsWith("**/");
  const rest = anyPrefix ? p.slice(3) : p;
  if (rest.endsWith("/**")) {
    const dir = rest.slice(0, -3);
    if (!dir) return true;
    return anyPrefix
      ? rel === dir || rel.startsWith(`${dir}/`) || rel.includes(`/${dir}/`)
      : rel === dir || rel.startsWith(`${dir}/`);
  }
  // 带目录的文件模式：`**/foo.json` 或 `dir/foo.json`
  return anyPrefix
    ? wildmatch(rel.split("/").pop() ?? rel, rest) || rel.endsWith(`/${rest}`)
    : rel === rest;
}

/** 默认忽略规则（规格 FR-002） */
export const DEFAULT_IGNORE_PATTERNS = [
  "*.tmp",
  "*.partial",
  "*.lock",
  ".momo-sync/**",
  "backup/**",
  "backups/**",
  "**/*.backup.json",
];

/** 相对路径是否应被来源忽略 */
export function isIgnoredRel(rel: string, patterns: string[]): boolean {
  return patterns.some((p) => matchIgnore(rel, p));
}

/* ---------------- 版本保留策略（规格 FR-013） ---------------- */

export type RevisionMetaLite = { revision: number; createdAt: number; pinned?: boolean };

/**
 * 计算应保留的版本号集合：最近 20 个 + 最近 7 天内 + 用户 pin 的 + 最新版（当前基线）。
 * 自动清理不得删除当前版本（规格 FR-013）。
 */
export function computeRevisionKeep(revisions: RevisionMetaLite[], now = Date.now()): number[] {
  const keep = new Set<number>();
  const sorted = [...revisions].sort((a, b) => b.revision - a.revision);
  for (const r of sorted) {
    if (keep.size < 20) keep.add(r.revision); // 最近 20 个
    if (now - r.createdAt < 7 * 24 * 3600 * 1000) keep.add(r.revision); // 7 天内
    if (r.pinned) keep.add(r.revision); // 永久保留
  }
  if (sorted.length) keep.add(sorted[0].revision); // 当前版本兜底
  return [...keep].sort((a, b) => a - b);
}

/* ---------------- 依赖检查（规格 FR-016：只标记，不阻塞同步/入库） ---------------- */

/** 检查 UI Workflow 的依赖：缺失的自定义节点类型 + 疑似缺失的模型引用（loader 类）。
 * 需要 object_info（ComfyUI 在线）；离线时调用方应跳过。最多各报 5 条，防刷屏。 */
export function dependencyWarnings(
  ui: { nodes: Array<{ id: number | string; type: string; widgets_values?: unknown[] }> },
  objectInfo: Record<string, any>,
): string[] {
  const missing = new Set<string>();
  const modelMissing: string[] = [];
  for (const n of ui.nodes ?? []) {
    const oi = objectInfo[n.type];
    if (!oi) {
      missing.add(n.type);
      continue;
    }
    // loader 类节点：第一个 combo（选项数组）输入即模型/资源名，值不在选项表 → 疑似缺失
    if (!/loader/i.test(n.type)) continue;
    const req = oi?.input?.required ?? {};
    for (const [, def] of Object.entries<any>(req)) {
      const t = Array.isArray(def) ? def[0] : def?.type;
      if (!Array.isArray(t) || !t.length) continue;
      const cur = String((n.widgets_values ?? [])[0] ?? "");
      if (cur && !t.includes(cur)) modelMissing.push(`${n.type}: ${cur}`);
      break;
    }
  }
  const out: string[] = [];
  for (const t of [...missing].slice(0, 5)) out.push(`SYNC_MISSING_NODE: 缺少自定义节点「${t}」（工作流已保存，运行前需安装）`);
  for (const m of [...new Set(modelMissing)].slice(0, 5)) out.push(`疑似缺失模型：${m}（运行前请在 ComfyUI 里确认）`);
  return out;
}

/* ---------------- 显示名 ---------------- */

/** 相对路径 → 显示名：末段文件名去 .json；嵌套目录保留「子目录/名」帮助区分 */
export function displayNameOfRel(rel: string): string {
  const seg = rel.split("/").pop() ?? rel;
  return seg.replace(/\.json$/i, "") || seg;
}
