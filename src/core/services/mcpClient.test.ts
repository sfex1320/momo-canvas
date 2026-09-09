/**
 * MCP 客户端纯逻辑快测（node --experimental-strip-types 直接跑，tsc 已过类型）
 * 覆盖：SSE data 解析 / JSON-RPC 按 id 匹配 / inputSchema 归一化 / 调用结果文本化
 */
import { parseSseData, pickRpcById, toObjectSchema, formatCallContent } from "./mcpFormat.ts";

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failed++;
    console.error(`✗ ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  } else console.log(`✓ ${name}`);
};

// SSE 解析
eq("SSE 提取 data 行", parseSseData("event: message\ndata: {\"a\":1}\n\n: comment\ndata: {\"b\":2}"), ['{"a":1}', '{"b":2}']);
eq("SSE 无 data 返回空", parseSseData(": keep-alive\n\n"), []);

// JSON-RPC 按 id 匹配（SSE 流里夹通知）
const stream = ['{"jsonrpc":"2.0","method":"notifications/progress","params":{"p":1}}', '{"jsonrpc":"2.0","id":7,"result":{"tools":[{"name":"search"}]}}', '{"jsonrpc":"2.0","id":8,"result":{"x":1}}'];
eq("按 id 取 result", pickRpcById(stream, 7), { result: { tools: [{ name: "search" }] } });
eq("id 不匹配返回 null", pickRpcById(stream, 99), null);
eq("error 分支", pickRpcById(['{"jsonrpc":"2.0","id":3,"error":{"message":"boom"}}'], 3), { error: { message: "boom" } });

// schema 归一化
eq("schema 正常透传", toObjectSchema({ type: "object", properties: { q: { type: "string" } }, required: ["q"] }), { type: "object", properties: { q: { type: "string" } }, required: ["q"] });
eq("schema 缺 properties 补空对象", toObjectSchema({ type: "object" }).properties, {});
eq("schema 非 object 兜底", toObjectSchema(undefined), { type: "object", properties: {} });
eq("required 过滤非字符串", toObjectSchema({ type: "object", properties: {}, required: ["a", 3, null] }).required, ["a"]);

// 调用结果文本化
eq("文本拼接", formatCallContent({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), { text: "a\nb", isError: false });
eq("非文本占位", formatCallContent({ content: [{ type: "image", data: "..." }, { type: "text", text: "ok" }] }).text, "ok\n（另有 image 类型的内容未展示）");
eq("空内容", formatCallContent({ content: [] }).text, "（服务器没有返回文本内容）");
eq("isError 透传", formatCallContent({ content: [{ type: "text", text: "bad" }], isError: true }).isError, true);

if (failed) {
  console.error(`\n${failed} 项失败`);
  throw new Error(`${failed} 项失败`);
}
console.log("\n全部通过");
