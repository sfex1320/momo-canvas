/**
 * 画布命令面板 —
 *  CanvasSearch（Ctrl+F）：按名称/内容搜索画布节点，回车飞越并选中
 *  Spotlight（Ctrl+K）：键盘流快速添加节点（后续含画布模板），回车落到视图中心
 * 需在 ReactFlow 上下文内渲染（用到 setCenter / screenToFlowPosition）
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { NODE_LABEL, useBoard } from "../../core/stores/boardStore";
import { useTemplates } from "../../core/stores/templateStore";
import { useUi } from "../../core/stores/uiStore";
import { NODE_CATALOG } from "./nodeCatalog";
import { IcDownload, IcLayers, IcSearch, IcTrash, IcUpload } from "../../ui/icons";
import { toast } from "../../core/stores/uiStore";
import { errMsg, isTauri } from "../../core/utils";
import type { AppNode, BoardTemplate, ChatMsg, NodeKind } from "../../core/types";

/** 节点的可搜索文本：类型名 + 各类内容字段 */
function nodeSearchText(n: AppNode): string {
  const d = n.data as Record<string, unknown>;
  const parts: string[] = [NODE_LABEL[n.type as NodeKind] ?? String(n.type)];
  for (const k of ["text", "prompt", "result", "name", "custom", "extra", "subject", "title"]) {
    if (typeof d[k] === "string") parts.push(d[k] as string);
  }
  const profile = d.profile as { name?: string } | undefined;
  if (profile?.name) parts.push(profile.name);
  const msgs = d.messages as ChatMsg[] | undefined;
  if (msgs?.length) parts.push(...msgs.slice(-4).map((m) => m.text));
  return parts.join("\n").toLowerCase();
}

/** 节点内容摘要（结果列表里显示） */
function nodeSnippet(n: AppNode): string {
  const d = n.data as Record<string, unknown>;
  const s =
    (typeof d.text === "string" && d.text) ||
    (typeof d.prompt === "string" && d.prompt) ||
    (typeof d.name === "string" && d.name) ||
    (typeof d.result === "string" && d.result) ||
    ((d.profile as { name?: string } | undefined)?.name ?? "");
  return String(s).replace(/\s+/g, " ").slice(0, 46);
}

export function CanvasSearch() {
  const open = useUi((s) => s.searchOpen);
  const setOpen = useUi((s) => s.setSearchOpen);
  const { setCenter, getZoom } = useReactFlow();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const nodes = useBoard((s) => s.nodes);
  const hits = useMemo(() => {
    const query = q.trim().toLowerCase();
    const list = nodes.filter((n) => n.type !== "group");
    if (!query) return [];
    return list.filter((n) => nodeSearchText(n).includes(query)).slice(0, 12);
  }, [q, nodes]);

  if (!open) return null;

  const jump = (n: AppNode) => {
    const s = useBoard.getState();
    const parent = n.parentId ? s.nodes.find((x) => x.id === n.parentId) : undefined;
    const ax = n.position.x + (parent?.position.x ?? 0) + (n.measured?.width ?? 260) / 2;
    const ay = n.position.y + (parent?.position.y ?? 0) + (n.measured?.height ?? 140) / 2;
    void setCenter(ax, ay, { zoom: Math.max(getZoom(), 0.85), duration: 320 });
    // 选中即高亮
    s.onNodesChange([
      ...s.nodes.filter((x) => x.selected && x.id !== n.id).map((x) => ({ type: "select" as const, id: x.id, selected: false })),
      { type: "select" as const, id: n.id, selected: true },
    ]);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && hits[idx]) {
      jump(hits[idx]);
      setOpen(false);
    }
  };

  return (
    <div className="palette-wrap" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="palette glass">
        <div className="pal-input">
          <IcSearch size={16} />
          <input
            ref={inputRef}
            className="nodrag"
            placeholder="搜索画布节点：名称 / 提示词 / 内容…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={onKey}
          />
          <kbd>Esc</kbd>
        </div>
        {q.trim() ? (
          <div className="pal-list nowheel">
            {hits.length ? (
              hits.map((n, i) => (
                <button
                  key={n.id}
                  className={`pal-item ${i === idx ? "on" : ""}`}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => jump(n)}
                >
                  <b>{NODE_LABEL[n.type as NodeKind] ?? n.type}</b>
                  <span>{nodeSnippet(n) || "（无内容）"}</span>
                </button>
              ))
            ) : (
              <div className="pal-empty">没有匹配的节点</div>
            )}
          </div>
        ) : (
          <div className="pal-empty dim">输入关键词，↑↓ 选择，回车飞到该节点</div>
        )}
      </div>
    </div>
  );
}

type SpotItem =
  | { type: "node"; kind: NodeKind; label: string; desc: string; icon: React.ReactNode }
  | { type: "tpl"; tpl: BoardTemplate };

