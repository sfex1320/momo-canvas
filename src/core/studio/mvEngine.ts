/**
 * AI MV 引擎（导演台 3.0 · 方案 §6.6）
 *
 * 音乐资产 → Web Audio 解码：时长 / 能量包络 / onset 节拍估计 / BPM / 能量段落；
 * LRC 歌词导入；区间（音乐段 × 视觉绑定）逐段生成视频——与 H3 共用配方/模型/资产体系，
 * 不复制生成引擎（§6.6 首版边界）。区间生成走 image→video 两步（首帧图 + 视频配方）
 * 或直接视频配方，产物收录资产库并回写区间 takes。
 */
import { assetToBlobUrl } from "../services/assetFiles";
import { useAssets } from "../stores/assetStore";
import { useDirector } from "../stores/directorStore";
import { generateImage } from "../services/imageGen";
import { resolveModelCard } from "../stores/settingsStore";
import { generateVideo } from "../services/videoGen";
import { assetToDataUrl } from "../services/assetFiles";
import { errMsg, uid } from "../utils";
import { jobCenter } from "./jobCenter";
import { mirrorProjectAsset } from "./projectAssetRouter";
import { useUi } from "../stores/uiStore";
import { routeSkillBindings } from "./skillRoute";
import type { AssetItem, MVAnalysis, MVProject, MVRegion } from "../types";

/* ---------------- 音乐分析 ---------------- */

/** 解码音频 → AudioBuffer（blob URL 或 dataURL） */
async function decodeAudio(src: string): Promise<AudioBuffer> {
  const res = await fetch(src);
  const buf = await res.arrayBuffer();
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  try {
    return await ctx.decodeAudioData(buf);
  } finally {
    void ctx.close();
  }
}

/** 能量包络（每秒 RMS，归一化 0~1） */
function envelopeOf(buffer: AudioBuffer): number[] {
  const ch = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const out: number[] = [];
  for (let s = 0; s < buffer.duration; s++) {
    const start = Math.floor(s * sr);
    const end = Math.min(ch.length, Math.floor((s + 1) * sr));
    let acc = 0;
    for (let i = start; i < end; i += 16) acc += ch[i] * ch[i]; // 抽样足够
    out.push(Math.sqrt(acc / Math.max(1, (end - start) / 16)));
  }
  const max = Math.max(...out, 1e-6);
  return out.map((v) => v / max);
}

/** onset 节拍估计：能量增量的局部峰值（间隔 0.25~1.2s 视为拍） */
function beatsFromEnvelope(env: number[]): number[] {
  const peaks: Array<{ t: number; s: number }> = [];
  for (let i = 1; i < env.length - 1; i++) {
    const delta = env[i] - env[i - 1];
    if (delta > 0.08 && env[i] > 0.25 && env[i] >= env[i + 1]) peaks.push({ t: i, s: delta });
  }
  peaks.sort((a, b) => b.s - a.s);
  const taken: number[] = [];
  for (const p of peaks) {
    if (taken.every((t) => Math.abs(t - p.t) > 0.24)) taken.push(p.t);
  }
  return taken.sort((a, b) => a - b);
}

/** 从拍间隔中位数估 BPM（钳在 60~180 的可信区间） */
function bpmFromBeats(beats: number[]): number | undefined {
  if (beats.length < 8) return undefined;
  const gaps = beats.slice(1).map((t, i) => t - beats[i]).filter((g) => g > 0.2 && g < 2);
  if (gaps.length < 6) return undefined;
  gaps.sort((a, b) => a - b);
  const med = gaps[Math.floor(gaps.length / 2)];
  let bpm = 60 / med;
  while (bpm < 60) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm);
}

/** 能量段落：包络平滑后按「安静/中等/高能」三档聚类成连续区间（副歌=高能段） */
function sectionsFromEnvelope(env: number[]): Array<{ startSec: number; endSec: number; energy: number }> {
  if (!env.length) return [];
  // 8 秒窗平滑
  const win = 8;
  const smooth = env.map((_, i) => {
    const a = Math.max(0, i - win / 2);
    const b = Math.min(env.length, i + win / 2);
    let acc = 0;
    for (let k = a; k < b; k++) acc += env[k];
    return acc / (b - a);
  });
  const q = (arr: number[], p: number) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
  };
  const low = q(smooth, 0.33);
  const high = q(smooth, 0.72);
  const level = (v: number) => (v >= high ? 2 : v > low ? 1 : 0);
  const out: Array<{ startSec: number; endSec: number; energy: number }> = [];
  let start = 0;
  let cur = level(smooth[0]);
  for (let i = 1; i <= smooth.length; i++) {
    const l = i < smooth.length ? level(smooth[i]) : -1;
    if (l !== cur) {
      if (i - start >= 12) {
        // 段内平均能量归档
        let acc = 0;
        for (let k = start; k < i; k++) acc += env[k];
        out.push({ startSec: start, endSec: i, energy: acc / (i - start) });
        start = i;
        cur = l;
      }
    }
  }
  if (start < smooth.length - 3) {
    out.push({ startSec: start, endSec: smooth.length, energy: smooth.slice(start).reduce((a, b) => a + b, 0) / (smooth.length - start) });
  }
  return out;
}

