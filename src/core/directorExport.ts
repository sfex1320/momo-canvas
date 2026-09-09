/**
 * 导演台导出工具 — Premiere FCP7 XML + 音频 TTS 生成 + 标准交付包
 *
 * 方案 §9：directorExport.ts 连接时间线数据与现有 videoEdit.ts，后续接 FFmpeg。
 * 方案 §23.6：标准交付包目录结构。
 * 方案 §23.5：音频导演台 TTS 生成。
 */
import { generateAudio } from "./services/audioGen";
import { resolveModelCard } from "./stores/settingsStore";
import { useAssets } from "./stores/assetStore";
import { useDirector } from "./stores/directorStore";
import { assetUrl } from "./services/assetFiles";
import { uid } from "./utils";
import { pushError } from "./stores/uiStore";
import { deriveTimeline } from "./directorEngine";
import type { DirectorProject, DirectorAudioTrack, DirectorAudioKind, DirectorTimelineEntry, DirectorSegment } from "./types";

/* ================ 时长策略（方案 §23.5） ================ */

/** 读取一段音频的实际时长（秒） */
export function audioDuration(src: string): Promise<number> {
  return new Promise((resolve) => {
    const a = document.createElement("audio");
    a.preload = "metadata";
    a.onloadedmetadata = () => resolve(a.duration || 0);
    a.onerror = () => resolve(0);
    a.src = src;
  });
}

/**
 * 对白优先策略（方案 §23.5）：先为每段的对白生成 TTS，
 * 测得真实时长后据此调整 segment 的 durationSec（让画面迁就对白）。
 *
 * @param onSegUpdate 每段时长更新后回调（UI 可实时刷新）
 * @returns 更新后的 segments（时长已按对白调整）
 */
export async function dialogueFirstStrategy(
  projectId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ adjusted: number; skipped: number }> {
  const initialProj = useDirector.getState().getById(projectId);
  if (!initialProj) return { adjusted: 0, skipped: 0 };

  // 收集有对白绑定、且对白已生成音频的片段
  const dialogueTracks = (initialProj.audioTracks ?? []).filter(
    (t) => t.kind === "dialogue" && t.segmentId && t.assetId,
  );
  const total = dialogueTracks.length;
  let adjusted = 0;
  let done = 0;

  for (const track of dialogueTracks) {
    done++;
    onProgress?.(done, total);
    const asset = useAssets.getState().items.find((a) => a.id === track.assetId);
    if (!asset) continue;
    const dur = await audioDuration(assetUrl(asset.path));
    if (!dur) continue;
    // 每轮重读最新项目（前一轮可能已改 durationSec，不能用过期快照）
    const cur = useDirector.getState().getById(projectId);
    if (!cur) break;
    const scenes = cur.scenes.map((s) => ({
      ...s,
      segments: s.segments.map((seg): DirectorSegment => {
        if (seg.id !== track.segmentId) return seg;
        if (seg.locked) return seg; // 锁定片段不调整
        // 对白时长 + 1 秒缓冲（让画面比对白稍长，留出镜头起止）
        const newDur = Math.ceil(dur + 1);
        if (Math.abs(newDur - seg.durationSec) < 1) return seg; // 差距太小不调
        adjusted++;
        // 联动 shots：按比例缩放 shot 时间到新时长（#28 修复）
        const ratio = newDur / seg.durationSec;
        const scaledShots = seg.shots.length
          ? seg.shots.map((sh) => ({
              ...sh,
              startSec: Math.round(sh.startSec * ratio * 10) / 10,
              endSec: Math.round(sh.endSec * ratio * 10) / 10,
            }))
          : seg.shots;
        return { ...seg, durationSec: newDur, shots: scaledShots };
      }),
    }));
    useDirector.getState().updateProject(projectId, { scenes });
  }

  return { adjusted, skipped: total - adjusted };
}

/**
 * 画面优先策略（方案 §23.5）：画面时长锁定后，
 * 让 TTS 的语速适配片段时长（对白长的加快语速，对白短的放慢）。
 *
 * 当前实现：为每段对白生成 TTS，测时长后给出建议语速（不自动重新生成，
 * 因为大部分 TTS API 的 speed 参数粒度粗，频繁重生成成本高）。
 *
 * @returns 每段对白的建议语速调整
 */
