//! ComfyUI 同步桥（规格 §4.3 / M3）：环回 HTTP 服务 + ComfyUI 前端扩展一键安装
//!
//! 桥解决 watcher 做不到的两件事：
//!  - **保存即时通知**：ComfyUI 里 Ctrl+S 保存工作流时，前端扩展 wrap fetch 捕获
//!    userdata 写入，POST /notify 通知 MOMO（emit `comfy-bridge-save`），跳过防抖即时对账——
//!    网络共享目录也不再等 60 秒复扫（NFR-002 <3s）
//!  - **在 ComfyUI 中打开指定工作流**：扩展每 2s 轮询 GET /pending-open，MOMO 把
//!    「待打开的工作流」一次性放进去，扩展收到后 app.loadGraphData 直接载入画布
//!
//! 安全（同 eagle_plugin_server 的约定）：
//!  - 只监听 127.0.0.1；token 恒定时间比较；请求体上限 1 MB
//!  - 端口固定候选（39871-39875 依次尝试，重启尽量不变），token 首次生成后持久存
//!    AppData/comfy-bridge.json——安装进 ComfyUI 的扩展里嵌的就是这组端口+token，长期有效
//!  - 任意网页都能对本机端口发起请求，因此所有路由都要求 token（防本机其它页面伪造/读取）

use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 固定候选端口：扩展安装时嵌入这组端口依次尝试，MOMO 重启后换端口扩展也能自愈
pub const PORT_CANDIDATES: [u16; 5] = [39871, 39872, 39873, 39874, 39875];

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ComfyBridgeInfo {
    pub port: u16,
    pub token: String,
}

struct PendingOpen {
    path: String,
    text: String,
}

struct Bridge {
    port: u16,
    token: String,
    stop: std::sync::mpsc::Sender<()>,
    pending: Mutex<Option<PendingOpen>>,
}

static BRIDGE: OnceLock<Mutex<Option<Bridge>>> = OnceLock::new();

fn bridge_slot() -> &'static Mutex<Option<Bridge>> {
    BRIDGE.get_or_init(|| Mutex::new(None))
}

fn err(msg: impl std::fmt::Display) -> String {
    msg.to_string()
}

fn descriptor_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| err(e))?;
    Ok(dir.join("comfy-bridge.json"))
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn make_token() -> String {
    use sha2::{Digest, Sha256};
    #[rustfmt::skip]
    let raw = [0u8; 8]; // 栈地址熵（每次进程不同，但 token 会持久化，只在首次生成用一次）
    let mut h = Sha256::new();
    h.update(format!("{:x}|{}|{}", &raw as *const _ as usize, now_ms(), std::process::id()));
    let out = h.finalize();
    out.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// 持久 token：首次生成写 AppData/comfy-bridge.json，之后启动复用（扩展里嵌的是它）
fn load_or_create_token(app: &tauri::AppHandle) -> Result<String, String> {
    let dp = descriptor_path(app)?;
    if let Ok(text) = fs::read_to_string(&dp) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(t) = v.get("token").and_then(|x| x.as_str()) {
                if !t.is_empty() {
                    return Ok(t.to_string());
                }
            }
        }
    }
    let token = make_token();
    // 端口由启动时写入；这里先写 token，端口字段下次启动补
    let json = serde_json::json!({ "schema": 1, "token": token, "pid": std::process::id(), "startedAt": now_ms() });
    fs::write(&dp, serde_json::to_vec(&json).map_err(|e| err(e))? ).map_err(|e| err(format!("写入桥描述失败: {}", e)))?;
    Ok(token)
}

