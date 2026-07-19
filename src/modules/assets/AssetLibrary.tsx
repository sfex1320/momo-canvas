/**
 * 资产库 — 独立模块
 *  自动收录画布生成内容 + 手动导入；分类 / 文件夹 / 标签 / 筛选 / 批量操作；
 *  图片、视频、音频、PDF 原生预览；
 *  卡片拖拽（Tauri 下走 OS 原生拖拽）：可落到画布（变图片节点）、右侧快捷栏、资源管理器、第三方软件；
 *  右键卡片有快捷菜单（放入画布 / 发送到快捷方式 / 打开位置 / 另存为 / 删除）
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { useAssets } from "../../core/stores/assetStore";
import { useBoard } from "../../core/stores/boardStore";
import { useSettings } from "../../core/stores/settingsStore";
import { toast } from "../../core/stores/uiStore";
import { assetToDataUrl, assetUrl } from "../../core/services/assetFiles";
import { errMsg, isTauri } from "../../core/utils";
import { ShortcutBar, sendAsset } from "./ShortcutBar";
import { getNativeDragAsset, setNativeDragAsset } from "./dragState";
import type { AssetItem, AssetKind } from "../../core/types";

/** 原生 OS 拖拽（Tauri 默认）：同一次拖拽可落到画布/快捷栏/资源管理器/第三方软件 */
async function nativeDragOut(it: AssetItem) {
  try {
    const { startDrag } = await import("@crabnebula/tauri-plugin-drag");
    await startDrag({ item: [it.path], icon: it.thumb || it.path });
  } catch (e) {
    toast(`拖出失败：${errMsg(e)}`, "err");
  }
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
  IcClose,
  IcDownload,
  IcEdit,
  IcFile,
  IcFolder,
  IcFolderPlus,
  IcGallery,
  IcImage,
  IcLibrary,
  IcMusic,
  IcSearch,
  IcTag,
  IcTrash,
  IcUpload,
  IcVideo,
} from "../../ui/icons";
import "./assets.css";

const KIND_TABS: { key: AssetKind | "all"; label: string; icon: React.ReactNode }[] = [
  { key: "all", label: "全部", icon: <IcGallery size={17} /> },
  { key: "image", label: "图片", icon: <IcImage size={17} /> },
  { key: "video", label: "视频", icon: <IcVideo size={17} /> },
  { key: "audio", label: "音频", icon: <IcMusic size={17} /> },
  { key: "pdf", label: "PDF", icon: <IcFile size={17} /> },
  { key: "other", label: "其他", icon: <IcFile size={17} /> },
];

const KIND_BADGE: Record<AssetKind, string> = { image: "", video: "视频", audio: "音频", pdf: "PDF", other: "文件" };

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

