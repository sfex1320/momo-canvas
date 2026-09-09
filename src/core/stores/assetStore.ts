import { create } from "zustand";
import type { AssetFolder, AssetGenMeta, AssetItem, AssetKind, EagleRemoteItem } from "../types";
import { loadJSON, saveJSON } from "../persist";
import { errMsg, hashDataUrl, isTauri, sanitizeFilename, uid, dataUrlToBytes } from "../utils";
import { assetToBlobUrl, assetsDir, deleteAssetFile, extFromMime, fetchBytes, kindFromExt, makeImageThumb, makeVideoThumb, mimeFromExt, sniffExt, storeAssetFile } from "../services/assetFiles";
import { toast } from "./uiStore";
import { useBoard } from "./boardStore";

export type CollectInput = {
  src: string; // dataURL / blob / http(s)
  kind?: AssetKind;
  name?: string;
  prompt?: string;
  promptZh?: string;
  promptEn?: string;
  catalogId?: string;
  catalogSource?: string;
  catalogRole?: AssetItem["catalogRole"];
  catalogSegments?: AssetItem["catalogSegments"];
  spatialLockZh?: string;
  spatialLockEn?: string;
  model?: string;
  /** 生成参数快照（Remix 还原用） */
  gen?: AssetGenMeta;
  /** 来自哪个画布生成节点（资产卡「定位到画布节点」用） */
  nodeId?: string;
  /** 多结果生成的分组信息；groupSlot 相同会原位替换旧资产 */
  group?: Pick<AssetItem, "groupId" | "groupLabel" | "groupKind" | "groupSlot" | "groupCover">;
  /** 导演台来源（资产库可按导演项目/片段分组定位，方案 §8.3） */
  director?: AssetItem["director"];
  /** 内容指纹（导演台参考图去重用；传入后写入资产项） */
  contentHash?: string;
  /** 生成耗时（毫秒，画布生成物传入；资产卡角标显示用） */
  durationMs?: number;
};

/** 回收站保留天数：超过自动彻底清理（删除磁盘文件） */
const TRASH_DAYS = 30;

/**
 * 项目资产过滤谓词（3.5 §9.5，纯函数——AssetLibrary 与集成测试共用同一份逻辑）：
 * 开启「本项目」时只保留 director.projectId 匹配的资产；projectId 为空时不过滤（无项目上下文）。
 */
export function assetVisibleInProject(item: Pick<AssetItem, "director">, projectId: string | undefined | null, projectOnly: boolean): boolean {
  if (!projectOnly) return true;
  if (!projectId) return true;
  return item.director?.projectId === projectId;
}

type AssetState = {
  items: AssetItem[];
  /** 回收站（删除的资产先进这里，可恢复；超期或手动彻底删除才动磁盘文件） */
  trash: AssetItem[];
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
  /** 删除 → 移入回收站（不删磁盘文件） */
  removeMany: (ids: string[]) => Promise<void>;
  /** 从回收站恢复 */
  restoreMany: (ids: string[]) => void;
  /** 彻底删除（回收站页用；删除磁盘文件） */
  purgeMany: (ids: string[]) => void;
  /** 收藏/取消收藏 */
  toggleFav: (id: string) => void;
  moveTo: (ids: string[], folderId: string | null) => void;
  rename: (id: string, name: string) => void;
  /** 覆盖式设置某资产的标签（去重、去空） */
  setTags: (id: string, tags: string[]) => void;
  /** 给一批资产追加同一个标签（批量栏用） */
  addTagMany: (ids: string[], tag: string) => void;
  createFolder: (name: string) => string;
  renameFolder: (id: string, name: string) => void;
  deleteFolder: (id: string) => void;
  /** 通用字段修补（Eagle 同步引擎写绑定状态/标签合并等；带序守卫照常落盘） */
  patchItem: (id: string, patch: Partial<AssetItem>) => void;
  /** Eagle 拉回登记：文件已由 Rust 流式落盘进 assets，这里补缩略图并建立资产条目 */
  registerEagleImport: (input: {
    absPath: string;
    size: number;
    ext: string;
    fingerprint: string;
    remote: EagleRemoteItem;
    link: AssetItem["eagle"];
    lineage?: AssetItem["lineage"];
  }) => Promise<AssetItem | null>;
};

