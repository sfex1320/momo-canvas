/**
 * 资产原生拖拽状态 — Tauri 下资产卡默认走 OS 原生拖出（可落到资源管理器/第三方软件），
 * 落回本应用（画布 / 快捷栏）时 HTML5 drop 只能拿到文件，不带资产 id；
 * 这里记录"正在拖的资产 id"，让应用内落点还原出完整资产信息（名称/提示词等）。
 */
let draggingAssetId: string | null = null;

export function setNativeDragAsset(id: string | null) {
  draggingAssetId = id;
}

export function getNativeDragAsset(): string | null {
  return draggingAssetId;
}
