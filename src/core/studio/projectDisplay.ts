import type { DirectorProject } from "../types";

/** 仅用于列表呈现，不覆盖用户原始命名，也不删除空项目。 */
export function projectDisplayName(p: DirectorProject): string {
  if (p.name.trim() && p.name.trim() !== "未命名项目") return p.name.trim();
  const heading = p.script.match(/^\s*#{1,2}\s+(.+)$/m)?.[1];
  const title = heading?.replace(/[*#`]/g, '').trim() || p.scenes.find(s => s.location.trim())?.location;
  return title ? `${title.slice(0, 32)} · ${p.id.slice(-4)}` : `新项目 · ${new Date(p.createdAt).toLocaleDateString('zh-CN')} · ${p.id.slice(-4)}`;
}
export function projectHasContent(p: DirectorProject): boolean {
  return Boolean(
    p.script.trim() || p.scenes.length || p.characters.length || p.assetDefinitions?.length || p.scripts?.length || p.mvProjects?.length ||
    p.timeline.length || p.globalSlots.length || p.workspace || p.recipes.length ||
    Object.keys(p.imageStudio ?? {}).length || p.audioTracks?.length || p.postTimeline?.titleCards.length ||
    p.postTimeline?.subtitles.length || Object.keys(p.postTimeline?.clipOverrides ?? {}).length ||
    p.threedEntities?.length || p.promptRecipes?.length || p.skillBindings?.length || p.exportAssetId ||
    p.promptRevisions?.length || p.continuityCapsules?.length || p.qualityReports?.length || p.assetCatalogSource
  );
}
