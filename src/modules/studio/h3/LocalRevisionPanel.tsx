import { useEffect, useRef, useState } from "react";
import type { DirectorProject, DirectorSegment, DirectorTake } from "../../../core/types";
import { useAssets } from "../../../core/stores/assetStore";
import { assetToBlobUrl } from "../../../core/services/assetFiles";
import { applyLocalRevision, generateReplacement } from "../../../core/studio/localRevision";
import { resolveModelCard } from "../../../core/stores/settingsStore";
import { estimateCost } from "../../../core/pricing";
import { jobCenter } from "../../../core/studio/jobCenter";
import { pushError, toast } from "../../../core/stores/uiStore";
import { errMsg } from "../../../core/utils";
import { PopSelect } from "../../../ui/PopSelect";
import { IcVideo } from "../../../ui/icons";
import { ModelPicker } from "../../../ui/ModelPicker";

export function LocalRevisionPanel({project,segment,take,time,duration}:{project:DirectorProject;segment:DirectorSegment;take:DirectorTake;time:number;duration:number}){
  const [lossless,setLossless]=useState(false);
  const assets=useAssets(s=>s.items),[open,setOpen]=useState(false),[start,setStart]=useState(0),[end,setEnd]=useState(()=>Math.min(3,duration||3)),[replacement,setReplacement]=useState(""),[compare,setCompare]=useState(""),[prompt,setPrompt]=useState(""),[model,setModel]=useState<string>(),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState<{model:string;prompt:string;start:number;end:number;cost:number}|null>(null);
  const [urls,setUrls]=useState<string[]>([]),videos=useRef<Array<HTMLVideoElement|null>>([]),ctrl=useRef<AbortController|null>(null);
  useEffect(()=>()=>ctrl.current?.abort(),[]);
  useEffect(()=>{let live=true;setUrls([]);if(!open||!compare)return;const ids=[take.assetId,compare];void Promise.all(ids.map(async id=>{const a=assets.find(x=>x.id===id);return a?assetToBlobUrl(a.path,a.mime):"";})).then(v=>{if(live)setUrls(v);}).catch(e=>{if(live)pushError("版本对照",errMsg(e));});return()=>{live=false;};},[open,compare,take.assetId,assets]);
  const choices=assets.filter(a=>a.kind==="video"&&a.id!==take.assetId&&(!a.director?.projectId||a.director.projectId===project.id));
  const execute=async(mode:"generate"|"apply")=>{
    if(ctrl.current)return;const c=new AbortController();ctrl.current=c;setBusy(true);
    const job=jobCenter.begin({projectId:project.id,segmentId:segment.id,kind:mode==="generate"?"generate":"render",label:mode==="generate"?"生成局部替换素材":"合成局部修订版",cancellable:true,cancelRun:()=>c.abort()});
    const common={projectId:project.id,signal:c.signal,onProgress:(m:string)=>job.stage(m)};
    try{if(mode==="generate"){
      const plan=confirm;if(!plan)throw new Error("请先确认请求");setConfirm(null);
      const result=await generateReplacement({...common,sourceId:take.assetId!,start:plan.start,end:plan.end,prompt:plan.prompt,modelKey:plan.model,aspect:project.aspect,confirmed:true});setReplacement(result.assetId);toast("替换素材已入库，预览后点击合成新版本","ok");
    }else{const result=await applyLocalRevision({...common,segmentId:segment.id,takeId:take.id,replacementId:replacement,start,end,lossless});setCompare(result.assetId!);toast("新版本已生成，原版保留；对照后可在 Take 条采用","ok");}job.done();}
    catch(e){if(c.signal.aborted)job.cancel();else{job.fail(errMsg(e));pushError("局部视频重做",errMsg(e));}}finally{ctrl.current=null;setBusy(false);}
  };
  return <div className="local-revision"><button className="st-btn sm" onClick={()=>setOpen(!open)}>局部重做与版本对照</button>{open&&<div className="local-revision-body">
    <div className="st-row"><label>起点秒 <input aria-label="替换起点" className="st-input" type="number" min={0} max={duration} step={0.05} value={start} onChange={e=>setStart(Number(e.target.value))}/></label><button className="st-btn sm" onClick={()=>setStart(time)}>取播放位置</button><label>终点秒 <input aria-label="替换终点" className="st-input" type="number" min={0} max={duration} step={0.05} value={end} onChange={e=>setEnd(Number(e.target.value))}/></label><button className="st-btn sm" onClick={()=>setEnd(time)}>取播放位置</button></div>
    <PopSelect triggerIcon value={replacement} onChange={setReplacement} options={[{value:"",label:"选择替换视频…",icon:<IcVideo size={13}/>},...choices.map(a=>({value:a.id,label:a.name,icon:<IcVideo size={13}/>}))]}/>
    <label><input type="checkbox" checked={lossless} disabled={busy} onChange={e=>setLossless(e.target.checked)}/>原码流无损拼接（本地 FFmpeg）</label>
    <div className="st-row"><button className="st-btn primary sm" disabled={busy||!replacement} onClick={()=>void execute("apply")}>合成新版本</button><small>{lossless?"输出 MP4；严格检查各素材编码、音轨与关键帧切点。不兼容时明确报错，不自动转为有损。":"兼容模式：保留原版；过长裁至区间，过短阻止合成。输出 WebM / 30fps，实时重编码。"}</small></div>
    <details><summary>没有替换素材：用 AI 生成这一小段</summary><textarea className="st-area" placeholder="描述这段需要改成什么；程序抽取起止帧辅助衔接" value={prompt} onChange={e=>setPrompt(e.target.value)}/><ModelPicker role="video" value={model} onChange={setModel}/><button className="st-btn sm" disabled={busy||!prompt.trim()} onClick={()=>{try{if(start<0||end<=start||end>duration)throw new Error("请先设置有效区间");const card=resolveModelCard("video",model);setConfirm({model:`${card.id.includes('::')?card.id:card.id+'::'+card.model}`,prompt,start,end,cost:estimateCost(card.model,{videoSec:end-start})});}catch(e){pushError("局部重做预检",errMsg(e));}}}>预览生成请求</button></details>
    {confirm&&<div className="reference-plan"><b>生成 {confirm.start.toFixed(2)}–{confirm.end.toFixed(2)} 秒的替换素材</b><span>{confirm.model} · 估算 ¥{confirm.cost.toFixed(2)}；实际时长由模型协议决定，提交后可能计费。</span><pre style={{whiteSpace:"pre-wrap"}}>{confirm.prompt}</pre><small>输入：区间起点和终点画面；尾帧是否支持取决于模型。</small><button className="st-btn primary sm" disabled={busy} onClick={()=>void execute("generate")}>确认生成替换素材</button><button className="st-btn sm" onClick={()=>setConfirm(null)}>取消</button></div>}
    {busy&&<button className="st-btn sm" onClick={()=>ctrl.current?.abort()}>停止</button>}
    <label>对照版本 <PopSelect triggerIcon value={compare} onChange={setCompare} options={[{value:"",label:"选择视频版本…",icon:<IcVideo size={13}/>},...choices.map(a=>({value:a.id,label:a.name,icon:<IcVideo size={13}/>}))]}/></label>
    {urls.length===2&&<><div className="local-revision-videos">{urls.map((url,i)=><figure key={url}><figcaption>{i?"对照版":"当前原版"}</figcaption><video ref={el=>{videos.current[i]=el;}} src={url} muted playsInline controls onSeeking={e=>{const other=videos.current[1-i];if(other&&Math.abs(other.currentTime-e.currentTarget.currentTime)>0.1)other.currentTime=Math.min(e.currentTarget.currentTime,Number.isFinite(other.duration)?other.duration:e.currentTarget.currentTime);}}/></figure>)}</div><button className="st-btn sm" onClick={()=>{const list=videos.current.filter(Boolean) as HTMLVideoElement[];const pause=list.some(v=>!v.paused);for(const v of list)if(pause)v.pause();else {v.currentTime=list[0].currentTime;void v.play().catch(e=>pushError("版本播放",errMsg(e)));}}}>同步播放 / 暂停</button></>}
  </div>}</div>;
}
