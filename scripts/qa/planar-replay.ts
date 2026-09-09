import report from "../../.Codex/planar-acceptance/report.json";
import {useDirector} from "../../src/core/stores/directorStore";
import {adoptEnglishH3} from "../../src/core/studio/h3Authoring";
import {validateAuthoredH3} from "../../src/core/studio/h3AuthoringCore";
import {compileSegmentPrompt} from "../../src/core/directorQueue";
if(location.hostname!=="[::1]")throw Error("仅允许独立验收来源");
document.querySelector<HTMLButtonElement>("#run")!.onclick=async()=>{
 const log=document.querySelector("#log")!;
 try{
  const a=(report.messages as any[]).find(m=>m.authoring)?.authoring;if(!a)throw Error("缺少实测记录");
  const p=useDirector.getState().createProject("qa-replay","qa-replay","真实稿重放");
  useDirector.getState().updateProject(p.id,{scenes:[{id:"sc",name:"摄影棚",segments:[{id:"seg",sceneId:"sc",summary:"女孩挥手",durationSec:4,dialogue:["你好，欢迎来到这里。"],shots:[],h3Authoring:a}]} as any]});
  const errors=validateAuthoredH3(a.reviewDraft,a.enDraft,"t2v",["你好，欢迎来到这里。"],{Picture:0,Video:0,Audio:0},4);if(errors.length)throw Error(errors.join("；"));
  await adoptEnglishH3(p.id,"seg");const now=useDirector.getState().getById(p.id)!,seg=now.scenes[0].segments[0];if(compileSegmentPrompt(now,seg,"video-t2v").prompt!==a.enDraft)throw Error("英文请求被改写");
  log.textContent="通过：真实返回稿的中英结构、逐字对白、无虚构参考、单镜头 0–4 秒、并行声轨、采用与原文执行全部通过。未再次调用模型。\n\n"+a.reviewDraft+"\n\n"+a.enDraft;
 }catch(e){log.textContent="失败 "+String(e);}
};
