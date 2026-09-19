/**
 * 设置面板 · 外观主题页
 */
import { Row, Switch } from "../../../ui/kit";
import { useSettings } from "../../../core/stores/settingsStore";
import { IcBlack, IcMoon, IcSun } from "../../../ui/icons";

export function AppearanceTab() {
  const theme = useSettings((s) => s.settings.theme);
  const gpuBoost = useSettings((s) => s.settings.gpuBoost);
  const update = useSettings((s) => s.update);
  return (
    <div className="set-page">
      <div className="set-page-h">
        <div className="set-page-t">外观主题</div>
        <div className="set-page-d">三套精心调校的主题，随时一键切换（标题栏主题按钮或 Ctrl+Shift+T 同样可切换）。</div>
      </div>

      <div className="set-card">
        <div className="set-card-h">界面主题</div>
        <div className="theme-cards">
          <div className={`theme-card ${theme === "light" ? "on" : ""}`} onClick={() => update("theme", "light")}>
            <div className="tc-preview" style={{ background: "#eef1f8" }}>
              <div style={{ position: "absolute", inset: "12px auto auto 12px", width: 90, height: 28, borderRadius: 8, background: "#fff", boxShadow: "0 4px 14px rgba(28,42,84,.14)" }} />
              <div style={{ position: "absolute", inset: "50px auto auto 34px", width: 110, height: 30, borderRadius: 8, background: "linear-gradient(135deg,#5b8cff,#9a6bff)" }} />
            </div>
            <div className="tc-name"><IcSun size={16} /> 云白 · 白色主题</div>
          </div>
          <div className={`theme-card ${theme === "dark" ? "on" : ""}`} onClick={() => update("theme", "dark")}>
            <div className="tc-preview" style={{ background: "#161f36" }}>
              <div style={{ position: "absolute", inset: "12px auto auto 12px", width: 90, height: 28, borderRadius: 8, background: "#1c2644", border: "1px solid rgba(126,156,255,.2)" }} />
              <div style={{ position: "absolute", inset: "50px auto auto 34px", width: 110, height: 30, borderRadius: 8, background: "linear-gradient(135deg,#5b8cff,#9a6bff)" }} />
            </div>
            <div className="tc-name"><IcMoon size={16} /> 深空蓝 · 深色主题</div>
          </div>
          <div className={`theme-card ${theme === "black" ? "on" : ""}`} onClick={() => update("theme", "black")}>
            <div className="tc-preview" data-theme="black" style={{ background: "var(--bg-app)" }}>
              <div style={{ position: "absolute", inset: "12px auto auto 12px", width: 90, height: 28, borderRadius: 8, background: "var(--panel)", border: "1px solid var(--border)" }} />
              <div style={{ position: "absolute", inset: "50px auto auto 34px", width: 110, height: 30, borderRadius: 8, background: "var(--grad-brand)" }} />
            </div>
            <div className="tc-name"><IcBlack size={16} /> 深邃黑 · 石墨灰白</div>
          </div>
        </div>
      </div>

      <div className="set-card">
        <div className="set-card-h">性能</div>
        <Row gap={12} style={{ alignItems: "center" }}>
          <Switch on={gpuBoost} onChange={(v) => update("gpuBoost", v)} />
          <div>
            <div style={{ fontWeight: 600 }}>画布 GPU 加速</div>
            <div className="set-hint" style={{ marginTop: 2 }}>
              把节点提升为独立合成层，平移/缩放走 GPU 合成，明显减少大画布的卡顿闪烁。默认开启；若遇到显卡驱动兼容问题（花屏/残影）可关闭，立即生效。
            </div>
          </div>
        </Row>
      </div>

    </div>
  );
}
