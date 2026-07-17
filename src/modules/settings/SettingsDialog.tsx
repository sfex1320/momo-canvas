/**
 * 设置面板 — 模型配置（多套卡片） / 联网搜索 / 图片保存 / ComfyUI / 外观
 */
import { useState } from "react";
import { Modal, Field, Switch, Row } from "../../ui/kit";
import { useSettings } from "../../core/stores/settingsStore";
import { useComfy } from "../../core/stores/comfyStore";
import { toast, useUi } from "../../core/stores/uiStore";
import { chatOnce } from "../../core/services/llm";
import { errMsg, isTauri, uid } from "../../core/utils";
import {
  IcChat,
  IcCheck,
  IcEdit,
  IcFlow,
  IcFolder,
  IcGallery,
  IcGlobe,
  IcLoading,
  IcMoon,
  IcPlus,
  IcSparkles,
  IcSun,
  IcTrash,
  IcVideo,
} from "../../ui/icons";
import {
  PROTOCOLS,
  ROLE_LABEL,
  type ModelCard,
  type ModelRole,
  type SearchProvider,
  type Settings,
} from "../../core/types";

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
    <Modal title="设置" onClose={close} width={880}>
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

/* ================= 模型配置（多套卡片） ================= */

const ROLE_ICON: Record<ModelRole, React.ReactNode> = {
  chat: <IcChat size={16} />,
  image: <IcSparkles size={16} />,
  video: <IcVideo size={16} />,
};

const ROLE_HINT: Record<ModelRole, string> = {
  chat: "多模态 · 思考 · 联网 — 供对话/反推/文本处理节点使用",
  image: "供「生成图像」节点使用，同一中转站可添加多套不同模型",
  video: "供「生成视频」节点使用",
};

const BASE_PLACEHOLDER: Record<string, string> = {
  openai: "https://api.xxx.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com（官方可留空默认）",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  siliconflow: "https://api.siliconflow.cn/v1",
};

function emptyCard(role: ModelRole): ModelCard {
  return {
    id: uid(8),
    role,
    name: "",
    protocol: PROTOCOLS[role][0].value as ModelCard["protocol"],
    baseUrl: "",
    apiKey: "",
    model: "",
    ...(role === "image" ? { size: "1024x1024" } : {}),
  };
}

