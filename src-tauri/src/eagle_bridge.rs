//! Eagle 资产桥 — Rust 文件层
//!
//! 前端把文件读成 Uint8Array 的老路不适合几 GB 的视频：这里提供流式文件复制与流式
//! SHA-256 指纹，Eagle 拉回的素材直接在 Rust 侧落进 AppData/assets，WebView 内存不随
//! 文件大小增长。
//!
//! 安全约定：
//! - 源路径必须是已存在的普通文件（拒绝目录/设备）
//! - 目标目录固定为 AppData/assets，由本模块自行推导，不信任前端传入的目标路径
//! - 先写 .part 临时文件，完整落盘并校验后原子改名；失败清理临时文件，不动源文件

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const COPY_BUF: usize = 512 * 1024;
/// 流式哈希的分块读取长度（大视频也要快：512KB 块 + BufReader）
const HASH_BUF: usize = 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
pub struct FileFingerprint {
    pub size: u64,
    /// 毫秒时间戳
    pub mtimeMs: f64,
    pub ext: String,
    /// 流式 SHA-256 的 hex（0x 前缀无）
    pub fingerprint: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CopiedAssetFile {
    pub path: String,
    pub size: u64,
    pub mtimeMs: f64,
    pub ext: String,
    pub fingerprint: String,
}

fn err(msg: impl std::fmt::Display) -> String {
    msg.to_string()
}

/// SystemTime → 毫秒
fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// 校验源路径并返回 (metadata, extension)
fn validate_source(path: &str) -> Result<(fs::Metadata, String), String> {
    let p = Path::new(path);
    let meta = fs::metadata(p).map_err(|e| err(format!("源文件不可访问：{e}")))?;
    if !meta.is_file() {
        return Err("源路径不是普通文件（不允许目录或设备）".into());
    }
    let ext = p
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    Ok((meta, ext))
}

/// 在 Eagle 素材库 images 目录里定位某个素材的主文件。
///
/// Eagle 4 实测布局：`images/{itemId}.info/{原始文件名}`（旁边有 metadata.json 与
/// `*_thumbnail.png`），不存在旧版直存 `images/{itemId}.{ext}` 的场景时兜底扫一遍。
/// 主文件 = .info 目录里除 metadata.json 外最大那个非缩略图文件。
pub fn locate_item_file(images_dir: &str, item_id: &str) -> Result<PathBuf, String> {
    if item_id.is_empty() || !item_id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("素材编号不合法".into());
    }
    let base = Path::new(images_dir);

    // ① Eagle 4 布局：{id}.info 目录
    let info = base.join(format!("{item_id}.info"));
    if info.is_dir() {
        let mut best: Option<(u64, PathBuf)> = None;
        let rd = fs::read_dir(&info).map_err(|e| err(format!("读取素材目录失败：{e}")))?;
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name == "metadata.json" || name.contains("_thumbnail") {
                continue;
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            if best.as_ref().map_or(true, |(s, _)| size > *s) {
                best = Some((size, entry.path()));
            }
        }
        if let Some((_, p)) = best {
            return Ok(p);
        }
        return Err("素材文件不存在（.info 目录里只有元数据）".into());
    }

    // ② 旧布局兜底：images/{id}.{ext} 直存（扩展名未知，按前缀匹配；Windows 大小写不敏感，统一小写比较）
    if let Ok(rd) = fs::read_dir(base) {
        let prefix = format!("{item_id}.").to_lowercase();
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name.starts_with(&prefix) {
                return Ok(entry.path());
            }
        }
    }
    Err("素材文件不存在（可能已被移动或删除）".into())
}

/// 前端导入 Eagle 素材前取真实文件路径（images 目录 + itemId → 绝对路径）
#[tauri::command]
pub fn eagle_locate_item_file(images_dir: String, item_id: String) -> Result<String, String> {
    locate_item_file(&images_dir, &item_id).map(|p| p.to_string_lossy().to_string())
}

fn app_assets_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| err(format!("无法定位应用数据目录：{e}")))?
        .join("assets");
    fs::create_dir_all(&dir).map_err(|e| err(format!("创建资产目录失败：{e}")))?;
    Ok(dir)
}

/// 复制 + 计算指纹的公共实现：先 .part 再原子改名
fn copy_stream(src: &Path, dest_dir: &Path, ext: &str) -> Result<CopiedAssetFile, String> {
    let mut src_f = File::open(src).map_err(|e| err(format!("打开源文件失败：{e}")))?;
    let meta = src_f.metadata().map_err(|e| err(format!("读取源文件信息失败：{e}")))?;

    let name = format!(
        "eagle_{}_{}.{}",
        std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
        nanoid(),
        if ext.is_empty() { "bin" } else { ext }
    );
    let part_path = dest_dir.join(format!("{name}.part"));
    let dest_path = dest_dir.join(&name);

    let result = (|| -> Result<String, String> {
        let mut dst = BufWriter::with_capacity(COPY_BUF, File::create(&part_path).map_err(|e| err(format!("创建目标文件失败：{e}")))?);
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; COPY_BUF];
        loop {
            let n = src_f.read(&mut buf).map_err(|e| err(format!("读取源文件失败：{e}")))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            dst.write_all(&buf[..n]).map_err(|e| err(format!("写入目标文件失败：{e}")))?;
        }
        dst.flush().map_err(|e| err(format!("刷盘失败：{e}")))?;
        drop(dst);

        // 完整性校验：落盘尺寸必须等于源尺寸，防止截断
        let written = fs::metadata(&part_path).map_err(|e| err(e))?.len();
        if written != meta.len() {
            return Err(format!("复制校验失败（{written} / {total} 字节），已放弃本次导入", total = meta.len()));
        }

        fs::rename(&part_path, &dest_path).map_err(|e| err(format!("落位失败：{e}")))?;
        Ok(hex(&hasher.finalize()))
    })();

    match result {
        Ok(fp) => Ok(CopiedAssetFile {
            path: dest_path.to_string_lossy().to_string(),
            size: meta.len(),
            mtimeMs: mtime_ms(&meta),
            ext: ext.to_string(),
            fingerprint: fp,
        }),
        Err(e) => {
            let _ = fs::remove_file(&part_path); // 清理临时文件，绝不动源文件
            Err(e)
        }
    }
}

