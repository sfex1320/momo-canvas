import { useComfy } from "../../core/stores/comfyStore";
import { nextStudioStep } from "../../core/studio/nextStep";
import { projectDisplayName, projectHasContent } from "../../core/studio/projectDisplay";
/**
 * MOMO AI 制片工作站 · Studio Shell（导演台 3.0 · 方案 §4 一壳七工位）
 *
 * 左侧一级导航不再是「第 1/2/3/4 步」，而是随时切换、共享同一项目数据的专业工位：
 *   AI 导演 / 剧本库 / 角色库 / AI 制图 / H3 导演台（主工位）/ AI MV / 成片交付
 * 底部共享工具：3D 预演 / 资产库 / 任务中心 / 引擎状态。
 * 顶栏保留项目、任务与导出；项目名、规格与目录绑定在「项目设置」内按需展开。
 * 工位态持久化到 project.studioUi；当前片段全局选中（useDirectorCtx）跨工位保持。
 */
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import "../director/director.css"; // SegmentRefEditor / AskCard 等复用组件的既有样式
import "./studio.css";
import { useUi } from "../../core/stores/uiStore";
import { useDirector } from "../../core/stores/directorStore";
import { useAssets } from "../../core/stores/assetStore";
import { useSettings } from "../../core/stores/settingsStore";
import { useDirectorCtx } from "../../core/directorContext";
import { projectProgress, mpToSize } from "../../core/directorEngine";
import { buildObjectIndex, breadcrumbFor } from "../../core/studio/objectIndex";
import { studioUiOf } from "../../core/studio/studioStore";
import { useAgentProposals } from "../../core/studio/agentGateway";
import { useJobCenter } from "../../core/studio/jobCenter";
import { JobCenterPanel, JobStrip } from "./shared/JobCenter";
import { ErrorBoundary } from "../../ui/ErrorBoundary";
import { AskCard } from "../director/AskCard";
import { PopSelect } from "../../ui/PopSelect";
import { entriesFromDataTransfer, importDroppedEntries } from "../../core/studio/dropImport";
import { bindProjectFolderFlow, checkWorkspace, unbindProjectFolder } from "../../core/studio/projectWorkspace";
import {
  IcClose, IcBrain, IcLibrary, IcUsers, IcBrush, IcClapper, IcMusic, IcFilmCut, IcFilmFrame, IcVideo, IcTimer,
  IcGallery, IcActivity, IcGear, IcDownload, IcFolder,
} from "../../ui/icons";
import type { DirectorProject, StudioStation, StudioToolKey } from "../../core/types";

/** 工位键：七个主工位 + 3D 预演（导航底部共享工具，全屏工位呈现） */
type StationKey = StudioStation | "previz";
import { SegmentWriter } from "./scripts/SegmentWriter";
import { ScriptLibraryStation } from "./scripts/ScriptLibraryStation";
// 3.4 主包拆分：重工位全部按需加载（3D three.js / 成片时间线 / MV 波形逻辑都在页面内部）
const CharacterLibraryStation = lazy(() => import("./characters/MaterialStation").then((m) => ({ default: m.MaterialStation })));
const ImageStudioStation = lazy(() => import("./image/ImageStudioStation").then((m) => ({ default: m.ImageStudioStation })));
const H3Station = lazy(() => import("./h3/H3Station").then((m) => ({ default: m.H3Station })));
const MVStation = lazy(() => import("./mv/MVStation").then((m) => ({ default: m.MVStation })));
const PostStation = lazy(() => import("./post/PostStation").then((m) => ({ default: m.PostStation })));
const PrevizStation = lazy(() => import("./previz/PrevizStation").then((m) => ({ default: m.PrevizStation })));

