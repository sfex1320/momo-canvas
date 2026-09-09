/**
 * 官方视频协议适配器（导演台 3.3 · 方案 §8）
 *
 * 三个正式 Provider 适配器，替代「OpenAI 兼容 + 多塞几个字段」的通用壳：
 *  - genArkSeedance：火山方舟 Ark v3 contents/generations（Seedance 2.0，content[] 多模态、
 *    整数 4–15s、return_last_frame、camera_fixed、可信素材 asset:// 错误友好提示）；
 *  - genDashscopeWan：阿里云 DashScope 异步任务（Wan 2.7，first/last frame、first_clip 延展、
 *    driving_audio、prompt_extend、水印与种子）；
 *  - genGoogleVideo：Google Gemini API predictLongRunning（Omni / Veo 3.1，operations 轮询、
 *    instances[].image、aspectRatio/resolution、generateContent 式宽容解析）。
 *
 * 状态说明：请求/轮询/取消结构按各家公开文档实现；**未经真实 API Key 联调前，
 * 3.5 统一视频规格：req.fps 仅 Seedance 类 body 逐字段构造——三家协议均无 FPS 直出参数，
 * 适配器按「不支持则忽略」处理（body 从不透传未知字段，协议零破坏）；预检会报告
 * 「模型未直接采用 FPS，交付阶段可补帧/转帧率」。
 * 能力档案仍标 adapterReady（适配器已实现·待联调）**——不冒充「已贯通」（方案 §1）。
 * 联调反馈后只改各家的字段映射，不动导演项目结构（§12.2）。
 */
import { trimBase } from "./http.ts";
import type { VideoGenReq, AdapterSpecReport } from "./videoGen";
import type { ModelCard } from "../types";
import { xfetch } from "./http.ts";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      rej(new Error("已取消"));
    }, { once: true });
  });

/** dataURL → 纯 base64（Google 需要 bytesBase64Encoded） */
function b64Of(dataUrl: string): string {
  return dataUrl.replace(/^data:[^;]+;base64,/, "");
}

/* ---------------- 请求体构造（纯函数，测试直测；适配器只做发送与轮询） ---------------- */

/** 火山方舟 Seedance 提交体：整数 4–15s 钳制、resolution 直出、无 FPS 参数 */
export function buildArkSeedanceBody(card: ModelCard, req: VideoGenReq): { body: Record<string, unknown>; report: AdapterSpecReport } {
  // content[] 多模态：文本角色 + 参考图角色（首帧/尾帧/参考按序占 image_url 位）
  const content: Array<Record<string, unknown>> = [{ type: "text", text: req.prompt }];
  const pics = [req.image, ...(req.refImages ?? [])].filter(Boolean) as string[];
  for (const p of pics) content.push({ type: "image_url", image_url: { url: p } });
  if (req.lastFrame) content.push({ type: "image_url", image_url: { url: req.lastFrame, role: "last_frame" } });
  if (req.video) content.push({ type: "video_url", video_url: { url: req.video } });

  const asked = Number(req.duration) || 5;
  const dur = Math.max(4, Math.min(15, Math.round(asked)));
  const body: Record<string, unknown> = {
    model: card.model,
    content,
    duration: dur, // 官方 API 整数 4–15 秒（能力档案 §4.3）
    watermark: false,
  };
  if (req.resolution) body.resolution = req.resolution; // 720p / 1080p
  if (req.aspect) body.ratio = req.aspect;
  if (req.seed !== undefined) body.seed = req.seed;
  if (req.audio !== undefined && req.audio) body.audio = true; // Seedance 原生同步音频
  const unapplied: AdapterSpecReport["unapplied"] = [{ field: "fps", reason: "火山方舟协议没有帧率直出参数——未发送 fps" }];
  if (dur !== asked) unapplied.push({ field: "durationSec", reason: `官方 API 整数 4–15 秒——${asked}s 已取整为 ${dur}s` });
  return {
    body,
    report: {
      durationSec: dur,
      ...(req.resolution ? { resolution: req.resolution } : {}),
      unapplied,
    },
  };
}

