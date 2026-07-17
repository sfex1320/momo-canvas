/**
 * ComfyUI 工作流模板管理器
 *  导入 API 格式 JSON → 勾选要暴露的输入/参数 → 指定输出节点 → 保存为模板
 */
import { useMemo, useRef, useState } from "react";
import { Modal, Field, Row } from "../../ui/kit";
import { useComfy } from "../../core/stores/comfyStore";
import { toast, useUi } from "../../core/stores/uiStore";
import { guessOutputNode, isApiWorkflow, listWorkflowInputs, type WfInputInfo } from "../../core/services/comfy";
import { uid } from "../../core/utils";
import { IcEdit, IcFlow, IcTrash, IcUpload } from "../../ui/icons";
import type { ComfyExposedParam, ComfyParamKind, ComfyTemplate } from "../../core/types";

type ExposeMap = Record<string, { label: string; kind: ComfyParamKind }>;

type Draft = {
  id: string;
  name: string;
  workflow: ComfyTemplate["workflow"];
  outputNodeId?: string;
  expose: ExposeMap;
};

/** 自动暴露最常用的参数：提示词文本 / 种子 / LoadImage */
function autoExpose(inputs: WfInputInfo[]): ExposeMap {
  const map: ExposeMap = {};
  for (const i of inputs) {
    const key = `${i.nodeId}.${i.input}`;
    const label = `${i.nodeTitle} · ${i.input}`;
    if (i.classType === "CLIPTextEncode" && i.input === "text") map[key] = { label, kind: "text" };
    else if (i.kind === "seed") map[key] = { label, kind: "seed" };
    else if (i.kind === "image") map[key] = { label, kind: "image" };
  }
  return map;
}

function draftFromTemplate(t: ComfyTemplate): Draft {
  const expose: ExposeMap = {};
  for (const p of t.params) expose[p.key] = { label: p.label, kind: p.kind };
  return { id: t.id, name: t.name, workflow: t.workflow, outputNodeId: t.outputNodeId, expose };
}

export function TemplateManager() {
  const open = useUi((s) => s.templateMgrOpen);
  const close = () => useUi.getState().setTemplateMgr(false);
  const templates = useComfy((s) => s.templates);
  const upsert = useComfy((s) => s.upsert);
  const remove = useComfy((s) => s.remove);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const importFile = async (f?: File | null) => {
    if (!f) return;
    try {
      const json = JSON.parse(await f.text());
      if (!isApiWorkflow(json)) {
        toast("这不是 API 格式的工作流：请在 ComfyUI 中用「导出(API)」保存后再导入", "err");
        return;
      }
      const inputs = listWorkflowInputs(json);
      setDraft({
        id: uid(8),
        name: f.name.replace(/\.json$/i, ""),
        workflow: json,
        outputNodeId: guessOutputNode(json),
        expose: autoExpose(inputs),
      });
    } catch {
      toast("JSON 解析失败，请检查文件内容", "err");
    }
  };

  const saveDraft = () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      toast("请给模板起个名字", "err");
      return;
    }
    const inputs = listWorkflowInputs(draft.workflow);
    const params: ComfyExposedParam[] = [];
    for (const i of inputs) {
      const key = `${i.nodeId}.${i.input}`;
      const ex = draft.expose[key];
      if (!ex) continue;
      params.push({
        key,
        nodeId: i.nodeId,
        input: i.input,
        label: ex.label || `${i.nodeTitle} · ${i.input}`,
        kind: ex.kind,
        value: i.value as string | number | boolean,
      });
    }
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
        <>
          <Row style={{ marginBottom: 16 }}>
            <button className="btn primary" onClick={() => fileRef.current?.click()}>
              <IcUpload size={16} /> 导入工作流（API 格式 JSON）
            </button>
            <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-3)" }}>
              ComfyUI 菜单 → 工作流 → 导出（API）
            </span>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                void importFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </Row>
          {templates.length === 0 ? (
            <div style={{ textAlign: "center", color: "var(--text-3)", padding: "48px 0", lineHeight: 2 }}>
              <IcFlow size={36} />
              <br />
              还没有模板，导入一个工作流开始吧
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
        </>
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
