import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortImageIn, PortOut, PortTextIn } from "../NodeShell";
import { IcDownload, IcLoading, IcSparkles } from "../../../ui/icons";
import { ModelPicker } from "../../../ui/ModelPicker";
import { useBoard } from "../../../core/stores/boardStore";
import { resolveModelCard, useSettings } from "../../../core/stores/settingsStore";
import { toast, useUi } from "../../../core/stores/uiStore";
import { runImageGen } from "../../../core/runner";
import { saveImageAs } from "../../../core/services/imageSaver";
import { errMsg } from "../../../core/utils";
import type { ImageGenData } from "../../../core/types";

const SIZES = ["default", "1024x1024", "768x1024", "1024x768", "1024x1536", "1536x1024", "auto"];

export const ImageGenNode = memo(function ImageGenNode({ id, data, selected }: NodeProps) {
  const d = data as ImageGenData;
  const upd = useBoard((s) => s.updateData);
  const setLightbox = useUi((s) => s.setLightbox);
  const running = d.status === "running";
  const main = d.results?.[d.picked ?? 0];

  const save = async () => {
    if (!main) return;
    try {
      let model: string | undefined;
      try {
        model = resolveModelCard("image", d.modelId).model;
      } catch {
        /* 未配置模型时仅影响文件命名 */
      }
      const p = await saveImageAs(main, useSettings.getState().settings.save, { prompt: d.prompt, model });
      if (p) toast(`已保存 → ${p}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  return (
    <NodeShell
      id={id}
      title="生成图像"
      icon={<IcSparkles size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={310}
      headExtra={
        main ? (
          <span className="acts nodrag" style={{ opacity: 1 }}>
            <button className="icon-btn" title="保存到本地" onClick={save}>
              <IcDownload size={17} />
            </button>
          </span>
        ) : undefined
      }
    >
      <div className="mnode-body">
        <ModelPicker role="image" value={d.modelId} onChange={(v) => upd(id, { modelId: v })} />
        <textarea
          className="textarea nodrag nowheel"
          rows={3}
          placeholder="提示词（留空则自动使用上游提示词/对话结果）"
          value={d.prompt}
          onChange={(e) => upd(id, { prompt: e.target.value })}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <select
            className="select nodrag"
            style={{ flex: 1.4, minHeight: 34 }}
            value={d.size}
            onChange={(e) => upd(id, { size: e.target.value })}
            title="输出尺寸"
          >
            {SIZES.map((s) => (
              <option key={s} value={s}>
                {s === "default" ? "尺寸·跟随全局" : s === "auto" ? "自动" : s}
              </option>
            ))}
          </select>
          <select
            className="select nodrag"
            style={{ flex: 1, minHeight: 34 }}
            value={d.count}
            onChange={(e) => upd(id, { count: Number(e.target.value) })}
            title="生成张数"
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n} 张
              </option>
            ))}
          </select>
        </div>
        <button className="btn primary nodrag" disabled={running} onClick={() => void runImageGen(id)}>
          {running ? <IcLoading size={17} /> : <IcSparkles size={17} />}
          {running ? "生成中…" : "生成"}
        </button>
        {running ? (
          <div className="skeleton">
            <span>正在绘制…</span>
          </div>
        ) : main ? (
          <>
            <img className="img-main nodrag" src={main} alt="" onClick={() => setLightbox(main)} />
            {d.results.length > 1 ? (
              <div className="thumbs nodrag">
                {d.results.map((s, i) => (
                  <img
                    key={i}
                    src={s}
                    className={i === (d.picked ?? 0) ? "on" : ""}
                    onClick={() => upd(id, { picked: i })}
                    alt=""
                  />
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      <PortTextIn />
      <PortImageIn />
      <PortOut kind="image" />
    </NodeShell>
  );
});
