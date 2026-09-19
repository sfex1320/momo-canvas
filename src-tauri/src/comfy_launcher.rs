//! 有界、只读的本机启动器发现；不执行脚本，不遍历模型或 Python 环境。
use std::{fs, io::Read, path::Path};
use serde::Serialize;
use tauri::Manager;

#[derive(Debug, Serialize)]
pub struct Launcher {
    path: String,
    name: String,
    reason: String,
    port: Option<u16>,
    #[serde(rename = "directRoot")]
    direct_root: Option<String>,
}

fn shell_path(path: &Path) -> String {
    let raw=path.to_string_lossy();
    if let Some(unc)=raw.strip_prefix(r"\\?\UNC\") {format!(r"\\{unc}")}
    else {raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_owned()}
}

fn direct_runtime(root: &Path) -> Option<(std::path::PathBuf,std::path::PathBuf)> {
    let main=if root.join("ComfyUI/main.py").is_file(){root.join("ComfyUI/main.py")}else{root.join("main.py")};
    if !main.is_file(){return None;}
    ["python/python.exe","python_embeded/python.exe",".venv/Scripts/python.exe","venv/Scripts/python.exe","ComfyUI/.venv/Scripts/python.exe"]
        .into_iter().map(|p|root.join(p)).find(|p|p.is_file()).map(|python|(python,main))
}

fn configured_port(root: &Path) -> u16 {
    fs::read(root.join(".launcher/preference.json")).ok()
        .and_then(|b|serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|j|j["args"]["port"].as_u64()).and_then(|p|u16::try_from(p).ok()).filter(|p|*p>0).unwrap_or(8188)
}

fn script_info(path: &Path) -> Option<(String, Option<u16>)> {
    let mut bytes = Vec::new();
    fs::File::open(path).ok()?.take(64 * 1024).read_to_end(&mut bytes).ok()?;
    let text = if bytes.starts_with(&[0xff, 0xfe]) {
        String::from_utf16_lossy(&bytes[2..].chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect::<Vec<_>>())
    } else { String::from_utf8_lossy(&bytes).into_owned() }.to_lowercase();
    let line = text.lines().find(|line| {
        let line = line.trim_start().trim_start_matches('@');
        !line.starts_with("rem ") && !line.starts_with("::") && !line.starts_with("echo ")
            && line.contains("main.py") && (line.contains("python") || line.contains("uv run"))
    })?;
    let port = line.split_once("--port").and_then(|(_, rest)| {
        let value = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '=');
        value.split(|c: char| !c.is_ascii_digit()).next()?.parse::<u16>().ok().filter(|p| *p > 0)
    });
    Some(("脚本直接启动 ComfyUI".into(), port))
}

fn scan_dir(dir: &Path, out: &mut Vec<Launcher>) -> Result<(), String> {
    if let Some((_,main))=direct_runtime(dir){
        out.push(Launcher{path:shell_path(&main),name:"直接启动 ComfyUI（完整节点）".into(),reason:"使用便携包自带 Python，无需操作启动器".into(),port:Some(configured_port(dir)),direct_root:Some(shell_path(dir))});
    }
    let entries = fs::read_dir(dir).map_err(|e| format!("无法读取 ComfyUI 目录：{e}"))?;
    for entry in entries.take(2048).flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) { continue; }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let lower = name.to_lowercase();
        if ["update", "install", "uninstall", "更新", "安装", "修复", "卸载"].iter().any(|s| lower.contains(s)) { continue; }
        let ext = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
        let info = match ext.as_str() {
            "exe" | "lnk" if lower.contains("绘世") || lower.contains("comfyui") => Some(("ComfyUI 软件启动器".into(), None)),
            "bat" | "cmd" => script_info(&path).or_else(|| {
                let stem = path.file_stem()?.to_string_lossy().to_lowercase();
                let known = ["run_nvidia_gpu", "run_cpu", "run_amd_gpu", "run_intel_gpu", "run_nvidia_gpu_fast_fp16_accumulation"].contains(&stem.as_str());
                (known && (dir.join("ComfyUI/main.py").is_file() || dir.join("main.py").is_file()))
                    .then(|| ("便携版启动脚本".into(), None))
            }),
            _ => None,
        };
        if let Some((reason, port)) = info {
            // Windows Shell 启动不使用 canonicalize 产生的扩展路径前缀。
            let raw = path.to_string_lossy();
            let path = if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") { format!(r"\\{unc}") }
                else { raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_owned() };
            out.push(Launcher { path, name, reason, port, direct_root:None });
        }
    }
    Ok(())
}

