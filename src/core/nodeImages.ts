import type { AppNode } from "./types";

/** 所有图片入口共用当前选中的结果，源图读取 src。 */
export function nodeMainImage(node: AppNode | undefined): string | undefined {
  if (!node) return undefined;
  const d = node.data as Record<string, unknown>;
  if (node.type === "image") return d.src as string | undefined;
  const results = d.results as string[] | undefined;
  return results?.length ? results[(d.picked as number | undefined) ?? 0] : undefined;
}

/** 画布选集送入助手：组按画布阅读顺序展开，多选父子节点不重复附图。 */
export function canvasReferenceImages(nodes: AppNode[], targets: AppNode[]): string[] {
  const seen = new Set<string>();
  const images: string[] = [];
  const visit = (node: AppNode) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    if (node.type === "group") {
      nodes.filter(n => n.parentId === node.id)
        .sort((a,b) => a.position.y - b.position.y || a.position.x - b.position.x).forEach(visit);
    } else {
      const src = nodeMainImage(node);
      if (src && !images.includes(src)) images.push(src);
    }
  };
  targets.forEach(visit);
  return images;
}