/// 启动同步桥（幂等）。端口优先复用上次端口，被占依次尝试候选表。
#[tauri::command]
pub fn comfy_bridge_start(app: tauri::AppHandle) -> Result<ComfyBridgeInfo, String> {
    if let Some(b) = bridge_slot().lock().unwrap().as_ref() {
        return Ok(ComfyBridgeInfo { port: b.port, token: b.token.clone() });
    }
    let token = load_or_create_token(&app)?;
    // 端口选择：优先描述文件里上次用的端口，失败再走候选表
    let mut prefs: Vec<u16> = Vec::new();
    if let Ok(text) = fs::read_to_string(descriptor_path(&app)?) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(p) = v.get("port").and_then(|x| x.as_u64()) {
                if p > 0 && p <= u16::MAX as u64 && p != 0 {
                    prefs.push(p as u16);
                }
            }
        }
    }
    for p in PORT_CANDIDATES {
        if !prefs.contains(&p) { prefs.push(p); }
    }
    let mut listener: Option<(TcpListener, u16)> = None;
    for p in prefs {
        if let Ok(l) = TcpListener::bind(("127.0.0.1", p)) {
            listener = Some((l, p));
            break;
        }
    }
    let (listener, port) = listener.ok_or("SYNC_SOURCE_OFFLINE: 同步桥端口 39871-39875 全被占用")?;
    // 描述文件刷新（记录本次端口，供下次优先复用与诊断）
    let json = serde_json::json!({ "schema": 1, "port": port, "token": token, "pid": std::process::id(), "startedAt": now_ms() });
    let _ = fs::write(descriptor_path(&app)?, serde_json::to_vec(&json).unwrap_or_default());

    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let token_srv = token.clone();
    let app_srv = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = std::thread::Builder::new()
            .name("comfy-bridge".into())
            .spawn(move || serve(listener, token_srv, app_srv, rx));
    });
    *bridge_slot().lock().unwrap() = Some(Bridge { port, token: token.clone(), stop: tx, pending: Mutex::new(None) });
    Ok(ComfyBridgeInfo { port, token })
}

/// 停止同步桥（应用退出时）
#[tauri::command]
pub fn comfy_bridge_stop() -> Result<bool, String> {
    let stopped = match bridge_slot().lock().unwrap().take() {
        Some(b) => {
            let _ = b.stop.send(());
            true
        }
        None => false,
    };
    Ok(stopped)
}

/// 进程退出钩子（lib.rs Exit 里调用）
pub fn cleanup_on_exit() {
    if let Some(b) = bridge_slot().lock().unwrap().take() {
        let _ = b.stop.send(());
    }
}

/// 放入「待打开」请求（ComfyUI 扩展下一次轮询取走，一次性）
#[tauri::command]
pub fn comfy_bridge_set_pending_open(path: String, text: String) -> Result<(), String> {
    let guard = bridge_slot().lock().unwrap();
    let Some(b) = guard.as_ref() else {
        return Err("同步桥未启动".into());
    };
    *b.pending.lock().unwrap() = Some(PendingOpen { path, text });
    Ok(())
}

/* ---------------- HTTP 服务主体（手写极简解析，无新增依赖） ---------------- */

const CORS: &str = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Method: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n";

fn serve(listener: TcpListener, token: String, app: tauri::AppHandle, stop: std::sync::mpsc::Receiver<()>) {
    listener.set_nonblocking(true).ok();
    loop {
        if stop.try_recv().is_ok() {
            return;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                handle_conn(stream, &token, &app);
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(_) => std::thread::sleep(Duration::from_millis(300)),
        }
    }
}

fn respond(stream: &mut TcpStream, status: &str, body: &str, content_type: &str) {
    let resp = format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n{}",
        status,
        content_type,
        body.len(),
        CORS,
        body,
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
}

