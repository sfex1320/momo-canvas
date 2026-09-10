import {useRef,useState} from "react";
import {useDirector} from "../../../core/stores/directorStore";
import {useAssets} from "../../../core/stores/assetStore";
import {assetUrl,assetToDataUrl} from "../../../core/services/assetFiles";
import {resolveModelCard} from "../../../core/stores/settingsStore";
import {mirrorProjectAsset} from "../../../core/studio/projectAssetRouter";
import {chatStream} from "../../../core/services/llm";
import {errMsg,parseJsonLoose,uid} from "../../../core/utils";
import {toast} from "../../../core/stores/uiStore";
import {CharacterLibraryStation} from "./CharacterLibraryStation";
import {Thumb} from "../../../ui/Thumb";
import {IcPlus,IcUpload} from "../../../ui/icons";
import type {DirectorProject} from "../../../core/types";

type Kind="character"|"scene"|"prop";
export function MaterialStation({project}:{project:DirectorProject}) {
  const [advanced,setAdvanced]=useState(false),[kind,setKind]=useState<Kind>("character"),[selected,setSelected]=useState("");
  const [busy,setBusy]=useState(false),[attach,setAttach]=useState(false);
  const input=useRef<HTMLInputElement>(null),assets=useAssets(s=>s.items);
  const entries=[...project.characters.map(c=>({id:c.id,kind:"character" as Kind,name:c.name,description:c.continuity,assetIds:c.assetIds??[]})),...(project.assetDefinitions??[])];
  const list=entries.filter(d=>d.kind===kind),entry=list.find(d=>d.id===selected)??list[0];
  const update=(id:string,patch:{name?:string;description?:string;assetIds?:string[]})=>{
    const p=useDirector.getState().getById(project.id)!;
    if(p.characters.some(c=>c.id===id))useDirector.getState().updateProject(p.id,{characters:p.characters.map(c=>c.id===id?{...c,...(patch.name!==undefined?{name:patch.name}:{}),...(patch.description!==undefined?{continuity:patch.description}:{}),...(patch.assetIds?{assetIds:patch.assetIds}:{}),rev:(c.rev??0)+1,updatedAt:Date.now()}:c)});
    else useDirector.getState().updateProject(p.id,{assetDefinitions:(p.assetDefinitions??[]).map(d=>d.id===id?{...d,...patch}:d)});
  };
  const add=(name?:string,assetIds:string[]=[])=>{
    const p=useDirector.getState().getById(project.id)!,id=uid(8),label=name??`${kind==="character"?"人物":kind==="scene"?"场景":"道具"} ${list.length+1}`;
    if(kind==="character")useDirector.getState().updateProject(p.id,{characters:[...p.characters,{id,name:label,continuity:"",assetIds}]});
    else useDirector.getState().updateProject(p.id,{assetDefinitions:[...(p.assetDefinitions??[]),{id,kind,name:label,description:"",assetIds}]});
    setSelected(id);
  };
  const upload=async(files:File[])=>{
    if(busy)return;setBusy(true);const target=attach?entry?.id:undefined;
    try{for(const file of files){if(!file.type.startsWith("image/"))continue;const item=await useAssets.getState().importFileGetItem(file);if(!item)continue;
      if(!item.director)useAssets.getState().patchItem(item.id,{director:{projectId:project.id,role:"reference"}});
      await mirrorProjectAsset({projectId:project.id,category:kind,assetId:item.id});
      if(target){const p=useDirector.getState().getById(project.id)!;const ids=p.characters.find(c=>c.id===target)?.assetIds??p.assetDefinitions?.find(d=>d.id===target)?.assetIds??[];update(target,{assetIds:[...new Set([...ids,item.id])]});}
      else add(file.name.replace(/\.[^.]+$/,""),[item.id]);
    }}catch(e){toast(errMsg(e),"err");}finally{setBusy(false);}
  };
  const identify=async()=>{if(!entry)return;const image=assets.find(a=>a.id===entry.assetIds[0]);if(!image)return;setBusy(true);const target=entry.id;try{const r=await chatStream(resolveModelCard("chat"),[{role:"user",text:`为创作素材建议一个简短名称和外观定义，类别：${kind}。不推断真实人物身份。只返回 JSON {"name":"名称","description":"可见外观、服装或空间布局"}`,images:[await assetToDataUrl(image.path,image.mime)]}]);const v=parseJsonLoose(r.text) as {name?:string;description?:string};if(typeof v?.name!=="string"||typeof v.description!=="string")throw Error("未获得有效定义");update(target,{name:v.name,description:v.description});}catch(e){toast(errMsg(e),"err");}finally{setBusy(false);}};
  if(advanced)return <><button className="st-btn" onClick={()=>setAdvanced(false)}>返回素材</button><CharacterLibraryStation project={project}/></>;
  return <div className="sw-layout" onDragOver={e=>{if(Array.from(e.dataTransfer.items).some(i=>i.type.startsWith("image/"))){e.preventDefault();e.stopPropagation();}}} onDrop={e=>{if(Array.from(e.dataTransfer.files).some(f=>f.type.startsWith("image/"))){e.preventDefault();e.stopPropagation();void upload(Array.from(e.dataTransfer.files));}}} onPaste={e=>{if((e.target as HTMLElement).closest("input,textarea,[contenteditable=true]"))return;if(Array.from(e.clipboardData.files).some(f=>f.type.startsWith("image/"))){e.preventDefault();e.stopPropagation();void upload(Array.from(e.clipboardData.files));}}}>
    <aside className="sw-list"><div className="sw-list-head"><b>项目素材</b><button className="st-btn" aria-label="新增素材定义" onClick={()=>add()}><IcPlus size={14}/></button></div><div className="sw-chips">{(["character","scene","prop"] as Kind[]).map(k=><button className={`st-btn ${kind===k?"primary":""}`} key={k} onClick={()=>{setKind(k);setSelected("");}}>{k==="character"?"人物":k==="scene"?"场景":"道具"}</button>)}</div>{list.map(d=><button className={`sw-segment ${entry?.id===d.id?"on":""}`} key={d.id} onClick={()=>setSelected(d.id)}><b>{d.name}</b><small>{d.assetIds.length} 张参考图</small></button>)}<button className="st-btn" onClick={()=>setAdvanced(true)}>角色与音色档案</button></aside>
    <main className="sw-page"><header className="sw-header"><div><small>先定义，再复用</small><h2>人物、场景与道具</h2></div><button className="st-btn primary" onClick={()=>useDirector.getState().updateProject(project.id,{studioUi:{...project.studioUi,station:"director"}})}>编写分段</button></header>
      <div className="sw-upload"><IcUpload size={24}/><b>拖入、粘贴或选择图片</b><span>每张图按文件名建立一个素材；也可以追加到当前素材。</span><button className="st-btn" disabled={busy} onClick={()=>input.current?.click()}>{busy?"处理中…":"选择图片"}</button><label><input type="checkbox" checked={attach} onChange={e=>setAttach(e.target.checked)}/>追加到当前素材</label><input hidden multiple type="file" accept="image/*" ref={input} onChange={e=>{void upload(Array.from(e.target.files??[]));e.target.value="";}}/></div>
      {entry&&<section><div className="sw-section-title"><h3>素材定义</h3><button className="st-btn" disabled={busy||!entry.assetIds.length} onClick={()=>void identify()}>识图填写</button></div><label>名称<input className="st-input" value={entry.name} onChange={e=>update(entry.id,{name:e.target.value})}/></label><label>定义<textarea className="st-area" rows={5} value={entry.description} onChange={e=>update(entry.id,{description:e.target.value})} placeholder="身份与外观、空间与光线、物件材质等固定信息。分段勾选后自动复用。"/></label><div className="sw-thumbs">{entry.assetIds.map(id=>{const a=assets.find(a=>a.id===id);return a?<div key={id}><Thumb src={assetUrl(a.path)} alt={a.name}/><button className="st-btn" onClick={()=>update(entry.id,{assetIds:entry.assetIds.filter(x=>x!==id)})}>解除绑定</button></div>:<span key={id}>参考素材缺失</span>;})}</div><label>从资产库绑定<select className="st-input" value="" onChange={e=>{if(e.target.value)update(entry.id,{assetIds:[...new Set([...entry.assetIds,e.target.value])]});}}><option value="">选择已有图片…</option>{assets.filter(a=>a.kind==="image"&&!a.deletedAt&&!entry.assetIds.includes(a.id)).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label></section>}
    </main>
  </div>;
}
