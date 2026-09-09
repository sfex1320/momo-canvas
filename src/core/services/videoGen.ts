/**
 * 视频模型服务 — 三种主流 API 风格适配（提交任务 → 轮询结果）
 *  - zhipu       智谱 CogVideoX：POST /videos/generations → GET /async-result/{id}
 *  - siliconflow 硅基流动：POST /video/submit → POST /video/status
 *  - openai      OpenAI 兼容：POST /videos → GET /videos/{id} → /videos/{id}/content
 */
import type { CustomProtocol, ModelCard } from "../types";
import { xfetch, trimBase, readErrorBody } from "./http.ts";
import { absolutize, extractResultStrings, resolveCustomProto, runCustomFlow } from "./customProto.ts";
import { soraSize, videoFamily, videoWh } from "../videoMeta.ts";
import { genArkSeedance, genDashscopeWan, genGoogleVideo } from "./videoAdapters.ts";
import { isAbortError } from "../runControl.ts";
import { modelAssignmentIssue } from "../modelAssignment.ts";
import type { SpecCapability } from "../studio/videoSpec.ts";

/**
 * 适配器规格报告（3.5 §6.8）：适配器构造完请求体后如实上报「发了什么/没发什么」。
 * Take 的 appliedVideoSpec 以它为准——不是把 requested 抄一遍。
 */
export type AdapterSpecReport = {
  /** 实际随请求发送的时长（秒；适配器内部钳制后的值） */
  durationSec?: number;
  /** 实际发送的分辨率档（模板/协议没吃 resolution 时缺省） */
  resolution?: string;
  /** 实际发送的帧率（协议没有 FPS 直出参数时缺省） */
  fps?: number;
  /** 未应用项与原因（进 Take adjustments 与预检展示） */
  unapplied?: Array<{ field: "resolution" | "fps" | "durationSec"; reason: string }>;
};

export type VideoGenReq = {
  prompt: string;
  image?: string; // 首帧参考图 dataURL
  /** 尾帧参考图 dataURL（首尾帧过渡；家族支持时才传） */
  lastFrame?: string;
  /** 参考图模式：全部上游图作为角色/主体参考（Seedance 2.0 / Veo 3.1 / 可灵 elements / Vidu reference） */
  refImages?: string[];
  /** 参考视频（部分家族支持；自定义协议用 {{video}} 占位） */
  video?: string;
  /** 参考音频（Seedance 2.0 等支持；自定义协议用 {{refAudio}} 占位） */
  refAudio?: string;
  /** 时长（秒数字符串，如 "5"；服务层按协议转格式） */
  duration?: string;
  /** 分辨率档（如 "720p"） */
  resolution?: string;
  /** 帧率（3.5 统一视频规格；适配器按各家协议映射，不支持则忽略并报告） */
  fps?: number;
  /** 宽高比（如 "16:9"） */
  aspect?: string;
  /** 生成音频 */
  audio?: boolean;
  /* —— 3.3 §2.5：官方协议适配器消费的字段（通用协议家族尽力透传）—— */
  /** 随机种子（Seedance/Wan 官方 API） */
  seed?: number;
  /** 负向提示词（Veo negativePrompt 等） */
  negative?: string;
  /** 适配器规格报告回调：请求体构造完成后上报真实发送值（Take 快照消费） */
  onSpecApplied?: (r: AdapterSpecReport) => void;
  onProgress?: (msg: string) => void;
  signal?: AbortSignal;
};

/**
 * 引擎能力描述（3.5 §6.5）：按协议给出 resolveVideoSpec 可消费的能力档案。
 * FPS 三家官方协议与通用 OpenAI 兼容协议都没有直出参数 → null（不发送 + adjustment 明示）；
 * 自定义协议以模板是否引用 {{fps}} 占位符为准（运行时报告补真相）。
 */
export function videoEngineCapability(card: ModelCard): SpecCapability {
  if (card.protocol === "ark") {
    return { resolutions: ["480p", "720p", "1080p", "2k", "4k"], fps: null, duration: { min: 4, max: 15, step: 1 } };
  }
  if (card.protocol === "dashscope") {
    return { resolutions: ["720p", "1080p"], fps: null, duration: { min: 2, max: 15, step: 1 } };
  }
  if (card.protocol === "google") {
    return { resolutions: ["720p", "1080p"], fps: null, duration: { min: 4, max: 8 } };
  }
  if (card.protocol === "zhipu") {
    return { fps: null, duration: { min: 2, max: 60 } };
  }
  if (card.protocol === "siliconflow") {
    return { fps: null, duration: undefined };
  }
  if (card.protocol.startsWith("custom:")) {
    // 自定义协议支不支持 fps 由模板 {{fps}} 占位符决定——这里不做区间钳制，运行时报告补真相
    return {};
  }
  // 通用 OpenAI 兼容（Sora 风格 seconds/size）：无 FPS 参数
  return { fps: null, duration: { min: 2, max: 60 } };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      rej(new Error("已取消"));
    });
  });