export async function videoFirstStrategy(
  projectId: string,
): Promise<Array<{ segmentId: string; trackId: string; dialogueSec: number; videoSec: number; suggestedSpeed: number }>> {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return [];
  const out: Array<{ segmentId: string; trackId: string; dialogueSec: number; videoSec: number; suggestedSpeed: number }> = [];

  for (const track of proj.audioTracks ?? []) {
    if (track.kind !== "dialogue" || !track.segmentId || !track.assetId) continue;
    const asset = useAssets.getState().items.find((a) => a.id === track.assetId);
    if (!asset) continue;
    const dialogueSec = await audioDuration(assetUrl(asset.path));
    const seg = proj.scenes.flatMap((s) => s.segments).find((x) => x.id === track.segmentId);
    if (!seg) continue;
    const videoSec = seg.durationSec;
    // 建议语速 = 对白时长 / 画面时长（>1 = 需加快，<1 = 可放慢）
    const suggestedSpeed = dialogueSec > 0 ? Math.max(0.5, Math.min(2, dialogueSec / videoSec)) : 1;
    out.push({ segmentId: track.segmentId, trackId: track.id, dialogueSec, videoSec, suggestedSpeed });
  }
  return out;
}

/* ================ Premiere FCP7 XML 导出（方案 §23.6） ================ */

/**
 * 生成 Final Cut Pro 7 XML（可导入 Premiere Pro / DaVinci Resolve / Final Cut Pro X）。
 *
 * @param assetPaths assetId → 本地文件路径（调用方从 take.assetId / track.assetId 查）
 */
export function generatePremiereXml(
  project: DirectorProject,
  assetPaths: Map<string, string>,
): string {
  const timeline = project.timeline;
  const fps = project.ruleSet?.generation.fps ?? 30;

  // 素材定义（每个时间线条目 = 一个 clipitem）
  const clips: string[] = [];
  let cursor = 0; // 当前时间线游标（秒）

  timeline.forEach((entry: DirectorTimelineEntry, i: number) => {
    const seg = findSegment(project, entry.segmentId);
    if (!seg) return;
    const take = (seg.takes ?? []).find((t) => t.id === entry.takeId);
    const assetId = take?.assetId;
    const path = assetId ? assetPaths.get(assetId) ?? "" : "";
    const start = cursor;
    const end = cursor + entry.durationSec;
    cursor = end;

    // FCP XML 用帧为单位的时间
    const sFrame = (t: number) => Math.round(t * fps).toString();

    clips.push(`
        <clipitem id="clipitem-${i}">
          <name>${escapeXml(seg.summary.slice(0, 30) || `片段 ${i + 1}`)}</name>
          <enabled>TRUE</enabled>
          <duration>${sFrame(entry.durationSec)}</duration>
          <rate><timebase>${fps}</timebase></rate>
          <start>${sFrame(start)}</start>
          <end>${sFrame(end)}</end>
          <in>0</in>
          <out>${sFrame(entry.durationSec)}</out>
          <file id="file-${i}">
            <name>${escapeXml(path.split(/[\\/]/).pop() || `clip-${i}.mp4`)}</name>
            <pathurl>${escapeXml(toFileUrl(path))}</pathurl>
            <rate><timebase>${fps}</timebase></rate>
            <duration>${sFrame(entry.durationSec)}</duration>
            <media>
              <video>
                <samplecharacteristics>
                  <rate><timebase>${fps}</timebase></rate>
                  <width>${project.aspect === "9:16" ? 1080 : 1920}</width>
                  <height>${project.aspect === "9:16" ? 1920 : 1080}</height>
                </samplecharacteristics>
              </video>
              <audio>
                <samplecharacteristics>
                  <rate><timebase>${fps}</timebase></rate>
                  <depth>16</depth>
                  <channels>2</channels>
                </samplecharacteristics>
              </audio>
            </media>
          </file>
          <subclipinfo>
            <name>${escapeXml(seg.summary.slice(0, 30))}</name>
          </subclipinfo>
        </clipitem>`);
  });

  // 音频轨
  const audioTracks = project.audioTracks ?? [];
  const tracksByKind: Record<DirectorAudioKind, DirectorAudioTrack[]> = {
    dialogue: audioTracks.filter((t) => t.kind === "dialogue"),
    narration: audioTracks.filter((t) => t.kind === "narration"),
    sfx: audioTracks.filter((t) => t.kind === "sfx"),
    ambient: audioTracks.filter((t) => t.kind === "ambient"),
    music: audioTracks.filter((t) => t.kind === "music"),
  };
  const audioTrackXml = (kind: DirectorAudioKind, label: string): string => {
    const tracks = tracksByKind[kind] ?? [];
    if (!tracks.length) return "";
    const clipsXml = tracks.map((t, i) => {
      const seg = t.segmentId ? findSegment(project, t.segmentId) : null;
      const path = t.assetId ? assetPaths.get(t.assetId) ?? "" : "";
      const dur = seg?.durationSec ?? 5;
      const start = seg ? timelinePositionOf(project, t.segmentId!) : i * dur;
      return `
        <clipitem id="audio-${kind}-${i}">
          <name>${escapeXml(t.text.slice(0, 30) || `${label} ${i + 1}`)}</name>
          <enabled>TRUE</enabled>
          <duration>${Math.round(dur * (project.ruleSet?.generation.fps ?? 30))}</duration>
          <rate><timebase>${project.ruleSet?.generation.fps ?? 30}</timebase></rate>
          <start>${Math.round(start * (project.ruleSet?.generation.fps ?? 30))}</start>
          <end>${Math.round((start + dur) * (project.ruleSet?.generation.fps ?? 30))}</end>
          <in>0</in>
          <out>${Math.round(dur * (project.ruleSet?.generation.fps ?? 30))}</out>
          <file id="audio-file-${kind}-${i}">
            <name>${escapeXml(t.text.slice(0, 20) || `${label}.wav`)}</name>
            <pathurl>${escapeXml(toFileUrl(path))}</pathurl>
          </file>
        </clipitem>`;
    }).join("");
    return `
      <track>
        ${clipsXml}
      </track>`;
  };

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="seq-${uid(6)}">
    <name>${escapeXml(project.name)}</name>
    <rate><timebase>${fps}</timebase></rate>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            <rate><timebase>${fps}</timebase></rate>
            <width>${project.aspect === "9:16" ? 1080 : 1920}</width>
            <height>${project.aspect === "9:16" ? 1920 : 1080}</height>
          </samplecharacteristics>
        </format>
        <track>
          ${clips.join("")}
        </track>
      </video>
      <audio>
        ${audioTrackXml("dialogue", "对白")}
        ${audioTrackXml("narration", "旁白")}
        ${audioTrackXml("sfx", "音效")}
        ${audioTrackXml("ambient", "环境音")}
        ${audioTrackXml("music", "音乐")}
      </audio>
    </media>
  </sequence>
</xmeml>`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!));
}

/** Windows/macOS/Linux 本地路径 → FCP7 XML 的 file://localhost/ URL（P2-7 修复） */
function toFileUrl(path: string): string {
  if (!path) return "";
  // 已经是 file:// 开头
  if (/^file:\/\//i.test(path)) return path;
  // Windows 路径 C:\Users\... → file://localhost/C:/Users/...
  const normalized = path.replace(/\\/g, "/");
  // encodeURI 处理中文/空格，但保留 / 和 :
  const encoded = encodeURI(normalized).replace(/%3A/g, ":").replace(/%5C/g, "/");
  if (/^[a-zA-Z]:/.test(normalized)) {
    return `file://localhost/${encoded}`;
  }
  // Unix 绝对路径 /home/... → file://localhost/home/...
  if (normalized.startsWith("/")) return `file://localhost${encoded}`;
  return `file://localhost/${encoded}`;
}

