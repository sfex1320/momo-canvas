// 真实助手引擎 + 隔离的服务/存储替身，验证路由与请求正文，不调用任何收费模型。
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {build}=createRequire(require.resolve('vite/package.json'))('esbuild');
const q={requests:[],chats:0,answer:'确认生成',nodes:[],errors:[],card:{id:'test',model:'test-image',name:'测试模型',protocol:'openai'}};
const state={mode:'edit',draft:'只把衣服改成红色，其余不变。',attachments:['selected-image'],messages:[{role:'assistant',text:'旧方案',results:[{kind:'image',src:'old-image',prompt:'旧整图长词'.repeat(1000)}]}],running:false,referenceMode:'auto',summary:'',summaryUpto:0,epoch:0,webSearch:false,
 setDraft(v){this.draft=v},pushUser(text,images){this.messages.push({role:'user',text,images,referenceMode:this.referenceMode})},beginAssistant(){const id='reply-'+this.messages.length;this.messages.push({id,role:'assistant',steps:[]});return id},updateMsg(id,patch){Object.assign(this.messages.find(m=>m.id===id),patch)},addStep(){return 'step'},setStep(){},appendResults(id,results){this.updateMsg(id,{results})},async askQuestion(id,text){q.question=text;return q.answer},setSummary(){}};
