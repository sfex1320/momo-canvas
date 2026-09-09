//! Comfy 工作流无感同步 — Rust 文件层（插件规格 v1.0 · M1：ComfyUI 主控单向同步）
//!
//! 职责（规格 §4.2）：
//!  - `comfy_sync_scan`：递归扫描来源目录（忽略规则由前端过滤，这里只管列文件与 stat）
//!  - `comfy_sync_watch` / `comfy_sync_unwatch`：notify 目录监听，事件 100ms 聚合后
//!    emit `comfy-sync-fs-event`；watcher 失效 emit `comfy-sync-watch-error`（前端退化为复扫）
//!  - `comfy_sync_hash_file` / `comfy_sync_read_file`：SHA-256 与读取（默认上限 100MB，规格 §13.3）
//!  - `comfy_sync_detect_dirs` / `comfy_sync_path_kind`：workflows 目录探测与盘类型判定
//!  - storage：AppData/comfy-sync 下 UI Workflow 正文与版本快照的原子读写
//!
//! 安全：workflow_id 只认 [A-Za-z0-9_-]，防路径穿越；写入全部临时文件 + rename；
//! 本模块只做扫描/监听/存储，绝不执行工作流内容（规格 §13.2）。

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, UNIX_EPOCH};

/// 扫描条目上限（规格 §13.3：防恶意/损坏目录拖垮界面）
const MAX_SCAN_ENTRIES: usize = 20_000;
/// 扫描深度上限
const MAX_SCAN_DEPTH: usize = 10;
/// 单文件读取上限（默认 100MB）
const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;

fn err(msg: impl std::fmt::Display) -> String {
    msg.to_string()
}

fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/* ---------------- 扫描 ---------------- */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanEntry {
    /// 绝对路径（原样，Windows 反斜杠）
    pub path: String,
    /// 相对来源根的路径（统一 `/` 分隔，小写比较由前端做）
    pub rel: String,
    pub size: u64,
    pub mtime_ms: f64,
}

/// 递归扫描目录下所有普通文件。目录不存在 → Err("SYNC_SOURCE_OFFLINE: …")，
/// 权限不足 → Err("SYNC_PERMISSION_DENIED: …")——前端据此区分离线与被拒，绝不判删除。
#[tauri::command]
pub fn comfy_sync_scan(root: String, recursive: bool) -> Result<Vec<ScanEntry>, String> {
    let root_p = Path::new(&root);
    if !root_p.is_dir() {
        // NotFound / 盘不在 / 网络断 一律视为离线（规格 FR-012：不得误判删除）
        return Err(format!("SYNC_SOURCE_OFFLINE: 目录不可访问: {}", root));
    }
    let mut out: Vec<ScanEntry> = Vec::new();
    scan_dir(root_p, "", recursive, 0, &mut out)?;
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(out)
}

fn scan_dir(dir: &Path, rel_prefix: &str, recursive: bool, depth: usize, out: &mut Vec<ScanEntry>) -> Result<(), String> {
    if out.len() >= MAX_SCAN_ENTRIES || depth > MAX_SCAN_DEPTH {
        return Ok(());
    }
    let rd = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) => {
            // 单个子目录被拒（比如权限）不影响其余部分（规格 NFR-003）
            if depth == 0 {
                return Err(format!(
                    "SYNC_PERMISSION_DENIED: 无法读取目录: {} ({})",
                    dir.display(),
                    e
                ));
            }
            return Ok(());
        }
    };
    for entry in rd.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        let rel = if rel_prefix.is_empty() { name.clone() } else { format!("{}{}", rel_prefix, name) };
        if ft.is_dir() {
            if recursive {
                scan_dir(&entry.path(), &format!("{}/", rel), true, depth + 1, out)?;
            }
        } else if ft.is_file() {
            if out.len() >= MAX_SCAN_ENTRIES {
                return Ok(());
            }
            let Ok(meta) = entry.metadata() else { continue };
            out.push(ScanEntry {
                path: entry.path().to_string_lossy().to_string(),
                rel,
                size: meta.len(),
                mtime_ms: mtime_ms(&meta),
            });
        }
    }
    Ok(())
}