/** DashScope Wan 提交体：2–15s 钳制、size 由分辨率/画幅折算、无 FPS 参数 */
export function buildDashscopeWanBody(card: ModelCard, req: VideoGenReq): { input: Record<string, unknown>; params: Record<string, unknown>; model: string; report: AdapterSpecReport } {
  const first = req.image ?? req.refImages?.[0];
  const input: Record<string, unknown> = { prompt: req.prompt };
  if (req.video && !first && !req.lastFrame) input.first_clip_url = req.video; // 视频延展（first_clip）
  else if (first && req.lastFrame) {
    input.first_frame_url = first;
    input.last_frame_url = req.lastFrame;
  } else if (first) {
    input.img_url = first;
  }
  if (req.refAudio) input.driving_audio_url = req.refAudio; // 音频驱动
  const asked = Number(req.duration) || 5;
  const dur = Math.max(2, Math.min(15, Math.round(asked)));
  const params: Record<string, unknown> = { duration: dur, prompt_extend: true, watermark: false };
  if (req.resolution) params.size = req.resolution === "1080p" ? "1920*1080" : "1280*720";
  if (req.aspect && !req.resolution) {
    params.size = req.aspect === "9:16" ? "720*1280" : req.aspect === "1:1" ? "960*960" : "1280*720";
  }
  if (req.seed !== undefined) params.seed = req.seed;
  if (req.audio !== undefined) params.audio = req.audio; // 原生音频 / 自动配音
  const unapplied: AdapterSpecReport["unapplied"] = [{ field: "fps", reason: "DashScope 协议没有帧率直出参数——未发送 fps" }];
  if (dur !== asked) unapplied.push({ field: "durationSec", reason: `官方 API 整数 2–15 秒——${asked}s 已取整为 ${dur}s` });
  return {
    input,
    params,
    model: card.model,
    report: {
      durationSec: dur,
      ...(req.resolution ? { resolution: req.resolution } : {}),
      unapplied,
    },
  };
}

/** Google Gemini API 提交体：4–8s 钳制、aspectRatio + resolution、无 FPS 参数 */
export function buildGoogleVideoBody(card: ModelCard, req: VideoGenReq): { instance: Record<string, unknown>; parameters: Record<string, unknown>; model: string; report: AdapterSpecReport } {
  // instances[].image：首帧（dataURL → bytesBase64Encoded）；Omni/Veo 多轮编辑可带 video，首版先图+文
  const instance: Record<string, unknown> = { prompt: req.prompt };
  const first = req.image ?? req.refImages?.[0];
  if (first?.startsWith("data:")) {
    instance.image = {
      bytesBase64Encoded: b64Of(first),
      mimeType: first.match(/^data:([^;]+)/)?.[1] ?? "image/png",
    };
  }
  const asked = Number(req.duration) || 5;
  const dur = Math.max(4, Math.min(8, Math.round(asked)));
  const parameters: Record<string, unknown> = {
    aspectRatio: req.aspect === "9:16" ? "9:16" : req.aspect === "1:1" ? "1:1" : "16:9",
    durationSeconds: dur,
    ...(req.negative ? { negativePrompt: req.negative } : {}),
  };
  // 3.5：resolution 必须随请求提交（Veo 3.1 支持 "720p"/"1080p"）——此前从未传递
  if (req.resolution) parameters.resolution = req.resolution;
  const model = card.model.includes(":") ? card.model : `${card.model}:predictLongRunning`;
  const unapplied: AdapterSpecReport["unapplied"] = [{ field: "fps", reason: "Google Gemini API 没有帧率直出参数——未发送 fps" }];
  if (dur !== asked) unapplied.push({ field: "durationSec", reason: `官方 API 整数 4–8 秒——${asked}s 已取整为 ${dur}s` });
  return {
    instance,
    parameters,
    model,
    report: {
      durationSec: dur,
      ...(req.resolution ? { resolution: req.resolution } : {}),
      unapplied,
    },
  };
}


