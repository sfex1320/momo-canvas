/**
 * Comfy 工作流无感同步引擎（插件规格 v1.0 · M1：ComfyUI 主控单向同步）
 *
 * 数据流（规格 §11.2）：
 *   Rust watcher 事件 → 750ms 防抖 → scanSource 对账（含改名/移动识别）
 *   → syncOne（稳定性检测 → 哈希对比 → 分类 → 版本快照 → 正文入库 → API 派生 → 模板联动）
 *
 * 核心原则（规格 §5）：
 *  - 完整 UI Workflow 是主数据，API Prompt 只派生（存进派生的 ComfyTemplate）
 *  - 默认 comfy_master：MOMO 对源目录只读，绝不写回
 *  - 损坏/半写的文件标 invalid，旧版本与模板继续可用，绝不覆盖
 *  - 画布实例的参数覆盖值（ComfyData.params）与本引擎完全隔离，升级定义不碰实例
 */
import type {
  ComfySyncEventLog,
  ComfySyncSource,
  ComfySyncedWorkflow,
  ComfyTemplate,
  ComfyWfNode,
} from "../types";
import { useComfySync, newSyncSource } from "../stores/comfySyncStore";
import { useComfy } from "../stores/comfyStore";
import { useSettings } from "../stores/settingsStore";
import { toast } from "../stores/uiStore";
import { fetchObjectInfo, guessOutputNode, listWorkflowInputs, normalizeHost } from "../services/comfy";
import { convertFrontendWorkflow, isFrontendWorkflow } from "../../modules/comfy/frontendConvert";
import { autoExposeMap, paramsFromExpose, applyComfyLayout, saveTextFile } from "../../modules/comfy/templateIO";
import { isTauri, errMsg, uid } from "../utils";
import {
  classifyWorkflowText,
  type WfFormat,
  semanticHashOf,
  structureFingerprintOf,
  graphIdOf,
  isIgnoredRel,
  displayNameOfRel,
  computeRevisionKeep,
  dependencyWarnings,
} from "./classify";
import { normRel, normAbs, matchRenames, type NewFileRecord } from "./identity";
import { applyParamPatches, detectPatchConflicts, injectStableNodeIds, patchesFromValues, type ParamPatch, type UiGraph } from "./writeBack";
import { diffUiWorkflows, diffSummary } from "./workflowDiff";

/* ---------------- Rust 桥（仅桌面应用；浏览器预览整个引擎不启动） ---------------- */

type ScanEntry = { path: string; rel: string; size: number; mtimeMs: number };
type FileStatInfo = { exists: boolean; size: number; mtimeMs: number; sha256: string };
type RevisionInfo = { revision: number; origin: string; createdAt: number; size: number };

const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
};

const scanDir = (root: string, recursive: boolean) =>
  invoke<ScanEntry[]>("comfy_sync_scan", { root, recursive });
const hashFile = (path: string) => invoke<FileStatInfo>("comfy_sync_hash_file", { path });
const readFileText = (path: string) => invoke<string | null>("comfy_sync_read_file", { path });
const detectDirs = (root: string) => invoke<string[]>("comfy_sync_detect_dirs", { root });
const pathKind = (path: string) => invoke<string>("comfy_sync_path_kind", { path });
const watchDir = (sourceId: string, root: string, recursive: boolean) =>
  invoke<void>("comfy_sync_watch", { sourceId, root, recursive });
const unwatchDir = (sourceId: string) => invoke<void>("comfy_sync_unwatch", { sourceId });
const writeWorkflowFile = (workflowId: string, json: string) =>
  invoke<void>("comfy_sync_write_workflow", { workflowId, json });
const readWorkflowFile = (workflowId: string) =>
  invoke<string | null>("comfy_sync_read_workflow", { workflowId });
const writeRevisionFile = (workflowId: string, revision: number, origin: string, json: string) =>
  invoke<void>("comfy_sync_write_revision", { workflowId, revision, origin, json });
const listRevisions = (workflowId: string) => invoke<RevisionInfo[]>("comfy_sync_list_revisions", { workflowId });
const readRevisionFile = (workflowId: string, revision: number) =>
  invoke<string | null>("comfy_sync_read_revision", { workflowId, revision });
const deleteRevisions = (workflowId: string, keep: number[]) =>
  invoke<number>("comfy_sync_delete_revisions", { workflowId, keep });
const deleteWorkflowFiles = (workflowId: string) =>
  invoke<void>("comfy_sync_delete_workflow", { workflowId });
const writeSourceFile = (root: string, path: string, text: string) =>
  invoke<{ sha256: string; size: number; mtimeMs: number }>("comfy_sync_write_source", { root, path, text });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ---------------- 引擎内部状态 ---------------- */

const DEBOUNCE_MS = 750; // 规格 FR-004：防抖 750ms
const LOCAL_RESCAN_MS = 5 * 60 * 1000; // 本地完整复扫 5 分钟
const NET_RESCAN_MS = 60 * 1000; // 网络/移动盘快速复扫 60 秒
const OFFLINE_BACKOFF_STEPS = [5, 10, 20, 40, 60]; // 离线退避（秒，规格 FR-012 指数退避封顶 60s）
const OBJECT_INFO_TTL = 60_000;

const st = {
  started: false,
  unlisten: [] as (() => void)[],
  debounce: new Map<string, number>(), // sourceId → 防抖 timer
  periodic: new Map<string, number>(), // sourceId → 周期复扫 timer
  backoffStep: new Map<string, number>(), // sourceId → 退避档位
  watchFailed: new Set<string>(), // watcher 建立失败的来源（恢复在线时重试，规格 §12.2）
  /** M2 写入令牌（规格 §11.4）：自己写的文件监听回来时按 路径+内容哈希 匹配消费，不当外部修改 */
  writeTokens: new Map<string, { path: string; sha256: string; at: number }>(),
  queue: Promise.resolve() as Promise<unknown>,
  objectInfo: { at: 0, info: null as Record<string, any> | null },
};

/** 写入令牌有效期：超时的令牌不再抑制（防哈希碰撞巧合吞掉真实外部修改） */
const WRITE_TOKEN_TTL = 5 * 60 * 1000;

/** 全局串行队列：同步是「读源→写库→派生」的重活，串行最稳（规格 NFR-004 限并发） */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = st.queue.then(job, job);
  st.queue = run.catch(() => undefined);
  return run;
}

const sync = () => useComfySync.getState();
const log = (e: Omit<ComfySyncEventLog, "id" | "createdAt">) => sync().log(e);

async function objectInfoCached(): Promise<Record<string, any> | null> {
  const host = useSettings.getState().settings.comfy.host;
  if (!host) return null;
  if (st.objectInfo.info && Date.now() - st.objectInfo.at < OBJECT_INFO_TTL) return st.objectInfo.info;
  const info = await fetchObjectInfo(host);
  if (info) st.objectInfo = { at: Date.now(), info };
  return info;
}

/* ---------------- 启动 / 停止 ---------------- */

