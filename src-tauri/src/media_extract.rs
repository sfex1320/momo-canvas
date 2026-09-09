//! 媒体提取服务（导演台 3.0 · 方案 §9.2）
//!
//! 22 帧微视频参考闭环的 Rust/FFmpeg 部分：
//!  - `extract_micro_reference`：从上一段采用 Take 的稳定结尾提取连续 22 帧微视频（含音轨）
//!  - `extract_bridge_frame`：稳定尾帧（结尾前 0.25s，避开编码结束黑帧）
//!  - `extract_thumbnail`：缩略图 / 代理图（时间点可选）
//!  - `trim_media`：入出点裁剪（动作参考片段）
//! 浏览器预览模式没有这些命令，前端在 videoEdit.ts 里有只读降级路径。
//!
//! 输出全部先写临时文件再原子改名，失败不覆盖已有素材；ffmpeg 复用 media_probe 的定位逻辑。

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::media_probe::{media_locate, media_probe};

/// 原子落位：临时文件 → 目标（rename 失败退化 copy；已有文件先备份再替换）
fn place_atomic(tmp: &Path, out: &Path) -> Result<(), String> {
    if !tmp.is_file() {
        return Err("提取结果为空（源文件可能损坏或时长不足）".into());
    }
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("输出目录创建失败：{}", e))?;
    }
    if out.exists() {
        let bak = out.with_extension("bak");
        fs::rename(out, &bak).map_err(|e| format!("旧文件备份失败：{}", e))?;
        if fs::rename(tmp, out).is_err() {
            let _ = fs::rename(&bak, out); // 回滚
            fs::copy(tmp, out).map_err(|e| format!("结果写入失败：{}", e))?;
        }
    } else if fs::rename(tmp, out).is_err() {
        fs::copy(tmp, out).map_err(|e| format!("结果写入失败：{}", e))?;
    }
    Ok(())
}

