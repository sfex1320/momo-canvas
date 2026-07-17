/**
 * 自绘标题栏 — 品牌 / 画板切换 / 主题 / 设置 / 窗口控制
 */
import { useEffect, useRef, useState } from "react";
import { useBoard } from "../../core/stores/boardStore";
import { useSettings } from "../../core/stores/settingsStore";
import { useUi } from "../../core/stores/uiStore";
import { isTauri } from "../../core/utils";
import {
  IcCheck,
  IcChevronD,
  IcClose,
  IcEdit,
  IcGallery,
  IcGear,
  IcLayers,
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

function BoardSwitch() {
  const order = useBoard((s) => s.order);
  const boards = useBoard((s) => s.boards);
  const activeId = useBoard((s) => s.activeId);
  const switchBoard = useBoard((s) => s.switchBoard);
  const newBoard = useBoard((s) => s.newBoard);
  const renameBoard = useBoard((s) => s.renameBoard);
  const deleteBoard = useBoard((s) => s.deleteBoard);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
        setEditing(null);
        setConfirmDel(null);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, []);

  const active = boards[activeId];
  return (
    <div className="board-switch" ref={ref}>
      <button onClick={() => setOpen(!open)} title="切换 / 管理画布">
        <IcLayers size={16} />
        <span className="bname">{active?.meta.name ?? "画布"}</span>
        <IcChevronD size={14} />
      </button>
      {open ? (
        <div className="board-pop glass">
          {order.map((id) => {
            const b = boards[id];
            if (!b) return null;
            return (
              <div key={id} className={`brow ${id === activeId ? "on" : ""}`} onClick={() => switchBoard(id)}>
                {editing === id ? (
                  <input
                    className="input"
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
                  <span className="bn">{b.meta.name}</span>
                )}
                <button
                  className="icon-btn"
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing(id);
                  }}
                >
                  <IcEdit size={15} />
                </button>
                {order.length > 1 ? (
                  confirmDel === id ? (
                    <button
                      className="icon-btn danger"
                      style={{ opacity: 1, color: "var(--danger)" }}
                      title="再点一次确认删除"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteBoard(id);
                        setConfirmDel(null);
                      }}
                    >
                      <IcCheck size={15} />
                    </button>
                  ) : (
                    <button
                      className="icon-btn danger"
                      title="删除画布"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDel(id);
                      }}
                    >
                      <IcTrash size={15} />
                    </button>
                  )
                ) : null}
              </div>
            );
          })}
          <div className="brow new-row" onClick={() => newBoard()}>
            <IcPlus size={16} />
            <span className="bn">新建画布</span>
          </div>
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
  const { maximized, call } = useWindowControls();

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <IcLogo size={24} />
        <span data-tauri-drag-region>
          MOMO <span className="grad-text">智能画布</span>
        </span>
      </div>
      <BoardSwitch />
      <div className="spacer" data-tauri-drag-region />
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
