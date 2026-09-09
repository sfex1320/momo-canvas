/** 所有相邻格共用同一整数像素边界，避免分别四舍五入造成重复或漏掉一列像素。 */
export function pixelGrid(width: number, height: number, xs: number[], ys: number[]) {
  const edges = (size: number, cuts: number[]) => [...new Set([
    0, ...cuts.filter(Number.isFinite).map(v => Math.round(Math.max(0, Math.min(1, v)) * size)), size,
  ])].sort((a, b) => a - b);
  const x = edges(width, xs), y = edges(height, ys);
  return y.slice(0, -1).flatMap((top, r) => x.slice(0, -1).map((left, c) => ({
    r, c, x: left, y: top, w: x[c + 1] - left, h: y[r + 1] - top,
  })));
}

/** 等比缩放整组，保留每片真实尺寸；边界先取整再相减，屏幕格位也不产生小数缝。 */
export function tileLayout(cells: Array<{ w: number; h: number }>, cols: number, scale: number) {
  cols = Math.max(1, Math.floor(cols));
  let top = 0;
  const positions: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (let start = 0; start < cells.length; start += cols) {
    let left = 0, rowHeight = 0;
    for (const cell of cells.slice(start, start + cols)) {
      const right = left + cell.w * scale;
      const bottom = top + cell.h * scale;
      positions.push({ x: Math.round(left), y: Math.round(top), w: Math.round(right) - Math.round(left), h: Math.round(bottom) - Math.round(top) });
      left = right;
      rowHeight = Math.max(rowHeight, cell.h * scale);
    }
    top += rowHeight;
  }
  return { positions, w: Math.max(0, ...positions.map(p => p.x + p.w)), h: Math.round(top) };
}