/** 最终响应 → 视频地址 */
function parseVideo(p: CustomProtocol, final: unknown, base = ""): string | null {
  const first = extractResultStrings(final, p.resultPath, "video")[0];
  if (!first) return null;
  // 相对地址先补成绝对地址，否则取到了也会被当成"不像地址"丢掉
  const v = absolutize(first, base);
  if (v.startsWith("http") || v.startsWith("data:") || v.startsWith("blob:")) return v;
  if (v.length > 200) return `data:video/mp4;base64,${v}`;
  return null;
}

/** 预设协议（用途 = 视频生成）：模板执行器跑提交/轮询，结果按视频地址取用 */
async function genCustomVideo(card: ModelCard, req: VideoGenReq): Promise<string> {
  const proto = await resolveCustomProto(card.protocol, "video");
  const vars = buildCustomVideoVars(card, req);
  // 3.5：模板实际引用了哪些规格占位符，就报告哪些真实发送（没引用的在 unapplied 里说明）
  req.onSpecApplied?.(customProtoSpecReport(proto, req, vars));
  req.onProgress?.("提交任务…");
  const final = await runCustomFlow(proto, vars, req.onProgress, req.signal);
  const v = parseVideo(proto, final, trimBase(card.baseUrl));
  if (!v)
    throw new Error(`协议「${proto.name}」未取到视频（路径 ${proto.resultPath}）。响应：${JSON.stringify(final).slice(0, 250)}`);
  return v;
}

/** 自定义协议占位符取值（纯函数，请求体测试直测）：fps 是否被消费由模板是否引用 {{fps}} 决定 */
export function buildCustomVideoVars(card: ModelCard, req: VideoGenReq): Record<string, string> {
  const wh = req.resolution ? videoWh(req.resolution, req.aspect ?? "16:9") : null;
  return {
    baseUrl: trimBase(card.baseUrl),
    apiKey: card.apiKey,
    model: card.model,
    // 完整 JSON 转义：手动 replace 只转义 " 和 \n，漏掉反斜杠本身与 \r \t，
    // 提示词里出现一个 \（Windows 路径、LaTeX、颜文字）就会破坏请求体 JSON，直接 400
    prompt: JSON.stringify(req.prompt).slice(1, -1),
    // 尺寸串按分辨率+比例折算（以前恒为空，模板写了 {{size}} 也拿不到值）
    size: wh ? `${wh.w}x${wh.h}` : "",
    n: "1",
    taskId: "",
    // 首帧参考图 dataURL（模板用 {{image}} 占位）；{{image2}} = 尾帧；
    // {{images}} = 参考图 JSON 数组（角色/主体参考模式）；{{video}} = 参考视频
    image: req.image ?? req.refImages?.[0] ?? "",
    image2: req.lastFrame ?? "",
    images: JSON.stringify(req.refImages ?? []),
    video: req.video ?? "",
    refAudio: req.refAudio ?? "",
    // 家族化参数（模板按需引用；空值配合条件块 {{?duration}}…{{/duration}} 不发）
    duration: req.duration ?? "",
    resolution: req.resolution ?? "",
    aspect: req.aspect ?? "",
    audio: req.audio === undefined ? "" : String(req.audio),
    // 3.5：帧率占位符（模板引用 {{fps}} 才真正发送；没引用时值为空串不会破坏请求）
    fps: req.fps !== undefined ? String(req.fps) : "",
  };
}

/** 自定义协议的规格报告：模板引用了哪些占位符，对应项才算真实发送 */
export function customProtoSpecReport(proto: CustomProtocol, req: VideoGenReq, vars: Record<string, string>): AdapterSpecReport {
  const tplText = [proto.submit.url, proto.submit.body, proto.poll?.url, proto.poll?.body]
    .filter((x): x is string => typeof x === "string")
    .join("\n");
  const used = (name: string) => tplText.includes(`{{${name}}}`) && (vars[name] ?? "") !== "";
  const unapplied: AdapterSpecReport["unapplied"] = [];
  if (req.fps !== undefined && !used("fps")) unapplied.push({ field: "fps", reason: "自定义协议模板未引用 {{fps}} 占位符——帧率未发送" });
  if (req.resolution && !used("resolution") && !used("size")) unapplied.push({ field: "resolution", reason: "自定义协议模板未引用 {{resolution}}/{{size}}——分辨率未发送" });
  if (req.duration && !used("duration")) unapplied.push({ field: "durationSec", reason: "自定义协议模板未引用 {{duration}}——时长未发送" });
  return {
    ...(used("duration") ? { durationSec: Number(vars.duration) } : {}),
    ...(used("resolution") ? { resolution: vars.resolution } : used("size") ? { resolution: req.resolution } : {}),
    ...(used("fps") ? { fps: Number(vars.fps) } : {}),
    ...(unapplied.length ? { unapplied } : {}),
  };
}

