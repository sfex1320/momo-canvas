/**
 * 聚焦裁剪节点 — 框选上游图片局部输出（纯本地裁剪，不调模型）
 * 用途：给下游生成节点传更精准的参考（LibTV「聚焦」/ 可灵「框选主体」同款思路）
 */
import { memo, useMemo, useState } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortImageIn, PortOut } from "../NodeShell";
import { IcCrop, IcLoading } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { toast, useUi } from "../../../core/stores/uiStore";
import { collectUpstream, runFlow } from "../../../core/runner";
import { RegionPicker } from "../RegionPicker";
import { Thumb } from "../../../ui/Thumb";
import type { CropData } from "../../../core/types";

export const CropNode = memo(function CropNode({ id, data, selected }: NodeProps) {
  const d = data as CropData;
  const upd = useBoard((s) => s.updateData);
  const setLightbox = useUi((s) => s.setLightbox);
  const nodes = useBoard((s) => s.nodes);
  const edges = useBoard((s) => s.edges);
  const up = useMemo(() => collectUpstream(id), [nodes, edges, id]);
  const upImage = up.images[0];
  const [picking, setPicking] = useState(false);
  const running = d.status === "running";

  const openPicker = () => {
    if (!upImage) {
      toast("请先连接一个上游图片节点", "err");
      return;
    }
    setPicking(true);
  };

  return (
    <NodeShell id={id} title="聚焦裁剪" icon={<IcCrop size={17} />} status={d.status} error={d.error} selected={selected} width={280}>
      <div className="mnode-body">
        <button className={`btn nodrag ${d.rect ? "" : "primary"}`} onClick={openPicker}>
          <IcCrop size={16} />
          {d.rect ? "重新框选区域" : "框选区域"}
        </button>
        <button className="btn primary nodrag" disabled={running || !d.rect} style={{ opacity: d.rect ? 1 : 0.5 }} onClick={() => void runFlow(id)}>
          {running ? <IcLoading size={17} /> : <IcCrop size={17} />}
          {running ? "裁剪中…" : "输出聚焦区域"}
        </button>
        {d.result ? <Thumb className="img-main nodrag" src={d.result} alt="" res onClick={() => setLightbox(d.result!)} /> : null}
      </div>
      {picking && upImage ? (
        <RegionPicker
          src={upImage}
          initial={d.rect}
          onSave={(rect) => {
            upd(id, { rect });
            // 框选即时生效：本地裁剪很快，直接跑一遍
            setTimeout(() => void runFlow(id), 60);
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
      <PortImageIn top={26} />
      <PortOut kind="image" />
    </NodeShell>
  );
});
