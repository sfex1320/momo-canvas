/**
 * 资产库 — 独立模块
 *  自动收录画布生成内容 + 手动导入；分类 / 文件夹 / 标签 / 筛选 / 批量操作；
 *  图片、视频、音频、PDF 原生预览；
 *  卡片拖拽（Tauri 下走 OS 原生拖拽）：可落到画布（变图片节点）、右侧快捷栏、资源管理器、第三方软件；
 *  右键卡片有快捷菜单（放入画布 / 发送到快捷方式 / 打开位置 / 另存为 / 删除）
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { useAssets, assetVisibleInProject } from "../../core/stores/assetStore";
import { useBoard } from "../../core/stores/boardStore";
import { useSettings } from "../../core/stores/settingsStore";
import { toast, useUi } from "../../core/stores/uiStore";
import { useEagle } from "../../core/stores/eagleStore";
import { PopSelect } from "../../ui/PopSelect";
import { ScrubVideoThumb } from "../../ui/VideoThumb";
import { assetToDataUrl, assetToBlob, assetToBlobUrl, assetUrl } from "../../core/services/assetFiles";
import { errMsg, isTauri } from "../../core/utils";
import { grabFrame } from "../../core/videoEdit";
import { ShortcutBar, sendAsset } from "./ShortcutBar";
import { getNativeDragAsset, setNativeDragAsset } from "./dragState";
import type { AssetItem, AssetKind } from "../../core/types";

/** 原生 OS 拖拽（Tauri 默认）：同一次拖拽可落到画布/快捷栏/资源管理器/第三方软件；多选拖拽 = 拖出全部选中文件 */
async function nativeDragOut(list: AssetItem[]) {
  try {
    const { startDrag } = await import("@crabnebula/tauri-plugin-drag");
    await startDrag({ item: list.map((it) => it.path), icon: list[0].thumb || list[0].path });
  } catch (e) {
    toast(`拖出失败：${errMsg(e)}`, "err");
  }
}

/**
 * 资产卡 / 组展开面板成员卡共用的拖拽启动逻辑：
 * Tauri 走 OS 原生拖出（画布/快捷栏/资源管理器/第三方软件通吃）；
 * 浏览器预览退回 HTML5 dataTransfer（画布/快捷栏）。
 */
function startAssetDrag(e: React.DragEvent, ids: string[], items: AssetItem[], hooks: { trackDragOut: () => void; endDragTrack: () => void }) {
  const payload = ids.join(",");
  if (isTauri) {
    e.preventDefault();
    setNativeDragAsset(payload);
    hooks.trackDragOut();
    const dragList = items.filter((x) => ids.includes(x.id));
    void nativeDragOut(dragList).finally(() => {
      setNativeDragAsset(null);
      hooks.endDragTrack();
    });
    return;
  }
  e.dataTransfer.setData("momo/asset-id", payload);
  e.dataTransfer.effectAllowed = "copy";
  hooks.trackDragOut();
}

/** 另存为（预览层与右键菜单共用） */
async function saveAsAsset(item: AssetItem) {
  try {
    if (!isTauri) {
      const a = document.createElement("a");
      a.href = assetUrl(item.path);
      a.download = item.name;
      a.click();
      return;
    }
    const ext = item.path.split(".").pop() ?? "bin";
    const { save } = await import("@tauri-apps/plugin-dialog");
    const dest = await save({ defaultPath: `${item.name}.${ext}` });
    if (!dest) return;
    const { copyFile } = await import("@tauri-apps/plugin-fs");
    await copyFile(item.path, dest);
    toast(`已保存 → ${dest}`, "ok");
  } catch (e) {
    toast(errMsg(e), "err");
  }
}

/** 打开文件位置（预览层与右键菜单共用） */
async function revealAsset(item: AssetItem) {
  if (!isTauri) return;
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(item.path);
  } catch (e) {
    toast(errMsg(e), "err");
  }
}
import {
  IcArrowL,
  IcArrowR,
  IcCheck,
  IcCheckSquare,
  IcClapper,
  IcClose,
  IcDownload,
  IcEagle,
  IcEdit,
  IcFile,
  IcFolder,
  IcFolderPlus,
  IcGallery,
  IcImage,
  IcLibrary,
  IcLayers,
  IcMusic,
  IcRefresh,
  IcRestore,
  IcSearch,
  IcStar,
  IcTag,
  IcTrash,
  IcUpload,
  IcVector,
  IcVideo,
} from "../../ui/icons";
import { EagleBrowser } from "./EagleBrowser";
import { queueEaglePush, unlinkAssets } from "../../core/eagleSyncEngine";
import "./assets.css";

const KIND_TABS: { key: AssetKind | "all" | "directorRef" | "fav" | "trash"; label: string; icon: React.ReactNode }[] = [
  { key: "all", label: "全部", icon: <IcGallery size={17} /> },
  { key: "image", label: "图片", icon: <IcImage size={17} /> },
  { key: "video", label: "视频", icon: <IcVideo size={17} /> },
  { key: "audio", label: "音频", icon: <IcMusic size={17} /> },
  { key: "pdf", label: "PDF", icon: <IcFile size={17} /> },
  { key: "vector", label: "矢量", icon: <IcVector size={17} /> },
  { key: "other", label: "其他", icon: <IcFile size={17} /> },
  { key: "directorRef", label: "导演台参考", icon: <IcClapper size={17} /> },
  { key: "fav", label: "收藏", icon: <IcStar size={17} /> },
  { key: "trash", label: "回收站", icon: <IcTrash size={17} /> },
];

const KIND_BADGE: Record<AssetKind, string> = { image: "", video: "视频", audio: "音频", pdf: "PDF", vector: "SVG", other: "文件" };

/** 视频卡封面：封面帧 + 悬停挂 video 左右滑动擦洗（与导演台版本卡同一预览逻辑）。
 *  asset:// 协议在 WebView2 下不支持 Range 请求（seek 不了），必须先转 blob URL。 */
function VideoCardThumb({ item }: { item: AssetItem }) {
  const [url, setUrl] = useState<string | undefined>(() =>
    /^(blob:|data:|https?:)/i.test(item.path) ? item.path : undefined,
  );
  useEffect(() => {
    if (url) return;
    let on = true;
    void assetToBlobUrl(item.path, item.mime)
      .then((u) => on && setUrl(u))
      .catch(() => on && setUrl(assetUrl(item.path)));
    return () => {
      on = false;
    };
  }, [item.path, url]);
  if (!url) return <IcVideo size={40} />;
  // 点击交给外层卡片（预览大图/勾选），这里只管擦洗预览
  return <ScrubVideoThumb src={url} className="a-scrub-thumb" onClick={() => {}} />;
}

/** PDF 首页封面渲染缓存（path → dataURL；模块级，重开资产库命中缓存不再重渲） */
const pdfCoverCache = new Map<string, string>();

async function renderPdfCover(path: string): Promise<string | null> {
  const hit = pdfCoverCache.get(path);
  if (hit) return hit;
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const blob = await assetToBlob(path, "application/pdf");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: Math.min(2, 480 / base.width) });
  const c = document.createElement("canvas");
  c.width = Math.ceil(vp.width);
  c.height = Math.ceil(vp.height);
  await page.render({ canvas: c, viewport: vp }).promise;
  const url = c.toDataURL("image/webp", 0.8);
  pdfCoverCache.set(path, url);
  return url;
}

