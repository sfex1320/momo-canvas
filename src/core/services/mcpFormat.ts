/**
 * MCP 纯逻辑（无外部依赖，node --experimental-strip-types 可直跑快测）
 * SSE 解析 / JSON-RPC 按 id 匹配 / inputSchema 归一化 / 调用结果文本化。
 * 有状态的 Streamable HTTP 会话在 mcpClient.ts。
 */

/** 从 SSE 响应体里解析出全部 data: 负载（JSON 文本；注释行/事件行忽略） */
export function parseSseData(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^data:\s?(.*)$/);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

/** 从一批 JSON-RPC 消息里挑出与请求 id 匹配的 result/error；SSE 流里可能夹带通知 */
export function pickRpcById(payloads: string[], id: number): { result?: unknown; error?: { message?: string } } | null {
  for (const p of payloads) {
    let j: unknown;
    try {
      j = JSON.parse(p);
    } catch {
      continue;
    }
    if (j && typeof j === "object" && (j as Record<string, unknown>).id === id) {
      const o = j as Record<string, unknown>;
      if ("error" in o) return { error: o.error as { message?: string } };
      return { result: o.result };
    }
  }
  return null;
}

/** MCP 服务器的 inputSchema 五花八门：统一洗成能力层要的 object 签名（未知字段保留） */
export function toObjectSchema(schema: unknown): { type: "object"; properties: Record<string, unknown>; required?: string[] } {
  const o = schema && typeof schema === "object" ? (schema as Record<string, unknown>) : {};
  const props = o.properties && typeof o.properties === "object" ? (o.properties as Record<string, unknown>) : {};
  const required = Array.isArray(o.required) ? o.required.filter((x): x is string => typeof x === "string") : undefined;
  return { type: "object", properties: props, ...(required?.length ? { required } : {}) };
}

/** tools/call 结果 → 文本（text 部分原样拼接；非文本内容以类型占位，不吞也不糊弄） */
export function formatCallContent(result: unknown): { text: string; isError: boolean } {
  const o = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const content = Array.isArray(o.content) ? o.content : [];
  const parts: string[] = [];
  const others: string[] = [];
  for (const c of content) {
    if (c && typeof c === "object") {
      const cc = c as Record<string, unknown>;
      if (cc.type === "text" && typeof cc.text === "string") parts.push(cc.text);
      else others.push(String(cc.type ?? "unknown"));
    }
  }
  if (others.length) parts.push(`（另有 ${others.join("、")} 类型的内容未展示）`);
  return { text: parts.join("\n") || "（服务器没有返回文本内容）", isError: o.isError === true };
}
