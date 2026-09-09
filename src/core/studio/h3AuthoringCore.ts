/** 中英写作的可复核合同；不把 LLM 的自称“翻译正确”当作校验。 */
import {extractDialogue} from "./h3BilingualCore.ts";
export const H3_AUTHOR_RULES=`将中文分镜文案按 H3 模式排版，并给出对应英文执行稿。中文审阅与英文执行保持相同镜头、人物、动作、时序、时长、参考编号；不得新增剧情。英文描述使用英文；对白、歌词和画面可见文字保留原语言。所有对白写成 <d>[Chinese]原文</d>，禁止翻译对白。按本次真实素材槽编号，禁止虚构参考。逐镜说明构图、动作、机位、声音和时间范围。`;
const full=["subject_definitions","summary","retention_analysis","detailed_description","overall_soundscape","non_diegetic_music"];
const base=["integrated_multimodal_description","overall_soundscape","non_diegetic_music"];
/** Base 三段成品稿与 Ref2VA 六段成品稿都必须原样进入执行层。 */
export function isOfficialH3BasePrompt(text:string):boolean{
  return text.trimStart().startsWith(base[0]+":")&&[...text.matchAll(/^(subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music)\s*:/gm)].map(m=>m[1]).join()===base.join();
}
export function h3AuthoringContract(mode:string){
  const fields=mode==="r2v"?full:base;
  const alignment=mode==="i2v"?"Picture 1 is the first frame at 0.00 seconds.":mode==="fl2v"?"Picture 1 is the first frame; Picture 2 is the last frame at the exact end of the duration.":mode==="l2v"?"Picture 1 is the last frame at the exact end of the duration.":"";
  return `Each zh/en body must contain exactly these fields, once each, in this order:\n${fields.map(k=>k+":").join("\n")}\nNo private metadata header, Purpose, Characters or extra preface. ${alignment} Match all reference labels to actual supplied slots. Both bodies use the same [0.00s-3.00s] timeline range notation.`;
}
export function validateAuthoredH3(zh:string,en:string,mode:string,dialogue:string[],counts:{Picture:number;Video:number;Audio:number},duration?:number):string[]{
  const problems:string[]=[],expected=mode==="r2v"?full:base;
  // 声场、配乐可与镜头同时发生；只校验画面小节，不能把并行声轨当成重复镜头。
  const timeline=(body:string)=>{
    const visual=body.match(/^(?:integrated_multimodal_description|detailed_description)\s*:([\s\S]*?)(?=^[a-z_]+\s*:|$(?![\s\S]))/m)?.[1]??"";
    return [...visual.matchAll(/\[(\d+(?:\.\d+)?)s\s*[-–]\s*(\d+(?:\.\d+)?)s\]/g)].map(m=>[+m[1],+m[2]]);
  };
  for(const [label,body] of [["中文",zh],["英文",en]]){
    const fields=[...body.matchAll(/^(subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music)\s*:/gm)].map(m=>m[1]);
    if(fields.join()!==expected.join())problems.push(`${label}稿小节不完整、重复或顺序错误`);
    if(!body.trimStart().startsWith(expected[0]+":"))problems.push(`${label}稿含多余前言`);
    const sections=body.split(/^(?:subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music)\s*:/m).slice(1);
    if(sections.some(s=>!s.trim()))problems.push(`${label}稿含空小节`);
    const actual=extractDialogue(body);
    if(JSON.stringify(actual)!==JSON.stringify(dialogue))problems.push(`${label}稿对白与中文输入不一致`);
    if(duration!==undefined){
      const ranges=timeline(body);
      if(!ranges.length||ranges[0][0]!==0||Math.abs(ranges[ranges.length-1][1]-duration)>.01||ranges.some((r,i)=>r[1]<=r[0]||(i>0&&Math.abs(r[0]-ranges[i-1][1])>.01)))problems.push(`${label}稿镜头时间范围未连续覆盖 0–${duration} 秒`);
    }
    for(const m of body.matchAll(/<(Picture|Video|Audio)\s+(\d+)>/g)){const n=+m[2];if(n<1||n>counts[m[1] as keyof typeof counts])problems.push(`${label}稿引用了不存在的 ${m[0]}`);}
  }
  if(JSON.stringify(timeline(zh))!==JSON.stringify(timeline(en)))problems.push("中英文镜头时间范围不一致");
  const refs=(s:string)=>[...new Set([...s.matchAll(/<(?:Picture|Video|Audio|Subject)\s+\d+>/g)].map(m=>m[0]))].sort().join();
  if(refs(zh)!==refs(en))problems.push("中英文参考标签不一致");
  const prose=en.replace(/^[a-z_]+\s*:/gm,"").replace(/<d>[\s\S]*?<\/d>/g,"").replace(/<(?:Picture|Video|Audio|Subject)\s+\d+>/g,"");
  if(!/[A-Za-z]{3}/.test(prose))problems.push("英文执行稿为空或无有效英文描述");
  return [...new Set(problems)];
}