fn discover(root: &Path) -> Result<Vec<Launcher>, String> {
    let root = root.canonicalize().map_err(|_| "目录不存在或当前不可访问")?;
    if !root.is_dir() { return Err("请选择 ComfyUI 文件夹".into()); }
    let mut out = Vec::new();
    scan_dir(&root, &mut out)?;
    // 用户常选到整合包内的源码目录，启动器实际位于它的上一层。
    if root.file_name().map(|n| n.to_string_lossy().eq_ignore_ascii_case("ComfyUI")).unwrap_or(false)
        && root.join("main.py").is_file() {
        if let Some(parent) = root.parent() { let _ = scan_dir(parent, &mut out); }
    }
    // 仅深入两层 ComfyUI 安装目录，不扫描任意子目录或符号链接。
    let mut dirs = vec![root];
    for _ in 0..2 {
        let mut next = Vec::new();
        for dir in dirs {
            for entry in fs::read_dir(&dir).into_iter().flatten().take(2048).flatten() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if entry.file_type().map(|t| t.is_dir() && !t.is_symlink()).unwrap_or(false)
                    && (name.starts_with("comfyui") || name == ".launcher") {
                    let child = entry.path();
                    if !child.canonicalize().map(|p| p.starts_with(&dir)).unwrap_or(false) { continue; }
                    let _ = scan_dir(&child, &mut out);
                    next.push(child);
                }
            }
        }
        dirs = next;
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out.dedup_by(|a, b| a.path.eq_ignore_ascii_case(&b.path));
    Ok(out)
}

#[tauri::command]
pub async fn comfy_launcher_discover(directory: String) -> Result<Vec<Launcher>, String> {
    tauri::async_runtime::spawn_blocking(move || discover(Path::new(&directory))).await.map_err(|e| e.to_string())?
}

static DIRECT_CHILDREN: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String,std::process::Child>>> = std::sync::OnceLock::new();

fn start_direct(root: &Path, port:u16, log:&Path) -> Result<u32,String> {
    use std::process::{Command,Stdio};
    let root=root.canonicalize().map_err(|_|"ComfyUI 目录不可访问")?;
    let key=shell_path(&root);
    let mut children=DIRECT_CHILDREN.get_or_init(Default::default).lock().map_err(|_|"启动状态不可用")?;
    if let Some(child)=children.get_mut(&key){if child.try_wait().map_err(|e|e.to_string())?.is_none(){return Ok(child.id());}}
    let (python,main)=direct_runtime(&root).ok_or("没有找到可直接启动的 Python 环境和 ComfyUI/main.py")?;
    if port==0{return Err("服务端口无效".into());}
    let output=fs::File::create(log).map_err(|e|format!("无法创建启动日志：{e}"))?;
    let mut command=Command::new(python);
    command.current_dir(main.parent().unwrap()).args(["-u",&shell_path(&main),"--port",&port.to_string(),"--disable-auto-launch"])
        .stdin(Stdio::null()).stdout(output.try_clone().map_err(|e|e.to_string())?).stderr(output);
    #[cfg(windows)] {use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
    let child=command.spawn().map_err(|e|format!("ComfyUI 启动失败：{e}"))?;
    let id=child.id();children.insert(key,child);Ok(id)
}

