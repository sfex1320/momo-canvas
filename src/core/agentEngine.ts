/**
 * Agent 模式引擎 —— 对话式创作循环
 *
 * 不依赖各家模型的 function calling（中转站支持参差不齐），
 * 而是用「每次回复必须是一个 JSON 动作」的纯文本协议驱动：
 *   search → 联网搜索；ask → 向用户提问并挂起等待抉择；
 *   image / video → 调生成服务；reply → 收尾汇报，结束本轮。
 * 工具结果以「系统反馈」用户消息回注，模型据此选择下一步，最多 12 轮。
 */
import type { AgentResult, ChatMsg, ModelCard, SearchHit } from "./types";
import { useAgent } from "./stores/agentStore";
import { useSettings, resolveModelCard } from "./stores/settingsStore";
import { useAssets } from "./stores/assetStore";
import { useUi, pushError, toast } from "./stores/uiStore";
import { useBoard } from "./stores/boardStore";
import { chatStream } from "./services/llm";
import { searchContext, webSearchForModel } from "./services/webSearch";
import { brandPrompt } from "./stores/designStore";
import { generateImage } from "./services/imageGen";
import { generateVideo } from "./services/videoGen";
import { runFlow } from "./runner";
import { assetUrl } from "./services/assetFiles";
import { clamp, errMsg, isTauri, parseJsonLoose, uid } from "./utils";
import { beginTask, endTask, isAbortError } from "./runControl";
import { chatCaps, familyPresets, gptSize, imageFamily, nearestAspect, parseRatio, scalePresetToTier } from "./modelMeta";
import { normalizeAgentAction, type AgentAction } from "./agentProtocol";
import { executeCapability, agentToolHint, getCapability } from "./capability";
// 内置能力的注册副作用：应用加载本模块时完成（必须由消费方触发——index.ts 若直接
// import builtin 会被静态提升，在 index 自己求值前执行注册，撞上 const registry 的 TDZ）
import "./capability/builtin";
import { checkAgentTurn, waitAgentTurn, generationRefs } from "./agentTurn";
import { budgetGate } from "./capability/budget";
import { estimateCost } from "./pricing";
import { useUsage } from "./stores/usageStore";

const MAX_ROUNDS = 12;
let activeTurn: AbortController | null = null;
/** 停止理解、确认等待和本轮生成；服务端已受理任务的计费以服务商为准。 */
export function stopAssistant() { activeTurn?.abort(); }


/** 执行轨迹与确认卡必须显示到具体模型，不能只写服务商名让直选看起来像没生效。 */
const modelLabel = (card: Pick<ModelCard, "name" | "model">) => `${card.name} · ${card.model}`;

const AGENT_SYSTEM = `你是 MOMO 智能画布的「创作 Agent」，一位全能 AI 美术指导。
用户用自然语言描述创作需求（可能附参考图）。你的职责：理解需求 → 必要时联网搜集资料 → 关键方向与用户确认 → 撰写高质量提示词 → 调用生成工具产出图片/视频 → 简要汇报。

【输出协议】你的每次回复必须且只是一个 JSON 对象（不要输出任何其他文字、不要用代码块包裹），从以下动作中选择一个：

{"action":"search","query":"搜索词"} —— 联网搜索资料/参考/灵感，结果下一轮给你。
{"action":"ask","question":"问题","options":["选项A","选项B","选项C"]} —— 需求存在关键分叉（风格、用途、画幅、色调等）且不同选择会明显影响成品时，给用户 2-4 个互斥选项。用户的选择下一轮告诉你。只为真正影响方向的抉择提问，整个任务最多问 1-2 轮。想给用户多个风格/方向候选时必须用这个动作（选项=各方案的简短描述），用户选定后直接 image——禁止一边介绍多个方案一边直接发起 image：程序的「确认生成」卡不是风格选择工具。
{"action":"image","prompt":"完整绘图提示词","count":1,"aspect":"1:1","resolution":"1K","useRefs":true} —— 生成图片。prompt 必须是成品级中文提示词：主体、细节、构图、光影、色彩、风格、质感、镜头，宁详勿略。useRefs=true 表示把用户的参考图传给绘图模型（图生图/参考风格）。
{"action":"video","prompt":"完整视频提示词","useRefs":true,"duration":"5"} —— 生成视频。useRefs=true 时用最近生成/用户提供的图片作为首帧或主体参考。
{"action":"reply","text":"对用户说的话"} —— 收尾：汇报成果/回答问题/闲聊。生成图片或视频后必须用它结束本轮。

【画幅与清晰度——必须遵守】
- 用户明确指定了比例（如 9:16、16:9、竖屏、横屏、方图）时，image 动作的 aspect 必须严格按用户要求填写（竖屏=高度大于宽度的比例，如 "9:16"；横屏如 "16:9"）。
- 用户给的是像素尺寸（如 1920×1080、1080p）时，换算成最接近的比例填 aspect（如 "16:9"），清晰度按像素量定档（1080p≈"2K"）。
- 用户没提比例且画幅会明显影响用途（海报/壁纸/头像/短视频封面等）时，先 ask 一轮确认，把比例和清晰度合并成一个问题，选项如：「竖屏 9:16 · 标清」「横屏 16:9 · 标清」「方图 1:1 · 高清」。用户选完后按其执行。
- resolution 仅三档："1K"（默认）/"2K"（高清）/"4K"（超清）；用户要高清、大图、印刷时填 "2K" 或 "4K"，未提及时一律 "1K"。

【生成确认闸——程序强制】
- image / video 动作第一次执行前，程序会自动向用户确认方案（汇总提示词/画幅/模型），用户确认后**程序直接执行该动作**，执行结果下一轮告诉你——你不需要重发动作，也不要自己在 ask 里做确认。
- 若用户选择「再想想/再改改」，先与用户完善方案（reply / ask），在用户明确要求前不要再输出生成动作。
- 当用户已经对你上一条生成方案回答「确认/开始/生成/可以」，或明确说「立即生成/重新生成/再来一张」时，必须立刻输出对应的 image / video 动作。禁止再用 reply 说「方案已锁定」「确认后程序会自动生成」「下一轮开始生成」——reply 只是文字，不会调用生成工具。

【每轮创作闭环——首轮与后续修改完全一致】
1. 理解本轮目标与上一轮成果；涉及药品说明、产品参数、时效信息、事实核对或用户明确要求搜索时，先 search。只改颜色、构图、文字等已有方案内容时可直接沿用上下文，不为走流程而搜索。
2. 综合搜索结果、参考图片和历史方案进行思考，形成完整成品提示词。
3. 准备好后直接输出 image/video 动作；程序会在确认卡里向用户展示提示词，并提供「确认生成 / 再想想」。不要先用 reply 展示一遍方案再让用户另发“生成”。
4. 用户要求修改上一轮图片时，把上一轮成图当作视觉参考，image 动作设 useRefs=true；修改完成后重新走本闭环。

【行为准则】
- 目标导向：用户要的是成品，不是聊天。需求明确（含画幅）时尽快进入生成，不要无谓地多问。用户没指定风格时，用你的专业判断直接定一个高质量方向生成——用户不满意自然会说「再改改」，这比先抛一堆方案问一圈更受欢迎。
- 需要事实、潮流、参考资料时先 search，把搜到的要点织进提示词。
- 用户要求 N 张时把 count 填成 N（上限 4）；一轮可以生成多张方案图对比，但总数不超过 3 张图或 1 条视频，除非用户明确要求更多。
- 【重要】历史里的「已交付」只属于当时那一轮。用户在后续消息中再次要求生成、要求修改后重新生成、或说"再来一张/换个风格"时，你必须重新执行 image / video 动作产出新图——只用 reply 说"已生成/已完成"而不执行动作，等于什么都没做。
- 【禁止虚构系统状态】生成是否失败、失败原因，一律以「【系统反馈】」里的原文为准——不要自己编造"通道异常/模型未返回结果/连续失败"这类说辞，也不要引用不存在的界面按钮（如「重新生成」按钮）。用户说"重新生成/再来一次"时，正确做法是你自己重新输出 image / video 动作，而不是让用户去点什么。
- 全程使用中文。`;

