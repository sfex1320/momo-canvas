/**
 * 设置面板 · 模型配置页 — 服务商卡片 / 预设卡片 / 服务商编辑器
 */
import { useEffect, useRef, useState } from "react";
import { CodexBridgeCard } from "../CodexBridgeCard";
import { createPortal } from "react-dom";
import { Field, Row } from "../../../ui/kit";
import { PopSelect } from "../../../ui/PopSelect";
import { ModelPicker } from "../../../ui/ModelPicker";
import { flattenCard, modelKey, splitModelKey, useSettings } from "../../../core/stores/settingsStore";
import { toast, useUi } from "../../../core/stores/uiStore";
import { chatOnce } from "../../../core/services/llm";
import { fetchModelList } from "../../../core/services/modelList";
import { errMsg } from "../../../core/utils";
import { modelAssignmentIssue } from "../../../core/modelAssignment";
import { openExternal } from "../../../core/external";
import { OLLAMA_PRESET, PROVIDER_PRESETS, buildPresetProvider, type ProviderPreset } from "../../../core/providerPresets";
import { useLocalGguf } from "../../../core/stores/localGgufStore";
import { GgufManageDialog } from "../GgufImportDialog";
import {
  IcBrain,
  IcCheck,
  IcClose,
  IcDownload,
  IcGear,
  IcGlobe,
  IcLoading,
  IcPlus,
  IcSearch,
  IcSparkles,
  IcTrash,
  IcUpload,
  IcWand,
} from "../../../ui/icons";
import { PROTOCOLS, ROLE_LABEL, type AnyProtocol, type ModelRole, type ProviderCard, type RoleSlot } from "../../../core/types";
import { MODEL_PLACEHOLDER, ROLE_ICON, ROLES, ROLE_SHORT, SecHelp, fromDraft, toDraft, type ProviderDraft } from "../shared";
import { exportCfg, importCfg } from "../cfgIO";

