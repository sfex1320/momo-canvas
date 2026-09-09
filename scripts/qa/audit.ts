import { runExtraAudit } from "./extraAudit";
import { useBoard } from "../../src/core/stores/boardStore";
import { useSettings } from "../../src/core/stores/settingsStore";
import { useAgent } from "../../src/core/stores/agentStore";
import { useDirector } from "../../src/core/stores/directorStore";
import { useSkills } from "../../src/core/stores/skillStore";
import { sendAgentMessage, stopAssistant, answerAgentQuestion } from "../../src/core/agentEngine";
import { createStoryboardGroup, splitGridCells } from "../../src/core/nodeEdit";
import { layerGroupForExport } from "../../src/core/elementSplit";
import { flatElementsToCanvas } from "../../src/core/elementFlat";
import { flatOutputSize, convertFlatUnit } from "../../src/core/elementFlatPlan";
import { pngDataUrlWithDpi } from "../../src/core/pngDpi";
import { createScenePreset, SCENE_PRESETS } from "../../src/modules/director/threed/scenePresets";
import { pixelGrid } from "../../src/core/gridGeometry";
import { stitchGrid } from "../../src/core/stitchCanvas";
import { loadImg } from "../../src/core/maskCanvas";
import { generationRefs, waitAgentTurn } from "../../src/core/agentTurn";
import { normalizeAgentAction } from "../../src/core/agentProtocol";
import { nextStudioStep } from "../../src/core/studio/nextStep";
import { StageEngine } from "../../src/modules/director/threed/stageEngine";
import { stageFrame } from "../../src/modules/director/threed/stageFraming";
import type { AgentAction } from "../../src/core/agentProtocol";
import type { ElementFlatOptions, PrevizEntity } from "../../src/core/types";

const report = document.querySelector<HTMLPreElement>("#report")!;
const write = (s: string) => { report.textContent += s + "\n"; };
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const timeout = async (test: () => boolean) => { for (let i=0;i<500;i++) { if(test()) return; await delay(10); } throw new Error("等待超时"); };
function fixture(w: number, h: number, color?: string) {
  const c = document.createElement("canvas"); c.width=w; c.height=h; const ctx=c.getContext("2d")!;
  if (color) { ctx.fillStyle=color; ctx.fillRect(0,0,w,h); }
  else { const px=ctx.createImageData(w,h); for(let y=0;y<h;y++) for(let x=0;x<w;x++){ const i=(y*w+x)*4; px.data.set([x%256,y%256,(x+y)%256,255],i); } ctx.putImageData(px,0,0); }
  return c.toDataURL();
}
async function pixels(src: string) { const img=await loadImg(src); const c=document.createElement("canvas"); c.width=img.naturalWidth;c.height=img.naturalHeight; const ctx=c.getContext("2d")!;ctx.drawImage(img,0,0);return ctx.getImageData(0,0,c.width,c.height); }

