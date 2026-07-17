/**
 * 自绘标题栏 — 品牌 / 画板切换 / 主题 / 设置 / 窗口控制
 */
import { useEffect, useRef, useState } from "react";
import { useBoard } from "../../core/stores/boardStore";
import { useSettings } from "../../core/stores/settingsStore";
import { useUi } from "../../core/stores/uiStore";
import { useAssets } from "../../core/stores/assetStore";
import { isTauri } from "../../core/utils";
import {
  IcClose,
  IcGallery,
  IcGear,
  IcHistory,
  IcLibrary,
  IcLogo,
  IcMax,
  IcMin,
  IcMoon,
  IcPlus,
  IcRestore,
  IcSun,
  IcTrash,
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
          {histList.length === 0 ? (
            <div className="brow" style={{ color: "var(--text-3)", cursor: "default" }}>
              暂无历史画布——关闭标签后会收进这里
            </div>
          ) : (
            histList.map((b) => (
              <div key={b.meta.id} className="brow" onClick={() => { restoreBoard(b.meta.id); setHistOpen(false); }}>
                <span className="bn">
                  {b.meta.name}
                  <span style={{ color: "var(--text-3)", fontWeight: 500, fontSize: 11.5, marginLeft: 7 }}>
                    {new Date(b.meta.updatedAt).toLocaleDateString()} · {b.nodes.length} 节点
                  </span>
                </span>
                <button
                  className="icon-btn danger"
                  title="彻底删除（不可恢复）"
                  onClick={(e) => {
                    e.stopPropagation();
                    purgeBoard(b.meta.id);
                  }}
                >
                  <IcTrash size={15} />
                </button>
              </div>
            ))
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
