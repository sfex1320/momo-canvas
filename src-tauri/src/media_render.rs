//! 正式后期渲染引擎（导演台 2.0 · 方案 §12）
//!
//! 受控 ffmpeg 管线（外部 ffmpeg，不随应用打包）：
//!  ① 每个视频片段：入出点裁切 + 画幅适配（contain/cover/blur）+ 原声音量/淡化 + 统一编码 → seg_N.mp4
//!  ② 标题卡/黑场/图片卡：lavfi color / drawtext / loop image → title_N.mp4
//!  ③ concat demuxer 拼接（所有片段已统一编码参数）
//!  ④ 音频轨：adelay 定位 + volume + afade → amix（normalize=0）+ alimiter 峰值保护（§12.3）
//!  ⑤ 字幕烧录（subtitles filter，SRT 先落临时文件）
//!  ⑥ 输出 H.264 MP4；全程在临时目录工作，成功后原子落位（失败不覆盖旧成片，§20.4）
//!
//! 命令要求（§20.4）：显式绝对路径、支持取消（media_render_cancel 杀子进程）、
//! 进度经 Channel 事件回前端、输出先写临时文件、失败保留可读中文错误。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;

use crate::media_probe::media_locate;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPlanR {
    pub clips: Vec<ClipR>,
    #[serde(default)]
    pub audio: Vec<AudioR>,
    #[serde(default)]
    pub titles: Vec<TitleR>,
    pub srt: Option<String>,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    #[serde(default = "default_fit")]
    pub fit: String,
}

