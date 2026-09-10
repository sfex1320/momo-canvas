/**
 * MOMO × Eagle 资产桥 — 同步引擎
 *
 * 职责：队列编排 / 推送与拉回 / 增量扫描 / 防回声 / 状态机迁移。
 * 协议细节全部在 eagleApi.ts；资产落盘账本在 assetStore.ts；本文件只做业务编排。
 *
 * 核心规则（实现规格 §8）：
 * - MOMO 生成完成只异步入队（queueEaglePush），绝不 await Eagle；
 * - 同一资产重复推送幂等：已有 itemId 只同步元数据，不重复 addFromPaths；
 * - Eagle 拉回先由 Rust 流式复制进 AppData/assets，前端零整读大文件；
 * - 删除只解除绑定（unlink），不级联删任何一端文件；
 * - 增量扫描只拉 id+modificationTime 轻量列表；本地写入的回声不反向同步。
 */
import type { AssetItem, EagleAssetLink, EagleCfg, EagleLinkState, EagleRemoteItem } from "./types";
import { pushError, toast } from "./stores/uiStore";
import { errMsg, isTauri, uid } from "./utils";
import { useAssets } from "./stores/assetStore";
import { useSettings } from "./stores/settingsStore";
import { useEagle } from "./stores/eagleStore";
import { EagleClient, libraryKeyOf, type EagleLibraryInfo } from "./services/eagleApi";
import { activeEagleAssets, newEagleImports } from "./eagleSyncIdentity";
import {eagleRetryDecision,eagleConnectionFailure as connectionFailure} from "./eagleQueuePolicy";

/** 队列重试上限（超过进入 error 态等待手动重试） */
const MAX_ATTEMPT = 3;
/** 本地写入后的回声豁免窗口（毫秒） */
const ECHO_WINDOW_MS = 30_000;


type QueueJob = {
  assetId: string;
  attempt: number;
  /** 排队时间戳（退避用） */
  queuedAt: number;
};

/* ---------------- 引擎内部状态 ---------------- */

const queue = new Map<string, QueueJob>();
let consuming = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollBackoffMs = 0;
let reconnectAt = 0;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;
let recoveredCount = 0;
let connecting: Promise<{ok:boolean;message:string}> | null = null;
let scanning = false;
/** 同一远端项目的导入串行，避免扫描与手动拉回同时创建版本。 */
const importing = new Map<string, Promise<void>>();
/** 本地写入记录 → 防止把 MOMO 自己写的变更当成 Eagle 端修改再拉回来 */
const lastWrite = new Map<string, { at: number; metaFingerprint: string; modifiedAt?: number }>();

export function client(): EagleClient | null {
  const s = useEagle.getState();
  if (!s.client) return null;
  return s.client;
}

/** 当前 Eagle 配置（settingsStore 单一真源） */
function cfg(): EagleCfg {
  return useSettings.getState().settings.eagle;
}

/* ---------------- 状态机 ---------------- */

/** 所有 eagle.state 迁移的唯一入口；UI 一律通过引擎动作，禁止直接拼 state */
export function transitionLink(assetId: string, state: EagleLinkState, extra?: Partial<EagleAssetLink>) {
  const assets = useAssets.getState();
  const item = assets.items.find((i) => i.id === assetId);
  if (!item) return;
  const base: EagleAssetLink = item.eagle ?? {
    libraryKey: currentLibraryKey(),
    itemId: "",
    pairId: uid(10),
    linkedAt: Date.now(),
    state: "queued",
  };
  assets.patchItem(assetId, { eagle: { ...base, ...extra, state } });
}

function currentLibraryKey(): string {
  const lib = useEagle.getState().library;
  return lib ? libraryKeyOf(lib.path) : "lib-unknown";
}

/**
 * 确保库就绪：未连接时先探测一次；连不上抛中文离线错误（队列据此走离线重试）。
 * 返回客户端 + 当前素材库。
 */
async function ensureLibraryReady(): Promise<{ cli: EagleClient; lib: EagleLibraryInfo }> {
  const st = useEagle.getState();
  if (st.connState === "ready" && st.client && st.library) {
    return { cli: st.client, lib: st.library };
  }
  const r = await detect();
  const now = useEagle.getState();
  if (!r.ok || !now.client || !now.library) {
    throw new Error("EAGLE_OFFLINE 连不上 Eagle：任务保留在同步队列，Eagle 恢复后自动续传");
  }
  return { cli: now.client, lib: now.library };
}

/* ---------------- 队列 ---------------- */

