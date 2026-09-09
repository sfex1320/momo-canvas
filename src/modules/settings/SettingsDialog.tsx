/**
 * 设置面板 — 模型配置（多套卡片） / 联网搜索 / 图片保存 / ComfyUI / 外观
 * 各 tab 实现在 ./tabs/ 下；共享件在 ./shared.tsx；配置导出导入在 ./cfgIO.ts
 */
import type React from "react";
import { Modal } from "../../ui/kit";
import { useUi } from "../../core/stores/uiStore";
import {
  IcActivity, IcEagle, IcFolder, IcGlobe, IcKeyboard, IcLayers, IcLink, IcLogo, IcMusic, IcPalette, IcSparkles, IcUpscale,
} from "../../ui/icons";
import { EnhanceModelsTab } from "./EnhanceModelsTab";
import { EagleTab } from "./tabs/EagleTab";
import { ModelsTab } from "./tabs/ModelsTab";
import { SearchTab } from "./tabs/SearchTab";
import { SaveTab } from "./tabs/SaveTab";
import { ComfyTab } from "./tabs/ComfyTab";
import { McpTab } from "./tabs/McpTab";
import { SoundTab } from "./tabs/SoundTab";
import { HotkeysTab } from "./tabs/HotkeysTab";
import { AppearanceTab } from "./tabs/AppearanceTab";
import { UsageTab } from "./tabs/UsageTab";
import { AboutTab } from "./tabs/AboutTab";

/** 左侧导航：按「模型 / 通用 / 系统」三组收敛，tab key 保持不变（openSettings 外部调用不受影响） */
const TAB_GROUPS: { label: string; tabs: { key: string; label: string; icon: React.ReactNode }[] }[] = [
  {
    label: "模型",
    tabs: [
      { key: "models", label: "模型配置", icon: <IcSparkles size={17} /> },
      { key: "search", label: "联网搜索", icon: <IcGlobe size={17} /> },
      { key: "enhanceModels", label: "超清模型", icon: <IcUpscale size={17} /> },
      { key: "comfy", label: "ComfyUI", icon: <IcLayers size={17} /> },
      { key: "mcp", label: "MCP 工具", icon: <IcLink size={17} /> },
      { key: "eagle", label: "Eagle 资产桥", icon: <IcEagle size={17} /> },
    ],
  },
  {
    label: "通用",
    tabs: [
      { key: "save", label: "图片保存", icon: <IcFolder size={17} /> },
      { key: "sound", label: "音效提醒", icon: <IcMusic size={17} /> },
      { key: "hotkeys", label: "快捷键", icon: <IcKeyboard size={17} /> },
      { key: "appearance", label: "外观主题", icon: <IcPalette size={17} /> },
    ],
  },
  {
    label: "系统",
    tabs: [
      { key: "usage", label: "用量与稳定性", icon: <IcActivity size={17} /> },
      { key: "about", label: "关于与更新", icon: <IcLogo size={17} /> },
    ],
  },
];

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  const tab = useUi((s) => s.settingsTab);
  const close = useUi((s) => s.closeSettings);
  const openSettings = useUi((s) => s.openSettings);
  const shifted = useUi((s) => s.sideEditorOpen);
  if (!open) return null;
  return (
    <Modal title="设置" onClose={close} width={1180} className={shifted ? "shifted" : ""}>
      <div className="settings-body">
        <div className="settings-nav">
          {TAB_GROUPS.map((g) => (
            <div key={g.label} style={{ display: "contents" }}>
              <div className="set-nav-group">{g.label}</div>
              {g.tabs.map((t) => (
                <button key={t.key} className={tab === t.key ? "on" : ""} onClick={() => openSettings(t.key)}>
                  {t.icon}
                  {t.label}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="settings-content">
          {tab === "models" && <ModelsTab />}
          {tab === "search" && <SearchTab />}
          {tab === "save" && <SaveTab />}
          {tab === "enhanceModels" && <EnhanceModelsTab />}
          {tab === "comfy" && <ComfyTab />}
          {tab === "mcp" && <McpTab />}
          {tab === "eagle" && <EagleTab />}
          {tab === "sound" && <SoundTab />}
          {tab === "hotkeys" && <HotkeysTab />}
          {tab === "appearance" && <AppearanceTab />}
          {tab === "usage" && <UsageTab />}
          {tab === "about" && <AboutTab />}
        </div>
      </div>
    </Modal>
  );
}
