/**
 * 导演台全屏层 3.0 — MOMO AI 制片工作站
 *
 * 本组件只负责装载与兜底（数据加载 / 项目缺失），实际壳层是
 * modules/studio/StudioShell（一壳七工位，方案 §4）。2.0 的四阶段导航
 * （策划/导演/成片/3D）、快速/专业模式、驾驶舱/详细视图双入口已退役
 * （方案 §11.3：UI 退役，数据不删——workspaceMode/cockpitView 保留在存档中不再读取）。
 */
import { useEffect } from "react";
import "./director.css"; // SegmentRefEditor / AskCard / 时间线等复用组件的既有样式
import "../studio/studio.css";
import { useUi } from "../../core/stores/uiStore";
import { useDirector } from "../../core/stores/directorStore";
import { useBoard } from "../../core/stores/boardStore";
import { StudioShell } from "../studio/StudioShell";

export function DirectorStudio() {
  const open = useUi((s) => s.directorOpen);
  const nodeId = useUi((s) => s.directorNodeId);
  const projectId = useUi((s) => s.directorProjectId);
  const close = () => useUi.getState().setDirectorOpen(false);
  const loaded = useDirector((s) => s.loaded);
  // 3.5 P0：打开状态直接携带 canonical projectId（画布节点 data.projectId），按 id 精确解析；
  // 节点 data 兜底 + nodeId 兜底只服务于旧会话状态（迁移期间双保险）
  const nodeProjectId = useBoard((s) => {
    for (const b of Object.values(s.boards)) {
      const n = b.nodes.find((x) => x.id === nodeId);
      if (n) return (n.data as { projectId?: string }).projectId;
    }
    return undefined;
  });
  const project = useDirector((s) =>
    (projectId ? s.projects.find((p) => p.id === projectId) : undefined) ??
      (nodeProjectId ? s.projects.find((p) => p.id === nodeProjectId) : undefined) ??
      s.projects.find((p) => p.nodeId === nodeId),
  );

  useEffect(() => {
    if (open) void useDirector.getState().init();
  }, [open]);

  if (!open) return null;

  if (!loaded) {
    return (
      <div className="director-studio studio3">
        <div className="st-loading">正在加载制片工作站数据…</div>
      </div>
    );
  }
  if (!project) {
    return (
      <div className="director-studio studio3">
        <div className="st-loading">
          <p>未找到导演台项目（节点可能已被删除或数据损坏）。</p>
          <button className="st-btn" onClick={close}>关闭</button>
        </div>
      </div>
    );
  }

  return <StudioShell project={project} />;
}
