import React from "react";
import {createRoot} from "react-dom/client";
import {CodexBridgeCard} from "../../src/modules/settings/CodexBridgeCard";
import {VectorizeConfigPanel} from "../../src/modules/canvas/EditPanels";
import {useBoard,defaultData} from "../../src/core/stores/boardStore";
import {ModelPicker} from "../../src/ui/ModelPicker";
import "../../src/styles/theme.css";
import "../../src/styles/base.css";
import "../../src/modules/settings/settings.css";
import "../../src/modules/canvas/canvas.css";
document.documentElement.dataset.theme="black";
useBoard.setState({nodes:[{id:"qa-vector",type:"vectorize",position:{x:0,y:0},selected:true,data:{...defaultData("vectorize"),preset:"flat",status:"done",svg:'<svg width="400" height="200"/>',resultW:400,resultH:200}}],edges:[]});
function Page(){const [model,setModel]=React.useState<string>();return <main style={{padding:30,maxWidth:1100,margin:"auto"}}><h2>Codex 与平面拆件 · 隔离界面验收</h2><CodexBridgeCard/><ModelPicker role="image" value={model} onChange={setModel}/><VectorizeConfigPanel/></main>}
createRoot(document.getElementById("root")!).render(<Page/>);
