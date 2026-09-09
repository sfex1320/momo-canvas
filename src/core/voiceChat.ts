/**
 * 语音通话（创作助手「打电话」模式）
 *
 * 轮流对讲的状态机，全程兼容 OpenAI 兼容中转，不依赖各家实时双工 WebSocket：
 *   聆听（麦克风 + 音量 VAD 自动断句）→ 识别（ASR）→ 交给助手（聊天/Agent）→ 朗读回复（TTS）→ 自动续听
 * 播放期间仍在监听：用户一开口立刻掐掉播放（barge-in），像真打电话一样可以插话。
 *
 * 需要在「设置 → 模型配置」里配好：语音识别（asr）必配；音频模型（audio）可选，
 * 没配就只做语音输入不朗读（回复仍会显示在面板上）。
 */
import { useAgent } from "./stores/agentStore";
import { resolveModelCard } from "./stores/settingsStore";
import { pushError, toast } from "./stores/uiStore";
import { transcribe } from "./services/asr";
import { generateAudio } from "./services/audioGen";
import { sendAgentMessage, sendSideChat } from "./agentEngine";
import { errMsg } from "./utils";

/* ---------------- 调参（依据常见麦克风底噪与中文语速） ---------------- */
/** 判定为「在说话」的音量阈值（0~1 的 RMS） */
const SPEAK_RMS = 0.045;
/** 说完之后静音多久算一句结束（毫秒） */
const SILENCE_MS = 900;
/** 一句话最长录多久，防止环境噪音导致无限录制 */
const MAX_UTTER_MS = 30000;
/** 短于这个时长的片段直接丢弃（咳嗽/关门声） */
const MIN_UTTER_MS = 400;
/** 播放回复时，用户音量超过这个值即打断 */
const BARGE_RMS = 0.08;

type Phase = "idle" | "listening" | "recognizing" | "thinking" | "speaking";

export type VoiceState = {
  phase: Phase;
  /** 实时音量 0~1（UI 画波形用） */
  level: number;
  /** 当前这句识别出的文本（识别完成后短暂显示） */
  heard: string;
  error?: string;
};

type Listener = (s: VoiceState) => void;

let state: VoiceState = { phase: "idle", level: 0, heard: "" };
const listeners = new Set<Listener>();

function emit(patch: Partial<VoiceState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
}

export function subscribeVoice(l: Listener): () => void {
  listeners.add(l);
  l(state);
  return () => listeners.delete(l);
}

export function voiceState(): VoiceState {
  return state;
}

/* ---------------- 运行时资源 ---------------- */
let stream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let recorder: MediaRecorder | null = null;
let rafId = 0;
let player: HTMLAudioElement | null = null;
let active = false;
let starting = false;
let callEpoch = 0;
let callAbort: AbortController | null = null;
let finishRecording: (() => void) | null = null;
let finishSpeaking: (() => void) | null = null;
let finishWaiting: (() => void) | null = null;
/** 助手正在回复：这一轮的 running 由 sendSideChat/sendAgentMessage 控制，靠订阅感知结束 */
let unsubAgent: (() => void) | null = null;

/** 当前是否在通话中（UI 与快捷键判断用） */
export function isVoiceCallActive(): boolean {
  return active;
}

function pickMime(): string | undefined {
  const cands = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return cands.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
}

/** 读一帧音量（RMS，0~1） */
function readLevel(): number {
  if (!analyser) return 0;
  const buf = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
}

/** 停掉正在播放的回复（用户插话 / 挂断） */
function stopPlayback() {
  if (player) {
    player.pause();
    player.src = "";
    player = null;
  }
}

