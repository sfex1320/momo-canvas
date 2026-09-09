/**
 * ComfyUI 工作流模板管理器
 *  导入 API 格式 JSON（选文件 / 多选批量 / 直接拖入 / Ctrl+V 粘贴）→ 勾选要暴露的输入/参数
 *  → 指定输出节点 → 保存为模板；模板可单个/批量导出为模板包，再导入即恢复
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Field, Row, Switch } from "../../ui/kit";
import { PopSelect } from "../../ui/PopSelect";
import { useComfy, useComfyTemplates } from "../../core/stores/comfyStore";
import { useComfySync } from "../../core/stores/comfySyncStore";
import { useSettings } from "../../core/stores/settingsStore";
import { toast, useUi } from "../../core/stores/uiStore";
import {
  analyzeCaps,
  analyzeCapsV3,
  canDisable,
  comboOptionsFor,
  fetchObjectInfo,
  guessOutputNode,
  isApiWorkflow,
  listWorkflowInputs,
} from "../../core/services/comfy";
import { layoutWorkflow, zhInput, zhNode, WFG_H, WFG_W, connectedComponents } from "./wfGraph";
import { errMsg, uid } from "../../core/utils";
import { IcClose, IcDownload, IcEdit, IcFlow, IcLink, IcRefresh, IcTrash, IcUpload } from "../../ui/icons";
import {
  applyComfyLayout,
  autoExposeMap,
  comfyEditFilename,
  importTemplateFilesAuto,
  isTripWatching,
  packTemplates,
  paramsFromExpose,
  saveTextFile,
  startComfyRoundTrip,
  stopTripWatch,
  syncFromComfyEditor,
  templatesFromJson,
  type ExposeMap,
} from "./templateIO";
import type { ComfyParamKind, ComfySemanticSlot, ComfyTemplate, ComfyVariant, ComfyVariantColor, ComfyWfNode } from "../../core/types";

type Draft = {
  id: string;
  name: string;
  workflow: ComfyTemplate["workflow"];
  outputNodeId?: string;
  expose: ExposeMap;
  disabledNodes: string[];
  /** 子工作流分支（手动编辑用；保存时直接写入模板） */
  variants?: ComfyVariant[];
};

function draftFromTemplate(t: ComfyTemplate): Draft {
  const expose: ExposeMap = {};
  for (const p of t.params) expose[p.key] = { label: p.label, kind: p.kind };
  return {
    id: t.id,
    name: t.name,
    workflow: t.workflow,
    outputNodeId: t.outputNodeId,
    expose,
    disabledNodes: t.disabledNodes ?? [],
    variants: t.variants,
  };
}

/** 分支配色循环（语义色名，样式通过主题 token + color-mix 生成，不硬编码 rgba） */
const VARIANT_COLORS: ComfyVariantColor[] = ["blue", "green", "orange", "purple", "cyan", "pink"];

/**
 * 按连通分量自动生成子工作流分支：工作流里完全断开的处理链各自成为一个分支。
 * 单连通分量（绝大多数工作流）→ 返回 undefined，保持 v1 单分支行为不变。
 * 多连通分量 → 每个分量生成一个 variant（nodeIds/outputNodeIds/params 按分量隔离）。
 * 分支名按内容自动命名（出图/出视频/图输入/放大/控制…），不再是「分支 1/2/3」这种认不出的名字。
 */
function autoVariantsFromWorkflow(
  wf: Record<string, ComfyWfNode>,
  params: ComfyTemplate["params"],
  outputNodeId?: string,
): ComfyVariant[] | undefined {
  const comps = connectedComponents(wf);
  if (comps.length <= 1) return undefined;
  // 输出节点集合：用户指定的 outputNodeId 或 analyzeCaps 自动识别的输出类节点
  const outSet = new Set<string>();
  if (outputNodeId) outSet.add(outputNodeId);
  for (const id of Object.keys(wf)) {
    if (/saveimage|previewimage|save|preview/i.test(wf[id].class_type)) outSet.add(id);
  }
  // 用 analyzeCapsV3 自动识别语义槽（首帧/尾帧/参考图/视频/音频/提示词）
  const capsV3 = analyzeCapsV3(wf);
  const usedNames = new Set<string>();
  return comps.map((comp, i) => {
    const compSet = new Set(comp);
    const outputs = comp.filter((id) => outSet.has(id));
    const compParams = params.filter((p) => compSet.has(p.nodeId));
    // 过滤出属于本分支的语义槽
    const slots: ComfySemanticSlot[] = (capsV3.autoSlots ?? [])
      .filter((s) => compSet.has(s.nodeId))
      .map((s, idx) => ({
        id: `slot_${idx}`,
        label: s.label,
        semantic: s.semantic as ComfySemanticSlot["semantic"],
        media: s.media as ComfySemanticSlot["media"],
        required: s.required,
        bindings: [{ nodeId: s.nodeId, input: s.input }],
      }));
    // 自动命名 + 重名去重（同结构的分支加 (2)/(3)）
    const baseName = autoVariantName(comp, wf);
    let name = baseName;
    for (let k = 2; usedNames.has(name); k++) name = `${baseName} (${k})`;
    usedNames.add(name);
    return {
      id: i === 0 ? "default" : `branch_${i}`,
      name,
      color: VARIANT_COLORS[i % VARIANT_COLORS.length],
      nodeIds: comp,
      outputNodeIds: outputs,
      params: compParams,
      slots,
    };
  });
}

