import {useEffect,useRef,useState} from "react";
import {createPortal} from "react-dom";
import {useBoard} from "../../core/stores/boardStore";
import {useUi} from "../../core/stores/uiStore";
import {nodeMainImage} from "../../core/nodeEdit";
import {generatePlanarSheet,PLANAR_SHEET_RULES} from "../../core/planarSheet";
import {abortNode} from "../../core/runControl";
import {errMsg,isTauri} from "../../core/utils";
import type {ImageData} from "../../core/types";
import {ModelPicker} from "../../ui/ModelPicker";
import {Thumb} from "../../ui/Thumb";
import {IcClose} from "../../ui/icons";
import "./designTools.css";

export function PlanarSheetPanel(){
  const id=useUi(s=>s.planarSheetNodeId)!,nodes=useBoard(s=>s.nodes),origin=useRef(useBoard.getState().activeId);
  const node=nodes.find(n=>n.id===id),meta=(node?.data as ImageData)?.planarSheet;
  const [prompt,setPrompt]=useState(meta?.prompt??PLANAR_SHEET_RULES),[model,setModel]=useState(meta?.modelId),[width,setWidth]=useState(meta?.width??2048),[height,setHeight]=useState(meta?.height??1536);
  const [draft,setDraft]=useState<string|undefined>(meta?id:undefined),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const root=useRef<HTMLElement>(null),alive=useRef(true),vectorTask=useRef<string|null>(null);
  const close=()=>useUi.getState().setPlanarSheetNodeId(null);
  useEffect(()=>{alive.current=true;const before=document.activeElement as HTMLElement;root.current?.querySelector<HTMLElement>("button")?.focus();const key=(e:KeyboardEvent)=>{if(e.key==="Escape"){e.stopPropagation();close();}if(e.key==="Tab"){const a=[...root.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]')];if(e.shiftKey&&document.activeElement===a[0]){e.preventDefault();a[a.length-1]?.focus();}else if(!e.shiftKey&&document.activeElement===a[a.length-1]){e.preventDefault();a[0]?.focus();}}};document.addEventListener("keydown",key,true);return()=>{alive.current=false;if(vectorTask.current)abortNode(vectorTask.current);abortNode(`planar-sheet:${meta?.sourceNodeId??id}`);document.removeEventListener("keydown",key,true);before?.focus();};},[id]);
  const source=nodeMainImage(meta?nodes.find(n=>n.id===meta.sourceNodeId):node),result=nodeMainImage(nodes.find(n=>n.id===draft));
  const run=async()=>{setBusy(true);setError("");try{const newId=await generatePlanarSheet(meta?.sourceNodeId??id,prompt,model,width,height);if(alive.current&&newId)setDraft(newId);}catch(e){if(alive.current)setError(errMsg(e));}finally{if(alive.current)setBusy(false);}};
  const vector=async()=>{if(!draft)return;setBusy(true);setError("");try{if(useBoard.getState().activeId!==origin.current)throw Error("画布已切换");const s=useBoard.getState(),old=new Set(s.nodes.map(n=>n.id));s.spawnEdit(draft,"vectorize");const added=useBoard.getState().nodes.find(n=>!old.has(n.id)&&n.type==="vectorize");if(!added)throw Error("无法建立矢量节点");vectorTask.current=added.id;useBoard.getState().updateData(added.id,{preset:"flat",flatColors:12,quality:"high-fidelity",filterSpeckle:1});const {runFlow}=await import("../../core/runner");if(!alive.current)return;await runFlow(added.id);if(alive.current){const data=useBoard.getState().nodes.find(n=>n.id===added.id)?.data;if(data?.status==="error")setError(String(data.error??"矢量化失败，可在画布重试"));else if(data?.status==="done")close();else setError("矢量化未完成，可在画布节点继续运行");}}catch(e){if(alive.current)setError(errMsg(e));}finally{if(alive.current)setBusy(false);}};
  return createPortal(<div className="design-overlay"><section ref={root} className="design-dialog planar-dialog" role="dialog" aria-modal="true" aria-label="立体转平面矢量">
    <header><b>立体转平面矢量</b><button className="icon-btn" onClick={close} aria-label="关闭平面总稿"><IcClose size={18}/></button></header>
    <p>先让绘画模型重建完整平面部件总稿，再生成 SVG 或逐件拆出。与直接抠取原图的「元素分层」分开。</p>
    <ol className="planar-steps"><li>效果图</li><li>平面总稿</li><li>拆件 / 局部重绘</li><li>色块清理 → SVG / PDF</li></ol>
    <div className="planar-previews"><figure><figcaption>输入参考</figcaption>{source&&<Thumb src={source}/>}</figure><figure><figcaption>平面部件总稿 · 栅格预览</figcaption>{result?<Thumb src={result}/>:<p>生成后在这里核对：完全正视、无厚度阴影、各件完整分离。</p>}</figure></div>
    <label>平面化提示词<textarea className="textarea" rows={7} value={prompt} disabled={busy} onChange={e=>setPrompt(e.target.value)}/></label>
    <div className="planar-settings"><ModelPicker role="image" value={model} onChange={setModel}/><label>目标宽 px<input type="number" min={256} max={4096} value={width} disabled={busy} onChange={e=>setWidth(+e.target.value)}/></label><label>目标高 px<input type="number" min={256} max={4096} value={height} disabled={busy} onChange={e=>setHeight(+e.target.value)}/></label></div>
    <p className="design-hint">目标尺寸由模型能力决定。绘画模型的“矢量风格图”仍是图片。下一步使用本地描摹生成含路径的 SVG。图中文字、被遮挡内容和生产尺寸请核对。</p>
    <div className="planar-actions"><button className="btn primary" disabled={busy||!source} onClick={()=>void run()}>{busy?"处理中…":result?"重新生成总稿":"生成平面总稿"}</button><button className="btn" disabled={busy||!result||!isTauri} onClick={()=>void vector()}>清理色块并转 SVG</button><button className="btn" disabled={busy||!result} onClick={()=>{close();useUi.getState().setLayerEditorNodeId(draft!);}}>原图拆件 / 模糊件重绘</button>{busy&&<button className="btn" onClick={()=>{abortNode(`planar-sheet:${meta?.sourceNodeId??id}`);if(vectorTask.current)abortNode(vectorTask.current);}}>停止生成</button>}</div>
    {error&&<p role="alert">{error}</p>}
  </section></div>,document.body);
}
