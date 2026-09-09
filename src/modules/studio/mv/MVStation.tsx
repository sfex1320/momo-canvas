/**
 * AI MV 工位（导演台 3.0 · 方案 §6.6）
 *
 * 左：歌曲 / 歌词 / 素材池 · 中：波形 + 节拍轨 + 段落轨 + 视觉区间轨（连续暗色 Stage）·
 * 右：当前区间检查器（提示词 / 绑定图 / 角色 / 口型 / 生成）· 顶部：分析音乐 / 批量生成 / 送往成片。
 * 区间生成共享项目配方与模型体系（mvEngine）；「送往成片」用正式渲染引擎
 * （clips=区间视频入出点 + 音乐轨），预演与导出同一份数据（§3.2）。
 */
import { useEffect, useRef, useState } from "react";
import { useDirector } from "../../../core/stores/directorStore";
import { SI, opt } from "../shared/selectIcons";
import { useAssets } from "../../../core/stores/assetStore";
import { useUi } from "../../../core/stores/uiStore";
import { assetUrl, assetToBlobUrl } from "../../../core/services/assetFiles";
import {
  analyzeMusic, createMvProject, deleteMvProject, generateRegions, mvReadyCount,
  parseLrc, patchMv, patchRegion, addRegion, removeRegion,
} from "../../../core/studio/mvEngine";
import { renderToMp4 } from "../../../core/directorRender";
import { jobCenter } from "../../../core/studio/jobCenter";
import { errMsg } from "../../../core/utils";
import { DockPanel } from "../shared/DockPanel";
import { SkillStationBadge } from "../shared/SkillBindingCard";
import { PopSelect } from "../../../ui/PopSelect";
import { Thumb } from "../../../ui/Thumb";
import { AskCard } from "../../director/AskCard";
import { IcMusic, IcPlus, IcLoading, IcPlay, IcCheck, IcUpload, IcTrash, IcSparkles, IcFilmJoin, IcRefresh } from "../../../ui/icons";
import type { DirectorProject, MVProject, MVRegion } from "../../../core/types";