/** 按分支内的节点类型自动起中文名：输出类型 → 输入特征 → 特殊处理（放大/控制/视频） */
function autoVariantName(comp: string[], wf: Record<string, ComfyWfNode>): string {
  const cts = comp.map((id) => wf[id]?.class_type ?? "");
  const has = (re: RegExp) => cts.some((c) => re.test(c));
  const parts: string[] = [];
  if (has(/saveimage|previewimage/i)) parts.push("出图");
  else if (has(/vhs_videocombine|savevideo|videocombine/i)) parts.push("出视频");
  else if (has(/showtext|savetext/i)) parts.push("出文本");
  if (has(/loadimage/i) && has(/cliptextencode/i)) parts.push("图+文");
  else if (has(/loadimage/i)) parts.push("图生");
  else if (has(/cliptextencode/i)) parts.push("文生");
  if (has(/upscale|hiresfix/i)) parts.push("放大");
  else if (has(/controlnet|hed|canny|depth|openpose|lineart|dwpreprocessor/i)) parts.push("控制");
  else if (has(/loadvideo|vhs_/i)) parts.push("视频");
  return parts.length ? parts.join("·") : "未识别";
}

export function TemplateManager() {
  const open = useUi((s) => s.templateMgrOpen);
  const editId = useUi((s) => s.templateMgrEdit);
  const close = () => useUi.getState().setTemplateMgr(false);
  const templates = useComfyTemplates();
  const upsert = useComfy((s) => s.upsert);
  const remove = useComfy((s) => s.remove);
  const syncWorkflows = useComfySync((s) => s.workflows);
  const setComfySyncOpen = useUi((s) => s.setComfySyncOpen);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // ComfyUI 往返编辑：监听会话在 templateIO 模块级存活（关掉本弹窗也继续），这里只同步展示状态
  const [tripIds, setTripIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    setTripIds(new Set(templates.filter((x) => isTripWatching(x.id)).map((x) => x.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const toggleTrip = (t: ComfyTemplate) => {
    if (tripIds.has(t.id)) {
      stopTripWatch(t.id);
      setTripIds((prev) => {
        const n = new Set(prev);
        n.delete(t.id);
        return n;
      });
      toast(`已停止「${t.name}」的自动同步监听`, "info");
      return;
    }
    void startComfyRoundTrip(t).then(
      () => {
        setTripIds((prev) => new Set(prev).add(t.id));
        toast(`已推送到 ComfyUI 工作流库并打开浏览器：在 ComfyUI 左侧「工作流」列表点开 ${comfyEditFilename(t.name)} 开始编辑，Ctrl+S 保存后这里自动同步`, "ok");
      },
      (e) => toast(`送出失败：${errMsg(e)}`, "err"),
    );
  };
  // combo 下拉选项：编辑器里同样从 ComfyUI 服务端 /object_info 拉取（缓存；离线退化为文本框）
  const comfyHost = useSettings((s) => s.settings.comfy.host);
  const [objectInfo, setObjectInfo] = useState<Record<string, any> | null>(null);
  useEffect(() => {
    if (!open) return;
    let on = true;
    void fetchObjectInfo(comfyHost).then((info) => {
      if (on) setObjectInfo(info);
    });
    return () => {
      on = false;
    };
  }, [open, comfyHost]);

  /* 设置页模板卡片点「编辑」→ 打开管理器直接进入对应模板 */
  useEffect(() => {
    if (!open || !editId) return;
    const t = useComfy.getState().templates.find((x) => x.id === editId);
    if (t) setDraft(draftFromTemplate(t));
    useUi.setState({ templateMgrEdit: null });
  }, [open, editId]);

  /** 识别单份 JSON：原始工作流 → 进编辑器勾参数；模板/模板包 → 直接保存 */
  const routeImport = (json: unknown, nameHint: string): { drafted: boolean; saved: number } => {
    if (isApiWorkflow(json)) {
      // API 格式本身无坐标：用真实尺寸布局估一份 pos/size 存上，推回 ComfyUI 时不再全部挤左
      const workflow = applyComfyLayout(json);
      setDraft({
        id: uid(8),
        name: nameHint,
        workflow,
        outputNodeId: guessOutputNode(workflow),
        expose: autoExposeMap(listWorkflowInputs(workflow)),
        disabledNodes: [],
      });
      return { drafted: true, saved: 0 };
    }
    const tpls = templatesFromJson(json);
    if (!tpls) throw new Error("内容既不是 API 格式工作流，也不是 momo 模板/模板包");
    for (const t of tpls) upsert(t);
    return { drafted: false, saved: tpls.length };
  };

  const importText = (text: string, nameHint = "粘贴的工作流") => {
    try {
      const r = routeImport(JSON.parse(text), nameHint);
      if (r.saved) toast(`已导入 ${r.saved} 个模板 ✓`, "ok");
      else toast("已读取工作流：勾选要暴露的参数后保存即可", "ok");
    } catch (e) {
      toast(`导入失败：${errMsg(e)}`, "err");
    }
  };

  /** 文件导入：单个原始工作流走编辑器；多选一律自动建模板（批量） */
  const importFiles = async (files: Iterable<File>) => {
    const list = Array.from(files);
    if (!list.length) return;
    if (list.length === 1) {
      try {
        routeImportFile(list[0]);
      } catch {
        /* routeImportFile 内部已 toast */
      }
      return;
    }
    const { saved, errs } = await importTemplateFilesAuto(list);
    if (saved) toast(`批量导入完成：${saved} 个模板 ✓（原始工作流已自动暴露常用参数，可再进编辑微调）`, "ok");
    if (errs.length) toast(`${errs.length} 个文件失败：${errs[0]}`, "err");
  };

  const routeImportFile = (f: File) => {
    void f.text().then(
      (text) => importText(text, f.name.replace(/\.json$/i, "")),
      (e) => toast(`读取文件失败：${errMsg(e)}`, "err"),
    );
  };

  /* 列表视图下 Ctrl+V 直接粘贴导入 */
  useEffect(() => {
    if (!open || draft) return;
    const onPaste = (e: ClipboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const text = e.clipboardData?.getData("text")?.trim();
      if (text) {
        e.stopPropagation();
        importText(text);
      }
    };
    window.addEventListener("paste", onPaste, true);
    return () => window.removeEventListener("paste", onPaste, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft]);

  if (!open) return null;

  const exportAll = async () => {
    if (!templates.length) return toast("还没有模板可导出", "err");
    if (await saveTextFile("momo-comfy-templates.json", packTemplates(templates)))
      toast(`已导出全部 ${templates.length} 个模板 ✓`, "ok");
  };

  const saveDraft = () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      toast("请给模板起个名字", "err");
      return;
    }
    const params = paramsFromExpose(draft.workflow, draft.expose, objectInfo);
    // 分支优先级：draft 手动编辑过的 variants > 自动检测连通分量
    const variants = draft.variants?.length
      ? draft.variants
      : autoVariantsFromWorkflow(draft.workflow, params, draft.outputNodeId);
    const tplId = draft.id;
    // 保存不丢同步关联：draft 不带 workflowId，从现存模板找回（同步派生模板保存后仍是同步模板）
    const existing = useComfy.getState().templates.find((t) => t.id === tplId);
    upsert({
      id: tplId,
      name: draft.name.trim(),
      workflow: draft.workflow,
      params,
      outputNodeId: draft.outputNodeId,
      disabledNodes: draft.disabledNodes.length ? draft.disabledNodes : undefined,
      variants,
      createdAt: Date.now(),
      ...(existing?.workflowId ? { workflowId: existing.workflowId } : {}),
    });
    const branchNote = variants && variants.length > 1 ? ` · ${variants.length} 个分支` : "";
    toast(`模板「${draft.name.trim()}」已保存（${params.length} 个参数${branchNote}）`, "ok");
    setDraft(null);
    // M2：双向同步的模板，保存即把参数改动写回源文件（未开启双向则安静跳过）
    void import("../../core/comfySync/engine").then((m) => m.maybeWriteBackTemplate(tplId));
  };

  return (
    <Modal
      title={draft ? `编辑模板 · ${draft.name || "未命名"}` : "ComfyUI 工作流模板"}
      onClose={() => (draft ? setDraft(null) : close())}
      width={draft ? 1120 : 880}
      footer={
        draft ? (
          <>
            <button className="btn" onClick={() => setDraft(null)}>返回列表</button>
            <button className="btn primary" onClick={saveDraft}>保存模板</button>
          </>
        ) : undefined
      }
    >
      {!draft ? (
        <div
          className={`tpl-drop ${dragOver ? "on" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files.length) void importFiles(e.dataTransfer.files);
            else {
              const t = e.dataTransfer.getData("text/plain")?.trim();
              if (t) importText(t, "拖入的工作流");
            }
          }}
        >
          <Row style={{ marginBottom: 10, flexWrap: "wrap" }}>
            <button className="btn primary" onClick={() => fileRef.current?.click()}>
              <IcUpload size={16} /> 导入工作流 / 模板（可多选）
            </button>
            <button
              className="btn"
              title="读取剪贴板里的 JSON 导入；直接按 Ctrl+V 也可以"
              onClick={() =>
                navigator.clipboard
                  .readText()
                  .then((t) => (t.trim() ? importText(t) : toast("剪贴板是空的", "err")))
                  .catch(() => toast("读取剪贴板失败——直接按 Ctrl+V 粘贴也可以", "err"))
              }
            >
              粘贴导入
            </button>
            <button className="btn" title="把全部模板导出为一个模板包 JSON，可在其他设备导入恢复" onClick={() => void exportAll()}>
              <IcDownload size={15} /> 全部导出
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) void importFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </Row>
          <p className="sec-desc" style={{ marginBottom: 14 }}>
            支持：ComfyUI「导出（API）」的工作流 JSON（文件/拖入/粘贴均可）· momo 模板/模板包 JSON。
            多选文件批量导入时会自动暴露提示词/种子/图片等常用参数，之后可再进编辑微调。
          </p>
          {templates.length === 0 ? (
            <div style={{ textAlign: "center", color: "var(--text-3)", padding: "48px 0", lineHeight: 2 }}>
              <IcFlow size={36} />
              <br />
              还没有模板：导入 / 拖入 / 粘贴一个工作流开始吧
            </div>
          ) : (
            templates.map((t) => (
              <div key={t.id} className="tpl-row">
                <span className="kind-ic" style={{ width: 34, height: 34, borderRadius: 9, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--grad-brand-soft)", color: "var(--accent)" }}>
                  <IcFlow size={17} />
                </span>
                <div className="tn">
                  <b>
                    {t.name}
                    {t.workflowId ? <span className="tpl-sync-tag" title="由 Comfy 工作流同步维护：源文件保存后自动更新，画布实例参数不受影响">同步</span> : null}
                  </b>
                  <span>
                    {Object.keys(t.workflow).length} 个节点 · 暴露 {t.params.length} 个参数
                    {(() => {
                      const sw = syncWorkflows.find((w) => w.workflowId === t.workflowId);
                      if (!sw) return "";
                      return ` · ${sw.status === "synced" ? "源文件已同步" : sw.status === "derive_failed" ? "待派生（ComfyUI 上线后自动补）" : "源状态：" + sw.status}`;
                    })()}
                    {tripIds.has(t.id) ? " · 🔄 ComfyUI 编辑中（保存即自动同步）" : ""}
                  </span>
                </div>
                <button className="icon-btn" title="编辑参数" onClick={() => setDraft(draftFromTemplate(t))}>
                  <IcEdit size={17} />
                </button>
                {t.workflowId ? (
                  <button
                    className="icon-btn"
                    title="此模板由无感同步维护：在 ComfyUI 里编辑源文件并保存即自动更新。点此打开同步中心（版本历史 / 状态）"
                    onClick={() => setComfySyncOpen(true)}
                  >
                    <IcLink size={17} />
                  </button>
                ) : (
                  <>
                    <button
                      className={`icon-btn${tripIds.has(t.id) ? " on" : ""}`}
                      title={
                        tripIds.has(t.id)
                          ? "停止自动同步监听（ComfyUI 里的文件保留）"
                          : "一键 ComfyUI 编辑：模板写进工作流目录并自动打开 ComfyUI（左侧列表点开 MOMO_*.json），改完 Ctrl+S，这里自动同步回模板"
                      }
                      onClick={() => toggleTrip(t)}
                    >
                      {tripIds.has(t.id) ? <IcClose size={17} /> : <IcUpload size={17} />}
                    </button>
                    <button
                      className="icon-btn"
                      title="从 ComfyUI 收回：读取 ComfyUI 里保存过的 MOMO_<模板名>.json（前端格式自动转换），更新本模板（保留名称/分支，失效的暴露参数自动剔除）"
                      onClick={() =>
                        void syncFromComfyEditor(t).then(
                          (r) => {
                            upsert(r.merged);
                            toast(
                              `模板「${t.name}」已同步更新（${Object.keys(r.merged.workflow).length} 个节点${r.droppedParams ? `，剔除 ${r.droppedParams} 个失效参数` : ""}）${r.warnings.length ? `；⚠️ ${r.warnings[0]}` : ""}`,
                              "ok",
                            );
                          },
                          (e) => toast(`同步失败：${errMsg(e)}`, "err"),
                        )
                      }
                    >
                      <IcRefresh size={17} />
                    </button>
                  </>
                )}
                <button
                  className="icon-btn"
                  title="导出该模板（含参数配置，可再导入）"
                  onClick={() =>
                    void saveTextFile(`${t.name}.momo-tpl.json`, packTemplates([t])).then(
                      (ok) => ok && toast(`模板「${t.name}」已导出 ✓`, "ok"),
                    )
                  }
                >
                  <IcDownload size={17} />
                </button>
                <button
                  className={`icon-btn danger`}
                  title={confirmDel === t.id ? "再点一次确认删除" : "删除模板"}
                  style={confirmDel === t.id ? { color: "var(--danger)", background: "color-mix(in srgb, var(--danger) 12%, transparent)" } : undefined}
                  onClick={() => {
                    if (confirmDel === t.id) {
                      remove(t.id);
                      setConfirmDel(null);
                    } else setConfirmDel(t.id);
                  }}
                >
                  <IcTrash size={17} />
                </button>
              </div>
            ))
          )}
        </div>
      ) : (
        <TemplateEditor draft={draft} setDraft={setDraft} objectInfo={objectInfo} />
      )}
    </Modal>
  );
}

function TemplateEditor({ draft, setDraft, objectInfo }: { draft: Draft; setDraft: (d: Draft) => void; objectInfo: Record<string, any> | null }) {
  const layout = useMemo(() => layoutWorkflow(draft.workflow), [draft.workflow]);
  const caps = useMemo(() => analyzeCaps(draft.workflow), [draft.workflow]);
  const [sel, setSel] = useState<string | null>(() => caps.imageEntries[0] ?? Object.keys(draft.workflow)[0] ?? null);
  // 示意图视图：空白处按住拖动平移 + 滚轮缩放（抓手工具）
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const panRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const off = new Set(draft.disabledNodes);
  const exposedCount = Object.keys(draft.expose).length;
  const positives = caps.textEntries.filter((t) => !t.negative);
  // 节点 → 所属分支颜色（用于示意图节点边框着色，直观显示分支归属）
  const nodeVariantColor = new Map<string, ComfyVariantColor>();
  for (const v of draft.variants ?? []) {
    for (const nid of v.nodeIds) if (!nodeVariantColor.has(nid)) nodeVariantColor.set(nid, v.color);
  }

  const toggleDisable = (nodeId: string) => {
    if (off.has(nodeId)) {
      setDraft({ ...draft, disabledNodes: draft.disabledNodes.filter((x) => x !== nodeId) });
      return;
    }
    const chk = canDisable(draft.workflow, nodeId);
    if (!chk.ok) {
      toast(chk.why ?? "该节点无法忽略", "err");
      return;
    }
    setDraft({
      ...draft,
      disabledNodes: [...draft.disabledNodes, nodeId],
      // 忽略的是当前输出节点 → 输出改回自动
      outputNodeId: draft.outputNodeId === nodeId ? undefined : draft.outputNodeId,
    });
  };

  return (
    <>
      <Row gap={12} style={{ marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <Field label="模板名称">
            <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
        </div>
        <div className="wfge-caps">
          <span className={`wfge-chip img ${caps.imageEntries.length ? "" : "warn"}`}
            title={caps.imageEntries.length ? `图片入口：${caps.imageEntries.map((i) => "#" + i).join(" ")}` : "没有加载图片节点：运行时若连了上游图片，会尝试自动注入一个（需 ComfyUI 在线）"}>
            图片入口 ×{caps.imageEntries.length}
          </span>
          <span className="wfge-chip txt" title={positives.map((t) => `#${t.nodeId}.${t.input}`).join(" ") || "没有识别到提示词输入"}>
            提示词入口 ×{positives.length}
          </span>
          <span className="wfge-chip out" title="在右侧详情里可改任意节点为输出">
            输出 {draft.outputNodeId ? `#${draft.outputNodeId}` : "自动"}
          </span>
          {draft.disabledNodes.length ? <span className="wfge-chip off">已忽略 ×{draft.disabledNodes.length}</span> : null}
          <span className="wfge-chip">已暴露参数 ×{exposedCount}</span>
        </div>
      </Row>
      <div className="wfge">
        <div
          className="wfge-graph"
          onWheel={(e) => {
            // 滚轮缩放（以指针为中心，0.4~3 倍）
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const ns = Math.min(3, Math.max(0.4, view.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
            const px = e.clientX - r.left;
            const py = e.clientY - r.top;
            setView((v) => ({ scale: ns, x: px - ((px - v.x) / v.scale) * ns, y: py - ((py - v.y) / v.scale) * ns }));
          }}
          onPointerDown={(e) => {
            // 空白处按住拖动 = 抓手平移；点在节点上不触发（节点负责自己的点击）
            if (e.button !== 0) return;
            if ((e.target as HTMLElement).closest(".wfge-node")) return;
            panRef.current = { x: e.clientX, y: e.clientY, tx: view.x, ty: view.y };
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = panRef.current;
            if (!d) return;
            setView((v) => ({ ...v, x: d.tx + e.clientX - d.x, y: d.ty + e.clientY - d.y }));
          }}
          onPointerUp={() => {
            panRef.current = null;
          }}
        >
          <div
            className="wfge-canvas"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
              transformOrigin: "0 0",
            }}
          >
            <svg className="wfge-edges" width={layout.width} height={layout.height}>
              {layout.edges.map((e, i) => {
                const a = layout.pos[e.from];
                const b = layout.pos[e.to];
                if (!a || !b) return null;
                const x1 = a.x + WFG_W;
                const y1 = a.y + WFG_H / 2;
                const x2 = b.x;
                const y2 = b.y + WFG_H / 2;
                const hot = sel === e.from || sel === e.to;
                const dim = off.has(e.from) || off.has(e.to);
                return (
                  <path
                    key={i}
                    className={`wfge-edge ${hot ? "hot" : ""} ${dim ? "dim" : ""}`}
                    d={`M ${x1} ${y1} C ${x1 + 34} ${y1}, ${x2 - 34} ${y2}, ${x2} ${y2}`}
                  />
                );
              })}
            </svg>
            {Object.entries(draft.workflow).map(([id, n]) => {
              const p = layout.pos[id];
              if (!p) return null;
              const nExposed = Object.keys(draft.expose).filter((k) => k.startsWith(`${id}.`)).length;
              return (
                <button
                  key={id}
                  type="button"
                  className={[
                    "wfge-node",
                    sel === id ? "sel" : "",
                    off.has(id) ? "off" : "",
                    draft.outputNodeId === id ? "isout" : "",
                    nodeVariantColor.has(id) ? `vcolor-${nodeVariantColor.get(id)}` : "",
                  ].join(" ")}
                  style={{ left: p.x, top: p.y, width: WFG_W, height: WFG_H }}
                  onClick={() => setSel(id)}
                  title={`${n.class_type}${off.has(id) ? "（已忽略）" : ""}`}
                >
                  <span className="wfge-nid">#{id}</span>
                  <span className="wfge-nname">{zhNode(n)}</span>
                  <span className="wfge-badges">
                    {caps.imageEntries.includes(id) ? <i className="b-img">图</i> : null}
                    {caps.textEntries.some((t) => t.nodeId === id && !t.negative) ? <i className="b-txt">文</i> : null}
                    {caps.textEntries.some((t) => t.nodeId === id && t.negative) ? <i className="b-neg">负</i> : null}
                    {draft.outputNodeId === id || (!draft.outputNodeId && caps.outputs.includes(id)) ? (
                      <i className="b-out">出</i>
                    ) : null}
                    {nExposed ? <i className="b-exp">{nExposed}参</i> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <NodeDetail draft={draft} setDraft={setDraft} sel={sel} off={off} onToggleDisable={toggleDisable} objectInfo={objectInfo} />
      </div>
      <VariantPanel draft={draft} setDraft={setDraft} />
      <p className="sec-desc" style={{ marginTop: 10 }}>
        点击示意图中的节点查看/编辑：勾选参数会显示在画布节点上；「图」=图片入口（自动接收上游图片）、「文」=提示词入口（自动接收上游文本）、「出」=取图位置。
      </p>
    </>
  );
}

/** 分支管理面板：显示/编辑子工作流分支（改名/改色/指定输出/添加节点/删除） */
function VariantPanel({ draft, setDraft }: { draft: Draft; setDraft: (d: Draft) => void }) {
  const variants = draft.variants ?? [];
  const wf = draft.workflow;
  const allNodeIds = Object.keys(wf);

  /** 确保有 variants：如果工作流有多个连通分量但 draft.variants 为空，自动生成 */
  const ensureVariants = (): ComfyVariant[] => {
    if (variants.length) return variants;
    const params = paramsFromExpose(wf, draft.expose);
    const auto = autoVariantsFromWorkflow(wf, params, draft.outputNodeId);
    if (auto) {
      setDraft({ ...draft, variants: auto });
      return auto;
    }
    return [];
  };

  const updateVariant = (id: string, patch: Partial<ComfyVariant>) => {
    const next = variants.map((v) => (v.id === id ? { ...v, ...patch } : v));
    setDraft({ ...draft, variants: next });
  };

  const addVariant = () => {
    const idx = variants.length;
    const v: ComfyVariant = {
      id: `branch_${Date.now().toString(36)}`,
      name: `分支 ${idx + 1}`,
      color: VARIANT_COLORS[idx % VARIANT_COLORS.length],
      nodeIds: [],
      outputNodeIds: [],
      params: [],
      slots: [],
    };
    setDraft({ ...draft, variants: [...variants, v] });
  };

  const removeVariant = (id: string) => {
    if (!confirm("删除这个分支定义？（不会删除工作流节点，相关 Comfy 画布节点回退为「请选择子工作流」）")) return;
    setDraft({ ...draft, variants: variants.filter((v) => v.id !== id) });
  };

  const toggleNodeInVariant = (vid: string, nodeId: string) => {
    const v = variants.find((x) => x.id === vid);
    if (!v) return;
    const has = v.nodeIds.includes(nodeId);
    updateVariant(vid, { nodeIds: has ? v.nodeIds.filter((x) => x !== nodeId) : [...v.nodeIds, nodeId] });
  };

  return (
    <div className="wfge-variants">
      <div className="wfge-vars-head">
        <span className="wfge-vars-title">子工作流分支</span>
        <button className="btn sm" onClick={addVariant}>新增分支</button>
        {!variants.length ? (
          <button className="btn sm" onClick={ensureVariants}>自动检测分支</button>
        ) : null}
      </div>
      <div className="sec-desc" style={{ marginBottom: 8, fontSize: 11.5 }}>
        多分支工作流（如 SeedVR2 图像+视频放大）会在此显示。每个分支可命名、着色、指定输出，运行时只提交该分支的节点。
        {!variants.length ? " 当前是单分支模板（整个工作流）。" : ""}
      </div>
      <div className="wfge-vars-list">
        {variants.map((v) => (
          <div key={v.id} className={`wfge-var color-${v.color}`}>
            <div className="wfge-var-head">
              <span className={`wfge-var-dot dot-${v.color}`} />
              <input
                className="input sm wfge-var-name nodrag"
                value={v.name}
                onChange={(e) => updateVariant(v.id, { name: e.target.value })}
              />
              <select
                className="input sm wfge-var-color-pick nodrag"
                value={v.color}
                onChange={(e) => updateVariant(v.id, { color: e.target.value as ComfyVariantColor })}
                title="分支颜色"
              >
                {VARIANT_COLORS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <button className="icon-btn danger" title="删除分支" onClick={() => removeVariant(v.id)}>✕</button>
            </div>
            <div className="wfge-var-body">
              {/* 输出节点选择 */}
              <label className="wfge-var-field">
                <span className="sec-desc">输出节点</span>
                <select
                  className="input sm nodrag"
                  value={v.outputNodeIds[0] ?? ""}
                  onChange={(e) => updateVariant(v.id, { outputNodeIds: e.target.value ? [e.target.value] : [] })}
                >
                  <option value="">（未指定）</option>
                  {allNodeIds.map((nid) => (
                    <option key={nid} value={nid}>#{nid} {zhNode(wf[nid])}</option>
                  ))}
                </select>
              </label>
              {/* 归属节点（多选 chip） */}
              <div className="wfge-var-nodes">
                <span className="sec-desc">归属节点（{v.nodeIds.length}）</span>
                <div className="wfge-var-node-chips">
                  {allNodeIds.map((nid) => {
                    const on = v.nodeIds.includes(nid);
                    return (
                      <button
                        key={nid}
                        className={`wfge-node-chip ${on ? "on" : ""}`}
                        title={`#${nid} ${zhNode(wf[nid])}`}
                        onClick={() => toggleNodeInVariant(v.id, nid)}
                      >
                        #{nid}
                      </button>
                    );
                  })}
                </div>
              </div>
              {/* 自动识别的语义槽（首帧/尾帧/参考图/视频/音频/提示词） */}
              {v.slots?.length ? (
                <div className="wfge-var-slots">
                  <span className="sec-desc">语义槽（{v.slots.length}）</span>
                  <div className="wfge-var-slot-list">
                    {v.slots.map((slot) => (
                      <span key={slot.id} className="wfge-var-slot" title={`${slot.label}：#${slot.bindings[0]?.nodeId}.${slot.bindings[0]?.input}`}>
                        {slot.label}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 右侧详情面板：所选节点的输入编辑 / 暴露 / 忽略 / 设为输出 */
function NodeDetail({
  draft,
  setDraft,
  sel,
  off,
  onToggleDisable,
  objectInfo,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  sel: string | null;
  off: Set<string>;
  onToggleDisable: (id: string) => void;
  objectInfo: Record<string, any> | null;
}) {
  const node: ComfyWfNode | undefined = sel ? draft.workflow[sel] : undefined;
  if (!sel || !node) {
    return <div className="wfge-side empty">点击左侧示意图中的节点，在这里编辑它的参数、默认值与暴露状态。</div>;
  }
  const disabled = off.has(sel);
  const chk = canDisable(draft.workflow, sel);
  const isConn = (v: unknown): v is [string, number] => Array.isArray(v) && v.length === 2 && typeof v[0] === "string";

  const setVal = (input: string, v: unknown) => {
    setDraft({
      ...draft,
      workflow: {
        ...draft.workflow,
        [sel]: { ...node, inputs: { ...node.inputs, [input]: v } },
      },
    });
  };
  const toggleExpose = (input: string, value: unknown) => {
    const key = `${sel}.${input}`;
    const expose = { ...draft.expose };
    if (expose[key]) delete expose[key];
    else {
      // combo（object_info 定义是选项数组）一律文本下拉——数字枚举的 combo 不能被值类型误判成 number
      const combo = !!comboOptionsFor(objectInfo, node.class_type, input)?.length;
      const kind: ComfyParamKind =
        /loadimage/i.test(node.class_type) && input === "image"
          ? "image"
          : input.toLowerCase().includes("seed")
            ? "seed"
            : combo
              ? "text"
              : typeof value === "boolean"
                ? "toggle"
                : typeof value === "number"
                  ? "number"
                  : "text";
      expose[key] = { label: `${zhNode(node)} · ${zhInput(input)}`, kind };
    }
    setDraft({ ...draft, expose });
  };

  const entries = Object.entries(node.inputs ?? {});
  const conns = entries.filter(([, v]) => isConn(v)) as [string, [string, number]][];
  // 已暴露的参数排前面（视觉分组），组内保持原顺序（sort 稳定）
  const widgets = entries
    .filter(([, v]) => !isConn(v))
    .sort((a, b) => Number(!!draft.expose[`${sel}.${b[0]}`]) - Number(!!draft.expose[`${sel}.${a[0]}`]));

  return (
    <div className="wfge-side">
      <div className="wfge-title">
        <b>
          #{sel} {zhNode(node)}
        </b>
        <span className="ct">{node.class_type}</span>
      </div>
      <Row gap={7} style={{ marginBottom: 10, flexWrap: "wrap" }}>
        <button
          className={`btn sm ${draft.outputNodeId === sel ? "primary" : ""}`}
          onClick={() => setDraft({ ...draft, outputNodeId: draft.outputNodeId === sel ? undefined : sel })}
        >
          {draft.outputNodeId === sel ? "✓ 输出节点（点击取消）" : "设为输出节点"}
        </button>
        <button
          className={`btn sm ${disabled ? "primary" : ""}`}
          title={disabled ? "恢复该节点" : chk.ok ? chk.why ?? "运行时跳过该节点" : chk.why}
          disabled={!disabled && !chk.ok}
          onClick={() => onToggleDisable(sel)}
        >
          {disabled ? "已忽略（点击恢复）" : "忽略此节点"}
        </button>
      </Row>
      {conns.length ? (
        <div className="wfge-conns">
          {conns.map(([input, v]) => {
            const srcNode = draft.workflow[v[0]];
            return (
              <div key={input} className="wfge-conn">
                <span className="k">{zhInput(input)}</span>
                <span className="v">
                  ← #{v[0]} {srcNode ? zhNode(srcNode) : "（缺失）"}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
      {widgets.length ? (
        <div className="wfge-widgets">
          {widgets.map(([input, value]) => {
            const key = `${sel}.${input}`;
            const ex = draft.expose[key];
            return (
              <div key={input} className={`wfge-widget${ex ? " on" : ""}`}>
                <div className="wfge-wrow">
                  <label className="wfge-check" title="勾选后显示在画布节点上，可被上游自动填充">
                    <input type="checkbox" checked={!!ex} onChange={() => toggleExpose(input, value)} />
                    <span className="k">{zhInput(input)}</span>
                    {zhInput(input) !== input ? <span className="raw">{input}</span> : null}
                  </label>
                  {ex ? <span className="wfge-exposed">已暴露</span> : null}
                  <WidgetValue value={value} options={comboOptionsFor(objectInfo, node.class_type, input)} onChange={(v) => setVal(input, v)} />
                </div>
                {ex ? (
                  <div className="wfge-wrow sub">
                    <input
                      type="text"
                      className="input"
                      value={ex.label}
                      title="在画布节点上显示的参数名"
                      onChange={(e) =>
                        setDraft({ ...draft, expose: { ...draft.expose, [key]: { ...ex, label: e.target.value } } })
                      }
                    />
                    <PopSelect
                      style={{ width: 110, flex: "none" }}
                      value={ex.kind}
                      options={[
                        { value: "text", label: "文本" },
                        { value: "number", label: "数值" },
                        { value: "seed", label: "种子" },
                        { value: "image", label: "图片" },
                        { value: "toggle", label: "开关" },
                      ]}
                      onChange={(v) =>
                        setDraft({
                          ...draft,
                          expose: { ...draft.expose, [key]: { ...ex, kind: v as ComfyParamKind } },
                        })
                      }
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="sec-desc">该节点没有可编辑的参数（输入全部来自上游连线）。</p>
      )}
    </div>
  );
}

/** 按值类型渲染默认值编辑控件（改的是模板里的默认值）；combo（有可选项）优先于值类型——数字枚举的 combo 也渲染下拉 */
function WidgetValue({ value, onChange, options }: { value: unknown; onChange: (v: unknown) => void; options?: string[] }) {
  if (options?.length) {
    const s = String(value ?? "");
    return (
      <PopSelect
        style={{ flex: 1, minWidth: 0 }}
        title="下拉选项来自 ComfyUI 节点定义（object_info）"
        value={options.includes(s) ? s : options[0]}
        options={options.map((o) => ({ value: o, label: o }))}
        onChange={(v) => onChange(v)}
      />
    );
  }
  if (typeof value === "boolean") return <Switch on={value} onChange={(b) => onChange(b)} />;
  if (typeof value === "number") {
    return (
      <input
        className="input num"
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
      />
    );
  }
  const s = String(value ?? "");
  if (s.length > 42 || s.includes("\n")) {
    return <textarea className="textarea" rows={2} value={s} onChange={(e) => onChange(e.target.value)} />;
  }
  return <input className="input" type="text" value={s} onChange={(e) => onChange(e.target.value)} />;
}
