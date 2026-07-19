/**
 * ComfyUI 服务 — HTTP REST 直连
 *  探活 /system_stats · 提交 /prompt · 轮询 /history/{id} · 取图 /view · 传图 /upload/image
 *  进度：/ws WebSocket 实时节点级进度（连不上时静默退回轮询文案）
 */
import type { ComfyExposedParam, ComfyParamKind, ComfyTemplate, ComfyWfNode } from "../types";
import { xfetch, trimBase, readErrorBody } from "./http";
import { dataUrlToBlob, uid } from "../utils";

export function normalizeHost(host: string): string {
  let h = host.trim();
  if (!h) return "";
  if (!/^https?:\/\//i.test(h)) h = `http://${h}`;
  return trimBase(h);
}

export async function pingComfy(host: string): Promise<{ ok: boolean; info?: string; err?: string }> {
  try {
    const resp = await xfetch(`${normalizeHost(host)}/system_stats`);
    if (!resp.ok) return { ok: false, err: `HTTP ${resp.status}` };
    const j = await resp.json();
    const dev = j.devices?.[0];
    return { ok: true, info: dev ? `${dev.name ?? ""}`.trim() : "已连接" };
  } catch (e) {
    // 把底层真实原因带出去（权限拦截 / 拒绝连接 / 超时……），别只说"连不上"
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

/* ---------------- 工作流解析 ---------------- */

export function isApiWorkflow(json: unknown): json is Record<string, ComfyWfNode> {
  if (!json || typeof json !== "object" || Array.isArray(json)) return false;
  const entries = Object.entries(json as Record<string, unknown>);
  if (!entries.length) return false;
  return entries.every(
    ([, v]) => !!v && typeof v === "object" && typeof (v as any).class_type === "string" && typeof (v as any).inputs === "object",
  );
}

const isConnection = (v: unknown) => Array.isArray(v) && v.length === 2 && typeof v[0] === "string";

function guessKind(node: ComfyWfNode, input: string, value: unknown): ComfyParamKind {
  const name = input.toLowerCase();
  if (node.class_type === "LoadImage" && name === "image") return "image";
  if (name.includes("seed")) return "seed";
  if (typeof value === "boolean") return "toggle";
  if (typeof value === "number") return "number";
  return "text";
}

export type WfInputInfo = {
  nodeId: string;
  nodeTitle: string;
  classType: string;
  input: string;
  value: unknown;
  kind: ComfyParamKind;
};

/** 列出工作流中所有「可暴露」的静态输入（排除节点间连线） */
export function listWorkflowInputs(wf: Record<string, ComfyWfNode>): WfInputInfo[] {
  const out: WfInputInfo[] = [];
  for (const [nodeId, node] of Object.entries(wf)) {
    for (const [input, value] of Object.entries(node.inputs ?? {})) {
      if (isConnection(value)) continue;
      out.push({
        nodeId,
        nodeTitle: node._meta?.title ?? node.class_type,
        classType: node.class_type,
        input,
        value,
        kind: guessKind(node, input, value),
      });
    }
  }
  return out;
}

/** 猜测输出节点（SaveImage / PreviewImage 优先） */
export function guessOutputNode(wf: Record<string, ComfyWfNode>): string | undefined {
  const entries = Object.entries(wf);
  const hit =
    entries.find(([, n]) => n.class_type.includes("SaveImage")) ??
    entries.find(([, n]) => n.class_type.includes("PreviewImage")) ??
    entries.find(([, n]) => n.class_type.toLowerCase().includes("save"));
  return hit?.[0];
}

/* ---------------- 运行 ---------------- */

export async function uploadImageToComfy(host: string, dataUrl: string): Promise<string> {
  const fd = new FormData();
  fd.append("image", dataUrlToBlob(dataUrl), `momo_${uid(6)}.png`);
  fd.append("overwrite", "true");
  const resp = await xfetch(`${normalizeHost(host)}/upload/image`, { method: "POST", body: fd });
  if (!resp.ok) throw new Error(`上传图片到 ComfyUI 失败 ${resp.status}: ${await readErrorBody(resp)}`);
  const j = await resp.json();
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

export type ComfyRunResult = { images: string[] }; // /view 直链

/** WebSocket 实时进度：按已完成节点数 + 当前节点采样步数换算百分比，报给 onProgress */
function openProgressSocket(
  base: string,
  clientId: string,
  wf: Record<string, ComfyWfNode>,
  getPromptId: () => string | undefined,
  onProgress?: (msg: string, pct?: number) => void,
): { close: () => void; live: () => boolean } {
  let ws: WebSocket | null = null;
  let live = false;
  const total = Math.max(1, Object.keys(wf).length);
  const done = new Set<string>();
  let current: string | undefined;
  let step: { value: number; max: number } | null = null;

  const title = (nid?: string) => {
    const n = nid ? wf[nid] : undefined;
    return n ? n._meta?.title ?? n.class_type : "";
  };
  const report = () => {
    const frac = Math.min(1, (done.size + (step && step.max > 0 ? step.value / step.max : 0)) / total);
    const stepTxt = step ? ` · ${step.value}/${step.max} 步` : "";
    onProgress?.(`节点 ${Math.min(done.size + 1, total)}/${total}：${title(current) || "…"}${stepTxt}`, Math.round(frac * 100));
  };

  try {
    ws = new WebSocket(`${base.replace(/^http/i, "ws")}/ws?clientId=${clientId}`);
    ws.onopen = () => {
      live = true;
    };
    ws.onclose = ws.onerror = () => {
      live = false;
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return; // 二进制帧是预览图，忽略
      let m: { type?: string; data?: Record<string, unknown> };
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      const d = m.data ?? {};
      const pid = getPromptId();
      // 带 prompt_id 的消息只认自己这单（不带的旧版消息放行——executing/progress 本就只发给提交方）
      if (typeof d.prompt_id === "string" && pid && d.prompt_id !== pid) return;
      switch (m.type) {
        case "execution_cached":
          for (const n of (d.nodes as unknown[]) ?? []) done.add(String(n));
          report();
          break;
        case "executing":
          if (d.node === null) break; // 整单结束，交给 history 轮询收尾
          if (current && current !== String(d.node)) done.add(current);
          current = String(d.node);
          step = null;
          report();
          break;
        case "progress":
          step = { value: Number(d.value ?? 0), max: Number(d.max ?? 0) };
          if (d.node) current = String(d.node);
          report();
          break;
      }
    };
  } catch {
    ws = null;
  }
  return {
    close: () => {
      try {
        ws?.close();
      } catch {
        /* 忽略 */
      }
    },
    live: () => live,
  };
}

export async function runComfyTemplate(
  host: string,
  tpl: ComfyTemplate,
  paramValues: Record<string, string | number | boolean>,
  opts: { onProgress?: (msg: string, pct?: number) => void; signal?: AbortSignal } = {},
): Promise<ComfyRunResult> {
  const base = normalizeHost(host);
  if (!base) throw new Error("请先在「设置 → ComfyUI」中填写服务地址");

  // 1. 深拷贝工作流，写入参数值
  const wf: Record<string, ComfyWfNode> = JSON.parse(JSON.stringify(tpl.workflow));
  for (const p of tpl.params) {
    const v = paramValues[p.key] ?? p.value;
    const node = wf[p.nodeId];
    if (!node) continue;
    node.inputs[p.input] = p.kind === "number" || p.kind === "seed" ? Number(v) : v;
  }

  // 2. 先开 WebSocket（提交前连上才能收到从头开始的执行消息），再提交
  const clientId = `momo-${uid(8)}`;
  let promptId: string | undefined;
  const sock = openProgressSocket(base, clientId, wf, () => promptId, opts.onProgress);
  try {
    const resp = await xfetch(`${base}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: wf, client_id: clientId }),
    });
    if (!resp.ok) throw new Error(`ComfyUI 任务提交失败 ${resp.status}: ${await readErrorBody(resp)}`);
    const j = await resp.json();
    if (j.error) throw new Error(`ComfyUI 拒绝了工作流: ${JSON.stringify(j.error).slice(0, 300)}`);
    promptId = j.prompt_id;
    if (!promptId) throw new Error("ComfyUI 未返回 prompt_id");
    opts.onProgress?.("已加入队列…");

    // 3. 轮询 history 收尾（完成判定始终以 history 为准，WS 只负责进度展示）
    const sleep = (ms: number) =>
      new Promise<void>((res, rej) => {
        const t = setTimeout(res, ms);
        opts.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          rej(new Error("已取消"));
        });
      });

    for (let i = 0; i < 600; i++) {
      await sleep(1200);
      const hr = await xfetch(`${base}/history/${promptId}`);
      if (!hr.ok) continue;
      const hj = await hr.json();
      const entry = hj[promptId];
      if (!entry) {
        // 尚未完成；WS 不可用时才用队列位置凑合个文案
        if (!sock.live() && i % 4 === 0) {
          try {
            const q = await (await xfetch(`${base}/queue`)).json();
            const pending = (q.queue_pending ?? []).length;
            const running = (q.queue_running ?? []).length;
            opts.onProgress?.(pending > 0 ? `排队中（前面还有 ${pending} 个任务）` : running > 0 ? "正在生成…" : "等待中…");
          } catch {
            /* 忽略 */
          }
        }
        continue;
      }
      const status = entry.status?.status_str;
      if (status === "error") {
        const msg = JSON.stringify(entry.status?.messages ?? []).slice(0, 300);
        throw new Error(`ComfyUI 执行出错: ${msg}`);
      }
      // 收集输出图片
      const images: string[] = [];
      const outputs = entry.outputs ?? {};
      const nodeIds = tpl.outputNodeId && outputs[tpl.outputNodeId] ? [tpl.outputNodeId] : Object.keys(outputs);
      for (const nid of nodeIds) {
        for (const img of outputs[nid]?.images ?? []) {
          const q = new URLSearchParams({
            filename: img.filename,
            subfolder: img.subfolder ?? "",
            type: img.type ?? "output",
          });
          images.push(`${base}/view?${q.toString()}`);
        }
      }
      if (!images.length) throw new Error("工作流执行完成，但未在输出节点找到图片");
      return { images };
    }
    throw new Error("ComfyUI 执行超时");
  } finally {
    sock.close();
  }
}

/** 把暴露参数转为默认值映射 */
export function defaultParamValues(params: ComfyExposedParam[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const p of params) out[p.key] = p.value as string | number | boolean;
  return out;
}
