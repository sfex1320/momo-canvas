/**
 * Skill 引擎路由（导演台 3.0）— 外调第三方 API ⇄ 本地大模型两条路线的 Skill 栈
 *
 * 导演台的生成引擎分两条路线：
 *  - local：本地 ComfyUI 配方（MiniMax H3 / LTX 等本地大模型工作流）；
 *  - remote：外调远程 Provider（Claude、Kling、Google Veo/Gemini 视频模型等）。
 * 同一个项目可能混用两条路线——H3 六段式提示词 Skill 只应进本地 H3 配方，
 * 外调模型要的是自然语言段落式提示词（且不认 <Picture N> 等占位语法）。
 * 绑定上的 scope（all/local/remote）+ modelPattern（模型/模板名关键词）决定
 * 「这次生成到底吃哪几个 Skill」；本模块是路由的唯一判定处，H3 编译 / AI 导演 /
 * AI 制图 / AI MV 四个消费点共用，不允许各自再写一份过滤。
 */
import { useSkills } from "../stores/skillStore";
import { useComfy } from "../stores/comfyStore";
import { buildSkillSystem } from "../skillEngine";
import type { DirectorProject } from "../types";
import type { SkillBinding, SkillPurpose, SkillRunSnapshot } from "../skillTypes";
import type { MomoSkill } from "../skillTypes";

/**
 * Skill 职能推断（3.3 §7 任务选择器的最小落地）：
 * 显式 purpose 优先；旧数据（如「剧本拆分MiniMax H3」）没有 purpose 时按名字/指令特征启发式——
 * 拆分类 Skill 只属于拆分链路，绝不进入生成提示词栈（§2.2 互相污染修复）。
 */
export function purposeOfSkill(sk: Pick<MomoSkill, "purpose" | "name" | "instructions" | "contexts" | "phase">): SkillPurpose {
  if (sk.purpose) return sk.purpose;
  const hay = `${sk.name}\n${sk.instructions.slice(0, 1500)}`;
  if (/剧本拆分|拆解|拆分能力|script[- ]?plan|分段规划|故事规划|接力规划/.test(hay)) return "script-plan";
  if (/项目包|交付规范|project[- ]?package|导出校验/.test(hay)) return "project-package";
  if (/提示词结构|提示词写作|prompt.{0,6}writ|H3 提示词|六段式|输出.{0,8}提示词|方言/.test(hay)) return "compile-video-prompt";
  if (sk.phase === "model-adapter") return "compile-video-prompt";
  if (sk.phase === "validate") return "validate";
  return "segment-authoring";
}

/** 生成提示词栈是否允许该 Skill 参与（拆分/项目包/校验类一律不进） */
export function isGenerationSkill(sk: MomoSkill): boolean {
  const p = purposeOfSkill(sk);
  return p !== "script-plan" && p !== "project-package" && p !== "validate";
}

/** 规划类 Skill 的指令文本（剧本拆分/精读链路注入用）：只要 script-plan / segment-authoring，
 *  排除 compile-*（提示词方言不属于拆分链，3.3 §2.2 污染修复）。 */
export function planningSkillSystem(project: DirectorProject): string {
  const skills = useSkills.getState();
  const out: string[] = [];
  for (const b of project.skillBindings ?? []) {
    if (!b.enabled) continue;
    const sk = skills.getById(b.skillId);
    if (!sk || !sk.enabled) continue;
    const p = purposeOfSkill(sk);
    if (p === "script-plan" || p === "segment-authoring") out.push(buildSkillSystem(sk, b.values));
  }
  return out.join("\n\n");
}

/** 路由上下文：engine 二选一；model/templateName 参与关键词匹配 */
export type SkillRouteCtx = {
  engine: "local" | "remote";
  /** 模型名（远程复合键取 model 段或全键参与匹配） */
  model?: string;
  /** 本地配方名 / 模板名（如 "REF2VA H3 多参考"） */
  templateName?: string;
};

