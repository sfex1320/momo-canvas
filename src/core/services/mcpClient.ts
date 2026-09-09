/**
 * MCP 客户端（Streamable HTTP 传输）—— 最小可用实现
 *
 * 只支持 Streamable HTTP 端点（POST JSON-RPC，响应 JSON 或 SSE）；
 * stdio 服务器需要 Rust 侧进程管道，暂不支持（设置页有说明）。
 * 请求走 xfetch（Tauri plugin-http 绕 CORS，浏览器预览退回 fetch）。
 *
 * 协议要点（MCP 2025-03-26 Streamable HTTP）：
 *  - POST 端点，Content-Type: application/json，Accept 同时收 json 与 text/event-stream；
 *  - initialize 握手后服务器可能下发 Mcp-Session-Id 头，后续请求必须原样带回；
 *  - 通知（notifications/*）没有 id，服务器通常回 202，不等待结果；
 *  - SSE 响应里按 id 匹配本次请求的消息（一个事件流可能夹着别的通知）。
 */
import { xfetch } from "./http";
import { parseSseData, pickRpcById, toObjectSchema, formatCallContent } from "./mcpFormat";
import type { McpServerCfg } from "../types";

// 纯逻辑（SSE 解析 / RPC 匹配 / schema 归一化 / 结果文本化）在 mcpFormat.ts，可独立快测
export { parseSseData, pickRpcById, toObjectSchema, formatCallContent };

export type McpToolInfo = { name: string; description?: string; inputSchema?: unknown };

export type McpCallResult = {
  /** 文本部分（给模型看）；其他类型（图片/资源）以占位符列出 */
  text: string;
  isError: boolean;
};

/* ---------------- 有状态会话（每服务器一个闭包） ---------------- */

type Session = { rpcId: number; sessionId?: string };
const sessions = new Map<string, Session>();

async function rpc(
  server: McpServerCfg,
  method: string,
  params: unknown,
  opts?: { notification?: boolean; signal?:AbortSignal },
): Promise<unknown> {
  opts?.signal?.throwIfAborted();
  const s = sessions.get(server.id) ?? { rpcId: 0 };
  const id = ++s.rpcId;
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, ...(opts?.notification ? {} : { id }), ...(params !== undefined ? { params } : {}) };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(server.headers ?? {}),
    ...(s.sessionId ? { "mcp-session-id": s.sessionId } : {}),
  };
  const res = await xfetch(server.url, { method: "POST", headers, body: JSON.stringify(body),signal:opts?.signal });
  const sid = res.headers.get("mcp-session-id");
  if (sid) s.sessionId = sid;
  sessions.set(server.id, s);
  if (opts?.notification) return undefined; // 通知通常 202，无 body 可等
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`MCP ${method} HTTP ${res.status}${text ? `：${text}` : ""}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  let payload: { result?: unknown; error?: { message?: string } } | null = null;
  if (ct.includes("text/event-stream")) {
    payload = pickRpcById(parseSseData(text), id);
  } else {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      if ("error" in j) payload = { error: j.error as { message?: string } };
      else payload = { result: j.result };
    } catch {
      payload = null;
    }
  }
  if (!payload) throw new Error(`MCP ${method} 返回了无法解析的响应`);
  if (payload.error) throw new Error(`MCP ${method} 失败：${payload.error.message ?? JSON.stringify(payload.error)}`);
  return payload.result;
}

/** 握手 + 拉工具清单（设置页「测试连接」与能力同步共用；失败抛中文错误） */
export async function connectMcpServer(server: McpServerCfg): Promise<{ tools: McpToolInfo[] }> {
  await rpc(server, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "momo-canvas", version: "1.0" },
  });
  await rpc(server, "notifications/initialized", {}, { notification: true }).catch(() => undefined);
  const listed = (await rpc(server, "tools/list", {})) as { tools?: McpToolInfo[] } | undefined;
  const tools = (listed?.tools ?? []).filter((t) => t && typeof t.name === "string");
  return { tools };
}

/** 调一个工具（能力层的 run 用） */
export async function callMcpTool(server: McpServerCfg, toolName: string, args: Record<string, unknown>, signal?:AbortSignal): Promise<McpCallResult> {
  const result = await rpc(server, "tools/call", { name: toolName, arguments: args ?? {} },{signal});
  const { text, isError } = formatCallContent(result);
  if (isError) throw new Error(text);
  return { text, isError };
}

/** 服务器配置变更（url/headers）后丢弃旧会话，下次连接重新握手 */
export function resetMcpSession(serverId: string): void {
  sessions.delete(serverId);
}
