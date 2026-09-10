//! 本地分割与 ICC 印刷导出。固定脚本、JSON 标准输入、限时和取消，禁止命令拼接。
use serde_json::Value;
use std::{collections::HashMap, io::{Read,Write}, path::PathBuf, process::{Command,Stdio}, sync::{Mutex,OnceLock,Arc,atomic::{AtomicBool,Ordering}}, time::{Duration,Instant}};
fn tasks()-> &'static Mutex<HashMap<String,Arc<AtomicBool>>> { static T:OnceLock<Mutex<HashMap<String,Arc<AtomicBool>>>>=OnceLock::new();T.get_or_init(||Mutex::new(HashMap::new())) }
#[tauri::command]
pub fn production_cancel(task_id:String) { if let Some(flag)=tasks().lock().unwrap().get(&task_id){flag.store(true,Ordering::SeqCst);} }
#[tauri::command]
pub fn production_detect(roots:Vec<String>)->Vec<String> {
    let mut found=Vec::new();
    for root in roots { let p=PathBuf::from(root);for ancestor in p.ancestors().take(7) {for rel in ["tools/jianying/Scripts/python.exe","python/python.exe","python_embeded/python.exe",".venv/Scripts/python.exe"]{let exe=ancestor.join(rel);if exe.is_file(){let path=exe.to_string_lossy().into_owned();if !found.contains(&path){found.push(path);}}}}}
    found
}
#[tauri::command]
pub async fn production_run(task_id:String,python_path:String,request:Value)->Result<Value,String> {
    if !PathBuf::from(&python_path).is_absolute()||!PathBuf::from(&python_path).is_file(){return Err("请在设计工具中选择有效的 Python 环境（需要 Pillow 与 OpenCV）".into());}
    if !matches!(request.get("op").and_then(Value::as_str),Some("probe"|"segment"|"semantic"|"cmyk"|"video_info"|"lossless"|"jianying")){return Err("未知生产操作".into());}
    let flag=Arc::new(AtomicBool::new(false));
    {let mut map=tasks().lock().unwrap();if map.contains_key(&task_id){return Err("此任务正在执行".into());}map.insert(task_id.clone(),flag.clone());}
    let result=tauri::async_runtime::spawn_blocking(move||run_python(&python_path,request,&flag)).await.map_err(|e|format!("生产任务异常：{e}"));
    tasks().lock().unwrap().remove(&task_id); result?
}
fn stop_tree(child:&mut std::process::Child){
    #[cfg(windows)] {use std::os::windows::process::CommandExt;
      let system=std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(||PathBuf::from("C:\\Windows"));
      let _=Command::new(system.join("System32/taskkill.exe")).args(["/PID",&child.id().to_string(),"/T","/F"]).creation_flags(0x08000000).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    let _=child.kill();let _=child.wait();
}
// 只清理本任务亲自新建的目录，取消时不会留下 FFmpeg 大型中间文件。
struct Scratch(PathBuf);
impl Drop for Scratch {fn drop(&mut self){let _=std::fs::remove_dir_all(&self.0);}}
fn run_python(path:&str,mut request:Value,flag:&AtomicBool)->Result<Value,String>{
    if flag.load(Ordering::SeqCst){return Err("任务已停止".into());}
    let _scratch=if matches!(request["op"].as_str(),Some("cmyk"|"lossless")) {
      let output=PathBuf::from(request["output"].as_str().ok_or("缺少输出路径")?);
      if !output.is_absolute(){return Err("输出路径必须为绝对路径".into());}
      let parent=output.parent().ok_or("输出目录无效")?.canonicalize().map_err(|e|e.to_string())?;
      let stamp=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e|e.to_string())?.as_nanos();
      let folder=parent.join(format!(".momo-production-{}-{stamp}",std::process::id()));
      std::fs::create_dir(&folder).map_err(|e|e.to_string())?;
      request["scratch"]=Value::String(folder.to_string_lossy().into_owned());Some(Scratch(folder))
    } else {None};
    let mut cmd=Command::new(path);cmd.env("PYTHONUTF8","1").env("PYTHONIOENCODING","utf-8").args(["-c",include_str!("production_tools.py")]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)] {use std::os::windows::process::CommandExt;cmd.creation_flags(0x08000000);}
    let mut child=cmd.spawn().map_err(|e|format!("Python 启动失败：{e}"))?;
    let mut stdin=child.stdin.take().unwrap();let bytes=serde_json::to_vec(&request).map_err(|e|e.to_string())?;
    let writer=std::thread::spawn(move||stdin.write_all(&bytes));
    let mut stdout=child.stdout.take().unwrap();let mut stderr=child.stderr.take().unwrap();
    let output=std::thread::spawn(move||{let mut b=Vec::new();let _=stdout.read_to_end(&mut b);b});
    let errors=std::thread::spawn(move||{let mut b=Vec::new();let _=stderr.read_to_end(&mut b);b});
    let start=Instant::now();let mut stopped=false;
    loop {if flag.load(Ordering::SeqCst)||start.elapsed()>Duration::from_secs(180){stop_tree(&mut child);stopped=true;break;}match child.try_wait(){Ok(Some(_))=>break,Ok(None)=>std::thread::sleep(Duration::from_millis(50)),Err(_)=>{stop_tree(&mut child);stopped=true;break;}}}
    let _=writer.join();let bytes=output.join().unwrap_or_default();let err=errors.join().unwrap_or_default();
    if stopped{return Err(if flag.load(Ordering::SeqCst){"任务已停止"}else{"本地生产任务超时"}.into());}
    let v:Value=serde_json::from_slice(&bytes).map_err(|_|format!("本地工具执行失败：{}",String::from_utf8_lossy(&err).chars().take(1000).collect::<String>()))?;
    if let Some(e)=v.get("error").and_then(Value::as_str){return Err(e.to_string());}Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    // 本机集成测试显式提供已有 Python 环境，不在测试中安装软件。
    #[test]
    fn production_native_json_and_cancel() {
      let Ok(python)=std::env::var("MOMO_QA_PYTHON") else {return;};
      let flag=AtomicBool::new(false);
      let result=run_python(&python,serde_json::json!({"op":"probe"}),&flag).unwrap();
      assert_eq!(result["PIL"],true);assert_eq!(result["cv2"],true);
      flag.store(true,Ordering::SeqCst);
      assert!(run_python(&python,serde_json::json!({"op":"probe"}),&flag).unwrap_err().contains("停止"));
    }
    #[test]
    fn production_cancel_cleans_scratch() {
      let (Ok(python),Ok(probe),Ok(source))=(std::env::var("MOMO_QA_PYTHON"),std::env::var("MOMO_QA_FFPROBE"),std::env::var("MOMO_QA_VIDEO")) else {return;};
      let parent=std::env::temp_dir().join(format!("momo-production-test-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
      std::fs::create_dir(&parent).unwrap();
      let output=parent.join("cancelled.mp4");let flag=Arc::new(AtomicBool::new(false));let cancel=flag.clone();
      let task=std::thread::spawn(move||{std::thread::sleep(Duration::from_secs(2));cancel.store(true,Ordering::SeqCst);});
      let parts:Vec<_>=(0..200).map(|_|serde_json::json!({"path":source,"start":0,"end":1})).collect();
      let result=run_python(&python,serde_json::json!({"op":"lossless","ffprobe":probe,"parts":parts,"output":output}),&flag);
      task.join().unwrap();let error=result.unwrap_err();assert!(error.contains("停止"),"{error}");
      assert!(!output.exists());assert_eq!(std::fs::read_dir(&parent).unwrap().count(),0);
      std::fs::remove_dir(&parent).unwrap();
    }
}
