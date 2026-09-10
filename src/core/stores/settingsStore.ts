import { create } from "zustand";
import {
  DEFAULT_HOTKEYS,
  DEFAULT_SETTINGS,
  PROTOCOLS,
  ROLE_LABEL,
  type CustomProtocol,
  type LegacyModelsV2,
  type LegacyRoleSlotV3,
  type LegacySettingsV1,
  type ModelCard,
  type ModelRole,
  type ModelsCfg,
  type ProviderCard,
  type RoleSlot,
  type Settings,
  type UnitPrice,
} from "../types";
import { loadJSON, saveJSON } from "../persist";
import { isTauri, uid } from "../utils";
import { PROTO_PRESETS, presetProtoId } from "../protoPresets";
import { useLocalGguf } from "./localGgufStore";
import { toast } from "./uiStore";
import { grsaiGptRoute } from "../modelMeta";

/** API Key 落盘加密前缀（DPAPI 密文 hex）；内存中始终是明文，只有写盘/读盘时转换 */
const KEY_ENC_PREFIX = "dpapi:";

/** 落盘前把 providers/search/eagle 的密钥换成 DPAPI 密文（返回浅拷贝；加密失败保持明文——不比现状更差） */
async function encryptKeysForDisk(s: Settings): Promise<Settings> {
  if (!isTauri) return s; // 浏览器预览无 DPAPI：保持明文
  const { invoke } = await import("@tauri-apps/api/core");
  const enc = async (k: string) => {
    if (!k || k.startsWith(KEY_ENC_PREFIX)) return k;
    const c = await invoke<string>("dpapi_encrypt", { s: k }).catch(() => "");
    return c ? KEY_ENC_PREFIX + c : k;
  };
  const providers = [];
  for (const p of s.models.providers) {
    providers.push(p.apiKey ? { ...p, apiKey: await enc(p.apiKey) } : p);
  }
  const search = s.search.apiKey ? { ...s.search, apiKey: await enc(s.search.apiKey) } : s.search;
  const eagleToken = s.eagle?.apiToken ? { ...s.eagle, apiToken: await enc(s.eagle.apiToken) } : s.eagle;
  return { ...s, models: { ...s.models, providers }, search, eagle: eagleToken };
}

/** 加载后把 dpapi: 前缀的 apiKey 解回明文（失败保留原值并提示重填——换机器/换用户后 DPAPI 解不开） */
async function decryptKeysFromDisk(s: Settings): Promise<Settings> {
  const need =
    s.models.providers.some((p) => p.apiKey?.startsWith(KEY_ENC_PREFIX)) ||
    !!s.search.apiKey?.startsWith(KEY_ENC_PREFIX) ||
    !!s.eagle?.apiToken?.startsWith(KEY_ENC_PREFIX);
  if (!need || !isTauri) return s;
  const { invoke } = await import("@tauri-apps/api/core");
  let failed = 0;
  const dec = async (k: string) => {
    if (!k.startsWith(KEY_ENC_PREFIX)) return k;
    try {
      return await invoke<string>("dpapi_decrypt", { s: k.slice(KEY_ENC_PREFIX.length) });
    } catch {
      failed++;
      return k;
    }
  };
  const providers = [];
  for (const p of s.models.providers) providers.push(p.apiKey ? { ...p, apiKey: await dec(p.apiKey) } : p);
  const search = s.search.apiKey ? { ...s.search, apiKey: await dec(s.search.apiKey) } : s.search;
  const eagleToken = s.eagle?.apiToken ? { ...s.eagle, apiToken: await dec(s.eagle.apiToken) } : s.eagle;
  if (failed) toast(`有 ${failed} 个 API Key 解密失败（DPAPI 绑定本机用户），请到「设置 → 模型配置」重新填写`, "err");
  return { ...s, models: { ...s.models, providers }, search, eagle: eagleToken };
}

