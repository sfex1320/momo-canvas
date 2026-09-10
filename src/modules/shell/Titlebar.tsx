/**
 * 自绘标题栏 — 品牌 / 画板切换 / 主题 / 设置 / 窗口控制
 */
import { useEffect, useRef, useState } from "react";
import { useBoard } from "../../core/stores/boardStore";
import { resolveModelCard, useSettings } from "../../core/stores/settingsStore";
import { toast, useUi, type ErrLogItem } from "../../core/stores/uiStore";
import { useAssets } from "../../core/stores/assetStore";
import { useComfySync } from "../../core/stores/comfySyncStore";
import { syncHealthOf } from "../../core/comfySync/health";
import { useRunLog, type RunLogEntry } from "../../core/stores/logStore";
import { chatStream } from "../../core/services/llm";
import { freeComfyMemory, freeResultText } from "../../core/services/comfy";
import { ERR_ANALYZE_SYSTEM, buildErrContext } from "../../core/errorHelp";
import { errMsg, isTauri } from "../../core/utils";
import {
  IcActivity,
  IcBell,
  IcClose,
  IcBlack,
  IcBroom,
  IcFlow,
  IcGallery,
  IcGear,
  IcHistory,
  IcLibrary,
  IcLoading,
  IcLogo,
  IcMax,
  IcMin,
  IcMoon,
  IcPlus,
  IcRestore,
  IcSparkles,
  IcSun,
  IcTrash,
  IcUsers,
} from "../../ui/icons";

function useWindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!isTauri) return;
    let un: (() => void) | undefined;
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow();
      setMaximized(await w.isMaximized());
      un = await w.onResized(async () => setMaximized(await w.isMaximized()));
    })();
    return () => un?.();
  }, []);
  const call = async (fn: "minimize" | "toggleMaximize" | "close") => {
    if (!isTauri) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow()[fn]();
  };
  return { maximized, call };
}

