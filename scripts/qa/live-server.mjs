// 仅供主动启动的真实服务验收。密钥留在本机内存，浏览器得到占位符。
import http from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=path.join(process.env.APPDATA,'site.jinpengi.momo');
const settings=JSON.parse(await readFile(path.join(root,'settings.json'),'utf8')).v4;
const prefs=JSON.parse(await readFile(path.join(root,'agent-prefs.json'),'utf8')).v1??{};
const selected={chat:process.env.MOMO_QA_CHAT||prefs.modelId||settings.models.defaults.chat,image:process.env.MOMO_QA_IMAGE||prefs.imageModelId||settings.models.defaults.image};
const ids=new Set(Object.values(selected).map(s=>s.split('::')[0]));
const providers=settings.models.providers.filter(p=>ids.has(p.id));
for(const p of providers)if(p.apiKey?.startsWith('dpapi:')){
  p.apiKey=execFileSync('powershell',['-NoProfile','-Command',"Add-Type -AssemblyName System.Security; $h=[Console]::In.ReadToEnd(); $b=New-Object byte[] ($h.Length/2); for($i=0;$i -lt $b.Length;$i++){$b[$i]=[Convert]::ToByte($h.Substring($i*2,2),16)}; [Console]::Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))"],{input:p.apiKey.slice(6),encoding:'utf8',windowsHide:true});
}
const posterMode=process.env.MOMO_QA_MODE==='poster';
const elementMode=process.env.MOMO_QA_MODE==='elements',planarMode=process.env.MOMO_QA_MODE==='planar', maxImages=planarMode?1:elementMode?3:2;
const endpoint='http://[::1]:1433', records=[],media=new Map();let images=0,chats=0;
const safeSettings=structuredClone(settings);safeSettings.models.providers=providers.map(p=>({...p,apiKey:'LOCAL_QA_KEY',baseUrl:p.baseUrl?endpoint+'/p/'+p.id+new URL(p.baseUrl).pathname.replace(/\/$/,''):''}));safeSettings.search={...safeSettings.search,apiKey:''};safeSettings.eagle={...safeSettings.eagle,apiToken:''};
const server=http.createServer(async(req,res)=>{
  if(req.headers.origin!=='http://[::1]:1430'){res.writeHead(403);res.end();return;}
  res.setHeader('Access-Control-Allow-Origin','http://[::1]:1430');res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization,x-api-key,anthropic-version');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  if(req.method==='OPTIONS'){res.end();return;}
  try{
    if(req.url==='/fixture'&&(elementMode||planarMode)){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({src:'data:image/png;base64,'+(await readFile(path.resolve('.Codex/live-acceptance/连续生图-1.png'))).toString('base64')}));return;}
    if(req.url==='/config'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({settings:safeSettings,selected}));return;}
    if(req.url==='/report'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(records));return;}
    if(req.url==='/save'&&req.method==='POST'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const data=JSON.parse(Buffer.concat(chunks).toString());
      const dir=path.resolve(posterMode?'.Codex/poster-acceptance':planarMode?'.Codex/planar-acceptance':elementMode?'.Codex/element-acceptance':'.Codex/live-acceptance');await mkdir(dir,{recursive:true});
      for(let i=0;i<Math.min(posterMode?10:maxImages,data.images?.length??0);i++){const value=data.images[i];if(/^data:image\/(png|jpeg|webp);base64,/.test(value))await writeFile(path.join(dir,`${posterMode?"海报实测":planarMode?"平面总稿":elementMode?"元素实测":"连续生图"}-${i+1}.png`),Buffer.from(value.split(',')[1],'base64'));}
      await writeFile(path.join(dir,'report.json'),JSON.stringify({records,messages:data.messages},null,2));res.end('ok');return;
    }
    let target,provider;
    const match=req.url.match(/^\/p\/([^/]+)(\/.*)$/);
    if(match){provider=providers.find(p=>p.id===match[1]);if(!provider)throw Error('未授权服务商');target=new URL(match[2],new URL(provider.baseUrl).origin);}
    else if(req.url.startsWith('/media/')){target=media.get(req.url.slice(7));if(!target)throw Error('未知媒体');}
    else throw Error('未知验收入口');
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
    if(req.method==='POST'&&/images|draw|generations/.test(target.pathname)){if(++images>maxImages)throw Error('已达到本次真实图片验收提交上限');}
    else if(req.method==='POST'&&++chats>(planarMode?2:16))throw Error('真实验收对话请求已达上限');
    const headers=new Headers();for(const key of ['content-type','accept','anthropic-version'])if(req.headers[key])headers.set(key,req.headers[key]);
    if(provider){headers.set('authorization','Bearer '+provider.apiKey);if(req.headers['x-api-key'])headers.set('x-api-key',provider.apiKey);}
    const start=Date.now();const response=await fetch(target,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:body,signal:AbortSignal.timeout(600000)});
    records.push({path:target.pathname,status:response.status,ms:Date.now()-start,bytes:body.length,hasReference:body.includes(Buffer.from('name="image'))||body.includes(Buffer.from('image_url')),provider:provider?.name});
    res.statusCode=response.status;const ct=response.headers.get('content-type')??'';res.setHeader('Content-Type',ct);
    if(ct.includes('json')){const obj=await response.json();const rewrite=v=>{if(typeof v==='string'&&/^https?:\/\//.test(v)){const id=String(media.size);media.set(id,v);return endpoint+'/media/'+id;}if(Array.isArray(v))return v.map(rewrite);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,rewrite(x)]));return v;};res.end(JSON.stringify(rewrite(obj)));}
    else{for await(const chunk of response.body)res.write(chunk);res.end();}
  }catch(e){res.statusCode=502;res.end(JSON.stringify({error:{message:String(e.message).replace(/Bearer\s+\S+/g,'Bearer [hidden]')}}));}
});
server.listen(1433,'::1',()=>console.log('真实验收代理已就绪；不打印密钥。', {selected,maxImages,elementMode}));