/**
 * 注入本地 GGUF 模型为虚拟服务商。
 *
 * 设计（§7）：
 *  - 所有本地 GGUF 模型合并到**同一家**虚拟服务商（id 固定 "local-gguf"），避免 ProviderCard 数量膨胀
 *  - 每个本地模型 = chat 槽的一个 model 项；model 值 = model.name（与 localGgufStore.name 对应）
 *  - 协议固定 "llamacpp"：对话时由 llm.ts 检测并 ensureRunning（动态注入 baseUrl）
 *  - baseUrl/apiKey 留空：运行期由 ensureRunning 填入
 *  - 注入只作用在内存（不写盘），不污染用户配置的 providers
 *  - 本地模型放在 providers 数组末尾：远程服务商在「第一家可用」兜底中优先
 *
 * 注意：必须在 localGgufStore.init() 之后调用，否则 models 为空。
 */
const LOCAL_GGUF_PROVIDER_ID = "local-gguf";

function injectLocalGgufProviders(providers: ProviderCard[]): ProviderCard[] {
  providers = [...providers.filter(p => p.id !== "codex-membership"), {id:"codex-membership",name:"Codex 会员 · 本机桥接",baseUrl:"",apiKey:"",models:{chat:{protocol:"codex",models:["codex-chat"]},image:{protocol:"codex",models:["codex-image"]}}}];
  const localModels = useLocalGguf.getState().models;
  if (!localModels.length) return providers;
  const chatModels = localModels.map((m) => m.name);
  const virtualCard: ProviderCard = {
    id: LOCAL_GGUF_PROVIDER_ID,
    name: "本地 GGUF 模型",
    baseUrl: "",
    apiKey: "",
    models: {
      chat: {
        protocol: "llamacpp",
        models: chatModels,
      },
    },
    logo: "🧠",
  };
  // 替换已有虚拟项（幂等）或追加
  const filtered = providers.filter((p) => p.id !== LOCAL_GGUF_PROVIDER_ID);
  return [...filtered, virtualCard];
}

/** 导出常量供 llm.ts / localLlm.ts 复用 */
export { LOCAL_GGUF_PROVIDER_ID as LOCAL_GGUF_PID };

/** 「服务商 + 模型」复合键（节点选择 / 角色默认 都用它） */
export function modelKey(providerId: string, model: string) {
  return `${providerId}::${model}`;
}

export function splitModelKey(key?: string): { pid?: string; model?: string } {
  if (!key) return {};
  const i = key.indexOf("::");
  if (i < 0) return { pid: key }; // 旧数据：只有服务商 id
  return { pid: key.slice(0, i), model: key.slice(i + 2) };
}

/** 兼容 v3 单模型槽位：model → models[]，顺带去重去空 */
function normalizeSlot(raw: LegacyRoleSlotV3 | RoleSlot): RoleSlot {
  const legacy = raw as LegacyRoleSlotV3;
  const list = (legacy.models ?? (legacy.model ? [legacy.model] : []))
    .map((m) => m.trim())
    .filter(Boolean);
  return { protocol: raw.protocol, models: [...new Set(list)] };
}

function normalizeProviders(providers: ProviderCard[]): ProviderCard[] {
  return providers.map((p) => {
    const models: ProviderCard["models"] = {};
    for (const role of ROLES) {
      const slot = p.models?.[role];
      if (!slot) continue;
      const fixed = normalizeSlot(slot);
      if (fixed.models.length) models[role] = fixed;
    }
    return { ...p, models };
  });
}

/* ---------------- 协议库规整（3.6：协议只来自内置预设，不再有自定义编辑链路） ---------------- */

/** 历史协议名 → 精简名（只留「中转站 + 用途」）；幂等：精简后的名字不会再被改 */
const PROTO_NAME_MAP: [RegExp, string][] = [
  [/^65535\s*异步生图/, "65535 生图"],
  [/^APIMart\s+GPT-Image-2\s*异步生图/i, "APIMart 生图"],
  [/^APIMart\s+[\w.-]+\s*异步生视频/i, "APIMart 生视频"],
  [/^Grsai\s+nano-banana/i, "Grsai 生图"],
];

