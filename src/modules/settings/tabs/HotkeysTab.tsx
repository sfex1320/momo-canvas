/**
 * 设置面板 · 快捷键页
 */
import { useEffect, useMemo, useState } from "react";
import { useSettings } from "../../../core/stores/settingsStore";
import { toast } from "../../../core/stores/uiStore";
import { DEFAULT_HOTKEYS, HOTKEY_LABEL, type HotkeyAction } from "../../../core/types";
import { SecHelp } from "../shared";

/** 键名 → 键帽显示（方向键用箭头，精致些） */
function keyLabel(key: string): string {
  const map: Record<string, string> = {
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    " ": "Space",
    Escape: "Esc",
    Delete: "Del",
    Backspace: "⌫",
    Enter: "⏎",
    Tab: "⇥ Tab",
  };
  return map[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** 组合键 → 键帽显示（"ctrl+z" → "Ctrl + Z"） */
function comboLabel(combo: string): string {
  return combo
    .split("+")
    .map((p) => (p === "ctrl" ? "Ctrl" : p === "shift" ? "Shift" : p === "alt" ? "Alt" : keyLabel(p)))
    .join(" + ");
}

/** 快捷键分组（设置页两列排布用；未列入的动作会自动归到「其他」） */
const HOTKEY_GROUPS: { title: string; actions: HotkeyAction[] }[] = [
  {
    title: "画布操作",
    actions: ["moveTool", "group", "ignore", "align", "duplicate", "delete", "undo", "redo", "popLock"],
  },
  { title: "视图", actions: ["fitView", "zoomIn", "zoomOut", "zen", "search", "spotlight"] },
  { title: "运行", actions: ["runAll", "runSelected"] },
  {
    title: "面板与窗口",
    actions: ["agent", "voiceCall", "director", "assets", "gallery", "charLib", "errCenter", "runLog", "settings", "theme", "newBoard"],
  },
  {
    title: "添加节点",
    actions: [
      "addImage",
      "addVideo",
      "addAudio",
      "addPrompt",
      "addStylePreset",
      "addNote",
      "addCombine",
      "addStoryboard",
      "addImageGen",
      "addVideoGen",
      "addAudioGen",
      "addComfy",
      "addRelight",
      "addMultiAngle",
      "addCharCard",
      "addEcomImage",
      "addDirector",
      "addEnhanceLocal",
      "addVectorize",
      "addVideoDub",
    ],
  },
  {
    title: "导演台监看器（导演工作区内生效）",
    actions: [
      "dirPlayPause",
      "dirPrevFrame",
      "dirNextFrame",
      "dirPrevSeg",
      "dirNextSeg",
      "dirSetIn",
      "dirSetOut",
      "dirApprove",
      "dirRegen",
      "dirPrompt",
    ],
  },
  { title: "已并入其他功能（保留兼容）", actions: ["addChat", "addLlmText"] },
];

const FIXED_KEYS: { label: string; keys: string[] }[] = [
  { label: "临时平移画布", keys: ["Space", "拖动"] },
  { label: "多选 / 框选连线", keys: ["Ctrl", "点击或框选"] },
  { label: "粘贴图片/文字", keys: ["Ctrl", "V"] },
  { label: "Alt 拖拽复制工作流", keys: ["Alt", "拖动节点"] },
  { label: "导演台切换 Take 1~9（监看器内）", keys: ["1~9"] },
  { label: "导演台变速播放（监看器内）", keys: ["J 慢放", "K 暂停复位", "L 快放"] },
];

export function HotkeysTab() {
  const hotkeys = useSettings((s) => s.settings.hotkeys);
  const update = useSettings((s) => s.update);
  const [capturing, setCapturing] = useState<HotkeyAction | null>(null);

  // 实时冲突检测：同一组合键被多个动作绑定 → 双方标红（录制新键时的拦截只能防新增，标红负责暴露存量冲突）
  const clashOf = useMemo(() => {
    const byKey = new Map<string, HotkeyAction[]>();
    for (const [a, k] of Object.entries(hotkeys) as [HotkeyAction, string][]) {
      if (!k) continue;
      const key = k.toLowerCase();
      const list = byKey.get(key) ?? [];
      list.push(a);
      byKey.set(key, list);
    }
    const out = new Map<HotkeyAction, HotkeyAction>(); // 冲突方 → 冲突对方（互相指认）
    for (const list of byKey.values()) {
      if (list.length > 1) list.forEach((a, i) => out.set(a, list[(i + 1) % list.length]));
    }
    return out;
  }, [hotkeys]);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const base = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const mods = [(e.ctrlKey || e.metaKey) && "ctrl", e.shiftKey && "shift", e.altKey && "alt"].filter(
        Boolean,
      ) as string[];
      if (capturing === "delete" && mods.length) {
        toast("删除请绑定单键（如 Del / X），暂不支持组合键删除", "err");
        return;
      }
      const combo = [...mods, base].join("+");
      const clash = (Object.entries(hotkeys) as [HotkeyAction, string][]).find(
        ([a, k]) => k.toLowerCase() === combo.toLowerCase() && a !== capturing,
      );
      if (clash) {
        toast(`「${comboLabel(combo)}」已分配给：${HOTKEY_LABEL[clash[0]]}`, "err");
        return;
      }
      update("hotkeys", { ...hotkeys, [capturing]: combo });
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, hotkeys, update]);

  return (
    <div className="set-page">
      <div className="set-page-h">
        <div className="set-page-t">
          快捷键
          <span className="sec-h-tail">
            <button className="btn sm" onClick={() => update("hotkeys", { ...DEFAULT_HOTKEYS })}>
              恢复默认
            </button>
            <SecHelp>点击键帽后按下新按键即可重新绑定（Esc 取消）。冲突的键帽会标红，点击其一重新绑定即可消除。</SecHelp>
          </span>
        </div>
        <div className="set-page-d">按功能分组、两列排布；最下方为固定组合键，仅作速查。</div>
      </div>

      {clashOf.size ? (
        <div className="set-hint danger">
          ⚠ 检测到 {clashOf.size / 2} 组快捷键冲突：标红的键帽有多个功能共用同一按键，点击键帽重新绑定即可消除
        </div>
      ) : null}

      {HOTKEY_GROUPS.map((g) => (
        <div key={g.title} className="set-card">
          <div className="set-card-h">{g.title}</div>
          <div className="hk-grid">
            {g.actions.map((action) => (
              <div className="hk-row" key={action}>
                <span className="hk-name" title={HOTKEY_LABEL[action]}>
                  {HOTKEY_LABEL[action]}
                </span>
                <button
                  className={`keycap ${capturing === action ? "cap" : ""} ${clashOf.has(action) ? "clash" : ""}`}
                  title={
                    clashOf.has(action)
                      ? `⚠ 与「${HOTKEY_LABEL[clashOf.get(action)!]}」快捷键冲突——点击后按下新按键重新绑定`
                      : "点击后按下新按键"
                  }
                  onClick={() => setCapturing(capturing === action ? null : action)}
                >
                  {capturing === action ? "按键…" : hotkeys[action] ? comboLabel(hotkeys[action]) : "未绑定"}
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="set-card">
        <div className="set-card-h">
          固定快捷键
          <span className="sec-h-tail">
            <span className="set-hint">仅作速查，不可修改</span>
          </span>
        </div>
        <div className="hk-grid">
          {FIXED_KEYS.map((f) => (
            <div className="hk-row dim" key={f.label}>
              <span className="hk-name">{f.label}</span>
              <span className="hk-combo">
                {f.keys.map((k, i) => (
                  <span key={i}>
                    {i > 0 ? <i className="hk-plus">+</i> : null}
                    <kbd className="keycap sm">{k}</kbd>
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
