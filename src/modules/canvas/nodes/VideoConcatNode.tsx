/**
 * 视频拼接节点 — 自带「时间线粗剪条」：
 * 上游片段按播放顺序横排（封面帧 + 时长角标），←/→ 调序、点封面单段预览、
 * 「预览成片」按顺序自动连播，满意再本地重编码拼成一条。
 */
import { memo, useEffect, useMemo, useState } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortOut, PortVideoIn } from "../NodeShell";
import { IcDownload, IcFilmJoin, IcLoading, IcPlay } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { useSettings } from "../../../core/stores/settingsStore";
import { toast, useUi } from "../../../core/stores/uiStore";
import { concatClips, runFlow } from "../../../core/runner";
import { saveVideoAs } from "../../../core/services/imageSaver";
import { errMsg } from "../../../core/utils";
import { VideoThumb, fmtDur, makeVideoPoster } from "../../../ui/VideoThumb";
import type { VideoConcatData } from "../../../core/types";

export const VideoConcatNode = memo(function VideoConcatNode({ id, data, selected }: NodeProps) {
  const d = data as VideoConcatData;
  const upd = useBoard((s) => s.updateData);
  const nodes = useBoard((s) => s.nodes);
  const edges = useBoard((s) => s.edges);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const clips = useMemo(() => concatClips(id), [nodes, edges, id, d.order]);
  const running = d.status === "running";

  // 总时长（读各片段元数据，异步补齐）
  const [total, setTotal] = useState(0);
  useEffect(() => {
    let on = true;
    if (!clips.length) {
      setTotal(0);
      return;
    }
    void Promise.all(clips.map((c) => makeVideoPoster(c.url))).then((ps) => {
      if (on) setTotal(ps.reduce((s, p) => s + (p.dur || 0), 0));
    });
    return () => {
      on = false;
    };
  }, [clips]);

  // 调序：以“上游节点”为单位交换（同一节点的多段视频保持内部顺序）
  const orderIds = useMemo(() => [...new Set(clips.map((c) => c.nodeId))], [clips]);
  const move = (nodeId: string, dir: -1 | 1) => {
    const idx = orderIds.indexOf(nodeId);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= orderIds.length) return;
    const next = [...orderIds];
    [next[idx], next[j]] = [next[j], next[idx]];
    upd(id, { order: next });
  };

  const save = async () => {
    if (!d.resultUrl) return;
    try {
      const p = await saveVideoAs(d.resultUrl, useSettings.getState().settings.save, { model: "拼接" });
      if (p) toast(`已保存 → ${p}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  return (
    <NodeShell
      id={id}
      title="视频拼接 · 时间线"
      icon={<IcFilmJoin size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={340}
      headExtra={
        d.resultUrl ? (
          <span className="acts nodrag" style={{ opacity: 1 }}>
            <button className="icon-btn" title="保存到本地" onClick={() => void save()}>
              <IcDownload size={17} />
            </button>
          </span>
        ) : undefined
      }
    >
      <div className="mnode-body">
        {clips.length ? (
          <>
            <div className="tl-strip nodrag nowheel">
              {clips.map((c, i) => {
                const gi = orderIds.indexOf(c.nodeId);
                return (
                  <div key={`${c.nodeId}_${i}`} className="tl-clip" title="点封面单独预览这一段">
                    <VideoThumb src={c.url} />
                    <span className="tl-idx">{i + 1}</span>
                    <div className="tl-acts">
                      <button
                        title="前移"
                        disabled={gi <= 0}
                        style={{ opacity: gi <= 0 ? 0.35 : 1 }}
                        onClick={() => move(c.nodeId, -1)}
                      >
                        ←
                      </button>
                      <button
                        title="后移"
                        disabled={gi >= orderIds.length - 1}
                        style={{ opacity: gi >= orderIds.length - 1 ? 0.35 : 1 }}
                        onClick={() => move(c.nodeId, 1)}
                      >
                        →
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="tl-meta nodrag">
              <span>
                {clips.length} 段{total ? ` · 约 ${fmtDur(total)}` : ""} · ←/→ 调序
              </span>
              <button className="btn sm" title="按当前顺序逐段自动连播，拼接前先看整片效果" onClick={() => useUi.getState().setSeqPreview(clips.map((c) => c.url))}>
                <IcPlay size={13} /> 预览成片
              </button>
            </div>
          </>
        ) : (
          <p className="hint" style={{ fontSize: 12, color: "var(--text-3)", margin: 0, lineHeight: 1.7 }}>
            接入 ≥2 路上游视频后，这里会出现时间线粗剪条：调序 → 预览 → 拼接。
          </p>
        )}
        <button className="btn primary nodrag" disabled={running || clips.length < 2} onClick={() => void runFlow(id)}>
          {running ? <IcLoading size={17} /> : <IcFilmJoin size={16} />}
          {running ? "重编码中…" : `拼接成片（${clips.length} 段）`}
        </button>
        {clips.length ? (
          <p className="hint" style={{ fontSize: 11.5, color: "var(--text-3)", margin: 0, lineHeight: 1.6 }}>
            实验性：本地实时重编码（耗时约等于总时长），分辨率取第一段，输出 webm 并自动落进资产库。
          </p>
        ) : null}
        {running && d.progress ? (
          <div className="progress-line">
            <IcLoading size={14} />
            {d.progress}
          </div>
        ) : null}
        {d.resultUrl && !running ? <VideoThumb className="img-main nodrag" src={d.resultUrl} /> : null}
      </div>
      <PortVideoIn top={26} />
      <PortOut kind="video" />
    </NodeShell>
  );
});