/**
 * 异步入队；手动菜单与批量栏走这条。
 * `opts.auto = true` 表示「生成完成后的自动推送」——须另开 autoPushGenerated，
 * 手动动作不受该开关限制（用户点了就是明确意图）。
 */
export function queueEaglePush(assetIds: string[], opts: { auto?: boolean } = {}) {
  if (!cfg().enabled) return;
  // 自动推送由同步方式派生：manual 不自动，push / bidirectional 自动（autoPushGenerated 字段由设置页联动写入）
  if (opts.auto && cfg().syncMode === "manual") return;
  let added = 0;
  for (const id of assetIds) {
    const item = useAssets.getState().items.find((i) => i.id === id);
    if (!item || item.deletedAt) continue;
    if (queue.has(id)) continue;
    queue.set(id, { assetId: id, attempt: 0, queuedAt: Date.now() });
    transitionLink(id, item.eagle?.itemId ? "local-dirty" : "queued");
    added++;
  }
  if (added) {
    recount();
    void consume(); // 立即尝试消费（离线时任务留在队列里等恢复）
  }
}

/** 同时在推的任务数：Eagle 端入库本身是异步队列，两路并发足够又不给它添堵 */
const CONCURRENCY = 2;

async function consume() {
  if (consuming) return;
  consuming = true;
  try {
    while (queue.size && cfg().enabled) {
      if (useEagle.getState().connState !== "ready") {
        if (Date.now() < reconnectAt) { wakeQueue(reconnectAt - Date.now()); break; }
        if (!(await detect()).ok) { reconnectAt = Date.now() + 30_000; wakeQueue(30_000); break; }
      }
      const jobs = takeDueJobs(CONCURRENCY);
      if (!jobs.length) break; // 剩余都在退避期
      await Promise.all(jobs.map((job) => settleJob(job)));
    }
  } finally {
    consuming = false;
    recount();
    if (!queue.size && recoveredCount) { toast(`Eagle 已恢复，待传队列已处理完毕，可在同步中心查看结果`, "ok"); recoveredCount = 0; }
  }
}

function wakeQueue(delay: number) {
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => { wakeTimer = null; void consume(); }, Math.max(200, delay));
}

/** 从资产账本恢复队列，重启或重新登录后同样续传。 */
export function restoreEagleQueue() {
  if (!cfg().enabled) return;
  for (const item of useAssets.getState().items) {
    if (item.deletedAt || !item.eagle || queue.has(item.id)) continue;
    if (["queued", "pushing", "local-dirty"].includes(item.eagle.state) || (item.eagle.state === "offline" && (!item.eagle.itemId || connectionFailure(item.eagle.error ?? ""))))
      queue.set(item.id, { assetId: item.id, attempt: 0, queuedAt: Date.now() });
  }
  recount();
  if (queue.size) wakeQueue(200);
}

/** 取出到期任务；一个都不到期时安排晚些的自动唤醒 */
function takeDueJobs(n: number): QueueJob[] {
  const now = Date.now();
  const out: QueueJob[] = [];
  for (const j of queue.values()) {
    if (j.queuedAt <= now) {
      out.push(j);
      if (out.length >= n) return out;
    }
  }
  if (!out.length && queue.size) {
    const soonest = Math.min(...[...queue.values()].map((j) => j.queuedAt));
    wakeQueue(soonest - Date.now());
  }
  return out;
}

/** 执行一个任务并按结果决定出队 / 退避重试 / 终态 */
async function settleJob(job: QueueJob) {
  const ok = await pushOne(job.assetId);
  const decision = eagleRetryDecision(ok,useEagle.getState().connState === "ready",job.attempt);
  if (decision === "wait") {
    job.queuedAt = Date.now() + 30_000;
    reconnectAt = job.queuedAt;
    wakeQueue(30_000);
    return; // 连接失败不消耗素材重试次数。
  }
  if (decision === "done" || decision === "failed") {
    queue.delete(job.assetId);
    if (!ok && job.attempt + 1 >= MAX_ATTEMPT) recount("failed");
  } else {
    job.attempt++;
    job.queuedAt = Date.now() + backoff(job.attempt); // 指数退避后重试
    recount();
  }
}

function backoff(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt);
}

