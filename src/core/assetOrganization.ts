import type { AssetItem } from "./types";

/** 只折叠展示，不移动文件、不覆盖人工文件夹或标签。 */
export function assetAutoGroup(item:AssetItem):string|undefined {
  if(item.groupId)return item.groupId;
  if(item.director?.segmentId)return `segment:${item.director.projectId}:${item.director.segmentId}:${item.kind}`;
  if(item.nodeId)return `node:${item.boardId??"legacy"}:${item.nodeId}:${item.kind}`;
  if(item.source==="import")return `import:${item.boardId??"legacy"}:${item.folderId??"none"}:${item.kind}:${new Date(item.createdAt).toLocaleDateString("sv")}`;
  return undefined;
}
export function assetVisibleOnBoard(item:AssetItem,boardId:string,nodeIds:ReadonlySet<string>):boolean {
  return item.boardId===boardId || (!item.boardId&&!!item.nodeId&&nodeIds.has(item.nodeId));
}
