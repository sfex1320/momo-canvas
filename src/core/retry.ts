/**
 * 重试与备用模型 — 两层兜底，让中转站 429/5xx/网络抖动不再让整条工作流白跑：
 *
 * ① http 传输层（xfetchRetry）：只对幂等请求自动重试（轮询 GET / 模型列表 / 搜索 / 图片下载）。
 *    生成类 POST 不在这里自动重试（重复扣费风险），交给下面的生成层显式控制。
 * ② 生成层（runGenWithFallback）：主模型瞬时错误按 settings.retry.submitMax 重试；
 *    耗尽换备用模型 card 再试一次，成功则标注 usedFallback。
 *
 * 主动停止（isAbortError）在两层都短路，绝不重试。
 * 退避：Retry-After 头优先，否则指数退避 + ±20% 抖动。
 */
import { xfetch } from "./services/http";
import { isAbortError } from "./runControl";
import { isRetryableStatus, isTransientError } from "./errorHelp";
import { resolveModelCard, useSettings } from "./stores/settingsStore";
import { errMsg } from "./utils";
import type { ModelCard } from "./types";

/** 退避时长（带 ±20% 抖动，避免多个客户端同步重试压垮服务商） */
export function backoffMs(attempt: number, base: number, cap: number): number {
  const raw = Math.min(cap, base * 2 ** attempt);
  return Math.round(raw * (0.8 + Math.random() * 0.4));
}

/** 解析 Retry-After 头（秒数或 HTTP 日期） */
export function parseRetryAfter(h: string | null): number | null {
  if (!h) return null;
  const sec = Number(h);
  if (Number.isFinite(sec) && sec >= 0) return Math.min(sec * 1000, 60_000);
  const d = Date.parse(h);
  return Number.isNaN(d) ? null : Math.max(0, d - Date.now());
}

const sleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        rej(new Error("已取消"));
      },
      { once: true },
    );
  });

/**
 * 幂等请求自动重试：429/5xx/网络抖动按指数退避重发。
 * 生成类 POST 不要用这个（会用下面的 runGenWithFallback）。
 */
export async function xfetchRetry(
  input: string | URL,
  init: RequestInit | undefined,
  opts: { max?: number; baseMs?: number; capMs?: number } = {},
): Promise<Response> {
  const { retry } = useSettings.getState().settings;
  const max = opts.max ?? retry.idempotentMax;
  const base = opts.baseMs ?? retry.backoffBaseMs;
  const cap = opts.capMs ?? retry.backoffMaxMs;
  for (let i = 0; i <= max; i++) {
    if (init?.signal?.aborted) throw new Error("已取消");
    try {
      const resp = await xfetch(input, init);
      if (resp.ok || !isRetryableStatus(resp.status) || i >= max) return resp;
      const wait = parseRetryAfter(resp.headers.get("retry-after")) ?? backoffMs(i, base, cap);
      await sleep(wait, init?.signal);
    } catch (e) {
      if (isAbortError(e)) throw e; // 主动停止：绝不重试
      if (i >= max || !isTransientError(errMsg(e))) throw e;
      await sleep(backoffMs(i, base, cap), init?.signal);
    }
  }
  // 理论上到不了（循环内必 return/throw），兜底
  return xfetch(input, init);
}

/** 幂等 GET 便捷封装（带设置里的默认重试次数） */
export const xfetchIdempotent = (input: string | URL, init?: RequestInit) =>
  xfetchRetry(input, init, { max: useSettings.getState().settings.retry.idempotentMax });

/**
 * 生成类（生图/生视频/生音频）重试 + 备用模型兜底。
 * 主模型瞬时错误按 submitMax 重试 → 耗尽换备用 card 再试 1 次 → 成功标注 usedFallback。
 * run 回调吃「当前 card」，必须用它重算家族相关字段（备用模型可能不同家族）。
 */
export async function runGenWithFallback<T>(
  role: "image" | "video" | "audio",
  primary: ModelCard,
  signal: AbortSignal | undefined,
  run: (card: ModelCard) => Promise<T>,
): Promise<{ result: T; card: ModelCard; usedFallback: boolean }> {
  // 会员任务不能因网络错误悄悄重复扣额度，更不能改走用户的付费 API。
  if (primary.protocol === "codex") {
    signal?.throwIfAborted();
    return {result:await run(primary),card:primary,usedFallback:false};
  }
  const { retry } = useSettings.getState().settings;
  const fbKey = role === "image" ? retry.fallbackImage : role === "video" ? retry.fallbackVideo : retry.fallbackAudio;

  const tryCard = async (card: ModelCard, attempts: number): Promise<T> => {
    for (let i = 0; i <= attempts; i++) {
      if (signal?.aborted) throw new Error("已取消");
      try {
        return await run(card);
      } catch (e) {
        if (isAbortError(e)) throw e; // 主动停止：绝不重试
        // 非瞬时错误（401/404/欠费/非 JSON）直接抛——重试无益，换备用才有意义
        if (i >= attempts || !isTransientError(errMsg(e))) throw e;
        await sleep(backoffMs(i, retry.backoffBaseMs, retry.backoffMaxMs), signal);
      }
    }
    throw new Error("重试耗尽"); // 不可达
  };

  try {
    return { result: await tryCard(primary, retry.submitMax), card: primary, usedFallback: false };
  } catch (primaryErr) {
    if (isAbortError(primaryErr) || !fbKey) throw primaryErr;
    let fallback: ModelCard;
    try {
      fallback = resolveModelCard(role, fbKey);
    } catch {
      throw primaryErr; // 备用槽被删/没配该角色 → 用原错误
    }
    // 备用 === 主模型没意义；非瞬时错误也不换（换了同样会失败）
    if (fallback.id === primary.id && fallback.model === primary.model) throw primaryErr;
    return { result: await tryCard(fallback, 0), card: fallback, usedFallback: true }; // 备用只试 1 次
  }
}
