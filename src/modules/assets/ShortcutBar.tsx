/**
 * 资产库右侧快捷方式栏 — 自定义文件夹/软件图标：
 *  点击 = 打开；把资产卡片拖到图标上 = 复制进文件夹 / 用该软件打开
 */
import { useState } from "react";
import { useSettings } from "../../core/stores/settingsStore";
import { useAssets } from "../../core/stores/assetStore";
import { toast } from "../../core/stores/uiStore";
import { errMsg, isTauri, sanitizeFilename, uid } from "../../core/utils";
import { kindFromExt, sniffExt } from "../../core/services/assetFiles";
import { parseLnkTarget } from "../../core/lnk";
import { getNativeDragAsset } from "./dragState";
import { IcClose, IcFolder, IcFolderPlus, IcPlay, IcPlus } from "../../ui/icons";
import type { AssetItem, ShortcutItem } from "../../core/types";

async function openShortcut(s: ShortcutItem) {
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(s.path);
  } catch (e) {
    toast(`打开失败：${errMsg(e)}`, "err");
  }
}

/** 资产拖到/发送到快捷方式：文件夹 → 以可读文件名复制过去；软件 → 用它打开资产（右键菜单也复用） */
export async function sendAsset(s: ShortcutItem, item: AssetItem) {
  try {
    if (s.kind === "folder") {
      const { copyFile, exists, readFile } = await import("@tauri-apps/plugin-fs");
      let ext = item.path.includes(".") ? item.path.split(".").pop()!.toLowerCase() : "";
      if (kindFromExt(ext) === "other" && item.kind !== "other") {
        // 早期版本落盘的 .bin：按文件头识别真实格式，复制出去的文件才能被其他软件打开
        try {
          ext = sniffExt(await readFile(item.path)) ?? ext;
        } catch {
          /* 识别失败就保留原后缀 */
        }
      }
      const stem = sanitizeFilename(item.name, 48) || "资产";
      let dest = `${s.path}\\${stem}.${ext || "png"}`;
      if (await exists(dest)) dest = `${s.path}\\${stem}_${uid(4)}.${ext || "png"}`;
      await copyFile(item.path, dest);
      toast(`已复制到「${s.name}」`, "ok");
    } else {
      const { openPath } = await import("@tauri-apps/plugin-opener");
      await openPath(item.path, s.path);
      toast(`已用「${s.name}」打开`, "ok");
    }
  } catch (e) {
    toast(errMsg(e), "err");
  }
}