function findSegment(project: DirectorProject, segId: string) {
  for (const s of project.scenes) {
    const seg = s.segments.find((x) => x.id === segId);
    if (seg) return seg;
  }
  return undefined;
}

function timelinePositionOf(project: DirectorProject, segId: string): number {
  // 按 timeline（只含采用片段）累加，与视频轨 cursor 对齐，避免缺片导致音画错位
  let cursor = 0;
  for (const entry of project.timeline) {
    if (entry.segmentId === segId) return cursor;
    cursor += entry.durationSec;
  }
  // 不在 timeline 里的片段（未采用/缺片）退回按 scenes 累加
  for (const scene of project.scenes) {
    for (const seg of scene.segments) {
      if (seg.id === segId) return cursor;
      cursor += seg.durationSec;
    }
  }
  return 0;
}

/* ================ 音频 TTS 生成（方案 §23.5） ================ */

/** 为一条音频轨道生成 TTS 朗读 */
export async function generateAudioTrack(
  projectId: string,
  trackId: string,
): Promise<void> {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  const track = (proj.audioTracks ?? []).find((t) => t.id === trackId);
  if (!track) return;

  try {
    const card = resolveModelCard("audio");
    const dataUrl = await generateAudio(card, {
      text: track.text,
      voice: track.voice,
    });
    if (!dataUrl) throw new Error("音频生成未返回结果");
    const asset = await useAssets.getState().collect({
      src: dataUrl,
      kind: "audio",
      prompt: track.text,
      model: card.model,
    });
    if (!asset) throw new Error("音频资产收录失败");
    // 3.5 P2：绑定项目文件夹时镜像到 分段资产库/NN_标题/音频/
    if (track.segmentId) {
      const { mirrorProjectAsset } = await import("./studio/projectAssetRouter");
      const segTitle = useDirector.getState().getById(projectId)?.scenes.flatMap((sc) => sc.segments).find((x) => x.id === track.segmentId)?.summary.slice(0, 20);
      void mirrorProjectAsset({ projectId, segmentId: track.segmentId, category: "audio", assetId: asset.id, segTitle });
    }
    // 写回项目
    const audioTracks = (proj.audioTracks ?? []).map((t) =>
      t.id === trackId
        ? { ...t, assetId: asset.id, takes: [...(t.takes ?? []), { id: uid(6), assetId: asset.id }] }
        : t,
    );
    useDirector.getState().updateProject(projectId, { audioTracks });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    pushError("导演台 · 音频生成", msg);
    throw e;
  }
}

