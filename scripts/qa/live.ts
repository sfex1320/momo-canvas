import { useSettings } from "../../src/core/stores/settingsStore";
import { useAgent } from "../../src/core/stores/agentStore";
import { useBoard } from "../../src/core/stores/boardStore";
import { sendAgentMessage, answerAgentQuestion, stopAssistant } from "../../src/core/agentEngine";
const report=document.querySelector("#report")!,endpoint="http://[::1]:1433";
document.querySelector<HTMLButtonElement>("#stop")!.onclick=stopAssistant;
document.querySelector<HTMLButtonElement>("#run")!.onclick=async event=>{
  const btn=event.currentTarget as HTMLButtonElement;btn.disabled=true;
  const log=(s:string)=>{report.textContent+=s+"\n";};
  try{
    if(location.hostname!=="[::1]")throw Error("请使用独立验收来源");
    const {settings,selected}=await(await fetch(endpoint+"/config")).json();
    useSettings.setState({settings});useBoard.getState().newBoard();
    useAgent.setState({mode:"agent",modelId:selected.chat,imageModelId:selected.image,webSearch:false,messages:[],summary:"",summaryUpto:0,attachments:[],referenceMode:"auto"});
    const images:string[]=[];
    for(const prompt of ["请实际生成一张1:1正方形1K测试海报：纯浅灰背景，中央一个红色立方体，无文字，无品牌。只生成1张。", "继续修改刚才生成的图：立方体改成蓝色，位置构图保持一致。请实际生成第二张图，1:1，1K，只生成1张。"]){
      log("发送："+prompt);useAgent.getState().setDraft(prompt);
      const seen=new Set<string>();const timer=setInterval(()=>{const s=useAgent.getState(),m=s.messages.at(-1);if(s.resolver&&m&&!seen.has(m.id+JSON.stringify(m.question))){seen.add(m.id+JSON.stringify(m.question));log("确认："+JSON.stringify(m.question));answerAgentQuestion(m.id,"确认生成，1张，1:1，1K");}},500);
      const unsubscribe=useAgent.subscribe(s=>{const m=s.messages.at(-1);const text=m?.steps?.at(-1)?.text;if(text&&!report.textContent?.endsWith(text+"\n"))log(text);});
      try{await sendAgentMessage();}finally{clearInterval(timer);unsubscribe();}
      const m=useAgent.getState().messages.filter(m=>m.role==="assistant").at(-1);log(m?.text??"");const src=m?.results?.[0]?.src;if(!src)throw Error("本轮没有交付图片");
      images.push(src);const img=new Image();img.src=src;img.style.width="320px";document.querySelector("#images")!.append(img);log(`第${images.length}张已交付，运行锁=${useAgent.getState().running}`);
    }
    await fetch(endpoint+"/save",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({images,messages:useAgent.getState().messages.map(m=>({role:m.role,text:m.text,results:m.results?.length}))})});
    log("完成：连续两轮真实服务生成均返回独立图片。");
  }catch(e){log("验收未通过："+String(e));}finally{log(JSON.stringify(await(await fetch(endpoint+"/report")).json(),null,2));}
};
