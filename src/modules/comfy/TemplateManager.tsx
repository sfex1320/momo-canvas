/**
 * ComfyUI 工作流模板管理器
 *  导入 API 格式 JSON（选文件 / 多选批量 / 直接拖入 / Ctrl+V 粘贴）→ 勾选要暴露的输入/参数
 *  → 指定输出节点 → 保存为模板；模板可单个/批量导出为模板包，再导入即恢复
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Field, Row } from "../../ui/kit";
import { useComfy } from "../../core/stores/comfyStore";
import { toast, useUi } from "../../core/stores/uiStore";
import { guessOutputNode, isApiWorkflow, listWorkflowInputs, type WfInputInfo } from "../../core/services/comfy";
import { errMsg, uid } from "../../core/utils";
import { IcDownload, IcEdit, IcFlow, IcTrash, IcUpload } from "../../ui/icons";
import {
  autoExposeMap,
  importTemplateFilesAuto,
  packTemplates,
  paramsFromExpose,
  saveTextFile,
  templatesFromJson,
  type ExposeMap,
} from "./templateIO";
import type { ComfyParamKind, ComfyTemplate } from "../../core/types";

type Draft = {
  id: string;
  name: string;
  workflow: ComfyTemplate["workflow"];
  outputNodeId?: string;
  expose: ExposeMap;
};

function draftFromTemplate(t: ComfyTemplate): Draft {
  const expose: ExposeMap = {};
  for (const p of t.params) expose[p.key] = { label: p.label, kind: p.kind };
  return { id: t.id, name: t.name, workflow: t.workflow, outputNodeId: t.outputNodeId, expose };
}

export function TemplateManager() {
  const open = useUi((s) => s.templateMgrOpen);
  const editId = useUi((s) => s.templateMgrEdit);
  const close = () => useUi.getState().setTemplateMgr(false);
  const templates = useComfy((s) => s.templates);
  const upsert = useComfy((s) => s.upsert);
  const remove = useComfy((s) => s.remove);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

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
      setDraft({
        id: uid(8),
        name: nameHint,
        workflow: json,
        outputNodeId: guessOutputNode(json),
        expose: autoExposeMap(listWorkflowInputs(json)),
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
    const params = paramsFromExpose(draft.workflow, draft.expose);
    upsert({
      id: draft.id,
      name: draft.name.trim(),
      workflow: draft.workflow,
      params,
      outputNodeId: draft.outputNodeId,
      createdAt: Date.now(),
    });
    toast(`模板「${draft.name.trim()}」已保存（${params.length} 个参数）`, "ok");
    setDraft(null);
  };

  return (
    <Modal
      title={draft ? `编辑模板 · ${draft.name || "未命名"}` : "ComfyUI 工作流模板"}
      onClose={() => (draft ? setDraft(null) : close())}
      width={880}
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
                  <b>{t.name}</b>
                  <span>
                    {Object.keys(t.workflow).length} 个节点 · 暴露 {t.params.length} 个参数
                  </span>
                </div>
                <button className="icon-btn" title="编辑参数" onClick={() => setDraft(draftFromTemplate(t))}>
                  <IcEdit size={17} />
                </button>
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
                  style={confirmDel === t.id ? { color: "var(--danger)", background: "rgba(242,79,106,.12)" } : undefined}
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
        <TemplateEditor draft={draft} setDraft={setDraft} />
      )}
    </Modal>
  );
}

function TemplateEditor({ draft, setDraft }: { draft: Draft; setDraft: (d: Draft) => void }) {
  const inputs = useMemo(() => listWorkflowInputs(draft.workflow), [draft.workflow]);
  const byNode = useMemo(() => {
    const m = new Map<string, WfInputInfo[]>();
    for (const i of inputs) {
      const arr = m.get(i.nodeId) ?? [];
      arr.push(i);
      m.set(i.nodeId, arr);
    }
    return m;
  }, [inputs]);

  const exposedCount = Object.keys(draft.expose).length;

  const toggle = (i: WfInputInfo) => {
    const key = `${i.nodeId}.${i.input}`;
    const expose = { ...draft.expose };
    if (expose[key]) delete expose[key];
    else expose[key] = { label: `${i.nodeTitle} · ${i.input}`, kind: i.kind };
    setDraft({ ...draft, expose });
  };

  return (
    <>
      <Row gap={12} style={{ marginBottom: 14 }}>
        <div style={{ flex: 1.4 }}>
          <Field label="模板名称">
            <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="输出节点（取图位置）">
            <select
              className="select"
              value={draft.outputNodeId ?? ""}
              onChange={(e) => setDraft({ ...draft, outputNodeId: e.target.value || undefined })}
            >
              <option value="">自动（所有输出）</option>
              {Object.entries(draft.workflow).map(([id, n]) => (
                <option key={id} value={id}>
                  #{id} {n._meta?.title ?? n.class_type}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Row>
      <p className="sec-desc" style={{ marginBottom: 12 }}>
        勾选要在画布节点上显示的参数（已选 {exposedCount} 个）。文本参数可接收上游提示词，图片参数自动接收上游图片。
      </p>
      {Array.from(byNode.entries()).map(([nodeId, list]) => {
        const node = draft.workflow[nodeId];
        const anyOn = list.some((i) => draft.expose[`${nodeId}.${i.input}`]);
        return (
          <details key={nodeId} className="wf-node" open={anyOn}>
            <summary>
              #{nodeId} {node._meta?.title ?? node.class_type}
              <span className="ct">{node.class_type}</span>
            </summary>
            {list.map((i) => {
              const key = `${i.nodeId}.${i.input}`;
              const ex = draft.expose[key];
              return (
                <div key={key} className="wf-input-row">
                  <input type="checkbox" checked={!!ex} onChange={() => toggle(i)} />
                  <span style={{ width: 110, fontWeight: 600 }}>{i.input}</span>
                  {ex ? (
                    <>
                      <input
                        type="text"
                        className="input"
                        value={ex.label}
                        title="在节点上显示的参数名"
                        onChange={(e) =>
                          setDraft({ ...draft, expose: { ...draft.expose, [key]: { ...ex, label: e.target.value } } })
                        }
                      />
                      <select
                        className="select"
                        value={ex.kind}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            expose: { ...draft.expose, [key]: { ...ex, kind: e.target.value as ComfyParamKind } },
                          })
                        }
                      >
                        <option value="text">文本</option>
                        <option value="number">数值</option>
                        <option value="seed">种子</option>
                        <option value="image">图片</option>
                        <option value="toggle">开关</option>
                      </select>
                    </>
                  ) : (
                    <span className="val" style={{ flex: 1 }}>
                      {String(i.value).slice(0, 60)}
                    </span>
                  )}
                </div>
              );
            })}
          </details>
        );
      })}
    </>
  );
}
