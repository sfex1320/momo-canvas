/**
 * 组（主节点）：虚线框容器，拖动组时成员跟随；
 * 右侧两个出口把成员输出按位置顺序聚合给下游（文本 / 图片）
 */
import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useBoard } from "../../../core/stores/boardStore";
import { useUi } from "../../../core/stores/uiStore";
import { IcGroup, IcTrash } from "../../../ui/icons";

export const GroupNode = memo(function GroupNode({ id, selected }: NodeProps) {
  const count = useBoard((s) => s.nodes.filter((n) => n.parentId === id).length);
  const removeNode = useBoard((s) => s.removeNode);
  const ghost = useUi((s) => (s.dupGhost ? s.dupGhost.includes(id) : false));
  return (
    <div className={`group-node ${selected ? "sel" : ""} ${ghost ? "ghost" : ""}`}>
      <div className="gn-head">
        <IcGroup size={15} />
        <span>组 · {count} 个节点</span>
        <button
          className="icon-btn danger nodrag"
          title="解散组（成员保留在画布上）"
          onClick={() => removeNode(id)}
        >
          <IcTrash size={15} />
        </button>
      </div>
      <Handle type="source" position={Position.Right} id="out-text" data-lab="文本出（按序组合）" title="成员文本按位置顺序组合输出" className="port port-text" style={{ top: 26 }} />
      <Handle type="source" position={Position.Right} id="out-image" data-lab="图片出（按序传入）" title="成员图片按位置顺序依次输出" className="port port-image" style={{ top: 58 }} />
    </div>
  );
});
