/**
 * 视频模型服务 — 三种主流 API 风格适配（提交任务 → 轮询结果）
 *  - zhipu       智谱 CogVideoX：POST /videos/generations → GET /async-result/{id}
 *  - siliconflow 硅基流动：POST /video/submit → POST /video/status
 *  - openai      OpenAI 兼容：POST /videos → GET /videos/{id} → /videos/{id}/content
 */
import type { VideoModelCfg } from "../types";
import { xfetch, trimBase, readErrorBody } from "./http";

export type VideoGenReq = {
  prompt: string;
  image?: string; // 首帧参考图 dataURL
  onProgress?: (msg: string) => void;
  signal?: AbortSignal;
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      rej(new Error("已取消"));
    });
  });

export async function generateVideo(cfg: VideoModelCfg, req: VideoGenReq): Promise<string> {
  if (!cfg.baseUrl || !cfg.model) throw new Error("请先在「设置 → 模型配置」中填写视频模型");
  const base = trimBase(cfg.baseUrl);
  const headers = {
    "Content-Type": "application/json",
    ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
  };
  const progress = (m: string) => req.onProgress?.(m);

  if (cfg.style === "zhipu") {
    const body: Record<string, unknown> = { model: cfg.model, prompt: req.prompt };
    if (req.image) body.image_url = req.image;
    const resp = await xfetch(`${base}/videos/generations`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!resp.ok) throw new Error(`视频任务提交失败 ${resp.status}: ${await readErrorBody(resp)}`);
    const { id } = await resp.json();
    if (!id) throw new Error("视频任务未返回 id");
    progress("任务已提交，生成中…");
    for (let i = 0; i < 240; i++) {
      await sleep(3000, req.signal);
      const r = await xfetch(`${base}/async-result/${id}`, { headers });
      if (!r.ok) continue;
      const j = await r.json();
      const st = j.task_status;
      if (st === "SUCCESS") {
        const url = j.video_result?.[0]?.url;
        if (!url) throw new Error("任务成功但未返回视频地址");
        return url;
      }
      if (st === "FAIL") throw new Error("视频生成失败（供应商返回 FAIL）");
      progress(`生成中… (${Math.round(((i + 1) * 3) / 60)}分${((i + 1) * 3) % 60}秒)`);
    }
    throw new Error("视频生成超时");
  }

  if (cfg.style === "siliconflow") {
    const body: Record<string, unknown> = { model: cfg.model, prompt: req.prompt };
    if (req.image) body.image = req.image;
    const resp = await xfetch(`${base}/video/submit`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!resp.ok) throw new Error(`视频任务提交失败 ${resp.status}: ${await readErrorBody(resp)}`);
    const { requestId } = await resp.json();
    if (!requestId) throw new Error("视频任务未返回 requestId");
    progress("任务已提交，生成中…");
    for (let i = 0; i < 240; i++) {
      await sleep(3000, req.signal);
      const r = await xfetch(`${base}/video/status`, { method: "POST", headers, body: JSON.stringify({ requestId }) });
      if (!r.ok) continue;
      const j = await r.json();
      if (j.status === "Succeed") {
        const url = j.results?.videos?.[0]?.url;
        if (!url) throw new Error("任务成功但未返回视频地址");
        return url;
      }
      if (j.status === "Failed") throw new Error(`视频生成失败: ${j.reason ?? "未知原因"}`);
      progress(`生成中… (${Math.round(((i + 1) * 3) / 60)}分${((i + 1) * 3) % 60}秒)`);
    }
    throw new Error("视频生成超时");
  }

  // openai 风格
  {
    const body: Record<string, unknown> = { model: cfg.model, prompt: req.prompt };
    const resp = await xfetch(`${base}/videos`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!resp.ok) throw new Error(`视频任务提交失败 ${resp.status}: ${await readErrorBody(resp)}`);
    const { id } = await resp.json();
    if (!id) throw new Error("视频任务未返回 id");
    progress("任务已提交，生成中…");
    for (let i = 0; i < 240; i++) {
      await sleep(3000, req.signal);
      const r = await xfetch(`${base}/videos/${id}`, { headers });
      if (!r.ok) continue;
      const j = await r.json();
      if (j.status === "completed") {
        const cr = await xfetch(`${base}/videos/${id}/content`, { headers });
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
