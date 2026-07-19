/**
 * 视频源节点 — 与图片节点对等的本地视频载体：
 * 导入/拖入的视频先落进资产库（磁盘文件），节点存 asset: URL，重启依然有效；
 * 下游可接取帧/取段/拼接/生成视频（参考视频）/ComfyUI。
 */
import { memo, useRef } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortOut } from "../NodeShell";
import { IcDownload, IcUpload, IcVideo } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { useSettings } from "../../../core/stores/settingsStore";
import { toast } from "../../../core/stores/uiStore";
import { useAssets } from "../../../core/stores/assetStore";
import { assetUrl } from "../../../core/services/assetFiles";
import { saveVideoAs } from "../../../core/services/imageSaver";
import { videoDuration } from "../../../core/videoEdit";
import { errMsg } from "../../../core/utils";
import { VideoThumb } from "../../../ui/VideoThumb";
import type { VideoData } from "../../../core/types";

/** 导入视频文件：进资产库拿到持久路径 → 返回可播放 URL 与时长 */
export async function importVideoFile(f: File): Promise<{ src: string; dur: number }> {
  const item = await useAssets.getState().importFileGetItem(f);
  if (!item) throw new Error("视频导入失败：无法写入资产库");
  const src = assetUrl(item.path);
  return { src, dur: await videoDuration(src) };
}

export const VideoNode = memo(function VideoNode({ id, data, selected }: NodeProps) {
  const d = data as VideoData;
  const upd = useBoard((s) => s.updateData);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (f?: File | null) => {
    if (!f) return;
    upd(id, { status: "running", error: undefined });
    try {
      const { src, dur } = await importVideoFile(f);
      upd(id, { src, dur, name: f.name, status: "done" });
    } catch (e) {
      upd(id, { status: "error", error: errMsg(e) });
    }
  };

  const save = async () => {
    if (!d.src) return;
    try {
      const p = await saveVideoAs(d.src, useSettings.getState().settings.save, { prompt: d.name });
      if (p) toast(`已保存 → ${p}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  return (
    <NodeShell
      id={id}
      title={d.name || "视频"}
      icon={<IcVideo size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={260}
      headExtra={
        d.src ? (
          <span className="acts nodrag" style={{ opacity: 1 }}>
            <button className="icon-btn" title="替换视频" onClick={() => fileRef.current?.click()}>
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
          <VideoThumb className="img-main nodrag" src={d.src} />
        ) : (
          <div className="img-empty nodrag" onClick={() => fileRef.current?.click()}>
            <IcVideo size={26} />
            <span>
              点击导入视频
              <br />
              也可直接把视频文件拖入画布
            </span>
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="video/*,.mp4,.webm,.mov,.mkv,.m4v"
          hidden
          onChange={(e) => {
            void onFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      <PortOut kind="video" />
    </NodeShell>
  );
});