fn default_fit() -> String {
    "contain".to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipR {
    pub path: String,
    #[serde(default)]
    pub in_sec: Option<f64>,
    #[serde(default)]
    pub out_sec: Option<f64>,
    #[serde(default)]
    pub dur_sec: Option<f64>,
    #[serde(default)]
    pub fade_in: Option<f64>,
    #[serde(default)]
    pub fade_out: Option<f64>,
    #[serde(default = "d1")]
    pub volume: f64,
    #[serde(default)]
    pub muted: bool,
    /* —— 基础变换（导演台 3.0 方案 §6.7：镜像/旋转真实进入预演与 MP4）—— */
    #[serde(default)]
    pub flip_h: bool,
    #[serde(default)]
    pub flip_v: bool,
    /// 顺时针旋转角度：0 / 90 / 180 / 270（90/270 会交换宽高，画幅适配后再旋转）
    #[serde(default)]
    pub rotate: u16,
    /* —— 3.4：与下一段的转场（fade=切点对称淡化，真实进入成片）—— */
    #[serde(default)]
    pub transition: Option<String>,
    #[serde(default)]
    pub transition_dur: Option<f64>,
}

/// 变换滤镜段：hflip/vflip/transpose（90=顺时针，270=逆时针两次）
fn transform_chain(c: &ClipR) -> String {
    let mut s = String::new();
    if c.flip_h {
        s.push_str(",hflip");
    }
    if c.flip_v {
        s.push_str(",vflip");
    }
    match c.rotate {
        90 => s.push_str(",transpose=1"),
        180 => s.push_str(",transpose=1,transpose=1"),
        270 => s.push_str(",transpose=2"),
        _ => {}
    }
    s
}

fn d1() -> f64 {
    1.0
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioR {
    pub path: String,
    #[serde(default)]
    pub at_sec: f64,
    #[serde(default = "d1")]
    pub volume: f64,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub fade_in: Option<f64>,
    #[serde(default)]
    pub fade_out: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleR {
    pub at_sec: f64,
    pub dur_sec: f64,
    pub kind: String,
    pub text: Option<String>,
    pub image_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderEvent {
    pub msg: String,
    pub pct: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderResult {
    pub out_path: String,
    pub duration_sec: f64,
}

/* ---------------- 任务注册与取消 ---------------- */

/// 运行中的渲染任务：取消标记 + 已启动的 ffmpeg 子进程 pid（取消时杀进程树）
fn running_map() -> &'static Mutex<HashMap<String, (Arc<AtomicBool>, Arc<Mutex<Vec<u32>>>)>> {
    static MAP: std::sync::OnceLock<Mutex<HashMap<String, (Arc<AtomicBool>, Arc<Mutex<Vec<u32>>>)>>> =
        std::sync::OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub fn media_render_cancel(task_id: String) -> Result<bool, String> {
    let map = running_map().lock().unwrap();
    if let Some((flag, pids)) = map.get(&task_id) {
        flag.store(true, Ordering::SeqCst);
        if let Ok(pids) = pids.lock() {
            for pid in pids.iter() {
                // Windows：杀进程树（ffmpeg 可能还有子进程）
                let _ = Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn();
            }
        }
        return Ok(true);
    }
    Ok(false)
}

/* ---------------- 渲染上下文 ---------------- */

struct Ctx {
    ffmpeg: String,
    cancelled: Arc<AtomicBool>,
    pids: Arc<Mutex<Vec<u32>>>,
}

impl Ctx {
    fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err("已取消渲染（未覆盖任何已有成片）".into());
        }
        Ok(())
    }

    /// 跑一个 ffmpeg 子进程，-progress pipe:1 解析进度；结束后从注册表摘除 pid
    fn run(&self, args: &[String], total_est: f64, ev: &Channel<RenderEvent>, label: &str) -> Result<(), String> {
        if self.cancelled.load(Ordering::SeqCst) {
            return Err("已取消渲染".into());
        }
        let mut cmd = Command::new(&self.ffmpeg);
        cmd.args(args)
            .args(["-progress", "pipe:1", "-nostats", "-y"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().map_err(|e| format!("ffmpeg 启动失败（{}）：{}", label, e))?;
        let pid = child.id();
        {
            self.pids.lock().unwrap().push(pid);
        }
        let mut progress_lines = 0usize;
        if let Some(stdout) = child.stdout.take() {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        progress_lines += 1;
                        if let Some(us) = line.trim().strip_prefix("out_time_us=") {
                            if let Ok(v) = us.parse::<f64>() {
                                if total_est > 0.0 && progress_lines % 8 == 0 {
                                    let _ = ev.send(RenderEvent {
                                        msg: format!("{}…", label),
                                        pct: Some(((v / 1_000_000.0) / total_est * 100.0).clamp(0.0, 99.9)),
                                    });
                                }
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        }
        let status = child.wait().map_err(|e| format!("等待 ffmpeg 失败：{}", e))?;
        {
            let mut pids = self.pids.lock().unwrap();
            pids.retain(|p| *p != pid);
        }
        if self.cancelled.load(Ordering::SeqCst) {
            return Err("已取消渲染".into());
        }
        if !status.success() {
            return Err(format!(
                "ffmpeg 步骤失败（{}）——请检查源文件是否可读、磁盘空间是否充足。可在设置 → 媒体工具里指定 ffmpeg 路径",
                label
            ));
        }
        Ok(())
    }
}

/// Windows 路径在 filter 参数里的转义（冒号需要转义）
fn esc(p: &str) -> String {
    p.replace('\\', "/").replace(':', "\\:")
}

/// 画幅适配滤镜链（单输入单输出；blur 用 split 分叉再合成）
fn fit_chain(fit: &str, w: u32, h: u32) -> String {
    match fit {
        "cover" => format!(
            "scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}",
            w = w,
            h = h
        ),
        "blur" => format!(
            "split=2[bgS][fgS];[bgS]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},gblur=sigma=20[bgB];[fgS]scale={w}:{h}:force_original_aspect_ratio=decrease[fgF];[bgB][fgF]overlay=(W-w)/2:(H-h)/2",
            w = w,
            h = h
        ),
        _ => format!(
            "scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black",
            w = w,
            h = h
        ),
    }
}

#[tauri::command]
pub async fn media_render(
    task_id: String,
    plan: RenderPlanR,
    out_path: String,
    ffmpeg_path: Option<String>,
    on_event: Channel<RenderEvent>,
) -> Result<RenderResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_render(&task_id, plan, &out_path, ffmpeg_path, &on_event))
        .await
        .map_err(|e| format!("渲染任务异常：{}", e))?
}

fn run_render(
    task_id: &str,
    plan: RenderPlanR,
    out_path: &str,
    ffmpeg_path: Option<String>,
    ev: &Channel<RenderEvent>,
) -> Result<RenderResult, String> {
    let out = PathBuf::from(out_path);
    if !out.is_absolute() {
        return Err("输出路径必须是绝对路径".into());
    }
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("输出目录创建失败：{}", e))?;
    }
    let loc = media_locate(ffmpeg_path)?;
    let ffmpeg = loc.ffmpeg.ok_or_else(|| {
        "本机没有找到 ffmpeg——请安装（winget install ffmpeg，或到 ffmpeg.org 下载），或在导演台 → 成片 → 媒体工具里指定 ffmpeg.exe 路径".to_string()
    })?;

    // 临时目录放输出同目录（保证同盘 rename 原子性）
    let tmp_dir = out
        .parent()
        .unwrap_or(Path::new("."))
        .join(format!(".momo_render_{}", ts()));
    fs::create_dir_all(&tmp_dir).map_err(|e| format!("临时目录创建失败：{}", e))?;

    let flag = Arc::new(AtomicBool::new(false));
    let pids: Arc<Mutex<Vec<u32>>> = Arc::new(Mutex::new(Vec::new()));
    running_map()
        .lock()
        .unwrap()
        .insert(task_id.to_string(), (flag.clone(), pids.clone()));
    let ctx = Ctx {
        ffmpeg,
        cancelled: flag,
        pids,
    };
    let result = do_render(&ctx, &plan, &tmp_dir, &out, ev);
    let _ = fs::remove_dir_all(&tmp_dir);
    running_map().lock().unwrap().remove(task_id);
    result.map(|dur| RenderResult {
        out_path: out.to_string_lossy().into_owned(),
        duration_sec: dur,
    })
}

fn ts() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 用 ffmpeg -i 的 stderr 抓媒体时长（秒）；解析失败返回 None（调用方回退，不阻断渲染）
fn media_duration(ffmpeg: &str, path: &str) -> Option<f64> {
    let out = Command::new(ffmpeg)
        .args(["-hide_banner", "-i", path])
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .output()
        .ok()?;
    // ffmpeg -i 不带输出参数时通常以 1 退出，Duration 信息在 stderr
    let text = String::from_utf8_lossy(&out.stderr);
    let seg = text.split("Duration:").nth(1)?.split(',').next()?.trim().to_string();
    let parts: Vec<f64> = seg.split(':').filter_map(|x| x.trim().parse::<f64>().ok()).collect();
    if parts.len() == 3 {
        Some(parts[0] * 3600.0 + parts[1] * 60.0 + parts[2])
    } else {
        None
    }
}

fn do_render(ctx: &Ctx, plan: &RenderPlanR, tmp: &Path, out: &Path, ev: &Channel<RenderEvent>) -> Result<f64, String> {
    let w = plan.width;
    let h = plan.height;
    let fps = plan.fps.max(1.0);
    let fit = fit_chain(&plan.fit, w, h);
    let total: f64 = plan.clips.iter().filter_map(|c| c.dur_sec).sum::<f64>()
        + plan.titles.iter().map(|t| t.dur_sec).sum::<f64>();
    let total = if total > 0.1 { total } else { 1.0 };
    let mut seg_files: Vec<(f64, u8, String)> = Vec::new(); // (时间线位置, 类别: 0=标题 1=片段, 文件)

    // ① 片段裁切与规范化——按落在片段区间内的标题 atSec 切分子段，标题能真实插入视频中间（3.4）
    struct Piece {
        clip: usize,
        in_off: f64,
        out_off: f64,
        pos: f64,
        first: bool,
        last: bool,
        piece: usize,
        pieces: usize,
    }
    let mut piece_list: Vec<Piece> = Vec::new();
    let mut clip_start = 0.0f64;
    for (i, c) in plan.clips.iter().enumerate() {
        let d = c
            .dur_sec
            .unwrap_or((c.out_sec.unwrap_or(0.0) - c.in_sec.unwrap_or(0.0)).max(0.1));
        // 落在本片段区间内部的标题插入点（相对片段起点，去重排序；贴近两端的点不切）
        let mut cuts: Vec<f64> = plan
            .titles
            .iter()
            .map(|t| t.at_sec - clip_start)
            .filter(|off| *off > 0.05 && *off < d - 0.05)
            .collect();
        cuts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        cuts.dedup_by(|a, b| (*a - *b).abs() < 0.05);
        let mut bounds: Vec<f64> = Vec::with_capacity(cuts.len() + 2);
        bounds.push(0.0);
        bounds.extend(&cuts);
        bounds.push(d);
        let n = bounds.len() - 1;
        for k in 0..n {
            piece_list.push(Piece {
                clip: i,
                in_off: bounds[k],
                out_off: bounds[k + 1],
                pos: clip_start + bounds[k],
                first: k == 0,
                last: k == n - 1,
                piece: k,
                pieces: n,
            });
        }
        clip_start += d;
    }

    for (idx, p) in piece_list.iter().enumerate() {
        let c = &plan.clips[p.clip];
        ctx.check()?;
        let seg_path = tmp.join(format!("seg_{:04}_{:02}.mp4", p.clip, p.piece));
        let dur = (p.out_off - p.in_off).max(0.1);
        let mut vf = fit.clone();
        vf.push_str(&transform_chain(c));
        // 淡入淡出：显式 fade 只作用于片段首/末子段；转场淡化（上段声明 fade → 本段淡入，本段声明 fade 且非末段 → 末段淡出）同理，不叠加
        if p.first {
            if let Some(fi) = c.fade_in.filter(|v| *v > 0.0) {
                vf.push_str(&format!(",fade=t=in:st=0:d={:.3}", fi.min(dur)));
            }
            if p.clip > 0 && plan.clips[p.clip - 1].transition.as_deref() == Some("fade") && c.fade_in.is_none() {
                let td = c.transition_dur.unwrap_or(0.5).clamp(0.1, 2.0).min(dur);
                vf.push_str(&format!(",fade=t=in:st=0:d={:.3}", td));
            }
        }
        if p.last {
            if let Some(fo) = c.fade_out.filter(|v| *v > 0.0) {
                vf.push_str(&format!(",fade=t=out:st={:.3}:d={:.3}", (dur - fo).max(0.0), fo));
            }
            if c.transition.as_deref() == Some("fade") && p.clip + 1 < plan.clips.len() && c.fade_out.is_none() {
                let td = c.transition_dur.unwrap_or(0.5).clamp(0.1, 2.0).min(dur);
                vf.push_str(&format!(",fade=t=out:st={:.3}:d={:.3}", (dur - td).max(0.0), td));
            }
        }
        let mut args: Vec<String> = vec!["-hide_banner".into()];
        // 子段取自源文件的绝对位置：in_sec/out_sec + 子段偏移
        let src_in = c.in_sec.unwrap_or(0.0) + p.in_off;
        let src_out = c.in_sec.unwrap_or(0.0) + p.out_off;
        if src_in > 0.001 {
            args.extend(["-ss".into(), format!("{:.3}", src_in)]);
        }
        if src_out > 0.001 {
            args.extend(["-to".into(), format!("{:.3}", src_out)]);
        }
        args.push("-i".into());
        args.push(c.path.clone());
        args.extend(["-vf".into(), vf]);
        if c.muted || c.volume <= 0.001 {
            args.push("-an".into());
        } else if (c.volume - 1.0).abs() > 0.01 {
            args.extend(["-af".into(), format!("volume={:.3}", c.volume)]);
        }
        args.extend([
            "-c:v".into(), "libx264".into(),
            "-preset".into(), "veryfast".into(),
            "-crf".into(), "20".into(),
            "-pix_fmt".into(), "yuv420p".into(),
            "-r".into(), format!("{:.3}", fps),
            "-c:a".into(), "aac".into(),
            "-ar".into(), "48000".into(),
            "-ac".into(), "2".into(),
        ]);
        let label = if p.pieces > 1 {
            format!("裁切片段 {}/{}（子段 {}/{}）", p.clip + 1, plan.clips.len(), p.piece + 1, p.pieces)
        } else {
            format!("裁切片段 {}/{}", p.clip + 1, plan.clips.len())
        };
        let _ = ev.send(RenderEvent { msg: label.clone(), pct: Some(((total - dur) / total * 100.0).clamp(0.0, 99.0)) });
        ctx.run(&args, dur, ev, &label)?;
        seg_files.push((p.pos, 1u8, seg_path.to_string_lossy().into_owned()));
    }

    // ② 标题卡（黑场 / 标题文字 / 图片卡）
    for (i, t) in plan.titles.iter().enumerate() {
        ctx.check()?;
        let seg_path = tmp.join(format!("title_{:04}.mp4", i));
        let args: Vec<String> = match t.kind.as_str() {
            "black" => vec![
                "-f".into(), "lavfi".into(),
                "-i".into(), format!("color=c=black:s={w}x{h}:d={:.3}:r={:.3}", t.dur_sec.max(0.2), fps),
                "-f".into(), "lavfi".into(),
                "-i".into(), "anullsrc=r=48000:cl=stereo".into(),
                "-shortest".into(),
                "-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(),
                "-pix_fmt".into(), "yuv420p".into(),
                "-c:a".into(), "aac".into(),
            ],
            "image" if t.image_path.as_deref().map(|p| Path::new(p).is_file()).unwrap_or(false) => vec![
                "-loop".into(), "1".into(),
                "-t".into(), format!("{:.3}", t.dur_sec.max(0.2)),
                "-i".into(), t.image_path.clone().unwrap(),
                "-vf".into(), fit.clone(),
                "-r".into(), format!("{:.3}", fps),
                "-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(),
                "-pix_fmt".into(), "yuv420p".into(),
                "-an".into(),
            ],
            _ => {
                // 标题卡：黑底白字（微软雅黑/黑体，缺字体退化为黑场）
                let font = ["C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf"]
                    .iter()
                    .find(|f| Path::new(f).is_file());
                let mut a: Vec<String> = vec![
                    "-f".into(), "lavfi".into(),
                    "-i".into(), format!("color=c=black:s={w}x{h}:d={:.3}:r={:.3}", t.dur_sec.max(0.5), fps),
                    "-f".into(), "lavfi".into(),
                    "-i".into(), "anullsrc=r=48000:cl=stereo".into(),
                ];
                if let Some(f) = font {
                    let safe = t.text.clone().unwrap_or_default()
                        .replace(['\\', ':', '\'', '%'], "");
                    a.push("-vf".into());
                    a.push(format!(
                        "drawtext=fontfile='{}':text='{}':fontcolor=white:fontsize={}:x=(w-text_w)/2:y=(h-text_h)/2",
                        esc(f), safe, h / 12
                    ));
                } else {
                    let _ = ev.send(RenderEvent { msg: "未找到中文字体，标题卡退化为黑场".into(), pct: None });
                }
                a.extend([
                    "-shortest".into(),
                    "-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(),
                    "-pix_fmt".into(), "yuv420p".into(),
                    "-c:a".into(), "aac".into(),
                ]);
                a
            }
        };
        ctx.run(&args, t.dur_sec, ev, &format!("标题卡 {}/{}", i + 1, plan.titles.len()))?;
        // atSec 参与时间线排序（3.4）：此前标题卡永远排到片尾，at_sec 从未被使用
        seg_files.push((t.at_sec.max(0.0), 0u8, seg_path.to_string_lossy().into_owned()));
    }

    if !seg_files.iter().any(|(_, tag, _)| *tag == 1u8) {
        return Err("没有可渲染的片段（采用版本缺失或资产文件不可读）".into());
    }
    // 时间线语义（3.4）：标题卡按 atSec 与片段按故事顺序统一编排，不再「片段全在前、标题全在后」
    seg_files.sort_by(|a, b| {
        a.0.partial_cmp(&b.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.1.cmp(&b.1))
    });

    // ③ concat 拼接
    ctx.check()?;
    let list_path = tmp.join("concat.txt");
    let list_txt = seg_files
        .iter()
        .map(|(_, _, f)| format!("file '{}'\n", f.replace('\'', "'\\''")))
        .collect::<String>();
    fs::write(&list_path, list_txt).map_err(|e| format!("拼接清单写入失败：{}", e))?;
    let concat_out = tmp.join("concat.mp4");
    let concat_args: Vec<String> = vec![
        "-hide_banner".into(),
        "-f".into(), "concat".into(),
        "-safe".into(), "0".into(),
        "-i".into(), list_path.to_string_lossy().into_owned(),
        "-c".into(), "copy".into(),
        concat_out.to_string_lossy().into_owned(),
    ];
    ctx.run(&concat_args, total, ev, "拼接片段")?;

    // ④ 音频混合（adelay 定位 + 音量/淡化 + amix + 峰值保护）；静音轨直接不进混音
    let active_audio: Vec<&AudioR> = plan.audio.iter().filter(|a| !a.muted).collect();
    let mix_path: Option<PathBuf> = if !active_audio.is_empty() {
        ctx.check()?;
        let mut args: Vec<String> = vec!["-hide_banner".into()];
        let mut chain: Vec<String> = Vec::new();
        for (i, a) in active_audio.iter().enumerate() {
            args.extend(["-i".into(), a.path.clone()]);
            let mut f = String::new();
            if a.at_sec > 0.01 {
                let ms = (a.at_sec * 1000.0).round() as i64;
                f.push_str(&format!("[{i}:a]adelay={ms}|{ms}"));
            } else {
                f.push_str(&format!("[{i}:a]anull"));
            }
            if (a.volume - 1.0).abs() > 0.01 {
                f.push_str(&format!(",volume={:.3}", a.volume));
            }
            if let Some(fi) = a.fade_in.filter(|v| *v > 0.01) {
                // afade 在 adelay 之后：淡入起点必须是延迟后的可听起点（st=atSec），否则在静音段里淡完
                let st = if a.at_sec > 0.01 { a.at_sec } else { 0.0 };
                f.push_str(&format!(",afade=t=in:st={st:.3}:d={fi:.3}"));
            }
            if let Some(fo) = a.fade_out.filter(|v| *v > 0.01) {
                // 淡出时基修正（3.4）：此前用 at_sec - fo，延迟音轨会在出声前就完成淡出。
                // 有效可听终点 = min(素材时长, 总片长 - atSec) + atSec；素材时长探测失败回退为总片长
                let src = media_duration(&ctx.ffmpeg, &a.path).unwrap_or_else(|| (total - a.at_sec.max(0.0)).max(1.0));
                let audible_end = (a.at_sec.max(0.0) + src).min(total.max(a.at_sec.max(0.0) + fo + 0.1));
                let st = (audible_end - fo).max(a.at_sec.max(0.0));
                f.push_str(&format!(",afade=t=out:st={st:.3}:d={fo:.3}"));
            }
            f.push_str(&format!("[a{i}]"));
            chain.push(f);
        }
        chain.push(format!(
            "{}amix=inputs={}:duration=longest:normalize=0,alimiter=limit=0.95[aout]",
            (0..active_audio.len()).map(|i| format!("[a{i}]")).collect::<String>(),
            active_audio.len()
        ));
        let out_mix = tmp.join("mix.wav");
        args.extend([
            "-filter_complex".into(), chain.join(";"),
            "-map".into(), "[aout]".into(),
            "-ar".into(), "48000".into(),
            "-ac".into(), "2".into(),
            out_mix.to_string_lossy().into_owned(),
        ]);
        ctx.run(&args, total, ev, "混合音频轨")?;
        Some(out_mix)
    } else {
        None
    };

    // ⑤ 字幕 SRT 临时文件
    let srt_path: Option<PathBuf> = plan
        .srt
        .as_ref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| {
            let p = tmp.join("subs.srt");
            let _ = fs::write(&p, s);
            p
        });

    // ⑥ 最终合成（混音 + 字幕烧录）
    ctx.check()?;
    let final_tmp = tmp.join("final.mp4");
    let has_sub = srt_path.is_some();
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-i".into(), concat_out.to_string_lossy().into_owned(),
    ];
    if let Some(mp) = &mix_path {
        args.extend(["-i".into(), mp.to_string_lossy().into_owned()]);
    }
    if let Some(sp) = &srt_path {
        args.extend([
            "-vf".into(),
            format!(
                "subtitles='{}':force_style='FontName=Microsoft YaHei,FontSize={}'",
                esc(&sp.to_string_lossy()),
                h / 24
            ),
        ]);
    }
    if mix_path.is_some() {
        args.extend([
            "-filter_complex".into(),
            "[0:a]anull[va];[va][1:a]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[aout]".into(),
            "-map".into(), "0:v".into(),
            "-map".into(), "[aout]".into(),
        ]);
    }
    args.push("-c:v".into());
    if has_sub {
        args.extend([
            "libx264".into(), "-preset".into(), "veryfast".into(),
            "-crf".into(), "20".into(), "-pix_fmt".into(), "yuv420p".into(),
        ]);
    } else {
        args.push("copy".into());
    }
    args.extend([
        "-c:a".into(), "aac".into(),
        "-movflags".into(), "+faststart".into(),
        final_tmp.to_string_lossy().into_owned(),
    ]);
    ctx.run(&args, total, ev, "最终合成（混音/字幕/编码）")?;

    // 原子落位：全部成功才动目标位置；旧成片先挪进临时目录（失败可回滚），rename 失败退化 copy
    let mut backup: Option<PathBuf> = None;
    if out.exists() {
        let bak = tmp.join("old_output.bak");
        fs::rename(out, &bak).map_err(|e| format!("旧成片备份失败：{}", e))?;
        backup = Some(bak);
    }
    let place = |src: &Path| -> Result<(), String> {
        if fs::rename(src, out).is_ok() {
            return Ok(());
        }
        fs::copy(src, out).map(|_| ()).map_err(|e| format!("成片写入失败：{}", e))
    };
    if let Err(e) = place(&final_tmp) {
        if let Some(bak) = backup.filter(|b| b.exists()) {
            let _ = fs::rename(bak, out); // 回滚旧成片
        }
        return Err(e);
    }
    let _ = ev.send(RenderEvent { msg: "渲染完成".into(), pct: Some(100.0) });
    Ok(total)
}
