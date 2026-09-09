/**
 * MOMO Link · 素材面板（Eagle Inspector 插件）
 * 选中素材时显示绑定状态，可发送到 MOMO 当前画布 / 请求 MOMO 定位既有资产。
 * 只发送 itemId —— 本地路径一律由 MOMO 向 Eagle API 复查，绝不外传。
 */
/* global eagle */
const os = require("os");
const fs = require("fs");
const path = require("path");

function descriptorPath() {
  const base =
    process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support")
        : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"));
  return path.join(base, "site.jinpengi.momo", "momo-bridge.json");
}

let bridge = null;
let selectedItems = [];

const $ = (id) => document.getElementById(id);

async function checkBridge() {
  try {
    const raw = JSON.parse(fs.readFileSync(descriptorPath(), "utf8"));
    const resp = await fetch(`http://127.0.0.1:${raw.port}/v1/health?token=${encodeURIComponent(raw.token)}`, {
      signal: AbortSignal.timeout ? AbortSignal.timeout(2000) : undefined,
    });
    const json = await resp.json();
    if (json.ok) {
      bridge = { port: raw.port, token: raw.token };
      $("btnSend").disabled = false;
      $("btnLocate").disabled = false;
      refresh();
      return;
    }
    throw new Error("offline");
  } catch {
    bridge = null;
    $("bind").textContent = "MOMO 未运行";
    $("btnSend").disabled = true;
    $("btnLocate").disabled = true;
  }
}

/** 查询 MOMO 是否已有这些 itemId 的绑定副本：用 health + import 幂等语义——
 *  MOMO 的 /v1/import-selection 对已绑定素材直接返回现有条目不产生重复，
 *  这里为「在 MOMO 中定位」单独走 open-asset。 */
function refresh() {
  const n = selectedItems.length;
  if (!n) {
    $("bind").textContent = "未选中";
    $("meta").textContent = "在 Eagle 里选中素材即可操作。";
    $("btnSend").textContent = "发送到 MOMO 当前画布";
    return;
  }
  $("bind").textContent = `已选 ${n} 项`;
  const names = selectedItems.slice(0, 3).map((i) => i.name).join("、");
  $("meta").textContent =
    `${names}${n > 3 ? ` 等 ${n} 项` : ""}\n` +
    (selectedItems.length === 1
      ? `${selectedItems[0].width || "?"}${selectedItems[0].height ? "×" + selectedItems[0].height : ""} · ${selectedItems[0].ext.toUpperCase()}`
      : "");
  $("btnSend").textContent = n > 1 ? `发送 ${n} 项到 MOMO 画布` : "发送到 MOMO 当前画布";
}

async function post(action, payload) {
  const resp = await fetch(
    `http://127.0.0.1:${bridge.port}/v1/${action}?token=${encodeURIComponent(bridge.token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-MOMO-Bridge-Token": bridge.token },
      body: JSON.stringify(payload),
    },
  );
  const json = await resp.json();
  if (json.status === "error") throw new Error(json.message);
  return json;
}

window.addEventListener("DOMContentLoaded", () => {
  eagle.onThemeChanged((theme) => document.body.setAttribute("theme", theme));
  void eagle.app.theme.then((theme) => document.body.setAttribute("theme", theme));

  $("btnSend").addEventListener("click", () => {
    if (!bridge) return;
    const ids = selectedItems.map((i) => i.id).filter(Boolean).slice(0, 500);
    if (!ids.length) return;
    post("import-selection", { itemIds: ids, target: "canvas" })
      .then((j) => ($("meta").textContent = `已把 ${j.accepted ?? ids.length} 个素材交给 MOMO 处理…`))
      .catch((e) => ($("meta").textContent = `发送失败：${e.message}`));
  });

  $("btnLocate").addEventListener("click", () => {
    if (!bridge || !selectedItems.length) return;
    const ids = selectedItems.map((i) => i.id).filter(Boolean).slice(0, 1);
    post("open-asset", { itemId: ids[0] })
      .then(() => ($("meta").textContent = "已请求 MOMO 定位该素材（未绑定时 MOMO 会提示先导入）"))
      .catch((e) => ($("meta").textContent = `定位失败：${e.message}`));
  });

  eagle.onPluginCreate(async (plugin) => {
    void plugin;
    eagle.onPluginAfterSelect(async (items) => {
      selectedItems = items || [];
      refresh();
    });
    await checkBridge();
    setInterval(() => void checkBridge(), 10000);
  });
});
