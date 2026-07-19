/**
 * 生成记录坞 — 本次会话所有生成结果的时间线
 */
import { useReactFlow } from "@xyflow/react";
import { useUi, toast } from "../../core/stores/uiStore";
import { useSettings } from "../../core/stores/settingsStore";
import { saveImageAs, saveVideoAs } from "../../core/services/imageSaver";
import { errMsg } from "../../core/utils";
import { useAssets } from "../../core/stores/assetStore";
import { IcClose, IcDownload, IcFit, IcGallery, IcLibrary } from "../../ui/icons";
import { Thumb } from "../../ui/Thumb";
import { VideoThumb } from "../../ui/VideoThumb";

export function GalleryDock() {
  const open = useUi((s) => s.galleryOpen);
  const items = useUi((s) => s.gallery);
  const setOpen = useUi((s) => s.setGalleryOpen);
  const setLightbox = useUi((s) => s.setLightbox);
  const zen = useUi((s) => s.zen);
  const { fitView } = useReactFlow();

  if (!open || zen) return null;

  const save = async (item: (typeof items)[number]) => {
    try {
      const cfg = useSettings.getState().settings.save;
      const meta = { prompt: item.prompt, model: item.model };
      const p = item.kind === "video" ? await saveVideoAs(item.src, cfg, meta) : await saveImageAs(item.src, cfg, meta);
      if (p) toast(`已保存 → ${p}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  const locate = (nodeId?: string) => {
    if (!nodeId) return;
    void fitView({ nodes: [{ id: nodeId }], duration: 400, padding: 0.5, maxZoom: 1 });
  };

  return (
    <div className="gallery-dock glass">
      <div className="gd-head">
        <IcGallery size={18} />
        生成记录
        <span className="cnt">{items.length ? `${items.length} 条` : ""}</span>
        <button
          className="icon-btn"
          title="打开资产库（全部历史生成都在那里）"
          onClick={() => useAssets.getState().setOpen(true)}
        >
          <IcLibrary size={17} />
        </button>
        <button className="icon-btn" title="关闭" onClick={() => setOpen(false)}>
          <IcClose size={17} />
        </button>
      </div>
      <div className="gd-body">
        {items.length === 0 ? (
          <div className="gd-empty">
            还没有生成记录
            <br />
            画布上的每次生成都会汇集到这里
          </div>
        ) : (
          items.map((it) => (
            <div key={it.id} className="g-item" title={it.prompt} onClick={() => it.kind === "image" && setLightbox(it.src)}>
              {it.kind === "video" ? <VideoThumb src={it.src} /> : <Thumb src={it.src} alt="" />}
              {it.kind === "video" ? <span className="g-badge">视频</span> : null}
              <div className="g-acts" onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn" title="定位到节点" onClick={() => locate(it.nodeId)}>
                  <IcFit size={15} />
                </button>
                <button className="icon-btn" title="保存到本地" onClick={() => void save(it)}>
                  <IcDownload size={15} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
