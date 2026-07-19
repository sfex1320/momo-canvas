/**
 * 图片/视频保存服务 — 依据「设置 → 图片保存」写入磁盘
 */
import type { SaveCfg } from "../types";
import { buildFilename, convertImage, dataUrlToBytes, imageSizeMeta, isTauri, toDataUrl, type FilenameMeta } from "../utils";
import { xfetch } from "./http";

export type SaveMeta = { prompt?: string; model?: string; seed?: string | number };

async function ensureDataUrl(src: string): Promise<string> {
  return toDataUrl(src, (u, i) => xfetch(u as string, i));
}

/** 自动保存（需已设置保存目录）；返回完整路径。{n} 序号同前缀依次递增 */
export async function autoSaveImage(src: string, cfg: SaveCfg, meta: SaveMeta = {}): Promise<string> {
  if (!isTauri) throw new Error("浏览器预览模式不支持写盘保存");
  if (!cfg.dir) throw new Error("请先在「设置 → 图片保存」中选择保存文件夹");
  const { writeFile, mkdir, exists } = await import("@tauri-apps/plugin-fs");
  if (!(await exists(cfg.dir))) await mkdir(cfg.dir, { recursive: true });
  const dataUrl = await convertImage(await ensureDataUrl(src), cfg.format);
  const full: FilenameMeta = { ...meta, ...(await imageSizeMeta(dataUrl)) };
  const ext = cfg.format === "jpeg" ? "jpg" : cfg.format;
  let path = "";
  if (cfg.pattern.includes("{n}")) {
    // 显式序号：同前缀找到第一个不存在的编号
    for (let i = 1; ; i++) {
      path = `${cfg.dir}\\${buildFilename(cfg.pattern, { ...full, n: i })}.${ext}`;
      if (!(await exists(path))) break;
    }
  } else {
    path = `${cfg.dir}\\${buildFilename(cfg.pattern, full)}.${ext}`;
    for (let i = 2; await exists(path); i++) {
      path = `${cfg.dir}\\${buildFilename(cfg.pattern, full)}_${i}.${ext}`;
    }
  }
  await writeFile(path, dataUrlToBytes(dataUrl));
  return path;
}

/** 手动另存为（弹出系统保存框）；返回路径，取消返回 null */
export async function saveImageAs(src: string, cfg: SaveCfg, meta: SaveMeta = {}): Promise<string | null> {
  if (!isTauri) {
    // 浏览器兜底：a 标签下载
    const a = document.createElement("a");
    a.href = await ensureDataUrl(src);
    a.download = `${buildFilename(cfg.pattern, meta)}.${cfg.format === "jpeg" ? "jpg" : cfg.format}`;
    a.click();
    return null;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const ext = cfg.format === "jpeg" ? "jpg" : cfg.format;
  const path = await save({
    defaultPath: `${cfg.dir ? cfg.dir + "\\" : ""}${buildFilename(cfg.pattern, meta)}.${ext}`,
    filters: [{ name: "图片", extensions: ["png", "jpg", "webp"] }],
  });
  if (!path) return null;
  const target = (path.split(".").pop() ?? ext).toLowerCase();
  const fmt = target === "jpg" || target === "jpeg" ? "jpeg" : target === "webp" ? "webp" : "png";
  const dataUrl = await convertImage(await ensureDataUrl(src), fmt);
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  await writeFile(path, dataUrlToBytes(dataUrl));
  return path;
}

/** 保存音频（asset/远程/blob/dataURL → 磁盘） */
export async function saveAudioAs(url: string, cfg: SaveCfg, meta: SaveMeta = {}): Promise<string | null> {
  const fetchBytes = async () => {
    if (url.startsWith("data:")) return dataUrlToBytes(url);
    const resp = url.startsWith("blob:") ? await fetch(url) : await xfetch(url);
    return new Uint8Array(await resp.arrayBuffer());
  };
  const ext = /(\.|\/)(wav)\b/i.test(url) ? "wav" : "mp3";
  if (!isTauri) {
    const a = document.createElement("a");
    a.href = url;
    a.download = `${buildFilename(cfg.pattern, meta)}.${ext}`;
    a.click();
    return null;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: `${cfg.dir ? cfg.dir + "\\" : ""}${buildFilename(cfg.pattern, meta)}.${ext}`,
    filters: [{ name: "音频", extensions: ["mp3", "wav", "m4a", "ogg"] }],
  });
  if (!path) return null;
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  await writeFile(path, await fetchBytes());
  return path;
}

/** 保存视频（远程 url / blob url → 磁盘） */
export async function saveVideoAs(url: string, cfg: SaveCfg, meta: SaveMeta = {}): Promise<string | null> {
  const fetchBytes = async () => {
    const resp = url.startsWith("blob:") ? await fetch(url) : await xfetch(url);
    return new Uint8Array(await resp.arrayBuffer());
  };
  if (!isTauri) {
    const a = document.createElement("a");
    a.href = url;
    a.download = `${buildFilename(cfg.pattern, meta)}.mp4`;
    a.click();
    return null;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: `${cfg.dir ? cfg.dir + "\\" : ""}${buildFilename(cfg.pattern, meta)}.mp4`,
    filters: [{ name: "视频", extensions: ["mp4"] }],
  });
  if (!path) return null;
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  await writeFile(path, await fetchBytes());
  return path;
}
