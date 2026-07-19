/**
 * 协议页状态 store — 把文档草稿、协议 JSON、校准运行现场提升到模块级：
 * 切到其他设置页 / 关掉设置弹窗，正在跑的真实测试不丢日志、回来还能看到进度，并可随时手动停止。
 */
import { create } from "zustand";
import type { CustomProtocol } from "../../core/types";

/** 校准通过后待「一键保存并应用」的现场信息（用哪个连接、哪个模型测通的） */
export type CalDone = {
  model: string;
  /** 用已有服务商测的 → 其 id；手动填 Base URL/Key 测的 → 空 */
  providerId?: string;
  baseUrl: string;
  apiKey: string;
  role: CustomProtocol["role"];
};

type ProtoTabState = {
  docs: string;
  draft: string;
  roleSel: CustomProtocol["role"];
  /** 测试用服务商 id；MANUAL = 手动输入 Base URL / Key */
  testProvider: string;
  testModel: string;
  manualBase: string;
  manualKey: string;
  calLog: string[];
  calBusy: boolean;
  ctrl: AbortController | null;
  calDone: CalDone | null;
  patch: (p: Partial<Omit<ProtoTabState, "patch" | "logLine">>) => void;
  logLine: (m: string) => void;
};

export const MANUAL = "__manual__";

export const useProtoTab = create<ProtoTabState>((set) => ({
  docs: "",
  draft: "",
  roleSel: "image",
  testProvider: "",
  testModel: "",
  manualBase: "",
  manualKey: "",
  calLog: [],
  calBusy: false,
  ctrl: null,
  calDone: null,
  patch: (p) => set(p),
  logLine: (m) => set((s) => ({ calLog: [...s.calLog, m] })),
}));