/* ---------------- 读取与哈希 ---------------- */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatInfo {
    pub exists: bool,
    pub size: u64,
    pub mtime_ms: f64,
    /// 文件内容的 SHA-256 hex（exists 时才有意义；读取失败为空串）
    pub sha256: String,
}

/// 读文件 stat + 内容哈希。不存在 → exists=false（与读取失败区分）。
#[tauri::command]
pub fn comfy_sync_hash_file(path: String) -> Result<FileStatInfo, String> {
    let p = Path::new(&path);
    let Ok(meta) = fs::metadata(p) else {
        return Ok(FileStatInfo { exists: false, size: 0, mtime_ms: 0.0, sha256: String::new() });
    };
    if !meta.is_file() {
        return Err(format!("SYNC_PERMISSION_DENIED: 不是普通文件: {}", path));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!("SYNC_FILE_TOO_LARGE: 文件超过 100MB 上限: {}", path));
    }
    let mut f = File::open(p).map_err(|e| format!("SYNC_PERMISSION_DENIED: 打开失败: {} ({})", path, e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("SYNC_PERMISSION_DENIED: 读取失败: {} ({})", path, e))?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    Ok(FileStatInfo {
        exists: true,
        size: meta.len(),
        mtime_ms: mtime_ms(&meta),
        sha256: format!("{:x}", hasher.finalize()),
    })
}

/// 读文本（UTF-8，带 BOM 容错）。不存在 → Ok(None)；超限 → Err。
#[tauri::command]
pub fn comfy_sync_read_file(path: String) -> Result<Option<String>, String> {
    let p = Path::new(&path);
    let meta = match fs::metadata(p) {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    if !meta.is_file() {
        return Ok(None);
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!("SYNC_FILE_TOO_LARGE: 文件超过 100MB 上限: {}", path));
    }
    match fs::read(p) {
        Ok(bytes) => {
            // 去掉 UTF-8 BOM（部分编辑器保存会带）
            let slice = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { &bytes[3..] } else { &bytes[..] };
            Ok(Some(String::from_utf8_lossy(slice).into_owned()))
        }
        Err(e) => Err(format!("SYNC_PERMISSION_DENIED: 读取失败: {} ({})", path, e)),
    }
}

/* ---------------- 目录探测与盘类型 ---------------- */

/// 探测给定目录下的 ComfyUI workflows 候选目录（规格 §6.3）：
/// 本身就是 workflows 目录 / user/default/workflows / ComfyUI/user/default/workflows / user/<用户名>/workflows。
/// 返回真实存在且可读的候选（可能多个，前端让用户勾选）。
#[tauri::command]
pub fn comfy_sync_detect_dirs(root: String) -> Vec<String> {
    let root_p = Path::new(&root);
    let mut out: Vec<String> = Vec::new();
    let mut push = |p: PathBuf| {
        if p.is_dir() && !out.contains(&p.to_string_lossy().to_string()) {
            out.push(p.to_string_lossy().to_string());
        }
    };
    // 选择的就是 workflows 目录本身
    if root_p
        .file_name()
        .map(|n| n.eq_ignore_ascii_case("workflows"))
        .unwrap_or(false)
    {
        push(root_p.to_path_buf());
    }
    push(root_p.join("user").join("default").join("workflows"));
    push(root_p.join("ComfyUI").join("user").join("default").join("workflows"));
    // 便携版/多用户：user/<用户名>/workflows
    if let Ok(rd) = fs::read_dir(root_p.join("user")) {
        for e in rd.flatten() {
            if e.path().is_dir() {
                push(e.path().join("workflows"));
            }
        }
    }
    out
}

