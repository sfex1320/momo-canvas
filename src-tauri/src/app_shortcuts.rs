//! 外部软件启动与系统快捷方式元数据。路径始终作为参数，绝不拼接进脚本。
use std::{path::Path, process::{Command, Stdio}};
use serde_json::Value;
use base64::{engine::general_purpose::STANDARD, Engine};
use tauri::Manager;

fn inspect(path: &str, name: &str) -> Result<Value, String> {
    // Windows Shell 解析开始菜单链接（含参数、工作目录）；图标由系统提取。
    let script = r#"
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
$p=$env:MOMO_SHORTCUT_PATH
if (!$p) {
 $roots=@([Environment]::GetFolderPath('StartMenu'),[Environment]::GetFolderPath('CommonStartMenu'),[Environment]::GetFolderPath('Desktop'))
 $links=@($roots | ForEach-Object {Get-ChildItem -LiteralPath $_ -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue})
 $hits=@($links | Where-Object {$_.Name -eq $env:MOMO_SHORTCUT_NAME -or $_.BaseName -eq [IO.Path]::GetFileNameWithoutExtension($env:MOMO_SHORTCUT_NAME)})
 if (!$hits.Count) {$shell=New-Object -ComObject WScript.Shell; $hits=@($links | Where-Object {try {[IO.Path]::GetFileName($shell.CreateShortcut($_.FullName).TargetPath) -eq $env:MOMO_SHORTCUT_NAME} catch {$false}})}
 if ($hits.Count -ne 1) {throw '无法唯一定位软件，请用选择按钮指定启动文件'}
 $p=$hits[0].FullName
}

if (!(Test-Path -LiteralPath $p)) {throw '启动文件已移动或不存在'}
$target=$p
if ([IO.Path]::GetExtension($p) -eq '.lnk') {$link=(New-Object -ComObject WScript.Shell).CreateShortcut($p); if ($link.TargetPath) {$target=$link.TargetPath}}
$icon=$null
try {Add-Type -AssemblyName System.Drawing; $ico=[Drawing.Icon]::ExtractAssociatedIcon($target); if ($ico) {$bmp=$ico.ToBitmap(); $ms=[IO.MemoryStream]::new(); $bmp.Save($ms,[Drawing.Imaging.ImageFormat]::Png); $icon='data:image/png;base64,'+[Convert]::ToBase64String($ms.ToArray()); $ms.Dispose(); $bmp.Dispose(); $ico.Dispose()}} catch {}
$folder=Test-Path -LiteralPath $target -PathType Container
@{path=$(if($folder){$target}else{$p}); name=[IO.Path]::GetFileNameWithoutExtension($p); kind=$(if ($folder) {'folder'} else {'app'}); icon=$icon; target=$target; arguments=$(if($link){$link.Arguments}else{''}); workdir=$(if($link){$link.WorkingDirectory}else{[IO.Path]::GetDirectoryName($p)})} | ConvertTo-Json -Compress
"#;
    let encoded = STANDARD.encode(script.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>());
    let mut cmd = Command::new("powershell.exe");
    #[cfg(windows)] { use std::os::windows::process::CommandExt; cmd.creation_flags(0x08000000); }
    let mut child = cmd.args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
        .env("MOMO_SHORTCUT_PATH", path).env("MOMO_SHORTCUT_NAME", name).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e|e.to_string())?;
    // 并行排空管道：高分辨率图标的 Base64 可能超过 Windows 管道容量。
    let stdout=child.stdout.take().ok_or("无法读取软件信息输出")?;
    let stderr=child.stderr.take().ok_or("无法读取软件信息错误输出")?;
    let reader=std::thread::spawn(move || {use std::io::Read;let mut bytes=Vec::new();let mut pipe=stdout;pipe.read_to_end(&mut bytes).map(|_|bytes)});
    let errors=std::thread::spawn(move || {use std::io::Read;let mut pipe=stderr;let mut discard=Vec::new();let _=pipe.read_to_end(&mut discard);});
    let started=std::time::Instant::now();
    loop {
        if child.try_wait().map_err(|e|e.to_string())?.is_some(){break;}
        if started.elapsed()>std::time::Duration::from_secs(20){let _=child.kill();let _=child.wait();return Err("软件信息读取超时，请检查路径是否在线".into());}
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    let status=child.wait().map_err(|e|e.to_string())?;
    let out=reader.join().map_err(|_|"读取软件信息失败")?.map_err(|e|e.to_string())?;
    let _=errors.join();
    if !status.success() {return Err("无法读取软件位置，请选择有效的启动文件或开始菜单快捷方式".into());}
    serde_json::from_slice(&out).map_err(|_|"软件信息读取失败".into())
}

