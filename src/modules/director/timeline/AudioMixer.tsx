/**
 * 音频混音器（方案 §11.3 / §12.3）— 成片工作区
 *
 * 每条音频轨的音量/静音/淡入淡出（渲染管线真实生效：volume/afade/alimiter 峰值保护）。
 * 对白/旁白可走 TTS 生成（generateAudioTrack），多版本采用其一。
 */
import { patchAudioTrack } from "../../../core/directorTimeline";
import { generateAudioTrack } from "../../../core/directorExport";
import { useDirector } from "../../../core/stores/directorStore";
import { errMsg } from "../../../core/utils";
import { toast } from "../../../core/stores/uiStore";
import { IcMusic, IcMic, IcLoading, IcPlay } from "../../../ui/icons";
import { useState } from "react";
import type { DirectorAudioKind, DirectorProject } from "../../../core/types";

const KIND_LABEL: Record<DirectorAudioKind, string> = {
  dialogue: "对白",
  narration: "旁白",
  sfx: "音效",
  ambient: "环境音",
  music: "音乐",
};

export function AudioMixer({ project }: { project: DirectorProject }) {
  const updateProject = useDirector((s) => s.updateProject);
  const [genBusy, setGenBusy] = useState<string | null>(null);
  const tracks = project.audioTracks ?? [];

  const genTts = async (trackId: string) => {
    setGenBusy(trackId);
    try {
      await generateAudioTrack(project.id, trackId);
      toast("音频已生成并落库", "ok");
    } catch (e) {
      toast(`TTS 失败：${errMsg(e)}`, "err");
    } finally {
      setGenBusy(null);
    }
  };

  return (
    <div className="ds-mixer">
      <div className="ds-card-title"><IcMusic size={14} /> 音频混音器</div>
      <div className="ds-hint">音量与淡化会真实混入导出的成片（默认峰值保护，不会爆音）</div>
      {!tracks.length ? (
        <div className="ds-hint">还没有音频轨——在下方「音频导演台」添加对白/旁白/音乐</div>
      ) : (
        <div className="ds-mixer-list">
          {tracks.map((t) => (
            <div key={t.id} className={`ds-mixer-row${t.muted ? " muted" : ""}`}>
              <span className="ds-mixer-kind">{KIND_LABEL[t.kind]}</span>
              <span className="ds-mixer-text" title={t.text}>{t.text.slice(0, 24) || "（空）"}</span>
              <label className="ds-mixer-vol" title="轨道音量（0~150%）">
                <input
                  className="nodrag"
                  type="range"
                  min={0}
                  max={1.5}
                  step={0.05}
                  value={t.muted ? 0 : (t.volume ?? 1)}
                  onChange={(e) => patchAudioTrack(project.id, t.id, { volume: Number(e.target.value), muted: Number(e.target.value) === 0 })}
                />
                <i>{Math.round((t.muted ? 0 : (t.volume ?? 1)) * 100)}%</i>
              </label>
              <label className="ds-mixer-fade" title="淡入/淡出秒数">
                <input
                  className="input sm nodrag"
                  type="number"
                  min={0}
                  step={0.1}
                  value={t.fadeIn ?? 0}
                  onChange={(e) => patchAudioTrack(project.id, t.id, { fadeIn: Math.max(0, Number(e.target.value) || 0) })}
                />
                <input
                  className="input sm nodrag"
                  type="number"
                  min={0}
                  step={0.1}
                  value={t.fadeOut ?? 0}
                  onChange={(e) => patchAudioTrack(project.id, t.id, { fadeOut: Math.max(0, Number(e.target.value) || 0) })}
                />
              </label>
              <button
                className={`btn sm${t.muted ? "" : " ghost"}`}
                title={t.muted ? "取消静音" : "静音这条轨"}
                onClick={() => patchAudioTrack(project.id, t.id, { muted: !t.muted })}
              >
                {t.muted ? "已静音" : "静音"}
              </button>
              {(t.kind === "dialogue" || t.kind === "narration") && !t.assetId ? (
                <button className="btn sm" disabled={genBusy === t.id} title="用 TTS 生成这条对白/旁白" onClick={() => void genTts(t.id)}>
                  {genBusy === t.id ? <IcLoading size={12} /> : <IcMic size={12} />} 生成
                </button>
              ) : t.assetId ? (
                <span className="ds-badge ok" title="已有音频资产"><IcPlay size={10} /> 就绪</span>
              ) : null}
              <button
                className="icon-btn danger"
                title="删除这条音频轨"
                onClick={() => updateProject(project.id, { audioTracks: tracks.filter((x) => x.id !== t.id) })}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
