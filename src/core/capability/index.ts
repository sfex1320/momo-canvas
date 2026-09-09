/**
 * 能力注册表 + 执行信封（能力总线）
 *
 * 注册表是「MOMO 会做什么」的单一目录；执行信封保证每件事都按同一套
 * 顺序过闸：查找 → 校验 → 确认策略 → 预算 → 幂等 → 执行 → 完成验证。
 * 创作助手的 tool 动作、MCP 适配器（capability/mcp.ts）、导演台/画布
 * 的扣费路径共用这一个入口。
 *
 * 确认策略在信封里的落地：
 *  none / proposal / immediate —— 直接进执行（proposal 型的 run() 自己送审）；
 *  inline —— 调用方未带 confirmed 时返回 confirm 计划（带上预算闸的确认话术），
 *            由调用方（创作助手）走自己的确认卡，用户确认后带 confirmed 再进来。
 *
 * 幂等账本是内存版（会话级）：提供 idemKey 的能力（写/提案类）同键重复
 * 调用直接复用上次结果——「用户已确认」类重放的工程化解法。扣费类不加
 * idemKey：重跑是合法诉求，防重放由确认闸 + 预算 + 批量重入锁承担。
 */
import type { CallerCtx, CapabilityDef } from "./types";
import { budgetGate } from "./budget";

/* eslint-disable @typescript-eslint/no-explicit-any -- 注册表存异构定义，统一 any 收纳 */
const registry = new Map<string, CapabilityDef<any, any>>();

/** 泛型入口：从 validate 的返回类型推断 A，让 confirm/estimate/run 的 args 拿到真类型 */
export function registerCapability<A, R>(def: CapabilityDef<A, R>): void {
  registry.set(def.id, def as CapabilityDef<any, any>);
}

export function unregisterCapability(id: string): void {
  registry.delete(id);
}

export function getCapability(id: string): CapabilityDef<any, any> | undefined {
  return registry.get(id);
}

export function listCapabilities(): CapabilityDef<any, any>[] {
  return [...registry.values()];
}

/**
 * Agent 的 tool 动作目录：只读 + 提案型写入 + 显式放行的扣费类。
 * read/提案对模型安全（提案须用户审核）；spend 默认不进目录——生成走
 * image/video 动作各自的确认闸，显式声明 agentSpendAllowed 的例外
 * （导演台批量生成 / ComfyUI 模板运行）由信封强制内联确认 + 预算。
 */
export function agentToolCatalog(): CapabilityDef<any, any>[] {
  return listCapabilities().filter(
    (c) => c.agentCallable !== false && (c.risk !== "spend" || c.agentSpendAllowed === true),
  );
}

export type ExecOutcome =
  | { kind: "done"; text: string; data?: unknown }
  /** 需要用户确认：prompt 已含预估话术，确认后带 confirmed 重进 */
  | { kind: "confirm"; prompt: string }
  /** 被闸门拦截（预算/策略），不是执行失败 */
  | { kind: "blocked"; reason: string }
  | { kind: "error"; error: string };

/** 内存幂等账本：idemKey → 上次结果（会话级，重启自然清空） */
const idemLedger = new Map<string, { ok: boolean; text?: string; data?: unknown; error?: string }>();

/**
 * 执行一个能力（完整信封）。
 * opts.confirmed=true 表示 inline 确认已经过用户之手（创作助手确认卡）。
 */
export async function executeCapability(
  id: string,
  rawArgs: unknown,
  ctx: CallerCtx,
  opts?: { confirmed?: boolean },
): Promise<ExecOutcome> {
  ctx.signal?.throwIfAborted();
  const def = getCapability(id);
  if (!def) return { kind: "error", error: `未知能力：${id}。可用能力见 tool 目录，不要虚构能力名。` };
  let args: unknown;
  try {
    args = def.validate(rawArgs);
  } catch (e) {
    return { kind: "error", error: `参数不合法：${(e as Error).message}` };
  }
  // 扣费类：统一预算闸（block 直接拦；confirm 阈值并入确认话术）
  let gateNote = "";
  if (def.risk === "spend" && def.estimate) {
    const est = def.estimate(args);
    if (est) {
      const gate = budgetGate(est.cost, est.label);
      if (gate.block) return { kind: "blocked", reason: gate.block };
      if (gate.confirm) gateNote = `\n${gate.confirm}`;
    }
  }
  const policy = def.confirm(ctx.channel, args);
  // inline 确认：没带 confirmed 就先把方案（含预算话术）递出去问用户
  if (policy.type === "inline" && !opts?.confirmed) {
    return { kind: "confirm", prompt: `${policy.prompt}${gateNote}` };
  }
  // 幂等：同键重复调用直接复用（「用户已确认」的重放不重复执行）
  const rawKey = def.idemKey?.(args);
  const key = rawKey ? `${id}:${ctx.projectId ?? ""}:${rawKey}` : undefined;
  if (key) {
    const prev = idemLedger.get(key);
    if (prev) {
      return prev.ok
        ? { kind: "done", text: `${prev.text}（与刚才的操作完全相同，直接沿用上次结果）`, data: prev.data }
        : { kind: "error", error: prev.error ?? "上次执行失败" };
    }
  }
  let result;
  try {
    ctx.signal?.throwIfAborted();
    result = await def.run(args, ctx);
    ctx.signal?.throwIfAborted();
  } catch (e) {
    const error = (e as Error).message || String(e);
    if (ctx.signal?.aborted) throw ctx.signal.reason;
    return { kind: "error", error };
  }
  const problems = def.verify?.(result, args) ?? [];
  if (problems.length) {
    const error = `完成验证未通过：${problems.join("；")}`;

    return { kind: "error", error };
  }
  if (key) idemLedger.set(key, { ok: true, text: result.text, data: result.data });
  return { kind: "done", text: result.text, data: result.data };
}

/** 给 Agent 系统提示的工具目录段（无能力时返回空串，不占提示词） */
export function agentToolHint(): string {
  const caps = agentToolCatalog();
  if (!caps.length) return "";
  const lines = caps
    .map((c) => {
      const params = Object.keys(c.inputSchema.properties);
      const spendNote = c.risk === "spend" ? "【扣费/占卡，需用户确认后执行】" : "";
      return `- ${c.id}：${spendNote}${c.description}${params.length ? `（参数：${params.join("、")}）` : "（无参数）"}`;
    })
    .join("\n");
  return `\n\n【工作区能力——tool 动作】用户的问题涉及 MOMO 工作区现状（导演台项目与片段进度、画布节点、ComfyUI 模板、待审提案）时，必须先用 tool 动作查询再回答，不要虚构工作区状态；用户要求实际执行（补缺生成、跑本地工作流）时也用 tool 动作发起：\n{"action":"tool","tool":"能力id","args":{}}\n可用能力：\n${lines}\n规则：tool 只读、提交待审提案、或经用户确认后执行扣费操作；只读结果下一轮返回，提案提交后交用户在导演台·AI 导演工位审核生效（你在回复里说明这一点即可，不要声称已改）；带【扣费】标记的能力执行前程序会向用户确认，确认后直接执行，你不要重发。`;
}

/* 注册时机说明：本模块必须保持无环（只依赖 types/budget）。内置能力的注册由
 * builtin.ts 顶层完成，其副作用导入放在消费方 agentEngine（应用加载它时必然
 * 先于任何 tool 调用）。**不要在本文件 import builtin**——静态导入会被提升到
 * 本模块求值之前执行，builtin 的顶层 registerCapability 将撞上 `const registry`
 * 的 TDZ（ReferenceError: Cannot access 'registry' before initialization，白屏）。 */

