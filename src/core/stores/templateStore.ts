/**
 * 画布模板库 — 把组/一组节点打包成可反复实例化的模板（LibTV「打组模板」/ Krea Node App 的桌面端形态）
 * 内置示例模板（seedTemplates）合并展示，不落盘、不可删除
 */
import { create } from "zustand";
import type { Edge } from "@xyflow/react";
import type { AppNode, BoardTemplate, NodeKind, TemplateEdge, TemplateNode } from "../types";
import { defaultData, edgeClassFor, outPortType, useBoard } from "./boardStore";
import { loadJSON, saveJSON } from "../persist";
import { uid } from "../utils";
import { SEED_TEMPLATES } from "../seedTemplates";

/** 模板保存时的数据清洗：保留配置、丢运行结果与大图（模板要轻，且结果没有复用意义） */
function cleanData(kind: NodeKind, data: Record<string, unknown>): Record<string, unknown> {
  const d: Record<string, unknown> = { ...data };
  d.status = "idle";
  delete d.error;
  delete d.progress;
  delete d.progressPct;
  delete d.ignored;
  if ("picked" in d) d.picked = 0;
  if ("results" in d) d.results = Array.isArray(d.results) ? [] : {};
  delete d.result;
  delete d.resultUrl;
  delete d.mask; // 蒙版/框选与具体图片绑定，模板里没有意义
  delete d.rect;
  delete d.srcW;
  delete d.srcH;
  delete d.outW;
  delete d.outH;
  if (kind === "image") {
    delete d.src; // 图片本体不进模板（避免 boards 级别的大 dataURL 膨胀）
    delete d.name;
  }
  if (kind === "chat") d.messages = [];
  return d;
}

type TemplateState = {
  templates: BoardTemplate[];
  loaded: boolean;
  init: () => Promise<void>;
  /** 全部模板：用户模板 + 内置示例 */
  all: () => BoardTemplate[];
  /** 把一组节点（组成员或多选）存为模板；返回模板 id */
  saveFrom: (name: string, nodes: AppNode[], edges: Edge[]) => string;
  remove: (id: string) => void;
  /** 实例化到画布：以 at 为左上角展开（重新生成 id、恢复连线），并整体选中 */
  instantiate: (tpl: BoardTemplate, at: { x: number; y: number }) => void;
};

let initOnce: Promise<void> | null = null;
type PersistShape = { templates: BoardTemplate[] };

export const useTemplates = create<TemplateState>((set, get) => {
  const persist = () => {
    if (!get().loaded) return;
    void saveJSON("boardTemplates.json", "v1", { templates: get().templates } satisfies PersistShape);
  };

  return {
    templates: [],
    loaded: false,

    init: () =>
      (initOnce ??= (async () => {
        const saved = await loadJSON<PersistShape>("boardTemplates.json", "v1");
        set({ templates: saved?.templates ?? [], loaded: true });
      })()),

    all: () => [...get().templates, ...SEED_TEMPLATES],

    saveFrom: (name, nodes, edges) => {
      // 组节点在前（成员 parentTid 指向它）；位置统一转为相对包围盒左上角
      const ids = new Set(nodes.map((n) => n.id));
      const abs = (n: AppNode) => {
        const p = n.parentId ? nodes.find((x) => x.id === n.parentId) : undefined;
        return { x: n.position.x + (p?.position.x ?? 0), y: n.position.y + (p?.position.y ?? 0) };
      };
      const minX = Math.min(...nodes.map((n) => abs(n).x));
      const minY = Math.min(...nodes.map((n) => abs(n).y));
      const idToTid = new Map<string, string>();
      for (const n of nodes) idToTid.set(n.id, uid(6));
      const tnodes: TemplateNode[] = nodes.map((n) => ({
        tid: idToTid.get(n.id)!,
        kind: n.type as NodeKind,
        // 组成员保留相对父级坐标；顶层节点转为相对包围盒
        x: n.parentId && ids.has(n.parentId) ? n.position.x : abs(n).x - minX,
        y: n.parentId && ids.has(n.parentId) ? n.position.y : abs(n).y - minY,
        data: cleanData(n.type as NodeKind, n.data as Record<string, unknown>),
        parentTid: n.parentId && ids.has(n.parentId) ? idToTid.get(n.parentId) : undefined,
        w: n.type === "group" ? Number((n.style as Record<string, unknown> | undefined)?.width) || undefined : undefined,
        h: n.type === "group" ? Number((n.style as Record<string, unknown> | undefined)?.height) || undefined : undefined,
      }));
      const tedges: TemplateEdge[] = edges
        .filter((e) => ids.has(e.source) && ids.has(e.target))
        .map((e) => ({
          sourceTid: idToTid.get(e.source)!,
          targetTid: idToTid.get(e.target)!,
          sourceHandle: e.sourceHandle ?? undefined,
          targetHandle: e.targetHandle ?? undefined,
        }));
      const tpl: BoardTemplate = { id: uid(8), name, nodes: tnodes, edges: tedges, createdAt: Date.now() };
      set((s) => ({ templates: [tpl, ...s.templates] }));
      persist();
      return tpl.id;
    },

    remove: (id) => {
      set((s) => ({ templates: s.templates.filter((t) => t.id !== id) }));
      persist();
    },

    instantiate: (tpl, at) => {
      const tidToId = new Map<string, string>();
      for (const tn of tpl.nodes) tidToId.set(tn.tid, `n_${uid(8)}`);
      // 组节点必须排在成员之前（xyflow 要求 parent 先于 child）
      const ordered = [...tpl.nodes].sort((a, b) => Number(a.kind !== "group") - Number(b.kind !== "group"));
      const nodes: AppNode[] = ordered.map((tn) => ({
        id: tidToId.get(tn.tid)!,
        type: tn.kind,
        position: tn.parentTid ? { x: tn.x, y: tn.y } : { x: at.x + tn.x, y: at.y + tn.y },
        // 以最新 defaultData 打底，模板缺字段也能得到完整节点数据
        data: { ...defaultData(tn.kind), ...tn.data },
        parentId: tn.parentTid ? tidToId.get(tn.parentTid) : undefined,
        extent: tn.parentTid ? ("parent" as const) : undefined,
        style: tn.kind === "group" && tn.w && tn.h ? { width: tn.w, height: tn.h } : undefined,
        selected: true,
      }));
      const edges: Edge[] = tpl.edges
        .filter((te) => tidToId.has(te.sourceTid) && tidToId.has(te.targetTid))
        .map((te) => {
          const srcTn = tpl.nodes.find((x) => x.tid === te.sourceTid)!;
          const port =
            srcTn.kind === "group"
              ? te.sourceHandle === "out-image"
                ? ("image" as const)
                : ("text" as const)
              : outPortType(srcTn.kind, srcTn.data);
          return {
            id: `e_${uid(8)}`,
            source: tidToId.get(te.sourceTid)!,
            target: tidToId.get(te.targetTid)!,
            sourceHandle: te.sourceHandle,
            targetHandle: te.targetHandle,
            className: edgeClassFor(port),
            interactionWidth: 28,
          };
        });
      useBoard.getState().insertFragment(nodes, edges);
    },
  };
});
