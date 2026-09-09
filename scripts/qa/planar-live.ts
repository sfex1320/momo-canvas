import {generatePlanarSheet,PLANAR_SHEET_RULES} from "../../src/core/planarSheet";
import {draftEnglishH3,adoptEnglishH3} from "../../src/core/studio/h3Authoring";
import {useBoard} from "../../src/core/stores/boardStore";
import {useSettings} from "../../src/core/stores/settingsStore";
import {useDirector} from "../../src/core/stores/directorStore";
import {abortAll} from "../../src/core/runControl";
if(location.hostname!=="[::1]")throw Error("仅允许独立验收来源");
const endpoint="http://[::1]:1433",ctrl=new AbortController();
document.querySelector<HTMLButtonElement>("#stop")!.onclick=()=>{ctrl.abort();abortAll();};
document.querySelector<HTMLButtonElement>("#run")!.onclick=async e=>{
 (e.currentTarget as HTMLButtonElement).disabled=true;const log=document.querySelector("#log")!,images:string[]=[],messages:unknown[]=[];const write=(s:string)=>log.textContent+=s+"\n";
 try{
  const config=await(await fetch(endpoint+"/config")).json(),fixture=await(await fetch(endpoint+"/fixture")).json();config.settings.models.defaults={...config.settings.models.defaults,chat:config.selected.chat,image:config.selected.image};useSettings.setState({settings:config.settings});useBoard.getState().newBoard();
  const id=useBoard.getState().addNode("image",{x:0,y:0},{src:fixture.src,status:"done"});const input=document.createElement("img");input.src=fixture.src;input.alt="输入立体效果";document.querySelector("#output")!.append(input);
  write("提交一张平面总稿…");const confirm=window.confirm;window.confirm=()=>true;
  try{const out=await generatePlanarSheet(id,PLANAR_SHEET_RULES+"\n本次输入为单个红色立方体装饰件，只需一块红色正视平面方形，不保留立体顶面和侧面。",config.selected.image,1024,1024);if(!out)throw Error("总稿未生成");const src=useBoard.getState().nodes.find(n=>n.id===out)!.data.src as string;images.push(src);const img=document.createElement("img");img.src=src;img.alt="输出平面总稿";document.querySelector("#output")!.append(img);messages.push({planar:true,source:id,result:out});write("平面总稿已保存，开始真实中文排版翻译…");}finally{window.confirm=confirm;}
  const p=useDirector.getState().createProject("qa-planar-live",useBoard.getState().activeId,"H3 中文写作验收");useDirector.getState().updateProject(p.id,{scenes:[{id:"sc",name:"白色摄影棚",segments:[{id:"seg",sceneId:"sc",summary:"女孩挥手",durationSec:4,dialogue:["你好，欢迎来到这里。"],shots:[],h3Authoring:{zh:"在纯白摄影棚里，一个成年女孩面向镜头微笑并挥手，用普通话说：<d>你好，欢迎来到这里。</d>。固定中景，四秒一个镜头，无配乐。",rules:"中英保持一个连续的 0–4 秒镜头，不增添任何剧情。"}}]} as any]});
  await draftEnglishH3(p.id,"seg",ctrl.signal);const seg=useDirector.getState().getById(p.id)!.scenes[0].segments[0];messages.push({authoring:seg.h3Authoring});write("中文稿：\n"+seg.h3Authoring?.reviewDraft+"\n英文稿：\n"+seg.h3Authoring?.enDraft);if(seg.h3Authoring?.problems?.length)throw Error(seg.h3Authoring.problems.join("；"));await adoptEnglishH3(p.id,"seg");write("真实 H3 结构、对白、参考和时间校验通过，英文稿采用成功。");
 }catch(e){messages.push({error:String(e)});write("未通过："+String(e));}finally{await fetch(endpoint+"/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({images,messages})});write("本次证据已保存。");}
};
