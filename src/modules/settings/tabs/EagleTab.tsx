/**
 * 设置面板 · Eagle 资产桥页（极简版）
 *
 * 设计原则「无感」：启用 → 选同步方式 → 选根文件夹，三步完事，其余全自动。
 * 同步方式单一控件承载自动推送/自动拉取（由模式派生，不暴露独立开关）。
 */
import { useEffect, useState } from "react";
import { Field, Row } from "../../../ui/kit";
import { PopSelect } from "../../../ui/PopSelect";
import { useSettings } from "../../../core/stores/settingsStore";
import { useEagle } from "../../../core/stores/eagleStore";
import { detect, ensureRootFolder, retryFailed } from "../../../core/eagleSyncEngine";
import { toast } from "../../../core/stores/uiStore";
import { errMsg, isTauri } from "../../../core/utils";
import type { EagleSyncMode, Settings } from "../../../core/types";
import { IcEagle, IcFolder, IcRefresh } from "../../../ui/icons";
import { SecHelp } from "../shared";

export function EagleTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const eagle = settings.eagle;
  const patch = (part: Partial<Settings["eagle"]>) => update("eagle", { ...eagle, ...part });

  /** 同步方式 → 派生自动推送/自动拉取（保持数据字段兼容，UI 不再单独暴露） */
  const patchMode = (mode: EagleSyncMode) =>
    patch({
      syncMode: mode,
      autoPushGenerated: mode !== "manual",
      autoPullLinked: mode === "bidirectional",
    });

  const conn = useEagle((s) => s.connState);
  const appInfo = useEagle((s) => s.appInfo);
  const library = useEagle((s) => s.library);
  const connectError = useEagle((s) => s.connectError);
  const stats = useEagle((s) => s.stats);

  const [busy, setBusy] = useState(false);

  /* 打开页面时自动检测一次（未启用时静默） */
  useEffect(() => {
    if (!isTauri || !eagle.enabled) return;
    void (async () => {
      setBusy(true);
      await detect();
      setBusy(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doDetect = async () => {
    if (!isTauri) return;
    setBusy(true);
    const r = await detect();
    setBusy(false);
    toast(r.ok ? `已连接：${r.message}` : r.message, r.ok ? "ok" : "err");
  };

  const rootOptions = flattenFolders(library?.folders ?? []).map((f) => ({
    value: f.id,
    label: `${"　".repeat(f.depth)}${f.name}`,
    icon: <IcEagle size={13} />,
  }));
  const hasRootHit = !!library && rootOptions.some((o) => o.value === eagle.rootFolderId);

  const badge =
    !eagle.enabled ? { text: "未启用", cls: "dim" } :
    conn === "ready" ? { text: "已连接", cls: "ok" } :
    conn === "connecting" ? { text: "连接中…", cls: "" } :
    conn === "offline" ? { text: "Eagle 离线", cls: "warn" } :
    conn === "error" ? { text: "连接出错", cls: "danger" } :
    { text: "未检测", cls: "dim" };

  return (
    <div className="set-page">
      <div className="set-page-h">
        <div className="set-page-t">Eagle 资产桥</div>
        <div className="set-page-d">生成的作品自动收进 Eagle 归档，Eagle 里的素材也能拉回画布继续创作——启用后全程无感，失败自动重试。</div>
      </div>

      {/* —— 连接 —— */}
      <div className="set-card">
        <div className="set-card-h">
          连接
          <span className="sec-h-tail">
            <span className={`set-badge ${badge.cls}`}>{badge.text}</span>
          </span>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <input type="checkbox" checked={eagle.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          <b>启用 Eagle 同步</b>
        </label>
        <Field label="Eagle 地址" hint="本机默认即可；改动后点「检测」生效">
          <Row gap={8}>
            <input className="input" style={{ maxWidth: 280 }} value={eagle.host} placeholder="http://127.0.0.1:41595"
              onChange={(e) => patch({ host: e.target.value.trim() })} />
            <button className="btn sm" disabled={busy || !eagle.enabled} onClick={() => void doDetect()}>
              <IcRefresh size={13} /> 检测 Eagle
            </button>
          </Row>
        </Field>
        {conn === "ready" && appInfo ? (
          <div className="set-hint ok">
            已连接 Eagle {appInfo.version} · 素材库「{library?.name}」{bridgeSuffix()}
          </div>
        ) : null}
        {connectError ? <div className="set-hint danger">{connectError}</div> : null}
      </div>

      {/* —— 同步 —— */}
      <div className="set-card">
        <div className="set-card-h">
          同步方式
          <span className="sec-h-tail">
            <SecHelp>
              自动推送（推荐）：画布生成落库后自动进 Eagle，不等不卡。
              双向同步在此基础上监听 Eagle 端的修改，素材在 Eagle 里被加工后会以新版本自动回流，原版本保留。
              任何一端删除都只解除绑定，不删对方文件。
            </SecHelp>
          </span>
        </div>
        <Field label="同步方式">
          <PopSelect
            style={{ width: 260 }}
            value={eagle.syncMode}
            options={[
              { value: "manual", label: "手动同步", desc: "只在资产卡右键时上传", icon: <IcEagle size={13} /> },
              { value: "push", label: "自动推送（推荐）", desc: "生成后自动收进 Eagle", icon: <IcEagle size={13} /> },
              { value: "bidirectional", label: "双向同步", desc: "自动推送 + Eagle 端修改自动回流", icon: <IcEagle size={13} /> },
            ]}
            onChange={(v) => patchMode(v as EagleSyncMode)}
          />
        </Field>
        <Field label="根文件夹" hint="MOMO 的作品在 Eagle 里统一收进它（画布名作子文件夹）；不存在时自动创建">
          <Row gap={8}>
            {library ? (
              <>
                <PopSelect
                  style={{ width: 280 }}
                  value={eagle.rootFolderId ?? ""}
                  placeholder={rootOptions.length ? "选择现有文件夹…" : undefined}
                  options={[
                    { value: "", label: `自动创建「${eagle.rootFolderName || "MOMO"}」`, icon: <IcFolder size={13} /> },
                    ...rootOptions,
                  ]}
                  onChange={(v) => patch({ rootFolderId: v || undefined })}
                />
                <button
                  className="btn sm"
                  title="确认根文件夹就位（不存在时自动创建）"
                  onClick={() =>
                    void ensureRootFolder({ createIfMissing: true })
                      .then((id) => (id ? toast("根文件夹已就位", "ok") : toast("请先检测 Eagle", "err")))
                      .catch((e) => toast(errMsg(e), "err"))
                  }
                >
                  就位
                </button>
              </>
            ) : (
              <input className="input" style={{ maxWidth: 280 }} value={eagle.rootFolderName}
                onChange={(e) => patch({ rootFolderName: e.target.value.trim() || "MOMO" })}
                placeholder="Eagle-Momo" />
            )}
            {library && hasRootHit ? <span className="set-hint ok" style={{ alignSelf: "center" }}>✓ 已指定</span> : null}
          </Row>
        </Field>
      </div>

      {/* —— 状态 —— */}
      <div className="set-card">
        <div className="set-card-h">同步状态</div>
        <div className="set-stats">
          <div className="set-stat"><b>{stats.synced}</b><span>已同步</span></div>
          <div className="set-stat"><b>{stats.queued}</b><span>待处理</span></div>
          <div className="set-stat"><b>{stats.conflict}</b><span>冲突</span></div>
          <div className="set-stat"><b>{stats.failed}</b><span>失败</span></div>
        </div>
        <Row gap={8} style={{ marginTop: 12 }}>
          <button className="btn sm" disabled={busy || !eagle.enabled} onClick={() => void doDetect()}>
            立即核对
          </button>
          <button className="btn sm" disabled={!eagle.enabled} onClick={() => { const n = retryFailed(); toast(n ? `已重试 ${n} 个失败任务` : "没有失败的同步任务", n ? "ok" : "info"); }}>
            重试失败任务
          </button>
        </Row>
      </div>

      {/* —— 插件 —— */}
      <div className="set-card">
        <div className="set-card-h">
          Eagle 内的 MOMO Link 插件<span className="sec-h-tail"><SecHelp>装上后可直接在 Eagle 里选中素材发送到 MOMO 画布。插件随 MOMO 分发，不用单独下载。</SecHelp></span>
        </div>
        <Row gap={8} style={{ marginBottom: 10 }}>
          <button
            className="btn sm"
            onClick={() => {
              void (async () => {
                try {
                  const { invoke } = await import("@tauri-apps/api/core");
                  const dir = await invoke<string>("eagle_plugin_dir");
                  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
                  await revealItemInDir(dir);
                  toast(`已打开插件目录：${dir}`, "ok");
                } catch (e) {
                  toast(errMsg(e), "err");
                }
              })();
            }}
          >
            <IcFolder size={14} /> 打开插件文件夹
          </button>
        </Row>
        <div className="set-hint">
          Eagle「插件」面板（左侧栏拼图图标）→ 右上「···」→ <b>安装本地插件</b> → 依次选择目录里的 <code>momo-link-service</code> 与 <code>momo-link-inspector</code> 两个文件夹。
        </div>
      </div>
    </div>
  );

  function bridgeSuffix(): string {
    const port = useEagle.getState().bridgePort;
    return port ? ` · 本地桥 :${port}` : "";
  }
}

/* ---------------- 文件夹树工具 ---------------- */

type FlatFolder = { id: string; name: string; depth: number };

function flattenFolders(nodes: { id: string; name: string; children?: unknown[] }[], depth = 0): FlatFolder[] {
  const out: FlatFolder[] = [];
  for (const n of nodes ?? []) {
    out.push({ id: n.id, name: n.name, depth });
    out.push(...flattenFolders((n.children ?? []) as never, depth + 1));
  }
  return out;
}
