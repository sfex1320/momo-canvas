/**
 * Eagle 资产桥 — Web API V2 协议适配层
 *
 * 端点差异全部收口在此文件，UI / store / 同步引擎不得直接拼 URL。
 * 端点与字段以本机 Eagle 4.0.0 Build 20260401 实测为准（2026-08-27）：
 *   GET  /api/v2/app/info            应用信息（version/buildVersion/platform）
 *   GET  /api/v2/application/info    全量应用信息（含 preferences.developer.apiToken）
 *   GET  /api/v2/library/info        当前素材库（name/path/folders 树/applicationVersion）
 *   POST /api/v2/item/get            按 ids/ext/keywords 过滤素材；offset/limit 分页（默认 50，max 1000）；fields 裁剪
 *   POST /api/v2/item/query          关键词全文搜索（Eagle 搜索语法），分页同上
 *   GET  /api/v2/item/countAll       库内素材总数
 *   POST /api/v2/item/add            { items:[{path|url|base64,name,tags,annotation,folders,star}] } 批量收录 → {ids}
 *   POST /api/v2/item/update         { id, name/tags/annotation/star/folders... } → false 或更新后条目
 *   POST /api/v2/folder/create       { name,parent?,description? } → folder
 *   POST /api/v2/folder/update       { id,...patch }
 *   GET/POST /api/v2/folder/get      文件夹树/查询
 *   AI Search：/api/v2/aiSearch/isInstalled·isReady·searchByText（未装自动降级关键词）
 *
 * 注意：
 * - V2 的 item raw 不含 filePath / star（读取用推导路径 {库}/images/{id}.{ext}；评分写回可用 item/update star 字段）
 * - 「在 Eagle 中打开」走 eagle://item/{id} 深链（本地 HTTP 服务会 302 到它，协议已注册）
 * - 浏览器预览模式直接抛「不支持桌面连接」，不无限重试
 */
import type { EagleRemoteItem } from "../types";
import { isTauri } from "../utils";
import { xfetch } from "./http";

/** 分页入参（上层语义分页，统一 ≤100 条） */
export type EaglePageInput = { offset?: number; limit?: number };

export type EaglePage<T> = {
  data: T[];
  total: number;
  offset: number;
  limit: number;
};

export type EagleAppInfo = {
  version: string;
  buildVersion: string;
  platform: string;
};

export type EagleFolderNode = {
  id: string;
  name: string;
  description?: string;
  children?: EagleFolderNode[];
};

export type EagleLibraryInfo = {
  name: string;
  path: string;
  applicationVersion: string;
  modificationTime?: number;
  folders: EagleFolderNode[];
};

export type EagleItemQuery = {
  offset?: number;
  limit?: number;
  ids?: string[];
  id?: string;
  /** 关键词（name contain） */
  keywords?: string[];
  tags?: string[];
  folders?: string[];
  ext?: string;
  /** 要裁剪的字段列表（增量扫描只要 id+modificationTime 用得上） */
  fields?: string[];
};

export type EagleAddItemInput = {
  path?: string;
  url?: string;
  name?: string;
  tags?: string[];
  annotation?: string;
  /** 目标文件夹 id 列表 */
  folders?: string[];
  star?: number;
  modificationTime?: number;
};

export type EagleItemPatch = {
  name?: string;
  tags?: string[];
  annotation?: string;
  folders?: string[];
  star?: number;
  modificationTime?: number;
};

export type EagleAiSearchHit = { itemId: string; score?: number };

