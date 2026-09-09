/**
 * 本地视频处理 — 取帧 / 取段 / 拼接（零模型成本）
 *  取帧：<video> 定位 + canvas 抽帧 → dataURL
 *  取段/拼接：实验性方案——canvas.captureStream + AudioContext 混音 + MediaRecorder
 *  实时重编码（处理时长 ≈ 片段实际时长），输出 webm。跨域且无 CORS 头的视频无法处理
 *  （canvas 会被污染），报中文错误提示先保存到本地再拖入。
 */

const CROSS_HINT = "视频源不允许跨域读取（画面被浏览器保护）。请先把视频保存到本地，再拖回画布作为输入。";

function makeVideo(src: string): HTMLVideoElement {
  const v = document.createElement("video");
  v.crossOrigin = "anonymous";
  v.preload = "auto";
  v.muted = true;
  v.src = src;
  return v;
}

function loadMeta(v: HTMLVideoElement): Promise<void> {
  return new Promise((resolve,reject)=>{
    if(v.readyState>=1)return resolve();
    const finish=(error?:Error)=>{clearTimeout(timer);v.onloadedmetadata=null;v.onerror=null;error?reject(error):resolve();};
    const timer=setTimeout(()=>finish(new Error("视频加载超时，请检查素材是否在线")),30000);
    v.onloadedmetadata=()=>finish();v.onerror=()=>finish(new Error("视频加载失败，请重新导入素材"));
  });
}
function seekTo(v: HTMLVideoElement,t:number):Promise<void>{
  return new Promise((resolve,reject)=>{
    if(Math.abs(v.currentTime-t)<0.001&&v.readyState>=2&&!v.seeking)return resolve();
    const finish=(error?:Error)=>{clearTimeout(timer);v.onseeked=null;v.onloadeddata=null;error?reject(error):resolve();};
    const timer=setTimeout(()=>finish(new Error("视频定位超时")),15000);
    v.onseeked=()=>finish();v.onloadeddata=()=>{if(Math.abs(v.currentTime-t)<0.05&&!v.seeking)finish();};v.currentTime=t;
  });
}

/** MediaRecorder 的 WebM 可能没有 duration 头；定位到末端促使浏览器读出实际时长。 */
async function mediaDuration(v:HTMLVideoElement):Promise<number>{
  await loadMeta(v);
  if(Number.isFinite(v.duration)&&v.duration>0)return v.duration;
  await seekTo(v,1e7);
  const duration=Number.isFinite(v.duration)?v.duration:v.currentTime;
  if(!Number.isFinite(duration)||duration<=0||duration>=1e7)throw new Error("无法读取视频时长，请转换为带时长信息的视频");
  await seekTo(v,0);return duration;
}

/** 抽帧：point = first/last/custom(timeSec)，返回 PNG dataURL 与视频时长 */
export async function grabFrame(
  src: string,
  point: "first" | "last" | "custom",
  timeSec?: number,
): Promise<{ dataUrl: string; duration: number }> {
  const v = makeVideo(src);
  const dur = await mediaDuration(v);
  const t =
    point === "first"
      ? Math.min(0.05, dur)
      : point === "last"
        ? Math.max(0, dur - 0.08)
        : Math.min(Math.max(0, timeSec ?? 0), Math.max(0, dur - 0.02));
  await seekTo(v, t);
  const c = document.createElement("canvas");
  c.width = v.videoWidth || 1280;
  c.height = v.videoHeight || 720;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("无法创建画布上下文");
  ctx.drawImage(v, 0, 0);
  try {
    return { dataUrl: c.toDataURL("image/png"), duration: dur };
  } catch {
    throw new Error(CROSS_HINT);
  }
}

function pickMime(): string {
  const cands = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', "video/webm"];
  for (const m of cands) if (MediaRecorder.isTypeSupported(m)) return m;
  throw new Error("当前环境不支持视频录制（MediaRecorder）");
}

/**
 * 实时重编码引擎：把若干 (src, start, end) 片段按顺序画到 canvas 并混入音频，
 * 用 MediaRecorder 录成一条 webm。取段 = 单片段；拼接 = 多片段。
 */
