/**
 * 自绘标题栏 — 品牌 / 画板切换 / 主题 / 设置 / 窗口控制
 */
import { useEffect, useRef, useState } from "react";
import { useBoard } from "../../core/stores/boardStore";
import { resolveModelCard, useSettings } from "../../core/stores/settingsStore";
import { toast, useUi, type ErrLogItem } from "../../core/stores/uiStore";
import { useAssets } from "../../core/stores/assetStore";
import { useRunLog, type RunLogEntry } from "../../core/stores/logStore";
import { chatStream } from "../../core/services/llm";
import { ERR_ANALYZE_SYSTEM, buildErrContext, extractProtocolFix } from "../../core/errorHelp";
import { errMsg, isTauri } from "../../core/utils";
import {
  IcActivity,
  IcBell,
  IcCheck,
  IcClose,
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
        <div className="board-pop glass">
          <div className="bp-title">画布历史 · 除非手动删除，永久保留</div>
          {histList.length === 0 ? (
            <div className="brow" style={{ color: "var(--text-3)", cursor: "default" }}>
              暂无历史画布——关闭标签后会收进这里
            </div>
          ) : (
            <div className="bp-grid">
              {histList.map((b) => (
                <div
                  key={b.meta.id}
                  className="bcard"
                  title="点击恢复该画布"
                  onClick={() => {
                    restoreBoard(b.meta.id);
                    setHistOpen(false);
                  }}
                >
                  <span className="bc-ic">
                    <IcHistory size={18} />
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
                      purgeBoard(b.meta.id);
                    }}
                  >
                    <IcTrash size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** 报错中心：铃铛按钮 + 历史报错弹层（每条可让 AI 分析并给方案，协议配置类问题可一键应用修复） */
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

  const applyFix = (text: string) => {
    const fix = extractProtocolFix(text);
    if (!fix) return;
    const st = useSettings.getState();
    st.update("customProtocols", [...st.settings.customProtocols.filter((x) => x.id !== fix.id), fix]);
    toast(`已应用协议修复：「${fix.name}」，重新运行节点即可`, "ok");
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
                const fix = a && !a.busy ? extractProtocolFix(a.text) : null;
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
                        title="让你配置的默认对话模型分析报错原因并给出解决方案；协议配置类问题可一键修复"
                        disabled={a?.busy}
                        onClick={() => void analyze(e)}
                      >
                        {a?.busy ? <IcLoading size={13} /> : <IcSparkles size={13} />} AI 分析
                      </button>
                    </div>
                    <div className="ep-msg">{e.message}</div>
                    {a?.text ? <div className="ep-ana">{a.text}</div> : null}
                    {fix ? (
                      <button className="btn sm primary" style={{ marginTop: 6 }} onClick={() => applyFix(a!.text)}>
                        <IcCheck size={14} /> 一键应用协议修复（{fix.name}）
                      </button>
                    ) : null}
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
  const [open, setOpen] = useState(false);
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
  const update = useSettings((s) => s.update);
  const openSettings = useUi((s) => s.openSettings);
  const galleryOpen = useUi((s) => s.galleryOpen);
  const setGalleryOpen = useUi((s) => s.setGalleryOpen);
  const galleryCount = useUi((s) => s.gallery.length);
  const libOpen = useAssets((s) => s.open);
  const setLibOpen = useAssets((s) => s.setOpen);
  const charLibOpen = useUi((s) => s.charLibOpen);
  const setCharLibOpen = useUi((s) => s.setCharLibOpen);
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
      <RunLogCenter />
      <ErrCenter />
      <button
        className={`icon-btn ${charLibOpen ? "on" : ""}`}
        title="角色库：内置人物预设，一键生成整套角色素材"
        onClick={() => setCharLibOpen(!charLibOpen)}
      >
        <IcUsers size={19} />
      </button>
      <button className={`icon-btn ${libOpen ? "on" : ""}`} title="资产库" onClick={() => setLibOpen(!libOpen)}>
        <IcLibrary size={19} />
      </button>
      <button
        className={`icon-btn ${galleryOpen ? "on" : ""}`}
        title={`生成记录${galleryCount ? `（${galleryCount}）` : ""}`}
        onClick={() => setGalleryOpen(!galleryOpen)}
      >
        <IcGallery size={19} />
      </button>
      <button
        className="icon-btn"
        title={theme === "dark" ? "切换到白色主题" : "切换到深空蓝主题"}
        onClick={() => update("theme", theme === "dark" ? "light" : "dark")}
      >
        {theme === "dark" ? <IcSun size={19} /> : <IcMoon size={19} />}
      </button>
      <button className="icon-btn" title="设置" onClick={() => openSettings()}>
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
