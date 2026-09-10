import type {DirectorProject,DirectorSegment} from "../types";
import {useDirector} from "../stores/directorStore";
import {useSkills} from "../stores/skillStore";
import {selectedDefinitions} from "./authoring";

import {routeSkillBindings,routeCtxOfRecipe} from "./skillRoute";
import {resolveModelCard} from "../stores/settingsStore";
import {chatStream} from "../services/llm";
import {resolveSlotMedia,effectiveSlots} from "../directorRefs";
import {isExecutionLocked} from "../directorEngine";
import {parseJsonLoose} from "../utils";
import {extractDialogue,parseH3PromptBody} from "./h3BilingualCore";
import {H3_AUTHOR_RULES,validateAuthoredH3,h3AuthoringContract} from "./h3AuthoringCore";

function current(pid:string,sid:string){const project=useDirector.getState().getById(pid),seg=project?.scenes.flatMap(s=>s.segments).find(s=>s.id===sid);if(!project||!seg)throw Error("片段不存在");return{project,seg};}
export function patchH3Authoring(pid:string,sid:string,patch:Partial<DirectorSegment>){const {project}=current(pid,sid);useDirector.getState().updateProject(pid,{scenes:project.scenes.map(s=>({...s,segments:s.segments.map(x=>x.id===sid?{...x,...patch}:x)}))});}
function context(p:DirectorProject,s:DirectorSegment){return JSON.stringify([s.durationSec,s.dialogue,s.slots,p.globalSlots,p.skillBindings,p.recipes,p.defaultRecipeId,s.recipeId,s.h3Authoring?.zh,s.h3Authoring?.rules,selectedDefinitions(p,s)]);}
async function refsFor(p:DirectorProject,s:DirectorSegment){const expected=effectiveSlots(p,s).reduce((n,x)=>n+x.assetIds.length,0);const m=await resolveSlotMedia(p,s);if(expected!==(m?.images.orderedAll.length??0)+(m?.videos.length??0)+(m?.audios.length??0))throw Error("参考素材缺失或无法读取，请先修复素材槽");return{counts:{Picture:m?.images.orderedAll.length??0,Video:m?.videos.length??0,Audio:m?.audios.length??0},note:m?.images.entries.map((e,i)=>`<Picture ${i+1}>: ${e.slot.label??e.slot.semantic}`).join("\n")??""};}
const jobs=new Set<string>();
export async function draftEnglishH3(pid:string,sid:string,signal:AbortSignal){
  const key=`${pid}:${sid}`;if(jobs.has(key))throw Error("该片段正在排版翻译");jobs.add(key);
  try{
    const {project,seg}=current(pid,sid),input=seg.h3Authoring;
    if(!input?.zh.trim())throw Error("先填写中文文案");
    const stamp=context(project,seg),baseEn=seg.promptOverride??"";
    await useSkills.getState().init();
    const refs=await refsFor(project,seg),recipe=project.recipes.find(r=>r.id===(seg.recipeId??project.defaultRecipeId)),mode=recipe?.mode??(refs.counts.Picture+refs.counts.Video+refs.counts.Audio?"r2v":"t2v");
    const skills=routeSkillBindings(project,routeCtxOfRecipe(project,recipe),undefined,{excludePlanning:true}).filter(s=>s.purpose!=="compile-image-prompt").map(s=>s.system);
    const dialogue=extractDialogue(input.zh).length?extractDialogue(input.zh):seg.dialogue;
    signal.throwIfAborted();
    const r=await chatStream(resolveModelCard("chat"),[{role:"user",text:JSON.stringify({中文文案:input.zh,已绑定人物场景道具:selectedDefinitions(project,seg),补充排版要求:input.rules,对白逐字保留:dialogue,时长秒:seg.durationSec,模式:mode,真实参考数量:refs.counts,图片顺序:refs.note})}],{signal,system:[...skills,H3_AUTHOR_RULES,h3AuthoringContract(mode),'严格输出 JSON {"zh":"按相同小节排版的中文审阅全文","en":"英文执行全文"}。不要 Markdown 围栏。中英正文仅保留模式要求的字段与对齐描述，不额外添加标题/用途/时长元信息前言。每稿时间轴必须使用 [0.000s-3.000s] 格式标记各镜头范围，从 0.000s 开始连续不重叠，精确结束于用户时长。'].join("\n\n")});
    signal.throwIfAborted();const raw=parseJsonLoose(r.text) as {zh?:unknown;en?:unknown}|null;
    if(typeof raw?.zh!=="string"||typeof raw.en!=="string")throw Error("模型未返回完整中英文稿，请重试");
    const problems=validateAuthoredH3(raw.zh,raw.en,mode,dialogue,refs.counts,seg.durationSec);
    const now=current(pid,sid);if(context(now.project,now.seg)!==stamp||(now.seg.promptOverride??"")!==baseEn)throw Error("生成期间中文、素材或执行稿发生变化，未覆盖新内容，请重试");
    patchH3Authoring(pid,sid,{h3Authoring:{...input,enDraft:raw.en,reviewDraft:raw.zh,baseEn,context:stamp,problems}});
  }finally{jobs.delete(key);}
}
export async function adoptEnglishH3(pid:string,sid:string){
  const {project,seg}=current(pid,sid),a=seg.h3Authoring;
  if(!a?.enDraft||!a.reviewDraft)throw Error("先生成中英文待审稿");
  if(isExecutionLocked(seg)||seg.locks?.reviewZh)throw Error("请先解锁英文执行稿与中文审阅稿");
  if(context(project,seg)!==a.context||(seg.promptOverride??"")!==a.baseEn)throw Error("文案、素材或执行稿已变化，请重新排版翻译");
  const refs=await refsFor(project,seg),recipe=project.recipes.find(r=>r.id===(seg.recipeId??project.defaultRecipeId)),mode=recipe?.mode??(Object.values(refs.counts).some(Boolean)?"r2v":"t2v");
  const dialogue=extractDialogue(a.zh).length?extractDialogue(a.zh):seg.dialogue,problems=validateAuthoredH3(a.reviewDraft,a.enDraft,mode,dialogue,refs.counts,seg.durationSec);
  const now=current(pid,sid);if(context(now.project,now.seg)!==a.context||now.seg.h3Authoring?.enDraft!==a.enDraft||now.seg.h3Authoring?.reviewDraft!==a.reviewDraft||isExecutionLocked(now.seg)||now.seg.locks?.reviewZh||(now.seg.promptOverride??"")!==a.baseEn)throw Error("片段已变化，未采用过期稿");
  if(problems.length){patchH3Authoring(pid,sid,{h3Authoring:{...a,problems}});throw Error(problems.join("；"));}
  patchH3Authoring(pid,sid,{promptOverride:a.enDraft,h3Prompt:{en:parseH3PromptBody(a.enDraft,seg.summary),zh:parseH3PromptBody(a.reviewDraft,seg.summary),source:"skill",syncStatus:"synced",generatedAt:Date.now()},h3Authoring:{zh:a.zh,rules:a.rules},dialogue});
}
