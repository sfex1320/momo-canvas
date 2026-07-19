/**
 * ComfyUI 服务 — HTTP REST 直连
 *  探活 /system_stats · 提交 /prompt · 轮询 /history/{id} · 取图 /view · 传图 /upload/image
 *  进度：/ws WebSocket 实时节点级进度（连不上时静默退回轮询文案）
 */
import type { ComfyExposedParam, ComfyParamKind, ComfyTemplate, ComfyWfNode } from "../types";
import { xfetch, trimBase, readErrorBody } from "./http";
import { dataUrlToBlob, toDataUrl, uid } from "../utils";

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

const isConnection = (v: unknown): v is [string, number] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === "string";

export const isImageLoaderClass = (ct: string) => /loadimage/i.test(ct);
export const isOutputClass = (ct: string) => /saveimage|previewimage|save|preview/i.test(ct);

function guessKind(node: ComfyWfNode, input: string, value: unknown): ComfyParamKind {
  const name = input.toLowerCase();
  if (isImageLoaderClass(node.class_type) && name === "image") return "image";
  if (name.includes("seed")) return "seed";
  if (typeof value === "boolean") return "toggle";
  if (typeof value === "number") return "number";
  return "text";
}

/* ---------------- 能力识别 / 忽略节点 ---------------- */

export type WfTextEntry = { nodeId: string; input: string; negative: boolean };

export type WfCaps = {
  /** 图片入口：LoadImage 类节点 id（数字序） */
  imageEntries: string[];
  /** 提示词入口：带文本控件的节点（negative = 被接到负面条件上） */
  textEntries: WfTextEntry[];
  /** 输出候选：保存/预览类节点 */
  outputs: string[];
};

/** 识别工作流的图片/提示词入口与输出候选 */
export function analyzeCaps(wf: Record<string, ComfyWfNode>): WfCaps {
  const ids = Object.keys(wf).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  const imageEntries = ids.filter((id) => isImageLoaderClass(wf[id].class_type));
  const outputs = ids.filter((id) => isOutputClass(wf[id].class_type));

  const negativeSet = new Set<string>();
  for (const n of Object.values(wf)) {
    for (const [input, v] of Object.entries(n.inputs ?? {})) {
      if (isConnection(v) && /negative/i.test(input)) negativeSet.add(v[0]);
    }
  }

  const textEntries: WfTextEntry[] = [];
  for (const id of ids) {
    const n = wf[id];
    for (const [input, v] of Object.entries(n.inputs ?? {})) {
      if (isConnection(v) || typeof v !== "string") continue;
      const looksText =
        (n.class_type === "CLIPTextEncode" && input === "text") ||
        ["text", "prompt", "caption", "positive_prompt", "negative_prompt"].includes(input.toLowerCase());
      if (!looksText) continue;
      const negative =
        negativeSet.has(id) || /negative|负面/i.test(n._meta?.title ?? "") || /negative/i.test(input);
      textEntries.push({ nodeId: id, input, negative });
    }
  }
  textEntries.sort((a, b) => Number(a.negative) - Number(b.negative) || Number(a.nodeId) - Number(b.nodeId));
  return { imageEntries, textEntries, outputs };
}

/** 有没有别的节点引用它（作为连线来源） */
export function hasDownstream(wf: Record<string, ComfyWfNode>, nodeId: string): boolean {
  return Object.values(wf).some((n) => Object.values(n.inputs ?? {}).some((v) => isConnection(v) && v[0] === nodeId));
}

/** 该节点第一个「连线输入」——跨接时下游改用这个来源 */
export function firstConnInput(node: ComfyWfNode): [string, number] | null {
  for (const v of Object.values(node.inputs ?? {})) if (isConnection(v)) return v;
  return null;
}

/** 能否安全忽略：末端节点随时可以；中间节点要有连线输入可跨接 */
export function canDisable(wf: Record<string, ComfyWfNode>, nodeId: string): { ok: boolean; why?: string } {
  if (!hasDownstream(wf, nodeId)) return { ok: true };
  if (firstConnInput(wf[nodeId])) return { ok: true, why: "中间节点：忽略后下游自动改接它的上游" };
  return { ok: false, why: "该节点被下游引用、又没有可跨接的上游输入，忽略会使工作流断链" };
}

