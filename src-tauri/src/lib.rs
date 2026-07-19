#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