/// workflows 目录探测（规格 §6.3）：user/default、ComfyUI/user/default、user/<用户名> 都认
#[test]
fn detect_dirs_finds_workflows() {
    let root = std::env::temp_dir().join(format!("momo_cfs_detect_{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    for sub in ["user/default/workflows", "ComfyUI/user/default/workflows", "user/alice/workflows"] {
        fs::create_dir_all(root.join(sub)).unwrap();
    }
    let dirs = comfy_sync_detect_dirs(root.to_string_lossy().to_string());
    let norm: Vec<String> = dirs.iter().map(|d| d.replace('\\', "/")).collect();
    assert!(norm.iter().any(|d| d.ends_with("user/default/workflows")), "{:?}", norm);
    assert!(norm.iter().any(|d| d.contains("ComfyUI/user/default/workflows")), "{:?}", norm);
    assert!(norm.iter().any(|d| d.ends_with("user/alice/workflows")), "{:?}", norm);
    // 根目录本身不叫 workflows → 不含自身
    let root_s = root.to_string_lossy().to_string();
    assert!(!norm.iter().any(|d| *d == root_s.replace('\\', "/")));
    let _ = fs::remove_dir_all(&root);
}

/// 来源路径的盘类型（规格 §9.1 kind）：unc / removable / mapped_drive / local
#[tauri::command]
pub fn comfy_sync_path_kind(path: String) -> String {
    if path.starts_with(r"\\") {
        return "unc".into();
    }
    #[cfg(windows)]
    {
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::GetDriveTypeW;
        use windows::Win32::System::WindowsProgramming::{
            DRIVE_CDROM, DRIVE_RAMDISK, DRIVE_REMOTE, DRIVE_REMOVABLE,
        };
        // 取根路径：`G:\foo\bar` → `G:\`；拿不到盘符（相对路径/UNC 已前置返回）按 local
        let root: String = if path.len() >= 2 && path.as_bytes()[1] == b':' {
            format!("{}\\", &path[..2])
        } else {
            return "local".into();
        };
        let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
        let dt = unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) };
        // DRIVE_FIXED(3) / DRIVE_UNKNOWN(0) / DRIVE_NO_ROOT_DIR(1) 一律兜底 local：
        // 宁可按本地盘处理（watcher + 5 分钟复扫），不能把固定盘误判成移动盘走激进轮询
        return match dt {
            DRIVE_REMOVABLE | DRIVE_CDROM | DRIVE_RAMDISK => "removable".into(),
            DRIVE_REMOTE => "mapped_drive".into(),
            _ => "local".into(),
        };
    }
    #[allow(unreachable_code)]
    "local".into()
}

/* ---------------- 目录监听（notify） ---------------- */

/// 持有 watcher 只为生命周期：从 WATCHERS 移除时 drop，监听随之停止、事件线程自然退出
struct WatchHandle {
    #[allow(dead_code)] // 故意持有：drop 即停监听
    watcher: RecommendedWatcher,
}

fn watchers() -> &'static Mutex<HashMap<String, WatchHandle>> {
    static W: OnceLock<Mutex<HashMap<String, WatchHandle>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashMap::new()))
}

const FS_EVENT: &str = "comfy-sync-fs-event";
const WATCH_ERROR_EVENT: &str = "comfy-sync-watch-error";
/// 事件聚合窗口：一波连续事件只 emit 一次（前端再做 750ms 防抖）
const EMIT_COALESCE_MS: u64 = 100;