/** App 就绪后调用：恢复来源、监听文件事件（规格 M1 验收 15：重启后同步自动恢复） */
export async function startEngine(): Promise<void> {
  if (!isTauri || st.started) return;
  await sync().init();
  if (useSettings.getState().settings.comfy.syncV2Enabled === false) return; // 功能开关（规格 §16.3）
  st.started = true;
  sync().setRunning(true);
  const { listen } = await import("@tauri-apps/api/event");
  st.unlisten.push(
    await listen<{ sourceId: string }>("comfy-sync-fs-event", (e) => scheduleRescan(e.payload.sourceId)),
  );
  st.unlisten.push(
    await listen<{ sourceId: string; error: string }>("comfy-sync-watch-error", (e) => {
      // watcher 失效（UNC 断链常见）：交给复扫发现离线并退避（规格 §12.2）
      log({ sourceId: e.payload.sourceId, level: "warn", event: "watch_error", message: `目录监听中断（${e.payload.error}），转为定期复扫` });
      scheduleRescan(e.payload.sourceId);
    }),
  );
  // M3 同步桥：ComfyUI 里保存的即时通知（跳过防抖直接对账，网络盘也不等复扫）
  st.unlisten.push(
    await listen<{ path: string }>("comfy-bridge-save", (e) => {
      const rel = decodeURIComponent(e.payload.path || "");
      if (!rel) return;
      const hit = sync().workflows.find((w) => normRel(w.relativePath) === normRel(rel.replace(/^workflows\//, "")) || normAbs(w.absolutePath).endsWith(normAbs(rel)));
      if (hit) void enqueue(() => scanSource(hit.sourceId));
    }),
  );
  // 桥服务随引擎启停（幂等；端口候选 39871-39875，token 持久）
  void invoke<void>("comfy_bridge_start", {}).catch((e) => log({ level: "warn", event: "bridge_failed", message: `同步桥启动失败（不影响文件监听同步）：${errMsg(e)}` }));
  for (const s of sync().sources) if (s.enabled) void activateSource(s.id);
}

export function stopEngine(): void {
  if (!st.started) return;
  st.started = false;
  sync().setRunning(false);
  for (const u of st.unlisten) u();
  st.unlisten = [];
  for (const t of st.debounce.values()) clearTimeout(t);
  for (const t of st.periodic.values()) clearInterval(t);
  st.debounce.clear();
  st.periodic.clear();
  for (const s of sync().sources) void unwatchDir(s.id).catch(() => undefined);
  void invoke<void>("comfy_bridge_stop", {}).catch(() => undefined);
}

/* ---------------- 来源管理（规格 FR-001 / §6.3） ---------------- */

/** 探测给定目录下的候选 workflows 目录（可能多个，UI 让用户勾选） */
export async function detectWorkflowDirs(root: string): Promise<string[]> {
  if (!isTauri) return [];
  return detectDirs(root);
}

export async function pathKindOf(root: string): Promise<ComfySyncSource["kind"]> {
  if (!isTauri) return "local";
  const k = await pathKind(root);
  return (["local", "removable", "mapped_drive", "unc"] as const).includes(k as any)
    ? (k as ComfySyncSource["kind"])
    : "local";
}

/** 添加来源并立即首扫（首扫只列候选不自动入库，规格 FR-003） */
export async function addSource(input: { rootPath: string; name?: string; autoTrack?: boolean }): Promise<ComfySyncSource> {
  // 同一目录重复添加会让每个文件长出两套记录/模板——直接拦下
  const dup = sync().sources.find((s) => normAbs(s.rootPath) === normAbs(input.rootPath));
  if (dup) throw new Error(`这个目录已经是来源「${dup.name}」了——同一目录只能有一个来源`);
  const kind = await pathKindOf(input.rootPath);
  const src = newSyncSource(input.rootPath, input.name || defaultSourceName(input.rootPath, kind), kind);
  if (input.autoTrack !== undefined) src.autoTrackNewWorkflows = input.autoTrack;
  sync().upsertSource(src);
  log({ sourceId: src.id, level: "info", event: "source_added", message: `已添加来源「${src.name}」` });
  if (st.started) void activateSource(src.id);
  else await scanSource(src.id); // 引擎未启动（如开关关闭时在 UI 手动加）：仍完成一次首扫列出候选
  return src;
}

function defaultSourceName(rootPath: string, kind: ComfySyncSource["kind"]): string {
  const seg = rootPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? rootPath;
  const kindLabel = kind === "unc" ? "网络共享" : kind === "mapped_drive" ? "映射盘" : kind === "removable" ? "移动盘" : "本机";
  return `${kindLabel} · ${seg === "workflows" ? "ComfyUI 工作流" : seg}`;
}

/** 修改来源设置（递归/自动跟踪/忽略规则等）。只有影响监听的字段（路径/递归/启用）才重启 watcher，
 *  否则改个名字每敲一个字都会全量重扫 */
export async function updateSource(id: string, patch: Partial<ComfySyncSource>): Promise<void> {
  const cur = sync().sources.find((s) => s.id === id);
  if (!cur) return;
  sync().patchSource(id, patch);
  if (!st.started) return;
  const restartKeys = new Set(["rootPath", "includeSubdirectories", "enabled"]);
  const structural = Object.keys(patch).some((k) => restartKeys.has(k));
  if (!structural) return;
  const next = { ...cur, ...patch };
  if (next.enabled) void activateSource(id);
  else void deactivateSource(id);
}

/** 暂停来源：停监听停复扫，数据保留 */
export async function pauseSource(id: string): Promise<void> {
  sync().patchSource(id, { enabled: false });
  if (st.started) await deactivateSource(id);
}

export async function resumeSource(id: string): Promise<void> {
  sync().patchSource(id, { enabled: true, status: "scanning" });
  if (st.started) await activateSource(id);
  else await scanSource(id);
}

/** 删除来源：工作流改挂 detached（保留正文/模板/画布实例，规格 FR-001） */
export async function removeSource(id: string): Promise<void> {
  await deactivateSource(id);
  sync().removeSource(id); // store 内部会把该来源的工作流标 detached
  log({ sourceId: id, level: "info", event: "source_removed", message: "来源已删除，已同步的工作流保留为本地副本" });
}

async function activateSource(id: string): Promise<void> {
  const src = sync().sources.find((s) => s.id === id);
  if (!src || !src.enabled) return;
  st.backoffStep.delete(id);
  // 周期复扫：本地 5 分钟，网络/移动盘 60 秒（规格 FR-004）
  clearInterval(st.periodic.get(id));
  st.periodic.set(
    id,
    window.setInterval(() => scheduleRescan(id), src.kind === "local" ? LOCAL_RESCAN_MS : NET_RESCAN_MS),
  );
  void watchDir(id, src.rootPath, src.includeSubdirectories)
    .then(() => {
      st.watchFailed.delete(id);
      sync().patchSource(id, { status: "online" });
    })
    .catch((e) => {
      st.watchFailed.add(id);
      log({ sourceId: id, level: "warn", event: "watch_failed", message: `目录监听未建立，走定期复扫：${errMsg(e)}` });
    });
  await enqueue(() => scanSource(id));
}

async function deactivateSource(id: string): Promise<void> {
  const t1 = st.debounce.get(id);
  if (t1) clearTimeout(t1);
  st.debounce.delete(id);
  const t2 = st.periodic.get(id);
  if (t2) clearInterval(t2);
  st.periodic.delete(id);
  await unwatchDir(id).catch(() => undefined);
}

function scheduleRescan(sourceId: string): void {
  const src = sync().sources.find((s) => s.id === sourceId);
  if (!src?.enabled || !st.started) return;
  const old = st.debounce.get(sourceId);
  if (old) clearTimeout(old);
  st.debounce.set(
    sourceId,
    window.setTimeout(() => {
      st.debounce.delete(sourceId);
      void enqueue(() => scanSource(sourceId));
    }, DEBOUNCE_MS),
  );
}

/** 离线退避复扫：5→10→20→40→60s 封顶循环，恢复在线立即归零（规格 FR-012） */
function scheduleOfflineRetry(sourceId: string): void {
  const src = sync().sources.find((s) => s.id === sourceId);
  if (!src?.enabled || !st.started) return;
  const step = Math.min((st.backoffStep.get(sourceId) ?? 0), OFFLINE_BACKOFF_STEPS.length - 1);
  const delay = OFFLINE_BACKOFF_STEPS[step] * 1000;
  st.backoffStep.set(sourceId, step + 1);
  const old = st.debounce.get(sourceId);
  if (old) clearTimeout(old);
  st.debounce.set(
    sourceId,
    window.setTimeout(() => {
      st.debounce.delete(sourceId);
      void enqueue(() => scanSource(sourceId));
    }, delay),
  );
}

/* ---------------- 对账扫描（含改名/移动识别，规格 FR-006/FR-007） ---------------- */

async function scanSource(sourceId: string): Promise<void> {
  const src = sync().sources.find((s) => s.id === sourceId);
  if (!src || !src.enabled) return;
  const firstScan = src.lastScanAt === undefined;
  // ComfyUI 上线补派生（派生失败的工作流重试一次，规格 §5.2）
  void rederivePending();
  sync().patchSource(sourceId, { status: "scanning" });

  let entries: ScanEntry[];
  try {
    entries = await scanDir(src.rootPath, src.includeSubdirectories);
  } catch (e) {
    const msg = errMsg(e);
    const offline = msg.startsWith("SYNC_SOURCE_OFFLINE");
    sync().patchSource(sourceId, { status: offline ? "offline" : "permission_denied" });
    // 离线绝不判删除（规格 FR-012）；正常态工作流标 source_offline（derive_failed 等自身带警告的状态保留原样）
    if (offline) {
      for (const w of sync().workflows) {
        if (w.sourceId === sourceId && (w.status === "synced" || w.status === "source_changed" || w.status === "syncing")) {
          sync().patchWorkflow(w.workflowId, { status: "source_offline" });
        }
      }
    }
    log({ sourceId, level: offline ? "info" : "error", event: offline ? "source_offline" : "source_denied", message: offline ? `来源离线：${src.name}（保留最后正常版本）` : `来源目录被拒绝访问：${msg}` });
    if (offline) scheduleOfflineRetry(sourceId);
    return;
  }
  st.backoffStep.delete(sourceId);
  sync().patchSource(sourceId, { status: "online", lastScanAt: Date.now(), lastOnlineAt: Date.now() });
  // 来源恢复在线（离线期间 watcher 建立失败过）：补建监听，事件驱动的低延迟同步才能回来
  if (st.watchFailed.has(sourceId)) {
    const s = sync().sources.find((x) => x.id === sourceId);
    if (s) {
      void watchDir(sourceId, s.rootPath, s.includeSubdirectories)
        .then(() => st.watchFailed.delete(sourceId))
        .catch(() => undefined); // 再失败就继续靠周期复扫，下次扫描再试
    }
  }

  const jsonEntries = entries.filter((e) => /\.json$/i.test(e.rel) && !isIgnoredRel(e.rel, src.ignorePatterns));
  const byNormRel = new Map<string, ScanEntry>();
  for (const e of jsonEntries) if (!byNormRel.has(normRel(e.rel))) byNormRel.set(normRel(e.rel), e);

  const mine = sync().workflows.filter((w) => w.sourceId === sourceId && w.status !== "detached");

  // 1) 已跟踪：路径还在 → stat 变了就同步；路径没了 → 进入改名对账
  const gone: ComfySyncedWorkflow[] = [];
  for (const w of mine) {
    const e = byNormRel.get(normRel(w.relativePath));
    if (!e) {
      gone.push(w);
      continue;
    }
    if (w.status === "untracked") continue; // 未勾选的只列不改
    if (e.size === w.statSize && e.mtimeMs === w.statMtimeMs && w.sourceHash) {
      // 来源恢复在线且内容没变：把离线标记收敛回 synced
      if (w.status === "source_offline") sync().patchWorkflow(w.workflowId, { status: "synced" });
      continue; // 没动
    }
    if (w.policy === "manual") {
      if (w.status !== "source_changed") sync().patchWorkflow(w.workflowId, { status: "source_changed" });
      continue; // 手动模式只标记（规格 §8）
    }
    await syncOne(w.workflowId, e);
  }

  // 2) 新文件（未被任何记录占用）
  const knownRels = new Set(mine.map((w) => normRel(w.relativePath)));
  let fresh = jsonEntries.filter((e) => !knownRels.has(normRel(e.rel)));

  // 未勾选过的占位记录：源没了直接清掉（没有入库数据可保）
  const goneTracked = gone.filter((g) => {
    if (g.status === "untracked") {
      sync().removeWorkflow(g.workflowId);
      return false;
    }
    return true;
  });

  // 3) 改名/移动识别：消失记录 × 新文件 一对一配对（规格 FR-007：不产生重复模板）
  if (goneTracked.length && fresh.length) {
    const freshSignals: NewFileRecord[] = [];
    for (const f of fresh.slice(0, 300)) {
      const sig = await signalsOfPath(f.path);
      if (sig) freshSignals.push({ rel: normRel(f.rel), ...sig });
    }
    const matches = matchRenames(
      goneTracked.map((g) => ({
        workflowId: g.workflowId,
        graphId: g.graphId,
        semanticHash: g.semanticHash,
        structureFingerprint: g.structureFingerprint,
      })),
      freshSignals,
    );
    const matchedRels = new Set(matches.map((m) => m.rel));
    const matchedIds = new Set(matches.map((m) => m.workflowId));
    for (const m of matches) {
      const w = sync().workflows.find((x) => x.workflowId === m.workflowId);
      const e = byNormRel.get(m.rel);
      if (!w || !e) continue;
      const oldName = w.displayName;
      sync().patchWorkflow(w.workflowId, { status: "syncing" });
      await syncOne(w.workflowId, e);
      log({
        workflowId: w.workflowId,
        sourceId,
        level: "info",
        event: "renamed",
        message: `「${oldName}」在来源里改名/移动为「${displayNameOfRel(e.rel)}」，已保持同一工作流继续跟踪`,
      });
    }
    for (const g of goneTracked.filter((x) => !matchedIds.has(x.workflowId))) {
      // 真删了：快照/模板/画布全保留（规格 FR-011）
      if (g.status !== "source_deleted") {
        sync().patchWorkflow(g.workflowId, { status: "source_deleted" });
        log({ workflowId: g.workflowId, sourceId, level: "warn", event: "source_deleted", message: `「${g.displayName}」的源文件已被删除（MOMO 数据保留，可恢复历史版本）` });
      }
    }
    fresh = fresh.filter((f) => !matchedRels.has(normRel(f.rel)));
  } else if (goneTracked.length) {
    for (const g of goneTracked) {
      if (g.status !== "source_deleted") {
        sync().patchWorkflow(g.workflowId, { status: "source_deleted" });
        log({ workflowId: g.workflowId, sourceId, level: "warn", event: "source_deleted", message: `「${g.displayName}」的源文件已被删除（MOMO 数据保留）` });
      }
    }
  }

  // 4) 新增文件：首扫一律只列候选；此后新增按 autoTrack 决定（规格 FR-003）
  for (const f of fresh) {
    const exists = sync().workflows.some((w) => w.sourceId === sourceId && normRel(w.relativePath) === normRel(f.rel));
    if (exists) continue;
    const auto = !firstScan && src.autoTrackNewWorkflows;
    const rec: ComfySyncedWorkflow = {
      workflowId: `wf_${uid(10)}`,
      sourceId,
      relativePath: f.rel,
      absolutePath: f.path,
      displayName: displayNameOfRel(f.rel),
      format: "ui_v04", // 占位，syncOne 后修正
      policy: src.defaultPolicy,
      status: auto ? "pending_import" : "untracked",
      sourceHash: "",
      baseHash: "",
      revision: 0,
      sourceModifiedAt: f.mtimeMs,
      statSize: f.size,
      statMtimeMs: f.mtimeMs,
      warnings: [],
    };
    sync().upsertWorkflow(rec);
    if (auto) await syncOne(rec.workflowId, f);
  }
}

/** 读文件提取身份信号（改名对账用；读不动返回 null） */
async function signalsOfPath(path: string): Promise<{ graphId?: string; semanticHash?: string; structureFingerprint?: string } | null> {
  try {
    const text = await readFileText(path);
    if (!text) return null;
    const cls = classifyWorkflowText(text);
    if (cls.format !== "ui_v04" && cls.format !== "api_only") return null;
    return {
      graphId: graphIdOf(cls.json),
      semanticHash: semanticHashOf(cls.json),
      structureFingerprint: structureFingerprintOf(cls.json),
    };
  } catch {
    return null;
  }
}

/* ---------------- 单个工作流同步管线（规格 FR-005 / FR-008） ---------------- */

async function syncOne(workflowId: string, entry: ScanEntry): Promise<void> {
  const w0 = sync().workflows.find((x) => x.workflowId === workflowId);
  if (!w0) return;
  const prevStatus = w0.status;
  sync().patchWorkflow(workflowId, { status: "syncing" });
  try {
    // 稳定性检测（规格 FR-005）：间隔 200ms 两次 stat 一致才读正文
    let stat = await stableStat(entry.path);
    if (!stat) {
      sync().patchWorkflow(workflowId, { status: "source_deleted", absolutePath: entry.path });
      return;
    }
    // 自身写入抑制（规格 §11.4）：这次「变化」是我们自己写回的文件——消费令牌，对齐 stat 即收工
    const token = st.writeTokens.get(workflowId);
    if (token && Date.now() - token.at < WRITE_TOKEN_TTL && token.path === entry.path && stat.sha256 === token.sha256) {
      st.writeTokens.delete(workflowId);
      sync().patchWorkflow(workflowId, { status: "synced", statSize: stat.size, statMtimeMs: stat.mtimeMs });
      return;
    }
    if (stat.sha256 === w0.sourceHash && w0.sourceHash) {
      // 内容与基线一致（可能只是 touch / 离线恢复 / 文件从损坏回到上一次正常版本）。
      // derive_failed 必须保持（派生还没成功，等 rederivePending 补）；
      // invalid 清除并清警告（内容已回到正常基线）；其余收敛为 synced
      sync().patchWorkflow(workflowId, {
        status: w0.status === "derive_failed" ? "derive_failed" : "synced",
        warnings: w0.status === "invalid" ? [] : w0.warnings,
        statSize: stat.size,
        statMtimeMs: stat.mtimeMs,
      });
      return;
    }
    // 读取 + 分类；invalid 按 300/600/1200ms 重试（规格 FR-005）
    let text: string | null = null;
    let cls: { format: WfFormat; json?: unknown; error?: string } = { format: "invalid", error: "" };
    for (const delay of [0, 300, 600, 1200]) {
      if (delay) await sleep(delay);
      text = await readFileText(entry.path);
      if (text === null) {
        sync().patchWorkflow(workflowId, { status: "source_deleted", absolutePath: entry.path });
        return;
      }
      cls = classifyWorkflowText(text);
      if (cls.format === "ui_v04" || cls.format === "api_only") break;
    }
    if (cls.format === "invalid" || cls.format === "momo_pack") {
      // 旧版本/模板一律保留，绝不覆盖（规格 FR-005 第 6 条 / §5.2）
      const reason =
        cls.format === "momo_pack" ? "MOMO 模板包不参与同步（请到模板管理导入）" : cls.error || "无法解析的 JSON";
      sync().patchWorkflow(workflowId, {
        status: "invalid",
        statSize: stat.size,
        statMtimeMs: stat.mtimeMs,
        warnings: [reason],
      });
      log({ workflowId, sourceId: w0.sourceId, level: "warn", event: "invalid", message: `「${w0.displayName}」当前内容无效（${reason}），继续使用上一次正常版本` });
      return;
    }
    const json = cls.json!;
    const rev = w0.revision + 1;
    // 版本快照 + 当前正文（先快照后正文；写失败抛错整体放弃，不留半套数据）
    await writeRevisionFile(workflowId, rev, "source", text!);
    await writeWorkflowFile(workflowId, text!);
    // API Prompt 派生 + 模板联动（规格 §5.2：派生失败不得损坏已入库的 UI Workflow）
    const derive = await deriveAndApplyTemplate(workflowId, w0, cls.format, json, displayNameOfRel(entry.rel));
    sync().patchWorkflow(workflowId, {
      status: derive.ok ? "synced" : "derive_failed",
      format: cls.format,
      sourceHash: stat.sha256,
      baseHash: stat.sha256,
      semanticHash: semanticHashOf(json),
      structureFingerprint: structureFingerprintOf(json),
      graphId: graphIdOf(json),
      revision: rev,
      sourceModifiedAt: stat.mtimeMs,
      syncedAt: Date.now(),
      statSize: stat.size,
      statMtimeMs: stat.mtimeMs,
      relativePath: entry.rel,
      absolutePath: entry.path,
      displayName: displayNameOfRel(entry.rel),
      warnings: derive.warnings,
      templateId: derive.templateId ?? w0.templateId,
      // 三方合并基线（规格 FR-015）：本次源内容里各参数的真实值，写回 diff 以它为准
      baseParamValues: derive.baseParamValues ?? w0.baseParamValues,
    });
    if (derive.ok) {
      log({ workflowId, sourceId: w0.sourceId, level: "info", event: "synced", message: `「${displayNameOfRel(entry.rel)}」已同步（版本 ${rev}${derive.note ? `，${derive.note}` : ""}）` });
    } else {
      log({ workflowId, sourceId: w0.sourceId, level: "warn", event: "derive_failed", message: `「${displayNameOfRel(entry.rel)}」已入库，但派生失败：${derive.error}` });
    }
    void pruneRevisions(workflowId);
  } catch (e) {
    sync().patchWorkflow(workflowId, { status: prevStatus, warnings: [errMsg(e)] });
    log({ workflowId, sourceId: w0.sourceId, level: "error", event: "sync_failed", message: `「${w0.displayName}」同步失败：${errMsg(e)}` });
  }
}

/** 两次 stat（间隔 200ms）一致才认为文件写完了；连续 3 轮不稳定返回最后一次 */
async function stableStat(path: string): Promise<FileStatInfo | null> {
  for (let i = 0; i < 3; i++) {
    const a = await hashFile(path).catch(() => null);
    if (!a?.exists) return null;
    await sleep(200);
    const b = await hashFile(path).catch(() => null);
    if (!b?.exists) return null;
    if (a.size === b.size && a.mtimeMs === b.mtimeMs) return b;
  }
  const last = await hashFile(path).catch(() => null);
  return last?.exists ? last : null;
}

/* ---------------- API 派生与模板联动（规格 FR-008 第 6-8 步 / FR-009） ---------------- */

type DeriveResult = { ok: boolean; templateId?: string; warnings: string[]; error?: string; note?: string; baseParamValues?: Record<string, unknown> };

/** API 派生结果里各参数的真实值（key=`nodeId.input`，连线值跳过）——写回三方合并的共同基线 */
function apiParamValues(apiWf: Record<string, ComfyWfNode>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, n] of Object.entries(apiWf)) {
    for (const [k, v] of Object.entries(n.inputs ?? {})) {
      if (Array.isArray(v)) continue; // 连线
      out[`${id}.${k}`] = v;
    }
  }
  return out;
}

async function deriveAndApplyTemplate(
  workflowId: string,
  rec: ComfySyncedWorkflow,
  format: "ui_v04" | "api_only",
  json: unknown,
  displayName: string,
): Promise<DeriveResult> {
  let apiWf: Record<string, ComfyWfNode>;
  const warnings: string[] = [];
  if (format === "api_only") {
    apiWf = json as Record<string, ComfyWfNode>;
    warnings.push("API 格式文件：无画布布局信息（API-only，不可写回）");
    apiWf = applyComfyLayout(apiWf);
  } else {
    const info = await objectInfoCached();
    if (!info) {
      return { ok: false, warnings, error: "SYNC_API_DERIVE_FAILED: ComfyUI 离线，暂无法派生 API Prompt（工作流已安全入库，ComfyUI 上线后自动补）" };
    }
    try {
      const r = convertFrontendWorkflow(json as any, info);
      apiWf = r.workflow;
      warnings.push(...r.warnings);
      apiWf = applyComfyLayout(apiWf, info);
      // 依赖检查（规格 FR-016）：缺失自定义节点/模型只进警告，不阻塞同步与版本保存
      warnings.push(...dependencyWarnings(json as { nodes: Array<{ id: number | string; type: string; widgets_values?: unknown[] }> }, info));
    } catch (e) {
      return { ok: false, warnings, error: `SYNC_API_DERIVE_FAILED: ${errMsg(e)}` };
    }
  }
  const baseParamValues = apiParamValues(apiWf);
  // 模板联动：优先记录里的 templateId，其次按 workflowId 找（模板可能被手工绑定，规格 §16.2）
  const comfyStore = useComfy.getState();
  let tpl = rec.templateId ? comfyStore.templates.find((t) => t.id === rec.templateId) : undefined;
  tpl ??= comfyStore.templates.find((t) => t.workflowId === workflowId);
  let note = "";
  if (!tpl) {
    tpl = {
      id: uid(8),
      name: displayName,
      workflow: apiWf,
      params: paramsFromExpose(apiWf, autoExposeMap(listWorkflowInputs(apiWf))),
      outputNodeId: guessOutputNode(apiWf),
      createdAt: Date.now(),
      workflowId,
    };
    note = "已创建画布模板";
  } else {
    const merged = mergeSyncedTemplate(tpl, apiWf, displayName, rec.baseParamValues ?? {});
    if (merged.droppedParams) note = `${merged.droppedParams} 个失效参数已从定义移除（画布实例的覆盖值不受影响）`;
    tpl = merged.tpl;
  }
  useComfy.getState().upsert(tpl);
  return { ok: true, templateId: tpl.id, warnings, note, baseParamValues };
}

/**
 * 同步模板合并（规格 FR-009 实例参数保护 + FR-015 三方语义）：
 *  - workflow / 参数定义来源换新；失效输入（节点没了 / 输入转成连线）剔除
 *  - 参数 value：用户没改过（=== 旧基线）→ 跟随源文件新值；改过 → 保留用户值（成为待写回补丁）
 *  - variants 是用户手工配置的分支：default 分支跟随源整体更新，自定义分支只剔除失效节点
 *  - 画布实例（ComfyData.params）完全不经手——覆盖值天然保留
 */
function mergeSyncedTemplate(
  tpl: ComfyTemplate,
  apiWf: Record<string, ComfyWfNode>,
  displayName: string,
  baseValues: Record<string, unknown>,
): { tpl: ComfyTemplate; droppedParams: number } {
  const params: ComfyTemplate["params"] = [];
  let dropped = 0;
  for (const p of tpl.params) {
    const n = apiWf[p.nodeId];
    const cur = n?.inputs?.[p.input];
    if (!n || !(p.input in (n.inputs ?? {})) || Array.isArray(cur)) {
      dropped++; // 节点没了 / 输入转成连线：定义移除（孤儿由画布侧灰显提示）
      continue;
    }
    const base = baseValues[p.key];
    const userChanged = base !== undefined && JSON.stringify(p.value) !== JSON.stringify(base);
    params.push(userChanged ? p : { ...p, value: cur as typeof p.value });
  }
  const outputNodeId = tpl.outputNodeId && apiWf[tpl.outputNodeId] ? tpl.outputNodeId : guessOutputNode(apiWf);
  const disabledNodes = tpl.disabledNodes?.filter((id) => apiWf[id]);
  // 分支节点集：default 分支跟随源文件整体更新（nodeIds/outputNodeIds/params 与顶层同步，同 normalizeTemplate 语义）；
  // 用户自定义分支保守剔除失效 id（新增节点由用户自己决定是否加入）
  const variants = tpl.variants?.map((v) => {
    if (v.id !== "default") return { ...v, nodeIds: v.nodeIds.filter((id) => apiWf[id]) };
    return { ...v, nodeIds: Object.keys(apiWf), outputNodeIds: outputNodeId ? [outputNodeId] : [], params, disabledNodes };
  });
  return {
    tpl: { ...tpl, name: displayName, workflow: apiWf, params, outputNodeId, disabledNodes, ...(variants ? { variants } : {}) },
    droppedParams: dropped,
  };
}

/* ---------------- 用户操作（同步中心 UI 调用） ---------------- */

/** 勾选同步 untracked 工作流（规格 FR-003） */
export async function trackWorkflows(ids: string[]): Promise<void> {
  let ok = 0;
  for (const id of ids) {
    const w = sync().workflows.find((x) => x.workflowId === id);
    if (!w) continue;
    const src = sync().sources.find((s) => s.id === w.sourceId);
    if (!src) continue;
    const entry: ScanEntry = {
      path: joinPath(src.rootPath, w.relativePath),
      rel: w.relativePath,
      size: w.statSize ?? 0,
      mtimeMs: w.sourceModifiedAt,
    };
    sync().patchWorkflow(id, { status: "pending_import" });
    await enqueue(() => syncOne(id, entry));
    const after = sync().workflows.find((x) => x.workflowId === id);
    if (after && (after.status === "synced" || after.status === "derive_failed")) ok++;
  }
  if (ok) toast(`Comfy 同步：${ok} 套工作流已入库${ids.length - ok ? `，${ids.length - ok} 套失败（见事件记录）` : ""}`, "ok");
}

/** 解除关联：删本地同步数据，模板脱钩保留为普通模板，画布实例不动 */
export async function untrackWorkflow(id: string): Promise<void> {
  const w = sync().workflows.find((x) => x.workflowId === id);
  if (!w) return;
  const comfyStore = useComfy.getState();
  const tpl = comfyStore.templates.find((t) => t.workflowId === id);
  if (tpl) comfyStore.upsert({ ...tpl, workflowId: undefined });
  await deleteWorkflowFiles(id).catch(() => undefined);
  sync().removeWorkflow(id);
  log({ workflowId: id, level: "info", event: "untracked", message: `「${w.displayName}」已解除关联（模板与画布实例保留）` });
}

export async function setWorkflowPolicy(id: string, policy: ComfySyncedWorkflow["policy"]): Promise<void> {
  sync().patchWorkflow(id, { policy });
}

export async function togglePinRevision(workflowId: string, revision: number): Promise<void> {
  const w = sync().workflows.find((x) => x.workflowId === workflowId);
  if (!w) return;
  const pinned = new Set(w.pinnedRevisions ?? []);
  if (pinned.has(revision)) pinned.delete(revision);
  else pinned.add(revision);
  sync().patchWorkflow(workflowId, { pinnedRevisions: [...pinned] });
}

/** 版本列表（规格 FR-013；pin 状态合并在记录里） */
export async function listWorkflowRevisions(workflowId: string): Promise<(RevisionInfo & { pinned: boolean })[]> {
  const w = sync().workflows.find((x) => x.workflowId === workflowId);
  const revs = await listRevisions(workflowId);
  const pinned = new Set(w?.pinnedRevisions ?? []);
  return revs.map((r) => ({ ...r, pinned: pinned.has(r.revision) }));
}

/** 恢复历史版本：写回 MOMO 本地正文并重新派生模板；不碰源文件（comfy_master 只读，规格 §8） */
export async function restoreRevision(workflowId: string, revision: number): Promise<void> {
  const w = sync().workflows.find((x) => x.workflowId === workflowId);
  if (!w) throw new Error("工作流记录不存在");
  const text = await readRevisionFile(workflowId, revision);
  if (text === null) throw new Error(`版本 ${revision} 的快照不存在`);
  const cls = classifyWorkflowText(text);
  if (cls.format !== "ui_v04" && cls.format !== "api_only") throw new Error(`版本 ${revision} 内容无效：${cls.error}`);
  const rev = w.revision + 1;
  await writeRevisionFile(workflowId, rev, "restore", text);
  await writeWorkflowFile(workflowId, text);
  const derive = await deriveAndApplyTemplate(workflowId, w, cls.format, cls.json!, displayNameOfRel(w.relativePath));
  sync().patchWorkflow(workflowId, {
    revision: rev,
    syncedAt: Date.now(),
    status: derive.ok ? "synced" : "derive_failed",
    warnings: derive.warnings,
    templateId: derive.templateId ?? w.templateId,
  });
  log({ workflowId, level: "info", event: "restored", message: `「${w.displayName}」已恢复到版本 ${revision}（源文件未改动）` });
  void pruneRevisions(workflowId);
}

/** 「保留为 MOMO 本地副本」：清掉 source_deleted 的源信息，数据转正（规格 FR-011） */
export function keepLocalCopy(workflowId: string): void {
  const w = sync().workflows.find((x) => x.workflowId === workflowId);
  if (!w) return;
  sync().patchWorkflow(workflowId, { status: "detached" });
  log({ workflowId, level: "info", event: "kept_local", message: `「${w.displayName}」已保留为 MOMO 本地副本（不再跟踪源文件）` });
}

/** 把同步工作流绑定到现有模板（旧数据迁移入口，规格 §16.2 流程 4） */
export async function bindWorkflowToTemplate(workflowId: string, templateId: string): Promise<void> {
  const w = sync().workflows.find((x) => x.workflowId === workflowId);
  const tpl = useComfy.getState().templates.find((t) => t.id === templateId);
  if (!w || !tpl) return;
  useComfy.getState().upsert({ ...tpl, workflowId });
  sync().patchWorkflow(workflowId, { templateId });
  log({ workflowId, level: "info", event: "bound", message: `「${w.displayName}」已关联模板「${tpl.name}」，此后源文件更新会自动跟` });
}

/** 立即扫描某来源（同步中心「立即扫描」） */
export async function rescanSourceNow(sourceId: string): Promise<void> {
  await enqueue(() => scanSource(sourceId));
  const src = sync().sources.find((s) => s.id === sourceId);
  if (src && src.status === "online") toast(`来源「${src.name}」扫描完成`, "ok");
}

/** ComfyUI 上线后补派生（derive_failed 的工作流重试；扫描与设置保存时可调，规格 §5.2） */
export async function rederivePending(): Promise<void> {
  const pending = sync().workflows.filter((w) => w.status === "derive_failed");
  if (!pending.length) return;
  if (!useSettings.getState().settings.comfy.host) return;
  const info = await objectInfoCached();
  if (!info) return;
  for (const w of pending) {
    const text = await readWorkflowFile(w.workflowId).catch(() => null);
    if (!text) continue;
    const cls = classifyWorkflowText(text);
    if (cls.format !== "ui_v04" && cls.format !== "api_only") continue;
    const derive = await deriveAndApplyTemplate(w.workflowId, w, cls.format, cls.json!, w.displayName);
    if (derive.ok) {
      sync().patchWorkflow(w.workflowId, { status: "synced", warnings: derive.warnings, templateId: derive.templateId ?? w.templateId });
      log({ workflowId: w.workflowId, level: "info", event: "rederived", message: `「${w.displayName}」已在 ComfyUI 在线后完成派生` });
    }
  }
}

/* ---------------- 内部工具 ---------------- */

/** 版本保留策略清理（规格 FR-013：最近20 + 7天内 + pinned；当前版本永不删） */
async function pruneRevisions(workflowId: string): Promise<void> {
  try {
    const w = sync().workflows.find((x) => x.workflowId === workflowId);
    const revs = await listRevisions(workflowId);
    const pinned = new Set(w?.pinnedRevisions ?? []);
    const keep = computeRevisionKeep(revs.map((r) => ({ revision: r.revision, createdAt: r.createdAt, pinned: pinned.has(r.revision) })));
    const toDelete = revs.filter((r) => !keep.includes(r.revision));
    if (toDelete.length) await deleteRevisions(workflowId, keep);
  } catch {
    /* 清理失败不影响同步主流程，下次再试 */
  }
}

function joinPath(root: string, rel: string): string {
  return `${root.replace(/[\\/]+$/, "")}\\${rel.replace(/\//g, "\\")}`;
}

/* ================= M2：双向写回（规格 FR-010 / §11.3 / §11.4） ================= */

const isWriteAllowed = (w: ComfySyncedWorkflow, src?: ComfySyncSource): boolean =>
  (w.policy === "bidirectional" || w.policy === "momo_master") && !!src && src.allowWriteBack;

/** 开启双向（用户在同步中心确认后调用）：工作流转 bidirectional + 来源授权写回 */
export async function enableBidirectional(workflowId: string): Promise<void> {
  const w = sync().workflows.find((x) => x.workflowId === workflowId);
  if (!w) return;
  sync().patchWorkflow(workflowId, { policy: "bidirectional" });
  const src = sync().sources.find((s) => s.id === w.sourceId);
  if (src && !src.allowWriteBack) sync().patchSource(src.id, { allowWriteBack: true });
  log({ workflowId, sourceId: w.sourceId, level: "info", event: "bidirectional_on", message: `「${w.displayName}」已开启双向同步：MOMO 里保存参数会写回源文件` });
}

/**
 * 把模板参数改动写回源文件（规格 §11.3 伪代码的落地）：
 *  读源 → 哈希比对 → 未变则最小补丁 / 变了则字段级冲突检测 → 首次写回注入稳定 ID
 *  → 同目录临时文件原子替换 → 写入令牌抑制自己的监听事件 → MOMO 侧账本对齐。
 * force=true 跳过冲突检测（「使用 MOMO 值」的冲突解决路径）。
 */
export async function writeBackWorkflow(
  workflowId: string,
  opts?: { force?: boolean },
): Promise<{ ok: boolean; reason?: string; conflicts?: number }> {
  return enqueue(async () => {
    const w = sync().workflows.find((x) => x.workflowId === workflowId);
    if (!w) return { ok: false, reason: "工作流记录不存在" };
    const src = sync().sources.find((s) => s.id === w.sourceId);
    if (!isWriteAllowed(w, src)) return { ok: false, reason: "SYNC_WRITE_FORBIDDEN: 该工作流未开启双向同步（同步中心 → 模式里开启）" };
    const tpl = useComfy.getState().templates.find((t) => t.workflowId === workflowId || t.id === w.templateId);
    if (!tpl) return { ok: false, reason: "找不到关联模板" };
    const patches = patchesFromValues(tpl.params as Array<{ key: string; nodeId: string; input: string; value: unknown; label?: string }>, w.baseParamValues ?? {});
    if (!patches.length) return { ok: true }; // 参数没变，无需写回
    const info = await objectInfoCached();
    if (!info) return { ok: false, reason: "SYNC_API_DERIVE_FAILED: 写回需要 ComfyUI 在线（读取节点定义定位参数位）" };
    const latestText = await readFileText(w.absolutePath);
    if (latestText === null) return { ok: false, reason: "SYNC_SOURCE_OFFLINE: 源文件不可读（可能已被删除或所在盘离线）" };
    let ui: UiGraph;
    try {
      ui = JSON.parse(latestText);
    } catch {
      return { ok: false, reason: "SYNC_INVALID_JSON: 源文件当前不是有效 JSON，放弃写回（避免覆盖）" };
    }
    if (!isFrontendWorkflow(ui)) return { ok: false, reason: "SYNC_UNSUPPORTED_FORMAT: 源文件不是完整工作流（API-only 文件不可反向写回）" };
    // 字段级冲突（规格 FR-015：双方同字段不同值）：存记录等用户解决，绝不静默覆盖
    if (!opts?.force) {
      const fields = detectPatchConflicts(ui, patches, w.baseParamValues ?? {}, info);
      if (fields.length) {
        sync().upsertConflict({
          id: `cf_${uid(8)}`,
          workflowId,
          createdAt: Date.now(),
          baseRevision: w.revision,
          patches,
          fields: fields.map((f) => ({ key: f.patch.key, label: f.patch.label ?? f.patch.key, baseValue: f.baseValue, sourceValue: f.sourceValue, momoValue: f.momoValue })),
          status: "open",
        });
        log({ workflowId, sourceId: w.sourceId, level: "warn", event: "write_conflict", message: `「${w.displayName}」写回冲突：${fields.length} 个参数 ComfyUI 侧也改过（${fields.map((f) => f.patch.label ?? f.patch.key).slice(0, 3).join("、")}…），请在同步中心处理` });
        return { ok: false, reason: "SYNC_WRITE_CONFLICT", conflicts: fields.length };
      }
    }
    return await commitWriteBack(w, src!, ui, patches, info, tpl, "momo");
  });
}

/** 应用补丁 + 稳定 ID + 原子写 + 令牌 + 账本对齐（写回与「使用 MOMO 值」共用） */
async function commitWriteBack(
  w: ComfySyncedWorkflow,
  src: ComfySyncSource,
  ui: UiGraph,
  patches: ParamPatch[],
  info: Record<string, any>,
  tpl: ComfyTemplate,
  origin: "momo" | "merge",
): Promise<{ ok: boolean; reason?: string }> {
  const r = applyParamPatches(ui, patches, info);
  const skippedNote = [
    r.orphaned.length ? `${r.orphaned.length} 个参数的节点已在 ComfyUI 里删除（跳过）` : "",
    r.skipped.length ? `${r.skipped.length} 个参数无法定位（连线占用/定义更新，跳过）` : "",
  ].filter(Boolean).join("；");
  injectStableNodeIds(ui, () => `mnode_${uid(10)}`); // 首次双向写回注入（规格 §10.3，保留原属性）
  const outText = JSON.stringify(ui, null, 2);
  const written = await writeSourceFile(src.rootPath, w.absolutePath, outText);
  st.writeTokens.set(w.workflowId, { path: w.absolutePath, sha256: written.sha256, at: Date.now() });
  // MOMO 侧账本：源与 MOMO 重新一致（版本留档 + 基线刷新）
  const rev = w.revision + 1;
  await writeRevisionFile(w.workflowId, rev, origin, outText);
  await writeWorkflowFile(w.workflowId, outText);
  // 模板参数值已生效：用户改动成为新基线，防止下一轮把同值当补丁重发
  const newValues = Object.fromEntries(tpl.params.map((p) => [p.key, p.value]));
  sync().patchWorkflow(w.workflowId, {
    revision: rev,
    syncedAt: Date.now(),
    status: "synced",
    sourceHash: written.sha256,
    baseHash: written.sha256,
    statSize: written.size,
    statMtimeMs: written.mtimeMs,
    semanticHash: undefined,
    baseParamValues: { ...(w.baseParamValues ?? {}), ...newValues },
  });
  log({
    workflowId: w.workflowId,
    sourceId: w.sourceId,
    level: "info",
    event: "written_back",
    message: `「${w.displayName}」已写回 ${r.applied.length} 个参数到源文件${skippedNote ? `（${skippedNote}）` : ""}`,
  });
  return { ok: true };
}

/** 模板管理保存双向模板后调用：改了参数才写回；错误 toast 提示（不吞） */
export async function maybeWriteBackTemplate(tplId: string): Promise<void> {
  const tpl = useComfy.getState().templates.find((t) => t.id === tplId);
  if (!tpl?.workflowId) return;
  const w = sync().workflows.find((x) => x.workflowId === tpl.workflowId);
  if (!w) return;
  const src = sync().sources.find((s) => s.id === w.sourceId);
  if (!isWriteAllowed(w, src)) return; // comfy_master/manual：不写回，安静跳过
  const r = await writeBackWorkflow(w.workflowId);
  if (!r.ok && r.reason === "SYNC_WRITE_CONFLICT") return; // 冲突已有专门 toast/记录
  if (!r.ok) toast(`写回源文件未完成：${r.reason}`, "err");
  else toast(`已写回源文件（${tpl.name}）✓`, "ok");
}

/** 解决写回冲突（规格 FR-015 冲突 UI 的动作） */
export async function resolveConflict(conflictId: string, resolution: "source" | "momo" | "exported" | "later"): Promise<void> {
  const c = sync().conflicts.find((x) => x.id === conflictId);
  if (!c || c.status !== "open") return;
  if (resolution === "later") return; // 保留待处理
  const w = sync().workflows.find((x) => x.workflowId === c.workflowId);
  if (!w) {
    sync().patchConflict(conflictId, { status: "resolved", resolvedAt: Date.now(), resolution });
    return;
  }
  if (resolution === "source") {
    // 使用 ComfyUI 版：直接重新同步源（模板参数会被源值合并，MOMO 补丁放弃）
    const src = sync().sources.find((s) => s.id === w.sourceId);
    await enqueue(() =>
      syncOne(w.workflowId, { path: w.absolutePath, rel: w.relativePath, size: w.statSize ?? 0, mtimeMs: w.sourceModifiedAt }),
    );
    sync().patchConflict(conflictId, { status: "resolved", resolvedAt: Date.now(), resolution: "source" });
    log({ workflowId: w.workflowId, level: "info", event: "conflict_resolved", message: `「${w.displayName}」冲突按「使用 ComfyUI 版本」解决` });
    void src;
    return;
  }
  if (resolution === "momo") {
    const r = await writeBackWorkflow(w.workflowId, { force: true });
    if (r.ok) {
      sync().patchConflict(conflictId, { status: "resolved", resolvedAt: Date.now(), resolution: "momo" });
      log({ workflowId: w.workflowId, level: "info", event: "conflict_resolved", message: `「${w.displayName}」冲突按「使用 MOMO 值」解决（已写回源文件）` });
    } else {
      toast(`按 MOMO 值写回失败：${r.reason}`, "err");
    }
    return;
  }
  // exported：另存为新文件（基线快照 + MOMO 补丁），不碰源文件
  const baseText = await readRevisionFile(w.workflowId, c.baseRevision);
  if (baseText === null) {
    toast("基线快照读取失败，无法导出", "err");
    return;
  }
  const info = await objectInfoCached();
  if (!info) {
    toast("导出 MOMO 版需要 ComfyUI 在线（定位参数位）", "err");
    return;
  }
  try {
    const ui: UiGraph = JSON.parse(baseText);
    applyParamPatches(ui, c.patches as ParamPatch[], info);
    const okSave = await saveTextFile(`${w.displayName}-MOMO版.json`, JSON.stringify(ui, null, 2));
    if (okSave) {
      sync().patchConflict(conflictId, { status: "resolved", resolvedAt: Date.now(), resolution: "exported" });
      log({ workflowId: w.workflowId, level: "info", event: "conflict_resolved", message: `「${w.displayName}」冲突按「另存为新文件」解决` });
    }
  } catch (e) {
    toast(`导出失败：${errMsg(e)}`, "err");
  }
}

/** 完整 UI Workflow 替换写回（FR-010 第二项）：恢复历史版本后「写回源文件」用。
 * 用户明确意图的覆盖，不走冲突检测，但仍要求双向已开启。 */
export async function writeFullWorkflowSource(workflowId: string): Promise<void> {
  const w = sync().workflows.find((x) => x.workflowId === workflowId);
  if (!w) throw new Error("工作流记录不存在");
  const src = sync().sources.find((s) => s.id === w.sourceId);
  if (!isWriteAllowed(w, src)) throw new Error("SYNC_WRITE_FORBIDDEN: 该工作流未开启双向同步");
  const text = await readWorkflowFile(workflowId);
  if (text === null) throw new Error("MOMO 本地正文不存在");
  await enqueue(async () => {
    const written = await writeSourceFile(src!.rootPath, w.absolutePath, text);
    st.writeTokens.set(workflowId, { path: w.absolutePath, sha256: written.sha256, at: Date.now() });
    const rev = w.revision + 1;
    await writeRevisionFile(workflowId, rev, "restore", text);
    sync().patchWorkflow(workflowId, {
      revision: rev,
      syncedAt: Date.now(),
      status: "synced",
      sourceHash: written.sha256,
      baseHash: written.sha256,
      statSize: written.size,
      statMtimeMs: written.mtimeMs,
    });
    log({ workflowId, level: "info", event: "written_back", message: `「${w.displayName}」已把恢复的版本完整写回源文件` });
  });
}

/** 当前工作流的写回能力（UI 显示用） */
export function writeBackStateOf(workflowId: string): { allowed: boolean; policy: ComfySyncedWorkflow["policy"] } {
  const w = sync().workflows.find((x) => x.workflowId === workflowId);
  if (!w) return { allowed: false, policy: "comfy_master" };
  const src = sync().sources.find((s) => s.id === w.sourceId);
  return { allowed: isWriteAllowed(w, src), policy: w.policy };
}

/* ---------------- 差异查看（规格 FR-014） ---------------- */

export type DiffView = { title: string; summary: string | null; rows: Array<{ kind: string; text: string; detail?: string }> };

/** 源文件当前内容 vs MOMO 本地正文（「查看差异」按钮） */
export async function diffSourceVsLocal(workflowId: string): Promise<DiffView> {
  const w = sync().workflows.find((x) => x.workflowId === workflowId);
  if (!w) throw new Error("工作流不存在");
  const localText = await readWorkflowFile(workflowId);
  const sourceText = await readFileText(w.absolutePath);
  if (localText === null && sourceText === null) throw new Error("两边都读不到内容");
  if (localText === null) throw new Error("MOMO 本地正文不存在（先同步一次）");
  if (sourceText === null) throw new Error("源文件当前不可读（可能离线或已删除）");
  const local = JSON.parse(localText);
  const source = JSON.parse(sourceText);
  const info = await objectInfoCached().catch(() => null);
  const d = diffUiWorkflows(local, source, info);
  return { title: `${w.displayName}：MOMO 当前 ←→ 源文件`, summary: diffSummary(d), rows: d.rows };
}

/** 某历史版本 vs MOMO 当前正文（版本历史里的「对比」） */
export async function diffRevisionVsCurrent(workflowId: string, revision: number): Promise<DiffView> {
  const w = sync().workflows.find((x) => x.workflowId === workflowId);
  if (!w) throw new Error("工作流不存在");
  const revText = await readRevisionFile(workflowId, revision);
  const curText = await readWorkflowFile(workflowId);
  if (revText === null) throw new Error(`版本 ${revision} 快照不存在`);
  if (curText === null) throw new Error("当前正文不存在");
  const info = await objectInfoCached().catch(() => null);
  const d = diffUiWorkflows(JSON.parse(revText), JSON.parse(curText), info);
  return { title: `${w.displayName}：版本 #${revision} ←→ 当前`, summary: diffSummary(d), rows: d.rows };
}

/* ================= M3：ComfyUI 同步桥（规格 §4.3） ================= */

/** ComfyUI 是否已加载同步桥扩展（GET /api/extensions 列表里找 momo_bridge） */
export async function bridgeInstalledInComfy(): Promise<boolean> {
  const host = useSettings.getState().settings.comfy.host;
  if (!host) return false;
  try {
    const { xfetch } = await import("../services/http");
    const r = await xfetch(`${normalizeHost(host)}/extensions`, { cache: "no-store" });
    if (!r.ok) return false;
    const list = (await r.json()) as string[];
    return Array.isArray(list) && list.some((x) => String(x).includes("momo_bridge"));
  } catch {
    return false;
  }
}

/** 一键安装同步桥扩展：用户选 ComfyUI 根目录 / custom_nodes 目录 → Rust 写入扩展文件（嵌端口+token） */
export async function installBridge(): Promise<string> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    directory: true,
    title: "选择 ComfyUI 根目录或 custom_nodes 目录（同步桥扩展会装到 custom_nodes/momo_sync_bridge）",
  });
  if (!picked || typeof picked !== "string") throw new Error("已取消");
  const dir = await invoke<string>("comfy_bridge_install", { comfyDir: picked });
  log({ level: "info", event: "bridge_installed", message: `同步桥扩展已安装到 ${dir}——重启 ComfyUI 后生效（保存即时同步 / 在 ComfyUI 中打开）` });
  return dir;
}

