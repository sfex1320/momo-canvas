import { useEffect, useState } from "react";
import type { PrevizEntity } from "../../../core/types";
import type { StageEngine } from "./stageEngine";
import { sampleBoneKeys } from "./skeletalRig";
import { PopSelect } from "../../../ui/PopSelect";
import { IcLayers } from "../../../ui/icons";

export function SkeletonPanel({entity,engine,time,disabled,onChange}:{entity:PrevizEntity;engine:StageEngine|null;time:number;disabled:boolean;onChange:(e:PrevizEntity)=>void}) {
  const [info,setInfo]=useState(()=>engine?.rigInfo(entity.id)),[bone,setBone]=useState("");
  useEffect(()=>{const read=()=>setInfo(engine?.rigInfo(entity.id));read();const timer=setInterval(read,1000);return()=>clearInterval(timer);},[engine,entity.id,entity.modelAssetPath]);
  if(entity.preset!=="glb")return null;
  const s=entity.skeletal??{},poses=sampleBoneKeys(s,time),angles=poses[bone]??[0,0,0];
  const save=(bones:Record<string,[number,number,number]>)=>onChange({...entity,skeletal:{...s,keys:[...(s.keys??[]).filter(k=>Math.abs(k.time-time)>0.025),{time:Math.round(time*100)/100,bones}].sort((a,b)=>a.time-b.time)}});
  return <fieldset disabled={disabled} style={{border:0,padding:0,width:"100%"}}><details><summary>骨骼动画与姿态 · {info?.bones.length??0} 根骨骼</summary>
    <div className="ds3d-motion-row"><PopSelect value={s.clip??""} onChange={clip=>onChange({...entity,skeletal:{...s,clip}})} triggerIcon options={[{value:"",label:"静态姿态",icon:<IcLayers size={13}/>},...(info?.clips??[]).map(c=>({value:c.name,label:`${c.name} · ${c.duration.toFixed(2)}秒`,icon:<IcLayers size={13}/>}))]}/>
      <label>动作速度 <input aria-label="骨骼动作速度" type="number" min={0.05} max={4} step={0.05} value={s.speed??1} onChange={e=>onChange({...entity,skeletal:{...s,speed:Math.max(.05,Math.min(4,Number(e.target.value)||1))}})}/></label>
      <label><input type="checkbox" checked={s.loop!==false} onChange={e=>onChange({...entity,skeletal:{...s,loop:e.target.checked}})}/>循环</label></div>
    {!!info?.bones.length&&<div className="ds3d-motion-row"><PopSelect value={bone} onChange={setBone} triggerIcon options={[{value:"",label:"选择骨骼…",icon:<IcLayers size={13}/>},...info.bones.map(b=>({value:b.key,label:b.name,icon:<IcLayers size={13}/>}))]}/>
      {bone!==""&&(["X","Y","Z"] as const).map((axis,i)=><label key={axis}>{axis}° <input aria-label={`骨骼${axis}旋转`} type="number" step={5} value={Math.round(angles[i]*100)/100} onChange={e=>{const a=[...angles] as [number,number,number];a[i]=Math.max(-180,Math.min(180,Number(e.target.value)||0));save({...poses,[bone]:a});}}/></label>)}
      <button className="btn sm" onClick={()=>save(poses)}>记录姿态 {time.toFixed(2)}s</button><button className="btn sm" onClick={()=>onChange({...entity,skeletal:{...s,keys:s.keys?.filter(k=>Math.abs(k.time-time)>0.025)}})}>删除当前姿态帧</button>
      {(s.keys??[]).map(k=><span key={k.time}>{k.time}s ◆</span>)}</div>}
    <small>导入带骨骼的 GLB 可播放内置动作，并叠加局部骨骼旋转；使用上方时间轴录制不同姿态。没有骨骼的模型仍可编辑整体轨迹。</small>
  </details></fieldset>;
}
