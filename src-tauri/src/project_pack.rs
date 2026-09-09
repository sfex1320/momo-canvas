//! 可移植项目包（导演台 2.0 · 方案 §16）
//!
//! `.momoproject` 是一个目录（无第三方 zip 依赖，可直接浏览/手工修改）：
//! ```text
//! 项目名.momoproject/
//! ├─ project.momo.json     # DirectorProject 数据（绝不含 API Key——settings 不入包）
//! ├─ templates.json        # 引用的 ComfyUI 模板快照（缺失时导入端出报告）
//! ├─ manifest.json         # 包清单（版本/资产索引/模板清单）
//! └─ assets/<相对路径>      # 引用素材（按内容指纹在前端已去重）
//! ```
//! 导入端按资产 manifest 与本地 contentHash 指纹去重复用（§16.3）。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackManifest {
    pub pack_version: u32,
    pub project_name: String,
    pub exported_at: u128,
    /// 资产索引：相对路径（assets/ 下）→ 内容指纹（导入去重用）
    pub assets: Vec<PackAssetEntry>,
    /// 引用的模板 id 列表（导入端检查是否缺失）
    pub template_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackAssetEntry {
    pub rel: String,
    pub hash: String,
    pub kind: String,
    /// 导出端项目里引用的资产 id（导入端据此重链接：旧 id → 包内 rel → 本机新 id）
    #[serde(default)]
    pub asset_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackResult {
    pub dir: String,
    pub file_count: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPack {
    pub project_json: String,
    pub templates_json: Option<String>,
    pub manifest: PackManifest,
    pub dir: String,
}

/// 流式复制（大视频不整读进内存）
fn copy_file(src: &Path, dst: &Path) -> Result<u64, String> {
    if let Some(p) = dst.parent() {
        fs::create_dir_all(p).map_err(|e| format!("创建目录失败：{}", e))?;
    }
    fs::copy(src, dst).map_err(|e| format!("复制 {} 失败：{}", src.display(), e))
}

/// 导出项目包：前端给齐 project_json / templates_json / 资产清单（src 绝对路径 + 相对路径 + 指纹）。
/// out_dir 由前端经系统目录选择器取得（用户显式选择，等价 §20.4 白名单根目录）。
#[tauri::command]
pub fn pack_export(
    out_dir: String,
    project_name: String,
    project_json: String,
    templates_json: Option<String>,
    assets: Vec<PackAssetEntry>,
    asset_sources: Vec<PackAssetSource>,
) -> Result<PackResult, String> {
    let root = PathBuf::from(&out_dir);
    if !root.is_absolute() {
        return Err("输出目录必须是绝对路径".into());
    }
    // 3.4：包目录固定带 .momoproject 后缀；同名目录只允许覆盖「合法 MOMO 项目包」
    //（必须含 project.momo.json 标记），其他同名目录绝不删除——自动改名新建，防止误删用户数据
    let base = sanitize(&project_name);
    let mut pack_dir = root.join(format!("{}.momoproject", base));
    if pack_dir.exists() {
        if pack_dir.join("project.momo.json").is_file() {
            fs::remove_dir_all(&pack_dir).map_err(|e| format!("旧项目包清理失败：{}", e))?;
        } else {
            let mut n = 1usize;
            loop {
                let alt = root.join(format!("{}-{}.momoproject", base, n));
                if !alt.exists() {
                    pack_dir = alt;
                    break;
                }
                n += 1;
            }
        }
    }
    let pack = pack_dir;
    fs::create_dir_all(pack.join("assets")).map_err(|e| format!("项目包创建失败：{}", e))?;

    fs::write(pack.join("project.momo.json"), project_json).map_err(|e| format!("写入项目数据失败：{}", e))?;
    if let Some(t) = &templates_json {
        fs::write(pack.join("templates.json"), t).map_err(|e| format!("写入模板快照失败：{}", e))?;
    }
    let mut copied = 1usize; // project.momo.json
    for s in &asset_sources {
        let dst = pack.join(&s.rel);
        copy_file(Path::new(&s.src), &dst)?;
        copied += 1;
    }
    let manifest = PackManifest {
        pack_version: 1,
        project_name: project_name.clone(),
        exported_at: ts(),
        assets,
        template_ids: vec![],
    };
    let manifest = extract_template_ids(manifest, templates_json.as_deref());
    fs::write(
        pack.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).map_err(|e| format!("清单序列化失败：{}", e))?,
    )
    .map_err(|e| format!("写入清单失败：{}", e))?;
    Ok(PackResult {
        dir: pack.to_string_lossy().into_owned(),
        file_count: copied,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackAssetSource {
    pub src: String,
    pub rel: String,
}

fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.');
    if cleaned.is_empty() {
        "未命名项目".to_string()
    } else {
        cleaned.to_string()
    }
}

/// 从模板快照 JSON 里抽 id 列表（导入端缺失报告用）
fn extract_template_ids(mut m: PackManifest, templates_json: Option<&str>) -> PackManifest {
    m.template_ids = templates_json
        .and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok())
        .and_then(|v| {
            v.as_array().map(|arr| {
                arr.iter()
                    .filter_map(|x| x.get("id").and_then(|i| i.as_str()).map(|s| s.to_string()))
                    .collect()
            })
        })
        .unwrap_or_default();
    m
}

/// 读取项目包（前端选目录后调用）：返回项目数据 + 模板快照 + 清单。
/// 逐项校验：缺 project.momo.json 报错；缺 manifest 时尽力重建（宽容旧包）。
#[tauri::command]
pub fn pack_import(dir: String) -> Result<ImportPack, String> {
    let root = PathBuf::from(&dir);
    if !root.is_absolute() {
        return Err("项目包路径必须是绝对路径".into());
    }
    let proj_path = root.join("project.momo.json");
    if !proj_path.is_file() {
        return Err("所选目录不是有效的 .momoproject（缺少 project.momo.json）".into());
    }
    let project_json = fs::read_to_string(&proj_path).map_err(|e| format!("读取项目数据失败：{}", e))?;
    let templates_json = match fs::read_to_string(root.join("templates.json")) {
        Ok(t) => Some(t),
        Err(_) => None,
    };
    let manifest = match fs::read_to_string(root.join("manifest.json")) {
        Ok(m) => serde_json::from_str(&m).map_err(|e| format!("清单解析失败：{}", e))?,
        Err(_) => PackManifest {
            pack_version: 0,
            project_name: "导入项目".into(),
            exported_at: 0,
            assets: vec![],
            template_ids: vec![],
        },
    };
    Ok(ImportPack {
        project_json,
        templates_json,
        manifest,
        dir: root.to_string_lossy().into_owned(),
    })
}

/// 把包内资产复制回本机资产目录（导入端对未命中本地指纹的资产调用）。
/// 返回 相对路径 → 本机新路径 的映射，前端据此重建资产表与重链接（§16.3）。
#[tauri::command]
pub fn pack_copy_assets(pack_dir: String, target_dir: String, rels: Vec<String>) -> Result<Vec<PackAssetCopy>, String> {
    let src_root = PathBuf::from(&pack_dir);
    let dst_root = PathBuf::from(&target_dir);
    if !src_root.is_absolute() || !dst_root.is_absolute() {
        return Err("路径必须是绝对路径".into());
    }
    let mut out = Vec::new();
    for rel in rels {
        // 防路径穿越：只接受 assets/ 下的相对路径
        let rel_path = PathBuf::from(&rel);
        if rel.contains("..") || rel_path.is_absolute() {
            return Err(format!("非法资产路径：{}", rel));
        }
        let src = src_root.join(&rel_path);
        let dst = dst_root.join(&rel_path);
        if !src.is_file() {
            out.push(PackAssetCopy {
                rel: rel.clone(),
                path: String::new(),
                ok: false,
            });
            continue;
        }
        copy_file(&src, &dst)?;
        out.push(PackAssetCopy {
            rel,
            path: dst.to_string_lossy().into_owned(),
            ok: true,
        });
    }
    Ok(out)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackAssetCopy {
    pub rel: String,
    pub path: String,
    pub ok: bool,
}

fn ts() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
