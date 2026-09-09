import "../modules/canvas/designTools.css";
import { useAssets } from "../core/stores/assetStore";
import { useDesign } from "../core/stores/designStore";
import { assetUrl } from "../core/services/assetFiles";
import { Thumb } from "./Thumb";

export function ReferencePlan({boardId,projectId,prompt,ids,onChange,target}:{boardId:string;projectId?:string;prompt:string;ids:string[];onChange:(ids:string[])=>void;target:string}) {
  const assets=useAssets(s=>s.items),brands=useDesign(s=>s.brands),brand=brands[boardId];
  const suggestions=assets.filter(a=>a.kind==="image"&&!ids.includes(a.id)&&(!projectId||!a.director?.projectId||a.director.projectId===projectId)).filter(a=>(brand?.enabled&&brand.logoAssetIds.includes(a.id))||(a.name.length>=2&&prompt.includes(a.name.replace(/\.[^.]+$/,"")))).slice(0,6);
  return <div className="reference-plan"><small>{target}{brand?.enabled?` · 品牌：${brand.name||"当前画布"}`:""}</small><div className="reference-plan-list">{ids.map((id,i)=>{const a=assets.find(a=>a.id===id);return <span key={id}>{a?<Thumb src={assetUrl(a.path)} alt={a.name}/>:null}<small>{i+1} · {a?.name??"缺失素材"}</small><button type="button" className="btn sm" disabled={i===0} onClick={()=>{const next=[...ids];[next[i-1],next[i]]=[next[i],next[i-1]];onChange(next);}}>前移</button><button type="button" className="btn sm" onClick={()=>onChange(ids.filter(x=>x!==id))}>移除</button></span>;})}</div>
    {suggestions.length?<><small>建议参考（接受后才使用）</small><div className="reference-plan-list">{suggestions.map(a=><button type="button" className="btn sm" key={a.id} onClick={()=>onChange([...ids,a.id])}>＋{a.name}</button>)}<button type="button" className="btn sm" onClick={()=>onChange([...ids,...suggestions.map(a=>a.id)])}>全部接受</button></div></>:null}
  </div>;
}
