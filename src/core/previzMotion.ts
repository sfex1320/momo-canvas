import type { PrevizEntity, PrevizKeyframe } from "./types";

/** 秒级关键帧。机位和角色各自存轨迹，角度按最短方向插值。 */
export function motionFrame(e: PrevizEntity, time: number): PrevizKeyframe {
  const base: PrevizKeyframe={time:0,pos:e.pos??[(e.x-50)*0.24,0,(e.y-50)*0.24],rotDeg:e.rotDeg??[0,180-e.angle,0],scale3:e.scale3??[1,1,1]};
  const keys=[base,...(e.motion??[])].filter(k=>Number.isFinite(k.time)&&k.time>=0).sort((a,b)=>a.time-b.time);
  let a=keys[0],b=keys[keys.length-1];
  for(const key of keys){if(key.time<=time)a=key;else{b=key;break;}}
  const t=b.time>a.time?Math.max(0,Math.min(1,(time-a.time)/(b.time-a.time))):0;
  const lerp=(x:number,y:number)=>x+(y-x)*t;
  return {time,pos:a.pos.map((v,i)=>lerp(v,b.pos[i])) as PrevizKeyframe["pos"],scale3:a.scale3.map((v,i)=>lerp(v,b.scale3[i])) as PrevizKeyframe["scale3"],rotDeg:a.rotDeg.map((v,i)=>v+(((b.rotDeg[i]-v)%360+540)%360-180)*t) as PrevizKeyframe["rotDeg"]};
}
export function sampleMotion(entities: PrevizEntity[],time:number): PrevizEntity[]{
  return entities.map(e=>({...e,...motionFrame(e,time),animationTime:time}));
}
export function putMotionKey(e:PrevizEntity,key:PrevizKeyframe):PrevizEntity {
  const time=Math.round(Math.max(0,Math.min(120,key.time))*100)/100;
  return {...e,motion:[...(e.motion??[]).filter(k=>Math.abs(k.time-time)>0.005),{...key,time}].sort((a,b)=>a.time-b.time)};
}
export function motionPreset(e:PrevizEntity,kind:"move"|"push"|"orbit",duration:number):PrevizEntity {
  const start=motionFrame(e,0),end={...start,time:duration,pos:[...start.pos] as PrevizKeyframe["pos"]};
  if(kind==="move")end.pos[0]+=3;
  if(kind==="push"){const a=start.rotDeg[1]*Math.PI/180;end.pos[0]+=Math.sin(a)*2;end.pos[2]+=Math.cos(a)*2;}
  if(kind==="orbit"){
    const radius=Math.hypot(start.pos[0],start.pos[2])||5;
    const initial=Math.atan2(start.pos[0],start.pos[2]);
    return {...e,motion:Array.from({length:9},(_,i)=>{const a=initial+i*Math.PI/16;return {time:duration*i/8,pos:[Math.sin(a)*radius,start.pos[1],Math.cos(a)*radius],rotDeg:[start.rotDeg[0],a*180/Math.PI+180,start.rotDeg[2]],scale3:start.scale3};})};
  }
  return {...e,motion:[start,end]};
}