/** 单绑定是否命中当前路由：scope 匹配 + 关键词（逗号分隔，不区分大小写）匹配任一即中 */
export function bindingMatchesRoute(b: SkillBinding, ctx: SkillRouteCtx): boolean {
  if (b.scope === "local" && ctx.engine !== "local") return false;
  if (b.scope === "remote" && ctx.engine !== "remote") return false;
  const pat = b.modelPattern?.trim();
  if (!pat) return true;
  const kws = pat.split(/[,，]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!kws.length) return true;
  const hay = [ctx.model ?? "", ctx.templateName ?? ""].join(" ").toLowerCase();
  return kws.some((k) => hay.includes(k));
}

export type RoutedSkill = {
  binding: SkillBinding;
  /** 拼好的 system（指令 + 变量值） */
  system: string;
  skillName: string;
  /** 职能（3.3 §7：生成栈只允许一个主 compile-*，拆分类不进） */
  purpose: SkillPurpose;
};

/**
 * 取项目绑定里对当前路由生效、且（可选）contexts 命中的 Skill 栈（保持绑定顺序）。
 * contexts 传空 = 不按上下文筛（项目级全量，仅按引擎路由）。
 * 3.3 §7：生成路径（compileSegmentPrompt 等）传入 excludePlanning=true 时排除
 * script-plan / project-package / validate 类 Skill——拆分规范不再被拼进最终提示词。
 */
export function routeSkillBindings(
  project: DirectorProject,
  ctx: SkillRouteCtx,
  contexts?: string[],
  opts: { excludePlanning?: boolean } = {},
): RoutedSkill[] {
  const skills = useSkills.getState();
  const out: RoutedSkill[] = [];
  for (const b of project.skillBindings ?? []) {
    if (!b.enabled) continue;
    if (!bindingMatchesRoute(b, ctx)) continue;
    const sk = skills.getById(b.skillId);
    if (!sk || !sk.enabled) continue;
    if (contexts?.length && !sk.contexts.some((c) => contexts.includes(c))) continue;
    const purpose = purposeOfSkill(sk);
    if (opts.excludePlanning && (purpose === "script-plan" || purpose === "project-package" || purpose === "validate")) continue;
    out.push({ binding: b, system: buildSkillSystem(sk, b.values), skillName: sk.name, purpose });
  }
  return out;
}

/** 把路由后的 Skill 栈拼成提示词尾注（生成路径用），同时产出追溯快照 */
export function applySkillStack(prompt: string, stack: RoutedSkill[]): { prompt: string; snapshots: SkillRunSnapshot[] } {
  if (!stack.length) return { prompt, snapshots: [] };
  const skills = useSkills.getState();
  const snapshots: SkillRunSnapshot[] = stack.map(({ binding, skillName }) => {
    const sk = skills.getById(binding.skillId);
    return {
      skillId: binding.skillId,
      name: skillName,
      version: sk?.version ?? "",
      instructionFingerprint: sk?.instructionFingerprint ?? "",
      values: binding.values,
    };
  });
  return { prompt: `${prompt}\n\n${stack.map((s) => s.system).join("\n\n")}`, snapshots };
}

/**
 * 片段配方的路由上下文：comfy 配方 → local（带配方名），远程配方/无配方 → remote（带模型名）。
 * 无配方（远程默认模型）按 remote 处理——与 runBatch 执行时的引擎判定一致。
 */
export function routeCtxOfRecipe(
  project: DirectorProject,
  recipe: { engine?: "comfy" | "provider"; templateId?: string; name?: string; providerModelKey?: string } | undefined,
  fallbackModelKey?: string,
): SkillRouteCtx {
  void project; // 保留签名占位：调用方习惯传 project（配方解析在各自队列里已有，避免重复实现）
  if (recipe?.engine === "comfy") {
    const tpl = recipe.templateId ? useComfy.getState().templates.find((t) => t.id === recipe.templateId) : undefined;
    return { engine: "local", templateName: tpl?.name ?? recipe.name, model: recipe.templateId };
  }
  const key = recipe?.providerModelKey ?? fallbackModelKey ?? "";
  return { engine: "remote", model: key.split("::").pop() || key };
}
