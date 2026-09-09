import {flatElementsToCanvas} from '../../src/core/elementFlat';
import {useBoard} from '../../src/core/stores/boardStore';
import {useSettings} from '../../src/core/stores/settingsStore';
import {loadImg} from '../../src/core/maskCanvas';
if(location.hostname!=='[::1]')throw Error('独立来源限定');
const endpoint='http://[::1]:1433';
document.querySelector<HTMLButtonElement>('#run')!.onclick=async e=>{
  (e.currentTarget as HTMLButtonElement).disabled=true;const log=document.querySelector('#log')!,report:any[]=[],images:string[]=[];
  const write=(s:string)=>{log.textContent+=s+'\n';};
  try{
    const config=await(await fetch(endpoint+'/config')).json(),fixture=await(await fetch(endpoint+'/fixture')).json();useSettings.setState({settings:config.settings});useBoard.getState().newBoard();
    const id=useBoard.getState().addNode('image',{x:0,y:0},{src:fixture.src,status:'done'});
    const confirm=window.confirm;window.confirm=()=>true;
    try{for(const view of ['front','back','bottom'] as const){
      const ok=await flatElementsToCanvas(id,[{id:'cube',name:'红色立方体展陈装饰块',role:'subject',box:[.27,.24,.46,.5]}],{view,width:101.6,height:76.2,unit:'mm',dpi:100,background:'#e8edf5',transparent:false,backColor:'#f5ce36',bottomColor:'#256b4c',modelId:config.selected.image},message=>write(message));
      const node=useBoard.getState().nodes.filter(n=>n.id!==id&&n.type==='image').at(-1),src=(node?.data as any)?.src;
      if(!ok||!src)throw Error(view+'生成未完成');const image=await loadImg(src);if(image.naturalWidth!==400||image.naturalHeight!==300)throw Error('尺寸不符');images.push(src);const el=document.createElement('img');el.src=src;el.alt=view;document.querySelector('#outputs')!.append(el);
      report.push({view,width:image.naturalWidth,height:image.naturalHeight,dpi:100,success:true});write('通过 '+view+' 400×300px / 101.6×76.2mm @100DPI');
    }}finally{window.confirm=confirm;}
    await fetch(endpoint+'/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({images,messages:report})});write('真实拆解三视图已保存');
  }catch(e){write('失败 '+String(e));}
};