function recount(extra?: "failed") {
  const items = useAssets.getState().items;
  const dirtyIds = useEagle.getState().dirtyIds;
  let synced = 0;
  let queued = queue.size;
  let conflict = 0;
  let dirty = 0;
  let failed = 0;
  for (const i of items) {
    const st = i.eagle?.state;
    if (!st) continue;
    if (st === "synced") synced++;
    else if (st === "conflict") conflict++;
    else if (st === "error") failed++;
    else if (st === "remote-dirty") dirty++;
    else if (st === "local-dirty" && !queue.has(i.id)) dirty++;
  }
  if (extra === "failed") failed++;
  // 队列里的 local-dirty 已含在 queue.size 里，只把未被队列覆盖的远端脏项计入待处理
  queued += dirtyIds.filter((id) => !queue.has(id)).length;
  useEagle.setState({ stats: { synced, queued, conflict, failed } });
}

/* ---------------- 推送：MOMO → Eagle ---------------- */

async function pushOne(assetId: string): Promise<boolean> {
  const assets = useAssets.getState();
  const item = assets.items.find((i) => i.id === assetId);
  if (!item || item.deletedAt) return true; // 已删除视为处理完

  // 未启用时静默离队（用户关掉功能不应继续骚扰）
  if (!cfg().enabled) {
    if (item.eagle) transitionLink(assetId, "offline");
    return true;
  }

  transitionLink(assetId, "pushing");
  try {
    // ① 库就绪 + 目标文件夹
    const { cli, lib } = await ensureLibraryReady();
    const folderId = await resolveTargetFolder(item, lib);

    // ② 已绑定：只核对元数据，不重复收文件（幂等的核心）
    if (item.eagle?.itemId) {
      const remotePage = await cli.getItems({ ids: [item.eagle.itemId], limit: 1 });
      const remote = remotePage.data[0];
      if (!remote || remote.isDeleted) {
        // Eagle 端没了：解除绑定（默认策略 unlink——不动 MOMO 文件）
        transitionLink(assetId, "offline", { error: "Eagle 端素材已被删除" });
        return true;
      }
      await syncMeta(cli, item, remote);
      transitionLink(assetId, "synced", {
        libraryKey: currentLibraryKey(),
        libraryName: lib.name,
        error: undefined,
        lastRemoteModifiedAt: remoteStamp(remote),
      });
      lastWrite.set(remote.id, { at: Date.now(), metaFingerprint: metaFingerprintOf(item), modifiedAt: remoteStamp(remote) });
      return true;
    }

    // ③ 未绑定：批量端点收一个新项目并建立绑定
    if (!isTauriLocalPath(item.path)) throw new Error("该资产不是本机文件（浏览器预览模式无法同步）");
    // 文件必须真实存在：索引还在但磁盘文件已被清理的旧资产（切片替换/回收站清理），
    // 直接推会让 Eagle 报原生 ENOENT——先拦下来给中文结论，且不重试（重试也不会有文件）
    if (!(await localFileExists(item.path))) {
      const msg = "资产文件已不在磁盘上（可能被切片替换或回收站清理过），无法同步；如需保留请从画布重新生成";
      transitionLink(assetId, "error", { error: msg, itemId: undefined });
      pushError("Eagle 资产桥", `「${item.name}」${msg}`);
      return true; // 终态：不留在队列里反复撞
    }
    const ids = await cli.addFromPaths(
      [
        {
          path: item.path,
          name: `${item.name}`,
          tags: mergedTags(item),
          annotation: buildAnnotation(item),
          ...(item.rating ? { star: item.rating } : {}),
        },
      ],
      folderId,
    );
    const itemId = ids[0];
    if (!itemId) throw new Error("Eagle 未返回素材编号");
    const remotePage = await cli.getItems({ ids: [itemId], limit: 1 });
    const remote = remotePage.data[0];
    transitionLink(assetId, "synced", {
      libraryKey: currentLibraryKey(),
      libraryName: lib.name,
      itemId,
      pairId: uid(10),
      linkedAt: Date.now(),
      lastRemoteModifiedAt: remote ? remoteStamp(remote) : undefined,
      error: undefined,
    });
    lastWrite.set(itemId, { at: Date.now(), metaFingerprint: metaFingerprintOf(item), modifiedAt: remote ? remoteStamp(remote) : undefined });
    return true;
  } catch (e) {
    const msg = errMsg(e);
    const offline = connectionFailure(msg);
    transitionLink(assetId, offline ? "offline" : "error", { error: msg });
    noticeFailure(msg, offline);
    // 离线保留在队列里等 Eagle 恢复；其它错误也留一次重试机会（文档：元数据最多自动重试 2 次）
    const j = queue.get(assetId);
    return offline ? false : !j || j.attempt >= MAX_ATTEMPT - 1;
  }
}

