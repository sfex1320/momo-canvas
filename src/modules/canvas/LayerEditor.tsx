/**
 * 元素工坊（原「智能分层」重构，3.6）— 图层编辑的全屏入口：
 *   视觉模型识别元素清单（名称/角色/bbox/文字原文）→ 预览图上框选核对（框可拖动/缩放/圈选新增/删除/改名）→
 *   双档拆解到画布（保像素=裁切+色键；重绘=局部特写高清重绘+色键）→ 透明 PNG 图片节点收进图层组（按原图位置摆放）。
 * 拆解后回到画布继续编辑：图层节点「元素重绘 / 改字」，图层组头「合成图层」（按原位拼回）、组右键导出 PSD/TIFF（原位）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useBoard } from "../../core/stores/boardStore";
import { pushError, useUi } from "../../core/stores/uiStore";
import { ELEMENT_ROLE_LABEL, analyzeElements, splitElementsToCanvas, type ElementItem } from "../../core/elementSplit";
import type { ElementFlatOptions } from "../../core/types";
import { ModelPicker } from "../../ui/ModelPicker";
import { abortNode } from "../../core/runControl";
import { nodeMainImage } from "../../core/nodeEdit";
import { useImageDims } from "../../core/imageInfo";
import { convertFlatUnit, flatOutputSize } from "../../core/elementFlatPlan";
import { Thumb } from "../../ui/Thumb";
import { IcCheck, IcClose, IcLayers, IcLoading, IcPlus, IcRefresh, IcTrash } from "../../ui/icons";
import { errMsg, uid } from "../../core/utils";
import { PrecisionCutout } from "./PrecisionCutout";
import "./designTools.css";

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** 正在进行的框调整：move = 整体拖动；resize = 右下柄缩放。box 存按下时的初值，move 全量按差值重算（避免累积漂移） */
type BoxDrag = { id: string; kind: "move" | "resize"; sx: number; sy: number; box: [number, number, number, number] };

