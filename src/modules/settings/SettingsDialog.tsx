/**
 * 设置面板 — 模型配置（多套卡片） / 联网搜索 / 图片保存 / ComfyUI / 外观
 */
import { useEffect, useState } from "react";
import { Modal, Field, Switch, Row } from "../../ui/kit";
import { flattenCard, useSettings } from "../../core/stores/settingsStore";
import { useComfy } from "../../core/stores/comfyStore";
import { toast, useUi } from "../../core/stores/uiStore";
import { chatOnce } from "../../core/services/llm";
import { fetchModelList } from "../../core/services/modelList";
import { errMsg, isTauri, uid } from "../../core/utils";
import {
  IcChat,
  IcCheck,
  IcDownload,
  IcEdit,
  IcFlow,
  IcFolder,
  IcGallery,
  IcGlobe,
  IcKeyboard,
  IcLoading,
  IcMoon,
  IcPlus,
  IcSparkles,
  IcSun,
  IcTrash,
  IcUpload,
  IcVideo,
} from "../../ui/icons";
import {
  DEFAULT_HOTKEYS,
  HOTKEY_LABEL,
  PROTOCOLS,
  ROLE_LABEL,
  type AnyProtocol,
  type HotkeyAction,
  type ModelRole,
  type ProviderCard,
  type RoleSlot,
  type SearchProvider,
  type Settings,
} from "../../core/types";

const TABS = [
  { key: "models", label: "模型配置", icon: <IcSparkles size={17} /> },
  { key: "search", label: "联网搜索", icon: <IcGlobe size={17} /> },
  { key: "save", label: "图片保存", icon: <IcGallery size={17} /> },
  { key: "comfy", label: "ComfyUI", icon: <IcFlow size={17} /> },
  { key: "hotkeys", label: "快捷键", icon: <IcKeyboard size={17} /> },
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
          {tab === "hotkeys" && <HotkeysTab />}
          {tab === "appearance" && <AppearanceTab />}
        </div>
      </div>
    </Modal>
  );
}

/* ================= 配置导出 / 导入 ================= */

async function exportCfg() {
  try {
    const json = JSON.stringify(useSettings.getState().settings, null, 2);
    if (isTauri) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({ defaultPath: "momo-settings.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!path) return;
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(path, json);
      toast(`配置已导出 → ${path}`, "ok");
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      a.download = "momo-settings.json";
      a.click();
      URL.revokeObjectURL(a.href);
      toast("配置已导出", "ok");
    }
  } catch (e) {
    toast(errMsg(e), "err");
  }
}

async function importCfg() {
  try {
    let text = "";
    if (isTauri) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ filters: [{ name: "JSON", extensions: ["json"] }], multiple: false });
      if (typeof path !== "string") return;
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      text = await readTextFile(path);
    } else {
      text = await new Promise<string>((resolve, reject) => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = ".json";
        inp.onchange = () => {
          const f = inp.files?.[0];
          if (!f) return reject(new Error("未选择文件"));
          f.text().then(resolve, reject);
        };
        inp.click();
      });
    }
    useSettings.getState().importSettings(JSON.parse(text));
    toast("配置已导入 ✓", "ok");
  } catch (e) {
    toast(errMsg(e), "err");
  }
}

/* ================= 模型配置（服务商卡片） ================= */

const ROLE_ICON: Record<ModelRole, React.ReactNode> = {
  chat: <IcChat size={16} />,
  image: <IcSparkles size={16} />,
  video: <IcVideo size={16} />,
};

const ROLES: ModelRole[] = ["chat", "image", "video"];

const MODEL_PLACEHOLDER: Record<ModelRole, string> = {
  chat: "deepseek-chat / glm-4.6v …",
  image: "gpt-image-1 / seedream-4.5 …",
  video: "cogvideox-3 / Wan2.2-T2V …",
};

/** 编辑草稿：三个角色槽位全部实体化，模型名留空表示未启用 */
type ProviderDraft = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  slots: Record<ModelRole, RoleSlot>;
};

function toDraft(p?: ProviderCard): ProviderDraft {
  const slot = (role: ModelRole): RoleSlot =>
    p?.models[role] ?? {
      protocol: PROTOCOLS[role][0].value as AnyProtocol,
      model: "",
      ...(role === "image" ? { size: "1024x1024" } : {}),
    };
  return {
    id: p?.id ?? uid(8),
    name: p?.name ?? "",
    baseUrl: p?.baseUrl ?? "",
    apiKey: p?.apiKey ?? "",
    slots: { chat: slot("chat"), image: slot("image"), video: slot("video") },
  };
}

