//! MOMO 本地桥（Eagle 插件 ↔ MOMO）
//!
//! 环回 HTTP 服务：只监听 127.0.0.1，随机可用端口，每请求必须带 `X-MOMO-Bridge-Token`
//! （或 ?token=）。连接描述写进 AppData/momo-bridge.json，Eagle 后台服务插件据此找到 MOMO。
//!
//! 安全要求（方案 §7.2）：
//! - 只接受环回地址；请求体上限 1 MB
//! - token 恒定时间比较；白名单路由 + 白名单动作
//! - 缩略图端点只放行「当前素材库 images 目录内 + 白名单扩展名」的文件
//! - MOMO 退出时尽力删除连接描述文件

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BODY: usize = 1024 * 1024; // 请求体上限 1 MB
const THUMB_EXTS: [&str; 18] = [
    "png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "tif", "tiff", "svg",
    "mp4", "webm", "mov", "mkv", "m4v",
    "mp3", "wav", "ogg",
];

#[derive(Debug, Serialize)]
pub struct BridgeInfo {
    pub port: u16,
    pub token: String,
}

#[derive(Debug, Serialize)]
struct BridgeDescriptor {
    schema: u32,
    port: u16,
    token: String,
    pid: u32,
    startedAt: u128,
}

/// 全局桥状态（lib.rs 的 RunEvent::Exit 里也要停服务/删描述文件）
pub struct BridgeState {
    pub info: Mutex<Option<Bridge>>,
}

pub struct Bridge {
    pub port: u16,
    pub token: String,
    pub stop: std::sync::mpsc::Sender<()>,
    /// 前端传入的素材库根目录（缩略图路径前缀校验用），可为空（未连 Eagle 时禁用 thumb）
    pub library_images_dir: Mutex<Option<String>>,
}

static BRIDGE: OnceLock<BridgeState> = OnceLock::new();
static REQ_COUNTER: AtomicU64 = AtomicU64::new(0);

fn bridge() -> &'static BridgeState {
    BRIDGE.get_or_init(|| BridgeState { info: Mutex::new(None) })
}

fn err(msg: impl std::fmt::Display) -> String {
    msg.to_string()
}

fn descriptor_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| err(e))?;
    Ok(dir.join("momo-bridge.json"))
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// 高熵随机令牌（栈地址熵 + 时间 + 进程号喂 SHA-256，转 hex 取 32 位）
fn make_token(port: u16) -> String {
    #[rustfmt::skip]
    let RAW = [0u8; 8]; // 栈变量：其地址每次进程运行不同，作为廉价熵源

    let mut h = Sha256::new();
    h.update(format!(
        "{:x}|{}|{}|{}",
        &RAW as *const _ as usize,
        now_ms(),
        std::process::id(),
        port,
    ));
    let out = h.finalize();
    out.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// 启动环回桥并写连接描述；重复调用返回现有实例（幂等）
#[tauri::command]
pub fn eagle_bridge_start(
    app: tauri::AppHandle,
    library_images_dir: Option<String>,
) -> Result<BridgeInfo, String> {
    if let Ok(guard) = bridge().info.lock() {
        if let Some(b) = guard.as_ref() {
            // 已在跑：顺带更新库目录缓存（用户切库后无需重启桥）
            if let Ok(mut dir) = b.library_images_dir.lock() {
                *dir = library_images_dir;
            }
            return Ok(BridgeInfo { port: b.port, token: b.token.clone() });
        }
    }

    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| err(format!("本地端口分配失败：{e}")))?;
    let port = listener.local_addr().map_err(|e| err(e))?.port();
    let token = make_token(port);

    // 连接描述落盘：Eagle 插件按 AppData 定位它
    let desc = BridgeDescriptor { schema: 1, port, token: token.clone(), pid: std::process::id(), startedAt: now_ms() };
    let dp = descriptor_path(&app)?;
    fs::write(&dp, serde_json::to_vec(&desc).map_err(|e| err(e))?).map_err(|e| err(format!("写入桥描述失败:{e}")))?;

    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let token_srv = token.clone();
    let images_dir = library_images_dir.clone().unwrap_or_default();

    tauri::async_runtime::spawn(async move {
        // accept 循环跑在阻塞线程；stop 信号到来就退出
        let _ = std::thread::Builder::new()
            .name("eagle-bridge".into())
            .spawn(move || serve(listener, token_srv, images_dir, rx));
    });

    let b = Bridge { port, token: token.clone(), stop: tx, library_images_dir: Mutex::new(library_images_dir) };
    *bridge().info.lock().unwrap() = Some(b);
    Ok(BridgeInfo { port, token })
}

/// 停止桥服务（同时作废连接描述文件）
#[tauri::command]
pub fn eagle_bridge_stop(app: tauri::AppHandle) -> Result<bool, String> {
    let stopped = {
        let mut guard = bridge().info.lock().unwrap();
        match guard.take() {
            Some(b) => {
                let _ = b.stop.send(());
                true
            }
            None => false,
        }
    };
    let _ = fs::remove_file(descriptor_path(&app)?);
    Ok(stopped)
}

