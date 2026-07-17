/**
 * 节点外壳：统一卡片、头部操作、端口
 */
import type { ReactNode } from "react";
import { Handle, Position } from "@xyflow/react";
import { useBoard } from "../../core/stores/boardStore";
import { useUi } from "../../core/stores/uiStore";
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
  const hinted = useUi((s) => (s.proxHint ? s.proxHint.includes(id) : false));
  return (
    <div className={`mnode ${status} ${selected ? "sel" : ""} ${hinted ? "prox" : ""}`} style={{ width }}>
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

/** 文本输入端口（左上，紫色） */
export const PortTextIn = () => (
  <Handle type="target" position={Position.Left} id="in-text" title="文本输入 · 接提示词/对话等" className="port port-text" style={{ top: 26 }} />
);

/** 图片输入端口（左下一格，蓝色） */
export const PortImageIn = ({ top = 58 }: { top?: number }) => (
  <Handle type="target" position={Position.Left} id="in-image" title="图片输入 · 接图片/生成图像等" className="port port-image" style={{ top }} />
);

/** 输出端口（右中） */
export const PortOut = ({ kind }: { kind: "text" | "image" }) => (
  <Handle type="source" position={Position.Right} id="out" title={kind === "text" ? "文本输出" : "图片输出"} className={`port port-${kind}`} />
);
