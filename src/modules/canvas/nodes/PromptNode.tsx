import { memo, useMemo, useRef } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortOut } from "../NodeShell";
import { IcLoading, IcSparkles, IcText } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { optimizePrompt } from "../../../core/runner";
import type { PromptData } from "../../../core/types";

/** 与本提示词共同接入同一个下游生成节点的上游图片（供 @ 引用） */
function useSiblingImages(id: string) {
  const nodes = useBoard((s) => s.nodes);
  const edges = useBoard((s) => s.edges);
  return useMemo(() => {
    const targets = edges.filter((e) => e.source === id).map((e) => e.target);
    const out: { src: string; label: string }[] = [];
    const seen = new Set<string>();
    for (const t of targets) {
      for (const e of edges) {
        if (e.target !== t || e.targetHandle !== "in-image" || seen.has(e.source)) continue;
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
    }
    return out;
  }, [nodes, edges, id]);
}

export const PromptNode = memo(function PromptNode({ id, data, selected }: NodeProps) {
  const d = data as PromptData;
  const upd = useBoard((s) => s.updateData);
  const images = useSiblingImages(id);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const insertAt = (label: string) => {
    const token = `@${label} `;
    const ta = taRef.current;
    if (!ta) {
      upd(id, { text: `${d.text}${d.text && !d.text.endsWith(" ") ? " " : ""}${token}` });
      return;
    }
    const start = ta.selectionStart ?? d.text.length;
    const end = ta.selectionEnd ?? start;
    upd(id, { text: d.text.slice(0, start) + token + d.text.slice(end) });
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <NodeShell
      id={id}
      title="提示词"
      icon={<IcText size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={290}
    >
      <div className="mnode-body">
        {images.length ? (
          <div className="ref-strip nodrag">
            <span className="rs-lab">同路参考图 · 点击 @ 到提示词</span>
            <div className="rs-chips">
              {images.map((im) => (
                <button key={im.label} className="img-chip" title={`插入 @${im.label}（如：@${im.label} 把背景换成夜景）`} onClick={() => insertAt(im.label)}>
                  <img src={im.src} alt="" />
                  <span>@{im.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <textarea
          ref={taRef}
          className="textarea nodrag nowheel"
          rows={5}
          placeholder="描述你想要的画面…"
          value={d.text}
          onChange={(e) => upd(id, { text: e.target.value })}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 12.5, color: "var(--text-3)" }}>{d.text.length} 字</span>
          <button className="btn sm nodrag" disabled={!!d.optimizing} onClick={() => void optimizePrompt(id)}>
            {d.optimizing ? <IcLoading size={15} /> : <IcSparkles size={15} />}
            AI 扩写优化
          </button>
        </div>
      </div>
      <PortOut kind="text" />
    </NodeShell>
  );
});
