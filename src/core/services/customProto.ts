/**
 * 生成协议模板执行器（预设协议运行时）— 模板渲染 + 提交 + 可选异步轮询 + JSON 路径取值
 * （协议来源见 core/protoPresets.ts；图片/视频/音频服务共用）
 */
import type { CustomProtocol } from "../types";
import { xfetch } from "./http";
import { normalizeImageResult } from "./imageResult";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const done = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(t);
      done();
      rej(new Error("已取消"));
    };
    const t = setTimeout(() => {
      done();
      res();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });

/** 简易 JSON 路径："data.url" / "data[].url" / "output[]" / "data[0].url"（[] 展开数组，[n] 取下标） */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function jsonPath(obj: any, path: string): any[] {
  // 路径缺失时直接返回空（协议里 statusPath 漏填会一路把 undefined 传进来，
  // 老代码在这里 path.split 直接抛原生 TypeError 掐死整个任务）
  if (!path || typeof path !== "string") return [];
  let cur: any[] = [obj];
  for (const seg of path.split(".").filter(Boolean)) {
    const m = seg.match(/^(.*?)\[(\d*)\]$/);
    const key = m ? m[1] : seg;
    const spread = !!m && m[2] === "";
    const idx = m && m[2] !== "" ? Number(m[2]) : -1;
    const next: any[] = [];
    for (const c of cur) {
      const v = key ? c?.[key] : c;
      if (v === undefined || v === null) continue;
      if (spread && Array.isArray(v)) next.push(...v);
      else if (idx >= 0 && Array.isArray(v)) {
        if (v[idx] !== undefined && v[idx] !== null) next.push(v[idx]);
      } else next.push(v);
    }
    cur = next;
  }
  return cur;
}

/** 相对地址补成绝对地址（中转站结果直链常给 /files/xx.png 或 //cdn.xx/xx.png） */
export function absolutize(s: string, baseUrl: string): string {
  if (/^(https?:|data:|blob:)/i.test(s)) return s;
  if (s.startsWith("//")) return `https:${s}`;
  if (!baseUrl) return s;
  try {
    return new URL(s, `${baseUrl.replace(/\/+$/, "")}/`).toString();
  } catch {
    return s;
  }
}

/** 变量是否为空（"" 或 "[]" 都算空 —— {{images}} 无参考图时是空数组字面量） */
function isBlank(v: string | undefined): boolean {
  return !v || v === "[]";
}

/** 模板渲染：先处理条件块，再做占位符替换
 *  {{?var}}…{{/var}} 变量非空时保留块内容；{{^var}}…{{/var}} 变量为空时保留（else 分支）
 *  典型用法：URL 按有无参考图切换端点、body 里蒙版/图片字段按需出现 */
