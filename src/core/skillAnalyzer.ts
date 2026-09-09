/**
 * Skill 分型的 LLM 分析（kind: rule | workflow + triggers）
 *
 * 导入的 Skill 只有手工 frontmatter 才带 kind/triggers；这里用对话模型读一遍
 * 指令正文做结构化判定，用户在 Skill 详情里点「AI 分析分型」预览后手动应用。
 * triggers 只是 Agent 路由提示（用户看/模型提名用），不是扣费/写入的放行依据。
 */
import { chatOnce } from "./services/llm";
import { resolveModelCard } from "./stores/settingsStore";
import { parseJsonLoose } from "./utils";

export type SkillKindAnalysis = {
  kind: "rule" | "workflow";
  triggers: string[];
  /** 一句话判定依据（给用户预览用） */
  note: string;
};

const SYS = `你是 MOMO 智能画布 Skill 系统的元数据分析器。读一份 Skill 的名称/描述/指令正文，判定分型并提炼触发条件。

分型规则：
- rule（规则型）：一份提示词/写作规范——告诉模型「怎么写、遵守什么结构/风格/比例」，作为 system 注入一次即可生效（哪怕正文很长，本质仍是规范文本）。
- workflow（工作流型）：包含明确的分步骤执行流程、多阶段产物、步骤间有先后依赖或执行计划（如「第一步…第二步…最后…」「先产出A再基于A产出B」）。

输出一个 JSON 对象（不要输出任何其他文字、不要代码块包裹）：
{"kind":"rule 或 workflow","triggers":["2-4 条中文触发条件：用户提出什么样的请求时该用这个 Skill"],"note":"一句话判定依据（30 字内）"}
triggers 只描述「什么时候用」，不要包含任何执行指令；不确定的项宁可少写。`;

export async function analyzeSkillMeta(skill: {
  name: string;
  description?: string;
  instructions: string;
}): Promise<SkillKindAnalysis> {
  const card = resolveModelCard("chat");
  const user = [
    `Skill 名称：${skill.name}`,
    `描述：${skill.description || "（无）"}`,
    `指令正文（截取前 6000 字）：`,
    skill.instructions.slice(0, 6000) || "（空）",
  ].join("\n");
  const raw = await chatOnce(card, SYS, user);
  const j = parseJsonLoose<Record<string, unknown>>(raw);
  const kind = j?.kind === "workflow" ? "workflow" : j?.kind === "rule" ? "rule" : null;
  if (!kind) throw new Error("模型返回不符合分型 JSON 合同，请重试");
  const triggers = Array.isArray(j?.triggers)
    ? j!.triggers.map((t) => String(t).trim()).filter(Boolean).slice(0, 4)
    : [];
  return { kind, triggers, note: typeof j?.note === "string" ? j.note.slice(0, 60) : "" };
}
