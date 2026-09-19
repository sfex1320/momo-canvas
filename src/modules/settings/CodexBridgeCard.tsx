import {selectCodexCreation} from "../../core/stores/agentStore";
import {useEffect,useState} from "react";
import {CodexConsole} from "../agent/CodexConsole";
import {useUi} from "../../core/stores/uiStore";
import {codexStatus,codexExecutable,saveCodexExecutable,type CodexStatus,type CodexLimits} from "../../core/codexBridge";
import {errMsg,isTauri} from "../../core/utils";
import {openExternal} from "../../core/external";
import {useSettings} from "../../core/stores/settingsStore";

export function CodexBridgeCard(){
 const [expanded,setExpanded]=useState(false);
 const [consoleOpen,setConsoleOpen]=useState(false);
 const [status,setStatus]=useState<CodexStatus>(),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const defaults=useSettings(s=>s.settings.models.defaults);
 const refresh=async()=>{setBusy(true);setError("");setStatus(undefined);try{setStatus(await codexStatus());}catch(e){setError(errMsg(e));}finally{setBusy(false);}};
 useEffect(()=>{if(isTauri)void refresh();},[]);
 useEffect(()=>{const update=(e:Event)=>setStatus(s=>s?{...s,limits:(e as CustomEvent<CodexLimits>).detail}:s);window.addEventListener("momo-codex-limits",update);return()=>window.removeEventListener("momo-codex-limits",update);},[]);
 const choose=async()=>{const {open}=await import("@tauri-apps/plugin-dialog");const p=await open({title:"选择 codex.exe",filters:[{name:"Codex",extensions:["exe"]}],defaultPath:(await codexExecutable())||undefined});if(typeof p==="string"){await saveCodexExecutable(p);await refresh();}};
 const bindLocal=async()=>{setBusy(true);setStatus(undefined);setError("");try{await saveCodexExecutable("");setStatus(await codexStatus());}catch(e){setError(errMsg(e));}finally{setBusy(false);}};
 const limits=status?.limits?.rateLimits;
 return <section className="codex-bridge-card" onMouseLeave={()=>setExpanded(false)} onKeyDown={e=>{if(e.key==="Escape")setExpanded(false);}}><div><b>Codex 会员</b><button className="btn sm" onClick={()=>{selectCodexCreation();useUi.getState().closeSettings();useUi.getState().setAgentOpen(true);}}>打开助手</button><button className="btn sm" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>连接与额度 {expanded?"收起":"展开"}</button></div>
 {consoleOpen&&<CodexConsole onClose={()=>setConsoleOpen(false)}/>}
 {expanded&&<div className="codex-bridge-drawer"><button className="btn sm" onClick={()=>setConsoleOpen(true)}>文件任务</button>
 <p>使用本机 Codex 的 ChatGPT 登录与共享额度。画布按需启动后台进程，无需保持 Codex 窗口开启。网络沿用本机环境；不自动切换付费 API。</p>
 <p>换电脑：先在新电脑安装 Codex 并用 ChatGPT 登录，再点“绑定本机”，连接成功后选择“用于对话与生图”。账号额度跟随登录账号，项目文件需另外迁移。</p>
 <div className="codex-bridge-actions"><button className="btn sm" disabled={busy||!isTauri} title="清除旧电脑的程序路径，自动检测本机 Codex；不退出或更换 Codex 账号" onClick={()=>void bindLocal()}>绑定本机</button><button className="btn sm" disabled={status?.account.type!=="chatgpt"} onClick={()=>{useSettings.getState().setDefault("chat","codex-membership::codex-chat");useSettings.getState().setDefault("image","codex-membership::codex-image");}}>用于对话与生图</button><button className="btn sm" disabled={busy||!isTauri} onClick={()=>void refresh()}>{busy?"连接中…":"检查连接与额度"}</button><button className="btn sm" disabled={busy||!isTauri} onClick={()=>void choose().catch(e=>setError(errMsg(e)))}>选择 Codex 程序</button><button className="btn sm" onClick={()=>void openExternal("https://learn.chatgpt.com/docs/auth")}>登录说明</button><button className="btn sm" disabled={status?.account.type!=="chatgpt"||defaults.image==="codex-membership::codex-image"} onClick={()=>useSettings.getState().setDefault("image","codex-membership::codex-image")}>{defaults.image==="codex-membership::codex-image"?"已用于默认生图":"设为默认生图"}</button></div>
 {status&&<p role="status">{status.account.type==="chatgpt"?`已连接 · ${status.account.planType??"ChatGPT"} 会员`:"请在 Codex 中用 ChatGPT 登录，然后重新检查连接"}</p>}
 {status?.executable&&<small title={status.executable} style={{display:"block",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>本机程序：{status.executable}</small>}
 {status?.account.type==="chatgpt"&&<div className="codex-quota">{(["primary","secondary"] as const).map(k=>{const w=limits?.[k];return w?<div key={k}><span>{w.windowDurationMins===10080?"每周额度":w.windowDurationMins?`${w.windowDurationMins/60} 小时额度`:"共享额度"} · 剩余 {Math.max(0,100-w.usedPercent)}%</span><progress max={100} value={Math.max(0,100-w.usedPercent)}/>{w.resetsAt&&<small>{new Date(w.resetsAt*1000).toLocaleString("zh-CN")} 恢复</small>}</div>:null;})}{!limits&&<span>额度暂时不可用，请稍后刷新</span>}</div>}
 <small>每次生成 1 张；尺寸由 Codex 生图能力决定。额度用完会停止，不自动购买或兑换重置券。</small>{error&&<p role="alert">{error}</p>}
 </div>}
 </section>;
}
