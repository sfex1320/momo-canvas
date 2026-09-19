/** 设置、顶部按钮与同步中心共用同一份本机启动配置与连接状态。 */
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { loadJSON, saveJSON } from "./persist";
import { useComfy } from "./stores/comfyStore";
import { useSettings } from "./stores/settingsStore";
import { isTauri } from "./utils";
import type { ComfyLauncherCandidate } from "./types";
import { toast } from "./stores/uiStore";

type Config = { launcher?: string; bridgeDir?: string; directory?: string; directRoot?: string };
export const useComfyRuntime = create<Config & {
  loaded:boolean; launching:boolean; selecting:boolean;
  picker?: { directory:string; candidates:ComfyLauncherCandidate[] };
}>(()=>({loaded:false,launching:false,selecting:false}));
let loading: Promise<void> | undefined;
export function loadComfyRuntime() {
  return loading ??= loadJSON<Config>("comfy-runtime.json","v1").then(c=>{useComfyRuntime.setState({...c,loaded:true});});
}
export async function saveComfyRuntime(patch: Config) {
  await loadComfyRuntime();
  useComfyRuntime.setState(patch);
  const {launcher,bridgeDir,directory,directRoot}=useComfyRuntime.getState();
  await saveJSON("comfy-runtime.json","v1",{launcher,bridgeDir,directory,directRoot});
}
/** 升级前装过同步桥的目录也会自动认领，离线不提示重复安装。 */
export async function discoverComfyBridge(roots:string[]) {
  if(!isTauri)return;
  await loadComfyRuntime();
  const {exists}=await import("@tauri-apps/plugin-fs");
  const {dirname,join}=await import("@tauri-apps/api/path");
  const current=useComfyRuntime.getState().bridgeDir;
  if(current&&await exists(await join(current,"js","momo_bridge.js")))return;
  for(const root of roots){
    let dir=root;
    for(let depth=0;depth<7;depth++){
      const candidate=await join(dir,"custom_nodes","momo_sync_bridge");
      if(await exists(await join(candidate,"js","momo_bridge.js"))){await saveComfyRuntime({bridgeDir:candidate});return;}
      const parent=await dirname(dir);if(parent===dir)break;dir=parent;
    }
  }
}
async function selectLauncherFile() {
  const {open}=await import("@tauri-apps/plugin-dialog");
  const path=await open({title:"选择 ComfyUI 启动器或启动脚本",filters:[{name:"启动文件",extensions:["exe","bat","cmd","lnk"]}]});
  if(typeof path!=="string")return false;
  await saveComfyRuntime({launcher:path,directory:undefined,directRoot:undefined});return true;
}
export async function chooseComfyLauncher() {
  if(useComfyRuntime.getState().selecting)return false;
  useComfyRuntime.setState({selecting:true});
  try {return await selectLauncherFile();}
  finally {useComfyRuntime.setState({selecting:false});}
}

let settlePicker: ((path:string|null)=>void) | undefined;
export function resolveComfyLauncher(path:string|null) {
  const resolve=settlePicker;
  settlePicker=undefined;
  useComfyRuntime.setState({picker:undefined});
  resolve?.(path);
}

/** 唯一候选自动绑定；多入口由用户选择，取消时保留原绑定。 */
export async function chooseComfyDirectory() {
  if(!isTauri)throw Error("目录自动识别需要桌面端");
  if(useComfyRuntime.getState().selecting)return false;
  useComfyRuntime.setState({selecting:true});
  try {
    const {open}=await import("@tauri-apps/plugin-dialog");
    const directory=await open({title:"选择 ComfyUI 文件夹（自动识别启动器）",directory:true});
    if(typeof directory!=="string")return false;
    const candidates=await invoke<ComfyLauncherCandidate[]>("comfy_launcher_discover",{directory});
    const path=candidates.length===1?candidates[0].path:await new Promise<string|null>(resolve=>{
      settlePicker=resolve;
      useComfyRuntime.setState({picker:{directory,candidates}});
    });
    if(path===null)return false;
    if(path==="manual")return await selectLauncherFile();
    const candidate=candidates.find(c=>c.path===path);
    if(!candidate)return false;
    await saveComfyRuntime({launcher:candidate.path,directory,directRoot:candidate.directRoot??undefined});
    // 只同步明确写在所选脚本里的端口；GUI 启动器的内部配置不猜测。
    if(candidate.port) {
      const {settings,update}=useSettings.getState();
      update("comfy",{...settings.comfy,host:`http://127.0.0.1:${candidate.port}`});
    }
    toast(`已绑定 ${candidate.name}${candidate.port?` · 端口 ${candidate.port}`:""}`,"ok");
    return true;
  } finally {useComfyRuntime.setState({selecting:false});}
}
export async function launchComfy() {
  if(!isTauri)throw Error("一键启动需要桌面端");
  if(useComfyRuntime.getState().launching)return;
  useComfyRuntime.setState({launching:true});
  try {
    await loadComfyRuntime();
    if(!useComfyRuntime.getState().launcher && !(await chooseComfyDirectory()))return;
    // 旧版本绑定绘世 exe 的入口自动升级为同目录完整服务直启。
    let config=useComfyRuntime.getState();
    if(!config.directRoot && /(?:绘世|comfyui).*\.exe$/i.test(config.launcher??"")){
      const {dirname}=await import("@tauri-apps/api/path");
      const directory=config.directory??await dirname(config.launcher!);
      const found=await invoke<ComfyLauncherCandidate[]>("comfy_launcher_discover",{directory});
      const direct=found.filter(c=>c.directRoot);
      if(direct.length===1){
        await saveComfyRuntime({launcher:direct[0].path,directory,directRoot:direct[0].directRoot!});
        config=useComfyRuntime.getState();
      }
    }
    const host=useSettings.getState().settings.comfy.host;
    const url=new URL(/^https?:\/\//i.test(host)?host:`http://${host}`);
    if(!["localhost","127.0.0.1","[::1]"].includes(url.hostname))throw Error("当前连接的是远程服务，请先在 ComfyUI 设置填写本机地址");
    if((await useComfy.getState().test(host)).ok)return;
    const log=config.directRoot?await invoke<string>("comfy_launch_direct",{directory:config.directRoot,port:Number(url.port)||(url.protocol==="https:"?443:80)}):undefined;
    if(!config.directRoot)await invoke("shortcut_launch",{path:config.launcher});
    const start=Date.now();
    while(Date.now()-start<300_000) {
      await new Promise(r=>setTimeout(r,2000));
      if((await useComfy.getState().test(host)).ok)return;
    }
    throw Error(`ComfyUI 启动等待超过 5 分钟，服务尚未就绪。${log?`启动日志：${log}`:"请检查启动器或日志后重新检测连接"}`);
  } finally {useComfyRuntime.setState({launching:false});}
}

let subscribers=0, timer:ReturnType<typeof setInterval>|undefined;
/** 多入口挂载只保留一个探活定时器，切换地址立即清掉旧状态。 */
export function watchComfyConnection() {
  if(!isTauri)return ()=>{};
  subscribers++;
  const refresh=()=>void useComfy.getState().test(useSettings.getState().settings.comfy.host);
  if(subscribers===1){refresh();timer=setInterval(refresh,15_000);}
  const off=useSettings.subscribe((s,prev)=>{if(s.settings.comfy.host!==prev.settings.comfy.host)refresh();});
  window.addEventListener("focus",refresh);
  return()=>{off();window.removeEventListener("focus",refresh);if(--subscribers===0)clearInterval(timer);};
}