const STATIONS: Array<{ key: StudioStation; label: string; icon: React.ReactNode; desc: string }> = [
  { key: "director", label: "分段编写", icon: <IcBrain size={20} />, desc: "时间轴写作 · 素材复用 · 衔接与声音" },
  { key: "scripts", label: "剧本库", icon: <IcLibrary size={20} />, desc: "草稿 · 正式剧本 · 版本 · 送入项目" },
  { key: "characters", label: "素材定义", icon: <IcUsers size={20} />, desc: "人物 · 场景 · 道具 · 参考与音色" },
  { key: "image", label: "AI 制图", icon: <IcBrush size={20} />, desc: "文生图 · 图生图 · 编辑 · 结果入库" },
  { key: "h3", label: "生成选片", icon: <IcClapper size={20} />, desc: "整理分镜 · 生成画面 · 对比选片" },
  { key: "mv", label: "AI MV", icon: <IcMusic size={20} />, desc: "音乐 · 节拍 · 图像映射 · 口型" },
  { key: "post", label: "初剪交付", icon: <IcFilmCut size={20} />, desc: "多轨时间线 · 质检 · 预演 · 导出" },
];

const TOOLS: Array<{ key: StudioToolKey; label: string; icon: React.ReactNode; desc: string }> = [
  { key: "previz", label: "3D 预演", icon: <IcFilmFrame size={20} />, desc: "站位 · 机位 · 光源 · 站位图导出" },
  { key: "assets", label: "资产库", icon: <IcGallery size={20} />, desc: "全部参考与生成素材" },
  { key: "jobs", label: "任务中心", icon: <IcActivity size={20} />, desc: "生成 / 提取 / 渲染 / 分析" },
  { key: "engine", label: "ComfyUI", icon: <IcGear size={20} />, desc: "服务地址 / 工作流模板管理 / 显存清理（设置 → ComfyUI）" },
];

