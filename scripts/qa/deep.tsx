import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ReactFlowProvider,useReactFlow} from '@xyflow/react';
import * as THREE from 'three';
import {clone} from 'three/examples/jsm/utils/SkeletonUtils.js';
import {GLTFExporter} from 'three/examples/jsm/exporters/GLTFExporter.js';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {SkeletalRig,sampleBoneKeys} from '../../src/modules/director/threed/skeletalRig';
import {alphaContours,cutlineSvg} from '../../src/core/cutline';
import {useBoard} from '../../src/core/stores/boardStore';
import {useSettings} from '../../src/core/stores/settingsStore';
import {useAgent} from '../../src/core/stores/agentStore';
import {voiceInputOnce,stopVoiceCall,voiceState,startVoiceCall} from '../../src/core/voiceChat';
import {SmartCanvas} from '../../src/modules/canvas/SmartCanvas';
import {runComfyTemplate} from '../../src/core/services/comfy';
import {saveJSON,loadJSON} from '../../src/core/persist';
import '../../src/styles/theme.css';import '../../src/styles/base.css';
if(location.hostname!=='[::1]')throw Error('独立验收来源限定');
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const check=(v:unknown,m:string)=>{if(!v)throw Error(m);};
const entity:any={id:'rig-qa',name:'骨骼测试',kind:'character',preset:'glb',color:'#bbbbbb',x:0,y:0,angle:0};
const results:Array<any>=[];
async function test(name:string,fn:()=>Promise<unknown>|unknown,write:(s:string)=>void){const t=performance.now();try{const detail=await fn();results.push({name,passed:true,ms:Math.round(performance.now()-t),detail});write('通过 · '+name+' '+JSON.stringify(detail??''));}catch(e){results.push({name,passed:false,error:String(e)});write('失败 · '+name+' '+String(e));}}
async function logic(write:(s:string)=>void){
  await test('刀线外轮廓、孔洞、毫米尺寸与复杂度上限',()=>{const w=20,h=16,a=new Uint8ClampedArray(w*h*4);for(let y=2;y<14;y++)for(let x=2;x<18;x++)if(!(x>=7&&x<12&&y>=6&&y<10))a[(y*w+x)*4+3]=255;const loops=alphaContours(a,w,h);check(loops.length===2&&loops.every(l=>l.length===4),'孔洞或外框丢失');check(cutlineSvg(loops,w,h,100,80).includes('width="100mm"'),'毫米错误');const noise=new Uint8ClampedArray(400*400*4);for(let i=0;i<160000;i++)if(((i%400)+Math.floor(i/400))%2)noise[i*4+3]=255;let blocked=false;try{alphaContours(noise,400,400);}catch{blocked=true;}check(blocked,'噪点图未受限');return{loops:loops.length};},write);
  await test('真实 GLB 导出再导入：骨骼动画、倒放采样、实例隔离',async()=>{
    const scene=new THREE.Scene(),root=new THREE.Bone(),arm=new THREE.Bone();root.name='Hips';arm.name='Arm';arm.position.y=1;root.add(arm);scene.add(root);
    const geometry=new THREE.BoxGeometry(.2,1,.2),n=geometry.attributes.position.count;const indices=new Uint16Array(n*4),weights=new Float32Array(n*4);for(let i=0;i<n;i++){indices[i*4]=geometry.attributes.position.getY(i)>0?1:0;weights[i*4]=1;}geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(indices,4));geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(weights,4));const mesh=new THREE.SkinnedMesh(geometry,new THREE.MeshStandardMaterial());mesh.add(root);mesh.bind(new THREE.Skeleton([root,arm]));scene.add(mesh);
    const clip=new THREE.AnimationClip('挥手',2,[new THREE.NumberKeyframeTrack('Arm.rotation[z]',[0,2],[0,Math.PI/2])]);
    // glTF 动画用四元数轨导出，确保生产加载器能回读。
    clip.tracks=[new THREE.QuaternionKeyframeTrack('Arm.quaternion',[0,2],[0,0,0,1,0,0,Math.sin(Math.PI/4),Math.cos(Math.PI/4)])];
    const bytes=await new GLTFExporter().parseAsync(scene,{binary:true,animations:[clip]}) as ArrayBuffer;
    const parsed=await new GLTFLoader().parseAsync(bytes,'');
    // 导出带蒙皮与动作的 GLB，再从真实加载结果克隆两个实例。
    const a=new SkeletalRig(clone(parsed.scene),parsed.animations),b=new SkeletalRig(clone(parsed.scene),parsed.animations);
    a.sample({...entity,animationTime:1,skeletal:{clip:'挥手',loop:false}});check(Math.abs(a.bones[1].bone.rotation.z-Math.PI/4)<.01,'动作采样错误');
    a.sample({...entity,animationTime:2,skeletal:{clip:'挥手',loop:false}});a.sample({...entity,animationTime:.5,skeletal:{clip:'挥手',loop:false}});check(Math.abs(a.bones[1].bone.rotation.z-Math.PI/8)<.01,'倒放失败');check(b.bones[1].bone.rotation.z===0,'实例共享骨骼');
    a.sample({...entity,animationTime:1,skeletal:{keys:[{time:2,bones:{'1':[0,0,90]}}]}});check(Math.abs(a.bones[1].bone.rotation.z-Math.PI/4)<.01,'局部姿态关键帧未应用');
    check(parsed.animations.length===1,'GLB 动画未回读');a.dispose();b.dispose();scene.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();(o.material as THREE.Material).dispose();}});
    check(Math.abs(sampleBoneKeys({bones:{'0':[0,170,0]},keys:[{time:2,bones:{'0':[0,-170,0]}}]},1)['0'][1]-180)<.01,'跨零旋转错误');return{glbBytes:bytes.byteLength};
  },write);
  await test('语音录音：等待最后 dataavailable，挂断隔离迟到识别',async()=>{
    const oldFetch=window.fetch,oldRecorder=window.MediaRecorder,oldContext=window.AudioContext,oldGet=navigator.mediaDevices.getUserMedia;
    let loudUntil=0,received='',release:((r:Response)=>void)|undefined;
    class Recorder {static isTypeSupported(){return true;}state='inactive';mimeType='audio/webm';ondataavailable:any;onstop:any;onerror:any;start(){this.state='recording';this.ondataavailable?.({data:new Blob(['开头'])});}stop(){this.state='inactive';setTimeout(()=>{this.ondataavailable?.({data:new Blob(['最后音频块'])});this.onstop?.(new Event('stop'));},60);}}
    class Context {createAnalyser(){return{fftSize:1024,getByteTimeDomainData:(a:Uint8Array)=>a.fill(performance.now()<loudUntil?145:128)};}createMediaStreamSource(){return{connect(){}};}resume(){return Promise.resolve();}close(){return Promise.resolve();}}
    (window as any).MediaRecorder=Recorder;(window as any).AudioContext=Context;
    navigator.mediaDevices.getUserMedia=async()=>({getTracks:()=>[{stop(){}}]}) as any;
    useSettings.setState(s=>({settings:{...s.settings,models:{...s.settings.models,providers:[{id:'voice-qa',name:'模拟 ASR',baseUrl:'https://voice.qa.invalid',apiKey:'fixture',models:{asr:{models:['whisper-1'],protocol:'openai'}}} as any],defaults:{...s.settings.models.defaults,asr:'voice-qa::whisper-1'}}}}));
    window.fetch=async(_input,init)=>{received=await (init!.body as FormData).get('file')!.text();return new Promise< Response>(r=>{release=r;});};
    try{useAgent.getState().setDraft('原草稿');loudUntil=performance.now()+150;const pending=voiceInputOnce();for(let i=0;i<200&&!release;i++)await delay(15);check(received==='开头最后音频块','最后一块音频丢失，实际请求='+received);stopVoiceCall();release?.(Response.json({text:'迟到文本'}));await pending;check(useAgent.getState().draft==='原草稿'&&voiceState().phase==='idle','挂断后回填');
      let acquire:((s:MediaStream)=>void)|undefined,stopped=0,calls=0;navigator.mediaDevices.getUserMedia=()=>{calls++;return new Promise(r=>acquire=r);};const first=startVoiceCall();await startVoiceCall();stopVoiceCall();acquire?.({getTracks:()=>[{stop(){stopped++;}}]} as any);await first;check(calls===1&&stopped===1,'重复申请或迟到设备未释放');
    }finally{stopVoiceCall();window.fetch=oldFetch;window.MediaRecorder=oldRecorder;window.AudioContext=oldContext;navigator.mediaDevices.getUserMedia=oldGet;}
  },write);
  await saveJSON('deep-qa.json','result',results);
}
function Main(){const [log,setLog]=useState(''),[busy,setBusy]=useState(false),flow=useReactFlow();const write=(s:string)=>setLog(x=>x+s+'\n');
  const run=async(fn:()=>Promise<void>)=>{setBusy(true);try{await fn();}finally{setBusy(false);}};
  const perf=async()=>{await test('5000 节点画布：视口裁剪、100次平移、状态保存',async()=>{
    useBoard.getState().newBoard();useBoard.getState().setViewport({x:0,y:0,zoom:1});const nodes=Array.from({length:5000},(_,i)=>({id:'perf-'+i,type:'prompt' as const,position:{x:i%100*300,y:Math.floor(i/100)*200},width:260,height:140,measured:{width:260,height:140},data:{text:'性能节点 '+i,status:'idle' as const}}));
    const start=performance.now();useBoard.setState({nodes,edges:[]});await delay(1800);await flow.setViewport({x:0,y:0,zoom:1});await delay(1200);write('视口状态 '+JSON.stringify({initialized:flow.viewportInitialized,viewport:flow.getViewport()}));const rendered=document.querySelectorAll('.react-flow__node').length;check(rendered<100,'离屏节点未充分裁剪，实际='+rendered);
    const gaps:number[]=[];let last=performance.now();for(let i=0;i<100;i++){await flow.setViewport({x:-(i%10)*300,y:-Math.floor(i/10)*200,zoom:1});await delay(30);gaps.push(performance.now()-last);last=performance.now();}
    check(useBoard.getState().nodes.length===5000,'裁剪丢数据');await saveJSON('perf-qa.json','v1',nodes);const restored=await loadJSON<any[]>('perf-qa.json','v1');check(restored?.length===5000,'持久化丢节点');return{rendered,total:5000,elapsedMs:Math.round(performance.now()-start),p95TickMs:Math.round(gaps.sort((a,b)=>a-b)[95])};
  },write);await saveJSON('deep-qa.json','result',results);};
  return <><nav style={{height:46,display:'flex',gap:8,padding:6}}><button disabled={busy} onClick={()=>void run(()=>logic(write))}>骨骼、蒙版、语音回归</button><button disabled={busy} onClick={()=>void run(perf)}>5000 节点压力检查</button><button disabled={busy} onClick={()=>void run(async()=>{await test('五分钟持续平移与骨骼资源释放',async()=>{const started=performance.now(),samples:number[]=[];let i=0;while(performance.now()-started<300000){const t=performance.now();await flow.setViewport({x:-(i%40)*200,y:-Math.floor(i%400/40)*200,zoom:1});const root=new THREE.Group();root.add(new THREE.Bone());const rig=new SkeletalRig(root,[]);rig.sample({...entity,animationTime:i%4});rig.dispose();await delay(100);samples.push(performance.now()-t);i++;}check(useBoard.getState().nodes.length===5000,'长时运行丢数据');return{iterations:i,seconds:Math.round((performance.now()-started)/1000),rendered:document.querySelectorAll('.react-flow__node').length,p95Ms:Math.round(samples.sort((a,b)=>a-b)[Math.floor(samples.length*.95)])};},write);await saveJSON('deep-qa.json','endurance',results);})}>五分钟持续运行</button><button disabled={busy} onClick={()=>void run(async()=>{await test('真实 ComfyUI 提交→轮询→下载',async()=>{const r=await runComfyTemplate('http://[::1]:1434',{id:'real-qa',name:'真实空白图工作流',createdAt:0,params:[],outputNodeId:'2',workflow:{'1':{class_type:'EmptyImage',inputs:{width:64,height:64,batch_size:1,color:0x2050cc}},'2':{class_type:'SaveImage',inputs:{images:['1',0],filename_prefix:'MOMO验收/链路'}}}},{});check(r.images.length===1,'未取得图片');return{images:r.images.length};},write);})}>真实 ComfyUI 链路</button><button onClick={()=>{const b=new Blob([JSON.stringify(results,null,2)],{type:'application/json'}),u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download='deep-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}}>保存报告</button><button onClick={()=>void Promise.all([loadJSON('deep-qa.json','result'),loadJSON('deep-qa.json','endurance')]).then(r=>write('重载读回 '+JSON.stringify(r)))}>重载后读回</button></nav><pre style={{height:180,overflow:'auto',whiteSpace:'pre-wrap'}}>{log}</pre><main style={{height:'calc(100vh - 240px)'}}><SmartCanvas/></main></>;
}
createRoot(document.getElementById('root')!).render(<ReactFlowProvider><Main/></ReactFlowProvider>);