/* ---------------- 通用协议请求体构造（纯函数，测试直测） ---------------- */

/** 智谱 CogVideoX 提交体 */
export function buildZhipuVideoBody(card: ModelCard, req: VideoGenReq): { body: Record<string, unknown>; report: AdapterSpecReport } {
  const body: Record<string, unknown> = { model: card.model, prompt: req.prompt };
  // 首帧兜底：面板只连了参考图没设首帧时，也要把第一张图发出去（否则图生视频退化成文生视频）
  if (req.image ?? req.refImages?.[0]) body.image_url = req.image ?? req.refImages![0];
  const unapplied: AdapterSpecReport["unapplied"] = [];
  if (req.duration) body.duration = Number(req.duration);
  let resSent = false;
  if (req.resolution) {
    const wh = videoWh(req.resolution, req.aspect ?? "16:9");
    if (wh) {
      body.size = `${wh.w}x${wh.h}`;
      resSent = true;
    }
  }
  if (req.audio !== undefined) body.with_audio = req.audio;
  unapplied.push({ field: "fps", reason: "智谱协议没有帧率直出参数——未发送 fps" });
  return {
    body,
    report: {
      ...(req.duration ? { durationSec: Number(req.duration) } : {}),
      ...(resSent ? { resolution: req.resolution } : {}),
      unapplied,
    },
  };
}

/** 硅基流动提交体（无 duration 字段——时长不由该协议控制） */
export function buildSiliconflowVideoBody(req: VideoGenReq, model: string): { body: Record<string, unknown>; report: AdapterSpecReport } {
  const body: Record<string, unknown> = { model, prompt: req.prompt };
  if (req.image ?? req.refImages?.[0]) body.image = req.image ?? req.refImages![0];
  if (req.resolution) {
    const wh = videoWh(req.resolution, req.aspect ?? "16:9");
    if (wh) body.image_size = `${wh.w}x${wh.h}`;
  }
  return {
    body,
    report: {
      ...(req.resolution ? { resolution: req.resolution } : {}),
      unapplied: [
        { field: "durationSec", reason: "硅基流动协议不接收时长字段——时长由服务端/模型决定" },
        { field: "fps", reason: "硅基流动协议没有帧率直出参数——未发送 fps" },
      ],
    },
  };
}

/** OpenAI 任务式（Sora 风格）提交体 */
export function buildOpenAiVideoBody(req: VideoGenReq, model: string, family: string): { body: Record<string, unknown>; report: AdapterSpecReport } {
  const body: Record<string, unknown> = { model, prompt: req.prompt };
  const unapplied: AdapterSpecReport["unapplied"] = [];
  if (req.duration) body.seconds = req.duration;
  let resSent = false;
  if (req.resolution) {
    if (family === "sora") {
      body.size = soraSize(req.resolution, req.aspect ?? "16:9");
      resSent = true;
    } else {
      const wh = videoWh(req.resolution, req.aspect ?? "16:9");
      if (wh) {
        body.size = `${wh.w}x${wh.h}`;
        resSent = true;
      }
    }
  }
  if (req.image ?? req.refImages?.[0]) body.input_reference = req.image ?? req.refImages![0];
  // 尾帧 / 多参考图 / 音画同出：中转站字段不统一，按常见命名一并带上（不支持的会忽略未知字段）
  if (req.lastFrame) body.input_reference_last = req.lastFrame;
  if ((req.refImages?.length ?? 0) > 1) body.reference_images = req.refImages;
  if (req.audio !== undefined) body.with_audio = req.audio;
  unapplied.push({ field: "fps", reason: "OpenAI 兼容协议没有帧率直出参数——未发送 fps" });
  return {
    body,
    report: {
      ...(req.duration ? { durationSec: Number(req.duration) } : {}),
      ...(resSent ? { resolution: req.resolution } : {}),
      unapplied,
    },
  };
}

