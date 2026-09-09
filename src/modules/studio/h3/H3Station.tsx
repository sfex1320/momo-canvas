import {H3AuthoringPanel} from "./H3AuthoringPanel";
import { LocalRevisionPanel } from "./LocalRevisionPanel";
/**
 * H3 导演台 — 主工位（导演台 3.0 · 方案 §6.5）
 *
 * 三栏：场景/片段树 │ 暗色制作舞台 │ 当前片段检查器
 *  - 片段树：场景分组、缩略图、状态徽标（缺分镜→已采用→来源过期）、搜索与状态筛选；
 *  - 舞台（连续暗色 Stage）：监看器（采用 Take > 最新成功 > 分镜图 > 明确空态；生成中不闪空）
 *    + 控制条 + Take 条 + 22 帧微参考条 + 本段音频条；
 *  - 检查器四个稳定分组：导演描述 / 提示词（结构化来源 + 实际请求 + 差异）/ 角色与参考
 *    （复用 SegmentRefEditor，真实 <Picture/Video/Audio N> 编号）/ 生成（配方·时长·批量）。
 * 生成/采用/批量/停止全部接回现有队列（runBatch / approveTake / stopBatchHard，§11.1）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useDirector } from "../../../core/stores/directorStore";
import { SEG_STATUS_ICONS, SI, opt } from "../shared/selectIcons";
import { useAssets } from "../../../core/stores/assetStore";
import { useComfy } from "../../../core/stores/comfyStore";
import { useDirectorCtx, monitorTake } from "../../../core/directorContext";
import { approveTake, removeSegment, removeTake } from "../../../core/directorEngine";
import { precheckBatch } from "../../../core/directorPrecheck";
import { runBatch, stopBatchHard, cancelBatch, previewSegmentPrompt, collectBatchTasks, runBatchUpscale } from "../../../core/directorQueue";
import { refineSegmentPrompts, analyzeSegmentsWithLLM, unrefinedSegments } from "../../../core/directorEngine";
import { exportH3Package } from "../../../core/directorPackageExport";
import { importCatalogFromDirectory, importCatalogFromFileList, catalogSourceNote } from "../../../core/directorAssetCatalog";
import { directorReferenceSupport } from "../../../core/directorRecipeSupport";
import { createAudioTrack, generateAudioTrack } from "../../../core/directorExport";
import { assetToBlobUrl, assetUrl } from "../../../core/services/assetFiles";
import { SEGMENT_STATUS_LABEL, type ObjectIndex, type SegmentStatus } from "../../../core/studio/objectIndex";
import { clampDuration, profileForRecipe, recipeCapabilityNote } from "../../../core/studio/capabilityProfile";
import { resolveVideoSpec } from "../../../core/studio/videoSpec";
import { specCapabilityFor } from "../../../core/studio/specCapability";
import { resolveModelCard } from "../../../core/stores/settingsStore";
import { ensureMicroReference, microRefLabel, prevSegmentOf } from "../../../core/studio/microRef";
import { useUi } from "../../../core/stores/uiStore";
import { errMsg } from "../../../core/utils";
import { DockPanel, InspectorGroup } from "../shared/DockPanel";
import { SkillBindingCard } from "../shared/SkillBindingCard";
import { RecipeSelect } from "../../director/RecipeSelect";
import { SegmentRefEditor } from "../../director/SegmentRefEditor";
import { AskCard } from "../../director/AskCard";
import { BatchSwitches } from "../../director/BatchSwitches";
import { PopSelect, PopLayer } from "../../../ui/PopSelect";
import { Thumb } from "../../../ui/Thumb";
import {
  IcPlay, IcStop, IcArrowL, IcArrowR, IcRefresh, IcCheck, IcLoading, IcSearch, IcMusic,
  IcLink, IcVideo, IcTimer, IcClose, IcSparkles,
} from "../../../ui/icons";
import type { ContinuityCapsule, DirectorProject, DirectorSegment } from "../../../core/types";

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "approved", label: "已采用" },
  { value: "pending", label: "待采用" },
  { value: "running", label: "生成中" },
  { value: "failed", label: "失败" },
  { value: "missing", label: "缺分镜" },
  { value: "stale", label: "来源过期" },
];

export function H3Station({ project, index }: { project: DirectorProject; index: ObjectIndex }) {
  const ctx = useDirectorCtx();
  const patchSegment = useDirector((s) => s.patchSegment);
  const updateProject = useDirector((s) => s.updateProject);
  const assets = useAssets((s) => s.items);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [playPulse, setPlayPulse] = useState(0);
  const [busy, setBusy] = useState(false);
  const [batchInfo, setBatchInfo] = useState<{ done: number; total: number; msg?: string } | null>(null);
  const ui = project.studioUi;

  const segView = ctx.segId ? index.byId.get(ctx.segId) : undefined;
  const seg = segView?.segment ?? index.segments[0]?.segment;

  /* ---------- 片段树过滤 ---------- */
  const filtered = useMemo(() => {
    const kw = q.trim();
    return index.segments.filter((v) => {
      if (kw && !(v.segment.summary.includes(kw) || v.scene.location.includes(kw))) return false;
      switch (filter) {
        case "approved": return v.status === "approved";
        case "pending": return v.status === "pending";
        case "running": return v.status === "running" || v.status === "queued";
        case "failed": return v.status === "failed";
        case "missing": return v.status === "empty" || v.status === "no-refs";
        case "stale": return v.status === "stale";
        default: return true;
      }
    });
  }, [index.segments, q, filter]);

  /* ---------- 生成 / 采用 / 停止（接回现有队列） ---------- */

  // 生成前预检状态（远程计费等需要确认的场景）
  const [ask, setAsk] = useState<{ text: React.ReactNode; run: () => void } | null>(null);

  /** 生成前预检（§9.4 合同：只阻止受影响片段）。ComfyUI 离线只过滤本地片段（远程照常）；
   *  片段级 blocker 过滤后不送跑；远程计费弹卡确认。run 收到 (ids, excludeIds)。 */
  const runWithPrecheck = async (
    op: "selected" | "missing" | "failed",
    ids: string[] | undefined,
    run: (ids: string[] | undefined, excludeIds?: string[]) => Promise<void>,
  ) => {
    let pre;
    try {
      pre = await precheckBatch(project, op, ids);
    } catch (e) {
      useUi.getState().toast?.(errMsg(e), "err");
      return;
    }
    const segBlockers = pre.issues.filter((i) => i.level === "blocker" && i.scope === "segment");
    const projectBlockers = pre.issues.filter((i) => i.level === "blocker" && i.scope === "project");
    const blocked = pre.blockedSegIds;
    const effective = op === "selected" ? (ids ?? []).filter((id) => !blocked.has(id)) : undefined;
    // 全军覆没才整体拦截（合同：部分受影响只过滤部分）
    if (op === "selected" && effective?.length === 0) {
      useUi.getState().toast?.(`预检拦截：${projectBlockers[0]?.message ?? segBlockers[0]?.message ?? "所选片段均未通过预检"}`, "err");
      return;
    }
    if (op !== "selected" && blocked.size >= collectBatchTasks(project, op, ids).length) {
      useUi.getState().toast?.(`预检拦截：${projectBlockers[0]?.message ?? "全部片段未通过预检"}`, "err");
      return;
    }
    const exclude = blocked.size ? [...blocked] : undefined;
    const billing = pre.issues.find((i) => i.level === "warn" && i.message.includes("远程计费"));
    if (billing) {
      setAsk({
        text: (
          <>
            {pre.summary}
            {blocked.size ? <div className="st-hint" style={{ marginTop: 4 }}>⚠ {blocked.size} 个片段未通过预检（本地引擎不可用等），将自动跳过。</div> : null}
            <div className="st-hint" style={{ marginTop: 4 }}>{billing.message}；确认后开始提交任务。</div>
          </>
        ),
        run: () => void run(effective, exclude),
      });
      return;
    }
    if (blocked.size) useUi.getState().toast?.(`预检：${blocked.size} 个片段未通过（本地引擎不可用等），已跳过；其余照常生成`, "info");
    await run(effective, exclude);
  };

  const generateCurrent = async () => {
    if (!seg || busy) return;
    setBusy(true);
    try {
      await runWithPrecheck("selected", [seg.id], async (ids, exclude) => {
        setBatchInfo({ done: 0, total: ids?.length ?? 1 });
        try {
          const r = await runBatch(
            project.id,
            "selected",
            ids,
            (done, total, current, detail) => setBatchInfo({ done, total, msg: detail?.msg ?? current }),
            exclude,
          );
          if (r.failed) useUi.getState().toast?.(`生成失败 ${r.failed} 段，详见任务中心`, "err");
        } catch (e) {
          useUi.getState().toast?.(errMsg(e), "err");
        } finally {
          setBusy(false);
          setTimeout(() => setBatchInfo(null), 1200);
        }
      });
    } finally {
      setBusy(false);
    }
  };
  const batchMissing = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await runWithPrecheck("missing", undefined, async (ids, exclude) => {
        try {
          await runBatch(
            project.id,
            "missing",
            ids,
            (done, total, current, detail) => setBatchInfo({ done, total, msg: detail?.msg ?? current }),
            exclude,
          );
        } finally {
          setBusy(false);
          setTimeout(() => setBatchInfo(null), 1200);
        }
      });
    } finally {
      setBusy(false);
    }
  };

  const missingCount = useMemo(() => collectBatchTasks(project, "missing").length, [project]);
  const failedCount = useMemo(() => collectBatchTasks(project, "failed").length, [project]);
  const skillBound = (project.skillBindings ?? []).some((b) => b.enabled);
  const unrefinedCount = useMemo(() => unrefinedSegments(project).length, [project]);
  const batchRef = useRef<HTMLDivElement>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [upscaleTpl, setUpscaleTpl] = useState("");

  /** 批量工具（本地 ComfyUI 主线，3.0 回归）：重跑失败 / 提示词精炼 / 高清放大 */
  const doFailed = async () => {
    setBatchOpen(false);
    if (busy) return;
    setBusy(true);
    try {
      await runWithPrecheck("failed", undefined, async (ids, exclude) => {
        setBatchInfo({ done: 0, total: failedCount });
        try {
          await runBatch(project.id, "failed", ids, (done, total, current, detail) => setBatchInfo({ done, total, msg: detail?.msg ?? current }), exclude);
        } finally {
          setBusy(false);
          setTimeout(() => setBatchInfo(null), 1200);
        }
      });
    } finally {
      setBusy(false);
    }
  };
  const doRefine = async () => {
    setBatchOpen(false);
    setBusy(true);
    setBatchInfo({ done: 0, total: index.segments.length });
    try {
      const r = await refineSegmentPrompts(project.id, undefined, (done, total) => setBatchInfo({ done, total, msg: "Skill 精炼提示词" }));
      if (!r.ok && !r.failed && r.skipped) useUi.getState().toast?.(`${r.skipped} 段均为成品直录（已锁定），无需精炼`, "info");
      else useUi.getState().toast?.(`精炼完成：成功 ${r.ok}${r.failed ? `，失败 ${r.failed}` : ""}${r.skipped ? `，跳过 ${r.skipped}（锁定）` : ""}`, r.failed ? "info" : "ok");
    } catch (e) {
      useUi.getState().toast?.(errMsg(e), "err");
    } finally {
      setBusy(false);
      setTimeout(() => setBatchInfo(null), 1500);
    }
  };
  const doUpscale = async () => {
    if (!upscaleTpl) return;
    setBatchOpen(false);
    setBusy(true);
    setBatchInfo({ done: 0, total: 0, msg: "高清放大（后处理）" });
    try {
      const override = project.upscaleParams?.[upscaleTpl];
      const r = await runBatchUpscale(project.id, upscaleTpl, (done, total, name) => setBatchInfo({ done, total, msg: `放大 ${name}` }), override);
      useUi.getState().toast?.(`放大完成 ${r.done} 段${r.failed ? `，失败 ${r.failed}` : ""}`, r.failed ? "info" : "ok");
    } catch (e) {
      useUi.getState().toast?.(errMsg(e), "err");
    } finally {
      setBusy(false);
      setTimeout(() => setBatchInfo(null), 1500);
    }
  };
  /** AI 精读分段：规则切段产物（无镜头/对白结构）逐段提取摘要/时长/对白/镜头 */
  const doReadAll = async () => {
    setBatchOpen(false);
    setBusy(true);
    setBatchInfo({ done: 0, total: index.segments.length });
    try {
      const r = await analyzeSegmentsWithLLM(project.id, undefined, (done, total) => setBatchInfo({ done, total, msg: "AI 精读分段" }));
      if (!r.ok && !r.failed) useUi.getState().toast?.(`没有需要精读的片段（${r.skipped} 段已有内容或已锁定）`, "info");
      else useUi.getState().toast?.(`精读完成：成功 ${r.ok}${r.failed ? `，失败 ${r.failed}` : ""}${r.skipped ? `，跳过 ${r.skipped}` : ""}`, r.failed ? "info" : "ok");
    } catch (e) {
      useUi.getState().toast?.(errMsg(e), "err");
    } finally {
      setBusy(false);
      setTimeout(() => setBatchInfo(null), 1500);
    }
  };
  /** 双语资产册绑定（MOMO_ASSET_CATALOG_V1）：Tauri 目录选择，浏览器走文件列表降级 */
  const doCatalog = async () => {
    setBatchOpen(false);
    const handled = await importCatalogFromDirectory(project.id);
    if (!handled) catalogInputRef.current?.click();
  };
  const catalogInputRef = useRef<HTMLInputElement>(null);
  const [pkgAsk, setPkgAsk] = useState(false);
  const [pkgEn, setPkgEn] = useState(true);
  const [pkgBusy, setPkgBusy] = useState(false);
  const doExportPkg = async () => {
    setPkgAsk(false);
    setPkgBusy(true);
    setBusy(true);
    try {
      await exportH3Package(project.id, { withEn: pkgEn });
    } catch {
      /* 已在导出内 toast */
    } finally {
      setPkgBusy(false);
      setBusy(false);
    }
  };

  return (
    <>
      {/* 左：场景/片段树（§6.5） */}
      <DockPanel
        className="h3-left"
        title="片段"
        projectId={project.id}
        widthKey="h3Left"
        width={ui?.panelWidths?.h3Left ?? 250}
        min={200}
        max={360}
        headExtra={
          <div ref={batchRef} style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            {missingCount ? (
              <button className="st-btn sm primary" title={`补齐 ${missingCount} 个缺片段（批量生成）`} disabled={busy} onClick={batchMissing}>
                补缺 {missingCount}
              </button>
            ) : null}
            {index.segments.length ? (
              <button className="st-btn sm" title="批量工具：重跑失败 / Skill 精炼提示词 / 高清放大（本地 ComfyUI 主线）" disabled={busy} onClick={() => setBatchOpen((v) => !v)}>
                批量
              </button>
            ) : null}
            {batchOpen ? (
              <PopLayer anchorRef={batchRef} onClose={() => setBatchOpen(false)} className="st-batch-menu">
                <button className="st-btn sm ghost" disabled={!failedCount} title="重跑全部失败的片段（单段失败不阻断其他）" onClick={() => void doFailed()}>
                  重跑失败{failedCount ? `（${failedCount}）` : ""}
                </button>
                <button className="st-btn sm ghost" disabled={!skillBound} title={skillBound ? `用项目绑定的提示词 Skill（如 H3 Prompt）批量精炼全部分镜；锁定段自动跳过${unrefinedCount ? `；当前 ${unrefinedCount} 段还没有英文执行稿` : ""}` : "先在下方「Skill 栈」绑定提示词 Skill（如 MiniMax H3 Prompt）"} onClick={() => void doRefine()}>
                  Skill 精炼提示词{unrefinedCount ? `（${unrefinedCount} 段未精炼）` : ""}
                </button>
                <button className="st-btn sm ghost" title="规则切段产物的片段逐段调对话模型，提取摘要/时长/对白/镜头结构" onClick={() => void doReadAll()}>
                  AI 精读分段
                </button>
                <button
                  className="st-btn sm ghost"
                  title={`导入双语资产册（资产提示词.md / 全部素材）：媒体按指纹只收录一次，图片/视频/音频按「使用分段」绑定参考槽，对白/旁白/音乐另入混音轨${catalogSourceNote(project) ? `；当前来源 ${catalogSourceNote(project)}` : ""}`}
                  onClick={() => void doCatalog()}
                >
                  资产册绑定…
                </button>
                <div className="st-row" style={{ padding: "2px 0" }}>
                  <PopSelect
                    value={upscaleTpl}
                    onChange={(v) => setUpscaleTpl(String(v))}
                    triggerIcon
                    options={[opt("", "选择放大模板…", SI.flow), ...useComfy.getState().templates.map((t) => ({ value: t.id, label: t.name, icon: SI.image }))]}
                  />
                  <button className="st-btn sm" disabled={!upscaleTpl || busy} title="对全部采用版本跑高清放大（后处理；参数覆盖存项目，成片页可改）" onClick={() => void doUpscale()}>
                    高清放大
                  </button>
                </div>
                <button
                  className="st-btn sm ghost"
                  title="导出 h3-script-package 规范的双语项目包目录（完整剧本 / 资产册 / 分段资产库 / 中英分段剧本 + 校验报告）；导出前跑包校验"
                  disabled={busy || !index.segments.length}
                  onClick={() => {
                    setBatchOpen(false);
                    setPkgAsk(true);
                  }}
                >
                  导出 H3 项目包…
                </button>
                <div className="st-row" style={{ borderTop: "1px solid var(--studio-border)", paddingTop: 6, marginTop: 2 }}>
                  <button className="st-btn sm ghost" title="打开设置 → ComfyUI（服务地址 / 模板管理器 / 显存清理）" onClick={() => { setBatchOpen(false); useUi.getState().openSettings("comfy"); }}>
                    ComfyUI 设置
                  </button>
                  <button className="st-btn sm ghost" title="打开工作流模板管理器（导入 API/前端格式、暴露参数、往返编辑）" onClick={() => { setBatchOpen(false); useUi.getState().setTemplateMgr(true); }}>
                    模板管理器
                  </button>
                </div>
              </PopLayer>
            ) : null}
          </div>
        }
      >
        {/* 浏览器预览的资产册降级入口（webkitdirectory 选目录） */}
        <input
          ref={catalogInputRef}
          type="file"
          // @ts-expect-error webkitdirectory 非标准属性
          webkitdirectory="true"
          directory="true"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void importCatalogFromFileList(project.id, e.target.files);
            e.target.value = "";
          }}
        />
        <div className="st-tree-search">
          <IcSearch size={13} style={{ color: "var(--studio-text-3)", alignSelf: "center" }} />
          <input className="st-input" placeholder="搜索片段 / 场景" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--studio-border)" }}>
          <PopSelect
            value={filter}
            onChange={(v) => setFilter(String(v))}
            triggerIcon
            options={STATUS_FILTERS.map((f) => ({ value: f.value, label: f.label, icon: SEG_STATUS_ICONS[f.value] }))}
          />
        </div>
        {/* 空态分叉：项目没有片段（冷启动引导）vs 有片段但筛选无结果 */}
        {index.segments.length === 0 ? (
          <div className="st-empty">
            <b>项目还没有片段</b>
            <span>先用 AI 导演共创故事，或把剧本导入剧本库后「送入项目」拆分。</span>
            <div className="st-row" style={{ justifyContent: "center" }}>
              <button className="st-btn sm" onClick={() => updateProject(project.id, { studioUi: { ...ui ?? { station: "h3" }, station: "director" } })}>去 AI 导演</button>
              <button className="st-btn sm" onClick={() => updateProject(project.id, { studioUi: { ...ui ?? { station: "h3" }, station: "scripts" } })}>去剧本库</button>
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="st-empty"><b>没有匹配片段</b>试试清空搜索或切回「全部状态」。</div>
        ) : null}
        {filtered.map((v) => {
          const poster = v.posterAssetId ? assets.find((a) => a.id === v.posterAssetId) : undefined;
          return (
            <div
              key={v.segment.id}
              className={`st-seg${seg?.id === v.segment.id ? " on" : ""}`}
              onClick={() => ctx.setSeg(v.segment.id)}
              onDoubleClick={() => {
                ctx.setSeg(v.segment.id);
                setPlayPulse((p) => p + 1);
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && ctx.setSeg(v.segment.id)}
            >
              <div className="st-seg-thumb">
                {poster ? (
                  poster.kind === "video" && poster.thumb ? (
                    <img src={assetUrl(poster.thumb)} alt="" />
                  ) : poster.kind === "image" ? (
                    <Thumb src={assetUrl(poster.path)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : null
                ) : (
                  <IcVideo size={14} />
                )}
              </div>
              <div className="st-seg-main">
                <div className="st-seg-t">
                  {String(v.storyIndex + 1).padStart(2, "0")} {v.segment.summary.slice(0, 18) || "（无摘要）"}
                </div>
                <div className="st-seg-meta">
                  <StatusPill status={v.status} />
                  <span>{v.segment.durationSec}s</span>
                </div>
              </div>
            </div>
          );
        })}
      </DockPanel>

      {/* 中：暗色制作舞台（监看器 + Take 条 + 微参考条 + 音频条） */}
      <MonitorStage
        project={project}
        seg={seg}
        index={index}
        playPulse={playPulse}
        busy={busy}
        batchInfo={batchInfo}
        onGenerate={generateCurrent}
        onStop={() => void stopBatchHard()}
      />

      {pkgAsk || pkgBusy ? (
        <div className="st-diff-mask" onClick={() => !pkgBusy && setPkgAsk(false)}>
          <div className="st-diff" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
            <div className="st-diff-h">导出 H3 项目包{pkgBusy ? " · 导出中…" : ""}</div>
            <div style={{ padding: "14px 16px", fontSize: 12.5, lineHeight: 1.8, color: "var(--studio-text-2)" }}>
              将导出 h3-script-package 规范目录：完整剧本.md · 全部素材（资产册 + 图片）· 分段资产库 · 分段剧本-中{pkgEn ? " · 分段剧本-英（LLM 翻译）" : ""}。
              导出前自动校验（围栏配对 / 空提示词 / 资产编号），问题写入目录内校验报告。
            </div>
            <div className="st-diff-f">
              {pkgBusy ? (
                <span className="st-hint"><IcLoading size={12} /> 正在导出，进度见任务中心…</span>
              ) : (
                <>
                  <label className="st-hint" style={{ display: "flex", gap: 5, alignItems: "center", marginRight: "auto" }}>
                    <input type="checkbox" checked={pkgEn} onChange={(e) => setPkgEn(e.target.checked)} /> 同时生成英文分段剧本
                  </label>
                  <button className="st-btn" onClick={() => setPkgAsk(false)}>取消</button>
                  <button className="st-btn primary" onClick={() => void doExportPkg()}>选择位置并导出</button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* 右：检查器（四个稳定分组） */}
      <Inspector project={project} seg={seg} onGenerate={generateCurrent} busy={busy} patchSegment={patchSegment} updateProject={updateProject} />
          {ask ? (
        <AskCard
          text={ask.text}
          okText="确认开始生成"
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

function StatusPill({ status }: { status: SegmentStatus }) {
  const cls =
    status === "approved" ? "ok" :
    status === "failed" ? "err" :
    status === "stale" || status === "running" || status === "queued" ? "warn" :
    status === "pending" ? "accent" : "";
  return <span className={`st-pill ${cls}`}>{SEGMENT_STATUS_LABEL[status]}</span>;
}

/* ================= 中栏：暗色舞台 ================= */

function MonitorStage({
  project,
  seg,
  index,
  playPulse,
  busy,
  batchInfo,
  onGenerate,
  onStop,
}: {
  project: DirectorProject;
  seg: DirectorSegment | undefined;
  index: ObjectIndex;
  playPulse: number;
  busy: boolean;
  batchInfo: { done: number; total: number; msg?: string } | null;
  onGenerate: () => void;
  onStop: () => void;
}) {
  const ctx = useDirectorCtx();
  const updateProject = useDirector((s) => s.updateProject);
  const assets = useAssets((s) => s.items);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [confirmTake, setConfirmTake] = useState<string | null>(null);

  const take = seg ? monitorTake(seg.takes, seg.approvedTakeId, ctx.takeId) : undefined;
  const running = (seg?.takes ?? []).some((t) => t.status === "running" || t.status === "queued");
  const asset = take?.assetId ? assets.find((a) => a.id === take.assetId) : undefined;
  const isVideo = asset?.kind === "video" || take?.kind === "video";
  const [videoUrl, setVideoUrl] = useState<string>();
  useEffect(() => {
    let on = true;
    setVideoUrl(undefined);
    if (asset?.kind === "video") {
      void assetToBlobUrl(asset.path, asset.mime)
        .then((u) => on && setVideoUrl(u))
        .catch(() => on && setVideoUrl(/^https?:/.test(asset.path) ? asset.path : undefined));
    } else if (asset?.kind === "image") {
      setVideoUrl(assetUrl(asset.path));
    }
    return () => { on = false; };
  }, [asset?.id, asset?.kind, asset?.path, asset?.mime]);

  // 分镜图顺位（§1.2 验收 1：未生成视频时显示分镜图，不闪空）
  const storyboardAsset = useMemo(() => {
    if (asset) return undefined;
    for (const slot of [...(seg?.slots ?? []), ...project.globalSlots]) {
      if (!slot.assetIds.length || slot.relayKind) continue;
      const a = assets.find((x) => x.id === slot.assetIds[0]);
      if (a?.kind === "image") return a;
    }
    return undefined;
  }, [asset, seg, project.globalSlots, assets]);

  useEffect(() => { setTime(0); setPlaying(false); }, [take?.id]);
  useEffect(() => {
    if (!playPulse) return;
    void videoRef.current?.play().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playPulse]);

  const doneTakes = (seg?.takes ?? []).filter((t) => t.status === "done");
  const prev = seg ? prevSegmentOf(project, seg.id) : undefined;
  const capsule = seg ? project.continuityCapsules?.find((c) => c.segmentId === seg.id) : undefined;
  const audioTracks = (project.audioTracks ?? []).filter((t) => t.segmentId === seg?.id);

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}.${String(Math.floor((s % 1) * 30)).padStart(2, "0")}`;

  const step = (dir: -1 | 1) => {
    const i = seg ? index.segments.findIndex((v) => v.segment.id === seg.id) : -1;
    const next = index.segments[i + dir];
    if (next) ctx.setSeg(next.segment.id);
  };

  return (
    <section className="st-stage" style={{ flex: 1 }}>
      <div className="st-panel-h">
        监看
        {seg ? (
          <span className="st-hint" style={{ marginLeft: 8 }}>
            {String((index.segments.find((v) => v.segment.id === seg.id)?.storyIndex ?? 0) + 1).padStart(2, "0")} · {seg.summary.slice(0, 30)}
          </span>
        ) : null}
        {running ? (
          <span className="st-pill warn" style={{ marginLeft: "auto" }}>
            <IcLoading size={11} /> {batchInfo?.msg ?? "生成中…不替换画面"}
          </span>
        ) : null}
      </div>

      {/* 监看器：采用 Take > 最新成功 > 分镜图 > 明确空态 */}
      <div className="h3-monitor">
        {isVideo && videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            loop={ctx.loop}
            muted={ctx.muted}
            playsInline
            onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
        ) : storyboardAsset ? (
          <Thumb src={assetUrl(storyboardAsset.path)} style={{ maxWidth: "80%", maxHeight: "80%" }} />
        ) : index.segments.length === 0 ? (
          /* 冷启动：空项目的监看舞台给「第一步」引导，不让大块黑色显得无意义 */
          <div className="mon-empty">
            <IcVideo size={36} />
            <b>从故事开始你的影片</b>
            <span>这里是监看舞台：生成的片段会按「采用 Take → 最新成功 → 分镜图」的顺位在这里预览。</span>
            <div className="st-row" style={{ gap: 8, marginTop: 6 }}>
              <button
                className="st-btn sm"
                style={{ background: "rgba(255,255,255,0.1)", borderColor: "rgba(255,255,255,0.18)", color: "#e6eaf2" }}
                title="和 AI 共创故事梗概、角色与分段方案"
                onClick={() => updateProject(project.id, { studioUi: { ...(project.studioUi ?? { station: "h3" }), station: "director" } })}
              >
                AI 导演共创
              </button>
              <button
                className="st-btn sm"
                style={{ background: "rgba(255,255,255,0.1)", borderColor: "rgba(255,255,255,0.18)", color: "#e6eaf2" }}
                title="导入剧本文件 / 三态识别后拆分成片段"
                onClick={() => updateProject(project.id, { studioUi: { ...(project.studioUi ?? { station: "h3" }), station: "scripts" } })}
              >
                导入剧本
              </button>
            </div>
          </div>
        ) : (
          <div className="mon-empty">
            <IcVideo size={36} />
            <b>本段还没有画面</b>
            <span>补齐参考素材后点下方「生成」，或先在 AI 制图 / 3D 预演产出分镜图。</span>
          </div>
        )}
        {running && asset ? (
          <div className="mon-overlay">
            <IcLoading size={12} /> 正在重新生成（监看保持上一版本）
          </div>
        ) : null}
      </div>

      {/* 控制条 */}
      <div className="h3-mon-ctrl">
        <button className="st-iconbtn" title="上一片段" onClick={() => step(-1)}><IcArrowL size={16} /></button>
        <button
          className="st-iconbtn"
          title="播放 / 暂停（空格）"
          onClick={() => {
            const v = videoRef.current;
            if (!v) return;
            if (v.paused) void v.play().catch(() => {});
            else v.pause();
          }}
        >
          {playing ? <IcStop size={16} /> : <IcPlay size={16} />}
        </button>
        <button className="st-iconbtn" title="下一片段" onClick={() => step(1)}><IcArrowR size={16} /></button>
        <button className={`st-iconbtn${ctx.loop ? " on" : ""}`} title="循环播放" onClick={() => ctx.setLoop(!ctx.loop)}><IcRefresh size={15} /></button>
        <button
          className={`st-iconbtn${ctx.muted ? " on" : ""}`}
          title="静音"
          onClick={() => ctx.setMuted(!ctx.muted)}
        >
          <IcMusic size={15} />
        </button>
        <span className="tcode">{fmt(time)} / {fmt(dur)}</span>
        <button className="st-btn sm" style={{ marginLeft: 10 }} disabled={busy || !seg} title={seg ? "生成本段（配方与参数在右侧检查器）" : "项目还没有片段——先到剧本库送入项目"} onClick={onGenerate}>
          {running ? <IcLoading size={12} /> : <IcPlay size={12} />} 生成
        </button>
        {running ? (
          <button className="st-btn sm" style={{ marginLeft: 10 }} title="立即中断在途生成 + 停 ComfyUI 队列并清显存（远程已提交计费部分无法撤销）" onClick={onStop}>
            停止
          </button>
        ) : null}
        {take && !take.approved ? (
          <button className="st-btn sm" style={{ marginLeft: 10 }} title="采用当前 Take（进入时间线，并为下一段提取末 22 帧微参考）" onClick={() => seg && approveTake(project.id, seg.id, take.id)}>
            <IcCheck size={13} /> 采用
          </button>
        ) : null}
        {batchInfo ? (
          <span className="st-hint" style={{ marginLeft: 10 }}>
            {batchInfo.done}/{batchInfo.total} {batchInfo.msg ? `· ${batchInfo.msg}` : ""}
          </span>
        ) : null}
      </div>

      {seg && take?.assetId && isVideo && <LocalRevisionPanel key={`${project.id}:${seg.id}:${take.id}`} project={project} segment={seg} take={take} time={time} duration={dur}/>}
      {/* Take 条（§6.5：缩略图、版本号、耗时、采用、对比） */}
      <div className="h3-takes" style={{ display: doneTakes.length ? undefined : "none" }}>
        {doneTakes.map((t, i) => {
          const a = t.assetId ? assets.find((x) => x.id === t.assetId) : undefined;
          const dur = t.startedAt && t.finishedAt ? ((t.finishedAt - t.startedAt) / 1000).toFixed(0) : null;
          return (
            <div key={t.id} className={`h3-take${take?.id === t.id ? " on" : ""}`} onClick={() => ctx.setTake(t.id)} title={t.error ?? t.promptSnapshot.slice(0, 120)}>
              <div className="tk-thumb">
                {a?.thumb ? <img src={assetUrl(a.thumb)} alt="" /> : a?.kind === "image" ? <Thumb src={assetUrl(a.path)} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
                {t.approved ? <span className="st-pill ok" style={{ position: "absolute", left: 3, top: 3 }}>采用</span> : null}
              </div>
              <div className="tk-row">
                <b>Take {i + 1}</b>
                {dur ? <span className="grow">{dur}s</span> : <span className="grow" />}
                <button
                  className="st-iconbtn"
                  style={{ width: 24, height: 24 }}
                  title={t.approved ? "取消采用（版本保留）" : "采用此版本"}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!seg) return;
                    if (t.approved) {
                      // 取消采用：清采用标记回未选片（版本保留）
                      const scenes = project.scenes.map((s) => ({
                        ...s,
                        segments: s.segments.map((g) =>
                          g.id === seg.id ? { ...g, approvedTakeId: null, takes: (g.takes ?? []).map((x) => ({ ...x, approved: false })) } : g,
                        ),
                      }));
                      updateProject(project.id, { scenes });
                    } else {
                      approveTake(project.id, seg.id, t.id);
                    }
                  }}
                >
                  <IcCheck size={12} style={{ color: t.approved ? "var(--ok)" : undefined }} />
                </button>
                <button
                  className="st-iconbtn"
                  style={{ width: 24, height: 24, color: confirmTake === t.id ? "var(--danger)" : undefined }}
                  title={confirmTake === t.id ? "再点一次确认删除此版本" : "删除此版本（素材文件保留在资产库）"}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!seg) return;
                    if (confirmTake !== t.id) {
                      setConfirmTake(t.id);
                      window.setTimeout(() => setConfirmTake((v) => (v === t.id ? null : v)), 2500);
                      return;
                    }
                    setConfirmTake(null);
                    removeTake(project.id, seg.id, t.id);
                  }}
                >
                  <IcClose size={12} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* 22 帧微参考条（§6.5 闭环：来源 · 预览 · 过期 · 重建） */}
      <MicroRefStrip project={project} seg={seg} capsule={capsule} hasPrev={!!prev} />

      {/* 本段音频条（对白 / 旁白 / 音效位置） */}
      <div className="h3-audio">
        {audioTracks.length === 0 ? (
          <div className="h3-audio-track" style={{ opacity: 0.7 }}>
            <IcMusic size={12} />
            本段暂无音频——在检查器「导演描述」里添加对白/旁白后可生成 TTS
          </div>
        ) : (
          audioTracks.slice(0, 3).map((t) => {
            const a = t.assetId ? assets.find((x) => x.id === t.assetId) : undefined;
            return (
              <div className="h3-audio-track" key={t.id} title={`${t.kind} · ${t.text.slice(0, 60)}`}>
                <span className={`st-pill ${t.kind === "dialogue" ? "accent" : ""}`}>{t.kind === "dialogue" ? "对白" : t.kind === "narration" ? "旁白" : t.kind === "sfx" ? "音效" : t.kind === "music" ? "音乐" : "环境"}</span>
                <span className="grow" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{t.text.slice(0, 24)}</span>
                {a ? (
                  <audio className="wv" src={assetUrl(a.path)} controls style={{ height: 22 }} />
                ) : (
                  <span className="st-hint">未生成</span>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

/* 22 帧微参考条：显示来源、可预览、过期可重建（§6.5） */
function MicroRefStrip({
  project,
  seg,
  capsule,
  hasPrev,
}: {
  project: DirectorProject;
  seg: DirectorSegment | undefined;
  capsule: ContinuityCapsule | undefined;
  hasPrev: boolean;
}) {
  const assets = useAssets((s) => s.items);
  const [busy, setBusy] = useState(false);
  const asset = capsule?.microReferenceAssetId ? assets.find((a) => a.id === capsule.microReferenceAssetId) : undefined;
  const [blobUrl, setBlobUrl] = useState<string>();
  useEffect(() => {
    let on = true;
    if (asset?.kind === "video") {
      void assetToBlobUrl(asset.path, asset.mime).then((u) => on && setBlobUrl(u)).catch(() => {});
    }
    return () => { on = false; };
  }, [asset?.id, asset?.kind, asset?.path, asset?.mime]);

  if (!seg || !hasPrev) return null;
  const rebuild = async () => {
    setBusy(true);
    try {
      await ensureMicroReference(project.id, seg.id, { force: true });
    } catch (e) {
      useUi.getState().toast?.(`微参考重建失败：${errMsg(e)}`, "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h3-microstrip">
      <IcLink size={13} />
      <b>22 帧微参考</b>
      {capsule?.stale ? <span className="mr-stale">来源已过期（上游换了采用版本）</span> : null}
      {asset && blobUrl ? (
        <>
          <span className="st-hint">{microRefLabel(project, capsule)}</span>
          <div className="mr-clip" title="点击预览微参考（末 22 帧连续画面）">
            <video src={blobUrl} muted loop autoPlay playsInline style={{ display: "block" }} />
          </div>
        </>
      ) : (
        <span className="st-hint">尚未提取</span>
      )}
      <button className="st-btn sm" style={{ marginLeft: "auto" }} disabled={busy} title="从上一段采用 Take 的稳定结尾重取末 22 帧（FFmpeg；浏览器预览降级截取）" onClick={rebuild}>
        {busy ? <IcLoading size={12} /> : null}
        {asset ? "重取" : "提取"}
      </button>
    </div>
  );
}

/* ================= 右栏：检查器四分组 ================= */

function Inspector({
  project,
  seg,
  onGenerate,
  busy,
  patchSegment,
  updateProject,
}: {
  project: DirectorProject;
  seg: DirectorSegment | undefined;
  onGenerate: () => void;
  busy: boolean;
  patchSegment: ReturnType<typeof useDirector.getState>["patchSegment"];
  updateProject: ReturnType<typeof useDirector.getState>["updateProject"];
}) {
  const ui = project.studioUi;
  const open = (k: string) => ui?.inspectorOpen?.[k] ?? true;
  const toggle = (k: string) =>
    updateProject(project.id, {
      studioUi: { ...(ui ?? { station: "h3" }), inspectorOpen: { ...(ui?.inspectorOpen ?? {}), [k]: !open(k) } },
    });
  const [promptPreview, setPromptPreview] = useState<string>();
  const [promptView, setPromptView] = useState<"zh" | "en" | "both" | "req">("zh");
  const [zhBusy, setZhBusy] = useState(false);
  const [ask, setAsk] = useState<{ text: React.ReactNode; run: () => void } | null>(null);
  const recipe = project.recipes.find((r) => r.id === (seg?.recipeId ?? project.defaultRecipeId));
  const comfyTemplates = useComfy((s) => s.templates); // 订阅式：模板增删/改名即时刷新支持度与档案
  const tpl = recipe?.templateId ? comfyTemplates.find((t) => t.id === recipe.templateId) : undefined;
  const support = useMemo(() => directorReferenceSupport(recipe, tpl), [recipe, tpl]);
  // 3.3 §2.7：当前配方的能力档案（时长钳制与预检提示用）
  const recipeProfile = profileForRecipe(recipe, tpl?.name);
  const durationCapNote = `当前配方能力：${recipeProfile.duration.min}–${recipeProfile.duration.max}s${recipeProfile.duration.step ? `（步进 ${recipeProfile.duration.step}）` : ""}；${recipeCapabilityNote(recipe ?? { id: "", name: "远程默认", engine: "provider", output: "video", mode: "t2v", defaultParams: {} }, tpl?.name)}`;

  // 与上次生成的差异（§6.5 提示词分组：修订差异）
  const lastTake = seg ? [...(seg.takes ?? [])].filter((t) => t.status === "done").sort((a, b) => b.createdAt - a.createdAt)[0] : undefined;

  if (!seg) {
    const noSegments = project.scenes.every((s) => s.segments.length === 0);
    return (
      <DockPanel className="h3-right" title="检查器" width={ui?.panelWidths?.h3Right ?? 320} projectId={project.id} widthKey="h3Right">
        <div className="st-empty">
          <b>{noSegments ? "项目还没有片段" : "未选中片段"}</b>
          <span>{noSegments ? "先用 AI 导演共创或剧本库导入并「送入项目」，拆分后在这里逐段配置与生成。" : "在左侧片段树点选一个片段，检查器会同步它。"}</span>
          {noSegments ? (
            <div className="st-row" style={{ justifyContent: "center" }}>
              <button className="st-btn sm" onClick={() => updateProject(project.id, { studioUi: { ...(project.studioUi ?? { station: "h3" }), station: "director" } })}>去 AI 导演</button>
              <button className="st-btn sm" onClick={() => updateProject(project.id, { studioUi: { ...(project.studioUi ?? { station: "h3" }), station: "scripts" } })}>去剧本库</button>
            </div>
          ) : null}
        </div>
      </DockPanel>
    );
  }

  const patch = (p: Partial<DirectorSegment>) => patchSegment(project.id, seg.id, p);

  // 项目规则（原策划页能力回归）：风格锚定与负向规则编译时自动拼进每段提示词
  const baseRule = () => project.ruleSet ?? { name: "全局规则", positive: {}, negative: {}, generation: {} };
  const patchStyle = (v: string) => updateProject(project.id, { ruleSet: { ...baseRule(), positive: { ...(project.ruleSet?.positive ?? {}), style: v } } });
  const patchNegFlag = (k: "noSubtitles" | "noWatermark" | "noText" | "noBackgroundMusic", v: boolean) =>
    updateProject(project.id, { ruleSet: { ...baseRule(), negative: { ...(project.ruleSet?.negative ?? {}), [k]: v || undefined } } });
  const patchNegExtra = (v: string) =>
    updateProject(project.id, { ruleSet: { ...baseRule(), negative: { ...(project.ruleSet?.negative ?? {}), extra: v.split("\n").filter((x) => x.trim()) } } });

  return (
    <DockPanel className="h3-right" title="检查器" projectId={project.id} widthKey="h3Right" width={ui?.panelWidths?.h3Right ?? 400} min={300} max={560}>
      {/* ① 角色与参考（参考图置顶——用户指定顺序：参考图 → 时间/描述 → 提示词/生成） */}
      {/* ③ 角色与参考（复用 SegmentRefEditor：真实 Picture/Video/Audio 编号） */}
      <InspectorGroup title="角色与参考" open={open("refs")} onToggle={() => toggle("refs")}>
        <SegmentRefEditor project={project} segment={seg} support={support} />
      </InspectorGroup>

      {/* ① 导演描述 */}
      <InspectorGroup title="导演描述" open={open("desc")} onToggle={() => toggle("desc")}>
        {/* 3.5：视频规格入口收敛到标题栏「规格默认 + MP」——这里只显示本段最终生效值与来源（只读） */}
        <div className="st-hint" style={{ marginBottom: 4 }} title="分段标题/元数据识别值优先于标题栏默认；手改时长仍会标记为手动来源">
          生效规格：{(() => {
            let cap: Parameters<typeof resolveVideoSpec>[2];
            try {
              cap = recipe?.engine === "provider" && recipe.providerModelKey
                ? specCapabilityFor(recipe, resolveModelCard("video", recipe.providerModelKey))
                : specCapabilityFor(recipe);
            } catch {
              cap = specCapabilityFor(recipe);
            }
            const spec = resolveVideoSpec(project, seg, cap);
            const parts = [
              spec.applied.resolution ? `${spec.applied.resolution.label}` : `${spec.requested.resolution.label}（分辨率未发送）`,
              spec.applied.fps !== undefined ? `${spec.applied.fps}fps` : `${spec.requested.fps}fps（帧率未发送）`,
              `${seg.durationSec}s`,
            ];
            const adj = spec.adjustments.find((a) => a.applied === null);
            return parts.join(" · ") + (adj ? `（⚠ ${adj.reason.slice(0, 30)}）` : "");
          })()}
        </div>
        <div className="st-row">
          <div className="st-field" style={{ flex: 1 }}>
            <label>时长（秒）</label>
            <input
              className="st-input"
              type="number"
              min={2}
              max={30}
              value={seg.durationSec}
              title={durationCapNote ?? "时长上限按当前配方的能力档案自动钳制"}
              onChange={(e) => {
                // 3.3 §2.7：时长是模型能力——已配配方按其能力档案钳制（H3 ≤15s 等）；
                // 未配配方（远程默认模型）能力未知，不做 generic 兜底钳制，交给预检提示
                const v = Math.max(2, Number(e.target.value) || 6);
                let final = v;
                if (recipe) {
                  const r = clampDuration(recipeProfile, v);
                  if (r.clamped) useUi.getState().toast?.(r.note ?? "时长已按模型能力钳制", "info");
                  final = r.sec;
                }
                // 3.5：手动改时长必须把来源标成 user（videoSpec.user.durationSec），
                // 否则 resolveVideoSpec 仍显示「分段识别」——手改却不认账
                patch({
                  durationSec: final,
                  videoSpec: { ...seg.videoSpec, user: { ...(seg.videoSpec?.user ?? {}), durationSec: final } },
                });
              }}
            />
          </div>
          <div className="st-field" style={{ flex: 1 }}>
            <label>片段配方</label>
            <PopSelect
              value={seg.recipeId ?? project.defaultRecipeId ?? ""}
              onChange={(v) => patch({ recipeId: String(v) || undefined })}
              triggerIcon
              options={[opt("", "项目默认", SI.flow), ...project.recipes.filter((r) => r.output === "video").map((r) => ({ value: r.id, label: r.name, icon: SI.video }))]}
            />
          </div>
        </div>
        <div className="st-field">
          <label>对白（每行一句；保存后可在音频条生成 TTS）</label>
          <textarea
            className="st-area"
            rows={2}
            value={seg.dialogue.join("\n")}
            onChange={(e) => patch({ dialogue: e.target.value.split("\n").filter((x) => x.trim()) })}
          />
        </div>
        {seg.dialogue.length ? (
          <button
            className="st-btn sm"
            title="把第一句对白生成为 TTS 音频轨（audio 角色模型）"
            onClick={async () => {
              try {
                const track = createAudioTrack(project.id, "dialogue", seg.dialogue[0], seg.id);
                await generateAudioTrack(project.id, track.id);
              } catch (e) {
                useUi.getState().toast?.(errMsg(e), "err");
              }
            }}
          >
            <IcMusic size={12} /> 生成对白 TTS
          </button>
        ) : null}
        <div className="st-field">
          <label>承接上一段（连续性）</label>
          <textarea className="st-area" rows={2} value={seg.continuityIn ?? ""} onChange={(e) => patch({ continuityIn: e.target.value })} />
        </div>
      </InspectorGroup>

      {/* ② 提示词四视图（3.5 P3）：中文审阅 / 英文执行 / 左右对照 / 实际请求 + 锁分离 */}
      <InspectorGroup
        title="提示词"
        open={open("prompt")}
        onToggle={() => toggle("prompt")}
        extra={
          <>
            {seg.h3Prompt?.syncStatus === "zh-newer" ? <span className="st-pill warn">中文较新</span> : null}
            {seg.promptFinalOverride ? (
              <span className="st-pill accent" title="存在最终锁定稿（promptFinalOverride）——实际请求整段直发该稿，跳过风格/Skill 自动拼接；解锁后恢复自动编译">
                最终锁定稿（实际请求以它为准）
              </span>
            ) : seg.locks?.executionEn ? (
              <span className="st-pill accent" title="英文执行稿已锁定——Skill 精炼与角色同步不会改写，只标过期">
                执行稿锁定
              </span>
            ) : null}
            {seg.h3Prompt?.syncStatus === "conflict" ? (
              <span className="st-pill" style={{ color: "var(--warn)" }} title="中英文稿存在时长/对白/缺段差异——请人工核对后再标同步">
                双语待核对
              </span>
            ) : null}
          </>
        }
      >
        <H3AuthoringPanel key={seg.id} project={project} seg={seg}/>
        {(() => {
          const h3 = seg.h3Prompt;
          const locks = seg.locks ?? { structure: !!seg.locked, reviewZh: false, executionEn: !!seg.promptFinalOverride };
          // 英文执行稿以 promptOverride 为唯一真源（编译路径零回归），h3Prompt.en 镜像
          const enBody = seg.promptOverride ?? h3?.en.promptBody ?? "";
          const zhBody = h3?.zh?.promptBody ?? "";
          const setEn = (v: string) =>
            patch({
              promptOverride: v || undefined,
              ...(h3 ? { h3Prompt: { ...h3, en: { ...h3.en, promptBody: v }, syncStatus: h3.zh ? "en-newer" : "synced" } } : {}),
            });
          const setZh = (v: string) =>
            patch({
              ...(h3
                ? { h3Prompt: { ...h3, zh: { ...(h3.zh ?? { title: h3.en.title, promptBody: "" }), promptBody: v }, syncStatus: v ? "zh-newer" : "en-newer" } }
                : {}),
            });
          const VIEWS = [
            { key: "zh", label: "中文审阅" },
            { key: "en", label: "英文执行" },
            { key: "both", label: "左右对照" },
            { key: "req", label: "实际请求" },
          ] as const;
          const view = promptView ?? "zh";
          const syncEnLock = (on: boolean) =>
            patch({
              locks: { ...locks, executionEn: on },
              // 双写 promptFinalOverride 保旧编译路径（整段直发语义不变）
              promptFinalOverride: on ? enBody || undefined : undefined,
            });
          return (
            <>
              <div className="st-row" style={{ gap: 2, flexWrap: "wrap" }}>
                {VIEWS.map((v) => (
                  <button key={v.key} className={`st-btn sm${view === v.key ? " primary" : " ghost"}`} onClick={() => setPromptView(v.key)}>
                    {v.label}
                  </button>
                ))}
              </div>
              {view === "zh" ? (
                zhBody || !h3?.en ? (
                  <textarea className="st-area" rows={10} value={zhBody} onChange={(e) => setZh(e.target.value)} placeholder="中文审阅稿（仅供人读，不发给模型）——导入双语包自动填充" />
                ) : (
                  <div className="st-empty" style={{ padding: 10 }}>
                    <b>还没有中文审阅稿</b>
                    <span>英文执行稿已就绪。中文稿用于人工校对，不影响生成。</span>
                    <button
                      className="st-btn sm"
                      disabled={zhBusy}
                      title="用对话模型把英文执行稿对齐为中文审阅稿（对白原文逐字不动，英文不修改）"
                      onClick={async () => {
                        if (!seg) return;
                        setZhBusy(true);
                        try {
                          const { generateZhReview } = await import("../../../core/studio/h3Bilingual");
                          const r = await generateZhReview(project.id, seg.id);
                          if (r.ok) useUi.getState().toast?.("中文审阅稿已生成（对白原文保留，已标同步）", "ok");
                          else useUi.getState().toast?.(`中文稿对白校验未过，已存为待确认草稿：${r.problems.slice(0, 3).join("；")}`, "err");
                        } catch (e) {
                          useUi.getState().toast?.(errMsg(e), "err");
                        } finally {
                          setZhBusy(false);
                        }
                      }}
                    >
                      {zhBusy ? <IcLoading size={12} /> : <IcSparkles size={12} />} 生成中文审阅稿
                    </button>
                  </div>
                )
              ) : null}
              {view === "zh" && h3?.zhDraft ? (
                <div className="st-field" style={{ marginTop: 4 }}>
                  <span className="st-hint" style={{ color: "var(--warn)" }}>
                    有一份对白校验未通过的中文稿草稿（syncStatus: conflict）——核对下面的差异后确认或丢弃；确认前不覆盖现有中文稿
                  </span>
                  <textarea className="st-area" rows={8} readOnly value={h3.zhDraft.promptBody} style={{ fontFamily: "var(--font-mono)", fontSize: 11 }} />
                  <div className="st-row" style={{ gap: 4, marginTop: 4 }}>
                    <button
                      className="st-btn sm"
                      title="人工核对无误：草稿升级为正式中文审阅稿，标记 synced"
                      onClick={async () => {
                        const { promoteZhDraft } = await import("../../../core/studio/h3Bilingual");
                        promoteZhDraft(project.id, seg.id);
                      }}
                    >
                      确认采用草稿
                    </button>
                    <button
                      className="st-btn sm ghost"
                      title="丢弃草稿，保持英文执行稿为唯一真相（syncStatus 回到 en-newer）"
                      onClick={async () => {
                        const { discardZhDraft } = await import("../../../core/studio/h3Bilingual");
                        discardZhDraft(project.id, seg.id);
                      }}
                    >
                      丢弃草稿
                    </button>
                  </div>
                </div>
              ) : null}
              {view === "en" ? (
                <>
                  <textarea
                    className="st-area"
                    rows={12}
                    value={enBody}
                    onChange={(e) => setEn(e.target.value)}
                    readOnly={locks.executionEn}
                    placeholder="英文执行稿（H3 模型请求真相；留空 = 自动编译：风格 + Skill + 参考编号）"
                    style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}
                  />
                  {h3?.en.dialogue?.length ? <span className="st-hint">对白 {h3.en.dialogue.length} 句已提取进「导演描述」（TTS/字幕真源）</span> : null}
                  {h3?.en.continuityMode ? <span className="st-hint">衔接模式：{h3.en.continuityMode === "opening" ? "开篇" : h3.en.continuityMode === "continuity_relay" ? "同场接力" : "硬切"}</span> : null}
                </>
              ) : null}
              {view === "both" ? (
                <div className="st-row" style={{ alignItems: "stretch", gap: 6 }}>
                  <textarea className="st-area" rows={10} value={zhBody} onChange={(e) => setZh(e.target.value)} placeholder="中文审阅稿" style={{ flex: 1, minWidth: 0 }} />
                  <textarea className="st-area" rows={10} value={enBody} onChange={(e) => setEn(e.target.value)} readOnly={locks.executionEn} placeholder="英文执行稿" style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 11.5 }} />
                </div>
              ) : null}
              {view === "req" ? (
                <>
                  <button
                    className="st-btn sm"
                    title="查看将真实发给模型的完整提示词（风格/Skill/参考编号拼接后）——只读，写入 Take 快照"
                    onClick={async () => {
                      setPromptPreview("编译中…");
                      try {
                        setPromptPreview(await previewSegmentPrompt(project, seg));
                      } catch (e) {
                        setPromptPreview(`编译失败：${errMsg(e)}`);
                      }
                    }}
                  >
                    编译实际请求
                  </button>
                  <textarea className="st-area" rows={12} readOnly value={promptPreview ?? ""} placeholder="点上方按钮编译…" style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }} />
                </>
              ) : null}
              <div className="st-row" style={{ gap: 10, flexWrap: "wrap", marginTop: 4 }}>
                <label className="st-hint" style={{ display: "flex", gap: 4, alignItems: "center" }} title="结构锁：禁止重新拆段/删除/重排；成品直录默认开">
                  <input type="checkbox" checked={!!locks.structure} onChange={(e) => patch({ locks: { ...locks, structure: e.target.checked }, locked: e.target.checked || undefined })} />
                  结构锁
                </label>
                <label className="st-hint" style={{ display: "flex", gap: 4, alignItems: "center" }} title="执行稿锁：任何 Skill/角色同步不得改写英文执行稿，只标过期">
                  <input type="checkbox" checked={!!locks.executionEn} onChange={(e) => syncEnLock(e.target.checked)} />
                  执行稿锁（整段直发）
                </label>
                {lastTake ? (
                  <span className="st-hint" title="与上次生成快照的差异">
                    上次 {new Date(lastTake.createdAt).toLocaleTimeString()}
                    {enBody !== (seg.takes ?? []).slice(-1)[0]?.promptSnapshot.slice(0, 80) ? " · 已改" : ""}
                  </span>
                ) : null}
              </div>
            </>
          );
        })()}
      </InspectorGroup>

      {/* ④ 生成 */}
      <InspectorGroup title="生成" open={open("gen")} onToggle={() => toggle("gen")}>
        <div className="st-field">
          <label>项目默认配方</label>
          <RecipeSelect project={project} target="project" />
        </div>
        <div className="st-row between">
          <span className="st-hint">
            <IcTimer size={11} /> {seg.durationSec}s · {recipe ? recipe.name : "远程默认视频模型"}
          </span>
          <button
            className="st-btn sm ghost"
            title="打开工作流模板管理器（导入 ComfyUI 工作流 / 暴露参数 / 往返编辑）"
            onClick={() => useUi.getState().setTemplateMgr(true)}
          >
            管理模板
          </button>
        </div>
        {/* 项目风格锚定与负向规则（原策划页能力回归 3.0）：编译时自动拼进每段提示词 */}
        <div className="st-field">
          <label>项目风格锚定（每段生成时自动前置）</label>
          <textarea
            className="st-area"
            rows={2}
            value={project.ruleSet?.positive.style ?? ""}
            onChange={(e) => patchStyle(e.target.value)}
            placeholder="如：胶片质感、暖调低对比、自然光"
          />
        </div>
        <div className="st-field">
          <label>负向规则（编译时以「负向：」拼接）</label>
          <div className="st-row" style={{ gap: 10, flexWrap: "wrap" }}>
            {([["noSubtitles", "去字幕"], ["noWatermark", "去水印"], ["noText", "去文字"], ["noBackgroundMusic", "去背景音乐"]] as const).map(([k, label]) => (
              <label key={k} className="st-hint" style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <input type="checkbox" checked={!!project.ruleSet?.negative[k]} onChange={(e) => patchNegFlag(k, e.target.checked)} />
                {label}
              </label>
            ))}
          </div>
          <textarea
            className="st-area"
            rows={2}
            value={(project.ruleSet?.negative.extra ?? []).join("\n")}
            onChange={(e) => patchNegExtra(e.target.value)}
            placeholder="自定义负向（每行一条）"
          />
        </div>
        <div className="st-row">
          <button className="st-btn primary" style={{ flex: 1 }} disabled={busy} onClick={onGenerate}>
            {busy ? <IcLoading size={13} /> : <IcPlay size={13} />} 生成本段
          </button>
          <button
            className="st-btn"
            title="软取消：跑完当前段后停止"
            onClick={() => {
              cancelBatch();
              useUi.getState().toast?.("将在当前段完成后停止批量", "ok");
            }}
          >
            <IcStop size={12} />
          </button>
        </div>
        <div className="st-row" style={{ flexWrap: "wrap" }}>
          <BatchSwitches project={project} />
        </div>
      </InspectorGroup>

      {/* ⑤ Skill 栈（引擎路由版，3.0）：本地 H3/LTX 与外调 Kling/Veo 各吃各的 Skill */}
      <InspectorGroup
        title="Skill 栈"
        open={open("skills")}
        onToggle={() => toggle("skills")}
        extra={
          (project.skillBindings ?? []).some((b) => b.enabled) ? (
            <span className="st-pill accent">{(project.skillBindings ?? []).filter((b) => b.enabled).length} 启用</span>
          ) : null
        }
      >
        <SkillBindingCard project={project} />
      </InspectorGroup>

      {/* ⑥ 危险操作：删除片段（移出时间线，素材保留在资产库） */}
      <div style={{ padding: "8px 10px", borderTop: "1px solid var(--studio-border)" }}>
        <button
          className="st-btn sm danger"
          style={{ width: "100%" }}
          title="从项目中移除此片段（场景空了连场景一起删）；时间线同步重建，已生成素材保留在资产库"
          onClick={() =>
            setAsk({
              text: (
                <>
                  删除片段 <b>「{seg.summary.slice(0, 24)}」</b>？
                  <div className="st-hint" style={{ marginTop: 4 }}>
                    片段及其全部 Take 版本将从项目中移出，时间线同步重建；已生成的素材文件保留在资产库。此操作不可撤销。
                  </div>
                </>
              ),
              run: () => removeSegment(project.id, seg.id),
            })
          }
        >
          <IcClose size={12} /> 删除此片段
        </button>
      </div>
      {ask ? (
        <AskCard
          text={ask.text}
          okText="确认删除"
          danger
          onConfirm={() => {
            ask.run();
            setAsk(null);
          }}
          onCancel={() => setAsk(null)}
        />
      ) : null}
    </DockPanel>
  );
}