/** 推荐中转站预设卡片：logo / 评分 / 价格 / 官网跳转 / 一键导入（点「选项」生成草稿，弹编辑浮层补 Key） */
function PresetCard({ p, onPick }: { p: ProviderPreset; onPick: (p: ProviderPreset) => void }) {
  const host = p.baseUrl.replace(/^https?:\/\//, "").split("/")[0] || p.baseUrl;
  // 评分配色档：≥9 高（绿）/ 7-8 中（蓝）/ <7 低（灰）；作稳定性 · 可信度参考
  const level = p.rating == null ? "" : p.rating >= 9 ? "high" : p.rating >= 7 ? "mid" : "low";
  return (
    <div className={`preset-card ${level}`} title={`${p.label}\n\n${p.note}\n${p.baseUrl}`}>
      <div className="psc-top">
        {p.logo ? (
          /^https?:|^data:/i.test(p.logo) ? (
            <img className="psc-logo" src={p.logo} alt="" />
          ) : (
            // [...str][0] 按码点取首字符：emoji（如 🦙）是代理对，slice(0,1) 会切成乱码
            <span className="psc-logo txt">{[...p.logo][0]}</span>
          )
        ) : (
          <span className="psc-logo txt">{[...p.label][0]}</span>
        )}
        <b className="psc-name">{p.label}</b>
        {p.rating != null ? (
          <span className="psc-rating" title="稳定性 / 可信度参考（0-10，越高越稳）">
            {p.rating}
          </span>
        ) : null}
      </div>
      <span className="psc-host">{host}</span>
      {p.price ? (
        <span className="psc-price" title="大概费用（以下单页为准）">
          {p.price}
        </span>
      ) : null}
      <div className="psc-acts">
        {p.site ? (
          <button
            className="icon-btn"
            title={`打开官网：${p.site}`}
            onClick={() => void openExternal(p.site!)}
          >
            <IcGlobe size={14} />
          </button>
        ) : null}
        <button
          className="btn sm primary"
          title="导入为服务商卡片（名称 / 地址 / 协议已填好，再补 API Key 与模型即可）"
          onClick={() => onPick(p)}
        >
          选项
        </button>
      </div>
    </div>
  );
}

export function ModelsTab() {
  const models = useSettings((s) => s.settings.models);
  const upsertProvider = useSettings((s) => s.upsertProvider);
  const removeProvider = useSettings((s) => s.removeProvider);
  const setDefault = useSettings((s) => s.setDefault);
  const reorderProviders = useSettings((s) => s.reorderProviders);
  const [editing, setEditing] = useState<ProviderDraft | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [showPresets, setShowPresets] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [ggufMgrOpen, setGgufMgrOpen] = useState(false);
  const setSideEditorOpen = useUi((s) => s.setSideEditorOpen);
  const localModels = useLocalGguf((s) => s.models);
  // 已配置的 Ollama 卡（chat 槽走原生协议）：固定卡点击直接编辑它，没有则建一张新草稿
  const ollamaCard = models.providers.find((p) => p.models.chat?.protocol === "ollama");
  // 编辑器内部「待确认输入」的收口入口：保存按钮在标题栏（ProviderEditor 外），经它触发 finalize
  const editorApi = useRef<{ save: () => void } | null>(null);

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
    // Ollama 本地协议无需 API Key（其余协议仍要求 Key 非空）
    const isOllama = d.slots.chat.protocol === "ollama" || Object.values(d.slots).some((s) => s.protocol === "ollama");
    if (!d.apiKey.trim() && !isOllama) {
      toast("请填写 API Key 后再保存（没有 Key 的服务商不会保存到模型配置）", "err");
      return;
    }
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
    <div className="set-page">
      <div className="set-page-h">
        <div className="set-page-t">
          模型配置
          <span className="sec-h-tail">
            <button
              className="btn sm"
              title="管理 Skill 创作规则包（导入 SKILL.md / .momoskill）"
              onClick={() => useUi.getState().setSkillMgrOpen(true)}
            >
              <IcWand size={14} /> Skill 管理
            </button>
            <button
              className="btn sm"
              title="添加本地 GGUF 模型（一键启动，直接对话）"
              onClick={() => useUi.getState().setGgufImportOpen(true)}
            >
              <IcBrain size={14} /> 添加本地 GGUF
            </button>
            <button
              className="btn sm"
              title="配置本地模型引擎（llama-server 路径）"
              onClick={() => useUi.getState().setLocalLlmSetupOpen(true)}
            >
              <IcGear size={14} /> 本地引擎
            </button>
          </span>
        </div>
        <div className="set-page-d">
          一格 = 一个服务商（中转站/官方）：Base URL 与 API Key 只填一次，对话、绘画、视频、音频、语音识别每种用途都可以添加多个模型；点击卡片在右侧弹出编辑面板。
        </div>
      </div>

      {/* 默认模型：五类用途各选一个，节点/面板不单独指定时全用这里的 */}
      <CodexBridgeCard />
      <div className="set-card">
        <div className="set-card-h">
          默认模型
          <span className="sec-h-tail">
            <SecHelp>画布节点、创作助手不单独指定模型时，一律调用这里选的；节点上仍可临时改用别的模型。</SecHelp>
          </span>
        </div>
        <div className="dm-grid">
          {ROLES.map((role) => {
            const has = models.providers.some((p) => (p.models[role]?.models.length ?? 0) > 0);
            return (
              <div key={role} className="dm-row">
                <span className="dm-lab" title={ROLE_LABEL[role]}>
                  {ROLE_ICON[role]}
                  {ROLE_SHORT[role]}
                </span>
                {has ? (
                  <ModelPicker
                    role={role}
                    value={models.defaults[role]}
                    onChange={(v) => {
                      if (v) setDefault(role, v);
                    }}
                  />
                ) : (
                  <span className="dm-none" title="先在下方服务商卡片里给这类用途添加模型">
                    未配置
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 服务商卡片 */}
      <div className="set-card">
        <div className="set-card-h">
          服务商
          <span className="sec-h-tail">
            <button
              className="btn sm"
              title="展开 / 收起推荐中转站预设（一键导入，名称 / 地址 / 协议已填好，补 API Key 即可）"
              onClick={() => setShowPresets((v) => !v)}
            >
              <IcSparkles size={14} /> {showPresets ? "收起预设" : "中转站预设"}
            </button>
          </span>
        </div>
        <div className="prov-grid">
        <button className="pcard add" onClick={() => setEditing(toDraft())}>
          <IcPlus size={22} />
          <span>添加服务商</span>
        </button>
        {/* Ollama 固定卡：未配置时作为创建入口；已配置后让位给服务商卡片（避免出现两张内容相同的卡） */}
        {!ollamaCard ? (
          <button
            className="pcard fixed"
            title="本地 Ollama 服务，无需 API Key。点击创建配置（默认 http://127.0.0.1:11434）"
            onClick={() => setEditing(toDraft(buildPresetProvider(OLLAMA_PRESET)))}
          >
            <span className="pc-logo txt">🦙</span>
            <b>Ollama 本地</b>
            <span className="pc-host">本地模型 · 无需 API Key</span>
          </button>
        ) : null}
        {/* 本地 GGUF 固定卡：导入后生成专属卡片，点击打开管理弹窗 */}
        <button
          className="pcard fixed"
          title={
            localModels.length
              ? `已导入：${localModels.map((m) => m.name).join("、")}`
              : "导入本地 .gguf 模型（一键注册并启动 llama-server）"
          }
          onClick={() => (localModels.length ? setGgufMgrOpen(true) : useUi.getState().setGgufImportOpen(true))}
        >
          <span className="pc-logo txt">🧠</span>
          <b>本地 GGUF 模型</b>
          <span className="pc-host">{localModels.length ? `已导入 ${localModels.length} 个模型` : "点击添加 .gguf 文件"}</span>
        </button>
        {models.providers.map((p, i) => (
          <button
            key={p.id}
            className={`pcard ${editing?.id === p.id ? "on" : ""} ${dragIdx === i ? "dragging" : ""} ${overIdx === i ? "drag-over" : ""}`}
            title="点击编辑；按住可拖动调整顺序"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", String(i));
              e.dataTransfer.effectAllowed = "move";
              setDragIdx(i);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setOverIdx(i);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setOverIdx((v) => (v === i ? null : v));
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIdx != null && dragIdx !== i) reorderProviders(dragIdx, i);
              setDragIdx(null);
              setOverIdx(null);
            }}
            onDragEnd={() => {
              setDragIdx(null);
              setOverIdx(null);
            }}
            onClick={() => setEditing(toDraft(p))}
          >
            {p.logo ? (
              /^https?:|^data:/i.test(p.logo) ? (
                <img className="pc-logo" src={p.logo} alt="" />
              ) : (
                // 按码点取首字符：emoji（如 🦙）是代理对，slice(0,1) 会切成乱码
                <span className="pc-logo txt">{[...p.logo][0]}</span>
              )
            ) : null}
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
        <div className="set-hint" style={{ marginTop: 10 }}>
          卡片上的五个图标：对话 / 绘画 / 视频 / 音频 / 语音识别。图标点亮 = 该服务商配置了这类模型；
          <b>绿点 = 这类模型的当前默认来源</b>（在上方「默认模型」里切换）。
        </div>

        {showPresets ? (
          <div className="preset-section" style={{ marginTop: 12 }}>
            <div className="preset-grid">
              {PROVIDER_PRESETS.map((p) => (
                <PresetCard key={p.key} p={p} onPick={(pp) => setEditing(toDraft(buildPresetProvider(pp)))} />
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* 配置备份与恢复 */}
      <div className="set-card">
        <div className="set-card-h">配置备份与恢复</div>
        <Row gap={8}>
          <button
            className="btn sm"
            title="导出全部设置，API Key 一律抹去（推荐：给别人 / 传网盘都安全，接收方填自己的 Key；自己重新导入时本机 Key 自动保留）"
            onClick={() => void exportCfg(true)}
          >
            <IcDownload size={15} /> 导出配置
          </button>
          <button
            className="btn sm"
            title="含密钥的加密分享包（.momocfg）：文件里看不到明文密钥，接收方导入即可直接使用。注意：能直接用就意味着密钥也随包给了对方，只发给信任的人"
            onClick={() => void exportCfg(false)}
          >
            <IcDownload size={15} /> 加密分享包
          </button>
          <button className="btn sm" title="从导出的配置文件恢复全部设置（支持 .json 与 .momocfg 加密包）" onClick={() => void importCfg()}>
            <IcUpload size={15} /> 导入配置
          </button>
        </Row>
        <div className="set-hint" style={{ marginTop: 8 }}>
          配置存在系统用户数据目录并自动备份；「导出配置」不含密钥可安全分享，「加密分享包」含密钥，只发给信任的人。
        </div>
      </div>

      <GgufManageDialog open={ggufMgrOpen} onClose={() => setGgufMgrOpen(false)} />

      {editing
        ? createPortal(
            <div className="prov-float" role="dialog" aria-label="服务商配置">
              {/* 操作按钮固定在标题栏：内容再长，保存/取消/测试也不会被滚出视野 */}
              <div className="pf-head">
                <b>{isExisting ? savedEditing?.name || "编辑服务商" : "添加服务商"}</b>
                <span className="pf-head-acts">
                  {isExisting && savedEditing?.models.chat ? (
                    <button className="btn sm" disabled={testing === savedEditing.id} onClick={() => void testChat(savedEditing)}>
                      {testing === savedEditing.id ? <IcLoading size={14} /> : null} 测试
                    </button>
                  ) : null}
                  <button className="btn sm" onClick={() => setEditing(null)}>
                    取消
                  </button>
                  <button className="btn sm primary" onClick={() => editorApi.current?.save()}>
                    保存服务商
                  </button>
                  <button className="icon-btn" onClick={() => setEditing(null)} aria-label="关闭">
                    <IcClose size={16} />
                  </button>
                </span>
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
                            <PopSelect
                              style={{ width: 148, flex: "none" }}
                              title={`${ROLE_LABEL[role]}默认模型`}
                              value={def.model ?? slot.models[0]}
                              options={slot.models.map((m) => ({ value: m, label: m }))}
                              onChange={(v) => setDefault(role, modelKey(savedEditing.id, v))}
                            />
                          ) : null}
                        </span>
                      );
                    })}
                    <span style={{ flex: 1 }} />
                    <button
                      className="icon-btn danger"
                      title={confirmDel === savedEditing.id ? "再点一次确认删除" : "删除该服务商"}
                      style={confirmDel === savedEditing.id ? { color: "var(--danger)", background: "color-mix(in srgb, var(--danger) 12%, transparent)" } : undefined}
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
                <ProviderEditor
                  draft={editing}
                  setDraft={setEditing}
                  onSave={saveEditing}
                  apiRef={editorApi}
                />
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

const EMPTY_BY_ROLE: Record<ModelRole, string> = { chat: "", image: "", video: "", audio: "", asr: "" };

function ProviderEditor({
  draft,
  setDraft,
  onSave,
  apiRef,
}: {
  draft: ProviderDraft;
  setDraft: (d: ProviderDraft) => void;
  onSave: (d: ProviderDraft) => void;
  /** 标题栏的「保存服务商」经它触发（要先收口各槽位里没回车的输入，再走 onSave） */
  apiRef: React.RefObject<{ save: () => void } | null>;
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
    const issue=modelAssignmentIssue(role,m);if(issue){toast(issue,"err");return;}
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
      // 预设协议也按 OpenAI 兼容方式尝试（多数中转站同时开放 /models）
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

  // 每次渲染都刷新闭包：标题栏的保存按钮始终拿到最新的 draft/inputs
  useEffect(() => {
    apiRef.current = { save: () => onSave(finalize()) };
  });

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
              <PopSelect
                // 协议名可能很长：触发按钮限宽截断，全名在弹层里看
                style={{ flex: "1 1 0", minWidth: 0, maxWidth: 190 }}
                title="协议"
                value={slot.protocol}
                options={[
                  ...PROTOCOLS[role].map((x) => ({ value: x.value, label: x.label })),
                  ...(role !== "chat"
                    ? customProtocols
                        .filter((p) => (p.role === "video" ? "video" : p.role === "audio" ? "audio" : "image") === role)
                        .map((p) => ({
                          value: `custom:${p.id}`,
                          label: p.name,
                          icon: ROLE_ICON[role],
                        }))
                    : []),
                ]}
                onChange={(v) => patchSlot(role, { protocol: v as AnyProtocol })}
              />
              <input
                className="input"
                style={{ flex: "1.5 1 0", minWidth: 0 }}
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
                <PopSelect
                  className="pe-pick"
                  title="点选即添加"
                  value=""
                  placeholder={
                    kw
                      ? `筛出 ${filtered.length} / ${list.length} 个模型，点选即添加…`
                      : `从拉取到的 ${list.length} 个模型中点选即添加…`
                  }
                  options={filtered.map((m) => ({
                    value: m,
                    label: slot.models.includes(m) ? `✓ ${m}` : m,
                    disabled: slot.models.includes(m),
                  }))}
                  onChange={(v) => {
                    if (v) addModel(role, v);
                  }}
                />
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
