/**
 * 绘画模型服务 — 多协议适配，返回统一为 dataURL 列表
 *  - openai  文生图 /images/generations；带参考图 /images/edits（multipart）
 *  - gemini  generateContent（nano banana 系列，支持参考图）
 */
import type { ModelCard } from "../types";
import { xfetch, trimBase, readErrorBody } from "./http";
import { dataUrlToBlob, toDataUrl } from "../utils";

export type ImageGenReq = {
  prompt: string;
  size?: string;
  n?: number;
  refImages?: string[]; // dataURL
};

async function normalizeResults(data: any[]): Promise<string[]> {
  const out: string[] = [];
  for (const item of data ?? []) {
    if (item?.b64_json) out.push(`data:image/png;base64,${item.b64_json}`);
    else if (item?.url) out.push(await toDataUrl(item.url, (u, i) => xfetch(u as string, i)));
  }
  return out;
}

async function genOpenAI(card: ModelCard, req: ImageGenReq): Promise<string[]> {
  const base = trimBase(card.baseUrl);
  const headers: Record<string, string> = card.apiKey ? { Authorization: `Bearer ${card.apiKey}` } : {};
  const size = req.size || card.size || "1024x1024";
  const n = req.n ?? 1;

  if (req.refImages?.length) {
    const fd = new FormData();
    fd.append("model", card.model);
    fd.append("prompt", req.prompt);
    fd.append("n", String(n));
    if (size !== "auto") fd.append("size", size);
    req.refImages.forEach((img, i) => {
      fd.append(req.refImages!.length > 1 ? "image[]" : "image", dataUrlToBlob(img), `ref_${i}.png`);
    });
    const resp = await xfetch(`${base}/images/edits`, { method: "POST", headers, body: fd });
    if (!resp.ok) throw new Error(`图生图请求失败 ${resp.status}: ${await readErrorBody(resp)}`);
    return normalizeResults((await resp.json()).data);
  }

  const body: Record<string, unknown> = { model: card.model, prompt: req.prompt, n };
  if (size !== "auto") body.size = size;
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
  return normalizeResults((await resp.json()).data);
}

async function genGemini(card: ModelCard, req: ImageGenReq): Promise<string[]> {
  const base = trimBase(card.baseUrl || "https://generativelanguage.googleapis.com");
  const root = base.includes("/v1beta") ? base : `${base}/v1beta`;
  const url = `${root}/models/${card.model}:generateContent?key=${encodeURIComponent(card.apiKey)}`;
  const parts: unknown[] = [
    ...(req.refImages ?? []).map((img) => {
      const mime = img.match(/^data:([^;]+)/)?.[1] ?? "image/png";
      return { inline_data: { mime_type: mime, data: img.split(",")[1] ?? "" } };
    }),
    { text: req.prompt },
  ];
  const n = Math.min(req.n ?? 1, 4);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const resp = await xfetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts }] }),
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

export async function generateImage(card: ModelCard, req: ImageGenReq): Promise<string[]> {
  if (!card.model) throw new Error(`模型「${card.name}」缺少模型名称`);
  if (!card.baseUrl && card.protocol !== "gemini") throw new Error(`模型「${card.name}」缺少 Base URL`);
  const imgs = card.protocol === "gemini" ? await genGemini(card, req) : await genOpenAI(card, req);
  if (!imgs.length) throw new Error(`模型「${card.name}」没有返回图片`);
  return imgs;
}
