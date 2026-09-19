// 快捷键升级回归：纯函数验证，不启动应用或调用外部服务。
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const require=createRequire(import.meta.url);
const {build}=createRequire(require.resolve('vite/package.json'))('esbuild');
const result=await build({stdin:{contents:'export * from "./src/core/hotkeys"; export { DEFAULT_HOTKEYS } from "./src/core/types"; export { matchHotkey } from "./src/core/utils"; export { canvasReferenceImages } from "./src/core/nodeImages";',resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {normalizeHotkeys,hotkeysConflict,shouldIgnoreCanvasHotkey,DEFAULT_HOTKEYS,matchHotkey,canvasReferenceImages}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
assert.equal(normalizeHotkeys({}).comfyLaunch,'ctrl+shift+c');
assert.equal(normalizeHotkeys({comfyLaunch:''}).comfyLaunch,'','显式解绑不能被升级重新绑定');
assert.equal(normalizeHotkeys({agent:'ctrl+shift+c'}).agent,'ctrl+shift+c');
assert.equal(normalizeHotkeys({agent:'ctrl+shift+c'}).comfyLaunch,'','新默认键必须避让旧自定义');
assert.equal(normalizeHotkeys({agent:'CTRL+SHIFT+S'}).comfySync,'','冲突判断不区分大小写');
assert.equal(normalizeHotkeys({comfySync:null}).comfySync,DEFAULT_HOTKEYS.comfySync,'导入无效值回退默认');
assert.equal(normalizeHotkeys({charLib:'x'}).charLib,'','已删除入口不可复活');
assert.equal(normalizeHotkeys({addChat:'ctrl+shift+c'}).comfyLaunch,'ctrl+shift+c','停用入口不可占用默认键');
assert.equal(hotkeysConflict('ignore','i','dirSetIn','i'),false,'画布与导演台允许同键');
assert.equal(hotkeysConflict('comfyLaunch','ctrl+shift+c','agent','CTRL+SHIFT+C'),true);
assert.equal(hotkeysConflict('director','r','dirRegen','r'),true,'关闭导演台出口与导演台动作必须检测冲突');
const event={defaultPrevented:false,isComposing:false,repeat:false};
const body={tagName:'BODY',isContentEditable:false,closest:()=>null};
assert.equal(shouldIgnoreCanvasHotkey(event,body,false),false);
for(const e of [{...event,defaultPrevented:true},{...event,isComposing:true},{...event,repeat:true}]) assert.equal(shouldIgnoreCanvasHotkey(e,body,false),true);
for(const tagName of ['INPUT','TEXTAREA','SELECT']) assert.equal(shouldIgnoreCanvasHotkey(event,{...body,tagName},false),true);
assert.equal(shouldIgnoreCanvasHotkey(event,{...body,isContentEditable:true},false),true);
assert.equal(shouldIgnoreCanvasHotkey(event,body,true),true,'弹层打开时禁止操作背后的画布');
const defaults=Object.entries(DEFAULT_HOTKEYS);
for(let i=0;i<defaults.length;i++) for(let j=i+1;j<defaults.length;j++) assert.equal(hotkeysConflict(...defaults[i],...defaults[j]),false,`默认冲突：${defaults[i][0]} / ${defaults[j][0]}`);
console.log('通过：默认绑定无作用域冲突；旧绑定、显式解绑和停用项迁移正确；输入法、输入框、重复按键和弹层均受保护。');

// 编译并执行 SmartCanvas 当前真实事件函数，仅替换桌面服务和 UI store，避免复制一份路由逻辑来测试自身。
const ts=require('typescript');
const source=ts.createSourceFile('SmartCanvas.tsx',readFileSync('src/modules/canvas/SmartCanvas.tsx','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let handler, blockingPanel;
function visit(node){
 if(ts.isVariableDeclaration(node)){
  if(node.name.getText(source)==='onKey'&&node.initializer?.getText(source).includes('shouldIgnoreCanvasHotkey')) handler=node.initializer.getText(source);
  if(node.name.getText(source)==='hasBlockingPanel') blockingPanel=node.initializer.getText(source);
 }
 ts.forEachChild(node,visit);
}
visit(source);assert.ok(handler&&blockingPanel,'必须找到生产事件入口和弹层判定');
const compile=text=>ts.transpileModule(`(${text})`,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
const calls=[];
const ui={setComfySyncOpen:v=>calls.push(['sync',v]),setTemplateMgr:v=>calls.push(['template',v]),setSkillMgrOpen:v=>calls.push(['skill',v]),openSettings:v=>calls.push(['settings',v])};
let bindings={...DEFAULT_HOTKEYS};
let active=body;
const nodes=[{id:'image',type:'image',selected:true,position:{x:0,y:0},data:{src:'original'}},{id:'other',type:'image',selected:false,position:{x:0,y:0},data:{src:'other'}}];
const edges=[{id:'selected-edge',selected:true},{id:'other-edge',selected:false}];
const context={shouldIgnoreCanvasHotkey,matchHotkey,canvasReferenceImages,hasBlockingPanel:runInNewContext(compile(blockingPanel)),document:{get activeElement(){return active},querySelector:()=>null},useSettings:{getState:()=>({settings:{hotkeys:bindings}})},useUi:{getState:()=>ui},useBoard:{getState:()=>({nodes,edges})},deleteElements:selection=>calls.push(['delete',selection.nodes.map(n=>n.id),selection.edges.map(e=>e.id)]),sendImagesToAgent:images=>calls.push(['images',images]),useComfyRuntime:{getState:()=>({})},useComfy:{getState:()=>({online:'off'})},launchComfy:async()=>calls.push(['launch'])};
context.NODE_CATALOG=[];
const onKey=runInNewContext(compile(handler),context);
const key=(name,extra={})=>onKey({key:name,ctrlKey:false,metaKey:false,shiftKey:false,altKey:false,...event,preventDefault(){this.defaultPrevented=true},...extra});
key('Delete');assert.deepEqual(calls.pop(),['delete',['image'],['selected-edge']]);
bindings.delete='x';key('Delete');key('Backspace');assert.equal(calls.length,0,'改绑后旧 Delete 和隐藏 Backspace 不可继续删除');
key('x');assert.equal(calls.pop()[0],'delete');
bindings.delete='ctrl+shift+x';key('x');assert.equal(calls.length,0,'导入组合键不能退化成单键');key('x',{ctrlKey:true,shiftKey:true});assert.equal(calls.pop()[0],'delete');
bindings.delete='';key('Delete');key('Backspace');assert.equal(calls.length,0,'解绑彻底停用删除');
bindings={...DEFAULT_HOTKEYS};
for(const property of ['settingsOpen','templateMgrOpen','comfySyncOpen','skillMgrOpen','directorOpen','lightbox','mediaEdit']){ui[property]=true;key('Delete');key('c',{ctrlKey:true,shiftKey:true});delete ui[property];}
assert.equal(calls.length,0,'浮层与导演台不会删除画布或启动服务');
for(const extra of [{isComposing:true},{repeat:true},{defaultPrevented:true}]) key('Delete',extra);
active={...body,tagName:'INPUT'};key('Delete');key('c',{ctrlKey:true,shiftKey:true});active=body;
assert.equal(calls.length,0,'输入/输入法/重复键不能删除或启动服务');
for(const [keyName,expected] of [['c','launch'],['s','sync'],['m','template'],['k','skill'],['u','settings'],['i','images']]){key(keyName,{ctrlKey:true,shiftKey:true});const call=calls.pop();assert.equal(call[0],expected);if(expected==='settings')assert.equal(call[1],'models');if(expected==='images')assert.deepEqual(call[1],['original']);}
console.log('通过：生产事件函数六组动作路由正确；删除仅处理所选节点/连线，改绑/解绑无旧键旁路，输入和弹层阻止实际删除与启动调用。');