/** 从模型输出里抠出动作 JSON；抠不出来就返回 null（当普通文本回复处理） */
function parseAction(raw: string): AgentAction | null {
  return normalizeAgentAction(parseJsonLoose<Record<string, unknown>>(raw));
}

/** 把 Agent 请求的比例/清晰度映射成该绘画模型家族的实际请求参数（ Banana 走 aspect/resolution，其余家族换算成尺寸） */
function agentImageParams(card: ModelCard, aspect?: string, resolution?: string): { aspect?: string; resolution?: string; size?: string } {
  if (!aspect) return {};
  const family = imageFamily(card);
  if (family === "banana") {
    const r = parseRatio(aspect);
    return { ...(r ? { aspect: nearestAspect(r) } : {}), ...(resolution ? { resolution } : {}) };
  }
  const r = parseRatio(aspect);
  if (!r) return {};
  if (family === "gpt") {
    const s = gptSize(aspect, resolution ?? "1K");
    return s ? { size: `${s.w}x${s.h}` } : {};
  }
  // seedream / flux / qwen / generic：家族预设 × 清晰度档缩放
  // （以前 resolution 在这里被静默丢掉——用户点名 4K 也只出 1K 预设尺寸）
  const presets = familyPresets(family);
  const best = nearestAspect(r, presets.map((p) => p.ratio));
  const p = presets.find((x) => x.ratio === best);
  if (!p) return {};
  const s = scalePresetToTier(p, resolution, family);
  return { size: `${s.w}x${s.h}` };
}

/** 生图请求参数 → 画布 imageGen 节点的字段（banana 存 aspect/resolution，其余家族存 width/height） */
function sizingToNodeData(sizing: { aspect?: string; resolution?: string; size?: string }, aspect?: string): Record<string, unknown> {
  if (sizing.aspect) return { aspect: sizing.aspect, ...(sizing.resolution ? { resolution: sizing.resolution } : {}) };
  if (sizing.size) {
    const [w, h] = sizing.size.split("x").map(Number);
    if (w && h) return { width: w, height: h, size: "default", ...(aspect ? { aspect } : {}) };
  }
  return {};
}

/** 会话历史 → LLM 上下文（助手消息压缩成一句话摘要，附工具反馈） */
function buildContext(scratch: string[], includeGeneratedImages = false): ChatMsg[] {
  const st = useAgent.getState();
  const msgs = st.messages;
  const ctx: ChatMsg[] = [];
  // 前情摘要（与聊天模式共用一份）：窗口之外的早期讨论以要点形式延续，Agent 多轮任务不断片
  if (st.summary) {
    ctx.push({
      role: "user",
      text: `【前情摘要】以下是更早对话的要点（供你延续上下文，不必向用户复述）：\n${st.summary}`,
    });
  }
  const recent = msgs.slice(-14);
  const lastVisualMsgId = includeGeneratedImages
    ? [...recent].reverse().find((m) => m.results?.some((r) => r.kind === "image"))?.id
    : undefined;
  for (const m of recent) {
    if (m.role === "user") {
      ctx.push({ role: "user", text: (m.text || "（参考图）") + (m.referenceMode === "none" ? "\n【本轮设置】不参考历史图片，生成动作 useRefs 必须为 false。" : ""), images: m.images });
    } else {
      // 进行中的那条助手消息不进上下文
      if (!m.text && !m.results?.length) continue;
      // 已交付内容必须带提示词回注——用户说「把刚才那张改成蓝色」时，模型得知道「刚才那张」是什么
      const done = [
        m.text,
        m.question ? `（曾向你确认「${m.question.text}」，你选择：${m.question.answer ?? "未答"}）` : "",
        m.results?.length
          ? `（已交付 ${m.results.length} 个${m.results[0].kind === "video" ? "视频" : "图片"}，提示词：${(m.results[0].prompt ?? "").slice(0, 3000)}）`
          : "",
      ].filter(Boolean).join("\n");
      ctx.push({ role: "assistant", text: done || "…" });
      // 后续修改必须让真正支持视觉的对话模型重新看到上一轮成图，而不是只读 80 字提示词摘要。
      // 用 user 视觉上下文块回注，兼容 OpenAI / Anthropic / Gemini 的图片输入消息形态。
      if (m.id === lastVisualMsgId && m.results?.some((r) => r.kind === "image")) {
        ctx.push({
          role: "user",
          text: "【上一轮成图视觉上下文】这是你刚才交付的图片。后续若用户要求修改，请结合图片实际画面与文字要求决定新提示词，不要把这条说明当成用户的新需求。",
          images: m.results.filter((r) => r.kind === "image").slice(0, 2).map((r) => r.src),
        });
      }
    }
  }
  if (scratch.length) {
    ctx.push({
      role: "user",
      text: `【系统反馈】以下是你刚才调用工具的结果，请据此选择下一步动作（继续只输出一个 JSON 动作；任务完成就 reply）：\n\n${scratch.join("\n\n")}`,
    });
  }
  return ctx;
}

/** 从一段文本里识别画幅（"9:16" / "竖屏" / "横屏" / "方图" / "1920×1080" 像素写法） */
function sniffAspectFrom(text: string): string | undefined {
  // 像素写法优先（"1920×1080"）：折算成最接近的常用比例档
  const px = text.match(/(\d{3,4})\s*[x×*]\s*(\d{3,4})/);
  if (px) {
    const w = Number(px[1]);
    const h = Number(px[2]);
    if (w > 0 && h > 0) return nearestAspect(w / h);
  }
  const m = text.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  if (m) return `${m[1]}:${m[2]}`;
  if (/竖(屏|版|图|构图)|纵向|手机屏/.test(text)) return "9:16";
  if (/横(屏|版|图|构图)|宽屏/.test(text)) return "16:9";
  if (/方(图|形)|正方形/.test(text)) return "1:1";
  return undefined;
}

/** 从一段文本里识别清晰度档（1K/2K/4K，含 1080p / 像素尺寸写法） */
function sniffResolutionFrom(text: string): string | undefined {
  if (/4k|2160p|超清|超高清/i.test(text)) return "4K";
  if (/2k|1440p|1080p|高清|大图|印刷/i.test(text)) return "2K";
  if (/1k|720p|标清/i.test(text)) return "1K";
  // 只给了像素尺寸（"1920×1080"）：按长边定档
  const px = text.match(/(\d{3,4})\s*[x×*]\s*(\d{3,4})/);
  if (px) {
    const long = Math.max(Number(px[1]), Number(px[2]));
    return long >= 3000 ? "4K" : long >= 1400 ? "2K" : "1K";
  }
  return undefined;
}

