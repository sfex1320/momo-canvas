/**
 * 自定义协议「测试并自动校准」— 用真实请求把协议从"猜"变成"量"：
 *  真发一次提交（+轮询），在真实响应 JSON 里机械定位任务 ID / 状态字段 / 结果字段的实际位置，
 *  把协议里写错的路径与取值改成实测值。测试会真实调用服务商接口（生成类接口会扣费）。
 */
import type { CustomProtocol } from "../types";
import { trimBase } from "./http";
import { DONE_SET, FAIL_SET, customFetch, extractResultStrings, jsonPath, render } from "./customProto";

/* eslint-disable @typescript-eslint/no-explicit-any */

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      rej(new Error("已手动停止测试"));
    });
  });

type Found = { path: string; value: unknown };

/** 广度优先在 JSON 里找第一个命中谓词的字段，返回 jsonPath 语法路径（浅层优先；数组按首元素同构展开为 []） */
function bfsFind(obj: any, pred: (key: string, value: any) => boolean, maxDepth = 6): Found | null {
  type Item = { node: any; path: string[]; depth: number };
  const queue: Item[] = [{ node: obj, path: [], depth: 0 }];
  while (queue.length) {
    const { node, path, depth } = queue.shift()!;
    if (depth > maxDepth || node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      if (!node.length) continue;
      const marked = path.length ? [...path.slice(0, -1), `${path[path.length - 1]}[]`] : ["[]"];
      const first = node[0];
      if (first !== null && typeof first === "object") {
        queue.push({ node: first, path: marked, depth: depth + 1 });
      } else {
        // 基础类型数组（如 "url": ["https://…"]）：用数组自身的键名对首元素做判定
        const selfKey = (path[path.length - 1] ?? "").replace(/\[\]$/, "");
        if (pred(selfKey, first)) return { path: marked.join("."), value: first };
      }
      continue;
    }
    for (const [k, v] of Object.entries(node)) {
      if (pred(k, v)) return { path: [...path, k].join("."), value: v };
      if (v && typeof v === "object") queue.push({ node: v, path: [...path, k], depth: depth + 1 });
    }
  }
  return null;
}

/** 定位任务 ID：先按明确字段名，再退回泛化的 id */
function findTaskId(j: any): Found | null {
  const strict = ["task_id", "taskid", "job_id", "jobid", "request_id", "requestid"];
  const ok = (v: any) => (typeof v === "string" && v !== "") || typeof v === "number";
  return (
    bfsFind(j, (k, v) => strict.includes(k.toLowerCase()) && ok(v)) ??
    bfsFind(j, (k, v) => k.toLowerCase() === "id" && ok(v))
  );
}

/** 定位状态字段 */
function findStatus(j: any): Found | null {
  const keys = ["status", "task_status", "state"];
  return bfsFind(j, (k, v) => keys.includes(k.toLowerCase()) && typeof v === "string" && v !== "");
}

/** 定位提交响应里的轮询地址（status_url 风格） */
function findStatusUrl(j: any): Found | null {
  const keys = ["status_url", "statusurl", "task_url", "query_url"];
  return bfsFind(j, (k, v) => keys.includes(k.toLowerCase()) && typeof v === "string" && v !== "");
}

/** 定位结果字段：先找键名像 url/image/video/b64 的资源串，再退回任意资源串 */
function findResult(j: any): Found | null {
  const looksRes = (v: any) =>
    typeof v === "string" && (v.startsWith("http") || v.startsWith("data:image") || v.startsWith("data:video") || v.length > 500);
  return (
    bfsFind(j, (k, v) => /url|image|video|b64|mp4/i.test(k) && looksRes(v)) ??
    bfsFind(j, (_k, v) => looksRes(v))
  );
}

/** 生成一张 512×512 的测试图（图生图/图生视频模板的 {{image}} 占位用） */
export function makeTestImage(): string {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 512, 512);
  g.addColorStop(0, "#7ea2ff");
  g.addColorStop(1, "#b98bff");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 44px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("momo test", 256, 268);
  return c.toDataURL("image/jpeg", 0.85);
}

