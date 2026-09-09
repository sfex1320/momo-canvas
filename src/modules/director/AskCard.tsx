/** 应用内确认卡片（替代 window.confirm——WebView2 的原生确认框会掉到窗口后面，难关） */
import type { ReactNode } from "react";

export function AskCard({
  text,
  okText = "确认开始",
  danger,
  onConfirm,
  onCancel,
  children,
}: {
  /** 确认内容（可含 JSX 插值） */
  text: ReactNode;
  /** 确认按钮文案 */
  okText?: string;
  /** 危险操作：确认钮变红 */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** 确认行之外的次级选项（如「存为草稿」） */
  children?: ReactNode;
}) {
  return (
    <div
      className="ds-ask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="ds-ask-card">
        <div className="ds-ask-text">{text}</div>
        {children}
        <div className="ds-ask-row">
          <button className="btn sm" onClick={onCancel}>
            取消
          </button>
          <button className={`btn sm ${danger ? "danger" : "primary"}`} onClick={onConfirm}>
            {okText}
          </button>
        </div>
      </div>
    </div>
  );
}
