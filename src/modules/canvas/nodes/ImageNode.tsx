import { memo, useRef } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortIn, PortOut } from "../NodeShell";
import { mediaNodeWidth } from "../../../core/imageInfo";
import { EditSurface } from "../EditSurface";
import { IcDownload, IcImage, IcScan, IcUpload } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { useSettings } from "../../../core/stores/settingsStore";
import { toast, useUi } from "../../../core/stores/uiStore";
import { fileToDataUrl, errMsg } from "../../../core/utils";
import { saveImageAs } from "../../../core/services/imageSaver";
import { useImageDims } from "../../../core/imageInfo";
import { Thumb } from "../../../ui/Thumb";
import type { ImageData } from "../../../core/types";

export const ImageNode = memo(function ImageNode({ id, data, selected }: NodeProps) {
  const d = data as ImageData;
  const upd = useBoard((s) => s.updateData);
  const setLightbox = useUi((s) => s.setLightbox);
  const fileRef = useRef<HTMLInputElement>(null);
  // 宽度随图片比例自适应（竖图窄、横图宽）
  const dims = useImageDims(d.src);
  // 分镜组切片：从所属组读「序号开关 + 本片在点击序中的位次」（原始值订阅，避免新引用）
  const storyIdx = useBoard((s) => {
    if (!d.storyTile) return -1;
    const me = s.nodes.find((n) => n.id === id);
    const g = me?.parentId ? s.nodes.find((n) => n.id === me.parentId) : undefined;
    const order = (g?.data as { storyOrder?: string[] } | undefined)?.storyOrder;
    return order ? order.indexOf(id) : -1;
  });
  const showOrder = useBoard((s) => {
    if (!d.storyTile) return false;
    const me = s.nodes.find((n) => n.id === id);
    const g = me?.parentId ? s.nodes.find((n) => n.id === me.parentId) : undefined;
    return !!(g?.data as { showOrder?: boolean } | undefined)?.showOrder;
  });

  const onFile = async (f?: File | null) => {
    if (!f) return;
    const src = await fileToDataUrl(f);
    upd(id, { src, name: f.name, status: "done" });
  };

  const save = async () => {
    if (!d.src) return;
    try {
      const p = await saveImageAs(d.src, useSettings.getState().settings.save, { prompt: d.name });
      if (p) toast(`已保存 → ${p}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  return (
    <NodeShell
      id={id}
      title={d.name || "图片"}
      icon={<IcImage size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={d.storyTile && d.tileSize ? d.tileSize.w : mediaNodeWidth(dims, 320)}
      media
      hideHead={!!d.storyTile}
      headExtra={
        d.src ? (
          <>
            <button className="nt-btn" title="放大预览" onClick={() => setLightbox(d.src!)}>
              <IcScan size={14} /> 放大
            </button>
            <button className="nt-btn" title="替换图片" onClick={() => fileRef.current?.click()}>
              <IcUpload size={14} /> 替换
            </button>
            <button className="nt-btn" title="保存到本地" onClick={save}>
              <IcDownload size={14} /> 保存
            </button>
          </>
        ) : undefined
      }
    >
      <div className="mnode-body">
        {d.src ? (
          <EditSurface id={id} src={d.src}>
            <Thumb className="img-main" src={d.src} alt={d.name} res={!d.storyTile} style={d.storyTile && d.tileSize ? { height: d.tileSize.h, objectFit: "fill" } : undefined} onClick={() => setLightbox(d.src!)} />
          </EditSurface>
        ) : (
          <div
            className="img-empty"
            role="button"
            tabIndex={0}
            // 不加 nodrag：空态占满节点体，加了会导致节点无处下手拖动；点击不位移时 onClick 照常触发
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                fileRef.current?.click();
              }
            }}
          >
            <IcImage size={26} />
            <span>
              点击导入图片
              <br />
              也可直接拖入 / Ctrl+V 粘贴
            </span>
          </div>
        )}
        {d.storyTile && showOrder && storyIdx >= 0 ? <i className="tile-order">{storyIdx + 1}</i> : null}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            void onFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      <PortOut kind="image" />
      {/* 分镜组切片：输入口只作原图溯源连线展示（点击「传入」不显示——NODE_INPUTS.image 为空） */}
      {d.storyTile ? <PortIn /> : null}
    </NodeShell>
  );
});