/** 剔除被忽略的节点：引用它的输入改接其第一个上游（链式解析），无法跨接则删除该输入 */
export function pruneDisabled(
  wf: Record<string, ComfyWfNode>,
  disabled: string[] | undefined,
): Record<string, ComfyWfNode> {
  const off = new Set((disabled ?? []).filter((id) => wf[id]));
  if (!off.size) return wf;
  // 每个被忽略节点的跨接来源（顺着链条找到第一个未被忽略的上游）
  const resolve = (id: string): [string, number] | null => {
    let cur: [string, number] | null = [id, 0];
    for (let i = 0; i < 20 && cur; i++) {
      if (!off.has(cur[0])) return cur;
      cur = firstConnInput(wf[cur[0]]);
    }
    return null;
  };
  const out: Record<string, ComfyWfNode> = {};
  for (const [id, node] of Object.entries(wf)) {
    if (off.has(id)) continue;
    const inputs: Record<string, unknown> = {};
    for (const [input, v] of Object.entries(node.inputs ?? {})) {
      if (isConnection(v) && off.has(v[0])) {
        const src = resolve(v[0]);
        if (src) inputs[input] = [src[0], src[1]];
        // 无法跨接 → 丢弃该输入，交给提交前校验给出中文提示
      } else inputs[input] = v;
    }
    out[id] = { ...node, inputs };
  }
  return out;
}

/* ---------------- object_info（节点类型说明书，用于提交前校验） ---------------- */

const objectInfoCache = new Map<string, Promise<Record<string, any> | null>>();