/** 分析音乐资产（进度经任务中心；失败给中文原因） */
export async function analyzeMusic(projectId: string, mvId: string): Promise<MVAnalysis> {
  const proj = useDirector.getState().getById(projectId);
  const mv = proj?.mvProjects?.find((m) => m.id === mvId);
  const asset = mv?.musicAssetId ? useAssets.getState().items.find((a) => a.id === mv.musicAssetId) : undefined;
  if (!asset) throw new Error("请先选择音乐资产（资产库中的音频）");
  const job = jobCenter.begin({ projectId, kind: "analyze", label: `分析音乐 · ${asset.name}` });
  try {
    job.stage("解码音频");
    const src = await assetToBlobUrl(asset.path, asset.mime).catch(() => asset.path);
    const buffer = await decodeAudio(src);
    if (src.startsWith("blob:")) URL.revokeObjectURL(src);
    job.stage("节拍与段落检测", 60);
    const envelope = envelopeOf(buffer);
    const beats = beatsFromEnvelope(envelope);
    const bpm = bpmFromBeats(beats);
    const rawSections = sectionsFromEnvelope(envelope);
    const maxE = Math.max(...rawSections.map((s) => s.energy), 1e-6);
    const sections = rawSections.map((s) => ({
      ...s,
      energy: s.energy / maxE,
      label: s.energy / maxE > 0.66 ? "副歌" : s.energy / maxE > 0.33 ? "过渡" : "安静",
    }));
    const analysis: MVAnalysis = { durationSec: buffer.duration, bpm, beats, sections, envelope, analyzedAt: Date.now() };
    patchMv(projectId, mvId, (m) => ({ ...m, analysis, updatedAt: Date.now() }));
    job.done(`分析完成：${buffer.duration.toFixed(1)}s${bpm ? ` · ≈${bpm} BPM` : ""} · ${sections.length} 段`);
    return analysis;
  } catch (e) {
    const msg = errMsg(e);
    job.fail(msg);
    useUi.getState().pushError("AI MV · 音乐分析", msg);
    throw e;
  }
}

/** LRC 歌词文本 → 带时间轴行（[mm:ss.xx] 前缀，多时间标签展开） */
export function parseLrc(text: string): Array<{ startSec: number; endSec: number; text: string }> {
  const lines: Array<{ t: number; text: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) continue;
    const body = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of tags) {
      const t = Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(`0.${m[3]}`) : 0);
      lines.push({ t, text: body });
    }
  }
  lines.sort((a, b) => a.t - b.t);
  return lines
    .filter((l) => l.text)
    .map((l, i) => ({ startSec: l.t, endSec: lines[i + 1]?.t ?? l.t + 4, text: l.text }));
}

/* ---------------- 项目与区间操作 ---------------- */

export function patchMv(projectId: string, mvId: string, fn: (mv: MVProject) => MVProject): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  useDirector.getState().updateProject(projectId, {
    mvProjects: (proj.mvProjects ?? []).map((m) => (m.id === mvId ? fn(m) : m)),
  });
}

export function createMvProject(projectId: string, name: string): MVProject {
  const proj = useDirector.getState().getById(projectId)!;
  const mv: MVProject = {
    id: uid(10),
    name,
    regions: [],
    settings: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  useDirector.getState().updateProject(projectId, { mvProjects: [mv, ...(proj.mvProjects ?? [])] });
  return mv;
}

export function deleteMvProject(projectId: string, mvId: string): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  useDirector.getState().updateProject(projectId, { mvProjects: (proj.mvProjects ?? []).filter((m) => m.id !== mvId) });
}

