/**
 * 轻量时间线（方案 §11.2 / §11.3）— 成片工作区的轨道视图
 *
 * 轨道：V1 采用视频片段 / T1 标题卡·黑场·图片卡 / D1 对白 / N1 旁白 / S1 音效 / A1 环境音 / M1 音乐 / SUB 字幕
 * 首版编辑能力（§11.3）：片段点击选中 + 参数浮层（入出点/硬切/交叉淡化/原声音量/淡化）、
 * 标题卡增删、字幕时间调整（SubtitleEditor 承担文本编辑）、画幅适配。
 * 拖动排序的无障碍替代入口在 Sequence Dock 右键（上移/下移），这里不重复实现。
 */
import { useMemo, useRef, useState } from "react";
import { useDirectorCtx } from "../../../core/directorContext";
import { buildPostTimeline, patchClipOverride, addTitleCard, removeTitleCard, setTimelineFit } from "../../../core/directorTimeline";
import { useDirector } from "../../../core/stores/directorStore";
import { PopLayer, PopSelect } from "../../../ui/PopSelect";
import { IcFilmFrame, IcText, IcMusic, IcPlus, IcClose, IcClapper } from "../../../ui/icons";
import type { DirectorProject, PostTitleCard } from "../../../core/types";

const SEC_PX = 14;
/** 轨道标签列宽：片段/刻度统一右移让位，避免 0 秒附近的块压进吸左标签底下 */
const GUTTER = 92;
const TRACK_LABEL: Array<{ key: string; label: string }> = [
  { key: "v1", label: "V1 成片" },
  { key: "t1", label: "T1 标题" },
  { key: "d1", label: "D1 对白" },
  { key: "n1", label: "N1 旁白" },
  { key: "s1", label: "S1 音效" },
  { key: "a1", label: "A1 环境" },
  { key: "m1", label: "M1 音乐" },
  { key: "sub", label: "SUB 字幕" },
];

