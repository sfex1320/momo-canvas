/**
 * 框选取景器 — 聚焦裁剪节点用：在原图上拖一个矩形，输出归一化区域（0-1）
 * createPortal 到 body：避开 React Flow 节点 transform 对 fixed 定位的影响
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { loadImg } from "../../core/maskCanvas";
import { IcCheck, IcClose, IcCrop } from "../../ui/icons";

type Rect = { x: number; y: number; w: number; h: number };

export function RegionPicker({
  src,
  initial,
  onSave,
  onClose,
}: {
  src: string;
  initial?: Rect;
  onSave: (rect: Rect) => void;
  onClose: () => void;
}) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(initial ?? null);
  const [scale, setScale] = useState(1);
  const dragFrom = useRef<{ x: number; y: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    let on = true;
    void loadImg(src)
      .then((img) => {
        if (!on) return;
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        setDims({ w, h });
        setScale(Math.min((window.innerWidth * 0.86) / w, (window.innerHeight * 0.72) / h, 1.5));
      })
      .catch(onClose);
    return () => {
      on = false;
    };
    // 只认 src（同 MaskEditor：父节点重渲染不应重置取景状态）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const toNorm = (e: React.PointerEvent) => {
    const b = boxRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)),
      y: Math.max(0, Math.min(1, (e.clientY - b.top) / b.height)),
    };
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragFrom.current = toNorm(e);
    setRect(null);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!dragFrom.current) return;
    const a = dragFrom.current;
    const b = toNorm(e);
    setRect({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
  };
  const onUp = () => {
    dragFrom.current = null;
  };

  const valid = rect && rect.w > 0.02 && rect.h > 0.02;
  const w = (dims?.w ?? 1) * scale;
  const h = (dims?.h ?? 1) * scale;

  return createPortal(
    <div className="mask-editor nodrag nowheel">
      <div className="me-toolbar glass">
        <span className="me-title">
          <IcCrop size={16} /> 框选聚焦区域
        </span>
        <span className="me-note">
          {valid && dims ? `已选 ${Math.round(rect!.w * dims.w)} × ${Math.round(rect!.h * dims.h)} px` : "在图上拖动框选一个区域"}
        </span>
        <span className="me-space" />
        <button className="btn nodrag" onClick={onClose}>
          <IcClose size={15} /> 取消
        </button>
        <button
          className="btn primary nodrag"
          disabled={!valid}
          style={{ opacity: valid ? 1 : 0.4 }}
          onClick={() => {
            if (valid) {
              onSave(rect!);
              onClose();
            }
          }}
        >
          <IcCheck size={15} /> 确认区域
        </button>
      </div>
      <div className="me-stage" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {dims ? (
          <div
            ref={boxRef}
            className="rp-box"
            style={{ width: w, height: h, backgroundImage: `url(${src})`, cursor: "crosshair", touchAction: "none" }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
          >
            {rect ? (
              <>
                <div className="rp-dim" style={{ left: 0, top: 0, width: "100%", height: `${rect.y * 100}%` }} />
                <div className="rp-dim" style={{ left: 0, top: `${(rect.y + rect.h) * 100}%`, width: "100%", bottom: 0 }} />
                <div className="rp-dim" style={{ left: 0, top: `${rect.y * 100}%`, width: `${rect.x * 100}%`, height: `${rect.h * 100}%` }} />
                <div className="rp-dim" style={{ left: `${(rect.x + rect.w) * 100}%`, top: `${rect.y * 100}%`, right: 0, height: `${rect.h * 100}%` }} />
                <div
                  className="rp-rect"
                  style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}
                />
              </>
            ) : null}
          </div>
        ) : (
          <div className="me-loading">载入图片中…</div>
        )}
      </div>
      <div className="me-hint">框内区域将作为该节点的输出，供下游作精准参考 · Esc 取消</div>
    </div>,
    document.body,
  );
}