fn token_eq(a: &str, b: &str) -> bool {
    // 恒定时间比较（长度不同直接 false，长度相同逐字节累积差）
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn handle_conn(mut stream: TcpStream, token: &str, app: &tauri::AppHandle) {
    use tauri::Emitter;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let Ok(reader) = stream.try_clone() else { return };
    let mut reader = BufReader::new(reader);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        respond(&mut stream, "400 Bad Request", "{}", "application/json");
        return;
    }
    let method = parts[0];
    let target = parts[1];
    // 解析 query（忽略 body：notify 的实质信息全在 query，防大 body 攻击面）
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, q),
        None => (target, ""),
    };
    let qget = |want: &str| -> Option<String> {
        query.split('&').find_map(|kv| {
            let (k, v) = kv.split_once('=')?;
            if k == want {
                Some(percent_decode(v))
            } else {
                None
            }
        })
    };
    // 头读掉（Content-Length 内的 body 不读：上限保护由「不读」本身保证）
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) if line.trim().is_empty() => break,
            Ok(_) => continue,
            Err(_) => break,
        }
    }

    let req_token = qget("token").unwrap_or_default();
    if !token_eq(&req_token, token) {
        respond(&mut stream, "403 Forbidden", "{}", "application/json");
        return;
    }
    match (method, path) {
        ("OPTIONS", _) => respond(&mut stream, "204 No Content", "", "text/plain"),
        ("POST", "/notify") => {
            // ComfyUI 扩展捕获的保存事件：带上 userdata 相对路径（workflows/xxx.json）
            let wf_path = qget("path").unwrap_or_default();
            let _ = app.emit("comfy-bridge-save", serde_json::json!({ "path": wf_path }));
            respond(&mut stream, "200 OK", "{\"ok\":true}", "application/json");
        }
        ("GET", "/pending-open") => {
            let body = {
                let guard = bridge_slot().lock().unwrap();
                match guard.as_ref().and_then(|b| b.pending.lock().unwrap().take()) {
                    Some(p) => serde_json::json!({ "path": p.path, "text": p.text }).to_string(),
                    None => "{}".to_string(),
                }
            };
            respond(&mut stream, "200 OK", &body, "application/json");
        }
        ("GET", "/ping") => respond(&mut stream, "200 OK", "{\"ok\":true}", "application/json"),
        _ => respond(&mut stream, "404 Not Found", "{}", "application/json"),
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let hex = |b: u8| -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    };
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                    out.push(h * 16 + l);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/* ---------------- ComfyUI 前端扩展一键安装（规格 §4.3） ---------------- */

/// 生成 ComfyUI 前端扩展的 JS 文本（嵌候选端口与 token；ESM，ComfyUI 1.x 扩展协议）
fn bridge_js(ports: &[u16], token: &str) -> String {
    let ports_js = format!("[{}]", ports.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(", "));
    format!(
        r#"// MOMO Sync Bridge —— 由 MOMO 智能画布自动生成，请勿手改
// 保存即通知 MOMO（即时同步）+ 轮询「在 ComfyUI 中打开」请求
import {{ app }} from "../../scripts/app.js";

const PORTS = {ports};
const TOKEN = "{token}";
let BASE = null; // 已探通的桥地址缓存

async function bridgeUrl(path) {{
  if (BASE) return BASE + path;
  for (const p of PORTS) {{
    const base = `http://127.0.0.1:${{p}}`;
    try {{
      const r = await fetch(`${{base}}/ping?token=${{TOKEN}}`, {{ cache: "no-store" }});
      if (r.ok) {{
        const j = await r.json();
        if (j && j.ok) {{
          BASE = base;
          return base + path;
        }}
      }}
    }} catch (e) {{ /* 下一个候选端口 */ }}
  }}
  return null;
}}

app.registerExtension({{
  name: "MOMO.SyncBridge",
  async setup() {{
    // 1) 保存即时通知：wrap fetch，捕获对 userdata/workflows 的写入（ComfyUI Ctrl+S 的落盘请求）
    const origFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {{
      const res = await origFetch(...args);
      try {{
        const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
        const method = ((args[1] && args[1].method) || "GET").toUpperCase();
        if (method === "POST" && /\/userdata\//.test(url) && /workflows/.test(decodeURIComponent(url))) {{
          const rel = decodeURIComponent(url).match(/userdata\/([^?]+)/);
          const u = await bridgeUrl(`/notify?token=${{TOKEN}}&path=${{encodeURIComponent(rel ? rel[1] : "")}}`);
          if (u) fetch(u, {{ mode: "no-cors" }}).catch(() => {{}});
        }}
      }} catch (e) {{ /* 通知失败不影响 ComfyUI 自身保存 */ }}
      return res;
    }};
    // 2) 「在 ComfyUI 中打开」：轮询待打开请求（一次性，取走即加载到画布）
    setInterval(async () => {{
      try {{
        const u = await bridgeUrl(`/pending-open?token=${{TOKEN}}`);
        if (!u) return;
        const r = await origFetch(u, {{ cache: "no-store" }});
        const j = await r.json();
        if (j && j.text) {{
          await app.loadGraphData(JSON.parse(j.text));
          console.info("[MOMO Bridge] 已打开 MOMO 请求的工作流");
        }}
      }} catch (e) {{ /* MOMO 不在运行时静默 */ }}
    }}, 2000);
  }},
}});
"#,
        ports = ports_js,
        token = token,
    )
}