/** 手动重试失败队列：清空 error 态重新入队 */
export function retryFailed() {
  const assets = useAssets.getState();
  const ids = assets.items.filter((i) => i.eagle?.state === "error").map((i) => i.id);
  if (!ids.length) return 0;
  queueEaglePush(ids);
  return ids.length;
}

/* ---------------- 元数据合并（按用户策略） ---------------- */

function mergedTags(item: AssetItem): string[] {
  return [...new Set([...(item.tags ?? [])])];
}

/** Eagle annotation 给人看的摘要，完整生成参数仍在 MOMO 本地 */
function buildAnnotation(item: AssetItem): string {
  const lines: string[] = [];
  lines.push(`来自 MOMO · ${item.source === "canvas" ? "画布生成" : item.source === "eagle" ? "Eagle 回流" : "手动导入"}${boardNameSuffix(item)}`);
  if (item.model) lines.push(`模型：${item.model}`);
  const prompt = (item.promptEn || item.promptZh || item.prompt || "").trim();
  if (prompt) lines.push(`提示词：${prompt.slice(0, 300)}${prompt.length > 300 ? "…" : ""}`);
  lines.push(`MOMO 资产：momo://asset/${item.id}`);
  return lines.join("\n");
}

/** 画布名后缀（普通 helper 而非 Hook——命名不带 use 前缀，避免被 rules-of-hooks 误判为 Hook 调用） */
function boardNameSuffix(_item: AssetItem): string {
  return "";
}

function metaFingerprintOf(item: AssetItem): string {
  return JSON.stringify([item.name, [...(item.tags ?? [])].sort(), item.annotation ?? "", item.rating ?? 0]);
}

/** 按 metadata 策略把远端元数据合并进本地（pull 方向）；返回是否发生了变化 */
async function syncMeta(cli: EagleClient, local: AssetItem, remote: EagleRemoteItem): Promise<void> {
  const policy = cfg().metadata;
  const patch: Partial<AssetItem> = {};
  const toEagle: { tags?: string[]; annotation?: string; star?: number; modificationTime?: number } = {};

  // 名称：newer → 较新者赢（游标与扫描一致，用 lastModified/modificationTime 的较大者）
  const remoteStampV = Math.max(remote.modificationTime ?? 0, remote.lastModified ?? 0);
  if (policy.name !== "momo" && remoteStampV > (local.eagle?.lastRemoteModifiedAt ?? 0)) {
    if (policy.name === "eagle") patch.name = remote.name.replace(/\.[^.]+$/, "");
  }
  // 标签：union 双向合并
  if (policy.tags === "union") {
    const union = [...new Set([...(local.tags ?? []), ...remote.tags])];
    if (union.length !== (local.tags ?? []).length) patch.tags = union;
    const remoteSet = new Set(remote.tags);
    const missingOnRemote = union.filter((t) => !remoteSet.has(t));
    if (missingOnRemote.length) toEagle.tags = union;
  }
  // 说明：较新一侧赢
  if (remote.annotation != null && remote.annotation !== (local.annotation ?? "")) {
    if (policy.annotation === "eagle") patch.annotation = remote.annotation;
    else if (policy.annotation === "momo" && (local.annotation ?? "") !== "") toEagle.annotation = local.annotation!;
  }
  // 评分：较新一侧；写入用 star 字段（实测 item/save 支持 0~5）
  const remoteStar = remote.star ?? 0;
  const localStar = local.rating ?? 0;
  if (policy.rating === "eagle" && remoteStar !== localStar) patch.rating = remoteStar;
  else if (policy.rating === "momo" && localStar !== remoteStar && (local.eagle?.linkedAt ?? 0) > 0) toEagle.star = localStar;

  if (Object.keys(patch).length) useAssets.getState().patchItem(local.id, patch);
  if (Object.keys(toEagle).length) {
    const fp = metaFingerprintOf(local);
    await cli.updateItem(remote.id, toEagle);
    lastWrite.set(remote.id, { at: Date.now(), metaFingerprint: fp });
  }
}

/* ---------------- 拉回：Eagle → MOMO ---------------- */

/** Eagle 库 images 目录绝对路径（桥与文件定位共用） */
export function libraryImagesDir(): string {
  const lib = useEagle.getState().library;
  if (!lib) return "";
  return `${lib.path}${/[\\/]$/.test(lib.path) ? "" : "\\"}images`;
}

/**
 * Eagle 库内素材的真实文件路径。
 * Eagle 4 实测布局是 images/{id}.info/{原始文件名}（字体/音视频等尤其如此），
 * 由 Rust 在 .info 目录里挑主文件；旧版直存 {id}.{ext} 作兜底。
 */
