/**
 * Windows .lnk（Shell Link，MS-SHLLINK）二进制解析 — 只取目标路径
 * 背景：dragDropEnabled=false 时 HTML5 拖放拿不到 OS 文件路径（Windows 平台限制），
 * 但 .lnk 快捷方式文件的字节里写着目标路径，借此支持「把快捷方式拖进来固定」。
 */

/** 读 null 结尾的 ANSI 字符串（中文 Windows 为 GBK） */
function readAnsiZ(bytes: Uint8Array, off: number): string {
  let end = off;
  while (end < bytes.length && bytes[end] !== 0) end++;
  const slice = bytes.slice(off, end);
  try {
    return new TextDecoder("gbk").decode(slice);
  } catch {
    try {
      return new TextDecoder("windows-1252").decode(slice);
    } catch {
      return "";
    }
  }
}

/** 读 null 结尾的 UTF-16LE 字符串 */
function readUtf16z(bytes: Uint8Array, off: number): string {
  const out: number[] = [];
  for (let i = off; i + 1 < bytes.length; i += 2) {
    const c = bytes[i] | (bytes[i + 1] << 8);
    if (!c) break;
    out.push(c);
  }
  return String.fromCharCode(...out);
}

/** 解析 .lnk 目标路径；非法/网络路径等解析不出时返回 null */
export function parseLnkTarget(bytes: Uint8Array): string | null {
  try {
    if (bytes.length < 0x4c) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== 0x4c) return null; // HeaderSize 固定 0x4C
    const flags = dv.getUint32(0x14, true);
    let off = 0x4c;
    if (flags & 0x1) {
      // HasLinkTargetIDList：跳过 IDList
      off += 2 + dv.getUint16(off, true);
    }
    if (!(flags & 0x2)) return null; // 无 LinkInfo
    const li = off;
    const headerSize = dv.getUint32(li + 4, true);
    const liFlags = dv.getUint32(li + 8, true);
    if (!(liFlags & 0x1)) return null; // 无 VolumeIDAndLocalBasePath（如网络共享）
    // Unicode 偏移（LinkInfoHeaderSize >= 0x24 时才存在，优先使用，避免编码问题）
    if (headerSize >= 0x24) {
      const uOff = dv.getUint32(li + 0x1c, true);
      if (uOff) {
        const p = readUtf16z(bytes, li + uOff);
        if (p) return p;
      }
    }
    const aOff = dv.getUint32(li + 0x10, true); // LocalBasePathOffset
    const sOff = dv.getUint32(li + 0x18, true); // CommonPathSuffixOffset
    const base = aOff ? readAnsiZ(bytes, li + aOff) : "";
    const suffix = sOff ? readAnsiZ(bytes, li + sOff) : "";
    if (!base && !suffix) return null;
    if (base && suffix) return base.endsWith("\\") ? base + suffix : `${base}\\${suffix}`;
    return base || suffix;
  } catch {
    return null;
  }
}