export function normalizeRemoteItem(raw: Record<string, unknown>): EagleRemoteItem {
  const r = raw as Record<string, unknown>;
  return {
    id: String(r.id ?? ""),
    name: String(r.name ?? "未命名"),
    ext: String(r.ext ?? "").toLowerCase(),
    size: Number(r.size ?? 0),
    width: typeof r.width === "number" ? r.width : undefined,
    height: typeof r.height === "number" ? r.height : undefined,
    tags: Array.isArray(r.tags) ? (r.tags as unknown[]).map(String) : [],
    folders: Array.isArray(r.folders) ? (r.folders as unknown[]).map(String) : [],
    annotation: typeof r.annotation === "string" ? r.annotation : undefined,
    url: typeof r.url === "string" ? r.url : undefined,
    star: typeof r.star === "number" ? r.star : 0,
    btime: typeof r.btime === "number" ? r.btime : undefined,
    mtime: typeof r.mtime === "number" ? r.mtime : undefined,
    modificationTime: typeof r.modificationTime === "number" ? r.modificationTime : undefined,
    lastModified: typeof r.lastModified === "number" ? r.lastModified : undefined,
    isDeleted: r.isDeleted === true,
  };
}

/** 素材库路径 → 稳定 libraryKey（Windows 盘符小写、分隔符归一、djb2 十六进制指纹） */
export function libraryKeyOf(libraryPath: string): string {
  const norm = libraryPath.replace(/[\\/]+$/, "").replace(/[\\/]/g, "/").toLowerCase();
  let h = 5381;
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) | 0;
  return `lib-${(h >>> 0).toString(16)}-${norm.length.toString(36)}`;
}

export class EagleClient {
  readonly host: string;
  private token: string;