export async function remoteFilePath(it: EagleRemoteItem): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("eagle_locate_item_file", { imagesDir: libraryImagesDir(), itemId: it.id });
}

/**
 * 把 Eagle 素材导入 MOMO：
 * - 已绑定同一 itemId 且远端未变化 → 直接返回现有活动版本（幂等，不产生副本）
 * - 远端变化且参数 forceNewVersion → 以 lineage 新版本导入（非破坏）
 * - 全新 itemId → 复制入库建立绑定
 */
export async function importEagleItems(
  itemIds: string[],
  opts: { target?: string; silent?: boolean; autoPull?: boolean } = {},
): Promise<AssetItem[]> {
  if (!isTauriSupported()) return [];
  const { cli, lib } = await ensureLibraryReady();

  const imported: AssetItem[] = [];
  for (const id of [...new Set(itemIds)].slice(0, 50)) {
    const key = `${libraryKeyOf(lib.path)}:${id}`;
    const previous = importing.get(key);
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    importing.set(key, done);
    await previous;
    try {
      const page = await cli.getItems({ id, limit: 1 });
      const remote = page.data[0];
      if (!remote) continue;

      // 幂等：已绑定且无远端变化的 itemId 直接复用现有资产——
      // 插件「发送到画布」等场景不得复制出重复版本
      const existing = activeEagleAssets(useAssets.getState().items, libraryKeyOf(lib.path)).find(i => i.eagle?.itemId === id);
      if (existing && existing.eagle?.state === "synced" && existing.eagle.lastRemoteModifiedAt === remoteStamp(remote)) {
        if (opts.target === "canvas") void sendToCanvasCenter(existing);
        imported.push(existing);
        continue;
      }

      const srcPath = await remoteFilePath(remote);
      const { invoke } = await import("@tauri-apps/api/core");
      const copied = await invoke<{ path: string; size: number; mtimeMs: number; ext: string; fingerprint: string }>(
        "eagle_copy_into_assets",
        { sourcePath: srcPath, preferredExt: remote.ext },
      );

      // 作为已绑定资产的新版本回流（从 Eagle 刷新）
      if (existing) {
        const revision = (existing.lineage?.revision ?? 0) + 1;
        const link: EagleAssetLink = {
          ...(existing.eagle as EagleAssetLink),
          state: "synced",
          lastRemoteModifiedAt: remoteStamp(remote),
          lastLocalFingerprint: copied.fingerprint,
          error: undefined,
        };
        const created = await useAssets.getState().registerEagleImport({
          absPath: copied.path,
          size: copied.size,
          ext: copied.ext,
          fingerprint: copied.fingerprint,
          remote,
          link,
          lineage: { parentAssetId: existing.id, rootAssetId: existing.lineage?.rootAssetId ?? existing.id, revision, reason: "eagle-edit" },
        });
        if (created) {
          // 绑定转移到活动版本，原版本保留历史谱系
          useAssets.getState().patchItem(existing.id, {
            eagle: existing.eagle ? { ...existing.eagle, state: "offline", error: "已由新版本接管" } : undefined,
            lineage: existing.lineage ?? { rootAssetId: existing.id, revision: 0 },
          });
          imported.push(created);
        }
        continue;
      }

      // 全新导入
      const link: EagleAssetLink = {
        libraryKey: currentLibraryKey(),
        libraryName: lib.name,
        itemId: remote.id,
        pairId: uid(10),
        linkedAt: Date.now(),
        lastRemoteModifiedAt: remoteStamp(remote),
        lastLocalFingerprint: copied.fingerprint,
        state: "synced",
      };
      const created = await useAssets.getState().registerEagleImport({
        absPath: copied.path,
        size: copied.size,
        ext: copied.ext,
        fingerprint: copied.fingerprint,
        remote,
        link,
        lineage: { rootAssetId: "", revision: 0, reason: "manual-import" },
      });
      if (created) {
        created.lineage && (created.lineage.rootAssetId ||= created.id);
        imported.push(created);
        if (opts.target === "canvas") void sendToCanvasCenter(created);
      }
    } catch (e) {
      pushError("Eagle 资产桥", `导入「${id}」失败：${errMsg(e)}`);
    } finally {
      release();
      if (importing.get(key) === done) importing.delete(key);
    }
  }
  if (!opts.silent && imported.length) {
    toast(`已从 Eagle 导入 ${imported.length} 个素材到资产库`, "ok");
  }
  return imported;
}

/** 解除绑定：只清关系，两端文件都不动 */
export function unlinkAssets(assetIds: string[]) {
  for (const id of assetIds) {
    useAssets.getState().patchItem(id, { eagle: undefined });
    queue.delete(id);
  }
  recount();
}