fn run_ffmpeg(ffmpeg: &str, args: &[&str]) -> Result<(), String> {
    let out = Command::new(ffmpeg)
        .args(["-hide_banner", "-nostdin"])
        .args(args)
        .output()
        .map_err(|e| format!("ffmpeg 启动失败：{}", e))?;
    if !out.status.success() {
        let tail = String::from_utf8_lossy(&out.stderr);
        let hint = tail.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
        return Err(format!("ffmpeg 提取失败：{}", hint));
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicroRefResult {
    pub out_path: String,
    /// 提取区间（秒，源时间轴）
    pub start_sec: f64,
    pub end_sec: f64,
    pub fps: f64,
    pub frames: u32,
}

/// 提取末尾 N 帧（默认 22）微视频参考：H3 R2V 的连续性微参考，保留音轨。
/// 帧数会被源时长钳制（源太短就取全部），返回真实区间供胶囊记录与预览定位。
#[tauri::command]
pub fn extract_micro_reference(
    src: String,
    out_path: String,
    frames: Option<u32>,
    ffmpeg_path: Option<String>,
) -> Result<MicroRefResult, String> {
    let frames = frames.unwrap_or(22).clamp(1, 120);
    let out = PathBuf::from(&out_path);
    if !out.is_absolute() {
        return Err("输出路径必须是绝对路径".into());
    }
    let probe = media_probe(src.clone(), ffmpeg_path.clone())?;
    let dur = probe.duration_sec.ok_or("源视频没有可读的时长（可能已损坏）")?;
    let fps = probe.fps.unwrap_or(25.0).max(1.0);
    // 源不足 N 帧时取全部（至少 3 帧），区间结束避开最后 0.04s 的编码尾巴
    let end = (dur - 0.04).max(0.1);
    let span = (frames as f64 / fps).min(end);
    let start = (end - span).max(0.0);
    let real_frames = ((end - start) * fps).round().max(1.0) as u32;

    let loc = media_locate(ffmpeg_path)?;
    let ffmpeg = loc.ffmpeg.ok_or("本机没有找到 ffmpeg——安装后在设置里指定路径，或在浏览器预览模式下使用降级提取")?;
    let tmp = out.with_extension("microref.tmp.mp4");
    // -ss 放 -i 前（关键帧定位后精修，快且稳）；视频重编码保证任意源可切，音轨有则保留
    let ss = format!("{:.3}", start);
    let to = format!("{:.3}", end);
    run_ffmpeg(
        &ffmpeg,
        &[
            "-ss", &ss, "-to", &to, "-i", &src,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest",
            "-y", &tmp.to_string_lossy(),
        ],
    )?;
    place_atomic(&tmp, &out)?;
    Ok(MicroRefResult {
        out_path: out.to_string_lossy().into_owned(),
        start_sec: start,
        end_sec: end,
        fps,
        frames: real_frames,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameResult {
    pub out_path: String,
    /// 实际抽帧时间点（秒）
    pub at_sec: f64,
}

/// 稳定桥接帧：优先结尾前 0.25s（真最后一帧常是黑帧/半帧）；源太短取首帧。
#[tauri::command]
pub fn extract_bridge_frame(
    src: String,
    out_path: String,
    ffmpeg_path: Option<String>,
) -> Result<FrameResult, String> {
    let out = PathBuf::from(&out_path);
    if !out.is_absolute() {
        return Err("输出路径必须是绝对路径".into());
    }
    let probe = media_probe(src.clone(), ffmpeg_path.clone())?;
    let dur = probe.duration_sec.unwrap_or(0.0);
    let at = if dur > 0.35 { dur - 0.25 } else { 0.0 };
    let loc = media_locate(ffmpeg_path)?;
    let ffmpeg = loc.ffmpeg.ok_or("本机没有找到 ffmpeg——安装后在设置里指定路径，或使用浏览器预览降级路径")?;
    let tmp = out.with_extension("frame.tmp.jpg");
    let ss = format!("{:.3}", at);
    run_ffmpeg(
        &ffmpeg,
        &["-ss", &ss, "-i", &src, "-frames:v", "1", "-q:v", "2", "-y", &tmp.to_string_lossy()],
    )?;
    place_atomic(&tmp, &out)?;
    Ok(FrameResult { out_path: out.to_string_lossy().into_owned(), at_sec: at })
}

/// 缩略图 / 代理图：at_sec 缺省取 1s（视频封面惯例），宽度等比缩放。
#[tauri::command]
pub fn extract_thumbnail(
    src: String,
    out_path: String,
    at_sec: Option<f64>,
    width: Option<u32>,
    ffmpeg_path: Option<String>,
) -> Result<FrameResult, String> {
    let out = PathBuf::from(&out_path);
    if !out.is_absolute() {
        return Err("输出路径必须是绝对路径".into());
    }
    let probe = media_probe(src.clone(), ffmpeg_path.clone())?;
    let dur = probe.duration_sec.unwrap_or(0.0);
    let at = at_sec.unwrap_or_else(|| dur.min(1.0).max(0.0));
    let loc = media_locate(ffmpeg_path)?;
    let ffmpeg = loc.ffmpeg.ok_or("本机没有找到 ffmpeg——安装后在设置里指定路径")?;
    let tmp = out.with_extension("thumb.tmp.jpg");
    let ss = format!("{:.3}", at);
    let scale = width
        .filter(|w| *w >= 32)
        .map(|w| format!("scale={}:-2", w))
        .unwrap_or_default();
    let mut args: Vec<String> = vec![
        "-ss".into(), ss, "-i".into(), src, "-frames:v".into(), "1".into(), "-q:v".into(), "3".into(),
    ];
    if !scale.is_empty() {
        args.push("-vf".into());
        args.push(scale);
    }
    args.push("-y".into());
    args.push(tmp.to_string_lossy().into_owned());
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_ffmpeg(&ffmpeg, &arg_refs)?;
    place_atomic(&tmp, &out)?;
    Ok(FrameResult { out_path: out.to_string_lossy().into_owned(), at_sec: at })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimResult {
    pub out_path: String,
    pub start_sec: f64,
    pub end_sec: f64,
}

/// 入出点裁剪（动作参考 / 铃声音段等）：重编码保证任意源可切，音轨保留。
#[tauri::command]
pub fn trim_media(
    src: String,
    out_path: String,
    start_sec: f64,
    end_sec: f64,
    ffmpeg_path: Option<String>,
) -> Result<TrimResult, String> {
    let out = PathBuf::from(&out_path);
    if !out.is_absolute() {
        return Err("输出路径必须是绝对路径".into());
    }
    if end_sec - start_sec < 0.05 {
        return Err("裁剪区间太短（至少 0.05 秒）".into());
    }
    let loc = media_locate(ffmpeg_path)?;
    let ffmpeg = loc.ffmpeg.ok_or("本机没有找到 ffmpeg——安装后在设置里指定路径")?;
    let tmp = out.with_extension("trim.tmp.mp4");
    let ss = format!("{:.3}", start_sec.max(0.0));
    let to = format!("{:.3}", end_sec);
    run_ffmpeg(
        &ffmpeg,
        &[
            "-ss", &ss, "-to", &to, "-i", &src,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest",
            "-y", &tmp.to_string_lossy(),
        ],
    )?;
    place_atomic(&tmp, &out)?;
    Ok(TrimResult { out_path: out.to_string_lossy().into_owned(), start_sec: start_sec.max(0.0), end_sec })
}
