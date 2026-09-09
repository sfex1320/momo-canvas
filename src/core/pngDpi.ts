/** PNG pHYs 元数据；保留原始像素与其它块，不重新编码图像。规范：https://www.w3.org/TR/png-3/#11pHYs */
export function pngWithDpi(source: Uint8Array, dpi: number): Uint8Array {
  const ppm = Math.round(dpi / .0254);
  if (!Number.isFinite(dpi) || dpi < 1 || ppm > 0xffffffff) throw new Error("DPI 超出有效范围");
  const signature = [137,80,78,71,13,10,26,10];
  if (!signature.every((v,i)=>source[i]===v)) throw new Error("不是有效的 PNG 图片");
  const chunk = new Uint8Array(21), view = new DataView(chunk.buffer);
  view.setUint32(0,9); chunk.set([112,72,89,115],4);
  view.setUint32(8,ppm); view.setUint32(12,ppm); chunk[16]=1;
  let crc=0xffffffff;
  for (const value of chunk.subarray(4,17)) {
    crc ^= value;
    for (let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);
  }
  view.setUint32(17,(crc^0xffffffff)>>>0);
  const parts: Uint8Array[]=[source.subarray(0,8)];
  const input=new DataView(source.buffer,source.byteOffset,source.byteLength);
  let inserted=false, ended=false;
  for(let offset=8;offset<source.length;) {
    if(offset+12>source.length) throw new Error("PNG 数据不完整");
    const len=input.getUint32(offset), end=offset+12+len;
    if(end>source.length) throw new Error("PNG 数据块不完整");
    const kind=String.fromCharCode(...source.subarray(offset+4,offset+8));
    if(offset===8 && (kind!=="IHDR"||len!==13)) throw new Error("PNG 图片头无效");
    if(kind==="IDAT"&&!inserted) {parts.push(chunk);inserted=true;}
    if(kind!=="pHYs") parts.push(source.subarray(offset,end));
    offset=end;
    if(kind==="IEND") {ended=true;break;}
  }
  if(!inserted||!ended) throw new Error("PNG 缺少图像数据或结束标记");
  const output=new Uint8Array(parts.reduce((sum,p)=>sum+p.length,0));
  let cursor=0;for(const part of parts){output.set(part,cursor);cursor+=part.length;}
  return output;
}

export function pngDataUrlWithDpi(dataUrl: string, dpi: number) {
  if (!dataUrl.startsWith("data:image/png;base64,")) throw new Error("尺寸信息只能写入 PNG 图片");
  const bytes=Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",")+1)),c=>c.charCodeAt(0));
  const output=pngWithDpi(bytes,dpi);
  const pieces: string[]=[];
  for(let i=0;i<output.length;i+=32768) pieces.push(String.fromCharCode(...output.subarray(i,i+32768)));
  return "data:image/png;base64,"+btoa(pieces.join(""));
}