/** SRT 时间戳（00:00:01,500）——歌词字幕进成片烧录 */
function srtTs(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor(sec / 60) % 60;
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function MVStation({ project }: { project: DirectorProject }) {
  const [ask, setAsk] = useState<{ text: React.ReactNode; run: () => void } | null>(null);
  const updateProject = useDirector((s) => s.updateProject);
  const assets = useAssets((s) => s.items);
  const mvs = project.mvProjects ?? [];
  const mvId = project.studioUi?.mvId ?? mvs[0]?.id ?? null;
  const mv = mvs.find((m) => m.id === mvId) ?? mvs[0];
  const audioAssets = assets.filter((a) => a.kind === "audio" && !a.deletedAt);
  const imageAssets = assets.filter((a) => a.kind === "image" && !a.deletedAt);
  const [regionSel, setRegionSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lrcText, setLrcText] = useState("");
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const musicAsset = mv?.musicAssetId ? assets.find((a) => a.id === mv.musicAssetId) : undefined;
  const musicUrl = musicAsset ? (/^(blob:|data:|https?:)/.test(musicAsset.path) ? musicAsset.path : undefined) : undefined;
  const [musicBlob, setMusicBlob] = useState<string>();
  useEffect(() => {
    let on = true;
    if (musicAsset && !musicUrl) {
      void assetToBlobUrl(musicAsset.path, musicAsset.mime).then((u) => on && setMusicBlob(u)).catch(() => {});
    }
    return () => { on = false; };
  }, [musicAsset?.id, musicUrl, musicAsset]);

  const selRegion = mv?.regions.find((r) => r.id === regionSel) ?? null;
  const ready = mv ? mvReadyCount(mv) : 0;

  /* ---------- 顶部动作 ---------- */
  const doAnalyze = async () => {
    if (!mv) return;
    setBusy(true);
    try {
      await analyzeMusic(project.id, mv.id);
    } catch (e) {
      useUi.getState().toast?.(errMsg(e), "err");
    } finally {
      setBusy(false);
    }
  };

  const autoRegions = () => {
    if (!mv?.analysis?.sections?.length) return;
    // 按段落自动建视觉区间（已有人工区间不覆盖）
    for (const s of mv.analysis.sections) {
      if (mv.regions.some((r) => r.startSec === s.startSec)) continue;
      addRegion(project.id, mv.id, { startSec: s.startSec, endSec: s.endSec, imageAssetIds: [], characterIds: [], prompt: s.label ? `${s.label}氛围的音乐视觉` : "" });
    }
  };

  const doGenerate = async (ids?: string[]) => {
    if (!mv) return;
    const targets = ids ?? mv.regions.filter((r) => !r.approvedTakeId).map((r) => r.id);
    if (!targets.length) return useUi.getState().toast?.("所有区间都已有版本；如需重跑请在区间上单独生成", "info");
    // 远程计费确认闸（3.4）：未绑图的区间会先远程生图再远程生视频，批量连续计费前必须确认
    const vRecipe = project.recipes.find((r) => r.id === mv.settings.recipeId);
    const remoteVideo = vRecipe?.engine === "comfy" ? 0 : targets.length;
    const noImage = targets.filter((id) => !(mv.regions.find((r) => r.id === id)?.imageAssetIds ?? []).length).length;
    if (remoteVideo > 0 || noImage > 0) {
      setAsk({
        text: (
          <>
            将生成 {targets.length} 个 MV 区间
            {remoteVideo > 0 ? <div className="st-hint">· {remoteVideo} 次远程视频生成（按服务商计费，提交后不可撤销）</div> : null}
            {noImage > 0 ? <div className="st-hint">· {noImage} 个区间未绑定图片，将先远程生成首帧图（同样计费）</div> : null}
            <div className="st-hint" style={{ marginTop: 4 }}>确认后开始提交任务。</div>
          </>
        ),
        run: () => void runGenerate(targets),
      });
      return;
    }
    await runGenerate(targets);
  };

  const runGenerate = async (targets: string[]) => {
    if (!mv) return;
    abortRef.current = new AbortController();
    setBusy(true);
    const r = await generateRegions(project.id, mv.id, targets, abortRef.current.signal);
    setBusy(false);
    if (r.failed) useUi.getState().toast?.(`完成 ${r.ok} 个区间，失败 ${r.failed} 个（单段失败不阻断，可单独重跑）`, "info");
    else useUi.getState().toast?.(`${r.ok} 个区间生成完成`, "ok");
  };

  /** 送往成片：区间视频入出点 + 音乐轨 → 正式渲染管线（预演与导出同一份数据） */
  const doExport = async () => {
    if (!mv || !musicAsset) return useUi.getState().toast?.("请先选择音乐并生成至少一个区间", "err");
    const clips: Array<{ path: string; durSec: number }> = [];
    for (const r of mv.regions) {
      const take = (r.takes ?? []).find((t) => t.id === r.approvedTakeId && t.status === "done" && t.assetId);
      if (!take?.assetId) continue;
      const a = assets.find((x) => x.id === take.assetId);
      if (!a) continue;
      clips.push({ path: a.path, durSec: r.endSec - r.startSec });
    }
    if (!clips.length) return useUi.getState().toast?.("还没有就绪的区间视频", "err");
    const job = jobCenter.begin({ projectId: project.id, kind: "render", label: `MV 成片 · ${mv.name}` });
    try {
      // 输出路径：桌面端选保存位置；浏览器预览降级拼接不需要
      let outPath = "";
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const picked = await save({ defaultPath: `${mv.name}_成片.mp4`, filters: [{ name: "MP4 视频", extensions: ["mp4"] }] });
        if (!picked) {
          job.cancel();
          return;
        }
        outPath = picked;
      } catch {
        // 无对话框环境（理论上不会走到）继续，让渲染端报路径错误
      }
      const [w, h] = (mv.settings.aspect ?? project.aspect) === "9:16" ? [720, 1280] : [1280, 720];
      const total = clips.reduce((n, c) => n + c.durSec, 0);
      const lyrics = mv.lyrics ?? [];
      const srt = lyrics.length ? lyrics.map((l, i) => `${i + 1}\n${srtTs(l.startSec)} --> ${srtTs(l.endSec)}\n${l.text}\n`).join("\n") : "";
      job.stage("渲染 MV 成片（区间拼接 + 音乐混音）", 5);
      const r = await renderToMp4(
        {
          clips: clips.map((c) => ({ path: c.path, inSec: 0, outSec: c.durSec, durSec: c.durSec, volume: 0.15, muted: false })), // 区间原声压低垫底，音乐为主；outSec 真实传值让 ffmpeg 按区间裁切
          audio: [{ path: musicAsset.path, atSec: 0, volume: 1, muted: false }],
          titles: [],
          srt,
          width: w,
          height: h,
          fps: 30,
          fit: "cover",
          totalSec: Math.max(total, mv.analysis?.durationSec ?? total),
          assetCount: clips.length + 1,
        },
        outPath,
        (p) => job.stage(p.msg, p.pct),
      );
      job.done("MV 成片已导出");
      useUi.getState().toast?.(`MV 成片完成：${r.path ?? "已生成（浏览器降级）"}`, "ok");
    } catch (e) {
      job.fail(errMsg(e));
      useUi.getState().toast?.(`MV 成片失败：${errMsg(e)}`, "err");
    }
  };

  return (
    <>
      {/* 左：歌曲 / 歌词 / 素材池 */}
      <DockPanel
        className="mv-left"
        title="AI MV"
        projectId={project.id}
        widthKey="mvLeft"
        width={project.studioUi?.panelWidths?.mvLeft ?? 260}
        headExtra={
          <button
            className="st-btn sm"
            style={{ marginLeft: "auto" }}
            onClick={() => {
              const m = createMvProject(project.id, `MV ${mvs.length + 1}`);
              updateProject(project.id, { studioUi: { ...project.studioUi ?? { station: "h3" }, mvId: m.id } });
            }}
          >
            <IcPlus size={12} /> 新建
          </button>
        }
      >
        {mvs.length > 1 ? (
          <div style={{ padding: "8px 10px 0" }}>
            <PopSelect
              value={mv?.id ?? ""}
              onChange={(v) => updateProject(project.id, { studioUi: { ...project.studioUi ?? { station: "h3" }, mvId: String(v) } })}
              triggerIcon
              options={mvs.map((m) => ({ value: m.id, label: m.name, icon: SI.music }))}
            />
          </div>
        ) : null}
        {mv ? (
          <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="st-field">
              <label>歌曲（资产库音频）</label>
              <PopSelect
                value={mv.musicAssetId ?? ""}
                onChange={(v) => patchMv(project.id, mv.id, (m) => ({ ...m, musicAssetId: String(v) || undefined }))}
                triggerIcon
                options={[opt("", "选择音乐…", SI.music), ...audioAssets.map((a) => ({ value: a.id, label: a.name, icon: SI.music }))]}
              />
              <input ref={fileRef} type="file" accept="audio/*" hidden onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const a = await useAssets.getState().importFileGetItem(f);
                if (a) patchMv(project.id, mv.id, (m) => ({ ...m, musicAssetId: a.id }));
                e.target.value = "";
              }} />
              <button className="st-btn sm" onClick={() => fileRef.current?.click()}><IcUpload size={12} /> 导入音乐</button>
            </div>
            <div className="st-field">
              <label>歌曲信息</label>
              <span className="st-hint">
                {mv.analysis
                  ? `${mv.analysis.durationSec.toFixed(1)}s${mv.analysis.bpm ? ` · ≈${mv.analysis.bpm} BPM` : ""} · ${mv.analysis.sections?.length ?? 0} 段 · ${ready}/${mv.regions.length} 区间就绪`
                  : "尚未分析——点顶部「分析音乐」探测时长/节拍/段落"}
              </span>
            </div>
            <div className="st-field">
              <label>歌词（LRC 粘贴或手填；进成片字幕）</label>
              <textarea
                className="st-area"
                rows={4}
                placeholder={"[00:12.5]第一句歌词\n[00:16.2]第二句歌词"}
                value={lrcText}
                onChange={(e) => setLrcText(e.target.value)}
                onBlur={() => {
                  if (!lrcText.trim()) return;
                  patchMv(project.id, mv.id, (m) => ({ ...m, lyrics: parseLrc(lrcText) }));
                }}
              />
            </div>
            {mv.regions.length > 0 ? (
              <button className="st-btn sm danger" title="删除此 MV 项目（生成资产保留在资产库）" onClick={() => { deleteMvProject(project.id, mv.id); setRegionSel(null); }}>
                <IcTrash size={12} /> 删除 MV
              </button>
            ) : null}
          </div>
        ) : (
          <div className="st-empty"><b>新建一个 MV</b>选择歌曲 → 分析 → 绑图 → 逐区间生成。</div>
        )}
      </DockPanel>

      {/* 中：波形 + 轨道（连续暗色 Stage） */}
      {mv ? (
        <section className="st-stage" style={{ flex: 1 }}>
          <div className="st-panel-h">
            <IcMusic size={13} /> {mv.name}
            <SkillStationBadge project={project} context="studio.mv" />
            <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button className="st-btn sm" disabled={!mv.musicAssetId || busy} onClick={() => void doAnalyze()}>{busy ? <IcLoading size={11} /> : <IcSparkles size={11} />} 分析音乐</button>
              <button className="st-btn sm" disabled={!mv.analysis?.sections?.length} onClick={autoRegions} title="按能量段落自动建视觉区间">自动区间</button>
              <button className="st-btn sm" disabled={busy || !mv.regions.length} onClick={() => void doGenerate()}>
                <IcPlay size={11} /> 批量生成
              </button>
              {busy ? (
                <button className="st-btn sm" onClick={() => abortRef.current?.abort()} title="停止后续区间（已提交的远程任务无法撤销计费）">停止</button>
              ) : null}
              <button className="st-btn sm primary" disabled={!ready} onClick={() => void doExport()}>
                <IcFilmJoin size={11} /> 送往成片
              </button>
            </div>
          </div>

          {/* 预览音频 */}
          <audio
            ref={audioRef}
            src={musicUrl ?? musicBlob}
            onTimeUpdate={(e) => setPlayhead(e.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            hidden
          />

          {/* 波形 + 播放头 */}
          <div className="mv-wave" onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            const dur = mv.analysis?.durationSec ?? musicAsset ? mv.analysis?.durationSec ?? 1 : 1;
            if (audioRef.current && dur) audioRef.current.currentTime = pct * dur;
            setPlayhead(pct * (mv.analysis?.durationSec ?? 0));
          }}>
            <WaveCanvas envelope={mv.analysis?.envelope} beats={mv.analysis?.beats} playheadPct={(playhead / (mv.analysis?.durationSec || 1)) * 100} />
            <div className="mv-playhead" style={{ left: `${(playhead / (mv.analysis?.durationSec || 1)) * 100}%` }} />
          </div>

          {/* 轨道：节拍 / 段落 / 视觉区间 */}
          <div className="mv-tracks">
            <div className="mv-track">
              <span className="tl-label">节拍</span>
              <div className="tl-body" style={{ position: "relative" }}>
                {(mv.analysis?.beats ?? []).map((b, i) => (
                  <span key={i} className="mv-beat" style={{ left: `${(b / (mv.analysis?.durationSec || 1)) * 100}%` }} />
                ))}
              </div>
            </div>
            <div className="mv-track">
              <span className="tl-label">段落</span>
              <div className="tl-body" style={{ position: "relative" }}>
                {(mv.analysis?.sections ?? []).map((s, i) => (
                  <span
                    key={i}
                    className="mv-region"
                    style={{
                      left: `${(s.startSec / (mv.analysis!.durationSec || 1)) * 100}%`,
                      width: `${((s.endSec - s.startSec) / (mv.analysis!.durationSec || 1)) * 100}%`,
                      background: s.energy > 0.66 ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)",
                      borderColor: "transparent",
                    }}
                  >
                    {s.label}
                  </span>
                ))}
              </div>
            </div>
            <div className="mv-track">
              <span className="tl-label">视觉</span>
              <div className="tl-body" style={{ position: "relative" }}>
                {mv.regions.map((r) => {
                  const take = (r.takes ?? []).find((t) => t.id === r.approvedTakeId && t.status === "done" && t.assetId);
                  const thumb = take?.assetId ? assets.find((a) => a.id === take.assetId)?.thumb : undefined;
                  const img = !thumb && r.imageAssetIds[0] ? assets.find((a) => a.id === r.imageAssetIds[0]) : undefined;
                  return (
                    <div
                      key={r.id}
                      className={`mv-region${selRegion?.id === r.id ? " on" : ""}`}
                      style={{
                        left: `${(r.startSec / (mv.analysis?.durationSec || 1)) * 100}%`,
                        width: `${((r.endSec - r.startSec) / (mv.analysis?.durationSec || 1)) * 100}%`,
                      }}
                      title={`${r.startSec.toFixed(1)}-${r.endSec.toFixed(1)}s · ${r.prompt ?? ""}`}
                      onClick={() => setRegionSel(r.id)}
                    >
                      {thumb ? <img className="mv-thumb" src={assetUrl(thumb)} alt="" /> : img ? <Thumb src={assetUrl(img.path)} style={{ height: "100%", aspectRatio: "16/10", objectFit: "cover", borderRadius: 2 }} /> : null}
                      {take ? "✓" : "…"} {r.lipSync ? "口型" : ""}
                    </div>
                  );
                })}
                <button
                  className="st-btn sm"
                  style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", zIndex: 2 }}
                  title="在播放头处新建视觉区间"
                  onClick={() => {
                    const start = Math.floor(playhead);
                    const r = addRegion(project.id, mv.id, { startSec: start, endSec: Math.min(start + 8, mv.analysis?.durationSec ?? start + 8), imageAssetIds: [], characterIds: [] });
                    setRegionSel(r.id);
                  }}
                >
                  <IcPlus size={11} />
                </button>
              </div>
            </div>
          </div>
          <div className="h3-mon-ctrl">
            <button className="st-iconbtn" title={playing ? "暂停" : "播放（波形与轨道共用播放头）"} onClick={() => {
              const a = audioRef.current;
              if (!a) return;
              if (a.paused) void a.play().catch(() => {});
              else a.pause();
            }}>
              {playing ? <IcPlay size={16} /> : <IcPlay size={16} />}
            </button>
            <span className="tcode">
              {playhead.toFixed(1)}s / {(mv.analysis?.durationSec ?? 0).toFixed(1)}s
            </span>
          </div>
        </section>
      ) : (
        <div className="st-empty" style={{ flex: 1 }}><IcMusic size={30} /><b>新建 MV 项目开始</b></div>
      )}

      {/* 右：区间检查器 */}
      <DockPanel className="mv-right" title="区间" projectId={project.id} widthKey="mvRight" width={project.studioUi?.panelWidths?.mvRight ?? 300}>
        {mv && selRegion ? (
          <RegionInspector project={project} mv={mv} region={selRegion} onDone={() => void doGenerate([selRegion.id])} busy={busy} />
        ) : (
          <div className="st-empty">
            <b>选择一个视觉区间</b>
            <span>在轨道上点选区间（或点 + 新建）；每段音乐可绑不同的图 / 角色 / 口型。</span>
          </div>
        )}
        {/* 素材池：可点击追加到当前区间 */}
        {mv && selRegion ? (
          <div style={{ borderTop: "1px solid var(--studio-border)", padding: 10 }}>
            <span className="st-hint">素材池（点图追加到当前区间）</span>
            <div className="ch-refs" style={{ marginTop: 6 }}>
              {imageAssets.slice(0, 18).map((a) => (
                <div
                  key={a.id}
                  className="ch-ref"
                  title={a.name}
                  onClick={() => patchRegion(project.id, mv.id, selRegion.id, { imageAssetIds: [...selRegion.imageAssetIds, a.id] })}
                >
                  <Thumb src={assetUrl(a.path)} style={{ width: "100%", height: "100%" }} />
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </DockPanel>
          {ask ? (
        <AskCard
          text={ask.text}
          okText="确认开始生成"
          danger
          onConfirm={() => {
            ask.run();
            setAsk(null);
          }}
          onCancel={() => setAsk(null)}
        />
      ) : null}
</>
  );
}

/** 波形 canvas：能量包络 + 节拍刻度（一次性绘制，随 analysis 变化重画） */
function WaveCanvas({ envelope, beats, playheadPct }: { envelope?: number[]; beats?: number[]; playheadPct: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const env = envelope ?? [];
    if (!env.length) {
      ctx.fillStyle = "rgba(255,255,255,0.16)";
      ctx.font = "11px sans-serif";
      ctx.fillText("分析音乐后显示波形与节拍", 12, h / 2);
      return;
    }
    // 镜像能量柱
    ctx.fillStyle = "rgba(160,175,210,0.55)";
    const bw = Math.max(1, w / env.length);
    for (let i = 0; i < env.length; i++) {
      const bh = Math.max(1, env[i] * (h * 0.86));
      ctx.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 0.5), bh);
    }
    // 节拍刻度
    const dur = env.length;
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    for (const b of beats ?? []) {
      ctx.fillRect((b / dur) * w, 0, 1, 6);
      ctx.fillRect((b / dur) * w, h - 6, 1, 6);
    }
  }, [envelope, beats]);
  void playheadPct;
  return <canvas ref={ref} />;
}

