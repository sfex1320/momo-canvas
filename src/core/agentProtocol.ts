/** Agent 纯文本动作协议的宽容归一化；保持无外部依赖，便于独立链路验证。 */

export type AgentAction =
  | { action: "search"; query: string }
  | { action: "ask"; question: string; options?: string[] }
  | { action: "image"; prompt: string; count?: number; aspect?: string; resolution?: string; useRefs?: boolean }
  | { action: "video"; prompt: string; useRefs?: boolean; duration?: string }
  | { action: "tool"; tool: string; args?: Record<string, unknown> }
  | { action: "reply"; text: string };

export function normalizeAgentAction(j: Record<string, unknown> | null): AgentAction | null {
  if (!j) return null;
  const useRefs = j.useRefs === true || j.useRefs === "true";
  const count = Number(j.count);
  const duration = Number(j.duration);
  const action = typeof j.action === "string" ? j.action : typeof j.name === "string" ? j.name : "";
  // MiniMax 等模型偶尔把内部工具名 web_search 连同专用标签当文本吐出；统一转成 MOMO 的 search 动作。
  const args = j.arguments && typeof j.arguments === "object" ? j.arguments as Record<string, unknown> : undefined;
  const query = typeof j.query === "string" ? j.query : typeof args?.query === "string" ? args.query : undefined;
  if ((action === "search" || action === "web_search") && query) return { action: "search", query };
  if (action === "ask" && typeof j.question === "string") {
    return {
      action: "ask",
      question: j.question,
      options: Array.isArray(j.options) ? j.options.filter((x): x is string => typeof x === "string").slice(0, 4) : [],
    };
  }
  if (action === "image" && typeof j.prompt === "string" && j.prompt.trim()) {
    return {
      action: "image",
      prompt: j.prompt,
      count: Number.isFinite(count) && count > 0 ? count : undefined,
      aspect: typeof j.aspect === "string" ? j.aspect : undefined,
      resolution: typeof j.resolution === "string" ? j.resolution : undefined,
      useRefs,
    };
  }
  if (action === "video" && typeof j.prompt === "string" && j.prompt.trim()) {
    return { action: "video", prompt: j.prompt, useRefs, duration: Number.isFinite(duration) && duration > 0 ? String(duration) : undefined };
  }
  // tool 动作（能力层）：tool=能力 id；args 兼容模型常见的 arguments 写法
  const toolName = typeof j.tool === "string" ? j.tool : typeof j.name === "string" && j.name !== "tool" ? j.name : "";
  if ((action === "tool" || action === "use_tool") && toolName) {
    const toolArgs =
      j.args && typeof j.args === "object" ? (j.args as Record<string, unknown>)
      : j.arguments && typeof j.arguments === "object" ? (j.arguments as Record<string, unknown>)
      : {};
    return { action: "tool", tool: toolName, args: toolArgs };
  }
  if (action === "reply" && typeof j.text === "string") return { action: "reply", text: j.text };
  return null;
}