export function PostTimeline({ project }: { project: DirectorProject }) {
  const setSeg = useDirectorCtx((s) => s.setSeg);
  const updateProject = useDirector((s) => s.updateProject);
  const view = useMemo(() => buildPostTimeline(project), [project]);
  const [sel, setSel] = useState<{ kind: "clip" | "title"; id: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);

  const width = Math.max(600, (view.totalSec + 4) * SEC_PX + GUTTER);
  const selClip = sel?.kind === "clip" ? view.clips.find((c) => c.segment.id === sel.id) : undefined;
  const selTitle = sel?.kind === "title" ? view.titleCards.find((t) => t.id === sel.id) : undefined;
  const pt = project.postTimeline ?? { clipOverrides: {}, titleCards: [], subtitles: [], fit: "contain" as const };

  const audioByKind = (kind: string) => view.audio.filter((a) => a.track.kind === kind);

  // 空态收起：没有任何片段/卡/音频/字幕时，整条时间线收成一条细提示
  if (!view.clips.length && !view.titleCards.length && !view.subtitles.length && !(project.audioTracks ?? []).length) {
    return (
      <div className="ds-tl ds-tl-bar">
        <span className="ds-card-title"><IcFilmFrame size={14} /> 成片时间线</span>
        <span className="ds-hint">还没有采用片段——到「导演」工作区生成并采用后，会按故事顺序排进这条时间线</span>
      </div>
    );
  }

  const addCard = (kind: PostTitleCard["kind"]) => {
    addTitleCard(project.id, { kind, durSec: kind === "title" ? 3 : 2, atSec: view.totalSec, text: kind === "title" ? "标题" : undefined });
    setAddOpen(false);
  };

  return (
    <div className="ds-tl" ref={clipRef}>
      <div className="ds-tl-toolbar">
        <span className="ds-card-title"><IcFilmFrame size={14} /> 成片时间线</span>
        <span className="ds-hint">{view.clips.length} 个采用片段 · 总时长 {view.totalSec.toFixed(1)}s</span>
        <span className="spacer" />
        <PopSelect
          title="画幅适配：片段画幅与项目不一致时的处理"
          value={pt.fit}
          triggerIcon
          options={[
            { value: "contain", label: "包含（留黑边）", icon: <IcFilmFrame size={14} /> },
            { value: "cover", label: "裁切填满", icon: <IcClapper size={14} /> },
            { value: "blur", label: "模糊填充", icon: <IcMusic size={14} /> },
          ]}
          onChange={(v) => setTimelineFit(project.id, v as typeof pt.fit)}
        />
        <button ref={addRef} className="btn sm" title="在成片末尾添加标题卡/黑场/图片卡" onClick={() => setAddOpen((v) => !v)}>
          <IcPlus size={13} /> 标题/黑场
        </button>
      </div>

      <div className="ds-tl-scroll">
        <div className="ds-tl-canvas" style={{ width }}>
          {/* 时间标尺 */}
          <div className="ds-tl-ruler">
            {Array.from({ length: Math.ceil(view.totalSec / 5) + 1 }, (_, i) => (
              <span key={i} className="ds-tl-tick" style={{ left: GUTTER + i * 5 * SEC_PX }}>
                {i * 5}s
              </span>
            ))}
          </div>

          {/* V1 视频轨 */}
          <div className="ds-tl-track v">
            <span className="ds-tl-track-label">{TRACK_LABEL[0].label}</span>
            {view.clips.map((c) => (
              <button
                key={c.segment.id}
                className={`ds-tl-clip${sel?.id === c.segment.id ? " on" : ""}`}
                style={{ left: GUTTER + c.startSec * SEC_PX, width: Math.max(24, c.durSec * SEC_PX - 2) }}
                title={`${c.segment.summary.slice(0, 20)}（${c.durSec.toFixed(1)}s${c.entry.inSec ? ` · 入 ${c.entry.inSec}s` : ""}${c.entry.outSec && c.entry.outSec < c.entry.durationSec ? ` · 出 ${c.entry.outSec}s` : ""}）点击调参数`}
                onClick={() => {
                  setSel({ kind: "clip", id: c.segment.id });
                  setSeg(c.segment.id);
                }}
              >
                <span className="ds-tl-clip-n">{c.segment.summary.slice(0, 8)}</span>
                <span className="ds-tl-clip-d">{c.durSec.toFixed(1)}s</span>
                {c.override.transition === "fade" ? <span className="ds-tl-fade" title="与下一段交叉淡化">⤳</span> : null}
              </button>
            ))}
            {!view.clips.length ? <span className="ds-tl-empty">还没有采用片段——到「导演」工作区生成并采用</span> : null}
          </div>

          {/* T1 标题卡轨 */}
          <div className="ds-tl-track t">
            <span className="ds-tl-track-label">{TRACK_LABEL[1].label}</span>
            {view.titleCards.map((t) => (
              <button
                key={t.id}
                className={`ds-tl-title${sel?.id === t.id ? " on" : ""}`}
                style={{ left: GUTTER + t.atSec * SEC_PX, width: Math.max(22, t.durSec * SEC_PX - 2) }}
                title={`${t.kind === "title" ? `标题「${t.text ?? ""}」` : t.kind === "black" ? "黑场" : "图片卡"} · ${t.durSec}s（点击编辑/删除）`}
                onClick={() => setSel({ kind: "title", id: t.id })}
              >
                {t.kind === "black" ? "黑" : t.kind === "image" ? "图" : (t.text ?? "标题").slice(0, 6)}
              </button>
            ))}
          </div>

          {/* 音频轨（对白/旁白/音效/环境/音乐） */}
          {TRACK_LABEL.slice(2, 7).map((tr) => {
            const list = audioByKind(tr.key === "d1" ? "dialogue" : tr.key === "n1" ? "narration" : tr.key === "s1" ? "sfx" : tr.key === "a1" ? "ambient" : "music");
            return (
              <div key={tr.key} className="ds-tl-track a">
                <span className="ds-tl-track-label">{tr.label}</span>
                {list.map((a) => (
                  <span
                    key={a.track.id}
                    className={`ds-tl-audio${a.track.muted ? " muted" : ""}`}
                    style={{ left: GUTTER + a.startSec * SEC_PX, width: Math.max(22, a.durSec * SEC_PX - 2) }}
                    title={`${a.track.text.slice(0, 30)}${a.track.assetId ? "（已有音频资产）" : "（未生成 TTS）"}${a.track.muted ? " · 已静音" : ""}——在下方混音器调音量/淡化`}
                  >
                    {a.track.text.slice(0, 10)}
                  </span>
                ))}
              </div>
            );
          })}

          {/* SUB 字幕轨 */}
          <div className="ds-tl-track sub">
            <span className="ds-tl-track-label">{TRACK_LABEL[7].label}</span>
            {view.subtitles.map((s) => (
              <span
                key={s.id}
                className="ds-tl-sub"
                style={{ left: GUTTER + s.startSec * SEC_PX, width: Math.max(20, (s.endSec - s.startSec) * SEC_PX - 2) }}
                title={s.text}
              >
                {s.text.slice(0, 12)}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* 片段参数浮层：入出点/转场/原声音量/淡化（§11.3 首版编辑能力） */}
      {selClip ? (
        <ClipParamPop
          project={project}
          segId={selClip.segment.id}
          durSec={selClip.entry.durationSec}
          onClose={() => setSel(null)}
          anchor={clipRef}
        />
      ) : null}

      {/* 标题卡编辑浮层 */}
      {selTitle ? (
        <PopLayer anchorRef={clipRef} onClose={() => setSel(null)} className="ds-tl-pop" style={{ minWidth: 0 }}>
          <div className="ds-tl-pop-head">
            <b>{selTitle.kind === "title" ? "标题卡" : selTitle.kind === "black" ? "黑场" : "图片卡"}</b>
            <span className="spacer" />
            <button
              className="btn sm danger"
              onClick={() => {
                removeTitleCard(project.id, selTitle.id);
                setSel(null);
              }}
            >
              <IcClose size={12} /> 删除
            </button>
          </div>
          <label className="ds-tl-field">
            位置（秒）
            <input
              className="input sm nodrag"
              type="number"
              min={0}
              step={0.1}
              value={selTitle.atSec}
              onChange={(e) => {
                const cards = view.titleCards.map((t) => (t.id === selTitle.id ? { ...t, atSec: Math.max(0, Number(e.target.value) || 0) } : t));
                updateProject(project.id, { postTimeline: { ...pt, titleCards: cards } });
              }}
            />
          </label>
          <label className="ds-tl-field">
            时长（秒）
            <input
              className="input sm nodrag"
              type="number"
              min={0.2}
              step={0.1}
              value={selTitle.durSec}
              onChange={(e) => {
                const cards = view.titleCards.map((t) => (t.id === selTitle.id ? { ...t, durSec: Math.max(0.2, Number(e.target.value) || 1) } : t));
                updateProject(project.id, { postTimeline: { ...pt, titleCards: cards } });
              }}
            />
          </label>
          {selTitle.kind === "title" ? (
            <label className="ds-tl-field">
              文本
              <input
                className="input nodrag"
                value={selTitle.text ?? ""}
                onChange={(e) => {
                  const cards = view.titleCards.map((t) => (t.id === selTitle.id ? { ...t, text: e.target.value } : t));
                  updateProject(project.id, { postTimeline: { ...pt, titleCards: cards } });
                }}
              />
            </label>
          ) : null}
        </PopLayer>
      ) : null}

      {addOpen ? (
        <PopLayer anchorRef={addRef} onClose={() => setAddOpen(false)} className="ds-tl-pop">
          <button className="ds-tl-add" onClick={() => addCard("title")}><IcText size={13} /> 标题卡（黑底白字）</button>
          <button className="ds-tl-add" onClick={() => addCard("black")}><IcFilmFrame size={13} /> 黑场</button>
          <button className="ds-tl-add" onClick={() => addCard("image")}><IcPlus size={13} /> 图片卡（从资产库选首图）</button>
        </PopLayer>
      ) : null}
    </div>
  );
}

/** 片段参数浮层（入出点/转场/原声） */
function ClipParamPop({
  project,
  segId,
  durSec,
  onClose,
  anchor,
}: {
  project: DirectorProject;
  segId: string;
  durSec: number;
  onClose: () => void;
  anchor: React.RefObject<HTMLDivElement | null>;
}) {
  const pt = project.postTimeline ?? { clipOverrides: {}, titleCards: [], subtitles: [], fit: "contain" as const };
  const ov = pt.clipOverrides[segId] ?? { segmentId: segId };
  const patch = (p: Parameters<typeof patchClipOverride>[2]) => patchClipOverride(project.id, segId, p);
  return (
    <PopLayer anchorRef={anchor} onClose={onClose} className="ds-tl-pop" style={{ minWidth: 0 }}>
      <div className="ds-tl-pop-head">
        <b>片段剪辑参数</b>
        <span className="ds-hint">入出点同时作用于预演与最终导出</span>
      </div>
      <div className="ds-tl-fields">
        <label className="ds-tl-field">
          入点（秒）
          <input
            className="input sm nodrag"
            type="number"
            min={0}
            max={durSec}
            step={0.1}
            value={ov.inSec ?? 0}
            onChange={(e) => patch({ inSec: Math.max(0, Math.min(durSec - 0.1, Number(e.target.value) || 0)) })}
          />
        </label>
        <label className="ds-tl-field">
          出点（秒）
          <input
            className="input sm nodrag"
            type="number"
            min={0}
            max={durSec}
            step={0.1}
            value={ov.outSec ?? durSec}
            onChange={(e) => patch({ outSec: Math.max(0.2, Math.min(durSec, Number(e.target.value) || durSec)) })}
          />
        </label>
        <label className="ds-tl-field">
          转场
          <PopSelect
            value={ov.transition ?? "cut"}
            triggerIcon
            options={[
              { value: "cut", label: "硬切", icon: <IcFilmFrame size={14} /> },
              { value: "fade", label: "交叉淡化", icon: <IcMusic size={14} /> },
            ]}
            onChange={(v) => patch({ transition: v as "cut" | "fade", transitionDur: v === "fade" ? (ov.transitionDur ?? 0.5) : undefined })}
          />
        </label>
        {ov.transition === "fade" ? (
          <label className="ds-tl-field">
            淡化时长
            <input
              className="input sm nodrag"
              type="number"
              min={0.1}
              max={2}
              step={0.1}
              value={ov.transitionDur ?? 0.5}
              onChange={(e) => patch({ transitionDur: Math.max(0.1, Math.min(2, Number(e.target.value) || 0.5)) })}
            />
          </label>
        ) : null}
        <label className="ds-tl-field">
          原声音量
          <input
            className="nodrag"
            type="range"
            min={0}
            max={1.5}
            step={0.05}
            value={ov.muted ? 0 : (ov.volume ?? 1)}
            onChange={(e) => patch({ volume: Number(e.target.value), muted: Number(e.target.value) === 0 })}
          />
          <i>{Math.round((ov.muted ? 0 : (ov.volume ?? 1)) * 100)}%</i>
        </label>
        <label className="ds-tl-field">
          淡入/淡出（秒）
          <input
            className="input sm nodrag"
            type="number"
            min={0}
            step={0.1}
            value={ov.fadeIn ?? 0}
            onChange={(e) => patch({ fadeIn: Math.max(0, Number(e.target.value) || 0) })}
          />
          <input
            className="input sm nodrag"
            type="number"
            min={0}
            step={0.1}
            value={ov.fadeOut ?? 0}
            onChange={(e) => patch({ fadeOut: Math.max(0, Number(e.target.value) || 0) })}
          />
        </label>
      </div>
    </PopLayer>
  );
}
