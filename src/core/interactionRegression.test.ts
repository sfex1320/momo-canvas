import {assetAutoGroup,assetVisibleOnBoard} from "./assetOrganization.ts";
import {ecomContinuityPrompt} from "./ecomContinuity.ts";
import type {AssetItem,EcomSlide} from "./types";

function check(name:string,ok:boolean){if(!ok)throw Error(`失败：${name}`);console.log(`通过：${name}`);}
const base:AssetItem={id:"a",kind:"image",name:"测试",path:"a.png",mime:"image/png",size:1,source:"canvas",createdAt:0,boardId:"board-a",nodeId:"node-a"};
check("同节点跨画布不会折叠到一起",assetAutoGroup(base)!==assetAutoGroup({...base,boardId:"board-b"}));
check("人工生成组优先",assetAutoGroup({...base,groupId:"manual"})==="manual");
check("明确归属其他画布，即使节点名相同也不显示",!assetVisibleOnBoard(base,"board-b",new Set(["node-a"])));
check("旧资产按节点归属回退",assetVisibleOnBoard({...base,boardId:undefined},"board-a",new Set(["node-a"])));
check("旧资产缺少证据不混入当前画布",!assetVisibleOnBoard({...base,boardId:undefined,nodeId:undefined},"board-a",new Set()));
check("导入图片与视频各自整理",assetAutoGroup({...base,source:"import",nodeId:undefined})!==assetAutoGroup({...base,source:"import",nodeId:undefined,kind:"video"}));
const slides:EcomSlide[]=[{title:"开场",prompt:"产品",exitEdge:"米白底，曲线 x=30%"},{title:"细节",prompt:"放大",entryEdge:"模型误填红色",exitEdge:"模型误填蓝色"},{title:"结束",prompt:"总结",entryEdge:"米白底，曲线 x=70%"}];
const prompt=ecomContinuityPrompt(slides,1,["product","bottom","top"],"bottom","top");
check("单片重生以两个真实邻片边界为准",prompt.includes("x=30%")&&prompt.includes("x=70%")&&!prompt.includes("模型误填"));
check("裁条编号与实际参考槽保持一致",prompt.includes("图2是紧邻上一片")&&prompt.includes("图3是紧邻下一片"));
check("被容量裁剪的参考图不产生虚假编号",!ecomContinuityPrompt(slides,1,["product"],"bottom","top").includes("图0"));
check("旧项目缺少接缝字段仍有连续布局约束",ecomContinuityPrompt([{title:"旧段",prompt:"旧提示词"}],0,[]).includes("6%"));