/** 录一句话：说话开始 → 静音 SILENCE_MS 结束，返回音频（没说话返回 null） */
function recordUtterance(): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (!stream) return resolve(null);
    const mime = pickMime();
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recorder = rec;
    const chunks: Blob[] = [];
    let spoke = false;
    let lastLoud = performance.now();
    const startedAt = performance.now();
    let done = false;

    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      cancelAnimationFrame(rafId);
      rec.onstop = () => {
        if(recorder===rec)recorder = null;
        if(finishRecording===cancelRecording)finishRecording = null;
        if (!ok || !spoke) return resolve(null);
        resolve(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
      };
      // stop() 会立即变成 inactive，但最后一块 dataavailable 与 stop 事件稍后到达。
      // 必须等真实 stop，不能据 inactive 手动提前 resolve，否则尾部音频丢失。
      try { if(rec.state!=="inactive")rec.stop();else rec.onstop?.(new Event("stop")); }
      catch { resolve(null); }
    };
    const cancelRecording=()=>finish(false);
    finishRecording=cancelRecording;
    rec.onerror=()=>finish(false);

    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.start(120);

    const tick = () => {
      if (!active) return finish(false);
      const lv = readLevel();
      emit({ level: lv });
      const now = performance.now();
      if (lv >= SPEAK_RMS) {
        spoke = true;
        lastLoud = now;
      }
      if (spoke && now - lastLoud >= SILENCE_MS) return finish(now - startedAt >= MIN_UTTER_MS);
      if (now - startedAt >= MAX_UTTER_MS) return finish(spoke);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  });
}

/** 等助手这一轮回复结束（running: true → false） */
function waitAssistantDone(): Promise<void> {
  return new Promise((resolve) => {
    if (!useAgent.getState().running || useAgent.getState().resolver) return resolve();
    unsubAgent?.();
    unsubAgent = useAgent.subscribe((s) => {
      if (!s.running || s.resolver) {
        unsubAgent?.();
        unsubAgent = null;
        finishWaiting=null;
        resolve();
      }
    });
    finishWaiting=()=>{unsubAgent?.();unsubAgent=null;resolve();};
  });
}

/** 朗读一段文本；播放期间监听用户插话，一开口立刻停下（barge-in） */
async function speak(text: string, signal: AbortSignal): Promise<void> {
  const clean = text.replace(/[*#`>_~]/g, "").trim();
  if (!clean) return;
  let card;
  try {
    card = resolveModelCard("audio");
  } catch {
    return; // 没配音频模型 = 只做语音输入，不朗读
  }
  emit({ phase: "speaking" });
  const url = await generateAudio(card, { text: clean.slice(0, 900), signal });
  if (!active || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const a = new Audio(url);
    player = a;
    let stopped = false;
    const end = () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(rafId);
      stopPlayback();
      finishSpeaking=null;
      resolve();
    };
    a.onended = end;
    finishSpeaking=end;
    a.onerror = end;
    void a.play().catch(end);
    // 播放中持续读音量：用户开口即打断
    const watch = () => {
      if (!active || stopped) return;
      const lv = readLevel();
      emit({ level: lv });
      if (lv >= BARGE_RMS) return end();
      rafId = requestAnimationFrame(watch);
    };
    rafId = requestAnimationFrame(watch);
  });
}

/** 通话主循环：听 → 认 → 答 → 读 → 再听 */
async function loop(epoch:number,signal:AbortSignal) {
  while (active && epoch===callEpoch && !signal.aborted) {
    emit({ phase: "listening", heard: "" });
    const blob = await recordUtterance();
    if (!active || epoch!==callEpoch) break;
    if (!blob) continue; // 这一轮没说话，继续听

    emit({ phase: "recognizing", level: 0 });
    let text = "";
    try {
      const card = resolveModelCard("asr");
      text = await transcribe(card, { audio: blob, lang: "zh", signal });
    } catch (e) {
      if(signal.aborted||epoch!==callEpoch)break;
      pushError("语音识别", errMsg(e));
      emit({ phase: "idle", error: errMsg(e) });
      active = false;
      break;
    }
    if (!active || epoch!==callEpoch) break;
    if (!text.trim()) continue; // 识别为空（环境噪音），继续听

    emit({ phase: "thinking", heard: text });
    const st = useAgent.getState();
    st.setDraft(text);
    // 有挂起的抉择问题时，这句话就是对问题的回答（sendAgentMessage 内部已处理）
    if (st.mode === "chat") void sendSideChat();
    else void sendAgentMessage();
    await waitAssistantDone();
    if (!active || epoch!==callEpoch) break;

    const msgs = useAgent.getState().messages;
    const last = [...msgs].reverse().find((m) => m.role === "assistant" && (m.text.trim()||m.question));
    if (last) {
      try {
        await speak(last.question && !last.question.answer ? last.question.text : last.text,signal);
      } catch (e) {
        // 朗读失败不影响继续通话（回复文字已经在面板上）
        if(!signal.aborted)toast(`朗读失败：${errMsg(e)}`, "err");
      }
    }
  }
  if(epoch===callEpoch)stopVoiceCall();
}