export function AssetLibrary() {
  const open = useAssets((s) => s.open);
  const setOpen = useAssets((s) => s.setOpen);
  const items = useAssets((s) => s.items);
  const folders = useAssets((s) => s.folders);
  const importFiles = useAssets((s) => s.importFiles);
  const removeMany = useAssets((s) => s.removeMany);
  const moveTo = useAssets((s) => s.moveTo);
  const createFolder = useAssets((s) => s.createFolder);
  const renameFolder = useAssets((s) => s.renameFolder);
  const deleteFolder = useAssets((s) => s.deleteFolder);
  const addTagMany = useAssets((s) => s.addTagMany);

  const [kind, setKind] = useState<AssetKind | "all">("all");
  const [folderId, setFolderId] = useState<string | "all">("all");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [batchTag, setBatchTag] = useState("");
  /** 拖卡片且指针已移出面板区域：资产库隐身让位（快捷栏保留可落） */
  const [dragOut, setDragOut] = useState(false);
  /** 右键菜单：屏幕坐标 + 目标资产 */
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number; id: string } | null>(null);
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

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return items.filter((i) => {
      if (kind !== "all" && i.kind !== kind) return false;
      if (folderId !== "all" && i.folderId !== folderId) return false;
      if (tagFilter && !(i.tags ?? []).includes(tagFilter)) return false;
      if (kw && !`${i.name} ${i.prompt ?? ""} ${i.model ?? ""} ${(i.tags ?? []).join(" ")}`.toLowerCase().includes(kw))
        return false;
      return true;
    });
  }, [items, kind, folderId, tagFilter, keyword]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length };
    for (const i of items) c[i.kind] = (c[i.kind] ?? 0) + 1;
    return c;
  }, [items]);

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

  /* Esc 关闭 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (previewIdx !== null) setPreviewIdx(null);
        else setOpen(false);
      }
      if (previewIdx !== null && e.key === "ArrowLeft") setPreviewIdx((i) => (i !== null && i > 0 ? i - 1 : i));
      if (previewIdx !== null && e.key === "ArrowRight")
        setPreviewIdx((i) => (i !== null && i < filtered.length - 1 ? i + 1 : i));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, previewIdx, filtered.length, setOpen]);

  useEffect(() => setConfirmDel(false), [selected.size]);

  if (!open) return null;

  const toggleSel = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const clearSel = () => setSelected(new Set());

  const batchDelete = async () => {
    if (!confirmDel) {
      setConfirmDel(true);
      return;
    }
    const n = selected.size;
    await removeMany([...selected]);
    clearSel();
    setPreviewIdx(null);
    toast(`已删除 ${n} 个资产（文件已从磁盘移除）`, "ok");
  };

  const previewItem = previewIdx !== null ? filtered[previewIdx] : null;

  return (
    <div
      className={`assetlib-mask ${dragOut ? "drag-out" : ""}`}
      onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
    >
      <div
        ref={panelRef}
        className={`assetlib ${selected.size ? "selecting" : ""}`}
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
          <div className="side-sec">文件夹</div>
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
          <button
            className="side-item"
            onClick={() => {
              const id = createFolder(`文件夹 ${folders.length + 1}`);
              setEditingFolder(id);
            }}
          >
            <IcFolderPlus size={17} />
            新建文件夹
          </button>
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
        </div>

        {/* 主区 */}
        <div className="al-main">
          <div className="al-toolbar">
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
            <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-3)" }}>{filtered.length} 项</span>
            <span style={{ flex: 1 }} />
            <button
              className="btn sm"
              title="选中当前筛选结果的全部资产"
              disabled={!filtered.length}
              onClick={() => setSelected(new Set(filtered.map((i) => i.id)))}
            >
              <IcCheckSquare size={15} /> 全选筛选结果
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

          <div className="al-grid">
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
              filtered.map((it, idx) => (
                <div
                  key={it.id}
                  className={`a-card ${selected.has(it.id) ? "sel" : ""}`}
                  title={`${it.prompt || it.name}\n拖拽：落到画布 = 图片节点 · 右侧快捷栏 = 发送 · 资源管理器/第三方软件 = 拖出文件\n右键：更多操作`}
                  draggable
                  onDragStart={(e) => {
                    if (isTauri) {
                      // 原生拖拽：一次拖拽通吃画布 / 快捷栏 / 资源管理器 / 第三方软件
                      e.preventDefault();
                      setNativeDragAsset(it.id);
                      trackDragOut();
                      void nativeDragOut(it).finally(() => {
                        setNativeDragAsset(null);
                        endDragTrack();
                      });
                      return;
                    }
                    // 浏览器预览：HTML5 拖拽（画布/快捷栏）
                    e.dataTransfer.setData("momo/asset-id", it.id);
                    e.dataTransfer.effectAllowed = "copy";
                    trackDragOut();
                  }}
                  onDragEnd={(e) => {
                    endDragTrack();
                    // 成功落到画布上就顺手关掉资产库，让用户看到新节点
                    if (e.dataTransfer.dropEffect !== "none") setOpen(false);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setCardMenu({ x: e.clientX, y: e.clientY, id: it.id });
                  }}
                  onClick={() => {
                    if (selected.size) toggleSel(it.id);
                    else setPreviewIdx(idx);
                  }}
                >
                  <div className="a-thumb">
                    {it.thumb ? (
                      <img src={assetUrl(it.thumb)} alt="" loading="lazy" />
                    ) : it.kind === "image" ? (
                      <img src={assetUrl(it.path)} alt="" loading="lazy" />
                    ) : it.kind === "audio" ? (
                      <IcMusic size={40} />
                    ) : it.kind === "video" ? (
                      <IcVideo size={40} />
                    ) : (
                      <IcFile size={40} />
                    )}
                  </div>
                  {KIND_BADGE[it.kind] ? <span className="a-badge">{KIND_BADGE[it.kind]}</span> : null}
                  <button
                    className="a-check"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSel(it.id);
                    }}
                  >
                    {selected.has(it.id) ? <IcCheck size={14} /> : null}
                  </button>
                  <div className="a-name">{it.name}</div>
                </div>
              ))
            )}
          </div>

          {selected.size ? (
            <div className="al-batchbar">
              <b>已选 {selected.size} 项</b>
              <select
                className="select"
                style={{ width: 190, minHeight: 34 }}
                value=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return;
                  moveTo([...selected], v === "__root__" ? null : v);
                  toast("已移动", "ok");
                  clearSel();
                }}
              >
                <option value="">移动到文件夹…</option>
                <option value="__root__">（无文件夹）</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
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
      </div>

      {cardMenu
        ? (() => {
            const it = items.find((x) => x.id === cardMenu.id);
            return it ? <CardMenu item={it} x={cardMenu.x} y={cardMenu.y} onClose={() => setCardMenu(null)} /> : null;
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
            toast("已删除", "ok");
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
  const [confirmDel, setConfirmDel] = useState(false);

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
            void removeMany([item.id]).then(() => toast("已删除（文件已从磁盘移除）", "ok"));
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

  return (
    <div className="a-preview" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ap-stage" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {item.kind === "image" ? (
          <img src={url} alt={item.name} />
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
          <span>{item.source === "canvas" ? "画布生成" : "手动导入"}</span>
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
        {item.prompt ? <div className="prompt-box">{item.prompt}</div> : null}
        <div style={{ flex: 1 }} />
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
