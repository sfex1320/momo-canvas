import { useEffect, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { Titlebar } from "./modules/shell/Titlebar";
import { SmartCanvas } from "./modules/canvas/SmartCanvas";
import { GalleryDock } from "./modules/shell/GalleryDock";
import { SettingsDialog } from "./modules/settings/SettingsDialog";
import { TemplateManager } from "./modules/comfy/TemplateManager";
import { useSettings } from "./core/stores/settingsStore";
import { useBoard } from "./core/stores/boardStore";
import { useComfy } from "./core/stores/comfyStore";
import { useUi } from "./core/stores/uiStore";
import { IcLogo } from "./ui/icons";

function Toasts() {
  const toasts = useUi((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type === "err" ? "err" : t.type === "ok" ? "ok" : ""}`}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}

function Lightbox() {
  const src = useUi((s) => s.lightbox);
  const set = useUi((s) => s.setLightbox);
  if (!src) return null;
  return (
    <div className="lightbox" onClick={() => set(null)}>
      <img src={src} alt="" />
    </div>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void Promise.all([useSettings.getState().init(), useBoard.getState().init(), useComfy.getState().init()]).then(() =>
      setReady(true),
    );
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
      <Lightbox />
      <Toasts />
    </ReactFlowProvider>
  );
}
