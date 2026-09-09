import { useEffect, useState } from "react";
import { productionPrefs, productionRun, saveProductionPrefs, type ProductionPrefs } from "../../core/productionTools";
import { useBoard } from "../../core/stores/boardStore";
import { renderArtboard } from "../../core/artboard";
import { nodeMainImage } from "../../core/nodeEdit";
import { loadImg } from "../../core/maskCanvas";
import { alphaContours, cutlineSvg } from "../../core/cutline";
import { errMsg, isTauri } from "../../core/utils";
import { toast } from "../../core/stores/uiStore";
import type { GroupData } from "../../core/types";

export function ProductionPanel(){
  const [prefs,setPrefs]=useState<ProductionPrefs>({pythonPath:"",iccPath:"",ffmpegPath:""}),[message,setMessage]=useState(""),[busy,setBusy]=useState(false),[width,setWidth]=useState(600),[height,setHeight]=useState(400);
  const nodes=useBoard(s=>s.nodes),selected=nodes.find(n=>n.selected&&nodeMainImage(n));
  useEffect(()=>{void productionPrefs().then(setPrefs).catch(e=>setMessage(errMsg(e)));},[]);
  const act=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);setMessage("");try{await saveProductionPrefs(prefs);await fn();}catch(e){setMessage(errMsg(e));}finally{setBusy(false);}};
  const pick=async(key:keyof ProductionPrefs)=>{if(!isTauri)return;const {open}=await import("@tauri-apps/plugin-dialog");const path=await open({multiple:false,filters:[{name:key==="iccPath"?"ICC 配置文件":"可执行程序",extensions:key==="iccPath"?["icc","icm"]:["exe"]}]});if(typeof path==="string"){const next={...prefs,[key]:path};setPrefs(next);await saveProductionPrefs(next);}};
  const exportCmyk=async(id:string)=>{
    if(!prefs.iccPath)throw new Error("先选择印厂提供的 CMYK ICC 配置文件");
    const {png}=await renderArtboard(id),s=(nodes.find(n=>n.id===id)!.data as GroupData).artboard!;
    const {save}=await import("@tauri-apps/plugin-dialog");const output=await save({defaultPath:"画板-CMYK.tif",filters:[{name:"CMYK TIFF",extensions:["tif"]}]});if(!output)return;
    const r=await productionRun<{profile:string}>({op:"cmyk",image:png,profile:prefs.iccPath,dpi:s.dpi,output});setMessage(`已导出 CMYK TIFF，嵌入 ${r.profile}；尺寸按画板缩尺输出。`);
  };
  const exportCut=async()=>{
    if(!selected)throw new Error("请先在画布选中一个透明图片元素");const img=await loadImg(nodeMainImage(selected)!);
    if(img.width*img.height>4_000_000)throw new Error("刀线追踪上限400万像素，请先缩小透明稿");
    const c=document.createElement("canvas");c.width=img.width;c.height=img.height;const ctx=c.getContext("2d")!;ctx.drawImage(img,0,0);
    const data=ctx.getImageData(0,0,c.width,c.height).data;if(!data.some((v,i)=>i%4===3&&v<128))throw new Error("图片没有透明背景，请先在元素工坊确认蒙版");
    const svg=cutlineSvg(alphaContours(data,c.width,c.height),c.width,c.height,width,height);
    const {save}=await import("@tauri-apps/plugin-dialog");const path=await save({defaultPath:"元素-CutContour.svg",filters:[{name:"毫米刀线 SVG",extensions:["svg"]}]});if(!path)return;
    const {writeTextFile}=await import("@tauri-apps/plugin-fs");await writeTextFile(path,svg);toast("刀线已导出，请在生产软件核对孔洞、尺度及工艺补偿","ok");
  };
  return <div className="design-fields"><b>本地生产环境</b>{([['pythonPath','Python（Pillow＋OpenCV）'],['iccPath','CMYK 输出 ICC'],['ffmpegPath','FFmpeg（无损剪辑）']] as const).map(([k,label])=><label key={k}>{label}<div style={{display:"flex",gap:8,flex:1,minWidth:0}}><input className="input" style={{flex:1,minWidth:0}} value={prefs[k]} onChange={e=>setPrefs({...prefs,[k]:e.target.value})}/><button className="btn" onClick={()=>void pick(k)}>选择</button></div></label>)}
    <button className="btn" disabled={busy||!isTauri} onClick={()=>void act(async()=>{const r=await productionRun<{PIL:boolean;cv2:boolean}>({op:"probe"});setMessage(`Pillow ${r.PIL?"可用":"未安装"}；OpenCV ${r.cv2?"可用":"未安装"}`);})}>保存并检查环境</button>
    <b>印刷颜色分离</b><p>将 sRGB 画板按所选 ICC 转为 CMYK TIFF，嵌入配置文件并保留 DPI。颜色预览仍为屏幕 RGB，生产前按印厂要求校样。</p>
    {nodes.filter(n=>n.type==="group"&&(n.data as GroupData).artboard).map(n=><button className="btn" disabled={busy||!isTauri} key={n.id} onClick={()=>void act(()=>exportCmyk(n.id))}>导出 {String((n.data as GroupData).title)} · CMYK</button>)}
    <b>透明元素刀线</b><p>沿透明度 50% 的像素边缘追踪闭合轮廓，保留孔洞；成品宽高按轮廓外接框计算，忽略外围透明留白。SVG 使用毫米及 CutContour 图层，输出不自动补偿刀具、公差。</p>
    <label>成品宽 mm<input className="input" type="number" min={1} value={width} onChange={e=>setWidth(+e.target.value)}/></label><label>成品高 mm<input className="input" type="number" min={1} value={height} onChange={e=>setHeight(+e.target.value)}/></label>
    <button className="btn" disabled={busy||!selected||!isTauri} onClick={()=>void act(exportCut)}>导出所选透明元素的刀线</button>{message&&<p role="status">{message}</p>}{busy&&<p>正在处理…</p>}
  </div>;
}
