/**
 * 球面方位小部件 — 打光（光源位置）与多角度（相机机位）节点共用
 *  中央是上游图片缩略图；太阳/相机图标表示光源/机位的球面位置。
 *  轨迹球交互：按住任意处拖动即可 360° 环绕（水平拖过 ±90° 自然绕到背面），垂直拖动调俯仰。
 *  背面时图标绕到中心画面「后面」（绘制在图片之下）、变小变暗，方向一目了然。
 */
import { useId, useRef } from "react";
import { useThumb } from "./Thumb";

const R = 60;
const RAD = Math.PI / 180;

export function SphereGizmo({
  az,
  el,
  image,
  mode,
  onChange,
}: {
  /** 水平方位角：0 正前方，负左正右，±180 背后 */
  az: number;
  /** 垂直仰角：正上负下 */
  el: number;
  /** 中央展示的参考图（上游图片） */
  image?: string;
  /** light = 光源（太阳）；camera = 机位（相机） */
  mode: "light" | "camera";
  onChange: (az: number, el: number) => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<{ az: number; el: number; x: number; y: number; sign: 1 | -1 } | null>(null);
  const clipId = useId();
  const thumb = useThumb(image);

  const cosE = Math.cos(el * RAD);
  const x = Math.sin(az * RAD) * cosE * R;
  const y = -Math.sin(el * RAD) * R;
  /** 深度（朝向观察者为正）：决定前/背面表现 */
  const depth = Math.cos(az * RAD) * cosE;
  const front = depth >= 0;
  /** 近大远小：前面 1 → 背面 0.68 */
  const markScale = 0.78 + Math.max(-1, Math.min(1, depth)) * 0.22;

  // 光锥/视线：从图标到中央画面的三角形（背面或太靠近中心时省略/变淡）
  const len = Math.hypot(x, y);
  const nx = len > 8 ? (-y / len) * 13 : 0;
  const ny = len > 8 ? (x / len) * 13 : 0;

  /* 轨迹球拖拽：以按下时的方位为基准做增量，水平满幅 ≈ 300°、垂直满幅 ≈ 200°。
     方向跟手：图标在背面时水平增量取反（否则物理镜像会让图标与鼠标反着走）；
     方向在按下时锁定，拖动中途越过边缘也不突变，松手重按即按新半球生效。 */
  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { az, el, x: e.clientX, y: e.clientY, sign: depth >= 0 ? 1 : -1 };
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    const b = ref.current?.getBoundingClientRect();
    if (!d || !b?.width) return;
    let naz = d.az + d.sign * ((e.clientX - d.x) / b.width) * 300;
    naz = ((naz + 540) % 360) - 180; // 环绕到 -180..180
    const nel = Math.max(-85, Math.min(85, d.el - ((e.clientY - d.y) / b.height) * 200));
    onChange(Math.round(naz), Math.round(nel));
  };
  const onUp = () => {
    drag.current = null;
  };

  const mark = (
    <g
      transform={`translate(${x},${y}) scale(${markScale})`}
      className={`sg-mark ${mode} ${front ? "" : "back"}`}
    >
      <title>
        {`${mode === "light" ? "光源" : "机位"} · 水平 ${az}° / 垂直 ${el}°${front ? "" : "（背面）"} —— 按住拖动可 360° 环绕`}
      </title>
      {mode === "light" ? (
        <>
          {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
            <line
              key={a}
              x1={Math.cos(a * RAD) * 6.2}
              y1={Math.sin(a * RAD) * 6.2}
              x2={Math.cos(a * RAD) * 9.4}
              y2={Math.sin(a * RAD) * 9.4}
              className="sg-ray"
            />
          ))}
          <circle r={4.4} className="sg-sun" />
        </>
      ) : (
        <>
          <rect x={-3.2} y={-8} width={6.4} height={3} rx={1.2} className="sg-cam" />
          <rect x={-7.6} y={-5.4} width={15.2} height={11} rx={2.4} className="sg-cam" />
          <circle r={3} className="sg-lens" />
          <circle r={1.2} className="sg-lens-core" />
        </>
      )}
    </g>
  );

  return (
    <svg
      ref={ref}
      className="sphere-gizmo nodrag nopan"
      viewBox="-80 -80 160 160"
      style={{ cursor: drag.current ? "grabbing" : "grab", touchAction: "none" }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={onUp}
    >
      <circle r={R} className="sg-globe" />
      <ellipse rx={R} ry={R * 0.34} className="sg-grid" />
      <ellipse rx={R * 0.34} ry={R} className="sg-grid" />
      <circle r={R * 0.72} className="sg-grid" />
      {/* 背面：图标画在中央图片之下（被画面遮住一部分 = 「绕到了后面」） */}
      {!front ? mark : null}
      {front && len > 8 ? <polygon points={`${x},${y} ${nx},${ny} ${-nx},${-ny}`} className="sg-cone" /> : null}
      {thumb ? (
        <>
          <clipPath id={clipId}>
            <rect x={-24} y={-18} width={48} height={36} rx={5} />
          </clipPath>
          <image href={thumb} x={-24} y={-18} width={48} height={36} preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clipId})`} />
          <rect x={-24} y={-18} width={48} height={36} rx={5} className="sg-photo-frame" />
        </>
      ) : (
        <rect x={-24} y={-18} width={48} height={36} rx={5} className="sg-photo" />
      )}
      {front ? mark : null}
    </svg>
  );
}
