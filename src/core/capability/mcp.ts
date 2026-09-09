/**
 * MCP 适配器 —— 注册表里的第二种能力来源
 *
 * 设置里的 MCP 服务器（Streamable HTTP）连接成功后，其工具整批注册为
 * `mcp__<服务器id>__<工具名>` 能力（risk=read：由用户主动配置的服务器，
 * 工具作用于外部服务，摸不到 MOMO 数据；扣费/写入 MOMO 依然只能走内置信封）。
 * 每次同步先清后建——服务器禁用/改名/删工具不留残骸。
 *
 * 同步时机：App 启动（settings init 之后）+ 设置变更（订阅 settingsStore，
 * mcp 字段指纹变化时 800ms 防抖重连）。服务器离线只标 error 不注册，下次
 * 设置变更或重启再试。
 */
import { create } from "zustand";
import { registerCapability, unregisterCapability, listCapabilities } from "./index";
import type { CallerCtx } from "./types";
import { connectMcpServer, callMcpTool, resetMcpSession, toObjectSchema } from "../services/mcpClient";
import type { McpServerCfg } from "../types";
import { useSettings } from "../stores/settingsStore";

export type McpServerStatus = {
  state: "idle" | "connecting" | "connected" | "error";
  toolCount: number;
  error?: string;
  at: number;
};

type McpStatusState = {
  byId: Record<string, McpServerStatus>;
  set: (id: string, s: McpServerStatus) => void;
};

/** 连接状态（设置页徽标用；不入持久化） */
export const useMcpStatus = create<McpStatusState>((set) => ({
  byId: {},
  set: (id, s) => set((st) => ({ byId: { ...st.byId, [id]: s } })),
}));

function safeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 单服务器 → 一批能力（mcp__<srv>__<tool>） */
function registerServerTools(server: McpServerCfg, tools: Awaited<ReturnType<typeof connectMcpServer>>["tools"]): void {
  const prefix = `mcp__${safeId(server.id)}__`;
  for (const t of tools) {
    const schema = toObjectSchema(t.inputSchema);
    registerCapability({
      id: `${prefix}${safeId(t.name)}`,
      source: "mcp",
      title: `${server.name} · ${t.name}`,
      description: `[MCP:${server.name}] ${t.description || t.name}`,
      risk: "read", // 用户主动配置的外部服务器；工具动不了 MOMO 数据，扣费仍只走内置信封
      inputSchema: schema,
      validate: (args) => {
        if (args === undefined || args === null) return {};
        if (typeof args !== "object" || Array.isArray(args)) throw new Error("args 必须是对象");
        return args as Record<string, unknown>;
      },
      confirm: () => ({ type: "none" }),
      run: async (args: Record<string, unknown>, _ctx: CallerCtx) => {
        const { text } = await callMcpTool(server, t.name, args, _ctx.signal);
        return { text };
      },
    });
  }
}

/** 全量同步：清掉旧的 mcp 能力 → 逐服务器连接注册。串行（避免并发握手把状态写花）。 */
export async function syncMcpCapabilities(): Promise<void> {
  for (const c of listCapabilities()) if (c.source === "mcp") unregisterCapability(c.id);
  const servers = useSettings.getState().settings.mcp.servers.filter((s) => s.enabled && s.url);
  for (const srv of servers) {
    useMcpStatus.getState().set(srv.id, { state: "connecting", toolCount: 0, at: Date.now() });
    try {
      resetMcpSession(srv.id);
      const { tools } = await connectMcpServer(srv);
      registerServerTools(srv, tools);
      useMcpStatus.getState().set(srv.id, { state: "connected", toolCount: tools.length, at: Date.now() });
    } catch (e) {
      useMcpStatus.getState().set(srv.id, { state: "error", toolCount: 0, error: (e as Error).message, at: Date.now() });
    }
  }
}

let started = false;
let lastFingerprint = "";

/** App 启动后接线：立即同步一次 + 订阅设置变更（指纹防抖重连）。幂等。 */
export function initMcpSync(): void {
  if (started) return;
  started = true;
  void syncMcpCapabilities();
  let timer: ReturnType<typeof setTimeout> | null = null;
  useSettings.subscribe((st) => {
    const fp = JSON.stringify(st.settings.mcp?.servers ?? []);
    if (fp === lastFingerprint) return;
    lastFingerprint = fp;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void syncMcpCapabilities(), 800);
  });
}

/** 设置页「测试连接」：单服务器握手并立即同步（不等防抖） */
export async function testMcpServer(server: McpServerCfg): Promise<{ ok: boolean; toolCount: number; error?: string }> {
  useMcpStatus.getState().set(server.id, { state: "connecting", toolCount: 0, at: Date.now() });
  try {
    resetMcpSession(server.id);
    const { tools } = await connectMcpServer(server);
    useMcpStatus.getState().set(server.id, { state: "connected", toolCount: tools.length, at: Date.now() });
    return { ok: true, toolCount: tools.length };
  } catch (e) {
    const error = (e as Error).message;
    useMcpStatus.getState().set(server.id, { state: "error", toolCount: 0, error, at: Date.now() });
    return { ok: false, toolCount: 0, error };
  }
}