export async function recordSegments(
  segs: { src: string; start?: number; end?: number }[],
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  // 先取全部片段时长，用于进度显示与画布尺寸（取第一段的分辨率）
  const metas: { v: HTMLVideoElement; start: number; end: number }[] = [];
  for (const s of segs) {
    signal?.throwIfAborted();
    const v = makeVideo(s.src);
    const dur = await mediaDuration(v);
    const start = Math.min(Math.max(0, s.start ?? 0), Math.max(0, dur - 0.05));
    const end = Math.min(s.end && s.end > start ? s.end : dur, dur);
    metas.push({ v, start, end });
  }
  const total = metas.reduce((sum, m) => sum + (m.end - m.start), 0);
  if (total <= 0.1) throw new Error("片段总时长为 0，请检查起止时间");

  signal?.throwIfAborted();
  const first = metas[0].v;
  const c = document.createElement("canvas");
  c.width = first.videoWidth || 1280;
  c.height = first.videoHeight || 720;
  const ctx = c.getContext("2d")!;

  // 音频：各视频经 AudioContext 汇入同一路输出（元素静音不影响采集）
  const ac = new AudioContext();
  await ac.resume();
  const dest = ac.createMediaStreamDestination();
  for (const m of metas) {
    try {
      const node = ac.createMediaElementSource(m.v);
      node.connect(dest);
    } catch {
      /* 跨域无 CORS 的源取不到音频，画面仍可尝试 */
    }
  }

  const stream = c.captureStream(30);
  for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
  const rec = new MediaRecorder(stream, { mimeType: pickMime(), videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const done = new Promise<void>((res) => (rec.onstop = () => res()));

  let elapsed = 0;
  rec.start(250);
  try {
    for (const [i, m] of metas.entries()) {
      signal?.throwIfAborted();
      const v = m.v;
      v.muted = false;
      v.volume = 1;
      await seekTo(v, m.start);
      await v.play();
      await new Promise<void>((resolve,reject)=>{
        let raf=0,lastTime=v.currentTime,lastAdvance=performance.now();
        const finish=(error?:unknown)=>{cancelAnimationFrame(raf);signal?.removeEventListener("abort",abort);v.onerror=null;v.pause();error?reject(error):resolve();};
        const abort=()=>finish(new DOMException("已取消","AbortError"));
        signal?.addEventListener("abort",abort,{once:true});
        const tick=()=>{try{
          signal?.throwIfAborted();
          ctx.drawImage(v,0,0,c.width,c.height);
          if(v.currentTime>lastTime){lastTime=v.currentTime;lastAdvance=performance.now();}
          if(performance.now()-lastAdvance>20000)throw new Error("视频播放停滞，请检查素材或前台运行后重试");
          const current=elapsed+Math.max(0,v.currentTime-m.start);
          onProgress?.(`重编码中 ${Math.min(99,Math.round(current/total*100))}%（第 ${i+1}/${metas.length} 段）`);
          if(v.ended||v.currentTime>=m.end)finish();else raf=requestAnimationFrame(tick);
        }catch(e){finish(e);}};
        v.onerror=()=>finish(new Error("视频播放出错"));tick();
      });
      elapsed += m.end - m.start;
    }
  } finally {
    if(rec.state!=="inactive")rec.stop();
    await done;
    stream.getTracks().forEach(t=>t.stop());
    void ac.close();
    for (const m of metas) {
      m.v.pause();
      m.v.src = "";
    }
  }

  const blob = new Blob(chunks, { type: "video/webm" });
  if (blob.size < 100) throw new Error("录制结果为空，可能是视频无法解码或被跨域保护");
  return URL.createObjectURL(blob);
}

/** 取段：截取 [start, end] 输出新视频（webm blob URL） */
export function trimVideo(
  src: string,
  start: number,
  end: number | undefined,
  onProgress?: (msg: string) => void,
): Promise<string> {
  return recordSegments([{ src, start, end }], onProgress);
}

/** 拼接：多段视频按顺序合成一条（分辨率取第一段，其余缩放适配） */
export function concatVideos(srcs: string[], onProgress?: (msg: string) => void): Promise<string> {
  return recordSegments(srcs.map((src) => ({ src })), onProgress);
}

/**
 * 视频配音：把音频混入/替换视频原声，本地实时重编码输出 webm
 *  replace = 只保留新音频；mix = 原声与新音频叠加。音频短于视频则后段静音，长于视频则截断。
 */
export async function dubVideo(
  videoSrc: string,
  audioSrc: string,
  mode: "replace" | "mix",
  onProgress?: (msg: string) => void,
): Promise<string> {
  const v = makeVideo(videoSrc);
  const dur = await mediaDuration(v);
  if (dur <= 0.1) throw new Error("上游视频时长为 0，无法配音");

  const c = document.createElement("canvas");
  c.width = v.videoWidth || 1280;
  c.height = v.videoHeight || 720;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("无法创建画布上下文");

  const ac = new AudioContext();
  const dest = ac.createMediaStreamDestination();
  // 新音频一路
  const a = document.createElement("audio");
  a.crossOrigin = "anonymous";
  a.preload = "auto";
  a.src = audioSrc;
  await new Promise<void>((res, rej) => {
    if (a.readyState >= 1) return res();
    a.onloadedmetadata = () => res();
    a.onerror = () => rej(new Error("音频加载失败：源可能已过期或格式不支持"));
  });
  try {
    ac.createMediaElementSource(a).connect(dest);
  } catch {
    void ac.close();
    throw new Error(CROSS_HINT);
  }
  // mix 模式再接入视频原声
  if (mode === "mix") {
    try {
      ac.createMediaElementSource(v).connect(dest);
    } catch {
      /* 原声跨域取不到就只用新音频 */
    }
  }

  const stream = c.captureStream(30);
  for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
  const rec = new MediaRecorder(stream, { mimeType: pickMime(), videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const done = new Promise<void>((res) => (rec.onstop = () => res()));

  let tainted = false;
  rec.start(250);
  try {
    v.muted = mode !== "mix"; // replace：原声不出（也没接进采集）；mix：经 AudioContext 采集
    if (mode === "mix") {
      v.muted = false;
      v.volume = 1;
    }
    a.volume = 1;
    await v.play();
    void a.play().catch(() => undefined);
    await new Promise<void>((res, rej) => {
      let raf = 0;
      const tick = () => {
        try {
          ctx.drawImage(v, 0, 0, c.width, c.height);
        } catch {
          tainted = true;
        }
        onProgress?.(`配音重编码中 ${Math.min(99, Math.round((v.currentTime / dur) * 100))}%`);
        if (v.ended || v.currentTime >= dur - 0.03) {
          v.pause();
          a.pause();
          cancelAnimationFrame(raf);
          res();
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      v.onerror = () => rej(new Error("视频播放出错"));
      raf = requestAnimationFrame(tick);
    });
  } finally {
    rec.stop();
    await done;
    void ac.close();
    v.src = "";
    a.src = "";
  }
  if (tainted) throw new Error(CROSS_HINT);
  const blob = new Blob(chunks, { type: "video/webm" });
  if (blob.size < 20_000) throw new Error("录制结果为空，可能是视频无法解码或被跨域保护");
  return URL.createObjectURL(blob);
}

/** 读视频时长（秒），失败返回 0 */
export async function videoDuration(src: string): Promise<number> {
  try {
    const v = makeVideo(src);
    const duration=await mediaDuration(v);
    v.removeAttribute("src");v.load();return duration;
  } catch {
    return 0;
  }
}

/**
 * 从视频提取一段音频并编码 16bit PCM WAV（声线参考用：提取后入资产库，拖到其他片段的音频参考格）。
 * WebView2 里 asset:// 的视频无法直接喂给 AudioContext，调用方需先转 blob URL。
 */
export async function extractAudioWav(videoUrl: string, startSec?: number, endSec?: number): Promise<Blob> {
  const buf = await (await fetch(videoUrl)).arrayBuffer();
  const Ctx = window.AudioContext;
  if (!Ctx) throw new Error("当前环境不支持音频解码");
  const ctx = new Ctx();
  let audio: AudioBuffer;
  try {
    audio = await ctx.decodeAudioData(buf);
  } finally {
    void ctx.close();
  }
  const sr = audio.sampleRate;
  const s = Math.max(0, Math.floor((startSec ?? 0) * sr));
  const e = Math.min(audio.length, Math.ceil((endSec ?? audio.duration) * sr));
  const frames = Math.max(0, e - s);
  if (!frames) throw new Error("提取区间为空");
  const chs = Math.max(1, Math.min(2, audio.numberOfChannels));
  // 交错声道
  const data = new Float32Array(frames * chs);
  for (let c = 0; c < chs; c++) {
    const src = audio.getChannelData(Math.min(c, audio.numberOfChannels - 1));
    for (let i = 0; i < frames; i++) data[i * chs + c] = src[s + i];
  }
  // WAV 头 + PCM16 编码
  const bytes = 44 + data.length * 2;
  const out = new ArrayBuffer(bytes);
  const v = new DataView(out);
  const ws = (o: number, str: string) => {
    for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i));
  };
  ws(0, "RIFF");
  v.setUint32(4, bytes - 8, true);
  ws(8, "WAVE");
  ws(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, chs, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * chs * 2, true);
  v.setUint16(32, chs * 2, true);
  v.setUint16(34, 16, true);
  ws(36, "data");
  v.setUint32(40, data.length * 2, true);
  let o = 44;
  for (let i = 0; i < data.length; i++, o += 2) {
    const x = Math.max(-1, Math.min(1, data[i]));
    v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([out], { type: "audio/wav" });
}
