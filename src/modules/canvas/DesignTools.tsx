import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useBoard } from "../../core/stores/boardStore";
import { emptyBrand, useDesign } from "../../core/stores/designStore";
import { useAssets } from "../../core/stores/assetStore";
import { createArtboard, artboardSize, alignArtboard, exportArtboard } from "../../core/artboard";
import { toast, pushError } from "../../core/stores/uiStore";
import type { ArtboardSpec } from "../../core/types";
import { errMsg } from "../../core/utils";
import { IcClose, IcGrid } from "../../ui/icons";
import "./designTools.css";
import { ProductionPanel } from "./ProductionPanel";

export function DesignTools({onClose}:{onClose:()=>void}) {
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==="Escape"){e.stopPropagation();onClose();}};document.addEventListener("keydown",key,true);return()=>document.removeEventListener("keydown",key,true);},[onClose]);
  const boardId=useBoard(s=>s.activeId),brands=useDesign(s=>s.brands),nodes=useBoard(s=>s.nodes),assets=useAssets(s=>s.items);
  const [kit,setKit]=useState(()=>brands[boardId]??emptyBrand());
  const [spec,setSpec]=useState<ArtboardSpec>({widthMm:600,heightMm:400,dpi:150,bleedMm:3,safeMm:10,scale:1,background:"#ffffff"});
  const [tab,setTab]=useState("brand");let size="";try{const p=artboardSize(spec);size=`输出 ${p.w}×${p.h}px（含出血）`;}catch(e){size=errMsg(e);}
  const groups=nodes.filter(n=>n.type==="group"&&(n.data as {artboard?:ArtboardSpec}).artboard);
  return createPortal(<div className="design-overlay"><section className="design-dialog" role="dialog" aria-label="平面设计工作台" aria-modal="true">
    <header><b><IcGrid size={18}/> 平面设计工作台</b><button className="icon-btn" onClick={onClose} aria-label="关闭设计工作台"><IcClose size={17}/></button></header>
    <nav><button className={`btn ${tab==="brand"?"primary":""}`} onClick={()=>setTab("brand")}>品牌包</button><button className={`btn ${tab==="board"?"primary":""}`} onClick={()=>setTab("board")}>尺寸画板</button>
    <button className={`btn ${tab==="production"?"primary":""}`} onClick={()=>setTab("production")}>印刷与精细生产</button></nav>
    {tab==="production"?<ProductionPanel/>:tab==="brand"?<div className="design-fields">
      <label><input type="checkbox" checked={kit.enabled} onChange={e=>setKit({...kit,enabled:e.target.checked})}/>在当前画布及关联项目生成时使用</label>
      <label>品牌名称<input className="input" value={kit.name} onChange={e=>setKit({...kit,name:e.target.value})}/></label>
      <label>标准色（逗号分隔）<input className="input" value={kit.colors.join(",")} onChange={e=>setKit({...kit,colors:e.target.value.split(/[,，]/).map(v=>v.trim())})}/></label>
      <label>字体要求<input className="input" value={kit.fonts} onChange={e=>setKit({...kit,fonts:e.target.value})}/></label>
      <label>设计规则<textarea className="textarea" value={kit.rules} onChange={e=>setKit({...kit,rules:e.target.value})}/></label>
      <label>禁止事项<input className="input" value={kit.forbidden} onChange={e=>setKit({...kit,forbidden:e.target.value})}/></label>
      <b>品牌参考资产</b><div className="design-assets">{assets.filter(a=>a.kind==="image").slice(0,40).map(a=><label key={a.id}><input type="checkbox" checked={kit.logoAssetIds.includes(a.id)} onChange={e=>setKit({...kit,logoAssetIds:e.target.checked?[...kit.logoAssetIds,a.id]:kit.logoAssetIds.filter(x=>x!==a.id)})}/>{a.name}</label>)}</div>
      <p className="design-hint">标准色、字体和文字规则进入生成提示词。品牌图片在参考建议中显示，由你接受后才投喂；原生可编辑字体仍需排版工具处理。</p>
      <button className="btn primary" onClick={()=>{useDesign.getState().save(boardId,kit);toast("品牌包已保存","ok");}}>保存品牌包</button>
    </div>:<div className="design-fields">
      <div className="design-grid">{([["widthMm","宽 mm"],["heightMm","高 mm"],["dpi","DPI"],["bleedMm","出血 mm"],["safeMm","安全区 mm"],["scale","缩尺 1:"]] as const).map(([key,label])=><label key={key}>{label}<input className="input sm" type="number" min={key==="bleedMm"||key==="safeMm"?0:1} value={spec[key]} onChange={e=>setSpec({...spec,[key]:Number(e.target.value)})}/></label>)}</div>
      <label>背景<input type="color" value={spec.background} onChange={e=>setSpec({...spec,background:e.target.value})}/></label><p className="design-hint">{size}。创建时将选中的顶层素材放入画板，越界内容导出时裁切；出血区铺背景色。</p>
      <button className="btn primary" onClick={()=>{try{createArtboard(spec);toast("尺寸画板已创建","ok");}catch(e){pushError("尺寸画板",errMsg(e));}}}>创建画板（收纳所选素材）</button>
      {groups.map(g=><div className="design-board-row" key={g.id}><b>{String((g.data as {title?:string}).title)}</b><div>{([['left','左对齐'],['center','居中'],['top','顶对齐'],['distribute','水平分布']] as const).map(([key,label])=><button className="btn sm" key={key} onClick={()=>alignArtboard(g.id,key)}>{label}</button>)}<button className="btn sm primary" onClick={()=>void exportArtboard(g.id).catch(e=>pushError("画板导出",errMsg(e)))}>导出 PNG＋尺寸清单</button></div></div>)}
    </div>}
  </section></div>,document.body);
}