/** 轮询期被本地中止时，尽力调用供应商取消端点（不支持时明确说明费用语义，§9.5） */
async function pollWithCancel(poll: () => Promise<string>, onAbort: () => Promise<{ cancelled: boolean; note: string }>): Promise<string> {
  try {
    return await poll();
  } catch (e) {
    if (e instanceof Error && e.message.includes("已取消")) {
      const r = await onAbort();
      throw new Error(`${r.note}`);
    }
    throw e;
  }
}

/* ---------------- 火山方舟 · Seedance（Ark v3） ---------------- */

export async function genArkSeedance(card: ModelCard, req: VideoGenReq): Promise<string> {
  const base = trimBase(card.baseUrl || "https://ark.cn-beijing.volces.com");
  const headers = {
    "Content-Type": "application/json",
    ...(card.apiKey ? { Authorization: `Bearer ${card.apiKey}` } : {}),
  };
  const { body, report } = buildArkSeedanceBody(card, req);
  req.onSpecApplied?.(report);

  const create = await xfetch(`${base}/api/v3/contents/generations/tasks`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!create.ok) {
    const t = await create.text().catch(() => "");
    throw new Error(arkErr(create.status, t));
  }
  const created = (await create.json()) as { id?: string };
  if (!created.id) throw new Error("火山方舟未返回任务 id");
  req.onProgress?.(`已提交（${created.id.slice(0, 12)}…），轮询中`);

  // 轮询：queued → running → succeeded/failed（含 cancelled/expired）；中止时尽力取消远端任务
  const pollLoop = async (): Promise<string> => {
  for (let i = 0; i < 200; i++) {
    await sleep(5000, req.signal);
    const r = await xfetch(`${base}/api/v3/contents/generations/tasks/${created.id}`, { headers, signal: req.signal });
    if (!r.ok) continue; // 单次轮询失败容忍
    const task = (await r.json()) as {
      status?: string;
      error?: { code?: string; message?: string };
      content?: { video_url?: string };
      last_frame_url?: string;
    };
    if (task.status === "succeeded" && task.content?.video_url) {
      req.onProgress?.("生成完成，取回视频");
      return task.content.video_url;
    }
    if (task.status === "failed" || task.status === "cancelled" || task.status === "expired") {
      throw new Error(`火山方舟任务${task.status === "failed" ? "失败" : "已取消/过期"}：${task.error?.message ?? "未给出原因"}${/asset:\/\//.test(task.error?.message ?? "") ? "（火山可信素材需先通过素材库审核，肖像素材需授权）" : ""}`);
    }
    if (i % 6 === 0) req.onProgress?.(`${task.status === "running" ? "生成中" : "排队中"}… ${(i * 5) / 6 | 0}0 秒`);
  }
  throw new Error("火山方舟任务超时（>10 分钟）——可在任务中心查看后重试");
  };
  return pollWithCancel(pollLoop, async () => {
    const r = await xfetch(`${base}/api/v3/contents/generations/tasks/${created.id}`, { method: "DELETE", headers }).catch(() => null);
    return r && r.ok ? { cancelled: true, note: "已中止：火山方舟任务已取消" } : { cancelled: false, note: "已停止本地等待（火山方舟任务可能继续，已提交费用可能发生）" };
  });
}

function arkErr(status: number, text: string): string {
  if (status === 401 || status === 403) return "火山方舟鉴权失败：请检查 API Key（Ark 控制台 · API Key 管理）";
  if (status === 404) return "火山方舟接口 404：请确认 Base URL（通常 https://ark.cn-beijing.volces.com）与模型接入点";
  if (status === 429) return "火山方舟限流：任务并发达到上限，稍后重试或联系商务提额";
  return `火山方舟提交失败（HTTP ${status}）：${text.slice(0, 300)}`;
}

/* ---------------- 阿里云 DashScope · Wan 2.7 ---------------- */

