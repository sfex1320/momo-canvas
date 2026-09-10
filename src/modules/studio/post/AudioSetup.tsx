import {useRef,useState} from "react";
import {useDirector} from "../../../core/stores/directorStore";
import {useAssets} from "../../../core/stores/assetStore";
import {createAudioTrack,generateAudioTrack} from "../../../core/directorExport";
import {mirrorProjectAsset} from "../../../core/studio/projectAssetRouter";
import {patchAudioTrack} from "../../../core/directorTimeline";
import {extractAudioWav,trimVideo} from "../../../core/videoEdit";
import {assetUrl} from "../../../core/services/assetFiles";
import {toast} from "../../../core/stores/uiStore";
import {errMsg} from "../../../core/utils";
import type {DirectorProject} from "../../../core/types";

export function AudioSetup({project}:{project:DirectorProject}) {
  const [sid,setSid]=useState(""),[cid,setCid]=useState(""),[voice,setVoice]=useState(""),[text,setText]=useState(""),[busy,setBusy]=useState(false),[start,setStart]=useState(0),[end,setEnd]=useState(3);
  const input=useRef<HTMLInputElement>(null),assets=useAssets(s=>s.items);
  const segments=project.scenes.flatMap(s=>s.segments),seg=segments.find(s=>s.id===sid),character=project.characters.find(c=>c.id===cid);
  const task=async(run:()=>Promise<void>)=>{setBusy(true);try{await run();}catch(e){toast(errMsg(e),"err");}finally{setBusy(false);}};
  const upload=async(files:File[])=>task(async()=>{for(const f of files){const asset=await useAssets.getState().importFileGetItem(f);if(!asset||asset.kind!=="audio")continue;if(!asset.director)useAssets.getState().patchItem(asset.id,{director:{projectId:project.id,role:"reference"}});await mirrorProjectAsset({projectId:project.id,category:"audio",assetId:asset.id,segmentId:sid||undefined,segTitle:seg?.summary});const track=createAudioTrack(project.id,"music",f.name,sid||undefined);patchAudioTrack(project.id,track.id,{assetId:asset.id});}});
  const speak=()=>task(async()=>{const chosenVoice=voice.trim()||character?.ttsVoice;const track=createAudioTrack(project.id,sid?"dialogue":"narration",text,sid||undefined);patchAudioTrack(project.id,track.id,{voice:chosenVoice});if(character&&chosenVoice){const current=useDirector.getState().getById(project.id)!;useDirector.getState().updateProject(project.id,{characters:current.characters.map(c=>c.id===character.id?{...c,ttsVoice:chosenVoice}:c)});}await generateAudioTrack(project.id,track.id);toast("配音已加入音轨", "ok");});
  const extract=(kind:"audio"|"video")=>task(async()=>{
    if(!seg)throw Error("先选择来源片段");
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end-start>15)throw Error("参考范围应为 0–15 秒内的有效片段");
    const take=seg.takes?.find(t=>t.id===seg.approvedTakeId)??seg.takes?.filter(t=>t.status==="done"&&t.kind==="video").slice(-1)[0];
    const asset=assets.find(a=>a.id===take?.assetId);if(!asset)throw Error("本段还没有可用的视频版本");
    let src:string;
    if(kind==="audio"){const blob=await extractAudioWav(assetUrl(asset.path),start,end);src=await new Promise<string>((res,rej)=>{const reader=new FileReader();reader.onload=()=>res(String(reader.result));reader.onerror=rej;reader.readAsDataURL(blob);});}
    else src=await trimVideo(assetUrl(asset.path),start,end);
    const result=await useAssets.getState().collect({src,kind,name:`${seg.summary} · ${start.toFixed(3)}–${end.toFixed(3)}s ${kind==="audio"?"声音":"视频"}参考`,director:{projectId:project.id,segmentId:seg.id,role:"reference"}});
    if(!result)throw Error("参考素材未保存");
    const current=useDirector.getState().getById(project.id)!,all=current.scenes.flatMap(s=>s.segments),next=all[all.findIndex(s=>s.id===sid)+1];
    if(next)useDirector.getState().patchSegment(project.id,next.id,{slots:[...(next.slots??[]),{semantic:kind==="audio"?"referenceAudio":"referenceVideo",assetIds:[result.id],label:`${character?.name??seg.summary} · 连续性参考`,auto:false}]});
    toast(next?"已保存并绑定到下一片段参考槽":"已保存到资产库，当前没有下一片段", "ok");
  });
  return <details className="sw-import" style={{padding:12}}><summary>配乐、配音与参考</summary><div className="sw-row"><label>作用片段<select className="st-input" value={sid} onChange={e=>setSid(e.target.value)}><option value="">全片</option>{segments.map(s=><option key={s.id} value={s.id}>{s.summary}</option>)}</select></label><button className="st-btn" disabled={busy} onClick={()=>input.current?.click()}>上传配乐</button><input type="file" multiple accept="audio/*" hidden ref={input} onChange={e=>{void upload(Array.from(e.target.files??[]));e.target.value="";}}/></div>
    <div className="sw-row"><select className="st-input" aria-label="配音角色" value={cid} onChange={e=>{setCid(e.target.value);setVoice("");}}><option value="">旁白 / 自定义</option>{project.characters.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select><input className="st-input" value={voice} onChange={e=>setVoice(e.target.value)} placeholder={character?.ttsVoice??"音色 ID（沿用配音模型支持的音色）"}/></div><textarea className="st-area" style={{width:"100%",marginTop:8}} rows={3} value={text} onChange={e=>setText(e.target.value)} placeholder="输入配音台词…"/><button className="st-btn" disabled={busy||!text.trim()} onClick={()=>void speak()}>{busy?"处理中…":"生成配音"}</button>
    <p className="st-hint">角色记忆同一音色 ID。参考音频用于支持音频参考的视频模型；普通 TTS 不会自动克隆音色。</p>
    <div className="sw-row"><label>参考开始（秒）<input className="st-input" type="number" min={0} step={0.001} value={start} onChange={e=>setStart(+e.target.value)}/></label><label>参考结束（秒）<input className="st-input" type="number" min={0} step={0.001} value={end} onChange={e=>setEnd(+e.target.value)}/></label></div><button className="st-btn" disabled={busy||!seg} onClick={()=>void extract("video")}>提取视频参考</button><button className="st-btn" disabled={busy||!seg} onClick={()=>void extract("audio")}>提取声音参考</button>
  </details>;
}
