/**
 * 节点外壳：统一卡片、头部操作、端口
 */
import type { ReactNode } from "react";
import { Handle, Position } from "@xyflow/react";
import { useBoard } from "../../core/stores/boardStore";
import { IcCopy, IcTrash } from "../../ui/icons";
import type { RunStatus } from "../../core/types";

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
  return (
    <div className={`mnode ${status} ${selected ? "sel" : ""}`} style={{ width }}>
      <div className="mnode-head">
        <span className="kind-ic">{icon}</span>
        <span className="title">{title}</span>
        {headExtra}
        <span className="acts nodrag">
          <button className="icon-btn" title="创建副本 (Ctrl+D)" onClick={() => duplicateNode(id)}>
            <IcCopy size={17} />
          </button>
          <button className="icon-btn danger" title="删除 (Del)" onClick={() => removeNode(id)}>
            <IcTrash size={17} />
          </button>
        </span>
      </div>
      {children}
      {status === "error" && error ? <div className="mnode-err nodrag nowheel">{error}</div> : null}
    </div>
  );
}

/** 文本输入端口（左上） */
export const PortTextIn = () => (
  <Handle type="target" position={Position.Left} id="in-text" className="port port-text" style={{ top: 26 }} />
);

/** 图片输入端口（左下一格） */
export const PortImageIn = ({ top = 58 }: { top?: number }) => (
  <Handle type="target" position={Position.Left} id="in-image" className="port port-image" style={{ top }} />
);

/** 输出端口（右中） */
export const PortOut = ({ kind }: { kind: "text" | "image" }) => (
  <Handle type="source" position={Position.Right} id="out" className={`port port-${kind}`} />
);
