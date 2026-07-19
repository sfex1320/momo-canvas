import { useEffect, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { Titlebar } from "./modules/shell/Titlebar";
import { SmartCanvas } from "./modules/canvas/SmartCanvas";
import { GalleryDock } from "./modules/shell/GalleryDock";
import { SettingsDialog } from "./modules/settings/SettingsDialog";
import { TemplateManager } from "./modules/comfy/TemplateManager";
import { AssetLibrary } from "./modules/assets/AssetLibrary";
import { CharLibrary } from "./modules/charlib/CharLibrary";
import { useSettings } from "./core/stores/settingsStore";
import { useBoard } from "./core/stores/boardStore";
import { useComfy } from "./core/stores/comfyStore";
import { useAssets } from "./core/stores/assetStore";
import { useTemplates } from "./core/stores/templateStore";
import { toast, useUi } from "./core/stores/uiStore";
import { autoCheckOnStart } from "./core/services/updater";
import { IcLogo } from "./ui/icons";

function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const setErrlogOpen = useUi((s) => s.setErrlogOpen);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.type === "err" ? "err" : t.type === "ok" ? "ok" : ""}`}
          title={t.type === "err" ? "点击查看报错历史" : undefined}
          onClick={t.type === "err" ? () => setErrlogOpen(true) : undefined}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}

/** 前后对比：拖动分割线擦看原图 ↔ 结果 */
function CompareWipe({ before, after }: { before: string; after: string }) {
  const [pos, setPos] = useState(50);
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return;
    const r = e.currentTarget.getBoundingClientRect();
    setPos(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)));
  };
  return (
    <div
      className="cmp-wipe"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const r = e.currentTarget.getBoundingClientRect();
        setPos(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)));
      }}
      onPointerMove={move}
    >
      <img src={after} alt="" draggable={false} />
      <img src={before} alt="" draggable={false} className="cw-before" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} />
      <div className="cw-bar" style={{ left: `${pos}%` }}>
        <i>⟷</i>
      </div>
      <span className="cw-tag l">原图</span>
      <span className="cw-tag r">结果</span>
    </div>
  );
}

function Lightbox() {
  const src = useUi((s) => s.lightbox);
  const before = useUi((s) => s.lightboxBefore);
  const set = useUi((s) => s.setLightbox);
  const [comparing, setComparing] = useState(false);
  useEffect(() => setComparing(false), [src]);
  if (!src) return null;
  return (
    <div className="lightbox" onClick={() => set(null)}>
      {before && comparing ? <CompareWipe before={before} after={src} /> : <img src={src} alt="" />}
      {before ? (
        <button
          className="btn lb-cmp"
          onClick={(e) => {
            e.stopPropagation();
            setComparing(!comparing);
          }}
        >
          {comparing ? "退出对比" : "⟷ 对比原图"}
        </button>
      ) : null}
    </div>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void Promise.all([
      useSettings.getState().init(),
      useBoard.getState().init(),
      useComfy.getState().init(),
      useAssets.getState().init(),
      useTemplates.getState().init(),
    ]).then(() => setReady(true));
    // 启动 5 秒后静默检查一次更新（失败不打扰）
    const t = setTimeout(() => {
      void autoCheckOnStart((info) => {
        toast(`发现新版本 v${info.version} —— 到「设置 → 关于与更新」一键升级`, "info");
      });
    }, 5000);
    return () => clearTimeout(t);
  }, []);

  /* 屏蔽 webview 默认右键菜单（右键用于平移画布）与 Ctrl+滚轮页面缩放 */
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      e.preventDefault();
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    window.addEventListener("contextmenu", onCtx);
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("contextmenu", onCtx);
      window.removeEventListener("wheel", onWheel);
    };
  }, []);

  if (!ready) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <IcLogo size={56} />
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <Titlebar />
      <SmartCanvas />
      <GalleryDock />
      <SettingsDialog />
      <TemplateManager />
      <AssetLibrary />
      <CharLibrary />
      <Lightbox />
      <Toasts />
    </ReactFlowProvider>
  );
}
