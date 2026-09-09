import { useEffect, useRef, useState } from "react";
import type { DirectorProject, PrevizEntity } from "../../../core/types";
import { motionFrame, motionPreset, putMotionKey, sampleMotion } from "../../../core/previzMotion";
import { useAssets } from "../../../core/stores/assetStore";
import { useDirector } from "../../../core/stores/directorStore";
import { pushError, toast } from "../../../core/stores/uiStore";
import { errMsg } from "../../../core/utils";
import { jobCenter } from "../../../core/studio/jobCenter";
import type { StageEngine } from "./stageEngine";
import { SkeletonPanel } from "./SkeletonPanel";

export function MotionPanel({project,entities,selected,time,onTime,onChange,engine,segmentId,onRecording}: {
  project:DirectorProject;entities:PrevizEntity[];selected:string|null;time:number;onTime:(t:number)=>void;
  onChange:(v:PrevizEntity[])=>void;onRecording:(value:boolean)=>void;engine:StageEngine|null;segmentId?:string|null;
}) {
  const [duration,setDuration]=useState(()=>Math.max(5,...entities.flatMap(e=>(e.motion??[]).map(k=>k.time))));
  const [playing,setPlaying]=useState(false),[recording,setRecording]=useState(false);
  const ctrl=useRef<AbortController|null>(null);
  const frame=useRef(onTime);frame.current=onTime;
  useEffect(()=>()=>ctrl.current?.abort(),[]);
  useEffect(()=>{if(!playing)return;const start=performance.now()-time*1000;let raf=0;const tick=()=>{const t=(performance.now()-start)/1000;frame.current(Math.min(t,duration));if(t>=duration)setPlaying(false);else raf=requestAnimationFrame(tick);};raf=requestAnimationFrame(tick);return()=>cancelAnimationFrame(raf);},[playing,duration]);
  const entity=entities.find(e=>e.id===selected);
  const change=(next:PrevizEntity)=>onChange(entities.map(e=>e.id===next.id?next:e));
  const record=async()=>{
    if(!engine||ctrl.current)return;
    const c=new AbortController();ctrl.current=c;setPlaying(false);setRecording(true);onRecording(true);
    const job=jobCenter.begin({projectId:project.id,kind:"render",label:"3D 动态预演",cancellable:true,cancelRun:()=>c.abort()});
    let url:string|undefined;
    try{
      const blob=await engine.recordMotion(entities,duration,project.aspect,c.signal,(pct)=>job.stage("录制动态预演",pct));
      c.signal.throwIfAborted();url=URL.createObjectURL(blob);
      const asset=await useAssets.getState().collect({src:url,kind:"video",name:`${project.name} · 3D 动态预演`,director:{projectId:project.id,role:"generated"}});
      if(!asset)throw new Error("动态预演收录失败");
      if(segmentId){const p=useDirector.getState().getById(project.id);if(p)useDirector.getState().updateProject(project.id,{scenes:p.scenes.map(s=>({...s,segments:s.segments.map(g=>g.id===segmentId?{...g,slots:[...(g.slots??[]),{semantic:"referenceVideo" as const,assetIds:[asset.id],auto:false}]}:g)}))});}
      job.done();toast(segmentId?"动态预演已入库并加入当前片段参考视频":"动态预演已存入资产库","ok");
    }catch(e){if(c.signal.aborted)job.cancel();else{job.fail(errMsg(e));pushError("动态预演",errMsg(e));}}
    finally{if(url)URL.revokeObjectURL(url);ctrl.current=null;setRecording(false);onRecording(false);engine.syncEntities(sampleMotion(entities,time));}
  };
  return <div className="ds3d-motion">
    {entity&&<SkeletonPanel entity={entity} engine={engine} time={time} disabled={playing||recording} onChange={change}/>}
    <div className="ds3d-motion-row"><b>动态预演</b><button className="btn sm" disabled={recording} onClick={()=>{if(time>=duration)onTime(0);setPlaying(!playing);}}>{playing?"暂停":"播放"}</button>
      <input aria-label="预演时间" type="range" min={0} max={duration} step={0.05} value={time} disabled={recording} onChange={e=>{setPlaying(false);onTime(Number(e.target.value));}}/><span>{time.toFixed(2)}s</span>
      <label>时长 <input aria-label="预演时长" type="number" min={1} max={120} value={duration} disabled={recording||playing} onChange={e=>{const v=Math.max(1,Math.min(120,Number(e.target.value)||1));setDuration(v);onTime(Math.min(time,v));}}/>秒</label>
      <button className="btn sm" disabled={recording||playing||!entity} onClick={()=>entity&&change(putMotionKey(entity,motionFrame(entity,time)))}>记录关键帧</button>
      <button className="btn sm" disabled={recording||playing||!entity} onClick={()=>entity&&change({...entity,motion:entity.motion?.filter(k=>Math.abs(k.time-time)>0.025)})}>删除当前帧</button>
      {recording?<button className="btn sm" onClick={()=>ctrl.current?.abort()}>停止录制</button>:<button className="btn sm" onClick={()=>void record()}>导出动态参考</button>}
    </div>
    <div className="ds3d-motion-row"><span>{entity?`${entity.name} · ${entity.kind==="camera"?"镜头轨迹":"实体轨迹"}`:"选择角色或机位，记录不同时间的位置"}</span>
      {entity&&<><button className="btn sm" disabled={recording||playing} onClick={()=>change(motionPreset(entity,entity.kind==="camera"?"push":"move",duration))}>{entity.kind==="camera"?"一键推进":"一键横移"}</button>{entity.kind==="camera"&&<button className="btn sm" disabled={recording||playing} onClick={()=>change(motionPreset(entity,"orbit",duration))}>绕原点环拍</button>}{(entity.motion??[]).map(k=><button key={k.time} className="btn sm" disabled={recording} onClick={()=>{setPlaying(false);onTime(k.time);}}>{k.time}s ◆</button>)}</>}
      <small>在不同时间拖动实体会记录关键帧；录制保留当前视角，输出无声 WebM。</small>
    </div>
  </div>;
}
