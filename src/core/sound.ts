/**
 * 任务提示音 / 语音播报 — 完成与报错的听觉反馈
 * 内置提示音用 WebAudio 现场合成（无资源文件）；可在 设置 → 音效提醒 里
 * 上传自定义音频、调音量、开启系统 TTS 语音播报（播报节点名与结果）。
 */
import { useSettings } from "./stores/settingsStore";

let ctx: AudioContext | null = null;
function audioCtx(): AudioContext {
  return (ctx ??= new AudioContext());
}

/** 合成一串正弦音（f 频率 Hz、t 起始秒、d 时长秒） */
function beep(seq: { f: number; t: number; d: number }[], volume: number) {
  try {
    const ac = audioCtx();
    for (const { f, t, d } of seq) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0, ac.currentTime + t);
      g.gain.linearRampToValueAtTime(volume * 0.5, ac.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + t + d);
      o.connect(g).connect(ac.destination);
      o.start(ac.currentTime + t);
      o.stop(ac.currentTime + t + d + 0.05);
    }
  } catch {
    /* 音频设备不可用时静默 */
  }
}

function playCustom(src: string, volume: number) {
  try {
    const a = new Audio(src);
    a.volume = Math.min(1, Math.max(0, volume));
    void a.play();
  } catch {
    /* 忽略 */
  }
}

/** 完成提示音（自定义音频优先，否则内置上扬双音） */
export function playDone() {
  const { sound } = useSettings.getState().settings;
  if (!sound.enabled) return;
  if (sound.doneAudio) playCustom(sound.doneAudio, sound.volume);
  else beep([{ f: 880, t: 0, d: 0.12 }, { f: 1318, t: 0.12, d: 0.24 }], sound.volume);
}

/** 报错提示音（自定义音频优先，否则内置下沉双音） */
export function playError() {
  const { sound } = useSettings.getState().settings;
  if (!sound.enabled) return;
  if (sound.errAudio) playCustom(sound.errAudio, sound.volume);
  else beep([{ f: 330, t: 0, d: 0.15 }, { f: 220, t: 0.16, d: 0.3 }], sound.volume);
}

/** 系统 TTS 播报（需开启语音播报） */
export function speak(text: string) {
  const { sound } = useSettings.getState().settings;
  if (!sound.enabled || !sound.speak) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-CN";
    u.volume = Math.min(1, Math.max(0, sound.volume));
    speechSynthesis.cancel(); // 连续任务时不排队积压
    speechSynthesis.speak(u);
  } catch {
    /* 无可用语音时静默 */
  }
}

export function notifyDone(label: string) {
  playDone();
  speak(`${label}完成`);
}

export function notifyError(label: string) {
  playError();
  speak(`${label}出错`);
}
