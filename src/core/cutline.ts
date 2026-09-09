/** 像素 alpha 边界转换为毫米 SVG 闭合轮廓；含孔洞，边界不猜实物尺寸。 */
export function alphaContours(alpha:Uint8ClampedArray,w:number,h:number,threshold=128):Array<Array<[number,number]>> {
  const edges=new Map<string,Array<[number,number]>>();
  if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||alpha.length!==w*h*4)throw new Error("蒙版尺寸无效");
  let count=0;
  const put=(x:number,y:number,a:number,b:number)=>{if(++count>200000)throw new Error("轮廓过于复杂，请先清理蒙版噪点或降低分辨率");const k=`${x},${y}`,list=edges.get(k)??[];list.push([a,b]);edges.set(k,list);};
  const on=(x:number,y:number)=>x>=0&&y>=0&&x<w&&y<h&&alpha[(y*w+x)*4+3]>=threshold;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(on(x,y)){
    if(!on(x,y-1))put(x,y,x+1,y);if(!on(x+1,y))put(x+1,y,x+1,y+1);if(!on(x,y+1))put(x+1,y+1,x,y+1);if(!on(x-1,y))put(x,y+1,x,y);
  }
  const loops:Array<Array<[number,number]>>=[];
  while(edges.size){const start=edges.keys().next().value!,first=start.split(",").map(Number) as [number,number],loop=[first];let key=start;
    do{const list=edges.get(key);if(!list?.length)throw new Error("轮廓未闭合，请检查透明蒙版");const next=list.pop()!;if(!list.length)edges.delete(key);loop.push(next);key=next.join(",");}while(key!==start);
    const reduced=loop.slice(0,-1).filter((p,i,a)=>{const before=a[(i+a.length-1)%a.length],after=a[(i+1)%a.length];return (p[0]-before[0])*(after[1]-p[1])!==(p[1]-before[1])*(after[0]-p[0]);});
    if(reduced.length>=3)loops.push(reduced);
  }
  return loops;
}
export function cutlineSvg(loops:Array<Array<[number,number]>>,pixelW:number,pixelH:number,widthMm:number,heightMm:number):string {
  if(![pixelW,pixelH,widthMm,heightMm].every(n=>Number.isFinite(n)&&n>0)||!loops.length)throw new Error("轮廓或毫米尺寸无效");
  // 成品尺寸以全部有效轮廓的外接框为准，外围透明留白不占成品尺寸。
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const loop of loops)for(const [x,y] of loop){if(!Number.isFinite(x)||!Number.isFinite(y))throw new Error("轮廓坐标无效");minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
  if(maxX<=minX||maxY<=minY)throw new Error("轮廓没有有效面积");
  const paths=loops.map(loop=>`<path d="M ${loop.map(([x,y])=>`${((x-minX)/(maxX-minX)*widthMm).toFixed(3)},${((y-minY)/(maxY-minY)*heightMm).toFixed(3)}`).join(" L ")} Z"/>`).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${widthMm} ${heightMm}"><title>切割轮廓 · 毫米 · 请核对工艺公差</title><g id="CutContour" fill="none" stroke="#ff00ff" stroke-width="0.1">${paths}</g></svg>`;
}
