//! 矢量导出（阶段二）：SVG → 原生 .ai / .cdr，经 Illustrator / CorelDRAW 的 COM 自动化。
//!
//! - 检测：reg query HKCR\{Illustrator,CorelDRAW}.Application（不启动应用，最快）。
//! - 转换：内嵌 VBScript（cscript //nologo 运行）——Illustrator 单例 Open(svg)+SaveAs(.ai)，
//!   CorelDRAW CreateDocument+ActiveLayer.Import(svg,cdrSVG=1345)+SaveAs(.cdr,Filter=1795)。
//! - 健壮性：spawn_blocking 不阻塞 UI；超时 taskkill /T /F 杀进程树（避免留挂的 AI/CDR）；
//!   UserInteractionLevel=-1 / Visible=False 抑制对话框；校验产物存在 + AI 头为 %PDF。
//! - 仅 Windows；未装对应软件时前端禁用按钮（detect 返回 false）。
use serde::Serialize;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

type SResult<T> = Result<T, String>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppsStatus {
    pub illustrator: bool,
    pub coreldraw: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub bytes: usize,
    pub format: String,
}

const SVG2AI_VBS: &str = r#"Option Explicit
Const aiDontDisplayWarnings = -1
Const aiIllustrator29 = 29
If WScript.Arguments.Count < 2 Then WScript.Quit 2
Dim src, dst
src = WScript.Arguments(0)
dst = WScript.Arguments(1)
Dim app, doc, opt
On Error Resume Next
Set app = CreateObject("Illustrator.Application")
If Err.Number <> 0 Then WScript.Quit 3
Err.Clear
app.UserInteractionLevel = aiDontDisplayWarnings
Set doc = app.Open(src)
If Err.Number <> 0 Then WScript.Quit 4
Err.Clear
Set opt = CreateObject("Illustrator.IllustratorSaveOptions")
opt.Compatibility = aiIllustrator29
opt.PDFCompatible = True
opt.EmbedLinkedFiles = True
opt.FontSubsetThreshold = 100
doc.SaveAs dst, opt
If Err.Number <> 0 Then WScript.Quit 5
Err.Clear
doc.Close 1
WScript.Quit 0
"#;

const SVG2CDR_VBS: &str = r#"Option Explicit
Const cdrSVG = 1345, cdrCDR = 1795, cdrAllPages = 0, cdrCurrentVersion = 0
If WScript.Arguments.Count < 4 Then WScript.Quit 2
Dim src, dst, wMM, hMM
src = WScript.Arguments(0)
dst = WScript.Arguments(1)
wMM = CDbl(WScript.Arguments(2))
hMM = CDbl(WScript.Arguments(3))
Dim app, doc, opt
On Error Resume Next
Set app = CreateObject("CorelDRAW.Application")
If Err.Number <> 0 Then WScript.Quit 3
Err.Clear
app.Visible = False
app.Optimization = True
Set doc = app.CreateDocument
If Err.Number <> 0 Then WScript.Quit 4
Err.Clear
On Error Resume Next
doc.Unit = 2
doc.ActivePage.SizeWidth = wMM
doc.ActivePage.SizeHeight = hMM
doc.ActiveLayer.Import src, cdrSVG
If Err.Number <> 0 Then WScript.Quit 5
Err.Clear
Set opt = app.CreateStructSaveAsOptions()
opt.Filter = cdrCDR
opt.Version = cdrCurrentVersion
opt.Overwrite = True
opt.Range = cdrAllPages
opt.EmbedICCProfile = False
opt.IncludeCMXData = False
doc.SaveAs dst, opt
If Err.Number <> 0 Then WScript.Quit 6
Err.Clear
doc.Close
app.Optimization = False
WScript.Quit 0
"#;

const SVG2PDF_VBS: &str = r#"Option Explicit
Const aiDontDisplayWarnings = -1
If WScript.Arguments.Count < 2 Then WScript.Quit 2
Dim src, dst
src = WScript.Arguments(0)
dst = WScript.Arguments(1)
Dim app, doc, opt
On Error Resume Next
Set app = CreateObject("Illustrator.Application")
If Err.Number <> 0 Then WScript.Quit 3
Err.Clear
app.UserInteractionLevel = aiDontDisplayWarnings
Set doc = app.Open(src)
If Err.Number <> 0 Then WScript.Quit 4
Err.Clear
Set opt = CreateObject("Illustrator.PDFSaveOptions")
opt.PreserveEditability = False
doc.SaveAs dst, opt
If Err.Number <> 0 Then WScript.Quit 5
Err.Clear
doc.Close 1
WScript.Quit 0
"#;

