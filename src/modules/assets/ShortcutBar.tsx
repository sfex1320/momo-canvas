/**
 * 资产库右侧快捷方式栏 — 自定义文件夹/软件图标：
 *  点击 = 打开；把资产卡片拖到图标上 = 复制进文件夹 / 用该软件打开
 */
import { useEffect, useState } from "react";
import { useSettings } from "../../core/stores/settingsStore";
import { useAssets } from "../../core/stores/assetStore";
import { toast } from "../../core/stores/uiStore";
import { errMsg, isTauri, sanitizeFilename, uid } from "../../core/utils";
import { kindFromExt, sniffExt } from "../../core/services/assetFiles";
import { invoke } from "@tauri-apps/api/core";
import { openExternal } from "../../core/external";
import { getNativeDragAsset } from "./dragState";
import { IcGlobe, IcClose, IcFolder, IcFolderPlus, IcPlay, IcPlus } from "../../ui/icons";
import type { AssetItem, ShortcutItem } from "../../core/types";

async function openShortcut(s: ShortcutItem) {
  try {
    if (s.kind === "website") await openExternal(s.path);
    else if (s.kind === "app") await invoke("shortcut_launch", {path:s.path});
    else { const { openPath } = await import("@tauri-apps/plugin-opener"); await openPath(s.path); }
  } catch (e) {
    toast(`打开失败：${errMsg(e)}`, "err");
  }
}

