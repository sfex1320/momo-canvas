//! 媒体探测（导演台 2.0 · 方案 §12.1 / §15.4）
//!
//! ffprobe 外部进程封装：输入探测时长/分辨率/帧率/音轨/损坏状态。
//! ffmpeg/ffprobe 不随应用打包（§24：FFmpeg 体积与授权由用户侧解决）——
//! 定位顺序：用户配置路径 > PATH > 常见安装位置。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

/// ffprobe -print_format json 的部分解析结构（只取我们关心的字段）
#[derive(Debug, Deserialize)]
struct FfprobeOut {
    #[serde(default)]
    streams: Vec<FfStream>,
    #[serde(default)]
    format: Option<FfFormat>,
}

#[derive(Debug, Deserialize)]
struct FfStream {
    #[serde(default, rename = "codec_type")]
    codec_type: Option<String>,
    #[serde(default)]
    width: Option<u32>,
    #[serde(default)]
    height: Option<u32>,
    #[serde(default, rename = "avg_frame_rate")]
    avg_frame_rate: Option<String>,
    #[serde(default, rename = "codec_name")]
    codec_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FfFormat {
    #[serde(default)]
    duration: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub duration_sec: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub has_audio: Option<bool>,
    pub corrupt: Option<bool>,
}

/// 解析 "30000/1001" 形式的帧率分数
fn parse_ratio(s: &str) -> Option<f64> {
    let mut it = s.splitn(2, '/');
    let a: f64 = it.next()?.trim().parse().ok()?;
    let b = it.next().map(|x| x.trim().parse::<f64>().ok()).unwrap_or(Some(1.0))?;
    if b == 0.0 {
        return None;
    }
    Some(a / b)
}

/// 定位 ffmpeg / ffprobe：custom 显式路径优先，其次 PATH（where），最后常见安装位置。
/// 返回 (ffmpeg, ffprobe)——ffprobe 默认与 ffmpeg 同目录。
#[tauri::command]
pub fn media_locate(custom: Option<String>) -> Result<MediaLocateResult, String> {
    let found = |exe: &str, custom: &Option<String>| -> Option<String> {
        if let Some(p) = custom {
            let pb = PathBuf::from(&p);
            if pb.is_file() {
                return Some(pb.to_string_lossy().into_owned());
            }
        }
        // PATH
        if let Ok(out) = Command::new("cmd").args(["/C", &format!("where {}", exe)]).output() {
            if out.status.success() {
                let txt = String::from_utf8_lossy(&out.stdout);
                if let Some(line) = txt.lines().next() {
                    let t = line.trim();
                    if !t.is_empty() && PathBuf::from(t).is_file() {
                        return Some(t.to_string());
                    }
                }
            }
        }
        // 常见位置（Windows 常见安装路径 + 本应用同目录）
        let cands = [
            format!("C:\\ffmpeg\\bin\\{}.exe", exe),
            format!("C:\\Program Files\\ffmpeg\\bin\\{}.exe", exe),
            format!("C:\\Program Files (x86)\\ffmpeg\\bin\\{}.exe", exe),
            format!("{}\\{}.exe", std::env::current_dir().unwrap_or_default().display(), exe),
        ];
        cands.iter().find(|c| PathBuf::from(c).is_file()).cloned()
    };
    let ffmpeg = found("ffmpeg", &custom);
    // ffprobe 与 ffmpeg 同目录
    let ffprobe = match &ffmpeg {
        Some(p) => {
            let sibling = PathBuf::from(p).with_file_name("ffprobe.exe");
            if sibling.is_file() {
                Some(sibling.to_string_lossy().into_owned())
            } else {
                found("ffprobe", &None)
            }
        }
        None => found("ffprobe", &None),
    };
    Ok(MediaLocateResult { ffmpeg, ffprobe })
}

#[derive(Debug, Serialize)]
pub struct MediaLocateResult {
    pub ffmpeg: Option<String>,
    pub ffprobe: Option<String>,
}

/// 探测单个媒体文件（ffprobe JSON 解析；ffprobe 缺失时返回缺省而非报错，浏览器层有降级）
#[tauri::command]
pub fn media_probe(input: String, ffprobe_path: Option<String>) -> Result<ProbeResult, String> {
    let loc = media_locate(ffprobe_path)?;
    let exe = loc.ffprobe.ok_or_else(|| {
        "本机没有找到 ffprobe（媒体探测需要）——安装 ffmpeg 后重试，或在设置里指定路径".to_string()
    })?;
    let out = Command::new(&exe)
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(&input)
        .output()
        .map_err(|e| format!("ffprobe 启动失败：{}", e))?;
    if !out.status.success() {
        // 文件不存在 / 损坏容器
        return Ok(ProbeResult {
            duration_sec: None,
            width: None,
            height: None,
            fps: None,
            has_audio: None,
            corrupt: Some(true),
        });
    }
    let parsed: FfprobeOut = serde_json::from_slice(&out.stdout).map_err(|e| format!("ffprobe 输出解析失败：{}", e))?;
    let video = parsed.streams.iter().find(|s| s.codec_type.as_deref() == Some("video"));
    let audio = parsed
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("audio") && s.codec_name.as_deref() != Some("unknown"));
    let duration = parsed
        .format
        .as_ref()
        .and_then(|f| f.duration.as_ref())
        .and_then(|d| d.parse::<f64>().ok());
    Ok(ProbeResult {
        duration_sec: duration,
        width: video.and_then(|v| v.width),
        height: video.and_then(|v| v.height),
        fps: video.and_then(|v| v.avg_frame_rate.as_deref()).and_then(parse_ratio),
        has_audio: Some(audio.is_some()),
        corrupt: Some(false),
    })
}