/** 新建一条音频轨道 */
export function createAudioTrack(
  projectId: string,
  kind: DirectorAudioKind,
  text: string,
  segmentId?: string,
  sceneId?: string,
): DirectorAudioTrack {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) throw new Error("项目不存在");
  const track: DirectorAudioTrack = {
    id: uid(8),
    kind,
    text,
    segmentId,
    sceneId,
  };
  useDirector.getState().updateProject(projectId, {
    audioTracks: [...(proj.audioTracks ?? []), track],
  });
  return track;
}

/** 把音频轨道按时间线导出为资产地址列表（供 SeqPlayer 预览或交付） */
export function collectAudioUrls(project: DirectorProject): string[] {
  const assets = useAssets.getState().items;
  const urls: string[] = [];
  for (const track of project.audioTracks ?? []) {
    if (!track.assetId) continue;
    const asset = assets.find((a) => a.id === track.assetId);
    if (asset) urls.push(assetUrl(asset.path));
  }
  return urls;
}

/* ================ 剪映稳定交付包（公开格式，方案 §23.6） ================ */

/** 秒 → SRT 时间码（HH:MM:SS,mmm） */
function srtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

/** 从项目对白生成 SRT 字幕文本（按时间线顺序，只含采用片段） */
export function generateSrt(project: DirectorProject): string {
  const dialogueTracks = (project.audioTracks ?? []).filter((t) => t.kind === "dialogue" || t.kind === "narration");
  if (!dialogueTracks.length) return "";
  const lines: string[] = [];
  let idx = 1;
  let cursor = 0;
  // 按 deriveTimeline（只含采用片段，与视频轨一致）累加，缺片不会造成字幕错位
  for (const entry of deriveTimeline(project)) {
    const seg = findSegment(project, entry.segmentId);
    if (!seg) continue;
    const track = dialogueTracks.find((t) => t.segmentId === seg.id);
    if (!track || !track.text.trim()) {
      cursor += entry.durationSec;
      continue;
    }
    lines.push(String(idx++));
    lines.push(`${srtTime(cursor)} --> ${srtTime(cursor + entry.durationSec)}`);
    lines.push(track.text);
    lines.push("");
    cursor += entry.durationSec;
  }
  return lines.join("\n");
}

/** 生成镜头清单 CSV（可在 Excel / 剪映 / Premiere 参考用） */
export function generateShotList(project: DirectorProject): string {
  const rows: string[] = ["序号,场景,片段摘要,时长(秒),景别,机位,动作,采用状态"];
  let i = 1;
  for (const scene of project.scenes) {
    for (const seg of scene.segments) {
      const approved = seg.takes?.some((t) => t.id === seg.approvedTakeId && t.status === "done");
      for (const shot of seg.shots) {
        rows.push([
          i++,
          csvField(scene.location),
          csvField(seg.summary),
          seg.durationSec,
          csvField(shot.shotSize),
          csvField(shot.camera),
          csvField(shot.action),
          approved ? "已采用" : "缺片",
        ].join(","));
      }
    }
  }
  return rows.join("\n");
}

function csvField(s: string): string {
  const needs = /[",\n\r]/.test(s);
  return needs ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 生成项目清单 JSON（含元数据 + 时间线 + 音频轨道） */
export function generateProjectManifest(project: DirectorProject): string {
  return JSON.stringify({
    projectName: project.name,
    targetDurationSec: project.targetDurationSec,
    aspect: project.aspect,
    scenes: project.scenes.length,
    segments: project.scenes.reduce((n, s) => n + s.segments.length, 0),
    characters: project.characters,
    timeline: project.timeline,
    audioTracks: project.audioTracks?.map((t) => ({ kind: t.kind, text: t.text, segmentId: t.segmentId })),
    exportedAt: new Date().toISOString(),
  }, null, 2);
}
