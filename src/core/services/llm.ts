/**
 * 对话模型服务 — 多协议适配（流式 + 多模态 + 思考内容）
 *  - openai     OpenAI 兼容 /chat/completions（DeepSeek/GLM/Qwen/中转站等）
 *  - anthropic  Claude /v1/messages
 *  - gemini     Google /v1beta/models/{model}:streamGenerateContent
 */
import type { ChatMsg, ModelCard } from "../types";
import { xfetch, trimBase, readErrorBody } from "./http";

export type StreamCallbacks = {
  onText?: (full: string, delta: string) => void;
  onReasoning?: (full: string, delta: string) => void;
  signal?: AbortSignal;
};

type StreamOpts = StreamCallbacks & { system?: string };
type StreamResult = { text: string; reasoning: string };

/* ---------------- SSE 流读取 ---------------- */
async function readSse(resp: Response, onData: (payload: string) => void) {
  if (!resp.body) throw new Error("模型未返回流式响应");
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const handleLine = (line: string) => {
    const s = line.trim();
    if (!s.startsWith("data:")) return;
    const payload = s.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    onData(payload);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  }
  if (buf) handleLine(buf);
}

function splitDataUrl(dataUrl: string): { mime: string; b64: string } {
  const mime = dataUrl.match(/^data:([^;]+)/)?.[1] ?? "image/png";
  return { mime, b64: dataUrl.split(",")[1] ?? "" };
}

/* ---------------- OpenAI 兼容 ---------------- */
async function streamOpenAI(card: ModelCard, msgs: ChatMsg[], opts: StreamOpts): Promise<StreamResult> {
  const apiMsgs: { role: string; content: unknown }[] = [];
  if (opts.system) apiMsgs.push({ role: "system", content: opts.system });
  for (const m of msgs) {
    if (m.images?.length) {
      apiMsgs.push({
        role: m.role,
        content: [
          ...m.images.map((url) => ({ type: "image_url", image_url: { url } })),
          { type: "text", text: m.text },
        ],
      });
    } else {
      apiMsgs.push({ role: m.role, content: m.text });
    }
  }
  const resp = await xfetch(`${trimBase(card.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(card.apiKey ? { Authorization: `Bearer ${card.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: card.model, messages: apiMsgs, stream: true }),
    signal: opts.signal,
  });
  if (!resp.ok) throw new Error(`对话请求失败 ${resp.status}: ${await readErrorBody(resp)}`);

  let text = "";
  let reasoning = "";
  await readSse(resp, (payload) => {
    try {
      const j = JSON.parse(payload);
      const delta = j.choices?.[0]?.delta ?? {};
      const r: string = delta.reasoning_content ?? delta.reasoning ?? "";
      const t: string = delta.content ?? "";
      if (r) {
        reasoning += r;
        opts.onReasoning?.(reasoning, r);
      }
      if (t) {
        text += t;
        opts.onText?.(text, t);
      }
    } catch {
      /* 忽略无法解析的行 */
    }
  });
  return { text, reasoning };
}

/* ---------------- Anthropic Claude ---------------- */
async function streamAnthropic(card: ModelCard, msgs: ChatMsg[], opts: StreamOpts): Promise<StreamResult> {
  const base = trimBase(card.baseUrl);
  const url = base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
  const apiMsgs = msgs.map((m) => ({
    role: m.role,
    content: m.images?.length
      ? [
          ...m.images.map((img) => {
            const { mime, b64 } = splitDataUrl(img);
            return { type: "image", source: { type: "base64", media_type: mime, data: b64 } };
          }),
          { type: "text", text: m.text || "。" },
        ]
      : m.text,
  }));
  const resp = await xfetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(card.apiKey ? { "x-api-key": card.apiKey, Authorization: `Bearer ${card.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: card.model,
      max_tokens: 8192,
      ...(opts.system ? { system: opts.system } : {}),
      messages: apiMsgs,
      stream: true,
    }),
    signal: opts.signal,
  });
  if (!resp.ok) throw new Error(`对话请求失败 ${resp.status}: ${await readErrorBody(resp)}`);

  let text = "";
  let reasoning = "";
  await readSse(resp, (payload) => {
    try {
      const j = JSON.parse(payload);
      if (j.type !== "content_block_delta") return;
      const d = j.delta ?? {};
      if (d.type === "thinking_delta" && d.thinking) {
        reasoning += d.thinking;
        opts.onReasoning?.(reasoning, d.thinking);
      } else if (d.type === "text_delta" && d.text) {
        text += d.text;
        opts.onText?.(text, d.text);
      }
    } catch {
      /* 忽略 */
    }
  });
  return { text, reasoning };
}

/* ---------------- Google Gemini ---------------- */
function geminiBase(baseUrl: string): string {
  const base = trimBase(baseUrl || "https://generativelanguage.googleapis.com");
  return base.includes("/v1beta") ? base : `${base}/v1beta`;
}

async function streamGemini(card: ModelCard, msgs: ChatMsg[], opts: StreamOpts): Promise<StreamResult> {
  const url = `${geminiBase(card.baseUrl)}/models/${card.model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(card.apiKey)}`;
  const contents = msgs.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [
      ...(m.images ?? []).map((img) => {
        const { mime, b64 } = splitDataUrl(img);
        return { inline_data: { mime_type: mime, data: b64 } };
      }),
      { text: m.text },
    ],
  }));
  const resp = await xfetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
    }),
    signal: opts.signal,
  });
  if (!resp.ok) throw new Error(`对话请求失败 ${resp.status}: ${await readErrorBody(resp)}`);

  let text = "";
  let reasoning = "";
  await readSse(resp, (payload) => {
    try {
      const j = JSON.parse(payload);
      for (const part of j.candidates?.[0]?.content?.parts ?? []) {
        if (!part.text) continue;
        if (part.thought) {
          reasoning += part.text;
          opts.onReasoning?.(reasoning, part.text);
        } else {
          text += part.text;
          opts.onText?.(text, part.text);
        }
      }
    } catch {
      /* 忽略 */
    }
  });
  return { text, reasoning };
}

/* ---------------- 统一入口 ---------------- */
export async function chatStream(card: ModelCard, msgs: ChatMsg[], opts: StreamOpts = {}): Promise<StreamResult> {
  if (!card.baseUrl && card.protocol !== "gemini") throw new Error(`模型「${card.name}」缺少 Base URL`);
  if (!card.model) throw new Error(`模型「${card.name}」缺少模型名称`);
  const run = card.protocol === "anthropic" ? streamAnthropic : card.protocol === "gemini" ? streamGemini : streamOpenAI;
  const result = await run(card, msgs, opts);
  if (!result.text && !result.reasoning)
    throw new Error(`模型「${card.name}」没有返回内容（请检查 Base URL / 模型名 / 协议是否匹配）`);
  return result;
}

/** 一句话工具调用（内部仍走流式） */
export async function chatOnce(card: ModelCard, system: string, user: string): Promise<string> {
  const { text } = await chatStream(card, [{ role: "user", text: user }], { system });
  return text.trim();
}

export const OPTIMIZE_SYSTEM = `你是一位顶级 AI 绘画提示词专家。用户会给你一段绘画意图或粗糙提示词，请把它优化为一段高质量的中文绘画提示词：补充主体细节、构图、光影、风格、质感、镜头信息；保持原意；只输出优化后的提示词本身，不要任何解释。`;
