import { useEffect } from "react";
import { launchComfy, loadComfyRuntime, useComfyRuntime, watchComfyConnection } from "../core/comfyRuntime";
import { useComfy } from "../core/stores/comfyStore";
import { useSettings } from "../core/stores/settingsStore";
import { toast } from "../core/stores/uiStore";
import { errMsg } from "../core/utils";
import { resolveComfyLauncher } from "../core/comfyRuntime";
import { Modal } from "./kit";
import { createPortal } from "react-dom";
export function ComfyLaunchButton(){
  const hotkey=useSettings(s=>s.settings.hotkeys.comfyLaunch);
  const launching=useComfyRuntime(s=>s.launching), selecting=useComfyRuntime(s=>s.selecting), online=useComfy(s=>s.online);
  useEffect(()=>{void loadComfyRuntime();return watchComfyConnection();},[]);
  return <button className="btn sm" style={{borderRadius:10,whiteSpace:"nowrap"}} disabled={launching||selecting||online==="ok"} title={`首次选择 ComfyUI 文件夹自动识别启动器，之后一键启动${hotkey?`（${hotkey.toUpperCase()}）`:""}`} onClick={()=>void launchComfy().catch(e=>toast(errMsg(e),"err"))}>{selecting?"选择 ComfyUI 启动器…":launching?"ComfyUI 启动中…":online==="ok"?"ComfyUI 已连接":"一键启动 ComfyUI"}</button>;
}

/** 全局只挂一份，设置、顶部与同步中心共用同一次选择。 */
export function ComfyLauncherPicker(){
  const picker=useComfyRuntime(s=>s.picker);
  useEffect(()=>{
    if(!picker)return;
    const onKey=(e:KeyboardEvent)=>{if(e.key==="Escape"){e.stopImmediatePropagation();resolveComfyLauncher(null);}};
    window.addEventListener("keydown",onKey,true);
    return()=>window.removeEventListener("keydown",onKey,true);
  },[picker]);
  if(!picker)return null;
  return createPortal(<div style={{position:"relative",zIndex:10000}}><Modal title={picker.candidates.length?"选择 ComfyUI 启动方式":"未找到明确的启动器"} width={640} onClose={()=>resolveComfyLauncher(null)} footer={<><button className="btn" onClick={()=>resolveComfyLauncher("manual")}>手动选择启动文件…</button><button className="btn" onClick={()=>resolveComfyLauncher(null)}>取消</button></>}>
    <p style={{fontSize:12,color:"var(--text-3)",overflowWrap:"anywhere"}}>{picker.directory}</p>
    <p style={{fontSize:12,color:"var(--text-3)"}}>{picker.candidates.length?"这个目录有多个启动入口，选择平时使用的一个。选择会保存，下次无需重复绑定。":"可手动选择 exe、bat、cmd 或快捷方式，或重新选择整合包的外层目录。"}</p>
    <div style={{display:"grid",gap:10}}>{picker.candidates.map(c=><button className="btn" key={c.path} style={{height:"auto",padding:12,textAlign:"left",display:"grid",justifyContent:"stretch",gap:4}} onClick={()=>resolveComfyLauncher(c.path)}>
      <strong>{c.name}</strong><span style={{fontSize:12,color:"var(--text-3)",whiteSpace:"normal",overflowWrap:"anywhere"}}>{c.reason}{c.port?` · 同步连接端口 ${c.port}`:""}<br/>{c.path}</span>
    </button>)}</div>
  </Modal></div>,document.body);
}
