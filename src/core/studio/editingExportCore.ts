import type {RenderPlan} from "../directorRender";

const xml=(s:string)=>s.replace(/[<>&"']/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&apos;"}[c]!));
export function editingFileUrl(path:string):string {
  const raw=path.replace(/\\/g,"/");
  return `file://localhost/${raw.replace(/^\//,"").split("/").map((part,i)=>i===0&&/^[a-z]:$/i.test(part)?part:encodeURIComponent(part)).join("/")}`;
}
/** 基础剪辑交换：入出点、原声、分离音轨与音量；与 MP4 共用同一份渲染计划。 */
export function premiereXml(plan:RenderPlan,name:string,durations:Record<string,number>={},hasAudio:Record<string,boolean>={}):string {
  const fps=plan.fps,frame=(s:number)=>Math.round(s*fps),rate=`<rate><timebase>${Math.round(fps)}</timebase><ntsc>${Math.abs(fps-Math.round(fps))>.01?"TRUE":"FALSE"}</ntsc></rate>`;
  const file=(path:string,id:string,duration:number,video:boolean)=>`<file id="${id}"><name>${xml(path.split(/[\\/]/).pop()??path)}</name><pathurl>${xml(editingFileUrl(path))}</pathurl>${rate}<duration>${frame(duration)}</duration><media>${video?`<video><samplecharacteristics>${rate}<width>${plan.width}</width><height>${plan.height}</height></samplecharacteristics></video>`:""}<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio></media></file>`;
  const volume=(v:number)=>`<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audio</effectcategory><effecttype>audio</effecttype><mediatype>audio</mediatype><parameter><parameterid>level</parameterid><name>Level</name><value>${v}</value></parameter></effect></filter>`;
  let cursor=0;
  const videos:string[]=[],sound:string[][]=[[],[]];
  for(const [i,c] of plan.clips.entries()) {
    const duration=durations[c.path]??c.outSec,start=frame(cursor),end=frame(cursor+c.durSec),fid=`file-${i}`;
    const body=`<name>${xml(c.path.split(/[\\/]/).pop()??`片段 ${i+1}`)}</name><enabled>TRUE</enabled>${rate}<duration>${frame(duration)}</duration><start>${start}</start><end>${end}</end><in>${frame(c.inSec)}</in><out>${frame(c.outSec)}</out>`;
    videos.push(`<clipitem id="video-${i}">${body}${file(c.path,fid,duration,true)}</clipitem>`);
    if(!c.muted&&hasAudio[c.path]!==false)for(let channel=1;channel<=2;channel++)sound[channel-1].push(`<clipitem id="sound-${i}-${channel}">${body}<file id="${fid}"/><sourcetrack><mediatype>audio</mediatype><trackindex>${channel}</trackindex></sourcetrack>${volume(c.volume)}</clipitem>`);
    cursor+=c.durSec;
  }
  const audio=plan.audio.filter(a=>!a.muted).map((a,i)=>{
    const dur=Math.max(0,Math.min(durations[a.path]??plan.totalSec,plan.totalSec-a.atSec));
    return [1,2].map(ch=>`<track><clipitem id="audio-${i}-${ch}"><name>${xml(a.path.split(/[\\/]/).pop()??"音频")}</name><enabled>TRUE</enabled>${rate}<duration>${frame(durations[a.path]??dur)}</duration><start>${frame(a.atSec)}</start><end>${frame(a.atSec+dur)}</end><in>0</in><out>${frame(dur)}</out>${ch===1?file(a.path,`audio-file-${i}`,dur,false):`<file id="audio-file-${i}"/>`}<sourcetrack><mediatype>audio</mediatype><trackindex>${ch}</trackindex></sourcetrack>${volume(a.volume)}</clipitem></track>`).join("");
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4"><sequence id="momo-sequence"><name>${xml(name)}</name><duration>${frame(cursor)}</duration>${rate}<media><video><format><samplecharacteristics>${rate}<width>${plan.width}</width><height>${plan.height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format><track>${videos.join("")}</track></video><audio><numOutputChannels>2</numOutputChannels>${sound.map(track=>`<track>${track.join("")}</track>`).join("")}${audio}</audio></media></sequence></xmeml>`;
}