function RegionInspector({ project, mv, region, onDone, busy }: { project: DirectorProject; mv: MVProject; region: MVRegion; onDone: () => void; busy: boolean }) {
  const assets = useAssets((s) => s.items);
  const patch = (p: Partial<MVRegion>) => patchRegion(project.id, mv.id, region.id, p);
  const takes = (region.takes ?? []).filter((t) => t.status === "done" && t.assetId);
  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="st-row">
        <div className="st-field" style={{ flex: 1 }}>
          <label>起点（秒）</label>
          <input className="st-input" type="number" step="0.5" value={region.startSec} onChange={(e) => patch({ startSec: Math.max(0, Number(e.target.value) || 0) })} />
        </div>
        <div className="st-field" style={{ flex: 1 }}>
          <label>终点（秒）</label>
          <input className="st-input" type="number" step="0.5" value={region.endSec} onChange={(e) => patch({ endSec: Math.max(region.startSec + 2, Number(e.target.value) || region.startSec + 2) })} />
        </div>
      </div>
      <div className="st-field">
        <label>区间提示词（运动 / 氛围）</label>
        <textarea className="st-area" rows={2} value={region.prompt ?? ""} onChange={(e) => patch({ prompt: e.target.value })} placeholder="如：镜头缓推，角色在霓虹雨巷中回眸" />
      </div>
      <div className="st-field">
        <label>绑定角色（外观参考叠加）</label>
        <div className="st-row" style={{ flexWrap: "wrap" }}>
          {project.characters.map((c) => (
            <button
              key={c.id}
              className={`st-pill${region.characterIds.includes(c.id) ? " accent" : ""}`}
              style={{ cursor: "pointer", border: 0 }}
              onClick={() => patch({ characterIds: region.characterIds.includes(c.id) ? region.characterIds.filter((x) => x !== c.id) : [...region.characterIds, c.id] })}
            >
              {c.name}
            </button>
          ))}
          {!project.characters.length ? <span className="st-hint">项目还没有角色</span> : null}
        </div>
      </div>
      <label className="st-hint" style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input type="checkbox" checked={!!region.lipSync} onChange={(e) => patch({ lipSync: e.target.checked })} />
        人物口型区间{mv.settings.lipSyncRecipeId ? "" : "（未配置口型配方——生成时按普通区间处理）"}
      </label>
      <div className="st-row">
        <button className="st-btn primary" style={{ flex: 1 }} disabled={busy} onClick={onDone}>
          <IcPlay size={12} /> 生成此区间
        </button>
        <button className="st-btn" title="删除区间（产物资产保留）" onClick={() => removeRegion(project.id, mv.id, region.id)}><IcTrash size={13} /></button>
      </div>
      {takes.length ? (
        <div className="st-field">
          <label>版本（{takes.length}）</label>
          {takes.map((t, i) => {
            const a = t.assetId ? assets.find((x) => x.id === t.assetId) : undefined;
            return (
              <div key={t.id} className="st-row" style={{ padding: "4px 0" }}>
                <span style={{ fontSize: 12, flex: 1 }}>Take {i + 1}{region.approvedTakeId === t.id ? " ✓" : ""}</span>
                {a ? (
                  <button className="st-btn sm" onClick={() => patch({ approvedTakeId: t.id })}>
                    {region.approvedTakeId === t.id ? <IcCheck size={11} /> : null} 采用
                  </button>
                ) : null}
              </div>
            );
          })}
          <button className="st-btn sm" disabled={busy} onClick={() => patch({ takes: [], approvedTakeId: undefined })} title="清空本区间版本重新生成">
            <IcRefresh size={11} /> 重置区间
          </button>
        </div>
      ) : null}
    </div>
  );
}