/* ---------------- 增量扫描（bidirectional 才启用） ---------------- */

/** 远端修改游标：Eagle 实测改名/评分只动 lastModified、文件替换只动 modificationTime，取较大者才不漏检 */
function remoteStamp(it: Pick<EagleRemoteItem, "modificationTime" | "lastModified">): number {
  return Math.max(it.modificationTime ?? 0, it.lastModified ?? 0);
}

export function scheduleScan() {
  if (pollTimer) clearTimeout(pollTimer);
  const c = cfg();
  if (!c.enabled || c.syncMode !== "bidirectional") return;
  const interval = effectiveInterval(c.pollIntervalMs);
  pollTimer = setTimeout(async () => {
    await runScanOnce().catch(() => {});
    scheduleScan();
  }, interval);
}

function effectiveInterval(base: number): number {
  return Math.max(3000, base) + pollBackoffMs;
}

async function runScanOnce(): Promise<void> {
  if (scanning) return;
  scanning = true;
  try { await scanActiveAssets(); } finally { scanning = false; }
}

async function scanActiveAssets(): Promise<void> {
  const st = useEagle.getState();
  if (st.connState !== "ready" || st.library == null) return;
  const cli = client();
  if (!cli) return;

  // 只核对 MOMO 已绑定的 itemId（分批 500/个请求），不扫全库——
  // 6 千项的库按老做法每轮要 7 个请求，绑定几十个时 1 个请求就够
  const bound = activeEagleAssets(useAssets.getState().items, libraryKeyOf(st.library.path)).filter(i => i.eagle?.state !== "error");
  if (!bound.length) return;
  try {
    const byId = new Map<string, number>();
    for (let at = 0; at < bound.length; at += 500) {
      const batch = bound.slice(at, at + 500).map((i) => i.eagle!.itemId);
      const page = await cli.getItems({ ids: batch, fields: ["id", "modificationTime", "lastModified"], limit: 1000 });
      for (const r of page.data) byId.set(r.id, remoteStamp(r));
    }
    pollBackoffMs = 0;
    useEagle.setState({ lastScanAt: Date.now() });

    const changedAssets: string[] = [];
    const changedItemIds: string[] = [];
    for (const item of bound) {
      const link = item.eagle!;
      const remoteM = byId.get(link.itemId);
      if (remoteM == null) {
        // 绑定项在 Eagle 里消失了（被删除/换库）——按 unlink 策略只标记，不动本地文件
        transitionLink(item.id, "offline", { error: "Eagle 端素材已不存在" });
        continue;
      }
      if (remoteM === link.lastRemoteModifiedAt) continue;
      // 回声：自己刚写过去的变更不算远端修改，只推进游标
      const echo = lastWrite.get(link.itemId);
      if (echo && Date.now() - echo.at < ECHO_WINDOW_MS) {
        transitionLink(item.id, link.state, { lastRemoteModifiedAt: remoteM });
        continue;
      }
      transitionLink(item.id, "remote-dirty", { lastRemoteModifiedAt: undefined });
      changedAssets.push(item.id);
      changedItemIds.push(link.itemId);
    }
    recount();
    if (changedAssets.length) {
      useEagle.setState({ dirtyIds: changedAssets });
      // 双向模式 = 无感回流：Eagle 端被加工过的素材自动以新版本导入（原版本保留）
      const previousIds = new Set(useAssets.getState().items.map(i => i.id));
      await importEagleItems(changedItemIds, { silent: true, autoPull: true })
        .then((imported) => {
          if (!imported.length) return;
          useEagle.setState({ dirtyIds: [] });
          const created = newEagleImports(imported, previousIds);
          if (created.length) toastOnce(`Eagle 端有 ${created.length} 个素材被更新，已自动导入为新版本（原版本保留在资产库）`, "ok");
        })
        .catch((e) => console.warn("[eagle] auto pull failed", e));
    }
  } catch (e) {
    pollBackoffMs = Math.min(55_000, (pollBackoffMs || 4000) * 2);
    const msg = errMsg(e);
    if (/连不上/.test(msg)) noticeOffline();
    else console.warn("[eagle] scan failed", msg);
  }
}

/* ---------------- 连接管理 ---------------- */

