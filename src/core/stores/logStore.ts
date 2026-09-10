import { compactError } from "../errorText";
/**
 * 运行日志：每一次对外网络请求的请求体/响应体/耗时/状态。
 *  - http.ts 的 xfetch 自动上报（脱敏：不存鉴权头；请求/响应体截断，base64 折叠）
 *  - 同 URL 同状态的连续请求（异步任务轮询）合并为一条并累计次数
 *  - 保留最近 200 条，最近 120 条落盘（重启后仍可查上次的失败请求）
 */
import { create } from "zustand";
import { loadJSON, saveJSON } from "../persist.ts";
import { uid } from "../utils.ts";

export type RunLogEntry = {
  id: string;
  ts: number;
  method: string;
  url: string;
  /** HTTP 状态码；undefined = 网络层错误（没拿到响应） */
  status?: number;
  ok?: boolean;
  durMs: number;
  reqBody?: string;
  respBody?: string;
  error?: string;
  /** 同请求重复次数（轮询合并） */
  count: number;
};

const KEEP = 200;
const PERSIST = 120;

type LogState = {
  entries: RunLogEntry[];
  loaded: boolean;
  init: () => Promise<void>;
  push: (e: Omit<RunLogEntry, "id" | "count">) => void;
  clear: () => void;
  compactErrors: () => void;
};

let initOnce: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const scheduleSave = (entries: RunLogEntry[]) => {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void saveJSON("runlogs.json", "v1", entries.slice(0, PERSIST));
  }, 1500);
};

export const useRunLog = create<LogState>((set, get) => ({
  entries: [],
  loaded: false,

  init: () =>
    (initOnce ??= (async () => {
      const saved = await loadJSON<RunLogEntry[]>("runlogs.json", "v1");
      // 历史日志补洗一遍：老版本的 url/请求体没做密钥脱敏，磁盘上可能已有明文
      const washed = (saved ?? []).map((x) => ({
        ...x,
        url: compactError(redactSecrets(x.url.slice(0,8192))),
        error: x.error ? compactError(x.error) : x.error,
        reqBody: x.reqBody ? redactSecrets(x.reqBody) : x.reqBody,
        respBody: x.respBody ? redactSecrets(x.respBody) : x.respBody,
      }));
      // 旧在前新在后地合并：启动时已有的（本次会话产生的）排前面
      set((s) => ({ entries: [...s.entries, ...washed].slice(0, KEEP), loaded: true }));
    })()),

  push: (e) => {
    e = { ...e, url: compactError(e.url), error: e.error ? compactError(e.error) : e.error };
    const list = get().entries;
    const head = list[0];
    // 轮询合并：紧邻的同方法同 URL 同状态 → 累计次数、刷新时间与响应
    if (head && head.method === e.method && head.url === e.url && head.status === e.status && !e.error && !head.error) {
      const merged: RunLogEntry = { ...head, ts: e.ts, durMs: e.durMs, respBody: e.respBody ?? head.respBody, count: head.count + 1 };
      const next = [merged, ...list.slice(1)];
      set({ entries: next });
      scheduleSave(next);
      return;
    }
    const next = [{ ...e, id: uid(8), count: 1 }, ...list].slice(0, KEEP);
    set({ entries: next });
    scheduleSave(next);
  },

  compactErrors: () => {
    const entries = get().entries.map(e => ({...e,url:compactError(e.url),error:e.error?compactError(e.error):e.error}));
    if (entries.some((e,i) => e.url!==get().entries[i].url || e.error!==get().entries[i].error)) {set({entries});scheduleSave(entries);}
  },
  clear: () => {
    set({ entries: [] });
    void saveJSON("runlogs.json", "v1", []);
  },
}));

/* ---------------- 脱敏 / 截断工具（http.ts 上报前调用） ---------------- */

const CAP = 2400;

/**
 * 密钥脱敏：把配置里所有 API Key 从文本中抹掉。
 * Gemini 协议把 key 放 query（?key=xxx）、自定义协议把 {{apiKey}} 渲染进 body——
 * 不洗的话完整密钥会落进 runlogs.json 并显示在运行日志面板，用户截图求助就等于公开密钥。
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let t = text;
  try {
    // 动态取 settings（logStore 不静态依赖 settingsStore，避免加载顺序问题）
    const st = settingsRef?.();
    if (st) {
      for (const key of st) {
        if (key && key.length >= 8) t = t.split(key).join("***");
      }
    }
  } catch {
    /* 取不到配置就只走正则兜底 */
  }
  return t
    .replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"'<>]+/gi, "$1***")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1***")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, "sk-***");
}

/** settings 里的全部密钥（settingsStore 启动时注册，避免循环依赖） */
let settingsRef: (() => string[]) | null = null;
export function registerSecretSource(fn: () => string[]) {
  settingsRef = fn;
}

/** 折叠 base64/dataURL 长串，抹掉密钥，截断到 CAP 字符 */
export function sanitizeBody(text: string): string {
  let t = redactSecrets(text)
    .replace(/data:[a-z/+.-]+;base64,[A-Za-z0-9+/=]{64,}/gi, (m) => `data:…[base64 ${m.length} 字符已省略]`)
    .replace(/"[A-Za-z0-9+/=]{512,}"/g, (m) => `"…[base64 ${m.length} 字符已省略]"`);
  if (t.length > CAP) t = `${t.slice(0, CAP)}\n…[共 ${text.length} 字符，已截断]`;
  return t;
}

/** 这些地址是高频探活/轮询/静态资源，不进日志 */
export function shouldSkipLog(url: string): boolean {
  return /\/system_stats|\/object_info|\/queue\b|\/history\/|\/view\?|\/ws\b/.test(url);
}
