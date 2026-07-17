import { isTauri } from "./utils";

/** 在系统默认浏览器中打开链接 */
export async function openExternal(url: string) {
  if (isTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank");
}

/** 在资源管理器中打开文件夹 */
export async function openFolder(path: string) {
  if (!isTauri) return;
  const { openPath } = await import("@tauri-apps/plugin-opener");
  await openPath(path);
}