export async function detect(): Promise<{ ok: boolean; message: string }> {
  if (connecting) return connecting;
  connecting = detectOnce();
  try { return await connecting; } finally { connecting = null; }
}
async function detectOnce(): Promise<{ok:boolean;message:string}> {
  const c = cfg();
  if (!isTauriSupported()) {
    useEagle.setState({ connState: "disabled" });
    return { ok: false, message: "浏览器预览模式不支持桌面连接" };
  }
  if (!c.enabled) {
    useEagle.setState({ connState: "disabled" });
    return { ok: false, message: "Eagle 连接未启用" };
  }
  const recovering = useEagle.getState().connState !== "ready";
  useEagle.setState({ connState: "connecting" });
  const cli = new EagleClient(c.host, c.apiToken);
  try {
    const app = await cli.health();
    const lib = await cli.libraryInfo();
    useEagle.setState({
      connState: "ready",
      appInfo: app,
      library: lib,
      client: cli,
      libraryKey: libraryKeyOf(lib.path),
      bridgePort: useEagle.getState().bridgePort,
    });
    await startBridgeIfNeeded(lib);
    scheduleScan();
    await ensureRootFolder({ createIfMissing: true });
    useEagle.setState({ connectError: undefined });
    reconnectAt = 0;
    restoreEagleQueue();
    if (recovering && queue.size) {
      recoveredCount = queue.size;
      for (const job of queue.values()) { job.attempt = 0; job.queuedAt = Date.now(); }
      wakeQueue(200);
    }
    return { ok: true, message: `Eagle ${app.version} · 库「${lib.name}」(${lib.path})` };
  } catch (e) {
    const msg = errMsg(e);
    useEagle.setState({ connState: /连不上|超时/.test(msg) ? "offline" : "error", connectError: msg, client: null });
    return { ok: false, message: msg };
  }
}

/** 桥服务启动 + 缩略图目录登记（幂等） */
async function startBridgeIfNeeded(lib: EagleLibraryInfo) {
  if (!isTauriSupported()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const imagesDir = `${lib.path}${/[\\/]$/.test(lib.path) ? "" : "\\"}images`;
    const info = await invoke<{ port: number; token: string }>("eagle_bridge_start", { libraryImagesDir: imagesDir });
    useEagle.setState({ bridgePort: info.port, bridgeToken: info.token });
  } catch (e) {
    console.warn("[eagle] bridge start failed", e);
  }
}

/** Eagle 库内素材的展示 URL（走本地桥流式端点；Rust 按 itemId 定位真实文件，前端不经手路径） */
export function remoteThumbUrl(it: EagleRemoteItem): string | null {
  const st = useEagle.getState();
  if (!st.bridgePort || !st.bridgeToken) return null;
  return `http://127.0.0.1:${st.bridgePort}/v1/thumb?token=${encodeURIComponent(st.bridgeToken)}&itemId=${encodeURIComponent(it.id)}`;
}

/** 找到或创建 MOMO 根文件夹（按名称匹配即可满足首版；命中失败才新建，避免重复创建） */
export async function ensureRootFolder(opts: { createIfMissing: boolean }): Promise<string | null> {
  const st = useEagle.getState();
  const c = cfg();
  const want = c.rootFolderName.trim() || "MOMO";
  if (c.rootFolderId && st.library) {
    const found = findFolder(st.library.folders, c.rootFolderId);
    if (found) return found.id;
  }
  if (!st.library || !st.client) return null;
  const hit = searchFolder(st.library.folders, want);
  if (hit) {
    if (c.rootFolderId !== hit.id) useSettings.getState().update("eagle", { ...c, rootFolderId: hit.id });
    return hit.id;
  }
  if (!opts.createIfMissing) return null;
  const created = await st.client.createFolder({ name: want, description: "MOMO 智能画布资产同步根目录" });
  // 新建的根目录要让本地缓存到，否则下次还得全树搜
  const folders = [created as never, ...st.library.folders] as typeof st.library.folders;
  useEagle.setState({ library: { ...st.library!, folders } });
  useSettings.getState().update("eagle", { ...c, rootFolderId: created.id });
  return created.id;
}

type FolderNode = { id: string; name: string; children?: FolderNode[] };

function findFolder(nodes: FolderNode[], id: string): FolderNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const deep = n.children?.length ? findFolder(n.children, id) : null;
    if (deep) return deep;
  }
  return null;
}

function searchFolder(nodes: FolderNode[], name: string): FolderNode | null {
  for (const n of nodes) {
    if (n.name === name) return n;
    const deep = n.children?.length ? searchFolder(n.children, name) : null;
    if (deep) return deep;
  }
  return null;
}

/**
 * 解析资产落位文件夹（用户约定只留两层）：
 *   MOMO(根) / {画布名称} / 文件
 * 导演台参考 → MOMO / 导演台参考；没有归档信息的直接进根。
 */