/** 画布历史弹窗：一页最多 6 列 × 2 行；超出分页，底部页码点，滚轮 / 拖拽空白处翻页 */
function BoardHistoryPop({
  list,
  onPick,
  onPurge,
}: {
  list: { meta: { id: string; name: string; updatedAt: number }; nodes: unknown[] }[];
  onPick: (id: string) => void;
  onPurge: (id: string) => void;
}) {
  const COLS_MAX = 6;
  const ROWS = 2;
  const cols = Math.min(COLS_MAX, Math.max(1, Math.ceil(list.length / ROWS)));
  const perPage = cols * ROWS;
  const pages = Math.max(1, Math.ceil(list.length / perPage));
  const [page, setPage] = useState(0);
  const drag = useRef<{ x: number; moved: boolean } | null>(null);
  const cur = Math.min(page, pages - 1);
  const items = list.slice(cur * perPage, cur * perPage + perPage);
  const go = (d: number) => setPage((p) => Math.max(0, Math.min(pages - 1, p + d)));

  return (
    <div
      className="board-pop glass bhist"
      // 弹窗宽度跟着卡片数走：每列 158px + 间距，最多 6 列
      style={{ width: cols * 158 + (cols - 1) * 8 + 20 }}
      onWheel={(e) => {
        if (pages < 2) return;
        e.preventDefault();
        go(e.deltaY > 0 || e.deltaX > 0 ? 1 : -1);
      }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest(".bcard, button")) return;
        drag.current = { x: e.clientX, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.moved) return;
        const dx = e.clientX - d.x;
        if (Math.abs(dx) > 48) {
          d.moved = true;
          go(dx < 0 ? 1 : -1);
        }
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerLeave={() => (drag.current = null)}
    >
      <div className="bp-title">画布历史 · 除非手动删除，永久保留{pages > 1 ? "（滚轮 / 拖动空白处翻页）" : ""}</div>
      {list.length === 0 ? (
        <div className="brow" style={{ color: "var(--text-3)", cursor: "default" }}>
          暂无历史画布——关闭标签后会收进这里
        </div>
      ) : (
        <>
          <div className="bp-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {items.map((b) => (
              <div key={b.meta.id} className="bcard" title="点击恢复该画布" onClick={() => onPick(b.meta.id)}>
                <span className="bc-ic">
                  <IcHistory size={16} />
                </span>
                <b>{b.meta.name}</b>
                <span className="bc-meta">
                  {new Date(b.meta.updatedAt).toLocaleDateString()} · {b.nodes.length} 节点
                </span>
                <button
                  className="icon-btn danger bc-del"
                  title="彻底删除（不可恢复）"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPurge(b.meta.id);
                  }}
                >
                  <IcTrash size={13} />
                </button>
              </div>
            ))}
          </div>
          {pages > 1 ? (
            <div className="bp-pager">
              <span className="bp-pnum">
                {cur + 1} / {pages}
              </span>
              <span className="bp-dots">
                {Array.from({ length: pages }, (_, i) => (
                  <button
                    key={i}
                    className={`bp-dot ${i === cur ? "on" : ""}`}
                    title={`第 ${i + 1} 页`}
                    onClick={() => setPage(i)}
                  />
                ))}
              </span>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** 浏览器式画布标签：单击切换 · 双击重命名 · × 关闭进历史 · + 新建 · 历史可恢复 */
function BoardTabs() {
  const order = useBoard((s) => s.order);
  const boards = useBoard((s) => s.boards);
  const activeId = useBoard((s) => s.activeId);
  const archived = useBoard((s) => s.archived);
  const switchBoard = useBoard((s) => s.switchBoard);
  const newBoard = useBoard((s) => s.newBoard);
  const renameBoard = useBoard((s) => s.renameBoard);
  const archiveBoard = useBoard((s) => s.archiveBoard);
  const restoreBoard = useBoard((s) => s.restoreBoard);
  const purgeBoard = useBoard((s) => s.purgeBoard);
  const [editing, setEditing] = useState<string | null>(null);
  const [histOpen, setHistOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setHistOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, []);

  const histList = Object.values(archived).sort((a, b) => b.meta.updatedAt - a.meta.updatedAt);

  return (
    <div className="board-tabs" ref={ref}>
      <div className="bt-scroll">
        {order.map((id) => {
          const b = boards[id];
          if (!b) return null;
          const on = id === activeId;
          return (
            <div
              key={id}
              className={`btab ${on ? "on" : ""}`}
              title={`${b.meta.name}（双击重命名）`}
              onClick={() => switchBoard(id)}
              onDoubleClick={() => setEditing(id)}
            >
              {editing === id ? (
                <input
                  autoFocus
                  defaultValue={b.meta.name}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      renameBoard(id, (e.target as HTMLInputElement).value.trim() || b.meta.name);
                      setEditing(null);
                    }
                    if (e.key === "Escape") setEditing(null);
                  }}
                  onBlur={(e) => {
                    renameBoard(id, e.target.value.trim() || b.meta.name);
                    setEditing(null);
                  }}
                />
              ) : (
                <span className="bt-name">{b.meta.name}</span>
              )}
              <button
                className="bt-close"
                title="关闭画布（进入画布历史，可恢复）"
                onClick={(e) => {
                  e.stopPropagation();
                  archiveBoard(id);
                }}
              >
                <IcClose size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <button className="bt-add" title="新建画布" onClick={() => newBoard()}>
        <IcPlus size={15} />
      </button>
      <button
        className={`bt-add ${histOpen ? "on" : ""}`}
        title={`画布历史（${histList.length}）：恢复或彻底删除关闭过的画布`}
        onClick={() => setHistOpen(!histOpen)}
      >
        <IcHistory size={15} />
      </button>
      {histOpen ? (
        <BoardHistoryPop
          list={histList}
          onPick={(id) => {
            restoreBoard(id);
            setHistOpen(false);
          }}
          onPurge={purgeBoard}
        />
      ) : null}
    </div>
  );
}

/** 报错中心：铃铛按钮 + 历史报错弹层（每条可让 AI 分析并给解决方案） */
function ErrCenter() {
  const errlog = useUi((s) => s.errlog);
  const open = useUi((s) => s.errlogOpen);
  const unread = useUi((s) => s.errlogUnread);
  const setOpen = useUi((s) => s.setErrlogOpen);
  const clear = useUi((s) => s.clearErrlog);
  const ref = useRef<HTMLDivElement>(null);
  /** AI 分析状态：报错条目 id → 流式结果 */
  const [ana, setAna] = useState<Record<string, { busy: boolean; text: string }>>({});

  const analyze = async (e: ErrLogItem) => {
    setAna((s) => ({ ...s, [e.id]: { busy: true, text: "" } }));
    try {
      const card = resolveModelCard("chat");
      const user = `报错来源：${e.source}\n报错内容：\n${e.message}\n\n当前配置上下文（不含密钥）：\n${buildErrContext()}`;
      const { text } = await chatStream(card, [{ role: "user", text: user }], {
        system: ERR_ANALYZE_SYSTEM,
        onText: (full) => setAna((s) => ({ ...s, [e.id]: { busy: true, text: full } })),
      });
      setAna((s) => ({ ...s, [e.id]: { busy: false, text } }));
    } catch (err) {
      setAna((s) => ({ ...s, [e.id]: { busy: false, text: `分析失败：${errMsg(err)}` } }));
    }
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, setOpen]);

  return (
    <div className="err-center" ref={ref}>
      <button
        className={`icon-btn ${open ? "on" : ""}`}
        title={`报错中心${errlog.length ? `（${errlog.length} 条）` : "：暂无报错"}`}
        onClick={() => setOpen(!open)}
      >
        <IcBell size={19} />
        {unread ? <i className="err-badge">{unread > 9 ? "9+" : unread}</i> : null}
      </button>
      {open ? (
        <div className="err-pop glass">
          <div className="ep-head">
            <b>报错历史</b>
            <span style={{ flex: 1 }} />
            {errlog.length ? (
              <button className="btn sm" onClick={clear}>
                清空
              </button>
            ) : null}
          </div>
          {errlog.length === 0 ? (
            <div className="ep-empty">暂无报错记录——任务出错时会收进这里</div>
          ) : (
            <div className="ep-list">
              {errlog.map((e) => {
                const a = ana[e.id];
                return (
                  <div key={e.id} className="ep-item">
                    <div className="ep-meta">
                      <span className="ep-src">{e.source}</span>
                      <span className="ep-time">
                        {new Date(e.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </span>
                      <button
                        className="btn sm"
                        style={{ minHeight: 24, padding: "1px 8px" }}
                        title="让你配置的默认对话模型分析报错原因并给出解决方案"
                        disabled={a?.busy}
                        onClick={() => void analyze(e)}
                      >
                        {a?.busy ? <IcLoading size={13} /> : <IcSparkles size={13} />} AI 分析
                      </button>
                    </div>
                    <div className="ep-msg">{e.message}</div>
                    {a?.text ? <div className="ep-ana">{a.text}</div> : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** 一键释放 ComfyUI 显存与内存（/free）：卸载模型 + 清缓存，完成后报告释放量 */
function MemFreeBtn() {
  const host = useSettings((s) => s.settings.comfy.host);
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="icon-btn"
      title="一键释放 ComfyUI 显存与内存：卸载模型并清理缓存，下次运行会重新加载模型"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const r = await freeComfyMemory(host);
        setBusy(false);
        toast(freeResultText(r), r.ok ? "ok" : "err");
      }}
    >
      {busy ? <IcLoading size={19} /> : <IcBroom size={19} />}
    </button>
  );
}

/** 单条运行日志：一行摘要，点开看请求体/响应体 */
function RunLogRow({ e }: { e: RunLogEntry }) {
  const [open, setOpen] = useState(false);
  let host = e.url;
  let path = "";
  try {
    const u = new URL(e.url);
    host = u.host;
    path = u.pathname + (u.search.length > 1 ? "?…" : "");
  } catch {
    /* 保持原样 */
  }
  const bad = e.error !== undefined || e.ok === false;
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => toast("已复制", "ok"));
  };
  return (
    <div className={`rl-item ${bad ? "bad" : ""}`}>
      <div className="rl-line" onClick={() => setOpen(!open)}>
        <span className={`rl-status ${bad ? "bad" : "ok"}`}>{e.status ?? "网络错误"}</span>
        <span className="rl-method">{e.method}</span>
        <span className="rl-url" title={e.url}>
          <b>{host}</b>
          {path}
        </span>
        {e.count > 1 ? <span className="rl-count">×{e.count}</span> : null}
        <span className="rl-dur">{e.durMs >= 1000 ? `${(e.durMs / 1000).toFixed(1)}s` : `${e.durMs}ms`}</span>
        <span className="rl-time">
          {new Date(e.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </span>
      </div>
      {open ? (
        <div className="rl-detail">
          {e.error ? <div className="rl-err">{e.error}</div> : null}
          {e.reqBody ? (
            <>
              <div className="rl-cap">
                请求体
                <button className="btn sm" onClick={() => copy(e.reqBody!)}>复制</button>
              </div>
              <pre>{e.reqBody}</pre>
            </>
          ) : null}
          {e.respBody ? (
            <>
              <div className="rl-cap">
                响应体
                <button className="btn sm" onClick={() => copy(e.respBody!)}>复制</button>
              </div>
              <pre>{e.respBody}</pre>
            </>
          ) : null}
          {!e.reqBody && !e.respBody && !e.error ? <div className="rl-cap">（无正文记录）</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/** 运行日志中心：所有对外请求的流水（脱敏），排查中转站问题第一入口 */
function RunLogCenter() {
  const entries = useRunLog((s) => s.entries);
  // 开关放 store：标题栏按钮与快捷键共用同一状态
  const open = useUi((s) => s.runLogOpen);
  const setOpen = useUi((s) => s.setRunLogOpen);
  const [onlyBad, setOnlyBad] = useState(false);
  const [kw, setKw] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void useRunLog.getState().init();
  }, []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const list = entries.filter((e) => {
    if (onlyBad && !(e.error !== undefined || e.ok === false)) return false;
    if (kw && !`${e.url} ${e.reqBody ?? ""} ${e.respBody ?? ""} ${e.error ?? ""}`.toLowerCase().includes(kw.toLowerCase()))
      return false;
    return true;
  });

  return (
    <div className="err-center" ref={ref}>
      <button
        className={`icon-btn ${open ? "on" : ""}`}
        title="运行日志：每次生成的实际请求与响应（已脱敏），排查中转站问题先看这里"
        onClick={() => setOpen(!open)}
      >
        <IcActivity size={19} />
      </button>
      {open ? (
        <div className="err-pop glass rl-pop">
          <div className="ep-head">
            <b>运行日志</b>
            <span className="ep-sub">已脱敏：不记录密钥，正文截断</span>
            <span style={{ flex: 1 }} />
            <input
              className="input rl-kw"
              placeholder="搜索 URL / 正文…"
              value={kw}
              onChange={(e) => setKw(e.target.value)}
            />
            <button className={`btn sm ${onlyBad ? "primary" : ""}`} onClick={() => setOnlyBad(!onlyBad)}>
              仅失败
            </button>
            {entries.length ? (
              <button className="btn sm" onClick={() => useRunLog.getState().clear()}>
                清空
              </button>
            ) : null}
          </div>
          {list.length === 0 ? (
            <div className="ep-empty">
              {entries.length ? "没有匹配的日志" : "暂无请求记录——运行任意生成节点后，这里会出现每次请求的完整流水"}
            </div>
          ) : (
            <div className="ep-list rl-list">
              {list.map((e) => (
                <RunLogRow key={e.id} e={e} />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}


export function Titlebar() {
  const theme = useSettings((s) => s.settings.theme);
  const hotkeys = useSettings((s) => s.settings.hotkeys);
  const update = useSettings((s) => s.update);
  /** 标题栏按钮的 title 后缀：显示当前绑定的快捷键（设置 → 快捷键 可改） */
  const hk = (a: keyof typeof hotkeys) => (hotkeys[a] ? `（${hotkeys[a].replace(/\+/g, " + ").toUpperCase()}）` : "");
  const openSettings = useUi((s) => s.openSettings);
  const galleryOpen = useUi((s) => s.galleryOpen);
  const setGalleryOpen = useUi((s) => s.setGalleryOpen);
  const galleryCount = useUi((s) => s.gallery.length);
  const libOpen = useAssets((s) => s.open);
  const setLibOpen = useAssets((s) => s.setOpen);
  const charLibOpen = useUi((s) => s.charLibOpen);
  const setCharLibOpen = useUi((s) => s.setCharLibOpen);
  const agentOpen = useUi((s) => s.agentOpen);
  const setAgentOpen = useUi((s) => s.setAgentOpen);
  const comfySyncOpen = useUi((s) => s.comfySyncOpen);
  const setComfySyncOpen = useUi((s) => s.setComfySyncOpen);
  const syncSources = useComfySync((s) => s.sources);
  const syncWorkflows = useComfySync((s) => s.workflows);
  const syncRunning = useComfySync((s) => s.running);
  const syncHealth = syncHealthOf(syncSources, syncWorkflows, syncRunning);
  const { maximized, call } = useWindowControls();

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <IcLogo size={24} />
        <span data-tauri-drag-region>
          MOMO <span className="grad-text">智能画布</span>
        </span>
      </div>
      <BoardTabs />
      <div className="spacer" data-tauri-drag-region />
      <button
        className={`icon-btn ${agentOpen ? "on" : ""}`}
        title={
          (agentOpen ? "收起创作助手" : "创作助手：侧边聊天完善想法/提示词（可附图/联网/语音通话），或 Agent 自动搜资料出图出片") +
          hk("agent")
        }
        onClick={() => setAgentOpen(!agentOpen)}
      >
        <IcSparkles size={19} />
      </button>
      <RunLogCenter />
      <ErrCenter />
      <MemFreeBtn />
      {(() => {
        // Comfy 同步入口（规格 §6.1：状态点 灰=未配置 绿=正常 蓝=有新 黄=警告 红=失败）
        const dotTitle: Record<string, string> = {
          off: "Comfy 同步未启用",
          empty: "Comfy 同步：未配置来源",
          ok: "Comfy 同步：全部正常",
          new: "Comfy 同步：有新发现或待同步内容",
          warn: "Comfy 同步：来源离线或有警告",
          error: "Comfy 同步：存在失败",
        };
        return (
          <button
            className={`icon-btn ${comfySyncOpen ? "on" : ""}`}
            title={`Comfy 工作流同步：配置一次 ComfyUI 工作流目录，之后自动同步，无需再导出 API JSON\n${dotTitle[syncHealth] ?? ""}`}
            onClick={() => setComfySyncOpen(!comfySyncOpen)}
          >
            <IcFlow size={19} />
            <i className={`tb-sync-dot d-${syncHealth}`} />
          </button>
        );
      })()}
      <button
        className={`icon-btn ${charLibOpen ? "on" : ""}`}
        title={`角色库：内置人物预设，一键生成整套角色素材${hk("charLib")}`}
        onClick={() => setCharLibOpen(!charLibOpen)}
      >
        <IcUsers size={19} />
      </button>
      <button className={`icon-btn ${libOpen ? "on" : ""}`} title={`资产库${hk("assets")}`} onClick={() => setLibOpen(!libOpen)}>
        <IcLibrary size={19} />
      </button>
      <button
        className={`icon-btn ${galleryOpen ? "on" : ""}`}
        title={`生成记录${galleryCount ? `（${galleryCount}）` : ""}${hk("gallery")}`}
        onClick={() => setGalleryOpen(!galleryOpen)}
      >
        <IcGallery size={19} />
      </button>
      {(() => {
        // 三态轮换：云白 → 深空蓝 → 深邃黑 → 云白
        const Icon = theme === "light" ? IcSun : theme === "dark" ? IcMoon : IcBlack;
        const title =
          theme === "light"
            ? "当前：云白 · 点击切换到深空蓝"
            : theme === "dark"
              ? "当前：深空蓝 · 点击切换到深邃黑"
              : "当前：深邃黑 · 点击切换到云白";
        return (
          <button
            className="icon-btn"
            title={title + hk("theme")}
            onClick={() => update("theme", theme === "light" ? "dark" : theme === "dark" ? "black" : "light")}
          >
            <Icon size={19} />
          </button>
        );
      })()}
      <button className="icon-btn" title={`设置${hk("settings")}`} onClick={() => openSettings()}>
        <IcGear size={19} />
      </button>
      {isTauri ? (
        <div className="win-ctrls">
          <button title="最小化" onClick={() => void call("minimize")}>
            <IcMin size={17} />
          </button>
          <button title={maximized ? "还原" : "最大化"} onClick={() => void call("toggleMaximize")}>
            {maximized ? <IcRestore size={15} /> : <IcMax size={15} />}
          </button>
          <button className="close" title="关闭" onClick={() => void call("close")}>
            <IcClose size={17} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