export function ShortcutBar() {
  const shortcuts = useSettings((s) => s.settings.shortcuts);
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const [overId, setOverId] = useState<string | null>(null);

  const add = async (kind: ShortcutItem["kind"]) => {
    if (!isTauri) {
      toast("浏览器预览模式不支持快捷方式", "err");
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open(
      kind === "folder"
        ? { directory: true, title: "选择要固定的文件夹" }
        : { title: "选择软件（exe）", filters: [{ name: "程序", extensions: ["exe", "lnk", "bat"] }] },
    );
    if (typeof path !== "string") return;
    const name = path.split(/[\\/]/).filter(Boolean).pop()?.replace(/\.(exe|lnk|bat)$/i, "") ?? "快捷方式";
    update("shortcuts", [...shortcuts, { id: uid(6), name, path, kind }]);
    toast(`已固定「${name}」`, "ok");
  };

  const remove = (id: string) =>
    update(
      "shortcuts",
      settings.shortcuts.filter((s) => s.id !== id),
    );

  const onDropTo = (s: ShortcutItem, e: React.DragEvent) => {
    e.preventDefault();
    // 不能冒泡到资产库容器的“拖文件导入”，否则自己的资产会被再导入一份
    e.stopPropagation();
    setOverId(null);
    // Tauri 下资产卡走原生拖拽（拿不到自定义数据），从拖拽状态里补回资产 id
    const id = e.dataTransfer.getData("momo/asset-id") || getNativeDragAsset() || "";
    const it = useAssets.getState().items.find((x) => x.id === id);
    if (it) {
      void sendAsset(s, it);
      return;
    }
    // 不是资产 → 可能是从 OS 拖进来的快捷方式，走创建逻辑
    void createFromOsDrop(e);
  };

  /** OS 文件拖到快捷栏 → 直接固定为快捷方式。
   *  Windows 限制：HTML5 拖放拿不到文件夹/程序本体的路径，但 .lnk 的字节里有目标路径，可解析 */
  const createFromOsDrop = async (e: React.DragEvent) => {
    if (!isTauri) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    if (!files.length) return;
    const items: ShortcutItem[] = [];
    const skipped: string[] = [];
    const existing = new Set(useSettings.getState().settings.shortcuts.map((s) => s.path.toLowerCase()));
    for (const f of files) {
      // WebView2 将来若提供路径就直接用（Electron 式非标准字段）
      let target = (f as File & { path?: string }).path ?? null;
      if (!target && /\.lnk$/i.test(f.name)) {
        try {
          target = parseLnkTarget(new Uint8Array(await f.arrayBuffer()));
        } catch {
          target = null;
        }
      }
      if (!target) {
        skipped.push(f.name);
        continue;
      }
      if (existing.has(target.toLowerCase())) continue;
      existing.add(target.toLowerCase());
      let kind: ShortcutItem["kind"];
      try {
        const { stat } = await import("@tauri-apps/plugin-fs");
        kind = (await stat(target)).isDirectory ? "folder" : "app";
      } catch {
        kind = /\.(exe|bat|cmd)$/i.test(target) ? "app" : "folder";
      }
      const name = target.split(/[\\/]/).filter(Boolean).pop()?.replace(/\.(exe|lnk|bat|cmd)$/i, "") ?? "快捷方式";
      items.push({ id: uid(6), name, path: target, kind });
    }
    if (items.length) {
      const cur = useSettings.getState().settings.shortcuts;
      update("shortcuts", [...cur, ...items]);
      toast(`已固定：${items.map((i) => `「${i.name}」`).join("")}`, "ok");
    }
    if (skipped.length) {
      toast(
        `「${skipped.join("、")}」读不到路径：Windows 拖放限制，拖文件夹/程序本体拿不到位置。请拖它们的快捷方式（.lnk），或用下方 + 按钮选择`,
        "err",
      );
    }
  };

  return (
    <div
      className="sc-bar"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // 拖到栏空白处：资产忽略（拖到具体图标上才发送），OS 文件则创建快捷方式
        if (getNativeDragAsset() || e.dataTransfer.getData("momo/asset-id")) return;
        void createFromOsDrop(e);
      }}
    >
      <div className="sc-title">快捷</div>
      {shortcuts.map((s) => (
        <div key={s.id} className={`sc-item ${overId === s.id ? "over" : ""}`}>
          <button
            className="sc-ic"
            title={`${s.name}\n点击打开 · 把资产拖到这里${s.kind === "folder" ? "自动复制进去" : "用它打开"}`}
            onClick={() => void openShortcut(s)}
            onDragOver={(e) => {
              e.preventDefault();
              setOverId(s.id);
            }}
            onDragLeave={() => setOverId(null)}
            onDrop={(e) => onDropTo(s, e)}
          >
            {s.kind === "folder" ? <IcFolder size={20} /> : <IcPlay size={18} />}
          </button>
          <span className="sc-name">{s.name}</span>
          <button className="sc-del" title="移除快捷方式" onClick={() => remove(s.id)}>
            <IcClose size={11} />
          </button>
        </div>
      ))}
      <div className="sc-adds">
        <button className="sc-ic add" title="固定一个文件夹" onClick={() => void add("folder")}>
          <IcFolderPlus size={18} />
        </button>
        <button className="sc-ic add" title="固定一个软件（exe）" onClick={() => void add("app")}>
          <IcPlus size={18} />
        </button>
      </div>
    </div>
  );
}
