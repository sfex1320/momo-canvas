import {SkillManager} from "../../src/modules/skills/SkillManager";
import React from "react";
import { createRoot } from "react-dom/client";
import { ReactFlow, ReactFlowProvider, Background } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "../../src/styles/theme.css";
import "../../src/styles/base.css";
import "../../src/modules/canvas/canvas.css";
import { ImageNode } from "../../src/modules/canvas/nodes/ImageNode";
import { GroupNode } from "../../src/modules/canvas/nodes/GroupNode";
import { LayerEditor } from "../../src/modules/canvas/LayerEditor";
import { useBoard } from "../../src/core/stores/boardStore";
import { useUi } from "../../src/core/stores/uiStore";
import { useSettings } from "../../src/core/stores/settingsStore";
import { createStoryboardGroup } from "../../src/core/nodeEdit";

if (location.hostname !== "[::1]") throw new Error("视觉回归须使用独立 [::1] 来源");
document.documentElement.dataset.theme="light";
const originalFetch=window.fetch.bind(window);
window.fetch=(input,init)=>String(input).startsWith("data:")||String(input).startsWith("blob:")?originalFetch(input,init):Promise.reject(new Error("视觉回归不调用真实模型，可手工圈选"));
useSettings.setState(s=>({settings:{...s.settings,models:{...s.settings.models,providers:[]}}}));
useBoard.getState().newBoard();
const c=document.createElement("canvas");c.width=1024;c.height=1024;const ctx=c.getContext("2d")!;
ctx.fillStyle="#b80729";ctx.fillRect(0,0,1024,1024);ctx.strokeStyle="#f8d679";ctx.lineWidth=35;ctx.beginPath();ctx.arc(512,512,385,0,Math.PI*2);ctx.stroke();ctx.lineWidth=8;ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(1024,1024);ctx.moveTo(1024,0);ctx.lineTo(0,1024);ctx.stroke();ctx.fillStyle="#f8d679";ctx.font="bold 105px sans-serif";ctx.textAlign="center";ctx.fillText("MOMO",512,530);
const source=useBoard.getState().addNode("image",{x:-600,y:0},{src:c.toDataURL(),status:"done",name:"无缝测试图"});
await createStoryboardGroup(source,Array.from({length:9},(_,i)=>`${Math.floor(i/3)}-${i%3}`),[1/3,2/3],[1/3,2/3]);
const visibleIds=useBoard.getState().nodes.map(n=>n.id);
const nodeTypes={image:ImageNode,group:GroupNode};
function Preview(){const nodes=useBoard(s=>s.nodes);return <ReactFlowProvider><div style={{height:"100vh",width:"100vw"}}>
  <ReactFlow nodes={nodes.filter(n=>visibleIds.includes(n.id)).map(n=>({...n,selected:false}))} edges={[]} nodeTypes={nodeTypes} fitView><Background /></ReactFlow>
  <div style={{position:"fixed",top:10,left:12,zIndex:9,display:"flex",gap:10}}><button className="btn" onClick={()=>useUi.getState().setLayerEditorNodeId(source)}>检查元素工坊</button><button className="btn" onClick={()=>useUi.getState().setSkillMgrOpen(true)}>检查内置 Skill 删除</button>{["light","blue","black"].map(t=><button className="btn" key={t} onClick={()=>document.documentElement.dataset.theme=t}>{t}</button>)}<span>真实节点 · 阴影与无缝宫格</span></div><LayerEditor /><SkillManager/>
</div></ReactFlowProvider>}
createRoot(document.getElementById("root")!).render(<Preview/>);