  constructor(host: string, token = "") {
    // 去尾斜杠；保底端口防用户只填个主机名
    let h = host.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(h)) h = `http://${h}`;
    this.host = h;
    this.token = token.trim();
  }

  /** 带 token 的请求地址（token query + header 双通道，兼容 Eagle 各版本校验方式） */
  private url(path: string): string {
    if (!this.token) return `${this.host}${path}`;
    return `${this.host}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.token)}`;
  }

  private async req<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 8000): Promise<T> {
    if (!isTauri) throw new Error("浏览器预览模式不支持桌面连接：请使用 MOMO 桌面版连接 Eagle");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await xfetch(this.url(path), {
        method,
        headers: { "Content-Type": "application/json", ...(this.token ? { "X-API-Token": this.token } : {}) },
        body: body != null ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await resp.text();
      let json: { status?: string; code?: number; message?: string; data?: T };
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Eagle 返回了无法解析的内容（HTTP ${resp.status}）——确认端口是否被其它程序占用`);
      }
      // Eagle 约定 HTTP 200 也可能 status:error
      if (json.status === "error") {
        throw new Error(translateEagleError(json.code ?? resp.status, json.message));
      }
      return json.data as T;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new Error("Eagle 响应超时——若 Eagle 正在整理大素材库请稍后再试");
      }
      if (e instanceof Error && /fetch|network|Failed to fetch/i.test(e.message)) {
        throw new Error("连不上 Eagle：请确认 Eagle 已启动，且「偏好设置 → 开发者」里的 API 服务已开启（默认端口 41595）");
      }
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---- 应用与库 ---- */

  async health(): Promise<EagleAppInfo> {
    return this.req<EagleAppInfo>("GET", "/api/v2/app/info");
  }

  async libraryInfo(): Promise<EagleLibraryInfo> {
    return this.req<EagleLibraryInfo>("GET", "/api/v2/library/info");
  }

  async countAll(): Promise<number> {
    return this.req<number>("GET", "/api/v2/item/countAll");
  }

  /* ---- 素材读取 ---- */

  async getItems(input: EagleItemQuery): Promise<EaglePage<EagleRemoteItem>> {
    const d = await this.req<{ data: Record<string, unknown>[]; total: number; offset: number; limit: number }>(
      "POST",
      "/api/v2/item/get",
      { ...input, limit: clampLimit(input.limit) },
    );
    return { data: (d?.data ?? []).map(normalizeRemoteItem), total: d?.total ?? 0, offset: d?.offset ?? 0, limit: d?.limit ?? 0 };
  }

  async queryItems(query: string, page: EaglePageInput = {}): Promise<EaglePage<EagleRemoteItem>> {
    const d = await this.req<{ data: Record<string, unknown>[]; total: number; offset: number; limit: number }>(
      "POST",
      "/api/v2/item/query",
      { query, offset: page.offset ?? 0, limit: clampLimit(page.limit) },
    );
    return { data: (d?.data ?? []).map(normalizeRemoteItem), total: d?.total ?? 0, offset: d?.offset ?? 0, limit: d?.limit ?? 0 };
  }

  /** 全量轻量 ID + 修改时间（增量扫描专用；一页最多 1000） */
  async getIdsWithModifiedAt(): Promise<Array<{ id: string; modifiedAt: number }>> {
    const out: Array<{ id: string; modifiedAt: number }> = [];
    const step = 1000;
    for (let offset = 0; ; offset += step) {
      const page = await this.getItems({ fields: ["id", "modificationTime"], offset, limit: step });
      for (const it of page.data) {
        out.push({ id: it.id, modifiedAt: it.modificationTime ?? 0 });
      }
      if (!page.data.length || offset + page.data.length >= page.total) break;
    }
    return out;
  }

  /* ---- 写入 ---- */

  /** 本地路径批量收录进 Eagle；返回生成的 itemId 列表 */
  async addFromPaths(items: EagleAddItemInput[], folderId?: string): Promise<string[]> {
    const payload = items.map((it) => ({ ...it, ...(folderId ? { folders: [folderId] } : {}) }));
    const d = await this.req<{ ids?: string[]; id?: string }>("POST", "/api/v2/item/add", { items: payload });
    if (Array.isArray(d?.ids)) return d.ids.map(String);
    if (d?.id) return [String(d.id)];
    throw new Error("Eagle 未返回新收录的素材编号，无法建立绑定");
  }

  async updateItem(id: string, patch: EagleItemPatch): Promise<boolean> {
    const d = await this.req<Record<string, unknown> | boolean>("POST", "/api/v2/item/update", { id, ...patch });
    return d !== false;
  }

  /* ---- 文件夹 ---- */

  async listFolders(): Promise<EagleFolderNode[]> {
    const lib = await this.libraryInfo();
    return lib.folders ?? [];
  }

  async createFolder(input: { name: string; parent?: string; description?: string }): Promise<EagleFolderNode & { children?: EagleFolderNode[] }> {
    return this.req("POST", "/api/v2/folder/create", input);
  }

  async updateFolder(id: string, patch: { name?: string; description?: string; parent?: string }): Promise<unknown> {
    return this.req("POST", "/api/v2/folder/update", { id, ...patch });
  }

  /* ---- AI Search（可选能力，未安装时上层降级关键词搜索） ---- */

  async aiSearchInstalled(): Promise<boolean> {
    try {
      return (await this.req<boolean>("GET", "/api/v2/aiSearch/isInstalled")) === true;
    } catch {
      return false;
    }
  }

  async aiSearchByText(query: string, limit = 30): Promise<EagleAiSearchHit[]> {
    const d = await this.req<{ hits?: Record<string, unknown>[]; results?: Record<string, unknown>[] }>(
      "POST",
      "/api/v2/aiSearch/searchByText",
      { query, limit },
    );
    const list = d?.hits ?? d?.results ?? [];
    return list.map((h) => ({ itemId: String(h.itemId ?? h.id ?? ""), score: typeof h.score === "number" ? h.score : undefined }));
  }
}

function clampLimit(n?: number) {
  return Math.min(1000, Math.max(1, n && Number.isFinite(n) ? n : 50));
}

/** Eagle 错误码 → 可行动的中文提示 */
function translateEagleError(code: number | undefined, message?: string): string {
  switch (code) {
    case 401:
      return "Eagle API 校验失败：请在「偏好设置 → 开发者」核对 Token，并同步到 MOMO 设置里";
    case 403:
      return "Eagle 拒绝访问：API 服务可能未开启或 Token 无效";
    case 404:
      return "Eagle 接口不存在：你的 Eagle 版本过低（推荐 Build 22+），请升级后再试";
    default:
      return message ? `Eagle 错误（${code ?? ""}）：${message}` : `Eagle 错误（${code ?? "未知"}）`;
  }
}