/** PDF 卡封面：截取第一页作固定封面；渲染失败回落文件图标 */
function PdfCover({ item }: { item: AssetItem }) {
  const [url, setUrl] = useState<string | null>(() => pdfCoverCache.get(item.path) ?? null);
  useEffect(() => {
    if (url) return;
    let on = true;
    void renderPdfCover(item.path)
      .then((u) => on && u && setUrl(u))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [item.path, url]);
  if (url) return <img src={url} alt="" loading="lazy" />;
  return <IcFile size={40} />;
}

/** 矢量 / 音频的专属图标封面（不再直显原文件，网格观感统一） */
function KindCover({ kind }: { kind: "vector" | "audio" }) {
  return (
    <div className={`a-kind-cover ${kind}`}>
      {kind === "vector" ? <IcVector size={34} /> : <IcMusic size={34} />}
      <span>{kind === "vector" ? "SVG" : "音频"}</span>
    </div>
  );
}

function AssetThumb({ item }: { item: AssetItem }) {
  if (item.thumb) return <img src={assetUrl(item.thumb)} alt="" loading="lazy" />;
  if (item.kind === "image") return <img src={assetUrl(item.path)} alt="" loading="lazy" />;
  if (item.kind === "vector") return <KindCover kind="vector" />;
  if (item.kind === "audio") return <KindCover kind="audio" />;
  if (item.kind === "video") return <VideoCardThumb item={item} />;
  if (item.kind === "pdf") return <PdfCover item={item} />;
  return <IcFile size={40} />;
}

function groupMemberOrder(item: AssetItem) {
  if (item.groupSlot === "final") return 10_000;
  const n = Number(item.groupSlot?.split(":")[1]);
  return Number.isFinite(n) ? n : 9_000;
}

/** Eagle 同步状态角标（绑定过才显示；文案短、hover 给完整说明） */
function EagleBadge({ item }: { item: AssetItem }) {
  const link = item.eagle;
  if (!link) return null;
  const map: Record<string, { text: string; title: string; cls: string }> = {
    synced: { text: "Eagle ✓", title: "已同步到 Eagle 素材库", cls: "ok" },
    queued: { text: "待同步", title: "已在同步队列等待处理", cls: "" },
    pushing: { text: "同步中", title: "正在写入 Eagle…", cls: "" },
    pulling: { text: "拉取中", title: "正在从 Eagle 拉回文件…", cls: "" },
    "local-dirty": { text: "待同步", title: "本地有改动尚未同步到 Eagle", cls: "warn" },
    "remote-dirty": { text: "Eagle 更新", title: "Eagle 端素材已被外部修改——右键「从 Eagle 导入新版」生成新版本（原版本保留）", cls: "warn" },
    conflict: { text: "冲突", title: "两端都有修改，请手动选择以哪边为准", cls: "err" },
    offline: { text: "离线", title: "Eagle 当前不可用，任务保留在队列中", cls: "" },
    error: { text: "同步失败", title: link.error ?? "同步失败，可在右键重试或到设置页查看", cls: "err" },
  };
  const info = map[link.state];
  if (!info) return null;
  return (
    <span className={`a-badge eagle ${info.cls}`} title={`Eagle 资产桥 · ${info.title}`}>
      <IcEagle size={11} /> {info.text}
    </span>
  );
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtDate(ts: number) {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 生成耗时：60s 内显示秒，更长显示分秒（资产卡角标用，尽量短） */
function fmtDur(ms: number) {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

export function AssetLibrary() {
  const open = useAssets((s) => s.open);
  const setOpen = useAssets((s) => s.setOpen);
  const items = useAssets((s) => s.items);
  const trash = useAssets((s) => s.trash);
  const folders = useAssets((s) => s.folders);
  const importFiles = useAssets((s) => s.importFiles);
  const removeMany = useAssets((s) => s.removeMany);
  const restoreMany = useAssets((s) => s.restoreMany);
  const purgeMany = useAssets((s) => s.purgeMany);
  const toggleFav = useAssets((s) => s.toggleFav);
  const moveTo = useAssets((s) => s.moveTo);
  const createFolder = useAssets((s) => s.createFolder);
  const renameFolder = useAssets((s) => s.renameFolder);
  const deleteFolder = useAssets((s) => s.deleteFolder);
  const addTagMany = useAssets((s) => s.addTagMany);

  const [kind, setKind] = useState<AssetKind | "all" | "directorRef" | "fav" | "trash">("all");
  /** 主区页签：本地资产 / Eagle 远程浏览 */
  const [tab, setTab] = useState<"local" | "eagle">("local");
  const connState = useEagle((s) => s.connState);
  const eagleStats = useEagle((s) => s.stats);
  const eagleEnabled = useSettings((s) => s.settings.eagle.enabled);
  const [folderId, setFolderId] = useState<string | "all">("all");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 多选模式：左键点选勾选、拖动可批量拖出；右键按住滑动涂抹勾选 */
  const [pickMode, setPickMode] = useState(false);
  /**
   * 右键滑选笔触（两段式，S 形路径）：
   *  - cell 逐卡模式：划到哪张涂哪张（划过行中间几张就是几张）
   *  - row 整行模式：划过某行「最右一张」后紧接下移到下一行才触发，此后一行一行整行选
   *  - 方向锁定：起笔卡未选中 → 本次全程「勾选」；起笔卡已选中 → 本次全程「取消勾选」（绝不中途反转）
   */
  const strokeRef = useRef<{
    action: "add" | "remove";
    mode: "cell" | "row";
    rows: string[][][];
    cardRow: Map<Element, number>;
    rowLastCard: Set<Element>;
    seenCells: Set<Element>;
    seenRows: Set<number>;
    brinkRow: number | null;
    grid: HTMLElement;
    raf: number;
  } | null>(null);
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  const [focusedGroupId, setFocusedGroupId] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [batchTag, setBatchTag] = useState("");
  /** 拖卡片且指针已移出面板区域：资产库隐身让位（快捷栏保留可落） */
  const [dragOut, setDragOut] = useState(false);
  /** 右键菜单：屏幕坐标 + 目标资产 */
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  /** 组卡右键菜单 */
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  /** 网格内双击重命名的资产 */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingName, setRenamingName] = useState("");
  /** 回收站彻底删除的二次确认（直接删磁盘文件，必须两步） */
  const [purgeConfirmId, setPurgeConfirmId] = useState<string | null>(null);
  const [purgeAll, setPurgeAll] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragTrackStop = useRef<(() => void) | null>(null);

  /** 拖拽期间跟踪指针：留在面板内保持完整可见（方便拖到右侧快捷栏），移出面板才隐身露出画布 */
  const trackDragOut = () => {
    const onOver = (e: DragEvent) => {
      const r = panelRef.current?.getBoundingClientRect();
      if (!r) return;
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      setDragOut(!inside);
    };
    window.addEventListener("dragover", onOver);
    dragTrackStop.current = () => {
      window.removeEventListener("dragover", onOver);
      dragTrackStop.current = null;
      setDragOut(false);
    };
  };
  const endDragTrack = () => dragTrackStop.current?.();
  useEffect(() => () => dragTrackStop.current?.(), []);

  // 3.5 §9.5：项目资产视图——从导演台打开资产库时默认「本项目」；用户可手动切到「全部资产」，
  // 切换剧本后回到默认（跟随新 projectId，不闪旧项目资产）。projectOnly = null 表示未手动设置（跟默认）。
  const directorProjectId = useUi((s) => s.directorProjectId);
  const [projectOnlyManual, setProjectOnlyManual] = useState<boolean | null>(null);
  const prevProjectRef = useRef(directorProjectId);
  if (prevProjectRef.current !== directorProjectId) {
    prevProjectRef.current = directorProjectId;
    setProjectOnlyManual(null); // 剧本切换：过滤目标跟随新 projectId，手动偏好复位到默认
  }
  const projectOnly = projectOnlyManual ?? !!directorProjectId;
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return items.filter((i) => {
      if (!assetVisibleInProject(i, directorProjectId, projectOnly)) return false;
      // 来源维度：导演台参考素材（上游同步/参考格上传/声音提取落库）默认不混进普通视图，
      // 收进「导演台参考」分类统一管理；收藏与关键词搜索不受隐藏影响（要找的时候找得到）
      const isDirRef = i.director?.role === "reference";
      if (kind === "directorRef") {
        if (!isDirRef) return false;
      } else if (isDirRef && kind !== "fav" && !kw) return false;
      if (kind === "fav") {
        if (!i.fav) return false;
      } else if (kind !== "all" && kind !== "directorRef" && i.kind !== kind) return false;
      if (folderId !== "all" && i.folderId !== folderId) return false;
      if (tagFilter && !(i.tags ?? []).includes(tagFilter)) return false;
      if (kw && !`${i.name} ${i.prompt ?? ""} ${i.promptZh ?? ""} ${i.promptEn ?? ""} ${i.catalogId ?? ""} ${i.spatialLockZh ?? ""} ${i.spatialLockEn ?? ""} ${i.model ?? ""} ${(i.tags ?? []).join(" ")}`.toLowerCase().includes(kw))
        return false;
      return true;
    });
  }, [items, kind, folderId, tagFilter, keyword, projectOnly, directorProjectId]);

  /** 同一次生成的多份资产在网格中只占一张组卡；展开后仍操作真实资产项。 */
  const entries = useMemo(() => {
    const out: { key: string; items: AssetItem[] }[] = [];
    const groupAt = new Map<string, number>();
    for (const item of filtered) {
      if (!item.groupId) {
        out.push({ key: item.id, items: [item] });
        continue;
      }
      const at = groupAt.get(item.groupId);
      if (at == null) {
        groupAt.set(item.groupId, out.length);
        out.push({ key: item.groupId, items: [item] });
      } else {
        out[at].items.push(item);
      }
    }
    return out;
  }, [filtered]);

  const focusedGroup = focusedGroupId
    ? entries.find((entry) => entry.key === focusedGroupId && entry.items.length > 1)
    : undefined;

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const i of items) {
      if (i.director?.role === "reference") {
        // 导演台参考不占「全部」与各类型计数（默认视图看不到，计数大于可见数会误导）
        c.directorRef = (c.directorRef ?? 0) + 1;
      } else {
        c.all = (c.all ?? 0) + 1;
        c[i.kind] = (c[i.kind] ?? 0) + 1;
      }
      if (i.fav) c.fav = (c.fav ?? 0) + 1;
    }
    c.trash = trash.length;
    return c;
  }, [items, trash]);

  /** 全部标签 → 出现次数（按次数降序） */
  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) for (const t of i.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);

  /* 筛选中的标签被删光后自动复位 */
  useEffect(() => {
    if (tagFilter && !allTags.some(([t]) => t === tagFilter)) setTagFilter(null);
  }, [tagFilter, allTags]);

  /* Eagle 插件「在 MOMO 中定位」：打开资产库并直接预览目标资产 */
  useEffect(() => {
    const onFocus = (e: Event) => {
      const id = (e as CustomEvent<{ assetId?: string }>).detail?.assetId;
      if (!id) return;
      const it = useAssets.getState().items.find((i) => i.id === id);
      if (!it) return;
      setOpen(true);
      setTab("local");
      setFocusedGroupId(null);
      const idx = filtered.findIndex((x) => x.id === id);
      setPreviewIdx(idx >= 0 ? idx : null);
    };
    window.addEventListener("momo:focus-asset", onFocus);
    return () => window.removeEventListener("momo:focus-asset", onFocus);
  }, [filtered, setOpen]);

  /* Esc 关闭；多选模式优先退出多选 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (previewIdx !== null) setPreviewIdx(null);
        else if (focusedGroupId) setFocusedGroupId(null);
        else if (pickMode) {
          setPickMode(false);
          setSelected(new Set());
        } else setOpen(false);
      }
      if (previewIdx !== null && e.key === "ArrowLeft") setPreviewIdx((i) => (i !== null && i > 0 ? i - 1 : i));
      if (previewIdx !== null && e.key === "ArrowRight")
        setPreviewIdx((i) => (i !== null && i < filtered.length - 1 ? i + 1 : i));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, previewIdx, focusedGroupId, filtered.length, setOpen]);

  useEffect(() => {
    if (focusedGroupId && !focusedGroup) setFocusedGroupId(null);
  }, [focusedGroupId, focusedGroup]);

  useEffect(() => setConfirmDel(false), [selected.size]);

  /* 面板关闭时退出多选模式（选择集维持原行为保留） */
  useEffect(() => {
    if (!open) setPickMode(false);
  }, [open]);

  if (!open) return null;

  const toggleSel = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const clearSel = () => setSelected(new Set());

  /** 按锁定方向应用一批 id（add = 全部勾选 / remove = 全部取消） */
  const applyStrokeIds = (ids: string[]) => {
    const st = strokeRef.current;
    if (!st || !ids.length) return;
    const action = st.action;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (action === "add") next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  /** 笔触途经卡片：cell 模式逐卡涂抹并检测「行尾→下一行」升级；row 模式整行涂抹 */
  const strokeOverCard = (el: Element) => {
    const st = strokeRef.current;
    if (!st) return;
    const row = st.cardRow.get(el);
    if (row == null) return;
    if (st.mode === "row") {
      if (st.seenRows.has(row)) return;
      st.seenRows.add(row);
      applyStrokeIds(st.rows[row].flat());
      return;
    }
    if (!st.seenCells.has(el)) {
      st.seenCells.add(el);
      applyStrokeIds((el.getAttribute("data-sel-ids") ?? "").split(",").filter(Boolean));
    }
    if (st.rowLastCard.has(el)) {
      st.brinkRow = row; // 划到本行最右一张：再紧接下移就升级整行模式
    } else if (st.brinkRow != null && row === st.brinkRow + 1) {
      // 行尾 → 紧接下一行：升级。起始行补齐整行（刚才可能只划过一部分），新行整行选
      st.mode = "row";
      if (!st.seenRows.has(st.brinkRow)) {
        st.seenRows.add(st.brinkRow);
        applyStrokeIds(st.rows[st.brinkRow].flat());
      }
      if (!st.seenRows.has(row)) {
        st.seenRows.add(row);
        applyStrokeIds(st.rows[row].flat());
      }
      st.brinkRow = null;
    } else if (row !== st.brinkRow) {
      st.brinkRow = null; // 移去了别的行但不是「行尾紧接下一行」，升级条件作废
    }
  };

  /** 指针坐标下的卡片（不在卡上返回 null） */
  const hitCard = (x: number, y: number): Element | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    return el?.closest("[data-sel-ids]") ?? null;
  };

  /** 多选模式右键起笔：方向由起笔卡当前状态决定；滑动逐卡涂抹，行尾紧接下移升级整行；超界自动滚动续选 */
  const startStroke = (fromCard: HTMLElement) => {
    const grid = fromCard.closest(".al-grid") as HTMLElement | null;
    if (!grid) return;
    const gridR = grid.getBoundingClientRect();
    const base = grid.scrollTop;
    const cards = Array.from(grid.querySelectorAll<HTMLElement>("[data-sel-ids]")).map((el) => ({
      el,
      // 折算成相对网格的稳定坐标：滚动中 rect.top 与 scrollTop 同步变化，差值恒定
      top: el.getBoundingClientRect().top - gridR.top + base,
      left: el.getBoundingClientRect().left,
      ids: (el.getAttribute("data-sel-ids") ?? "").split(",").filter(Boolean),
    }));
    cards.sort((a, b) => a.top - b.top);
    const rows: string[][][] = [];
    const rowTops: number[] = [];
    const rowLastCard = new Set<Element>();
    const cardRow = new Map<Element, number>();
    for (const c of cards) {
      const at = rowTops.length - 1;
      if (at >= 0 && Math.abs(c.top - rowTops[at]) < 60) {
        rows[at].push(c.ids);
        cardRow.set(c.el, at);
      } else {
        rowTops.push(c.top);
        rows.push([c.ids]);
        cardRow.set(c.el, rows.length - 1);
      }
    }
    // 每行最右一张（行内 left 最大者）：划过它再下移即触发整行模式
    for (let r = 0; r < rows.length; r++) {
      const rowCards = cards.filter((c) => cardRow.get(c.el) === r).sort((a, b) => a.left - b.left);
      if (rowCards.length) rowLastCard.add(rowCards[rowCards.length - 1].el);
    }
    // 方向锁定：起笔卡当前已全选中 → 本次全程取消勾选；否则全程勾选
    const startIds = (fromCard.getAttribute("data-sel-ids") ?? "").split(",").filter(Boolean);
    const allOn = startIds.length > 0 && startIds.every((id) => selected.has(id));
    strokeRef.current = { action: allOn ? "remove" : "add", mode: "cell", rows, cardRow, rowLastCard, seenCells: new Set(), seenRows: new Set(), brinkRow: null, grid, raf: 0 };
    const r0 = fromCard.getBoundingClientRect();
    const mouse = { x: r0.left + r0.width / 2, y: r0.top + r0.height / 2 };
    strokeOverCard(fromCard);
    const onMove = (ev: MouseEvent) => {
      mouse.x = ev.clientX;
      mouse.y = ev.clientY;
      const el = hitCard(mouse.x, mouse.y);
      if (el) strokeOverCard(el);
    };
    const tick = () => {
      const st = strokeRef.current;
      if (!st) return;
      const gr = st.grid.getBoundingClientRect();
      if (mouse.y < gr.top + 14 && st.grid.scrollTop > 0) {
        st.grid.scrollTop -= 14;
        const el = hitCard(mouse.x, mouse.y);
        if (el) strokeOverCard(el);
      } else if (mouse.y > gr.bottom - 14 && st.grid.scrollTop < st.grid.scrollHeight - st.grid.clientHeight - 1) {
        st.grid.scrollTop += 14;
        const el = hitCard(mouse.x, mouse.y);
        if (el) strokeOverCard(el);
      }
      st.raf = requestAnimationFrame(tick);
    };
    const onUp = () => {
      const st = strokeRef.current;
      if (st) cancelAnimationFrame(st.raf);
      strokeRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    strokeRef.current.raf = requestAnimationFrame(tick);
  };

  const batchDelete = async () => {
    if (!confirmDel) {
      setConfirmDel(true);
      return;
    }
    const n = selected.size;
    await removeMany([...selected]);
    clearSel();
    setPreviewIdx(null);
    toast(`已删除 ${n} 个资产 → 回收站（30 天内可恢复）`, "ok");
  };

  /** 批量导出：Tauri 选文件夹复制文件 + 附 meta.json；浏览器逐张下载 */
  const exportMany = async (ids: string[]) => {
    const list = items.filter((i) => ids.includes(i.id));
    if (!list.length) return;
    if (!isTauri) {
      for (const it of list) {
        const a = document.createElement("a");
        a.href = assetUrl(it.path);
        a.download = `${it.name}.${it.path.split(".").pop() ?? "png"}`;
        a.click();
      }
      toast(`已开始下载 ${list.length} 个文件`, "ok");
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, title: "选择导出文件夹" });
    if (typeof dir !== "string") return;
    const { copyFile, writeTextFile } = await import("@tauri-apps/plugin-fs");
    let ok = 0;
    for (const it of list) {
      try {
        await copyFile(it.path, `${dir}\\${it.name}.${it.path.split(".").pop() ?? "png"}`);
        ok++;
      } catch (e) {
        toast(`导出「${it.name}」失败：${errMsg(e)}`, "err");
      }
    }
    try {
      await writeTextFile(
        `${dir}\\momo-meta.json`,
        JSON.stringify(list.map((i) => ({ name: i.name, prompt: i.prompt, model: i.model, kind: i.kind, tags: i.tags })), null, 2),
      );
    } catch {
      /* meta 写失败不阻塞导出 */
    }
    toast(`已导出 ${ok} 个文件 → ${dir}`, "ok");
  };

  /** 把一批资产作为图片节点放入画布（组卡右键「组内全部放画布」用） */
  const addImagesToCanvas = async (list: AssetItem[]) => {
    setOpen(false);
    let ok = 0;
    for (const it of list) {
      try {
        const src = await assetToDataUrl(it.path, it.mime);
        useBoard.getState().addNode("image", { x: 120 + ok * 40, y: 120 + ok * 40 }, { src, name: it.name, status: "done" });
        ok++;
      } catch (e) {
        toast(`读取资产失败（${it.name}）：${errMsg(e)}`, "err");
      }
    }
    if (ok) toast(`已放入画布 ${ok} 个图片节点`, "ok");
  };

  const previewItem = previewIdx !== null ? filtered[previewIdx] : null;

  return (
    <div
      className={`assetlib-mask ${dragOut ? "drag-out" : ""}`}
      onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
    >
      <div
        ref={panelRef}
        className={`assetlib ${selected.size || pickMode ? "selecting" : ""}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          // 拖的是库里自己的资产（原生拖拽落回面板）→ 不是导入外部文件，忽略
          if (getNativeDragAsset()) return;
          const files = Array.from(e.dataTransfer.files ?? []);
          if (files.length) void importFiles(files);
        }}
      >
        {/* 左侧栏 */}
        <div className="al-side">
          <div className="al-title">
            <IcLibrary size={21} />
            资产库
          </div>
          <div className="side-sec">分类</div>
          {KIND_TABS.map((t) => (
            <button key={t.key} className={`side-item ${kind === t.key ? "on" : ""}`} onClick={() => setKind(t.key)}>
              {t.icon}
              {t.label}
              <span className="cnt">{counts[t.key] ?? 0}</span>
            </button>
          ))}
          <div className="side-sec side-sec-row">
            文件夹
            <span style={{ flex: 1 }} />
            <button
              className="icon-btn al-newfolder"
              title="新建文件夹"
              onClick={() => {
                const id = createFolder(`文件夹 ${folders.length + 1}`);
                setEditingFolder(id);
              }}
            >
              <IcFolderPlus size={14} />
            </button>
          </div>
          <button className={`side-item ${folderId === "all" ? "on" : ""}`} onClick={() => setFolderId("all")}>
            <IcFolder size={17} />
            全部位置
          </button>
          {folders.map((f) => (
            <button
              key={f.id}
              className={`side-item ${folderId === f.id ? "on" : ""}`}
              onClick={() => setFolderId(f.id)}
            >
              <IcFolder size={17} />
              {editingFolder === f.id ? (
                <input
                  className="input"
                  style={{ minHeight: 28, padding: "2px 8px", flex: 1, minWidth: 0 }}
                  autoFocus
                  defaultValue={f.name}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      renameFolder(f.id, (e.target as HTMLInputElement).value.trim() || f.name);
                      setEditingFolder(null);
                    }
                    if (e.key === "Escape") setEditingFolder(null);
                  }}
                  onBlur={(e) => {
                    renameFolder(f.id, e.target.value.trim() || f.name);
                    setEditingFolder(null);
                  }}
                />
              ) : (
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
              )}
              <span className="fold-acts">
                <span
                  className="icon-btn"
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingFolder(f.id);
                  }}
                >
                  <IcEdit size={13} />
                </span>
                <span
                  className="icon-btn danger"
                  title="删除文件夹（资产回到全部位置）"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteFolder(f.id);
                    if (folderId === f.id) setFolderId("all");
                  }}
                >
                  <IcTrash size={13} />
                </span>
              </span>
            </button>
          ))}
          {allTags.length ? (
            <>
              <div className="side-sec">标签</div>
              {allTags.map(([t, n]) => (
                <button
                  key={t}
                  className={`side-item ${tagFilter === t ? "on" : ""}`}
                  title={tagFilter === t ? "再点一次取消筛选" : `筛选标签「${t}」`}
                  onClick={() => setTagFilter(tagFilter === t ? null : t)}
                >
                  <IcTag size={16} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t}</span>
                  <span className="cnt">{n}</span>
                </button>
              ))}
            </>
          ) : null}
          {eagleEnabled ? (
            <>
              <div className="side-sec">连接</div>
              <button
                className={`side-item ${tab === "eagle" ? "on eagle" : ""}`}
                title={
                  connState === "ready"
                    ? "浏览 Eagle 当前素材库（搜索 / 按需导入到 MOMO）"
                    : "Eagle 资产桥未连接——点击去设置页开启"
                }
                onClick={() => (connState === "ready" ? setTab(tab === "eagle" ? "local" : "eagle") : useUi.getState().openSettings("eagle"))}
              >
                <IcEagle size={16} />
                Eagle 素材库
                {connState !== "ready" ? (
                  <span className="cnt">{connState === "offline" ? "离线" : "未连"}</span>
                ) : (
                  <span className="cnt">
                    {eagleStats.queued + eagleStats.failed > 0
                      ? `${eagleStats.synced}/${eagleStats.synced + eagleStats.queued + eagleStats.failed}`
                      : eagleStats.synced || ""}
                  </span>
                )}
              </button>
            </>
          ) : null}
        </div>

        {/* 主区 */}
        <div className="al-main">
        <div className="al-toolbar">
          {tab === "local" && <div className="al-scope" role="group" aria-label="资产范围">
            <button aria-pressed={!projectOnly} onClick={()=>setProjectOnlyManual(false)}><IcLayers size={14}/>全部资产</button>
            <button aria-pressed={projectOnly} disabled={!directorProjectId} title={directorProjectId?"仅显示当前导演项目的参考与生成资产":"打开导演项目后可筛选"} onClick={()=>setProjectOnlyManual(true)}><IcFolder size={14}/>本项目</button>
          </div>}
            {tab === "local" ? (
              <div className="search-box">
                <IcSearch size={16} />
                <input
                  placeholder="按名称 / 提示词 / 模型筛选…"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                />
                {keyword ? (
                  <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => setKeyword("")}>
                    <IcClose size={13} />
                  </button>
                ) : null}
              </div>
            ) : <span style={{ fontWeight: 700, fontSize: "var(--fs-sm)" }}><IcEagle size={15} /> Eagle 远程浏览</span>}
            {tab === "local" ? (
              <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-3)" }}>
                {entries.length === filtered.length ? `${filtered.length} 项` : `${entries.length} 张卡片 · ${filtered.length} 项`}
              </span>
            ) : null}
            <span style={{ flex: 1 }} />
            <button
              className={`btn sm ${pickMode ? "primary" : ""}`}
              title={
                pickMode
                  ? "退出多选模式"
                  : "进入多选模式：左键点击勾选、按住拖动可批量拖出（多选时拖一张 = 拖全部）；右键按住滑动涂抹——划到哪张选哪张，划到一行最右一张后继续下移则一行一行连选，超出上下边界自动滚动续选；起笔卡已选中时本次为取消勾选"
              }
              disabled={!pickMode && !filtered.length}
              onClick={() => {
                if (pickMode) {
                  setPickMode(false);
                  clearSel();
                } else {
                  setPickMode(true);
                }
              }}
            >
              <IcCheckSquare size={15} /> {pickMode ? "退出多选" : "进入多选模式"}
            </button>
            <button className="btn sm" onClick={() => fileRef.current?.click()}>
              <IcUpload size={15} /> 导入文件
            </button>
            <button className="icon-btn" title="关闭 (Esc)" onClick={() => setOpen(false)}>
              <IcClose size={18} />
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length) void importFiles(files);
                e.target.value = "";
              }}
            />
          </div>

          {tab === "eagle" ? (
            <EagleBrowser />
          ) : kind === "trash" ? (
            <div className="al-trash">
              <div className="al-trash-head">
                <b>回收站（{trash.length}）</b>
                <span className="sec-desc" style={{ flex: 1 }}>
                  删除的资产保留 30 天，之后自动彻底清理；「恢复」回到资产库
                </span>
                {trash.length ? (
                  <button
                    className={`btn sm ${purgeAll ? "danger" : ""}`}
                    title="彻底删除回收站全部资产（删除磁盘文件，不可恢复）"
                    onClick={() => {
                      if (!purgeAll) {
                        setPurgeAll(true);
                        return;
                      }
                      purgeMany(trash.map((t) => t.id));
                      setPurgeAll(false);
                      toast("回收站已清空", "ok");
                    }}
                  >
                    <IcTrash size={14} /> {purgeAll ? "再点一次确认" : "全部彻底删除"}
                  </button>
                ) : null}
              </div>
              {trash.length ? (
                <div className="al-trash-list">
                  {trash.map((t) => (
                    <div key={t.id} className="al-trash-item">
                      <div className="a-thumb sm">
                        <AssetThumb item={t} />
                      </div>
                      <div className="al-trash-info">
                        <b>{t.name}</b>
                        <span className="sec-desc">
                          {t.kind === "image" ? "图片" : KIND_BADGE[t.kind] || "文件"} · 删除于{" "}
                          {t.deletedAt ? fmtDate(t.deletedAt) : "—"}
                        </span>
                      </div>
                      <span style={{ flex: 1 }} />
                      <button className="btn sm" title="恢复回资产库" onClick={() => { restoreMany([t.id]); toast("已恢复", "ok"); }}>
                        <IcRestore size={14} /> 恢复
                      </button>
                      {purgeConfirmId === t.id ? (
                        <button
                          className="btn sm danger"
                          title="再次点击确认：删除磁盘文件，不可恢复"
                          onClick={() => { purgeMany([t.id]); setPurgeConfirmId(null); toast("已彻底删除", "ok"); }}
                        >
                          确认删除
                        </button>
                      ) : (
                        <button
                          className="btn sm danger"
                          title="彻底删除（删除磁盘文件，不可恢复）"
                          onClick={() => setPurgeConfirmId(t.id)}
                        >
                          <IcTrash size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="al-empty">
                  <IcRestore size={40} />
                  <br />
                  回收站是空的
                </div>
              )}
            </div>
          ) : (
          <div className="al-grid" onContextMenu={(e) => { if (pickMode) e.preventDefault(); }}>
            {filtered.length === 0 ? (
              <div className="al-empty">
                <IcLibrary size={40} />
                <br />
                {items.length === 0 ? (
                  <>
                    资产库还是空的
                    <br />
                    画布上生成的图片 / 视频会自动收录到这里，也可以点「导入文件」或直接拖文件进来
                  </>
                ) : (
                  "没有符合筛选条件的资产"
                )}
              </div>
            ) : (
              entries.map((entry) => {
                const members = [...entry.items].sort((a, b) => groupMemberOrder(a) - groupMemberOrder(b));
                const grouped = members.length > 1;
                const it = members.find((x) => x.groupCover) ?? members[0];
                const idx = filtered.findIndex((x) => x.id === it.id);
                if (grouped) {
                  const allSelected = members.every((x) => selected.has(x.id));
                  return (
                    <div key={entry.key} className="a-group-stack">
                      <div
                        className={`a-card a-group-card ${allSelected ? "sel" : ""}`}
                        data-sel-ids={members.map((x) => x.id).join(",")}
                        title={`${it.groupLabel || it.prompt || it.name}\n${members.length} 个生成结果 · 点击展开\n右键：整组操作`}
                        onMouseDown={(e) => {
                          // 多选模式右键起笔滑选（组卡按整组取反）
                          if (pickMode && e.button === 2) {
                            e.preventDefault();
                            startStroke(e.currentTarget as HTMLElement);
                          }
                        }}
                        onClick={() => {
                          if (pickMode || selected.size) {
                            const next = new Set(selected);
                            if (allSelected) members.forEach((x) => next.delete(x.id));
                            else members.forEach((x) => next.add(x.id));
                            setSelected(next);
                          } else {
                            setFocusedGroupId(entry.key);
                          }
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (pickMode) return; // 多选模式右键被滑选占用
                          setGroupMenu({ x: e.clientX, y: e.clientY, key: entry.key });
                        }}
                      >
                        <div className="a-thumb"><AssetThumb item={it} /></div>
                        <span className="a-group-count"><IcLayers size={12} /> {members.length}</span>
                        <button
                          className="a-check"
                          aria-label={allSelected ? "取消选择整组" : "选择整组"}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            const next = new Set(selected);
                            if (allSelected) members.forEach((x) => next.delete(x.id));
                            else members.forEach((x) => next.add(x.id));
                            setSelected(next);
                          }}
                        >
                          {allSelected ? <IcCheck size={14} /> : null}
                        </button>
                        <div className="a-name">{it.groupLabel || it.name}</div>
                      </div>
                    </div>
                  );
                }
                return (
                <div
                  key={it.id}
                  className={`a-card ${selected.has(it.id) ? "sel" : ""}`}
                  data-sel-ids={it.id}
                  title={`${it.prompt || it.name}\n拖拽：落到画布 = 图片节点 · 右侧快捷栏 = 发送 · 资源管理器/第三方软件 = 拖出文件\n右键：更多操作`}
                  draggable
                  onMouseDown={(e) => {
                    // 多选模式右键起笔滑选；左键留给点选与拖拽（多选拖一张 = 拖全部选中）
                    if (pickMode && e.button === 2) {
                      e.preventDefault();
                      startStroke(e.currentTarget as HTMLElement);
                    }
                  }}
                  onDragStart={(e) => {
                    // 多选时拖选中卡 = 拖全部选中（负载为逗号拼接的 id 列表，消费端 split）
                    const ids = selected.size && selected.has(it.id) ? [...selected] : [it.id];
                    startAssetDrag(e, ids, items, { trackDragOut, endDragTrack });
                  }}
                  onDragEnd={(e) => {
                    endDragTrack();
                    // 成功落到画布上就顺手关掉资产库，让用户看到新节点
                    if (e.dataTransfer.dropEffect !== "none") setOpen(false);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (pickMode) return; // 多选模式右键被滑选占用，不弹快捷菜单
                    setCardMenu({ x: e.clientX, y: e.clientY, id: it.id });
                  }}
                  onClick={() => {
                    if (selected.size || pickMode) toggleSel(it.id);
                    else setPreviewIdx(idx);
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setRenamingId(it.id);
                    setRenamingName(it.name);
                  }}
                >
                  <div className="a-thumb">
                    <AssetThumb item={it} />
                    {it.width && it.height ? (
                      <div
                        className="a-meta"
                        title={`${it.width}×${it.height}${it.durationMs ? ` · 生成耗时 ${fmtDur(it.durationMs)}` : ""} · 收录于 ${fmtDate(it.createdAt)}`}
                      >
                        <span>{it.width}×{it.height}</span>
                        {it.durationMs ? <span>{fmtDur(it.durationMs)}</span> : null}
                      </div>
                    ) : null}
                  </div>
                  {KIND_BADGE[it.kind] ? <span className="a-badge">{KIND_BADGE[it.kind]}</span> : null}
                  <EagleBadge item={it} />
                  <button
                    className={`a-fav ${it.fav ? "on" : ""}`}
                    title={it.fav ? "取消收藏" : "收藏（「收藏」页签集中查看）"}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFav(it.id);
                    }}
                  >
                    <IcStar size={13} />
                  </button>
                  <button
                    className="a-check"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSel(it.id);
                    }}
                  >
                    {selected.has(it.id) ? <IcCheck size={14} /> : null}
                  </button>
                  {renamingId === it.id ? (
                    <input
                      className="a-rename-input"
                      autoFocus
                      value={renamingName}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenamingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === "Escape") {
                          if (e.key === "Enter" && renamingName.trim()) {
                            useAssets.getState().rename(it.id, renamingName.trim());
                          }
                          setRenamingId(null);
                          e.stopPropagation();
                        }
                      }}
                      onBlur={() => {
                        if (renamingName.trim()) useAssets.getState().rename(it.id, renamingName.trim());
                        setRenamingId(null);
                      }}
                    />
                  ) : (
                    <div className="a-name">{it.name}</div>
                  )}
                </div>
                );
              })
            )}
          </div>
          )}

          {selected.size ? (
            <div className="al-batchbar">
              <b>已选 {selected.size} 项</b>
              <PopSelect
                style={{ width: 190 }}
                title="移动到文件夹"
                value=""
                placeholder="移动到文件夹…"
                options={[
                  { value: "__root__", label: "（无文件夹）" },
                  ...folders.map((f) => ({ value: f.id, label: f.name })),
                ]}
                onChange={(v) => {
                  if (!v) return;
                  moveTo([...selected], v === "__root__" ? null : v);
                  toast("已移动", "ok");
                  clearSel();
                }}
              />
              <div className="batch-tag">
                <IcTag size={15} />
                <input
                  className="input"
                  style={{ minHeight: 34, width: 130 }}
                  placeholder="打标签，回车确认"
                  value={batchTag}
                  list="al-tag-options"
                  onChange={(e) => setBatchTag(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && batchTag.trim()) {
                      addTagMany([...selected], batchTag);
                      toast(`已为 ${selected.size} 项加上标签「${batchTag.trim()}」`, "ok");
                      setBatchTag("");
                    }
                  }}
                />
                <datalist id="al-tag-options">
                  {allTags.map(([t]) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </div>
              <button className="btn sm" title="把所选资产复制到指定文件夹（附带元信息 momo-meta.json）" onClick={() => void exportMany([...selected])}>
                <IcDownload size={15} /> 批量导出
              </button>
              {eagleEnabled ? (
                <button
                  className="btn sm"
                  title={`把所选 ${selected.size} 项批量收进 Eagle 素材库（已在队列/已绑定的自动跳过）`}
                  onClick={() => {
                    queueEaglePush([...selected]);
                    toast(`已把 ${selected.size} 项加入 Eagle 同步队列`, "ok");
                    clearSel();
                  }}
                >
                  <IcEagle size={15} /> 同步到 Eagle
                </button>
              ) : null}
              <button
                className="btn sm"
                title="全选当前筛选结果的全部资产"
                disabled={!filtered.length}
                onClick={() => setSelected(new Set(filtered.map((i) => i.id)))}
              >
                <IcCheckSquare size={15} /> 全选
              </button>
              <button
                className="btn sm"
                title="反选：已选中的取消勾选，当前筛选结果里未选中的全部勾选"
                disabled={!filtered.length}
                onClick={() => {
                  const cur = new Set(selected);
                  setSelected(new Set(filtered.filter((i) => !cur.has(i.id)).map((i) => i.id)));
                }}
              >
                <IcRefresh size={15} /> 反选
              </button>
              <button className={`btn sm ${confirmDel ? "primary" : "danger"}`} onClick={() => void batchDelete()}>
                <IcTrash size={15} /> {confirmDel ? "再点一次确认删除" : "批量删除"}
              </button>
              <span style={{ flex: 1 }} />
              <button className="btn sm" onClick={clearSel}>
                取消选择
              </button>
            </div>
          ) : null}
        </div>
        <ShortcutBar />
        {focusedGroup ? (
          <div className="a-group-focus" onMouseDown={(e) => e.target === e.currentTarget && setFocusedGroupId(null)}>
            <section className="a-group-panel" role="dialog" aria-modal="true" aria-label="生成结果组">
              <header>
                <span><IcLayers size={17} /></span>
                <div>
                  <b>{focusedGroup.items[0].groupLabel || "生成结果组"}</b>
                  <small>{focusedGroup.items.length} 个资产 · 点击任一项查看大图</small>
                </div>
                <button className="icon-btn" aria-label="关闭生成结果组" onClick={() => setFocusedGroupId(null)}>
                  <IcClose size={18} />
                </button>
              </header>
              <div className="a-group-grid">
                {[...focusedGroup.items].sort((a, b) => groupMemberOrder(a) - groupMemberOrder(b)).map((member) => (
                  <div
                    key={member.id}
                    className="a-group-member"
                    /* 组内单张可整卡拖拽：与主网格单卡同一逻辑（原生 OS 拖出 →
                       画布 / 快捷栏 / 资源管理器 / 第三方软件；浏览器预览退 HTML5） */
                    draggable
                    title={`${member.prompt || member.name}\n拖拽：落到画布 = 节点 · 资源管理器/第三方软件 = 拖出文件\n点击查看大图`}
                    onDragStart={(e) => startAssetDrag(e, [member.id], items, { trackDragOut, endDragTrack })}
                    onDragEnd={(e) => {
                      endDragTrack();
                      if (e.dataTransfer.dropEffect !== "none") setOpen(false);
                    }}
                    onClick={() => {
                      const memberIndex = filtered.findIndex((x) => x.id === member.id);
                      if (memberIndex >= 0) setPreviewIdx(memberIndex);
                      setFocusedGroupId(null);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setCardMenu({ x: e.clientX, y: e.clientY, id: member.id });
                    }}
                  >
                    <span className="a-thumb"><AssetThumb item={member} /></span>
                    <EagleBadge item={member} />
                    <span className="a-group-member-name">{member.groupSlot === "final" ? "最终长图" : member.name}</span>
                    {member.groupSlot === "final" ? <span className="a-group-final">最终</span> : null}
                  </div>
                ))}
              </div>
            </section>
          </div>
        ) : null}
      </div>

      {cardMenu
        ? (() => {
            const it = items.find((x) => x.id === cardMenu.id);
            return it ? <CardMenu item={it} x={cardMenu.x} y={cardMenu.y} onClose={() => setCardMenu(null)} /> : null;
          })()
        : null}

      {/* 组卡右键：整组操作 */}
      {groupMenu
        ? (() => {
            const entry = entries.find((e) => e.key === groupMenu.key);
            if (!entry) return null;
            const members = [...entry.items].sort((a, b) => groupMemberOrder(a) - groupMemberOrder(b));
            return (
              <>
                <div
                  style={{ position: "fixed", inset: 0, zIndex: 490 }}
                  onMouseDown={() => setGroupMenu(null)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setGroupMenu(null);
                  }}
                />
                <div className="a-menu glass" style={{ left: Math.min(groupMenu.x, window.innerWidth - 250), top: Math.min(groupMenu.y, window.innerHeight - 200) }}>
                  <button className="am-row" onClick={() => void addImagesToCanvas(members)}>
                    组内 {members.length} 张全部放入画布
                  </button>
                  <button
                    className="am-row"
                    onClick={() => {
                      void removeMany(members.map((m) => m.id));
                      setGroupMenu(null);
                      toast(`整组 ${members.length} 项已移到回收站`, "ok");
                    }}
                  >
                    删除整组（移到回收站）
                  </button>
                </div>
              </>
            );
          })()
        : null}

      {previewItem ? (
        <AssetPreview
          item={previewItem}
          hasPrev={previewIdx! > 0}
          hasNext={previewIdx! < filtered.length - 1}
          onPrev={() => setPreviewIdx((i) => (i ?? 1) - 1)}
          onNext={() => setPreviewIdx((i) => (i ?? 0) + 1)}
          onClose={() => setPreviewIdx(null)}
          onDelete={async () => {
            await removeMany([previewItem.id]);
            setPreviewIdx(null);
            toast("已移到回收站（30 天内可恢复）", "ok");
          }}
        />
      ) : null}
    </div>
  );
}

/* ---------------- 卡片右键菜单 ---------------- */
function CardMenu({ item, x, y, onClose }: { item: AssetItem; x: number; y: number; onClose: () => void }) {
  const { screenToFlowPosition } = useReactFlow();
  const addNode = useBoard((s) => s.addNode);
  const setOpen = useAssets((s) => s.setOpen);
  const removeMany = useAssets((s) => s.removeMany);
  const shortcuts = useSettings((s) => s.settings.shortcuts);
  const eagleEnabled = useSettings((s) => s.settings.eagle.enabled);
  const [confirmDel, setConfirmDel] = useState(false);
  /** 解除绑定是破坏性较弱但需防误触的操作 */
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  const left = Math.min(x, window.innerWidth - 250);
  const top = Math.min(y, window.innerHeight - 320);
  const centerPos = () =>
    screenToFlowPosition({ x: window.innerWidth / 2 - 140, y: window.innerHeight / 2 - 120 });

  const toCanvasImage = async () => {
    onClose();
    try {
      const src = await assetToDataUrl(item.path, item.mime);
      addNode("image", centerPos(), { src, name: item.name, status: "done" });
      setOpen(false);
      toast("已放入画布：图片节点", "ok");
    } catch (e) {
      toast(`读取资产失败：${errMsg(e)}`, "err");
    }
  };

  const toCanvasPrompt = () => {
    onClose();
    addNode("prompt", centerPos(), { text: (item.prompt ?? "").trim() || item.name });
    setOpen(false);
    toast("已放入画布：提示词节点", "ok");
  };

  /** Remix：按资产记录的生成参数还原一个配置好的生成节点（提示词/模型/尺寸等） */
  const toCanvasRemix = () => {
    onClose();
    const g = item.gen;
    if (!g) return;
    if (g.nodeKind === "videoGen") {
      addNode("videoGen", centerPos(), { prompt: g.prompt ?? "", modelId: g.modelId, lang: g.lang });
    } else {
      addNode("imageGen", centerPos(), {
        prompt: g.prompt ?? "",
        modelId: g.modelId,
        size: g.size ?? "default",
        aspect: g.aspect,
        resolution: g.resolution,
        quality: g.quality,
        width: g.width,
        height: g.height,
        lang: g.lang,
        creativity: g.creativity,
      });
    }
    setOpen(false);
    toast("Remix：已还原生成节点与当时的参数，点「生成」即可复刻/续作", "ok");
  };

  return (
    <>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 490 }}
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div className="a-menu glass" style={{ left, top }}>
        {item.kind === "image" ? (
          <button className="am-row" onClick={() => void toCanvasImage()}>
            作为图片节点放入画布
          </button>
        ) : null}
        <button
          className="am-row"
          title={item.prompt ? "使用该资产记录的生成提示词" : "该资产没有提示词记录，将使用名称"}
          onClick={toCanvasPrompt}
        >
          作为提示词节点放入画布
        </button>
        {item.gen ? (
          <button
            className="am-row"
            title={`按生成时的参数还原节点：\n模型 ${item.gen.modelId ?? "默认"}\n${(item.gen.prompt ?? "").slice(0, 90)}`}
            onClick={toCanvasRemix}
          >
            Remix：还原生成节点与参数
          </button>
        ) : null}
        {isTauri && eagleEnabled ? (
          <>
            <div className="am-sep" />
            {!item.eagle?.itemId ? (
              <button
                className="am-row"
                title="把这份作品收进 Eagle 素材库（后台执行，不阻塞画布）"
                onClick={() => {
                  onClose();
                  queueEaglePush([item.id]);
                  toast("已加入 Eagle 同步队列", "ok");
                }}
              >
                同步到 Eagle
              </button>
            ) : item.eagle.state === "remote-dirty" ? (
              <button
                className="am-row"
                title="Eagle 端的文件已被修改——以新版本资产导入，原版本保留（非破坏）"
                onClick={async () => {
                  onClose();
                  const { importEagleItems } = await import("../../core/eagleSyncEngine");
                  const res = await importEagleItems([item.eagle!.itemId], { silent: true });
                  toast(res.length ? `已导入 Eagle 新版本 → ${res[0].name}` : "拉取失败：Eagle 可能已离线", res.length ? "ok" : "err");
                }}
              >
                从 Eagle 导入新版
              </button>
            ) : null}
            <button
              className="am-row"
              title="在 Eagle 里定位到这份素材"
              onClick={async () => {
                onClose();
                const { openExternal } = await import("../../core/external");
                await openExternal(`eagle://item/${item.eagle!.itemId}`);
              }}
            >
              在 Eagle 中打开
            </button>
            <button
              className="am-row danger"
              title={confirmUnlink ? "再次点击确认：只解除绑定关系，两端文件都保留" : "解除与 Eagle 的绑定（不动任何文件）"}
              onClick={() => {
                if (!confirmUnlink) {
                  setConfirmUnlink(true);
                  return;
                }
                onClose();
                unlinkAssets([item.id]);
                toast("已解除 Eagle 绑定（文件均保留）", "ok");
              }}
            >
              {confirmUnlink ? "再点一次确认解绑" : "解除 Eagle 绑定"}
            </button>
          </>
        ) : null}
        {isTauri && shortcuts.length ? (
          <>
            <div className="am-sep" />
            {shortcuts.map((s) => (
              <button
                key={s.id}
                className="am-row"
                onClick={() => {
                  onClose();
                  void sendAsset(s, item);
                }}
              >
                发送到「{s.name}」{s.kind === "folder" ? "（复制）" : "（打开）"}
              </button>
            ))}
          </>
        ) : null}
        <div className="am-sep" />
        {isTauri ? (
          <button
            className="am-row"
            onClick={() => {
              onClose();
              void revealAsset(item);
            }}
          >
            打开文件位置
          </button>
        ) : null}
        <button
          className="am-row"
          onClick={() => {
            onClose();
            void saveAsAsset(item);
          }}
        >
          另存为…
        </button>
        <button
          className="am-row danger"
          onClick={() => {
            if (!confirmDel) {
              setConfirmDel(true);
              return;
            }
            onClose();
            void removeMany([item.id]).then(() => toast("已移到回收站（30 天内可恢复）", "ok"));
          }}
        >
          {confirmDel ? "再点一次确认删除" : "删除资产"}
        </button>
      </div>
    </>
  );
}

