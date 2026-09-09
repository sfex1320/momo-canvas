import type { ArtboardSpec, GroupData, ImageData } from "./types";
import { useBoard } from "./stores/boardStore";
import { loadImg } from "./maskCanvas";
import { nodeMainImage } from "./nodeEdit";
import { pngDataUrlWithDpi } from "./pngDpi";
import { saveImageAs } from "./services/imageSaver";
import { useSettings } from "./stores/settingsStore";
import { isTauri } from "./utils";

export function artboardSize(s: ArtboardSpec) {
  if(![s.widthMm,s.heightMm,s.dpi,s.scale,s.bleedMm,s.safeMm].every(Number.isFinite) || Math.min(s.widthMm,s.heightMm,s.dpi,s.scale)<=0 || Math.min(s.bleedMm,s.safeMm)<0 || s.safeMm*2>=Math.min(s.widthMm,s.heightMm)) throw new Error("画板尺寸、缩放比例或安全区无效");
  const factor=s.dpi/25.4/s.scale, w=Math.round((s.widthMm+2*s.bleedMm)*factor),h=Math.round((s.heightMm+2*s.bleedMm)*factor);
  if(Math.min(w,h)<16||Math.max(w,h)>8192||w*h>24_000_000) throw new Error("输出须至少16像素、单边不超过8192，总量不超过2400万像素；可增加缩尺比例");
  return {w,h,factor};
}
export function createArtboard(spec: ArtboardSpec) {
  artboardSize(spec);
  const s=useBoard.getState(), members=s.nodes.filter(n=>n.selected&&!n.parentId&&n.type!=="group");
  const x=members.length?Math.min(...members.map(n=>n.position.x))-24:0,y=members.length?Math.min(...members.map(n=>n.position.y))-56:0;
  const width=720,height=width*spec.heightMm/spec.widthMm;
  const id=s.addNode("group",{x,y},{title:`画板 ${spec.widthMm}×${spec.heightMm}mm · 1:${spec.scale}`,layerGroup:true,artboard:spec});
  useBoard.setState(state=>({nodes:state.nodes.map(n=>n.id===id?{...n,style:{width:width+48,height:height+80}}:members.some(m=>m.id===n.id)?{...n,parentId:id,position:{x:n.position.x-x,y:n.position.y-y}}:n).sort((a,b)=>a.id===id?-1:b.id===id?1:0)}));
  useBoard.getState().placeGroupMembers(id,{}, {w:width+48,h:height+80},false);
  return id;
}
export function alignArtboard(id:string,mode:"left"|"center"|"top"|"distribute") {
  const s=useBoard.getState(),g=s.nodes.find(n=>n.id===id),spec=(g?.data as GroupData)?.artboard;if(!spec)return;
  const members=s.nodes.filter(n=>n.parentId===id);const picked=members.filter(n=>n.selected);const items=(picked.length?picked:members).sort((a,b)=>a.position.x-b.position.x);const width=720;
  const size=(n:typeof items[number])=>(n.data as ImageData).tileSize?.w??n.measured?.width??320;
  const gap=items.length>1?(width-items.reduce((sum,n)=>sum+size(n),0))/(items.length-1):0;let cursor=24;
  const positions: Record<string,{x:number;y:number}>={};
  for(const n of items){positions[n.id]={x:mode==="left"?24:mode==="center"?24+(width-size(n))/2:mode==="distribute"?cursor:n.position.x,y:mode==="top"?56:n.position.y};cursor+=size(n)+gap;}
  s.placeGroupMembers(id,positions,{w:768,h:width*spec.heightMm/spec.widthMm+80});
}
export async function renderArtboard(id:string) {
  const s=useBoard.getState(),g=s.nodes.find(n=>n.id===id),spec=(g?.data as GroupData)?.artboard;if(!spec)throw new Error("请选择尺寸画板");
  const {w,h,factor}=artboardSize(spec),display=720/spec.widthMm;
  const c=document.createElement("canvas");c.width=w;c.height=h;const ctx=c.getContext("2d")!;ctx.fillStyle=spec.background;ctx.fillRect(0,0,w,h);
  const manifest: string[]=[`画板：${spec.widthMm}×${spec.heightMm}mm；缩尺1:${spec.scale}；${spec.dpi}DPI；出血${spec.bleedMm}mm；安全区${spec.safeMm}mm`];
  for(const n of s.nodes.filter(n=>n.parentId===id)) {const src=nodeMainImage(n);if(!src)continue;const img=await loadImg(src);const dw=(n.data as ImageData).tileSize?.w??n.measured?.width??320;const dh=(n.data as ImageData).tileSize?.h??n.measured?.height??dw*img.naturalHeight/img.naturalWidth;const x=(n.position.x-24)/display,y=(n.position.y-56)/display;
    ctx.drawImage(img,(x+spec.bleedMm)*factor,(y+spec.bleedMm)*factor,dw/display*factor,dh/display*factor);
    manifest.push(`${String((n.data as ImageData).name??n.id)}：x=${x.toFixed(2)}mm，y=${y.toFixed(2)}mm，宽=${(dw/display).toFixed(2)}mm，高=${(dh/display).toFixed(2)}mm`);
  }
  const png=pngDataUrlWithDpi(c.toDataURL("image/png"),spec.dpi);
  return {png,manifest:manifest.join("\n")};
}
export async function exportArtboard(id:string){
  const {png,manifest}=await renderArtboard(id);
  const path=await saveImageAs(png,{...useSettings.getState().settings.save,format:"png"},{prompt:"尺寸画板"});
  if(isTauri){if(!path)return null;const {writeTextFile}=await import("@tauri-apps/plugin-fs");await writeTextFile(path.replace(/\.[^.]+$/,"-尺寸清单.txt"),manifest);}
  else{const url=URL.createObjectURL(new Blob([manifest],{type:"text/plain;charset=utf-8"}));const a=document.createElement("a");a.href=url;a.download="画板尺寸清单.txt";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  return png;
}
