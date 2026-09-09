import type { AssetItem } from "./types";

/** 历史版本保留 Eagle 来源，但同库同项目只允许一个活动版本参与同步。 */
export function activeEagleAssets(items: AssetItem[], libraryKey: string): AssetItem[] {
  const byId = new Map(items.map(i => [i.id, i]));
  const superseded = new Set(items.filter(i => {
    const parent = byId.get(i.lineage?.parentAssetId ?? "");
    return i.eagle?.itemId && parent?.eagle?.itemId === i.eagle.itemId && parent.eagle.libraryKey === i.eagle.libraryKey;
  }).map(i => i.lineage!.parentAssetId));
  const active = new Map<string, AssetItem>();
  for (const item of items) {
    const link = item.eagle;
    if (!link?.itemId || link.libraryKey !== libraryKey || item.deletedAt || superseded.has(item.id) || link.error === "已由新版本接管") continue;
    const previous = active.get(link.itemId);
    if (!previous || (item.lineage?.revision ?? 0) > (previous.lineage?.revision ?? 0) ||
      ((item.lineage?.revision ?? 0) === (previous.lineage?.revision ?? 0) && item.createdAt > previous.createdAt)) active.set(link.itemId, item);
  }
  return [...active.values()];
}

/** 复用已有素材不算导入新版本，不能因此弹出更新通知。 */
export function newEagleImports(imported: AssetItem[], previousIds: Set<string>): AssetItem[] {
  return imported.filter(item => !previousIds.has(item.id));
}
