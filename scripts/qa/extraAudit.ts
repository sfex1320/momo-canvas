import { useBoard } from "../../src/core/stores/boardStore";
import { useDirector } from "../../src/core/stores/directorStore";
import { useAssets } from "../../src/core/stores/assetStore";
import { useDesign, emptyBrand } from "../../src/core/stores/designStore";
import { useSettings } from "../../src/core/stores/settingsStore";
import { useComfy } from "../../src/core/stores/comfyStore";
import { artboardSize, createArtboard, renderArtboard } from "../../src/core/artboard";
import { imageStudioPrompt, runImageStudio } from "../../src/core/studio/imageStudio";
import { jobCenter, useJobCenter } from "../../src/core/studio/jobCenter";
import { registerCapability, executeCapability, unregisterCapability } from "../../src/core/capability";
import { motionFrame, motionPreset, putMotionKey, sampleMotion } from "../../src/core/previzMotion";
import { StageEngine } from "../../src/modules/director/threed/stageEngine";
import { applyLocalRevision, replacementPlan } from "../../src/core/studio/localRevision";
import { videoDuration, recordSegments } from "../../src/core/videoEdit";
import { loadImg } from "../../src/core/maskCanvas";
import type { ArtboardSpec, PrevizEntity } from "../../src/core/types";

