/**
 * H3 双语提示词（3.5 P3 · 方案 §4）—— 六段式的确定性解析、双稿配对、锁规则。
 *
 * 英文执行稿是模型请求真相；中文审阅稿仅供人读，绝不发给视频模型。
 * 纯解析/配对/校验在 h3BilingualCore（零依赖，node 直跑快测）；本文件承载需要 store/chat 的流程
 * （中文审阅稿生成：模型对齐 → 对白逐字校验 → 通过才 synced，不一致存草稿标 conflict）。
 */
import { chatOnce } from "../services/llm";
import { resolveModelCard } from "../stores/settingsStore";
import { useDirector } from "../stores/directorStore";
import { parseH3PromptBody, extractDialogue, extractContinuityMode, pairBilingualDocs, h3PatchForSegment, validateZhAgainstEn } from "./h3BilingualCore";
export { parseH3PromptBody, extractDialogue, extractContinuityMode, pairBilingualDocs, h3PatchForSegment, validateZhAgainstEn };
export type { BilingualPair } from "./h3BilingualCore";
import type { H3BilingualPrompt, H3PromptLanguageData } from "../types";

/* ---------------- 中文审阅稿生成（§5.3 路径 3） ---------------- */

export type ZhReviewResult = {
  /** 模型返回的中文稿全文 */
  zhBody: string;
  /** 校验是否通过（通过才写 h3Prompt.zh 并标 synced） */
  ok: boolean;
  /** 未通过时的具体差异（UI 展示给用户） */
  problems: string[];
};

/**
 * 用 chat 模型把英文执行稿对齐为中文审阅稿（结构化标签保留、对白原文逐字不动）；英文绝不修改。
 * 3.5 P1 修复：生成后重新提取中英对白逐字比对——不一致时不覆盖已有中文稿，
 * 保存为 zhDraft 待确认草稿、syncStatus 标 conflict，并向调用方返回差异清单。
 */
export async function generateZhReview(projectId: string, segmentId: string): Promise<ZhReviewResult> {
  const proj = useDirector.getState().getById(projectId);
  const seg = proj?.scenes.flatMap((sc) => sc.segments).find((x) => x.id === segmentId);
  const h3 = seg?.h3Prompt;
  const enBody = seg?.promptOverride ?? h3?.en.promptBody;
  if (!seg || !h3 || !enBody) throw new Error("该片段还没有英文执行稿——先精炼或导入执行稿");
  let card;
  try {
    card = resolveModelCard("chat");
  } catch {
    throw new Error("未配置对话模型（chat 角色）——请在 设置 → 模型配置 添加");
  }
  const zhBody = await chatOnce(
    card,
    "你是双语影视提示词审阅员。把用户给的英文 H3 视频执行稿对齐为中文审阅稿：subject_definitions/summary/detailed_description 等小节结构保持、<Subject N> 与 <Picture N> 等编号原样保留、<d>[语言]…</d> 对白原文逐字不动（不翻译）、时长与衔接模式等元数据保留。只输出中文审阅稿全文，不要任何解释。",
    enBody,
  );
  if (!zhBody || zhBody.length < 20) throw new Error("模型没有返回有效的中文审阅稿");

  // 生成后强制校验（3.5 P1）：对白逐字 + 结构小节 + 时长——模型改了对白就不能标 synced
  const problems = validateZhAgainstEn(zhBody, enBody, seg.durationSec, parseSegmentDuration(zhBody));
  const zh = parseH3PromptBody(zhBody, h3.en.title);
  const cur = useDirector.getState().getById(projectId)!;
  if (problems.length) {
    // 不覆盖已有中文稿：生成稿进 zhDraft 待确认，syncStatus 标 conflict（或已有 zh 时 en-newer 不动）
    const next: H3BilingualPrompt = {
      ...h3,
      zhDraft: zh,
      syncStatus: "conflict",
      generatedAt: Date.now(),
    };
    useDirector.getState().updateProject(projectId, {
      scenes: cur.scenes.map((sc) => ({
        ...sc,
        segments: sc.segments.map((x) => (x.id === segmentId ? { ...x, h3Prompt: next } : x)),
      })),
    });
    return { zhBody, ok: false, problems };
  }
  const next: H3BilingualPrompt = { ...h3, zh, zhDraft: undefined, source: h3.source === "legacy" ? "manual" : h3.source, syncStatus: "synced", generatedAt: Date.now() };
  useDirector.getState().updateProject(projectId, {
    scenes: cur.scenes.map((sc) => ({
      ...sc,
      segments: sc.segments.map((x) => (x.id === segmentId ? { ...x, h3Prompt: next } : x)),
    })),
  });
  return { zhBody, ok: true, problems: [] };
}

/** 从中文稿正文提取时长声明（时长一致性校验用；无声明返回 undefined） */
function parseSegmentDuration(body: string): number | undefined {
  const m = body.match(/(\d{1,3}(?:\.\d+)?)\s*(?:秒|s\b)/i) ?? body.match(/(?:时长|duration)[:：]?\s*(\d{1,3}(?:\.\d+)?)/i);
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) && v >= 2 && v <= 60 ? v : undefined;
}

/** zhDraft 草稿升级为正式中文稿（用户核对后手动确认；H3 检查器调用） */
export function promoteZhDraft(projectId: string, segmentId: string): void {
  const cur = useDirector.getState().getById(projectId);
  const seg = cur?.scenes.flatMap((sc) => sc.segments).find((x) => x.id === segmentId);
  if (!cur || !seg?.h3Prompt?.zhDraft) return;
  const h3 = seg.h3Prompt;
  const next: H3BilingualPrompt = { ...h3, zh: h3.zhDraft as H3PromptLanguageData, zhDraft: undefined, syncStatus: "synced", generatedAt: Date.now() };
  useDirector.getState().updateProject(projectId, {
    scenes: cur.scenes.map((sc) => ({
      ...sc,
      segments: sc.segments.map((x) => (x.id === segmentId ? { ...x, h3Prompt: next } : x)),
    })),
  });
}

/** 丢弃 zhDraft 草稿（用户核对后拒绝；syncStatus 回到 en-newer） */
export function discardZhDraft(projectId: string, segmentId: string): void {
  const cur = useDirector.getState().getById(projectId);
  const seg = cur?.scenes.flatMap((sc) => sc.segments).find((x) => x.id === segmentId);
  if (!cur || !seg?.h3Prompt?.zhDraft) return;
  const h3 = seg.h3Prompt;
  const next: H3BilingualPrompt = { ...h3, zhDraft: undefined, syncStatus: h3.zh ? "en-newer" : "en-newer", generatedAt: Date.now() };
  useDirector.getState().updateProject(projectId, {
    scenes: cur.scenes.map((sc) => ({
      ...sc,
      segments: sc.segments.map((x) => (x.id === segmentId ? { ...x, h3Prompt: next } : x)),
    })),
  });
}
