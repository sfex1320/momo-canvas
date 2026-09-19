import type { EcomSlide } from "./types";

export const ECOM_CONTINUITY_RULES = `把所有切片当作同一张连续长图的纵向窗口。先设计整张长图的阅读流、统一底色和贯穿曲线，再分切。
每片输出 entryEdge 和 exitEdge：分别说明顶部与底部边缘的底色色值、纹理、延伸元素及其横向位置（百分比）。后一片 entryEdge 必须逐字等于前一片 exitEdge。
各片上下边缘保留约 6% 无文字的过渡区，不放页脚、边框、完整卡片收口或独立海报留白。内容通过连续背景、光带或曲线自然过渡，不能每片重新开场。主题需要变色时在片内缓慢渐变，到边缘时必须与下一片一致。`;

/** 整批与单片重生共用的边界约束，旧规划缺字段时也明确引用真实邻片。 */
export function ecomContinuityPrompt(slides:EcomSlide[],index:number,refs:string[],edge?:string,next?:string):string {
  const current=slides[index], prev=slides[index-1], after=slides[index+1];
  const lines=[`这是一张连续长图的第 ${index+1}/${slides.length} 个纵向窗口，只输出当前窗口，不重画上一片整张内容。内容顺序：${slides.map(s=>s.title).join(" → ")}。`];
  const entry=prev?.exitEdge || current.entryEdge;
  const exit=after?.entryEdge || current.exitEdge;
  if(entry)lines.push(`顶部入画边界（严格匹配）：${entry}`);
  if(exit)lines.push(`底部出画边界（严格匹配）：${exit}`);
  if(edge && refs.includes(edge))lines.push(`图${refs.indexOf(edge)+1}是紧邻上一片的底部裁条，只作接缝参考。本片顶部从该裁条最下沿继续向下延伸，延续相同的底色、光照、纹理尺度和曲线横向位置；不要重复裁条内容，不把裁条当产品或全图构图。`);
  if(next && refs.includes(next))lines.push(`图${refs.indexOf(next)+1}是紧邻下一片的顶部裁条，本片底部须与它的最上沿相接，向相同底色与形状自然过渡。`);
  lines.push("上下各约 6% 保持无文字的连续背景过渡区；不加片间边框、页脚、分割线、圆角卡片收口。阅读流必须纵向贯穿接缝。");
  return lines.join("\n");
}

export async function ecomEdge(src:string,side:"top"|"bottom"):Promise<string> {
  const image=new Image();image.crossOrigin="anonymous";
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("切片接缝参考读取超时")),30_000);image.onload=()=>{clearTimeout(timer);resolve();};image.onerror=()=>{clearTimeout(timer);reject(Error("无法读取相邻切片，不能建立接缝参考"));};image.src=src;});
  const h=Math.max(1,Math.round(image.naturalHeight*.18)), width=Math.min(1536,image.naturalWidth);
  const canvas=document.createElement("canvas");canvas.width=width;canvas.height=Math.max(1,Math.round(h*width/image.naturalWidth));
  const ctx=canvas.getContext("2d");if(!ctx)throw Error("无法准备切片接缝参考");
  ctx.drawImage(image,0,side==="bottom"?image.naturalHeight-h:0,image.naturalWidth,h,0,0,canvas.width,canvas.height);
  return canvas.toDataURL("image/png");
}