/** 画幅字段归一化：模型可能填 "竖屏"、"1920×1080" 这类非标准值，一律折算成 "9:16" 式比例，认不出就丢弃走下一级兜底 */
function normAspect(a?: string): string | undefined {
  if (!a) return undefined;
  return parseRatio(a) ? a : sniffAspectFrom(a);
}

/** 清晰度字段归一化：只认 1K/2K/4K，其余（"高清" 等）折算，认不出丢弃 */
function normResolution(r?: string): string | undefined {
  if (!r) return undefined;
  const up = r.toUpperCase();
  return up === "1K" || up === "2K" || up === "4K" ? up : sniffResolutionFrom(r);
}

/** 生成确认闸的答案判定：点了「确认生成」或输入肯定语才算数，其余一律视为「再改改」 */
function isConfirmAnswer(a: string): boolean {
  return /确认|开始|生成|可以|好的?|行|嗯|来吧|yes|ok|go/i.test(a) && !/不|别|改|等|取消/.test(a);
}

/** 扫描整段对话里用户说过的画幅/清晰度（模型漏填 JSON 字段的兜底，用户的原话优先级最高） */
function sniffSpecFromChat(): { aspect?: string; resolution?: string } {
  const msgs = useAgent.getState().messages;
  let aspect: string | undefined;
  let resolution: string | undefined;
  for (const m of msgs) {
    // 用户消息 + 用户对抉择问题的回答都算数
    const texts = [m.role === "user" ? m.text : "", m.question?.answer ?? ""].filter(Boolean);
    for (const t of texts) {
      aspect = sniffAspectFrom(t) ?? aspect;
      resolution = sniffResolutionFrom(t) ?? resolution;
    }
  }
  return { aspect, resolution };
}

/** 从一段文本里识别要生成的张数（"3张" / "两张" / "多张" / "一组"） */
function sniffCountFrom(text: string): number | undefined {
  const m = text.match(/(\d)\s*[张幅个]/);
  if (m) return clamp(Number(m[1]), 1, 4);
  if (/两\s*[张幅]|2\s*[张幅]/.test(text)) return 2;
  if (/多张|几张|好几张|一组|一套|三个方案|多个方案/.test(text)) return 3;
  return undefined;
}

/** 扫描对话里用户最近一次说过的张数（模型不填 count 时的兜底） */
function sniffCountFromChat(): number | undefined {
  const msgs = useAgent.getState().messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const texts = [m.role === "user" ? m.text : "", m.question?.answer ?? ""].filter(Boolean);
    for (const t of texts) {
      const c = sniffCountFrom(t);
      if (c) return c;
    }
  }
  return undefined;
}

/** 用户最近一次附带的参考图 */
/** 收录成果：资产库 + 生成记录（与画布节点生成同等待遇） */
function collectResults(results: AgentResult[]) {
  const group = results.length > 1
    ? { groupId: `gen-${uid(12)}`, groupLabel: results[0]?.prompt || "Agent 批量生成", groupKind: "generation" as const }
    : undefined;
  for (const [index, r] of results.entries()) {
    if (r.kind === "image") useUi.getState().addGallery({ kind: "image", src: r.src, prompt: r.prompt });
    void useAssets.getState().collect({
      src: r.src,
      kind: r.kind,
      prompt: r.prompt,
      name: r.prompt,
      group: group ? { ...group, groupSlot: `result:${index}` } : undefined,
    });
  }
}

/** Agent 循环里，启用模型自带联网时追加到系统提示后的说明段 */
const NET_HINT = `\n\n【联网——已启用】本次请求已启用你自带的联网搜索能力（tools 已注入请求）。需要实时资料、潮流、事实核查时，直接自行联网检索，再基于结果输出下一个动作；**禁止输出 search 动作**——它专供没有内置联网时使用，在你联网开启期间会被程序直接拒绝执行。若你发现自己实际无法联网（检索不到结果），基于已有知识创作并在回复中说明。`;

/** 第二次创作的语义动作复核：由对话模型理解意图，程序不靠固定口令猜“是否生成”。 */
const ACTION_AUDIT_HINT = `\n\n【当前轮次：动作审计】你上一轮准备输出普通回复，但本会话此前已经交付过生成成果。请以用户最新自然语言、参考图片和完整上下文为准，重新判断用户此刻真正需要的是继续讨论/修改方案，还是实际制作新的图片或视频。若需要实际制作，必须输出 image/video 动作；reply 只能表达文字，绝不能承诺稍后、下一轮或自动生成。不要根据某个关键词机械判断，要理解整句话与上下文。`;