function fromDraft(d: ProviderDraft): ProviderCard {
  const models: ProviderCard["models"] = {};
  for (const role of ROLES) {
    const s = d.slots[role];
    if (s.model.trim()) models[role] = { ...s, model: s.model.trim() };
  }
  const fallback = d.baseUrl.replace(/^https?:\/\//, "").split("/")[0] || "未命名服务商";
  return { id: d.id, name: d.name.trim() || fallback, baseUrl: d.baseUrl, apiKey: d.apiKey, models };
}

function ModelsTab() {
  const models = useSettings((s) => s.settings.models);
  const upsertProvider = useSettings((s) => s.upsertProvider);
  const removeProvider = useSettings((s) => s.removeProvider);
  const setDefault = useSettings((s) => s.setDefault);
  const [editing, setEditing] = useState<ProviderDraft | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const testChat = async (p: ProviderCard) => {
    const card = flattenCard(p, "chat");
    if (!card) return;
    setTesting(p.id);
    try {
      const r = await chatOnce(card, "你是一个连通性测试助手。", "请只回复两个字：正常");
      toast(`「${p.name}」对话模型连通 ✓ 回复：${r.slice(0, 40)}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setTesting(null);
    }
  };

  const saveEditing = () => {
    if (!editing) return;
    const p = fromDraft(editing);
    if (!Object.keys(p.models).length) {
      toast("请至少为一种用途填写模型名称（可用「拉取模型」快速选择）", "err");
      return;
    }
    upsertProvider(p);
    setEditing(null);
    toast(`已保存「${p.name}」`, "ok");
  };

  return (
    <>
      <h3>模型配置</h3>
      <p className="sec-desc">
        一张卡片对应一个服务商（中转站）：Base URL 与 API Key 只填一次，卡内可同时配置对话、绘画、视频 3 套模型。
        配置保存在系统用户数据目录，升级不会丢失；每次启动还会自动写一份备份，也可以手动导出成文件保管。
      </p>
      <Row style={{ marginBottom: 14 }}>
        <button className="btn primary" onClick={() => setEditing(toDraft())}>
          <IcPlus size={16} /> 添加服务商
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn sm" title="把全部设置导出为 JSON 文件保管" onClick={() => void exportCfg()}>
          <IcDownload size={15} /> 导出配置
        </button>
        <button className="btn sm" title="从导出的 JSON 文件恢复全部设置" onClick={() => void importCfg()}>
          <IcUpload size={15} /> 导入配置
        </button>
      </Row>

      {editing && !models.providers.some((p) => p.id === editing.id) ? (
        <ProviderEditor draft={editing} setDraft={setEditing} onSave={saveEditing} onCancel={() => setEditing(null)} />
      ) : null}

      {models.providers.length === 0 && !editing ? (
        <div style={{ padding: "8px 2px", color: "var(--text-3)", fontSize: "var(--fs-sm)" }}>
          还没有服务商，点上方「添加服务商」开始配置
        </div>
      ) : null}

      {models.providers.map((p) =>
        editing?.id === p.id ? (
          <ProviderEditor key={p.id} draft={editing} setDraft={setEditing} onSave={saveEditing} onCancel={() => setEditing(null)} />
        ) : (
          <div key={p.id} className="prov-card">
            <div className="pc-head">
              <div className="pc-title">
                <b>{p.name}</b>
                <span>{p.baseUrl || "（未填 Base URL）"}</span>
              </div>
              {p.models.chat ? (
                <button className="btn sm" disabled={testing === p.id} onClick={() => void testChat(p)}>
                  {testing === p.id ? <IcLoading size={14} /> : null} 测试
                </button>
              ) : null}
              <button className="icon-btn" title="编辑" onClick={() => setEditing(toDraft(p))}>
                <IcEdit size={16} />
              </button>
              <button
                className="icon-btn danger"
                title={confirmDel === p.id ? "再点一次确认删除" : "删除"}
                style={confirmDel === p.id ? { color: "var(--danger)", background: "rgba(242,79,106,.12)" } : undefined}
                onClick={() => {
                  if (confirmDel === p.id) {
                    removeProvider(p.id);
                    setConfirmDel(null);
                  } else setConfirmDel(p.id);
                }}
              >
                <IcTrash size={16} />
              </button>
            </div>
            {ROLES.map((role) => {
              const slot = p.models[role];
              const isDefault = models.defaults[role] === p.id;
              return (
                <div key={role} className={`pc-role ${slot ? "" : "off"}`}>
                  {slot ? (
                    <button
                      className={`mrow-radio ${isDefault ? "on" : ""}`}
                      title={isDefault ? `当前是${ROLE_LABEL[role]}默认` : `设为${ROLE_LABEL[role]}默认`}
                      onClick={() => setDefault(role, p.id)}
                    >
                      {isDefault ? <IcCheck size={13} /> : null}
                    </button>
                  ) : (
                    <span className="pc-radio-ph" />
                  )}
                  <span className="pc-role-ic">{ROLE_ICON[role]}</span>
                  <span className="pc-role-name">{ROLE_LABEL[role]}</span>
                  {slot ? (
                    <>
                      <span className="pc-model" title={slot.model}>{slot.model}</span>
                      <span className="pc-proto">
                        {PROTOCOLS[role].find((x) => x.value === slot.protocol)?.label ?? slot.protocol}
                      </span>
                    </>
                  ) : (
                    <span className="pc-model off">未配置</span>
                  )}
                </div>
              );
            })}
          </div>
        ),
      )}
    </>
  );
}

function ProviderEditor({
  draft,
  setDraft,
  onSave,
  onCancel,
}: {
  draft: ProviderDraft;
  setDraft: (d: ProviderDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  // 拉取到的模型列表按协议缓存（同一中转站三个槽位通常协议相同，可复用）
  const [lists, setLists] = useState<Record<string, string[]>>({});
  const [pulling, setPulling] = useState<ModelRole | null>(null);

  const patchSlot = (role: ModelRole, part: Partial<RoleSlot>) =>
    setDraft({ ...draft, slots: { ...draft.slots, [role]: { ...draft.slots[role], ...part } } });

  const pull = async (role: ModelRole) => {
    const proto = draft.slots[role].protocol;
    setPulling(role);
    try {
      const ids = await fetchModelList(proto, draft.baseUrl, draft.apiKey);
      setLists((s) => ({ ...s, [proto]: ids }));
      toast(`拉取到 ${ids.length} 个模型，请在下拉框中选择`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setPulling(null);
    }
  };

  return (
    <div className="mrow-editor">
      <Row gap={12}>
        <div style={{ flex: 1 }}>
          <Field label="服务商名称">
            <input
              className="input"
              placeholder="例如：中转A / 智谱官方"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
        </div>
        <div style={{ flex: 1.6 }}>
          <Field label="Base URL">
            <input
              className="input"
              placeholder="https://api.xxx.com/v1（Gemini 官方可留空）"
              value={draft.baseUrl}
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value.trim() })}
            />
          </Field>
        </div>
      </Row>
      <Field label="API Key">
        <input
          className="input"
          type="password"
          value={draft.apiKey}
          onChange={(e) => setDraft({ ...draft, apiKey: e.target.value.trim() })}
        />
      </Field>

      {ROLES.map((role) => {
        const slot = draft.slots[role];
        const list = lists[slot.protocol] ?? [];
        return (
          <div key={role} className="pe-slot">
            <div className="pe-slot-head">
              <span className="pc-role-ic">{ROLE_ICON[role]}</span>
              {ROLE_LABEL[role]}
              <span className="pe-slot-hint">留空 = 该服务商不提供此用途</span>
            </div>
            <Row gap={10}>
              <select
                className="select"
                style={{ flex: 1 }}
                title="协议"
                value={slot.protocol}
                onChange={(e) => patchSlot(role, { protocol: e.target.value as AnyProtocol })}
              >
                {PROTOCOLS[role].map((x) => (
                  <option key={x.value} value={x.value}>
                    {x.label}
                  </option>
                ))}
              </select>
              <input
                className="input"
                style={{ flex: 1.5 }}
                placeholder={MODEL_PLACEHOLDER[role]}
                list={`ml-${draft.id}-${slot.protocol}`}
                value={slot.model}
                onChange={(e) => patchSlot(role, { model: e.target.value })}
              />
              {role === "image" ? (
                <select
                  className="select"
                  style={{ width: 118, flex: "none" }}
                  title="默认尺寸"
                  value={slot.size ?? "1024x1024"}
                  onChange={(e) => patchSlot(role, { size: e.target.value })}
                >
                  {["1024x1024", "768x1024", "1024x768", "1024x1536", "1536x1024", "auto"].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              ) : null}
              <button
                className="btn sm"
                style={{ flex: "none" }}
                title="从该服务商拉取可用模型列表"
                disabled={pulling !== null}
                onClick={() => void pull(role)}
              >
                {pulling === role ? <IcLoading size={14} /> : <IcDownload size={14} />} 拉取模型
              </button>
            </Row>
            {list.length ? (
              <select
                className="select pe-pick"
                value=""
                onChange={(e) => {
                  if (e.target.value) patchSlot(role, { model: e.target.value });
                }}
              >
                <option value="">从拉取到的 {list.length} 个模型中选择…</option>
                {list.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : null}
            <datalist id={`ml-${draft.id}-${slot.protocol}`}>
              {list.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
        );
      })}

      <Row style={{ justifyContent: "flex-end", margin: "12px 0 10px" }}>
        <button className="btn sm" onClick={onCancel}>
          取消
        </button>
        <button className="btn sm primary" onClick={onSave}>
          保存服务商
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

/* ================= 快捷键 ================= */

/** 键名 → 键帽显示（方向键用箭头，精致些） */
function keyLabel(key: string): string {
  const map: Record<string, string> = {
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    " ": "Space",
    Escape: "Esc",
    Delete: "Del",
    Backspace: "⌫",
    Enter: "⏎",
    Tab: "⇥ Tab",
  };
  return map[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

const FIXED_KEYS: { label: string; keys: string[] }[] = [
  { label: "撤销", keys: ["Ctrl", "Z"] },
  { label: "重做", keys: ["Ctrl", "Y"] },
  { label: "创建副本", keys: ["Ctrl", "D"] },
  { label: "删除所选（节点/连线）", keys: ["Del"] },
  { label: "临时平移画布", keys: ["Space", "拖动"] },
  { label: "多选 / 框选连线", keys: ["Ctrl", "点击或框选"] },
  { label: "粘贴图片/文字", keys: ["Ctrl", "V"] },
];

function HotkeysTab() {
  const hotkeys = useSettings((s) => s.settings.hotkeys);
  const update = useSettings((s) => s.update);
  const [capturing, setCapturing] = useState<HotkeyAction | null>(null);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const clash = (Object.entries(hotkeys) as [HotkeyAction, string][]).find(([a, k]) => k === key && a !== capturing);
      if (clash) {
        toast(`「${keyLabel(key)}」已分配给：${HOTKEY_LABEL[clash[0]]}`, "err");
        return;
      }
      update("hotkeys", { ...hotkeys, [capturing]: key });
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, hotkeys, update]);

  return (
    <>
      <h3>快捷键</h3>
      <p className="sec-desc">点击键帽后按下新按键即可重新绑定（Esc 取消）。下方为固定组合键，仅作速查。</p>
      {(Object.keys(HOTKEY_LABEL) as HotkeyAction[]).map((action) => (
        <div className="hk-row" key={action}>
          <span className="hk-name">{HOTKEY_LABEL[action]}</span>
          <button
            className={`keycap ${capturing === action ? "cap" : ""}`}
            title="点击后按下新按键"
            onClick={() => setCapturing(capturing === action ? null : action)}
          >
            {capturing === action ? "按键…" : keyLabel(hotkeys[action])}
          </button>
        </div>
      ))}
      <Row style={{ margin: "6px 0 18px" }}>
        <button className="btn sm" onClick={() => update("hotkeys", { ...DEFAULT_HOTKEYS })}>
          恢复默认
        </button>
      </Row>
      <h3 style={{ fontSize: "var(--fs-base)" }}>固定快捷键</h3>
      {FIXED_KEYS.map((f) => (
        <div className="hk-row dim" key={f.label}>
          <span className="hk-name">{f.label}</span>
          <span className="hk-combo">
            {f.keys.map((k, i) => (
              <span key={i}>
                {i > 0 ? <i className="hk-plus">+</i> : null}
                <kbd className="keycap sm">{k}</kbd>
              </span>
            ))}
          </span>
        </div>
      ))}
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
