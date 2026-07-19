import { create } from "zustand";
import { uid } from "../utils";
import { humanizeError } from "../errorHelp";
import { notifyError } from "../sound";
import type { GalleryItem } from "../types";

export type Toast = { id: string; msg: string; type: "info" | "ok" | "err" };

/** 报错历史条目（报错中心） */
export type ErrLogItem = { id: string; time: number; source: string; message: string };

export type AddMenuState = {
  /** 画布 flow 坐标（落点） */
  flowX: number;
  flowY: number;
  /** 屏幕坐标（菜单定位） */
  screenX: number;
  screenY: number;
  /** 从某个输出拖线松手时：来源节点，用于自动连线 */
  sourceNode?: string;
  sourcePort?: "text" | "image" | "video";
} | null;

type UiState = {
  zen: boolean;
  galleryOpen: boolean;
  settingsOpen: boolean;
  settingsTab: string;
  /** 设置里的服务商编辑浮出面板是否打开（主窗口需要让位左移） */
  sideEditorOpen: boolean;
  templateMgrOpen: boolean;
  /** 打开模板管理器时要直接进入编辑的模板 id（设置页卡片「编辑」用） */
  templateMgrEdit: string | null;
  /** 角色库弹层（人物预设） */
  charLibOpen: boolean;
  lightbox: string | null;
  /** 灯箱对比模式的「原图」：非空时灯箱显示前后对比滑块 */
  lightboxBefore: string | null;
  /** 灯箱内容类型：video 时用 <video> 播放（节点上只显示封面帧，点开才真正播放） */
  lightboxKind: "image" | "video";
  addMenu: AddMenuState;
  gallery: GalleryItem[];
  toasts: Toast[];
  /** 报错历史（报错中心） */
  errlog: ErrLogItem[];
  errlogOpen: boolean;
  errlogUnread: number;
  /** 拖拽中将要自动连线的两个节点 id（高亮提示） */
  proxHint: string[] | null;
  /** 当前工具：move = 移动工具（左键拖空白平移）；select = 框选模式 */
  tool: "move" | "select";
  /** 建组模式：在画布上框画区域成组 */
  groupDraw: boolean;
  /** Alt 拖拽复制中：被拖动的副本节点 id（虚线显示） */
  dupGhost: string[] | null;
  /** 拖动节点后抑制生成设置面板（只有点击节点才重新显示） */
  genPanelSuppressed: boolean;
  /** 打开中的「上游传入」预览弹窗（节点 id 列表） */
  upPop: string[];
  /** 弹窗锁定：锁定后预览弹窗不因点击画布/其他节点而收起（全局生效） */
  popLock: boolean;
  /** 画布内搜索节点（Ctrl+F） */
  searchOpen: boolean;
  /** Spotlight 快速添加（Ctrl+K）：搜索节点/模板并添加到画布 */
  spotlightOpen: boolean;
  /** AI 布线助手：一句话生成工作流方案 */
  aiWireOpen: boolean;

  toggleUpPop: (id: string) => void;
  closeUpPop: (id: string) => void;
  togglePopLock: () => void;
  setSearchOpen: (v: boolean) => void;
  setSpotlightOpen: (v: boolean) => void;
  setAiWireOpen: (v: boolean) => void;
  toggleZen: () => void;
  setGenPanelSuppressed: (v: boolean) => void;
  setGalleryOpen: (v: boolean) => void;
  openSettings: (tab?: string) => void;
  closeSettings: () => void;
  setSideEditorOpen: (v: boolean) => void;
  setTemplateMgr: (v: boolean, editId?: string | null) => void;
  setCharLibOpen: (v: boolean) => void;
  setLightbox: (src: string | null, before?: string | null, kind?: "image" | "video") => void;
  setAddMenu: (v: AddMenuState) => void;
  setProxHint: (ids: string[] | null) => void;
  toggleTool: () => void;
  setGroupDraw: (v: boolean) => void;
  setDupGhost: (ids: string[] | null) => void;
  addGallery: (item: Omit<GalleryItem, "id" | "time">) => void;
  toast: (msg: string, type?: Toast["type"]) => void;
  /** 记录一次报错：进报错中心 + 弹可点击的错误弹窗 */
  pushError: (source: string, message: string) => void;
  setErrlogOpen: (v: boolean) => void;
  clearErrlog: () => void;
};

