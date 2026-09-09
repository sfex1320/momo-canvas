/**
 * MOMO Skill 类型定义 — 可安装、可配置、可复用、可验证的创作规则包
 *
 * Skill 不是模型，也不只是保存一段「万能提示词」。它告诉 MOMO：
 *  - 当前内容要按什么专业流程完善
 *  - 必须遵守哪些比例、尺度、构图、镜头或文字规则
 *  - 需要向用户补问哪些变量
 *  - 结果应输出普通文本，还是结构化数据（海报版式、导演镜头等）
 *
 * 详见《MOMO导演台节点-产品与技术方案.md》§17。
 */

/** Skill 适用的工作上下文（决定 Skill 出现在哪些入口） */
export type SkillContext =
  | "prompt.text"
  | "prompt.image"
  | "prompt.video"
  | "director.project"
  | "director.segment"
  | "poster.layout"
  | "ecom.layout"
  | "agent.image"
  | "agent.video"
  /* —— 制片工作站 3.0：新工位的 Skill 扩展点 —— */
  | "studio.director" // AI 导演工位：故事共创 / 方案拆解的对话规范
  | "studio.image" // AI 制图工位：文生图 / 图生图 / 编辑图的提示词规范
  | "studio.mv"; // AI MV 工位：区间运动 / 氛围提示词规范

/** 全部合法 contexts（导入校验 / 管理器标签 / 绑定卡筛选的单一来源）
 *  ⚠️ 已冻结（12 成员封顶）：context 轴混合了媒介/业务对象/界面工位/Agent 入口四种维度，
 *  继续加枚举是笛卡尔积式膨胀。新工位的入口聚合改由 purpose + scope/modelPattern（skillRoute）
 *  与能力层（capability/）承担；确需新入口先在 AGENTS.md「能力层」节登记评审。 */
export const SKILL_CONTEXTS: SkillContext[] = [
  "prompt.text",
  "prompt.image",
  "prompt.video",
  "director.project",
  "director.segment",
  "poster.layout",
  "ecom.layout",
  "agent.image",
  "agent.video",
  "studio.director",
  "studio.image",
  "studio.mv",
];

export const SKILL_CONTEXT_LABEL: Record<SkillContext, string> = {
  "prompt.text": "文本提示词",
  "prompt.image": "图片提示词",
  "prompt.video": "视频提示词",
  "director.project": "导演台·项目",
  "director.segment": "导演台·片段",
  "poster.layout": "海报排版",
  "ecom.layout": "电商图",
  "agent.image": "助手·出图",
  "agent.video": "助手·出片",
  "studio.director": "工位·AI 导演",
  "studio.image": "工位·AI 制图",
  "studio.mv": "工位·AI MV",
};

/** Skill 执行阶段（固定排序：analyze → authoring → model-adapter → validate） */
export type SkillPhase = "analyze" | "authoring" | "model-adapter" | "validate";

/**
 * Skill 职能（3.3 §5/§7）：一个 Skill 只干一件事。
 * 拆分类（script-plan / project-package）绝不进入生成提示词栈；
 * 生成栈的 model-adapter 只允许一个主 compile-* 产出最终 prompt。
 * 缺省时由 skillRoute 的启发式推断（名字/指令特征），导入 frontmatter 可显式声明。
 */
export type SkillPurpose =
  | "script-plan" // 项目/剧本规划（拆分、接力规划；只进拆分链路）
  | "segment-authoring" // 模型无关的片段写作规范
  | "compile-video-prompt" // 目标模型视频提示词方言（生成栈 model-adapter）
  | "compile-image-prompt" // 制图提示词方言
  | "project-package" // 项目包导出/校验（只在导出时运行）
  | "validate"; // 结果校验（只报告不改写）

export const SKILL_PURPOSE_LABEL: Record<SkillPurpose, string> = {
  "script-plan": "剧本规划",
  "segment-authoring": "片段写作",
  "compile-video-prompt": "视频提示词方言",
  "compile-image-prompt": "制图提示词方言",
  "project-package": "项目包校验",
  validate: "结果校验",
};

