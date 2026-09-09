/**
 * Skill 安全导入 — 两种入口：
 *  ① 快速 Skill：直接导入一个 SKILL.md（frontmatter 元数据 + 正文指令）
 *  ② 完整 Skill 包：.momoskill ZIP（skill.json + instructions.md + references/ + assets/）
 *
 * 安全策略（方案 §17.9）：
 *  - 第一版只读取声明式文件，不执行 scripts/、.js、.py、可执行文件
 *  - 解压时校验路径，禁止 ../ 路径穿越
 *  - 文件数量 ≤ 100、总体积 ≤ 20MB
 *  - 导入向导让用户补充名称、分类、适用位置、执行阶段
 */
import type { MomoSkill, SkillContext, SkillOutput, SkillPhase, SkillVariable } from "./skillTypes";
import { SKILL_CONTEXTS } from "./skillTypes";
import type { SkillPurpose } from "./skillTypes";
import { newSkill } from "./stores/skillStore";

/** 导入结果 */
const VALID_PURPOSES: SkillPurpose[] = ["script-plan", "segment-authoring", "compile-video-prompt", "compile-image-prompt", "project-package", "validate"];

/** frontmatter/JSON 的 purpose 合法化：非法值丢弃返回 undefined */
function validPurpose(raw: unknown): SkillPurpose | undefined {
  return typeof raw === "string" && (VALID_PURPOSES as string[]).includes(raw) ? (raw as SkillPurpose) : undefined;
}

export type ImportResult = {
  skill: MomoSkill;
  warnings: string[]; // 非 fatal 警告（如忽略了脚本文件）
};

const MAX_FILES = 100;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/** SKILL.md frontmatter 里的合法字段 */
type Frontmatter = {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  contexts?: string[];
  phase?: string;
  output?: string;
  variables?: SkillVariable[];
  /** 分型（能力层）：rule | workflow，缺省 rule */
  kind?: string;
  /** Agent 路由提示（workflow 型）：自然语言触发条件 */
  triggers?: string[];
};