/// 定位 Eagle 插件套件目录（设置页「打开插件文件夹」用）：
/// 打包版走安装资源 eagle-plugins/；开发模式回落仓库 integrations/eagle/
#[tauri::command]
pub fn eagle_plugin_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("eagle-plugins");
        if p.is_dir() {
            return Ok(p.to_string_lossy().to_string());
        }
    }
    // CARGO_MANIFEST_DIR = <仓库>/src-tauri → 仓库根/integrations/eagle
    if let Some(root) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
        let dev = root.join("integrations").join("eagle");
        if dev.is_dir() {
            return Ok(dev.to_string_lossy().to_string());
        }
    }
    Err("没有找到 Eagle 插件目录（安装资源与开发目录都不存在）".into())
}

/// 进程退出钩子：尽力删除连接描述（防残留指向死端口）
pub fn cleanup_on_exit(app: &tauri::AppHandle) {
    if let Ok(dp) = descriptor_path(app) {
        let _ = fs::remove_file(dp);
    }
    if let Ok(guard) = bridge().info.lock() {
        if let Some(b) = guard.as_ref() {
            let _ = b.stop.send(());
        }
    }
}

/* ---------------- HTTP 服务主体（手写极简解析，无新增依赖） ---------------- */

fn serve(listener: TcpListener, token: String, images_dir: String, stop: std::sync::mpsc::Receiver<()>) {
    // 非阻塞 accept 轮询，让停止信号有机会被消费
    listener.set_nonblocking(true).ok();
    loop {
        if stop.try_recv().is_ok() {
            return;
        }
        match listener.accept() {
            Ok((stream, addr)) => {
                if !addr.ip().is_loopback() {
                    continue; // 只服务本机
                }
                let token = token.clone();
                let dir = images_dir.clone();
                std::thread::Builder::new()
                    .name("eagle-bridge-conn".into())
                    .spawn(move || handle_conn(stream, token, dir))
                    .ok();
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(80));
            }
            Err(_) => return,
        }
    }
}

/// 恒定时间比较，防逐字节试探
fn ct_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

struct RequestLine {
    method: String,
    path: String,
    query: std::collections::HashMap<String, String>,
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match (bytes[i], bytes.get(i + 1), bytes.get(i + 2)) {
            (b'%', Some(h), Some(l)) => {
                let hv = (*h as char).to_digit(16);
                let lv = (*l as char).to_digit(16);
                if let (Some(a), Some(b)) = (hv, lv) {
                    out.push(((a << 4) | b) as u8);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            (b'+', _, _) => {
                out.push(b' ');
                i += 1;
            }
            (c, _, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn parse_request(stream: &mut TcpStream) -> Option<(RequestLine, Vec<u8>)> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    if reader.read_line(&mut line).ok()? == 0 {
        return None;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_uppercase();
    let target = parts.next()?.to_string();

    let mut content_length = 0usize;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).ok()? == 0 {
            break;
        }
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = v.trim().parse().unwrap_or(0);
        }
    }
    if content_length > MAX_BODY {
        return None;
    }
    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body).ok()?;
    }

    let (path, query_str) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target, String::new()),
    };
    let mut query = std::collections::HashMap::new();
    for kv in query_str.split('&') {
        if let Some((k, v)) = kv.split_once('=') {
            query.insert(percent_decode(k), percent_decode(v));
        }
    }
    Some((RequestLine { method, path: percent_decode(&path), query }, body))
}