export function Spotlight({ onPick, onPickTemplate }: { onPick: (kind: NodeKind) => void; onPickTemplate: (tpl: BoardTemplate) => void }) {
  const open = useUi((s) => s.spotlightOpen);
  const setOpen = useUi((s) => s.setSpotlightOpen);
  const templates = useTemplates((s) => s.templates);
  const allTemplates = useTemplates((s) => s.all);
  const removeTemplate = useTemplates((s) => s.remove);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const items = useMemo<SpotItem[]>(() => {
    const query = q.trim().toLowerCase();
    const tpls = allTemplates()
      .filter((t) => !query || t.name.toLowerCase().includes(query) || "模板".includes(query))
      .map((tpl): SpotItem => ({ type: "tpl", tpl }));
    const kinds = NODE_CATALOG.filter(
      (i) => !query || i.label.toLowerCase().includes(query) || i.desc.toLowerCase().includes(query) || i.kind.toLowerCase().includes(query),
    ).map((i): SpotItem => ({ type: "node", kind: i.kind, label: i.label, desc: i.desc, icon: i.icon }));
    // 有查询词时模板优先（模板通常是刻意找的）；空查询时节点在前、模板压后
    return query ? [...tpls, ...kinds] : [...kinds, ...tpls];
    // templates 订阅只为在增删模板后刷新列表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, templates, allTemplates]);

  if (!open) return null;

  const pick = (it: SpotItem) => {
    if (it.type === "node") onPick(it.kind);
    else onPickTemplate(it.tpl);
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && items[idx]) {
      pick(items[idx]);
    }
  };

  return (
    <div className="palette-wrap" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="palette glass">
        <div className="pal-input">
          <IcSearch size={16} />
          <input
            ref={inputRef}
            className="nodrag"
            placeholder="快速添加：输入节点名或模板名（如 重绘 / 生图 / 示例）…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={onKey}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="pal-list nowheel">
          {items.length ? (
            items.map((it, iIdx) => {
              const key = it.type === "node" ? it.kind : it.tpl.id;
              return (
                <button key={key} className={`pal-item ${iIdx === idx ? "on" : ""}`} onMouseEnter={() => setIdx(iIdx)} onClick={() => pick(it)}>
                  <span className="pal-ic">{it.type === "node" ? it.icon : <IcLayers size={16} />}</span>
                  <b>{it.type === "node" ? it.label : it.tpl.name}</b>
                  <span>
                    {it.type === "node"
                      ? it.desc
                      : `画布模板 · ${it.tpl.nodes.filter((x) => x.kind !== "group").length} 个节点，插入即用`}
                  </span>
                  {it.type === "tpl" ? (
                    <span
                      className="pal-del"
                      title="导出为 .momoflow 工作流文件（发给别人导入即用）"
                      onClick={(e) => {
                        e.stopPropagation();
                        void useTemplates
                          .getState()
                          .exportOne(it.tpl)
                          .then((p) => p && toast(`已导出 → ${p}`, "ok"))
                          .catch((err) => toast(`导出失败：${errMsg(err)}`, "err"));
                      }}
                    >
                      <IcDownload size={14} />
                    </span>
                  ) : null}
                  {it.type === "tpl" && !it.tpl.builtin ? (
                    <span
                      className="pal-del"
                      title="删除此模板"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeTemplate(it.tpl.id);
                      }}
                    >
                      <IcTrash size={14} />
                    </span>
                  ) : null}
                </button>
              );
            })
          ) : (
            <div className="pal-empty">没有匹配的节点或模板</div>
          )}
          <button
            className="pal-item"
            title="导入别人分享的 .momoflow 工作流文件（导入后出现在模板列表，插入即用）"
            onClick={() => {
              const done = (name: string | null) => {
                if (name) toast(`已导入工作流「${name}」：在此列表中选择即可插入画布`, "ok");
              };
              if (isTauri) {
                void useTemplates
                  .getState()
                  .importViaDialog()
                  .then(done)
                  .catch((err) => toast(`导入失败：${errMsg(err)}`, "err"));
                return;
              }
              const input = document.createElement("input");
              input.type = "file";
              input.accept = ".momoflow,.json";
              input.onchange = () => {
                const f = input.files?.[0];
                if (!f) return;
                void f
                  .text()
                  .then((t) => done(useTemplates.getState().importText(t)))
                  .catch((err) => toast(`导入失败：${errMsg(err)}`, "err"));
              };
              input.click();
            }}
          >
            <span className="pal-ic">
              <IcUpload size={16} />
            </span>
            <b>导入工作流文件</b>
            <span>.momoflow · 别人导出的画布工作流，导入后即出现在模板列表</span>
          </button>
        </div>
      </div>
    </div>
  );
}