#[tauri::command]
pub async fn comfy_launch_direct(app:tauri::AppHandle,directory:String,port:u16)->Result<String,String>{
    let dir=app.path().app_data_dir().map_err(|e|e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e|e.to_string())?;
    let log=dir.join("comfy-startup.log");
    tauri::async_runtime::spawn_blocking(move||{start_direct(Path::new(&directory),port,&log)?;Ok(shell_path(&log))}).await.map_err(|e|e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn direct_start_reaches_service_when_requested() {
        use std::io::Write;
        let Ok(directory)=std::env::var("MOMO_COMFY_START_CHECK") else{return;};
        let root=Path::new(&directory);
        let addr="127.0.0.1:8910".parse().unwrap();
        assert!(std::net::TcpStream::connect_timeout(&addr,std::time::Duration::from_millis(200)).is_err(),"验收端口已占用，不启动另一个实例");
        let log=std::env::temp_dir().join("momo-comfy-direct-check.log");
        let id=start_direct(root,8910,&log).unwrap();
        let started=std::time::Instant::now();
        let mut ready=false;
        while started.elapsed().as_secs()<180 {
            if let Ok(mut stream)=std::net::TcpStream::connect_timeout(&addr,std::time::Duration::from_millis(500)){
                let _=stream.set_read_timeout(Some(std::time::Duration::from_secs(3)));
                let _=stream.write_all(b"GET /system_stats HTTP/1.0\r\nHost: localhost\r\n\r\n");
                let mut text=String::new();let _=stream.read_to_string(&mut text);
                if text.contains("200 OK")&&text.contains("system"){ready=true;break;}
            }
            let mut children=DIRECT_CHILDREN.get().unwrap().lock().unwrap();
            if children.values_mut().find(|c|c.id()==id).unwrap().try_wait().unwrap().is_some(){break;}
            drop(children);
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
        // 只结束本测试创建的实例，正常桌面服务不受影响。
        if let Some(child)=DIRECT_CHILDREN.get().unwrap().lock().unwrap().values_mut().find(|c|c.id()==id){let _=child.kill();let _=child.wait();}
        println!("直启验收：ready={ready}，耗时={} 秒，日志={}",started.elapsed().as_secs(),log.display());
        assert!(ready,"完整 ComfyUI 未就绪，请检查验收日志");
    }
    #[test]
    fn discovery_handles_bundle_parent_ports_and_excludes_maintenance() {
        let root = std::env::temp_dir().join(format!("momo-comfy-discovery-{}", std::process::id()));
        fs::create_dir_all(root.join("ComfyUI/models")).unwrap();
        let files = [
            ("ComfyUI/main.py", ""), ("绘世启动器.exe", ""),
            ("启动 H3.cmd", "@echo off\npython ComfyUI/main.py --port 8909"),
            ("run_cpu.bat", "python ComfyUI/main.py --cpu"),
            ("update.cmd", "python ComfyUI/main.py"), ("python.exe", ""),
            ("ComfyUI/models/comfyui.exe", ""), ("说明.cmd", "rem python main.py\necho python main.py"),
        ];
        for (name, text) in files { fs::write(root.join(name), text).unwrap(); }
        let result = discover(&root).unwrap();
        assert_eq!(result.len(), 3);
        assert!(result.iter().all(|r| !r.path.starts_with(r"\\?\")));
        assert_eq!(result.iter().find(|r| r.name == "启动 H3.cmd").unwrap().port, Some(8909));
        assert_eq!(discover(&root.join("ComfyUI")).unwrap().len(), 3);
        assert!(discover(&root.join("missing")).is_err());
        for (name, _) in files { fs::remove_file(root.join(name)).unwrap(); }
        fs::remove_dir(root.join("ComfyUI/models")).unwrap();
        fs::remove_dir(root.join("ComfyUI")).unwrap();
        assert!(discover(&root).unwrap().is_empty());
        let portable = root.join("ComfyUI_windows_portable");
        fs::create_dir(&portable).unwrap();
        let encoded = [0xff, 0xfe].into_iter().chain("python ComfyUI/main.py --port=8199".encode_utf16().flat_map(u16::to_le_bytes)).collect::<Vec<_>>();
        fs::write(portable.join("启动.cmd"), encoded).unwrap();
        let single = discover(&root).unwrap();
        assert_eq!(single.len(), 1);
        assert_eq!(single[0].port, Some(8199));
        fs::remove_file(portable.join("启动.cmd")).unwrap();
        fs::remove_dir(portable).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn inspect_directory_from_environment_without_launching() {
        if let Ok(root) = std::env::var("MOMO_COMFY_DISCOVERY_DIR") {
            let result = discover(Path::new(&root)).unwrap();
            println!("{}", serde_json::to_string_pretty(&result).unwrap());
            assert!(!result.is_empty());
        }
    }
}
