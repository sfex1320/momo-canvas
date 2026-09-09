/**
 * 音频模型服务 — TTS 朗读 / 音乐生成
 *  - openai    OpenAI 兼容：POST /audio/speech（tts-1 / gpt-4o-mini-tts 等，返回二进制音频）
 *  - custom:*  预设协议（用途 = 音频生成）：{{prompt}} 文本、{{voice}} 音色
 */
import type { CustomProtocol, ModelCard } from "../types";
import { xfetch, trimBase, readErrorBody } from "./http";
import { absolutize, extractResultStrings, resolveCustomProto, runCustomFlow } from "./customProto";

export type AudioGenReq = {
  /** 朗读文本 / 音乐描述 */
  text: string;
  /** 音色（openai 的 voice；预设协议 {{voice}} 占位） */
  voice?: string;
  onProgress?: (msg: string) => void;
  /** 停止信号（节点上的停止按钮） */
  signal?: AbortSignal;
};

/** blob → dataURL（结果统一走 dataURL，再由 runner 收进资产库换持久地址） */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(new Error("音频数据读取失败"));
    r.readAsDataURL(blob);
  });
}

/** 最终响应 → 音频地址 */
function parseAudio(p: CustomProtocol, final: unknown, base = ""): string | null {
  const first = extractResultStrings(final, p.resultPath, "audio")[0];
  if (!first) return null;
  const a = absolutize(first, base);
  if (a.startsWith("http") || a.startsWith("data:") || a.startsWith("blob:")) return a;
  if (a.length > 200) return `data:audio/mpeg;base64,${a}`;
  return null;
}

async function genCustomAudio(card: ModelCard, req: AudioGenReq): Promise<string> {
  const proto = await resolveCustomProto(card.protocol, "audio");
  const vars: Record<string, string> = {
    baseUrl: trimBase(card.baseUrl),
    apiKey: card.apiKey,
    model: card.model,
    // 完整 JSON 转义（手动 replace 只转义 " 和 \n 会漏掉反斜杠本身与 \r \t，破坏请求体）
    prompt: JSON.stringify(req.text).slice(1, -1),
    // 音色名可能含引号/换行（自定义音色 ID），同样按 JSON 字符串转义再进模板
    voice: JSON.stringify(req.voice ?? "").slice(1, -1),
    size: "",
    n: "1",
    taskId: "",
  };
  req.onProgress?.("提交任务…");
  const final = await runCustomFlow(proto, vars, req.onProgress, req.signal);
  const a = parseAudio(proto, final, trimBase(card.baseUrl));
  if (!a)
    throw new Error(`协议「${proto.name}」未取到音频（路径 ${proto.resultPath}）。响应：${JSON.stringify(final).slice(0, 250)}`);
  return a;
}

export async function generateAudio(card: ModelCard, req: AudioGenReq): Promise<string> {
  if (!card.baseUrl || !card.model) throw new Error(`模型「${card.name}」缺少 Base URL 或模型名称`);
  if (card.protocol.startsWith("custom:")) return genCustomAudio(card, req);

  // openai 兼容：/audio/speech 同步返回二进制音频
  const base = trimBase(card.baseUrl);
  req.onProgress?.("合成音频…");
  const resp = await xfetch(`${base}/audio/speech`, {
    method: "POST",
    signal: req.signal,
    headers: {
      "Content-Type": "application/json",
      ...(card.apiKey ? { Authorization: `Bearer ${card.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: card.model,
      input: req.text,
      voice: req.voice?.trim() || "alloy",
      response_format: "mp3",
    }),
  });
  if (!resp.ok) throw new Error(`音频合成失败 ${resp.status}: ${await readErrorBody(resp)}`);
  const blob = await resp.blob();
  if (blob.size < 200) throw new Error("音频合成返回内容为空，请检查模型名与音色参数");
  return blobToDataUrl(blob.type ? blob : new Blob([blob], { type: "audio/mpeg" }));
}