/// 探测本机是否安装 Illustrator / CorelDRAW（查 COM ProgID 注册，不启动应用）
pub fn detect_apps() -> AppsStatus {
    AppsStatus {
        illustrator: reg_exists("HKEY_CLASSES_ROOT\\Illustrator.Application"),
        coreldraw: reg_exists("HKEY_CLASSES_ROOT\\CorelDRAW.Application"),
    }
}

fn reg_exists(key: &str) -> bool {
    Command::new("reg")
        .args(["query", key])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// SVG 文本 → 原生 .ai / .cdr。w_mm/h_mm 仅 CorelDRAW 页面尺寸用。
/// format="eps" 走独立导出（不依赖 AI/CDR，见 run_eps）。
pub fn run(svg: &str, format: &str, out_path: &str, w_mm: f64, h_mm: f64) -> SResult<ExportResult> {
    if format == "pdf" { return run_pdf(svg, out_path, w_mm, h_mm); }
    if format == "png" { return run_png(svg, out_path, w_mm as u32); }
    if format == "eps" {
        return run_eps(svg, out_path);
    }
    let (script_name, body, need_dim): (&str, &str, bool) = match format {
        "ai" => ("momo_svg2ai.vbs", SVG2AI_VBS, false),
        "pdf" => ("momo_svg2pdf.vbs", SVG2PDF_VBS, false),
        "cdr" => ("momo_svg2cdr.vbs", SVG2CDR_VBS, true),
        _ => return Err(format!("暂不支持的导出格式：{}", format)),
    };
    let app_name = if format == "cdr" {
        "CorelDRAW"
    } else {
        "Illustrator"
    };

    let script_tmp = std::env::temp_dir().join(script_name);
    std::fs::write(&script_tmp, body).map_err(|e| format!("写脚本失败：{}", e))?;
    let svg_tmp = std::env::temp_dir().join(format!("momo_vec_export_{}.svg", unique_nanos()));
    std::fs::write(&svg_tmp, svg).map_err(|e| format!("写临时 SVG 失败：{}", e))?;

    let mut cmd = Command::new("cscript");
    cmd.args(["//nologo", script_tmp.to_str().unwrap()]);
    cmd.arg(svg_tmp.to_str().unwrap());
    cmd.arg(out_path);
    if need_dim {
        cmd.arg(format!("{}", w_mm));
        cmd.arg(format!("{}", h_mm));
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let run = run_with_timeout(cmd, Duration::from_secs(180));
    let _ = std::fs::remove_file(&script_tmp);
    let _ = std::fs::remove_file(&svg_tmp);

    let code = run?;
    if code != 0 {
        let hint = match code {
            3 => format!("无法启动 {}（确认已安装）", app_name),
            4 => format!("{} 新建/打开文档失败", app_name),
            5 => format!("{} 导入/保存失败（SVG 可能含不支持的元素）", app_name),
            6 => format!("{} SaveAs 失败", app_name),
            _ => format!("{} 退出码 {}", app_name, code),
        };
        return Err(format!("导出失败：{}", hint));
    }
    if !std::path::Path::new(out_path).exists() {
        return Err("导出后未找到输出文件".into());
    }
    let meta = std::fs::metadata(out_path).map_err(|e| format!("读输出文件失败：{}", e))?;
    if meta.len() == 0 {
        return Err("输出文件为空".into());
    }
    // 格式头校验（文档 §27.2：禁止只看扩展名）：AI(pdfCompatible) 与 PDF 都应以 %PDF 开头
    if format == "ai" || format == "pdf" {
        let head = std::fs::read(out_path).map_err(|e| e.to_string())?;
        if !head.starts_with(b"%PDF") {
            return Err(format!(
                "{} 文件头不是 %PDF（pdfCompatible 的 AI / PDF 应以 PDF 头开始）",
                format.to_uppercase()
            ));
        }
    }
    Ok(ExportResult {
        path: out_path.to_string(),
        bytes: meta.len() as usize,
        format: format.to_string(),
    })
}

/// 独立矢量 PDF：拒绝会栅格化的滤镜/图片，避免“套壳 PDF”误当生产矢量。
fn run_pdf(svg:&str,out_path:&str,w_mm:f64,h_mm:f64)->SResult<ExportResult>{
    let lower=svg.to_lowercase();
    if lower.contains("<image")||lower.contains("<filter")||lower.contains("filter="){return Err("纯矢量 PDF 不接受嵌入位图或滤镜，请先转为路径".into());}
    if !w_mm.is_finite()||!h_mm.is_finite()||w_mm<=0.||h_mm<=0.||w_mm>20000.||h_mm>20000.{return Err("导出尺寸必须在 0–20000 mm 之间".into());}
    let mut opts=svg2pdf::usvg::Options::default();opts.fontdb_mut().load_system_fonts();
    opts.image_href_resolver.resolve_string=Box::new(|_,_|None);
    let tree=svg2pdf::usvg::Tree::from_str(svg,&opts).map_err(|e|format!("SVG 解析失败：{e}"))?;
    if (w_mm/h_mm-tree.size().width() as f64/tree.size().height() as f64).abs()>0.01{return Err("导出宽高比与矢量稿不一致，请保持原稿比例".into());}
    let dpi=(tree.size().width() as f64*25.4/w_mm) as f32;
    let bytes=svg2pdf::to_pdf(&tree,svg2pdf::ConversionOptions{embed_text:false,..Default::default()},svg2pdf::PageOptions{dpi}).map_err(|e|format!("PDF 转换失败：{e}"))?;
    std::fs::write(out_path,&bytes).map_err(|e|e.to_string())?;
    Ok(ExportResult{path:out_path.into(),bytes:bytes.len(),format:"pdf".into()})
}
/// 从矢量曲线直接重新栅格化，不放大原图的马赛克。w_px 是用户指定的输出像素宽。
fn run_png(svg:&str,out_path:&str,w_px:u32)->SResult<ExportResult>{
    let mut opts=resvg::usvg::Options::default();opts.image_href_resolver.resolve_string=Box::new(|_,_|None);
    let tree=resvg::usvg::Tree::from_str(svg,&opts).map_err(|e|e.to_string())?;
    let scale=w_px as f32/tree.size().width();let h=(tree.size().height()*scale).round() as u32;
    if w_px<1||w_px>32768||h<1||h>32768||w_px as u64*h as u64>64_000_000{return Err("PNG 输出限制为 6400 万像素，请降低倍率".into());}
    let mut pix=resvg::tiny_skia::Pixmap::new(w_px,h).ok_or("无法分配输出画布")?;
    resvg::render(&tree,resvg::tiny_skia::Transform::from_scale(scale,scale),&mut pix.as_mut());
    pix.save_png(out_path).map_err(|e|e.to_string())?;let bytes=std::fs::metadata(out_path).map_err(|e|e.to_string())?.len() as usize;
    Ok(ExportResult{path:out_path.into(),bytes,format:"png".into()})
}

fn unique_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/* ---------------- EPS 独立导出（批次6，文档 §15：不依赖 AI/CDR 的印刷交换格式） ---------------- */

/// SVG → EPS：usvg 解析（组/变换已烘平到绝对坐标）→ PostScript 路径填充。
/// 降级约定（印刷应急通道，不是全保真转换器）：
/// 渐变/图案取首停止色当纯填充；无填充的描边路径以描边色填充；文字/位图跳过（计入日志）。
pub fn run_eps(svg: &str, out_path: &str) -> SResult<ExportResult> {
    let opt = resvg::usvg::Options::default();
    let tree =
        resvg::usvg::Tree::from_str(svg, &opt).map_err(|e| format!("解析 SVG 失败：{}", e))?;
    let size = tree.size();
    let (w, h) = (size.width().ceil().max(1.0), size.height().ceil().max(1.0));
    let mut ps = format!(
        "%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 {} {}\n%%Creator: MOMO 智能画布\n%%EndComments\n",
        w as u32, h as u32
    );
    let mut skipped = 0u32;
    walk_eps(tree.root(), h, &mut ps, &mut skipped);
    ps.push_str("showpage\n%%EOF\n");
    std::fs::write(out_path, &ps).map_err(|e| format!("写 EPS 失败：{}", e))?;
    let meta = std::fs::metadata(out_path).map_err(|e| e.to_string())?;
    if skipped > 0 {
        eprintln!(
            "[EPS] 跳过 {} 个不支持的元素（文字/位图/无填充描边）",
            skipped
        );
    }
    Ok(ExportResult {
        path: out_path.to_string(),
        bytes: meta.len() as usize,
        format: "eps".to_string(),
    })
}

fn paint_color(paint: &resvg::usvg::Paint) -> Option<(f32, f32, f32)> {
    use resvg::usvg::Paint;
    let c = match paint {
        Paint::Color(c) => *c,
        // 渐变降级：首停止色（文档约定「渐变降级为填充」）
        Paint::LinearGradient(lg) => lg.stops().first()?.color(),
        Paint::RadialGradient(rg) => rg.stops().first()?.color(),
        Paint::Pattern(_) => return None,
    };
    Some((
        c.red as f32 / 255.0,
        c.green as f32 / 255.0,
        c.blue as f32 / 255.0,
    ))
}

fn walk_eps(group: &resvg::usvg::Group, page_h: f32, ps: &mut String, skipped: &mut u32) {
    use resvg::usvg::Node;
    for node in group.children() {
        match node {
            Node::Group(sub) => walk_eps(sub, page_h, ps, skipped),
            Node::Path(p) => {
                if !p.is_visible() {
                    continue;
                }
                let Some((r, g, b)) = p
                    .fill()
                    .and_then(|f| paint_color(f.paint()))
                    .or_else(|| p.stroke().and_then(|s| paint_color(s.paint())))
                else {
                    *skipped += 1;
                    continue;
                };
                let t = p.abs_transform();
                // usvg 坐标 → EPS 坐标（y 轴翻转，原点左下）
                let map = move |x: f32, y: f32| -> (f32, f32) {
                    (
                        t.sx * x + t.kx * y + t.tx,
                        page_h - (t.ky * x + t.sy * y + t.ty),
                    )
                };
                ps.push_str(&format!(
                    "{:.3} {:.3} {:.3} setrgbcolor\nnewpath\n",
                    r, g, b
                ));
                let mut cur = (0f32, 0f32);
                for seg in p.data().segments() {
                    use resvg::usvg::tiny_skia_path::PathSegment;
                    match seg {
                        PathSegment::MoveTo(p0) => {
                            let (x, y) = map(p0.x, p0.y);
                            ps.push_str(&format!("{:.2} {:.2} moveto\n", x, y));
                            cur = (p0.x, p0.y);
                        }
                        PathSegment::LineTo(p0) => {
                            let (x, y) = map(p0.x, p0.y);
                            ps.push_str(&format!("{:.2} {:.2} lineto\n", x, y));
                            cur = (p0.x, p0.y);
                        }
                        PathSegment::QuadTo(p1, p2) => {
                            // PS 无二阶贝塞尔：升阶为三阶（c1 = P0 + 2/3(P1−P0)，c2 = P2 + 2/3(P1−P2)）
                            let c1 = (
                                cur.0 + 2.0 / 3.0 * (p1.x - cur.0),
                                cur.1 + 2.0 / 3.0 * (p1.y - cur.1),
                            );
                            let c2 = (
                                p2.x + 2.0 / 3.0 * (p1.x - p2.x),
                                p2.y + 2.0 / 3.0 * (p1.y - p2.y),
                            );
                            let (x1, y1) = map(c1.0, c1.1);
                            let (x2, y2) = map(c2.0, c2.1);
                            let (x3, y3) = map(p2.x, p2.y);
                            ps.push_str(&format!(
                                "{:.2} {:.2} {:.2} {:.2} {:.2} {:.2} curveto\n",
                                x1, y1, x2, y2, x3, y3
                            ));
                            cur = (p2.x, p2.y);
                        }
                        PathSegment::CubicTo(p1, p2, p3) => {
                            let (x1, y1) = map(p1.x, p1.y);
                            let (x2, y2) = map(p2.x, p2.y);
                            let (x3, y3) = map(p3.x, p3.y);
                            ps.push_str(&format!(
                                "{:.2} {:.2} {:.2} {:.2} {:.2} {:.2} curveto\n",
                                x1, y1, x2, y2, x3, y3
                            ));
                            cur = (p3.x, p3.y);
                        }
                        PathSegment::Close => ps.push_str("closepath\n"),
                    }
                }
                ps.push_str("fill\n");
            }
            _ => *skipped += 1, // 文字/位图：EPS 通道不支持
        }
    }
}

fn run_with_timeout(mut cmd: Command, timeout: Duration) -> SResult<i32> {
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 cscript 失败：{}", e))?;
    let pid = child.id();
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => return Ok(status.code().unwrap_or(-1)),
            None => {
                if Instant::now() > deadline {
                    let _ = Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/T", "/F"])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                    return Err("导出超时（180s），已终止进程树。请确认 Illustrator/CorelDRAW 未被弹窗阻塞。".into());
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }
}

/* ---------------- 单测（只测不启动应用的部分）---------------- */
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independent_pdf_keeps_paths_and_mm(){
        let svg=r#"<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200"><path d="M10 10H390V190H10Z" fill="red"/></svg>"#;
        let dir=std::env::var("MOMO_VECTOR_ACCEPTANCE_DIR").unwrap_or_else(|_|env!("OUT_DIR").into());
        let pdf=format!("{dir}/平面拆件.pdf");run_pdf(svg,&pdf,200.,100.).unwrap();
        let bytes=std::fs::read(&pdf).unwrap();let text=String::from_utf8_lossy(&bytes);assert!(text.starts_with("%PDF"));assert!(!text.contains("/Subtype /Image"));assert!(text.contains("/MediaBox"));
        let png=format!("{dir}/平面拆件-4x.png");run_png(svg,&png,1600).unwrap();let img=image::open(png).unwrap();assert_eq!((img.width(),img.height()),(1600,800));
        assert!(run_png(svg,"unused.png",32000).is_err());assert!(run_pdf(svg,"unused.pdf",200.,500.).is_err());
    }
    #[test]fn pdf_rejects_raster_and_filters(){assert!(run_pdf("<svg><image href='x'/></svg>","unused.pdf",1.,1.).is_err());assert!(run_pdf("<svg><filter/></svg>","unused.pdf",1.,1.).is_err());}

    #[test]
    fn vbs_scripts_present() {
        assert!(SVG2AI_VBS.contains("IllustratorSaveOptions") && SVG2AI_VBS.contains("SaveAs"));
        assert!(
            SVG2CDR_VBS.contains("CreateDocument")
                && SVG2CDR_VBS.contains("1345")
                && SVG2CDR_VBS.contains("1795")
        );
        assert!(
            SVG2PDF_VBS.contains("PDFSaveOptions"),
            "PDF 脚本应含 PDFSaveOptions"
        );
    }

    #[test]
    fn eps_export_writes_postscript() {
        // 独立 EPS：红色矩形 path + 渐变圆（降级首停止色），校验 PS 头/颜色/路径命令
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"100\" height=\"80\">\
            <defs><linearGradient id=\"g1\"><stop offset=\"0\" stop-color=\"#00ff00\"/><stop offset=\"1\" stop-color=\"#0000ff\"/></linearGradient></defs>\
            <path d=\"M10 10 L90 10 L90 70 L10 70 Z\" fill=\"#dc1e1e\"/>\
            <circle cx=\"50\" cy=\"40\" r=\"20\" fill=\"url(#g1)\"/></svg>";
        let out = format!("{}/eps_test.eps", env!("OUT_DIR"));
        let r = run_eps(svg, &out).expect("EPS 导出应成功");
        let ps = std::fs::read_to_string(&out).unwrap();
        assert!(ps.starts_with("%!PS-Adobe-3.0 EPSF-3.0"), "应为 EPS 文件头");
        assert!(
            ps.contains("%%BoundingBox: 0 0 100 80"),
            "应有正确 BoundingBox"
        );
        assert!(
            ps.contains("0.863 0.118 0.118 setrgbcolor"),
            "应含矩形红色：{}",
            &ps[..ps.len().min(600)]
        );
        assert!(
            ps.contains("0.000 1.000 0.000 setrgbcolor"),
            "渐变应降级为首停止色（绿）"
        );
        assert!(
            ps.contains("lineto") && ps.contains("curveto") && ps.contains("fill"),
            "应有路径命令与填充"
        );
        assert!(ps.ends_with("%%EOF\n"), "应以 %%EOF 收尾");
        assert!(r.bytes > 100, "EPS 不应为空壳");
        eprintln!("EPS 导出：{} 字节", r.bytes);
    }

    #[test]
    fn detect_apps_runs() {
        // 不断言结果（CI 可能没装），只保证 reg query 不 panic、返回结构合法
        let s = detect_apps();
        let _ = s.illustrator;
        let _ = s.coreldraw;
    }
}