async function agentLoop(asstId: string, signal: AbortSignal) {
  const ask = (id: string, question: string, options: string[]) => waitAgentTurn(useAgent.getState().askQuestion(id, question, options), signal);
  const st = () => useAgent.getState();
  const scratch: string[] = [];
  /** 最近生成的图片（视频动作的首帧来源） */
  let lastGenImages: string[] = [];
  /** 本轮已确认的成图规格：确认一次后所有 image 动作复用，不再反复问 */
  const spec: { aspect?: string; resolution?: string } = {};
  /** 生成确认闸：已确认过的方案签名（prompt+画幅+张数）。生成扣费前必须先向用户确认一次 */
  let confirmedSig = "";
  /** 第二次创作起，普通回复先交给模型自己做一次语义动作审计，避免“口头说生成”却没输出动作 */
  const currentAt = st().messages.findIndex((m) => m.id === asstId);
  const hasEarlierGeneration = st().messages
    .slice(0, currentAt < 0 ? st().messages.length : currentAt)
    .some((m) => !!m.results?.length);
  let replyAudited = false;
  /** 本轮一旦见过 image/video 动作，后续 reply 就是工具后的正常收尾，不再审计，防重复生成 */
  let executableActionSeen = false;
  /** 外部搜索接口本会话已失败过（true 后不再执行 search 动作，防止模型反复重试空烧轮数） */
  let searchFailed = false;
  /** 联网 tools 被服务端拒绝过（端点不支持/中转站剥参数）：本轮任务内不再尝试注入，避免每轮都白失败一次 */
  let netBroken = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    checkAgentTurn(signal);
    const card = resolveModelCard("chat", st().modelId);
    const thinkSid = st().addStep(
      asstId,
      "think",
      `${replyAudited ? "复核意图并选择真实动作" : scratch.length ? "结合上下文完善提示词" : "理解需求并规划创作"}（${modelLabel(card)}）`,
    );
    // 联网开关开启且模型支持请求内服务端联网（GLM/混元等）→ 让模型自己查，比 search 动作少绕一圈。
    // 必须在系统提示里告知模型「已启用内置联网」，否则模型不知道自己带着 tools，
    // 仍会按协议输出 search 动作去走外部搜索接口（自带联网形同虚设）
    const useBuiltin = !netBroken && st().webSearch && chatCaps(card).builtinSearch;
    const system =
      AGENT_SYSTEM + agentToolHint() + (useBuiltin ? NET_HINT : "") + (replyAudited && !executableActionSeen ? ACTION_AUDIT_HINT : "");
    let raw: string;
    try {
      raw = (
        await chatStream(card, buildContext(scratch, chatCaps(card).vision), {
          signal,
          system,
          builtinSearch: useBuiltin,
          disableThinking: !st().thinkingOn, // 思考模式开关（仅创作助手生效）
        })
      ).text;
    } catch (e) {
      if (signal.aborted || isAbortError(e)) throw e;
      if (!useBuiltin) {
        st().setStep(asstId, thinkSid, { status: "error", text: `理解需求失败：${errMsg(e)}` });
        throw e;
      }
      // 端点不认联网 tools（剥参数/400，部分中转站如此）→ 去掉联网按普通请求重发一次，任务不中断；
      // 本轮任务内记住教训，后续轮次直接走无联网
      netBroken = true;
      scratch.push(
        `（系统提示）联网搜索工具被服务端拒绝（${errMsg(e).slice(0, 140)}），已切换为无联网模式。请基于已有知识继续创作，关键事实不确定时向用户说明信息可能不是最新。`,
      );
      try {
        raw = (
          await chatStream(card, buildContext(scratch, chatCaps(card).vision), {
            signal,
            system: AGENT_SYSTEM + agentToolHint() + (replyAudited && !executableActionSeen ? ACTION_AUDIT_HINT : ""),
            builtinSearch: false,
            disableThinking: !st().thinkingOn,
          })
        ).text;
      } catch (fallbackError) {
        st().setStep(asstId, thinkSid, { status: "error", text: `理解需求失败：${errMsg(fallbackError)}` });
        throw fallbackError;
      }
    }
    checkAgentTurn(signal);
    st().setStep(asstId, thinkSid, {
      status: "done",
      text: `${replyAudited ? "已复核意图与执行动作" : "已理解需求并完善方案"}（${modelLabel(card)}）`,
    });
    let act = parseAction(raw);
    if (!act) {
      // 宽容：部分模型按 function-calling 风格输出 {"name":"能力id","arguments":{…}}（没有 action 字段）。
      // name 能对上能力目录就按 tool 动作处理；对不上则按普通文本回复走下面的既有分支。
      const j = parseJsonLoose<Record<string, unknown>>(raw);
      const fnName = typeof j?.name === "string" ? j.name : "";
      if (fnName && getCapability(fnName)) {
        act = {
          action: "tool",
          tool: fnName,
          args: j?.arguments && typeof j.arguments === "object" ? (j.arguments as Record<string, unknown>) : {},
        };
      }
    }

    /* 第二轮修改后的关键兜底不猜用户用了什么“口令”：让对话模型根据完整上下文重新做语义路由。
       reply 可以用于讨论，但不能一边承诺生成一边不输出 image/video；审计只做一次，避免正常聊天循环。 */
    if (hasEarlierGeneration && !executableActionSeen && !replyAudited && (!act || act.action === "reply")) {
      replyAudited = true;
      const candidate = act?.action === "reply" ? act.text : raw;
      scratch.push(
        `（动作审计）当前对话已经交付过图片或视频。请重新理解用户最新消息与完整上下文，并检查你刚才准备给用户的回复：\n「${candidate.slice(0, 800)}」\n` +
          "如果用户只想讨论、询问或继续修改方案，可以继续输出 reply/ask；如果用户是在要求制作、按修改方案重新制作、继续生成或立即执行，就必须输出真正的 image/video 动作。不要用 reply 承诺稍后或下一轮生成，因为 reply 不会调用工具。仍然只输出一个 JSON 动作。",
      );
      continue;
    }

    // 普通的协议外文本照常展示；上面的待生成态已经保证不会在这里静默结束。
    if (!act) {
      st().updateMsg(asstId, { text: raw });
      return;
    }

    if (act.action === "reply") {
      st().updateMsg(asstId, { text: act.text });
      return;
    }

    if (act.action === "search") {
      if (!st().webSearch) {
        scratch.push("用户已关闭联网，本次搜索未执行。请直接回答或说明需要开启联网。");
        continue;
      }
      // 已启用模型自带联网：search 动作（外部搜索接口）没有意义，程序直接拒绝执行。
      // 提示词劝不住所有模型（输出协议里 search 排在最前，诱导太强），必须硬拦，
      // 否则会去调未配置的外部接口反复失败，任务卡死
      if (useBuiltin) {
        scratch.push(
          "（系统提示）本次请求已启用你的内置联网搜索，search 动作不会被执行。请直接基于你联网检索到的信息输出下一个动作；若你发现自己实际无法联网（检索不到结果），就基于已有知识创作，并在最终回复中向用户说明信息可能不是最新。",
        );
        continue;
      }
      // 外部搜索刚失败过就不再执行（接口未配置时模型会反复重试，白白烧轮数）
      if (searchFailed) {
        scratch.push(
          "（系统提示）内置搜索接口刚才已失败（可能未在设置中配置），不会再执行 search 动作。请基于已有知识继续创作，关键事实不确定时向用户说明。",
        );
        continue;
      }
      const sid = st().addStep(asstId, "search", `搜索：${act.query}`);
      try {
        const searched = await waitAgentTurn(webSearchForModel(card, useSettings.getState().settings.search, act.query), signal);
        const hits: SearchHit[] = searched.hits;
        st().setStep(asstId, sid, {
          status: "done",
          text: `${searched.source} 搜索：${act.query}（${hits.length} 条结果）`,
        });
        scratch.push(
          `搜索「${act.query}」的结果：\n` +
            (hits.length
              ? hits.map((h, i) => `${i + 1}. ${h.title} — ${h.snippet}`).join("\n")
              : "（没有搜到结果）"),
        );
      } catch (e) {
        checkAgentTurn(signal);
        searchFailed = true;
        st().setStep(asstId, sid, { status: "error", text: `搜索失败：${errMsg(e)}` });
        scratch.push(
          `搜索「${act.query}」失败：${errMsg(e)}。搜索接口当前不可用，不要再输出 search 动作。请基于已有知识继续创作（关键事实不确定时向用户说明），或直接告知用户。`,
        );
      }
      continue;
    }

    if (act.action === "ask") {
      const answer = await ask(asstId, act.question, act.options ?? []);
      scratch.push(`你向用户提问「${act.question}」，用户的回答是：${answer}`);
      continue;
    }

    if (act.action === "tool") {
      // 能力层（capability/）：统一信封——校验/确认策略/预算/幂等/完成验证都在 executeCapability 里过。
      // 只读直接出结果；提案送审核池等用户确认；扣费类（run_batch / comfy 模板）由信封先回 confirm
      // 计划，这里用助手自己的确认卡问用户，确认后带 confirmed 重进信封执行。
      const targetProjectId=useUi.getState().directorProjectId ?? undefined;
      const sid = st().addStep(asstId, "tool", `工作区能力：${act.tool}`);
      try {
        let res = await executeCapability(act.tool, act.args ?? {}, { channel: "assistant", signal, projectId: targetProjectId });
        if (res.kind === "confirm") {
          const answer = await ask(asstId, `${res.prompt}\n\n（确认后程序直接执行，结果下一轮告诉你）`, ["确认执行", "再想想"]);
          if (!isConfirmAnswer(answer)) {
            st().setStep(asstId, sid, { status: "error", text: "用户取消了本次执行" });
            scratch.push(`用户暂不执行 ${act.tool}：「${answer}」。请按用户意见调整方案或改为口头说明，未经确认不要重发。`);
            continue;
          }
          if((useUi.getState().directorProjectId ?? undefined)!==targetProjectId) throw new Error("确认期间切换了项目，请在目标项目重新发起任务");
          res = await executeCapability(act.tool, act.args ?? {}, { channel: "assistant", signal, projectId: targetProjectId }, { confirmed: true });
          if (res.kind === "confirm") {
            // 带了 confirmed 还要求确认 = 信封状态异常，不给模型留反复确认的循环口
            st().setStep(asstId, sid, { status: "error", text: "确认流程异常" });
            scratch.push(`【工具 ${act.tool} 确认后仍要求确认】这是程序异常，请直接告知用户。`);
            continue;
          }
        }
        if (res.kind === "done") {
          st().setStep(asstId, sid, { status: "done", text: `已完成：${act.tool}` });
          scratch.push(`【工具 ${act.tool} 结果】\n${res.text}`);
        } else if (res.kind === "blocked") {
          st().setStep(asstId, sid, { status: "error", text: res.reason });
          scratch.push(`【工具 ${act.tool} 被拦截】${res.reason}。请把原因告知用户，不要绕过闸门重试。`);
        } else {
          st().setStep(asstId, sid, { status: "error", text: res.error });
          scratch.push(
            `【工具 ${act.tool} 未执行】${res.error}。请换一种做法（修正参数或改用其他能力），不要原样重试；无法推进时直接告知用户。`,
          );
        }
      } catch (e) {
        st().setStep(asstId, sid, { status: "error", text: errMsg(e) });
        scratch.push(`【工具 ${act.tool} 执行异常】${errMsg(e)}。请换一种做法或直接告知用户，不要原样重试。`);
      }
      continue;
    }

    if (act.action === "image") {
      executableActionSeen = true;
      const imgCard = resolveModelCard("image", st().imageModelId);
      const actualImagePrompt=brandPrompt(useBoard.getState().activeId,act.prompt);
      const refs = act.useRefs ? generationRefs(st().messages, lastGenImages) : undefined;
      /* 画幅解析（模型经常漏填/乱填 JSON 字段，必须自己兜底，否则一律回落 1024x1024 出方图）：
         已确认的规格 > 动作里的字段 > 提示词里的措辞 > 用户在对话中说过的原话；每一级都先归一化（"竖屏"/"1920×1080" → "9:16"/"16:9"） */
      const fromChat = sniffSpecFromChat();
      const aspect = normAspect(spec.aspect) ?? normAspect(act.aspect) ?? sniffAspectFrom(act.prompt) ?? fromChat.aspect;
      const resolution = normResolution(spec.resolution) ?? normResolution(act.resolution) ?? fromChat.resolution;
      // 画幅完全没着落 → 强制问一轮再生成（用户明确要求过"要问分辨率"）
      if (!aspect || !resolution) {
        const answer = await ask(
          asstId,
          "先定一下成图的画幅和清晰度，再开始生成：",
          ["竖屏 9:16 · 标清", "横屏 16:9 · 标清", "方图 1:1 · 高清", "竖屏 9:16 · 高清"],
        );
        spec.aspect = sniffAspectFrom(answer) ?? aspect ?? "1:1";
        spec.resolution = sniffResolutionFrom(answer) ?? resolution ?? "1K";
        scratch.push(
          `用户已确认画幅：${spec.aspect}、清晰度：${spec.resolution}。请直接用这个规格执行 image 动作（不要再问）。`,
        );
        continue;
      }
      spec.aspect = aspect;
      spec.resolution = resolution;

      /* 生成前最终确认（防自动扣费）：规格齐了也不直接跑，先把完整方案给用户看，确认后才真正发起 */
      const n0 = clamp(Math.round(act.count ?? sniffCountFromChat() ?? 1), 1, 4);
      /* 统一预算闸（与画布 runner 同一道门）：单次上限/日预算直接阻断，超阈值的花费并入确认卡提示。
         此前助手生图不过预算、不记用量——同一笔花费从不同入口发起必须走同一道门。 */
      let estCost = 0;
      let costNote = "";
      try {
        estCost = estimateCost(imgCard.model, { images: n0 });
      } catch {
        /* 未配绘画模型时按 0 估，让后面 generateImage 的报错去提示 */
      }
      const gate1 = budgetGate(estCost, `生成 ${n0} 张图片`,{billing:imgCard.protocol==="codex"?"subscription":undefined});
      if (gate1.block) {
        scratch.push(`（预算闸）${gate1.block}。本次不执行 image 动作；请把原因告知用户，或按用户意见减少张数后再试。`);
        continue;
      }
      if (estCost > 0) costNote = `\n· 预估花费：¥${estCost.toFixed(2)}`;
      if (imgCard.protocol === "codex") costNote = "\n· 使用 Codex 共享会员额度，每次 1 张，不扣中转站费用";
      const sig = `img|${act.prompt}|${aspect}|${resolution}|${n0}`;
      if (confirmedSig !== sig) {
        let modelLab = "默认";
        try {
          modelLab = modelLabel(imgCard);
        } catch {
          /* 没配绘画模型时让后面 generateImage 的报错去提示 */
        }
        const brief0 = actualImagePrompt;
        const answer = await ask(
          asstId,
          `方案已就绪，确认后开始生成（会调用模型扣费）：\n· 提示词：${brief0}\n· 画幅：${aspect} · ${resolution} · ${n0} 张\n· 模型：${modelLab}${costNote}\n· 参考图：${refs?.length??0} 张（按对话中显示顺序）`,
          ["确认生成", "再想想"],
        );
        if (!isConfirmAnswer(answer)) {
          // 方案要改，旧规格不作数（改完会重新走规格确认 + 生成确认）
          spec.aspect = undefined;
          spec.resolution = undefined;
          scratch.push(
            `用户暂不生成，想继续调整方案：「${answer}」。请据此完善提示词或规格（reply 讨论 / ask 确认方向），在用户明确确认前不要再输出 image 动作。`,
          );
          continue;
        }
        // 确认通过：记录签名后**当场执行**这个动作（不再回炉让模型重发——
        // 模型复现 prompt 几乎必然有细微措辞差异，签名永远对不上会造成反复弹确认）
        confirmedSig = sig;
      }
      checkAgentTurn(signal);
      // 确认后二次过闸（等待用户作答期间日预算可能已被画布任务吃满）
      const gate2 = budgetGate(estCost, `生成 ${n0} 张图片`,{billing:imgCard.protocol==="codex"?"subscription":undefined});
      if (gate2.block) {
        scratch.push(`（预算闸）${gate2.block}。已取消本次生成，请把原因告知用户。`);
        continue;
      }

      const brief = act.prompt.length > 42 ? `${act.prompt.slice(0, 42)}…` : act.prompt;
      const sid = st().addStep(asstId, "image", `生成图片：${brief}`);
      // 点下生成的那一瞬间，画布上就先出一个「生成中」的节点（波光动效由 .mnode.running 提供），
      // 结果直接写回这个节点——创作助手出图与画布同步出内容
      const board = useBoard.getState();
      const sizingPre = (() => {
        try {
          return agentImageParams(imgCard, aspect, resolution);
        } catch {
          return {};
        }
      })();
      const nodeId = board.addNode("imageGen", canvasCenterPos(-165, -120), {
        prompt: act.prompt,
        status: "running",
        count: n0,
        modelId: `${imgCard.id}::${imgCard.model}`,
        ...sizingToNodeData(sizingPre, aspect),
      });
      // 注册停止通道：画布节点上的「停止」按钮对 Agent 出图同样有效
      const nodeSignal = beginTask(nodeId, "imageGen");
      const imageSignal = AbortSignal.any([signal, nodeSignal]);
      const t0 = Date.now();
      try {
        const n = n0;
        // 比例/清晰度 → 该模型家族的实际参数（用户指定的画幅必须生效，不再静默退回 1:1）
        const sizing = agentImageParams(imgCard, aspect, resolution);
        const sizeLab = sizing.aspect ? `${sizing.aspect}·${sizing.resolution ?? resolution}` : sizing.size ?? "默认";
        st().setStep(asstId, sid, { text: `生成图片：${brief}（${modelLabel(imgCard)} · ${sizeLab}）` });
        let results = await generateImage(imgCard, { prompt: actualImagePrompt, n, refImages: refs, signal: imageSignal, onProgress:stage=>{st().setStep(asstId,sid,{text:stage});useBoard.getState().updateData(nodeId,{progress:stage},{result:true});}, ...sizing });
        // 中转站普遍无视 n 参数只回 1 张：不够就并行补齐（用户要 3 张就必须给 3 张）
        if (results.length < n) {
          const extra = await Promise.allSettled(
            Array.from({ length: n - results.length }, () =>
              generateImage(imgCard, { prompt: actualImagePrompt, n: 1, refImages: refs, signal: imageSignal, ...sizing }),
            ),
          );
          for (const r of extra) if (r.status === "fulfilled") results = results.concat(r.value);
        }
        checkAgentTurn(imageSignal);
        results = results.slice(0, n);
        if (!results.length) throw new Error("绘画模型未返回图片，请重试或检查模型配置");
        lastGenImages = results;
        useBoard.getState().updateData(nodeId, { status: "done", results, picked: 0 });
        const items: AgentResult[] = results.map((src) => ({ kind: "image" as const, src, prompt: act.prompt }));
        st().appendResults(asstId, items);
        st().setStep(asstId, sid, {
          status: "done",
          text: `已生成 ${results.length} 张图片（${modelLabel(imgCard)} · ${sizeLab}）`,
        });
        collectResults(items);
        // 用量记账（与画布 runner 同一张账）：助手生成不再游离在用量看板之外
        useUsage.getState().record(imgCard, { ok: true, images: results.length, durMs: Date.now() - t0 });
        // 本次方案已交付：确认闸复位，用户之后的新需求要重新确认一轮（防再次自动扣费）
        confirmedSig = "";
        scratch.push(
          `本轮已成功生成 ${results.length} 张图片并展示给用户（提示词：${act.prompt}；画幅：${sizeLab}）。注意：这只算完成当前这次请求；用户之后再提生成/修改需求时，必须重新执行 image 动作。`,
        );
      } catch (e) {
        if (isAbortError(e)) {
          useBoard.getState().updateData(nodeId, { status: "idle", error: undefined });
          st().setStep(asstId, sid, { status: "error", text: "已停止生成" });
          st().updateMsg(asstId, { text: "已停止本次图片生成。你可以继续修改要求。" });
          return;
        } else {
          useBoard.getState().updateData(nodeId, { status: "error", error: errMsg(e) });
          st().setStep(asstId, sid, { status: "error", text: `生图失败：${errMsg(e)}` });
          pushError("Agent 生图", errMsg(e));
          // 失败也记账（与 runner 一致）；卡在 try 内解析不到时跳过
          try { useUsage.getState().record(imgCard, { ok: false, durMs: Date.now() - t0 }); } catch { /* 无卡不计 */ }
          scratch.push(`生成图片失败：${errMsg(e)}。请调整策略（改提示词/换方案）或直接告知用户。`);
        }
      } finally {
        endTask(nodeId);
      }
      continue;
    }

    if (act.action === "video") {
      executableActionSeen = true;
      const vidCard = resolveModelCard("video", st().videoModelId);
      const firstFrame = act.useRefs ? generationRefs(st().messages, lastGenImages)[0] : undefined;
      /* 视频更贵：与生图同款确认闸 + 统一预算闸（同一道门，单次上限/日预算直接阻断） */
      const durSec = Number(act.duration ?? 5) || 5;
      let vEstCost = 0;
      let vCostNote = "";
      try {
        vEstCost = estimateCost(vidCard.model, { videoSec: durSec });
      } catch {
        /* 未配视频模型时按 0 估，让后面 generateVideo 的报错去提示 */
      }
      const vGate1 = budgetGate(vEstCost, `生成 ${durSec} 秒视频`);
      if (vGate1.block) {
        scratch.push(`（预算闸）${vGate1.block}。本次不执行 video 动作；请把原因告知用户。`);
        continue;
      }
      if (vEstCost > 0) vCostNote = `\n· 预估花费：¥${vEstCost.toFixed(2)}`;
      const vSig = `vid|${act.prompt}|${act.duration ?? ""}`;
      if (confirmedSig !== vSig) {
        let modelLab = "默认";
        try {
          modelLab = modelLabel(vidCard);
        } catch {
          /* 没配视频模型时让后面 generateVideo 的报错去提示 */
        }
        const brief0 = act.prompt.length > 800 ? `${act.prompt.slice(0, 800)}…` : act.prompt;
        const answer = await ask(
          asstId,
          `视频方案已就绪，确认后开始生成（视频生成费用较高）：\n· 提示词：${brief0}\n· 时长：${act.duration ?? "默认"} 秒\n· 模型：${modelLab}${vCostNote}`,
          ["确认生成", "再想想"],
        );
        if (!isConfirmAnswer(answer)) {
          scratch.push(
            `用户暂不生成，想继续调整方案：「${answer}」。请据此完善提示词或规格（reply 讨论 / ask 确认方向），在用户明确确认前不要再输出 video 动作。`,
          );
          continue;
        }
        // 与生图同款：确认通过即当场执行，不回炉让模型重发（防复现偏差导致的反复确认）
        confirmedSig = vSig;
      }
      checkAgentTurn(signal);
      const vGate2 = budgetGate(vEstCost, `生成 ${durSec} 秒视频`);
      if (vGate2.block) {
        scratch.push(`（预算闸）${vGate2.block}。已取消本次生成，请把原因告知用户。`);
        continue;
      }
      const brief = act.prompt.length > 42 ? `${act.prompt.slice(0, 42)}…` : act.prompt;
      const sid = st().addStep(asstId, "video", `生成视频：${brief}`);
      // 与生图同款：先在画布落一个「生成中」的视频节点，进度与结果都写回它
      const nodeId = useBoard.getState().addNode("videoGen", canvasCenterPos(-165, -120), {
        prompt: act.prompt,
        status: "running",
        modelId: `${vidCard.id}::${vidCard.model}`,
        ...(act.duration ? { duration: act.duration } : {}),
      });
      const vSignal = AbortSignal.any([signal, beginTask(nodeId, "videoGen")]);
      const vt0 = Date.now();
      try {
        const url = await generateVideo(vidCard, {
          prompt: act.prompt,
          image: firstFrame,
          duration: act.duration,
          signal: vSignal,
          onProgress: (msg) => {
            st().setStep(asstId, sid, { text: `生成视频：${msg}` });
            useBoard.getState().updateData(nodeId, { progress: msg });
          },
        });
        checkAgentTurn(vSignal);
        // 视频体积大且 http 地址可能过期：先落资产库，用持久地址展示
        // Tauri 下资产是 AppData 绝对路径，必须经 assetUrl 转 asset: 协议，否则 webview 播不了
        const item = await useAssets.getState().collect({ src: url, kind: "video", prompt: act.prompt, name: act.prompt });
        const src = item ? (isTauri ? assetUrl(item.path) : item.path) : url;
        useBoard.getState().updateData(nodeId, { status: "done", resultUrl: src, resultUrls: [src], picked: 0, progress: "" });
        st().appendResults(asstId, [{ kind: "video", src, prompt: act.prompt }]);
        st().setStep(asstId, sid, { status: "done", text: `已生成视频（${modelLabel(vidCard)}）` });
        // 用量记账（与画布 runner 同一张账）
        useUsage.getState().record(vidCard, { ok: true, videoSec: durSec, durMs: Date.now() - vt0 });
        // 与生图同款：交付后确认闸复位，下一个新需求重新确认
        confirmedSig = "";
        scratch.push("本轮已成功生成视频并展示给用户。用户之后再提生成需求时，必须重新执行动作。");
      } catch (e) {
        if (isAbortError(e)) {
          useBoard.getState().updateData(nodeId, { status: "idle", error: undefined, progress: "" });
          st().setStep(asstId, sid, { status: "error", text: "已停止生成" });
          st().updateMsg(asstId, { text: "已停止本次视频生成。你可以继续修改要求。" });
          return;
        } else {
          useBoard.getState().updateData(nodeId, { status: "error", error: errMsg(e) });
          st().setStep(asstId, sid, { status: "error", text: `生成视频失败：${errMsg(e)}` });
          pushError("Agent 生视频", errMsg(e));
          try { useUsage.getState().record(vidCard, { ok: false, durMs: Date.now() - vt0 }); } catch { /* 无卡不计 */ }
          scratch.push(`生成视频失败：${errMsg(e)}。请调整策略或直接告知用户。`);
        }
      } finally {
        endTask(nodeId);
      }
      continue;
    }
  }
  st().updateMsg(asstId, {
    text: "（处理轮数较多，我先停在这里——以上是目前的进展，你可以继续补充要求，我接着做。）",
  });
}

