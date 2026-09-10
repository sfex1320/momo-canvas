/** 官方 Codex 会员图片通道。路径设置独立持久化，账号凭据完全由 Codex 管理。 */
import {Channel,invoke} from "@tauri-apps/api/core";
import {loadJSON,saveJSON} from "./persist";
import {isTauri,uid,toDataUrl} from "./utils";
import type {ImageGenReq} from "./services/imageGen";

export const CODEX_IMAGE_MODEL="codex-image";
export type CodexTextMessage = { role: "user" | "assistant"; text: string };
export type CodexTextEvent = { delta?: string; stage?: string };
export async function codexText(request: { mode: "chat" | "task"; workspace?: string; messages: CodexTextMessage[] }, signal: AbortSignal, progress: (event: CodexTextEvent) => void) {
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
export async function codexGenerate(req:ImageGenReq):Promise<string[]>{
 if(!isTauri)throw Error("Codex 会员生图需要 MOMO 桌面端");
 if(req.mask)throw Error("Codex 图片桥暂不支持像素蒙版约束，请用文字描述改图范围或选择支持蒙版的绘画服务商");
 if((req.n??1)!==1)throw Error("Codex 会员通道每次生成一张，请将数量设为 1；批量任务可逐张运行");
 req.signal?.throwIfAborted();const executable=await codexExecutable();
 const refs=await Promise.all((req.refImages??[]).map(r=>toDataUrl(r)));req.signal?.throwIfAborted();
 const taskId=uid(18),onEvent=new Channel<{stage:string}>();onEvent.onmessage=e=>req.onProgress?.(e.stage);
 const stop=()=>void invoke("codex_bridge_cancel",{taskId}).catch(()=>{});req.signal?.addEventListener("abort",stop,{once:true});
 try{const promise=invoke<{images:string[];limits?:CodexLimits}>("codex_bridge_generate",{taskId,executable,request:{prompt:[req.prompt,req.negative?`避免：${req.negative}`:""].filter(Boolean).join("\n"),refs,size:req.size??req.aspect,background:req.background,newConversation:req.newConversation??false},onEvent});if(req.signal?.aborted)stop();const result=await promise;req.signal?.throwIfAborted();window.dispatchEvent(new CustomEvent("momo-codex-limits",{detail:result.limits}));return result.images;}finally{req.signal?.removeEventListener("abort",stop);}
}