export function LayerEditor() {
  const nodeId = useUi((s) => s.layerEditorNodeId);
  const close = useUi((s) => s.setLayerEditorNodeId);
  const src = useBoard((s) => nodeMainImage(s.nodes.find((n) => n.id === nodeId)));
  const dims = useImageDims(src);
  const previewRef = useRef<HTMLElement>(null);
  const [previewSize, setPreviewSize] = useState({ w: 1, h: 1 });
  useEffect(() => {
    const el = previewRef.current; if (!nodeId || !el) return;
    const observer = new ResizeObserver(entries => {
      const r = entries[0]?.contentRect;
      if (r) setPreviewSize({ w: r.width, h: r.height });
    });
    observer.observe(el); return () => observer.disconnect();
  }, [nodeId]);
  const fitScale = dims ? Math.min(previewSize.w / dims.w, previewSize.h / dims.h) : 1;
  const stageSize = dims ? { width: dims.w * fitScale, height: dims.h * fitScale } : { width: previewSize.w, height: previewSize.h };
  const [items, setItems] = useState<ElementItem[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [precision,setPrecision]=useState<string|null>(null);
  const [mode, setMode] = useState<"pixel" | "redraw" | "flat">("pixel");
  const [flat, setFlat] = useState<ElementFlatOptions>({ view: "front", backColor: "#ffffff", bottomColor: "#eeeeee", background: "#ffffff", transparent: false, width: 1024, height: 1024, unit: "px", dpi: 150 });
  const [bgComplete, setBgComplete] = useState(true);
  const [progress, setProgress] = useState({ message: "", pct: 0 });
  const [busy, setBusy] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 框编辑：拖动/缩放、圈选新增、清单行改名
  const [addMode, setAddMode] = useState(false);
  const [drawing, setDrawing] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const dragRef = useRef<BoxDrag | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const analysisEpoch = useRef(0);
  const analysisController=useRef<AbortController|null>(null);

  const run = useCallback(async () => {
    if (!src) return;
    analysisController.current?.abort();
    const controller=new AbortController();analysisController.current=controller;
    const epoch = ++analysisEpoch.current;
    setBusy(true);
    setError(null);
    setItems(null);
    setSelected(null);
    setAddMode(false);
    setProgress({ message: "视觉模型识别图中的元素…", pct: 35 });
    try {
      // 让加载状态先完成一次绘制，再发起视觉请求。
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const result = await analyzeElements(src,controller.signal);
      if (analysisEpoch.current !== epoch) return;
      setItems(result);
      setChecked(new Set(result.map((it) => it.id)));
      setSelected(result[0]?.id ?? null);
    } catch (e) {
      if (analysisEpoch.current !== epoch) return;
      const message = errMsg(e);
      setError(message);
      setItems([]); // 视觉服务不可用时仍可圈选元素，继续使用绘画模型拆件
      pushError("元素识别", message);
    } finally {
      if (analysisEpoch.current === epoch) {
        setBusy(false);
        setProgress({ message: "", pct: 0 });
      }
    }
  }, [src]);

  useEffect(() => {
    if (!nodeId || !src) return;
    void run();
    return () => { analysisEpoch.current++;analysisController.current?.abort();abortNode(`element-flat:${nodeId}`);abortNode(`element-split:${nodeId}`); };
  }, [nodeId, src, run]);

  // 对话框焦点管理：Esc 关闭、Delete 删选中框、Tab 留在工坊内，关闭后由原按钮自然恢复焦点。
  useEffect(() => {
    if (!nodeId) return;
    const root = dialogRef.current;
    root?.querySelector<HTMLElement>("button, input")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if(precision){if(event.key==="Escape"){event.preventDefault();setPrecision(null);}return;}
      const typing = (event.target as HTMLElement | null)?.tagName === "INPUT";
      if (event.key === "Escape") {
        event.preventDefault();
        close(null);
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selected && !typing) {
        event.preventDefault();
        setItems((prev) => prev?.filter((i) => i.id !== selected) ?? prev);
        setChecked((prev) => {
          const n = new Set(prev);
          n.delete(selected);
          return n;
        });
        setSelected(null);
        return;
      }
      if (event.key !== "Tab" || !root) return;
      const focusable = Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [nodeId, close, selected, precision]);

  if (!nodeId) return null;

  const toggle = (id: string) =>
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const checkedItems = items?.filter((it) => checked.has(it.id)) ?? [];
  const working = busy || splitting;
  let outputSize: { w: number; h: number } | undefined, sizeError = "";
  if (mode === "flat") { try { outputSize = flatOutputSize(flat); } catch(e) { sizeError = errMsg(e); } }
  const setFlatUnit = (unit: ElementFlatOptions["unit"]) => {
    try { setFlat(convertFlatUnit(flat, unit)); }
    catch { setFlat(v => ({ ...v, unit })); }
  };

  const patchBox = (id: string, box: [number, number, number, number]) =>
    setItems((prev) => (prev ? prev.map((it) => (it.id === id ? { ...it, box, cutout:undefined } : it)) : prev));

  const ptrNorm = (e: { clientX: number; clientY: number }) => {
    const r = stageRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  };

  /** 框/柄按下：选中并开始拖动（capture 到自身，move/up 都落在它身上） */
  const boxDown = (e: React.PointerEvent, it: ElementItem, kind: "move" | "resize") => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(it.id);
    if (!checked.has(it.id)) toggle(it.id);
    dragRef.current = { id: it.id, kind, sx: e.clientX, sy: e.clientY, box: it.box };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const boxMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const r = stageRef.current?.getBoundingClientRect();
    if (!d || !r) return;
    const dx = (e.clientX - d.sx) / r.width;
    const dy = (e.clientY - d.sy) / r.height;
    const [x, y, w, h] = d.box;
    if (d.kind === "move") {
      patchBox(d.id, [Math.max(0, Math.min(1 - w, x + dx)), Math.max(0, Math.min(1 - h, y + dy)), w, h]);
    } else {
      patchBox(d.id, [x, y, Math.max(0.02, Math.min(1 - x, w + dx)), Math.max(0.02, Math.min(1 - y, h + dy))]);
    }
  };
  const boxUp = () => {
    dragRef.current = null;
  };

  /** 圈选新增：addMode 下在预览空白处按下拖出一个新框 */
  const stageDown = (e: React.PointerEvent) => {
    if (!addMode || e.button !== 0) return;
    const p = ptrNorm(e);
    setDrawing({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const stageMove = (e: React.PointerEvent) => {
    if (!drawing) return;
    const p = ptrNorm(e);
    setDrawing((d) => (d ? { ...d, x1: p.x, y1: p.y } : d));
  };
  const stageUp = () => {
    if (!drawing) return;
    const x = Math.min(drawing.x0, drawing.x1);
    const y = Math.min(drawing.y0, drawing.y1);
    const w = Math.abs(drawing.x1 - drawing.x0);
    const h = Math.abs(drawing.y1 - drawing.y0);
    setDrawing(null);
    if (w <= 0.02 || h <= 0.02) return;
    const it: ElementItem = {
      id: `elem_${uid(6)}`,
      name: "新元素（双击改名，名称即重绘提示词）",
      role: "subject",
      box: [x, y, w, h],
    };
    setItems((prev) => (prev ? [...prev, it] : [it]));
    setChecked((s) => new Set(s).add(it.id));
    setSelected(it.id);
    setAddMode(false);
  };

  const commitRename = (id: string, name: string) => {
    const v = name.trim();
    if (v) setItems((prev) => (prev ? prev.map((it) => (it.id === id ? { ...it, name: v } : it)) : prev));
    setRenaming(null);
  };
  const removeItem = (id: string) => {
    setItems((prev) => prev?.filter((i) => i.id !== id) ?? prev);
    setChecked((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
    if (selected === id) setSelected(null);
  };

  const split = async () => {
    if (!nodeId || !checkedItems.length) return;
    setSplitting(true);
    try {
      const ok = await splitElementsToCanvas(nodeId, checkedItems, {
        mode,
        bgComplete,
        flat,
          onProgress: (message, pct) => setProgress({ message, pct }),
          onItemDone: (id) => setChecked(prev => { const next = new Set(prev); next.delete(id); return next; }),
      });
        if (ok && useUi.getState().layerEditorNodeId === nodeId) close(null);
    } finally {
      setSplitting(false);
      setProgress({ message: "", pct: 0 });
    }
  };

  return (
    <div className="le-overlay" role="presentation" onPointerDown={(e) => { if (e.target === e.currentTarget) close(null); }}>
      <div ref={dialogRef} className="le-dialog" role="dialog" aria-modal="true" aria-labelledby="le-title">
        <header className="le-head">
          <div>
            <h2 id="le-title"><IcLayers size={18} /> 元素分层</h2>
            <p>识别文字 / 主体 / Logo / 装饰 → 拆成透明图层（重绘档 = 高清重制每层）· 框可拖动 / 右下角缩放 / 圈选新增 / Delete 删除 · 识别使用已配置视觉模型，可能计费</p>
          </div>
          <button className="icon-btn" aria-label="关闭元素工坊" title="关闭（Esc）" onClick={() => close(null)}><IcClose size={16} /></button>
        </header>

        <div className="le-main">
          <section className="le-preview" aria-label="元素预览" ref={previewRef}>
            <div
              ref={stageRef}
              className={`le-stage ${addMode ? "adding" : ""}`}
              style={stageSize}
              onPointerDown={stageDown}
              onPointerMove={stageMove}
              onPointerUp={stageUp}
            >
              {src ? <Thumb src={src} alt="原图预览" /> : null}
              {items?.map((it) => (
                <div
                  key={it.id}
                  role="button"
                  tabIndex={0}
                  className={`le-box ${selected === it.id ? "on" : ""} ${checked.has(it.id) ? "" : "off"}`}
                  style={{ left: `${it.box[0] * 100}%`, top: `${it.box[1] * 100}%`, width: `${it.box[2] * 100}%`, height: `${it.box[3] * 100}%` }}
                  title={`${it.name}（${ELEMENT_ROLE_LABEL[it.role]}${it.text ? `：「${it.text.slice(0, 24)}」` : ""}）— 拖动移框，右下角缩放`}
                  onPointerDown={(e) => boxDown(e, it, "move")}
                  onPointerMove={boxMove}
                  onPointerUp={boxUp}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    setSelected(it.id);
                    if (!checked.has(it.id)) toggle(it.id);
                  }}
                >
                  <span className="le-rs" onPointerDown={(e) => boxDown(e, it, "resize")} onPointerMove={boxMove} onPointerUp={boxUp} />
                </div>
              ))}
              {drawing ? (
                <div
                  className="le-box draw"
                  style={{
                    left: `${Math.min(drawing.x0, drawing.x1) * 100}%`,
                    top: `${Math.min(drawing.y0, drawing.y1) * 100}%`,
                    width: `${Math.abs(drawing.x1 - drawing.x0) * 100}%`,
                    height: `${Math.abs(drawing.y1 - drawing.y0) * 100}%`,
                  }}
                />
              ) : null}
            </div>
            {working ? (
              <div className="le-progress" aria-live="polite" aria-atomic="true">
                <IcLoading size={20} />
                <strong>{progress.message || "正在处理…"}</strong>
                <div><i style={{ width: `${progress.pct}%` }} /></div>
                <span>{progress.pct}%</span>
              </div>
            ) : null}
            {error ? <div className="le-error" role="alert">{error}<button className="btn" onClick={() => void run()}><IcRefresh size={13} /> 重试</button></div> : null}
          </section>

          <aside className={`le-side${mode === "flat" ? " flat" : ""}`}>
            {precision&&items?.find(it=>it.id===precision)&&<PrecisionCutout src={src!} item={items.find(it=>it.id===precision)!} onClose={()=>setPrecision(null)} onSave={cutout=>setItems(prev=>prev?.map(it=>it.id===precision?{...it,cutout}:it)??prev)}/>}
            <button className="btn sm" disabled={working||!selected} onClick={()=>setPrecision(selected)}>精细蒙版：标记保留 / 删除</button>
            <div className="le-side-title">
              <span>元素</span>
              <b>{checkedItems.length}/{items?.length ?? 0}</b>
            </div>
            {mode === "flat" ? <div className="le-flat-options">
              <b>平面拆件规格</b>
              <ModelPicker role="image" value={flat.modelId} onChange={modelId => setFlat(v => ({ ...v, modelId }))} />
              <div className="le-mode" role="group" aria-label="拆件视图">
                {([['front', '正面'], ['back', '背面'], ['bottom', '底面']] as const).map(([view, label]) => <button key={view} disabled={working} className={flat.view === view ? "on" : ""} onClick={() => setFlat(v => ({ ...v, view }))}>{label}</button>)}
              </div>
              {([['backColor', '背面颜色'], ['bottomColor', '底面颜色'], ['background', '背景颜色']] as const).map(([key, label]) => <label key={key}>{label}<input type="color" aria-label={label} disabled={working} value={flat[key]} onChange={e => setFlat(v => ({ ...v, [key]: e.target.value }))} /></label>)}
              <label><span>透明背景</span><input type="checkbox" disabled={working} checked={flat.transparent} onChange={e => setFlat(v => ({ ...v, transparent: e.target.checked }))} /></label>
              <div className="le-mode" role="group" aria-label="尺寸单位">{(['px', 'mm'] as const).map(unit => <button key={unit} disabled={working} className={flat.unit === unit ? 'on' : ''} onClick={() => setFlatUnit(unit)}>{unit === 'px' ? '像素' : '毫米'}</button>)}</div>
              {([['width', '画板宽'], ['height', '画板高'], ['dpi', 'DPI']] as const).filter(([key]) => key !== 'dpi' || flat.unit === 'mm').map(([key, label]) => <label key={key}>{label}<input className="input sm" aria-label={label} type="number" min="1" disabled={working} value={flat[key]} onChange={e => setFlat(v => ({ ...v, [key]: Number(e.target.value) }))} /></label>)}
              <p className="le-flat-hint">每个元素单独出图，适合美陈和文化墙。尺寸为输出画板；背面、底面为推定稿。透明图使用色键抠底，边缘需复核。</p>
              <div className="le-output-preview" aria-live="polite">{outputSize ? <><b>每件 {outputSize.w} × {outputSize.h} 像素</b><span>共 {checkedItems.length} 件 · {flat.transparent ? "透明 PNG" : "纯色背景 PNG"}{flat.unit === "mm" ? ` · 写入 ${flat.dpi} DPI` : ""}</span><i style={{ aspectRatio: `${outputSize.w}/${outputSize.h}`, background: flat.transparent ? undefined : flat.background }} /></> : <span role="alert">{sizeError}</span>}</div>
            </div> : null}
            <div className="le-list">
              {items?.map((it) => (
                <div
                  key={it.id}
                  role="button"
                  tabIndex={0}
                  className={`le-layer el-row ${selected === it.id ? "on" : ""}`}
                  aria-pressed={selected === it.id}
                  onClick={() => setSelected(it.id)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelected(it.id);
                    }
                  }}
                >
                  <span
                    role="button"
                    tabIndex={0}
                    className={`le-check ${checked.has(it.id) ? "on" : ""}`}
                    aria-label={checked.has(it.id) ? `取消拆解 ${it.name}` : `勾选拆解 ${it.name}`}
                    onClick={(e) => { e.stopPropagation(); toggle(it.id); }}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggle(it.id); } }}
                  >
                    {checked.has(it.id) ? <IcCheck size={13} /> : null}
                  </span>
                  <span className="le-layer-text">
                    {renaming === it.id ? (
                      <input
                        autoFocus
                        defaultValue={it.name}
                        title="元素名称 = 重绘提示词，写外观描述效果最好"
                        onBlur={(e) => commitRename(it.id, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(it.id, (e.target as HTMLInputElement).value);
                          if (e.key === "Escape") setRenaming(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <b title="双击改名（名称即重绘提示词）" onDoubleClick={() => setRenaming(it.id)}>{it.name}</b>
                    )}
                    <small>
                      {ELEMENT_ROLE_LABEL[it.role]}
                      {it.text ? ` · 「${it.text.slice(0, 18)}」` : ""}
                    </small>
                  </span>
                  <button
                    className="icon-btn le-del"
                    title={`删除「${it.name}」`}
                    aria-label={`删除 ${it.name}`}
                    onClick={(e) => { e.stopPropagation(); removeItem(it.id); }}
                  >
                    <IcTrash size={13} />
                  </button>
                </div>
              ))}
              {items && !items.length ? <p className="le-empty">没有识别到元素</p> : null}
            </div>
            {items?.length ? (
              <div className="le-report">
                <p>框不准可直接拖动修正、右下角缩放，圈选可新增；名称 = 重绘档的提示词（双击改）。</p>
                <p>保像素档免费（裁切 + 色键抠图）；重绘档逐元素高清重制（计费，按局部 2 倍尺寸重画）。</p>
              </div>
            ) : null}
          </aside>
        </div>

        <footer className="le-foot">
          <div className="le-mode" role="group" aria-label="拆解档位">
            <button className={mode === "pixel" ? "on" : ""} title="bbox 裁切 + 色键抠图：不重画、与原图像素一致、免费" onClick={() => setMode("pixel")}>保像素</button>
            <button className={mode === "redraw" ? "on" : ""} title="逐元素局部特写图生图（按 2 倍尺寸高清重制）再抠图：元素干净高清、有轻微风格漂移、计费" onClick={() => setMode("redraw")}>高清重绘</button>
            <button className={mode === "flat" ? "on" : ""} disabled={working} onClick={() => setMode("flat")}>单件视图重绘</button>
          </div>
          <label className="le-check-label" title="把元素遮挡住的背景区域用边界扩散补全（本地免费；复杂纹理背景建议关闭）">
            <input type="checkbox" disabled={mode === "flat" || working} checked={bgComplete} onChange={(e) => setBgComplete(e.target.checked)} /> 背景补全
          </label>
          <button
            className={`btn ${addMode ? "primary" : ""}`}
            disabled={working || !items}
            title="开启后在预览图上拖出一个新框，手动补识别漏掉的元素"
            onClick={() => { setAddMode((v) => !v); setDrawing(null); }}
          >
            <IcPlus size={13} /> {addMode ? "圈选中…（拖出一个框）" : "圈选新增"}
          </button>
          <button className="btn" disabled={working || !items} onClick={() => void run()}><IcRefresh size={13} /> 重新识别</button>
          <span className="le-spacer" />
          {splitting ? <button className="btn" title="停止后保留已完成元素；已提交的模型任务可能仍计费" onClick={() => nodeId && abortNode(`${mode==="flat"?"element-flat":"element-split"}:${nodeId}`)}>停止拆解</button> : null}
          <button className="btn primary" disabled={working || !checkedItems.length || !!sizeError} onClick={() => void split()}>
            <IcLayers size={13} /> 拆解到画布（{checkedItems.length} 元素）
          </button>
        </footer>
      </div>
    </div>
  );
}
