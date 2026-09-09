import { useBoard } from "../../core/stores/boardStore";
import { useAssets } from "../../core/stores/assetStore";
import { useDesign } from "../../core/stores/designStore";
import { collectImageRefsFor, imagePromptInput } from "../../core/runner";
import { resolveModelCard } from "../../core/stores/settingsStore";
import { assetUrl } from "../../core/services/assetFiles";
import { Thumb } from "../../ui/Thumb";
import { pushError } from "../../core/stores/uiStore";
import type { ImageGenData } from "../../core/types";

/** 画布连线即参考来源：建议只在用户点选后转成真实素材节点与连线。 */
export function CanvasInputReview({nodeId}:{nodeId:string}){
  const nodes=useBoard(s=>s.nodes),boardId=useBoard(s=>s.activeId),assets=useAssets(s=>s.items),brands=useDesign(s=>s.brands);
  useBoard(s=>s.edges);
  const node=nodes.find(n=>n.id===nodeId),d=node?.data as ImageGenData|undefined;
  if(!node||!d)return null;
  const refs=collectImageRefsFor(nodeId),prompt=imagePromptInput(nodeId),brand=brands[boardId];
  let model="尚未配置模型";try{const c=resolveModelCard("image",d.modelId);model=`${c.name} · ${c.model}`;}catch{ /* 空态在此显示 */ }
  const candidates=assets.filter(a=>a.kind==="image"&&!refs.some(r=>r.src===assetUrl(a.path))).filter(a=>(brand?.enabled&&brand.logoAssetIds.includes(a.id))||(a.name.length>=2&&prompt.includes(a.name))).slice(0,6);
  return <div style={{display:"grid",gap:8,maxWidth:480}}><b>{model}</b><span>{d.count??1} 张 · {d.aspect??"自动画幅"} · {d.resolution??"模型默认清晰度"}</span>
    <pre style={{whiteSpace:"pre-wrap",maxHeight:180,overflow:"auto"}}>{prompt||"未填写提示词"}</pre>{d.lang==="en"&&<small>启用英文模式：上述文字会在运行时翻译成英文。</small>}
    {d.negative&&<small>负向：{d.negative}</small>}<b>本次参考图 · {refs.length} 张</b><div className="reference-plan-list">{refs.map((r,i)=><span key={`${i}:${r.src}`}><Thumb src={r.src}/><small>图{i+1} · {r.label}</small></span>)}</div>
    {candidates.length>0&&<><small>建议加入（点击后创建素材节点并连到当前节点）</small>{candidates.map(a=><button key={a.id} className="btn sm" onClick={()=>{try{
      const state=useBoard.getState();const parent=node.parentId?state.nodes.find(n=>n.id===node.parentId):undefined;
      const id=state.addNode("image",{x:node.position.x+(parent?.position.x??0)-400,y:node.position.y+(parent?.position.y??0)+refs.length*100},{src:assetUrl(a.path),name:a.name,status:"done"});
      state.onConnect({source:id,target:nodeId,sourceHandle:"out",targetHandle:"in"});
      useBoard.getState().onNodesChange(useBoard.getState().nodes.map(n=>({type:"select" as const,id:n.id,selected:n.id===nodeId})));
    }catch(e){pushError("参考图建议",String(e));}}}>＋ {a.name}</button>)}</>}
  </div>;
}
