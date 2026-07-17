/**
 * 轻量 UI 组件
 */
import type { CSSProperties, ReactNode } from "react";
import { IcClose } from "./icons";

export function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <button type="button" className={`switch ${on ? "on" : ""}`} onClick={() => onChange(!on)} />;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Row({ children, gap = 10, style }: { children: ReactNode; gap?: number; style?: CSSProperties }) {
  return <div style={{ display: "flex", alignItems: "center", gap, ...style }}>{children}</div>;
}

/** 方格选项组：圆角方形按钮（图标 + 名称），替代下拉菜单 */
export function OptGrid({
  options,
  value,
  onChange,
  cols = 3,
}: {
  options: { value: string; label: string; icon?: ReactNode }[];
  value: string;
  onChange: (v: string) => void;
  cols?: number;
}) {
  return (
    <div className="opt-grid nodrag" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {options.map((o) => (
        <button key={o.value} className={`opt-cell ${value === o.value ? "on" : ""}`} onClick={() => onChange(o.value)}>
          {o.icon ? <span className="oc-ic">{o.icon}</span> : null}
          <span className="oc-lab">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  width = 720,
  footer,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  footer?: ReactNode;
}) {
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px 12px",
            borderBottom: "1px solid var(--panel-border)",
          }}
        >
          <div style={{ fontSize: "var(--fs-title)", fontWeight: 700 }}>{title}</div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <IcClose />
          </button>
        </div>
        <div style={{ padding: 20, overflowY: "auto", flex: 1 }}>{children}</div>
        {footer ? (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 10,
              padding: "12px 20px 16px",
              borderTop: "1px solid var(--panel-border)",
            }}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
