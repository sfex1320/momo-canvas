/**
 * 视频模型服务 — 三种主流 API 风格适配（提交任务 → 轮询结果）
 *  - zhipu       智谱 CogVideoX：POST /videos/generations → GET /async-result/{id}
 *  - siliconflow 硅基流动：POST /video/submit → POST /video/status
 *  - openai      OpenAI 兼容：POST /videos → GET /videos/{id} → /videos/{id}/content
 */
import type { ModelCard } from "../types";
import { xfetch, trimBase, readErrorBody } from "./http";
import { extractResultStrings, resolveCustomProto, runCustomFlow } from "./customProto";
import { runWithSelfHeal } from "./protoSelfHeal";
import { soraSize, videoFamily, videoWh } from "../videoMeta";

export type VideoGenReq = {
  prompt: string;
  image?: string; // 首帧参考图 dataURL
  /** 尾帧参考图 dataURL（首尾帧过渡；家族支持时才传） */
  lastFrame?: string;
  /** 参考图模式：全部上游图作为角色/主体参考（Seedance 2.0 / Veo 3.1 / 可灵 elements / Vidu reference） */
  refImages?: string[];
  /** 参考视频（部分家族支持；自定义协议用 {{video}} 占位） */
  video?: string;
  /** 时长（秒数字符串，如 "5"；服务层按协议转格式） */
  duration?: string;
  /** 分辨率档（如 "720p"） */
  resolution?: string;
  /** 宽高比（如 "16:9"） */
  aspect?: string;
  /** 生成音频 */
  audio?: boolean;
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

/** 自定义协议（设置 → 协议，用途 = 视频生成）：模板执行器跑提交/轮询，结果按视频地址取用 */
async function genCustomVideo(card: ModelCard, req: VideoGenReq): Promise<string> {
  const proto = await resolveCustomProto(card.protocol, "video");
  // 自愈闭环：运行失败且像协议配置问题时，AI 依据执行现场自动修协议并重试一次
  return runWithSelfHeal(
    proto,
    "生成视频",
    async (p, trace) => {
      const vars: Record<string, string> = {
        baseUrl: trimBase(card.baseUrl),
        apiKey: card.apiKey,
        model: card.model,
        prompt: req.prompt.replace(/"/g, '\\"').replace(/\n/g, "\\n"),
        size: "",
        n: "1",
        taskId: "",
        // 首帧参考图 dataURL（模板用 {{image}} 占位）；{{image2}} = 尾帧；
        // {{images}} = 参考图 JSON 数组（角色/主体参考模式）；{{video}} = 参考视频
        image: req.image ?? req.refImages?.[0] ?? "",
        image2: req.lastFrame ?? "",
        images: JSON.stringify(req.refImages ?? []),
        video: req.video ?? "",
        // 家族化参数（模板按需引用；空值配合条件块 {{?duration}}…{{/duration}} 不发）
        duration: req.duration ?? "",
        resolution: req.resolution ?? "",
        aspect: req.aspect ?? "",
        audio: req.audio === undefined ? "" : String(req.audio),
      };
      req.onProgress?.("提交任务…");
      const final = await runCustomFlow(p, vars, req.onProgress, trace);
      const raw = extractResultStrings(final, p.resultPath, "video");
      const v = raw[0];
      if (!v)
        throw new Error(
          `协议「${p.name}」未取到视频（路径 ${p.resultPath}）。响应：${JSON.stringify(final).slice(0, 250)}`,
        );
      if (v.startsWith("http") || v.startsWith("data:") || v.startsWith("blob:")) return v;
      if (v.length > 200) return `data:video/mp4;base64,${v}`;
      throw new Error(`协议「${p.name}」返回的结果不像视频地址：${v.slice(0, 120)}`);
    },
    req.onProgress,
  );
}

export async function generateVideo(card: ModelCard, req: VideoGenReq): Promise<string> {
  if (!card.baseUrl || !card.model) throw new Error(`模型「${card.name}」缺少 Base URL 或模型名称`);
  if (card.protocol.startsWith("custom:")) return genCustomVideo(card, req);
  const base = trimBase(card.baseUrl);
  const headers = {
    "Content-Type": "application/json",
    ...(card.apiKey ? { Authorization: `Bearer ${card.apiKey}` } : {}),
  };
  const progress = (m: string) => req.onProgress?.(m);
  const tick = (i: number) => progress(`生成中… (${Math.floor(((i + 1) * 3) / 60)}分${((i + 1) * 3) % 60}秒)`);

  const family = videoFamily(card);

  if (card.protocol === "zhipu") {
    const body: Record<string, unknown> = { model: card.model, prompt: req.prompt };
    if (req.image) body.image_url = req.image;
    if (req.duration) body.duration = Number(req.duration);
    if (req.resolution) {
      const wh = videoWh(req.resolution, req.aspect ?? "16:9");
      if (wh) body.size = `${wh.w}x${wh.h}`;
    }
    if (req.audio !== undefined) body.with_audio = req.audio;
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
    const body: Record<string, unknown> = { model: card.model, prompt: req.prompt };
    if (req.image) body.image = req.image;
    if (req.resolution) {
      const wh = videoWh(req.resolution, req.aspect ?? "16:9");
      if (wh) body.image_size = `${wh.w}x${wh.h}`;
    }
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
      tick(i);
    }
    throw new Error("视频生成超时");
  }

  // openai 任务式（Sora 风格：seconds 字符串 + size 尺寸串；首帧 input_reference）
  {
    const body: Record<string, unknown> = { model: card.model, prompt: req.prompt };
    if (req.duration) body.seconds = req.duration;
    if (req.resolution) {
      if (family === "sora") {
        body.size = soraSize(req.resolution, req.aspect ?? "16:9");
      } else {
        const wh = videoWh(req.resolution, req.aspect ?? "16:9");
        if (wh) body.size = `${wh.w}x${wh.h}`;
      }
    }
    if (req.image ?? req.refImages?.[0]) body.input_reference = req.image ?? req.refImages![0];
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
