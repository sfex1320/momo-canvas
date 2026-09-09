import {useEffect,useRef,useState} from "react";
import type {DirectorProject,DirectorSegment} from "../../../core/types";
import {draftEnglishH3,adoptEnglishH3,patchH3Authoring} from "../../../core/studio/h3Authoring";
import {errMsg} from "../../../core/utils";
export function H3AuthoringPanel({project,seg}:{project:DirectorProject;seg:DirectorSegment}){
  const [busy,setBusy]=useState(false),[error,setError]=useState("");const ctrl=useRef<AbortController|null>(null),live=useRef(true);
  useEffect(()=>{live.current=true;return()=>{live.current=false;ctrl.current?.abort();};},[seg.id]);
  const a=seg.h3Authoring??{zh:seg.scriptText??seg.summary,rules:""};
  const edit=(patch:Partial<typeof a>)=>patchH3Authoring(project.id,seg.id,{h3Authoring:{...a,...patch}});
  const generate=async()=>{setBusy(true);setError("");const c=new AbortController();ctrl.current=c;try{edit({});await draftEnglishH3(project.id,seg.id,c.signal);}catch(e){if(live.current)setError(errMsg(e));}finally{if(live.current)setBusy(false);}};
  return <details className="h3-authoring"><summary>中文写作 → Skill 排版 → 英文执行</summary><p className="st-hint">使用已绑定的提示词 Skill；没有绑定时使用内置 H3 规范。先生成待审稿，核对后才替换执行稿。</p>
    <label>中文文案<textarea className="st-area" rows={6} disabled={busy} value={a.zh} onChange={e=>edit({zh:e.target.value})}/></label>
    <label>补充排版规则<textarea className="st-area" rows={2} disabled={busy} value={a.rules} onChange={e=>edit({rules:e.target.value})} placeholder="例如镜头按时间排序、保持人物称呼一致。长期规则可存为 Skill。"/></label>
    <p className="st-hint">对白取本段对白列表；文案中明确标记 &lt;d&gt;原文&lt;/d&gt; 时优先采用标记对白。对白与可见文字保留原语言。</p>
    <button className="st-btn" disabled={busy||!a.zh.trim()} onClick={()=>void generate()}>{busy?"排版翻译中…":"生成中英文待审稿"}</button>{busy&&<button className="st-btn" onClick={()=>ctrl.current?.abort()}>停止</button>}
    {a.enDraft&&<><div className="h3-authoring-pair"><label>中文排版稿<textarea className="st-area" rows={8} disabled={busy} value={a.reviewDraft??""} onChange={e=>edit({reviewDraft:e.target.value})}/></label><label>英文待审稿<textarea className="st-area" rows={8} disabled={busy} value={a.enDraft} onChange={e=>edit({enDraft:e.target.value})}/></label></div><p className="st-hint">结构校验不能保证语义翻译完全无误，请对照确认人物、动作和时间。修改后采用时会重新校验。</p><button className="st-btn" disabled={busy} onClick={()=>void adoptEnglishH3(project.id,seg.id).catch(e=>setError(errMsg(e)))}>核对并采用英文执行稿</button></>}
    {!!a.problems?.length&&<ul role="status">{a.problems.map(p=><li key={p}>{p}</li>)}</ul>}{error&&<p role="alert">{error}</p>}
  </details>;
}
