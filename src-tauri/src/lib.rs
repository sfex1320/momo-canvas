mod enhance2;
mod codex_bridge;
mod flat_art;
mod export;
mod face;
mod geom;
mod layer_export;
mod local_llm;
mod media_probe;
mod production_tools;
mod media_render;
mod media_extract;
mod model_cache;
mod project_pack;
mod sr;
mod vec;
mod vec_score;
mod dpapi;
mod shortcut;
mod sysmon;
mod eagle_bridge;
mod eagle_plugin_server;
mod comfy_sync;
mod comfy_bridge;

use tauri::ipc::Channel;

/// 本地超分（阶段一）：吃输入图字节 + 模型路径 + 配置，跑 DirectML 推理，原子写输出。
/// 进度经 on_event Channel 回前端；任务可被 enhance_cancel 取消（tile 粒度）。
#[tauri::command]
async fn enhance_upscale(
    task_id: String,
    input_bytes: Vec<u8>,
    out_path: String,
    model_path: String,
    config: sr::EnhanceConfig,
    on_event: Channel<sr::SrEvent>,
) -> Result<sr::EnhanceResult, String> {
    // 推理是 CPU+GPU 混合的同步阻塞活，放进 spawn_blocking 不阻塞 Tauri 主线程/异步运行时
    let res = tauri::async_runtime::spawn_blocking(move || {
        sr::run(
            &task_id,
            &input_bytes,
            &out_path,
            &model_path,
            &config,
            &on_event,
        )
    })
    .await
    .map_err(|e| format!("推理任务异常: {}", e))?;
    res
}

/// 取消某个进行中的超分任务（tile 之间生效）
#[tauri::command]
fn enhance_cancel(task_id: String) {
    sr::request_cancel(&task_id);
}

/// 图像转矢量（VTracer，本地 CPU）。位图 → 安全 SVG，写 out_path，回 SVG 文本 + 统计。
/// 批次5：多候选 + 质量档，进度经 on_event Channel 回前端（分析/候选 k/N/评分/后处理/完成）。
#[tauri::command]
async fn vectorize_image(
    task_id: String,
    input_bytes: Vec<u8>,
    reference_bytes: Option<Vec<u8>>,
    out_path: String,
    config: vec::VectorizeConfig,
    on_event: Channel<vec::VecEvent>,
) -> Result<vec::VectorizeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        vec::run(
            &task_id,
            &input_bytes,
            reference_bytes.as_deref(),
            &out_path,
            &config,
            &on_event,
        )
    })
    .await
    .map_err(|e| format!("矢量化任务异常: {}", e))?
}

/// 取消矢量化任务。VTracer 单个候选内部不可中断，在当前候选结束后、评分或下一候选前生效。
#[tauri::command]
fn vectorize_cancel(task_id: String) {
    vec::request_cancel(&task_id);
}

/// 探测本机是否安装 Illustrator / CorelDRAW（前端据此显隐 AI/CDR 导出按钮）
#[tauri::command]
fn vector_export_apps() -> export::AppsStatus {
    export::detect_apps()
}

/// SVG → 原生 .ai / .cdr（COM 自动化，spawn_blocking 不阻塞 UI；超时杀进程树）
#[tauri::command]
async fn vector_export(
    svg: String,
    format: String,
    out_path: String,
    w_mm: f64,
    h_mm: f64,
) -> Result<export::ExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || export::run(&svg, &format, &out_path, w_mm, h_mm))
        .await
        .map_err(|e| format!("导出任务异常: {}", e))?
}