let initOnce: Promise<void> | null = null;

type PersistShape = { items: AssetItem[]; folders: AssetFolder[]; trash?: AssetItem[] };

export const useAssets = create<AssetState>((set, get) => {
  const persist = () => {
    const { items, folders, trash, loaded } = get();
    if (!loaded) return;
    // 浏览器预览模式的 blob 路径重启即失效，不值得持久化
    void saveJSON("assets.json", "v1", {
      items: items.filter((i) => !i.path.startsWith("blob:")),
      folders,
      trash,
    } satisfies PersistShape);
  };

  return {
    items: [],
    trash: [],
    folders: [],
    loaded: false,
    open: false,

    init: () =>
      (initOnce ??= (async () => {
        const saved = await loadJSON<PersistShape>("assets.json", "v1");
        const now = Date.now();
        const trash = saved?.trash ?? [];
        // 超期回收站项：后台彻底清理（删磁盘文件），不留僵尸
        const expired = trash.filter((t) => now - (t.deletedAt ?? now) > TRASH_DAYS * 86400_000);
        const kept = trash.filter((t) => !expired.includes(t));
        if (expired.length) {
          for (const it of expired) void deleteAssetFile(it.path, it.thumb);
          void saveJSON("assets.json", "v1", { items: saved?.items ?? [], folders: saved?.folders ?? [], trash: kept } satisfies PersistShape);
        }
        set({ items: saved?.items ?? [], folders: saved?.folders ?? [], trash: kept, loaded: true });
      })()),

    setOpen: (v) => set({ open: v }),

    collect: async (input) => {
      try {
        // 导演台参考素材按内容指纹去重：同一张图/一段声音无论复用多少次（拖进多个片段、重复导入文件夹），
        // 只落一份磁盘文件、返回同一个资产条目，杜绝「导演台参考」里堆重复副本。生成结果不去重（内容相同也是新版本）。
        if (input.director?.role === "reference") {
          const h = input.contentHash ?? (input.src.startsWith("data:") ? hashDataUrl(input.src) : undefined);
          const hit = h ? get().items.find((i) => i.contentHash === h && !i.deletedAt) : undefined;
          if (hit) {
            // 资产册重复导入复用同一份二进制，同时刷新双语提示词与空间锁元数据。
            const enriched: AssetItem = {
              ...hit,
              name: input.name ?? hit.name,
              prompt: input.prompt ?? hit.prompt,
              promptZh: input.promptZh ?? hit.promptZh,
              promptEn: input.promptEn ?? hit.promptEn,
              catalogId: input.catalogId ?? hit.catalogId,
              catalogSource: input.catalogSource ?? hit.catalogSource,
              catalogRole: input.catalogRole ?? hit.catalogRole,
              catalogSegments: input.catalogSegments ?? hit.catalogSegments,
              spatialLockZh: input.spatialLockZh ?? hit.spatialLockZh,
              spatialLockEn: input.spatialLockEn ?? hit.spatialLockEn,
            };
            if (JSON.stringify(enriched) !== JSON.stringify(hit)) {
              set((s) => ({ items: s.items.map((i) => (i.id === hit.id ? enriched : i)) }));
              persist();
            }
            return enriched;
          }
        }
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
          promptZh: input.promptZh,
          promptEn: input.promptEn,
          catalogId: input.catalogId,
          catalogSource: input.catalogSource,
          catalogRole: input.catalogRole,
          catalogSegments: input.catalogSegments,
          spatialLockZh: input.spatialLockZh,
          spatialLockEn: input.spatialLockEn,
          model: input.model,
          folderId,
          source: "canvas",
          gen: input.gen,
          nodeId: input.nodeId,
          director: input.director,
          // dataURL 来源自动写内容指纹：导演台参考图等按内容去重的场景才能跨入口生效
          contentHash: input.contentHash ?? (input.src.startsWith("data:") ? hashDataUrl(input.src) : undefined),
          durationMs: input.durationMs,
          ...input.group,
          createdAt: Date.now(),
        };
        // 电商切片重生/重新拼接：同组同槽只保留最新版本，并清理被替换的磁盘文件。
        const replaced = input.group?.groupId && input.group.groupSlot
          ? get().items.find((i) => i.groupId === input.group!.groupId && i.groupSlot === input.group!.groupSlot)
          : undefined;
        set((s) => ({ items: [item, ...s.items.filter((i) => i.id !== replaced?.id)] }));
        persist();
        if (replaced) void deleteAssetFile(replaced.path, replaced.thumb);
        // Eagle 自动推送：只异步入队，绝不等待 Eagle（生成流程零感知；引擎自行离线重试）
        void import("../eagleSyncEngine").then((m) => m.queueEaglePush([item.id], { auto: true }));
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
      // 删除 → 回收站（不删磁盘文件）：误删可恢复；30 天后或回收站里手动彻底删除才动文件
      const setIds = new Set(ids);
      const doomed = get().items.filter((i) => setIds.has(i.id));
      const now = Date.now();
      set((s) => ({
        items: s.items.filter((i) => !setIds.has(i.id)),
        trash: [...doomed.map((i) => ({ ...i, deletedAt: now })), ...s.trash],
      }));
      persist();
    },

    restoreMany: (ids) => {
      const setIds = new Set(ids);
      set((s) => ({
        items: [...s.trash.filter((i) => setIds.has(i.id)).map(({ deletedAt: _d, ...rest }) => rest), ...s.items],
        trash: s.trash.filter((i) => !setIds.has(i.id)),
      }));
      persist();
    },

    purgeMany: (ids) => {
      const setIds = new Set(ids);
      const doomed = get().trash.filter((i) => setIds.has(i.id));
      set((s) => ({ trash: s.trash.filter((i) => !setIds.has(i.id)) }));
      persist();
      for (const it of doomed) void deleteAssetFile(it.path, it.thumb);
    },

    toggleFav: (id) => {
      set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, fav: !i.fav } : i)) }));
      persist();
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

    patchItem: (id, patch) => {
      let changed = false;
      set((s) => ({
        items: s.items.map((i) => {
          if (i.id !== id) return i;
          const next = { ...i, ...patch };
          if (JSON.stringify(next) !== JSON.stringify(i)) {
            changed = true;
            return next;
          }
          return i;
        }),
      }));
      if (changed) persist();
    },

    registerEagleImport: async ({ absPath, size, ext, fingerprint, remote, link, lineage }) => {
      try {
        const kind = kindFromExt(ext);
        // 缩略图：图片/矢量/视频现场生成（失败不阻塞导入，卡片回落类型图标）
        let thumbPath: string | undefined;
        let width: number | undefined;
        let height: number | undefined;
        const wantsThumb = kind === "image" || kind === "vector" || kind === "video";
        if (wantsThumb && isTauri) {
          try {
            const blobUrl = await assetToBlobUrl(absPath, mimeFromExt(ext));
            const meta =
              kind === "video"
                ? await makeVideoThumb(blobUrl)
                : await makeImageThumb(blobUrl);
            if (meta) {
              const { writeFile } = await import("@tauri-apps/plugin-fs");
              const { join } = await import("@tauri-apps/api/path");
              const dir = await assetsDir();
              width = meta.width;
              height = meta.height;
              thumbPath = await join(dir, "thumbs", `${Date.now()}_${uid(6)}_${remote.id}.webp`);
              await writeFile(thumbPath, dataUrlToBytes(meta.thumb));
            }
          } catch (e) {
            console.warn("[assets] eagle thumb failed", e);
          }
        }
        const item: AssetItem = {
          id: uid(),
          kind,
          name: remote.name?.replace(/\.[^.]+$/, "") || "Eagle 素材",
          path: absPath,
          thumb: thumbPath,
          mime: mimeFromExt(ext),
          size,
          width,
          height,
          prompt: remote.annotation,
          annotation: remote.annotation,
          rating: remote.star || 0,
          tags: remote.tags.length ? [...remote.tags] : undefined,
          model: undefined,
          folderId: null,
          source: "eagle",
          contentHash: fingerprint.slice(0, 32),
          createdAt: Date.now(),
          ...(link ? { eagle: link } : {}),
          ...(lineage ? { lineage } : {}),
        };
        set((s) => ({ items: [item, ...s.items] }));
        persist();
        return item;
      } catch (e) {
        console.warn("[assets] eagle import failed", e);
        toast(`登记 Eagle 素材失败：${errMsg(e)}`, "err");
        return null;
      }
    },
  };
});
