import { create } from "zustand";
import { uid } from "../utils";
import { loadJSON, saveJSON } from "../persist";
import type { AgentMsg, AgentStep, AgentStepKind } from "../types";

/** 助手面板的模型/模式选择：持久化，重启后延续（对话内容不持久化） */
type AgentPrefs = {
  modelId?: string;
  imageModelId?: string;
  videoModelId?: string;
  mode?: "chat" | "agent";
  webSearch?: boolean;
  /** 思考模式（仅创作助手生效；Ollama / 本地 GGUF 等支持思考的模型） */
  thinkingOn?: boolean;
};
const PREF_FILE = "agent-prefs.json";

/**
 * 选择器可能在很短时间内连续改三个角色。saveJSON 在 Tauri 下包含异步外置化与落盘，
 * 若并发写同一个文件，较早的旧快照反而可能最后完成并覆盖新选择；串行队列保证提交顺序就是落盘顺序。
 */
let prefsSaveChain: Promise<void> = Promise.resolve();

/** 写回选择（模型/模式/联网开关/思考开关），对话内容不落盘 */
function savePrefs(get: () => AgentState) {
  const { modelId, imageModelId, videoModelId, mode, webSearch, thinkingOn } = get();
  const snapshot = { modelId, imageModelId, videoModelId, mode, webSearch, thinkingOn } satisfies AgentPrefs;
  prefsSaveChain = prefsSaveChain.then(
    () => saveJSON(PREF_FILE, "v1", snapshot),
    () => saveJSON(PREF_FILE, "v1", snapshot),
  ).catch(() => {
    /* 偏好保存失败不打断当前对话；下次选择会继续从新快照写入 */
  });
}

type AgentState = {
  messages: AgentMsg[];
  draft: string;
  /** 待发送的参考图（dataURL） */
  attachments: string[];
  referenceMode: "auto" | "none";
  running: boolean;
  /** 对话模型复合键「providerId::model」，空 = 角色默认 */
  modelId?: string;
  /** Agent/画布生图用的绘画模型复合键，空 = 角色默认 */
  imageModelId?: string;
  /** Agent 生视频用的视频模型复合键，空 = 角色默认 */
  videoModelId?: string;
  /** 面板模式：chat = 多模态聊天（完善想法/提示词）；agent = 自动搜资料出图出片 */
  mode: "chat" | "agent";
  /** 聊天模式：发送前先联网搜索 */
  webSearch: boolean;
  /** 思考模式开关（仅创作助手生效；关闭时给支持思考的模型下发禁用思考指令） */
  thinkingOn: boolean;
  /** 聊天上下文压缩：旧消息摘要（超出窗口的较早对话由模型自行压缩，保证多轮讨论不断片） */
  summary: string;
  /** 摘要已覆盖到的消息下标（不含）：压缩增量推进 */
  summaryUpto: number;
  /** 会话代次：清空对话时自增，用于丢弃在途的旧摘要压缩结果（否则陈旧下标会把新消息切没） */
  epoch: number;
  /** ask 动作挂起时的唤醒器：用户作答后继续循环 */
  resolver: ((answer: string) => void) | null;

  setDraft: (v: string) => void;
  addAttachments: (imgs: string[]) => void;
  removeAttachment: (i: number) => void;
  setModelId: (v?: string) => void;
  setImageModelId: (v?: string) => void;
  setVideoModelId: (v?: string) => void;
  /** 载入上次的模型/模式选择（应用启动时调一次） */
  initPrefs: () => Promise<void>;
  setMode: (m: "chat" | "agent") => void;
  toggleWebSearch: () => void;
  toggleThinking: () => void;
  setSummary: (s: string, upto: number) => void;
  clear: () => void;

  /* ---- 引擎内部使用 ---- */
  pushUser: (text: string, images: string[]) => void;
  beginAssistant: (kind?: "chat" | "agent") => string;
  updateMsg: (id: string, patch: Partial<AgentMsg>) => void;
  addStep: (msgId: string, kind: AgentStepKind, text: string) => string;
  setStep: (msgId: string, stepId: string, patch: Partial<AgentStep>) => void;
  appendResults: (msgId: string, results: AgentMsg["results"]) => void;
  /** 挂起循环，等用户作答；返回用户的选择/输入 */
  askQuestion: (msgId: string, text: string, options: string[]) => Promise<string>;
  answer: (msgId: string, answer: string) => void;
};

