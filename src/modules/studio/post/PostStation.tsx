/**
 * 成片交付工位（导演台 3.0 · 方案 §6.7）— 全屏后期工位，替换卡片仪表盘
 *
 * 素材/问题列表 │ 监看器 + 多轨时间线 │ 属性 / 质检 / 导出
 *  - 时间线复用 PostTimeline（V1/T1/D1/N1/S1/A1/M1/SUB）+ 混音器 + 字幕编辑器；
 *  - 质量问题在左轨（缺片 / 质量报告 / 连续性），点击定位片段（跳 H3 播放头同源 segId）；
 *  - 属性面板承载入出点 / 转场 / 镜像 / 旋转 / 原声音量——预演与导出读同一份覆盖数据（§3.2）；
 *  - 导出走桌面 ffmpeg 正式管线（预设 / 进度 / 取消 / 项目包）。
 */
import { useMemo, useRef, useState } from "react";
import { useAssets } from "../../../core/stores/assetStore";
import { AudioSetup } from "./AudioSetup";
import {exportEditingProject,chooseEditingPython} from "../../../core/studio/editingExport";
import { SI, opt } from "../shared/selectIcons";
import { useDirector } from "../../../core/stores/directorStore";
import { useUi, toast } from "../../../core/stores/uiStore";
import { useDirectorCtx } from "../../../core/directorContext";
import { assetUrl } from "../../../core/services/assetFiles";
import { errMsg, isTauri } from "../../../core/utils";
import { buildPostTimeline, clipOverrideOf, patchClipOverride } from "../../../core/directorTimeline";
import { buildRenderPlan, renderToMp4, EXPORT_PRESETS, locateFfmpeg, cancelRender, type RenderProgress } from "../../../core/directorRender";
import { probeApprovedTakes } from "../../../core/directorQuality";
import { checkContinuity } from "../../../core/directorAnalysis";
import { exportProjectPackage } from "../../../core/directorProjectIO";
import { jobCenter } from "../../../core/studio/jobCenter";
import { DockPanel, InspectorGroup } from "../shared/DockPanel";
import { PostTimeline } from "../../director/timeline/PostTimeline";
import { AudioMixer } from "../../director/timeline/AudioMixer";
import { SubtitleEditor } from "../../director/timeline/SubtitleEditor";
import { AskCard } from "../../director/AskCard";
import { PopSelect } from "../../../ui/PopSelect";
import { IcVideo, IcLoading, IcStop, IcScan, IcDownload, IcFolder, IcWarn, IcCheck, IcPlay, IcRotate, IcFilmFrame } from "../../../ui/icons";
import type { DirectorProject, PostClipOverride } from "../../../core/types";