/** 发送一条用户消息并驱动 Agent 循环 */
export async function sendAgentMessage() {
  const st = useAgent.getState();
  // 有挂起的问题时，输入框内容视为对问题的自由回答
  // （必须先于 running 守卫判断：挂起等待期间 running 恒为 true，否则这条路径永远走不到）
  if (st.resolver) {
    const pending = st.messages.find((m) => m.question && !m.question.answer);
    const text = st.draft.trim();
    if (pending && text) {
      st.setDraft("");
      st.answer(pending.id, text);
    }
    return;
  }
  if (st.running) return;
  const text = st.draft.trim();
  const images = st.attachments;
  if (!text && !images.length) return;
  const turn = new AbortController();
  activeTurn = turn;
  useAgent.setState({ running: true, draft: "", attachments: [] });
  st.pushUser(text, images);
  const asstId = useAgent.getState().beginAssistant();
  try {
    await agentLoop(asstId, turn.signal);
  } catch (e) {
    useAgent.getState().updateMsg(asstId, { text: isAbortError(e) ? "已停止。可以继续输入新的要求。" : `出错了：${errMsg(e)}` });
    if (!isAbortError(e)) pushError("Agent", errMsg(e));
  } finally {
    if (activeTurn === turn) activeTurn = null;
    const state = useAgent.getState();
    const pendingQuestion = state.messages.find(m => m.id === asstId)?.question;
    if (pendingQuestion && pendingQuestion.answer === undefined) state.updateMsg(asstId, { question: { ...pendingQuestion, answer: "已停止" } });
    const message = state.messages.find(m => m.id === asstId);
    for (const step of message?.steps ?? []) if (step.status === "running") state.setStep(asstId, step.id, { status: "error", text: "已停止" });
    useAgent.setState({ running: false, resolver: null });
    // Agent 的多轮任务同样推进前情摘要（与聊天模式共用；失败静默，结果留给下一轮）
    try {
      void maybeCompressHistory(resolveModelCard("chat", useAgent.getState().modelId)).catch(() => {});
    } catch {
      /* 对话模型缺失/未配置时跳过 */
    }
  }
}