export const useAgent = create<AgentState>((set, get) => ({
  messages: [],
  draft: "",
  attachments: [],
  referenceMode: "auto",
  running: false,
  modelId: undefined,
  imageModelId: undefined,
  videoModelId: undefined,
  mode: "chat",
  // 默认开启：联网是创作助手的核心能力；模型自带联网时优先用模型自己的（不额外花钱），
  // 不支持的家族走内置搜索接口，未配置时自动降级直接回答。面板上可一键关闭
  webSearch: true,
  thinkingOn: true,
  summary: "",
  summaryUpto: 0,
  epoch: 0,
  resolver: null,

  setDraft: (v) => set({ draft: v }),
  addAttachments: (imgs) => set((s) => ({ attachments: [...s.attachments, ...imgs].slice(0, 6), referenceMode: "auto" })),
  removeAttachment: (i) => set((s) => ({ attachments: s.attachments.filter((_, x) => x !== i) })),
  setModelId: (v) => {
    set({ modelId: v });
    savePrefs(get);
  },
  setImageModelId: (v) => {
    set({ imageModelId: v });
    savePrefs(get);
  },
  setVideoModelId: (v) => {
    set({ videoModelId: v });
    savePrefs(get);
  },

  initPrefs: async () => {
    const p = await loadJSON<AgentPrefs>(PREF_FILE, "v1");
    if (!p) return;
    set({
      modelId: p.modelId,
      imageModelId: p.imageModelId,
      videoModelId: p.videoModelId,
      mode: p.mode ?? "chat",
      // 只有从未保存过偏好（undefined）才用默认 true；用户显式关过就是 false
      webSearch: p.webSearch ?? true,
      thinkingOn: p.thinkingOn ?? true,
    });
  },
  setMode: (m) => {
    set({ mode: m });
    savePrefs(get);
  },
  toggleWebSearch: () => {
    set((s) => ({ webSearch: !s.webSearch }));
    savePrefs(get);
  },
  toggleThinking: () => {
    set((s) => ({ thinkingOn: !s.thinkingOn }));
    savePrefs(get);
  },
  setSummary: (summary, upto) => set({ summary, summaryUpto: upto }),
  clear: () =>
    set((s) => ({
      messages: [],
      draft: "",
      attachments: [],
      referenceMode: "auto",
      resolver: null,
      summary: "",
      summaryUpto: 0,
      epoch: s.epoch + 1,
    })),

  pushUser: (text, images) =>
    set((s) => ({
      referenceMode: "auto",
      messages: [
        ...s.messages,
        { id: uid(), role: "user", text, images: images.length ? images : undefined, referenceMode: s.referenceMode, time: Date.now() },
      ],
    })),

  beginAssistant: (kind) => {
    const id = uid();
    set((s) => ({
      messages: [
        ...s.messages,
        { id, role: "assistant", text: "", steps: [], results: [], kind: kind ?? s.mode, time: Date.now() },
      ],
    }));
    return id;
  },

  updateMsg: (id, patch) =>
    set((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),

  addStep: (msgId, kind, text) => {
    const sid = uid(6);
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === msgId ? { ...m, steps: [...(m.steps ?? []), { id: sid, kind, text, status: "running" }] } : m,
      ),
    }));
    return sid;
  },

  setStep: (msgId, stepId, patch) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === msgId
          ? { ...m, steps: (m.steps ?? []).map((st) => (st.id === stepId ? { ...st, ...patch } : st)) }
          : m,
      ),
    })),

  appendResults: (msgId, results) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === msgId ? { ...m, results: [...(m.results ?? []), ...(results ?? [])] } : m,
      ),
    })),

  askQuestion: (msgId, text, options) =>
    new Promise<string>((resolve) => {
      set((s) => ({
        resolver: resolve,
        messages: s.messages.map((m) => (m.id === msgId ? { ...m, question: { text, options } } : m)),
      }));
    }),

  answer: (msgId, answer) => {
    const state = get();
    const pending = [...state.messages].reverse().find(m => m.question && m.question.answer === undefined);
    if (!pending || pending.id !== msgId || !state.resolver) return;
    const r = state.resolver;
    set((s) => ({
      resolver: null,
      messages: s.messages.map((m) =>
        m.id === msgId && m.question ? { ...m, question: { ...m.question, answer } } : m,
      ),
    }));
    r?.(answer);
  },
}));
