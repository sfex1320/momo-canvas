import type { DirectorProject, DirectorSegment, DirectorShot, DirectorSlotValue } from "../types";

/** 时间以整数毫秒解析、以秒储存，避免输入被小数精度吞掉。 */
export function parseAuthorTime(value: string): number | null {
  const raw = value.trim();
  if (/^\d+(?:\.\d{1,3})?\s*(?:ms|毫秒)$/i.test(raw)) return Math.round(parseFloat(raw)) / 1000;
  const s = raw.replace(/\s*(?:s|秒)$/i, "");
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d{1,3})?$/.test(s)) return null;
  const parts = s.split(":").map(Number);
  if (parts.slice(1).some(v => v >= 60)) return null;
  const sec = parts.reduce((total, part) => total * 60 + part, 0);
  return Number.isFinite(sec) ? Math.round(sec * 1000) / 1000 : null;
}
export const timeChip = (sec: number) => `${Math.max(0, sec).toFixed(3)}s`;

export function parseTimedActions(text: string): DirectorShot[] {
  const rows: DirectorShot[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*\[?([\d:.]+\s*(?:ms|毫秒|s|秒)?)\s*[-–—~～至]\s*([\d:.]+\s*(?:ms|毫秒|s|秒)?)\]?\s*[:：]?\s*(.+)$/i);
    if (!m) continue;
    const start = parseAuthorTime(m[1]), end = parseAuthorTime(m[2]);
    if (start === null || end === null || end <= start) continue;
    rows.push({ id: `time-${rows.length}-${Math.round(start * 1000)}`, startSec: start, endSec: end, action: m[3], audio: "", camera: "", shotSize: "" });
  }
  return rows;
}
export function authoringProblems(segment: DirectorSegment): string[] {
  const out: string[] = [];
  let cursor = 0;
  for (const [i, shot] of segment.shots.entries()) {
    if (Math.round(shot.startSec*1000) < Math.round(cursor*1000)) out.push(`第 ${i + 1} 行与上一行重叠`);
    if (Math.round(shot.startSec*1000) > Math.round(cursor*1000)) out.push(`第 ${i + 1} 行之前有时间空隙`);
    if (shot.endSec <= shot.startSec) out.push(`第 ${i + 1} 行结束时间须晚于开始`);
    if (shot.endSec > segment.durationSec) out.push(`第 ${i + 1} 行超过片段时长`);
    cursor = shot.endSec;
  }
  return out;
}
export function selectedDefinitions(p: DirectorProject, s: DirectorSegment): string {
  const chars = p.characters.filter(c => s.characterIds?.includes(c.id));
  const defs = (p.assetDefinitions ?? []).filter(d => s.definitionIds?.includes(d.id));
  return [...chars.map(c => `${c.name}：${[c.identity,c.appearanceAnchors,c.continuity,c.voiceDesc].filter(Boolean).join("；")}`), ...defs.map(d => `${d.kind === "scene" ? "场景" : "道具"} ${d.name}：${d.description}`)].join("\n");
}
export function authoredText(p: DirectorProject, s: DirectorSegment): string {
  return [s.summary, selectedDefinitions(p,s), ...s.shots.map(sh => `[${timeChip(sh.startSec)}-${timeChip(sh.endSec)}] ${sh.action}${sh.camera ? `；机位：${sh.camera}` : ""}${sh.audio ? `；声音：${sh.audio}` : ""}`), ...s.dialogue.map(d => `<d>${d}</d>`), s.continuityIn ? `承接：${s.continuityIn}` : "", s.continuityOut ? `结束状态：${s.continuityOut}` : "", s.musicIntent === "none" ? "不添加配乐。" : s.musicIntent === "ambient" ? "仅环境声音，不添加配乐。" : s.musicIntent === "music" ? "添加与剧情匹配的配乐。" : ""].filter(Boolean).join("\n");
}
export function definitionSlots(p: DirectorProject, s: DirectorSegment): DirectorSlotValue[] {
  const seen = new Set<string>();
  return [...p.characters.filter(c => s.characterIds?.includes(c.id)).map(c => ({ semantic: "characterRef" as const, assetIds: c.assetIds ?? [], label: c.name, auto: false })), ...(p.assetDefinitions ?? []).filter(d => s.definitionIds?.includes(d.id)).map(d => ({semantic: "referenceImage" as const, assetIds: d.assetIds, label: d.name, auto:false}))].map(slot => ({...slot, assetIds:slot.assetIds.filter(id=>{if(seen.has(id))return false;seen.add(id);return true;})})).filter(s => s.assetIds.length);
}
export function shouldRelay(p: DirectorProject, s: DirectorSegment): boolean {
  if (s.relayMode === "cut") return false;
  if (s.relayMode === "continue") return true;
  if (s.relayMode === "auto") {
    const all = p.scenes.flatMap(c => c.segments), index = all.findIndex(c => c.id === s.id);
    const prev = all[index - 1];
    if (!prev) return false;
    const scenes = (p.assetDefinitions ?? []).filter(d => d.kind === "scene");
    const selected = scenes.filter(d => s.definitionIds?.includes(d.id));
    return selected.length ? selected.some(d => prev.definitionIds?.includes(d.id)) : prev.sceneId === s.sceneId;
  }
  return !!p.tailFrameRelay;
}
