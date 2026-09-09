/**
 * 能力层类型 —— MOMO 统一执行信封（能力总线第一阶段）
 *
 * 背景：同一件事（生成、写入、查询）此前散落在画布 runner、导演台队列、
 * 创作助手三条路径上，各自的校验/确认/预算/记账策略不一致（典型：助手
 * 生图不过预算闸、不记用量）。能力层把「一件事」包成 CapabilityDef：
 * 校验 → 确认策略 → 预算 → 幂等 → 执行 → 完成验证，全部从同一道门过。
 *
 * 分阶段接入（见 AGENTS.md 能力层）：
 *  ① 只读能力（risk=read）——第一批，创作助手 tool 动作直连；
 *  ② 提案型写入（risk=write）——run() 只负责把提案送进 useAgentProposals
 *     审核池，真实写入永远由用户在 AI 导演工位确认后走受控应用器；
 *  ③ 扣费能力（risk=spend）——最后接入，estimate() 接统一预算闸。
 */

/** 调用通道：同一能力从不同入口发起，确认策略可以不同 */
export type CapabilityChannel = "assistant" | "canvas" | "director" | "external";

export type CallerCtx = {
  channel: CapabilityChannel;
  /** 发起方绑定的导演台项目 id（能力自行决定是否采用） */
  projectId?: string;
  /** 取消信号（复用 runControl 的停止通道） */
  signal?: AbortSignal;
};

/** 能力风险等级：read 只读 / write 写入（必须走提案审核）/ spend 扣费 */
export type CapabilityRisk = "read" | "write" | "spend";

/**
 * 确认策略：通道 × 能力共同决定，而不是各调用点自己拍。
 *  none      —— 只读，直接执行；
 *  proposal  —— run() 只提交提案，用户审核后才真正写入（写类的唯一通道）；
 *  inline    —— 调用方先向用户确认（创作助手的生成确认闸）再执行；
 *  immediate —— 用户手点即确认（画布/导演台工位内）。
 */
export type ConfirmPolicy =
  | { type: "none" }
  | { type: "proposal" }
  | { type: "inline"; prompt: string }
  | { type: "immediate" };

/** 能力执行结果（text 是给模型看的反馈，agent 模式直接回注对话） */
export type CapabilityResult = {
  text: string;
  data?: unknown;
};

/** 能力定义。泛型 A=校验后的参数类型；run 的返回即 CapabilityResult。 */
export type CapabilityDef<A = Record<string, unknown>, R = CapabilityResult> = {
  id: string;
  title: string;
  /** 一句话说明（进 Agent 的 tool 目录与系统提示） */
  description: string;
  risk: CapabilityRisk;
  /**
   * 能力来源：builtin 内置 / mcp 外部服务器适配。mcp 来源的能力在每次
   * 同步时整批重建（先清后注册），服务器禁用/改名不留残骸。
   */
  source?: "builtin" | "mcp";
  /**
   * 是否进 Agent 的 tool 目录（默认 true）。
   * spend 类默认不进目录（生成必须走 image/video 动作各自的确认闸），
   * 显式声明 agentSpendAllowed=true 的例外（director.run_batch / comfy.run_template）：
   * 信封会强制内联确认 + 预算 + 重入保护后才放行。
   */
  agentCallable?: boolean;
  /** spend 类显式允许进 Agent 目录（见上）；read/write 类直接用 agentCallable 控制 */
  agentSpendAllowed?: boolean;
  /** 给模型的参数签名（JSON Schema 子集：object + properties + required） */
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  /** 运行时校验：吃 unknown 吐类型化 args；失败抛带中文信息的 Error */
  validate: (args: unknown) => A;
  /** 确认策略（read → none；write → proposal；spend → inline/immediate 由通道决定） */
  confirm: (channel: CapabilityChannel, args: A) => ConfirmPolicy;
  /** 扣费预估（risk=spend 必填；进统一预算闸） */
  estimate?: (args: A) => { cost: number; label: string } | null;
  /** 幂等键（写/扣费类必填）：同键重复调用直接返回上次结果，防重放 */
  idemKey?: (args: A) => string;
  /** 实际执行（已过闸门与确认） */
  run: (args: A, ctx: CallerCtx) => Promise<R> | R;
  /** 完成验证：返回问题文案数组，空 = 通过。写/扣费类建议提供 */
  verify?: (result: R, args: A) => string[];
};
