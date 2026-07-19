/**
 * 扩图取景编辑器 — 原图居中，四边拖拽外扩 / 一键按目标比例外扩；
 * 棋盘格区域 = 将由模型补全的新画面。createPortal 到 body（避开节点 transform）。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { loadImg } from "../../core/maskCanvas";
import { exactRatio } from "../../core/imageInfo";
import { IcCheck, IcClose, IcExpand, IcRefresh } from "../../ui/icons";
import type { OutpaintPads } from "../../core/types";

const RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16", "21:9", "3:2", "2:3"];
const MAX_PAD = 1; // 每边最多外扩 100%

export function OutpaintEditor({
  src,
  initial,
  onSave,
  onClose,
}: {
  src: string;
  initial: OutpaintPads;
  onSave: (pads: OutpaintPads) => void;
  onClose: () => void;
}) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [pads, setPads] = useState<OutpaintPads>(initial);
  const drag = useRef<{ side: keyof OutpaintPads; startPad: number; startX: number; startY: number } | null>(null);
  const [scale, setScale] = useState(1);

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
        // 固定比例尺：按「最大外扩（每边 100% → 3 倍画布）」适配窗口，拖拽过程不跳动
        setScale(Math.min((window.innerWidth * 0.82) / (w * 3), (window.innerHeight * 0.6) / (h * 3), 1));
      })
      .catch(onClose);
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  if (!dims) {
    return createPortal(
      <div className="mask-editor nodrag nowheel">
        <div className="me-stage">
          <div className="me-loading">载入图片中…</div>
        </div>
      </div>,
      document.body,
    );
  }

  const { w: W, h: H } = dims;
  const clamp = (v: number) => Math.max(0, Math.min(MAX_PAD, v));
  const round2 = (v: number) => Math.round(v * 100) / 100;

  /** 按目标比例居中外扩（只扩不裁） */
  const applyRatio = (r: string) => {
    const [a, b] = r.split(":").map(Number);
    const target = a / b;
    const cur = W / H;
    if (target > cur * 1.001) {
      const pad = clamp((H * target - W) / 2 / W);
      setPads({ left: round2(pad), right: round2(pad), up: 0, down: 0 });
    } else if (target < cur * 0.999) {
      const pad = clamp((W / target - H) / 2 / H);
      setPads({ up: round2(pad), down: round2(pad), left: 0, right: 0 });
    } else {
      setPads({ left: 0, right: 0, up: 0, down: 0 });
    }
  };

  const startDrag = (side: keyof OutpaintPads) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { side, startPad: pads[side] ?? 0, startX: e.clientX, startY: e.clientY };
  };
  const onMove = (e: React.PointerEvent) => {
    const dr = drag.current;
    if (!dr) return;
    const dx = e.clientX - dr.startX;
    const dy = e.clientY - dr.startY;
    const delta =
      dr.side === "left" ? -dx / (W * scale) : dr.side === "right" ? dx / (W * scale) : dr.side === "up" ? -dy / (H * scale) : dy / (H * scale);
    setPads((p) => ({ ...p, [dr.side]: round2(clamp(dr.startPad + delta)) }));
  };
  const endDrag = () => {
    drag.current = null;
  };

  const outW = Math.round(W * (1 + pads.left + pads.right));
  const outH = Math.round(H * (1 + pads.up + pads.down));
  const cw = outW * scale;
  const ch = outH * scale;
  const changed = pads.left + pads.right + pads.up + pads.down > 0;

  return createPortal(
    <div className="mask-editor nodrag nowheel" onPointerMove={onMove} onPointerUp={endDrag}>
      <div className="me-toolbar glass">
        <span className="me-title">
          <IcExpand size={16} /> 扩图取景
        </span>
        <span className="me-seg">
          {RATIOS.map((r) => (
            <button key={r} title={`居中外扩到 ${r}`} onClick={() => applyRatio(r)}>
              {r}
            </button>
          ))}
        </span>
        <button className="icon-btn" title="重置（不扩展）" onClick={() => setPads({ left: 0, right: 0, up: 0, down: 0 })}>
          <IcRefresh size={15} />
        </button>
        <span className="me-note">
          输出 {outW} × {outH} px · {exactRatio(outW, outH)}
        </span>
        <span className="me-space" />
        <button className="btn nodrag" onClick={onClose}>
          <IcClose size={15} /> 取消
        </button>
        <button className="btn primary nodrag" disabled={!changed} style={{ opacity: changed ? 1 : 0.45 }} onClick={() => {
          onSave(pads);
          onClose();
        }}>
          <IcCheck size={15} /> 确认范围
        </button>
      </div>
      <div className="me-stage" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="op-canvas" style={{ width: cw, height: ch }}>
          <div
            className="op-img"
            style={{
              left: W * pads.left * scale,
              top: H * pads.up * scale,
              width: W * scale,
              height: H * scale,
              backgroundImage: `url(${src})`,
            }}
          />
          <div className="op-handle h left" title="向左拖动扩展" style={{ top: ch / 2 }} onPointerDown={startDrag("left")} />
          <div className="op-handle h right" title="向右拖动扩展" style={{ top: ch / 2 }} onPointerDown={startDrag("right")} />
          <div className="op-handle v up" title="向上拖动扩展" style={{ left: cw / 2 }} onPointerDown={startDrag("up")} />
          <div className="op-handle v down" title="向下拖动扩展" style={{ left: cw / 2 }} onPointerDown={startDrag("down")} />
        </div>
      </div>
      <div className="me-hint">拖动四边把手向外扩展，或点上方比例一键取景 · 棋盘格区域将由模型补全 · Esc 取消</div>
    </div>,
    document.body,
  );
}