/** 拉取并缓存 /object_info；失败返回 null（不阻断运行） */
export function fetchObjectInfo(host: string): Promise<Record<string, any> | null> {
  const base = normalizeHost(host);
  let p = objectInfoCache.get(base);
  if (!p) {
    p = xfetch(`${base}/object_info`)
      .then((r) => (r.ok ? (r.json() as Promise<Record<string, any>>) : null))
      .catch(() => null);
    objectInfoCache.set(base, p);
    // 失败的不缓存，下次重试
    void p.then((v) => {
      if (!v) objectInfoCache.delete(base);
    });
  }
  return p;
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

export const isVideoLoaderClass = (ct: string) => /loadvideo/i.test(ct);

/** 上传视频到 ComfyUI 的 input 目录（/upload/image 接口对任意文件通用） */
export async function uploadVideoToComfy(host: string, src: string): Promise<string> {
  const blob = src.startsWith("data:") ? dataUrlToBlob(src) : await (await xfetch(src)).blob();
  const ext = /webm/.test(blob.type) ? "webm" : /quicktime|mov/.test(blob.type) ? "mov" : "mp4";
  const fd = new FormData();
  fd.append("image", blob, `momo_${uid(6)}.${ext}`);
  fd.append("overwrite", "true");
  const resp = await xfetch(`${normalizeHost(host)}/upload/image`, { method: "POST", body: fd });
  if (!resp.ok) throw new Error(`上传视频到 ComfyUI 失败 ${resp.status}: ${await readErrorBody(resp)}`);
  const j = await resp.json();
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

/** images 已回传为 dataURL（显示/下游/资产收录全链路统一）；texts 为 ShowText 等文本输出；videos 为 VHS 合成等视频输出（blob URL） */
export type ComfyRunResult = { images: string[]; texts: string[]; videos: string[] };

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
  opts: {
    onProgress?: (msg: string, pct?: number) => void;
    signal?: AbortSignal;
    /** 上游图片（dataURL）：自动喂给图片参数 → LoadImage 节点 → 缺失的必填图片输入 */
    upstreamImages?: string[];
    /** 上游文本：模板没有文本参数时自动填入正面提示词入口 */
    upstreamTexts?: string[];
    /** 上游视频：自动上传并喂给 LoadVideo 类节点（SeedVR2 放大等视频工作流） */
    upstreamVideos?: string[];
  } = {},
): Promise<ComfyRunResult> {
  const base = normalizeHost(host);
  if (!base) throw new Error("请先在「设置 → ComfyUI」中填写服务地址");

  // 1. 深拷贝 + 剔除被忽略的节点，然后写入参数值
  const wf: Record<string, ComfyWfNode> = pruneDisabled(
    JSON.parse(JSON.stringify(tpl.workflow)),
    tpl.disabledNodes,
  );
  const nodeTitle = (nid: string) => {
    const n = wf[nid];
    return n ? n._meta?.title ?? n.class_type : nid;
  };

  const imgQueue = [...(opts.upstreamImages ?? [])];
  let imagesUsed = 0;
  let lastImageSrc: string | undefined;
  const uploadCache = new Map<string, string>();
  const ensureUploaded = async (dataUrl: string): Promise<string> => {
    lastImageSrc = dataUrl;
    let name = uploadCache.get(dataUrl);
    if (!name) {
      opts.onProgress?.(`上传图片到 ComfyUI…`);
      name = await uploadImageToComfy(host, dataUrl);
      uploadCache.set(dataUrl, name);
    }
    imagesUsed++;
    return name;
  };

  const imageParamNodes = new Set<string>(); // 已由图片参数占用的节点
  let hasTextParam = false;
  let firstTextFilled = false;
  for (const p of tpl.params) {
    const node = wf[p.nodeId];
    if (!node) continue; // 节点被忽略/不存在
    const own = paramValues[p.key];
    if (p.kind === "image") {
      imageParamNodes.add(p.nodeId);
      let v = own !== undefined && own !== "" ? own : undefined;
      if (typeof v === "string" && v.startsWith("data:")) v = await ensureUploaded(v);
      else if (v === undefined && imgQueue.length) v = await ensureUploaded(imgQueue.shift()!);
      if (v === undefined) throw new Error(`图片参数「${p.label}」缺少输入：请连接上游图片节点`);
      node.inputs[p.input] = v;
      continue;
    }
    if (p.kind === "text") {
      hasTextParam = true;
      const empty = own === undefined || own === "";
      if (empty && !firstTextFilled && opts.upstreamTexts?.length) {
        node.inputs[p.input] = opts.upstreamTexts.join("\n");
        firstTextFilled = true;
        continue;
      }
    }
    const v = own !== undefined ? own : p.value;
    node.inputs[p.input] = p.kind === "number" || p.kind === "seed" ? Number(v) : v;
  }

  // 2a. 剩余上游图片 → 未被参数占用的 LoadImage 节点（按编号顺序）
  if (imgQueue.length) {
    const loaders = Object.keys(wf)
      .filter((id) => isImageLoaderClass(wf[id].class_type) && !imageParamNodes.has(id))
      .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    for (const id of loaders) {
      if (!imgQueue.length) break;
      wf[id].inputs.image = await ensureUploaded(imgQueue.shift()!);
    }
  }

  // 2a'. 上游视频 → LoadVideo 类节点（VHS_LoadVideo 等；输入名 video / file / video_path）
  const vidQueue = [...(opts.upstreamVideos ?? [])];
  if (vidQueue.length) {
    const vLoaders = Object.keys(wf)
      .filter((id) => isVideoLoaderClass(wf[id].class_type))
      .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    for (const id of vLoaders) {
      if (!vidQueue.length) break;
      opts.onProgress?.("上传视频到 ComfyUI…");
      const name = await uploadVideoToComfy(host, vidQueue.shift()!);
      const inputs = wf[id].inputs;
      const key = ["video", "file", "video_path"].find((k) => k in inputs && !isConnection(inputs[k])) ?? "video";
      inputs[key] = name;
      opts.onProgress?.(`视频已接入 #${id} ${nodeTitle(id)}`);
    }
    if (vidQueue.length) {
      throw new Error(
        "已连接上游视频，但该工作流没有足够的视频加载节点（LoadVideo）。请在模板里加 VHS_LoadVideo 类节点，或断开视频连线。",
      );
    }
  }

  // 2b. 模板没有文本参数时，把上游文本填入正面提示词入口
  if (!hasTextParam && opts.upstreamTexts?.length) {
    const entry = analyzeCaps(wf).textEntries.find((t) => !t.negative);
    if (entry) {
      wf[entry.nodeId].inputs[entry.input] = opts.upstreamTexts.join("\n");
      opts.onProgress?.(`上游文本已填入 #${entry.nodeId} ${nodeTitle(entry.nodeId)}`);
    }
  }

  // 2c. 提交前校验（object_info 说明书）：补默认值 / 自动注入图片入口 / 中文报缺
  const info = await fetchObjectInfo(host);
  if (info) {
    const problems: string[] = [];
    let inj = 0;
    for (const [nid, node] of Object.entries(wf)) {
      const spec = info[node.class_type];
      if (!spec) {
        problems.push(`#${nid} ${nodeTitle(nid)}：本机 ComfyUI 未安装节点类型「${node.class_type}」，请先安装对应的自定义节点插件`);
        continue;
      }
      const required = (spec.input?.required ?? {}) as Record<string, unknown[]>;
      for (const [input, def] of Object.entries(required)) {
        const cur = node.inputs[input];
        const broken = cur === undefined || (isConnection(cur) && !wf[cur[0]]);
        if (!broken) continue;
        const t = def?.[0];
        if (Array.isArray(t)) {
          if (t.length) node.inputs[input] = t[0]; // 下拉选项 → 取第一项
          continue;
        }
        const dflt = (def?.[1] as { default?: unknown } | undefined)?.default;
        if (dflt !== undefined) {
          node.inputs[input] = dflt; // 普通控件 → 用默认值
          continue;
        }
        if (t === "IMAGE") {
          // 缺图片输入：自动注入一个 LoadImage 节点接上游图片
          const src = imgQueue.shift() ?? lastImageSrc;
          if (src) {
            const name = await ensureUploaded(src);
            const iid = `momo_in_${++inj}`;
            wf[iid] = { class_type: "LoadImage", inputs: { image: name, upload: "image" }, _meta: { title: "MOMO 传入图片" } };
            node.inputs[input] = [iid, 0];
            opts.onProgress?.(`已自动补入图片 → #${nid} ${nodeTitle(nid)}`);
          } else {
            problems.push(`#${nid} ${nodeTitle(nid)}：必填图片输入「${input}」没有来源——请连接上游图片节点`);
          }
        } else if (typeof t === "string") {
          problems.push(`#${nid} ${nodeTitle(nid)}：必填输入「${input}」（${t}）缺失或指向被忽略的节点`);
        }
      }
    }
    if (problems.length) throw new Error(`工作流无法运行：\n${problems.join("\n")}`);
  }

  // 2d. 上游连了图片却全程没用上 → 明确报错（否则模型只会"看不见"图，产出无关结果）
  if ((opts.upstreamImages?.length ?? 0) > 0 && imagesUsed === 0) {
    throw new Error(
      "已连接上游图片，但该工作流没有任何图片入口（无 LoadImage 节点、也没有空缺的图片输入）。请在模板编辑器的示意图中检查，或断开图片连线。",
    );
  }

  // 3. 先开 WebSocket（提交前连上才能收到从头开始的执行消息），再提交
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

    // 4. 轮询 history 收尾（完成判定始终以 history 为准，WS 只负责进度展示）
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
      // 收集输出：图片取指定输出节点（未指定则全部）；文本/视频一律扫全部输出节点
      const urls: string[] = [];
      const vurls: string[] = [];
      const texts: string[] = [];
      const outputs = entry.outputs ?? {};
      const viewUrl = (f: { filename: string; subfolder?: string; type?: string }) => {
        const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder ?? "", type: f.type ?? "output" });
        return `${base}/view?${q.toString()}`;
      };
      const nodeIds = tpl.outputNodeId && outputs[tpl.outputNodeId] ? [tpl.outputNodeId] : Object.keys(outputs);
      for (const nid of nodeIds) {
        for (const img of outputs[nid]?.images ?? []) urls.push(viewUrl(img));
      }
      for (const nid of Object.keys(outputs)) {
        const out = outputs[nid] ?? {};
        for (const t of [...(out.text ?? []), ...(out.string ?? []), ...(out.strings ?? [])]) {
          if (typeof t === "string" && t.trim()) texts.push(t.trim());
        }
        // VHS_VideoCombine 等视频合成节点的输出叫 gifs（历史命名，内容是视频文件）
        for (const g of [...(out.gifs ?? []), ...(out.videos ?? [])]) {
          if (g?.filename) vurls.push(viewUrl(g));
        }
      }
      if (!urls.length && !texts.length && !vurls.length)
        throw new Error("工作流执行完成，但未在输出节点找到图片、视频或文本");

      // /view 是临时直链（ComfyUI 重启即失效）：图片回传 dataURL、视频回传 blob URL，
      // 进入统一管线（节点显示、下游使用、资产收录、自动保存）
      const images: string[] = [];
      for (const [i, u] of urls.entries()) {
        opts.onProgress?.(urls.length > 1 ? `回传生成结果 ${i + 1}/${urls.length}…` : "回传生成结果…");
        try {
          images.push(await toDataUrl(u, (i2, init) => xfetch(i2 as string, init)));
        } catch {
          images.push(u); // 回传失败保底用直链，至少当场能预览
        }
      }
      const videos: string[] = [];
      for (const u of vurls) {
        opts.onProgress?.("回传视频结果…");
        try {
          videos.push(URL.createObjectURL(await (await xfetch(u)).blob()));
        } catch {
          videos.push(u);
        }
      }
      return { images, texts, videos };
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