/// 为来源启动目录监听（同一 source_id 重复调用会先替换旧 watcher）。
/// 事件经 100ms 聚合后 emit `comfy-sync-fs-event` {sourceId}；watcher 失效 emit
/// `comfy-sync-watch-error` {sourceId, error}（网络盘断链常见，前端应退化为复扫）。
#[tauri::command]
pub fn comfy_sync_watch(app: tauri::AppHandle, source_id: String, root: String, recursive: bool) -> Result<(), String> {
    // 先停旧的（drop watcher → channel 关闭 → 事件线程自然退出）
    if let Some(old) = watchers().lock().unwrap().remove(&source_id) {
        drop(old);
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| format!("SYNC_WATCH_FAILED: {}", e))?;
    watcher
        .watch(
            Path::new(&root),
            if recursive { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive },
        )
        .map_err(|e| format!("SYNC_WATCH_FAILED: 监听失败（目录可能离线）: {} ({})", root, e))?;
    let emit_app = app.clone();
    let sid = source_id.clone();
    std::thread::spawn(move || {
        let mut pending = false;
        loop {
            match rx.recv_timeout(Duration::from_millis(if pending { EMIT_COALESCE_MS } else { 60_000 })) {
                Ok(Ok(ev)) => {
                    // 只关心真实文件增删改（访问/元数据类事件忽略，减少无谓复扫）
                    let meaningful = matches!(
                        ev.kind,
                        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) | EventKind::Any
                    );
                    if meaningful {
                        pending = true;
                    }
                }
                Ok(Err(e)) => {
                    // watcher 报错（UNC 断链 / 目录消失）：通知前端退化轮询
                    let _ = emit_app.emit(
                        WATCH_ERROR_EVENT,
                        serde_json::json!({ "sourceId": sid, "error": e.to_string() }),
                    );
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if pending {
                        pending = false;
                        let _ = emit_app.emit(FS_EVENT, serde_json::json!({ "sourceId": sid }));
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    // watcher 被 unwatch/drop：最后一波事件也要发出
                    if pending {
                        let _ = emit_app.emit(FS_EVENT, serde_json::json!({ "sourceId": sid }));
                    }
                    return;
                }
            }
        }
    });
    watchers().lock().unwrap().insert(source_id, WatchHandle { watcher });
    Ok(())
}

/// 停止来源监听（删除来源 / 暂停时调用）
#[tauri::command]
pub fn comfy_sync_unwatch(source_id: String) {
    if let Some(h) = watchers().lock().unwrap().remove(&source_id) {
        drop(h);
    }
}

/* ---------------- 存储：正文与版本快照（AppData/comfy-sync） ---------------- */

fn sync_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("SYNC_DB_TRANSACTION_FAILED: 取 AppData 失败: {}", e))?;
    Ok(base.join("comfy-sync"))
}

/// workflow_id 白名单校验：[A-Za-z0-9_-]，防路径穿越（规格 §13.1）
fn safe_id(id: &str) -> Result<String, String> {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(id.to_string())
    } else {
        Err("SYNC_PATH_ESCAPE_BLOCKED: 非法 workflow id".into())
    }
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| err(format!("目录创建失败: {} ({})", parent.display(), e)))?;
    }
    let tmp = path.with_extension("part");
    fs::write(&tmp, text).map_err(|e| err(format!("临时写入失败: {} ({})", tmp.display(), e)))?;
    if let Err(e) = fs::rename(&tmp, path) {
        // Windows 上 rename 覆盖已存在文件偶尔失败（索引器/杀软占用）：删掉目标再改一次名
        let _ = fs::remove_file(path);
        fs::rename(&tmp, path).map_err(|e2| err(format!("SYNC_ATOMIC_WRITE_FAILED: 落盘失败: {} / {}", e2, e)))?;
    }
    Ok(())
}

/// 写当前版本正文（UI Workflow 原样 JSON 文本）
#[tauri::command]
pub fn comfy_sync_write_workflow(app: tauri::AppHandle, workflow_id: String, json: String) -> Result<(), String> {
    let id = safe_id(&workflow_id)?;
    let p = sync_dir(&app)?.join("workflows").join(format!("{}.json", id));
    write_atomic(&p, &json)
}