async function resolveTargetFolder(item: AssetItem, _lib: EagleLibraryInfo): Promise<string | undefined> {
  const rootId = await ensureRootFolder({ createIfMissing: true });
  if (!rootId) return undefined;
  const st = useEagle.getState();
  if (!st.client || !st.library) return rootId;

  const dirName = item.director?.role === "reference" ? "导演台参考" : item.folderId ? folderNameOf(item.folderId) : "";
  if (!dirName) return rootId;
  const cached = useEagle.getState().folderMap[dirName];
  if (cached && findFolder(st.library.folders, cached)) return cached;

  // 根目录的直接子级：同名复用（只认根的直接孩子），没有才创建
  const root = findFolder(st.library.folders, rootId);
  const hit = root?.children?.find((ch) => ch.name === dirName);
  let folderId: string;
  if (hit) {
    folderId = hit.id;
  } else {
    const created = await st.client.createFolder({ name: dirName, parent: rootId });
    folderId = created.id;
    // 新建后把缓存库树补上这个孩子，避免下次重复建
    if (root) {
      root.children = [...(root.children ?? []), created];
      useEagle.setState({ library: st.library });
    }
  }
  useEagle.setState({ folderMap: { ...useEagle.getState().folderMap, [dirName]: folderId } });
  return folderId;

  function folderNameOf(fid: string): string {
    return useAssets.getState().folders.find((f) => f.id === fid)?.name ?? "未分类";
  }
}

/* ---------------- 工具杂项 ---------------- */

function isTauriSupported(): boolean {
  return isTauri;
}

function isTauriLocalPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\/.test(path);
}

/** 本机文件存在性（plugin-fs exists；浏览器模式直接 false） */
async function localFileExists(path: string): Promise<boolean> {
  if (!isTauri) return false;
  try {
    const { exists } = await import("@tauri-apps/plugin-fs");
    return await exists(path);
  } catch {
    return false;
  }
}

function noticeOffline() {
  useEagle.setState({ connState: "offline", client: null });
  reconnectAt = Date.now() + 30_000;
  wakeQueue(30_000);
}

function noticeFailure(msg: string, offline: boolean) {
  if (offline) {
    noticeOffline();
    return;
  }
  pushError("Eagle 资产桥", msg);
}

let lastToastAt = 0;
function toastOnce(msg: string, type: "info" | "ok" = "info") {
  const now = Date.now();
  if (now - lastToastAt < 10_000) return;
  lastToastAt = now;
  toast(msg, type);
}

/** 插件发来的动作统一入口：导入选中项 / 发送到画布 / 定位资产 */
export async function handleBridgeAction(payload: { kind: string; itemIds: string[]; target?: string }) {
  switch (payload.kind) {
    case "import-selection":
    case "send-to-canvas":
      await importEagleItems(payload.itemIds, { target: payload.target === "canvas" || payload.kind === "send-to-canvas" ? "canvas" : payload.target });
      break;
    case "open-asset": {
      const target = useAssets.getState().items.find((i) => i.eagle?.itemId === payload.itemIds[0]);
      if (!target) {
        toast("MOMO 里没有该 Eagle 素材的绑定副本", "err");
        return;
      }
      window.dispatchEvent(new CustomEvent("momo:focus-asset", { detail: { assetId: target.id } }));
      break;
    }
    default:
      break;
  }
}

/** 放到当前画布中央（插件 send-to-canvas 用） */
async function sendToCanvasCenter(asset: AssetItem) {
  try {
    if (asset.kind !== "image" && asset.kind !== "video" && asset.kind !== "audio") return;
    const board = (await import("./stores/boardStore")).useBoard.getState();
    const pos = screenCenterFlowPos(board);
    if (asset.kind === "video") {
      const { assetUrl } = await import("./services/assetFiles");
      board.addNode("video", pos, { src: assetUrl(asset.path), name: asset.name, status: "done" });
    } else {
      const { assetToDataUrl } = await import("./services/assetFiles");
      const src = await assetToDataUrl(asset.path, asset.mime);
      board.addNode("image", pos, { src, name: asset.name, status: "done" });
    }
    toast("已放入画布", "ok");
  } catch (e) {
    pushError("Eagle 资产桥", `放到画布失败:${errMsg(e)}`);
  }
}

function screenCenterFlowPos(_board: unknown): { x: number; y: number } {
  // 保守取一个可视中央近似值；精确换算需要 React Flow 实例（右键菜单路径已有）
  return { x: 80, y: 80 };
}
