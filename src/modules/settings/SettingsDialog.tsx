/**
 * 设置面板 — 模型配置 / 联网搜索 / 图片保存 / ComfyUI / 外观
 */
import { useState } from "react";
import { Modal, Field, Switch, Row } from "../../ui/kit";
import { useSettings } from "../../core/stores/settingsStore";
import { useComfy } from "../../core/stores/comfyStore";
import { toast, useUi } from "../../core/stores/uiStore";
import { chatOnce } from "../../core/services/llm";
import { errMsg, isTauri } from "../../core/utils";
import {
  IcChat,
  IcFlow,
  IcFolder,
  IcGallery,
  IcGlobe,
  IcLoading,
  IcMoon,
  IcSparkles,
  IcSun,
  IcVideo,
} from "../../ui/icons";
import type { ImageModelCfg, SearchProvider, Settings, VideoApiStyle } from "../../core/types";

const TABS = [
  { key: "models", label: "模型配置", icon: <IcSparkles size={17} /> },
  { key: "search", label: "联网搜索", icon: <IcGlobe size={17} /> },
  { key: "save", label: "图片保存", icon: <IcGallery size={17} /> },
  { key: "comfy", label: "ComfyUI", icon: <IcFlow size={17} /> },
  { key: "appearance", label: "外观主题", icon: <IcSun size={17} /> },
];

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  const tab = useUi((s) => s.settingsTab);
  const close = useUi((s) => s.closeSettings);
  const openSettings = useUi((s) => s.openSettings);
  if (!open) return null;
  return (
    <Modal title="设置" onClose={close} width={860}>
      <div className="settings-body">
        <div className="settings-nav">
          {TABS.map((t) => (
            <button key={t.key} className={tab === t.key ? "on" : ""} onClick={() => openSettings(t.key)}>
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
        <div className="settings-content">
          {tab === "models" && <ModelsTab />}
          {tab === "search" && <SearchTab />}
          {tab === "save" && <SaveTab />}
          {tab === "comfy" && <ComfyTab />}
          {tab === "appearance" && <AppearanceTab />}
        </div>
      </div>
    </Modal>
  );
}

/* ---------------- 模型配置 ---------------- */
function ModelsTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const [testing, setTesting] = useState(false);

  const testChat = async () => {
    setTesting(true);
    try {
      const r = await chatOnce(settings.chat, "你是一个连通性测试助手。", "请只回复两个字：正常");
      toast(`对话模型连通 ✓ 回复：${r.slice(0, 40)}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setTesting(false);
    }
  };

  const patch = <K extends keyof Settings>(key: K, part: Partial<Settings[K]>) =>
    update(key, { ...(settings[key] as object), ...part } as Settings[K]);

  return (
    <>
      <h3>模型配置</h3>
      <p className="sec-desc">三类模型均使用 OpenAI 兼容接口；Base URL 填到版本号为止（例如 https://api.xxx.com/v1）。</p>

      <div className="model-card">
        <div className="mc-head">
          <span className="kind-ic"><IcChat size={16} /></span>
          对话模型 <span style={{ fontSize: 12.5, color: "var(--text-3)", fontWeight: 500 }}>多模态 · 思考 · 联网</span>
          <span style={{ flex: 1 }} />
          <button className="btn sm" disabled={testing} onClick={() => void testChat()}>
            {testing ? <IcLoading size={14} /> : null} 测试连通
          </button>
        </div>
        <Field label="Base URL">
          <input className="input" value={settings.chat.baseUrl} placeholder="https://api.deepseek.com/v1"
            onChange={(e) => patch("chat", { baseUrl: e.target.value.trim() })} />
        </Field>
        <Field label="API Key">
          <input className="input" type="password" value={settings.chat.apiKey}
            onChange={(e) => patch("chat", { apiKey: e.target.value.trim() })} />
        </Field>
        <Field label="模型名称" hint="推荐支持视觉与思考的模型，如 deepseek-reasoner、glm-4.6v、qwen3-vl-plus 等">
          <input className="input" value={settings.chat.model} placeholder="deepseek-chat"
            onChange={(e) => patch("chat", { model: e.target.value.trim() })} />
        </Field>
      </div>

      <div className="model-card">
        <div className="mc-head">
          <span className="kind-ic"><IcSparkles size={16} /></span>
          绘画模型
        </div>
        <Field label="Base URL">
          <input className="input" value={settings.image.baseUrl} placeholder="https://api.xxx.com/v1"
            onChange={(e) => patch("image", { baseUrl: e.target.value.trim() })} />
        </Field>
        <Field label="API Key">
          <input className="input" type="password" value={settings.image.apiKey}
            onChange={(e) => patch("image", { apiKey: e.target.value.trim() })} />
        </Field>
        <Row gap={12}>
          <div style={{ flex: 1.5 }}>
            <Field label="模型名称">
              <input className="input" value={settings.image.model} placeholder="gpt-image-1 / seedream-4.5 …"
                onChange={(e) => patch("image", { model: e.target.value.trim() })} />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="默认尺寸">
              <select className="select" value={settings.image.size}
                onChange={(e) => patch("image", { size: e.target.value as ImageModelCfg["size"] })}>
                {["1024x1024", "768x1024", "1024x768", "1024x1536", "1536x1024", "auto"].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </Field>
          </div>
        </Row>
      </div>

      <div className="model-card">
        <div className="mc-head">
          <span className="kind-ic"><IcVideo size={16} /></span>
          视频模型
        </div>
        <Row gap={12}>
          <div style={{ flex: 1.5 }}>
            <Field label="Base URL">
              <input className="input" value={settings.video.baseUrl} placeholder="https://open.bigmodel.cn/api/paas/v4"
                onChange={(e) => patch("video", { baseUrl: e.target.value.trim() })} />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="接口风格">
              <select className="select" value={settings.video.style}
                onChange={(e) => patch("video", { style: e.target.value as VideoApiStyle })}>
                <option value="zhipu">智谱 CogVideoX</option>
                <option value="siliconflow">硅基流动</option>
                <option value="openai">OpenAI 兼容</option>
              </select>
            </Field>
          </div>
        </Row>
        <Field label="API Key">
          <input className="input" type="password" value={settings.video.apiKey}
            onChange={(e) => patch("video", { apiKey: e.target.value.trim() })} />
        </Field>
        <Field label="模型名称">
          <input className="input" value={settings.video.model} placeholder="cogvideox-3 / Wan-AI/Wan2.2-T2V …"
            onChange={(e) => patch("video", { model: e.target.value.trim() })} />
        </Field>
      </div>
    </>
  );
}

/* ---------------- 联网搜索 ---------------- */
function SearchTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const patch = (part: Partial<Settings["search"]>) => update("search", { ...settings.search, ...part });
  const p = settings.search.provider;
  return (
    <>
      <h3>联网搜索</h3>
      <p className="sec-desc">开启对话节点上的 🌐 后，提问将先联网检索，AI 结合实时结果作答并给出来源。</p>
      <Field label="搜索服务商">
        <select className="select" value={p} onChange={(e) => patch({ provider: e.target.value as SearchProvider })}>
          <option value="tavily">Tavily（tavily.com，注册即有免费额度）</option>
          <option value="bocha">博查 Bocha（国内直连）</option>
          <option value="searxng">SearXNG（自建实例，免 Key）</option>
        </select>
      </Field>
      {p !== "searxng" ? (
        <Field label="API Key">
          <input className="input" type="password" value={settings.search.apiKey}
            onChange={(e) => patch({ apiKey: e.target.value.trim() })} />
        </Field>
      ) : (
        <Field label="实例地址" hint="例如 http://127.0.0.1:8080（需开启 JSON 输出）">
          <input className="input" value={settings.search.baseUrl} placeholder="http://127.0.0.1:8080"
            onChange={(e) => patch({ baseUrl: e.target.value.trim() })} />
        </Field>
      )}
      <Field label="结果条数">
        <select className="select" style={{ width: 140 }} value={settings.search.maxResults}
          onChange={(e) => patch({ maxResults: Number(e.target.value) })}>
          {[3, 5, 8, 10].map((n) => (
            <option key={n} value={n}>{n} 条</option>
          ))}
        </select>
      </Field>
    </>
  );
}

/* ---------------- 图片保存 ---------------- */
function SaveTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const patch = (part: Partial<Settings["save"]>) => update("save", { ...settings.save, ...part });

  const pickDir = async () => {
    if (!isTauri) {
      toast("浏览器预览模式无法选择文件夹", "err");
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, title: "选择图片保存文件夹" });
    if (typeof dir === "string") patch({ dir });
  };

  return (
    <>
      <h3>图片保存</h3>
      <p className="sec-desc">控制生成结果保存到本地时的位置、格式与命名。</p>
      <Field label="保存文件夹">
        <Row>
          <input className="input" value={settings.save.dir} placeholder="尚未选择…"
            onChange={(e) => patch({ dir: e.target.value })} />
          <button className="btn" onClick={() => void pickDir()}>
            <IcFolder size={16} /> 浏览
          </button>
        </Row>
      </Field>
      <Row gap={12}>
        <div style={{ flex: 1 }}>
          <Field label="保存格式">
            <select className="select" value={settings.save.format}
              onChange={(e) => patch({ format: e.target.value as Settings["save"]["format"] })}>
              <option value="png">PNG（无损）</option>
              <option value="jpeg">JPG（体积小）</option>
              <option value="webp">WebP（兼顾两者）</option>
            </select>
          </Field>
        </div>
        <div style={{ flex: 1.6 }}>
          <Field label="命名模板" hint="可用变量：{date} {time} {model} {prompt} {seed}">
            <input className="input" value={settings.save.pattern}
              onChange={(e) => patch({ pattern: e.target.value })} />
          </Field>
        </div>
      </Row>
      <Field label="生成后自动保存" hint="开启后，每次生成成功都会按上述规则自动写入保存文件夹">
        <Switch on={settings.save.autoSave} onChange={(v) => patch({ autoSave: v })} />
      </Field>
    </>
  );
}

/* ---------------- ComfyUI ---------------- */
function ComfyTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const online = useComfy((s) => s.online);
  const onlineInfo = useComfy((s) => s.onlineInfo);
  const test = useComfy((s) => s.test);
  const setTemplateMgr = useUi((s) => s.setTemplateMgr);
  const [testing, setTesting] = useState(false);

  return (
    <>
      <h3>ComfyUI</h3>
      <p className="sec-desc">连接本机或局域网内已启动的 ComfyUI 服务，通过工作流模板在画布上直接出图。</p>
      <Field label="服务地址">
        <Row>
          <input className="input" value={settings.comfy.host} placeholder="http://127.0.0.1:8188"
            onChange={(e) => update("comfy", { host: e.target.value.trim() })} />
          <button
            className="btn"
            disabled={testing}
            onClick={async () => {
              setTesting(true);
              const ok = await test(settings.comfy.host);
              setTesting(false);
              toast(ok ? "ComfyUI 已连接 ✓" : "无法连接 ComfyUI，请确认已启动", ok ? "ok" : "err");
            }}
          >
            {testing ? <IcLoading size={15} /> : null} 测试连接
          </button>
        </Row>
      </Field>
      <Row gap={8} style={{ marginBottom: 18 }}>
        <span className={`dot ${online}`} />
        <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-2)" }}>
          {online === "ok" ? `已连接 ${onlineInfo}` : online === "down" ? "未连接" : "未检测"}
        </span>
      </Row>
      <button className="btn primary" onClick={() => setTemplateMgr(true)}>
        <IcFlow size={16} /> 打开工作流模板管理器
      </button>
      <p className="sec-desc" style={{ marginTop: 12 }}>
        模板管理器可导入 ComfyUI「API 格式」工作流 JSON，自由勾选要暴露的输入/参数/输出节点并保存为模板。
      </p>
    </>
  );
}

/* ---------------- 外观 ---------------- */
function AppearanceTab() {
  const theme = useSettings((s) => s.settings.theme);
  const update = useSettings((s) => s.update);
  return (
    <>
      <h3>外观主题</h3>
      <p className="sec-desc">两套精心调校的主题，随时一键切换（标题栏月亮/太阳按钮同样可切换）。</p>
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
      </div>
    </>
  );
}