/** Skill 输出合同类型 */
export type SkillOutput = "text" | "prompt-plan" | "poster-plan" | "director-plan";

/** Skill 变量类型 */
export type SkillVariableType = "text" | "number" | "boolean" | "select";

/** Skill 变量定义（导入时声明，用户执行前填值） */
export type SkillVariable = {
  key: string;
  label: string;
  type: SkillVariableType;
  /** select 类型的候选值 */
  options?: string[];
  /** 默认值（text/number/boolean/select 各按类型） */
  default?: string | number | boolean;
  required?: boolean;
  /** 一行说明（悬浮提示） */
  hint?: string;
};

/** Skill 本体（保存在 skillStore，节点/导演项目只保存 SkillBinding） */
export type MomoSkill = {
  id: string;
  name: string;
  version: string;
  description: string;
  /** 来源：内置 或 用户导入 */
  source: "builtin" | "import";
  /** 分型（能力层）：rule = 纯规范文本（现状默认，只做提示词注入）；
   *  workflow = 带分步执行计划的扩展型（导入时 LLM 分析可选产出，现阶段仅登记元数据，
   *  执行编排统一走能力层注册表，Skill 自身不持有执行权） */
  kind?: "rule" | "workflow";
  /** Agent 路由提示（自然语言触发条件，workflow 型 Skill 用）：
   *  只用于能力层提名候选，绝不作为扣费/写入动作的放行依据——放行只认确定性链（purpose/scope + 信封闸门） */
  triggers?: string[];
  /** 适用上下文（决定 Skill 出现在哪些入口） */
  contexts: SkillContext[];
  /** 执行阶段（同一阶段可多个 Skill，用户可排序） */
  phase: SkillPhase;
  /** 职能（3.3 §7 任务选择器；缺省由路由启发式推断） */
  purpose?: SkillPurpose;
  /** 输出合同类型 */
  output: SkillOutput;
  /** 完整指令文本（SKILL.md / instructions.md 内容） */
  instructions: string;
  /** 参考资料文件名列表（内容在导入时落盘到 Skill 目录，执行时读取） */
  references?: string[];
  /** 变量定义 */
  variables: SkillVariable[];
  /** 是否启用（禁用的 Skill 不出现在选择器，但已绑定的历史快照仍保留） */
  enabled: boolean;
  /** 是否收藏置顶 */
  starred?: boolean;
  /** 指令内容指纹（用于检测更新后让旧生成记录知道规则已变化） */
  instructionFingerprint?: string;
  createdAt: number;
  updatedAt: number;
};

/** 节点/导演项目里保存的 Skill 绑定（不存 Skill 本体，只存 id + 变量值 + 启停） */
export type SkillBinding = {
  skillId: string;
  enabled: boolean;
  /** 变量值（key → 值） */
  values: Record<string, string | number | boolean>;
  /* —— 引擎路由（导演台 3.0：外调第三方 API ⇄ 本地大模型两条路线用不同的 Skill 栈）—— */
  /** 生效范围：all 全部引擎 / local 仅本地 ComfyUI 配方 / remote 仅外调远程 Provider */
  scope?: "all" | "local" | "remote";
  /** 模型/模板名关键词（逗号分隔，如 "H3,LTX"）：命中才生效——留空匹配全部 */
  modelPattern?: string;
};

/** 每次 Skill 执行后写入生成历史 / Take 的快照（不可变，Skill 更新后旧记录仍可追溯） */
export type SkillRunSnapshot = {
  skillId: string;
  name: string;
  version: string;
  instructionFingerprint: string;
  values: Record<string, unknown>;
};

/** 海报结构化输出（SkillOutput = "poster-plan" 时） */
export type PosterPlan = {
  prompt: string;
  negativePrompt?: string;
  aspect: string;
  safeMarginPct: number;
  grid: string;
  subject: { position: string; scalePct: number };
  title: { text: string; zone: string; maxLines: number; hierarchy: number };
  subtitle?: { text: string; zone: string; maxLines: number };
  cta?: { text: string; zone: string };
  palette?: string[];
  checklist: string[];
};
