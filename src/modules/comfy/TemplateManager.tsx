/**
 * ComfyUI 工作流模板管理器
 *  导入 API 格式 JSON（选文件 / 多选批量 / 直接拖入 / Ctrl+V 粘贴）→ 勾选要暴露的输入/参数
 *  → 指定输出节点 → 保存为模板；模板可单个/批量导出为模板包，再导入即恢复
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Field, Row, Switch } from "../../ui/kit";
import { useComfy } from "../../core/stores/comfyStore";
import { toast, useUi } from "../../core/stores/uiStore";
import {
  analyzeCaps,
  canDisable,
  guessOutputNode,
  isApiWorkflow,
  listWorkflowInputs,
} from "../../core/services/comfy";
import { layoutWorkflow, zhInput, zhNode, WFG_H, WFG_W } from "./wfGraph";
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
import type { ComfyParamKind, ComfyTemplate, ComfyWfNode } from "../../core/types";

type Draft = {
  id: string;
  name: string;
  workflow: ComfyTemplate["workflow"];
  outputNodeId?: string;
  expose: ExposeMap;
  disabledNodes: string[];
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
  };
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
    const params = paramsFromExpose(draft.workflow, draft.expose);
    upsert({
      id: draft.id,
      name: draft.name.trim(),
      workflow: draft.workflow,
      params,
      outputNodeId: draft.outputNodeId,
      disabledNodes: draft.disabledNodes.length ? draft.disabledNodes : undefined,
      createdAt: Date.now(),
    });
    toast(`模板「${draft.name.trim()}」已保存（${params.length} 个参数）`, "ok");
    setDraft(null);
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
  const layout = useMemo(() => layoutWorkflow(draft.workflow), [draft.workflow]);
  const caps = useMemo(() => analyzeCaps(draft.workflow), [draft.workflow]);
  const [sel, setSel] = useState<string | null>(() => caps.imageEntries[0] ?? Object.keys(draft.workflow)[0] ?? null);
  const off = new Set(draft.disabledNodes);
  const exposedCount = Object.keys(draft.expose).length;
  const positives = caps.textEntries.filter((t) => !t.negative);

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
        <div className="wfge-graph">
          <div className="wfge-canvas" style={{ width: layout.width, height: layout.height }}>
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
        <NodeDetail draft={draft} setDraft={setDraft} sel={sel} off={off} onToggleDisable={toggleDisable} />
      </div>
      <p className="sec-desc" style={{ marginTop: 10 }}>
        点击示意图中的节点查看/编辑：勾选参数会显示在画布节点上；「图」=图片入口（自动接收上游图片）、「文」=提示词入口（自动接收上游文本）、「出」=取图位置。
      </p>
    </>
  );
}

/** 右侧详情面板：所选节点的输入编辑 / 暴露 / 忽略 / 设为输出 */
function NodeDetail({
  draft,
  setDraft,
  sel,
  off,
  onToggleDisable,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  sel: string | null;
  off: Set<string>;
  onToggleDisable: (id: string) => void;
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
      const kind: ComfyParamKind =
        /loadimage/i.test(node.class_type) && input === "image"
          ? "image"
          : input.toLowerCase().includes("seed")
            ? "seed"
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
  const widgets = entries.filter(([, v]) => !isConn(v));

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
              <div key={input} className="wfge-widget">
                <div className="wfge-wrow">
                  <label className="wfge-check" title="勾选后显示在画布节点上，可被上游自动填充">
                    <input type="checkbox" checked={!!ex} onChange={() => toggleExpose(input, value)} />
                    <span className="k">{zhInput(input)}</span>
                    {zhInput(input) !== input ? <span className="raw">{input}</span> : null}
                  </label>
                  <WidgetValue value={value} onChange={(v) => setVal(input, v)} />
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

/** 按值类型渲染默认值编辑控件（改的是模板里的默认值） */
function WidgetValue({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
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
