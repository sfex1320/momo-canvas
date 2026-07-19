/**
 * 设置面板 — 模型配置（多套卡片） / 联网搜索 / 图片保存 / ComfyUI / 外观
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Modal, Field, Switch, Row } from "../../ui/kit";
import { flattenCard, modelKey, resolveModelCard, splitModelKey, useSettings } from "../../core/stores/settingsStore";
import { useComfy } from "../../core/stores/comfyStore";
import { toast, useUi } from "../../core/stores/uiStore";
import { chatOnce } from "../../core/services/llm";
import { fetchModelList } from "../../core/services/modelList";
import { calibrateProtocol } from "../../core/services/protoCalibrate";
import { MANUAL, useProtoTab } from "./protoTabStore";
import { xfetch } from "../../core/services/http";
import { errMsg, isTauri, uid } from "../../core/utils";
import { importTemplateFilesAuto, packTemplates, saveTextFile } from "../comfy/templateIO";
import {
  IcChat,
  IcCheck,
  IcClose,
  IcDownload,
  IcEdit,
  IcFlow,
  IcFolder,
  IcGallery,
  IcGlobe,
  IcKeyboard,
  IcLoading,
  IcMoon,
  IcMusic,
  IcPlay,
  IcPlus,
  IcSearch,
  IcSparkles,
  IcSun,
  IcTrash,
  IcUpload,
  IcVideo,
} from "../../ui/icons";
import { IcLogo } from "../../ui/icons";
import { checkUpdate, currentVersion, isPortable, GH_REPO, type UpdateInfo } from "../../core/services/updater";
import { PROTO_PRESETS, applyProtoPreset } from "../../core/protoPresets";
import { playDone, playError } from "../../core/sound";
import {
  DEFAULT_HOTKEYS,
  HOTKEY_LABEL,
  PROTOCOLS,
  ROLE_LABEL,
  type AnyProtocol,
  type CustomProtocol,
  type HotkeyAction,
  type ModelRole,
  type ProviderCard,
  type RoleSlot,
  type SearchProvider,
  type Settings,
  type SoundCfg,
} from "../../core/types";

const TABS = [
  { key: "models", label: "模型配置", icon: <IcSparkles size={17} /> },
  { key: "protocols", label: "协议", icon: <IcFlow size={17} /> },
  { key: "search", label: "联网搜索", icon: <IcGlobe size={17} /> },
  { key: "save", label: "图片保存", icon: <IcGallery size={17} /> },
  { key: "comfy", label: "ComfyUI", icon: <IcFlow size={17} /> },
  { key: "sound", label: "音效提醒", icon: <IcMusic size={17} /> },
  { key: "hotkeys", label: "快捷键", icon: <IcKeyboard size={17} /> },
  { key: "appearance", label: "外观主题", icon: <IcSun size={17} /> },
  { key: "about", label: "关于与更新", icon: <IcLogo size={17} /> },
];

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  const tab = useUi((s) => s.settingsTab);
  const close = useUi((s) => s.closeSettings);
  const openSettings = useUi((s) => s.openSettings);
  const shifted = useUi((s) => s.sideEditorOpen);
  if (!open) return null;
  return (
    <Modal title="设置" onClose={close} width={1120} className={shifted ? "shifted" : ""}>
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
          {tab === "protocols" && <ProtocolTab />}
          {tab === "search" && <SearchTab />}
          {tab === "save" && <SaveTab />}
          {tab === "comfy" && <ComfyTab />}
          {tab === "sound" && <SoundTab />}
          {tab === "hotkeys" && <HotkeysTab />}
          {tab === "appearance" && <AppearanceTab />}
          {tab === "about" && <AboutTab />}
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
  chat: "输入模型名回车添加，如 deepseek-chat",
  image: "输入模型名回车添加，如 gpt-image-1",
  video: "输入模型名回车添加，如 cogvideox-3",
};

/** 编辑草稿：三个角色槽位全部实体化，models 为空表示该用途未启用 */
type ProviderDraft = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  slots: Record<ModelRole, RoleSlot>;
};

