//! 图像转矢量（批次5 多候选 + 质量档）：VTracer（纯 Rust，CPU）位图 → SVG + 防御性清洗 + 落盘
//!
//! - 走文件接口 convert_image_to_svg（VTracer 内部用 image 0.23，本项目用 0.25；文件解耦避免版本冲突）。
//! - 质量档（文档 §9）：fast=单候选直出不评分；balanced=3 候选；high-fidelity=5 候选；few-nodes=3 个偏简化候选。
//!   彩色内容变体围绕 color_precision/filter_speckle/path_precision/mode；黑白线稿变体走 Otsu/固定阈值二值预处理。
//! - 候选评分在 vec_score.rs（resvg 渲染比对 + 锚点预算）；锚点预算按质量档（标准 25000 / 高保真 100000 / 少节点 8000）。
//! - 消费上游 analysisMap：flatRatio 高 → 降色准；edgeDensity 高 → 升坐标精度；jpegScore 高 → 报告提示先去压缩。
//! - VTracer 输出受控（仅 svg/g/path），sanitize 再剥一层 script/javascript 作防御 + 供未来导入外部 SVG 复用。
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use visioncortex::PathSimplifyMode; // vtracer 未 re-export（少节点档的多边形模式用）
use vtracer::{ColorMode, Config, Hierarchical, Preset};

type SResult<T> = Result<T, String>;

