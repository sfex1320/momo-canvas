/** 官方 Codex 会员图片通道。路径设置独立持久化，账号凭据完全由 Codex 管理。 */
import {Channel,invoke} from "@tauri-apps/api/core";
import {loadJSON,saveJSON} from "./persist";
import {isTauri,uid,toDataUrl} from "./utils";
import type {ImageGenReq} from "./services/imageGen";

export const CODEX_IMAGE_MODEL="codex-image";
export type CodexTextMessage = { role: "user" | "assistant"; text: string; images?: string[] };
export type CodexTextEvent = { delta?: string; stage?: string };
export async function codexText(request: { mode: "chat" | "task"; workspace?: string; system?: string; messages: CodexTextMessage[] }, signal: AbortSignal, progress: (event: CodexTextEvent) => void) {
  if (!isTauri) throw Error("Codex 对话与任务需要 MOMO 桌面端");
  signal.throwIfAborted();
  const taskId = uid(18), executable = await codexExecutable(), onEvent = new Channel<CodexTextEvent>();
  onEvent.onmessage = progress;
  const stop = () => void invoke("codex_bridge_cancel", { taskId }).catch(() => {});
  signal.addEventListener("abort", stop, { once: true });
  try {
    const pending = invoke<{ text: string; limits?: CodexLimits }>("codex_bridge_text", { taskId, executable, request, onEvent });
    if (signal.aborted) stop();
    const result = await pending; signal.throwIfAborted();
    window.dispatchEvent(new CustomEvent("momo-codex-limits", { detail: result.limits }));
    return result;
  } finally { signal.removeEventListener("abort", stop); }
}
export type CodexLimits={rateLimits?:{primary?:{usedPercent:number;windowDurationMins?:number;resetsAt?:number}|null;secondary?:{usedPercent:number;windowDurationMins?:number;resetsAt?:number}|null;spendControlReached?:boolean}|null};
export type CodexStatus={executable:string;account:{type?:string;planType?:string};limits?:CodexLimits|null};
export async function codexExecutable(){return (await loadJSON<{executable:string}>("codex-bridge.json","v1"))?.executable??"";}
export async function saveCodexExecutable(executable:string){await saveJSON("codex-bridge.json","v1",{executable});}
export async function codexStatus(){if(!isTauri)throw Error("Codex 桥接需要 MOMO 桌面端");return invoke<CodexStatus>("codex_bridge_status",{executable:await codexExecutable()});}
export async function codexGenerate(req:ImageGenReq):Promise<string[]> {
 if(!isTauri)throw Error("Codex 会员生图需要 MOMO 桌面端");
 if(req.mask)throw Error("Codex 图片桥暂不支持像素蒙版约束，请用文字描述改图范围或选择支持蒙版的绘画服务商");
 if((req.n??1)!==1)throw Error("Codex 会员通道每次生成一张，请将数量设为 1");
 const controller=new AbortController(), signal=req.signal?AbortSignal.any([req.signal,controller.signal]):controller.signal;
 const taskId=uid(18); let timedOut=false, active=true;
 const stop=()=>void invoke("codex_bridge_cancel",{taskId}).catch(()=>{});
 const timer=setTimeout(()=>{timedOut=true;controller.abort();},660_000);
 const started=Date.now(); let stage="正在准备参考图片";
 const report=()=>{if(active)req.onProgress?.(`${stage}\n已等待 ${Math.floor((Date.now()-started)/1000)} 秒，可随时停止`);};
 const ticker=setInterval(report,10_000);
 signal.addEventListener("abort",stop,{once:true});
 try {
   signal.throwIfAborted();report();
   const executable=await codexExecutable();
   const refs=await Promise.all((req.refImages??[]).map(r=>toDataUrl(r,(src,init)=>fetch(src,{...init,signal:AbortSignal.any([signal,AbortSignal.timeout(60_000)])}),"image")));
   signal.throwIfAborted();
   const onEvent=new Channel<{stage:string}>();onEvent.onmessage=e=>{stage=e.stage;report();};
   const pending=invoke<{images:string[];limits?:CodexLimits}>("codex_bridge_generate",{taskId,executable,request:{operation:req.operation??"generate",prompt:[req.prompt,req.negative?`避免：${req.negative}`:""].filter(Boolean).join("\n"),refs,size:req.size??req.aspect,background:req.background,newConversation:req.operation==="edit"?true:req.newConversation??true},onEvent});
   const result=await new Promise<{images:string[];limits?:CodexLimits}>((resolve,reject)=>{
     const abort=()=>reject(timedOut?Error("Codex 生图已超过 11 分钟，已停止等待；请检查网络后手动重试"):signal.reason);
     signal.addEventListener("abort",abort,{once:true});
     pending.then(resolve,reject).finally(()=>signal.removeEventListener("abort",abort));
     if(signal.aborted)abort();
   });
   signal.throwIfAborted();window.dispatchEvent(new CustomEvent("momo-codex-limits",{detail:result.limits}));return result.images;
 } catch(e) {
   if(timedOut)throw Error("Codex 生图请求超时，已停止等待。请检查网络后手动重试");
   throw e;
 } finally {active=false;clearTimeout(timer);clearInterval(ticker);signal.removeEventListener("abort",stop);}
}
