/**
 * MOMO Link · 服务（Eagle 后台服务插件）
 *
 * ① 按 MOMO 写在本机 AppData 的桥描述文件（momo-bridge.json）发现 MOMO；
 * ② 轮询健康状态，MOMO 未启动时待机提示，启动后自动恢复；
 * ③ 把 Eagle 当前选中素材的 itemId 发给 MOMO（/v1/import-selection），
 *    真实素材信息由 MOMO 向 Eagle API 复查——本插件绝不发送本地文件路径。
 */
/* global eagle */
const os = require("os");
const fs = require("fs");
const path = require("path");

/** MOMO AppData 目录名 = Tauri identifier（site.jinpengi.momo） */
function descriptorPath() {
  const base =
    process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support")
        : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"));
  return path.join(base, "site.jinpengi.momo", "momo-bridge.json");
}

let bridge = null; // { port, token }
let timer = null;

const $ = (id) => document.getElementById(id);

function log(msg) {
  const el = $("log");
  if (!el) return;
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  el.textContent = `[${time}] ${msg}\n` + (el.textContent === "—\n" || el.textContent === "—" ? "" : el.textContent);
  if (el.textContent.length > 4000) el.textContent = el.textContent.slice(0, 4000);
}

async function checkBridge() {
  const desc = descriptorPath();
  try {
    if (!fs.existsSync(desc)) throw new Error("no-descriptor");
    const raw = JSON.parse(fs.readFileSync(desc, "utf8"));
    if (raw.schema !== 1 || !raw.port || !raw.token) throw new Error("bad-descriptor");

    // 描述文件可能来自上一次已退出的 MOMO 会话：能 ping 通才算在线
    const resp = await fetch(`http://127.0.0.1:${raw.port}/v1/health?token=${encodeURIComponent(raw.token)}`, {
      signal: AbortSignal.timeout ? AbortSignal.timeout(2500) : undefined,
    });
    const json = await resp.json();
    if (!json.ok) throw new Error("bad-health");

    const firstTime = !bridge;
    bridge = { port: raw.port, token: raw.token };
    $("dot").className = "dot ok";
    $("statusText").innerHTML = `<b>已连接 MOMO</b>`;
    $("bridgeDetail").textContent = `环回桥 127.0.0.1:${raw.port} · pid ${raw.pid}`;
    $("btnSend").disabled = false;
    if (firstTime) log(`已连接 MOMO（端口 ${raw.port}）`);
  } catch (e) {
    if (bridge) log("与 MOMO 断开：等待其重新启动…");
    else if ($("log").textContent === "—") log(`MOMO 未启动（${e.message}）`);
    bridge = null;
    $("dot").className = "dot err";
    $("statusText").innerHTML = "<b>MOMO 未运行</b>";
    $("bridgeDetail").textContent = "请先启动 MOMO 智能画布，再点「重新连接」；连接成功后这里会常驻监听。";
    $("btnSend").disabled = true;
  }
}

async function sendSelection(targetValue) {
  if (!bridge) return;
  try {
    const items = await eagle.item.getSelected();
    const ids = items.map((it) => it.id).filter(Boolean).slice(0, 500);
    if (!ids.length) {
      log("没有选中任何素材——在 Eagle 里选中一项再发送");
      return;
    }
    const resp = await fetch(`http://127.0.0.1:${bridge.port}/v1/import-selection?token=${encodeURIComponent(bridge.token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-MOMO-Bridge-Token": bridge.token },
      body: JSON.stringify({ itemIds: ids, target: targetValue }),
    });
    const json = await resp.json();
    if (json.status === "error") throw new Error(json.message || "MOMO 拒绝了请求");
    log(`已把 ${json.accepted ?? ids.length} 个选中素材发给 MOMO${targetValue ? "（放入画布）" : ""}`);
  } catch (e) {
    log(`发送失败：${e.message}`);
  }
}

function startPolling() {
  if (timer) clearInterval(timer);
  void checkBridge();
  timer = setInterval(() => void checkBridge(), 8000);
}

window.addEventListener("DOMContentLoaded", () => {
  $("btnRetry").addEventListener("click", () => {
    bridge = null;
    $("log").textContent = "—";
    void checkBridge();
  });
  $("btnSend").addEventListener("click", () => {
    const target = document.querySelector('input[name="target"]:checked');
    void sendSelection(target && target.value !== "" ? target.value : undefined);
  });
  startPolling();
});
