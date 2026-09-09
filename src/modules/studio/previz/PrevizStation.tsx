/**
 * 3D 预演工位（导演台 3.0 · 方案 §6.8）— ThreeDPage 迁入统一外壳
 *
 * 3D 视口只在此工位全屏存在（不嵌入其他页面卡片）；
 * 视口与 H3 监看器共用 Stage 语义（始终暗色），导出站位图写
 * referenceRole: spatialLayout 可直接送片段参考（ThreeDPage 既有能力保留）。
 */
import { ThreeDPage } from "../../director/ThreeDPage";
import type { DirectorProject } from "../../../core/types";

export function PrevizStation({ project }: { project: DirectorProject }) {
  return (
    <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
      <ThreeDPage project={project} />
    </section>
  );
}
