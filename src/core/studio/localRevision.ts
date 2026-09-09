import { useDirector } from "../stores/directorStore";
import { useAssets } from "../stores/assetStore";
import { assetToBlobUrl, assetUrl } from "../services/assetFiles";
import { losslessVideo } from "../productionTools";
import { grabFrame, recordSegments, videoDuration } from "../videoEdit";
import { generateVideo, type AdapterSpecReport } from "../services/videoGen";
import { resolveModelCard } from "../stores/settingsStore";
import { estimateCost } from "../pricing";
import { budgetGate } from "../capability/budget";
import { useUsage } from "../stores/usageStore";
import { uid } from "../utils";
import { mirrorProjectAsset } from "./projectAssetRouter";
import type { DirectorTake } from "../types";

export function replacementPlan(duration:number,start:number,end:number,replacementDuration:number) {
  if(![duration,start,end,replacementDuration].every(Number.isFinite)||duration<=0||start<0||end>duration+0.05||end-start<0.1)throw new Error("替换区间须位于原视频内，且至少0.1秒");
  if(replacementDuration+0.05<end-start)throw new Error("替换素材短于选定区间，请缩小区间或生成更长的视频");
  return {start,end:Math.min(end,duration),length:Math.min(end,duration)-start};
}
async function videoAsset(id:string){const a=useAssets.getState().items.find(a=>a.id===id&&a.kind==="video");if(!a)throw new Error("视频素材已丢失，请重新选择");return {asset:a,url:await assetToBlobUrl(a.path,a.mime)};}

/** 只生成待替换区间；先收录独立素材，之后合成失败也无需再次付费。 */
export async function generateReplacement(p:{projectId:string;sourceId:string;start:number;end:number;prompt:string;modelKey?:string;aspect:string;signal:AbortSignal;onProgress:(msg:string)=>void;confirmed:boolean}) {
  if(!p.confirmed||!p.prompt.trim())throw new Error("请填写局部重做要求并确认请求");
  p.signal.throwIfAborted();
  const source=await videoAsset(p.sourceId),duration=await videoDuration(source.url);
  replacementPlan(duration,p.start,p.end,p.end-p.start);
  const card=resolveModelCard("video",p.modelKey),seconds=p.end-p.start;
  const gate=budgetGate(estimateCost(card.model,{videoSec:seconds}),"局部视频重做");if(gate.block)throw new Error(gate.block);
  const first=await grabFrame(source.url,"custom",p.start),last=await grabFrame(source.url,"custom",Math.max(p.start,p.end-0.05));
  p.signal.throwIfAborted();
  let applied:AdapterSpecReport|undefined;const started=Date.now();
  const src=await generateVideo(card,{prompt:p.prompt,image:first.dataUrl,lastFrame:last.dataUrl,aspect:p.aspect,duration:String(seconds),signal:p.signal,onProgress:p.onProgress,onSpecApplied:r=>{applied=r;}});
  useUsage.getState().record(card,{ok:true,videoSec:applied?.durationSec??seconds,durMs:Date.now()-started});
  // 已生成素材优先入库，避免停止发生在收费成功后造成结果丢失。
  const a=await useAssets.getState().collect({src,kind:"video",name:`局部重做 ${p.start.toFixed(2)}–${p.end.toFixed(2)}秒`,prompt:p.prompt,director:{projectId:p.projectId,role:"generated"}});
  if(!a)throw new Error("视频已生成，但保存失败，请检查存储空间");
  return {assetId:a.id,applied};
}

/** 原版保持不变，新版本必须由用户手动采用。 */
export async function applyLocalRevision(p:{projectId:string;segmentId:string;takeId:string;replacementId:string;start:number;end:number;signal:AbortSignal;onProgress:(msg:string)=>void;lossless?:boolean}) {
  p.signal.throwIfAborted();
  const project=useDirector.getState().getById(p.projectId),segment=project?.scenes.flatMap(s=>s.segments).find(s=>s.id===p.segmentId),take=segment?.takes?.find(t=>t.id===p.takeId);
  if(!take?.assetId||take.status!=="done")throw new Error("请先选择成功的视频版本");
  const source=await videoAsset(take.assetId),replacement=await videoAsset(p.replacementId);
  const range=replacementPlan(await videoDuration(source.url),p.start,p.end,await videoDuration(replacement.url));
  const parts=[...(range.start>0?[{src:source.url,start:0,end:range.start}]:[]),{src:replacement.url,start:0,end:range.length},...(range.end<await videoDuration(source.url)-0.01?[{src:source.url,start:range.end}]:[])];
  p.onProgress(p.lossless?"检查编码与关键帧，原码流无损拼接…":"兼容合成…");
  const copied=p.lossless?await losslessVideo(parts.map(part=>({path:part.src===source.url?source.asset.path:replacement.asset.path,start:part.start,end:part.end})),p.signal):undefined;
  const url=copied?assetUrl(copied.path):await recordSegments(parts,p.onProgress,p.signal);
  try{
    p.signal.throwIfAborted();
    const asset=await useAssets.getState().collect({src:url,kind:"video",name:`局部修订 · ${segment!.summary.slice(0,20)}`,prompt:take.promptSnapshot,director:{projectId:p.projectId,segmentId:p.segmentId,role:"generated"}});
    if(!asset)throw new Error("新版本保存失败");
    const next:DirectorTake={id:uid(10),segmentId:p.segmentId,kind:"video",target:"clip",status:"done",assetId:asset.id,promptSnapshot:take.promptSnapshot,createdAt:Date.now(),finishedAt:Date.now(),derivedFrom:{takeId:take.id,postRecipeId:"local-revision",postRecipeName:`局部替换 ${range.start.toFixed(2)}–${range.end.toFixed(2)}秒`},paramSnapshot:{replacementAssetId:p.replacementId,startSec:range.start,endSec:range.end,format:"webm",fps:30},note:"局部修订版；实时重编码，保留各片段原声；待人工检查后采用"};
    if(copied){next.paramSnapshot={...next.paramSnapshot,format:"mp4",fps:undefined,mode:"stream-copy",actualDurationSec:copied.duration};next.note="原码流无损局部修订；编码与关键帧检查通过，待人工检查后采用";}
    const latest=useDirector.getState().getById(p.projectId);if(!latest)throw new Error("原项目已删除，新视频已保留在资产库");
    useDirector.getState().updateProject(p.projectId,{scenes:latest.scenes.map(s=>({...s,segments:s.segments.map(g=>g.id===p.segmentId?{...g,takes:[...(g.takes??[]),next]}:g)}))});
    void mirrorProjectAsset({projectId:p.projectId,segmentId:p.segmentId,category:"take",assetId:asset.id});
    return next;
  }finally{if(url.startsWith("blob:"))URL.revokeObjectURL(url);}
}