export function patchRegion(projectId: string, mvId: string, regionId: string, patch: Partial<MVRegion>): void {
  patchMv(projectId, mvId, (m) => ({
    ...m,
    regions: m.regions.map((r) => (r.id === regionId ? { ...r, ...patch } : r)),
    updatedAt: Date.now(),
  }));
}

export function addRegion(projectId: string, mvId: string, region: Omit<MVRegion, "id">): MVRegion {
  const r: MVRegion = { id: uid(8), ...region };
  patchMv(projectId, mvId, (m) => ({ ...m, regions: [...m.regions, r], updatedAt: Date.now() }));
  return r;
}

export function removeRegion(projectId: string, mvId: string, regionId: string): void {
  patchMv(projectId, mvId, (m) => ({ ...m, regions: m.regions.filter((r) => r.id !== regionId), updatedAt: Date.now() }));
}

/* ---------------- 区间生成 ---------------- */

/**
 * 生成一个区间：图片区间走「首帧图（远程 image）→ 视频配方（I2V）」，
 * 已有绑定图则直接用绑定图进视频参考。产物收录资产库（director.role generated），
 * takes 回写区间。失败不抛出到批量层（单段失败不阻断，§9.4）。
 */
export async function generateRegion(
  projectId: string,
  mvId: string,
  regionId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ ok: boolean; error?: string }> {
  const proj0 = useDirector.getState().getById(projectId);
  const mv = proj0?.mvProjects?.find((m) => m.id === mvId);
  const region = mv?.regions.find((r) => r.id === regionId);
  if (!proj0 || !mv || !region) return { ok: false, error: "区间不存在" };
  const dur = Math.max(2, Math.round(region.endSec - region.startSec));
  const job = jobCenter.begin({
    projectId,
    kind: "generate",
    label: `MV 区间 ${region.startSec.toFixed(0)}-${region.endSec.toFixed(0)}s`,
  });
  const take = { id: uid(10), status: "queued" as const };
  patchRegion(projectId, mvId, regionId, { takes: [...(region.takes ?? []), take] });
  const fail = (err: string) => {
    job.fail(err);
    patchRegion(projectId, mvId, regionId, {
      takes: (useDirector.getState().getById(projectId)?.mvProjects?.find((m) => m.id === mvId)?.regions.find((r) => r.id === regionId)?.takes ?? []).map((t) =>
        t.id === take.id ? { ...t, status: "error" as const, error: err } : t,
      ),
    });
    return { ok: false, error: err };
  };
  try {
    opts.signal?.throwIfAborted();
    // 工位 Skill（studio.mv）：按本区间的生成引擎路由注入 MV 提示词规范
    // （本地视频配方 → local；远程视频模型 → remote；首帧图走 remote 生图同栈）
    const vRecipe = proj0.recipes.find((r) => r.id === (mv.settings.recipeId ?? proj0.defaultRecipeId) && r.output === "video");
    const route = vRecipe?.engine === "comfy"
      ? { engine: "local" as const, templateName: vRecipe.name, model: vRecipe.templateId }
      : { engine: "remote" as const, model: vRecipe?.providerModelKey?.split("::").pop() ?? resolveModelCard("video").model };
    const skillStack = routeSkillBindings(proj0, route, ["studio.mv", "prompt.video"]);
    const mvSkillNote = skillStack.length ? `\n\n${skillStack.map((s) => s.system).join("\n\n")}` : "";
    const regionPrompt = region.prompt || mv.name;
    // ① 组参考图（绑定图 + 角色外观参考）
    const refAssets: AssetItem[] = [];
    for (const id of region.imageAssetIds) {
      const a = useAssets.getState().items.find((x) => x.id === id);
      if (a) refAssets.push(a);
    }
    for (const cid of region.characterIds) {
      const ch = proj0.characters.find((c) => c.id === cid);
      for (const aid of ch?.assetIds ?? []) {
        const a = useAssets.getState().items.find((x) => x.id === aid);
        if (a) refAssets.push(a);
      }
    }
    let firstFrame: string | undefined = refAssets[0]
      ? await assetToDataUrl(refAssets[0].path, refAssets[0].mime).catch(() => undefined)
      : undefined;

    // ② 无绑定图 → 先出首帧图（远程 image 模型；没有配 image 模型时要求必须绑定图）
    if (!firstFrame) {
      let card;
      try {
        card = resolveModelCard("image");
      } catch {
        return fail("区间没有绑定图片，且未配置远程生图模型——请绑定图片或配置 image 角色模型");
      }
      if (!card.model) return fail("区间没有绑定图片，且未配置远程生图模型——请绑定图片或配置 image 角色模型");
      job.stage("生成区间首帧图", 20);
      const urls = await generateImage(card, {
        prompt: `${regionPrompt}${mvSkillNote} — music video key frame`,
        aspect: mv.settings.aspect ?? proj0.aspect,
        n: 1,
        signal: opts.signal,
      });
      if (!urls[0]) return fail("首帧图生成失败");
      firstFrame = urls[0];
    }

    // ③ 视频生成：优先项目视频配方（comfy），否则远程 video 模型（vRecipe 已在路由处解析）
    job.stage("生成区间视频", 45);
    let outUrl: string | undefined;
    if (vRecipe?.engine === "comfy" && vRecipe.templateId) {
      const { runComfyTemplate } = await import("../services/comfy");
      const { useComfy } = await import("../stores/comfyStore");
      const tpl = useComfy.getState().templates.find((t) => t.id === vRecipe.templateId);
      if (!tpl) return fail("MV 配方引用的视频模板不存在");
      const host = (await import("../stores/settingsStore")).useSettings.getState().settings.comfy.host;
      const r = await runComfyTemplate(host, tpl, { ...(vRecipe.defaultParams ?? {}), 时长: dur, duration: dur }, {
        upstreamImages: firstFrame ? [firstFrame] : [],
        signal: opts.signal,
        onProgress: (msg, pct) => job.stage(msg, pct ? 40 + pct * 0.5 : undefined),
      });
      outUrl = r.videos[0] ?? r.images[0];
    } else {
      // 3.4：优先用 MV 配方绑定的模型键，而不是全局默认视频模型
      const vCard = vRecipe?.providerModelKey
        ? resolveModelCard("video", vRecipe.providerModelKey)
        : resolveModelCard("video");
      if (!vCard.model) return fail("未配置视频生成模型（image 角色可用，video 角色缺失）——请在设置里配置 video 模型或选择 ComfyUI 视频配方");
      outUrl = await generateVideo(vCard, {
        prompt: `${regionPrompt}${mvSkillNote} — music video clip`,
        image: firstFrame,
        duration: String(dur),
        aspect: mv.settings.aspect ?? proj0.aspect,
        signal: opts.signal,
      });
    }
    if (!outUrl) return fail("视频引擎没有返回结果");
    if (outUrl.startsWith("blob:")) outUrl = await blobToDataUrl(outUrl);

    // ④ 收录 + 回写
    job.stage("收录资产", 92);
    const asset = await useAssets.getState().collect({
      src: outUrl,
      kind: "video",
      name: `MV_${mv.name}_${region.startSec.toFixed(0)}s`,
      prompt: region.prompt,
      director: { projectId, role: "generated" },
    });
    if (asset) {
      // 3.5 P2：绑定项目文件夹时镜像进 AI MV/（失败不阻断）
      void mirrorProjectAsset({ projectId, category: "mv", assetId: asset.id });
    }
    patchRegion(projectId, mvId, regionId, {
      takes: (useDirector.getState().getById(projectId)?.mvProjects?.find((m) => m.id === mvId)?.regions.find((r) => r.id === regionId)?.takes ?? []).map((t) =>
        t.id === take.id ? { ...t, status: "done" as const, assetId: asset?.id } : t,
      ),
      approvedTakeId: asset ? take.id : undefined,
    });
    job.done("区间视频就绪");
    return { ok: true };
  } catch (e) {
    const msg = errMsg(e);
    useUi.getState().pushError("AI MV · 区间生成", msg);
    return fail(msg);
  }
}

function blobToDataUrl(url: string): Promise<string> {
  return fetch(url).then((r) => r.blob()).then(
    (b) => new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error("结果读取失败"));
      fr.readAsDataURL(b);
    }),
  );
}

/** 批量生成所选区间（串行；abort 由调用方拼 signal） */
export async function generateRegions(
  projectId: string,
  mvId: string,
  regionIds: string[],
  signal?: AbortSignal,
): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  for (const id of regionIds) {
    if (signal?.aborted) break;
    const r = await generateRegion(projectId, mvId, id, { signal });
    if (r.ok) ok++;
    else failed++;
  }
  return { ok, failed };
}

/** MV 已就绪区间（有采用 Take）数 */
export function mvReadyCount(mv: MVProject): number {
  return mv.regions.filter((r) => {
    const t = (r.takes ?? []).find((x) => x.id === r.approvedTakeId);
    return t?.status === "done" && t.assetId;
  }).length;
}
