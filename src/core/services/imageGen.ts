import { normalizeImageResult } from "./imageResult";
/**
 * 绘画模型服务 — 多协议适配，返回统一为 dataURL 列表
 *  - openai  文生图 /images/generations；带参考图 /images/edits（multipart）
 *  - gemini  generateContent（nano banana 系列，支持参考图）
 */
import type { CustomProtocol, ModelCard } from "../types";
import { xfetch, trimBase, readErrorBody } from "./http";
import { extractResultStrings, resolveCustomProto, runCustomFlow, render } from "./customProto";
import { dataUrlToBlob, toDataUrl } from "../utils";
import { gptSize, grsaiGptRoute } from "../modelMeta";

export type ImageGenReq = {
  prompt: string;
  size?: string;
  n?: number;
  refImages?: string[]; // dataURL
  /** GPT Image：质量 auto/high/medium/low */
  quality?: string;
  /** Nano Banana：宽高比（imageConfig.aspectRatio） */
  aspect?: string;
  /** Nano Banana：分辨率档 1K/2K/4K（imageConfig.imageSize） */
  resolution?: string;
  /** OpenAI images/edits 蒙版 PNG dataURL（透明处 = 允许重绘）；仅与 refImages 搭配生效 */
  mask?: string;
  /** GPT Image：背景（transparent = 输出透明 PNG） */
  background?: string;
  /** 随机种子：锁定后可复现（仅支持的家族/中转站生效，不支持的会被忽略） */
  seed?: number;
  /** 负向提示词：不想出现的内容 */
  negative?: string;
  /** 停止信号（节点上的停止按钮）：请求与轮询都会随之中断 */
  signal?: AbortSignal;
  /** Codex 图片通道：阶段提示与主动新建会话。 */
  onProgress?: (stage: string) => void;
  newConversation?: boolean;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
/** 各家中转站返回结构五花八门：尽量把图片条目找出来 */
function extractImageItems(j: any): any[] {
  if (Array.isArray(j?.data)) return j.data;
  if (Array.isArray(j?.images)) return j.images;
  if (Array.isArray(j?.output)) return j.output;
  if (j?.data && typeof j.data === "object") return [j.data];
  if (j?.url || j?.b64_json || j?.image) return [j];
  return [];
}

async function normalizeResults(j: any): Promise<string[]> {
  // 结果图是已付费产物：慢线路下载放宽超时（默认 90 秒对 4K 大图偏紧）
  const fetchUrl = (u: string) => toDataUrl(u, (x, i) => xfetch(x as string, i, { timeoutMs: 300_000 }));
  const out: string[] = [];
  for (const item of extractImageItems(j)) {
    if (typeof item === "string") {
      if (item.startsWith("http")) out.push(await fetchUrl(item));
      else if (item.startsWith("data:image")) out.push(item);
      else if (item.length > 200) out.push(`data:image/png;base64,${item}`);
      continue;
    }
    const b64 = item?.b64_json ?? item?.b64 ?? item?.image_base64;
    const url =
      item?.url ??
      (typeof item?.image_url === "string" ? item.image_url : item?.image_url?.url) ??
      (typeof item?.image === "string" && item.image.startsWith("http") ? item.image : undefined);
    // 部分中转站的 b64_json 里塞的是完整 data URL，直接透传，别再包一层前缀
    if (b64) out.push(b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`);
    else if (url) out.push(await fetchUrl(url));
    else if (typeof item?.image === "string" && item.image.length > 200) out.push(`data:image/png;base64,${item.image}`);
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 解析响应；没直接给图但给了异步任务信息（status_url）时自动轮询到出图 */
async function parseImageResponse(resp: Response, ctx: { base: string; headers: Record<string, string>; signal?: AbortSignal }): Promise<string[]> {
  const j = await resp.json();
  const imgs = await normalizeResults(j);
  if (imgs.length) return imgs;

  const taskId = j?.task_id ?? j?.taskId ?? j?.job_id ?? (j?.status && !j?.data ? j?.id : undefined);
  const statusUrl: string | undefined =
    typeof j?.status_url === "string" ? j.status_url : typeof j?.statusUrl === "string" ? j.statusUrl : undefined;
  if (statusUrl) {
    // 中转站把该模型转成了异步任务：按它返回的 status_url 轮询直到出图
    const url = statusUrl.startsWith("http") ? statusUrl : new URL(statusUrl, `${ctx.base}/`).toString();
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      await sleep(3000);
      if (ctx.signal?.aborted) throw new Error("已取消");
      if (Date.now() > deadline) throw new Error(`异步生图任务轮询超时（10 分钟），任务 ID：${taskId ?? "未知"}`);
      let pj: unknown;
      try {
        const r = await xfetch(url, { headers: ctx.headers, signal: ctx.signal });
        if (!r.ok) continue;
        pj = await r.json();
      } catch {
        continue; // 单次查询失败不中断（网络抖动），有 10 分钟总超时兜底
      }
      const p = pj as { status?: string; data?: { status?: string }; result?: unknown; output?: unknown };
      const st = String(p?.status ?? p?.data?.status ?? "").toLowerCase();
      if (["failed", "fail", "error", "canceled", "cancelled"].includes(st))
        throw new Error(`异步生图任务失败（状态 ${st}）。响应：${JSON.stringify(pj).slice(0, 200)}`);
      const got = await normalizeResults(pj);
      if (got.length) return got;
      // 有的站把结果套在 result / output 里
      for (const inner of [p?.result, p?.output]) {
        if (inner && typeof inner === "object") {
          const g2 = await normalizeResults(inner);
          if (g2.length) return g2;
        }
      }
    }
  }

  console.warn("[imageGen] 未解析出图片的完整响应：", j);
  if (taskId)
    throw new Error(
      `中转站把该模型转成了「异步任务」返回（任务 ID: ${String(taskId).slice(0, 40)}），但没有给出可轮询的 status_url。` +
        `该站点需要走异步协议（65535/APIMart 等预设已内置），请确认服务商绑定的协议正确，或在中转站侧改为同步返回。响应：${JSON.stringify(j).slice(0, 200)}`,
    );
  throw new Error(`模型未返回图片。响应内容：${JSON.stringify(j).slice(0, 300)}`);
}

async function genOpenAI(card: ModelCard, req: ImageGenReq): Promise<string[]> {
  const base = trimBase(card.baseUrl);
  const headers: Record<string, string> = card.apiKey ? { Authorization: `Bearer ${card.apiKey}` } : {};
  // 中转站常以 OpenAI 兼容协议提供 Nano Banana/Gemini 生图：此时上游只给了 aspect/resolution
  // （这两个字段只有原生 gemini 协议会读），必须在这里折算成 WxH，否则一律回落 1024x1024 出方图
  let size = req.size || card.size;
  if (!size && req.aspect && req.aspect !== "auto") {
    const s = gptSize(req.aspect, req.resolution ?? "1K");
    if (s) size = `${s.w}x${s.h}`;
  }
  size = size || "1024x1024";
  const n = req.n ?? 1;

  if (req.refImages?.length) {
    const refs = req.refImages.slice(0, 16); // GPT Image 系列最多 16 张输入图
    const fd = new FormData();
    fd.append("model", card.model);
    fd.append("prompt", req.prompt);
    fd.append("n", String(n));
    if (size !== "auto") fd.append("size", size);
    if (req.quality && req.quality !== "auto") fd.append("quality", req.quality);
    if (req.background) fd.append("background", req.background);
    if (req.seed !== undefined && Number.isFinite(req.seed)) fd.append("seed", String(Math.round(req.seed)));
    if (req.negative) fd.append("negative_prompt", req.negative);
    if (req.mask) fd.append("mask", dataUrlToBlob(req.mask), "mask.png");
    refs.forEach((img, i) => {
      fd.append(refs.length > 1 ? "image[]" : "image", dataUrlToBlob(img), `ref_${i}.png`);
    });
    // 排查中转站兼容性用：确认蒙版/参考图确实随请求发出（F12 控制台可见）
    console.info(
      `[imageGen] POST ${base}/images/edits · model=${card.model} · 参考图=${refs.length} 张 · mask=${req.mask ? "已附带" : "无"} · size=${size} · n=${n}`,
    );
    const resp = await xfetch(`${base}/images/edits`, { method: "POST", headers, body: fd, signal: req.signal });
    if (!resp.ok) throw new Error(`图生图请求失败 ${resp.status}: ${await readErrorBody(resp)}`);
    return parseImageResponse(resp, { base, headers, signal: req.signal });
  }

  const body: Record<string, unknown> = { model: card.model, prompt: req.prompt, n };
  if (size !== "auto") body.size = size;
  if (req.quality && req.quality !== "auto") body.quality = req.quality;
  if (req.background) body.background = req.background;
  // 随机种子 / 负向提示词：seedream/flux/qwen/万相 等家族与多数中转站支持；
  // 不支持的会忽略未知字段，发了也无害
  if (req.seed !== undefined && Number.isFinite(req.seed)) body.seed = Math.round(req.seed);
  if (req.negative) body.negative_prompt = req.negative;
  let resp = await xfetch(`${base}/images/generations`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, response_format: "b64_json" }),
    signal: req.signal,
  });
  if (!resp.ok) {
    // 部分供应商不接受 response_format，去掉重试一次
    resp = await xfetch(`${base}/images/generations`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: req.signal,
    });
  }
  if (!resp.ok) throw new Error(`生图请求失败 ${resp.status}: ${await readErrorBody(resp)}`);
  return parseImageResponse(resp, { base, headers, signal: req.signal });
}

async function genGemini(card: ModelCard, req: ImageGenReq): Promise<string[]> {
  const base = trimBase(card.baseUrl || "https://generativelanguage.googleapis.com");
  const root = base.includes("/v1beta") ? base : `${base}/v1beta`;
  const url = `${root}/models/${card.model}:generateContent?key=${encodeURIComponent(card.apiKey)}`;
  const parts: unknown[] = [
    ...(req.refImages ?? []).slice(0, 14).map((img) => {
      // Nano Banana 系列最多 14 张参考图
      const mime = img.match(/^data:([^;]+)/)?.[1] ?? "image/png";
      return { inline_data: { mime_type: mime, data: img.split(",")[1] ?? "" } };
    }),
    { text: req.prompt },
  ];
  // 宽高比 / 分辨率（1K 为默认档，不传以兼容不支持 imageSize 的旧模型）
  const imageConfig: Record<string, string> = {};
  if (req.aspect && req.aspect !== "auto") imageConfig.aspectRatio = req.aspect;
  if (req.resolution && req.resolution !== "1K") imageConfig.imageSize = req.resolution;
  const payload: Record<string, unknown> = { contents: [{ role: "user", parts }] };
  if (Object.keys(imageConfig).length) payload.generationConfig = { imageConfig };
  const n = Math.min(req.n ?? 1, 4);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const resp = await xfetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: req.signal,
    });
    if (!resp.ok) throw new Error(`Gemini 生图失败 ${resp.status}: ${await readErrorBody(resp)}`);
    const j = await resp.json();
    for (const part of j.candidates?.[0]?.content?.parts ?? []) {
      const inline = part.inline_data ?? part.inlineData;
      if (inline?.data) out.push(`data:${inline.mime_type ?? inline.mimeType ?? "image/png"};base64,${inline.data}`);
    }
  }
  return out;
}

/* ---------------- 预设协议 ----------------
   声明式协议（来源 core/protoPresets.ts）：执行器在 customProto.ts（图片/视频/音频共用） */

async function genCustom(card: ModelCard, req: ImageGenReq): Promise<string[]> {
  const proto = await resolveCustomProto(card.protocol, "image");
  // 模板能力硬校验：占位符缺失时大声报错，绝不静默丢图/丢蒙版（否则模型只收到提示词，输出会与原图毫无关系）
  const tplText = `${proto.submit.url} ${proto.submit.body ?? ""}`;
  const hasImagePh = ["{{image}}", "{{images}}", "{{image2}}"].some((k) => tplText.includes(k));
  if (req.refImages?.length && !hasImagePh)
    throw new Error(
      `协议「${proto.name}」的提交模板没有图片占位符，参考图发不出去（模型只会收到提示词）。` +
        `请换用带参考图通道的协议，或把该服务商的绘画协议改为「OpenAI 兼容」`,
    );
  if (req.mask && !tplText.includes("{{mask}}"))
    throw new Error(
      `协议「${proto.name}」的模板不含 {{mask}} 蒙版占位符，真蒙版通道走不通。请把节点上的「通道」切成「指令式」`,
    );
  /** 最终响应 → 图片 dataURL 列表 */
  const parseImages = async (p: CustomProtocol, final: unknown): Promise<string[]> => {
    const base = trimBase(card.baseUrl);
    // 相对地址（/files/xx.png）与协议相对地址（//cdn.xx/xx.png）先补成绝对地址，
    // 否则明明取到了结果却被逐条丢弃，报错还会把排查方向引到"resultPath 写错了"
    const raw = extractResultStrings(final, p.resultPath, "image").map((s) => normalizeImageResult(s, base));
    const out: string[] = [];
    const skipped: string[] = [];
    for (const r of raw) {
      if (r.startsWith("http")) out.push(await toDataUrl(r, (u, i) => xfetch(u as string, i, { timeoutMs: 300_000 }), "image"));
      else if (r.startsWith("data:image")) out.push(r);
      else if (r.length > 200) out.push(`data:image/png;base64,${r}`);
      else skipped.push(r.slice(0, 60));
    }
    if (!out.length && skipped.length)
      throw new Error(`按路径「${p.resultPath}」取到 ${skipped.length} 条内容，但都不像可用的图片地址：${skipped.join(" / ")}`);
    return out;
  };

  const vars: Record<string, string> = {
    baseUrl: trimBase(card.baseUrl),
    apiKey: card.apiKey,
    model: card.model,
    // 完整 JSON 转义：处理 \r \t \ 控制字符等（手动 replace 只转义 " 和 \n 会漏，破坏请求体 JSON）
    prompt: JSON.stringify(req.prompt).slice(1, -1),
    // 图生图的 auto 保持 auto（跟随原图分辨率，重绘/扩图需要）；文生图才默认 1024x1024
    // 只给了 aspect 时（Nano Banana 家族）先折算成 WxH，避免自定义协议拿不到尺寸
    size: (() => {
      if (req.size && req.size !== "auto") return req.size;
      if (req.aspect && req.aspect !== "auto") {
        const s = gptSize(req.aspect, req.resolution ?? "1K");
        if (s) return `${s.w}x${s.h}`;
      }
      return req.refImages?.length ? "auto" : "1024x1024";
    })(),
    n: String(req.n ?? 1),
    taskId: "",
    // 画幅相关占位符：{{aspect}} 如 16:9 · {{resolution}} 1K/2K/4K · {{quality}} auto/high/medium/low
    aspect: req.aspect && req.aspect !== "auto" ? req.aspect : "",
    resolution: req.resolution ?? "",
    quality: req.quality && req.quality !== "auto" ? req.quality : "",
    // 图片占位符：{{image}} 首图 dataURL · {{image2}} 第二图 · {{images}} 全部参考图的 JSON 数组字面量（不要加引号）
    image: req.refImages?.[0] ?? "",
    image2: req.refImages?.[1] ?? "",
    images: JSON.stringify(req.refImages ?? []),
    // {{mask}} 蒙版 PNG dataURL（局部重绘/扩图的真蒙版通道）
    mask: req.mask ?? "",
    // 随机种子 / 负向提示词（仅模板里写了 {{seed}} / {{negative}} 的协议才发出去）
    seed: req.seed !== undefined && Number.isFinite(req.seed) ? String(Math.round(req.seed)) : "",
    negative: JSON.stringify(req.negative ?? "").slice(1, -1),
  };
  // 排查中转站请求体兼容性：F12 控制台可见实际渲染后的请求体（body 前 300 字符，dataURL 在后段不显示）
  console.info(
    `[imageGen:custom] POST ${render(proto.submit.url, vars)} · model=${card.model} · 参考图=${req.refImages?.length ?? 0} 张 · mask=${req.mask ? "已附带" : "无"} · body前300=${render(proto.submit.body ?? "", vars).slice(0, 300)}`,
  );
  const final = await runCustomFlow(proto, vars, undefined, req.signal);
  const out = await parseImages(proto, final);
  if (!out.length)
    throw new Error(`协议「${proto.name}」未取到图片（路径 ${proto.resultPath}）。响应：${JSON.stringify(final).slice(0, 250)}`);
  return out;
}

export async function generateImage(card: ModelCard, req: ImageGenReq): Promise<string[]> {
  card = grsaiGptRoute(card);
  if (card.protocol === "codex") return (await import("../codexBridge")).codexGenerate(req);
  if (!card.model) throw new Error(`模型「${card.name}」缺少模型名称`);
  if (!card.baseUrl && card.protocol !== "gemini") throw new Error(`模型「${card.name}」缺少 Base URL`);
  const imgs = card.protocol.startsWith("custom:")
    ? await genCustom(card, req)
    : card.protocol === "gemini"
      ? await genGemini(card, req)
      : await genOpenAI(card, req);
  if (!imgs.length) throw new Error(`模型「${card.name}」没有返回图片`);
  return imgs;
}