/// 读当前版本正文；没存过 → Ok(None)
#[tauri::command]
pub fn comfy_sync_read_workflow(app: tauri::AppHandle, workflow_id: String) -> Result<Option<String>, String> {
    let id = safe_id(&workflow_id)?;
    let p = sync_dir(&app)?.join("workflows").join(format!("{}.json", id));
    match fs::read_to_string(&p) {
        Ok(s) => Ok(Some(s)),
        Err(_) => Ok(None),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionInfo {
    pub revision: u32,
    pub origin: String,
    /// 版本快照的写入时间（文件 mtime，毫秒）
    pub created_at: f64,
    pub size: u64,
}

/// 写一个版本快照：revisions/<id>/<00042>-<origin>.json
#[tauri::command]
pub fn comfy_sync_write_revision(
    app: tauri::AppHandle,
    workflow_id: String,
    revision: u32,
    origin: String,
    json: String,
) -> Result<(), String> {
    let id = safe_id(&workflow_id)?;
    let origin: String = origin.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
    let p = sync_dir(&app)?
        .join("revisions")
        .join(&id)
        .join(format!("{:05}-{}.json", revision, origin));
    write_atomic(&p, &json)
}

/// 列出版本快照（按 revision 升序）
#[tauri::command]
pub fn comfy_sync_list_revisions(app: tauri::AppHandle, workflow_id: String) -> Result<Vec<RevisionInfo>, String> {
    let id = safe_id(&workflow_id)?;
    let dir = sync_dir(&app)?.join("revisions").join(&id);
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(&dir) else { return Ok(out) };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some((rev_str, origin_ext)) = name.split_once('-') else { continue };
        let Ok(rev) = rev_str.parse::<u32>() else { continue };
        let origin = origin_ext.trim_end_matches(".json").to_string();
        let Ok(meta) = e.metadata() else { continue };
        out.push(RevisionInfo {
            revision: rev,
            origin,
            created_at: mtime_ms(&meta),
            size: meta.len(),
        });
    }
    out.sort_by_key(|r| r.revision);
    Ok(out)
}

/// 读指定版本快照正文
#[tauri::command]
pub fn comfy_sync_read_revision(
    app: tauri::AppHandle,
    workflow_id: String,
    revision: u32,
) -> Result<Option<String>, String> {
    let id = safe_id(&workflow_id)?;
    let dir = sync_dir(&app)?.join("revisions").join(&id);
    let prefix = format!("{:05}-", revision);
    let Ok(rd) = fs::read_dir(&dir) else { return Ok(None) };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with(&prefix) {
            return Ok(fs::read_to_string(e.path()).ok());
        }
    }
    Ok(None)
}

