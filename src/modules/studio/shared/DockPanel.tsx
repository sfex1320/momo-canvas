/**
 * 停靠面板（导演台 3.0 · 方案 §5.3）：平面停靠布局，面板靠 1px 分隔线建立层级。
 * 可拖动调宽（宽度经 studioUi.panelWidths 持久化），可折叠到 0（隐藏）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { patchStudioUi } from "../../../core/studio/studioStore";
import { IcChevronD } from "../../../ui/icons";

export function DockPanel({
  className,
  title,
  hint,
  side,
  projectId,
  widthKey,
  width,
  min = 180,
  max = 520,
  headExtra,
  children,
  scroll = true,
}: {
  className?: string;
  title?: string;
  hint?: string;
  side?: ReactNode;
  /** 宽度持久化归属的项目（拖动落盘用） */
  projectId?: string;
  /** 拖动调宽的持久化键（studioUi.panelWidths[widthKey]） */
  widthKey?: string;
  width?: number;
  min?: number;
  max?: number;
  headExtra?: ReactNode;
  children: ReactNode;
  /** 内容区是否独立滚动（false = 面板自身管理布局） */
  scroll?: boolean;
}) {
  const [w, setW] = useState(width);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);
  // 手柄侧别：面板名带 right 的停靠在内容区右侧，拖动方向相反；手柄绝对定位在面板对应侧边（3.4 修复：此前是底部零高度死条）
  const edge: "left" | "right" = className?.includes("right") ? "right" : "left";
  const dir = edge === "right" ? -1 : 1;

  const applyW = useCallback(
    (next0: number) => {
      const next = Math.round(Math.min(max, Math.max(min, next0)));
      setW(next);
      if (widthKey && projectId) patchStudioUi(projectId, { panelWidths: { [widthKey]: next } });
    },
    [widthKey, projectId, min, max],
  );

  const onDown = useCallback(
    (e: React.MouseEvent) => {
      if (!widthKey) return;
      dragging.current = true;
      startX.current = e.clientX;
      startW.current = w ?? min;
      document.body.style.cursor = "col-resize";
      e.preventDefault();
    },
    [widthKey, w, min],
  );

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current || !widthKey) return;
      setW(Math.round(Math.min(max, Math.max(min, startW.current + dir * (e.clientX - startX.current)))));
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      if (widthKey && projectId && w) patchStudioUi(projectId, { panelWidths: { [widthKey]: w } });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [widthKey, projectId, w, min, max, dir]);

  return (
    <section className={`st-panel ${className ?? ""}`} style={widthKey ? { width: w } : undefined}>
      {title ? (
        <header className="st-panel-h">
          {title}
          {headExtra}
          {hint ? <span className="st-hint" title={hint}>?</span> : null}
          {side}
        </header>
      ) : null}
      <div className={`st-panel-b${scroll ? "" : " noscroll"}`}>{children}</div>
      {widthKey ? (
        <div
          className={`st-resizer edge-${edge}${dragging.current ? " drag" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整面板宽度"
          tabIndex={0}
          title="拖动调整面板宽度（←/→ 微调）"
          onMouseDown={onDown}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") applyW((w ?? min) - 16 * dir);
            if (e.key === "ArrowRight") applyW((w ?? min) + 16 * dir);
          }}
        />
      ) : null}
    </section>
  );
}

/** 检查器分组（§6.5 右侧检查器四个稳定分组；常用项常显、高级折叠） */
export function InspectorGroup({
  title,
  open,
  onToggle,
  extra,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`st-group${open ? " open" : ""}`}>
      <div className="st-group-h" onClick={onToggle} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onToggle()}>
        <IcChevronD size={12} className="chev" />
        {title}
        <span style={{ marginLeft: "auto" }}>{extra}</span>
      </div>
      <div className="st-group-b">{children}</div>
    </div>
  );
}