export async function genDashscopeWan(card: ModelCard, req: VideoGenReq): Promise<string> {
  const base = trimBase(card.baseUrl || "https://dashscope.aliyuncs.com");
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${card.apiKey}`,
    "X-DashScope-Async": "enable",
  };
  const built = buildDashscopeWanBody(card, req);
  req.onSpecApplied?.(built.report);

  const create = await xfetch(`${base}/api/v1/services/aigc/video-generation/video-synthesis`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: built.model, input: built.input, parameters: built.params }),
    signal: req.signal,
  });
  if (!create.ok) {
    const t = await create.text().catch(() => "");
    if (create.status === 401) throw new Error("DashScope 鉴权失败：请检查 API Key（百炼控制台）");
    if (create.status === 429) throw new Error("DashScope 限流：稍后重试");
    throw new Error(`DashScope 提交失败（HTTP ${create.status}）：${t.slice(0, 300)}`);
  }
  const created = (await create.json()) as { output?: { task_id?: string } };
  const taskId = created.output?.task_id;
  if (!taskId) throw new Error("DashScope 未返回 task_id");
  req.onProgress?.(`已提交（${taskId.slice(0, 12)}…），轮询中`);

  const pollLoop = async (): Promise<string> => {
  for (let i = 0; i < 200; i++) {
    await sleep(5000, req.signal);
    const r = await xfetch(`${base}/api/v1/tasks/${taskId}`, { headers: { Authorization: `Bearer ${card.apiKey}` }, signal: req.signal });
    if (!r.ok) continue;
    const task = (await r.json()) as { output?: { task_status?: string; video_url?: string; message?: string } };
    const st = task.output?.task_status;
    if (st === "SUCCEEDED" && task.output?.video_url) return task.output.video_url;
    if (st === "FAILED" || st === "CANCELED" || st === "UNKNOWN") {
      throw new Error(`DashScope 任务${st === "FAILED" ? "失败" : "已取消"}：${task.output?.message ?? "未给出原因"}`);
    }
    if (i % 6 === 0) req.onProgress?.(`${st === "RUNNING" ? "生成中" : "排队中"}… ${(i * 5) / 6 | 0}0 秒`);
  }
  throw new Error("DashScope 任务超时（>10 分钟）");
  };
  return pollWithCancel(pollLoop, async () => {
    const r = await xfetch(`${base}/api/v1/tasks/${taskId}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${card.apiKey}` } }).catch(() => null);
    return r && r.ok ? { cancelled: true, note: "已中止：DashScope 任务已取消" } : { cancelled: false, note: "已停止本地等待（DashScope 任务可能继续）" };
  });
}

/* ---------------- Google · Gemini API（Omni / Veo 3.1） ---------------- */

export async function genGoogleVideo(card: ModelCard, req: VideoGenReq): Promise<string> {
  const base = trimBase(card.baseUrl || "https://generativelanguage.googleapis.com");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (card.apiKey) headers["x-goog-api-key"] = card.apiKey;

  const built = buildGoogleVideoBody(card, req);
  req.onSpecApplied?.(built.report);

  const create = await xfetch(`${base}/v1beta/models/${built.model}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ instances: [built.instance], parameters: built.parameters }),
    signal: req.signal,
  });
  if (!create.ok) {
    const t = await create.text().catch(() => "");
    if (create.status === 401 || create.status === 403) throw new Error("Google 鉴权失败：请检查 API Key（AI Studio）与模型访问权限");
    if (create.status === 429) throw new Error("Google 限流：稍后重试（免费层配额较低）");
    throw new Error(`Google 提交失败（HTTP ${create.status}）：${t.slice(0, 300)}`);
  }
  const op = (await create.json()) as { name?: string };
  if (!op.name) throw new Error("Google 未返回 operation name");
  req.onProgress?.("已提交，轮询 operation…");

  const pollLoop = async (): Promise<string> => {
  for (let i = 0; i < 240; i++) {
    await sleep(5000, req.signal);
    const r = await xfetch(`${base}/v1beta/${op.name}`, { headers, signal: req.signal });
    if (!r.ok) continue;
    const task = (await r.json()) as {
      done?: boolean;
      error?: { message?: string };
      response?: Record<string, unknown>;
    };
    if (task.done) {
      if (task.error) throw new Error(`Google 生成失败：${task.error.message ?? "未给出原因"}`);
      const resp = task.response ?? {};
      // 宽容解析：generateVideoResponse.generatedSamples[].video.uri / generatedVideos[].video.uri / RSC 视频
      const uri =
        deepFind(resp, "video") ??
        deepFind(resp, "gcsUri") ??
        deepFind(resp, "videoUri") ??
        (typeof (resp as Record<string, unknown>).videoUrl === "string" ? ((resp as Record<string, unknown>).videoUrl as string) : undefined);
      if (!uri) throw new Error(`Google 返回完成但没有视频地址：${JSON.stringify(resp).slice(0, 250)}`);
      // Gemini API 的 uri 需带 key 下载；http(s) 直链直接返回
      if (/^https?:/.test(uri)) return uri;
      const dl = await xfetch(`${base}/v1beta/files/${encodeURIComponent(uri)}:download?alt=media`, { headers, signal: req.signal });
      if (!dl.ok) return `${base}/v1beta/${uri}?key=${card.apiKey}`; // 兜底：交给调用方 blob 化
      const blob = await dl.blob();
      return await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error("Google 视频下载失败"));
        fr.readAsDataURL(blob);
      });
    }
    if (i % 6 === 0) req.onProgress?.(`生成中… ${(i * 5) / 6 | 0}0 秒`);
  }
  throw new Error("Google operation 超时（>20 分钟）");
  };
  return pollWithCancel(pollLoop, async () => {
    const r = await xfetch(`${base}/v1beta/${op.name}:cancel`, { method: "POST", headers }).catch(() => null);
    return { cancelled: !!(r && r.ok), note: r && r.ok ? "已中止：Google operation 已取消" : "已停止本地等待（Google 侧取消结果以控制台为准）" };
  });
}

