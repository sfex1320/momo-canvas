import { invoke } from "@tauri-apps/api/core";
import { isTauri, uid } from "./utils";
import { loadJSON, saveJSON } from "./persist";
import { useComfySync } from "./stores/comfySyncStore";

export type ProductionPrefs = { pythonPath: string; iccPath: string; ffmpegPath: string };
export async function productionPrefs(): Promise<ProductionPrefs> {
  const p = await loadJSON<ProductionPrefs>("production-tools.json","v1") ?? {pythonPath:"",iccPath:"",ffmpegPath:""};
  if (!p.pythonPath && isTauri) {
    const paths = await invoke<string[]>("production_detect",{roots:useComfySync.getState().sources.map(s=>s.rootPath)}).catch(()=>[]);
    p.pythonPath = paths[0] ?? "";
  }
  return p;
}
export async function saveProductionPrefs(p:ProductionPrefs) { await saveJSON("production-tools.json","v1",p); }
export async function productionRun<T>(request:Record<string,unknown>,signal?:AbortSignal):Promise<T> {
  if(!isTauri)throw new Error("此功能需要 MOMO 桌面端的本地生产工具");
  signal?.throwIfAborted();const prefs=await productionPrefs(),taskId=uid(12);signal?.throwIfAborted();
  const stop=()=>void invoke("production_cancel",{taskId}).catch(()=>{});signal?.addEventListener("abort",stop,{once:true});
  try {const task=invoke<T>("production_run",{taskId,pythonPath:prefs.pythonPath,request});if(signal?.aborted)stop();const result=await task;signal?.throwIfAborted();return result;}
  finally{signal?.removeEventListener("abort",stop);}
}

export async function losslessVideo(parts:Array<{path:string;start:number;end?:number}>,signal:AbortSignal):Promise<{path:string;duration:number}> {
  const prefs=await productionPrefs();
  const tools=await invoke<{ffmpeg?:string;ffprobe?:string}>("media_locate",{custom:prefs.ffmpegPath||null});
  if(!tools.ffprobe)throw new Error("未找到 ffprobe，请安装 FFmpeg 或在设计工具中选择路径");
  const {assetsDir}=await import("./services/assetFiles");const {join}=await import("@tauri-apps/api/path");
  const output=await join(await assetsDir(),`无损修订-${uid(10)}.mp4`);
  return productionRun({op:"lossless",parts,output,ffmpeg:tools.ffmpeg,ffprobe:tools.ffprobe},signal);
}
