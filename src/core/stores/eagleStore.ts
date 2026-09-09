/**
 * MOMO × Eagle 资产桥 — 运行状态 store
 *
 * 只保存连接/统计等运行信息，不持有二进制与完整库列表（远程浏览数据在组件里按页拉）。
 * 业务编排全部走 eagleSyncEngine；本 store 不直接发请求。
 */
import { create } from "zustand";
import type { EagleAppInfo, EagleClient, EagleLibraryInfo } from "../services/eagleApi";

export type EagleConnState = "disabled" | "connecting" | "ready" | "offline" | "error";

type EagleState = {
  connState: EagleConnState;
  appInfo?: EagleAppInfo;
  /** 当前素材库（检测成功才有） */
  library?: EagleLibraryInfo;
  /** 规范化后的库指纹 */
  libraryKey?: string;
  /** 最近一次连接失败原因（设置页展示用） */
  connectError?: string;
  client: EagleClient | null;
  /** 本地桥端口（缩略图流与插件回传通道）；null = 桥未启动 */
  bridgePort?: number | null;
  /** 本地桥 token（缩略图 URL 参数用；仅存内存不落盘） */
  bridgeToken?: string;
  lastScanAt?: number;
  /** 检测到远端被外部更新的 MOMO 资产 id */
  dirtyIds: string[];
  stats: { synced: number; queued: number; conflict: number; failed: number };
  /** 资产落位子文件夹缓存：MOMO 相对路径 → Eagle folderId */
  folderMap: Record<string, string>;
};

export const useEagle = create<EagleState>(() => ({
  connState: "disabled",
  client: null,
  bridgePort: null,
  dirtyIds: [],
  stats: { synced: 0, queued: 0, conflict: 0, failed: 0 },
  folderMap: {},
}));
