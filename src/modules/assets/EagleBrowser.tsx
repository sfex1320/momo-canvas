/**
 * Eagle 远程浏览 — 资产库内的「Eagle」页签
 *
 * 只读浏览本机 Eagle 当前素材库：分页拉取（默认 60/页）+ 关键词搜索；
 * 缩略图走 MOMO 本地桥流式端点（环回 + token，路径白名单校验在 Rust 侧）。
 * 远程卡只能「导入到 MOMO」——导入完成才成为可拖拽的本地资产，绝不直接引用 Eagle 文件。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { EagleRemoteItem } from "../../core/types";
import { useEagle } from "../../core/stores/eagleStore";
import { useAssets } from "../../core/stores/assetStore";
import { ensureRootFolder, importEagleItems, remoteThumbUrl } from "../../core/eagleSyncEngine";
import { useSettings } from "../../core/stores/settingsStore";
import { toast, useUi } from "../../core/stores/uiStore";
import { errMsg } from "../../core/utils";
import { openExternal } from "../../core/external";
import { IcEagle, IcRefresh, IcSearch } from "../../ui/icons";

const PAGE = 60;

export function EagleBrowser() {
  const conn = useEagle((s) => s.connState);
  const library = useEagle((s) => s.library);
  const dirtyIds = useEagle((s) => s.dirtyIds);

  const [kw, setKw] = useState("");
  const [items, setItems] = useState<EagleRemoteItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  /** 已导入的 itemId（本地绑定检查结果）；放 state 才能让「导入 MOMO」按钮导入后立即变「已在库」 */
  const [linkedIds, setLinkedIds] = useState<Set<string>>(new Set());
  const seq = useRef(0);

  /* 检查本地已绑定的 itemId 集合（资产库打开期间同步结果变化时跟随刷新） */
  useEffect(() => {
    const s = new Set<string>();
    for (const i of useAssets.getState().items) if (i.eagle?.itemId) s.add(i.eagle.itemId);
    setLinkedIds(s);
  }, []);

  /** MOMO 根文件夹（默认只读这个文件夹及其子级，不扫全库） */
  const [rootId, setRootId] = useState<string | null | undefined>(undefined);
  const rootName = useSettings((s) => s.settings.eagle.rootFolderName);

  useEffect(() => {
    void ensureRootFolder({ createIfMissing: false })
      .then((id) => setRootId(id ?? null))
      .catch(() => setRootId(null));
  }, []);

  const load = useCallback(
    async (nextKw: string, nextOffset: number, scopeRoot?: string | null) => {
      setLoading(true);
      const mySeq = ++seq.current;
      try {
        const { client } = useEagle.getState();
        const cli = client;
        if (!cli) throw new Error("尚未连接 Eagle");
        const root = scopeRoot !== undefined ? scopeRoot : rootId;
        const kwArr = nextKw.trim() ? nextKw.trim().split(/\s+/).slice(0, 5) : undefined;
        // 限定 MOMO 根文件夹内（含子级）；keywords 走 name 过滤，不用全库搜索语法
        const page = await cli.getItems({
          folders: root ? [root] : undefined,
          keywords: kwArr,
          offset: nextOffset,
          limit: PAGE,
        });
        if (mySeq !== seq.current) return; // 旧请求作废
        setItems((prev) => (nextOffset === 0 ? page.data : [...prev, ...page.data]));
        setTotal(page.total);
        setOffset(nextOffset + page.data.length);
      } catch (e) {
        if (mySeq === seq.current) toast(`读取 Eagle 素材失败：${errMsg(e)}`, "err");
      } finally {
        if (mySeq === seq.current) setLoading(false);
      }
    },
    [rootId],
  );

  useEffect(() => {
    if (rootId !== undefined) void load("", 0);
  }, [rootId, load]);

  if (!library || conn !== "ready") {
    return (
      <div className="al-eagle-empty">
        <IcEagle size={44} />
        <br />
        {conn === "connecting" ? "正在连接 Eagle…" : "尚未连接 Eagle 素材库"}
        <br />
        <button className="btn sm" onClick={() => useUi.getState().openSettings("eagle")}>
          到「设置 → Eagle 资产桥」连接
        </button>
      </div>
    );
  }

  if (rootId === null) {
    return (
      <div className="al-eagle-empty">
        <IcEagle size={44} />
        <br />
        还没有指定 MOMO 根文件夹（如「Eagle-Momo」）
        <br />
        浏览范围只限根文件夹内部，不会扫描整个素材库
        <br />
        <button className="btn sm" onClick={() => useUi.getState().openSettings("eagle")}>
          到设置里选择根文件夹
        </button>
      </div>
    );
  }

  return (
    <div className="al-eagle">
      <div className="al-eagle-head">
        <span className="al-eagle-lib" title={library.path}>
          <IcEagle size={15} />
          {library.name}
          <em>{total} 项</em>
        </span>
        <div className="search-box">
          <IcSearch size={16} />
          <input
            placeholder={`在「${rootId ? "MOMO 根目录" : rootName}」中搜索…`}
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void load(kw, 0)}
          />
        </div>
        <button className="btn sm" disabled={loading} onClick={() => void load(kw, 0)}>
          <IcRefresh size={13} /> 刷新
        </button>
      </div>

      {items.length === 0 && !loading ? (
        <div className="al-empty">
          <IcEagle size={40} />
          <br />
          没有找到匹配的素材
        </div>
      ) : (
        <div className="al-grid al-eagle-grid">
          {items.map((it) => (
            <EagleRemoteCard key={it.id} item={it} linked={linkedIds.has(it.id)} onImport={() => void doImport(it)} />
          ))}
        </div>
      )}

      {loading ? <div className="al-eagle-loading">加载中…</div> : null}
      {!loading && items.length < total ? (
        <div className="al-eagle-more">
          <button className="btn sm" onClick={() => void load(kw, offset)}>
            加载更多（{items.length}/{total}）
          </button>
        </div>
      ) : null}
      {dirtyIds.length ? (
        <div className="set-hint" style={{ padding: "6px 12px" }}>
          有 {dirtyIds.length} 个已绑定素材在 Eagle 中被外部更新——在「全部」里按状态角标找到它们，右键「从 Eagle 导入新版」。
        </div>
      ) : null}
    </div>
  );

  async function doImport(it: EagleRemoteItem) {
    const res = await importEagleItems([it.id]);
    if (res.length) {
      setLinkedIds((prev) => new Set(prev).add(it.id));
      toast(`已导入：${res[0].name}`, "ok");
    }
  }
}

function EagleRemoteCard({ item, linked, onImport }: { item: EagleRemoteItem; linked: boolean; onImport: () => void }) {
  const url = remoteThumbUrl(item);
  const extBadge = item.ext.toUpperCase().slice(0, 4);
  return (
    <div
      className="a-card a-remote"
      title={`${item.name}${item.width ? ` · ${item.width}×${item.height}` : ""}\n双击在 Eagle 中打开`}
      onDoubleClick={() => void openExternal(`eagle://item/${item.id}`)}
    >
      <div className="a-thumb">{url ? <img src={url} alt="" loading="lazy" /> : <IcEagle size={36} />}</div>
      {extBadge ? <span className="a-badge">{extBadge}</span> : null}
      <div className="a-name">{item.name}</div>
      <button
        className={`btn sm ${linked ? "" : "primary"} a-remote-btn`}
        disabled={linked}
        title={linked ? "该素材已有 MOMO 绑定副本（不重复导入）" : "复制进 MOMO 资产库后即可拖入画布"}
        onClick={onImport}
      >
        {linked ? "已在库" : "导入 MOMO"}
      </button>
    </div>
  );
}
