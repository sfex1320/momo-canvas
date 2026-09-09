/** 效果图 → 单张平面部件总稿；抠图、SVG 描摹为明确的后续步骤。 */
import { useBoard } from "./stores/boardStore";
import { useAssets } from "./stores/assetStore";
import { resolveModelCard } from "./stores/settingsStore";
import { useUsage } from "./stores/usageStore";
import { nodeMainImage } from "./nodeEdit";
import { generateImage } from "./services/imageGen";
import { budgetGate } from "./capability/budget";
import { estimateCost } from "./pricing";
import { beginTask, endTask, acquireSlot } from "./runControl";
import { isTauri } from "./utils";
import { imageFamily, nearestAspect } from "./modelMeta";

export {PLANAR_SHEET_RULES} from "./planarSheetPrompt";

const running=new Set<string>();
export async function generatePlanarSheet(nodeId:string,prompt:string,modelId:string|undefined,width:number,height:number):Promise<string|null>{
  if(running.has(nodeId))throw Error("这张效果图正在生成平面总稿");
  if(!prompt.trim())throw Error("请填写平面总稿要求");
  if(![width,height].every(v=>Number.isInteger(v)&&v>=256&&v<=4096)||width*height>16_000_000)throw Error("生成尺寸为 256–4096 像素，总量不超过 1600 万像素");
  const board=useBoard.getState(),node=board.nodes.find(n=>n.id===nodeId),src=nodeMainImage(node);
  if(!node||!src)throw Error("效果图已不存在");
  const origin=board.activeId,card=resolveModelCard("image",modelId),cost=estimateCost(card.model,{images:1});
  const gate=budgetGate(cost,"立体转平面矢量",{billing:card.protocol==="codex"?"subscription":undefined});if(gate.block)throw Error(gate.block);
  running.add(nodeId);
  const taskId=`planar-sheet:${nodeId}`,signal=beginTask(taskId,"立体转平面矢量");
  try{
    const message=`使用 ${card.name} · ${card.model} 生成一张平面部件总稿，${card.protocol==="codex"?"消耗 Codex 共享会员额度":`预估 ¥${cost.toFixed(2)}`}。\n请先核对提示词和原效果图。继续生成？`;
    const yes=isTauri?await(await import("@tauri-apps/plugin-dialog")).ask(message,{title:"立体转平面矢量"}):window.confirm(message);
    if(!yes)return null;
    signal.throwIfAborted();
    if(useBoard.getState().activeId!==origin)throw Error("画布已切换，请回到原画布操作");
    const release=await acquireSlot(signal),start=Date.now();let billed=false;
    try{
      const results=await generateImage(card,{prompt,refImages:[src],n:1,signal,...(imageFamily(card)==="banana"?{aspect:nearestAspect(width/height),resolution:"2K"}:{size:`${width}x${height}`})});
      if(!results[0])throw Error("模型没有返回平面总稿");
      useUsage.getState().record(card,{ok:true,images:results.length,durMs:Date.now()-start});billed=true;
      const asset=await useAssets.getState().collect({src:results[0],kind:"image",name:"平面部件总稿",prompt,model:card.model});
      if(!asset)throw Error("平面总稿未能保存到资产库");
      signal.throwIfAborted();if(useBoard.getState().activeId!==origin||!useBoard.getState().nodes.some(n=>n.id===nodeId))return null;
      const parent=node.parentId?board.nodes.find(n=>n.id===node.parentId):undefined;
      return useBoard.getState().addNode("image",{x:node.position.x+(parent?.position.x??0)+(node.measured?.width??320)+100,y:node.position.y+(parent?.position.y??0)},
        {src:results[0],name:"平面部件总稿",status:"done",planarSheet:{sourceNodeId:nodeId,prompt,modelId,width,height}});
    }catch(e){if(!billed)useUsage.getState().record(card,{ok:false,durMs:Date.now()-start});throw e;}finally{release();}
  }finally{endTask(taskId);running.delete(nodeId);}
}
