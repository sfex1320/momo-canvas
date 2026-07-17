/**
 * 资产库 — 独立模块
 *  自动收录画布生成内容 + 手动导入；分类 / 文件夹 / 筛选 / 批量操作；
 *  图片、视频、音频、PDF 原生预览
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useAssets } from "../../core/stores/assetStore";
import { toast } from "../../core/stores/uiStore";
import { assetUrl } from "../../core/services/assetFiles";
import { errMsg, isTauri } from "../../core/utils";
import type { AssetItem, AssetKind } from "../../core/types";
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

  const [kind, setKind] = useState<AssetKind | "all">("all");
  const [folderId, setFolderId] = useState<string | "all">("all");
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return items.filter((i) => {
      if (kind !== "all" && i.kind !== kind) return false;
      if (folderId !== "all" && i.folderId !== folderId) return false;
      if (kw && !`${i.name} ${i.prompt ?? ""} ${i.model ?? ""}`.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [items, kind, folderId, keyword]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length };
    for (const i of items) c[i.kind] = (c[i.kind] ?? 0) + 1;
    return c;
  }, [items]);

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
    <div className="assetlib-mask" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div
        className={`assetlib ${selected.size ? "selecting" : ""}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
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
                  title={it.prompt || it.name}
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
      </div>

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
  const url = assetUrl(item.path);
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => setConfirmDel(false), [item.id]);

  const saveAs = async () => {
    try {
      if (!isTauri) {
        const a = document.createElement("a");
        a.href = url;
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
  };

  const reveal = async () => {
    if (!isTauri) return;
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(item.path);
    } catch (e) {
      toast(errMsg(e), "err");
    }
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
        {item.prompt ? <div className="prompt-box">{item.prompt}</div> : null}
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={() => void saveAs()}>
          <IcDownload size={16} /> 另存为…
        </button>
        {isTauri ? (
          <button className="btn" onClick={() => void reveal()}>
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