export const useUi = create<UiState>((set) => ({
  zen: false,
  galleryOpen: false,
  settingsOpen: false,
  settingsTab: "models",
  sideEditorOpen: false,
  templateMgrOpen: false,
  templateMgrEdit: null,
  charLibOpen: false,
  lightbox: null,
  lightboxBefore: null,
  lightboxKind: "image",
  addMenu: null,
  gallery: [],
  toasts: [],
  errlog: [],
  errlogOpen: false,
  errlogUnread: 0,
  proxHint: null,
  tool: "move",
  groupDraw: false,
  dupGhost: null,
  genPanelSuppressed: false,
  upPop: [],
  popLock: false,
  searchOpen: false,
  spotlightOpen: false,
  aiWireOpen: false,

  setSearchOpen: (v) => set({ searchOpen: v }),
  setSpotlightOpen: (v) => set({ spotlightOpen: v }),
  setAiWireOpen: (v) => set({ aiWireOpen: v }),

  toggleUpPop: (id) =>
    set((s) => ({ upPop: s.upPop.includes(id) ? s.upPop.filter((x) => x !== id) : [...s.upPop, id] })),
  closeUpPop: (id) => set((s) => (s.upPop.includes(id) ? { upPop: s.upPop.filter((x) => x !== id) } : s)),
  togglePopLock: () => set((s) => ({ popLock: !s.popLock })),
  toggleZen: () => set((s) => ({ zen: !s.zen })),
  setGenPanelSuppressed: (v) =>
    set((s) => (s.genPanelSuppressed === v ? s : { genPanelSuppressed: v })),
  setGalleryOpen: (v) => set({ galleryOpen: v }),
  openSettings: (tab) => set({ settingsOpen: true, ...(tab ? { settingsTab: tab } : {}) }),
  closeSettings: () => set({ settingsOpen: false, sideEditorOpen: false }),
  setSideEditorOpen: (v) => set({ sideEditorOpen: v }),
  setTemplateMgr: (v, editId) => set({ templateMgrOpen: v, templateMgrEdit: v ? (editId ?? null) : null }),
  setCharLibOpen: (v) => set({ charLibOpen: v }),
  setLightbox: (src, before, kind) =>
    set({ lightbox: src, lightboxBefore: src ? (before ?? null) : null, lightboxKind: src ? (kind ?? "image") : "image" }),
  setAddMenu: (v) => set({ addMenu: v }),

  setProxHint: (ids) =>
    set((s) => {
      // 拖拽中每帧都会算一次，内容没变就不触发渲染
      if (s.proxHint === ids || (s.proxHint && ids && s.proxHint.join() === ids.join())) return s;
      return { proxHint: ids };
    }),

  toggleTool: () => set((s) => ({ tool: s.tool === "move" ? "select" : "move" })),
  setGroupDraw: (v) => set({ groupDraw: v }),
  setDupGhost: (ids) => set({ dupGhost: ids }),

  addGallery: (item) =>
    set((s) => ({ gallery: [{ ...item, id: uid(), time: Date.now() }, ...s.gallery].slice(0, 200) })),

  toast: (msg, type = "info") => {
    const id = uid(6);
    set((s) => ({ toasts: [...s.toasts, { id, msg, type }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, type === "err" ? 6000 : 3000);
    if (type === "err") console.warn("[toast]", msg);
  },

  pushError: (source, message) => {
    // 常见英文/网络报错先翻译成中文；原文保留在报错中心供排查
    const tip = humanizeError(message);
    const full = tip ? `${tip}\n—— 原始报错：${message}` : message;
    set((s) => ({
      errlog: [{ id: uid(6), time: Date.now(), source, message: full }, ...s.errlog].slice(0, 100),
      errlogUnread: s.errlogOpen ? s.errlogUnread : s.errlogUnread + 1,
    }));
    useUi.getState().toast(`${source}：${tip ?? message}`, "err");
    notifyError(source);
  },

  setErrlogOpen: (v) => set((s) => ({ errlogOpen: v, errlogUnread: v ? 0 : s.errlogUnread })),
  clearErrlog: () => set({ errlog: [], errlogUnread: 0 }),
}));

export const toast = (msg: string, type?: Toast["type"]) => useUi.getState().toast(msg, type);

/** 运行类报错统一入口：写入报错中心（点错误弹窗可查看历史） */
export const pushError = (source: string, message: string) => useUi.getState().pushError(source, message);