/** 解析 SKILL.md：首段 YAML frontmatter（--- 分隔）+ 剩余正文作为 instructions */
function parseSkillMd(text: string): { fm: Frontmatter; instructions: string } {
  const fm: Frontmatter = {};
  let instructions = text;
  // 匹配首行 --- ... --- 包裹的 frontmatter
  const m = text.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (m) {
    const yaml = m[1];
    instructions = m[2].trim();
    // 极简 YAML 解析（不引第三方库）：只认 key: value 和 key: [a, b] 和列表
    for (const line of yaml.split(/\r?\n/)) {
      const mm = line.match(/^(\w+)\s*:\s*(.*)$/);
      if (!mm) continue;
      const [, k, v] = mm;
      if (k === "contexts") {
        fm.contexts = v.replace(/[\[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
      } else if (k === "triggers") {
        fm.triggers = v.replace(/[\[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 6);
      } else if (k === "variables") {
        // variables 是多行结构，极简解析跳过（导入向导里让用户补）
      } else if (k === "id" || k === "name" || k === "version" || k === "description" || k === "phase" || k === "output" || k === "kind") {
        (fm as any)[k] = v.trim().replace(/^["']|["']$/g, "");
      }
    }
  }
  return { fm, instructions };
}

/** frontmatter + 正文 → MomoSkill（校验 contexts/phase/output 合法性） */
function skillFromFrontmatter(
  fm: Frontmatter,
  instructions: string,
  fallbackName: string,
  references?: string[],
): ImportResult {
  const warnings: string[] = [];
  const validContexts: SkillContext[] = (fm.contexts ?? ["prompt.text"]).filter((c): c is SkillContext =>
    SKILL_CONTEXTS.includes(c as SkillContext),
  );
  if (fm.contexts && validContexts.length !== fm.contexts.length) {
    warnings.push(`部分 contexts 值不合法，已保留合法项：${validContexts.join(", ")}`);
  }
  const validPhases: SkillPhase[] = ["analyze", "authoring", "model-adapter", "validate"];
  const phase = (fm.phase && validPhases.includes(fm.phase as SkillPhase) ? fm.phase : "authoring") as SkillPhase;
  const validOutputs: SkillOutput[] = ["text", "prompt-plan", "poster-plan", "director-plan"];
  const output = (fm.output && validOutputs.includes(fm.output as SkillOutput) ? fm.output : "text") as SkillOutput;
  // 分型（能力层）：只认 rule/workflow，非法值丢弃告警；triggers 仅作 Agent 路由提示登记
  if (fm.kind && fm.kind !== "rule" && fm.kind !== "workflow") {
    warnings.push(`kind 值不合法（${fm.kind}），已按默认 rule 处理`);
  }
  const kind: MomoSkill["kind"] = fm.kind === "workflow" ? "workflow" : fm.kind === "rule" ? "rule" : undefined;
  const triggers = (fm.triggers ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 6);

  const skill = newSkill({
    id: fm.id || fm.name || undefined, // name 派生稳定 id：重复导入同名 Skill 覆盖更新而非新增重复项
    name: fm.name || fallbackName,
    version: fm.version || "1.0.0",
    description: fm.description || "",
    contexts: validContexts,
    phase,
    purpose: validPurpose((fm as Record<string, unknown>).purpose),
    output,
    instructions,
    references,
    source: "import",
    ...(kind ? { kind } : {}),
    ...(triggers.length ? { triggers } : {}),
  });
  return { skill, warnings };
}

/** 从纯文本 SKILL.md 导入（快速 Skill 入口） */
export function importSkillMd(filename: string, text: string): ImportResult {
  const { fm, instructions } = parseSkillMd(text);
  return skillFromFrontmatter(fm, instructions, filename.replace(/\.md$/i, ""));
}

/**
 * 从 Claude 风格 Skill zip 导入（SKILL.md + 可选 agents/、references/ 等）。
 * 解压由调用方完成（JSZip），这里只接受「路径 → 内容」映射。
 * 查找根目录或一级子目录下的 SKILL.md；脚本文件与路径穿越条目忽略并记 warning。
 */
export function importClaudeSkillZip(files: Map<string, Uint8Array | string>): ImportResult {
  const warnings: string[] = [];
  const blocked = [".js", ".mjs", ".cjs", ".py", ".sh", ".bat", ".cmd", ".ps1", ".exe", ".dll", ".so", ".dylib"];
  let totalBytes = 0;
  let skillMdText: string | null = null;
  let skillMdDepth = Infinity;
  const references: string[] = [];

  for (const [rawPath, content] of files) {
    const path = rawPath.replace(/\\/g, "/");
    if (path.includes("..") || path.startsWith("/")) {
      warnings.push(`忽略路径不安全的条目：${rawPath}`);
      continue;
    }
    const lower = path.toLowerCase();
    if (blocked.some((ext) => lower.endsWith(ext)) || lower.includes("scripts/")) {
      warnings.push(`当前版本不执行 Skill 脚本，已忽略：${path}`);
      continue;
    }
    totalBytes += typeof content === "string" ? content.length : content.byteLength;
    const segs = path.split("/").filter(Boolean);
    // SKILL.md：根目录或一级子目录，取层级最浅的一份
    if (segs.length >= 1 && segs.length <= 2 && segs[segs.length - 1].toLowerCase() === "skill.md") {
      if (segs.length < skillMdDepth) {
        skillMdDepth = segs.length;
        skillMdText = typeof content === "string" ? content : new TextDecoder().decode(content);
      }
      continue;
    }
    // references/ 只记文件名列表（内容本轮不落盘，与 .momoskill 一致）
    const refIdx = segs.indexOf("references");
    if (refIdx >= 0 && refIdx < segs.length - 1) references.push(segs.slice(refIdx + 1).join("/"));
  }
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Skill 包总体积超过 ${MAX_TOTAL_BYTES / 1024 / 1024}MB 上限`);
  if (skillMdText == null) throw new Error("压缩包里找不到 SKILL.md（Claude 风格 Skill 需包含 SKILL.md）");

  const { fm, instructions } = parseSkillMd(skillMdText);
  const r = skillFromFrontmatter(fm, instructions, "未命名 Skill", references.length ? references : undefined);
  return { skill: r.skill, warnings: [...warnings, ...r.warnings] };
}

/** .momoskill ZIP 包内的 skill.json 结构 */
type SkillJson = {
  momoSkill?: number;
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  contexts?: string[];
  phase?: string;
  output?: string;
  variables?: SkillVariable[];
};

/**
 * 从 .momoskill ZIP 解析（需传入已解压的文件映射）。
 * 本项目浏览器/Tauri 环境统一用 JSZip 解压，但为了不在 core 层引依赖，
 * 这里只接受「文件名 → 内容」的映射，解压由调用方完成。
 *
 * 安全检查：
 *  - 路径穿越：禁止包含 .. 或绝对路径的条目
 *  - 脚本文件：忽略并记 warning
 *  - 文件数量 / 总体积上限
 */
export function importSkillPackage(
  files: Map<string, Uint8Array | string>,
): ImportResult {
  const warnings: string[] = [];

  // 1. 安全检查：路径穿越 + 脚本文件 + 体积
  const blocked = [".js", ".mjs", ".cjs", ".py", ".sh", ".bat", ".cmd", ".ps1", ".exe", ".dll", ".so", ".dylib"];
  let totalBytes = 0;
  const cleaned = new Map<string, Uint8Array | string>();
  for (const [path, content] of files) {
    // 路径穿越防御
    if (path.includes("..") || /^[\\/]/.test(path)) {
      warnings.push(`忽略路径不安全的条目：${path}`);
      continue;
    }
    // 脚本文件忽略
    const lower = path.toLowerCase();
    if (blocked.some((ext) => lower.endsWith(ext)) || lower.startsWith("scripts/")) {
      warnings.push(`当前版本不执行 Skill 脚本，已忽略：${path}`);
      continue;
    }
    const bytes = typeof content === "string" ? content.length : content.byteLength;
    totalBytes += bytes;
    cleaned.set(path, content);
  }
  if (cleaned.size > MAX_FILES) throw new Error(`Skill 包文件数量超过 ${MAX_FILES} 上限`);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Skill 包总体积超过 ${MAX_TOTAL_BYTES / 1024 / 1024}MB 上限`);

  // 2. 读 skill.json
  const jsonRaw = cleaned.get("skill.json");
  if (!jsonRaw) throw new Error("Skill 包缺少 skill.json（请确认这是 MOMO Skill 包）");
  let sj: SkillJson;
  try {
    sj = JSON.parse(typeof jsonRaw === "string" ? jsonRaw : new TextDecoder().decode(jsonRaw));
  } catch {
    throw new Error("skill.json 解析失败：文件不是合法 JSON");
  }
  if (sj.momoSkill !== 1) throw new Error("skill.json 的 momoSkill 字段不是 1，可能不是 MOMO Skill 包");

  // 3. 读 instructions.md
  const instructionsRaw = cleaned.get("instructions.md");
  const instructions = instructionsRaw
    ? typeof instructionsRaw === "string" ? instructionsRaw : new TextDecoder().decode(instructionsRaw)
    : "";

  // 4. 读 references/（只记文件名列表，内容留在内存 Map 供执行时读取；本轮暂不落盘）
  const references: string[] = [];
  for (const path of cleaned.keys()) {
    if (path.startsWith("references/") && !path.endsWith("/")) {
      references.push(path.slice("references/".length));
    }
  }

  // 5. 校验 contexts/phase/output 合法性（同 importSkillMd；合法表唯一来源 SKILL_CONTEXTS）
  const validContexts: SkillContext[] = (sj.contexts ?? ["prompt.text"]).filter((c): c is SkillContext =>
    SKILL_CONTEXTS.includes(c as SkillContext),
  );
  const validPhases: SkillPhase[] = ["analyze", "authoring", "model-adapter", "validate"];
  const phase = (sj.phase && validPhases.includes(sj.phase as SkillPhase) ? sj.phase : "authoring") as SkillPhase;
  const validOutputs: SkillOutput[] = ["text", "prompt-plan", "poster-plan", "director-plan"];
  const output = (sj.output && validOutputs.includes(sj.output as SkillOutput) ? sj.output : "text") as SkillOutput;
  // 分型（能力层）：skill.json 同样支持 kind/triggers（triggers 仅作 Agent 路由提示）
  const sjExtra = sj as Record<string, unknown>;
  const rawKind = typeof sjExtra.kind === "string" ? sjExtra.kind : "";
  if (rawKind && rawKind !== "rule" && rawKind !== "workflow") {
    warnings.push(`kind 值不合法（${rawKind}），已按默认 rule 处理`);
  }
  const kind: MomoSkill["kind"] = rawKind === "workflow" ? "workflow" : rawKind === "rule" ? "rule" : undefined;
  const triggers = Array.isArray(sjExtra.triggers)
    ? sjExtra.triggers.map((t) => String(t).trim()).filter(Boolean).slice(0, 6)
    : [];

  const skill = newSkill({
    id: sj.id || sj.name || undefined, // 同上：稳定 id，重复导入覆盖更新
    name: sj.name || "未命名 Skill",
    version: sj.version || "1.0.0",
    description: sj.description || "",
    contexts: validContexts,
    phase,
    purpose: validPurpose((sj as Record<string, unknown>).purpose),
    output,
    instructions,
    references,
    variables: sj.variables ?? [],
    source: "import",
    ...(kind ? { kind } : {}),
    ...(triggers.length ? { triggers } : {}),
  });
  return { skill, warnings };
}