/** 深度找对象里第一个视频地址（Google 各模型响应结构不一：video.uri / gcsUri / http 直链，宽容解析） */
function deepFind(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const v = (obj as Record<string, unknown>)[key];
  if (typeof v === "string" && /^https?:/.test(v)) return v;
  if (v && typeof v === "object" && typeof (v as Record<string, unknown>).uri === "string") {
    return (v as Record<string, unknown>).uri as string;
  }
  for (const sub of Object.values(obj as Record<string, unknown>)) {
    const hit = deepFind(sub, key);
    if (hit) return hit;
  }
  return undefined;
}

/* ---------------- 取消（尽力而为：供应商支持才真正撤销） ---------------- */

/** 远程任务取消（3.3 §9.5）：各家用自己的取消端点；不支持时明确告知「只停止等待」 */
export async function cancelRemoteVideoTask(protocol: string, card: ModelCard, taskId: string): Promise<{ cancelled: boolean; note: string }> {
  try {
    const base = trimBase(card.baseUrl || "");
    if (protocol === "ark") {
      const r = await xfetch(`${base}/api/v3/contents/generations/tasks/${taskId}`, {
        method: "DELETE",
        headers: card.apiKey ? { Authorization: `Bearer ${card.apiKey}` } : {},
      });
      return r.ok ? { cancelled: true, note: "火山方舟任务已取消" } : { cancelled: false, note: "火山方舟取消未成功，已停止本地等待（已提交费用可能发生）" };
    }
    if (protocol === "dashscope") {
      const r = await xfetch(`${base}/api/v1/tasks/${taskId}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${card.apiKey}` },
      });
      return r.ok ? { cancelled: true, note: "DashScope 任务已取消" } : { cancelled: false, note: "DashScope 取消未成功，已停止本地等待" };
    }
    if (protocol === "google") {
      const r = await xfetch(`${base}/v1beta/${taskId}:cancel`, {
        method: "POST",
        headers: card.apiKey ? { "x-goog-api-key": card.apiKey } : {},
      });
      return { cancelled: r.ok, note: r.ok ? "Google operation 已取消" : "已停止本地等待（Google 侧取消结果以控制台为准）" };
    }
  } catch {
    // 网络失败不阻断本地停止
  }
  return { cancelled: false, note: "该协议不支持远程取消——已停止本地轮询与后续队列，已提交费用可能发生" };
}