#[tauri::command]
pub async fn shortcut_inspect(app: tauri::AppHandle, path: Option<String>, name: Option<String>, bytes: Option<Vec<u8>>) -> Result<Value,String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut path=path.unwrap_or_default();
        let name=name.unwrap_or_default();
        if let Some(bytes)=bytes {
            if bytes.len()<76 || bytes.len()>1024*1024 || bytes[..4]!=[76,0,0,0] {return Err("快捷方式格式无效".into());}
            use sha2::{Digest,Sha256};
            let dir=app.path().app_data_dir().map_err(|e|e.to_string())?.join("shortcuts");
            std::fs::create_dir_all(&dir).map_err(|e|e.to_string())?;
            let file=dir.join(format!("{:x}.lnk",Sha256::digest(&bytes)));
            std::fs::write(&file,bytes).map_err(|e|e.to_string())?;
            path=file.to_string_lossy().into_owned();
        }
        let mut result=inspect(&path,&name)?;
        if !name.is_empty() {result["name"]=Value::String(Path::new(&name).file_stem().unwrap_or_default().to_string_lossy().into_owned());}
        Ok(result)
    }).await.map_err(|e|e.to_string())?
}

#[tauri::command]
pub async fn shortcut_launch(path: String, asset: Option<String>) -> Result<(),String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p=Path::new(&path);
        if !p.is_file() {return Err("启动文件不存在，请重新绑定软件路径".into());}
        let ext=p.extension().unwrap_or_default().to_string_lossy().to_lowercase();
        if !["exe","lnk","bat","cmd","appref-ms"].contains(&ext.as_str()) {return Err("请选择软件启动文件".into());}
        if let Some(a)=&asset {if !Path::new(a).is_file() || a.contains(['\"','\0']) {return Err("素材路径无效或文件不存在".into());}}
        #[cfg(windows)] unsafe {
            use windows::{core::PCWSTR, Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL}};
            let wide=|s:&str|s.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
            let meta=if ext=="lnk" && asset.is_some(){Some(inspect(&path,"")?)}else{None};
            let target=meta.as_ref().and_then(|m|m["target"].as_str()).unwrap_or(&path);
            if meta.is_some() && !Path::new(target).is_file(){return Err("该快捷方式无法直接接收素材，请选择软件 exe 文件".into());}
            let arguments=meta.as_ref().and_then(|m|m["arguments"].as_str()).unwrap_or("");
            let working=meta.as_ref().and_then(|m|m["workdir"].as_str()).filter(|s|!s.is_empty()).map(String::from).unwrap_or_else(||p.parent().unwrap_or(Path::new(".")).to_string_lossy().into_owned());
            let file=wide(target); let verb=wide("open");
            let params=wide(&format!("{} {}",arguments,asset.map(|a|format!("\"{a}\"")).unwrap_or_default()));
            let dir=wide(&working);
            let r=ShellExecuteW(None,PCWSTR(verb.as_ptr()),PCWSTR(file.as_ptr()),PCWSTR(params.as_ptr()),PCWSTR(dir.as_ptr()),SW_SHOWNORMAL);
            if r.0 as isize <=32 {return Err(format!("系统无法启动软件（错误 {}），请检查路径或软件关联",r.0 as isize));}
        }
        Ok(())
    }).await.map_err(|e|e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shortcut_preserves_unicode_path_arguments_and_workdir() {
        use windows::core::{Interface,PCWSTR};
        use windows::Win32::System::Com::{CoCreateInstance,CoInitializeEx,CoUninitialize,IPersistFile,CLSCTX_INPROC_SERVER,COINIT_APARTMENTTHREADED};
        use windows::Win32::UI::Shell::{IShellLinkW,ShellLink};
        let root=std::env::temp_dir().join(format!("momo-shortcut-qa-{}",std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path=root.join("中文 软件启动.lnk");
        let exe=Path::new(&std::env::var("WINDIR").unwrap()).join("System32/notepad.exe");
        let args="\"中文 素材.png\"";
        let wide=|s:&str|s.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        unsafe {
            CoInitializeEx(None,COINIT_APARTMENTTHREADED).ok().unwrap();
            {
                let link:IShellLinkW=CoCreateInstance(&ShellLink,None,CLSCTX_INPROC_SERVER).unwrap();
                link.SetPath(PCWSTR(wide(&exe.to_string_lossy()).as_ptr())).unwrap();
                link.SetArguments(PCWSTR(wide(args).as_ptr())).unwrap();
                link.SetWorkingDirectory(PCWSTR(wide(&root.to_string_lossy()).as_ptr())).unwrap();
                link.cast::<IPersistFile>().unwrap().Save(PCWSTR(wide(&path.to_string_lossy()).as_ptr()),true).unwrap();
            }
            CoUninitialize();
        }
        let meta=inspect(&path.to_string_lossy(),"").unwrap();
        assert_eq!(meta["arguments"],args);
        assert_eq!(meta["workdir"],root.to_string_lossy().as_ref());
        assert!(meta["target"].as_str().unwrap().to_lowercase().ends_with("notepad.exe"));
        assert!(meta["icon"].as_str().unwrap().starts_with("data:image/png;base64,"));
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
    #[test]
    fn system_program_icon_and_missing_path() {
        let dir=std::env::var("WINDIR").unwrap_or_else(|_|"C:\\Windows".into());
        let path=Path::new(&dir).join("System32").join("notepad.exe");
        let result=inspect(&path.to_string_lossy(),"").unwrap();
        assert_eq!(result["kind"],"app");
        assert!(result["icon"].as_str().unwrap().starts_with("data:image/png;base64,"));
        assert!(inspect("Z:\\不存在的测试文件夹\\软件.exe","").is_err());
    }
}