/** 资产拖到/发送到快捷方式：文件夹 → 以可读文件名复制过去；软件 → 用它打开资产（右键菜单也复用） */
export async function sendAsset(s: ShortcutItem, item: AssetItem) {
  try {
    if (s.kind === "website") {
      await openExternal(s.path);
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(item.path);
      toast("已打开网站并定位素材。请拖入网页上传区；该链接尚未配置自动上传接口", "info");
    } else if (s.kind === "folder") {
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
      await invoke("shortcut_launch", {path:s.path, asset:item.path});
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
  const [website, setWebsite] = useState(false);
  const [url, setUrl] = useState("");
  const [webName, setWebName] = useState("");
  const [overId, setOverId] = useState<string | null>(null);

  const saveWebsite = (raw: string, label?: string) => {
    try {
      const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (!["http:","https:"].includes(u.protocol) || u.username || u.password || !u.hostname) throw Error("请输入有效的 http/https 网站地址");
      const cur = useSettings.getState().settings.shortcuts;
      if (!cur.some(s=>s.path===u.href)) update("shortcuts", [...cur,{id:uid(6),name:label?.trim()||u.hostname,path:u.href,kind:"website"}]);
      setWebsite(false); setUrl(""); setWebName("");
    } catch(e) { toast(errMsg(e),"err"); }
  };
  useEffect(()=>{
    let disposed=false;
    void (async()=>{
      for(const shortcut of shortcuts.filter(s=>s.kind==="app"&&!s.icon)) {
        try {
          const meta=await invoke<Partial<ShortcutItem>>("shortcut_inspect",{path:shortcut.path});
          if(disposed)return;
          if(meta.icon) update("shortcuts",useSettings.getState().settings.shortcuts.map(s=>s.id===shortcut.id?{...s,icon:meta.icon}:s));
        } catch { /* 图标不可用时保留通用图标 */ }
      }
    })();
    return()=>{disposed=true;};
  },[shortcuts.map(s=>s.id).join(",")]);
  const add = async (kind: ShortcutItem["kind"]) => {
    if (!isTauri) {
      toast("浏览器预览模式不支持快捷方式", "err");
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open(
      kind === "folder"
        ? { directory: true, title: "选择要固定的文件夹" }
        : { title: "选择软件（exe）", filters: [{ name: "程序", extensions: ["exe", "lnk", "bat", "cmd", "appref-ms"] }] },
    );
    if (typeof path !== "string") return;
    const name = path.split(/[\\/]/).filter(Boolean).pop()?.replace(/\.(exe|lnk|bat)$/i, "") ?? "快捷方式";
    try {
      const meta = await invoke<ShortcutItem>("shortcut_inspect",{path});
      update("shortcuts", [...useSettings.getState().settings.shortcuts, {...meta, id: uid(6), name, path, kind}]);
    } catch(e) { toast(errMsg(e),"err"); return; }
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
    // Tauri 下资产卡走原生拖拽（拿不到自定义数据），从拖拽状态里补回资产 id；多选拖拽负载取第一张
    const ids = (e.dataTransfer.getData("momo/asset-id") || getNativeDragAsset() || "").split(",");
    const list = useAssets.getState().items.filter(x=>ids.includes(x.id));
    if (list.length) {
      void (async()=>{for(const item of list)await sendAsset(s,item);})();
      return;
    }
    // 外部素材直接拖到目标：先正常入库，再复用发送入口，避免误注册成软件。
    const media=Array.from(e.dataTransfer.files).filter(f=>kindFromExt(f.name.split(".").pop()??"")!=="other");
    if(media.length){void(async()=>{for(const file of media){const item=await useAssets.getState().importFileGetItem(file);if(item)await sendAsset(s,item);}})();return;}
    // 不是素材 → 从 OS 拖进来的软件快捷方式，走创建逻辑。
    void createFromOsDrop(e);
  };

  /** OS 文件拖到快捷栏 → 直接固定为快捷方式。
   *  Windows 限制：HTML5 拖放拿不到文件夹/程序本体的路径，但 .lnk 的字节里有目标路径，可解析 */
  const createFromOsDrop = async (e: React.DragEvent) => {
    if (!isTauri) return;
    const link = e.dataTransfer.getData("text/uri-list").split("\n").find(v=>/^https?:\/\//i.test(v));
    if(link) {saveWebsite(link.trim());return;}
    const files = Array.from(e.dataTransfer.files ?? []);
    const items: ShortcutItem[] = [], skipped: string[] = [];
    const existing = new Set(useSettings.getState().settings.shortcuts.map(s=>s.path.toLowerCase()));
    for(const f of files) {
      try {
        if(/\.url$/i.test(f.name)) {const match=(await f.text()).match(/^URL=(.+)$/mi);if(match)saveWebsite(match[1].trim(), f.name.replace(/\.url$/i,""));continue;}
        const path=(f as File & {path?:string}).path;
        const bytes=!path&&/\.lnk$/i.test(f.name)?Array.from(new Uint8Array(await f.arrayBuffer())):undefined;
        const meta=await invoke<ShortcutItem>("shortcut_inspect", {path,name:f.name,bytes}).catch(e=>{if(!path&&bytes)return invoke<ShortcutItem>("shortcut_inspect",{name:f.name});throw e;});
        if(existing.has(meta.path.toLowerCase()))continue;
        existing.add(meta.path.toLowerCase());items.push({...meta,id:uid(6)});
      } catch {skipped.push(f.name);}
    }
    if (items.length) {
      const cur = useSettings.getState().settings.shortcuts;
      update("shortcuts", [...cur, ...items]);
      toast(`已固定：${items.map((i) => `「${i.name}」`).join("")}`, "ok");
    }
    if (skipped.length) {
      toast(
        `「${skipped.join("、")}」无法定位：请用下方 + 选择启动文件。开始菜单快捷方式可直接拖入；无路径的程序文件需要手动选择`,
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
            title={`${s.name}\n点击打开 · 把资产拖到这里${s.kind === "folder" ? "自动复制进去" : s.kind === "website" ? "打开网页并定位素材，需在网页选择上传" : "用它打开"}`}
            onClick={() => void openShortcut(s)}
            onDragOver={(e) => {
              e.preventDefault();
              setOverId(s.id);
            }}
            onDragLeave={() => setOverId(null)}
            onDrop={(e) => onDropTo(s, e)}
          >
            {s.icon ? <img src={s.icon} alt="" width={26} height={26}/> : s.kind === "folder" ? <IcFolder size={20} /> : s.kind === "website" ? <IcGlobe size={20}/> : <IcPlay size={18} />}
          </button>
          <span className="sc-name">{s.name}</span>
          <button className="sc-del" title="移除快捷方式" onClick={() => remove(s.id)}>
            <IcClose size={11} />
          </button>
        </div>
      ))}
      {website&&<div className="sc-website-form"><b>固定网站</b><input className="input" aria-label="网站名称" placeholder="网站名称（可选）" value={webName} onChange={e=>setWebName(e.target.value)}/><input className="input" aria-label="网站地址" placeholder="https://…" value={url} onChange={e=>setUrl(e.target.value)}/><button className="btn sm" onClick={()=>saveWebsite(url,webName)}>保存</button><button className="btn sm" onClick={()=>setWebsite(false)}>取消</button></div>}
      <div className="sc-adds">
        <button className="sc-ic add" title="固定网站链接" onClick={()=>setWebsite(v=>!v)}><IcGlobe size={18}/></button>
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
