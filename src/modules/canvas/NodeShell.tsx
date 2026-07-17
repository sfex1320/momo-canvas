/**
 * 节点外壳：统一卡片、头部操作、端口、上游传入提示
 */
import { useMemo, type ReactNode } from "react";
import { Handle, Position } from "@xyflow/react";
import { NODE_INPUTS, useBoard } from "../../core/stores/boardStore";
import { useUi } from "../../core/stores/uiStore";
import { collectUpstream } from "../../core/runner";
import { IcCopy, IcEyeOff, IcTrash } from "../../ui/icons";
import type { NodeKind, RunStatus } from "../../core/types";

/** 上游传入提示：几张图（圆角缩略图）/ 几段文本 */
function UpstreamBadge({ id }: { id: string }) {
  const nodes = useBoard((s) => s.nodes);
  const edges = useBoard((s) => s.edges);
  const { texts, images } = useMemo(() => collectUpstream(id), [nodes, edges, id]);
  if (!texts.length && !images.length) return null;
  return (
    <div className="up-badge nodrag" title="上游已传入的内容（运行时自动使用）">
      {images.slice(0, 4).map((s, i) => (
        <img key={i} src={s} alt="" />
      ))}
      {images.length > 4 ? <span className="ub-more">+{images.length - 4}</span> : null}
      {images.length ? <span className="ub-txt">{images.length} 张图传入</span> : null}
      {texts.length ? <span className="ub-txt">{texts.length} 段文本传入</span> : null}
    </div>
  );
}

export function NodeShell({
  id,
  title,
  icon,
  status,
  error,
  selected,
  width,
  headExtra,
  children,
}: {
  id: string;
  title: string;
  icon: ReactNode;
  status: RunStatus;
  error?: string;
  selected?: boolean;
  width: number;
  headExtra?: ReactNode;
  children: ReactNode;
}) {
  const duplicateNode = useBoard((s) => s.duplicateNode);
  const removeNode = useBoard((s) => s.removeNode);
  const updateData = useBoard((s) => s.updateData);
  const ignored = useBoard(
    (s) => !!((s.nodes.find((n) => n.id === id)?.data as Record<string, unknown> | undefined)?.ignored),
  );
  const kind = useBoard((s) => s.nodes.find((n) => n.id === id)?.type as NodeKind | undefined);
  const hinted = useUi((s) => (s.proxHint ? s.proxHint.includes(id) : false));
  const ghost = useUi((s) => (s.dupGhost ? s.dupGhost.includes(id) : false));
  const hasInputs = kind ? Object.keys(NODE_INPUTS[kind] ?? {}).length > 0 : false;
  return (
    <div
      className={`mnode ${status} ${selected ? "sel" : ""} ${hinted ? "prox" : ""} ${ignored ? "ign" : ""} ${ghost ? "ghost" : ""}`}
      style={{ width }}
    >
      <div className="mnode-head">
        <span className="kind-ic">{icon}</span>
        <span className="title">{title}</span>
        {headExtra}
        <span className="acts nodrag">
          <button
            className={`icon-btn ${ignored ? "on-warn" : ""}`}
            title={ignored ? "恢复此节点（重新向下游传递）" : "忽略此节点（半透明，不向下游传递）"}
            onClick={() => updateData(id, { ignored: !ignored })}
          >
            <IcEyeOff size={16} />
          </button>
          <button className="icon-btn" title="创建副本 (Ctrl+D)" onClick={() => duplicateNode(id)}>
            <IcCopy size={17} />
          </button>
          <button className="icon-btn danger" title="删除 (Del)" onClick={() => removeNode(id)}>
            <IcTrash size={17} />
          </button>
        </span>
      </div>
      {hasInputs ? <UpstreamBadge id={id} /> : null}
      {children}
      {status === "error" && error ? <div className="mnode-err nodrag nowheel">{error}</div> : null}
    </div>
  );
}

/** 文本输入端口（左上，紫色）；data-lab 会在悬停节点时显示为小标签 */
export const PortTextIn = () => (
  <Handle type="target" position={Position.Left} id="in-text" data-lab="文本入" title="文本输入 · 接提示词/对话等" className="port port-text" style={{ top: 26 }} />
);

/** 图片输入端口（左下一格，蓝色） */
export const PortImageIn = ({ top = 58 }: { top?: number }) => (
  <Handle type="target" position={Position.Left} id="in-image" data-lab="图片入" title="图片输入 · 接图片/生成图像等" className="port port-image" style={{ top }} />
);

/** 输出端口（右中） */
export const PortOut = ({ kind }: { kind: "text" | "image" }) => (
  <Handle type="source" position={Position.Right} id="out" data-lab={kind === "text" ? "文本出" : "图片出"} title={kind === "text" ? "文本输出" : "图片输出"} className={`port port-${kind}`} />
);
