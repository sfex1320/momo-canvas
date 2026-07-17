import { create } from "zustand";
import { uid } from "../utils";
import type { GalleryItem } from "../types";

export type Toast = { id: string; msg: string; type: "info" | "ok" | "err" };

export type AddMenuState = {
  /** 画布 flow 坐标（落点） */
  flowX: number;
  flowY: number;
  /** 屏幕坐标（菜单定位） */
  screenX: number;
  screenY: number;
  /** 从某个输出拖线松手时：来源节点，用于自动连线 */
  sourceNode?: string;
  sourcePort?: "text" | "image";
} | null;

type UiState = {
  zen: boolean;
  galleryOpen: boolean;
  settingsOpen: boolean;
  settingsTab: string;
  templateMgrOpen: boolean;
  lightbox: string | null;
  addMenu: AddMenuState;
  gallery: GalleryItem[];
  toasts: Toast[];
  /** 拖拽中将要自动连线的两个节点 id（高亮提示） */
  proxHint: string[] | null;

  toggleZen: () => void;
  setGalleryOpen: (v: boolean) => void;
  openSettings: (tab?: string) => void;
  closeSettings: () => void;
  setTemplateMgr: (v: boolean) => void;
  setLightbox: (src: string | null) => void;
  setAddMenu: (v: AddMenuState) => void;
  setProxHint: (ids: string[] | null) => void;
  addGallery: (item: Omit<GalleryItem, "id" | "time">) => void;
  toast: (msg: string, type?: Toast["type"]) => void;
};

export const useUi = create<UiState>((set) => ({
  zen: false,
  galleryOpen: false,
  settingsOpen: false,
  settingsTab: "models",
  templateMgrOpen: false,
  lightbox: null,
  addMenu: null,
  gallery: [],
  toasts: [],
  proxHint: null,

  toggleZen: () => set((s) => ({ zen: !s.zen })),
  setGalleryOpen: (v) => set({ galleryOpen: v }),
  openSettings: (tab) => set({ settingsOpen: true, ...(tab ? { settingsTab: tab } : {}) }),
  closeSettings: () => set({ settingsOpen: false }),
  setTemplateMgr: (v) => set({ templateMgrOpen: v }),
  setLightbox: (src) => set({ lightbox: src }),
  setAddMenu: (v) => set({ addMenu: v }),

  setProxHint: (ids) =>
    set((s) => {
      // 拖拽中每帧都会算一次，内容没变就不触发渲染
      if (s.proxHint === ids || (s.proxHint && ids && s.proxHint.join() === ids.join())) return s;
      return { proxHint: ids };
    }),

  addGallery: (item) =>
    set((s) => ({ gallery: [{ ...item, id: uid(), time: Date.now() }, ...s.gallery].slice(0, 200) })),

  toast: (msg, type = "info") => {
    const id = uid(6);
    set((s) => ({ toasts: [...s.toasts, { id, msg, type }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, type === "err" ? 5000 : 3000);
    if (type === "err") console.warn("[toast]", msg);
  },
}));

export const toast = (msg: string, type?: Toast["type"]) => useUi.getState().toast(msg, type);
