/**
 * 绘画模型服务 — OpenAI 兼容 images API
 *  - 无参考图：POST /images/generations
 *  - 带参考图：POST /images/edits（multipart，gpt-image 风格，多数中转站兼容）
 * 返回统一为 dataURL 列表
 */
import type { ImageModelCfg } from "../types";
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

export async function generateImage(cfg: ImageModelCfg, req: ImageGenReq): Promise<string[]> {
  if (!cfg.baseUrl || !cfg.model) throw new Error("请先在「设置 → 模型配置」中填写绘画模型");
  const base = trimBase(cfg.baseUrl);
  const headers: Record<string, string> = cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
  const size = req.size || cfg.size || "1024x1024";
  const n = req.n ?? 1;

  if (req.refImages?.length) {
    // 图生图：/images/edits multipart
    const fd = new FormData();
    fd.append("model", cfg.model);
    fd.append("prompt", req.prompt);
    fd.append("n", String(n));
    if (size !== "auto") fd.append("size", size);
    req.refImages.forEach((img, i) => {
      fd.append(req.refImages!.length > 1 ? "image[]" : "image", dataUrlToBlob(img), `ref_${i}.png`);
    });
    const resp = await xfetch(`${base}/images/edits`, { method: "POST", headers, body: fd });
    if (!resp.ok) throw new Error(`图生图请求失败 ${resp.status}: ${await readErrorBody(resp)}`);
    const j = await resp.json();
    const imgs = await normalizeResults(j.data);
    if (!imgs.length) throw new Error("绘画模型没有返回图片");
    return imgs;
  }

  // 文生图：/images/generations
  const body: Record<string, unknown> = { model: cfg.model, prompt: req.prompt, n };
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
  const j = await resp.json();
  const imgs = await normalizeResults(j.data);
  if (!imgs.length) throw new Error("绘画模型没有返回图片");
  return imgs;
}
