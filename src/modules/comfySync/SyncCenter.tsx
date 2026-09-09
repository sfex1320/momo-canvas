/**
 * Comfy 工作流同步中心（插件规格 v1.0 · §6）
 *  - 顶部入口按钮的状态点用 syncHealthOf 计算（灰/绿/蓝/黄/红）
 *  - 全屏层 z-index 460（高于导演台 450；版本历史子浮层 465）
 *  - 普通同步成功不打扰：只在列表与状态点刷新；失败/冲突/离线走事件记录（规格 §6.5）
 */
import { useEffect, useMemo, useState } from "react";
import type { ComfySyncSource, ComfySyncedWorkflow } from "../../core/types";
import { useComfySync } from "../../core/stores/comfySyncStore";
import { useUi, toast } from "../../core/stores/uiStore";
import { useSettings } from "../../core/stores/settingsStore";
import { isTauri, errMsg } from "../../core/utils";
import {
  addSource,
  detectWorkflowDirs,
  removeSource,
  rescanSourceNow,
  resumeSource,
  pauseSource,
  updateSource,
  trackWorkflows,
  untrackWorkflow,
  setWorkflowPolicy,
  enableBidirectional,
  resolveConflict,
  writeFullWorkflowSource,
  diffSourceVsLocal,
  diffRevisionVsCurrent,
  installBridge,
  bridgeInstalledInComfy,
  openInComfy,
  reassociateWorkflow,
  bindWorkflowToTemplate,
  type DiffView,
  togglePinRevision,
  restoreRevision,
  listWorkflowRevisions,
  keepLocalCopy,
} from "../../core/comfySync/engine";
import { useComfyTemplates } from "../../core/stores/comfyStore";
import { PopSelect } from "../../ui/PopSelect";
import { Switch } from "../../ui/kit";
import {
  IcCheck,
  IcClose,
  IcDiff,
  IcEdit,
  IcFilter,
  IcFlow,
  IcFolder,
  IcGear,
  IcGlobe,
  IcHistory,
  IcLink,
  IcLoading,
  IcPause,
  IcPlay,
  IcPlus,
  IcRefresh,
  IcSearch,
  IcStar,
  IcTrash,
  IcUpload,
} from "../../ui/icons";
import "./comfySync.css";

import { syncHealthOf } from "../../core/comfySync/health";
export { syncHealthOf } from "../../core/comfySync/health";

const STATUS_META: Record<ComfySyncedWorkflow["status"], { label: string; cls: string }> = {
  untracked: { label: "新发现", cls: "dim" },
  pending_import: { label: "待入库", cls: "dim" },
  syncing: { label: "同步中", cls: "info" },
  synced: { label: "已同步", cls: "ok" },
  source_changed: { label: "源有改动", cls: "info" },
  invalid: { label: "文件无效", cls: "err" },
  source_offline: { label: "来源离线", cls: "warn" },
  source_deleted: { label: "源已删除", cls: "warn" },
  detached: { label: "本地副本", cls: "dim" },
  paused: { label: "已暂停", cls: "dim" },
  derive_failed: { label: "待派生", cls: "warn" },
};

const SOURCE_STATUS: Record<ComfySyncSource["status"], { label: string; cls: string }> = {
  online: { label: "在线", cls: "ok" },
  offline: { label: "离线", cls: "warn" },
  permission_denied: { label: "无权限", cls: "err" },
  scanning: { label: "扫描中", cls: "info" },
};

const KIND_LABEL: Record<ComfySyncSource["kind"], string> = {
  local: "本机",
  removable: "移动盘",
  mapped_drive: "映射盘",
  unc: "网络共享",
};