#[tauri::command]
async fn layer_export_tiff(
    layers: Vec<layer_export::LayerFileInput>,
    out_path: String,
    dpi: u32,
) -> Result<layer_export::LayerExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || layer_export::export_tiff(&layers, &out_path, dpi))
        .await
        .map_err(|e| format!("分层 TIFF 任务异常：{}", e))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        // 记住窗口大小/位置/最大化状态，下次启动自动恢复
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // 资产原生拖出（拖到资源管理器/第三方软件）
        .plugin(tauri_plugin_drag::init())
        // 自动更新（安装版）+ 进程重启
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // 系统资源监控（CPU/内存/GPU/显存），画布右上角仪表盘轮询
        .manage(sysmon::SysmonState::new())
        // 本地桥前端事件需要主窗口句柄
        .setup(|app| {
            let _ = eagle_plugin_server::APP_HANDLE.set(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            codex_bridge::codex_bridge_status,
            codex_bridge::codex_bridge_generate,
            codex_bridge::codex_bridge_text,
            codex_bridge::codex_bridge_cancel,
            production_tools::production_detect,
            production_tools::production_run,
            production_tools::production_cancel,
            enhance_upscale,
            enhance_cancel,
            vectorize_image,
            vectorize_cancel,
            vector_export_apps,
            vector_export,
            layer_export_tiff,
            // 本地 GGUF 推理引擎（llama-server）受控子进程管理
            local_llm::detect_llama_server,
            local_llm::set_llama_server_path,
            local_llm::start_local_llm,
            local_llm::stop_local_llm,
            local_llm::get_local_llm_status,
            local_llm::get_local_llm_logs,
            // API Key 落盘加密（DPAPI，绑定当前 Windows 用户）
            dpapi::dpapi_encrypt,
            dpapi::dpapi_decrypt,
            // 便携版首次启动创建桌面快捷方式
            shortcut::create_desktop_shortcut,
            // 系统资源监控（画布仪表盘）
            sysmon::system_stats,
            // Eagle 资产桥：流式复制/指纹 + 插件环回桥
            eagle_bridge::eagle_file_fingerprint,
            eagle_bridge::eagle_copy_into_assets,
            eagle_bridge::eagle_locate_item_file,
            eagle_plugin_server::eagle_bridge_start,
            eagle_plugin_server::eagle_bridge_stop,
            eagle_plugin_server::eagle_plugin_dir,
            // 导演台 2.0：媒体探测/正式渲染（外部 ffmpeg）/可移植项目包
            media_probe::media_locate,
            media_probe::media_probe,
            media_render::media_render,
            media_render::media_render_cancel,
            // 导演台 3.0：媒体提取（22 帧微参考/稳定尾帧/缩略图/裁剪，方案 §9.2）
            media_extract::extract_micro_reference,
            media_extract::extract_bridge_frame,
            media_extract::extract_thumbnail,
            media_extract::trim_media,
            project_pack::pack_export,
            project_pack::pack_import,
            project_pack::pack_copy_assets,
            // Comfy 工作流无感同步：扫描/监听/哈希/探测/正文与版本存储（规格 §4.2）
            comfy_sync::comfy_sync_scan,
            comfy_sync::comfy_sync_hash_file,
            comfy_sync::comfy_sync_read_file,
            comfy_sync::comfy_sync_detect_dirs,
            comfy_sync::comfy_sync_path_kind,
            comfy_sync::comfy_sync_watch,
            comfy_sync::comfy_sync_unwatch,
            comfy_sync::comfy_sync_write_workflow,
            comfy_sync::comfy_sync_read_workflow,
            comfy_sync::comfy_sync_write_revision,
            comfy_sync::comfy_sync_list_revisions,
            comfy_sync::comfy_sync_read_revision,
            comfy_sync::comfy_sync_delete_revisions,
            comfy_sync::comfy_sync_delete_workflow,
            // M2 双向写回：原子替换源文件（授权根目录校验在命令内）
            comfy_sync::comfy_sync_write_source,
            // M3 同步桥：ComfyUI 前端扩展（保存即时通知 / 在 ComfyUI 中打开）的本地服务与一键安装
            comfy_bridge::comfy_bridge_start,
            comfy_bridge::comfy_bridge_stop,
            comfy_bridge::comfy_bridge_set_pending_open,
            comfy_bridge::comfy_bridge_install
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        // 应用退出时停掉所有 MOMO 自己启动的 llama-server（不影响用户外部启动的）
        // ExitRequested：窗口请求关闭时；Exit：应用真正退出时（含 app.exit / 系统关机）
        // 两个都处理，确保任何退出路径都清理子进程
        match event {
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                local_llm::stop_all();
                codex_bridge::stop_all();
                eagle_plugin_server::cleanup_on_exit(&_app_handle);
                comfy_bridge::cleanup_on_exit();
            }
            _ => {}
        }
    });
}