/** 用户作答 Agent 的提问（点选项或自由输入） */
export function answerAgentQuestion(msgId: string, answer: string) {
  useAgent.getState().answer(msgId, answer);
}

/* ================= 聊天模式（多模态对话：完善想法/提示词，随时一键在画布生图） ================= */

/** 聊天助手人设：多轮讨论按上下文锁定（风格/主体/色调等决定全程延续，除非用户明确改变） */
const CHAT_SYSTEM = `你是 MOMO 智能画布右侧的「创作助手」，一位懂绘画/摄影/视频创作的聊天搭子。
围绕用户的创作目标进行多轮讨论：记住并延续前文中已经确定的设定与决定（主题、风格、色调、构图等上下文全程锁定，除非用户明确要改变），帮用户把想法逐步打磨成可以直接出图的提示词。
全程使用中文，回复简洁有料；给出提示词时写完整、成品级的画面描述。用户随时可以拿你的回复一键在画布生成图片。`;

/** 上下文窗口：最近原样保留的条数 / 每积满多少条新消息压缩一次较早部分 */
const KEEP_RECENT = 10;
const COMPRESS_STRIDE = 8;

/** 写进 reasoning 的进度占位语：流式结束后要清掉，别留成假的「思考过程」 */
const REASONING_PLACEHOLDERS = ["正在使用", "正在联网搜索"];

