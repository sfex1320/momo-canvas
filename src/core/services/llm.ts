/**
 * 对话模型服务 — OpenAI 兼容 /chat/completions
 * 支持：流式输出、多模态图片输入、思考内容（reasoning_content / reasoning）
 */
import type { ChatModelCfg, ChatMsg } from "../types";
import { xfetch, trimBase, readErrorBody } from "./http";

export type StreamCallbacks = {
  onText?: (full: string, delta: string) => void;
  onReasoning?: (full: string, delta: string) => void;
  signal?: AbortSignal;
};

type ApiMsgPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type ApiMsg = { role: string; content: string | ApiMsgPart[] };

function toApiMessages(system: string | undefined, msgs: ChatMsg[]): ApiMsg[] {
  const out: ApiMsg[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of msgs) {
    if (m.images?.length) {
      const parts: ApiMsgPart[] = m.images.map((url) => ({ type: "image_url", image_url: { url } }));
      parts.push({ type: "text", text: m.text });
      out.push({ role: m.role, content: parts });
    } else {
      out.push({ role: m.role, content: m.text });
    }
  }
  return out;
}

export async function chatStream(
  cfg: ChatModelCfg,
  msgs: ChatMsg[],
  opts: StreamCallbacks & { system?: string } = {},
): Promise<{ text: string; reasoning: string }> {
  if (!cfg.baseUrl || !cfg.model) throw new Error("请先在「设置 → 模型配置」中填写对话模型");
  const url = `${trimBase(cfg.baseUrl)}/chat/completions`;
  const resp = await xfetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: toApiMessages(opts.system, msgs),
      stream: true,
    }),
    signal: opts.signal,
  });
  if (!resp.ok) throw new Error(`对话模型请求失败 ${resp.status}: ${await readErrorBody(resp)}`);
  if (!resp.body) throw new Error("对话模型未返回流式响应");

  let text = "";
  let reasoning = "";
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const handleLine = (line: string) => {
    const s = line.trim();
    if (!s.startsWith("data:")) return;
    const payload = s.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
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

  if (!text && !reasoning) throw new Error("对话模型没有返回内容（请检查 baseUrl / model 是否正确）");
  return { text, reasoning };
}

/** 一句话工具调用（非流式语义，内部仍走流式） */
export async function chatOnce(cfg: ChatModelCfg, system: string, user: string): Promise<string> {
  const { text } = await chatStream(cfg, [{ role: "user", text: user }], { system });
  return text.trim();
}

export const OPTIMIZE_SYSTEM = `你是一位顶级 AI 绘画提示词专家。用户会给你一段绘画意图或粗糙提示词，请把它优化为一段高质量的中文绘画提示词：补充主体细节、构图、光影、风格、质感、镜头信息；保持原意；只输出优化后的提示词本身，不要任何解释。`;
