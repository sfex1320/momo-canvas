import type { ComfySyncSource, ComfySyncedWorkflow } from "../types";
export type SyncHealth = "off" | "empty" | "ok" | "new" | "warn" | "error";

/** 顶部按钮状态点：灰=未配置/停用 绿=全部正常 蓝=有新发现 黄=离线/警告 红=失败（规格 §6.1） */
export function syncHealthOf(sources: ComfySyncSource[], workflows: ComfySyncedWorkflow[], running: boolean): SyncHealth {
  if (!running) return sources.length ? "warn" : "off";
  if (!sources.length) return "empty";
  const st = new Set(workflows.map((w) => w.status));
  if (st.has("invalid")) return "error";
  if (sources.some((s) => s.status === "offline" || s.status === "permission_denied")) return "warn";
  if (st.has("derive_failed")) return "warn";
  if (st.has("untracked") || st.has("pending_import") || st.has("source_changed")) return "new";
  return "ok";
}