/** 超出上下文窗口的较早对话自动压缩成前情摘要（模型自行压缩；失败不阻塞聊天，下次再试） */
async function maybeCompressHistory(card: ReturnType<typeof resolveModelCard>) {
  const st = useAgent.getState();
  const { messages, summary, summaryUpto, epoch } = st;
  const upto = messages.length - KEEP_RECENT;
  if (upto <= 0 || upto - summaryUpto < COMPRESS_STRIDE) return;
  const seg = messages
    .slice(summaryUpto, upto)
    .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.text || (m.images?.length ? "（发了参考图）" : "…")}`)
    .join("\n");
  const { text } = await chatStream(card, [
    {
      role: "user",
      text: `${summary ? `已有的前情摘要：\n${summary}\n\n` : ""}以下是后续的一段对话记录，请把它${summary ? "与已有摘要合并" : "压缩"}成一段简洁的前情摘要（200 字以内，保留用户的创作目标、已确定的风格/主体/色调等关键决定、已产出/交付的内容）：\n\n${seg}`,
    },
  ]);
  // 压缩期间用户点了「清空对话」→ 代次已变，这份摘要连同它的下标都已失效，直接丢弃
  if (useAgent.getState().epoch !== epoch || useAgent.getState().summaryUpto > upto) return;
  useAgent.getState().setSummary(text.trim(), upto);
}

/** 聊天模式发送：历史 + 附件（视觉输入）直发对话模型，流式写回；联网优先用模型自带搜索（不支持则内置搜索兜底） */
export async function sendSideChat() {
  const st = useAgent.getState();
  if (st.running) return;
  const text = st.draft.trim();
  const images = st.attachments;
  if (!text && !images.length) return;
  const turn = new AbortController();
  activeTurn = turn;
  useAgent.setState({ running: true, draft: "", attachments: [] });
  st.pushUser(text, images);
  const asstId = useAgent.getState().beginAssistant();
  try {
    const card = resolveModelCard("chat", useAgent.getState().modelId);
    const caps = chatCaps(card);
    // 带了参考图但模型可能没有视觉：提前提醒（不拦截，部分中转会静默忽略图片）
    if (images.length && !caps.vision) {
      toast(`当前模型「${modelLabel(card)}」可能不支持视觉输入，图片可能被忽略——可在面板上方换成多模态模型`, "err");
    }
    const parts: string[] = [CHAT_SYSTEM];
    let builtin = false;
    if (useAgent.getState().webSearch) {
      if (caps.builtinSearch) {
        builtin = true;
        useAgent.getState().updateMsg(asstId, { reasoning: `正在使用「${card.name}」自带的联网搜索…` });
      } else {
        useAgent.getState().updateMsg(asstId, { reasoning: "正在联网搜索…" });
        try {
          const searched = await webSearchForModel(card, useSettings.getState().settings.search, text);
          useAgent.getState().updateMsg(asstId, { reasoning: `正在使用「${searched.source}」联网搜索…` });
          const ctx = searchContext(searched.hits ?? []);
          if (ctx) parts.push(ctx);
        } catch (e) {
          toast(`联网搜索失败，将直接回答：${errMsg(e)}`, "info");
        }
        useAgent.getState().updateMsg(asstId, { reasoning: "" });
      }
    }
    const { summary, summaryUpto, messages: allMsgs } = useAgent.getState();
    if (summary) parts.push(`【前情摘要】以下是更早对话的要点（供你延续上下文，不必向用户复述）：\n${summary}`);
    // 面板消息 → LLM 上下文（摘要之后的近期消息原样带上；助手只带文本，用户消息带图）
    // 下标兜底：摘要下标万一超出当前消息数（清空/删改后），退回最近 14 条，绝不切成空数组
    const useSum = summary && summaryUpto < allMsgs.length;
    const history: ChatMsg[] = useAgent
      .getState()
      .messages.slice(useSum ? summaryUpto : -14)
      .filter((m) => m.id !== asstId)
      .map((m) => ({
        role: m.role,
        text: m.text || (m.images?.length ? "（参考图）" : "…"),
        images: m.role === "user" ? m.images : undefined,
      }));
    // 压缩在后台进行：本轮用旧摘要/近期消息已足够，结果留给下一轮
    void maybeCompressHistory(card).catch(() => {});
    const stream = (useBuiltin: boolean) =>
      chatStream(card, history, {
        signal: turn.signal,
        system: parts.join("\n\n"),
        builtinSearch: useBuiltin,
        disableThinking: !useAgent.getState().thinkingOn, // 思考模式开关（仅创作助手生效）
        onText: (full) => useAgent.getState().updateMsg(asstId, { text: full }),
        onReasoning: (full) => useAgent.getState().updateMsg(asstId, { reasoning: full }),
      });
    try {
      await stream(builtin);
    } catch (e) {
      if (turn.signal.aborted || !builtin) throw e;
      // 中转站不认自带联网的 tools 参数 → 降级为内置搜索重试一次
      toast(`「${card.name}」自带联网调用失败，改用内置搜索重试`, "info");
      useAgent.getState().updateMsg(asstId, { text: "", reasoning: "正在联网搜索…" });
      try {
        const searched = await webSearchForModel(card, useSettings.getState().settings.search, text);
        const ctx = searchContext(searched.hits ?? []);
        if (ctx) parts.push(ctx);
      } catch {
        /* 搜索也失败就直接回答 */
      }
      await stream(false);
    }
    // 「正在联网搜索…」这类只是占位提示，流式结束一律清掉（模型真有思考内容时早已被覆盖）
    const fin = useAgent.getState().messages.find((m) => m.id === asstId);
    if (fin?.reasoning && REASONING_PLACEHOLDERS.some((p) => fin.reasoning!.startsWith(p))) {
      useAgent.getState().updateMsg(asstId, { reasoning: "" });
    }
  } catch (e) {
    useAgent.getState().updateMsg(asstId, { text: `出错了：${errMsg(e)}` });
    if (isAbortError(e)) useAgent.getState().updateMsg(asstId, { text: "已停止。可以继续输入新的要求。", reasoning: "" });
    else pushError("聊天", errMsg(e));
  } finally {
    if (activeTurn === turn) activeTurn = null;
    const state = useAgent.getState();
    const pendingQuestion = state.messages.find(m => m.id === asstId)?.question;
    if (pendingQuestion && pendingQuestion.answer === undefined) state.updateMsg(asstId, { question: { ...pendingQuestion, answer: "已停止" } });
    const message = state.messages.find(m => m.id === asstId);
    for (const step of message?.steps ?? []) if (step.status === "running") state.setStep(asstId, step.id, { status: "error", text: "已停止" });
    useAgent.setState({ running: false, resolver: null });
  }
}

/** 画布可视区中心（新节点落点）：扣掉标题栏与右侧助手面板，避免节点落在面板底下看不见 */
export function canvasCenterPos(offsetX = 0, offsetY = 0) {
  const b = useBoard.getState();
  const vp = b.boards[b.activeId]?.meta.viewport ?? { x: 0, y: 0, zoom: 1 };
  const tbH = 46; // 标题栏高度（theme.css 的 --tb-h）
  const panelW = useUi.getState().agentOpen ? Math.min(400, window.innerWidth * 0.92) : 0;
  const cx = (window.innerWidth - panelW) / 2;
  const cy = tbH + (window.innerHeight - tbH) / 2;
  return {
    x: (cx - vp.x) / vp.zoom + offsetX + Math.random() * 60,
    y: (cy - vp.y) / vp.zoom + offsetY + Math.random() * 60,
  };
}

/** 从聊天文本里识别用户点名的画幅（"9:16" / "竖屏" / "1920×1080"），用于一键生图时对齐比例 */
function sniffAspect(text: string): string | undefined {
  return sniffAspectFrom(text);
}

/** 聊天消息一键在画布生图：以该文本为提示词创建生成图像节点并立即运行
 *  （沿用面板选好的绘画模型；文本里点名的画幅自动带上，避免"说了 9:16 却出 1:1"） */
export function genImageOnCanvas(prompt: string) {
  const p = prompt.trim();
  if (!p) return;
  const b = useBoard.getState();
  const imageModelId = useAgent.getState().imageModelId;
  let sizing: Record<string, unknown> = {};
  const aspect = sniffAspect(p);
  const resolution = sniffResolutionFrom(p);
  if (aspect) {
    try {
      const card = resolveModelCard("image", imageModelId);
      // 生成节点的字段：banana 用 aspect/resolution，其余家族用 width/height
      sizing = sizingToNodeData(agentImageParams(card, aspect, resolution), aspect);
    } catch {
      /* 没配置绘画模型时按默认走，runner 会给出中文报错 */
    }
  }
  const id = b.addNode("imageGen", canvasCenterPos(-165, -120), {
    prompt: p,
    ...(imageModelId ? { modelId: imageModelId } : {}),
    ...sizing,
  });
  // 生成完面板会跟着新节点选中弹出，符合「直接去画布看结果」的动线
  void runFlow(id);
  toast(aspect ? `已在画布创建生成图像节点（${aspect}），开始生成` : "已在画布创建生成图像节点，开始生成", "ok");
}

/** 把生成结果发到画布（图片/视频源节点） */
export function sendResultToCanvas(r: AgentResult) {
  const b = useBoard.getState();
  b.addNode(r.kind === "video" ? "video" : "image", canvasCenterPos(-160, -120), {
    status: "done",
    src: r.src,
    name: r.prompt ? `Agent：${r.prompt.slice(0, 20)}` : "Agent 生成",
  });
  toast("已发送到画布", "ok");
}
