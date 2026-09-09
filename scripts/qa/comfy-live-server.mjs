// 本机真实 ComfyUI 验收代理：仅允许一次 64px 无模型工作流，不改用户编辑器或队列。
import http from 'node:http';
let submissions=0;
http.createServer(async(req,res)=>{
  if(req.headers.origin!=='http://[::1]:1430'){res.writeHead(403);res.end();return;}
  res.setHeader('Access-Control-Allow-Origin','http://[::1]:1430');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  if(req.method==='OPTIONS'){res.end();return;}
  try{
    const url=new URL(req.url,'http://127.0.0.1:8909');
    if(!/^\/(object_info|prompt|history|view|queue|system_stats)(\/|$)/.test(url.pathname))throw Error('验收端点不允许');
    const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);
    if(req.method==='POST'){
      if(url.pathname!=='/prompt'||submissions>=1)throw Error('仅允许一次受控工作流');
      const p=JSON.parse(body).prompt,n=Object.values(p);
      if(n.length!==2||!n.some(v=>v.class_type==='EmptyImage'&&v.inputs.width===64&&v.inputs.height===64&&v.inputs.batch_size===1)||!n.some(v=>v.class_type==='SaveImage'&&v.inputs.filename_prefix==='MOMO验收/链路'))throw Error('非验收工作流 '+JSON.stringify(p));
      const q=await(await fetch('http://127.0.0.1:8909/queue')).json();if(q.queue_running.length||q.queue_pending.length)throw Error('用户工作流正在执行，请稍后验收');submissions++;
    }
    const response=await fetch(url,{method:req.method,headers:{'Content-Type':'application/json'},body:req.method==='POST'?body:undefined,signal:AbortSignal.timeout(30000)});
    res.statusCode=response.status;res.setHeader('Content-Type',response.headers.get('content-type')??'application/octet-stream');res.end(Buffer.from(await response.arrayBuffer()));
    console.log(req.method,url.pathname,response.status);
  }catch(e){console.log(String(e.message));res.statusCode=400;res.end(JSON.stringify({error:String(e.message)}));}
}).listen(1434,'::1',()=>console.log('ComfyUI 受控真实验收代理 1434 已就绪'));