function setupAudio(input:MediaStream) {
  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();analyser.fftSize = 1024;
  audioCtx.createMediaStreamSource(input).connect(analyser);
  void audioCtx.resume().catch(()=>{});
}

/** 开始通话：申请麦克风 → 进入循环 */
export async function startVoiceCall(): Promise<void> {
  if (active || starting) return;
  // 前置检查：没配语音识别模型直接给出可操作的中文提示，别等录完再报错
  try {
    resolveModelCard("asr");
  } catch {
    toast("还没配置语音识别模型：设置 → 模型配置 → 给服务商添加「语音识别」模型（如 gpt-4o-transcribe / whisper-1）", "err");
    return;
  }
  starting=true;const epoch=++callEpoch;const controller=new AbortController();callAbort=controller;
  try {
    const acquired = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if(epoch!==callEpoch){acquired.getTracks().forEach(t=>t.stop());return;}stream=acquired;
  } catch (e) {
    if(epoch!==callEpoch)return;
    starting=false;
    toast(`无法使用麦克风：${errMsg(e)}`, "err");
    return;
  }
  try { setupAudio(stream); } catch(e) { stopVoiceCall();toast(`麦克风初始化失败：${errMsg(e)}`,"err");return; }
  starting=false;
  active = true;
  emit({ phase: "listening", level: 0, heard: "", error: undefined });
  void loop(epoch,controller.signal).catch(e=>{if(epoch===callEpoch){pushError("语音通话",errMsg(e));stopVoiceCall();}});
}

/** 挂断：停录音、停播放、释放麦克风 */
export function stopVoiceCall() {
  callEpoch++;starting=false;callAbort?.abort();callAbort=null;
  active = false;
  finishRecording?.();finishRecording=null;
  finishSpeaking?.();finishSpeaking=null;
  finishWaiting?.();finishWaiting=null;
  cancelAnimationFrame(rafId);
  stopPlayback();
  unsubAgent?.();
  unsubAgent = null;
  try {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  } catch {
    /* 忽略 */
  }
  recorder = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  void audioCtx?.close().catch(()=>{});
  audioCtx = null;
  analyser = null;
  emit({ phase: "idle", level: 0, heard: "" });
}

/** 单次语音输入（不进通话循环）：录一句 → 识别 → 填进输入框，由用户确认后发送 */
export async function voiceInputOnce(): Promise<void> {
  if (active || starting) return;
  try {
    resolveModelCard("asr");
  } catch {
    toast("还没配置语音识别模型：设置 → 模型配置 → 添加「语音识别」模型", "err");
    return;
  }
  starting=true;const epoch=++callEpoch;const controller=new AbortController();callAbort=controller;
  try {
    const acquired = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    if(epoch!==callEpoch){acquired.getTracks().forEach(t=>t.stop());return;}stream=acquired;
  } catch (e) {
    if(epoch!==callEpoch)return;starting=false;
    toast(`无法使用麦克风：${errMsg(e)}`, "err");
    return;
  }
  try { setupAudio(stream); } catch(e) { stopVoiceCall();toast(`麦克风初始化失败：${errMsg(e)}`,"err");return; }
  starting=false;
  active = true;
  emit({ phase: "listening", level: 0, heard: "" });
  try {
    const blob = await recordUtterance();
    if (blob) {
      emit({ phase: "recognizing" });
      const text = await transcribe(resolveModelCard("asr"), { audio: blob, lang: "zh", signal:controller.signal });
      if(epoch!==callEpoch)return;
      if (text.trim()) {
        const cur = useAgent.getState().draft;
        useAgent.getState().setDraft(cur ? `${cur} ${text}` : text);
      } else {
        toast("没听清，请再说一次", "err");
      }
    }
  } catch (e) {
    if(!controller.signal.aborted)pushError("语音识别", errMsg(e));
  } finally {
    if(epoch===callEpoch)stopVoiceCall();
  }
}