/// 流式计算文件 SHA-256 指纹（不整读进内存）
fn hash_stream(path: &Path) -> Result<FileFingerprint, String> {
    let (meta, ext) = validate_source(path.to_str().ok_or("路径编码错误")?)?;
    let f = File::open(path).map_err(|e| err(format!("打开文件失败：{e}")))?;
    let mut reader = BufReader::with_capacity(HASH_BUF, f);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; HASH_BUF];
    loop {
        let n = reader.read(&mut buf).map_err(|e| err(format!("读取失败:{e}")))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(FileFingerprint {
        size: meta.len(),
        mtimeMs: mtime_ms(&meta),
        ext,
        fingerprint: hex(&hasher.finalize()),
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 文件名随机后缀：纳秒 + 进程内递增计数（防同毫秒冲突）
fn nanoid() -> String {
    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let a = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().subsec_nanos();
    let b = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{a:08x}{b:04x}")
}

/// 计算任意本地文件的流式指纹（Eagle 同步前的快速变化检查）
#[tauri::command]
pub async fn eagle_file_fingerprint(_app: tauri::AppHandle, path: String) -> Result<FileFingerprint, String> {
    // 阻塞 IO 挪到阻塞线程池，不占异步运行时
    tauri::async_runtime::spawn_blocking(move || hash_stream(Path::new(&path)))
        .await
        .map_err(|e| err(format!("任务调度失败：{e}")))?
}

/// 把 Eagle 库内的文件流式复制进 AppData/assets（大视频不经前端内存），返回最终资产路径与指纹
#[tauri::command]
pub async fn eagle_copy_into_assets(
    app: tauri::AppHandle,
    source_path: String,
    preferred_ext: Option<String>,
) -> Result<CopiedAssetFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, ext) = validate_source(&source_path)?;
        if ext.is_empty() {
            return Err("源文件没有扩展名，无法识别素材类型".into());
        }
        let dir = app_assets_dir(&app)?;
        copy_stream(Path::new(&source_path), &dir, preferred_ext.as_deref().unwrap_or(&ext))
    })
    .await
    .map_err(|e| err(format!("任务调度失败：{e}")))?
}

/* ---------------- 单元测试：Eagle 库文件定位（纯文件系统逻辑） ---------------- */

#[cfg(test)]
mod tests {
    use super::*;

    /// Eagle 4 布局：images/{id}.info/{主文件}，metadata.json 与 *_thumbnail 必须被排除
    #[test]
    fn locate_prefers_main_file_in_info_dir() {
        let tmp = std::env::temp_dir().join(format!("momo_locate_test_{}", std::process::id()));
        let images = tmp.join("images");
        let info = images.join("ABC123.info");
        fs::create_dir_all(&info).unwrap();
        fs::write(info.join("metadata.json"), b"{}").unwrap();
        fs::write(info.join("cover_thumbnail.png"), b"tiny").unwrap();
        fs::write(info.join("MiSans-Bold.ttf"), vec![0u8; 100]).unwrap();

        let hit = locate_item_file(images.to_str().unwrap(), "ABC123").unwrap();
        assert!(hit.to_string_lossy().ends_with("MiSans-Bold.ttf"));
        let _ = fs::remove_dir_all(&tmp);
    }

    /// 多个候选文件时取最大者（防把说明文档当主文件）
    #[test]
    fn locate_picks_largest_candidate() {
        let tmp = std::env::temp_dir().join(format!("momo_locate_big_{}", std::process::id()));
        let info = tmp.join("images").join("XYZ.info");
        fs::create_dir_all(&info).unwrap();
        fs::write(info.join("readme.txt"), b"1").unwrap();
        fs::write(info.join("real.mp4"), vec![0u8; 500]).unwrap();

        let hit = locate_item_file(tmp.join("images").to_str().unwrap(), "XYZ").unwrap();
        assert!(hit.to_string_lossy().ends_with("real.mp4"));
        let _ = fs::remove_dir_all(&tmp);
    }

    /// 旧布局兜底：images/{id}.{ext} 直存
    #[test]
    fn locate_falls_back_to_flat_layout() {
        let tmp = std::env::temp_dir().join(format!("momo_locate_flat_{}", std::process::id()));
        let images = tmp.join("images");
        fs::create_dir_all(&images).unwrap();
        fs::write(images.join("FLAT9.png"), b"png").unwrap();

        let hit = locate_item_file(images.to_str().unwrap(), "FLAT9").unwrap();
        assert!(hit.to_string_lossy().ends_with("FLAT9.png"));
        let _ = fs::remove_dir_all(&tmp);
    }

    /// 非法 id 直接拒绝（路径安全）
    #[test]
    fn locate_rejects_bad_ids() {
        let tmp = std::env::temp_dir().join(format!("momo_locate_bad_{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        assert!(locate_item_file(tmp.to_str().unwrap(), "../evil").is_err());
        assert!(locate_item_file(tmp.to_str().unwrap(), "").is_err());
        let _ = fs::remove_dir_all(&tmp);
    }
}