function fmtAgo(ts?: number): string {
  if (!ts) return "—";
  const d = Date.now() - ts;
  if (d < 60_000) return "刚刚";
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)} 小时前`;
  return new Date(ts).toLocaleDateString();
}

export function SyncCenter() {
  const open = useUi((s) => s.comfySyncOpen);
  const setOpen = useUi((s) => s.setComfySyncOpen);
  if (!open) return null;
  return <SyncCenterBody onClose={() => setOpen(false)} />;
}

function SyncCenterBody({ onClose }: { onClose: () => void }) {
  const sources = useComfySync((s) => s.sources);
  const workflows = useComfySync((s) => s.workflows);
  const events = useComfySync((s) => s.events);
  const running = useComfySync((s) => s.running);
  const [adding, setAdding] = useState<null | { candidates: string[]; picked: string; name: string }>(null);
  const [historyFor, setHistoryFor] = useState<ComfySyncedWorkflow | null>(null);

  // 打开同步中心时引擎没在跑（HMR 重建 / 开关刚打开）就拉起来——同步中心自己就是恢复入口
  useEffect(() => {
    if (!running && isTauri && useSettings.getState().settings.comfy.syncV2Enabled !== false) {
      void import("../../core/comfySync/engine").then((m) => m.startEngine());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [policyFilter, setPolicyFilter] = useState("all");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [editSrc, setEditSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [diffView, setDiffView] = useState<DiffView | null>(null);
  const [bindFor, setBindFor] = useState<ComfySyncedWorkflow | null>(null);
  const [bridgeChecked, setBridgeChecked] = useState<"unknown" | "installed" | "missing">("unknown");
  // ⚠️ zustand v5 selector 禁止返回 filter/map 的新数组——快照不稳定会触发
  // useSyncExternalStore 无限重渲染（Maximum update depth → 整树卸载白屏）。
  // 先订阅原数组，再 useMemo 派生。
  const conflicts = useComfySync((s) => s.conflicts);
  const openConflicts = useMemo(() => conflicts.filter((c) => c.status === "open"), [conflicts]);
  const templates = useComfyTemplates();

  // 打开时顺带探测同步桥是否已装进 ComfyUI（用于按钮文案）
  useEffect(() => {
    if (!isTauri) return;
    void bridgeInstalledInComfy().then((ok) => setBridgeChecked(ok ? "installed" : "missing"));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return workflows.filter((w) => {
      if (statusFilter !== "all" && w.status !== statusFilter) return false;
      if (sourceFilter !== "all" && w.sourceId !== sourceFilter) return false;
      if (policyFilter !== "all" && w.policy !== policyFilter) return false;
      if (q && !w.displayName.toLowerCase().includes(q) && !w.relativePath.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [workflows, query, statusFilter, sourceFilter, policyFilter]);

  const untrackedIds = useMemo(() => filtered.filter((w) => w.status === "untracked").map((w) => w.workflowId), [filtered]);
  const allChecked = untrackedIds.length > 0 && untrackedIds.every((id) => checked.has(id));

  const toggleAll = () => {
    setChecked(allChecked ? new Set() : new Set(untrackedIds));
  };
  const toggleOne = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startAdd = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        directory: true,
        title: "选择 ComfyUI 根目录或 workflows 目录（只需要选这一次）",
      });
      if (!picked || typeof picked !== "string") return;
      const dirs = await detectWorkflowDirs(picked);
      const candidates = dirs.length ? dirs : [picked];
      setAdding({ candidates, picked: candidates[0], name: "" });
    } catch (e) {
      toast(`选择目录失败：${errMsg(e)}`, "err");
    }
  };

  const confirmAdd = async () => {
    if (!adding) return;
    setBusy(true);
    try {
      await addSource({ rootPath: adding.picked, name: adding.name.trim() || undefined });
      setAdding(null);
    } catch (e) {
      toast(`添加来源失败：${errMsg(e)}`, "err");
    } finally {
      setBusy(false);
    }
  };

  if (!isTauri) {
    return (
      <div className="cfs-mask" onClick={onClose}>
        <div className="cfs-panel" onClick={(e) => e.stopPropagation()}>
          <header className="cfs-head">
            <h2>
              <IcFlow size={18} /> Comfy 工作流同步
            </h2>
            <button className="icon-btn" title="关闭" onClick={onClose}>
              <IcClose size={18} />
            </button>
          </header>
          <div className="cfs-empty">工作流同步需要桌面应用（浏览器预览模式下不可用）。</div>
        </div>
      </div>
    );
  }

  return (
    <div className="cfs-mask" onClick={onClose}>
      <div className="cfs-panel" onClick={(e) => e.stopPropagation()}>
        <header className="cfs-head">
          <h2>
            <IcFlow size={18} /> Comfy 工作流同步
            <span className={`cfs-dot cfs-dot-${syncHealthOf(sources, workflows, running)}`} title={running ? "同步服务运行中" : "同步服务未运行"} />
          </h2>
          <div className="cfs-head-acts">
            {openConflicts.length ? (
              <span className="cfs-conflict-pill" title={`有 ${openConflicts.length} 个写回冲突待处理（双方都改了同一参数），见下方冲突区`}>
                ⚠ {openConflicts.length} 个写回冲突
              </span>
            ) : null}
            <button
              className="btn sm"
              disabled={busy}
              title={
                bridgeChecked === "installed"
                  ? "同步桥已装进 ComfyUI：保存工作流即时同步（不等复扫）、可一键在 ComfyUI 中打开工作流"
                  : "一键安装 ComfyUI 同步桥扩展：保存即时同步 + 在 ComfyUI 中打开指定工作流（装完需重启 ComfyUI）"
              }
              onClick={async () => {
                setBusy(true);
                try {
                  const dir = await installBridge();
                  toast(`同步桥已安装到 ${dir}——重启 ComfyUI 后生效`, "ok");
                  setBridgeChecked("missing"); // 重启 ComfyUI 前探测不到，等它加载后自然变 installed
                } catch (e) {
                  if (errMsg(e) !== "已取消") toast(`安装失败：${errMsg(e)}`, "err");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <IcGlobe size={15} /> {bridgeChecked === "installed" ? "同步桥已装" : "装同步桥"}
            </button>
            <button className="btn sm" onClick={() => void startAdd()}>
              <IcPlus size={15} /> 添加来源
            </button>
            <button
              className="btn sm"
              disabled={busy || !sources.length}
              onClick={async () => {
                setBusy(true);
                try {
                  for (const s of sources.filter((x) => x.enabled)) await rescanSourceNow(s.id);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <IcLoading size={15} /> : <IcRefresh size={15} />} 立即扫描
            </button>
            <button className="icon-btn" title="关闭" onClick={onClose}>
              <IcClose size={18} />
            </button>
          </div>
        </header>

        {!running ? (
          <div className="cfs-empty">
            同步服务未运行——到 设置 → ComfyUI 打开「工作流无感同步」开关后，这里会自动恢复监听；已同步的数据不受影响。
          </div>
        ) : !sources.length ? (
          <div className="cfs-empty">
            还没有配置来源。点「添加来源」选择 ComfyUI 的工作流目录（通常在 ComfyUI 目录下的
            <code>user\default\workflows</code>），之后在 ComfyUI 里新建、保存、改名工作流，MOMO 都会自动跟上，不再需要导出 API JSON。
          </div>
        ) : null}

        {/* 写回冲突（规格 FR-015）：双方都改了同一参数，绝不静默覆盖 */}
        {openConflicts.length ? (
          <section className="cfs-conflicts">
            <b>⚠ 写回冲突（{openConflicts.length}）</b>
            {openConflicts.map((c) => {
              const cw = workflows.find((w) => w.workflowId === c.workflowId);
              return (
                <div key={c.id} className="cfs-conflict-card">
                  <div className="cfs-conflict-head">
                    <b>{cw?.displayName ?? c.workflowId}</b>
                    <span className="cfs-hint">{new Date(c.createdAt).toLocaleString()} · 基线版本 #{c.baseRevision}</span>
                  </div>
                  {c.fields.map((f) => (
                    <div key={f.key} className="cfs-conflict-field">
                      <span className="cfs-fname">{f.label ?? f.key}</span>
                      <span className="cfs-fval src" title="ComfyUI 源文件里的当前值">
                        ComfyUI：{JSON.stringify(f.sourceValue)}
                      </span>
                      <span className="cfs-fval momo" title="你在 MOMO 里改的值">
                        MOMO：{JSON.stringify(f.momoValue)}
                      </span>
                    </div>
                  ))}
                  <div className="cfs-conflict-acts">
                    <button className="btn sm" title="放弃 MOMO 的改动，以 ComfyUI 源文件为准重新同步" onClick={() => void resolveConflict(c.id, "source")}>
                      使用 ComfyUI 版本
                    </button>
                    <button className="btn sm primary" title="把 MOMO 的值强制写回源文件（覆盖 ComfyUI 侧的改动）" onClick={() => void resolveConflict(c.id, "momo")}>
                      使用 MOMO 值
                    </button>
                    <button className="btn sm" title="把「基线 + MOMO 改动」另存为新 JSON 文件，源文件不动" onClick={() => void resolveConflict(c.id, "exported")}>
                      另存为新文件
                    </button>
                    <button className="btn sm" title="保留冲突记录，稍后处理" onClick={() => void resolveConflict(c.id, "later")}>
                      稍后处理
                    </button>
                  </div>
                </div>
              );
            })}
          </section>
        ) : null}

        {/* 来源卡列表（规格 §6.2） */}
        {sources.length ? (
          <section className="cfs-sources">
            {sources.map((s) => {
              const editing = editSrc === s.id;
              return (
                <div key={s.id} className={`cfs-source ${editing ? "editing" : ""}`}>
                  <div className="cfs-source-main">
                    <span className={`cfs-badge ${SOURCE_STATUS[s.status].cls}`}>
                      <i /> {SOURCE_STATUS[s.status].label}
                    </span>
                    <b className="cfs-source-name">{s.name}</b>
                    <span className="cfs-ktag">{KIND_LABEL[s.kind]}</span>
                    <span className="cfs-path" title={s.rootPath}>
                      {s.rootPath}
                    </span>
                    <span className="cfs-hint">上次扫描 {fmtAgo(s.lastScanAt)}</span>
                    <span className="cfs-acts">
                      <button className="icon-btn" title="立即扫描此来源" onClick={() => void rescanSourceNow(s.id)}>
                        <IcRefresh size={16} />
                      </button>
                      {s.enabled ? (
                        <button className="icon-btn" title="暂停（停监听，数据保留）" onClick={() => void pauseSource(s.id)}>
                          <IcPause size={16} />
                        </button>
                      ) : (
                        <button className="icon-btn" title="恢复同步" onClick={() => void resumeSource(s.id)}>
                          <IcPlay size={16} />
                        </button>
                      )}
                      <button className="icon-btn" title="来源设置" onClick={() => setEditSrc(editing ? null : s.id)}>
                        <IcGear size={16} />
                      </button>
                      <button
                        className="icon-btn danger"
                        title="删除来源（已同步的工作流保留为本地副本，画布不受影响）"
                        onClick={() => {
                          if (confirm(`删除来源「${s.name}」？已同步的工作流会保留为 MOMO 本地副本，不会丢数据。`)) void removeSource(s.id);
                        }}
                      >
                        <IcTrash size={16} />
                      </button>
                    </span>
                  </div>
                  {editing ? (
                    <div className="cfs-source-edit">
                      <label>
                        名称
                        <input
                          className="input sm"
                          value={s.name}
                          onChange={(e) => void updateSource(s.id, { name: e.target.value })}
                        />
                      </label>
                      <label className="cfs-switch">
                        <Switch on={s.enabled} onChange={(v) => void (v ? resumeSource(s.id) : pauseSource(s.id))} />
                        启用同步
                      </label>
                      <label className="cfs-switch">
                        <Switch
                          on={s.includeSubdirectories}
                          onChange={(v) => void updateSource(s.id, { includeSubdirectories: v })}
                        />
                        包含子目录
                      </label>
                      <label className="cfs-switch">
                        <Switch
                          on={s.autoTrackNewWorkflows}
                          onChange={(v) => void updateSource(s.id, { autoTrackNewWorkflows: v })}
                        />
                        自动同步新增工作流
                      </label>
                      <label className="cfs-switch">
                        <Switch
                          on={s.allowWriteBack}
                          onChange={(v) => void updateSource(s.id, { allowWriteBack: v })}
                        />
                        允许写回源文件
                      </label>
                      <label>
                        新工作流默认模式
                        <PopSelect
                          className="cfs-policy"
                          value={s.defaultPolicy}
                          triggerIcon
                          title="该来源新增工作流的默认同步模式"
                          options={[
                            { value: "comfy_master", label: "Comfy 主控", desc: "只读同步，绝不写回", icon: <IcFlow size={14} /> },
                            { value: "manual", label: "手动", desc: "源变化只标记", icon: <IcPause size={14} /> },
                          ]}
                          onChange={(v) => void updateSource(s.id, { defaultPolicy: v as ComfySyncSource["defaultPolicy"] })}
                        />
                      </label>
                      <label className="cfs-ignore-row">
                        忽略规则
                        <textarea
                          className="textarea sm cfs-ignore-input"
                          rows={2}
                          value={s.ignorePatterns.join("\n")}
                          onChange={(e) =>
                            void updateSource(s.id, {
                              ignorePatterns: e.target.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
                            })
                          }
                        />
                      </label>
                      <p className="cfs-hint">
                        首次扫描只会列出候选，勾选后才入库；「自动同步新增」只对之后新建的工作流生效。忽略规则每行一条
                        （*.tmp 后缀 / backup 目录 / **​/任意层级），下次扫描生效。「允许写回」只是来源级授权——每个工作流还要单独开启「双向」才会真的写。
                      </p>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </section>
        ) : null}

        {/* 工作流表 */}
        <section className="cfs-list">
          <div className="cfs-list-bar">
            <label className="cfs-checkall">
              <input type="checkbox" checked={allChecked} onChange={toggleAll} />
              全选新发现（{untrackedIds.length}）
            </label>
            <button
              className="btn sm primary"
              disabled={!checked.size}
              onClick={async () => {
                // 勾选集同时服务「同步新发现」与「批量暂停」；这里只同步 untracked 的
                const ids = filtered.filter((w) => w.status === "untracked" && checked.has(w.workflowId)).map((w) => w.workflowId);
                setChecked(new Set());
                await trackWorkflows(ids);
              }}
            >
              <IcCheck size={15} /> 同步所选（{checked.size}）
            </button>
            <button
              className="btn sm"
              disabled={!checked.size}
              title="批量暂停：所选工作流改为「手动」模式（源变化只标记不自动更新，可随时恢复）"
              onClick={async () => {
                for (const id of checked) await setWorkflowPolicy(id, "manual");
                toast(`已把 ${checked.size} 套工作流改为手动模式`, "info");
                setChecked(new Set());
              }}
            >
              <IcPause size={14} /> 批量暂停（{checked.size}）
            </button>
            <span className="spacer" />
            <div className="cfs-search">
              <IcSearch size={15} />
              <input className="input sm" placeholder="搜索工作流…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <PopSelect
              value={policyFilter}
              triggerIcon
              title="按同步模式过滤"
              options={[
                { value: "all", label: "全部模式", icon: <IcFlow size={15} /> },
                { value: "comfy_master", label: "Comfy 主控", icon: <IcFlow size={15} /> },
                { value: "bidirectional", label: "双向", icon: <IcLink size={15} /> },
                { value: "manual", label: "手动", icon: <IcPause size={15} /> },
              ]}
              onChange={(v) => setPolicyFilter(v)}
            />
            <PopSelect
              value={sourceFilter}
              triggerIcon
              options={[
                { value: "all", label: "全部来源", icon: <IcFlow size={15} /> },
                ...sources.map((s) => ({ value: s.id, label: s.name, icon: <IcFolder size={15} /> })),
              ]}
              onChange={(v) => setSourceFilter(v)}
            />
            <PopSelect
              value={statusFilter}
              triggerIcon
              options={[
                { value: "all", label: "全部状态", icon: <IcFlow size={15} /> },
                ...Object.entries(STATUS_META).map(([k, m]) => ({ value: k, label: m.label, icon: <IcFilter size={15} /> })),
              ]}
              onChange={(v) => setStatusFilter(v)}
            />
          </div>

          <div className="cfs-rows">
            {filtered.length ? (
              filtered.map((w) => {
                const meta = STATUS_META[w.status];
                const src = sources.find((s) => s.id === w.sourceId);
                return (
                  <div key={w.workflowId} className="cfs-row" data-status={w.status}>
                    <input
                      type="checkbox"
                      disabled={w.status === "syncing" || w.status === "detached"}
                      checked={checked.has(w.workflowId)}
                      onChange={() => toggleOne(w.workflowId)}
                    />
                    <div className="cfs-row-main">
                      <b title={w.absolutePath}>{w.displayName}</b>
                      <span className="cfs-hint" title={w.relativePath}>
                        {src ? src.name : "本地副本"} · {w.relativePath}
                      </span>
                      {w.warnings.length ? (
                        <span className="cfs-warn" title={w.warnings.join("\n")}>
                          ⚠ {w.warnings[0]}
                        </span>
                      ) : null}
                    </div>
                    <span className="cfs-cell">{w.format === "api_only" ? "API-only" : "完整工作流"}</span>
                    <span className="cfs-cell">
                      {(() => {
                        // 模式切换（规格 §8）：Comfy 主控 / 双向（写回需确认）/ 手动
                        return (
                          <PopSelect
                            className="cfs-policy"
                            value={w.policy}
                            triggerIcon
                            title="同步模式"
                            options={[
                              { value: "comfy_master", label: "Comfy 主控", desc: "源文件自动同步进 MOMO，绝不写回", icon: <IcFlow size={14} /> },
                              {
                                value: "bidirectional",
                                label: "双向",
                                desc: w.format === "api_only" ? "API-only 文件没有画布布局，不能写回" : "MOMO 里保存参数会写回源文件",
                                icon: <IcLink size={14} />,
                                disabled: w.format === "api_only",
                              },
                              { value: "manual", label: "手动", desc: "源变化只标记，不自动更新", icon: <IcPause size={14} /> },
                            ]}
                            onChange={(v) => {
                              if (v === w.policy) return;
                              if (v === "bidirectional") {
                                if (
                                  confirm(
                                    `为「${w.displayName}」开启双向同步？\n\n开启后：你在 MOMO 模板里保存的参数改动会写回 ComfyUI 源文件（原子替换，双向冲突时会先征求你的选择，绝不静默覆盖）。\n不想 MOMO 碰源文件就保持「Comfy 主控」。`,
                                  )
                                )
                                  void enableBidirectional(w.workflowId);
                                return;
                              }
                              void setWorkflowPolicy(w.workflowId, v as ComfySyncedWorkflow["policy"]);
                            }}
                          />
                        );
                      })()}
                    </span>
                    <span className={`cfs-badge ${meta.cls}`}>
                      {w.status === "syncing" ? <IcLoading size={12} /> : <i />}
                      {meta.label}
                    </span>
                    <span className="cfs-cell" title={`文件修改：${w.sourceModifiedAt ? new Date(w.sourceModifiedAt).toLocaleString() : "—"}\n上次同步：${w.syncedAt ? new Date(w.syncedAt).toLocaleString() : "—"}`}>
                      {fmtAgo(w.syncedAt)}
                    </span>
                    <span className="cfs-acts">
                      {w.status === "source_changed" || w.policy === "manual" ? (
                        <button
                          className="icon-btn"
                          title="立即同步"
                          onClick={() => void trackWorkflows([w.workflowId])}
                        >
                          <IcUpload size={16} />
                        </button>
                      ) : null}
                      <button
                        className="icon-btn"
                        title="在 ComfyUI 中打开（需已装同步桥并启动 ComfyUI；未装时仅打开 ComfyUI 首页）"
                        onClick={() => void openInComfy(w.workflowId).catch((e) => toast(errMsg(e), "err"))}
                      >
                        <IcGlobe size={16} />
                      </button>
                      {w.templateId && templates.some((t) => t.id === w.templateId) ? (
                        <button
                          className="icon-btn"
                          title="配置模板：暴露哪些参数/图片入口、哪个节点作输出（打开模板编辑器）"
                          onClick={() => {
                            useUi.getState().setComfySyncOpen(false);
                            useUi.getState().setTemplateMgr(true, w.templateId);
                          }}
                        >
                          <IcEdit size={16} />
                        </button>
                      ) : null}
                      {w.templateId && !templates.some((t) => t.id === w.templateId) ? (
                        <button
                          className="icon-btn"
                          title="关联的画布模板已不存在——重新关联一个模板（旧模板被删的迁移场景）"
                          onClick={() => setBindFor(w)}
                        >
                          <IcLink size={16} />
                        </button>
                      ) : null}
                      <button
                        className="icon-btn"
                        title="查看差异：MOMO 当前 ←→ 源文件（节点/参数/连线/布局/分组）"
                        onClick={async () => {
                          try {
                            setDiffView(await diffSourceVsLocal(w.workflowId));
                          } catch (e) {
                            toast(errMsg(e), "err");
                          }
                        }}
                      >
                        <IcDiff size={16} />
                      </button>
                      <button
                        className="icon-btn"
                        title={w.policy === "manual" ? "恢复自动同步（ComfyUI 主控）" : "改为手动（源变化只标记，不自动更新）"}
                        onClick={() => void setWorkflowPolicy(w.workflowId, w.policy === "manual" ? "comfy_master" : "manual")}
                      >
                        {w.policy === "manual" ? <IcPlay size={16} /> : <IcPause size={16} />}
                      </button>
                      <button className="icon-btn" title="版本历史（查看 / 恢复 / 对比）" onClick={() => setHistoryFor(w)}>
                        <IcHistory size={16} />
                      </button>
                      <button
                        className="icon-btn"
                        title="打开所在目录"
                        onClick={async () => {
                          const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
                          await revealItemInDir(w.absolutePath);
                        }}
                      >
                        <IcFolder size={16} />
                      </button>
                      {w.status === "source_deleted" || w.status === "detached" ? (
                        <>
                          <button
                            className="icon-btn"
                            title="重新关联：为它指定来源目录里的新文件（改名/移动后找回）"
                            onClick={() => void reassociateWorkflow(w.workflowId).then(
                              () => toast(`「${w.displayName}」已重新关联并同步`, "ok"),
                              (e) => errMsg(e) !== "已取消" && toast(errMsg(e), "err"),
                            )}
                          >
                            <IcRefresh size={16} />
                          </button>
                          <button className="icon-btn" title="保留为 MOMO 本地副本（不再等源文件回来）" onClick={() => keepLocalCopy(w.workflowId)}>
                            <IcCheck size={16} />
                          </button>
                        </>
                      ) : null}
                      <button
                        className="icon-btn danger"
                        title="解除关联（删本地同步数据；模板与画布实例保留）"
                        onClick={() => {
                          if (confirm(`解除「${w.displayName}」的同步关联？本地版本历史会删除，画布模板与实例参数保留。`))
                            void untrackWorkflow(w.workflowId);
                        }}
                      >
                        <IcTrash size={16} />
                      </button>
                    </span>
                  </div>
                );
              })
            ) : (
              <div className="cfs-empty sm">
                {sources.length ? "没有符合条件的工作流。在 ComfyUI 里保存一个工作流，或点「立即扫描」。" : "先添加来源。"}
              </div>
            )}
          </div>
        </section>

        {/* 最近事件（规格 NFR-005） */}
        <section className="cfs-events">
          <b>同步记录</b>
          <div className="cfs-event-list">
            {events.length ? (
              events.slice(0, 8).map((e) => (
                <div key={e.id} className={`cfs-event lv-${e.level}`}>
                  <span className="cfs-hint">{new Date(e.createdAt).toLocaleTimeString()}</span>
                  <span>{e.message}</span>
                </div>
              ))
            ) : (
              <div className="cfs-hint">暂无事件。</div>
            )}
          </div>
        </section>

        {/* 添加来源：目录探测确认（规格 §6.3） */}
        {adding ? (
          <div className="cfs-sublayer" onClick={() => setAdding(null)}>
            <div className="cfs-subpanel" onClick={(e) => e.stopPropagation()}>
              <h3>确认工作流目录</h3>
              <p className="cfs-hint">在所选目录里找到这些候选，确认要同步哪个（一般是 user\default\workflows）：</p>
              {adding.candidates.map((c) => (
                <label key={c} className={`cfs-candidate ${adding.picked === c ? "on" : ""}`}>
                  <input
                    type="radio"
                    checked={adding.picked === c}
                    onChange={() => setAdding((a) => (a ? { ...a, picked: c } : a))}
                  />
                  <span className="cfs-path">{c}</span>
                </label>
              ))}
              <label className="cfs-name-row">
                来源名称
                <input
                  className="input sm"
                  placeholder="默认自动命名"
                  value={adding.name}
                  onChange={(e) => setAdding((a) => (a ? { ...a, name: e.target.value } : a))}
                />
              </label>
              <p className="cfs-hint">
                首次扫描只列出候选工作流，由你勾选入库；默认 ComfyUI 主控（MOMO 对源目录只读，绝不写回）。
              </p>
              <div className="cfs-sub-acts">
                <button className="btn sm" onClick={() => setAdding(null)}>
                  取消
                </button>
                <button className="btn sm primary" disabled={busy} onClick={() => void confirmAdd()}>
                  {busy ? <IcLoading size={15} /> : <IcPlus size={15} />} 添加并扫描
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* 版本历史（规格 FR-013） */}
        {historyFor ? <RevisionPanel wf={historyFor} onClose={() => setHistoryFor(null)} /> : null}

        {/* 差异视图（规格 FR-014） */}
        {diffView ? (
          <div className="cfs-sublayer" onClick={() => setDiffView(null)}>
            <div className="cfs-subpanel wide" onClick={(e) => e.stopPropagation()}>
              <DiffRowsView view={diffView} onClose={() => setDiffView(null)} />
            </div>
          </div>
        ) : null}

        {/* 关联到现有画布模板（规格 §16.2 迁移：旧模板绑定同步工作流） */}
        {bindFor ? (
          <div className="cfs-sublayer" onClick={() => setBindFor(null)}>
            <div className="cfs-subpanel" onClick={(e) => e.stopPropagation()}>
              <h3>
                关联模板 · {bindFor.displayName}
                <button className="icon-btn" title="关闭" onClick={() => setBindFor(null)}>
                  <IcClose size={17} />
                </button>
              </h3>
              <p className="cfs-hint">选择一个已有画布模板接收该工作流的后续更新（画布节点引用不变，实例参数不受影响）：</p>
              <div className="cfs-rev-list">
                {templates.length ? (
                  templates.map((t) => (
                    <button
                      key={t.id}
                      className={`cfs-candidate ${bindFor.templateId === t.id ? "on" : ""}`}
                      onClick={async () => {
                        await bindWorkflowToTemplate(bindFor.workflowId, t.id);
                        toast(`已关联模板「${t.name}」，下次同步起自动跟随源文件`, "ok");
                        setBindFor(null);
                      }}
                    >
                      <IcFlow size={15} />
                      <span>
                        {t.name}
                        {t.workflowId ? "（已关联其它工作流，将改为关联本工作流）" : ""}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="cfs-hint">还没有模板。</div>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 版本历史子面板：列表 + 对比 + 恢复 + 固定保留。恢复默认只回滚 MOMO 本地（comfy_master 只读）；
 *  已开启双向的工作流额外提供「写回源文件」（完整 UI Workflow 替换，FR-010 第二项） */
function RevisionPanel({ wf, onClose }: { wf: ComfySyncedWorkflow; onClose: () => void }) {
  const [revs, setRevs] = useState<Array<{ revision: number; origin: string; createdAt: number; size: number; pinned: boolean }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<DiffView | null>(null);
  const sources = useComfySync((s) => s.sources);
  const src = sources.find((s) => s.id === wf.sourceId);
  const bidirectional = (wf.policy === "bidirectional" || wf.policy === "momo_master") && !!src?.allowWriteBack;
  useEffect(() => {
    void listWorkflowRevisions(wf.workflowId).then(setRevs).catch(() => setRevs([]));
  }, [wf.workflowId]);
  const originLabel: Record<string, string> = { source: "ComfyUI 保存", restore: "手动恢复", momo: "MOMO 写回", merge: "合并", migration: "迁移" };
  return (
    <div className="cfs-sublayer" onClick={onClose}>
      <div className="cfs-subpanel wide" onClick={(e) => e.stopPropagation()}>
        <h3>
          版本历史 · {wf.displayName}
          <button className="icon-btn" title="关闭" onClick={onClose}>
            <IcClose size={17} />
          </button>
        </h3>
        {revs === null ? (
          <div className="cfs-empty sm">
            <IcLoading size={16} />
          </div>
        ) : revs.length ? (
          <div className="cfs-rev-list">
            {[...revs].reverse().map((r) => (
              <div key={r.revision} className={`cfs-rev ${r.revision === wf.revision ? "cur" : ""}`}>
                <b>#{r.revision}</b>
                <span>{originLabel[r.origin] ?? r.origin}</span>
                <span className="cfs-hint">{new Date(r.createdAt).toLocaleString()}</span>
                <span className="cfs-hint">{(r.size / 1024).toFixed(1)} KB</span>
                <span className="cfs-acts">
                  <button
                    className={`icon-btn ${r.pinned ? "on" : ""}`}
                    title={r.pinned ? "取消永久保留" : "永久保留此版本（清理策略不动它）"}
                    onClick={() => {
                      void togglePinRevision(wf.workflowId, r.revision);
                      setRevs((list) => (list ?? []).map((x) => (x.revision === r.revision ? { ...x, pinned: !x.pinned } : x)));
                    }}
                  >
                    <IcStar size={15} />
                  </button>
                  <button
                    className="icon-btn"
                    title="对比：此版本 ←→ 当前"
                    onClick={async () => {
                      try {
                        setDiff(await diffRevisionVsCurrent(wf.workflowId, r.revision));
                      } catch (e) {
                        toast(errMsg(e), "err");
                      }
                    }}
                  >
                    <IcDiff size={15} />
                  </button>
                  <button
                    className="btn sm"
                    disabled={busy || r.revision === wf.revision}
                    title={r.revision === wf.revision ? "这是当前版本" : "把 MOMO 侧回滚到此版本（不改动源文件）"}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await restoreRevision(wf.workflowId, r.revision);
                        toast(`已恢复「${wf.displayName}」到版本 #${r.revision}（源文件未改动）`, "ok");
                        const list = await listWorkflowRevisions(wf.workflowId);
                        setRevs(list);
                      } catch (e) {
                        toast(errMsg(e), "err");
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    恢复
                  </button>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="cfs-empty sm">还没有历史版本（同步一次之后，每次内容变化都会自动留档：最近 20 个 + 7 天内 + 你标记保留的）。</div>
        )}
        {bidirectional ? (
          <div className="cfs-rev-writeback">
            <button
              className="btn sm"
              disabled={busy}
              title="把 MOMO 当前正文完整写回源文件（覆盖 ComfyUI 侧内容；一般用于恢复版本后让源文件也跟上）"
              onClick={async () => {
                if (!confirm(`把「${wf.displayName}」的 MOMO 当前版本完整写回源文件？\n源文件里 ComfyUI 侧的未同步改动会被覆盖。`)) return;
                setBusy(true);
                try {
                  await writeFullWorkflowSource(wf.workflowId);
                  toast("已完整写回源文件 ✓", "ok");
                } catch (e) {
                  toast(errMsg(e), "err");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <IcUpload size={14} /> 写回源文件
            </button>
            <span className="cfs-hint">双向模式：把 MOMO 当前版本完整替换源文件</span>
          </div>
        ) : null}
        {diff ? <DiffRowsView view={diff} onClose={() => setDiff(null)} /> : null}
      </div>
    </div>
  );
}

/** 差异视图（规格 FR-014） */
function DiffRowsView({ view, onClose }: { view: DiffView; onClose: () => void }) {
  const KIND_LABEL: Record<string, string> = {
    "node+": "新增节点",
    "node-": "删除节点",
    param: "参数",
    move: "位置",
    resize: "尺寸",
    link: "连线",
    group: "分组",
    meta: "扩展字段",
  };
  return (
    <div className="cfs-diff">
      <div className="cfs-diff-head">
        <b>{view.title}</b>
        <span className="cfs-hint">{view.summary ?? "内容一致"}</span>
        <button className="icon-btn" title="关闭对比" onClick={onClose}>
          <IcClose size={16} />
        </button>
      </div>
      {view.rows.length ? (
        <div className="cfs-diff-list">
          {view.rows.slice(0, 200).map((r, i) => (
            <div key={i} className={`cfs-diff-row k-${r.kind}`}>
              <span className="cfs-diff-kind">{KIND_LABEL[r.kind] ?? r.kind}</span>
              <span className="cfs-diff-text">{r.text}</span>
              {r.detail ? <span className="cfs-hint">{r.detail}</span> : null}
            </div>
          ))}
          {view.rows.length > 200 ? <div className="cfs-hint">…还有 {view.rows.length - 200} 条未显示</div> : null}
        </div>
      ) : (
        <div className="cfs-hint">没有差异。</div>
      )}
    </div>
  );
}