type CancelMap = Mutex<HashMap<String, Arc<AtomicBool>>>;
static CANCELS: OnceLock<CancelMap> = OnceLock::new();
fn cancels() -> &'static CancelMap {
    CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn register_task(id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    cancels()
        .lock()
        .unwrap()
        .insert(id.to_string(), flag.clone());
    flag
}
fn unregister_task(id: &str) {
    cancels().lock().unwrap().remove(id);
}
pub fn request_cancel(task_id: &str) {
    if let Some(flag) = cancels().lock().unwrap().get(task_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorizeConfig {
    /// 平面拆件限定色盘（2–64），旧节点缺省 12；仅 flat 预设消费。
    #[serde(default)]
    pub flat_colors: Option<usize>,
    /// "bw" | "poster" | "photo" | "line-art" | "comic"
    pub preset: String,
    /// "auto" | "color" | "binary"
    pub color_mode: String,
    /// "stacked" | "cutout"
    pub hierarchical: String,
    /// 0 = 用 preset 默认；否则 1..10
    pub color_precision: i32,
    /// 0 = 用 preset 默认；否则小碎片过滤阈值
    pub filter_speckle: usize,
    /// 路径坐标小数位 0..5
    pub path_precision: u32,
    /// 是否做几何图元识别（圆/矩形/椭圆/圆角矩形→真图元，叠在 VTracer 结果上）
    pub geometry: bool,
    /// 质量档："fast"(1 候选) | "balanced"(3) | "high-fidelity"(5) | "few-nodes"(3 偏简化)
    #[serde(default = "default_quality")]
    pub quality: String,
    /// 上游 analysisMap 比率（可选，缺省不调整）：色块占比 / 边缘密度 / JPEG 压缩分
    #[serde(default)]
    pub flat_ratio: Option<f32>,
    #[serde(default)]
    pub edge_density: Option<f32>,
    #[serde(default)]
    pub jpeg_score: Option<f32>,
}

fn default_quality() -> String {
    "balanced".into()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase", tag = "kind", content = "data")]
pub enum VecEvent {
    Stage { stage: String, pct: f32 },
    Progress { pct: f32 },
    Log { msg: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorizeResult {
    pub svg_path: String,
    pub svg: String,
    pub width: u32,
    pub height: u32,
    pub path_count: usize,
    pub shape_count: usize,
    pub elapsed_ms: u64,
    /// 实际跑了几个候选（质量已达标时会早停；fast 固定为 1）
    pub candidates: usize,
    /// 胜出 SVG 锚点数与预算（复杂度契约）
    pub anchors: usize,
    pub anchor_budget: usize,
    /// 胜出候选总分（fast 档不评分为 None）
    pub score: Option<f64>,
    /// 生产质量门禁（fast 不评分为 None）
    pub quality_passed: Option<bool>,
    pub rmse: Option<f64>,
    pub edge_iou: Option<f64>,
    pub alpha_iou: Option<f64>,
    /// 胜出候选参数摘要（报告行展示）
    pub selected: String,
    /// analysisMap 消费提示（如「建议先过超清放大去压缩」）
    pub hint: Option<String>,
}

fn tmp_name(prefix: &str, ext: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("{}_{}.{}", prefix, nanos, ext))
}

/// 质量档 → 锚点预算（文档 §9：标准 25000 / 高保真 100000 / 少节点 8000；fast 给 15000 兜底）
fn anchor_budget(quality: &str) -> usize {
    match quality {
        "high-fidelity" => 100_000,
        "few-nodes" => 8_000,
        "fast" => 15_000,
        _ => 25_000,
    }
}

/// VTracer 的耗时主要取决于实际追踪像素，而不是最终 SVG 的显示尺寸。
/// 超清节点常输出 3840/7680 像素，但这些新增像素是插值/模型重建结果；直接逐像素追踪
/// 会让彩色聚类与多候选耗时呈倍数增长，对最终贝塞尔边缘却几乎没有收益。
fn trace_work_size(w: u32, h: u32, quality: &str, is_binary: bool) -> (u32, u32) {
    let (max_side, max_pixels): (u32, u64) = match (quality, is_binary) {
        ("high-fidelity", true) => (2_560, 4_000_000),
        ("high-fidelity", false) => (2_048, 2_560_000),
        ("balanced", true) => (2_048, 2_560_000),
        ("balanced", false) => (1_792, 1_780_000),
        ("few-nodes", true) => (1_920, 2_000_000),
        ("few-nodes", false) => (1_600, 1_500_000),
        (_, true) => (1_920, 2_000_000),
        (_, false) => (1_536, 1_200_000),
    };
    let side_scale = max_side as f64 / w.max(h).max(1) as f64;
    let pixel_scale = (max_pixels as f64 / (w as u64 * h as u64).max(1) as f64).sqrt();
    let scale = 1.0_f64.min(side_scale).min(pixel_scale);
    (
        ((w as f64 * scale).round() as u32).max(1),
        ((h as f64 * scale).round() as u32).max(1),
    )
}

fn candidate_budget_secs(quality: &str) -> u64 {
    match quality {
        "high-fidelity" => 240,
        "fast" => 75,
        _ => 150,
    }
}

/// color_precision 已到上限时，+1/+2 候选会完全相同。去重可避免同一张图白跑数次。
fn dedupe_candidates(candidates: Vec<Candidate>) -> Vec<Candidate> {
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|c| {
            seen.insert(format!(
                "{:?}|{:?}|{}|{}|{}|{:?}|{}|{}|{}|{}|{:?}|{:?}",
                c.config.color_mode,
                c.config.hierarchical,
                c.config.filter_speckle,
                c.config.color_precision,
                c.config.layer_difference,
                c.config.mode,
                c.config.corner_threshold,
                c.config.length_threshold,
                c.config.max_iterations,
                c.config.splice_threshold,
                c.config.path_precision,
                c.binary_thresh,
            ))
        })
        .collect()
}

/// 工作图降采样后，路径仍使用工作图坐标；用 viewBox 映射回原始画布尺寸，导出的
/// 3840×3840 SVG 仍保持原尺寸，同时不需要把每条路径坐标逐个乘回去。
fn restore_canvas_size(svg: &str, original: (u32, u32), work: (u32, u32)) -> String {
    if original == work {
        return svg.to_string();
    }
    let needle = format!("width=\"{}\" height=\"{}\"", work.0, work.1);
    let replacement = format!(
        "width=\"{}\" height=\"{}\" viewBox=\"0 0 {} {}\"",
        original.0, original.1, work.0, work.1
    );
    svg.replacen(&needle, &replacement, 1)
}

/// 一个候选 = VTracer 配置 + 可选的二值预处理阈值 + 报告用参数摘要
struct Candidate {
    label: String,
    config: Config,
    /// 二值化阈值（仅黑白/线稿）：先预处理成纯黑白 PNG 再喂 VTracer
    binary_thresh: Option<u32>,
}

/// Otsu 阈值（亮度直方图类间方差最大），黑白/线稿内容的自适应二值
fn otsu_threshold(rgba: &image::RgbaImage) -> u32 {
    let mut hist = [0u64; 256];
    let mut total = 0u64;
    for p in rgba.pixels() {
        if p.0[3] < 16 {
            continue;
        }
        let l = ((p.0[0] as u32 * 299 + p.0[1] as u32 * 587 + p.0[2] as u32 * 114) / 1000) as usize;
        hist[l] += 1;
        total += 1;
    }
    if total == 0 {
        return 128;
    }
    let sum_all: u64 = hist.iter().enumerate().map(|(i, &c)| i as u64 * c).sum();
    let (mut wb, mut sum_b, mut best, mut best_t) = (0u64, 0u64, 0f64, 128u32);
    for (t, &c) in hist.iter().enumerate() {
        wb += c;
        sum_b += t as u64 * c;
        let wf = total - wb;
        if wb == 0 || wf == 0 {
            continue;
        }
        let mb = sum_b as f64 / wb as f64;
        let mf = (sum_all - sum_b) as f64 / wf as f64;
        let between = wb as f64 * wf as f64 * (mb - mf) * (mb - mf);
        if between > best {
            best = between;
            best_t = t as u32;
        }
    }
    best_t
}

/// 按固定阈值把图预处理成纯黑白 RGBA（二值候选的输入变体）
fn binarize(rgba: &image::RgbaImage, thresh: u32) -> image::RgbaImage {
    image::RgbaImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let p = rgba.get_pixel(x, y);
        let l = (p.0[0] as u32 * 299 + p.0[1] as u32 * 587 + p.0[2] as u32 * 114) / 1000;
        // 等于 Otsu 阈值的最暗前景必须仍归入黑色；原实现用 >=，当阈值恰好等于
        // 线条灰度时会把整张线稿洗成白图。Alpha 保留，透明背景不能被实心白覆盖。
        let v = if l > thresh { 255u8 } else { 0u8 };
        image::Rgba([v, v, v, p.0[3]])
    })
}

/// 围绕基础配置生成候选矩阵（单测可直击）：数量由质量档决定
fn build_candidates(base: &Config, quality: &str, is_binary: bool, otsu: u32) -> Vec<Candidate> {
    let mk = |label: String, mut c: Config, binary_thresh: Option<u32>| {
        if is_binary {
            c.color_mode = ColorMode::Binary;
        }
        Candidate {
            label,
            config: c,
            binary_thresh,
        }
    };
    if is_binary {
        // 黑白/线稿：变体是二值预处理阈值（文档 §9：Otsu/自适应/固定阈值变体）
        let ths: Vec<u32> = match quality {
            "fast" => vec![otsu],
            "high-fidelity" => vec![otsu, 112, 128, 144, 160],
            "few-nodes" => vec![otsu, 160, 192],
            _ => vec![otsu, 128, 160],
        };
        return ths
            .into_iter()
            .map(|t| {
                let mut c = base.clone();
                if quality == "few-nodes" {
                    c.filter_speckle = c.filter_speckle.saturating_add(4);
                    c.mode = PathSimplifyMode::Polygon; // 多边形模式锚点最少
                }
                mk(format!("阈值 {}", t), c, Some(t))
            })
            .collect();
    }
    let cp = base.color_precision;
    let fs = base.filter_speckle;
    let pp = base.path_precision.unwrap_or(2);
    match quality {
        "fast" => vec![mk("基准".into(), base.clone(), None)],
        "high-fidelity" => {
            let mut out = vec![mk("基准".into(), base.clone(), None)];
            let mut v = base.clone();
            v.color_precision = (cp + 1).min(8);
            out.push(mk("色准+1".into(), v, None));
            let mut v = base.clone();
            v.color_precision = (cp + 2).min(8);
            out.push(mk("色准+2".into(), v, None));
            let mut v = base.clone();
            v.color_precision = (cp + 1).min(8);
            v.filter_speckle = fs.saturating_sub(1).max(1);
            out.push(mk("色准+1·保碎片".into(), v, None));
            let mut v = base.clone();
            v.color_precision = (cp + 1).min(8);
            v.path_precision = Some((pp + 1).min(5));
            out.push(mk("色准+1·高精度".into(), v, None));
            out
        }
        "few-nodes" => {
            let mut out = Vec::new();
            let mut v = base.clone();
            v.color_precision = (cp - 1).max(2);
            v.filter_speckle = fs + 2;
            out.push(mk("色准-1·滤碎片".into(), v, None));
            let mut v = base.clone();
            v.color_precision = (cp - 2).max(2);
            v.filter_speckle = fs + 4;
            out.push(mk("色准-2·强滤".into(), v, None));
            let mut v = base.clone();
            v.color_precision = (cp - 2).max(2);
            v.filter_speckle = fs + 4;
            v.mode = PathSimplifyMode::Polygon;
            v.path_precision = Some(pp.saturating_sub(1));
            out.push(mk("多边形·极简".into(), v, None));
            out
        }
        _ => {
            let mut out = vec![mk("基准".into(), base.clone(), None)];
            let mut v = base.clone();
            v.color_precision = (cp + 1).min(8);
            out.push(mk("色准+1".into(), v, None));
            let mut v = base.clone();
            v.color_precision = (cp - 1).max(2);
            v.filter_speckle = fs + 2;
            out.push(mk("色准-1·滤碎片".into(), v, None));
            out
        }
    }
}

pub fn run(
    task_id: &str,
    input_bytes: &[u8],
    reference_bytes: Option<&[u8]>,
    out_path: &str,
    cfg: &VectorizeConfig,
    on_event: &tauri::ipc::Channel<VecEvent>,
) -> SResult<VectorizeResult> {
    let cancel = register_task(task_id);
    struct Clean(String);
    impl Drop for Clean {
        fn drop(&mut self) {
            unregister_task(&self.0);
        }
    }
    let _clean = Clean(task_id.to_string());
    run_core_cancel(
        input_bytes,
        reference_bytes,
        out_path,
        cfg,
        &|e| {
            let _ = on_event.send(e);
        },
        cancel.as_ref(),
    )
}

pub fn run_core(
    input_bytes: &[u8],
    out_path: &str,
    cfg: &VectorizeConfig,
    progress: &dyn Fn(VecEvent),
) -> SResult<VectorizeResult> {
    let cancel = AtomicBool::new(false);
    run_core_cancel(input_bytes, None, out_path, cfg, progress, &cancel)
}

fn run_core_cancel(
    input_bytes: &[u8],
    reference_bytes: Option<&[u8]>,
    out_path: &str,
    cfg: &VectorizeConfig,
    progress: &dyn Fn(VecEvent),
    cancel: &AtomicBool,
) -> SResult<VectorizeResult> {
    let start = std::time::Instant::now();
    progress(VecEvent::Stage {
        stage: "分析源图".into(),
        pct: 0.05,
    });
    let img = image::load_from_memory(input_bytes).map_err(|e| format!("解码输入失败：{}", e))?;
    let (w, h) = (img.width(), img.height());
    let original_rgba = img.to_rgba8();
    // 上游超清提供 guide 时，guide 负责描边输入，源图负责最终回评；两者分工可避免
    // “对锐化后的自己评分很高、却已经偏离原字体/Logo”的假通过。
    let score_rgba = if let Some(bytes) = reference_bytes {
        image::load_from_memory(bytes)
            .map_err(|e| format!("解码质量参考图失败：{}", e))?
            .to_rgba8()
    } else {
        original_rgba.clone()
    };

    let mut base = match cfg.preset.as_str() {
        "bw" | "line-art" => Config::from_preset(Preset::Bw),
        "photo" => Config::from_preset(Preset::Photo),
        "comic" | "illustration" => {
            // 漫画/插画：保锐利尖角 + 低去碎片，保留尖刺与细线条（爆炸贴/Logo/手绘）
            let mut c = Config::from_preset(Preset::Poster);
            c.corner_threshold = 20; // 角点阈值低 → 锐角不圆化（海报档默认 60 会圆掉尖刺）
            c.filter_speckle = 1; // 不当碎片滤掉尖尖
            c.color_precision = 8;
            c
        }
        _ => Config::from_preset(Preset::Poster),
    };
    if cfg.color_precision > 0 {
        base.color_precision = cfg.color_precision.clamp(1, 8);
    }
    if cfg.filter_speckle > 0 {
        base.filter_speckle = cfg.filter_speckle.clamp(1, 200);
    }
    base.path_precision = Some(cfg.path_precision.clamp(0, 5));
    base.hierarchical = if cfg.hierarchical == "cutout" {
        Hierarchical::Cutout
    } else {
        Hierarchical::Stacked
    };
    if cfg.color_mode == "binary" {
        base.color_mode = ColorMode::Binary;
    } else if cfg.color_mode == "color" {
        base.color_mode = ColorMode::Color;
    }
    if cfg.preset == "line-art" {
        base.color_mode = ColorMode::Binary; // 线稿强制二值
    }
    let is_binary = matches!(base.color_mode, ColorMode::Binary);

    // 追踪使用受控工作分辨率，最终 SVG 用 viewBox 恢复原始画布尺寸。二值线稿给更高
    // 上限以保细线；彩色海报限制像素总量，避免 4K/8K 输入把聚类拖到几十分钟。
    let (work_w, work_h) = trace_work_size(w, h, &cfg.quality, is_binary);
    let mut rgba = if (work_w, work_h) == (w, h) {
        original_rgba.clone()
    } else {
        progress(VecEvent::Log {
            msg: format!(
                "超清输入 {}×{} 已按矢量追踪工作分辨率缩至 {}×{}；SVG 仍按原尺寸导出",
                w, h, work_w, work_h
            ),
        });
        image::imageops::resize(
            &original_rgba,
            work_w,
            work_h,
            image::imageops::FilterType::Triangle,
        )
    };

    if cfg.preset == "flat" {
        progress(VecEvent::Stage{stage:"整理平面色块与透明边界".into(),pct:0.12});
        rgba=crate::flat_art::clean_colors(&rgba,cfg.flat_colors.unwrap_or(12));
        base.color_precision=8;base.filter_speckle=cfg.filter_speckle.clamp(1,200);base.corner_threshold=20;
        // 平面图的直角/直边不能被样条控制点拉成鼓包。折线保持源轮廓，
        // 圆弧按像素轮廓细分；几何识别另走有质量回评的图元拟合。
        base.mode=PathSimplifyMode::Polygon;
    }
    // ---- analysisMap 消费（文档 §5.3 跨节点复用）：自动微调 + 提示 ----
    let mut hint: Option<String> = None;
    if cfg.preset == "photo" {
        hint = Some(
            "照片矢量是多色色阶的轮廓近似，不等同于可编辑的语义照片；精确 Logo/文字请改用对应预设"
                .into(),
        );
    }
    if let Some(js) = cfg.jpeg_score {
        if js > 0.5 {
            let msg = format!(
                "源图压缩痕迹明显（{}%），建议先接「超清放大·去压缩」再矢量化，边缘会更干净",
                (js * 100.0).round() as i32
            );
            progress(VecEvent::Log { msg: msg.clone() });
            hint = Some(match hint {
                Some(old) => format!("{}；{}", old, msg),
                None => msg,
            });
        }
    }
    if cfg.color_precision <= 0 {
        if let Some(fr) = cfg.flat_ratio {
            if fr > 0.6 && !is_binary {
                // 大面积平涂/文化墙最忌把轻微渐变与压缩噪声拆成海量色层；色块越明显，
                // 量化越积极。真正的细边由路径精度与高保真候选负责。
                let drop = if fr > 0.75 { 2 } else { 1 };
                base.color_precision = (base.color_precision - drop).max(2);
                progress(VecEvent::Log {
                    msg: format!(
                        "色块占比 {}% 偏高，自动降一级色准（{}）",
                        (fr * 100.0).round() as i32,
                        base.color_precision
                    ),
                });
            }
        }
    }
    if let Some(ed) = cfg.edge_density {
        if ed > 0.35 {
            base.path_precision = Some((base.path_precision.unwrap_or(2) + 1).min(5));
            progress(VecEvent::Log {
                msg: format!(
                    "边缘密度 {}% 偏高，路径坐标精度 +1",
                    (ed * 100.0).round() as i32
                ),
            });
        }
    }

    // ---- 候选矩阵 ----
    let otsu = if is_binary { otsu_threshold(&rgba) } else { 0 };
    let candidates = dedupe_candidates(build_candidates(&base, &cfg.quality, is_binary, otsu));
    let planned = candidates.len();
    let budget = anchor_budget(&cfg.quality);
    let in_tmp = tmp_name("momo_vec_in", "png");
    rgba.save(&in_tmp)
        .map_err(|e| format!("写临时输入失败：{}", e))?;

    // ---- 逐候选转换 ----
    let mut svgs: Vec<(String, String)> = Vec::with_capacity(planned); // (label, svg_text)
    let mut attempted = 0usize;
    let mut early_score: Option<crate::vec_score::Score> = None;
    for (k, cand) in candidates.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            let _ = std::fs::remove_file(&in_tmp);
            return Err("已取消".into());
        }
        attempted += 1;
        progress(VecEvent::Stage {
            stage: format!("候选 {}/{}（{}）", k + 1, planned, cand.label),
            pct: 0.1 + 0.55 * (k as f32) / (planned as f32),
        });
        let src_tmp = if let Some(t) = cand.binary_thresh {
            let bt = tmp_name("momo_vec_bin", "png");
            binarize(&rgba, t)
                .save(&bt)
                .map_err(|e| format!("写二值临时图失败：{}", e))?;
            bt
        } else {
            in_tmp.clone()
        };
        let out_tmp = tmp_name("momo_vec_out", "svg");
        let res = vtracer::convert_image_to_svg(&src_tmp, &out_tmp, cand.config.clone());
        if src_tmp != in_tmp {
            let _ = std::fs::remove_file(&src_tmp);
        }
        match res {
            Ok(()) => {
                let s = std::fs::read_to_string(&out_tmp)
                    .map_err(|e| format!("读候选 SVG 失败：{}", e))?;
                svgs.push((cand.label.clone(), s));
            }
            Err(e) => progress(VecEvent::Log {
                msg: format!("候选 {}（{}）失败，跳过：{}", k + 1, cand.label, e),
            }),
        }
        let _ = std::fs::remove_file(&out_tmp);
        progress(VecEvent::Progress {
            pct: 0.1 + 0.55 * ((k + 1) as f32) / (planned as f32),
        });

        // VTracer 单个候选内部不能安全中断；候选边界执行总耗时守卫，至少保留已经完成的
        // 结果并停止继续线性叠加耗时。
        let budget_secs = candidate_budget_secs(&cfg.quality);
        if k + 1 < planned && start.elapsed().as_secs() >= budget_secs {
            progress(VecEvent::Log {
                msg: format!(
                    "已达到本档 {} 秒候选预算，使用当前 {} 个候选选优",
                    budget_secs,
                    svgs.len()
                ),
            });
            break;
        }

        // 质量早停：简单 Logo/色块的基准候选经常已经近乎无损，继续跑 2~4 个候选只会线性变慢。
        // few-nodes 的目标是比较复杂度，不能早停；fast 本来就只有一个。
        if k == 0 && cfg.quality != "fast" && cfg.quality != "few-nodes" {
            if let Some((_, first)) = svgs.first() {
                if let Ok(sc) = crate::vec_score::score_candidate(first, &score_rgba, budget, 0.1) {
                    let within_budget = sc.anchors <= budget;
                    if sc.rmse <= 0.035 && sc.edge_iou >= 0.94 && within_budget {
                        progress(VecEvent::Log { msg: format!("基准候选已达生产阈值（RMSE {:.3} / 边缘 {:.1}%），提前结束其余候选", sc.rmse, sc.edge_iou * 100.0) });
                        early_score = Some(sc);
                        break;
                    }
                }
            }
        }
    }
    let _ = std::fs::remove_file(&in_tmp);
    if svgs.is_empty() {
        return Err("所有候选均转换失败".into());
    }

    // ---- 评分选优（fast 档跳过：单候选直出，省一次渲染，文档 §9）----
    let (selected, svg_raw, score) = if svgs.len() == 1 {
        let (label, s) = svgs.into_iter().next().unwrap();
        let sc = if cfg.quality == "fast" {
            None
        } else {
            early_score
                .or_else(|| crate::vec_score::score_candidate(&s, &score_rgba, budget, 0.1).ok())
        };
        (label, s, sc.map(|v| v.total))
    } else {
        progress(VecEvent::Stage {
            stage: "候选评分".into(),
            pct: 0.7,
        });
        // 少节点档复杂度与质量并重（否则简化候选在 RMSE 小亏时赢不了）；其余档质量优先
        let cb: f64 = if cfg.quality == "few-nodes" { 0.5 } else { 0.1 };
        let mut scored: Vec<(usize, crate::vec_score::Score)> = Vec::new();
        let mut scores_log = Vec::new();
        for (i, (label, s)) in svgs.iter().enumerate() {
            if cancel.load(Ordering::SeqCst) {
                return Err("已取消".into());
            }
            match crate::vec_score::score_candidate(s, &score_rgba, budget, cb) {
                Ok(sc) => {
                    scores_log.push(format!("{}={:.2}", label, sc.total));
                    scored.push((i, sc));
                }
                Err(e) => progress(VecEvent::Log {
                    msg: format!("候选 {} 评分失败：{}", label, e),
                }),
            }
            progress(VecEvent::Progress {
                pct: 0.7 + 0.2 * ((i + 1) as f32) / (svgs.len() as f32),
            });
        }
        if scored.is_empty() {
            return Err("全部候选评分失败".into());
        }
        // 预算是交付约束，不只是装饰性扣分：只要存在预算内候选，就绝不选择超预算版本。
        let has_within = scored.iter().any(|(_, s)| s.anchors <= budget);
        if !has_within {
            let msg = format!(
                "全部候选均超过 {} 锚点预算，已选择综合质量最佳版本；建议改用「少节点」档",
                budget
            );
            progress(VecEvent::Log { msg: msg.clone() });
            hint = Some(match hint {
                Some(old) => format!("{}；{}", old, msg),
                None => msg,
            });
        }
        let (bi, bsc) = scored
            .into_iter()
            .filter(|(_, s)| !has_within || s.anchors <= budget)
            .max_by(|(_, a), (_, b)| {
                a.total
                    .partial_cmp(&b.total)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .ok_or("候选预算筛选失败")?;
        progress(VecEvent::Log {
            msg: format!(
                "候选评分：{}；胜出「{}」",
                scores_log.join(" / "),
                svgs[bi].0
            ),
        });
        let (label, s) = svgs.into_iter().nth(bi).unwrap();
        (label, s, Some(bsc.total))
    };

    // ---- 后处理：清洗 + 几何图元层 ----
    progress(VecEvent::Stage {
        stage: "后处理".into(),
        pct: 0.92,
    });
    let mut svg = restore_canvas_size(&sanitize(&svg_raw), (w, h), (work_w, work_h));
    let path_count = svg.matches("<path").count();
    let anchors = crate::vec_score::count_anchors(&svg);
    let mut shape_count = 0usize;
    if cfg.geometry {
        if cancel.load(Ordering::SeqCst) {
            return Err("已取消".into());
        }
        let shapes = crate::geom::detect_shapes(&rgba);
        if !shapes.is_empty() {
            let layer = crate::geom::shapes_to_svg(&shapes);
            let candidate = svg.replacen(
                "</svg>",
                &format!("<g data-momo-geometry=\"true\">\n{}</g>\n</svg>", layer),
                1,
            );
            let base_sc = crate::vec_score::score_candidate(&svg, &score_rgba, budget, 0.1).ok();
            let geom_sc =
                crate::vec_score::score_candidate(&candidate, &score_rgba, budget, 0.1).ok();
            if matches!((base_sc, geom_sc), (Some(a), Some(b)) if b.total > a.total + 0.001 && b.anchors <= budget)
            {
                svg = candidate;
                shape_count = shapes.len();
                progress(VecEvent::Log {
                    msg: format!("几何图元层通过重渲染守卫，接受 {} 个图元", shape_count),
                });
            } else {
                progress(VecEvent::Log {
                    msg: "几何图元未改善最终重渲染质量，已安全回退原路径".into(),
                });
            }
        }
    }
    // 清洗和几何后再做一次最终回评，门禁只认最终实际落盘的 SVG。
    let final_score = if cfg.quality == "fast" {
        None
    } else {
        crate::vec_score::score_candidate(&svg, &score_rgba, budget, 0.1).ok()
    };
    let quality_passed = final_score.map(|s| {
        let (rmse_max, edge_min) = if cfg.quality == "high-fidelity" {
            (0.10, 0.62)
        } else {
            (0.14, 0.52)
        };
        s.rmse <= rmse_max && s.edge_iou >= edge_min && s.alpha_iou >= 0.92 && s.anchors <= budget
    });
    if quality_passed == Some(false) {
        let sc = final_score.unwrap();
        let msg = format!("最终重渲染未通过生产门禁（RMSE {:.3} / 边缘 {:.1}% / 透明轮廓 {:.1}%），请改用高保真档或人工复核", sc.rmse, sc.edge_iou * 100.0, sc.alpha_iou * 100.0);
        progress(VecEvent::Log { msg: msg.clone() });
        hint = Some(match hint {
            Some(old) => format!("{}；{}", old, msg),
            None => msg,
        });
    }
    std::fs::write(out_path, &svg).map_err(|e| format!("写输出失败：{}", e))?;
    progress(VecEvent::Stage {
        stage: "完成".into(),
        pct: 1.0,
    });
    Ok(VectorizeResult {
        svg_path: out_path.to_string(),
        svg,
        width: w,
        height: h,
        path_count,
        shape_count,
        elapsed_ms: start.elapsed().as_millis() as u64,
        candidates: attempted,
        anchors,
        anchor_budget: budget,
        score: final_score.map(|s| s.total).or(score),
        quality_passed,
        rmse: final_score.map(|s| s.rmse),
        edge_iou: final_score.map(|s| s.edge_iou),
        alpha_iou: final_score.map(|s| s.alpha_iou),
        selected,
        hint,
    })
}

/// 防御性清洗：VTracer 输出本不含危险内容；此函数作兜底，并供未来导入外部 SVG 复用
fn sanitize(svg: &str) -> String {
    let mut s = svg.replace("javascript:", "");
    let lower = s.to_ascii_lowercase();
    if let Some(a) = lower.find("<script") {
        if let Some(b) = lower.find("</script>") {
            if b + 9 <= s.len() && b >= a {
                s.replace_range(a..b + 9, "");
            }
        }
    }
    s
}

/* ---------------- 单测 ---------------- */
#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};
    use std::io::Cursor;

    fn synth_logo(w: u32, h: u32) -> Vec<u8> {
        // 三色块 + 圆，模拟扁平 Logo
        let mut img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let cx = (w / 2) as i32;
                let cy = (h / 2) as i32;
                let dx = x as i32 - cx;
                let dy = y as i32 - cy;
                let c = if dx * dx + dy * dy < (h as i32 / 3) * (h as i32 / 3) {
                    Rgba([220, 30, 30, 255]) // 红圆
                } else if x < w / 2 {
                    Rgba([30, 120, 220, 255]) // 蓝左
                } else {
                    Rgba([240, 220, 40, 255]) // 黄右
                };
                img.put_pixel(x, y, c);
            }
        }
        let mut buf = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut buf, image::ImageFormat::Png)
            .unwrap();
        buf.into_inner()
    }

    fn cfg_q(quality: &str) -> VectorizeConfig {
        VectorizeConfig {
            flat_colors: None,
            preset: "poster".into(),
            color_mode: "auto".into(),
            hierarchical: "stacked".into(),
            color_precision: 0,
            filter_speckle: 0,
            path_precision: 2,
            geometry: false,
            quality: quality.into(),
            flat_ratio: None,
            edge_density: None,
            jpeg_score: None,
        }
    }

    #[test]#[ignore="显式提供真实平面拆件验收目录"]
    fn flat_art_to_vector_delivery(){
        let dir=std::path::PathBuf::from(std::env::var("MOMO_VECTOR_ACCEPTANCE_DIR").expect("须指定验收目录"));
        let bytes=std::fs::read(dir.join("bridge-second.png")).unwrap();let mut cfg=cfg_q("high-fidelity");cfg.preset="flat".into();cfg.flat_colors=Some(4);cfg.filter_speckle=1;
        let out=dir.join("拆件-纯色路径.svg");let result=run_core(&bytes,out.to_str().unwrap(),&cfg,&|_|{}).unwrap();
        assert!(!result.svg.contains("<image"));assert!(result.path_count>0&&result.path_count<80);
        crate::export::run(&result.svg,"pdf",dir.join("拆件-矢量.pdf").to_str().unwrap(),300.,300.).unwrap();
        crate::export::run(&result.svg,"png",dir.join("拆件-4倍.png").to_str().unwrap(),(result.width*4)as f64,0.).unwrap();
        std::fs::write(dir.join("vector-report.json"),serde_json::to_string_pretty(&result).unwrap()).unwrap();
    }

    #[test]
    fn flat_rectangle_never_bulges_outside_source(){
        let mut img=image::RgbaImage::from_pixel(128,128,image::Rgba([255,255,255,255]));
        for y in 30..99 {for x in 25..88{img.put_pixel(x,y,image::Rgba([130,8,245,255]));}}
        let mut bytes=std::io::Cursor::new(Vec::new());img.write_to(&mut bytes,image::ImageFormat::Png).unwrap();
        let mut cfg=cfg_q("fast");cfg.preset="flat".into();cfg.flat_colors=Some(2);
        let path=format!("{}/flat_rect.svg",env!("OUT_DIR"));let r=run_core(&bytes.into_inner(),&path,&cfg,&|_|{}).unwrap();
        let tree=resvg::usvg::Tree::from_str(&r.svg,&Default::default()).unwrap();let mut pix=resvg::tiny_skia::Pixmap::new(128,128).unwrap();resvg::render(&tree,resvg::tiny_skia::Transform::identity(),&mut pix.as_mut());
        let mut purple=0;for y in 0..128{for x in 0..128{let p=pix.pixel(x,y).unwrap();if p.green()<70&&p.blue()>170{purple+=1;assert!(x>=24&&x<=88&&y>=29&&y<=99,"直边不能鼓出源图范围：{x},{y}");}}}assert!(purple>4000);
    }

    #[test]
    fn vectorize_produces_valid_svg() {
        let bytes = synth_logo(120, 120);
        let out = format!("{}/vec_test.svg", env!("OUT_DIR"));
        let r = run_core(&bytes, &out, &cfg_q("fast"), &|_| {}).expect("VTracer 应成功");
        // 输出是合法 SVG：含 <svg 开头 + 至少 1 条 path
        assert!(
            r.svg.starts_with("<svg") || r.svg.starts_with("<?xml"),
            "应为 SVG：{}",
            &r.svg[..20.min(r.svg.len())]
        );
        assert!(r.path_count >= 1, "至少 1 条路径");
        assert!(
            !r.svg.to_ascii_lowercase().contains("<script"),
            "不应含 script"
        );
        assert!(std::path::Path::new(&out).exists(), "SVG 应落盘");
        assert_eq!(r.candidates, 1, "fast 档应单候选");
        assert!(r.score.is_none(), "fast 档不评分");
        eprintln!(
            "矢量单候选：{}×{}，{} 条路径，{} 锚点",
            r.width, r.height, r.path_count, r.anchors
        );
    }

    #[test]
    #[ignore = "显式指定自制验收图片才运行，不读取用户作品"]
    fn external_flat_sheet_to_paths() {
        let source = std::path::PathBuf::from(std::env::var("MOMO_VECTOR_ACCEPTANCE_SOURCE").expect("请指定验收图片"));
        let output = source.with_extension("svg");
        assert!(!output.exists(), "验收不能覆盖已有 SVG");
        let bytes = std::fs::read(&source).expect("读取自制平面总稿");
        let result = run_core(&bytes, &output.to_string_lossy(), &cfg_q("fast"), &|_| {}).expect("真实总稿描摹成功");
        assert!(result.path_count > 0);
        assert!(!result.svg.contains("<image"), "必须是路径，不能包装栅格图");
        eprintln!("真实平面总稿：{}×{}，{} 条路径，{} 锚点", result.width, result.height, result.path_count, result.anchors);
    }

    #[test]
    fn quality_maps_to_candidate_count() {
        // 质量档 → 候选数映射（彩色）：1 / 3 / 5 / 3
        let base = Config::from_preset(Preset::Poster);
        assert_eq!(build_candidates(&base, "fast", false, 0).len(), 1);
        assert_eq!(build_candidates(&base, "balanced", false, 0).len(), 3);
        assert_eq!(build_candidates(&base, "high-fidelity", false, 0).len(), 5);
        assert_eq!(build_candidates(&base, "few-nodes", false, 0).len(), 3);
        // 二值同样映射
        assert_eq!(build_candidates(&base, "fast", true, 128).len(), 1);
        assert_eq!(build_candidates(&base, "balanced", true, 128).len(), 3);
        assert_eq!(build_candidates(&base, "high-fidelity", true, 128).len(), 5);
        assert_eq!(build_candidates(&base, "few-nodes", true, 128).len(), 3);
        // few-nodes 末候选应为多边形极简模式
        let fn_c = build_candidates(&base, "few-nodes", false, 0);
        assert!(matches!(
            fn_c.last().unwrap().config.mode,
            PathSimplifyMode::Polygon
        ));

        // Poster 默认色准已经是 8；“色准+1”与基准完全相同，执行前必须去重。
        assert_eq!(
            dedupe_candidates(build_candidates(&base, "balanced", false, 0)).len(),
            2
        );
    }

    #[test]
    fn ultra_hd_input_uses_bounded_trace_canvas() {
        let balanced = trace_work_size(3840, 3840, "balanced", false);
        let high = trace_work_size(3840, 3840, "high-fidelity", false);
        assert!(balanced.0 <= 1_792 && balanced.0 as u64 * balanced.1 as u64 <= 1_790_000);
        assert!(high.0 <= 2_048 && high.0 as u64 * high.1 as u64 <= 2_570_000);
        assert!(high.0 >= balanced.0, "高保真应保留更多追踪像素");

        let line = trace_work_size(3840, 3840, "high-fidelity", true);
        assert!(line.0 > high.0, "二值线稿应给更高工作分辨率以保细线");
    }

    #[test]
    fn restored_canvas_keeps_original_size_and_work_viewbox() {
        let src = r#"<svg width="1600" height="1600"><path d="M0 0"/></svg>"#;
        let out = restore_canvas_size(src, (3840, 3840), (1600, 1600));
        assert!(out.contains(r#"width="3840" height="3840""#));
        assert!(out.contains(r#"viewBox="0 0 1600 1600""#));
    }

    #[test]
    fn balanced_scores_and_picks() {
        // balanced：3 候选 + 评分选优，报告字段齐全
        let bytes = synth_logo(160, 160);
        let out = format!("{}/vec_bal.svg", env!("OUT_DIR"));
        let r = run_core(&bytes, &out, &cfg_q("balanced"), &|_| {}).expect("balanced 应成功");
        assert!(
            (1..=2).contains(&r.candidates),
            "去重/早停后应执行 1~2 个有效候选"
        );
        assert!(r.score.is_some(), "多候选应有胜出分");
        assert_eq!(
            r.quality_passed,
            Some(true),
            "合成色块 Logo 应通过生产门禁：{:?}",
            r.hint
        );
        assert!(!r.selected.is_empty(), "应有胜出参数摘要");
        assert!(r.anchors > 0, "应统计锚点");
        eprintln!(
            "balanced：{} 候选，胜出「{}」分 {:.2}，{} 锚点/预算 {}",
            r.candidates,
            r.selected,
            r.score.unwrap(),
            r.anchors,
            r.anchor_budget
        );
    }

    #[test]
    fn few_nodes_reduces_anchors() {
        // 少节点档锚点数应明显低于 balanced（文档 §9 复杂度契约）
        let bytes = synth_logo(200, 200);
        let out_a = format!("{}/vec_fn.svg", env!("OUT_DIR"));
        let out_b = format!("{}/vec_bl.svg", env!("OUT_DIR"));
        let rf = run_core(&bytes, &out_a, &cfg_q("few-nodes"), &|_| {}).expect("few-nodes 应成功");
        let rb = run_core(&bytes, &out_b, &cfg_q("balanced"), &|_| {}).expect("balanced 应成功");
        assert!(
            rf.anchors <= rb.anchors,
            "少节点锚点 {} 应 ≤ 标准 {}",
            rf.anchors,
            rb.anchors
        );
        assert_eq!(rf.anchor_budget, 8000);
        assert_eq!(rb.anchor_budget, 25000);
        eprintln!(
            "锚点对比：few-nodes {} vs balanced {}",
            rf.anchors, rb.anchors
        );
    }

    #[test]
    fn analysis_jpeg_hint_emitted() {
        // jpegScore 高 → hint 提示先去压缩
        let bytes = synth_logo(120, 120);
        let out = format!("{}/vec_hint.svg", env!("OUT_DIR"));
        let mut c = cfg_q("fast");
        c.jpeg_score = Some(0.8);
        let r = run_core(&bytes, &out, &c, &|_| {}).expect("应成功");
        assert!(r.hint.is_some(), "高压缩分应给提示");
        assert!(r.hint.unwrap().contains("去压缩"));
    }

    #[test]
    fn bw_binary_candidates_run() {
        // 黑白档：Otsu + 固定阈值候选（合成图带灰度过渡，Otsu 才有意义）
        let mut img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::new(120, 120);
        for y in 0..120u32 {
            for x in 0..120u32 {
                let v = if x < 50 {
                    40u8
                } else if x < 70 {
                    160u8
                } else {
                    240u8
                };
                img.put_pixel(x, y, Rgba([v, v, v, 255]));
            }
        }
        let mut buf = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut buf, image::ImageFormat::Png)
            .unwrap();
        let mut c = cfg_q("balanced");
        c.preset = "bw".into();
        let out = format!("{}/vec_bw.svg", env!("OUT_DIR"));
        let r = run_core(&buf.into_inner(), &out, &c, &|_| {}).expect("黑白多候选应成功");
        assert_eq!(r.candidates, 3);
        eprintln!("黑白档：{} 候选，胜出「{}」", r.candidates, r.selected);
    }

    #[test]
    fn sanitize_strips_script() {
        let cleaned = sanitize("<svg><script>alert(1)</script><path d='M0 0'/></svg>");
        assert!(!cleaned.to_ascii_lowercase().contains("script"));
        assert!(cleaned.contains("<path"));
    }

    #[test]
    fn binary_threshold_keeps_darkest_stroke_and_alpha() {
        let src = ImageBuffer::from_fn(3, 1, |x, _| match x {
            0 => Rgba([18, 18, 18, 255]),
            1 => Rgba([200, 200, 200, 255]),
            _ => Rgba([0, 0, 0, 0]),
        });
        let out = binarize(&src, 18);
        assert_eq!(
            out.get_pixel(0, 0).0,
            [0, 0, 0, 255],
            "等于阈值的线条必须保留为黑"
        );
        assert_eq!(out.get_pixel(1, 0).0, [255, 255, 255, 255]);
        assert_eq!(out.get_pixel(2, 0).0[3], 0, "透明背景必须保持透明");
    }

    #[test]
    fn cancelled_job_stops_before_first_candidate() {
        let bytes = synth_logo(120, 120);
        let out = format!("{}/vec_cancel.svg", env!("OUT_DIR"));
        let cancel = AtomicBool::new(true);
        let e = run_core_cancel(
            &bytes,
            None,
            &out,
            &cfg_q("high-fidelity"),
            &|_| {},
            &cancel,
        )
        .err()
        .expect("应取消");
        assert_eq!(e, "已取消");
    }

    #[test]
    fn geometry_guard_never_reduces_render_score() {
        let bytes = synth_logo(180, 180);
        let src = image::load_from_memory(&bytes).unwrap().to_rgba8();
        let mut plain_cfg = cfg_q("balanced");
        let plain = run_core(
            &bytes,
            &format!("{}/vec_geom_plain.svg", env!("OUT_DIR")),
            &plain_cfg,
            &|_| {},
        )
        .unwrap();
        plain_cfg.geometry = true;
        let guarded = run_core(
            &bytes,
            &format!("{}/vec_geom_guard.svg", env!("OUT_DIR")),
            &plain_cfg,
            &|_| {},
        )
        .unwrap();
        let a =
            crate::vec_score::score_candidate(&plain.svg, &src, plain.anchor_budget, 0.1).unwrap();
        let b = crate::vec_score::score_candidate(&guarded.svg, &src, guarded.anchor_budget, 0.1)
            .unwrap();
        assert!(
            b.total + 1e-9 >= a.total,
            "几何后处理不得降低重渲染质量：{} < {}",
            b.total,
            a.total
        );
    }

    #[test]
    fn guide_conversion_is_still_scored_against_original_reference() {
        let guide = synth_logo(120, 120);
        let mut ref_img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::new(120, 120);
        for p in ref_img.pixels_mut() {
            *p = Rgba([12, 12, 12, 255]);
        }
        let mut ref_buf = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(ref_img)
            .write_to(&mut ref_buf, image::ImageFormat::Png)
            .unwrap();
        let out = format!("{}/vec_dual_ref.svg", env!("OUT_DIR"));
        let cancel = AtomicBool::new(false);
        let reference = ref_buf.into_inner();
        let r = run_core_cancel(
            &guide,
            Some(&reference),
            &out,
            &cfg_q("balanced"),
            &|_| {},
            &cancel,
        )
        .expect("双源评分应完成");
        assert_eq!(
            r.quality_passed,
            Some(false),
            "转换输入与原图明显不同时不得假通过生产门禁"
        );
        assert!(r.hint.as_deref().unwrap_or("").contains("生产门禁"));
    }

    #[test]
    #[ignore = "仅用于手动验证真实大图；需设置 MOMO_VEC_BENCH_IMAGE"]
    fn benchmark_external_image() {
        let path = std::env::var("MOMO_VEC_BENCH_IMAGE").expect("请设置真实图片路径");
        let bytes = std::fs::read(path).expect("应能读取真实图片");
        let mut cfg = cfg_q("balanced");
        cfg.flat_ratio = Some(0.8);
        let out = format!("{}/vec_external_bench.svg", env!("OUT_DIR"));
        let r = run_core(&bytes, &out, &cfg, &|event| {
            if let VecEvent::Stage { stage, pct } = event {
                eprintln!("[{:.0}%] {}", pct * 100.0, stage);
            }
        })
        .expect("真实大图矢量化应完成");
        eprintln!(
            "真实大图：{}×{}，{} 候选，{} 路径，{} 锚点，{:.1}s，门禁 {:?}",
            r.width,
            r.height,
            r.candidates,
            r.path_count,
            r.anchors,
            r.elapsed_ms as f64 / 1000.0,
            r.quality_passed
        );
    }
}