/// 把同步桥扩展安装到 ComfyUI 的 custom_nodes 目录（用户选 ComfyUI 根目录或 custom_nodes 均可）。
/// 写入 custom_nodes/momo_sync_bridge/{__init__.py, js/momo_bridge.js}；已存在则覆盖更新。
/// 返回安装目录。需要用户重启 ComfyUI 后生效。
#[tauri::command]
pub fn comfy_bridge_install(app: tauri::AppHandle, comfy_dir: String) -> Result<String, String> {
    let root = Path::new(&comfy_dir);
    // 接受三种输入：ComfyUI 根目录 / custom_nodes 本身 / momo_sync_bridge 本身
    let cn = if root.file_name().map(|n| n.eq_ignore_ascii_case("custom_nodes")).unwrap_or(false) {
        root.to_path_buf()
    } else if root.file_name().map(|n| n.eq_ignore_ascii_case("momo_sync_bridge")).unwrap_or(false) {
        root.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| root.to_path_buf())
    } else {
        root.join("custom_nodes")
    };
    if !cn.is_dir() {
        return Err(format!("SYNC_PERMISSION_DENIED: 没有找到 custom_nodes 目录（试过 {}）——请选择 ComfyUI 根目录或 custom_nodes 目录", cn.display()));
    }
    let info = comfy_bridge_start(app.clone())?;
    let dir = cn.join("momo_sync_bridge");
    fs::create_dir_all(dir.join("js")).map_err(|e| err(format!("创建扩展目录失败: {} ({})", dir.display(), e)))?;
    let init_py = r#"# MOMO Sync Bridge（由 MOMO 智能画布安装）
# 只提供前端扩展，不注册任何节点
WEB_DIRECTORY = "./js"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
"#;
    fs::write(dir.join("__init__.py"), init_py).map_err(|e| err(format!("写入 __init__.py 失败: {}", e)))?;
    let js = bridge_js(&PORT_CANDIDATES, &info.token);
    fs::write(dir.join("js").join("momo_bridge.js"), js).map_err(|e| err(format!("写入扩展失败: {}", e)))?;
    Ok(dir.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 生成的扩展 JS 形状：插值正确、无 Rust format! 残留转义、JS 模板插值完整
    #[test]
    fn bridge_js_shape() {
        let js = bridge_js(&PORT_CANDIDATES, "testtoken123");
        assert!(js.contains("const PORTS = [39871, 39872, 39873, 39874, 39875];"), "端口表插值: {}", &js[..200.min(js.len())]);
        assert!(js.contains(r#"const TOKEN = "testtoken123";"#));
        assert!(!js.contains("{ports"), "Rust 插值残留");
        assert!(!js.contains("{token"), "Rust 插值残留");
        assert!(!js.contains("{{"), "Rust 大括号转义残留");
        assert!(js.contains("${p}"), "JS 模板插值（端口）被吃掉");
        assert!(js.contains("${TOKEN}"), "JS 模板插值（令牌）被吃掉");
        assert!(js.contains("${base}"), "JS 模板插值（BASE）被吃掉");
        assert!(js.contains("app.registerExtension"));
        assert!(js.contains("pending-open"));
        assert!(js.contains("/notify"));
    }

    /// percent 解码：hex 转义、+ 转空格、越界 % 保持原样
    #[test]
    fn percent_decode_cases() {
        assert_eq!(percent_decode("workflows%2FMy%20Flow.json"), "workflows/My Flow.json");
        assert_eq!(percent_decode("a+b"), "a b");
        assert_eq!(percent_decode("%2B"), "+"); // encodeURIComponent 的 + 是 %2B
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    /// token 恒定时间比较的语义（等/不等/长度不同）
    #[test]
    fn token_compare() {
        assert!(token_eq("abcdef", "abcdef"));
        assert!(!token_eq("abcdef", "abcdeg"));
        assert!(!token_eq("abc", "abcd"));
    }
}
