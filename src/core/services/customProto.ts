/**
 * 自定义协议模板执行器 — 模板渲染 + 提交 + 可选异步轮询 + JSON 路径取值
 * （设置 → 协议 里的声明式协议；图片与视频服务共用）
 */
import type { CustomProtocol } from "../types";
import { xfetch } from "./http";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 简易 JSON 路径："data.url" / "data[].url" / "output[]"，[] 表示展开数组 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function jsonPath(obj: any, path: string): any[] {
  let cur: any[] = [obj];
  for (const seg of path.split(".").filter(Boolean)) {
    const spread = seg.endsWith("[]");
    const key = spread ? seg.slice(0, -2) : seg;
    const next: any[] = [];
    for (const c of cur) {
      const v = key ? c?.[key] : c;
      if (v === undefined || v === null) continue;
      if (spread && Array.isArray(v)) next.push(...v);
      else next.push(v);
    }
    cur = next;
  }
  return cur;
}

/** 变量是否为空（"" 或 "[]" 都算空 —— {{images}} 无参考图时是空数组字面量） */
function isBlank(v: string | undefined): boolean {
  return !v || v === "[]";
}

/** 模板渲染：先处理条件块，再做占位符替换
 *  {{?var}}…{{/var}} 变量非空时保留块内容；{{^var}}…{{/var}} 变量为空时保留（else 分支）
 *  典型用法：URL 按有无参考图切换端点、body 里蒙版/图片字段按需出现 */
