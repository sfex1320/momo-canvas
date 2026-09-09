/**
 * 组（主节点）：虚线框容器，拖动组时成员跟随；
 * 右侧统一出口把成员输出按位置顺序聚合给下游（端口统一后，按成员各自输出类型分流：文本/图片/视频/音频）
 * 头部可把整组（含内部连线）存为画布模板，Spotlight / 双击菜单可反复实例化；
 * 图层组（元素工坊拆解产物）额外提供「合成图层」：按成员顺序叠加成一张图。
 * 分镜组（frameless）：平时只见贴片，悬停显示组框与工具条——重排(每行N格)/拼接/序号/转普通组/解组。
 */
import "../designTools.css";
import { memo, useEffect, useMemo, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useBoard } from "../../../core/stores/boardStore";
import { useTemplates } from "../../../core/stores/templateStore";
import { toast } from "../../../core/stores/uiStore";
import { composeLayerGroup } from "../../../core/elementSplit";
import { reflowStoryboardGroup, stitchStoryboardGroup, storyboardToNormalGroup } from "../../../core/nodeEdit";
import { PopSelect } from "../../../ui/PopSelect";
import { IcCheck, IcGrid, IcGroup, IcImage, IcLayers, IcTag, IcTrash, IcWand } from "../../../ui/icons";
import type { GroupData } from "../../../core/types";

export const GroupNode = memo(function GroupNode({ id, selected }: NodeProps) {
  // 订阅整个 nodes 原数组（引用稳定），成员在 useMemo 里派生——避免 selector 返回新引用（zustand v5 禁忌）
  const nodes = useBoard((s) => s.nodes);
  const fit = useBoard((s) => s.fitGroupToMembers);
  const members = useMemo(() => nodes.filter((n) => n.parentId === id), [nodes, id]);
  const count = members.length;
  // 组框自适应成员（只扩不缩）：成员被拖动/尺寸变化（measured 更新）后自动扩组框，解决「元素过大被固定区域关住」
  useEffect(() => {
    fit(id);
  }, [members, fit, id]);
  const removeNode = useBoard((s) => s.removeNode);
  const updateData = useBoard((s) => s.updateData);
  const gdata = useBoard((s) => s.nodes.find((n) => n.id === id)?.data as GroupData | undefined);
  const artboard = gdata?.artboard;
  const layerGroup = gdata?.layerGroup ?? false;
  const frameless = gdata?.frameless ?? false;
  const showOrder = gdata?.showOrder ?? false;
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const save = () => {
    const s = useBoard.getState();
    const group = s.nodes.find((n) => n.id === id);
    const members = s.nodes.filter((n) => n.parentId === id);
    if (!group || !members.length) {
      toast("组里还没有节点", "err");
      return;
    }
    const finalName = name.trim() || `组模板 · ${members.length} 节点`;
    useTemplates.getState().saveFrom(finalName, [group, ...members], s.edges);
    setNaming(false);
    setName("");
    toast(`已存为画布模板「${finalName}」：Ctrl+K 或双击画布即可插入`, "ok");
  };

  return (
    <div className={`group-node ${selected ? "sel" : ""} ${frameless ? "frameless" : ""}`}>
      {artboard && <div className="artboard-paper" style={{height:720*artboard.heightMm/artboard.widthMm,background:artboard.background}}><div className="artboard-safe" style={{inset:720*artboard.safeMm/artboard.widthMm}} /></div>}
      <div className="gn-head">
        <IcGroup size={15} />
        <span>{artboard ? `画板 · ${artboard.widthMm}×${artboard.heightMm}mm` : frameless ? `分镜组 · ${count} 格` : layerGroup ? `图层组 · ${count} 层` : `组 · ${count} 个节点`}</span>
        {frameless ? (
          <>
            <PopSelect
              title="每行格数（按分镜顺序严格网格重排）"
              value={String(gdata?.storyCols ?? 3)}
              options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `每行 ${n} 格`, icon: <IcGrid size={14} /> }))}
              onChange={(v) => reflowStoryboardGroup(id, Number(v))}
              className="gn-pop nodrag"
            />
            <button
              className="icon-btn nodrag"
              title="按分镜顺序把全部切片拼成一张长边 2K 的网格整图（生成新图片节点）"
              aria-label="拼接切片"
              onClick={() => void stitchStoryboardGroup(id)}
            >
              <IcImage size={15} />
            </button>
            <button
              className={`icon-btn nodrag ${showOrder ? "on" : ""}`}
              title={showOrder ? "隐藏分镜顺序角标" : "在切片上显示分镜顺序角标"}
              aria-label="序号"
              onClick={() => updateData(id, { showOrder: !showOrder })}
            >
              <IcTag size={15} />
            </button>
            <button
              className="icon-btn nodrag"
              title="转为普通组：恢复组框与瀑布流自动排布"
              aria-label="转普通组"
              onClick={() => storyboardToNormalGroup(id)}
            >
              <IcWand size={15} />
            </button>
          </>
        ) : null}
        {layerGroup && !frameless && !artboard ? (
          <><PopSelect title="合成与 PSD 输出倍率（受最长边 8192 与总像素 2400 万限制；细节取决于素材）" value={String(gdata?.layerOutputScale ?? 1)} options={[1, 2, 4].map(v => ({ value: String(v), label: v === 1 ? "原尺寸" : `${v} 倍`, icon: <IcImage size={14} /> }))} onChange={v => updateData(id, { layerOutputScale: Number(v) as 1 | 2 | 4 })} className="gn-pop nodrag" />
          <button
            className="icon-btn nodrag"
            title="按元素原图位置与所选倍率合成海报；移动节点卡片不改变海报排版"
            aria-label="合成图层"
            onClick={() => void composeLayerGroup(id)}
          >
            <IcImage size={15} />
          </button></>
        ) : null}
        {naming ? (
          <span className="gn-name nodrag">
            <input
              className="input"
              autoFocus
              placeholder="模板名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") setNaming(false);
              }}
            />
            <button className="icon-btn" title="保存模板" aria-label="保存模板" onClick={save}>
              <IcCheck size={15} />
            </button>
          </span>
        ) : (
          <button
            className="icon-btn nodrag"
            title="把整组（节点配置 + 内部连线）存为画布模板，之后 Ctrl+K / 双击画布可反复插入"
            aria-label="把整组存为画布模板"
            onClick={() => setNaming(true)}
          >
            <IcLayers size={15} />
          </button>
        )}
        <button
          className="icon-btn danger nodrag"
          title={frameless ? "解组（切片保留在画布上）" : "解散组（成员保留在画布上）"}
          aria-label="解散组（成员保留在画布上）"
          onClick={() => removeNode(id)}
        >
          <IcTrash size={15} />
        </button>
      </div>
      <Handle type="source" position={Position.Right} id="out" data-lab="组出（成员按序聚合）" title="成员按位置顺序聚合输出（文本/图片/视频/音频按各自类型分流给下游）" className="port" />
    </div>
  );
});
