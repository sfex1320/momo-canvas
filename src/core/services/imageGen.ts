/**
 * 绘画模型服务 — 多协议适配，返回统一为 dataURL 列表
 *  - openai  文生图 /images/generations；带参考图 /images/edits（multipart）
 *  - gemini  generateContent（nano banana 系列，支持参考图）
 */
import type { ModelCard } from "../types";
import { xfetch, trimBase, readErrorBody } from "./http";
import { extractResultStrings, resolveCustomProto, runCustomFlow } from "./customProto";
import { runWithSelfHeal } from "./protoSelfHeal";
import { dataUrlToBlob, toDataUrl } from "../utils";

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
  const fetchUrl = (u: string) => toDataUrl(u, (x, i) => xfetch(x as string, i));
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
async function parseImageResponse(resp: Response, ctx: { base: string; headers: Record<string, string> }): Promise<string[]> {
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
      if (Date.now() > deadline) throw new Error(`异步生图任务轮询超时（10 分钟），任务 ID：${taskId ?? "未知"}`);
      let pj: unknown;
      try {
        const r = await xfetch(url, { headers: ctx.headers });
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
        `可到「设置 → 协议」为该站配置自定义异步协议，或在中转站侧改为同步返回。响应：${JSON.stringify(j).slice(0, 200)}`,
    );
  throw new Error(`模型未返回图片。响应内容：${JSON.stringify(j).slice(0, 300)}`);
}

async function genOpenAI(card: ModelCard, req: ImageGenReq): Promise<string[]> {
  const base = trimBase(card.baseUrl);
  const headers: Record<string, string> = card.apiKey ? { Authorization: `Bearer ${card.apiKey}` } : {};
  const size = req.size || card.size || "1024x1024";
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
    if (req.mask) fd.append("mask", dataUrlToBlob(req.mask), "mask.png");
    refs.forEach((img, i) => {
      fd.append(refs.length > 1 ? "image[]" : "image", dataUrlToBlob(img), `ref_${i}.png`);
    });
    // 排查中转站兼容性用：确认蒙版/参考图确实随请求发出（F12 控制台可见）
    console.info(
      `[imageGen] POST ${base}/images/edits · model=${card.model} · 参考图=${refs.length} 张 · mask=${req.mask ? "已附带" : "无"} · size=${size} · n=${n}`,
    );
    const resp = await xfetch(`${base}/images/edits`, { method: "POST", headers, body: fd });
    if (!resp.ok) throw new Error(`图生图请求失败 ${resp.status}: ${await readErrorBody(resp)}`);
    return parseImageResponse(resp, { base, headers });
  }

  const body: Record<string, unknown> = { model: card.model, prompt: req.prompt, n };
  if (size !== "auto") body.size = size;
  if (req.quality && req.quality !== "auto") body.quality = req.quality;
  if (req.background) body.background = req.background;
  let resp = await xfetch(`${base}/images/generations`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, response_format: "b64_json" }),
  });
  if (!resp.ok) {
    // 部分供应商不接受 response_format，去掉重试一次
    resp = await xfetch(`${base}/images/generations`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  if (!resp.ok) throw new Error(`生图请求失败 ${resp.status}: ${await readErrorBody(resp)}`);
  return parseImageResponse(resp, { base, headers });
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

/* ---------------- 自定义协议 ----------------
   声明式协议（设置 → 协议）：执行器在 customProto.ts（与视频服务共用） */

async function genCustom(card: ModelCard, req: ImageGenReq): Promise<string[]> {
  const proto = await resolveCustomProto(card.protocol, "image");
  // 模板能力硬校验：占位符缺失时大声报错，绝不静默丢图/丢蒙版（否则模型只收到提示词，输出会与原图毫无关系）
  const tplText = `${proto.submit.url} ${proto.submit.body ?? ""}`;
  const hasImagePh = ["{{image}}", "{{images}}", "{{image2}}"].some((k) => tplText.includes(k));
  if (req.refImages?.length && !hasImagePh)
    throw new Error(
      `自定义协议「${proto.name}」的提交模板没有图片占位符，参考图发不出去（模型只会收到提示词）。` +
        `请到「设置 → 协议」给请求体加上图片字段（占位符 {{image}} 单图 / {{images}} 数组 / {{image2}} 第二图），` +
        `或把该服务商的绘画协议改为「OpenAI 兼容」`,
    );
  if (req.mask && !tplText.includes("{{mask}}"))
    throw new Error(
      `自定义协议「${proto.name}」的模板不含 {{mask}} 蒙版占位符，真蒙版通道走不通。` +
        `请把节点上的「通道」切成「指令式」，或到「设置 → 协议」为模板加上 {{mask}} 字段`,
    );
  // 自愈闭环：运行失败且像协议配置问题时，AI 依据执行现场自动修协议并重试一次
  return runWithSelfHeal(proto, "生成图像", async (p, trace) => {
    const vars: Record<string, string> = {
      baseUrl: trimBase(card.baseUrl),
      apiKey: card.apiKey,
      model: card.model,
      prompt: req.prompt.replace(/"/g, '\\"').replace(/\n/g, "\\n"),
      // 图生图的 auto 保持 auto（跟随原图分辨率，重绘/扩图需要）；文生图才默认 1024x1024
      size: req.size && req.size !== "auto" ? req.size : req.refImages?.length ? "auto" : "1024x1024",
      n: String(req.n ?? 1),
      taskId: "",
      // 图片占位符：{{image}} 首图 dataURL · {{image2}} 第二图 · {{images}} 全部参考图的 JSON 数组字面量（不要加引号）
      image: req.refImages?.[0] ?? "",
      image2: req.refImages?.[1] ?? "",
      images: JSON.stringify(req.refImages ?? []),
      // {{mask}} 蒙版 PNG dataURL（局部重绘/扩图的真蒙版通道）
      mask: req.mask ?? "",
    };
    const final = await runCustomFlow(p, vars, undefined, trace);
    const raw = extractResultStrings(final, p.resultPath, "image");
    const out: string[] = [];
    for (const r of raw) {
      if (r.startsWith("http")) out.push(await toDataUrl(r, (u, i) => xfetch(u as string, i)));
      else if (r.startsWith("data:image")) out.push(r);
      else if (r.length > 200) out.push(`data:image/png;base64,${r}`);
    }
    if (!out.length)
      throw new Error(
        `协议「${p.name}」未取到图片（路径 ${p.resultPath}）。响应：${JSON.stringify(final).slice(0, 250)}`,
      );
    return out;
  });
}

export async function generateImage(card: ModelCard, req: ImageGenReq): Promise<string[]> {
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
