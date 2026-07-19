import { memo, useRef } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortOut } from "../NodeShell";
import { IcDownload, IcImage, IcUpload } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { useSettings } from "../../../core/stores/settingsStore";
import { toast, useUi } from "../../../core/stores/uiStore";
import { fileToDataUrl, errMsg } from "../../../core/utils";
import { saveImageAs } from "../../../core/services/imageSaver";
import { Thumb } from "../../../ui/Thumb";
import type { ImageData } from "../../../core/types";

export const ImageNode = memo(function ImageNode({ id, data, selected }: NodeProps) {
  const d = data as ImageData;
  const upd = useBoard((s) => s.updateData);
  const setLightbox = useUi((s) => s.setLightbox);
  const fileRef = useRef<HTMLInputElement>(null);

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
      width={260}
      headExtra={
        d.src ? (
          <span className="acts nodrag" style={{ opacity: 1 }}>
            <button className="icon-btn" title="替换图片" onClick={() => fileRef.current?.click()}>
              <IcUpload size={17} />
            </button>
            <button className="icon-btn" title="保存到本地" onClick={save}>
              <IcDownload size={17} />
            </button>
          </span>
        ) : undefined
      }
    >
      <div className="mnode-body">
        {d.src ? (
          <Thumb className="img-main nodrag" src={d.src} alt={d.name} res onClick={() => setLightbox(d.src!)} />
        ) : (
          <div className="img-empty nodrag" onClick={() => fileRef.current?.click()}>
            <IcImage size={26} />
            <span>
              点击导入图片
              <br />
              也可直接拖入 / Ctrl+V 粘贴
            </span>
          </div>
        )}
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
    </NodeShell>
  );
});
