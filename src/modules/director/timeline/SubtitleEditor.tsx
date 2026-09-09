/**
 * 字幕编辑器（方案 §11.3 / §12.2）— 成片工作区
 *
 * 字幕文本与时间调整；导出 SRT 或烧录进 MP4（渲染管线 subtitles filter）。
 * 「从对白生成」按音频轨对白/旁白自动铺底（时间对齐片段起点）。
 */
import { useMemo } from "react";
import { addSubtitle, patchSubtitle, removeSubtitle } from "../../../core/directorTimeline";
import { buildPostTimeline } from "../../../core/directorTimeline";
import { IcText, IcPlus, IcClose } from "../../../ui/icons";
import type { DirectorProject } from "../../../core/types";

export function SubtitleEditor({ project }: { project: DirectorProject }) {
  const view = useMemo(() => buildPostTimeline(project), [project]);
  const subs = view.subtitles;

  const fromDialogue = () => {
    let n = 0;
    for (const a of view.audio) {
      if (a.track.kind !== "dialogue" && a.track.kind !== "narration") continue;
      if (!a.track.text.trim()) continue;
      if (subs.some((s) => s.text === a.track.text)) continue;
      const dur = Math.max(1.5, Math.min(a.durSec, a.track.text.length / 5));
      addSubtitle(project.id, a.startSec, Math.min(a.startSec + dur, view.totalSec), a.track.text);
      n++;
    }
    return n;
  };

  return (
    <div className="ds-subed">
      <div className="ds-card-title"><IcText size={14} /> 字幕（{subs.length} 条）</div>
      <div className="ds-hint">字幕既可导出 SRT，也会在「导出 MP4」时烧录进画面</div>
      <div className="ds-subed-tools">
        <button className="btn sm" onClick={() => addSubtitle(project.id, 0, 2, "新字幕")} disabled={view.clips.length === 0}>
          <IcPlus size={12} /> 添加字幕
        </button>
        <button
          className="btn sm ghost"
          title="按音频轨的对白/旁白自动生成字幕（时间对齐片段）"
          onClick={() => {
            const n = fromDialogue();
            if (n) import("../../../core/stores/uiStore").then(({ toast }) => toast(`已从对白生成 ${n} 条字幕`, "ok"));
          }}
        >
          从对白生成
        </button>
      </div>
      <div className="ds-subed-list">
        {subs.map((s) => (
          <div key={s.id} className="ds-subed-row">
            <input
              className="input sm nodrag ds-subed-t"
              type="number"
              min={0}
              step={0.1}
              title="开始（秒）"
              value={s.startSec}
              onChange={(e) => patchSubtitle(project.id, s.id, { startSec: Math.max(0, Number(e.target.value) || 0) })}
            />
            <span className="ds-hint">→</span>
            <input
              className="input sm nodrag ds-subed-t"
              type="number"
              min={0}
              step={0.1}
              title="结束（秒）"
              value={s.endSec}
              onChange={(e) => patchSubtitle(project.id, s.id, { endSec: Math.max(0.2, Number(e.target.value) || 1) })}
            />
            <input
              className="input nodrag ds-subed-text"
              value={s.text}
              onChange={(e) => patchSubtitle(project.id, s.id, { text: e.target.value })}
            />
            <button className="icon-btn danger" title="删除这条字幕" onClick={() => removeSubtitle(project.id, s.id)}>
              <IcClose size={12} />
            </button>
          </div>
        ))}
        {!subs.length ? <div className="ds-hint">还没有字幕——点「从对白生成」一键铺底</div> : null}
      </div>
    </div>
  );
}