export type CalibrateCtx = { baseUrl: string; apiKey: string; model: string };

/**
 * 校准主流程：真实执行 提交 →（定位任务 ID → 轮询）→ 定位结果，
 * 把协议里与实测不符的 taskIdPath / poll.url / statusPath / doneValue / resultPath 全部改成实测值。
 */
export async function calibrateProtocol(
  input: CustomProtocol,
  ctx: CalibrateCtx,
  onLog: (msg: string) => void,
  signal?: AbortSignal,
): Promise<{ proto: CustomProtocol; results: string[] }> {
  const bail = () => {
    if (signal?.aborted) throw new Error("已手动停止测试（提交请求已发出的费用不退，任务仍会在服务商后台完成）");
  };
  const proto: CustomProtocol = JSON.parse(JSON.stringify(input));
  const kind = proto.role === "video" ? "video" : proto.role === "audio" ? "audio" : "image";
  const base = trimBase(ctx.baseUrl);
  const vars: Record<string, string> = {
    baseUrl: base,
    apiKey: ctx.apiKey,
    model: ctx.model,
    prompt:
      kind === "video"
        ? "测试：一只橘猫缓缓转头，简洁卡通风格"
        : kind === "audio"
          ? "测试：你好，这是一次语音合成测试。"
          : "测试：一只可爱的橘猫，简洁卡通风格",
    voice: proto.submit.body?.includes("{{voice}}") ? "alloy" : "",
    size: "1024x1024",
    n: "1",
    taskId: "",
    image: proto.submit.body?.includes("{{image}}") || proto.poll?.body?.includes("{{image}}") ? makeTestImage() : "",
    image2: proto.submit.body?.includes("{{image2}}") ? makeTestImage() : "",
    images: proto.submit.body?.includes("{{images}}") ? JSON.stringify([makeTestImage()]) : "[]",
    mask: proto.submit.body?.includes("{{mask}}") ? makeTestImage() : "",
    // 视频家族参数：校准时给一组便宜的最小值（时长最短、分辨率最低）
    duration: kind === "video" ? "5" : "",
    resolution: kind === "video" ? "480p" : "",
    aspect: kind === "video" ? "16:9" : "",
    audio: kind === "video" ? "false" : "",
  };

  onLog(`① 发送提交请求：${render(proto.submit.url, vars)}`);
  const submitJ = await customFetch(proto.submit, vars, signal);
  onLog(`✓ 提交成功，响应：${JSON.stringify(submitJ).slice(0, 220)}`);

  let final: any = submitJ;
  const syncHit = findResult(submitJ);

  if (syncHit) {
    // 提交即出结果 → 同步接口
    if (proto.taskIdPath || proto.poll) {
      onLog("✓ 检测到提交响应里已含结果 → 判定为同步接口，移除轮询配置");
      delete proto.taskIdPath;
      delete proto.poll;
    }
  } else {
    // 异步：定位任务 ID
    const t = findTaskId(submitJ);
    if (!t) throw new Error(`提交响应里既没有结果字段也找不到任务 ID，无法继续。响应：${JSON.stringify(submitJ).slice(0, 250)}`);
    if (proto.taskIdPath !== t.path) {
      onLog(`✓ 校准 taskIdPath：「${proto.taskIdPath ?? "（未配置）"}」→「${t.path}」（实测值 ${String(t.value).slice(0, 40)}）`);
      proto.taskIdPath = t.path;
    } else {
      onLog(`✓ taskIdPath 与实测一致（${t.path}）`);
    }
    vars.taskId = String(t.value);

    // 提交响应若自带轮询地址，作为轮询失败时的替补
    const su = findStatusUrl(submitJ);
    let suTpl: string | null = null;
    if (su) {
      const abs = String(su.value).startsWith("http") ? String(su.value) : new URL(String(su.value), `${base}/`).toString();
      suTpl = abs.split(vars.taskId).join("{{taskId}}");
      if (suTpl.startsWith(base)) suTpl = `{{baseUrl}}${suTpl.slice(base.length)}`;
    }
    if (!proto.poll) {
      if (!suTpl) throw new Error("接口是异步的，但协议没有 poll 配置、提交响应也没给轮询地址，无法校准");
      onLog(`✓ 协议缺少 poll 配置，按提交响应的 status_url 补全：${suTpl}`);
      proto.poll = { url: suTpl, method: "GET", headers: { Authorization: "Bearer {{apiKey}}" }, intervalMs: 3000, statusPath: "status", doneValue: "succeeded", failValue: "failed" };
    }

    onLog(`② 开始轮询：${render(proto.poll.url, vars)}`);
    const deadline = Date.now() + 10 * 60_000;
    let switched = false;
    let statusFound: Found | null = null;
    for (let i = 0; ; i++) {
      await sleep(proto.poll.intervalMs ?? 3000, signal);
      bail();
      if (Date.now() > deadline) throw new Error("轮询超时（10 分钟）：任务可能仍在生成，也可能状态接口不对");
      let pj: any;
      try {
        pj = await customFetch(proto.poll, vars, signal);
      } catch (e) {
        bail();
        if (suTpl && proto.poll.url !== suTpl && !switched) {
          // 协议里的轮询地址打不通 → 换成提交响应自带的 status_url 再试
          onLog(`✗ 轮询地址请求失败，改用提交响应给的地址：${suTpl}`);
          proto.poll.url = suTpl;
          switched = true;
          continue;
        }
        throw e;
      }
      statusFound = findStatus(pj);
      const st = String(statusFound?.value ?? "");
      if ((proto.poll.failValue && st === proto.poll.failValue) || FAIL_SET.includes(st.toLowerCase()))
        throw new Error(`任务失败（状态 ${st}）。响应：${JSON.stringify(pj).slice(0, 250)}`);
      const done = findResult(pj) || DONE_SET.includes(st.toLowerCase()) || st === proto.poll.doneValue;
      if (done) {
        final = pj;
        // 校准状态字段与完成取值（以实测为准）
        if (statusFound) {
          if (proto.poll.statusPath !== statusFound.path) {
            onLog(`✓ 校准 statusPath：「${proto.poll.statusPath}」→「${statusFound.path}」`);
            proto.poll.statusPath = statusFound.path;
          }
          if (st && proto.poll.doneValue !== st) {
            onLog(`✓ 校准 doneValue：「${proto.poll.doneValue}」→「${st}」（完成时的实测状态）`);
            proto.poll.doneValue = st;
          }
        } else {
          onLog("△ 轮询响应里没有状态字段：完成判定依赖结果字段出现（执行器已支持，无需修改）");
        }
        break;
      }
      if (i % 5 === 0) onLog(`… 轮询中（状态 ${st || "未知"}）`);
    }
  }

  // 校准结果路径：协议路径在最终响应上取不到时，改成实测位置
  const primaryHit = jsonPath(final, proto.resultPath)
    .map((v) => (typeof v === "string" ? v : ""))
    .filter((s) => s.length > 4);
  if (!primaryHit.length) {
    const r = findResult(final);
    if (!r)
      throw new Error(
        `最终响应里找不到结果字段。可对照上方响应 JSON，把 resultPath 手工改成结果所在路径（数组层级加 []，如 data.result.images[].url[]）后再测；或到报错中心用「AI 分析」帮你定位。响应：${JSON.stringify(final).slice(0, 250)}`,
      );
    onLog(`✓ 校准 resultPath：「${proto.resultPath}」→「${r.path}」`);
    proto.resultPath = r.path;
  } else {
    onLog(`✓ resultPath 与实测一致（${proto.resultPath}）`);
  }
  const results = extractResultStrings(final, proto.resultPath, kind);
  onLog(`③ 测试通过：取到 ${results.length} 个结果，首个：${results[0]?.slice(0, 80)}…`);
  return { proto, results };
}
