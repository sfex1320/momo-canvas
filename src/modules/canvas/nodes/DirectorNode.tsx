/**
 * 导演台节点 — 项目级复合节点
 *  - 卡片只显示项目名、目标时长、完成度占位和「进入导演台」按钮
 *  - 新建节点时自动创建对应项目（directorStore）
 *  - director 不加入 RUNNERS（避免「全部运行」意外触发整集生成）
 *  - 有 outputUrl 时输出视频，否则不向下游传值
 *  - 上游接入的图片显示为有序缩略图条（顺序 = 生成时喂给模型的顺序），并自动同步进项目素材槽
 *
 * 详见《MOMO导演台节点-产品与技术方案.md》§6.1。
 */
import { memo, useEffect, useMemo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortIn, PortOut } from "../NodeShell";
import { IcFilmFrame, IcLoading } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { useDirector } from "../../../core/stores/directorStore";
import { useAssets } from "../../../core/stores/assetStore";
import { useUi } from "../../../core/stores/uiStore";
import { collectUpstream } from "../../../core/runner";
import { syncRefSlots, hashDataUrl } from "../../../core/directorRefs";
import { assetUrl } from "../../../core/services/assetFiles";
import { Thumb } from "../../../ui/Thumb";
import { VideoThumb } from "../../../ui/VideoThumb";
import type { DirectorData } from "../../../core/types";

export const DirectorNode = memo(function DirectorNode({ id, data, selected }: NodeProps) {
  const d = data as DirectorData;
  const upd = useBoard((s) => s.updateData);
  const boardId = useBoard((s) => s.activeId);
  const nodes = useBoard((s) => s.nodes);
  const edges = useBoard((s) => s.edges);
  const createProject = useDirector((s) => s.createProject);
  const project = useDirector((s) => s.projects.find((p) => p.id === d.projectId));
  const setDirectorOpen = useUi((s) => s.setDirectorOpen);
  const assets = useAssets((s) => s.items);

  // 新建节点时自动创建项目（projectId 为空触发一次）
  useEffect(() => {
    if (!d.projectId) {
      const p = createProject(id, boardId, "未命名项目");
      upd(id, { projectId: p.id });
    }
  }, [d.projectId, id, boardId, createProject, upd]);

  // 上游接入的素材（端口统一，任意图片/视频/音频节点都能连进来当参考）
  const upstreamMedia = useMemo(() => collectUpstream(id), [id, nodes, edges]);
  // 内容指纹签名：只有素材内容真的变了才触发同步（collectUpstream 每次返回新数组，不能按引用比较）
  const upstreamSig = useMemo(
    () => [...upstreamMedia.images, ...upstreamMedia.videos, ...upstreamMedia.audios].map(hashDataUrl).join("|"),
    [upstreamMedia],
  );
  useEffect(() => {
    if (d.projectId) void syncRefSlots(d.projectId, upstreamMedia);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.projectId, upstreamSig]);

  // 参考图缩略图条：按 globalSlots 顺序（= 导演台里调整后的生效顺序）展示
  const refThumbs = useMemo(() => {
    const ids = (project?.globalSlots ?? []).flatMap((s) => s.assetIds);
    return ids
      .map((aid) => assets.find((a) => a.id === aid))
      .filter((a): a is NonNullable<typeof a> => !!a)
      .map((a) => ({ id: a.id, src: assetUrl(a.thumb || a.path) }));
  }, [project?.globalSlots, assets]);

  const enter = () => {
    if (d.projectId) {
      useUi.setState({ directorNodeId: id, directorProjectId: d.projectId });
      setDirectorOpen(true);
    }
  };

  const fmtDuration = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  // 是否视频成片只看 outputUrl（cover 实际是 poster 图 data:image/webp，原 data:video 判断恒 false）
  const isVideo = !!d.outputUrl && (d.outputUrl.startsWith("blob:") || d.outputUrl.startsWith("data:video"));

  return (
    <NodeShell
      id={id}
      title="导演台"
      icon={<IcFilmFrame size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={360}
    >
      <PortIn />
      <div className="mnode-body">
        <div className="gen-sum">
          {project?.name ?? "未命名项目"}
          {project ? ` · ${fmtDuration(project.targetDurationSec)} · ${project.aspect}` : ""}
        </div>

        {/* 上游参考图条：序号即喂给模型的顺序（导演台「生成」页可调整顺序与接入点） */}
        {refThumbs.length ? (
          <div className="dir-refs" title={`已接入 ${refThumbs.length} 张上游参考图 · 顺序即生成顺序（进入导演台可调整顺序与接入点）`}>
            {refThumbs.slice(0, 8).map((r, i) => (
              <span key={r.id} className="dir-ref">
                <img src={r.src} alt="" loading="lazy" />
                <i>{i + 1}</i>
              </span>
            ))}
            {refThumbs.length > 8 ? <span className="dir-ref-more">+{refThumbs.length - 8}</span> : null}
          </div>
        ) : null}

        {/* 成片封面 / 进度：cover 是 poster 图（data:image），是否视频只看 outputUrl */}
        {d.outputUrl ? (
          isVideo ? (
            <VideoThumb className="img-main" src={d.outputUrl} onClick={() => useUi.getState().setLightbox(d.outputUrl ?? null, undefined, "video")} />
          ) : d.cover ? (
            <Thumb src={d.cover} onClick={() => useUi.getState().setLightbox(d.cover ?? null)} />
          ) : null
        ) : (
          <div className="node-hint">剧本到成片的一站式工作台</div>
        )}

        {d.progress ? (
          <div className="progress-line">
            <IcLoading size={14} />
            {d.progress}
          </div>
        ) : null}

        <button className="btn primary nodrag" onClick={enter} disabled={!d.projectId}>
          <IcFilmFrame size={16} /> 进入导演台
        </button>
      </div>
      <PortOut kind="video" />
    </NodeShell>
  );
});
