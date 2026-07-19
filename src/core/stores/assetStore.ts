import { create } from "zustand";
import type { AssetFolder, AssetGenMeta, AssetItem, AssetKind } from "../types";
import { loadJSON, saveJSON } from "../persist";
import { errMsg, sanitizeFilename, uid } from "../utils";
import { deleteAssetFile, extFromMime, fetchBytes, kindFromExt, mimeFromExt, sniffExt, storeAssetFile } from "../services/assetFiles";
import { toast } from "./uiStore";
import { useBoard } from "./boardStore";

export type CollectInput = {
  src: string; // dataURL / blob / http(s)
  kind?: AssetKind;
  name?: string;
  prompt?: string;
  model?: string;
  /** 生成参数快照（Remix 还原用） */
  gen?: AssetGenMeta;
};

type AssetState = {
  items: AssetItem[];
  folders: AssetFolder[];
  loaded: boolean;
  open: boolean;

  init: () => Promise<void>;
  setOpen: (v: boolean) => void;
  /** 画布生成内容自动收录；返回落盘后的资产项（失败返回 null），视频结果靠它换成持久地址 */
  collect: (input: CollectInput) => Promise<AssetItem | null>;
  /** 导入外部文件（File 对象，来自文件选择或拖放） */
  importFiles: (files: File[]) => Promise<void>;
  /** 导入单个文件并返回资产项（视频节点等需要拿到落盘路径时用） */
  importFileGetItem: (f: File) => Promise<AssetItem | null>;
  removeMany: (ids: string[]) => Promise<void>;
  moveTo: (ids: string[], folderId: string | null) => void;
  rename: (id: string, name: string) => void;
  /** 覆盖式设置某资产的标签（去重、去空） */
  setTags: (id: string, tags: string[]) => void;
  /** 给一批资产追加同一个标签（批量栏用） */
  addTagMany: (ids: string[], tag: string) => void;
  createFolder: (name: string) => string;
  renameFolder: (id: string, name: string) => void;
  deleteFolder: (id: string) => void;
};

let initOnce: Promise<void> | null = null;

type PersistShape = { items: AssetItem[]; folders: AssetFolder[] };

export const useAssets = create<AssetState>((set, get) => {
  const persist = () => {
    const { items, folders, loaded } = get();
    if (!loaded) return;
    // 浏览器预览模式的 blob 路径重启即失效，不值得持久化
    void saveJSON("assets.json", "v1", { items: items.filter((i) => !i.path.startsWith("blob:")), folders } satisfies PersistShape);
  };

  return {
    items: [],
    folders: [],
    loaded: false,
    open: false,

    init: () =>
      (initOnce ??= (async () => {
        const saved = await loadJSON<PersistShape>("assets.json", "v1");
        set({ items: saved?.items ?? [], folders: saved?.folders ?? [], loaded: true });
      })()),

    setOpen: (v) => set({ open: v }),

    collect: async (input) => {
      try {
        const { bytes, mime } = await fetchBytes(input.src);
        // mime 不可靠（中转站常给 octet-stream）→ 落盘扩展名以文件头识别为准，避免存成 .bin
        let ext = extFromMime(mime);
        if (kindFromExt(ext) === "other") ext = sniffExt(bytes) ?? (input.kind === "image" ? "png" : ext);
        const kind = input.kind ?? kindFromExt(ext);
        const realMime = kindFromExt(ext) === "other" ? mime : mimeFromExt(ext);
        const stored = await storeAssetFile(bytes, ext, kind);
        // 按当前画布名自动归入同名文件夹（不存在则创建）
        let folderId: string | null = null;
        const b = useBoard.getState();
        const boardName = b.boards[b.activeId]?.meta.name?.trim();
        if (boardName) {
          folderId = get().folders.find((f) => f.name === boardName)?.id ?? get().createFolder(boardName);
        }
        const item: AssetItem = {
          id: uid(),
          kind,
          name: input.name ?? (input.prompt ? sanitizeFilename(input.prompt, 32) : `生成_${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`),
          path: stored.path,
          thumb: stored.thumb,
          mime: realMime,
          size: stored.size,
          width: stored.width,
          height: stored.height,
          prompt: input.prompt,
          model: input.model,
          folderId,
          source: "canvas",
          gen: input.gen,
          createdAt: Date.now(),
        };
        set((s) => ({ items: [item, ...s.items] }));
        persist();
        return item;
      } catch (e) {
        console.warn("[assets] collect failed", e);
        return null;
      }
    },

    importFileGetItem: async (f) => {
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        let ext = f.name.includes(".") ? f.name.split(".").pop()! : extFromMime(f.type);
        // 扩展名认不出来（无后缀 / .bin 等）→ 按文件头识别，别一律归入「其他」
        if (kindFromExt(ext) === "other") ext = sniffExt(bytes) ?? ext;
        const kind = kindFromExt(ext);
        const stored = await storeAssetFile(bytes, ext, kind);
        const item: AssetItem = {
          id: uid(),
          kind,
          name: f.name.replace(/\.[^.]+$/, ""),
          path: stored.path,
          thumb: stored.thumb,
          mime: f.type || mimeFromExt(ext),
          size: stored.size,
          width: stored.width,
          height: stored.height,
          folderId: null,
          source: "import",
          createdAt: Date.now(),
        };
        set((s) => ({ items: [item, ...s.items] }));
        persist();
        return item;
      } catch (e) {
        toast(`导入「${f.name}」失败：${errMsg(e)}`, "err");
        return null;
      }
    },

    importFiles: async (files) => {
      let ok = 0;
      for (const f of files) {
        if (await get().importFileGetItem(f)) ok++;
      }
      if (ok) toast(`已导入 ${ok} 个文件`, "ok");
    },

    removeMany: async (ids) => {
      const setIds = new Set(ids);
      const doomed = get().items.filter((i) => setIds.has(i.id));
      set((s) => ({ items: s.items.filter((i) => !setIds.has(i.id)) }));
      persist();
      for (const it of doomed) void deleteAssetFile(it.path, it.thumb);
    },

    moveTo: (ids, folderId) => {
      const setIds = new Set(ids);
      set((s) => ({ items: s.items.map((i) => (setIds.has(i.id) ? { ...i, folderId } : i)) }));
      persist();
    },

    rename: (id, name) => {
      set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, name } : i)) }));
      persist();
    },

    setTags: (id, tags) => {
      const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
      set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, tags: clean.length ? clean : undefined } : i)) }));
      persist();
    },

    addTagMany: (ids, tag) => {
      const t = tag.trim();
      if (!t) return;
      const setIds = new Set(ids);
      set((s) => ({
        items: s.items.map((i) =>
          setIds.has(i.id) && !(i.tags ?? []).includes(t) ? { ...i, tags: [...(i.tags ?? []), t] } : i,
        ),
      }));
      persist();
    },

    createFolder: (name) => {
      const f: AssetFolder = { id: uid(8), name };
      set((s) => ({ folders: [...s.folders, f] }));
      persist();
      return f.id;
    },

    renameFolder: (id, name) => {
      set((s) => ({ folders: s.folders.map((f) => (f.id === id ? { ...f, name } : f)) }));
      persist();
    },

    deleteFolder: (id) => {
      set((s) => ({
        folders: s.folders.filter((f) => f.id !== id),
        items: s.items.map((i) => (i.folderId === id ? { ...i, folderId: null } : i)),
      }));
      persist();
    },
  };
});