export async function generateVideo(card: ModelCard, req: VideoGenReq): Promise<string> {
  const assignmentIssue=modelAssignmentIssue("video",card.model);if(assignmentIssue)throw new Error(assignmentIssue);
  if (!card.baseUrl || !card.model) throw new Error(`模型「${card.name}」缺少 Base URL 或模型名称`);
  if (card.protocol.startsWith("custom:")) return genCustomVideo(card, req);
  // 3.3 §8 官方协议适配器：火山方舟 Seedance / DashScope Wan / Google Omni·Veo
  if (card.protocol === "ark") return genArkSeedance(card, req);
  if (card.protocol === "dashscope") return genDashscopeWan(card, req);
  if (card.protocol === "google") return genGoogleVideo(card, req);
  const base = trimBase(card.baseUrl);
  const headers = {
    "Content-Type": "application/json",
    ...(card.apiKey ? { Authorization: `Bearer ${card.apiKey}` } : {}),
  };
  const progress = (m: string) => req.onProgress?.(m);
  const tick = (i: number) => progress(`生成中… (${Math.floor(((i + 1) * 3) / 60)}分${((i + 1) * 3) % 60}秒)`);

  const family = videoFamily(card);

  // 轮询查询的容错：瞬时失败（请求超时/网络抖动/非 2xx）本轮跳过，连续 10 次全失败才报错
  // （此前一次网络抖动就会把整个已提交、已扣费的视频任务打死）
  let consecFail = 0;
  const pollJson = async (url: string, init?: RequestInit): Promise<any | null> => {
    try {
      const r = await xfetch(url, { ...init, signal: req.signal });
      consecFail = 0;
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      if (isAbortError(e)) throw e; // 用户主动停止：立刻终止
      if (++consecFail >= 10) throw e;
      return null;
    }
  };

  if (card.protocol === "zhipu") {
    const { body, report } = buildZhipuVideoBody(card, req);
    req.onSpecApplied?.(report);
    const resp = await xfetch(`${base}/videos/generations`, { method: "POST", headers, body: JSON.stringify(body), signal: req.signal });
    if (!resp.ok) throw new Error(`视频任务提交失败 ${resp.status}: ${await readErrorBody(resp)}`);
    const { id } = await resp.json();
    if (!id) throw new Error("视频任务未返回 id");
    progress("任务已提交，生成中…");
    for (let i = 0; i < 240; i++) {
      await sleep(3000, req.signal);
      const j = await pollJson(`${base}/async-result/${id}`, { headers });
      if (!j) continue;
      if (j.task_status === "SUCCESS") {
        const url = j.video_result?.[0]?.url;
        if (!url) throw new Error("任务成功但未返回视频地址");
        return url;
      }
      if (j.task_status === "FAIL") throw new Error("视频生成失败（供应商返回 FAIL）");
      tick(i);
    }
    throw new Error("视频生成超时");
  }

  if (card.protocol === "siliconflow") {
    const { body, report } = buildSiliconflowVideoBody(req, card.model);
    req.onSpecApplied?.(report);
    const resp = await xfetch(`${base}/video/submit`, { method: "POST", headers, body: JSON.stringify(body), signal: req.signal });
    if (!resp.ok) throw new Error(`视频任务提交失败 ${resp.status}: ${await readErrorBody(resp)}`);
    const { requestId } = await resp.json();
    if (!requestId) throw new Error("视频任务未返回 requestId");
    progress("任务已提交，生成中…");
    for (let i = 0; i < 240; i++) {
      await sleep(3000, req.signal);
      const j = await pollJson(`${base}/video/status`, { method: "POST", headers, body: JSON.stringify({ requestId }) });
      if (!j) continue;
      if (j.status === "Succeed") {
        const url = j.results?.videos?.[0]?.url;
        if (!url) throw new Error("任务成功但未返回视频地址");
        return url;
      }
      if (j.status === "Failed") throw new Error(`视频生成失败: ${j.reason ?? "未知原因"}`);
      tick(i);
    }
    throw new Error("视频生成超时");
  }

  // openai 任务式（Sora 风格：seconds 字符串 + size 尺寸串；首帧 input_reference）
  {
    const { body, report } = buildOpenAiVideoBody(req, card.model, family);
    req.onSpecApplied?.(report);
    const resp = await xfetch(`${base}/videos`, { method: "POST", headers, body: JSON.stringify(body), signal: req.signal });
    if (!resp.ok) throw new Error(`视频任务提交失败 ${resp.status}: ${await readErrorBody(resp)}`);
    const { id } = await resp.json();
    if (!id) throw new Error("视频任务未返回 id");
    progress("任务已提交，生成中…");
    for (let i = 0; i < 240; i++) {
      await sleep(3000, req.signal);
      const j = await pollJson(`${base}/videos/${id}`, { headers });
      if (!j) continue;
      if (j.status === "completed") {
        // 成片是付费产物且体积大（慢线路下载常超 90 秒）：单独放宽下载超时，不与其他请求一刀切
        const cr = await xfetch(`${base}/videos/${id}/content`, { headers, signal: req.signal }, { timeoutMs: 600_000 });
        if (!cr.ok) throw new Error(`下载视频失败 ${cr.status}`);
        const blob = await cr.blob();
        return URL.createObjectURL(blob);
      }
      if (j.status === "failed") throw new Error(`视频生成失败: ${j.error?.message ?? "未知原因"}`);
      progress(`生成中… ${j.progress ?? ""}`);
    }
    throw new Error("视频生成超时");
  }
}