/**
 * 在 ComfyUI 中打开指定工作流（尽力版）：桥已装时把当前正文放进待打开队列（ComfyUI 里的
 * 扩展 2s 内轮询到并 loadGraphData），再打开 ComfyUI 页面；桥未装/不在线则退化为只开页面并提示。
 */
export async function openInComfy(workflowId: string): Promise<void> {
  const w = sync().workflows.find((x) => x.workflowId === workflowId);
  if (!w) throw new Error("工作流不存在");
  const host = useSettings.getState().settings.comfy.host;
  if (!host) {
    toast("先在 设置 → ComfyUI 里配置服务地址，才能打开 ComfyUI", "err");
    return;
  }
  const { openExternal } = await import("../external");
  const installed = await bridgeInstalledInComfy();
  if (installed) {
    const text = (await readWorkflowFile(workflowId)) ?? "";
    if (text) {
      await invoke<void>("comfy_bridge_set_pending_open", { path: w.absolutePath, text });
      await openExternal(normalizeHost(host));
      toast(`已在 ComfyUI 打开「${w.displayName}」（扩展会自动载入画布，2 秒内生效）`, "ok");
      return;
    }
  }
  await openExternal(normalizeHost(host));
  toast(installed ? "已打开 ComfyUI（正文读取失败，请在左侧工作流列表手动点开）" : "已打开 ComfyUI——安装「同步桥」后可一键直达该工作流（同步中心顶栏）", "info");
}