export function PostStation({ project }: { project: DirectorProject }) {
  const assets = useAssets((s) => s.items);
  const setSeg = useDirectorCtx((s) => s.setSeg);
  const [preset, setPreset] = useState("1080h");
  const [rendering, setRendering] = useState(false);
  const [exportBusy,setExportBusy] = useState(false);
  const exportEditor = async (target:"premiere"|"jianying") => {setExportBusy(true);try{const path=await exportEditingProject(project,preset,target);if(path)toast(`剪辑工程已导出：${path}`,"ok");}catch(e){toast(errMsg(e),"err");}finally{setExportBusy(false);}};
  const [prog, setProg] = useState<RenderProgress | null>(null);
  const [ask, setAsk] = useState<{ text: React.ReactNode; run: () => void } | null>(null);
  const [ffOk, setFfOk] = useState<boolean | null>(null);
  const [tab, setTab] = useState<"props" | "mix" | "subs">("props");
  const renderTaskRef = useRef<string | null>(null);

  const view = useMemo(() => buildPostTimeline(project), [project]);
  const plan = useMemo(() => buildRenderPlan(project, preset), [project, preset]);
  const ctxSegId = useDirectorCtx((s) => s.segId);
  const currentClip = view.clips.find((c) => c.segment.id === ctxSegId) ?? view.clips[0];
  const override: PostClipOverride = currentClip ? clipOverrideOf(project, currentClip.segment.id) : { segmentId: "" };

  /* 问题列表：缺片 + 质量报告 + 连续性（点击定位） */
  const issues = useMemo(() => {
    const list: Array<{ level: "error" | "warning" | "info"; title: string; detail: string; segId?: string }> = [];
    for (const seg of project.scenes.flatMap((s) => s.segments)) {
      if (!seg.approvedTakeId) {
        list.push({ level: "warning", title: `缺片：${seg.summary.slice(0, 20)}`, detail: "尚未采用 Take，不会进入成片", segId: seg.id });
      }
    }
    for (const r of project.qualityReports ?? []) {
      for (const i of r.issues ?? []) {
        if (i.level === "info") continue;
        const seg = project.scenes.flatMap((s) => s.segments).find((x) => (x.takes ?? []).some((t) => t.id === r.takeId));
        list.push({ level: i.level === "error" ? "error" : "warning", title: i.message, detail: `质量探测 · ${new Date(r.probedAt).toLocaleTimeString()}`, segId: seg?.id });
      }
    }
    for (const c of checkContinuity(project)) {
      if (c.level === "info") continue;
      list.push({ level: c.level === "error" ? "error" : "warning", title: c.message, detail: "连续性检查", segId: c.segmentId });
    }
    return list;
  }, [project]);

  // 预演条目与导出同源：同一份采用 Take + 入出点（转场除外）
  const previewItems = useMemo(() => {
    const list: Array<{ url: string; inSec: number; outSec: number }> = [];
    for (const c of view.clips) {
      const take = c.segment.takes?.find((t) => t.id === c.entry.takeId);
      const asset = take?.assetId ? assets.find((a) => a.id === take.assetId) : undefined;
      if (asset) list.push({ url: assetUrl(asset.path), inSec: c.entry.inSec ?? 0, outSec: c.entry.outSec ?? c.entry.durationSec });
    }
    return list;
  }, [view.clips, assets]);

  const currentAsset = useMemo(() => {
    const take = currentClip?.segment.takes?.find((t) => t.id === currentClip.entry.takeId);
    return take?.assetId ? assets.find((a) => a.id === take.assetId) : undefined;
  }, [currentClip, assets]);

  /** 导入 .momoproject 项目包（3.4）：自动在当前画布创建导演台节点并挂载 */
  const doImportPack = async () => {
    try {
      const { importProjectPackage } = await import("../../../core/directorProjectIO");
      const r = await importProjectPackage();
      const p = r.importedProject;
      if (!p) return;
      const { useBoard } = await import("../../../core/stores/boardStore");
      const board = useBoard.getState();
      const nid = board.addNode("director", { x: 160, y: 120 }, { projectId: p.id });
      useDirector.getState().updateProject(p.id, { nodeId: nid, boardId: board.activeId });
      toast(`项目包已导入为「${p.name}」，并在画布创建了导演台节点（资产复用 ${r.assetReused} / 拷回 ${r.assetCopied}）`, "ok");
    } catch (e) {
      const msg = errMsg(e);
      if (msg !== "已取消导入") toast(`导入失败：${msg}`, "err");
    }
  };

  const doRender = () => {
    if (!plan.plan.clips.length) return toast("还没有可渲染的采用片段", "err");
    setAsk({
      text: (
        <div className="ds-gi-confirm">
          <b>导出 MP4 成片</b>
          <div className="ds-gi-confirm-line">预设：{EXPORT_PRESETS.find((p) => p.id === preset)?.label}（{plan.plan.width}×{plan.plan.height}）</div>
          <div className="ds-gi-confirm-line">{plan.plan.clips.length} 段 · {plan.plan.audio.length} 条音频轨 · {plan.plan.totalSec.toFixed(1)}s</div>
          {plan.skipped ? <div className="ds-gi-confirm-line warn">⚠ {plan.skipped} 个片段资产不可读，将跳过</div> : null}
          {!isTauri ? <div className="ds-gi-confirm-line warn">浏览器预览模式：降级实时拼接（不含入出点/字幕/混音）</div> : null}
        </div>
      ),
      run: () => {
        void (async () => {
          setRendering(true);
          setProg({ msg: "准备渲染…" });
          const job = jobCenter.begin({ projectId: project.id, kind: "render", label: "成片导出 MP4" });
          const id = `render_${Date.now()}`;
          renderTaskRef.current = id;
          try {
            let outPath = `momo_render_${Date.now()}.mp4`;
            if (isTauri) {
              const { save } = await import("@tauri-apps/plugin-dialog");
              const picked = await save({
                title: "导出 MP4 成片",
                defaultPath: `${project.name.replace(/[^\w-]/g, "_")}_${preset}.mp4`,
                filters: [{ name: "MP4 视频", extensions: ["mp4"] }],
              });
              if (!picked || typeof picked !== "string") {
                setRendering(false);
                setProg(null);
                job.cancel();
                return;
              }
              outPath = picked;
            }
            const r = await renderToMp4(plan.plan, outPath, (p) => {
              setProg(p);
              job.stage(p.msg, p.pct);
            }, id);
            if (r.path && isTauri) {
              const asset = await useAssets.getState().collect({
                src: r.path,
                kind: "video",
                prompt: `${project.name} 成片`,
                director: { projectId: project.id, role: "export" },
              });
              if (asset) {
                void import("../../../core/studio/projectAssetRouter").then(({ mirrorProjectAsset }) =>
                  mirrorProjectAsset({ projectId: project.id, category: "export", assetId: asset.id }),
                );
                useDirector.getState().updateProject(project.id, { exportAssetId: asset.id });
                const useBoard = (await import("../../../core/stores/boardStore")).useBoard;
                useBoard.getState().updateData(project.nodeId, { outputUrl: asset.path });
              }
            }
            job.done(`成片已导出（${r.engine === "ffmpeg" ? "ffmpeg" : "降级拼接"}）`);
            toast(r.engine === "ffmpeg" ? `成片已导出：${r.path}` : "浏览器降级拼接完成", "ok");
          } catch (e) {
            job.fail(errMsg(e));
            toast(`渲染失败：${errMsg(e)}`, "err");
          } finally {
            setRendering(false);
            setProg(null);
          }
          void id;
        })();
      },
    });
  };

  const doProbe = async () => {
    const job = jobCenter.begin({ projectId: project.id, kind: "analyze", label: "成片质量探测" });
    try {
      const { problems } = await probeApprovedTakes(project.id, (d, t) => job.stage(`质量探测 ${d}/${t}`, (d / t) * 100));
      job.done(problems ? `发现 ${problems} 个问题` : "全部通过");
      toast(problems ? `发现 ${problems} 个问题（左侧问题列表）` : "质量检查全部通过 ✓", problems ? "info" : "ok");
    } catch (e) {
      job.fail(errMsg(e));
    }
  };

  return (
    <>
      {/* 左：素材/问题列表（点击定位播放头 = 选中片段并跳转） */}
      <DockPanel className="po-left" title={`问题（${issues.length}）`} projectId={project.id} widthKey="poLeft" width={project.studioUi?.panelWidths?.poLeft ?? 240} min={200} max={340}
        headExtra={
          <button className="st-btn sm" style={{ marginLeft: "auto" }} title="对全部采用版本做确定性体检（不自动花钱重跑）" onClick={() => void doProbe()}>
            <IcScan size={11} /> 探测
          </button>
        }
      >
        {issues.length === 0 ? (
          <div className="st-empty" style={{ paddingTop: 40 }}><IcCheck size={22} style={{ color: "var(--ok)" }} /><b>没有发现问题</b>缺片 / 质量探测 / 连续性检查都通过。</div>
        ) : null}
        {issues.map((i, k) => (
          <div key={k} className={`po-issue lv-${i.level}`} title={i.detail} onClick={() => i.segId && setSeg(i.segId)}>
            <IcWarn size={13} style={{ flex: "none", marginTop: 2, color: i.level === "error" ? "var(--danger)" : "var(--warn)" }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12 }}>{i.title}</div>
              <div className="st-hint">{i.detail}</div>
            </div>
          </div>
        ))}
      </DockPanel>

      {/* 中：监看 Stage + 时间线（Chrome） */}
      <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div className="st-stage" style={{ flex: "none", height: 300, minHeight: 220 }}>
          <div className="st-panel-h">
            监看 · 成片预演
            <span className="st-hint" style={{ marginLeft: 8 }}>
              {currentClip ? `${currentClip.segment.summary.slice(0, 24)} · ${(override.inSec ?? 0).toFixed(1)}–${(override.outSec ?? currentClip.durSec).toFixed(1)}s` : "没有采用片段"}
            </span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button className="st-btn sm" disabled={!previewItems.length} title="按时间线顺序预演（入出点与导出同源；转场仅导出生效）" onClick={() => useUi.getState().setSeqPreview(previewItems)}>
                <IcPlay size={11} /> 顺序预演
              </button>
            </div>
          </div>
          <div className="h3-monitor">
            {currentAsset?.kind === "video" ? (
              <video src={assetUrl(currentAsset.path)} controls loop style={{ maxHeight: "100%" }} />
            ) : currentAsset ? (
              <img src={assetUrl(currentAsset.path)} alt="" />
            ) : (
              <div className="mon-empty">
                <IcFilmFrame size={30} />
                <b>还没有成片画面</b>
                <span>在 H3 导演台采用 Take 后，片段会按故事顺序进入这条时间线。</span>
              </div>
            )}
          </div>
        </div>
        {/* 多轨时间线（V1/T1/D1/N1/S1/A1/M1/SUB） */}
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "var(--studio-panel)" }}>
          <PostTimeline project={project} />
          <AudioSetup project={project}/>
          <div style={{ display: "flex", gap: 0, borderTop: "1px solid var(--studio-border)" }}>
            <div style={{ flex: 1, minWidth: 0 }}>{tab !== "props" ? <AudioMixer project={project} /> : null}</div>
            <div style={{ flex: 1, minWidth: 0 }}>{tab !== "props" ? <SubtitleEditor project={project} /> : null}</div>
          </div>
        </div>
      </section>

      {/* 右：属性 / 混音 / 字幕 / 导出 */}
      <DockPanel className="po-right" title="属性与交付" projectId={project.id} widthKey="poRight" width={project.studioUi?.panelWidths?.poRight ?? 300}>
        <div className="st-context" style={{ padding: "0 10px" }}>
          {(["props", "mix"] as const).map((t) => (
            <button key={t} className={`st-btn sm${tab === t ? " primary" : ""}`} onClick={() => setTab(t)}>
              {t === "props" ? "片段属性" : "混音与字幕"}
            </button>
          ))}
        </div>
        {tab === "props" && currentClip ? (
          <>
            <InspectorGroup title="入出点与转场" open onToggle={() => {}}>
              <div className="st-row">
                <div className="st-field" style={{ flex: 1 }}>
                  <label>入点（秒）</label>
                  <input className="st-input" type="number" step="0.1" min={0} value={override.inSec ?? 0}
                    onChange={(e) => patchClipOverride(project.id, currentClip.segment.id, { inSec: Math.max(0, Number(e.target.value) || 0) })} />
                </div>
                <div className="st-field" style={{ flex: 1 }}>
                  <label>出点（秒）</label>
                  <input className="st-input" type="number" step="0.1" value={override.outSec ?? currentClip.durSec}
                    onChange={(e) => patchClipOverride(project.id, currentClip.segment.id, { outSec: Number(e.target.value) || currentClip.durSec })} />
                </div>
              </div>
              <div className="st-field">
                <label>与下一段的转场</label>
                <PopSelect
                  value={override.transition ?? "cut"}
                  onChange={(v) => patchClipOverride(project.id, currentClip.segment.id, { transition: v as "cut" | "fade" })}
                  triggerIcon
                  options={[opt("cut", "硬切", SI.cut), opt("fade", "交叉淡化", SI.join)]}
                />
              </div>
            </InspectorGroup>
            <InspectorGroup title="变换（进预演与 MP4）" open onToggle={() => {}}>
              <div className="st-row" style={{ gap: 10 }}>
                <label className="st-hint" style={{ display: "flex", gap: 5, alignItems: "center" }}>
                  <input type="checkbox" checked={!!override.flipH} onChange={(e) => patchClipOverride(project.id, currentClip.segment.id, { flipH: e.target.checked || undefined })} />
                  水平镜像
                </label>
                <label className="st-hint" style={{ display: "flex", gap: 5, alignItems: "center" }}>
                  <input type="checkbox" checked={!!override.flipV} onChange={(e) => patchClipOverride(project.id, currentClip.segment.id, { flipV: e.target.checked || undefined })} />
                  垂直镜像
                </label>
              </div>
              <div className="st-field">
                <label>旋转</label>
                <PopSelect
                  value={String(override.rotate ?? 0)}
                  onChange={(v) => patchClipOverride(project.id, currentClip.segment.id, { rotate: Number(v) as 0 | 90 | 180 | 270 })}
                  triggerIcon
                  options={[0, 90, 180, 270].map((d) => ({ value: String(d), label: d ? `${d}°` : "不旋转", icon: SI.rotate }))}
                />
              </div>
            </InspectorGroup>
            <InspectorGroup title="原声" open onToggle={() => {}}>
              <div className="st-field">
                <label>片段原声音量（{Math.round((override.volume ?? 1) * 100)}%）</label>
                <input type="range" min={0} max={1.5} step={0.05} value={override.volume ?? 1} style={{ width: "100%" }}
                  onChange={(e) => patchClipOverride(project.id, currentClip.segment.id, { volume: Number(e.target.value) })} />
              </div>
              <label className="st-hint" style={{ display: "flex", gap: 5, alignItems: "center" }}>
                <input type="checkbox" checked={!!override.muted} onChange={(e) => patchClipOverride(project.id, currentClip.segment.id, { muted: e.target.checked || undefined })} />
                静音本段原声
              </label>
            </InspectorGroup>
          </>
        ) : null}
        {tab === "props" && !currentClip ? <div className="st-empty"><b>时间线还没有片段</b></div> : null}

        <div className="st-group">
          <div className="st-group-h" style={{ cursor: "default" }}>交付导出</div>
          <div className="st-group-b">
            <div className="st-field">
              <label>输出预设</label>
              <PopSelect
                value={preset}
                triggerIcon
                options={EXPORT_PRESETS.map((p) => ({ value: p.id, label: p.label, icon: <IcVideo size={14} /> }))}
                onChange={(v) => setPreset(String(v))}
              />
            </div>
            <span className="st-hint">{plan.plan.width}×{plan.plan.height} · {plan.plan.clips.length} 段 · {plan.plan.totalSec.toFixed(0)}s</span>
            <button className="st-btn sm" title="导入 .momoproject 项目包（资产按指纹去重复用；自动在画布创建导演台节点挂载）" onClick={() => void doImportPack()}>
              <IcFolder size={12} /> 导入项目包
            </button>
            {rendering ? (
              <div className="st-row">
                <span className="st-hint" style={{ flex: 1 }}><IcLoading size={12} /> {prog?.msg}{prog?.pct !== undefined ? ` ${Math.round(prog.pct)}%` : ""}</span>
                <button className="st-btn sm" title="取消渲染（不影响已有成片）" onClick={() => renderTaskRef.current && void cancelRender(renderTaskRef.current)}>
                  <IcStop size={11} />
                </button>
              </div>
            ) : (
              <button className="st-btn primary" onClick={doRender}>
                <IcDownload size={13} /> 导出 MP4
              </button>
            )}
            <button
              className="st-btn sm"
              title="探测本机 ffmpeg（正式渲染引擎）"
              onClick={async () => {
                const r = await locateFfmpeg();
                setFfOk(!!r.ffmpeg);
                toast(r.ffmpeg ? `ffmpeg 已就绪：${r.ffmpeg}` : "未找到 ffmpeg——winget install ffmpeg，或在设置里指定路径", r.ffmpeg ? "ok" : "err");
              }}
            >
              {ffOk === true ? <IcCheck size={12} /> : ffOk === false ? <IcWarn size={12} /> : <IcScan size={12} />}
              {ffOk === true ? " ffmpeg 就绪" : ffOk === false ? " ffmpeg 缺失" : " 检测 ffmpeg"}
            </button>
            {isTauri ? (
              <button className="st-btn sm" title="导出 .momoproject 项目包（项目数据 + 素材 + 模板，不含 API Key）"
                onClick={() => void exportProjectPackage(project).then((r) => toast(`项目包已导出：${r.dir}`, "ok")).catch((e) => toast(errMsg(e), "err"))}>
                <IcFolder size={12} /> 项目包
              </button>
            ) : null}
            {isTauri && <div className="st-row" style={{flexWrap:"wrap"}}><button className="st-btn sm" disabled={exportBusy} onClick={()=>void exportEditor("premiere")}>{exportBusy?"导出中…":"PR 工程"}</button><button className="st-btn sm" disabled={exportBusy} onClick={()=>void exportEditor("jianying")}>剪映草稿</button><button className="st-btn sm" disabled={exportBusy} onClick={()=>void chooseEditingPython().catch(e=>toast(errMsg(e),"err"))}>剪映环境</button></div>}
          </div>
        </div>
        <div className="st-group">
          <div className="st-group-h" style={{ cursor: "default" }}>
            <IcRotate size={12} /> 交付说明
          </div>
          <div className="st-group-b">
            <span className="st-hint" style={{ lineHeight: 1.7 }}>
              预演与导出共用同一份时间线数据：入出点、转场、镜像/旋转、音量与字幕全部真实进入 MP4。
              缺片片段不进入成片，可在左侧问题列表点击定位。
            </span>
          </div>
        </div>
      </DockPanel>

      {ask ? (
        <AskCard
          text={ask.text}
          okText="开始导出"
          onCancel={() => setAsk(null)}
          onConfirm={() => {
            const run = ask.run;
            setAsk(null);
            run();
          }}
        />
      ) : null}
    </>
  );
}