function ModelsTab() {
  const models = useSettings((s) => s.settings.models);
  const upsertCard = useSettings((s) => s.upsertCard);
  const removeCard = useSettings((s) => s.removeCard);
  const setDefault = useSettings((s) => s.setDefault);
  const [editing, setEditing] = useState<ModelCard | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const testChat = async (card: ModelCard) => {
    setTesting(card.id);
    try {
      const r = await chatOnce(card, "你是一个连通性测试助手。", "请只回复两个字：正常");
      toast(`「${card.name}」连通 ✓ 回复：${r.slice(0, 40)}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setTesting(null);
    }
  };

  const saveEditing = () => {
    if (!editing) return;
    if (!editing.model.trim()) {
      toast("请填写模型名称", "err");
      return;
    }
    const name = editing.name.trim() || editing.model.trim();
    upsertCard({ ...editing, name });
    setEditing(null);
    toast(`已保存「${name}」`, "ok");
  };

  return (
    <>
      <h3>模型配置</h3>
      <p className="sec-desc">
        每类可添加多套配置（同一中转站也可配多个模型），节点上可单独选用；单选点为该类的默认模型。
      </p>
      {(Object.keys(ROLE_LABEL) as ModelRole[]).map((role) => {
        const cards = models.cards.filter((c) => c.role === role);
        return (
          <div className="model-card" key={role}>
            <div className="mc-head">
              <span className="kind-ic">{ROLE_ICON[role]}</span>
              {ROLE_LABEL[role]}
              <span style={{ fontSize: 12.5, color: "var(--text-3)", fontWeight: 500 }}>{ROLE_HINT[role]}</span>
              <span style={{ flex: 1 }} />
              <button className="btn sm" onClick={() => setEditing(emptyCard(role))}>
                <IcPlus size={15} /> 添加配置
              </button>
            </div>

            {cards.length === 0 && (!editing || editing.role !== role) ? (
              <div style={{ padding: "4px 2px 12px", color: "var(--text-3)", fontSize: "var(--fs-sm)" }}>
                还没有配置，点右上「添加配置」
              </div>
            ) : null}

            {cards.map((c) =>
              editing?.id === c.id ? (
                <CardEditor key={c.id} card={editing} setCard={setEditing} onSave={saveEditing} onCancel={() => setEditing(null)} />
              ) : (
                <div key={c.id} className="mrow">
                  <button
                    className={`mrow-radio ${models.defaults[role] === c.id ? "on" : ""}`}
                    title="设为默认"
                    onClick={() => setDefault(role, c.id)}
                  >
                    {models.defaults[role] === c.id ? <IcCheck size={13} /> : null}
                  </button>
                  <div className="mrow-name">
                    <b>{c.name}</b>
                    <span>
                      {PROTOCOLS[role].find((p) => p.value === c.protocol)?.label ?? c.protocol} · {c.model || "未填模型"}
                    </span>
                  </div>
                  {role === "chat" ? (
                    <button className="btn sm" disabled={testing === c.id} onClick={() => void testChat(c)}>
                      {testing === c.id ? <IcLoading size={14} /> : null} 测试
                    </button>
                  ) : null}
                  <button className="icon-btn" title="编辑" onClick={() => setEditing({ ...c })}>
                    <IcEdit size={16} />
                  </button>
                  <button
                    className="icon-btn danger"
                    title={confirmDel === c.id ? "再点一次确认删除" : "删除"}
                    style={confirmDel === c.id ? { color: "var(--danger)", background: "rgba(242,79,106,.12)" } : undefined}
                    onClick={() => {
                      if (confirmDel === c.id) {
                        removeCard(c.id);
                        setConfirmDel(null);
                      } else setConfirmDel(c.id);
                    }}
                  >
                    <IcTrash size={16} />
                  </button>
                </div>
              ),
            )}

            {editing && editing.role === role && !cards.some((c) => c.id === editing.id) ? (
              <CardEditor card={editing} setCard={setEditing} onSave={saveEditing} onCancel={() => setEditing(null)} />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function CardEditor({
  card,
  setCard,
  onSave,
  onCancel,
}: {
  card: ModelCard;
  setCard: (c: ModelCard) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const role = card.role;
  return (
    <div className="mrow-editor">
      <Row gap={12}>
        <div style={{ flex: 1.2 }}>
          <Field label="显示名称">
            <input
              className="input"
              placeholder="例如：中转A · GPT-Image"
              value={card.name}
              onChange={(e) => setCard({ ...card, name: e.target.value })}
            />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="协议">
            <select
              className="select"
              value={card.protocol}
              onChange={(e) => setCard({ ...card, protocol: e.target.value as ModelCard["protocol"] })}
            >
              {PROTOCOLS[role].map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Row>
      <Field label="Base URL">
        <input
          className="input"
          placeholder={BASE_PLACEHOLDER[card.protocol] ?? "https://…"}
          value={card.baseUrl}
          onChange={(e) => setCard({ ...card, baseUrl: e.target.value.trim() })}
        />
      </Field>
      <Field label="API Key">
        <input
          className="input"
          type="password"
          value={card.apiKey}
          onChange={(e) => setCard({ ...card, apiKey: e.target.value.trim() })}
        />
      </Field>
      <Row gap={12}>
        <div style={{ flex: 1.4 }}>
          <Field label="模型名称">
            <input
              className="input"
              placeholder={role === "chat" ? "deepseek-chat / glm-4.6v …" : role === "image" ? "gpt-image-1 / seedream-4.5 …" : "cogvideox-3 / Wan2.2-T2V …"}
              value={card.model}
              onChange={(e) => setCard({ ...card, model: e.target.value.trim() })}
            />
          </Field>
        </div>
        {role === "image" ? (
          <div style={{ flex: 1 }}>
            <Field label="默认尺寸">
              <select
                className="select"
                value={card.size ?? "1024x1024"}
                onChange={(e) => setCard({ ...card, size: e.target.value })}
              >
                {["1024x1024", "768x1024", "1024x768", "1024x1536", "1536x1024", "auto"].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ) : null}
      </Row>
      <Row style={{ justifyContent: "flex-end", marginBottom: 10 }}>
        <button className="btn sm" onClick={onCancel}>
          取消
        </button>
        <button className="btn sm primary" onClick={onSave}>
          保存配置
        </button>
      </Row>
    </div>
  );
}

/* ================= 联网搜索 ================= */
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

/* ================= 图片保存 ================= */
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
      <p className="sec-desc">
        控制「另存为 / 自动保存」写入磁盘的位置、格式与命名。画布生成的内容会另外自动收录进资产库，两者互不影响。
      </p>
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

/* ================= ComfyUI ================= */
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

/* ================= 外观 ================= */
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
