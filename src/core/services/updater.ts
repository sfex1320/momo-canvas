/**
 * 自动更新 — 双通道：
 *  安装版（NSIS/MSI）：tauri-plugin-updater 按 GitHub Releases 的 latest.json 检查，
 *    签名校验后下载安装（Windows 上安装器启动时应用自动退出）。
 *  便携版（解压即用，程序目录带 portable.txt 标记）：查 GitHub API 最新 Release，
 *    下载 *portable*.zip 到缓存目录 → 写替换脚本 → 启动脚本并退出应用；
 *    脚本等待进程退出后把 zip 解压覆盖到程序目录并重新启动。
 *
 *  发布约定（换仓库时改 GH_REPO 与 tauri.conf.json 的 plugins.updater.endpoints）：
 *   - Release tag 形如 v0.3.1
 *   - 安装版资产：tauri build 生成的 .exe 安装包 + .sig + latest.json（createUpdaterArtifacts）
 *   - 便携版资产：名字含 portable 的 zip（内含 MOMO-Canvas.exe，解压即整个程序目录）
 */
import { isTauri } from "../utils";
import { xfetch } from "./http";

/** 发布仓库（owner/repo） */
export const GH_REPO = "sfex1320/momo-canvas";

export type UpdateAction = (onProgress?: (msg: string) => void) => Promise<void>;

export type UpdateInfo =
  | { kind: "none"; current: string }
  | { kind: "installed" | "portable"; current: string; version: string; notes?: string; apply: UpdateAction };

/** 当前应用版本 */
export async function currentVersion(): Promise<string> {
  if (!isTauri) return "0.0.0";
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

/** 便携版判定：程序目录里有 portable.txt（打包便携 zip 时放入） */
export async function isPortable(): Promise<boolean> {
  if (!isTauri) return false;
  try {
    const { exists, BaseDirectory } = await import("@tauri-apps/plugin-fs");
    return await exists("portable.txt", { baseDir: BaseDirectory.Resource });
  } catch {
    return false;
  }
}

/** "1.2.3" 语义化比较：a > b 返回 1 */
function cmpVer(a: string, b: string): number {
  const pa = a.replace(/^v/i, "").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/i, "").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 检查更新（自动区分安装版/便携版） */
export async function checkUpdate(): Promise<UpdateInfo> {
  if (!isTauri) throw new Error("浏览器预览模式不支持应用内更新");
  const current = await currentVersion();
  if (await isPortable()) return checkPortable(current);
  return checkInstalled(current);
}

/* ---------------- 安装版：官方 updater 插件 ---------------- */

async function checkInstalled(current: string): Promise<UpdateInfo> {
  const { check } = await import("@tauri-apps/plugin-updater");
  let up;
  try {
    up = await check();
  } catch (e) {
    throw new Error(
      `检查更新失败：${e instanceof Error ? e.message : String(e)}\n（请确认 ${GH_REPO} 已发布带 latest.json 的 Release）`,
    );
  }
  if (!up) return { kind: "none", current };
  return {
    kind: "installed",
    current,
    version: up.version,
    notes: up.body ?? undefined,
    apply: async (onProgress) => {
      let total = 0;
      let got = 0;
      await up.downloadAndInstall((ev) => {
        if (ev.event === "Started") {
          total = ev.data.contentLength ?? 0;
          onProgress?.("开始下载…");
        } else if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          onProgress?.(total ? `下载中 ${Math.round((got / total) * 100)}%` : `已下载 ${(got / 1024 / 1024).toFixed(1)} MB`);
        } else if (ev.event === "Finished") {
          onProgress?.("下载完成，正在安装…");
        }
      });
      // Windows 上安装器启动时应用会自动退出；其他平台手动重启
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}

/* ---------------- 便携版：GitHub Releases + 脚本替换 ---------------- */

type GhRelease = {
  tag_name?: string;
  body?: string;
  assets?: { name: string; browser_download_url: string }[];
};

async function checkPortable(current: string): Promise<UpdateInfo> {
  const resp = await xfetch(`https://api.github.com/repos/${GH_REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!resp.ok) {
    throw new Error(
      resp.status === 404
        ? `仓库 ${GH_REPO} 还没有发布任何 Release（或仓库名未配置，见 services/updater.ts 的 GH_REPO）`
        : `检查更新失败 HTTP ${resp.status}`,
    );
  }
  const rel = (await resp.json()) as GhRelease;
  const version = (rel.tag_name ?? "").replace(/^v/i, "");
  if (!version || cmpVer(version, current) <= 0) return { kind: "none", current };
  const asset = rel.assets?.find((a) => /portable/i.test(a.name) && a.name.toLowerCase().endsWith(".zip"));
  if (!asset) throw new Error(`新版本 v${version} 没有便携版 zip 资产（名字需含 portable）`);
  return {
    kind: "portable",
    current,
    version,
    notes: rel.body ?? undefined,
    apply: (onProgress) => applyPortable(asset.browser_download_url, version, onProgress),
  };
}

async function applyPortable(url: string, version: string, onProgress?: (msg: string) => void): Promise<void> {
  const { appCacheDir, resourceDir, join } = await import("@tauri-apps/api/path");
  const fs = await import("@tauri-apps/plugin-fs");

  onProgress?.("下载新版本…");
  const resp = await xfetch(url);
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());

  const cache = await appCacheDir();
  await fs.mkdir(cache, { recursive: true }).catch(() => undefined);
  const zipPath = await join(cache, `momo-update-${version}.zip`);
  await fs.writeFile(zipPath, bytes);

  onProgress?.("准备替换脚本…");
  const appDir = await resourceDir(); // 便携版 = exe 所在目录
  const exeName = "MOMO-Canvas.exe";
  // 纯 ASCII bat（避免代码页问题）：等待退出 → 解压覆盖 → 重启 → 自删
  const bat = [
    "@echo off",
    "timeout /t 2 /nobreak >nul",
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${appDir.replace(/\\+$/, "")}' -Force"`,
    `start "" "${await join(appDir, exeName)}"`,
    `del "${zipPath}"`,
    'del "%~f0"',
    "",
  ].join("\r\n");
  const batPath = await join(cache, "momo-portable-update.bat");
  await fs.writeTextFile(batPath, bat);

  onProgress?.("即将退出并替换…");
  const { openPath } = await import("@tauri-apps/plugin-opener");
  await openPath(batPath);
  const { exit } = await import("@tauri-apps/plugin-process");
  await exit(0);
}

/* ---------------- 启动静默检查 ---------------- */

/** 启动后静默检查一次；发现新版本用回调通知（失败静默） */
export async function autoCheckOnStart(onFound: (info: Extract<UpdateInfo, { kind: "installed" | "portable" }>) => void) {
  if (!isTauri) return;
  try {
    const info = await checkUpdate();
    if (info.kind !== "none") onFound(info);
  } catch {
    /* 静默：仓库未配置/离线时不打扰 */
  }
}
