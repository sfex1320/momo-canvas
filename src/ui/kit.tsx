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