export function StudioShell({ project }: { project: DirectorProject }) {
  const close = () => useUi.getState().setDirectorOpen(false);
  const updateProject = useDirector((s) => s.updateProject);
  const ctxSegId = useDirectorCtx((s) => s.segId);
  const setSeg = useDirectorCtx((s) => s.setSeg);
  const comfyHost = useSettings((s) => s.settings.comfy.host);
  const templates=useComfy(s=>s.templates);
  const remoteConfigured=useSettings(s=>s.settings.models.defaults.image?.startsWith("codex-membership")||s.settings.models.providers.some(p=>(p.models.image?.models.length??0)>0||(p.models.video?.models.length??0)>0));
  const chatReady = useSettings((s) => s.settings.models.defaults.chat?.startsWith("codex-membership")||s.settings.models.providers.some(p => (p.models.chat?.models.length ?? 0) > 0));
  const pendingProposals = useAgentProposals((s) => s.proposals.filter((p) => p.projectId === project.id && p.status === "pending").length);

  const ui = project.studioUi ?? studioUiOf(project.id);
  const station: StationKey = ui.station ?? "h3";
  const previzOn = station === "previz";
  const [settingsOpen, setSettingsOpen] = useState(false);
  const stationInfo = STATIONS.find((s) => s.key === station) ?? TOOLS[0];

  // 全局选中片段写回 studioUi（跨会话恢复）；打开时恢复上次选中
  useEffect(() => {
    if (ctxSegId && ui.segId !== ctxSegId && project.scenes.some((s) => s.segments.some((g) => g.id === ctxSegId)))
      updateProject(project.id, { studioUi: { ...ui, segId: ctxSegId } }); // 跨项目打开时全局 segId 可能来自别的项目，先验证归属
  }, [ctxSegId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (ui.segId && !useDirectorCtx.getState().segId) setSeg(ui.segId);
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 3.5 P1（§11.5）：工作区校验不只发生在项目切换——首次打开导演台（恢复持久化项目的绑定）与
  // 窗口重新聚焦（目录可能刚重新上线）都检查；离线只标 missing 不清数据，上线顺手补清理待删 manifest。
  useEffect(() => {
    void checkWorkspace(project.id);
    const onFocus = () => void checkWorkspace(project.id);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [project.id]);

  const index = useMemo(() => buildObjectIndex(project), [project]);
  const crumb = breadcrumbFor(index, ctxSegId);
  const progress = projectProgress(project);
  const nextStep = nextStudioStep(project);
  const localConfigured=!!comfyHost&&project.recipes.some(r=>r.templateId&&templates.some(t=>t.id===r.templateId));
  const engineOk=remoteConfigured||localConfigured;

  const go = (key: StationKey) => updateProject(project.id, { studioUi: { ...ui, station: key } });

  /* 拖拽导入（全工位生效）：资源管理器的资产册目录 / 剧本 / 图片·视频·音频直接拖进内容区 */
  const [dropHot, setDropHot] = useState(false);
  const isFileDrag = (e: React.DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  const onContentDragOver = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropHot(true);
  };
  const onContentDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropHot(false);
  };
  const onContentDrop = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    setDropHot(false);
    void (async () => {
      const list = await entriesFromDataTransfer(e.dataTransfer);
      if (list?.length) await importDroppedEntries(project.id, list, { autoSendScripts: station === "scripts" });
    })();
  };

  /* 粘贴上传（全工位）：复制的图片/视频/音频/剧本文件直接入链；纯文本粘贴不劫持（剧本库工位自己收正文） */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const cd = e.clipboardData;
      if (!cd) return;
      const files = Array.from(cd.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      void importDroppedEntries(
        project.id,
        files.map((f) => ({ file: f, rel: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name })),
        { autoSendScripts: station === "scripts" },
      );
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [project.id, station]);

  const onTool = (key: StudioToolKey) => {
    if (key === "previz") return go("previz");
    if (key === "assets") return useAssets.getState().setOpen(true);
    if (key === "jobs") return useJobCenter.getState().setPanelOpen(true);
    // 引擎状态 → 设置的 ComfyUI 页（服务地址 / 模板管理器 / 显存清理都在那里）
    if (key === "engine") return useUi.getState().openSettings("comfy");
  };

  return (
    <div className="director-studio studio3" data-project-id={project.id}>
      {/* 顶栏（§4.3）：项目 / 面包屑 / 保存状态 / 引擎状态 / 任务条 / 导出 / 关闭。
          全屏工位层盖住了壳的自定义标题栏，这里必须自带拖动区才能拖动窗口 */}
      <header className="st-header" data-tauri-drag-region>
        <strong className="st-brand" data-tauri-drag-region><IcClapper size={19} /> 制片工作站</strong>
        {/* 3.5 P0：剧本项目切换器——切换整个 DirectorProject（角色/H3/MV/时间线/资产全隔离） */}
        <ProjectSwitcher current={project} />
        <span className="st-crumb" data-tauri-drag-region title="当前对象：项目 / 场景 / 片段">
          {crumb.length ? (
            <>
              {crumb.map((c, i) => (
                <span key={i} style={{ display: "inline-flex", gap: 4 }}>
                  {i > 0 ? <i data-tauri-drag-region>/</i> : null}
                  <b data-tauri-drag-region>{c}</b>
                </span>
              ))}
            </>
          ) : (
            <b data-tauri-drag-region>{progress.total ? `已采用 ${progress.approved}/${progress.total} 片段` : "尚无片段"}</b>
          )}
        </span>
        <div className="st-head-right">
          <JobStrip />
          <button className={`st-btn ghost${settingsOpen ? " on" : ""}`} aria-expanded={settingsOpen} aria-controls="studio-project-settings" onClick={() => setSettingsOpen((v) => !v)}>
            <IcGear size={15} /> 项目设置
          </button>
          <button className="st-btn" title="前往成片交付工位完成预演与正式导出" onClick={() => go("post")}>
            <IcDownload size={13} /> 导出
          </button>
          <button className="st-iconbtn" title="关闭制片工作站" aria-label="关闭" onClick={close}>
            <IcClose size={18} />
          </button>
        </div>
      </header>

      {settingsOpen ? <section id="studio-project-settings" className="st-project-settings" aria-label="项目设置">
        <label className="st-settings-label" htmlFor="studio-project-name">项目名</label>
        <input id="studio-project-name" className="st-title-input" value={project.name} onChange={(e) => updateProject(project.id, { name: e.target.value })} placeholder="未命名项目" />
        <span className="st-settings-label">默认规格</span>
        <VideoSpecDefaultsControl project={project} />
        <WorkspaceBindButton project={project} />
        <span className="st-saved"><span className={`st-dot${engineOk ? "" : " off"}`} />{remoteConfigured ? "生成模型已配置" : localConfigured ? "本地配方已配置" : "待配置生成模型"}</span>
        <span className="st-saved"><span className={`st-dot${chatReady ? "" : " off"}`} />{chatReady ? "对话模型已配置" : "待配置对话模型"}</span>
      </section> : null}

      <div className="st-guide" aria-label="制作流程">
        <div className="st-station-heading"><h1>{stationInfo.label}</h1><span>{stationInfo.desc}</span></div>
        <div className="st-guide-steps">{["剧本", "编写", "选片", "交付"].map((label, i) => <span key={label} aria-current={nextStep.stage === i ? "step" : undefined} className={nextStep.stage === i ? "on" : nextStep.stage > i ? "done" : ""}><i>{i + 1}</i>{label}</span>)}</div>
        <button className="st-btn primary" title={nextStep.hint} onClick={() => { if (nextStep.segmentId) setSeg(nextStep.segmentId); go(nextStep.station); }}>{nextStep.label} →</button>
      </div>
      <div className="st-body">
        {/* 一级导航：七工位（不编号）+ 底部共享工具 */}
        <nav className="st-nav" aria-label="工位导航">
          <span className="st-nav-heading">创作工位</span>
          {["scripts","characters","director","h3","post","image","mv"].map(key=>STATIONS.find(s=>s.key===key)!).map((s) => (
            <button
              key={s.key}
              className={`st-nav-item${station === s.key ? " on" : ""}`}
              title={`${s.label} — ${s.desc}`}
              aria-current={station === s.key}
              onClick={() => go(s.key)}
            >
              {s.icon}
              <span className="st-nav-label">{s.label}</span>
              {s.key === "director" && pendingProposals ? <span className="st-badge">{pendingProposals}</span> : null}
              {s.key === "post" && progress.missing ? (
                <span className="st-badge" title={`缺片 ${progress.missing} 个片段`}>
                  {progress.missing}
                </span>
              ) : null}
            </button>
          ))}
          <div className="st-nav-gap" />
          <div className="st-nav-split" />
          <span className="st-nav-heading">项目工具</span>
          {TOOLS.map((t) => (
            <button
              key={t.key}
              className={`st-nav-item${(t.key === "previz" && previzOn) || (t.key === "jobs" && false) ? " on" : ""}`}
              title={`${t.label} — ${t.desc}`}
              onClick={() => onTool(t.key)}
            >
              {t.icon}
              <span className="st-nav-label">{t.label}</span>
              {t.key === "jobs" ? <JobsBadge /> : null}
            </button>
          ))}
        </nav>

        {/* 工位内容：单一入口（§3.2）；ErrorBoundary 兜底——任何工位渲染异常只坏本区，不再整窗白屏 */}
        <main className="st-content" onDragOver={onContentDragOver} onDragLeave={onContentDragLeave} onDrop={onContentDrop}>
          <ErrorBoundary key={`${project.id}:${station}`} name="工位">
            {station === "director" ? <SegmentWriter project={project} /> : null}
            {station === "scripts" ? <ScriptLibraryStation project={project} /> : null}
            <Suspense fallback={<div className="st-loading">正在加载工位…</div>}>
              {station === "characters" ? <CharacterLibraryStation project={project} /> : null}
              {station === "image" ? <ImageStudioStation project={project} /> : null}
              {station === "h3" ? <H3Station project={project} index={index} /> : null}
              {station === "mv" ? <MVStation project={project} /> : null}
              {station === "post" ? <PostStation project={project} /> : null}
              {previzOn ? <PrevizStation project={project} /> : null}
            </Suspense>
          </ErrorBoundary>
          {dropHot ? (
            <div className="st-drop-hint">
              <b>松手导入「{project.name}」</b>
              <span>
                资产册目录（含 资产提示词.md）→ 按「使用分段」自动绑定参考槽 · 图片/视频/音频散件 →
                按文件名分段号（01-、第03段、H3-02）落到对应片段，对白/旁白/音乐另入混音轨 · .md/.txt 剧本 → 存入剧本库
              </span>
            </div>
          ) : null}
        </main>
      </div>
      <JobCenterPanel />
    </div>
  );
}

/** 项目文件夹绑定（3.5 P2）：选目录 → 确定性扫描 → 预演确认（含与已有片段的冲突预演）→ 绑定即导入；已绑定时显示状态/解除 */
function WorkspaceBindButton({ project }: { project: DirectorProject }) {
  const [scan, setScan] = useState<Awaited<ReturnType<typeof bindProjectFolderFlow>>>(null);
  const w = project.workspace;
  const doBind = async () => {
    const r = await bindProjectFolderFlow(project.id);
    if (r) setScan(r);
  };
  return (
    <>
      {w ? (
        <span
          className="st-hint"
          data-tauri-drag-region
          title={`已绑定：${w.rootPath}（${w.status === "ready" ? "就绪" : w.status === "missing" ? "目录离线——产物暂回托管" : w.status}）；Take 写入 分段资产库/NN_标题/Takes/，成片写入 成片/`}
          style={{ display: "inline-flex", alignItems: "center", gap: 4, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          <IcFolder size={14} /> {w.rootPath.split(/[\\/]/).pop()}
          {w.status === "missing" ? "（离线）" : ""}
          <button
            className="st-iconbtn"
            style={{ width: 18, height: 18 }}
            title="解除项目文件夹绑定（产物文件保留在原处；.momo/project.json 一并清理，该目录之后可绑定新项目）"
            onClick={(e) => {
              e.stopPropagation();
              void unbindProjectFolder(project.id);
            }}
          >
            <IcClose size={11} />
          </button>
        </span>
      ) : (
        <button className="st-btn sm ghost" title="绑定项目文件夹：自动扫描（完整剧本/双语分段/资产册/分段资产库）→ 预演确认 → 导入项目并路由产物落盘（不绑定为 AppData 托管）" onClick={() => void doBind()}>
          绑定文件夹
        </button>
      )}
      {scan ? (
        <AskCard
          danger={!!scan.conflict}
          text={
            <>
              <b>{scan.conflict ? "绑定并导入（目录与当前项目片段冲突）" : "绑定并导入项目文件夹"}</b>
              <div className="st-hint" style={{ marginTop: 4 }}>{scan.scan.rootPath}</div>
              <div className="st-hint">扫描结果：{scan.scan.summary}</div>
              {scan.conflict ? (
                <>
                  {scan.conflict.notes.map((n, i) => (
                    <div className="st-hint" key={i} style={i === 0 ? { marginTop: 4, color: "var(--warn)" } : { marginTop: 2 }}>
                      {i === 0 ? "⚠ " : "· "}
                      {n}
                    </div>
                  ))}
                </>
              ) : (
                <div className="st-hint" style={{ marginTop: 4 }}>
                  确认后写入 .momo/project.json 并绑定；自动扫描到的完整剧本、双语分段（英文直录 + 中文配对）、资产册会立即导入项目，
                  Take/成片等产物按目录规范物理落盘。内容没变时重复绑定不会重复导入。
                </div>
              )}
            </>
          }
          okText={scan.conflict ? "覆盖导入" : "绑定"}
          onConfirm={() => {
            void scan.apply(scan.conflict ? "overwrite" : "auto");
            setScan(null);
          }}
          onCancel={() => setScan(null)}
        >
          {scan.conflict ? (
            <div className="st-row" style={{ marginTop: 6 }}>
              <button
                className="st-btn sm ghost"
                onClick={() => {
                  void scan.apply("merge");
                  setScan(null);
                }}
              >
                合并导入（保留现有片段，只补剧本库与资产册）
              </button>
            </div>
          ) : null}
        </AskCard>
      ) : null}
    </>
  );
}

/** 统一视频规格默认值（3.5 P1 §6.7）：顶栏三项默认值 + 百万像素输入（H3 等本地模型按卡位总像素设置）。
 *  分段识别值优先于这里；远程模型走分辨率档，本地 ComfyUI 走 MP → 宽高换算（两位小数，0.1~10MP）。 */
function VideoSpecDefaultsControl({ project }: { project: DirectorProject }) {
  const updateProject = useDirector((s) => s.updateProject);
  const d = project.videoSpecDefaults ?? {};
  const label = `${d.resolution?.label ?? "1080p"} · ${d.fps ?? 24}fps · 默认${d.durationSec ?? 12}s`;
  const set = (patch: Partial<NonNullable<DirectorProject["videoSpecDefaults"]>>) =>
    updateProject(project.id, { videoSpecDefaults: { ...d, ...patch } });
  const mp = project.resolutionMP ?? 1;
  const size = mpToSize(project.aspect, mp); // 输入即见长宽（16:9 · 1MP → 1328×752；10MP → 4224×2368 一类）
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} className="nodrag">
      <PopSelect
        value={label}
        triggerIcon
        title="统一视频规格默认值——分辨率 / 帧率 / 默认时长。分段里明确写出的规格优先于这些默认值"
        options={[
          { value: label, label: `规格默认：${label}`, icon: <IcVideo size={14} /> },
          { value: "r-720", label: "分辨率 → 720p", icon: <IcVideo size={14} /> },
          { value: "r-1080", label: "分辨率 → 1080p", icon: <IcVideo size={14} /> },
          { value: "r-2k", label: "分辨率 → 2K", icon: <IcVideo size={14} /> },
          { value: "r-4k", label: "分辨率 → 4K", icon: <IcVideo size={14} /> },
          { value: "f-24", label: "帧率 → 24fps", icon: <IcVideo size={14} /> },
          { value: "f-25", label: "帧率 → 25fps", icon: <IcVideo size={14} /> },
          { value: "f-30", label: "帧率 → 30fps", icon: <IcVideo size={14} /> },
          { value: "d-10", label: "默认时长 → 10s", icon: <IcTimer size={14} /> },
          { value: "d-12", label: "默认时长 → 12s", icon: <IcTimer size={14} /> },
          { value: "d-15", label: "默认时长 → 15s", icon: <IcTimer size={14} /> },
        ]}
        onChange={(v) => {
          const s = String(v);
          if (s === "r-720") set({ resolution: { label: "720p", width: 1280, height: 720 } });
          else if (s === "r-1080") set({ resolution: { label: "1080p", width: 1920, height: 1080 } });
          else if (s === "r-2k") set({ resolution: { label: "2K", width: 2560, height: 1440 } });
          else if (s === "r-4k") set({ resolution: { label: "4K", width: 3840, height: 2160 } });
          else if (s === "f-24") set({ fps: 24 });
          else if (s === "f-25") set({ fps: 25 });
          else if (s === "f-30") set({ fps: 30 });
          else if (s === "d-10") set({ durationSec: 10 });
          else if (s === "d-12") set({ durationSec: 12 });
          else if (s === "d-15") set({ durationSec: 15 });
        }}
      />
      {/* 百万像素（本地模型卡位总像素，精确到 0.01MP，最高 20MP（两千万像素）；右侧实时换算长宽） */}
      <span title={`百万像素（MP）：本地模型（如 H3）按卡位总像素设置，精确到 0.01、最高 20MP；远程模型走左侧分辨率档。当前画幅 ${project.aspect} 换算为 ${size.width}×${size.height}`} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <input
          className="st-input"
          type="number"
          min={0.1}
          max={20}
          step={0.01}
          value={mp}
          onChange={(e) => {
            const v = Math.min(20, Math.max(0.1, Number(e.target.value) || 1));
            updateProject(project.id, { resolutionMP: Math.round(v * 100) / 100 });
          }}
          style={{ width: 64, padding: "2px 6px" }}
          aria-label="百万像素"
        />
        <span className="st-hint" style={{ whiteSpace: "nowrap" }}>MP · {size.width}×{size.height}</span>
      </span>
    </span>
  );
}

/** 剧本项目切换器（3.5 P0）：按 projectId 整体切换；清全局选中态防串项目；在途批量先确认。
 *  切换只走 doSwitch 一个函数（普通分支与确认分支共用——不重复写状态、不重复 toast、不竞态）。 */
function ProjectSwitcher({ current }: { current: DirectorProject }) {
  const projects = useDirector((s) => s.projects);
  const [showEmpty, setShowEmpty] = useState(false);
  const assets = useAssets(s => s.items);
  const hasContent = (p: DirectorProject) => projectHasContent(p) || assets.some(a => a.director?.projectId === p.id || a.projectMirrors?.[p.id]);
  const isEmptyDraft = (p: DirectorProject) => (!p.name.trim() || p.name.trim() === "未命名项目") && !hasContent(p);
  const others = projects.filter((p) => p.id !== current.id && (showEmpty || !isEmptyDraft(p)));
  const hiddenCount = projects.filter(p => p.id !== current.id && isEmptyDraft(p)).length;
  const option = (p: DirectorProject) => ({ value: p.id, label: projectDisplayName(p), desc: `${p.scenes.reduce((n,s)=>n+s.segments.length,0)} 个片段 · ${new Date(p.updatedAt).toLocaleDateString('zh-CN')}`, icon: <IcFilmFrame size={14} /> });
  const [confirmSwitch, setConfirmSwitch] = useState<{ target: string; run: () => void } | null>(null);
  const doSwitch = (target: DirectorProject) => {
    // 全局选中态清空：segId/takeId/对比全部属于旧项目，绝不能带进新项目
    const ctx = useDirectorCtx.getState();
    ctx.setSeg(null);
    ctx.setCompare(null);
    useUi.setState({ directorProjectId: target.id, directorNodeId: target.nodeId || null });
    useUi.getState().toast?.(`已切换到「${projectDisplayName(target)}」`, "ok");
    // §7-5：加载新项目 workspace 并校验目录（离线只标状态不清数据）
    void checkWorkspace(target.id);
  };
  const switchTo = (id: string) => {
    if (id === current.id) return;
    const target = projects.find((p) => p.id === id);
    if (!target) return;
    // 在途批量：AskCard 确认（继续后台跑/取消后切）——结果按原 projectId 写回原项目，不丢
    const busyRunning = useJobCenter.getState().jobs.some((j) => j.projectId === current.id && ["queued", "running", "prechecking"].includes(j.status));
    if (busyRunning) {
      setConfirmSwitch({ target: projectDisplayName(target), run: () => doSwitch(target) });
      return;
    }
    doSwitch(target);
  };
  return (
    <>
      <PopSelect
        value={current.id}
        triggerIcon
        title={`切换项目 · ${others.length + 1} 个`}
        options={[
          option(current),
          ...others.map(option),
          ...(hiddenCount ? [{ value: "__empty", label: showEmpty ? "收起空项目" : `显示 ${hiddenCount} 个空项目`, desc: "空项目保留，可随时继续编辑" }] : []),
        ]}
        onChange={(v) => v === "__empty" ? setShowEmpty(s => !s) : switchTo(String(v))}
      />
      {confirmSwitch ? (
        <AskCard
          text={<>「{projectDisplayName(current)}」有生成任务在运行。切换后任务继续后台运行、结果写回原项目。确认切换到「{confirmSwitch.target}」？</>}
          okText="确认切换"
          onConfirm={() => {
            confirmSwitch.run();
            setConfirmSwitch(null);
          }}
          onCancel={() => setConfirmSwitch(null)}
        />
      ) : null}
    </>
  );
}

/** 任务中心角标：运行中任务数 */
function JobsBadge() {
  const jobs = useJobCenter((s) => s.jobs);
  const n = jobs.filter((j) => ["planned", "prechecking", "queued", "running", "reviewing"].includes(j.status)).length;
  return n ? <span className="st-badge">{n}</span> : null;
}