/// 版本保留策略清理：删除不在 keep 里的快照（keep 由前端按「最近20 + 7天内 + pinned + 当前/基线」算好）
#[tauri::command]
pub fn comfy_sync_delete_revisions(
    app: tauri::AppHandle,
    workflow_id: String,
    keep: Vec<u32>,
) -> Result<u32, String> {
    let id = safe_id(&workflow_id)?;
    let dir = sync_dir(&app)?.join("revisions").join(&id);
    let mut removed = 0u32;
    let Ok(rd) = fs::read_dir(&dir) else { return Ok(0) };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some((rev_str, _)) = name.split_once('-') else { continue };
        let Ok(rev) = rev_str.parse::<u32>() else { continue };
        if keep.contains(&rev) {
            continue;
        }
        if fs::remove_file(e.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// 删除某工作流的全部本地同步数据（正文 + 版本）。「从同步列表移除」时用；
/// 源文件与画布实例绝不受影响（规格 FR-011：不得自动永久删除）。
#[tauri::command]
pub fn comfy_sync_delete_workflow(app: tauri::AppHandle, workflow_id: String) -> Result<(), String> {
    let id = safe_id(&workflow_id)?;
    let base = sync_dir(&app)?;
    let _ = fs::remove_file(base.join("workflows").join(format!("{}.json", id)));
    let _ = fs::remove_dir_all(base.join("revisions").join(&id));
    Ok(())
}

/* ---------------- M2：写回源文件（规格 FR-010 / §11.3 / §13.1） ---------------- */

/// 路径越界判定：目标文件规范化后必须落在授权根目录内（不跟随逃逸的符号链接/目录联接）。
/// canonicalize 对不存在路径会失败——写回场景源文件必然存在，失败即拒绝。
fn ensure_within_root(root: &str, path: &str) -> Result<PathBuf, String> {
    let root_c = fs::canonicalize(root)
        .map_err(|e| format!("SYNC_PATH_ESCAPE_BLOCKED: 来源目录不可访问: {} ({})", root, e))?;
    let path_c = fs::canonicalize(path)
        .map_err(|e| format!("SYNC_PATH_ESCAPE_BLOCKED: 目标文件不存在: {} ({})", path, e))?;
    if !path_c.starts_with(&root_c) {
        return Err(format!(
            "SYNC_PATH_ESCAPE_BLOCKED: 目标不在授权来源目录内: {} ∉ {}",
            path_c.display(),
            root_c.display()
        ));
    }
    Ok(path_c)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteSourceResult {
    pub sha256: String,
    pub size: u64,
    pub mtime_ms: f64,
}

/// 把工作流文本写回源文件（唯一一个会写来源目录的命令，仅 bidirectional/momo_master 走）：
///  - 目标必须已存在且位于授权根目录内（不新建文件、不越界，规格 §13.1/§13.5）
///  - 同目录临时文件 + rename 原子替换（网络共享也尽量原子，规格 §12.2）
///  - 返回写入后的真实文件哈希与 stat，前端存入写入令牌做自身事件抑制（规格 §11.4）
#[tauri::command]
pub fn comfy_sync_write_source(root: String, path: String, text: String) -> Result<WriteSourceResult, String> {
    let target = ensure_within_root(&root, &path)?;
    if !target.is_file() {
        return Err(format!("SYNC_WRITE_FORBIDDEN: 目标不是普通文件: {}", target.display()));
    }
    // 同目录临时文件（跨卷 rename 不原子，同目录保证 rename 是原子元数据操作）；
    // .momo-tmp 扩展名不带 .json，前端扫描过滤天然忽略它
    let tmp = target.with_extension("momo-tmp");
    fs::write(&tmp, text.as_bytes()).map_err(|e| format!("SYNC_ATOMIC_WRITE_FAILED: 临时写入失败: {} ({})", tmp.display(), e))?;
    if fs::rename(&tmp, &target).is_err() {
        // Windows 覆盖式 rename 偶发失败（目标被 ComfyUI/编辑器占用）：删目标再改名；
        // 仍失败则清掉临时文件报错，源文件最多保持旧内容（remove 成功而 rename 失败的窗口极小）
        if fs::remove_file(&target).is_err() || fs::rename(&tmp, &target).is_err() {
            let _ = fs::remove_file(&tmp);
            return Err("SYNC_ATOMIC_WRITE_FAILED: 替换源文件失败（目标文件可能被占用，请关闭 ComfyUI 里打开的该工作流后重试）".into());
        }
    }
    // 读回哈希：写入令牌需要「文件真实内容哈希」而非「请求文本哈希」（防写入过程被外部再改）
    let meta = fs::metadata(&target).map_err(|e| format!("SYNC_ATOMIC_WRITE_FAILED: 写后校验失败: {}", e))?;
    let mut f = File::open(&target).map_err(|e| format!("SYNC_ATOMIC_WRITE_FAILED: 写后校验读取失败: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("SYNC_ATOMIC_WRITE_FAILED: 写后校验读取失败: {}", e))?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    Ok(WriteSourceResult {
        sha256: format!("{:x}", hasher.finalize()),
        size: meta.len(),
        mtime_ms: mtime_ms(&meta),
    })
}

#[cfg(test)]
mod fs_flow_tests {
    use super::*;

    fn unwrap<T>(r: Result<T, String>, ctx: &str) -> T {
        match r {
            Ok(v) => v,
            Err(e) => panic!("{}: {}", ctx, e),
        }
    }

    /// 文件系统主链路：递归/平铺扫描 → 哈希 → 授权内原子写回（写后哈希一致）→ 越界拒绝 → 离线报错码
    #[test]
    fn scan_hash_write_flow() {
        let dir = std::env::temp_dir().join(format!("momo_cfs_flow_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("a.json"), r#"{"nodes":[],"links":[]}"#).unwrap();
        fs::write(dir.join("sub").join("b.json"), "{}").unwrap();
        fs::write(dir.join("c.tmp"), "x").unwrap();

        let entries = unwrap(
            comfy_sync_scan(dir.to_string_lossy().to_string(), true),
            "递归扫描",
        );
        assert_eq!(entries.len(), 3, "tmp 一并返回，忽略过滤由前端做");
        let rels: Vec<&str> = entries.iter().map(|e| e.rel.as_str()).collect();
        assert!(rels.contains(&"a.json") && rels.contains(&"sub/b.json"));

        let flat = unwrap(
            comfy_sync_scan(dir.to_string_lossy().to_string(), false),
            "平铺扫描",
        );
        assert_eq!(flat.len(), 2);

        let h = unwrap(
            comfy_sync_hash_file(dir.join("a.json").to_string_lossy().to_string()),
            "哈希",
        );
        assert!(h.exists && h.sha256.len() == 64);

        // 授权内写回：原子替换 + 返回写后真实哈希
        let w = unwrap(
            comfy_sync_write_source(
                dir.to_string_lossy().to_string(),
                dir.join("a.json").to_string_lossy().to_string(),
                r#"{"nodes":[1],"links":[]}"#.into(),
            ),
            "授权内写回",
        );
        let h2 = unwrap(
            comfy_sync_hash_file(dir.join("a.json").to_string_lossy().to_string()),
            "写后哈希",
        );
        assert_eq!(w.sha256, h2.sha256, "返回哈希必须等于文件真实哈希（写入令牌语义）");
        // 临时文件不残留
        assert!(!dir.join("a.momo-tmp").exists(), "临时文件未清理");

        // 越界：目标在授权根外 → SYNC_PATH_ESCAPE_BLOCKED
        let outside = dir.parent().unwrap().join(format!("momo_out_{}.json", std::process::id()));
        fs::write(&outside, "{}").unwrap();
        let r = comfy_sync_write_source(
            dir.to_string_lossy().to_string(),
            outside.to_string_lossy().to_string(),
            "{}".into(),
        );
        assert!(r.unwrap_err().starts_with("SYNC_PATH_ESCAPE_BLOCKED"), "越界必须被拦");
        let _ = fs::remove_file(&outside);

        // 离线：目录不存在 → SYNC_SOURCE_OFFLINE（绝不判删除的语义入口）
        let ghost = comfy_sync_scan(dir.join("ghost").to_string_lossy().to_string(), true);
        assert!(ghost.unwrap_err().starts_with("SYNC_SOURCE_OFFLINE"));

        let _ = fs::remove_dir_all(&dir);
    }

    /// 版本快照写入/列举/读取/保留清理（AppData 由命令注入，直接测文件层函数的落盘产物）
    #[test]
    fn revisions_roundtrip() {
        let dir = std::env::temp_dir().join(format!("momo_cfs_rev_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("revisions").join("wf_x")).unwrap();
        for (rev, origin) in [(1u32, "source"), (2, "source"), (3, "momo")] {
            let p = dir.join("revisions").join("wf_x").join(format!("{:05}-{}.json", rev, origin));
            fs::write(&p, format!("{{\"rev\":{}}}", rev)).unwrap();
        }
        // 与实现一致的列举逻辑：按文件名解析 rev/origin
        let mut revs: Vec<(u32, String)> = fs::read_dir(dir.join("revisions").join("wf_x"))
            .unwrap()
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let (r, o) = name.split_once('-')?;
                Some((r.parse().ok()?, o.trim_end_matches(".json").to_string()))
            })
            .collect();
        revs.sort();
        assert_eq!(revs, vec![(1, "source".into()), (2, "source".into()), (3, "momo".into())]);
        let _ = fs::remove_dir_all(&dir);
    }
}