document.querySelector<HTMLButtonElement>("#run")!.onclick = async event => {
  const button=event.currentTarget as HTMLButtonElement;button.disabled=true;report.textContent="";
  // 测试必须使用独立来源，避免把测试画布写入普通预览来源。
  if (location.hostname !== "[::1]") { write("请在 http://[::1]:1430/scripts/qa/audit.html 运行本页");button.disabled=false;return; }
  const nativeFetch=window.fetch.bind(window), nativeConfirm=window.confirm;
  let actions: AgentAction[] = [], requests: Array<{ url: string; body: any }> = [], imageCount=0;
  const image1=fixture(64,64,"#f02040"), image2=fixture(64,64,"#2050fa"), image3=fixture(64,64,"#30cc80");
  window.fetch = async (input, init) => {
    const url=String(input);
    if(url.startsWith("data:") || url.startsWith("blob:")) return nativeFetch(input,init);
    if(!url.startsWith("https://qa.invalid/")) throw new Error(`测试阻断非模拟请求 ${url.split('?')[0]}`);
    if(init?.signal?.aborted) throw new Error("已取消");
    const body=typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    requests.push({url,body});
    if(url.endsWith("/chat/completions")) {
      const action=actions.shift(); if(!action) throw new Error("模拟动作队列已耗尽");
      const chunk=JSON.stringify({choices:[{delta:{content:JSON.stringify(action)}}]});
      return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`,{headers:{"content-type":"text/event-stream"}});
    }
    if(url.includes("/images/")) { const src=[image1,image2,image3][imageCount++%3]; return Response.json({data:[{b64_json:src}]}); }
    throw new Error("未定义的模拟端点："+url);
  };
  window.confirm=()=>true;
  let passed=0, failed=0;
  const test=async(name:string, fn:()=>unknown|Promise<unknown>)=>{try{await fn();passed++;write("通过 · "+name);}catch(e){failed++;write("失败 · "+name+"\n"+String(e));}};
  try {
    useBoard.getState().newBoard();
    const settings=useSettings.getState().settings;
    useSettings.setState({settings:{...settings,models:{...settings.models,providers:[{id:"qa",name:"模拟模型",baseUrl:"https://qa.invalid/v1",apiKey:"",models:{chat:{protocol:"openai",models:["gpt-4o"]},image:{protocol:"openai",models:["gpt-image-1"]},video:{protocol:"openai",models:[]},audio:{protocol:"openai",models:[]},asr:{protocol:"openai",models:[]}}}],defaults:{chat:"qa::gpt-4o",image:"qa::gpt-image-1"}},budget:{dailyCap:0,perRunCap:0,confirmOverCost:0}}});
    useAgent.setState({mode:"agent",webSearch:false,modelId:"qa::gpt-4o",imageModelId:"qa::gpt-image-1",messages:[],summary:"",summaryUpto:0,running:false,resolver:null});
    await test("非整除、非均匀宫格逐像素重拼完全一致",async()=>{
      const original=fixture(1024,769);const cells=await splitGridCells(original,[1/3,0.78],[0.21,2/3]);
      const stitched=await stitchGrid(cells.map(c=>c.dataUrl),3);
      const a=await pixels(original), b=await pixels(stitched.dataUrl);
      assert(a.width===b.width&&a.height===b.height,"尺寸改变");assert(a.data.every((v,i)=>v===b.data[i]),"拼接像素不一致");
      const img=new Image();img.src=stitched.dataUrl;img.alt="无缝重拼结果";document.querySelector("#fixtures")!.replaceChildren(img);
    });
    await test("无缝分镜组尺寸相接且不吞用户原选节点",async()=>{
      const id=useBoard.getState().addNode("image",{x:0,y:0},{src:fixture(1024,1024),status:"done"});
      await createStoryboardGroup(id,Array.from({length:9},(_,i)=>`${Math.floor(i/3)}-${i%3}`),[1/3,2/3],[1/3,2/3]);
      const group=useBoard.getState().nodes.find(n=>(n.data as any).storyOrder?.length===9)!;assert(group,"未成组");
      const tiles=(group.data as any).storyOrder.map((id:string)=>useBoard.getState().nodes.find(n=>n.id===id)!);
      assert(tiles[1].position.x===tiles[0].position.x+tiles[0].data.tileSize.w,"横向错缝");
      assert(tiles[3].position.y===tiles[0].position.y+tiles[0].data.tileSize.h,"纵向错缝");assert(!useBoard.getState().nodes.find(n=>n.id===id)?.parentId,"源图误入组");
    });
    await test("异常切线归一化，没有零宽切片",()=>assert(pixelGrid(20,20,[NaN,0,1,0.5,0.5,-1],[]).every(c=>c.w>0&&c.h>0),"出现零宽切片"));
    const imageAction=(prompt:string,refs=false):AgentAction=>({action:"image",prompt,count:1,aspect:"1:1",resolution:"1K",useRefs:refs});
    const confirmTurn=async(text:string,seq:AgentAction[])=>{
      actions=seq;useAgent.setState({draft:text});const task=sendAgentMessage();
      await timeout(()=>!!useAgent.getState().resolver||!useAgent.getState().running);
      assert(useAgent.getState().resolver,"没有出现确认卡");
      const id=useAgent.getState().messages.at(-1)!.id;
      answerAgentQuestion("过期消息", "确认生成");assert(useAgent.getState().resolver,"旧卡片错误唤醒新任务");
      useAgent.getState().setDraft("确认生成");await sendAgentMessage();await task;
    };
    await test("首轮生图：自由输入确认后真实交付",async()=>{
      await confirmTurn("生成红色正方形海报 1K",[imageAction("红色海报"),{action:"reply",text:"已完成"}]);
      assert(useAgent.getState().messages.at(-1)?.results?.[0]?.src===image1,"首轮没有真实图片");assert(!useAgent.getState().running,"运行锁未释放");
    });
    await test("连续第二次生图：口头承诺被复核，上一轮图片作为真实参考",async()=>{
      await confirmTurn("把刚才图片改成蓝色，重新生成",[{action:"reply",text:"下一轮会自动生成"},imageAction("蓝色海报",true),{action:"reply",text:"第二张已完成"}]);
      const m=useAgent.getState().messages.at(-1)!;assert(m.results?.[0]?.src===image2,"错误复用首轮结果");
      const edit=requests.find(r=>r.url.endsWith("/images/edits"));assert(edit?.body instanceof FormData,"未发图生图请求");
      const files=[...edit.body.values()].filter(v=>v instanceof Blob) as Blob[];assert(files.length===1,"参考混入旧图");
      assert(await files[0].text()===await(await nativeFetch(image1)).text(),"没有传上一轮成图");
    });
    await test("确认中停止，解除等待锁，再开始第三轮生成",async()=>{
      actions=[imageAction("取消稿")];useAgent.setState({draft:"再画一张"});const task=sendAgentMessage();await timeout(()=>!!useAgent.getState().resolver);const before=imageCount;stopAssistant();await task;
      assert(!useAgent.getState().running&&!useAgent.getState().resolver&&before===imageCount,"取消仍然扣费或卡锁");
      await confirmTurn("重新生成绿色",[imageAction("绿色海报"),{action:"reply",text:"完成"}]);assert(useAgent.getState().messages.at(-1)?.results?.[0]?.src===image3,"取消后不能再生图");
    });
    await test("新附件优先；跨轮视频可引用最近成图",()=>{
      assert(generationRefs([{role:"user",images:[image1]},{role:"assistant",results:[{kind:"image",src:image2}]},{role:"user"}])[0]===image2,"跨轮丢参考");
      assert(generationRefs([{role:"assistant",results:[{kind:"image",src:image2}]},{role:"user",images:[image3]}])[0]===image3,"旧图覆盖新附件");
    });
    await test("动作字段异常值归一化",()=>{
      const a=normalizeAgentAction({action:"image",prompt:"图",useRefs:"false",count:Infinity});assert(a?.action==="image"&&!a.useRefs&&!a.count,"异常值漏过");
      assert(normalizeAgentAction({action:"video",prompt:"图",duration:6})?.action==="video","数值时长丢失");
    });
    await test("取消未返回网络请求不会继续执行",async()=>{const c=new AbortController();const task=waitAgentTurn(new Promise(()=>{}),c.signal);c.abort();await task.then(()=>{throw Error("未取消")},()=>{});});
    await test("PSD 图层预览按原位合成",async()=>{
      const state=useBoard.getState();const a=state.addNode("image",{x:0,y:0},{src:fixture(64,64,"#ffffff"),status:"done",elemMeta:{role:"decoration",box:[0,0,1,1]}});
      const b=state.addNode("image",{x:100,y:0},{src:fixture(16,16,"#ff0000"),status:"done",elemMeta:{role:"subject",box:[0,0,0.25,0.25]}});
      useBoard.getState().onNodesChange(useBoard.getState().nodes.map(n=>({type:"select",id:n.id,selected:[a,b].includes(n.id)})));useBoard.getState().groupSelected();
      const gid=useBoard.getState().nodes.find(n=>n.id===a)!.parentId!;const output=await layerGroupForExport(gid);const px=await pixels(output!.composite);assert(px.data[1]===0&&px.data[(32*64+32)*4+1]===255,"元素被错误居中");
    });
    const flat:ElementFlatOptions={view:"back",backColor:"#123456",bottomColor:"#eeeeee",background:"#fefefe",transparent:false,width:80,height:60,unit:"mm",dpi:100};
    await test("毫米画板换算及超限阻断",()=>{assert(flatOutputSize(flat).w===315,"毫米换算错误");let rejected=false;try{flatOutputSize({...flat,width:999999})}catch{rejected=true}assert(rejected,"超大尺寸未阻断");});
    await test("元素拆解调用真实适配器并输出指定像素尺寸",async()=>{
      const id=useBoard.getState().addNode("image",{x:0,y:0},{src:image1,status:"done"});
      assert(await flatElementsToCanvas(id,[{id:"piece",name:"文化墙圆形徽章",role:"decoration",box:[0,0,1,1]}],flat),"拆解执行失败");
      const output=useBoard.getState().nodes.find(n=>(n.data as any).flatMeta?.sourceNodeId===id);assert(output,"没有拆件节点");const px=await pixels((output!.data as any).src);assert(px.width===315&&px.height===236,"最终尺寸失效");
      const req=requests.filter(r=>r.url.endsWith("/images/edits")).at(-1);assert(String(req?.body.get("prompt")).includes("#123456"),"背面颜色未传模型");
    });
    await test("本轮不用旧图：即使模型要求参考也不发送历史图片",async()=>{
      useAgent.setState({referenceMode:"none",attachments:[]});const before=requests.length;
      await confirmTurn("全新生成，不参考之前的图片",[imageAction("全新设计",true),{action:"reply",text:"完成"}]);
      const calls=requests.slice(before).filter(r=>r.url.includes("/images/"));
      assert(calls.length===1&&calls[0].url.endsWith("/images/generations"),"仍然发送历史图片");
      assert(useAgent.getState().messages.filter(m=>m.role==="user").at(-1)?.referenceMode==="none","本轮策略未保存");
      assert(useAgent.getState().referenceMode==="auto","一次性选择错误影响下一轮");
    });
    await test("毫米/像素来回切换保持输出尺寸",()=>{
      const px={...flat,unit:"px" as const,width:1024,height:768,dpi:150};
      const converted=convertFlatUnit(convertFlatUnit(px,"mm"),"px");
      assert(converted.width===1024&&converted.height===768,"切换单位改变了图片尺寸");
    });
    await test("PNG 写入 DPI：像素不变、只保留一个物理尺寸块",async()=>{
      const input=fixture(31,23);const output=pngDataUrlWithDpi(pngDataUrlWithDpi(input,150),300);
      const a=await pixels(input),b=await pixels(output);assert(a.data.every((v,i)=>v===b.data[i]),"DPI 写入改变像素");
      const bytes=Uint8Array.from(atob(output.split(',')[1]),c=>c.charCodeAt(0));const v=new DataView(bytes.buffer);let count=0;
      for(let o=8;o<bytes.length;o+=v.getUint32(o)+12){if(String.fromCharCode(...bytes.slice(o+4,o+8))==="pHYs"){count++;assert(v.getUint32(o+8)===11811&&v.getUint32(o+12)===11811&&bytes[o+16]===1,"DPI 元数据不正确");}}
      assert(count===1,"重复的尺寸块");
    });
    await test("三套场景模板有独立实体、完整机位灯光、平移保持站位",()=>{
      let serial=0;for(const preset of SCENE_PRESETS){const a=createScenePreset(preset.id,()=>`preset-${serial++}`);const b=createScenePreset(preset.id,()=>`preset-${serial++}`,20);
        assert(a.some(e=>e.kind==="camera")&&a.some(e=>e.kind==="light"),"模板缺机位/灯光");
        assert(new Set([...a,...b].map(e=>e.id)).size===a.length+b.length,"模板实体 ID 重复");
        assert(a.every((e,i)=>b[i].pos![0]-e.pos![0]===20&&b[i].pos![2]===e.pos![2]),"平移改变相对站位");
      }
    });
    await test("内置元素拆解技能可发现",async()=>{await useSkills.getState().init();assert(useSkills.getState().skills.some(s=>s.id==="builtin-element-decompose"),"技能未注册");});
    await test("导演台导引：空项目、在途、采用、交付",()=>{
      const p=useDirector.getState().createProject("qa-director",useBoard.getState().activeId,"流程测试");assert(nextStudioStep(p).station==="scripts","空态入口错误");
      const seg:any={id:"s1",summary:"测试分镜",takes:[{id:"t1",status:"done"}],approvedTakeId:undefined};p.scenes=[{id:"sc",location:"测试场景",segments:[seg]}];assert(nextStudioStep(p).label==="挑选采用版本","漏过选片");
      seg.approvedTakeId="t1";assert(nextStudioStep(p).station==="post","采用后未引导交付");seg.takes.push({id:"t2",status:"running"});assert(nextStudioStep(p).label==="查看生成进度","在途重复引导生成");
    });
    await test("3D 横竖画幅取景与导出使用同一矩形",()=>{
      for (const aspect of ["16:9","9:16","1:1","4:3"]) {
        const r=stageFrame(1280,720,aspect);const [a,b]=aspect.split(":").map(Number);
        assert(r.w<=1280*.62+1&&r.h<=720*.7+1,"取景溢出");
        assert(Math.abs(r.w/r.h-a/b)<.01,"取景画幅错误");
      }
    });
    await test("3D 模型加载后已删除实体不会复活",async()=>{
      const host=document.createElement("div");host.style.cssText="width:400px;height:300px";const canvas=document.createElement("canvas");host.append(canvas);document.body.append(host);
      const engine=new StageEngine(canvas,{onPick:()=>{},onTransformCommit:()=>{}});
      // 用延迟 GLB 回调复现“加载中删除”，不访问任何真实模型文件。
      let loaded: ((g:any)=>void)|undefined;const internal=engine as any;
      internal.gltfLoader.load=(_url:string,ok:(g:any)=>void)=>{loaded=ok};
      const e:PrevizEntity={id:"glb",kind:"prop",name:"测试模型",preset:"glb",modelAssetPath:"qa.glb",color:"#ffffff",x:50,y:50,angle:0};engine.syncEntities([e]);engine.syncEntities([]);
      const THREE=await import("three");loaded!({scene:new THREE.Group()});assert(internal.entities.size===0,"删除的模型复活");engine.dispose();host.remove();
    });
    await runExtraAudit(test,image1);
  } finally { window.fetch=nativeFetch;window.confirm=nativeConfirm;button.disabled=false;write(`\n结束：${passed} 通过，${failed} 失败。全部模型响应为模拟，未进行付费生成。`); }
};