/** 精简协议显示名：去掉「（…）」「·修正版」等历史标注，认得的旧预设名换成新简名 */
function simplifyProtoName(name: string): string {
  for (const [re, to] of PROTO_NAME_MAP) if (re.test(name)) return to;
  return name
    .replace(/（[^）]*）/g, "")
    .replace(/·修正版/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * 协议库与预设对账（每次加载 / 导入配置时跑一遍，幂等）：
 *  ① 名称精简：去掉「（…）」「·修正版」等历史标注，认得的旧预设名换成新简名；
 *  ② 同名收敛：历史导入的预设协议（旧 id）统一改绑到 preset-<key>，避免库里出现两条同名协议；
 *  ③ 只保留仍被服务商槽位引用的协议（custom:<id>），没人用的孤儿清掉；
 *  ④ 预设派生的协议（id=preset-*）内容强制刷新为当前预设——站点接口修了改预设即全员生效；
 *  ⑤ baseUrl 命中预设的服务商：对应用途槽位还走内置协议（如 openai）时自动换成预设协议
 *     （这些站的生图/生视频必须走各自的异步通道，OpenAI 兼容路径本来就不通）；
 *     槽位已绑定任何自定义协议的一律不动。
 */
function syncPresetProtocols(providers: ProviderCard[], protos: CustomProtocol[]): CustomProtocol[] {
  const named = protos.map((p) => ({
    ...p,
    role: (p.role === "video" || p.role === "audio" ? p.role : "image") as CustomProtocol["role"],
    name: simplifyProtoName(p.name),
  }));
  for (const preset of PROTO_PRESETS) {
    const pid = presetProtoId(preset.key);
    const legacyIds = new Set(
      named.filter((p) => p.id !== pid && p.name === preset.proto.name && p.role === preset.proto.role).map((p) => p.id),
    );
    if (!legacyIds.size) continue;
    for (const pv of providers)
      for (const [role, slot] of Object.entries(pv.models))
        if (slot.protocol.startsWith("custom:") && legacyIds.has(slot.protocol.slice(7)))
          pv.models[role as ModelRole] = { ...slot, protocol: `custom:${pid}` };
  }
  const bound = new Set<string>();
  for (const p of providers)
    for (const slot of Object.values(p.models)) if (slot.protocol.startsWith("custom:")) bound.add(slot.protocol.slice(7));
  const list = named.filter((p) => bound.has(p.id));
  for (const preset of PROTO_PRESETS) {
    const id = presetProtoId(preset.key);
    // 被引用的预设条目统一刷新/补建（②的改绑只换了引用，条目本体要在这里落进库里）
    const i = list.findIndex((p) => p.id === id);
    if (bound.has(id)) list[i >= 0 ? i : list.length] = { ...preset.proto, id };
  }
  for (const preset of PROTO_PRESETS) {
    const id = presetProtoId(preset.key);
    const role = preset.proto.role;
    for (const pv of providers) {
      if (!preset.hostMatch.test(pv.baseUrl ?? "")) continue;
      const slot = pv.models[role];
      if (!slot || slot.protocol.startsWith("custom:")) continue;
      pv.models[role] = { ...slot, protocol: `custom:${id}` };
      if (!list.some((p) => p.id === id)) list.push({ ...preset.proto, id });
    }
  }
  return list;
}

type SettingsState = {
  settings: Settings;
  loaded: boolean;
  init: () => Promise<void>;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  upsertProvider: (p: ProviderCard) => void;
  removeProvider: (id: string) => void;
  setDefault: (role: ModelRole, id: string) => void;
  reorderProviders: (from: number, to: number) => void;
  /** 从导出的 JSON 恢复整套配置 */
  importSettings: (raw: unknown) => void;
};

/** 任意来源的部分配置 → 规整为完整 Settings（缺项补默认，槽位/默认键规整为新结构） */
function normalize(v: Partial<Settings>): Settings {
  const providers = normalizeProviders(v.models?.providers ?? []);
  const protos = syncPresetProtocols(providers, v.customProtocols ?? []);
  return {
    models: fixDefaults({ providers, defaults: v.models?.defaults ?? {} }),
    search: { ...DEFAULT_SETTINGS.search, ...(v.search ?? {}) },
    save: { ...DEFAULT_SETTINGS.save, ...(v.save ?? {}) },
    comfy: { ...DEFAULT_SETTINGS.comfy, ...(v.comfy ?? {}) },
    theme: v.theme ?? "dark",
    gpuBoost: v.gpuBoost ?? true,
    sound: { ...DEFAULT_SETTINGS.sound, ...(v.sound ?? {}) },
    hotkeys: { ...DEFAULT_HOTKEYS, ...(v.hotkeys ?? {}) },
    shortcuts: v.shortcuts ?? [],
    customProtocols: protos,
    // 稳定性/成本：浅合并默认值，老数据无这些键 → 拿全默认（submitMax=0 不重复扣费）
    retry: { ...DEFAULT_SETTINGS.retry, ...(v.retry ?? {}) },
    budget: { ...DEFAULT_SETTINGS.budget, ...(v.budget ?? {}) },
    pricing: { overrides: { ...((v.pricing as { overrides?: Record<string, UnitPrice> } | undefined)?.overrides ?? {}) } },
    // 本地超清放大引擎：浅合并默认值，老数据无此键 → 拿默认（4K / 自动 tile / 重叠 32）
    enhance: { ...DEFAULT_SETTINGS.enhance, ...(v.enhance ?? {}) },
    // 本地 GGUF 引擎：浅合并默认值，老数据无此键 → 空对象（首次使用时引导配置）
    localLlm: { ...DEFAULT_SETTINGS.localLlm, ...(v.localLlm ?? {}) },
    // Eagle 资产桥：浅合并默认值；metadata 深一层单独合并
    eagle: {
      ...DEFAULT_SETTINGS.eagle,
      ...(v.eagle ?? {}),
      metadata: { ...DEFAULT_SETTINGS.eagle.metadata, ...(v.eagle?.metadata ?? {}) },
    },
    // MCP 服务器（Streamable HTTP）：老数据无此键 → 空列表；逐项兜底必填字段
    mcp: {
      servers: (v.mcp?.servers ?? [])
        .filter((s) => s && typeof s.url === "string" && s.url.trim())
        .map((s) => ({
          id: String(s.id ?? "").trim(),
          name: String(s.name ?? "").trim() || s.url,
          url: s.url.trim(),
          enabled: s.enabled !== false,
          headers: s.headers && typeof s.headers === "object" ? s.headers : undefined,
        })),
    },
  };
}

function applyTheme(theme: Settings["theme"]) {
  document.documentElement.setAttribute("data-theme", theme);
}

/** 画布 GPU 加速开关 → 根元素 class（canvas.css 按 .gpu-boost 作用域生效） */
function applyGpu(on: boolean) {
  document.documentElement.classList.toggle("gpu-boost", on);
}

const ROLES: ModelRole[] = ["chat", "image", "video", "audio", "asr"];

/** 修补 defaults：规整为「pid::model」，指向不存在的服务商/模型时退回第一个可用的 */
function fixDefaults(cfg: ModelsCfg): ModelsCfg {
  const defaults = { ...cfg.defaults };
  for (const role of ROLES) {
    const { pid, model } = splitModelKey(defaults[role]);
    if (role === "chat" && pid === "codex-membership") { defaults[role] = "codex-membership::codex-chat"; continue; }
    if (role === "image" && pid === "codex-membership") { defaults[role] = "codex-membership::codex-image"; continue; }
    const p = cfg.providers.find((x) => x.id === pid && x.models[role]?.models.length);
    if (p) {
      const slot = p.models[role]!;
      defaults[role] = modelKey(p.id, model && slot.models.includes(model) ? model : slot.models[0]);
    } else {
      const first = cfg.providers.find((x) => x.models[role]?.models.length);
      defaults[role] = first ? modelKey(first.id, first.models[role]!.models[0]) : undefined;
    }
  }
  return { ...cfg, defaults };
}

/** v2 平铺卡片 → v3 服务商卡片：同 baseUrl+apiKey 的卡合并为一家，角色冲突则另立一家 */
function migrateModelsV2(old: LegacyModelsV2): ModelsCfg {
  const providers: ProviderCard[] = [];
  const cardToProvider = new Map<string, string>();
  for (const c of old.cards ?? []) {
    const slot: RoleSlot = { protocol: c.protocol, models: c.model ? [c.model] : [] };
    const home = providers.find(
      (p) => p.baseUrl === c.baseUrl && p.apiKey === c.apiKey && !p.models[c.role],
    );
    if (home) {
      home.models[c.role] = slot;
      cardToProvider.set(c.id, home.id);
    } else {
      providers.push({ id: c.id, name: c.name, baseUrl: c.baseUrl, apiKey: c.apiKey, models: { [c.role]: slot } });
      cardToProvider.set(c.id, c.id);
    }
  }
  const defaults: ModelsCfg["defaults"] = {};
  for (const role of ROLES) {
    const d = old.defaults?.[role];
    if (d && cardToProvider.has(d)) defaults[role] = cardToProvider.get(d);
  }
  return fixDefaults({ providers, defaults });
}

/** v1 单套配置 → v3 */
function migrateV1(old: LegacySettingsV1): Partial<Settings> {
  const cards: ModelCard[] = [];
  if (old.chat?.baseUrl || old.chat?.model)
    cards.push({ id: uid(8), role: "chat", name: "中转站 A", protocol: "openai", baseUrl: old.chat.baseUrl ?? "", apiKey: old.chat.apiKey ?? "", model: old.chat.model ?? "" });
  if (old.image?.baseUrl || old.image?.model)
    cards.push({ id: uid(8), role: "image", name: "中转站 A", protocol: "openai", baseUrl: old.image.baseUrl ?? "", apiKey: old.image.apiKey ?? "", model: old.image.model ?? "", size: old.image.size ?? "1024x1024" });
  if (old.video?.baseUrl || old.video?.model)
    cards.push({ id: uid(8), role: "video", name: "中转站 A", protocol: (old.video.style as ModelCard["protocol"]) ?? "zhipu", baseUrl: old.video.baseUrl ?? "", apiKey: old.video.apiKey ?? "", model: old.video.model ?? "" });
  return {
    models: migrateModelsV2({ cards, defaults: {} }),
    search: { ...DEFAULT_SETTINGS.search, ...(old.search ?? {}) },
    save: { ...DEFAULT_SETTINGS.save, ...(old.save ?? {}) },
    comfy: { ...DEFAULT_SETTINGS.comfy, ...(old.comfy ?? {}) },
    theme: old.theme ?? "dark",
  };
}

let initOnce: Promise<void> | null = null;

// 把配置里的全部密钥注册给运行日志做脱敏（动态 import 避免模块环）
void import("./logStore").then(({ registerSecretSource }) => {
  registerSecretSource(() => {
    const s = useSettings.getState().settings;
    return [...s.models.providers.map((p) => p.apiKey), s.search.apiKey].filter(Boolean);
  });
});

export const useSettings = create<SettingsState>((set, get) => {
  const commit = (next: Settings) => {
    set({ settings: next });
    // 落盘前 API Key 转 DPAPI 密文（内存保持明文，运行期无感）
    void encryptKeysForDisk(next).then((disk) => saveJSON("settings.json", "v4", disk));
  };

  return {
    settings: DEFAULT_SETTINGS,
    loaded: false,

    init: () =>
      (initOnce ??= (async () => {
        // 先初始化本地 GGUF 模型注册表（resolveModelCard 会在内存注入虚拟服务商）
        void useLocalGguf.getState().init();
        let merged: Settings | null = null;
        // v4 = v3 + eagle 资产桥配置；v4 不存在时走老链路加载（normalize 自动补 eagle 默认值）
        const v4 = await loadJSON<Partial<Settings>>("settings.json", "v4");
        if (v4) {
          merged = normalize(v4);
        } else {
          const v3 = await loadJSON<Partial<Settings>>("settings.json", "v3");
          if (v3) {
            merged = normalize(v3);
          } else {
            // v3 不存在时依次回退：v2 → v1 → 上次自动备份（升级/异常后的兜底恢复）
            const v2 = await loadJSON<{ models?: LegacyModelsV2 } & Partial<Omit<Settings, "models">>>("settings.json", "v2");
            if (v2) {
              merged = normalize({ ...v2, models: undefined });
              merged = { ...merged, models: migrateModelsV2(v2.models ?? { cards: [], defaults: {} }) };
            } else {
              const v1 = await loadJSON<LegacySettingsV1>("settings.json", "v1");
              if (v1) merged = normalize(migrateV1(v1));
              else {
                const bak = await loadJSON<Partial<Settings>>("settings.backup.json", "v4");
                if (bak) merged = normalize(bak);
              }
            }
            if (merged) void encryptKeysForDisk(merged).then((d) => saveJSON("settings.json", "v4", d));
          }
        }
        // 加载后把 dpapi: 密文 Key 解回明文（换机器/用户解不开 → 保留密文 + toast 提示重填）
        const final = (merged ? await decryptKeysFromDisk(merged) : null) ?? DEFAULT_SETTINGS;
        applyTheme(final.theme);
        applyGpu(final.gpuBoost);
        set({ settings: final, loaded: true });
        // 每次启动写一份备份（同样加密落盘），任何升级/迁移出问题都能从备份找回
        if (merged) void encryptKeysForDisk(final).then((d) => saveJSON("settings.backup.json", "v4", d));
      })()),

    importSettings: (raw) => {
      if (!raw || typeof raw !== "object") throw new Error("配置文件格式不正确");
      const next = normalize(raw as Partial<Settings>);
      applyTheme(next.theme);
      applyGpu(next.gpuBoost);
      commit(next);
    },

    update: (key, value) => {
      const next = { ...get().settings, [key]: value };
      if (key === "theme") applyTheme(next.theme);
      if (key === "gpuBoost") applyGpu(next.gpuBoost);
      commit(next);
    },

    upsertProvider: (p) => {
      const s = get().settings;
      const exists = s.models.providers.some((x) => x.id === p.id);
      const providers = exists ? s.models.providers.map((x) => (x.id === p.id ? p : x)) : [...s.models.providers, p];
      commit({ ...s, models: fixDefaults({ providers, defaults: s.models.defaults }) });
    },

    removeProvider: (id) => {
      const s = get().settings;
      const providers = s.models.providers.filter((p) => p.id !== id);
      commit({ ...s, models: fixDefaults({ providers, defaults: s.models.defaults }) });
    },

    setDefault: (role, id) => {
      const s = get().settings;
      commit({ ...s, models: { ...s.models, defaults: { ...s.models.defaults, [role]: id } } });
    },
    reorderProviders: (from, to) => {
      const s = get().settings;
      const providers = [...s.models.providers];
      if (from < 0 || from >= providers.length || to < 0 || to >= providers.length || from === to) return;
      const [moved] = providers.splice(from, 1);
      providers.splice(to, 0, moved);
      commit({ ...s, models: fixDefaults({ providers, defaults: s.models.defaults }) });
    },
  };
});

/** 服务商卡片 + 角色（+ 指定模型，缺省取该槽第一个）→ 扁平化模型配置（服务层消费） */
export function flattenCard(p: ProviderCard, role: ModelRole, model?: string): ModelCard | null {
  const slot = p.models[role];
  if (!slot?.models.length) return null;
  const card: ModelCard = {
    id: p.id,
    role,
    name: p.name,
    protocol: slot.protocol,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    model: model && slot.models.includes(model) ? model : slot.models[0],
  };
  return role === "image" ? grsaiGptRoute(card) : card;
}

/** 解析节点应使用的模型：节点指定的「pid::model」 > 角色默认 > 第一家配了该角色的。兼容旧数据的纯 pid。 */
export function resolveModelCard(role: ModelRole, key?: string): ModelCard {
  const { providers, defaults } = useSettings.getState().settings.models;
  // 注入本地 GGUF 虚拟服务商（只在内存，不写盘）
  const all = injectLocalGgufProviders(providers);
  const sel = splitModelKey(key);
  const def = splitModelKey(defaults[role]);
  const hasRole = (x: ProviderCard) => !!x.models[role]?.models.length;
  let p: ProviderCard | undefined;
  let model: string | undefined;
  if (sel.pid) {
    p = all.find((x) => x.id === sel.pid && hasRole(x));
    model = sel.model;
  }
  if (!p) {
    p = all.find((x) => x.id === def.pid && hasRole(x));
    model = def.model;
  }
  if (!p) {
    p = all.find(hasRole);
    model = undefined;
  }
  const card = p ? flattenCard(p, role, model) : null;
  if (!card) throw new Error(`还没有可用的${ROLE_LABEL[role]}：请到「设置 → 模型配置」添加服务商并配置模型`);
  return card;
}

/** 配置了某角色模型的全部服务商（供节点模型选择器使用） */
export function providersOfRole(role: ModelRole): ProviderCard[] {
  const providers = useSettings.getState().settings.models.providers;
  // 注入本地 GGUF 虚拟服务商（只在内存，不写盘）
  const all = injectLocalGgufProviders(providers);
  return all.filter((p) => p.models[role]?.models.length);
}

/** 该角色的默认协议（新建槽位时用） */
export function defaultProtocol(role: ModelRole) {
  return PROTOCOLS[role][0].value as ModelCard["protocol"];
}