/* ---------------- 预览层 ---------------- */
function AssetPreview({
  item,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  onClose,
  onDelete,
}: {
  item: AssetItem;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const rename = useAssets((s) => s.rename);
  const setTags = useAssets((s) => s.setTags);
  const url = assetUrl(item.path);
  const [confirmDel, setConfirmDel] = useState(false);
  const [tagInput, setTagInput] = useState("");
  useEffect(() => {
    setConfirmDel(false);
    setTagInput("");
  }, [item.id]);

  const addTag = () => {
    const t = tagInput.trim();
    if (!t) return;
    setTags(item.id, [...(item.tags ?? []), t]);
    setTagInput("");
  };

  /** 抽视频首/尾帧 → 落资产库（可拖进导演台当首帧/尾帧接力参考） */
  const grabToLibrary = async (point: "first" | "last") => {
    try {
      const { dataUrl } = await grabFrame(url, point);
      const a = await useAssets.getState().collect({
        src: dataUrl,
        kind: "image",
        name: `${item.name}·${point === "first" ? "首帧" : "尾帧"}`,
        model: item.model,
        prompt: item.prompt,
      });
      toast(a ? `已抽取${point === "first" ? "首帧" : "尾帧"}到资产库 → ${a.name}` : "抽帧失败", a ? "ok" : "err");
    } catch (e) {
      toast(`抽帧失败：${errMsg(e)}`, "err");
    }
  };

  return (
    <div className="a-preview" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ap-stage" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {item.kind === "image" ? (
          <img src={url} alt={item.name} />
        ) : item.kind === "vector" ? (
          <img className="svg-bg" src={url} alt={item.name} />
        ) : item.kind === "video" ? (
          <video src={url} controls autoPlay />
        ) : item.kind === "audio" ? (
          <div className="ap-audio">
            <IcMusic size={72} />
            <audio src={url} controls autoPlay style={{ width: 420 }} />
          </div>
        ) : item.kind === "pdf" ? (
          <iframe src={url} title={item.name} />
        ) : (
          <div className="ap-audio">
            <IcFile size={72} />
            <span>此格式暂不支持预览，可另存为后用系统应用打开</span>
          </div>
        )}
        {hasPrev ? (
          <button className="ap-nav prev" onClick={onPrev}>
            <IcArrowL size={22} />
          </button>
        ) : null}
        {hasNext ? (
          <button className="ap-nav next" onClick={onNext}>
            <IcArrowR size={22} />
          </button>
        ) : null}
        <button className="ap-close" onClick={onClose}>
          <IcClose size={20} />
        </button>
      </div>
      <div className="ap-info">
        <h4
          contentEditable
          suppressContentEditableWarning
          onBlur={(e) => {
            const name = e.currentTarget.textContent?.trim();
            if (name && name !== item.name) rename(item.id, name);
          }}
        >
          {item.name}
        </h4>
        <div className="meta-row">
          <span>类型</span>
          <span>
            {item.mime} {item.width ? `· ${item.width}×${item.height}` : ""}
          </span>
        </div>
        <div className="meta-row">
          <span>大小</span>
          <span>{fmtBytes(item.size)}</span>
        </div>
        <div className="meta-row">
          <span>时间</span>
          <span>{fmtDate(item.createdAt)}</span>
        </div>
        {item.model ? (
          <div className="meta-row">
            <span>模型</span>
            <span style={{ textAlign: "right" }}>{item.model}</span>
          </div>
        ) : null}
        <div className="meta-row">
          <span>来源</span>
          <span>{item.source === "canvas" ? "画布生成" : item.source === "eagle" ? "来自 Eagle" : "手动导入"}</span>
        </div>
        <div className="tag-editor">
          {(item.tags ?? []).map((t) => (
            <span key={t} className="tag-chip">
              <IcTag size={12} />
              {t}
              <button
                title="移除该标签"
                onClick={() => setTags(item.id, (item.tags ?? []).filter((x) => x !== t))}
              >
                <IcClose size={11} />
              </button>
            </span>
          ))}
          <input
            className="tag-add"
            placeholder="+ 标签"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addTag()}
            onBlur={addTag}
          />
        </div>
        {item.catalogId ? (
          <div className="set-hint">
            资产册 {item.catalogId} · {item.catalogRole === "spatialLayout" ? "空间站位图" : "外观参考"}
          </div>
        ) : null}
        {item.promptZh ? <div className="prompt-box"><b>中文提示词</b><br />{item.promptZh}</div> : null}
        {item.promptEn ? <div className="prompt-box"><b>English Prompt</b><br />{item.promptEn}</div> : null}
        {!item.promptZh && !item.promptEn && item.prompt ? <div className="prompt-box">{item.prompt}</div> : null}
        {item.catalogRole === "spatialLayout" && (item.spatialLockZh || item.spatialLockEn) ? (
          <div className="prompt-box"><b>空间锁</b><br />{item.spatialLockZh || item.spatialLockEn}</div>
        ) : null}
        <div style={{ flex: 1 }} />
        {item.kind === "video" ? (
          <>
            <button className="btn" title="抽取视频第一帧为图片，收进资产库（可拖进导演台当首帧）" onClick={() => void grabToLibrary("first")}>
              抽首帧
            </button>
            <button className="btn" title="抽取视频最后一帧为图片，收进资产库（可拖进导演台当尾帧/接力首帧）" onClick={() => void grabToLibrary("last")}>
              抽尾帧
            </button>
          </>
        ) : null}
        <button className="btn" onClick={() => void saveAsAsset(item)}>
          <IcDownload size={16} /> 另存为…
        </button>
        {isTauri ? (
          <button className="btn" onClick={() => void revealAsset(item)}>
            <IcFolder size={16} /> 打开文件位置
          </button>
        ) : null}
        <button
          className={`btn ${confirmDel ? "primary" : "danger"}`}
          onClick={() => (confirmDel ? void onDelete() : setConfirmDel(true))}
        >
          <IcTrash size={16} /> {confirmDel ? "再点一次确认删除" : "删除资产"}
        </button>
      </div>
    </div>
  );
}
