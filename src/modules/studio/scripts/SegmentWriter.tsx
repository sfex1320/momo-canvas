import {charactersInSegment} from "../../../core/studio/objectIndex";
import {useState} from "react";
import {useDirector} from "../../../core/stores/directorStore";
import {useDirectorCtx} from "../../../core/directorContext";
import {authoringProblems, authoredText, parseAuthorTime, parseTimedActions, shouldRelay, timeChip} from "../../../core/studio/authoring";
import {uid} from "../../../core/utils";
import {toast} from "../../../core/stores/uiStore";
import {H3AuthoringPanel} from "../h3/H3AuthoringPanel";
import {IcPlus, IcTrash, IcArrowR} from "../../../ui/icons";
import type {DirectorProject, DirectorSegment, DirectorShot} from "../../../core/types";

function TimeLabel({value,onChange,label}:{value:number;onChange:(v:number)=>void;label:string}) {
  const [editing,setEditing]=useState(false),[draft,setDraft]=useState("");
  return editing ? <input className="st-input sw-time-input" aria-label={label} autoFocus value={draft} onChange={e=>setDraft(e.target.value)} onBlur={()=>{const n=parseAuthorTime(draft);if(n!==null)onChange(n);else toast("请输入秒、毫秒或 00:00.000 时间", "err");setEditing(false);}} onKeyDown={e=>{if(e.key==="Enter")e.currentTarget.blur();if(e.key==="Escape")setEditing(false);}}/> : <button className="sw-time" title={label} onClick={()=>{setDraft(timeChip(value));setEditing(true);}}>{timeChip(value)}</button>;
}
export function SegmentWriter({project}:{project:DirectorProject}) {
  const selected=useDirectorCtx(s=>s.segId),setSelected=useDirectorCtx(s=>s.setSeg);
  const segments=project.scenes.flatMap(s=>s.segments),seg=segments.find(s=>s.id===selected)??segments[0];
  const chosenIds=seg?.characterIds??(seg?charactersInSegment(project,seg).map(c=>c.id):[]);
  const patch=(p:Partial<DirectorSegment>)=>useDirector.getState().patchSegment(project.id,seg.id,p);
  const [raw,setRaw]=useState("");
  const go=(station:"scripts"|"characters"|"h3"|"post")=>useDirector.getState().updateProject(project.id,{studioUi:{...project.studioUi,station}});
  const add=()=>{
    const current=useDirector.getState().getById(project.id)!;
    const scene=current.scenes.find(s=>s.id===seg?.sceneId)??current.scenes[0]??{id:uid(8),location:"场景 1",segments:[]};
    const next:DirectorSegment={id:uid(8),sceneId:scene.id,summary:`片段 ${segments.length+1}`,durationSec:8,dialogue:[],shots:[],characterIds:[],definitionIds:[],musicIntent:"none",relayMode:"auto"};
    const scenes=current.scenes.some(s=>s.id===scene.id)?current.scenes.map(s=>s.id===scene.id?{...s,segments:[...s.segments,next]}:s):[{...scene,segments:[next]}];
    useDirector.getState().updateProject(project.id,{scenes});setSelected(next.id);
  };
  const shotPatch=(id:string,p:Partial<DirectorShot>)=>patch({shots:seg.shots.map(s=>s.id===id?{...s,...p}:s)});
  return <div className="sw-layout">
    <aside className="sw-list"><div className="sw-list-head"><b>分段剧本</b><button className="st-btn" onClick={add} aria-label="新增片段"><IcPlus size={14}/></button></div><button className="st-btn" onClick={()=>go("scripts")}>导入剧本</button>{segments.map((s,i)=><button key={s.id} className={`sw-segment ${seg?.id===s.id?"on":""}`} onClick={()=>setSelected(s.id)}><small>{String(i+1).padStart(2,"0")} · {timeChip(s.durationSec)}</small><b>{s.summary}</b><span>{s.approvedTakeId?"已采用":"待制作"}</span></button>)}</aside>
    {!seg?<main className="sw-page"><h2>从你写的剧本开始</h2><p>先导入大纲、完整剧本或分段稿，也可以直接新增片段逐行编写。</p><button className="st-btn primary" onClick={add}>新增片段</button></main>:<main className="sw-page" key={seg.id}>
      <header className="sw-header"><div><small>分段编写</small><input className="st-input" aria-label="片段名称" value={seg.summary} onChange={e=>patch({summary:e.target.value})}/></div><button className="st-btn primary" onClick={()=>{setSelected(seg.id);go("h3");}}>生成与选片 <IcArrowR size={14}/></button></header>
      {(seg.promptOverride||seg.promptFinalOverride)&&<div className="sw-notice">本段已有执行稿。下方修改会保留旧执行稿，完成后请用“准备执行稿”生成待审版本再采用。</div>}
      <section><div className="sw-section-title"><h3>出场素材</h3><button className="st-btn" onClick={()=>go("characters")}>定义素材</button></div><div className="sw-chips">{project.characters.map(c=><label key={c.id}><input type="checkbox" checked={chosenIds.includes(c.id)} onChange={e=>patch({characterIds:e.target.checked?[...chosenIds,c.id]:chosenIds.filter(id=>id!==c.id)})}/>{c.name}</label>)}</div><div className="sw-chips">{(project.assetDefinitions??[]).map(d=><label key={d.id}><input type="checkbox" checked={seg.definitionIds?.includes(d.id)??false} onChange={e=>patch({definitionIds:e.target.checked?[...(seg.definitionIds??[]),d.id]:(seg.definitionIds??[]).filter(id=>id!==d.id)})}/><small>{d.kind==="scene"?"场景":"道具"}</small>{d.name}</label>)}</div>{!project.characters.length&&!project.assetDefinitions?.length&&<p className="st-hint">在素材页定义人物、场景和道具后，这里即可勾选复用。</p>}</section>
      <section><div className="sw-section-title"><h3>动作时间轴</h3><span>片段时长 <TimeLabel label="片段时长" value={seg.durationSec} onChange={durationSec=>{if(durationSec<=0)return;patch({durationSec,videoSpec:{...seg.videoSpec,user:{...seg.videoSpec?.user,durationSec}}});}}/></span></div>
        <div className="sw-actions">{seg.shots.map((shot,i)=><div className="sw-action" key={shot.id}><div className="sw-range"><span>{String(i+1).padStart(2,"0")}</span><TimeLabel label={`第 ${i+1} 行开始`} value={shot.startSec} onChange={startSec=>shotPatch(shot.id,{startSec})}/><span>—</span><TimeLabel label={`第 ${i+1} 行结束`} value={shot.endSec} onChange={endSec=>shotPatch(shot.id,{endSec})}/><button className="icon-btn" aria-label={`删除第 ${i+1} 行`} onClick={()=>patch({shots:seg.shots.filter(s=>s.id!==shot.id)})}><IcTrash size={13}/></button></div><textarea className="st-area" rows={2} placeholder="动作、表情、人物之间的交互…" value={shot.action} onChange={e=>shotPatch(shot.id,{action:e.target.value})}/><div className="sw-row"><input className="st-input" placeholder="机位 / 运镜（可选）" value={shot.camera} onChange={e=>shotPatch(shot.id,{camera:e.target.value})}/><input className="st-input" placeholder="本行对白 / 音效（可选）" value={shot.audio} onChange={e=>shotPatch(shot.id,{audio:e.target.value})}/></div></div>)}</div>
        <button className="st-btn" onClick={()=>{const start=seg.shots[seg.shots.length-1]?.endSec??0;const end=Math.max(start+1,seg.durationSec);patch({durationSec:end,shots:[...seg.shots,{id:uid(8),startSec:start,endSec:end,action:"",audio:"",camera:"",shotSize:""}],videoSpec:{...seg.videoSpec,user:{...seg.videoSpec?.user,durationSec:end}}});}}><IcPlus size={14}/>继续记录</button>
        <details className="sw-import"><summary>从文本识别时间行</summary><textarea className="st-area" rows={4} value={raw} onChange={e=>setRaw(e.target.value)} placeholder={'0.000s-2.500s 人物走入房间\n2.500s-8.000s 停步回头'}/><button className="st-btn" onClick={()=>{const rows=parseTimedActions(raw);if(!rows.length)return toast("未识别到时间范围", "err");const offset=seg.shots[seg.shots.length-1]?.endSec??0;const shots=rows.map(r=>({...r,id:uid(8),startSec:r.startSec+offset,endSec:r.endSec+offset}));const durationSec=Math.max(seg.durationSec,...shots.map(s=>s.endSec));patch({shots:[...seg.shots,...shots],durationSec,videoSpec:{...seg.videoSpec,user:{...seg.videoSpec?.user,durationSec}}});setRaw("");}}>识别并追加</button></details>
        {authoringProblems(seg).map(msg=><p className="sw-notice" key={msg}>{msg}</p>)}
      </section>
      <section><h3>场景与声音</h3><label>对白（每行一句）<textarea className="st-area" rows={2} value={seg.dialogue.join("\n")} onChange={e=>patch({dialogue:e.target.value.split("\n")})}/></label><div className="sw-row"><label>配乐<select className="st-input" value={seg.musicIntent??"none"} onChange={e=>patch({musicIntent:e.target.value as DirectorSegment["musicIntent"]})}><option value="none">无配乐</option><option value="ambient">仅环境声</option><option value="music">有配乐</option></select></label><label>衔接<select className="st-input" value={seg.relayMode??"auto"} onChange={e=>patch({relayMode:e.target.value as DirectorSegment["relayMode"]})}><option value="auto">同场景自动接力</option><option value="continue">承接上一段</option><option value="cut">硬切换场</option></select></label></div><p className="st-hint">{shouldRelay(project,seg)?"生成时从紧邻上一段的可用版本提取桥接参考。":"本段不使用上一段桥接画面。"}</p><label>承接状态<input className="st-input" value={seg.continuityIn??""} onChange={e=>patch({continuityIn:e.target.value})} placeholder="上一段结束时人物位置、朝向与动作…"/></label><label>结束状态<input className="st-input" value={seg.continuityOut??""} onChange={e=>patch({continuityOut:e.target.value})} placeholder="留给下一段的动作、视线、声音…"/></label></section>
      <section><button className="st-btn" disabled={!!authoringProblems(seg).length} onClick={()=>patch({characterIds:chosenIds,relayMode:seg.relayMode??"auto",musicIntent:seg.musicIntent??"none",h3Authoring:{zh:authoredText(project,{...seg,characterIds:chosenIds}),rules:seg.h3Authoring?.rules??""}})}>准备执行稿</button><H3AuthoringPanel key={seg.id} project={project} seg={seg}/></section>
    </main>}
  </div>;
}
