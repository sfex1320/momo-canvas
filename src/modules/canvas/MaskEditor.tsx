/**
 * 蒙版编辑器 — 局部重绘节点用：在原图上涂抹（画笔）或框选（矩形）要重绘的区域
 * 蒙版约定：与原图同尺寸 PNG，标注处不透明白色，其余全透明（见 maskCanvas.ts）
 * 注意：必须 createPortal 到 body —— React Flow 节点带 transform，内部 fixed 定位会失效
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { loadImg } from "../../core/maskCanvas";
import { IcBrush, IcCheck, IcClose, IcTrash, IcUndo } from "../../ui/icons";

type Tool = "brush" | "rect" | "eraser";

export function MaskEditor({
  src,
  initialMask,
  onSave,
  onClose,
}: {
  src: string;
  initialMask?: string;
  onSave: (mask: string) => void;
  onClose: () => void;
}) {
  const viewRef = useRef<HTMLCanvasElement>(null);
  // 原始分辨率的蒙版画布（导出用）；显示画布按比例缩放
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const undoStack = useRef<ImageData[]>([]);
  const drawing = useRef(false);
  const rectStart = useRef<{ x: number; y: number } | null>(null);
  const rectCur = useRef<{ x: number; y: number } | null>(null);
  const lastPt = useRef<{ x: number; y: number } | null>(null);

  const [tool, setTool] = useState<Tool>("brush");
  const [brush, setBrush] = useState(60);
  const [ready, setReady] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [scale, setScale] = useState(1);

  /* Esc 关闭（编辑器自身无焦点，需全局监听） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  /* 初始化：载入原图 + 既有蒙版 */
  useEffect(() => {
    let on = true;
    void (async () => {
      try {
        const img = await loadImg(src);
        if (!on) return;
        imgRef.current = img;
        const mc = document.createElement("canvas");
        mc.width = img.naturalWidth;
        mc.height = img.naturalHeight;
        maskRef.current = mc;
        if (initialMask) {
          const m = await loadImg(initialMask);
          if (!on) return;
          mc.getContext("2d")!.drawImage(m, 0, 0, mc.width, mc.height);
        }
        // 显示尺寸：适配窗口（工具栏留空间）
        const fit = Math.min((window.innerWidth * 0.86) / img.naturalWidth, (window.innerHeight * 0.72) / img.naturalHeight, 1.5);
        setScale(fit);
        setReady(true);
      } catch {
        onClose();
      }
    })();
    return () => {
      on = false;
    };
    // 只认 src：父组件（画布节点）随 store 频繁重渲染，onClose/initialMask 每次都是新引用，
    // 若列入依赖会在作画途中重置蒙版画布
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  /* 重绘显示画布：原图 + 红色蒙版叠加（+ 矩形拖拽预览） */
  const repaint = () => {
    const view = viewRef.current;
    const img = imgRef.current;
    const mask = maskRef.current;
    if (!view || !img || !mask) return;
    const ctx = view.getContext("2d")!;
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.drawImage(img, 0, 0, view.width, view.height);
    // 蒙版染红叠加
    const tint = document.createElement("canvas");
    tint.width = mask.width;
    tint.height = mask.height;
    const tctx = tint.getContext("2d")!;
    tctx.drawImage(mask, 0, 0);
    tctx.globalCompositeOperation = "source-in";
    tctx.fillStyle = "#ff3b30";
    tctx.fillRect(0, 0, tint.width, tint.height);
    ctx.globalAlpha = 0.5;
    ctx.drawImage(tint, 0, 0, view.width, view.height);
    ctx.globalAlpha = 1;
    if (rectStart.current && rectCur.current) {
      const a = rectStart.current;
      const b = rectCur.current;
      ctx.strokeStyle = "#ff3b30";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(Math.min(a.x, b.x) * scale, Math.min(a.y, b.y) * scale, Math.abs(b.x - a.x) * scale, Math.abs(b.y - a.y) * scale);
      ctx.setLineDash([]);
    }
  };

  useEffect(() => {
    if (ready) repaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, scale]);

  /* 显示坐标 → 原图坐标 */
  const toNatural = (e: React.PointerEvent) => {
    const rect = viewRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * (maskRef.current?.width ?? 1),
      y: ((e.clientY - rect.top) / rect.height) * (maskRef.current?.height ?? 1),
    };
  };

  const pushUndo = () => {
    const mask = maskRef.current;
    if (!mask) return;
    const ctx = mask.getContext("2d")!;
    undoStack.current.push(ctx.getImageData(0, 0, mask.width, mask.height));
    if (undoStack.current.length > 24) undoStack.current.shift();
    setCanUndo(true);
  };

  const undo = () => {
    const mask = maskRef.current;
    const snap = undoStack.current.pop();
    if (!mask || !snap) return;
    mask.getContext("2d")!.putImageData(snap, 0, 0);
    setCanUndo(undoStack.current.length > 0);
    repaint();
  };

  const clearAll = () => {
    const mask = maskRef.current;
    if (!mask) return;
    pushUndo();
    mask.getContext("2d")!.clearRect(0, 0, mask.width, mask.height);
    repaint();
  };

  const onDown = (e: React.PointerEvent) => {
    if (!ready || e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drawing.current = true;
    pushUndo();
    const p = toNatural(e);
    if (tool === "rect") {
      rectStart.current = p;
      rectCur.current = p;
    } else {
      lastPt.current = p;
      strokeTo(p, p);
    }
  };

  const strokeTo = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const mask = maskRef.current;
    if (!mask) return;
    const ctx = mask.getContext("2d")!;
    ctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = "#fff";
    ctx.fillStyle = "#fff";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = brush / scale;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    repaint();
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const p = toNatural(e);
    if (tool === "rect") {
      rectCur.current = p;
      repaint();
    } else {
      strokeTo(lastPt.current ?? p, p);
      lastPt.current = p;
    }
  };

  const onUp = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (tool === "rect" && rectStart.current && rectCur.current) {
      const a = rectStart.current;
      const b = rectCur.current;
      const ctx = maskRef.current!.getContext("2d")!;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#fff";
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    }
    rectStart.current = null;
    rectCur.current = null;
    lastPt.current = null;
    repaint();
  };

  const save = () => {
    const mask = maskRef.current;
    if (!mask) return;
    onSave(mask.toDataURL("image/png"));
    onClose();
  };

  const w = (maskRef.current?.width ?? 1) * scale;
  const h = (maskRef.current?.height ?? 1) * scale;

  return createPortal(
    <div className="mask-editor nodrag nowheel">
      <div className="me-toolbar glass">
        <span className="me-title">
          <IcBrush size={16} /> 编辑重绘蒙版
        </span>
        <span className="me-seg">
          <button className={tool === "brush" ? "on" : ""} title="画笔：涂抹要重绘的区域" onClick={() => setTool("brush")}>
            画笔
          </button>
          <button className={tool === "rect" ? "on" : ""} title="矩形：框选要重绘的区域" onClick={() => setTool("rect")}>
            框选
          </button>
          <button className={tool === "eraser" ? "on" : ""} title="橡皮：擦掉多涂的部分" onClick={() => setTool("eraser")}>
            橡皮
          </button>
        </span>
        {tool !== "rect" ? (
          <span className="me-brush" title="笔刷大小">
            <input type="range" className="range" min={12} max={220} step={4} value={brush} onChange={(e) => setBrush(+e.target.value)} />
            <b>{brush}</b>
          </span>
        ) : null}
        <button className="icon-btn" title="撤销一步" disabled={!canUndo} style={{ opacity: canUndo ? 1 : 0.35 }} onClick={undo}>
          <IcUndo size={16} />
        </button>
        <button className="icon-btn danger" title="清空蒙版" onClick={clearAll}>
          <IcTrash size={16} />
        </button>
        <span className="me-space" />
        <button className="btn nodrag" onClick={onClose}>
          <IcClose size={15} /> 取消
        </button>
        <button className="btn primary nodrag" onClick={save}>
          <IcCheck size={15} /> 保存蒙版
        </button>
      </div>
      <div className="me-stage" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {ready ? (
          <canvas
            ref={(el) => {
              (viewRef as React.MutableRefObject<HTMLCanvasElement | null>).current = el;
              if (el && (el.width !== Math.round(w) || el.height !== Math.round(h))) {
                el.width = Math.round(w);
                el.height = Math.round(h);
                repaint();
              }
            }}
            style={{ width: w, height: h, cursor: "crosshair", touchAction: "none" }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerLeave={onUp}
          />
        ) : (
          <div className="me-loading">载入图片中…</div>
        )}
      </div>
      <div className="me-hint">红色区域 = 将被重绘 · 其余保持原样 · Esc 取消</div>
    </div>,
    document.body,
  );
}
