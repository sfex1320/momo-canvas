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
  return new Promise((res, rej) => {
    if (v.readyState >= 1) return res();
    v.onloadedmetadata = () => res();
    v.onerror = () => rej(new Error("视频加载失败：源可能已过期（中转站直链一般 24 小时失效），可重新生成或改用本地文件"));
  });
}

function seekTo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("视频定位超时")), 15000);
    v.onseeked = () => {
      clearTimeout(timer);
      res();
    };
    v.currentTime = t;
  });
}

/** 抽帧：point = first/last/custom(timeSec)，返回 PNG dataURL 与视频时长 */
export async function grabFrame(
  src: string,
  point: "first" | "last" | "custom",
  timeSec?: number,
): Promise<{ dataUrl: string; duration: number }> {
  const v = makeVideo(src);
  await loadMeta(v);
  const dur = Number.isFinite(v.duration) ? v.duration : 0;
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
async function recordSegments(
  segs: { src: string; start?: number; end?: number }[],
  onProgress?: (msg: string) => void,
): Promise<string> {
  // 先取全部片段时长，用于进度显示与画布尺寸（取第一段的分辨率）
  const metas: { v: HTMLVideoElement; start: number; end: number }[] = [];
  for (const s of segs) {
    const v = makeVideo(s.src);
    await loadMeta(v);
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    const start = Math.min(Math.max(0, s.start ?? 0), Math.max(0, dur - 0.05));
    const end = Math.min(s.end && s.end > start ? s.end : dur, dur);
    metas.push({ v, start, end });
  }
  const total = metas.reduce((sum, m) => sum + (m.end - m.start), 0);
  if (total <= 0.1) throw new Error("片段总时长为 0，请检查起止时间");

  const first = metas[0].v;
  const c = document.createElement("canvas");
  c.width = first.videoWidth || 1280;
  c.height = first.videoHeight || 720;
  const ctx = c.getContext("2d")!;

  // 音频：各视频经 AudioContext 汇入同一路输出（元素静音不影响采集）
  const ac = new AudioContext();
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
  let tainted = false;
  rec.start(250);
  try {
    for (const [i, m] of metas.entries()) {
      const v = m.v;
      v.muted = false;
      v.volume = 1;
      await seekTo(v, m.start);
      await v.play();
      await new Promise<void>((res, rej) => {
        let raf = 0;
        const tick = () => {
          try {
            ctx.drawImage(v, 0, 0, c.width, c.height);
          } catch {
            tainted = true;
          }
          const segDone = elapsed + Math.max(0, v.currentTime - m.start);
          onProgress?.(`重编码中 ${Math.min(99, Math.round((segDone / total) * 100))}%（第 ${i + 1}/${metas.length} 段）`);
          if (v.ended || v.currentTime >= m.end) {
            v.pause();
            cancelAnimationFrame(raf);
            res();
            return;
          }
          raf = requestAnimationFrame(tick);
        };
        v.onerror = () => rej(new Error("视频播放出错"));
        raf = requestAnimationFrame(tick);
      });
      elapsed += m.end - m.start;
    }
  } finally {
    rec.stop();
    await done;
    void ac.close();
    for (const m of metas) {
      m.v.pause();
      m.v.src = "";
    }
  }
  if (tainted) throw new Error(CROSS_HINT);
  const blob = new Blob(chunks, { type: "video/webm" });
  if (blob.size < 20_000) throw new Error("录制结果为空，可能是视频无法解码或被跨域保护");
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
  await loadMeta(v);
  const dur = Number.isFinite(v.duration) ? v.duration : 0;
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
    await loadMeta(v);
    return Number.isFinite(v.duration) ? v.duration : 0;
  } catch {
    return 0;
  }
}