q.agent={getState:()=>state,setState:patch=>Object.assign(state,patch)};
q.board={getState:()=>({activeId:'board',boards:{},addNode(type,pos,data){q.nodes.push({type,data});return String(q.nodes.length)},onConnect(){},updateData(){}})};
globalThis.__qa=q;globalThis.window={innerWidth:1200,innerHeight:900};
const mocks={
 './stores/agentStore':'export const useAgent=globalThis.__qa.agent;',
 './stores/boardStore':'export const useBoard=globalThis.__qa.board;',
 './stores/settingsStore':'export const useSettings={getState:()=>({settings:{search:{}}})};export const resolveModelCard=()=>globalThis.__qa.card;',
 './stores/assetStore':'export const useAssets={getState:()=>({collect:async()=>{}})};',
 './stores/uiStore':'export const useUi={getState:()=>({addGallery(){}})};export const pushError=(...a)=>globalThis.__qa.errors.push(a);export const toast=pushError;',
 './services/llm':`export async function chatStream(){globalThis.__qa.chats++;return {text:globalThis.__qa.chatReplies?.shift()??'普通对话回复'};}`,
 './services/webSearch':'export const searchContext=()=>"";export const webSearchForModel=async()=>({hits:[]});',
 './stores/designStore':'export const brandPrompt=(id,p)=>"品牌额外词："+p;',
 './imageInfo':'export const imageDims=async()=>({w:768,h:1024});',
 './services/imageGen':'export const generateImage=async(c,r)=>{globalThis.__qa.requests.push(r);return ["edited-result"]};',
 './services/videoGen':'export const generateVideo=async()=>{throw Error("不应调用视频")};',
 './runner':'export const runFlow=()=>{};',
 './services/assetFiles':'export const assetUrl=x=>x;',
 './utils':'export const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));export const errMsg=e=>String(e.message??e);export const isTauri=false;export const parseJsonLoose=t=>{try{return JSON.parse(t)}catch{return null}};export const uid=()=>"test-id";',
 './runControl':'export const beginTask=()=>new AbortController().signal;export const endTask=()=>{};export const isAbortError=e=>String(e).includes("取消");',
 './modelMeta':'export const chatCaps=()=>({vision:true,builtinSearch:false});export const familyPresets=()=>[];export const gptSize=()=>({w:768,h:1024});export const imageFamily=()=>"gpt";export const nearestAspect=x=>String(x);export const parseRatio=s=>{const a=s?.split(":").map(Number);return a?.length===2?a[0]/a[1]:null};export const scalePresetToTier=x=>x;',
 './capability':'export const executeCapability=()=>{};export const agentToolHint=()=>"";export const getCapability=()=>null;',
 './capability/builtin':'',
 './capability/budget':'export const budgetGate=()=>({});',
 './pricing':'export const estimateCost=()=>0;',
 './stores/usageStore':'export const useUsage={getState:()=>({record(){}})};',
};
const dir=await mkdtemp(join(tmpdir(),'momo-agent-route-'));
try{
 const result=await build({entryPoints:[resolve('src/core/agentEngine.ts')],bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'隔离服务',setup(b){b.onResolve({filter:/.*/},a=>a.importer.endsWith('agentEngine.ts')&&Object.hasOwn(mocks,a.path)?{path:a.path,namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'js'}));}}]});
 const file=join(dir,'engine.cjs');await writeFile(file,result.outputFiles[0].contents);const engine=require(file);
 await engine.sendAgentMessage();
 assert.equal(q.chats,0,'编辑不可调用对话模型扩写');assert.equal(q.requests.length,1,JSON.stringify(q.errors));
 assert.equal(q.requests[0].prompt,'只把衣服改成红色，其余不变。');assert.equal(q.requests[0].operation,'edit');assert.deepEqual(q.requests[0].refImages,['selected-image']);
 assert.ok(!q.question.includes('旧整图长词'));assert.equal(q.nodes.find(n=>n.type==='imageGen').data.imageOperation,'edit');
 assert.equal(q.nodes.filter(n=>n.type==='image').length,0,'编辑不能复制参考图到画布');
 assert.deepEqual(q.nodes.find(n=>n.type==='imageGen').data.referenceImages,['selected-image'],'重试所需的参考图快照应保存在生成节点');
 console.log('通过：参考图 + 修改原文直达编辑，跳过 LLM 扩写、品牌词与旧长提示词；节点保留编辑类型。');
 state.draft='只修改背景';state.attachments=['second-source'];q.answer='再想想';await engine.sendAgentMessage();assert.equal(q.requests.length,1);assert.equal(state.running,false);
 console.log('通过：取消编辑确认不调用模型，任务正常结束。');
 state.draft='改成蓝色';state.attachments=[];state.messages=[];q.answer='确认编辑';await engine.sendAgentMessage();assert.equal(q.requests.length,1);assert.ok(q.errors.some(e=>e.join('').includes('编辑需要图片')));
 console.log('通过：缺少原图时阻止编辑，不降级成文生图。');
 state.mode='chat';state.draft='解释一下配色';state.messages=[];state.attachments=[];await engine.sendSideChat();assert.equal(q.requests.length,1);assert.equal(q.chats,1);
 console.log('通过：对话只走文字通道，不执行生图。');
 state.mode='agent';state.draft='画一只猫，方图1K';state.messages=[];state.attachments=[];q.answer='确认生成';q.chatReplies=[JSON.stringify({action:'image',prompt:'新图完整方案',aspect:'1:1',resolution:'1K',count:1,useRefs:false}),JSON.stringify({action:'reply',text:'已交付'})];
 await engine.sendAgentMessage();assert.equal(q.requests.length,2,JSON.stringify(q.errors));assert.equal(q.requests[1].operation,'generate');assert.equal(q.requests[1].prompt,'品牌额外词：新图完整方案');assert.equal(q.requests[1].refImages,undefined);
 console.log('通过：生图仍走规划方案，且不会自动携带历史图片。');
 // 不切换任何界面模式：生成后紧接自然语言编辑，随后讨论配色。
 state.draft='把刚才的猫改成白色，背景保持不变';state.attachments=[];q.answer='确认编辑';
 q.chatReplies=[JSON.stringify({action:'edit',prompt:'错误的整图重写词',useRefs:true})];
 const beforeEditNodes=q.nodes.length;
 await engine.sendAgentMessage();assert.equal(q.requests.length,3,JSON.stringify(q.errors));
 assert.equal(q.requests[2].operation,'edit');assert.equal(q.requests[2].prompt,'把刚才的猫改成白色，背景保持不变');
 assert.deepEqual(q.requests[2].refImages,['edited-result']);assert.equal(q.nodes.length,beforeEditNodes+1);
 assert.equal(q.nodes.at(-1).type,'imageGen');assert.deepEqual(q.nodes.at(-1).data.referenceImages,['edited-result']);
 state.draft='这个配色为什么显得柔和？只解释';state.attachments=[];
 q.chatReplies=[JSON.stringify({action:'reply',text:'因为明度接近'}),JSON.stringify({action:'reply',text:'因为明度接近'})];
 await engine.sendAgentMessage();assert.equal(q.requests.length,3);assert.equal(state.messages.at(-1).text,'因为明度接近');
 assert.equal(state.mode,'agent');
 console.log('通过：同一对话连续生成→原文编辑→普通讨论，编辑仅新增一个结果节点。');
}finally{delete globalThis.__qa;await unlink(join(dir,"engine.cjs")).catch(()=>{});await rmdir(dir);}
