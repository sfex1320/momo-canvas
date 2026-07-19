/**
 * 分镜节点 — 故事/剧本 → 完善 → 按风格与定调拆分镜（带时间轴）
 *  每个分镜右侧有独立文本输出口（只输出该镜提示词），可逐镜连生成节点；
 *  也可「一键铺节点」自动建好 N 个生成图像/视频节点并逐镜连线。
 */
import { memo, useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { NodeShell, PortOut, PortTextIn } from "../NodeShell";
import { IcClapper, IcImage, IcLoading, IcSparkles, IcVideo } from "../../../ui/icons";
import { ModelPicker } from "../../../ui/ModelPicker";
import { useBoard } from "../../../core/stores/boardStore";
import { refineStory, runFlow, spawnShotNodes } from "../../../core/runner";
import type { StoryboardData, StoryShot } from "../../../core/types";

/** 定调快捷词（点击填入，可继续手改） */
const TONES = ["油画质感", "水彩淡彩", "胶片写实", "赛博霓虹", "日系动画", "3D 渲染", "黑白默片"];

export const StoryboardNode = memo(function StoryboardNode({ id, data, selected }: NodeProps) {
  const d = data as StoryboardData;
  const upd = useBoard((s) => s.updateData);
  const running = d.status === "running";
  const [showRefined, setShowRefined] = useState(true);

  const setShot = (i: number, patch: Partial<StoryShot>) => {
    const shots = d.shots.map((s, j) => (j === i ? { ...s, ...patch } : s));
    upd(id, { shots });
  };

  return (
    <NodeShell id={id} title="分镜" icon={<IcClapper size={17} />} status={d.status} error={d.error} selected={selected} width={360}>
      <div className="mnode-body">
        <textarea
          className="textarea nodrag nowheel"
          rows={3}
          placeholder="故事 / 剧本（留空自动取上游文本；长剧本会先分小节整理再拆分镜）"
          value={d.story}
          onChange={(e) => upd(id, { story: e.target.value })}
        />
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn nodrag" style={{ flex: 1 }} disabled={running} title="编剧模型补全起承转合与视觉细节；拆分镜时优先用完善后的版本" onClick={() => void refineStory(id)}>
            {running && d.progress?.includes("完善") ? <IcLoading size={15} /> : <IcSparkles size={15} />} 完善故事
          </button>
          <div style={{ flex: 1.4 }}>
            <ModelPicker role="chat" value={d.chatModelId} onChange={(v) => upd(id, { chatModelId: v })} />
          </div>
        </div>
        {d.refined ? (
          <div className="sb-refined nodrag">
            <div className="sb-cap" onClick={() => setShowRefined(!showRefined)}>
              完善后的故事（可编辑，拆分镜用这版） {showRefined ? "▾" : "▸"}
            </div>
            {showRefined ? (
              <textarea
                className="textarea nodrag nowheel"
                rows={4}
                value={d.refined}
                onChange={(e) => upd(id, { refined: e.target.value })}
              />
            ) : null}
          </div>
        ) : null}

        <input
          className="input nodrag"
          placeholder="风格提示词（全片统一，如：吉卜力手绘、柔和晨光）"
          value={d.style}
          onChange={(e) => upd(id, { style: e.target.value })}
        />
        <div>
          <input
            className="input nodrag"
            placeholder="定调 / 色调（如：油画、暖黄胶片…）"
            value={d.tone}
            onChange={(e) => upd(id, { tone: e.target.value })}
          />
          <div className="sb-tones nodrag">
            {TONES.map((t) => (
              <button key={t} className={d.tone === t ? "on" : ""} onClick={() => upd(id, { tone: t })}>
                {t}
              </button>
            ))}
          </div>
        </div>
        <div className="ctl-row nodrag">
          <span>分镜数</span>
          <input
            className="input"
            type="number"
            min={2}
            max={24}
            style={{ width: 72, minHeight: 32 }}
            value={d.count}
            onChange={(e) => upd(id, { count: Math.max(2, Math.min(24, Number(e.target.value) || 4)) })}
          />
          <span>每镜秒数</span>
          <input
            className="input"
            type="number"
            min={1}
            max={60}
            style={{ width: 72, minHeight: 32 }}
            title="用于时间轴标注（如 0-5秒 / 5-10秒），与视频节点的时长设置对齐"
            value={d.shotSec}
            onChange={(e) => upd(id, { shotSec: Math.max(1, Number(e.target.value) || 5) })}
          />
        </div>
        <button className="btn primary nodrag" disabled={running} onClick={() => void runFlow(id)}>
          {running && !d.progress?.includes("完善") ? <IcLoading size={17} /> : <IcClapper size={16} />}
          {running ? d.progress ?? "处理中…" : `生成 ${d.count} 个分镜`}
        </button>

        {d.shots.length ? (
          <>
            <div className="sb-list nodrag">
              {d.shots.map((sh, i) => (
                <div key={i} className="sb-shot">
                  <Handle
                    type="source"
                    position={Position.Right}
                    id={`shot-${i}`}
                    data-lab={`镜${i + 1}出`}
                    title={`单独输出分镜 ${i + 1} 的提示词（连到生成图像/视频节点）`}
                    className="port port-text port-deliv"
                  />
                  <span className="sb-time">{sh.time}</span>
                  <textarea
                    className="textarea nodrag nowheel"
                    rows={2}
                    value={sh.prompt}
                    onChange={(e) => setShot(i, { prompt: e.target.value })}
                  />
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn nodrag" style={{ flex: 1 }} title="每个分镜建一个生成图像节点并逐镜连线" onClick={() => spawnShotNodes(id, "imageGen")}>
                <IcImage size={15} /> 一键铺生图
              </button>
              <button className="btn nodrag" style={{ flex: 1 }} title="每个分镜建一个生成视频节点并逐镜连线" onClick={() => spawnShotNodes(id, "videoGen")}>
                <IcVideo size={15} /> 一键铺视频
              </button>
            </div>
          </>
        ) : null}
      </div>
      <PortTextIn />
      <PortOut kind="text" />
    </NodeShell>
  );
});