/* ================= 重新关联（规格 FR-011：源删除后的恢复选项之一） ================= */

/** 为 source_deleted / detached 的工作流重新指定源文件（选一个新文件，记录原地更新后立即同步） */
export async function reassociateWorkflow(workflowId: string): Promise<void> {
  const w = sync().workflows.find((x) => x.workflowId === workflowId);
  if (!w) throw new Error("工作流不存在");
  const src = sync().sources.find((s) => s.id === w.sourceId);
  if (!src) throw new Error("所属来源已被删除——请重新添加来源后再关联");
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    title: `为「${w.displayName}」选择新的源文件（${src.rootPath} 内）`,
    filters: [{ name: "JSON 工作流", extensions: ["json"] }],
    defaultPath: src.rootPath,
  });
  if (!picked || typeof picked !== "string") throw new Error("已取消");
  // 新文件必须仍在来源目录内（同步语义成立；越界的文件请走来源管理另建来源）
  if (!normAbs(picked).startsWith(normAbs(src.rootPath))) {
    throw new Error(`所选文件不在来源目录 ${src.rootPath} 内（请把它移进去，或为它所在目录另建来源）`);
  }
  const rel = picked.slice(src.rootPath.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
  sync().patchWorkflow(workflowId, {
    absolutePath: picked,
    relativePath: rel,
    displayName: displayNameOfRel(rel),
    status: "pending_import",
    statSize: undefined,
    statMtimeMs: undefined,
  });
  const stat = await hashFile(picked);
  const entry: ScanEntry = { path: picked, rel, size: stat.size, mtimeMs: stat.mtimeMs };
  await enqueue(() => syncOne(workflowId, entry));
  log({ workflowId, sourceId: w.sourceId, level: "info", event: "reassociated", message: `「${w.displayName}」已重新关联到 ${rel}` });
}