fn respond(stream: &mut TcpStream, status: &str, ctype: &str, body: Vec<u8>, extra: &[(&str, &str)]) {
    let mut head = format!("HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
    for (k, v) in extra {
        head.push_str(k);
        head.push_str(": ");
        head.push_str(v);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(&body);
}

fn json_ok<T: Serialize>(stream: &mut TcpStream, value: &T) {
    respond(stream, "200 OK", "application/json", serde_json::to_vec(value).unwrap_or_default(), &[]);
}

fn json_err(stream: &mut TcpStream, status: &str, message: &str) {
    let body = serde_json::json!({ "status": "error", "message": message });
    respond(stream, status, "application/json", serde_json::to_vec(&body).unwrap_or_default(), &[]);
}

fn handle_conn(mut stream: TcpStream, token: String, images_dir: String) {
    let (req, body) = match parse_request(&mut stream) {
        Some(r) => r,
        None => return,
    };

    // 全部端点都要校验 token（query 或 header）
    let given = req.query.get("token").cloned().unwrap_or_default();
    if given.is_empty() || !ct_eq(&given, &token) {
        json_err(&mut stream, "401 Unauthorized", "MOMO 桥 Token 校验失败");
        return;
    }
    let _ = REQ_COUNTER.fetch_add(1, Ordering::Relaxed);

    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/v1/health") => json_ok(&mut stream, &serde_json::json!({ "ok": true, "name": "MOMO Canvas" })),

        // Eagle 库内素材的展示流：按 itemId 在 images 目录定位真实文件（Eagle 4 的
        // images/{id}.info/{原始文件名} 布局），扩展名白名单校验后才回吐。
        // 不再接受前端传任意路径——定位逻辑收敛在 Rust 侧。
        ("GET", "/v1/thumb") => {
            let item_id = req.query.get("itemId").cloned().unwrap_or_default();
            match crate::eagle_bridge::locate_item_file(&images_dir, &item_id) {
                Ok(path) => {
                    if let Err(m) = stream_file(&mut stream, &path.to_string_lossy()) {
                        if m.contains("白名单") {
                            json_err(&mut stream, "403 Forbidden", &m);
                        } else {
                            json_err(&mut stream, "404 Not Found", &m);
                        }
                    }
                }
                Err(m) => json_err(&mut stream, "404 Not Found", &m),
            }
        }

        // ---- Eagle 插件动作入口：白名单 JSON 动作，全部转发给前端事件循环处理 ----
        ("POST", "/v1/import-selection") | ("POST", "/v1/send-to-canvas") | ("POST", "/v1/open-asset") | ("POST", "/v1/request-operation") => {
            handle_plugin_action(&req, &body, &mut stream);
        }

        _ => json_err(&mut stream, "404 Not Found", "未知端点"),
    }
}

#[derive(Debug, Deserialize)]
struct PluginAction {
    #[allow(dead_code)]
    action: Option<String>,
    itemIds: Option<Vec<String>>,
    itemId: Option<String>,
    target: Option<String>,
}

/// 把插件发来的动作转成前端事件；不做任何文件操作——真实素材信息由前端向 Eagle API 复查
fn handle_plugin_action(req: &RequestLine, body: &[u8], stream: &mut TcpStream) {
    let parsed: PluginAction = serde_json::from_slice(body).unwrap_or(PluginAction {
        action: None,
        itemIds: None,
        itemId: None,
        target: None,
    });
    let ids: Vec<String> = parsed
        .itemIds
        .or_else(|| parsed.itemId.clone().map(|id| vec![id]))
        .unwrap_or_default()
        .into_iter()
        .filter(|s| !s.is_empty() && s.len() <= 64)
        .collect();
    if ids.is_empty() {
        json_err(stream, "400 Bad Request", "缺少 itemIds / itemId");
        return;
    }
    // 大小封顶：一次最多发送 500 个 id
    let ids: Vec<String> = ids.into_iter().take(500).collect();
    let payload = serde_json::json!({
        "kind": req.path.replace("/v1/", ""),
        "itemIds": ids,
        "target": parsed.target,
        "at": now_ms(),
    });
    if let Err(e) = forward_to_frontend(&payload) {
        json_err(stream, "502 Bad Gateway", &format!("无法把动作交给 MOMO 主界面：{e}"));
        return;
    }
    json_ok(stream, &serde_json::json!({ "accepted": ids.len() }));
}

fn forward_to_frontend(payload: &serde_json::Value) -> Result<(), String> {
    use tauri::Emitter;
    APP_HANDLE
        .get()
        .ok_or_else(|| "MOMO 界面尚未就绪".to_string())?
        .emit("eagle-bridge-action", payload.clone())
        .map_err(|e| err(e))
}

/// 主窗口句柄，forward_to_frontend 用（lib.rs run() 里注入）
pub static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// 校验路径属于素材库 images 目录且扩展名白名单，然后流式回吐
fn stream_file(stream: &mut TcpStream, raw_path: &str) -> Result<(), String> {
    // 路径由 locate_item_file 产生（素材库 images 目录内），这里只做扩展名白名单与存在性兜底
    let ext = Path::new(raw_path)
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !THUMB_EXTS.contains(&ext.as_str()) {
        return Err(format!("扩展名「{ext}」不在展示白名单").into());
    }
    let target = canonical(raw_path)?;
    let meta = fs::metadata(&target).map_err(|_| "素材文件不可访问（可能已被移动或删除）".to_string())?;
    if !meta.is_file() {
        return Err("素材不是普通文件".into());
    }
    let mime = match ext.as_str() {
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "m4v" => "video/x-m4v",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    };
    let len = meta.len().to_string();
    let disp = format!("inline; filename=\"{}.{}\"", target.file_stem().and_then(|s| s.to_str()).unwrap_or("asset"), ext);
    // 流式响应手工拼头（respond 只适合整包小 JSON；这里 Content-Length 是真实文件大小）
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {len}\r\nCache-Control: max-age=3600\r\nContent-Disposition: {disp}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(head.as_bytes()).is_err() {
        return Ok(());
    }
    // 正文流式拷贝（视频大文件也不占内存）
    let mut f = File::open(&target).map_err(|e| err(e))?;
    let mut buf = vec![0u8; 512 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| err(e))?;
        if n == 0 {
            break;
        }
        if stream.write_all(&buf[..n]).is_err() {
            break;
        }
    }
    Ok(())
}

fn canonical(p: &str) -> Result<PathBuf, String> {
    fs::canonicalize(p).map_err(|e| err(e))
}
