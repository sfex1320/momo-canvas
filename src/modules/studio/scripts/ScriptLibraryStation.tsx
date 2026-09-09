/**
 * 剧本库工位（导演台 3.0 · 方案 §6.2）— 正式内容库，不再是单页大文本框
 *
 * 左：文档列表（草稿/正式/归档）· 中：版本时间线 + 正文编辑 · 右：结构检查与「送入项目」
 *  - 版本不可变快照；可双栏对比、回退（回退 = 以旧版本另存新版本，历史不丢）；
 *  - 送入项目：替换项目剧本（重新拆分，先提示将失效的分镜/提示词/22帧参考/Take）
 *    或合并场景（新剧本场景追加拆分）；从文件导入 / 从项目另存。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useDirector } from "../../../core/stores/directorStore";
import { SI } from "../shared/selectIcons";
import { useUi } from "../../../core/stores/uiStore";
import { planningSkillSystem } from "../../../core/studio/skillRoute";
import { splitScript, structuredSplit, detectScriptKind, importPromptSegments, removeScriptDoc } from "../../../core/directorEngine";
import { createScriptDoc, inspectScript, inspectionSummary, structuredToScenes, matchZhCounterpartDoc, type ScriptInspection } from "../../../core/scriptInspect";
import { parseVideoSpecFromSegment } from "../../../core/studio/videoSpec";
import { collectSegmentMarks } from "../../../core/segmentParse";
import { uid, errMsg } from "../../../core/utils";
import { DockPanel } from "../shared/DockPanel";
import { PopSelect } from "../../../ui/PopSelect";
import { AskCard } from "../../director/AskCard";
import { IcLibrary, IcPlus, IcMerge, IcCheck, IcClose, IcHistory, IcUpload, IcDownload, IcTrash } from "../../../ui/icons";
import type { DirectorCharacter, DirectorProject, DirectorScene, ScriptDocument } from "../../../core/types";
import { DIRECTOR_SCHEMA_VERSION } from "../../../core/directorMigration";
import { bindProjectFolderFlow } from "../../../core/studio/projectWorkspace";

const STATUS_LABEL: Record<ScriptDocument["status"], string> = { draft: "草稿", official: "正式", archived: "归档" };

const TH: React.CSSProperties = { padding: "4px 6px", fontWeight: 500, whiteSpace: "nowrap", textAlign: "left" };
const TD: React.CSSProperties = { padding: "4px 6px", whiteSpace: "nowrap" };

export function ScriptLibraryStation({ project }: { project: DirectorProject }) {
  const updateProject = useDirector((s) => s.updateProject);
  const docs = project.scripts ?? [];
  const selectedId = project.studioUi?.scriptId ?? docs[0]?.id ?? null;
  const doc = docs.find((d) => d.id === selectedId) ?? docs[0];
  const activeVersion = doc?.versions.find((v) => v.id === doc.activeVersionId) ?? doc?.versions[doc.versions.length - 1];
  const [editing, setEditing] = useState<string | null>(null);
  const [diffVers, setDiffVers] = useState<{ a: string; b: string } | null>(null);
  const [sendMode, setSendMode] = useState<"replace" | "merge" | null>(null);
  const [ask, setAsk] = useState<{ text: React.ReactNode; run: () => void } | null>(null);
  /** 3.5 P0 导入语义：不同故事的剧本默认新建导演项目（隔离角色/H3/资产），不再隐式塞进当前项目 */
  const [ingestMode, setIngestMode] = useState<"ask" | "new-project" | "version" | "append">("ask");
  const fileRef = useRef<HTMLInputElement>(null);
  /** 3.5：绑定剧本总文件夹（=「仿制资产库」）——扫中英剧本/资产册/分段资产库，确认后一键导入项目 */
  const [bindScan, setBindScan] = useState<Awaited<ReturnType<typeof bindProjectFolderFlow>>>(null);

  const patchDoc = (patch: Partial<ScriptDocument>) => {
    if (!doc) return;
    updateProject(project.id, { scripts: docs.map((d) => (d.id === doc.id ? { ...d, ...patch, updatedAt: Date.now() } : d)) });
  };

  const stats = useMemo(() => {
    const body = activeVersion?.body ?? "";
    return {
      chars: body.length,
      scenes: (body.match(/第[一二三四五六七八九十百0-9]+[场幕]/g) ?? []).length,
      dialogue: (body.match(/[:：]"|「|"/g) ?? []).length,
      estSec: Math.round(body.length / 6),
    };
  }, [activeVersion]);

  const newDoc = () => {
    const now = Date.now();
    const d: ScriptDocument = {
      id: uid(10), title: "新剧本", status: "draft",
      versions: [{ id: uid(10), label: "初始版本", body: "", createdAt: now }],
      origin: "import", createdAt: now, updatedAt: now,
    };
    updateProject(project.id, { scripts: [d, ...docs], studioUi: { ...project.studioUi ?? { station: "h3" }, scriptId: d.id } });
  };

  const saveVersion = (label: string, body: string) => {
    if (!doc) return;
    const v = { id: uid(10), label, body, createdAt: Date.now() };
    patchDoc({ versions: [...doc.versions, v], activeVersionId: v.id });
  };

  /** dry-run 拆分（3.2 §4.2：先算差异与影响，不先动 project.script）：
   *  按三态识别产出新场景草案与说明；不写任何数据。 */
  type DrySplit = { kind: string; scenes: DirectorScene[]; characters?: DirectorCharacter[]; note: string; globalStyle?: string };

  const drySplit = async (body: string): Promise<DrySplit> => {
    const maxSegSec = 12;
    const kind = detectScriptKind(body);
    if (kind === "prompts") {
      const r = importPromptSegments(body, maxSegSec);
      const n = r.scenes[0]?.segments.length ?? 0;
      return { kind, scenes: r.scenes, note: `成品直录 ${n} 段（原文锁定，全局风格${r.globalStyle ? "锚定" : "无"}）`, globalStyle: r.globalStyle };
    }
    if (kind === "segmented") {
      const scenes = structuredToScenes(structuredSplit(body, maxSegSec), maxSegSec);
      return { kind, scenes, note: `规则切段 ${scenes.length} 段（原文留档，可 AI 精读）` };
    }
    useUi.getState().toast?.("正在用 AI 拆分剧本（预演，未写入项目）…", "ok");
    const { characters, scenes } = await splitScript(body, project.targetDurationSec, maxSegSec, planningSkillSystem(project) || undefined);
    return { kind, scenes, characters, note: `LLM 拆分 ${scenes.length} 场 · ${scenes.reduce((n, s) => n + s.segments.length, 0)} 片段 · ${characters.length} 角色` };
  };

  /** 差异预演结果（替换模式确认前展示） */
  const [preview, setPreview] = useState<{ body: string; kind: string; scenes: DirectorScene[]; characters?: DirectorCharacter[]; note: string; globalStyle?: string } | null>(null);

  /** 送入项目（§6.2 · 三态识别 + 真差异，3.2 §4.2）：
   *  merge 追加模式直接执行（不覆盖现有）；replace 模式先 dry-run 出差异卡再确认。 */
  const doSend = async () => {
    if (!doc || !activeVersion || !sendMode) return;
    try {
      const body = sendMode === "replace" ? activeVersion.body : `${project.script}\n\n${activeVersion.body}`;
      // 追加模式只拆新文档本身——把「旧正文+新文档」整体重拆再追加，会把旧剧情复制一遍（3.4 修复）
      const dry = await drySplit(sendMode === "replace" ? body : activeVersion.body);
      if (sendMode === "merge") {
        void applyDry(body, dry, "merge");
        return;
      }
      // 替换模式：先展示差异与影响，确认后才写（3.2：不能先替换 script 再提醒）
      setPreview({ body, ...dry });
      setSendMode(null);
    } catch (e) {
      useUi.getState().toast?.(`送入项目失败：${errMsg(e)}`, "err");
    }
  };

  /** 应用 dry-run 结果：mode=merge 追加（旧片段保留）；mode=replace 全量替换（旧片段移出，Take 资产保留在库） */
  const applyDry = async (body: string, dry: Awaited<ReturnType<typeof drySplit>>, mode: "merge" | "replace") => {
    try {
      const patch: Partial<DirectorProject> = { script: body, scenes: dry.scenes };
      // 时长统计在最终场景组合完成后进行（追加模式此前只统计新文档，会覆盖掉原项目时长）
      if (dry.globalStyle) {
        patch.ruleSet = {
          ...(project.ruleSet ?? { name: "全局规则", positive: {}, negative: {}, generation: {} }),
          positive: { ...(project.ruleSet?.positive ?? {}), style: dry.globalStyle },
        };
      }
      // 3.5 §6.4：前言（第一个分段标记之前）识别出的全片统一规格作为项目级候选（分段识别值优先于它）
      const sourceBody = mode === "replace" ? body : activeVersion?.body ?? "";
      const marks = collectSegmentMarks(sourceBody.trim());
      const prefix = marks.length ? sourceBody.slice(0, marks[0]) : sourceBody.slice(0, 3000);
      const prefixSpec = parseVideoSpecFromSegment(prefix);
      if (Object.keys(prefixSpec.sources ?? {}).length) patch.videoSpecFromPrefix = prefixSpec;
      const fresh = useDirector.getState().getById(project.id)!;
      if (mode === "merge") {
        patch.scenes = [...fresh.scenes, ...dry.scenes];
        const totalAll = patch.scenes.reduce((n, s) => n + s.segments.reduce((m, seg) => m + seg.durationSec, 0), 0);
        if (totalAll > 0) patch.targetDurationSec = totalAll;
        if (dry.characters?.length) {
          patch.characters = [...fresh.characters, ...dry.characters.filter((c) => !fresh.characters.some((x) => x.name === c.name))];
        }
      } else if (dry.characters?.length) {
        patch.characters = dry.characters;
      }
      useDirector.getState().updateProject(project.id, patch);
      const extras: string[] = [];
      if (mode === "replace") {
        // 替换后旧 segmentId 全部失效：全局选中态立即清空（否则 H3 导演台检查器还指着旧片段），
        // 并重建时间线、清掉挂在旧片段上的音频轨/胶囊/质检报告/后期覆盖
        const ctx = (await import("../../../core/directorContext")).useDirectorCtx.getState();
        ctx.setSeg(null);
        ctx.setCompare(null);
        updateProject(project.id, { studioUi: { ...(project.studioUi ?? { station: "h3" }), segId: null } });
        const { rebuildTimeline } = await import("../../../core/directorEngine");
        rebuildTimeline(project.id);
        const freshNow = useDirector.getState().getById(project.id);
        if (freshNow) {
          const alive = new Set(freshNow.scenes.flatMap((s) => s.segments.map((g) => g.id)));
          const pt = project.postTimeline;
          useDirector.getState().updateProject(project.id, {
            audioTracks: (project.audioTracks ?? []).filter((t) => !t.segmentId || alive.has(t.segmentId)),
            continuityCapsules: (project.continuityCapsules ?? []).filter((c) => alive.has(c.segmentId)),
            qualityReports: [],
            ...(pt
              ? { postTimeline: { ...pt, clipOverrides: Object.fromEntries(Object.entries(pt.clipOverrides).filter(([k]) => alive.has(k))) } }
              : {}),
          });
        }
        // 中英对照自动匹配（3.5）：当前稿是英文执行稿时，在剧本库里找同故事的中文稿按稳定键配对进 h3Prompt.zh
        if (doc && activeVersion) {
          const docsNow = useDirector.getState().getById(project.id)?.scripts ?? [];
          const zhDocId = matchZhCounterpartDoc(doc.title, docsNow, doc.id);
          const zhDoc = docsNow.find((d) => d.id === zhDocId);
          const zhBody = zhDoc?.versions.find((v) => v.id === zhDoc.activeVersionId) ?? zhDoc?.versions[zhDoc.versions.length - 1];
          if (zhBody?.body?.trim()) {
            const { pairZhIntoSegments } = await import("../../../core/studio/projectWorkspace");
            await pairZhIntoSegments(project.id, zhBody.body, activeVersion.body);
            extras.push(`中文对照稿「${zhDoc!.title}」已按段配对`);
          }
        }
        // 资产册参考槽重绑（3.5）：替换后片段 id 全新，按资产册「使用分段」把库内资产绑回新片段
        const { rebindCatalogSlots } = await import("../../../core/directorAssetCatalog");
        const rebound = rebindCatalogSlots(project.id);
        if (rebound) extras.push(`资产册参考槽已重绑 ${rebound} 项`);
      }
      useUi.getState().toast?.(
        `${dry.note}${mode === "merge" ? "（已追加）" : "（已替换为 " + (dry.scenes.reduce((n, s) => n + s.segments.length, 0)) + " 个新片段，片段选中已重置）"}${extras.length ? "；" + extras.join("；") : ""}——到 H3 导演台继续`,
        "ok",
      );
      setPreview(null);
      setSendMode(null);
    } catch (e) {
      useUi.getState().toast?.(`送入项目失败：${errMsg(e)}`, "err");
    }
  };

  const affected = useMemo(() => {
    const segs = project.scenes.flatMap((s) => s.segments);
    return {
      scenes: project.scenes.length,
      segments: segs.length,
      approved: segs.filter((s) => s.approvedTakeId).length,
      capsules: (project.continuityCapsules ?? []).length,
    };
  }, [project]);

  /** 当前选中的剧本是否已经送入项目（project.script 含该版本正文开头 = 送入过；替换/追加都会写 project.script） */
  const sentIn = useMemo(() => {
    const body = activeVersion?.body?.trim();
    if (!body) return true; // 空剧本谈不上送入，不提示
    return project.script.includes(body.slice(0, Math.min(60, body.length)));
  }, [project.script, activeVersion?.body]);

  /** 深解析当前版本：标题/段数/每段时长/衔接模式/引擎线索/提示词围栏/参考图/对白 */
  const inspection = useMemo<ScriptInspection | null>(
    () => (activeVersion?.body ? inspectScript(activeVersion.body, doc?.title) : null),
    [activeVersion?.body, doc?.title],
  );

  /** 导入语义执行体：new-project 建独立项目并切换 / version 只加版本 / append 走差异预演 */
  const ingestIntoNewProject = async (fileName: string, body: string) => {
    const { insp, docId } = createScriptDoc(project.id, fileName, body); // 先存进当前项目库（草稿），再整体搬进新项目
    const now = Date.now();
    const fresh = useDirector.getState().getById(project.id);
    const doc = fresh?.scripts?.find((d) => d.id === docId);
    const newProject: DirectorProject = {
      id: uid(10),
      nodeId: "",
      boardId: "",
      name: insp.title || fileName.replace(/\.(md|txt|json)$/i, "") || "新剧本项目",
      createdAt: now,
      updatedAt: now,
      targetDurationSec: insp.totalSec || 120,
      aspect: project.aspect,
      script: "",
      characters: [],
      scenes: [],
      recipes: [],
      globalSlots: [],
      timeline: [],
      workspaceMode: "pro",
      uiState: { workspace: "planning", inspectorTab: "content", cockpitView: "cockpit", segId: null },
      postTimeline: { clipOverrides: {}, titleCards: [], subtitles: [], fit: "contain" },
      scripts: doc ? [doc] : [],
      mvProjects: [],
      imageStudio: {},
      studioUi: { station: "h3", segId: null, scriptId: doc?.id },
      primaryScriptId: doc?.id,
      schemaVersion: DIRECTOR_SCHEMA_VERSION,
    };
    // 从当前项目摘出该草稿，放入新项目
    if (doc) {
      updateProject(project.id, { scripts: (useDirector.getState().getById(project.id)?.scripts ?? []).filter((d) => d.id !== docId) });
    }
    useDirector.getState().addImportedProject(newProject);
    // 确定性拆分（提示词包/分段脚本直入；完整剧本留草稿去新项目里拆）
    if (insp.kind !== "full") {
      const scenes = insp.kind === "prompts" ? importPromptSegments(body, 12).scenes : structuredToScenes(structuredSplit(body, 12), 12);
      const total = scenes.reduce((n, sc) => n + sc.segments.reduce((m, g) => m + g.durationSec, 0), 0);
      // 前言统一规格（3.5 §6.4）：第一个分段标记之前识别出的全片规格作为项目级候选
      const marks = collectSegmentMarks(body.trim());
      const prefix = marks.length ? body.slice(0, marks[0]) : body.slice(0, 3000);
      const prefixSpec = parseVideoSpecFromSegment(prefix);
      useDirector.getState().updateProject(newProject.id, {
        script: body,
        scenes,
        ...(total ? { targetDurationSec: total } : {}),
        ...(Object.keys(prefixSpec.sources ?? {}).length ? { videoSpecFromPrefix: prefixSpec } : {}),
      });
    }
    // 整体切换到新项目（清全局选中态）
    const ctx = (await import("../../../core/directorContext")).useDirectorCtx.getState();
    ctx.setSeg(null);
    ctx.setCompare(null);
    useUi.setState({ directorProjectId: newProject.id, directorNodeId: null });
    // 中英对照自动匹配（3.5）：同批导入的中文稿（当前项目剧本库里标题对应的中文侧）跟着搬进新项目并配对
    const extras: string[] = [];
    if (insp.kind !== "full") {
      const docsNow = useDirector.getState().getById(project.id)?.scripts ?? [];
      const zhDocId = matchZhCounterpartDoc(doc?.title ?? fileName, docsNow, docId);
      const zhDoc = docsNow.find((d) => d.id === zhDocId);
      const zhVer = zhDoc?.versions.find((v) => v.id === zhDoc.activeVersionId) ?? zhDoc?.versions[zhDoc.versions.length - 1];
      if (zhDoc && zhVer?.body?.trim()) {
        // 中文稿搬进新项目剧本库（保留原文档）
        const moved: ScriptDocument = { ...zhDoc };
        updateProject(project.id, { scripts: (useDirector.getState().getById(project.id)?.scripts ?? []).filter((d) => d.id !== zhDoc.id) });
        updateProject(newProject.id, { scripts: [moved, ...(useDirector.getState().getById(newProject.id)?.scripts ?? [])] });
        const { pairZhIntoSegments } = await import("../../../core/studio/projectWorkspace");
        await pairZhIntoSegments(newProject.id, zhVer.body, body);
        extras.push(`中文对照稿「${zhDoc.title}」已随迁并配对`);
      }
    }
    useUi.getState().toast?.(`已创建独立剧本项目「${newProject.name}」并切换（${insp.segments.length} 段）${extras.length ? "；" + extras.join("；") : ""}——角色库/H3/资产将独立`, "ok");
  };

  /** 智能导入（选择 / 粘贴 / 拖拽共用）：先问语义（新项目=推荐 / 当前项目新版本 / 追加） */
  const ingestScript = async (fileName: string, body: string) => {
    try {
      const insp0 = inspectScript(body, fileName);
      const different = insp0.title && insp0.title !== project.name && insp0.title !== (project.scripts ?? []).find((d) => d.id === project.studioUi?.scriptId)?.title;
      const scenesNow = useDirector.getState().getById(project.id)?.scenes.length ?? 0;
      const projectHasContent = scenesNow > 0 || (project.scripts ?? []).length > 0;
      if (ingestMode === "version") {
        const { docId } = createScriptDoc(project.id, fileName, body);
        updateProject(project.id, { studioUi: { ...project.studioUi ?? { station: "scripts" }, scriptId: docId } });
        useUi.getState().toast?.(`${inspectionSummary(insp0)}——已存为草稿，用「追加拆分 / 替换并重拆」送入项目`, "ok");
        return;
      }
      const needAsk = (ingestMode === "ask" || ingestMode === "append") && projectHasContent;
      if (needAsk) {
        setAsk({
          text: (
            <>
              <b>「{insp0.title || fileName}」</b>{inspectionSummary(insp0)}
              <div className="st-hint" style={{ marginTop: 6 }}>
                {different ? "标题与当前项目不同——推荐为它创建独立的剧本项目（角色库 / H3 / 资产完全隔离）。" : "选择这份剧本的去向："}
              </div>
            </>
          ),
          run: () => void ingestIntoNewProject(fileName, body),
          alt: () => {
            const { docId } = createScriptDoc(project.id, fileName, body);
            updateProject(project.id, { studioUi: { ...project.studioUi ?? { station: "scripts" }, scriptId: docId } });
            useUi.getState().toast?.(`已存为当前项目草稿——用「追加拆分 / 替换并重拆」送入项目`, "ok");
          },
        } as { text: React.ReactNode; run: () => void; alt?: () => void });
        return;
      }
      await ingestIntoNewProject(fileName, body);
    } catch (e) {
      useUi.getState().toast?.(`导入失败：${errMsg(e)}`, "err");
    }
  };
  const ingestRef = useRef(ingestScript);
  ingestRef.current = ingestScript;

  /* 粘贴上传：Ctrl+V 剧本正文 / 复制的剧本文件直接成稿（输入框聚焦时不劫持） */
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const cd = e.clipboardData;
      if (!cd) return;
      const files = Array.from(cd.files ?? []).filter((f) => /\.(md|txt|json)$/i.test(f.name));
      if (files.length) {
        e.preventDefault();
        for (const f of files) await ingestRef.current(f.name, await f.text());
        return;
      }
      const text = cd.getData("text/plain")?.trim();
      if (text && text.length >= 40) {
        e.preventDefault();
        await ingestRef.current("粘贴的剧本.md", text);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  return (
    <>
      <DockPanel
        className="sc-left"
        title="剧本库"
        projectId={project.id}
        widthKey="scLeft"
        width={project.studioUi?.panelWidths?.scLeft ?? 260}
        headExtra={
          <button className="st-btn sm" style={{ marginLeft: "auto" }} title="新建空剧本" onClick={newDoc}>
            <IcPlus size={12} /> 新建
          </button>
        }
      >
        {docs.length === 0 ? (
          <div className="st-empty"><b>剧本库还是空的</b>把剧本文件拖进本工位、Ctrl+V 粘贴正文、从 AI 导演存入，或点「导入」选文件。</div>
        ) : null}
        {docs.map((d) => {
          const ver = d.versions.find((v) => v.id === d.activeVersionId) ?? d.versions[d.versions.length - 1];
          return (
            <div
              key={d.id}
              className={`sc-doc${doc?.id === d.id ? " on" : ""}`}
              onClick={() => updateProject(project.id, { studioUi: { ...project.studioUi ?? { station: "h3" }, scriptId: d.id } })}
            >
              <div className="sc-doc-t">
                {d.title}
                <span className={`st-pill ${d.status === "official" ? "ok" : d.status === "archived" ? "" : "accent"}`}>{STATUS_LABEL[d.status]}</span>
              </div>
              <div className="sc-doc-m">
                {d.versions.length} 版 · {ver?.body.length ?? 0} 字 · {new Date(d.updatedAt).toLocaleDateString()}
              </div>
            </div>
          );
        })}
      </DockPanel>

      {/* 中：版本目录 + 正文编辑器 */}
      {doc ? (
        <section className="sc-editor">
          <div className="st-context">
            <input
              className="st-input"
              style={{ width: 180, fontWeight: 600 }}
              value={doc.title}
              onChange={(e) => patchDoc({ title: e.target.value })}
              aria-label="剧本标题"
            />
            <PopSelect
              value={doc.status}
              onChange={(v) => patchDoc({ status: v as ScriptDocument["status"] })}
              triggerIcon
              options={(["draft", "official", "archived"] as const).map((s) => ({ value: s, label: STATUS_LABEL[s], icon: s === "draft" ? SI.edit : s === "official" ? SI.check : SI.folder }))}
            />
            <span className="st-hint">{doc.versions.length} 个版本 · 当前「{activeVersion?.label}」</span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              {editing !== null ? (
                <>
                  <button className="st-btn sm" onClick={() => setEditing(null)}>放弃修改</button>
                  <button
                    className="st-btn sm primary"
                    onClick={() => {
                      saveVersion("手动编辑", editing);
                      setEditing(null);
                    }}
                  >
                    <IcCheck size={12} /> 存为新版本
                  </button>
                </>
              ) : (
                <button className="st-btn sm" onClick={() => setEditing(activeVersion?.body ?? "")}>
                  编辑正文
                </button>
              )}
              <button
                className="st-btn sm"
                title="对比最近两个版本"
                disabled={doc.versions.length < 2}
                onClick={() => setDiffVers({ a: doc.versions[doc.versions.length - 2].id, b: activeVersion!.id })}
              >
                <IcHistory size={12} /> 版本对比
              </button>
              <button
                className="st-btn sm"
                title="把当前项目正文另存为该剧本的新版本"
                onClick={() => saveVersion("从项目另存", project.script)}
              >
                <IcDownload size={12} /> 从项目另存
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".txt,.md,.json"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  try {
                    await ingestScript(f.name, await f.text());
                  } catch (err) {
                    useUi.getState().toast?.(errMsg(err), "err");
                  }
                  e.target.value = "";
                }}
              />
              <button className="st-btn sm" title="导入 txt / md / json 剧本文件（也可直接拖进工位或 Ctrl+V 粘贴）" onClick={() => fileRef.current?.click()}>
                <IcUpload size={12} /> 导入
              </button>
            </div>
          </div>
          {/* 版本时间线（横向） */}
          <div style={{ flex: "none", display: "flex", gap: 2, overflowX: "auto", borderBottom: "1px solid var(--studio-border)", padding: "6px 10px" }}>
            {[...doc.versions].reverse().map((v, i) => (
              <button
                key={v.id}
                className={`st-pill${v.id === activeVersion?.id ? " accent" : ""}`}
                style={{ cursor: "pointer", border: 0, flex: "none" }}
                title={`${v.label} · ${new Date(v.createdAt).toLocaleString()}${i === 0 ? "（最新）" : ""}`}
                onClick={() => patchDoc({ activeVersionId: v.id })}
              >
                {i === 0 ? "最新" : `v${doc.versions.length - i}`} · {v.label}
              </button>
            ))}
          </div>
          <textarea
            value={editing ?? activeVersion?.body ?? ""}
            readOnly={editing === null}
            onChange={(e) => setEditing(e.target.value)}
            placeholder="剧本正文…（拖入文件 / Ctrl+V 粘贴 / 导入按钮均可；完整剧本 / 已分段 / 成品提示词包自动识别）"
          />
        </section>
      ) : (
        <div className="st-empty" style={{ flex: 1 }}><IcLibrary size={30} /><b>选择或新建一个剧本</b></div>
      )}

      {/* 右：结构检查 + 送入项目 */}
      <DockPanel className="sc-right" title="结构检查与送入" projectId={project.id} widthKey="scRight" width={project.studioUi?.panelWidths?.scRight ?? 280}>
        <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="st-field">
            <label>当前版本结构</label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 12 }}>
              <span>正文 <b>{stats.chars}</b> 字</span>
              <span>识别场景 <b>{stats.scenes || "—"}</b></span>
              <span>对白痕迹 <b>{stats.dialogue || "—"}</b> 处</span>
              <span>预估时长 <b>{stats.estSec}</b> 秒</span>
            </div>
          </div>
          <div className="st-field">
            <label>导入语义（拖入 / 粘贴 / 选择导入共用）</label>
            <PopSelect
              value={ingestMode}
              onChange={(v) => setIngestMode(v as typeof ingestMode)}
              triggerIcon
              options={[
                { value: "ask", label: "每次询问（推荐）", icon: SI.edit },
                { value: "new-project", label: "总是新建独立项目", icon: SI.folder },
                { value: "version", label: "总是存为当前项目草稿", icon: SI.history },
              ]}
            />
            <span className="st-hint">不同故事的剧本应各自成项目（角色库 / H3 / 资产隔离）；同一故事的改编稿用「存为草稿」走版本管理。</span>
          </div>
          {inspection ? (
            <div className="st-field">
              <label>
                内容解析（{inspection.kindLabel} · {inspection.segments.length} 段{inspection.totalSec ? ` · ${inspection.totalSec}s` : ""}）
              </label>
              {inspection.segments.length ? (
                <div style={{ maxHeight: 230, overflow: "auto", border: "1px solid var(--studio-border)", borderRadius: 6 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                    <thead>
                      <tr style={{ color: "var(--studio-text-3)", position: "sticky", top: 0, background: "var(--studio-panel)" }}>
                        <th style={TH}>#</th>
                        <th style={TH}>分段名</th>
                        <th style={TH}>时长</th>
                        <th style={TH}>衔接</th>
                        <th style={TH}>引擎</th>
                        <th style={TH}>提示词</th>
                        <th style={TH}>图/视/音</th>
                        <th style={TH}>对白</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inspection.segments.map((s) => (
                        <tr key={s.index} style={{ borderTop: "1px solid var(--studio-border)" }}>
                          <td style={TD}>{s.index}</td>
                          <td style={{ ...TD, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }} title={s.title}>{s.title}</td>
                          <td style={TD}>{s.durationSec ? `${s.durationSec}s` : "—"}</td>
                          <td style={TD}>{s.mode ?? "—"}</td>
                          <td style={TD}>{s.engine ?? "—"}</td>
                          <td style={TD} title={s.hasFence ? "有显式提示词围栏" : "无围栏，按正文处理"}>{s.hasFence ? "✓ " : ""}{s.promptChars}字</td>
                          <td style={TD} title={`<Picture> ${s.pictures} · <Video> ${s.videos} · <Audio> ${s.audios}`}>{s.pictures}/{s.videos}/{s.audios}</td>
                          <td style={TD} title={s.dialogue.join("\n")}>{s.dialogue.length}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {inspection.warnings.map((w) => (
                <div key={w} className="st-hint" style={{ color: "var(--warn)" }}>{w}</div>
              ))}
              {inspection.globalStyle ? <div className="st-hint">已识别全局风格锚定（{inspection.globalStyle.length} 字），送入时写入项目规则</div> : null}
            </div>
          ) : null}
          <div className="st-field">
            <label>送入当前项目</label>
            {!sentIn ? (
              <div className="st-hint" style={{ color: "var(--warn)", lineHeight: 1.6, marginBottom: 4 }}>
                「{doc?.title ?? "这份剧本"}」还没送入项目——H3 导演台现在显示的仍是上次送入的 {affected.segments} 个片段。点「替换并重拆」才会把这份剧本变成项目片段。
              </div>
            ) : null}
            <span className="st-hint" style={{ lineHeight: 1.6 }}>
              {sentIn ? "当前项目片段正来自这份剧本。" : ""}项目现有 {affected.segments} 个片段（已采用 {affected.approved}、微参考胶囊 {affected.capsules} 个）。
              「替换并重拆」= 全量替换为新片段（Take 与资产保留在库，资产册参考槽按「使用分段」自动重绑；剧本库里有同故事中文稿时自动配对双语）；
              「追加拆分」= 旧片段保留、新场景接在后面。
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="st-btn sm" disabled={!activeVersion?.id} onClick={() => setSendMode("merge")}>
                <IcMerge size={12} /> 追加拆分
              </button>
              <button className="st-btn sm" disabled={!activeVersion?.id} onClick={() => setSendMode("replace")}>
                <IcUpload size={12} /> 替换并重拆
              </button>
            </div>
          </div>
          <div className="st-field">
            <label>绑定总文件夹（资产库）</label>
            <span className="st-hint" style={{ lineHeight: 1.6 }}>
              已按 1.0 习惯把一个片段的图片/视频/音乐整理进文件夹？选总文件夹自动识别：完整剧本、分段剧本-中/英（自动配对双语）、
              资产提示词.md（图片/视频/音频按「使用分段」绑参考槽，人物条目自动进角色库）、分段资产库。Take/成片也会写回该目录。
            </span>
            <button
              className="st-btn sm"
              title="选择剧本总文件夹：自动扫描中英文剧本 + 资产库并导入（预演确认后才写入）"
              onClick={async () => {
                const r = await bindProjectFolderFlow(project.id);
                if (r) setBindScan(r);
              }}
            >
              <IcLibrary size={12} /> 绑定总文件夹…
            </button>
          </div>
          {doc ? (
            <>
              {docs.length > 1 ? (
                <button
                  className="st-btn sm"
                  title="归档（不删除版本与已送入内容）"
                  onClick={() => patchDoc({ status: "archived" })}
                >
                  <IcTrash size={12} /> 归档此剧本
                </button>
              ) : null}
              <button
                className="st-btn sm danger"
                title="彻底删除这份剧本的全部版本（已送入项目的场景/片段与 Take 不受影响）"
                onClick={() =>
                  setAsk({
                    text: (
                      <>
                        彻底删除剧本 <b>「{doc.title}」</b>（{doc.versions.length} 个版本）？
                        <div className="st-hint" style={{ marginTop: 4 }}>
                          只删除剧本库里的这份文档；此前「送入项目」拆出的场景、片段与 Take 全部保留。此操作不可撤销。
                        </div>
                      </>
                    ),
                    run: () => removeScriptDoc(project.id, doc.id),
                  })
                }
              >
                <IcTrash size={12} /> 删除剧本
              </button>
            </>
          ) : null}
        </div>
      </DockPanel>

      {/* 版本差异 / 送入确认（双栏差异复用） */}
      {diffVers && doc ? (
        <div className="st-diff-mask" onClick={() => setDiffVers(null)}>
          <div className="st-diff" onClick={(e) => e.stopPropagation()}>
            <div className="st-diff-h"><IcHistory size={15} /> 版本对比
              <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                {[...doc.versions].reverse().map((v, i) => (
                  <PopSelect
                    key={v.id}
                    value={i === 0 ? diffVers.b : diffVers.a}
                    onChange={(x) => setDiffVers({ ...diffVers, [i === 0 ? "b" : "a"]: String(x) })}
                    triggerIcon
                    options={doc.versions.map((vv) => ({ value: vv.id, label: vv.label, icon: SI.history }))}
                  />
                ))}
              </div>
            </div>
            <div className="st-diff-cols">
              <div className="st-diff-col"><h6>旧版本</h6><div className="st-diff-body">{doc.versions.find((v) => v.id === diffVers.a)?.body.slice(0, 6000)}</div></div>
              <div className="st-diff-col"><h6>新版本</h6><div className="st-diff-body">{doc.versions.find((v) => v.id === diffVers.b)?.body.slice(0, 6000)}</div></div>
            </div>
            <div className="st-diff-f">
              <button
                className="st-btn"
                onClick={() => {
                  // 回退 = 以旧版本正文另存新版本（历史不丢）
                  saveVersion(`回退自 ${doc.versions.find((v) => v.id === diffVers.a)?.label}`, doc.versions.find((v) => v.id === diffVers.a)?.body ?? "");
                  setDiffVers(null);
                }}
              >
                回退到左侧版本
              </button>
              <button className="st-btn primary" onClick={() => setDiffVers(null)}><IcClose size={13} /> 关闭</button>
            </div>
          </div>
        </div>
      ) : null}

      {sendMode ? (
        <div className="st-diff-mask" onClick={() => setSendMode(null)}>
          <div className="st-diff" onClick={(e) => e.stopPropagation()}>
            <div className="st-diff-h">
              <IcUpload size={15} /> {sendMode === "replace" ? "替换项目剧本（先预演拆分差异）" : "追加拆分为新场景"}
            </div>
            <div style={{ padding: "12px 16px", fontSize: 12.5, lineHeight: 1.8, color: "var(--studio-text-2)" }}>
              {sendMode === "replace" ? (
                <>
                  将以「{doc?.title} · {activeVersion?.label}」重新拆分，先展示新旧场景差异与影响面，确认后才写入。<br />
                  当前项目：{affected.scenes} 场 / {affected.segments} 片段（已采用 {affected.approved}、微参考胶囊 {affected.capsules} 个）。
                </>
              ) : (
                <>把「{doc?.title} · {activeVersion?.label}」拆分出的场景追加到项目末尾；已有片段不受影响。</>
              )}
            </div>
            <div className="st-diff-f">
              <button className="st-btn" onClick={() => setSendMode(null)}>取消</button>
              <button className="st-btn primary" disabled={!activeVersion?.id} onClick={() => void doSend()}>
                <IcCheck size={13} /> {sendMode === "replace" ? "预演拆分差异" : "确认追加"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 替换模式的差异预演卡（3.2 §4.2：真差异 + 影响分析，确认前不写 project.script） */}
      {preview ? (
        <div className="st-diff-mask" onClick={() => setPreview(null)}>
          <div className="st-diff" onClick={(e) => e.stopPropagation()}>
            <div className="st-diff-h">
              <IcMerge size={15} /> 替换差异预演 · {preview.note}
              <span className="st-hint">识别类型：{preview.kind === "prompts" ? "成品提示词包" : preview.kind === "segmented" ? "已分段脚本" : "完整剧本"}</span>
            </div>
            <div className="st-diff-cols">
              <div className="st-diff-col">
                <h6>当前项目（{affected.scenes} 场 · {affected.segments} 片段）</h6>
                <div className="st-diff-body">
                  {project.scenes.map((sc, i) => (
                    <div key={sc.id} style={{ marginBottom: 6 }}>
                      <b>{i + 1}. {sc.location}</b>
                      {sc.segments.map((sg) => (
                        <div key={sg.id} className="st-hint">
                          {"　"}- {sg.summary.slice(0, 30)}{sg.approvedTakeId ? " ✓" : ""}
                        </div>
                      ))}
                    </div>
                  ))}
                  {!project.scenes.length ? "（空项目）" : null}
                </div>
              </div>
              <div className="st-diff-col">
                <h6>新草案（{preview.scenes.length} 场 · {preview.scenes.reduce((n, s) => n + s.segments.length, 0)} 片段）</h6>
                <div className="st-diff-body">
                  {preview.scenes.map((sc, i) => (
                    <div key={i} style={{ marginBottom: 6 }}>
                      <b>{i + 1}. {sc.location}</b>
                      {sc.segments.map((sg) => (
                        <div key={sg.id} className="st-hint">
                          {"　"}- {sg.summary.slice(0, 30)} · {sg.durationSec}s
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div style={{ padding: "10px 16px", fontSize: 12, lineHeight: 1.8, color: "var(--studio-text-2)", borderTop: "1px solid var(--studio-border)" }}>
              ⚠ 全量替换：现有 {affected.segments} 个片段将移出时间线（{affected.approved} 个已采用 Take 的<b>资产保留在资产库</b>可手动找回），
              {affected.capsules} 个微参考胶囊将失效；新草案 {preview.scenes.reduce((n, s) => n + s.segments.length, 0)} 个片段从零生成。
              若只想增加内容，选「追加为新场景」（旧片段与 Take 全部保留）。
            </div>
            <div className="st-diff-f">
              <button className="st-btn" onClick={() => setPreview(null)}>取消</button>
              <button className="st-btn" title="新草案追加到现有场景末尾；旧片段、Take 与微参考全部保留" onClick={() => void applyDry(preview.body, preview, "merge")}>
                <IcMerge size={13} /> 追加为新场景（无损）
              </button>
              <button className="st-btn primary" title="用新草案替换全部场景（旧片段移出，资产保留）" onClick={() => void applyDry(preview.body, preview, "replace")}>
                <IcCheck size={13} /> 全量替换
              </button>
            </div>
          </div>
        </div>
      ) : null}
          {ask ? (
        <AskCard
          text={ask.text}
          okText="创建独立项目（推荐）"
          onConfirm={() => {
            ask.run();
            setAsk(null);
          }}
          onCancel={() => setAsk(null)}
        >
          {(ask as { alt?: () => void }).alt ? (
            <button
              className="st-btn sm"
              style={{ marginTop: 8 }}
              onClick={() => {
                (ask as { alt?: () => void }).alt?.();
                setAsk(null);
              }}
            >
              存为当前项目的草稿版本
            </button>
          ) : null}
        </AskCard>
      ) : null}
      {bindScan ? (
        <AskCard
          danger={!!bindScan.conflict}
          text={
            <>
              <b>{bindScan.conflict ? "绑定并导入（目录与当前项目片段冲突）" : "绑定总文件夹并导入"}</b>
              <div className="st-hint" style={{ marginTop: 4 }}>{bindScan.scan.rootPath}</div>
              <div className="st-hint">扫描结果：{bindScan.scan.summary}</div>
              {bindScan.conflict ? (
                bindScan.conflict.notes.map((n, i) => (
                  <div className="st-hint" key={i} style={i === 0 ? { marginTop: 4, color: "var(--warn)" } : { marginTop: 2 }}>
                    {i === 0 ? "⚠ " : "· "}
                    {n}
                  </div>
                ))
              ) : (
                <div className="st-hint" style={{ marginTop: 4 }}>
                  确认后自动导入：完整剧本入剧本库 · 分段剧本-英直录成片段 · 中文稿按段配对 · 资产册媒体绑参考槽（人物进角色库）。
                  内容没变时重复绑定不会重复导入。
                </div>
              )}
            </>
          }
          okText={bindScan.conflict ? "覆盖导入" : "绑定"}
          onConfirm={() => {
            void bindScan.apply(bindScan.conflict ? "overwrite" : "auto");
            setBindScan(null);
          }}
          onCancel={() => setBindScan(null)}
        >
          {bindScan.conflict ? (
            <div className="st-row" style={{ marginTop: 6 }}>
              <button
                className="st-btn sm ghost"
                onClick={() => {
                  void bindScan.apply("merge");
                  setBindScan(null);
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