export function render(tpl: string, vars: Record<string, string>): string {
  const cond = tpl
    .replace(/\{\{\?(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, k, seg) => (isBlank(vars[k]) ? "" : seg))
    .replace(/\{\{\^(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, k, seg) => (isBlank(vars[k]) ? seg : ""));
  return cond.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

export async function customFetch(
  cfg: { url: string; method?: string; headers?: Record<string, string>; body?: string },
  vars: Record<string, string>,
  signal?: AbortSignal,
): Promise<any> {
  const headers: Record<string, string> = {};
  const src = cfg.headers ?? { "Content-Type": "application/json", Authorization: "Bearer {{apiKey}}" };
  for (const [k, v] of Object.entries(src)) headers[k] = render(v, vars);
  const method = cfg.method ?? (cfg.body ? "POST" : "GET");
  const resp = await xfetch(render(cfg.url, vars), {
    method,
    headers,
    ...(signal ? { signal } : {}),
    ...(cfg.body && method !== "GET" ? { body: render(cfg.body, vars) } : {}),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`请求失败 ${resp.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`响应不是 JSON：${text.slice(0, 200)}`);
  }
}

/* ---------------- 宽容轮询 ----------------
   协议助手生成的 statusPath / doneValue / resultPath 常与中转站实际响应有出入，
   这里做多重兜底：状态字段按常见路径再找、完成/失败按常见取值识别、结果字段出现即视为完成 */

export const DONE_SET = ["succeeded", "success", "succeed", "completed", "complete", "done", "finished"];
export const FAIL_SET = ["failed", "fail", "error", "canceled", "cancelled", "timeout"];
const STATUS_PATHS = ["status", "data.status", "data[].status", "task_status", "data.task_status", "state", "data.state"];

/** 常见图片/视频结果字段路径（协议路径未命中时兜底） */
const IMG_PATHS = [
  "data[].url", "data[].images[].url", "data.images[].url", "images[].url", "data.url",
  "data.result.images[].url[]", "data.result.images[].url", "result.images[].url[]", "result.images[].url",
  "data[].url[]", "output[].url", "result[].url", "data[].b64_json", "url",
  // 65535.space 网关风格：result_urls / result_b64（部分账户只回 base64），可能包在 data 信封里
  "result_urls[]", "data.result_urls[]", "result_b64[]", "data.result_b64[]",
];
const VID_PATHS = [
  "data[].video_url", "data.video_url", "video_url", "data[].url", "data.url",
  "data.result.video_url", "result.video_url", "data.result.videos[].url", "result.videos[].url",
  "output[].url", "url",
];

/** 先按协议的 statusPath 取状态，取不到再按常见路径兜底 */
function readStatus(pj: any, primary: string): string {
  for (const p of [primary, ...STATUS_PATHS]) {
    const v = jsonPath(pj, p)[0];
    if (v !== undefined && v !== null && String(v) !== "") return String(v);
  }
  return "";
}

/** 按协议 resultPath 取结果字符串；未命中时按常见字段兜底 */
export function extractResultStrings(final: any, primary: string, kind: "image" | "video"): string[] {
  const tryPath = (p: string) =>
    jsonPath(final, p)
      .map((v) => (typeof v === "string" ? v : ""))
      .filter((s) => s.length > 4);
  const hit = tryPath(primary);
  if (hit.length) return hit;
  for (const p of kind === "video" ? VID_PATHS : IMG_PATHS) {
    if (p === primary) continue;
    const out = tryPath(p);
    if (out.length) {
      console.warn(`[customProto] resultPath「${primary}」未命中，已兜底使用「${p}」`);
      return out;
    }
  }
  return [];
}

/** 执行现场记录：脱敏（密钥→***）+ 截断后收进 trace，供自愈时交给 AI 分析 */
function traceAdd(trace: string[] | undefined, label: string, text: string, secret?: string): number {
  if (!trace) return -1;
  let t = text;
  if (secret) t = t.split(secret).join("***");
  trace.push(`【${label}】${t.slice(0, 600)}`);
  return trace.length - 1;
}

/** 完整执行提交（+ 异步轮询）流程，返回包含结果的最终响应 JSON；trace 收集真实请求/响应现场 */
export async function runCustomFlow(
  proto: CustomProtocol,
  vars: Record<string, string>,
  onProgress?: (msg: string) => void,
  trace?: string[],
): Promise<any> {
  traceAdd(
    trace,
    "提交请求",
    `${proto.submit.method ?? "POST"} ${render(proto.submit.url, vars)} body=${render(proto.submit.body ?? "", vars)}`,
    vars.apiKey,
  );
  let final = await customFetch(proto.submit, vars);
  traceAdd(trace, "提交响应", JSON.stringify(final), vars.apiKey);
  if (proto.taskIdPath) {
    let taskId = String(jsonPath(final, proto.taskIdPath)[0] ?? "");
    if (!taskId) {
      // 协议里的路径没取到 → 按常见任务 id 字段名兜底再试一轮（协议助手偶尔会把路径层级写错）
      for (const p of ["task_id", "id", "job_id", "request_id", "requestId", "data.task_id", "data.id", "data.job_id"]) {
        const v = jsonPath(final, p)[0];
        if ((typeof v === "string" && v) || typeof v === "number") {
          taskId = String(v);
          console.warn(`[customProto] taskIdPath「${proto.taskIdPath}」未命中，已兜底使用「${p}」`);
          break;
        }
      }
    }
    // 拿不到任务 ID 但提交响应里已经有结果 → 服务商这次走了同步通道，直接收货
    if (!taskId && extractResultStrings(final, proto.resultPath, proto.role === "video" ? "video" : "image").length) {
      traceAdd(trace, "同步返回", "提交响应已含结果，跳过轮询", vars.apiKey);
      return final;
    }
    if (!taskId)
      throw new Error(`未取到任务 ID（路径 ${proto.taskIdPath}，常见字段兜底也未命中）。响应：${JSON.stringify(final).slice(0, 250)}`);
    vars.taskId = taskId;

    // 提交响应若自带轮询地址（status_url 风格）：留作替补——协议里的轮询地址打不通、
    // 或连续多轮查不到状态/结果（地址错但返回 200）时，自动切换过去，别干等到超时
    let altPoll: string | null = null;
    for (const p of ["status_url", "statusUrl", "data.status_url", "task_url", "query_url"]) {
      const v = jsonPath(final, p)[0];
      if (typeof v === "string" && v) {
        altPoll = v.startsWith("http") ? v : new URL(v, `${vars.baseUrl}/`).toString();
        break;
      }
    }
    if (!proto.poll) {
      if (!altPoll) throw new Error(`协议「${proto.name}」是异步接口但缺少 poll 轮询配置`);
      // 协议没配轮询但服务商给了 status_url：直接按它轮询（宽容执行，别让配置缺口挡住任务）
      proto = { ...proto, poll: { url: altPoll, method: "GET", headers: { Authorization: "Bearer {{apiKey}}" }, intervalMs: 3000, statusPath: "status", doneValue: "completed" } };
      traceAdd(trace, "轮询配置补全", `协议缺少 poll，已按提交响应的 status_url 轮询：${altPoll}`, vars.apiKey);
    }
    const pollCfg = { ...proto.poll! };
    let switched = false;
    const switchToAlt = (why: string): boolean => {
      if (!altPoll || switched || render(pollCfg.url, vars) === altPoll) return false;
      switched = true;
      pollCfg.url = altPoll;
      pollCfg.method = "GET";
      delete pollCfg.body;
      traceAdd(trace, "轮询地址替换", `${why}，改用提交响应给的查询地址：${altPoll}`, vars.apiKey);
      onProgress?.("轮询地址似乎不对，已改用服务商返回的查询地址…");
      return true;
    };

    onProgress?.("任务已提交，生成中…");
    traceAdd(trace, "轮询请求", `${pollCfg.method ?? "GET"} ${render(pollCfg.url, vars)}`, vars.apiKey);
    let pollSlot = -1;
    const kind = proto.role === "video" ? "video" : "image";
    const deadline = Date.now() + 10 * 60_000;
    let consecFail = 0;
    let blankStatus = 0; // 连续多少轮既读不到状态也没有结果（多半是轮询地址错但返回 200）
    for (let i = 0; ; i++) {
      await sleep(pollCfg.intervalMs ?? 3000);
      if (Date.now() > deadline) throw new Error(`轮询超时（10 分钟），任务 ID：${taskId}`);
      let pj: any;
      try {
        pj = await customFetch(pollCfg, vars);
        consecFail = 0;
      } catch (e) {
        // 单次查询失败不掐死任务（网络抖动/临时 5xx）：先试着换 status_url，连续多次才报错
        traceAdd(trace, "轮询请求失败", e instanceof Error ? e.message : String(e), vars.apiKey);
        if (switchToAlt("协议里的轮询地址请求失败")) {
          consecFail = 0;
          continue;
        }
        if (++consecFail >= 5) throw e;
        continue;
      }
      // 现场只保留最近一次轮询响应（避免长任务把现场撑爆）
      if (trace) {
        const raw = JSON.stringify(pj);
        const entry = `【最近轮询响应】${(vars.apiKey ? raw.split(vars.apiKey).join("***") : raw).slice(0, 600)}`;
        if (pollSlot < 0) pollSlot = trace.push(entry) - 1;
        else trace[pollSlot] = entry;
      }
      const status = readStatus(pj, pollCfg.statusPath);
      const sl = status.toLowerCase();
      if ((pollCfg.failValue && status === pollCfg.failValue) || FAIL_SET.includes(sl))
        throw new Error(`任务失败（状态 ${status || "未知"}）。响应：${JSON.stringify(pj).slice(0, 250)}`);
      // 完成判定三重兜底：协议指定值 → 常见完成取值 → 结果字段已经出现
      if (status === pollCfg.doneValue || DONE_SET.includes(sl) || extractResultStrings(pj, proto.resultPath, kind).length) {
        final = pj;
        break;
      }
      // 返回 200 却连续多轮读不到任何状态：多半在轮询一个错误地址 → 切到服务商给的 status_url
      if (!status && ++blankStatus >= 4 && switchToAlt("连续多轮查不到任务状态")) {
        blankStatus = 0;
        continue;
      }
      if (status) blankStatus = 0;
      const sec = Math.round(((i + 1) * (pollCfg.intervalMs ?? 3000)) / 1000);
      onProgress?.(`生成中…（状态 ${status || "等待中"} · 已等待 ${Math.floor(sec / 60)}分${sec % 60}秒）`);
    }
  }
  return final;
}

/** 从卡片协议标识（custom:<id>）解析出协议配置，并校验用途匹配 */
export async function resolveCustomProto(protocolId: string, wantRole: "image" | "video"): Promise<CustomProtocol> {
  const { useSettings } = await import("../stores/settingsStore");
  const id = protocolId.slice("custom:".length);
  const proto = useSettings.getState().settings.customProtocols.find((p) => p.id === id);
  if (!proto) throw new Error(`自定义协议不存在（${id}），请到「设置 → 协议」检查`);
  const role = proto.role === "video" ? "video" : "image";
  if (role !== wantRole) {
    const cur = role === "video" ? "视频" : "图片";
    const want = wantRole === "video" ? "视频" : "图片";
    throw new Error(
      `协议「${proto.name}」的用途是「${cur}生成」，不能用于${want}槽位。请到「设置 → 协议」编辑该协议并把用途改为「${want}生成」，或换一个协议`,
    );
  }
  return proto;
}