type Test=(name:string,run:()=>unknown|Promise<unknown>)=>Promise<void>;
function assert(v:unknown,msg:string):asserts v {if(!v)throw new Error(msg);}
export async function runExtraAudit(test:Test,image:string){
  await test("尺寸画板：尺寸、出血、安全区、PNG 与撤销",async()=>{
    const spec:ArtboardSpec={widthMm:254,heightMm:127,dpi:100,bleedMm:0,safeMm:10,scale:1,background:"#ffffff"};
    assert(artboardSize(spec).w===1000&&artboardSize(spec).h===500,"尺寸换算错误");
    const node=useBoard.getState().addNode("image",{x:50,y:40},{src:image,status:"done"});
    useBoard.getState().onNodesChange(useBoard.getState().nodes.map(n=>({type:"select",id:n.id,selected:n.id===node})));
    const group=createArtboard(spec);const result=await renderArtboard(group),img=await loadImg(result.png);
    assert(img.naturalWidth===1000&&img.naturalHeight===500,"导出尺寸错");assert(result.manifest.includes("x=0.00mm"),"尺寸清单偏移");
    useBoard.getState().undo();assert(!useBoard.getState().nodes.some(n=>n.id===group),"一次撤销没有移除画板");assert(!useBoard.getState().nodes.find(n=>n.id===node)?.parentId,"撤销后素材仍被包裹");
  });
  const p=useDirector.getState().createProject("qa-extra",useBoard.getState().activeId,"补全回归");
  await test("品牌规则按项目画布隔离，确认稿保持不变",()=>{
    useDesign.setState({brands:{[p.boardId]:{...emptyBrand(),name:"测试品牌",enabled:true,colors:["#d02020"],rules:"不要拉伸标志"}}});
    const params={mode:"t2i" as const,prompt:"产品图",inputAssetIds:[],engine:"provider" as const};
    const compiled=imageStudioPrompt(p.id,params);assert(compiled.includes("不要拉伸标志"),"品牌未进入最终稿");
    useDesign.setState({brands:{}});assert(compiled.includes("测试品牌")&&!imageStudioPrompt(p.id,params).includes("测试品牌"),"品牌串台或快照改变");
  });
  await test("AI 制图：连续生成、完整历史、缺失参考阻止提交",async()=>{
    const a=await useAssets.getState().collect({src:image,kind:"image",name:"制图参考"});assert(a,"参考入库失败");
    const params={mode:"i2i" as const,prompt:"保留产品形状",inputAssetIds:[a.id],engine:"provider" as const,providerModelKey:"qa::gpt-image-1",n:1,aspect:"16:9",negative:"不要多余文字",seed:42,confirmed:true};
    const r1=await runImageStudio(p.id,params),r2=await runImageStudio(p.id,{...params,inputAssetIds:r1.assetIds,prompt:"改成蓝色"});
    assert(r1.assetIds.length===1&&r2.assetIds.length===1,"第二张图未完成");assert(r1.record.params.seed===42&&r1.record.params.negative===params.negative&&r1.record.params.n===1,"历史漏参数");
    let failed=false;try{await runImageStudio(p.id,{...params,inputAssetIds:["deleted-ref"]});}catch{failed=true;}
    assert(failed,"丢失参考静默降级");assert(useJobCenter.getState().jobs[0].status==="failed","异常任务未结束");
  });
  await test("AI 制图 ComfyUI：旧正负提示词被实际工位请求替换",async()=>{
    const original=window.fetch;let submitted:any;let failure="";
    window.fetch=async(input,init)=>{const url=String(input);if(url==="https://qa.invalid/comfy/object_info")return Response.json({CLIPTextEncode:{input:{required:{text:["STRING"]}},output:["IMAGE"]},SaveImage:{input:{required:{images:["IMAGE"]}},output:[]}});if(url==="https://qa.invalid/comfy/prompt"){submitted=JSON.parse(String(init?.body));return Response.json({error:"测试仅捕获提交，不执行模型"},{status:400});}return original(input,init);};
    const id="qa-image-template";
    useComfy.setState({templates:[{id,name:"模拟制图配方",createdAt:0,workflow:{"1":{class_type:"CLIPTextEncode",inputs:{text:"旧正面"}},"2":{class_type:"CLIPTextEncode",inputs:{text:"旧负面"},_meta:{title:"negative"}},"3":{class_type:"SaveImage",inputs:{images:["1",0]}}},params:[{key:"1.text",nodeId:"1",input:"text",kind:"text",label:"正面",value:"旧正面"},{key:"2.text",nodeId:"2",input:"text",kind:"text",label:"负面",value:"旧负面"}],outputNodeId:"3"}]});
    useSettings.setState(s=>({settings:{...s.settings,comfy:{...s.settings.comfy,host:"https://qa.invalid/comfy"}}}));
    useDirector.getState().updateProject(p.id,{recipes:[{id:"qa-recipe",name:"测试图片",templateId:id,engine:"local",output:"image",defaultParams:{"1.text":"配方旧词","2.text":"配方旧负向"}} as any]});
    try{await runImageStudio(p.id,{mode:"t2i",prompt:"新正面",negative:"新负向",inputAssetIds:[],engine:"comfy",recipeId:"qa-recipe"});}catch(e){ failure=String(e); }finally{window.fetch=original;}
    assert(submitted?.prompt?.["1"]?.inputs.text.includes("新正面"),"最终正面稿未进入 /prompt："+failure);assert(submitted.prompt["2"].inputs.text==="新负向","负向漏传");
  });
  await test("任务取消后，迟到的完成和失败不能覆盖终态",()=>{
    const job=jobCenter.begin({kind:"image",label:"取消竞态"});job.cancel();job.done();job.fail("迟到错误");assert(useJobCenter.getState().jobs.find(j=>j.id===job.id)?.status==="cancelled","取消终态被覆盖");
  });
  await test("能力失败可再次执行，成功幂等按能力隔离",async()=>{
    let count=0;const id="qa.retry";
    registerCapability({id,title:"回归",description:"回归",risk:"read",inputSchema:{type:"object",properties:{}},validate:()=>({}),confirm:()=>({type:"none"}),idemKey:()=>"same",run:()=>{count++;if(count===1)throw new Error("首次失败");return {text:"成功"};}});
    try{assert((await executeCapability(id,{}, {channel:"assistant"})).kind==="error","首次应失败");assert((await executeCapability(id,{}, {channel:"assistant"})).kind==="done","失败被缓存无法重试");await executeCapability(id,{}, {channel:"assistant"});assert(count===2,"成功重复执行");}finally{unregisterCapability(id);}
  });
  await test("已停止的能力不触发任何副作用",async()=>{
    let calls=0;const id="qa.cancel",controller=new AbortController();controller.abort();registerCapability({id,title:"回归",description:"回归",risk:"read",inputSchema:{type:"object",properties:{}},validate:()=>({}),confirm:()=>({type:"none"}),run:()=>{calls++;return {text:"不应执行"};}});
    try{await executeCapability(id,{}, {channel:"assistant",signal:controller.signal});}catch{ /* 已停止 */ }finally{unregisterCapability(id);}assert(calls===0,"停止后仍执行");
  });
  const entity:PrevizEntity={id:"motion-test",name:"测试角色",kind:"character",preset:"male",color:"#35aaff",x:50,y:50,angle:0,pos:[0,0,0],rotDeg:[0,350,0],scale3:[1,1,1]};
  await test("关键帧插值：位置、角度跨零、实体独立和覆盖同帧",()=>{
    const e=putMotionKey(entity,{time:2,pos:[4,0,0],rotDeg:[0,10,0],scale3:[2,2,2]});const f=motionFrame(e,1);
    assert(f.pos[0]===2&&f.rotDeg[1]===360&&f.scale3[0]===1.5,"插值错误");assert(sampleMotion([e,{...entity,id:"static"}],1)[1].pos![0]===0,"静态实体被带走");assert(putMotionKey(e,{...f,time:2}).motion?.length===1,"同时间产生重复帧");
  });
  await test("轨迹模板：机位推进与环拍保持目标关系",()=>{
    const camera={...entity,kind:"camera" as const,pos:[0,1.5,5] as [number,number,number],rotDeg:[0,180,0] as [number,number,number]};
    const push=motionPreset(camera,"push",4);assert(motionFrame(push,4).pos[2]===3,"机位推进方向错误");const orbit=motionPreset(camera,"orbit",4);assert(orbit.motion?.length===9&&Math.abs(Math.hypot(...[orbit.motion[8].pos[0],orbit.motion[8].pos[2]])-5)<0.001,"环拍半径错误");
  });
  await test("局部替换区间：截断长素材，拒绝短素材与越界",()=>{
    assert(replacementPlan(10,2,5,4).length===3,"区间时长错误");for(const args of [[10,2,5,1],[10,-1,5,6],[10,2,11,12]]){let failed=false;try{replacementPlan(...args as [number,number,number,number]);}catch{failed=true;}assert(failed,"无效替换未阻断");}
  });
  await test("3D 动态录制→视频时长→局部合成真实浏览器流程",async()=>{
    const host=document.createElement("div");host.style.cssText="width:480px;height:320px";const canvas=document.createElement("canvas");host.append(canvas);document.body.append(host);const engine=new StageEngine(canvas,{onPick:()=>{},onTransformCommit:()=>{}});
    let url:string|undefined,out:string|undefined;
    try{const blob=await engine.recordMotion([motionPreset(entity,"move",1)],1,"16:9",new AbortController().signal,()=>{});assert(blob.size>100,"录制为空");url=URL.createObjectURL(blob);const duration=await videoDuration(url);assert(duration>0.5&&duration<2,"录制视频时长无效："+duration);out=await recordSegments([{src:url,start:0,end:.3},{src:url,start:.4,end:.8}],()=>{},new AbortController().signal);assert(await videoDuration(out)>.4,"局部合成没有视频时长");
      const source=await useAssets.getState().collect({src:url,kind:"video",name:"原版测试视频"});assert(source,"视频入库失败");
      useDirector.getState().updateProject(p.id,{scenes:[{id:"revision-scene",location:"测试",segments:[{id:"revision-segment",summary:"局部修订测试",approvedTakeId:"original-take",takes:[{id:"original-take",segmentId:"revision-segment",kind:"video",target:"clip",status:"done",assetId:source.id,promptSnapshot:"原版提示词",approved:true,createdAt:0}]}]} as any]});
      const revised=await applyLocalRevision({projectId:p.id,segmentId:"revision-segment",takeId:"original-take",replacementId:source.id,start:.2,end:.5,signal:new AbortController().signal,onProgress:()=>{}});
      const segment=useDirector.getState().getById(p.id)!.scenes[0].segments[0];assert(segment.approvedTakeId==="original-take"&&segment.takes!.length===2,"局部修订覆盖了原版或采用状态");assert(revised.derivedFrom?.takeId==="original-take"&&revised.assetId!==source.id,"派生版本缺少溯源");}finally{engine.dispose();host.remove();if(url)URL.revokeObjectURL(url);if(out)URL.revokeObjectURL(out);}
  });
}
