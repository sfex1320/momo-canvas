import { create } from "zustand";
import type { AssetFolder, AssetItem, AssetKind } from "../types";
import { loadJSON, saveJSON } from "../persist";
import { errMsg, sanitizeFilename, uid } from "../utils";
import { deleteAssetFile, extFromMime, fetchBytes, kindFromExt, storeAssetFile } from "../services/assetFiles";
import { toast } from "./uiStore";

export type CollectInput = {
  src: string; // dataURL / blob / http(s)
  kind?: AssetKind;
  name?: string;
  prompt?: string;
  model?: string;
};

type AssetState = {
  items: AssetItem[];
  folders: AssetFolder[];
  loaded: boolean;
  open: boolean;

  init: () => Promise<void>;
  setOpen: (v: boolean) => void;
  /** 画布生成内容自动收录 */
  collect: (input: CollectInput) => Promise<void>;
  /** 导入外部文件（File 对象，来自文件选择或拖放） */
  importFiles: (files: File[]) => Promise<void>;
  removeMany: (ids: string[]) => Promise<void>;
  moveTo: (ids: string[], folderId: string | null) => void;
  rename: (id: string, name: string) => void;
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
        const ext = extFromMime(mime);
        const kind = input.kind ?? kindFromExt(ext);
        const stored = await storeAssetFile(bytes, ext, kind);
        const item: AssetItem = {
          id: uid(),
          kind,
          name: input.name ?? (input.prompt ? sanitizeFilename(input.prompt, 32) : `生成_${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`),
          path: stored.path,
          thumb: stored.thumb,
          mime,
          size: stored.size,
          width: stored.width,
          height: stored.height,
          prompt: input.prompt,
          model: input.model,
          folderId: null,
          source: "canvas",
          createdAt: Date.now(),
        };
        set((s) => ({ items: [item, ...s.items] }));
        persist();
      } catch (e) {
        console.warn("[assets] collect failed", e);
      }
    },

    importFiles: async (files) => {
      let ok = 0;
      for (const f of files) {
        try {
          const ext = f.name.split(".").pop() ?? extFromMime(f.type);
          const kind = kindFromExt(ext);
          const bytes = new Uint8Array(await f.arrayBuffer());
          const stored = await storeAssetFile(bytes, ext, kind);
          const item: AssetItem = {
            id: uid(),
            kind,
            name: f.name.replace(/\.[^.]+$/, ""),
            path: stored.path,
            thumb: stored.thumb,
            mime: f.type || "application/octet-stream",
            size: stored.size,
            width: stored.width,
            height: stored.height,
            folderId: null,
            source: "import",
            createdAt: Date.now(),
          };
          set((s) => ({ items: [item, ...s.items] }));
          ok++;
        } catch (e) {
          toast(`导入「${f.name}」失败：${errMsg(e)}`, "err");
        }
      }
      if (ok) {
        toast(`已导入 ${ok} 个文件`, "ok");
        persist();
      }
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