export function render(tpl: string, vars: Record<string, string>): string {
  // 对话模型常把 body 写成对象而不是字符串模板：这里换成中文提示，别让原生 TypeError 糊到用户脸上
  if (typeof tpl !== "string")
    throw new Error(
      `协议模板字段不是字符串（收到 ${Array.isArray(tpl) ? "数组" : typeof tpl}）。submit.body 必须是 JSON 字符串模板，而不是嵌套对象`,
    );
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
  // 二进制响应（TTS 最常见的形态就是直接回一段 audio/mpeg 流）：包成 { __binary: dataURL } 交给下游，
  // 不能再无条件 JSON.parse —— 否则任何这类接口都会以「响应不是 JSON：ID3…」死在第一步
  const ct = (resp.headers?.get?.("content-type") ?? "").toLowerCase();
  if (resp.ok && ct && !/json|text|xml|html|javascript/.test(ct)) {
    const blob = await resp.blob();
    if (blob.size < 64) throw new Error(`请求成功但返回内容为空（${ct}）`);
    return { __binary: await blobToDataUrl(blob, ct) };
  }
  const text = await resp.text();
  if (!resp.ok) throw new Error(`请求失败 ${resp.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`响应不是 JSON：${text.slice(0, 200)}`);
  }
}

/** blob → dataURL（二进制响应统一转成 dataURL，与其它结果形态一致） */
function blobToDataUrl(blob: Blob, mime: string): Promise<string> {
  const b = blob.type ? blob : new Blob([blob], { type: mime.split(";")[0] || "application/octet-stream" });
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(new Error("二进制响应读取失败"));
    r.readAsDataURL(b);
  });
}

/* ---------------- 宽容轮询 ----------------
   协议助手生成的 statusPath / doneValue / resultPath 常与中转站实际响应有出入，
   这里做多重兜底：状态字段按常见路径再找、完成/失败按常见取值识别、结果字段出现即视为完成 */

export const DONE_SET = ["succeeded", "success", "succeed", "completed", "complete", "done", "finished"];
export const FAIL_SET = ["failed", "fail", "error", "canceled", "cancelled", "timeout"];
/** 明确表示「还在跑」的状态：此时哪怕响应里出现了 url 字段也不能判完成（多半是任务自链接） */
export const PENDING_SET = [
  "pending", "processing", "running", "queued", "queueing", "queuing", "in_queue", "inqueue",
  "in_progress", "inprogress", "starting", "waiting", "submitted", "created", "not_start", "notstart",
];
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
const AUD_PATHS = [
  "data[].audio_url", "data.audio_url", "audio_url", "data[].url", "data.url",
  "data.audio", "audio", "result.audio_url", "data.result.audio_url", "output[].url", "url",
];

/** 补轮询配置时继承提交请求的鉴权头（去掉 Content-Type，GET 不需要） */
export function inheritAuthHeaders(submitHeaders?: Record<string, string>): Record<string, string> {
  const src = Object.entries(submitHeaders ?? {}).filter(([k]) => !/^content-type$/i.test(k));
  if (!src.length) return { Authorization: "Bearer {{apiKey}}" };
  return Object.fromEntries(src);
}

/** 协议用途 → 结果媒体类型 */
export function roleKind(role: string | undefined): "image" | "video" | "audio" {
  return role === "video" ? "video" : role === "audio" ? "audio" : "image";
}

/** 先按协议的 statusPath 取状态，取不到再按常见路径兜底 */
function readStatus(pj: any, primary: string): string {
  for (const p of [primary, ...STATUS_PATHS]) {
    const v = jsonPath(pj, p)[0];
    if (v !== undefined && v !== null && String(v) !== "") return String(v);
  }
  return "";
}

/** 结果串看起来像"产物"而不是任务自链接（兜底完成判定用，避免把 status_url 当成图） */
export function looksLikeAsset(s: string): boolean {
  if (s.startsWith("data:") || s.startsWith("blob:")) return true;
  if (s.length > 200) return true; // base64
  if (!/^https?:\/\//i.test(s)) return false;
  const path = s.split("?")[0].toLowerCase();
  if (/\.(png|jpe?g|webp|gif|bmp|avif|mp4|webm|mov|m4v|mp3|wav|m4a|aac|flac|ogg)$/.test(path)) return true;
  // 无扩展名的签名直链很常见，只排除明显的任务查询/回调地址
  return !/(status|progress|cancel|callback|webhook|\/query|\/task|\/tasks|\/jobs?)\b/.test(path);
}

/** 按协议 resultPath 取结果字符串；未命中时按常见字段兜底 */
export function extractResultStrings(final: any, primary: string, kind: "image" | "video" | "audio"): string[] {
  // 二进制响应（customFetch 已转成 dataURL）：结果就是它本身，不必走路径
  if (final && typeof final === "object" && typeof final.__binary === "string") return [final.__binary];
  const tryPath = (p: string) =>
    jsonPath(final, p)
      .map((v) => {
        if (typeof v !== "string") return "";
        // 字段已明确声明为编码，不把未知图片格式的 Base64 当成相对路径。
        if (kind === "image" && /b64|base64/i.test(p) && !/^(data:|https?:|blob:)/i.test(v.trim())) {
          const image = normalizeImageResult(v, "");
          return image.startsWith("data:") ? image : `data:image/png;base64,${v.replace(/\s/g, "")}`;
        }
        return v;
      })
      .filter((s) => s.length > 4);
  const hit = tryPath(primary);
  if (hit.length) return hit;
  for (const p of kind === "video" ? VID_PATHS : kind === "audio" ? AUD_PATHS : IMG_PATHS) {
    if (p === primary) continue;
    const out = tryPath(p);
    if (out.length) {
      console.warn(`[customProto] resultPath「${primary}」未命中，已兜底使用「${p}」`);
      return out;
    }
  }
  return [];
}

/** 完整执行提交（+ 异步轮询）流程，返回包含结果的最终响应 JSON */
export async function runCustomFlow(
  proto: CustomProtocol,
  vars: Record<string, string>,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<any> {
  let final = await customFetch(proto.submit, vars, signal);
  if (proto.taskIdPath) {
    let taskId = String(jsonPath(final, proto.taskIdPath)[0] ?? "");
    if (!taskId) {
      // 协议里的路径没取到 → 按常见任务 id 字段名兜底再试一轮
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
    if (!taskId && extractResultStrings(final, proto.resultPath, roleKind(proto.role)).length) {
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
      // 鉴权沿用 submit 已配好的那套：写死 Bearer 会让 X-API-Key / Token 风格的站点在轮询时必 401
      proto = { ...proto, poll: { url: altPoll, method: "GET", headers: inheritAuthHeaders(proto.submit.headers), intervalMs: 3000, statusPath: "status", doneValue: "completed" } };
      console.info(`[customProto] 协议缺少 poll，已按提交响应的 status_url 轮询：${altPoll}`);
    }
    const pollCfg = { ...proto.poll! };
    let switched = false;
    const switchToAlt = (why: string): boolean => {
      if (!altPoll || switched || render(pollCfg.url, vars) === altPoll) return false;
      switched = true;
      pollCfg.url = altPoll;
      pollCfg.method = "GET";
      delete pollCfg.body;
      console.info(`[customProto] ${why}，改用提交响应给的查询地址：${altPoll}`);
      onProgress?.("轮询地址似乎不对，已改用服务商返回的查询地址…");
      return true;
    };

    onProgress?.("任务已提交，生成中…");
    const kind = roleKind(proto.role);
    // 超时按用途区分：视频（尤其长片/高分辨率）排队 + 生成经常超过 10 分钟，
    // 用一刀切的 10 分钟会在任务还在跑的时候误报超时
    const deadline = Date.now() + (kind === "video" ? 30 : 10) * 60_000;
    let consecFail = 0;
    let blankStatus = 0; // 连续多少轮既读不到状态也没有结果（多半是轮询地址错但返回 200）
    // 间隔钳制：intervalMs:100 会每分钟打 600 次查询（直接吃 429），过大则一次都发不出去
    const interval = Math.min(30_000, Math.max(1000, Math.round(Number(pollCfg.intervalMs) || 3000)));
    for (let i = 0; ; i++) {
      await sleep(interval, signal);
      if (signal?.aborted) throw new Error("已取消");
      if (Date.now() > deadline)
        throw new Error(`轮询超时（${kind === "video" ? 30 : 10} 分钟），任务 ID：${taskId}`);
      let pj: any;
      try {
        pj = await customFetch(pollCfg, vars, signal);
        consecFail = 0;
      } catch (e) {
        // 单次查询失败不掐死任务（网络抖动/临时 5xx/请求超时）：先试着换 status_url，连续多次才报错
        console.warn(`[customProto] 轮询请求失败：${e instanceof Error ? e.message : String(e)}`);
        if (switchToAlt("协议里的轮询地址请求失败")) {
          consecFail = 0;
          continue;
        }
        if (++consecFail >= 5) throw e;
        continue;
      }
      const status = readStatus(pj, pollCfg.statusPath);
      const sl = status.toLowerCase();
      if ((pollCfg.failValue && status === pollCfg.failValue) || FAIL_SET.includes(sl))
        throw new Error(`任务失败（状态 ${status || "未知"}）。响应：${JSON.stringify(pj).slice(0, 250)}`);
      // 完成判定三重兜底：协议指定值 → 常见完成取值 → 结果字段已经出现。
      // 第三重要收紧：状态明确还在跑时，响应里的 url 多半是任务自链接/回调地址，
      // 认成结果会导致「拿一份没出图的响应去取图」——白等 + 白扣费
      const resHit = extractResultStrings(pj, proto.resultPath, kind);
      const resSignal = resHit.length && (!PENDING_SET.includes(sl) || resHit.some(looksLikeAsset));
      if (status === pollCfg.doneValue || DONE_SET.includes(sl) || resSignal) {
        final = pj;
        break;
      }
      // 返回 200 却连续多轮读不到任何状态：多半在轮询一个错误地址 → 切到服务商给的 status_url
      if (!status && ++blankStatus >= 4 && switchToAlt("连续多轮查不到任务状态")) {
        blankStatus = 0;
        continue;
      }
      if (status) blankStatus = 0;
      const sec = Math.round(((i + 1) * interval) / 1000);
      onProgress?.(`生成中…（状态 ${status || "等待中"} · 已等待 ${Math.floor(sec / 60)}分${sec % 60}秒）`);
    }
  }
  return final;
}

/** 从卡片协议标识（custom:<id>）解析出协议配置，并校验用途匹配 */
export async function resolveCustomProto(protocolId: string, wantRole: "image" | "video" | "audio"): Promise<CustomProtocol> {
  const { useSettings } = await import("../stores/settingsStore");
  const id = protocolId.slice("custom:".length);
  const proto = useSettings.getState().settings.customProtocols.find((p) => p.id === id);
  if (!proto) throw new Error(`协议不存在（${id}）——该服务商绑定的协议可能已被清理，请到「设置 → 模型配置」重新选择协议`);
  const role = roleKind(proto.role);
  if (role !== wantRole) {
    const LAB = { image: "图片", video: "视频", audio: "音频" } as const;
    throw new Error(
      `协议「${proto.name}」的用途是「${LAB[role]}生成」，不能用于${LAB[wantRole]}槽位。请到「设置 → 模型配置」为该槽位换用「${LAB[wantRole]}生成」用途的协议`,
    );
  }
  return proto;
}