function toDraft(p?: ProviderCard): ProviderDraft {
  const slot = (role: ModelRole): RoleSlot => {
    const s = p?.models[role];
    return s
      ? { protocol: s.protocol, models: [...s.models] }
      : { protocol: PROTOCOLS[role][0].value as AnyProtocol, models: [] };
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
    if (s.models.length) models[role] = { protocol: s.protocol, models: [...s.models] };
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
  const setSideEditorOpen = useUi((s) => s.setSideEditorOpen);

  // 浮出面板打开时，让主设置窗口左移让位（两者整体居中）
  useEffect(() => {
    setSideEditorOpen(!!editing);
    return () => setSideEditorOpen(false);
  }, [!!editing, setSideEditorOpen]);

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

  const saveEditing = (d: ProviderDraft) => {
    const p = fromDraft(d);
    if (!Object.keys(p.models).length) {
      toast("请至少为一种用途添加一个模型（输入后回车，或「拉取模型」从列表选择）", "err");
      return;
    }
    upsertProvider(p);
    setEditing(null);
    toast(`已保存「${p.name}」`, "ok");
  };

  const isExisting = !!editing && models.providers.some((p) => p.id === editing.id);
  const savedEditing = isExisting ? models.providers.find((p) => p.id === editing!.id) : undefined;

  return (
    <>
      <h3>模型配置</h3>
      <p className="sec-desc">
        一格 = 一个服务商（中转站/官方）：Base URL 与 API Key 只填一次，对话、绘画、视频每种用途都可以添加多个模型，
        点击方格会在设置窗口右侧弹出编辑面板。配置存在系统用户数据目录并自动备份，也可手动导出保管。
      </p>
      <Row style={{ marginBottom: 12 }}>
        <span style={{ flex: 1 }} />
        <button className="btn sm" title="把全部设置导出为 JSON 文件保管" onClick={() => void exportCfg()}>
          <IcDownload size={15} /> 导出配置
        </button>
        <button className="btn sm" title="从导出的 JSON 文件恢复全部设置" onClick={() => void importCfg()}>
          <IcUpload size={15} /> 导入配置
        </button>
      </Row>

      <div className="prov-grid">
        <button className="pcard add" onClick={() => setEditing(toDraft())}>
          <IcPlus size={22} />
          <span>添加服务商</span>
        </button>
        {models.providers.map((p) => (
          <button key={p.id} className={`pcard ${editing?.id === p.id ? "on" : ""}`} onClick={() => setEditing(toDraft(p))}>
            <b>{p.name}</b>
            <span className="pc-host">{p.baseUrl.replace(/^https?:\/\//, "") || "未填地址"}</span>
            <span className="pc-roles">
              {ROLES.map((role) => {
                const slot = p.models[role];
                const isDef = splitModelKey(models.defaults[role]).pid === p.id;
                return (
                  <span
                    key={role}
                    className={`pc-dot ${slot?.models.length ? "on" : ""}`}
                    title={`${ROLE_LABEL[role]}${slot?.models.length ? `：${slot.models.join("、")}` : "：未配置"}${isDef ? "（默认）" : ""}`}
                  >
                    {ROLE_ICON[role]}
                    {isDef ? <i className="pc-def" /> : null}
                  </span>
                );
              })}
            </span>
          </button>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 6 }}>
        卡片上的三个图标：对话 / 绘画 / 视频。图标点亮 = 该服务商配置了这类模型；<b>绿点 = 这类模型的当前默认来源</b>（在下方各角色的单选里切换）。
      </div>

      {editing
        ? createPortal(
            <div className="prov-float" role="dialog" aria-label="服务商配置">
              <div className="pf-head">
                <b>{isExisting ? savedEditing?.name || "编辑服务商" : "添加服务商"}</b>
                <button className="icon-btn" onClick={() => setEditing(null)} aria-label="关闭">
                  <IcClose size={16} />
                </button>
              </div>
              <div className="pf-body">
                {isExisting && savedEditing ? (
                  <div className="pd-actions">
                    {ROLES.filter((r) => savedEditing.models[r]?.models.length).map((role) => {
                      const slot = savedEditing.models[role]!;
                      const def = splitModelKey(models.defaults[role]);
                      const isDefault = def.pid === savedEditing.id;
                      return (
                        <span key={role} className="pd-def-group">
                          <button
                            className={`btn sm ${isDefault ? "primary" : ""}`}
                            title={isDefault ? `当前是${ROLE_LABEL[role]}默认` : `设为${ROLE_LABEL[role]}默认`}
                            onClick={() => setDefault(role, modelKey(savedEditing.id, slot.models[0]))}
                          >
                            {isDefault ? <IcCheck size={14} /> : null} {ROLE_LABEL[role]}默认
                          </button>
                          {isDefault && slot.models.length > 1 ? (
                            <select
                              className="select"
                              style={{ width: 128, flex: "none" }}
                              title={`选择哪个模型作为${ROLE_LABEL[role]}默认`}
                              value={def.model ?? slot.models[0]}
                              onChange={(e) => setDefault(role, modelKey(savedEditing.id, e.target.value))}
                            >
                              {slot.models.map((m) => (
                                <option key={m} value={m}>
                                  {m}
                                </option>
                              ))}
                            </select>
                          ) : null}
                        </span>
                      );
                    })}
                    <span style={{ flex: 1 }} />
                    {savedEditing.models.chat ? (
                      <button className="btn sm" disabled={testing === savedEditing.id} onClick={() => void testChat(savedEditing)}>
                        {testing === savedEditing.id ? <IcLoading size={14} /> : null} 测试
                      </button>
                    ) : null}
                    <button
                      className="icon-btn danger"
                      title={confirmDel === savedEditing.id ? "再点一次确认删除" : "删除该服务商"}
                      style={confirmDel === savedEditing.id ? { color: "var(--danger)", background: "rgba(242,79,106,.12)" } : undefined}
                      onClick={() => {
                        if (confirmDel === savedEditing.id) {
                          removeProvider(savedEditing.id);
                          setConfirmDel(null);
                          setEditing(null);
                        } else setConfirmDel(savedEditing.id);
                      }}
                    >
                      <IcTrash size={16} />
                    </button>
                  </div>
                ) : null}
                <ProviderEditor draft={editing} setDraft={setEditing} onSave={saveEditing} onCancel={() => setEditing(null)} />
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

const EMPTY_BY_ROLE: Record<ModelRole, string> = { chat: "", image: "", video: "" };

function ProviderEditor({
  draft,
  setDraft,
  onSave,
  onCancel,
}: {
  draft: ProviderDraft;
  setDraft: (d: ProviderDraft) => void;
  onSave: (d: ProviderDraft) => void;
  onCancel: () => void;
}) {
  // 拉取到的模型列表按协议缓存（同一中转站三个槽位通常协议相同，可复用）
  const [lists, setLists] = useState<Record<string, string[]>>({});
  const [pulling, setPulling] = useState<ModelRole | null>(null);
  // 手动输入框 / 拉取列表筛选词（每个用途各一份）
  const [inputs, setInputs] = useState({ ...EMPTY_BY_ROLE });
  const [queries, setQueries] = useState({ ...EMPTY_BY_ROLE });

  const patchSlot = (role: ModelRole, part: Partial<RoleSlot>) =>
    setDraft({ ...draft, slots: { ...draft.slots, [role]: { ...draft.slots[role], ...part } } });

  const addModel = (role: ModelRole, name: string) => {
    const m = name.trim();
    if (!m) return;
    const cur = draft.slots[role].models;
    if (!cur.includes(m)) patchSlot(role, { models: [...cur, m] });
    setInputs((s) => ({ ...s, [role]: "" }));
  };

  const removeModel = (role: ModelRole, m: string) =>
    patchSlot(role, { models: draft.slots[role].models.filter((x) => x !== m) });

  const customProtocols = useSettings((s) => s.settings.customProtocols);

  const pull = async (role: ModelRole) => {
    const proto = draft.slots[role].protocol;
    setPulling(role);
    try {
      // 自定义协议也按 OpenAI 兼容方式尝试（多数中转站同时开放 /models）
      const ids = await fetchModelList(proto, draft.baseUrl, draft.apiKey);
      setLists((s) => ({ ...s, [proto]: ids }));
      toast(`拉取到 ${ids.length} 个模型，可搜索筛选后点选添加`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setPulling(null);
    }
  };

  /** 输入框里没回车确认的文字，保存时一并收进槽位，避免误丢 */
  const finalize = (): ProviderDraft => {
    let d = draft;
    for (const role of ROLES) {
      const m = inputs[role].trim();
      if (m && !d.slots[role].models.includes(m))
        d = { ...d, slots: { ...d.slots, [role]: { ...d.slots[role], models: [...d.slots[role].models, m] } } };
    }
    return d;
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
        const kw = queries[role].trim().toLowerCase();
        const filtered = kw ? list.filter((m) => m.toLowerCase().includes(kw)) : list;
        return (
          <div key={role} className="pe-slot">
            <div className="pe-slot-head">
              <span className="pc-role-ic">{ROLE_ICON[role]}</span>
              {ROLE_LABEL[role]}
              <span className="pe-slot-hint">可添加多个 · 不添加 = 该服务商不提供此用途</span>
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
                {role !== "chat"
                  ? customProtocols
                      .filter((p) => (p.role === "video" ? "video" : "image") === role)
                      .map((p) => (
                        <option key={p.id} value={`custom:${p.id}`}>
                          自定义 · {p.name}
                          {p.verifiedAt ? " ✓已校准" : "（未校准）"}
                        </option>
                      ))
                  : null}
              </select>
              <input
                className="input"
                style={{ flex: 1.5 }}
                placeholder={MODEL_PLACEHOLDER[role]}
                value={inputs[role]}
                onChange={(e) => setInputs((s) => ({ ...s, [role]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addModel(role, inputs[role]);
                  }
                }}
              />
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
            {(() => {
              // 选了从未真实测试过的自定义协议 → 提醒先去协议页测通（协议不通，模型配了也连不上）
              const cp = customProtocols.find((x) => `custom:${x.id}` === slot.protocol);
              return cp && !cp.verifiedAt ? (
                <div className="pe-slot-hint" style={{ marginTop: 4 }}>
                  ⚠ 协议「{cp.name}」还没跑过真实测试——建议先到「设置 → 协议」用「真实测试并校准」把协议测通，再来配模型，避免生成时才发现连不上。
                </div>
              ) : null;
            })()}
            {slot.models.length ? (
              <div className="pe-chips">
                {slot.models.map((m) => (
                  <span key={m} className="pe-chip" title={m}>
                    {m}
                    <button onClick={() => removeModel(role, m)} aria-label={`移除 ${m}`}>
                      <IcClose size={11} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            {list.length ? (
              <>
                <div className="pe-search">
                  <IcSearch size={14} />
                  <input
                    placeholder="输入关键词筛选拉取到的模型…"
                    value={queries[role]}
                    onChange={(e) => setQueries((s) => ({ ...s, [role]: e.target.value }))}
                  />
                </div>
                <select
                  className="select pe-pick"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) addModel(role, e.target.value);
                  }}
                >
                  <option value="">
                    {kw
                      ? `筛出 ${filtered.length} / ${list.length} 个模型，点选即添加…`
                      : `从拉取到的 ${list.length} 个模型中点选即添加…`}
                  </option>
                  {filtered.map((m) => (
                    <option key={m} value={m} disabled={slot.models.includes(m)}>
                      {slot.models.includes(m) ? `✓ ${m}` : m}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
          </div>
        );
      })}

      <Row style={{ justifyContent: "flex-end", margin: "12px 0 10px" }}>
        <button className="btn sm" onClick={onCancel}>
          取消
        </button>
        <button className="btn sm primary" onClick={() => onSave(finalize())}>
          保存服务商
        </button>
      </Row>
    </div>
  );
}

/* ================= 协议（自定义协议 + 协议助手） ================= */

const PROTOCOL_SYSTEM = `你是 API 协议分析专家。用户会粘贴一个 AI 生成类中转站/服务商的接口文档、示例请求或抓包内容（可能是图片生成，也可能是视频生成）。请分析后输出一份 momo 画布的自定义协议 JSON（只输出 JSON，不要任何解释、不要代码块标记）。

JSON 结构（TypeScript 描述）：
{
  "name": string,            // 协议显示名，如 "某某站异步生图"
  "role": "image" | "video", // 【务必仔细判断】该接口生成的是图片还是视频：看接口路径（如 /video/、/videos）、参数（时长/帧率）、返回字段（video_url、mp4 等）。视频接口必须填 "video"
  "submit": {                // 提交生成请求
    "url": string,           // 完整 URL，可用占位符 {{baseUrl}}
    "method": "POST"|"GET",
    "headers": Record<string,string>,  // 通常 {"Content-Type":"application/json","Authorization":"Bearer {{apiKey}}"}
    "body": string           // JSON 请求体的字符串模板
  },
  "taskIdPath": string,      // 【异步接口才填】提交响应中任务 id 的 JSON 路径，如 "task_id" 或 "data.id"；同步接口省略此字段
  "poll": {                  // 【异步接口才填】轮询查询
    "url": string,           // 查询 URL，可用 {{taskId}}
    "method": "GET"|"POST",
    "headers": Record<string,string>,
    "intervalMs": number,    // 轮询间隔毫秒，默认 3000
    "statusPath": string,    // 状态字段 JSON 路径
    "doneValue": string,     // 表示完成的状态值
    "failValue": string      // 表示失败的状态值
  },
  "resultPath": string       // 最终响应中图片/视频(url或base64)的 JSON 路径；数组用 []，如 "data[].url"
}

可用占位符：{{baseUrl}} {{apiKey}} {{model}} {{prompt}} {{size}} {{n}} {{taskId}} {{image}}（第一张参考图/首帧的 dataURL）{{image2}}（第二张参考图）{{images}}（全部参考图的 JSON 数组字面量，模板里不要加引号，如 "image": {{images}}）{{mask}}（局部重绘/扩图的蒙版 PNG dataURL）。
【重要】若文档显示接口支持图生图（image/images 等字段），请务必把图片字段写进 body 模板，否则参考图发不出去；支持蒙版编辑（mask/inpaint）也请写上 {{mask}} 字段。
条件块语法（可选字段/端点切换用）：{{?var}}…{{/var}} 变量非空时保留；{{^var}}…{{/var}} 变量为空时保留。例：url 写 "{{baseUrl}}/v1/images/{{?images}}edits{{/images}}{{^images}}generations{{/images}}"；body 里写 {{?mask}},"mask":{"image_url":"{{mask}}"}{{/mask}}。
JSON 路径语法：点号访问对象字段，字段名后加 [] 表示展开数组，如 "data.images[].url"。
如文档信息不足，按 OpenAI 风格合理推断并在 name 里标注「(待验证)」。`;

/** 粗糙但够用的 HTML → 纯文本（协议助手抓取文档链接用） */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function ProtocolTab() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const upsertProvider = useSettings((s) => s.upsertProvider);
  const [busy, setBusy] = useState(false);
  /* 草稿与校准现场都在 protoTabStore：切到其他页面/关掉弹窗不丢，正在跑的测试可停止 */
  const { docs, draft, roleSel, testProvider, testModel, manualBase, manualKey, calLog, calBusy, ctrl, calDone, patch, logLine } =
    useProtoTab();
  const providers = settings.models.providers;
  const selProvider = testProvider || providers[0]?.id || MANUAL;
  const manual = selProvider === MANUAL;

  /** 选服务商时顺手预填其对应槽位的第一个模型 */
  const pickProvider = (pid: string) => {
    patch({ testProvider: pid });
    if (pid === MANUAL) return;
    const p = providers.find((x) => x.id === pid);
    const m = p?.models[roleSel === "video" ? "video" : "image"]?.models[0];
    if (m) patch({ testModel: m });
  };

  const runCalibrate = async () => {
    let proto: CustomProtocol;
    try {
      proto = JSON.parse(draft) as CustomProtocol;
      if (!proto.submit?.url || !proto.resultPath) throw new Error("协议缺少 submit.url / resultPath");
    } catch (e) {
      toast(`右侧协议 JSON 不完整：${errMsg(e)}`, "err");
      return;
    }
    proto.role = roleSel;
    const prov = manual ? undefined : providers.find((x) => x.id === selProvider);
    const baseUrl = (manual ? manualBase : prov?.baseUrl ?? "").trim();
    const apiKey = (manual ? manualKey : prov?.apiKey ?? "").trim();
    if (!baseUrl) {
      toast(manual ? "请填写用于测试的 Base URL" : "请选择服务商，或选「手动输入」直接填 Base URL / Key", "err");
      return;
    }
    if (!testModel.trim()) {
      toast("请填写用于测试的模型名", "err");
      return;
    }
    const ctrl = new AbortController();
    patch({
      calBusy: true,
      ctrl,
      calDone: null,
      calLog: [`使用${prov ? `服务商「${prov.name}」` : "手动填写的地址"}（${baseUrl}）· 模型 ${testModel.trim()} 进行真实测试…`],
    });
    try {
      const { proto: fixed, results } = await calibrateProtocol(
        proto,
        { baseUrl, apiKey, model: testModel.trim() },
        logLine,
        ctrl.signal,
      );
      if (!fixed.id) fixed.id = proto.id ?? uid(6);
      fixed.verifiedAt = Date.now(); // 真实测试通过 → 盖「已校准」章
      patch({
        draft: JSON.stringify(fixed, null, 2),
        calDone: { model: testModel.trim(), providerId: prov?.id, baseUrl, apiKey, role: roleSel },
      });
      logLine(`✅ 校准完成（取到 ${results.length} 个结果），协议已盖「已校准」章 —— 点下方按钮一键保存并应用到模型配置`);
      toast("测试通过，协议已按真实响应校准 ✓", "ok");
    } catch (e) {
      logLine(`❌ ${errMsg(e)}`);
      toast(`测试失败：${errMsg(e)}`, "err");
    } finally {
      patch({ calBusy: false, ctrl: null });
    }
  };

  /** 校准通过后的一键衔接：保存协议 → 服务商槽位切到该协议 → 测试模型加进槽位（没有服务商则新建一个） */
  const saveAndApply = () => {
    const done = calDone;
    if (!done) return;
    try {
      const p = JSON.parse(draft) as CustomProtocol;
      if (!p.name || !p.submit?.url || !p.resultPath) throw new Error("协议缺少必填字段：name / submit.url / resultPath");
      if (!p.id) p.id = uid(6);
      p.role = done.role;
      update("customProtocols", [...settings.customProtocols.filter((x) => x.id !== p.id), p]);
      const role = done.role === "video" ? "video" : "image";
      const roleLabel = role === "video" ? "视频" : "绘画";
      if (done.providerId) {
        const prov = settings.models.providers.find((x) => x.id === done.providerId);
        if (!prov) throw new Error("测试时所用的服务商已被删除，请到「模型配置」手动选择该协议");
        const models = [...new Set([done.model, ...(prov.models[role]?.models ?? [])])];
        upsertProvider({ ...prov, models: { ...prov.models, [role]: { protocol: `custom:${p.id}`, models } } });
        toast(`协议「${p.name}」已保存，并应用到「${prov.name}」的${roleLabel}槽位（模型 ${done.model}）✓ 可直接使用`, "ok");
      } else {
        const host = done.baseUrl.replace(/^https?:\/\//i, "").split("/")[0] || "新服务商";
        upsertProvider({
          id: uid(8),
          name: host,
          baseUrl: done.baseUrl,
          apiKey: done.apiKey,
          models: { [role]: { protocol: `custom:${p.id}`, models: [done.model] } },
        });
        toast(`协议「${p.name}」已保存，并新建服务商「${host}」、配好${roleLabel}槽位（模型 ${done.model}）✓ 可直接使用`, "ok");
      }
      patch({ calDone: null, draft: "" });
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  const generate = async () => {
    if (!docs.trim()) {
      toast("先把中转站的接口文档 / 文档链接 / 示例请求粘贴到左边输入框", "err");
      return;
    }
    setBusy(true);
    try {
      // 文档里的 http 链接自动抓取正文一并交给模型（最多取前 2 个）
      let material = docs.slice(0, 24000);
      const urls = docs.match(/https?:\/\/[^\s"'<>）)】\]]+/g)?.slice(0, 2) ?? [];
      for (const u of urls) {
        try {
          toast(`正在抓取文档：${u.slice(0, 60)}…`, "info");
          const resp = await xfetch(u);
          const text = htmlToText(await resp.text()).slice(0, 20000);
          if (text) material += `\n\n=== 以下内容抓取自 ${u} ===\n${text}`;
        } catch (e) {
          toast(`抓取 ${u.slice(0, 50)} 失败：${errMsg(e)}，将只用已粘贴的文字分析`, "err");
        }
      }
      const card = resolveModelCard("chat");
      const out = await chatOnce(card, PROTOCOL_SYSTEM, material.slice(0, 48000));
      const json = out.match(/\{[\s\S]*\}/)?.[0] ?? out;
      const parsed = JSON.parse(json) as CustomProtocol;
      patch({ roleSel: parsed.role === "video" ? "video" : "image", draft: json });
      toast(
        `协议草稿已生成 ✓ 助手判定用途为「${parsed.role === "video" ? "视频" : "图片"}生成」，请核对右侧 JSON 与用途后保存`,
        "ok",
      );
    } catch (e) {
      toast(`生成失败：${errMsg(e)}`, "err");
    } finally {
      setBusy(false);
    }
  };

  /** 一键补全：让协议助手在不破坏现有字段的前提下，为草稿补上图片/蒙版占位符（参考左侧文档，可抓链接） */
  const completeDraft = async () => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      let material = docs.trim().slice(0, 20000);
      const urls = docs.match(/https?:\/\/[^\s"'<>）)】\]]+/g)?.slice(0, 2) ?? [];
      for (const u of urls) {
        try {
          toast(`正在抓取文档：${u.slice(0, 60)}…`, "info");
          const resp = await xfetch(u);
          const text = htmlToText(await resp.text()).slice(0, 16000);
          if (text) material += `\n\n=== 以下内容抓取自 ${u} ===\n${text}`;
        } catch {
          /* 链接抓不到就按经验补全 */
        }
      }
      const card = resolveModelCard("chat");
      const ask = (roleSel === "video"
        ? [
            "下面是一份视频生成协议 JSON。请在【不改动它已有的端点、鉴权、轮询、结果路径】的前提下，补全图生视频与参数能力：",
            "1. body 补首帧图片字段：占位符 {{image}}（dataURL 或 URL），字段名以参考文档为准（常见：image / image_url / image_urls / first_frame_image）",
            "2. 若文档显示支持首尾帧过渡，补尾帧字段用 {{image2}}（常见：image_tail / last_frame_image / lastFrame）",
            "3. 补生成参数占位符：{{duration}}（秒数）/ {{resolution}}（如 720p）/ {{aspect}}（如 16:9）/ {{audio}}（true/false），字段名按文档",
            "4. 所有可选字段用 {{?var}}…{{/var}} 条件块包裹，保证不传图/不传参时请求体依然是合法 JSON",
            "只输出补全后的完整协议 JSON（保留原 id、name、role；若是无文档的推断，在 name 末尾加「(待验证)」）。",
          ]
        : [
            "下面是一份已能跑通文生图的协议 JSON。请在【不改动它已有的端点、鉴权、轮询、结果路径】的前提下，补全图生图与蒙版能力：",
            "1. body 补图片字段：占位符用 {{images}}（数组，不加引号）或 {{image}}（单图 dataURL），字段名以参考文档为准；没有文档就按常见网关风格（如 image_urls）补",
            "2. 若文档显示支持蒙版/inpaint，补 {{mask}} 字段；文生图与图生图端点不同时，用条件块切换 url",
            "3. 所有可选字段用 {{?var}}…{{/var}} 条件块包裹，保证不传图时请求体依然是合法 JSON",
            "只输出补全后的完整协议 JSON（保留原 id、name、role；若是无文档的推断，在 name 末尾加「(待验证)」）。",
          ]
      ).concat([
        `\n当前协议：\n${draft}`,
        material ? `\n参考文档：\n${material}` : "\n（没有粘贴文档：按站点风格合理推断）",
      ]).join("\n");
      const out = await chatOnce(card, PROTOCOL_SYSTEM, ask.slice(0, 48000));
      const json = out.match(/\{[\s\S]*\}/)?.[0] ?? out;
      JSON.parse(json); // 先校验再落草稿
      patch({ draft: json });
      toast(
        roleSel === "video"
          ? "已补全图生视频/尾帧/参数字段 ✓ 核对右侧 JSON → 保存 → 校准"
          : "已补全图片/蒙版字段 ✓ 核对右侧 JSON → 保存 → 到下方「真实测试并校准」跑一遍",
        "ok",
      );
    } catch (e) {
      toast(`补全失败：${errMsg(e)}`, "err");
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    try {
      const p = JSON.parse(draft) as CustomProtocol;
      if (!p.name || !p.submit?.url || !p.resultPath)
        throw new Error("协议缺少必填字段：name / submit.url / resultPath");
      if (!p.id) p.id = uid(6);
      // 用途以界面选择为准（可纠正助手判断）
      p.role = roleSel;
      update("customProtocols", [...settings.customProtocols.filter((x) => x.id !== p.id), p]);
      toast(
        `协议「${p.name}」已保存（${p.role === "video" ? "视频" : "图片"}生成）——到「模型配置」里给服务商的${p.role === "video" ? "视频" : "绘画"}槽位选择「自定义 · ${p.name}」即可使用`,
        "ok",
      );
      patch({ draft: "" });
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  return (
    <>
      <h3>协议</h3>
      <p className="sec-desc">
        遇到不是 OpenAI 兼容的中转站（比如异步任务式生图/生视频）？把它的接口文档或文档链接粘贴给「协议助手」，由你配置的对话模型分析生成协议；
        核对用途（图片/视频）并保存后，就能在「模型配置」对应槽位的协议下拉里选用。协议也可以手写/修改 JSON。
      </p>
      <Row gap={10} style={{ alignItems: "flex-start", marginBottom: 14 }}>
        <Switch on={settings.protoSelfHeal} onChange={(v) => update("protoSelfHeal", v)} />
        <div>
          <b>协议自愈</b>
          <div className="sec-desc" style={{ margin: "2px 0 0" }}>
            自定义协议运行失败时，自动把报错与执行现场（真实请求/响应，密钥已脱敏）交给对话模型修协议并重试一次；
            重试成功才写回保存，失败自动回滚不留坏协议。网络/鉴权/额度类错误不触发（修协议没用）。重试会产生一次生成费用。
          </div>
        </div>
      </Row>

      <div className="gp-lab" style={{ marginBottom: 8 }}>常用中转站预设（一键导入 / 修复）</div>
      <div className="preset-list">
        {PROTO_PRESETS.map((pp) => (
          <div key={pp.key} className="preset-row">
            <div className="pr-info">
              <b>{pp.label}</b>
              <span>{pp.note}</span>
            </div>
            <button
              className="btn sm primary"
              title="若匹配的服务商已绑定自定义协议：原地覆盖修复（绑定不变）；否则新建协议并自动绑定"
              onClick={() => toast(applyProtoPreset(pp), "ok")}
            >
              导入 / 修复
            </button>
          </div>
        ))}
      </div>
      <p className="sec-desc" style={{ marginTop: 6, marginBottom: 16 }}>
        预设按官方文档校对过图片/蒙版字段格式。导入后建议先跑一次下方的「测试并自动校准」再上画布。
      </p>

      {settings.customProtocols.length ? (
        <>
          <div className="gp-lab" style={{ marginBottom: 8 }}>已保存的协议</div>
          <Row gap={8} style={{ flexWrap: "wrap", marginBottom: 16 }}>
            {settings.customProtocols.map((p) => (
              <span
                key={p.id}
                className="pe-chip"
                title={`${p.role === "video" ? "视频生成" : "图片生成"} · ${p.taskIdPath ? "异步轮询" : "同步"} · ${
                  p.verifiedAt ? `已于 ${new Date(p.verifiedAt).toLocaleString()} 真实测试通过` : "还没跑过真实测试（建议先到下方「测试并自动校准」验证）"
                } · 点 × 删除`}
              >
                {p.role === "video" ? "视频 · " : "图片 · "}
                {p.name}
                {p.verifiedAt ? " ✓" : ""}
                <button
                  onClick={() => patch({ draft: JSON.stringify(p, null, 2), roleSel: p.role === "video" ? "video" : "image" })}
                  title="编辑"
                  aria-label="编辑"
                >
                  <IcEditSmall />
                </button>
                <button
                  onClick={() => update("customProtocols", settings.customProtocols.filter((x) => x.id !== p.id))}
                  aria-label="删除"
                >
                  <IcClose size={11} />
                </button>
              </span>
            ))}
          </Row>
        </>
      ) : null}

      <Row gap={12} style={{ alignItems: "stretch" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="gp-lab">① 粘贴接口文档 / 文档链接 / 示例请求</div>
          <textarea
            className="textarea"
            style={{ flex: 1, minHeight: 260 }}
            placeholder={
              "把中转站的 API 文档、curl 示例、请求/响应 JSON 粘贴到这里…\n也可以直接粘贴 API 文档的网址链接，会自动抓取页面内容分析。\n信息越全，生成的协议越准。"
            }
            value={docs}
            onChange={(e) => patch({ docs: e.target.value })}
          />
          <button className="btn primary" disabled={busy} onClick={() => void generate()}>
            {busy ? <IcLoading size={16} /> : <IcSparkles size={16} />} 让协议助手分析生成
          </button>
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="gp-lab">② 核对 / 手动编辑协议 JSON</div>
          <textarea
            className="textarea"
            style={{ flex: 1, minHeight: 260, fontFamily: "Consolas, monospace", fontSize: 12.5 }}
            placeholder={
              '协议 JSON 会出现在这里，也可以直接手写。\n占位符：{{baseUrl}} {{apiKey}} {{model}} {{prompt}} {{size}} {{n}} {{taskId}}\n图片类：{{image}} 首图 · {{image2}} 第二图/尾帧 · {{images}} 参考图JSON数组（不加引号）· {{mask}} 蒙版\n视频类：{{duration}} 时长秒 · {{resolution}} 分辨率档 · {{aspect}} 宽高比 · {{audio}} true/false\n提示：要支持图生图/局部重绘，body 里必须写上图片/蒙版字段，否则图片不会发给模型'
            }
            value={draft}
            onChange={(e) => patch({ draft: e.target.value })}
          />
          {/* 能力体检：保存前就把「只能文生图/没有真蒙版」讲清楚，并给出一键修复入口 */}
          {roleSel === "image" && draft.trim() ? (
            !["{{image}}", "{{images}}", "{{image2}}"].some((k) => draft.includes(k)) ? (
              <div className="hint" style={{ color: "var(--warn, #d97706)" }}>
                ⚠ 模板没有图片占位符（{"{{image}} / {{images}}"}）：该协议只能<b>文生图</b>，接了参考图会直接报错。
                <button className="btn sm" style={{ marginLeft: 8 }} disabled={busy} onClick={() => void completeDraft()}>
                  {busy ? <IcLoading size={13} /> : <IcSparkles size={13} />} 让协议助手补全图生图/蒙版
                </button>
              </div>
            ) : !draft.includes("{{mask}}") ? (
              <div className="hint">
                ℹ 模板不含 {"{{mask}}"}：可以图生图，但「真蒙版」重绘不可用（节点上切「指令式」也能重绘）。
                <button className="btn sm" style={{ marginLeft: 8 }} disabled={busy} onClick={() => void completeDraft()}>
                  {busy ? <IcLoading size={13} /> : <IcSparkles size={13} />} 让协议助手补全蒙版
                </button>
              </div>
            ) : (
              <div className="hint">✓ 模板含图片与蒙版占位符：文生图 / 图生图 / 真蒙版重绘均可用。</div>
            )
          ) : null}
          {roleSel === "video" && draft.trim() ? (
            !draft.includes("{{image}}") ? (
              <div className="hint" style={{ color: "var(--warn, #d97706)" }}>
                ⚠ 模板没有首帧占位符（{"{{image}}"}）：该协议只能<b>文生视频</b>，接上游图片不会生效。
                <button className="btn sm" style={{ marginLeft: 8 }} disabled={busy} onClick={() => void completeDraft()}>
                  {busy ? <IcLoading size={13} /> : <IcSparkles size={13} />} 让协议助手补全图生视频/尾帧/参数
                </button>
              </div>
            ) : !draft.includes("{{image2}}") ? (
              <div className="hint">
                ℹ 模板不含尾帧 {"{{image2}}"}：首尾帧过渡不可用（接 2 路图时第 2 路会被忽略）。
                <button className="btn sm" style={{ marginLeft: 8 }} disabled={busy} onClick={() => void completeDraft()}>
                  {busy ? <IcLoading size={13} /> : <IcSparkles size={13} />} 让协议助手补全尾帧/参数
                </button>
              </div>
            ) : !["{{duration}}", "{{resolution}}", "{{aspect}}"].some((k) => draft.includes(k)) ? (
              <div className="hint">
                ℹ 模板不含 {"{{duration}} / {{resolution}} / {{aspect}}"}：面板上的时长/分辨率/比例设置不会生效。
                <button className="btn sm" style={{ marginLeft: 8 }} disabled={busy} onClick={() => void completeDraft()}>
                  {busy ? <IcLoading size={13} /> : <IcSparkles size={13} />} 让协议助手补全参数
                </button>
              </div>
            ) : (
              <div className="hint">✓ 模板含首帧/尾帧/参数占位符：文生视频 / 图生视频 / 首尾帧 / 面板参数均可用。</div>
            )
          ) : null}
          <Row gap={8} style={{ alignItems: "center" }}>
            <span className="gp-lab" style={{ margin: 0 }} title="决定该协议出现在哪个模型槽位、结果按图片还是视频处理">
              协议用途
            </span>
            <button className={`btn sm ${roleSel === "image" ? "primary" : ""}`} onClick={() => patch({ roleSel: "image" })}>
              <IcGallery size={14} /> 图片生成
            </button>
            <button className={`btn sm ${roleSel === "video" ? "primary" : ""}`} onClick={() => patch({ roleSel: "video" })}>
              <IcVideo size={14} /> 视频生成
            </button>
            <span style={{ flex: 1 }} />
            <button className="btn primary" disabled={!draft.trim()} onClick={save}>
              <IcCheck size={16} /> 校验并保存协议
            </button>
          </Row>
        </div>
      </Row>

      <div className="gp-lab" style={{ margin: "18px 0 6px" }}>③ 测试并自动校准（先把协议测通，再去配模型）</div>
      <p className="sec-desc" style={{ marginBottom: 8 }}>
        <b>真实调用一次</b>该协议（生成类接口会产生一次费用），程序在真实响应里定位任务
        ID、状态、结果字段的实际位置，自动把协议里写错的路径改成实测值——从「猜」变成「量」。
        可以借已有服务商的 Key，也可以选「手动输入」直接填 Base URL / Key（还没建服务商也能先测协议）。
        测试在后台运行：切到其他页面不会中断，日志保留在这里，也可以随时停止。
      </p>
      <Row gap={8} style={{ alignItems: "center", flexWrap: "wrap" }}>
        <select className="select" style={{ width: 200 }} value={selProvider} onChange={(e) => pickProvider(e.target.value)}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value={MANUAL}>手动输入 Base URL / Key…</option>
        </select>
        {manual ? (
          <>
            <input
              className="input"
              style={{ width: 230 }}
              placeholder="Base URL（如 https://api.xx.com/v1）"
              value={manualBase}
              onChange={(e) => patch({ manualBase: e.target.value })}
            />
            <input
              className="input"
              style={{ width: 190 }}
              type="password"
              placeholder="API Key"
              value={manualKey}
              onChange={(e) => patch({ manualKey: e.target.value })}
            />
          </>
        ) : null}
        <input
          className="input"
          style={{ width: 200 }}
          placeholder="测试用模型名（如 gpt-image-2）"
          value={testModel}
          onChange={(e) => patch({ testModel: e.target.value })}
        />
        <button
          className="btn primary"
          disabled={calBusy || !draft.trim()}
          title="真实发起一次生成请求（有费用），并按真实响应校准协议 JSON"
          onClick={() => void runCalibrate()}
        >
          {calBusy ? <IcLoading size={15} /> : <IcCheck size={15} />} {calBusy ? "测试中…" : "真实测试并校准"}
        </button>
        {calBusy ? (
          <button className="btn" onClick={() => ctrl?.abort()} title="停止等待/轮询（已发出的提交请求所产生的费用无法撤回）">
            停止测试
          </button>
        ) : null}
      </Row>
      {calLog.length ? (
        <div className="cal-log">
          {calLog.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      ) : null}
      {calDone && !calBusy ? (
        <Row gap={10} style={{ marginTop: 8, alignItems: "center" }}>
          <button className="btn primary" onClick={saveAndApply}>
            <IcCheck size={15} />{" "}
            {calDone.providerId
              ? `保存协议并应用到「${providers.find((p) => p.id === calDone.providerId)?.name ?? "服务商"}」`
              : "保存协议并新建服务商"}
          </button>
          <span className="sec-desc" style={{ margin: 0 }}>
            一键衔接：保存已校准协议 → {calDone.providerId ? "该服务商" : "新服务商"}的
            {calDone.role === "video" ? "视频" : "绘画"}槽位切到此协议 → 模型 {calDone.model} 加入槽位，配完即可用
          </span>
        </Row>
      ) : null}
    </>
  );
}

/** 小号编辑图标（協議 chip 内联用） */
function IcEditSmall() {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m13.7 5 3.3 3.3L9.3 16 5 17l1-4.3L13.7 5Z" />
    </svg>
  );
}

/* ================= 音效提醒 ================= */
function SoundTab() {
  const sound = useSettings((s) => s.settings.sound);
  const update = useSettings((s) => s.update);
  const patch = (p: Partial<SoundCfg>) => update("sound", { ...sound, ...p });

  /** 上传自定义提示音（存为 dataURL；1.5MB 以内） */
  const upload = (key: "doneAudio" | "errAudio") => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*";
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      if (f.size > 1.5 * 1024 * 1024) {
        toast("音频太大（限 1.5MB 内）：建议用短促的提示音片段", "err");
        return;
      }
      const r = new FileReader();
      r.onload = () => {
        patch({ [key]: r.result as string });
        toast("自定义提示音已保存，点「试听」确认效果", "ok");
      };
      r.readAsDataURL(f);
    };
    input.click();
  };

  return (
    <>
      <h3>音效提醒</h3>
      <p className="sec-desc">任务完成/报错时的提示音与语音播报。完成音在点击「生成/运行」的目标节点跑完后响起；报错音随报错中心触发。</p>
      <Row gap={12} style={{ alignItems: "center", marginBottom: 14 }}>
        <Switch on={sound.enabled} onChange={(v) => patch({ enabled: v })} />
        <b>启用音效提醒</b>
      </Row>
      <Field label="音量">
        <Row gap={10} style={{ alignItems: "center" }}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={sound.volume}
            style={{ width: 220 }}
            onChange={(e) => patch({ volume: Number(e.target.value) })}
          />
          <span style={{ fontSize: "var(--fs-sm)", color: "var(--text-3)" }}>{Math.round(sound.volume * 100)}%</span>
        </Row>
      </Field>
      <Field label="完成提示音" hint={sound.doneAudio ? "当前：自定义音频" : "当前：内置提示音（上扬双音）"}>
        <Row gap={8}>
          <button className="btn sm" onClick={playDone}>
            <IcPlay size={14} /> 试听
          </button>
          <button className="btn sm" onClick={() => upload("doneAudio")}>
            <IcUpload size={14} /> 上传自定义
          </button>
          {sound.doneAudio ? (
            <button className="btn sm" onClick={() => patch({ doneAudio: undefined })}>
              恢复内置
            </button>
          ) : null}
        </Row>
      </Field>
      <Field label="报错提示音" hint={sound.errAudio ? "当前：自定义音频" : "当前：内置提示音（下沉双音）"}>
        <Row gap={8}>
          <button className="btn sm" onClick={playError}>
            <IcPlay size={14} /> 试听
          </button>
          <button className="btn sm" onClick={() => upload("errAudio")}>
            <IcUpload size={14} /> 上传自定义
          </button>
          {sound.errAudio ? (
            <button className="btn sm" onClick={() => patch({ errAudio: undefined })}>
              恢复内置
            </button>
          ) : null}
        </Row>
      </Field>
      <Row gap={12} style={{ alignItems: "flex-start", marginTop: 16 }}>
        <Switch on={sound.speak} onChange={(v) => patch({ speak: v })} />
        <div>
          <div style={{ fontWeight: 600 }}>语音播报</div>
          <div className="sec-desc" style={{ margin: "2px 0 6px" }}>
            用系统语音念出节点名与结果，例如「生成图像完成」「生成视频出错」（使用 Windows 内置中文语音，无需联网）。
          </div>
          <button
            className="btn sm"
            onClick={() => {
              // 试听不受开关限制，方便先听效果再决定开不开
              const u = new SpeechSynthesisUtterance("生成图像完成");
              u.lang = "zh-CN";
              u.volume = sound.volume;
              speechSynthesis.speak(u);
            }}
          >
            <IcPlay size={14} /> 试听播报
          </button>
        </div>
      </Row>
    </>
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

/** 命名模板可用变量（点击追加） */
const NAME_VARS: { token: string; label: string; sample: string }[] = [
  { token: "{date}", label: "日期", sample: "20260718" },
  { token: "{time}", label: "时间", sample: "153042" },
  { token: "{model}", label: "模型", sample: "gpt-image-2" },
  { token: "{prompt}", label: "提示词", sample: "赛博朋克城市夜景" },
  { token: "{size}", label: "分辨率", sample: "2560x1440" },
  { token: "{ratio}", label: "比例", sample: "16x9" },
  { token: "{n}", label: "序号", sample: "1" },
  { token: "{seed}", label: "随机种子", sample: "12345" },
];

/** 模板实时示例：把变量替换成样例值，直观看到最终文件名 */
function PatternPreview({ pattern }: { pattern: string }) {
  let out = pattern;
  for (const v of NAME_VARS) out = out.split(v.token).join(v.sample);
  return (
    <>
      示例：<b style={{ color: "var(--text-2)" }}>{out || "（空模板将使用 momo_日期_时间）"}.png</b>
      　·　序号 = 同前缀文件依次递增
    </>
  );
}

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
      <Row gap={12} style={{ alignItems: "flex-start" }}>
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
          <Field label="命名模板" hint={<PatternPreview pattern={settings.save.pattern} />}>
            <input className="input" value={settings.save.pattern}
              onChange={(e) => patch({ pattern: e.target.value })} />
            <div className="var-chips">
              {NAME_VARS.map((v) => (
                <button
                  key={v.token}
                  className="btn sm"
                  title={`点击把「${v.label}」追加到模板末尾（${v.token}）`}
                  onClick={() => {
                    const cur = settings.save.pattern.trim();
                    patch({ pattern: cur ? `${cur}_${v.token}` : v.token });
                  }}
                >
                  {v.label}
                </button>
              ))}
              <button className="btn sm" title="清空模板重新组合" onClick={() => patch({ pattern: "" })}>
                清空
              </button>
            </div>
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
  const templates = useComfy((s) => s.templates);
  const removeTpl = useComfy((s) => s.remove);
  const setTemplateMgr = useUi((s) => s.setTemplateMgr);
  const [testing, setTesting] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const tplFileRef = useRef<HTMLInputElement>(null);

  const exportAllTpl = async () => {
    if (!templates.length) return toast("还没有模板可导出", "err");
    if (await saveTextFile("momo-comfy-templates.json", packTemplates(templates)))
      toast(`已导出全部 ${templates.length} 个模板 ✓`, "ok");
  };

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
              const r = await test(settings.comfy.host);
              setTesting(false);
              toast(
                r.ok ? "ComfyUI 已连接 ✓" : `无法连接 ComfyUI${r.err ? `：${r.err}` : "，请确认已启动"}`,
                r.ok ? "ok" : "err",
              );
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

      <div className="gp-lab" style={{ margin: "4px 0 8px" }}>工作流模板（{templates.length}）</div>
      {templates.length ? (
        templates.map((t) => (
          <div key={t.id} className="tpl-row">
            <span className="kind-ic" style={{ width: 34, height: 34, borderRadius: 9, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--grad-brand-soft)", color: "var(--accent)" }}>
              <IcFlow size={17} />
            </span>
            <div className="tn">
              <b>{t.name}</b>
              <span>
                {Object.keys(t.workflow).length} 个节点 · 暴露 {t.params.length} 个参数
              </span>
            </div>
            <button className="icon-btn" title="编辑模板（参数/输入输出）" onClick={() => setTemplateMgr(true, t.id)}>
              <IcEdit size={17} />
            </button>
            <button
              className="icon-btn"
              title="导出该模板（含参数配置，可再导入）"
              onClick={() =>
                void saveTextFile(`${t.name}.momo-tpl.json`, packTemplates([t])).then(
                  (ok) => ok && toast(`模板「${t.name}」已导出 ✓`, "ok"),
                )
              }
            >
              <IcDownload size={17} />
            </button>
            <button
              className="icon-btn danger"
              title={confirmDel === t.id ? "再点一次确认删除" : "删除模板"}
              style={confirmDel === t.id ? { color: "var(--danger)", background: "rgba(242,79,106,.12)" } : undefined}
              onClick={() => {
                if (confirmDel === t.id) {
                  removeTpl(t.id);
                  setConfirmDel(null);
                } else setConfirmDel(t.id);
              }}
            >
              <IcTrash size={17} />
            </button>
          </div>
        ))
      ) : (
        <p className="sec-desc">还没有模板——打开模板管理器导入，或直接批量导入工作流/模板包 JSON。</p>
      )}
      <Row gap={8} style={{ marginTop: 10, flexWrap: "wrap" }}>
        <button className="btn primary" onClick={() => setTemplateMgr(true)}>
          <IcFlow size={16} /> 打开工作流模板管理器
        </button>
        <button className="btn" title="选择多个 JSON（API 工作流 / 模板 / 模板包）一次性导入" onClick={() => tplFileRef.current?.click()}>
          <IcUpload size={15} /> 批量导入
        </button>
        <button className="btn" title="把全部模板导出为一个模板包 JSON，可在其他设备导入恢复" onClick={() => void exportAllTpl()}>
          <IcDownload size={15} /> 全部导出
        </button>
        <input
          ref={tplFileRef}
          type="file"
          accept=".json,application/json"
          multiple
          hidden
          onChange={(e) => {
            const files = e.target.files;
            if (files?.length)
              void importTemplateFilesAuto(files).then(({ saved, errs }) => {
                if (saved) toast(`批量导入完成：${saved} 个模板 ✓`, "ok");
                if (errs.length) toast(`${errs.length} 个文件失败：${errs[0]}`, "err");
              });
            e.target.value = "";
          }}
        />
      </Row>
      <p className="sec-desc" style={{ marginTop: 12 }}>
        模板管理器支持选文件 / <b>直接拖入</b> / <b>Ctrl+V 粘贴</b> ComfyUI「API 格式」工作流
        JSON，自由勾选要暴露的输入/参数/输出节点保存为模板；画布的 ComfyUI 节点上即可直接编辑这些参数并运行。
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

/** 组合键 → 键帽显示（"ctrl+z" → "Ctrl + Z"） */
function comboLabel(combo: string): string {
  return combo
    .split("+")
    .map((p) => (p === "ctrl" ? "Ctrl" : p === "shift" ? "Shift" : p === "alt" ? "Alt" : keyLabel(p)))
    .join(" + ");
}

const FIXED_KEYS: { label: string; keys: string[] }[] = [
  { label: "临时平移画布", keys: ["Space", "拖动"] },
  { label: "多选 / 框选连线", keys: ["Ctrl", "点击或框选"] },
  { label: "粘贴图片/文字", keys: ["Ctrl", "V"] },
  { label: "Alt 拖拽复制工作流", keys: ["Alt", "拖动节点"] },
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
      const base = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const mods = [(e.ctrlKey || e.metaKey) && "ctrl", e.shiftKey && "shift", e.altKey && "alt"].filter(
        Boolean,
      ) as string[];
      if (capturing === "delete" && mods.length) {
        toast("删除请绑定单键（如 Del / X），暂不支持组合键删除", "err");
        return;
      }
      const combo = [...mods, base].join("+");
      const clash = (Object.entries(hotkeys) as [HotkeyAction, string][]).find(
        ([a, k]) => k.toLowerCase() === combo.toLowerCase() && a !== capturing,
      );
      if (clash) {
        toast(`「${comboLabel(combo)}」已分配给：${HOTKEY_LABEL[clash[0]]}`, "err");
        return;
      }
      update("hotkeys", { ...hotkeys, [capturing]: combo });
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
            {capturing === action ? "按键…" : hotkeys[action] ? comboLabel(hotkeys[action]) : "未绑定"}
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
  const gpuBoost = useSettings((s) => s.settings.gpuBoost);
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
      <h3 style={{ marginTop: 24 }}>性能</h3>
      <Row gap={12} style={{ alignItems: "center" }}>
        <Switch on={gpuBoost} onChange={(v) => update("gpuBoost", v)} />
        <div>
          <div style={{ fontWeight: 600 }}>画布 GPU 加速</div>
          <div className="sec-desc" style={{ margin: 0 }}>
            把节点提升为独立合成层，平移/缩放走 GPU 合成，明显减少大画布的卡顿闪烁。默认开启；若遇到显卡驱动兼容问题（花屏/残影）可关闭，立即生效。
          </div>
        </div>
      </Row>
    </>
  );
}

/* ================= 关于与更新 ================= */

function AboutTab() {
  const [ver, setVer] = useState("…");
  const [mode, setMode] = useState<"installed" | "portable" | "web">("web");
  const [dataDir, setDataDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [found, setFound] = useState<Extract<UpdateInfo, { kind: "installed" | "portable" }> | null>(null);

  useEffect(() => {
    void currentVersion().then(setVer);
    if (isTauri) {
      void isPortable().then((p) => setMode(p ? "portable" : "installed"));
      void import("@tauri-apps/api/path").then((m) => m.appDataDir()).then(setDataDir).catch(() => undefined);
    }
  }, []);

  const doCheck = async () => {
    setBusy(true);
    setStatus("正在检查更新…");
    setFound(null);
    try {
      const info = await checkUpdate();
      if (info.kind === "none") setStatus(`已是最新版本（v${info.current}）`);
      else {
        setFound(info);
        setStatus("");
      }
    } catch (e) {
      setStatus(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const doApply = async () => {
    if (!found) return;
    setBusy(true);
    try {
      await found.apply((m) => setStatus(m));
    } catch (e) {
      setStatus(`更新失败：${errMsg(e)}`);
      setBusy(false);
    }
  };

  return (
    <>
      <h3>关于与更新</h3>
      <div className="about-card">
        <IcLogo size={40} />
        <div>
          <b style={{ fontSize: 16 }}>MOMO 智能画布</b>
          <div className="sec-desc" style={{ margin: 0 }}>
            当前版本 v{ver} ·{" "}
            {mode === "web" ? "浏览器预览" : mode === "portable" ? "便携版（更新时下载 zip 自动替换）" : "安装版（更新时自动下载安装）"}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <button className="btn primary" disabled={busy || !isTauri} onClick={() => void doCheck()}>
          {busy ? <IcLoading size={15} /> : null} 检查更新
        </button>
      </div>
      {status ? <p className="sec-desc" style={{ whiteSpace: "pre-wrap" }}>{status}</p> : null}
      {found ? (
        <div className="about-update">
          <b>发现新版本 v{found.version}</b>
          {found.notes ? <pre className="about-notes">{found.notes}</pre> : null}
          <button className="btn primary" disabled={busy} onClick={() => void doApply()}>
            {busy ? <IcLoading size={15} /> : null}
            {found.kind === "portable" ? "下载并替换（应用将自动重启）" : "下载并安装（应用将自动重启）"}
          </button>
        </div>
      ) : null}
      <h3 style={{ marginTop: 26 }}>数据与隐私</h3>
      <p className="sec-desc">
        所有配置（含 API Key）、画布、资产、模板都只保存在<b>本机</b>的应用数据目录，不打进安装包、不上传任何服务器；
        把安装包/便携包分发给别人，对方拿到的是<b>全新空白配置</b>，不会带上你的密钥。
      </p>
      {dataDir ? (
        <p className="sec-desc" style={{ userSelect: "text" }}>
          数据目录：<code>{dataDir}</code>
        </p>
      ) : null}
      <p className="sec-desc">
        更新源：GitHub 仓库 <code>{GH_REPO}</code> 的 Releases（发布新版本后，这里一键升级）。
      </p>
    </>
  );
}
