/**
 * 音频源节点 — 本地音频文件载体（配乐/配音/参考音频）：
 * 导入的文件先落进资产库（磁盘文件），节点存 asset: URL，重启依然有效；
 * 下游可接视频配音（橙色口）或生成视频的参考音频。
 */
import { memo, useRef } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortOut } from "../NodeShell";
import { IcDownload, IcMusic, IcUpload } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { useSettings } from "../../../core/stores/settingsStore";
import { toast } from "../../../core/stores/uiStore";
import { useAssets } from "../../../core/stores/assetStore";
import { assetUrl } from "../../../core/services/assetFiles";
import { saveAudioAs } from "../../../core/services/imageSaver";
import { errMsg } from "../../../core/utils";
import type { AudioData } from "../../../core/types";

/** 导入音频文件：进资产库拿到持久路径 → 返回可播放 URL */
export async function importAudioFile(f: File): Promise<{ src: string }> {
  const item = await useAssets.getState().importFileGetItem(f);
  if (!item) throw new Error("音频导入失败：无法写入资产库");
  return { src: assetUrl(item.path) };
}

export const AudioNode = memo(function AudioNode({ id, data, selected }: NodeProps) {
  const d = data as AudioData;
  const upd = useBoard((s) => s.updateData);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (f?: File | null) => {
    if (!f) return;
    upd(id, { status: "running", error: undefined });
    try {
      const { src } = await importAudioFile(f);
      upd(id, { src, name: f.name, status: "done" });
    } catch (e) {
      upd(id, { status: "error", error: errMsg(e) });
    }
  };

  const save = async () => {
    if (!d.src) return;
    try {
      const p = await saveAudioAs(d.src, useSettings.getState().settings.save, { prompt: d.name });
      if (p) toast(`已保存 → ${p}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  return (
    <NodeShell
      id={id}
      title={d.name || "音频"}
      icon={<IcMusic size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={260}
      headExtra={
        d.src ? (
          <span className="acts nodrag" style={{ opacity: 1 }}>
            <button className="icon-btn" title="替换音频" onClick={() => fileRef.current?.click()}>
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
          <audio className="audio-main nodrag" src={d.src} controls preload="none" />
        ) : (
          <div className="img-empty nodrag" onClick={() => fileRef.current?.click()}>
            <IcMusic size={26} />
            <span>
              点击导入音频
              <br />
              mp3 / wav / m4a / ogg…
            </span>
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac"
          hidden
          onChange={(e) => {
            void onFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      <PortOut kind="audio" />
    </NodeShell>
  );
});
