//! 桌面快捷方式同步（便携版每次启动时由前端调用）。
//!
//! 实现方式：Windows COM IShellLink + IPersistFile 直接生成 .lnk 文件，
//! 不经过 PowerShell / cmd（符合本项目「不通过 shell 字符串执行命令」的安全约定）。
//! 桌面路径用 SHGetKnownFolderPath(FOLDERID_Desktop) 获取，
//! 可正确处理 OneDrive 桌面重定向等非默认桌面位置。
//!
//! 目标固定为当前运行的 exe（便携版主程序），工作目录 = exe 所在目录
//! （便携版必须保证 models/ 相对路径可用）。

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutResult {
    /// 本次是否创建了原本不存在的快捷方式
    pub created: bool,
    /// 本次是否把同名旧快捷方式改为指向当前便携程序
    pub updated: bool,
    /// 快捷方式完整路径
    pub path: String,
}

/// 创建或更新指向当前 exe 的桌面快捷方式。仅 Windows；其他平台返回中文错误。
#[tauri::command]
pub fn create_desktop_shortcut(name: String) -> Result<ShortcutResult, String> {
    #[cfg(windows)]
    {
        create_shortcut_win(&name)
    }
    #[cfg(not(windows))]
    {
        let _ = name;
        Err("桌面快捷方式仅支持 Windows 平台".into())
    }
}

#[cfg(windows)]
fn create_shortcut_win(name: &str) -> Result<ShortcutResult, String> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_Desktop, SHGetKnownFolderPath};

    // 名称去非法字符（文件名不允许的字符替换掉），防止用户可见名写出非法 .lnk 文件名
    let safe_name: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            _ => c,
        })
        .collect();
    let safe_name = if safe_name.trim().is_empty() {
        "MOMO".to_string()
    } else {
        safe_name
    };

    let exe = std::env::current_exe().map_err(|e| format!("获取程序路径失败：{e}"))?;
    unsafe {
        // 拿真实桌面目录（含 OneDrive 重定向）
        let desktop_pw = SHGetKnownFolderPath(&FOLDERID_Desktop, Default::default(), None)
            .map_err(|e| format!("获取桌面路径失败：{e}"))?;
        let desktop = PCWSTR(desktop_pw.0).to_string();
        CoTaskMemFree(Some(desktop_pw.0 as _));
        let desktop = desktop.map_err(|e| format!("桌面路径转换失败：{e}"))?;
        let lnk_path = std::path::Path::new(&desktop).join(format!("{safe_name}.lnk"));
        sync_shortcut_file(&lnk_path, &exe)
    }
}

/// 把文件同步与桌面定位分开，回归测试只操作临时 .lnk，不修改用户桌面。
#[cfg(windows)]
fn sync_shortcut_file(
    lnk_path: &std::path::Path,
    exe: &std::path::Path,
) -> Result<ShortcutResult, String> {
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    // 保证所有提前返回（含写入失败）都释放 COM；接口对象先于此守卫析构。
    struct ComGuard;
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    let work_dir = exe
        .parent()
        .ok_or("无法确定程序所在目录")?
        .to_string_lossy();
    let exe_text = exe.to_string_lossy();
    let lnk_text = lnk_path.to_string_lossy().into_owned();
    let existed = lnk_path.exists();
    let lnk_w = to_wide(&lnk_text);
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| format!("COM 初始化失败：{e}"))?;
        let _guard = ComGuard;

        if existed {
            let old: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("读取快捷方式失败：{e}"))?;
            let old_file = old.cast::<IPersistFile>().map_err(|e| e.to_string())?;
            let mut old_target = vec![0u16; 32768];
            let mut old_dir = vec![0u16; 32768];
            // 只有目标与工作目录都仍指向当前程序才跳过；旧路径或损坏的 .lnk 一律重写。
            if old_file.Load(PCWSTR(lnk_w.as_ptr()), STGM_READ).is_ok()
                && old
                    .GetPath(&mut old_target, std::ptr::null_mut(), 0)
                    .is_ok()
                && old.GetWorkingDirectory(&mut old_dir).is_ok()
                && same_windows_path(&from_wide(&old_target), &exe_text)
                && same_windows_path(&from_wide(&old_dir), &work_dir)
            {
                return Ok(ShortcutResult {
                    created: false,
                    updated: false,
                    path: lnk_text,
                });
            }
        }

        let exe_w = to_wide(&exe_text);
        let dir_w = to_wide(&work_dir);
        let desc_w = to_wide("MOMO 智能画布（便携版）");

        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("创建 COM 对象失败：{e}"))?;
        link.SetPath(PCWSTR(exe_w.as_ptr()))
            .map_err(|e| format!("设置目标失败：{e}"))?;
        link.SetWorkingDirectory(PCWSTR(dir_w.as_ptr()))
            .map_err(|e| format!("设置工作目录失败：{e}"))?;
        link.SetDescription(PCWSTR(desc_w.as_ptr()))
            .map_err(|e| format!("设置描述失败：{e}"))?;
        link.SetIconLocation(PCWSTR(exe_w.as_ptr()), 0)
            .map_err(|e| format!("设置快捷方式图标失败：{e}"))?;
        let _ = link.SetShowCmd(SW_SHOWNORMAL);

        // IShellLinkW → IPersistFile 接口转换后落盘为 .lnk
        let persist = link
            .cast::<IPersistFile>()
            .map_err(|e| format!("转换持久化接口失败：{e}"))?;
        persist
            .Save(PCWSTR(lnk_w.as_ptr()), true)
            .map_err(|e| format!("写入快捷方式失败：{e}（桌面可能被安全软件拦截）"))?;

        Ok(ShortcutResult {
            created: !existed,
            updated: existed,
            path: lnk_text,
        })
    }
}

/// &str → 以 NUL 结尾的 UTF-16（COM PCWSTR 需要）
#[cfg(windows)]
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn from_wide(s: &[u16]) -> String {
    String::from_utf16_lossy(&s[..s.iter().position(|c| *c == 0).unwrap_or(s.len())])
}

#[cfg(windows)]
fn same_windows_path(a: &str, b: &str) -> bool {
    a.replace('/', "\\").trim_end_matches('\\').to_lowercase()
        == b.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn shortcut_creates_updates_and_stays_idempotent() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("momo-shortcut-test-{}-{stamp}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let link = dir.join("MOMO 智能画布.lnk");
        let old_exe = dir.join("旧便携包").join("MOMO-Canvas.exe");
        let new_exe = dir.join("新便携包").join("MOMO-Canvas.exe");
        let first = sync_shortcut_file(&link, &old_exe).unwrap();
        assert!(first.created && !first.updated, "首次启动应创建快捷方式");
        let unchanged = sync_shortcut_file(&link, &old_exe).unwrap();
        assert!(
            !unchanged.created && !unchanged.updated,
            "同一路径启动应保持不变"
        );
        let moved = sync_shortcut_file(&link, &new_exe).unwrap();
        assert!(
            !moved.created && moved.updated,
            "新便携目录应覆盖同名旧快捷方式"
        );
        let verified = sync_shortcut_file(&link, &new_exe).unwrap();
        assert!(
            !verified.created && !verified.updated,
            "重读应验证目标已指向新路径"
        );
        std::fs::remove_file(&link).unwrap();
        std::fs::remove_dir(&dir).unwrap();
    }
}
