/**
 * 带 @ 引用胶囊的提示词输入框 —
 * 未编辑时把文本里的 @图片名 渲染成「缩略图 + 图N」胶囊（对齐即梦/可灵的引用展示），
 * 点击进入编辑态回到普通 textarea（中文输入法安全）；图N 编号与实际传给模型的参考图顺序一致。
 */
import { useMemo, useRef, useState, type RefObject } from "react";
import { useBoard } from "../core/stores/boardStore";
import { orderedInEdges } from "../core/runner";
import { Thumb } from "./Thumb";

export type AtRef = { label: string; src: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 生成节点自己的上游参考图（与 runner.resolveAtRefs 同序），供提示词框渲染 @ 胶囊 */
export function useOwnUpstreamImageRefs(nodeId: string): AtRef[] {
  const nodes = useBoard((s) => s.nodes);
  const edges = useBoard((s) => s.edges);
  return useMemo(() => {
    const out: AtRef[] = [];
    const seen = new Set<string>();
    for (const e of orderedInEdges(nodeId, nodes, edges)) {
      if (e.targetHandle !== "in-image" || seen.has(e.source)) continue;
      const n = nodes.find((x) => x.id === e.source);
      if (!n) continue;
      const nd = n.data as Record<string, unknown>;
      const src =
        n.type === "image"
          ? (nd.src as string | undefined)
          : ((nd.results as string[] | undefined)?.[(nd.picked as number | undefined) ?? 0] ?? undefined);
      if (!src) continue;
      seen.add(e.source);
      const raw = n.type === "image" && nd.name ? String(nd.name).replace(/\.\w+$/, "") : "";
      out.push({ src, label: raw ? raw.slice(0, 12) : `图${out.length + 1}` });
    }
    return out;
  }, [nodes, edges, nodeId]);
}

/** 把文本按 @label 切段，命中的渲染成胶囊 */
function RichView({ value, refs }: { value: string; refs: AtRef[] }) {
  const parts = useMemo(() => {
    const labs = refs.map((r) => escapeRe(`@${r.label}`)).sort((a, b) => b.length - a.length);
    if (!labs.length) return [value];
    return value.split(new RegExp(`(${labs.join("|")})`, "g"));
  }, [value, refs]);
  return (
    <>
      {parts.map((p, i) => {
        const idx = refs.findIndex((r) => `@${r.label}` === p);
        if (idx < 0) return <span key={i}>{p}</span>;
        const r = refs[idx];
        return (
          <span key={i} className="at-pill" title={`引用参考图 @${r.label}（发给模型时写作「图${idx + 1}」）`}>
            <Thumb src={r.src} alt="" />图{idx + 1}
          </span>
        );
      })}
    </>
  );
}

export function AtTextArea({
  value,
  onChange,
  refs,
  placeholder,
  rows = 5,
  taRef,
}: {
  value: string;
  onChange: (v: string) => void;
  refs: AtRef[];
  placeholder?: string;
  rows?: number;
  /** 外部需要操作光标（如点击 @ 插入）时传入 */
  taRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const inner = useRef<HTMLTextAreaElement>(null);
  const ta = taRef ?? inner;
  const [editing, setEditing] = useState(false);
  const hasToken = refs.some((r) => value.includes(`@${r.label}`));

  // 没有 @ 引用时保持普通输入框；有引用且未在编辑 → 胶囊展示，点击进入编辑
  if (hasToken && !editing) {
    return (
      <div
        className="textarea at-view nodrag nowheel"
        style={{ minHeight: `${rows * 1.55 + 1.2}em` }}
        title="点击编辑（@ 引用以胶囊显示）"
        onClick={() => {
          setEditing(true);
          requestAnimationFrame(() => ta.current?.focus());
        }}
      >
        <RichView value={value} refs={refs} />
      </div>
    );
  }
  return (
    <textarea
      ref={ta}
      className="textarea nodrag nowheel"
      rows={rows}
      placeholder={placeholder}
      value={value}
      autoFocus={editing}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => setEditing(false)}
    />
  );
}
