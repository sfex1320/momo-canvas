/**
 * 生成参数二级面板 — 选中「生成图像」节点时出现在画布左下角
 * 按所选模型家族动态出参数：
 *  - Nano Banana / Gemini：宽高比（带示意图标）+ 1K/2K/4K
 *  - GPT Image：质量四档 + 自定义宽高 + 常用预设
 *  - 通用：预设尺寸 + 自定义宽高
 */
import { useMemo } from "react";
import { useBoard } from "../../core/stores/boardStore";
import { resolveModelCard, useSettings } from "../../core/stores/settingsStore";
import {
  BANANA_ASPECTS,
  BANANA_SIZES,
  FAMILY_LABEL,
  GENERIC_PRESETS,
  GPT_PRESETS,
  GPT_QUALITIES,
  familyMaxCount,
  familyMaxRef,
  imageFamily,
  type ImageFamily,
} from "../../core/modelMeta";
import { ModelPicker } from "../../ui/ModelPicker";
import { IcGear } from "../../ui/icons";
import type { ImageGenData } from "../../core/types";

/** 宽高比示意小图标 */
function ArIcon({ ratio }: { ratio: string }) {
  if (ratio === "auto") return <span className="ar-ic">A</span>;
  const [w, h] = ratio.split(":").map(Number);
  const r = w / h;
  const bw = r >= 1 ? 15 : Math.max(15 * r, 6);
  const bh = r >= 1 ? Math.max(15 / r, 6) : 15;
  return (
    <span className="ar-ic">
      <i style={{ width: bw, height: bh }} />
    </span>
  );
}

export function GenConfigPanel() {
  const selId = useBoard((s) => {
    const sel = s.nodes.filter((n) => n.selected);
    return sel.length === 1 && sel[0].type === "imageGen" ? sel[0].id : null;
  });
  const node = useBoard((s) => (selId ? s.nodes.find((n) => n.id === selId) : undefined));
  const edges = useBoard((s) => s.edges);
  const upd = useBoard((s) => s.updateData);

  const d = node?.data as ImageGenData | undefined;
  const models = useSettings((s) => s.settings.models);

  const family: ImageFamily = useMemo(() => {
    if (!d) return "generic";
    try {
      return imageFamily(resolveModelCard("image", d.modelId));
    } catch {
      return "generic";
    }
  }, [d, models]);

  if (!selId || !d) return null;

  const refCount = edges.filter((e) => e.target === selId && e.targetHandle === "in-image").length;
  const maxN = familyMaxCount(family);
  const patch = (p: Partial<ImageGenData>) => upd(selId, p);
  const setWH = (w: number, h: number, ratio?: string) => patch({ width: w, height: h, aspect: ratio, size: "default" });

  return (
    <div className="gen-panel glass">
      <div className="gp-col gp-col-info">
        <div className="gp-head">
          <IcGear size={15} />
          生成设置
        </div>
        <span className="gp-fam">{FAMILY_LABEL[family]}</span>
        <div className="gp-sec">
          <div className="gp-lab">模型</div>
          <ModelPicker role="image" value={d.modelId} onChange={(v) => patch({ modelId: v })} />
        </div>
        <div className="gp-foot">
          参考图：已接入 {refCount} 路 · 最多 {familyMaxRef(family)} 张
        </div>
      </div>

      {family === "banana" ? (
        <div className="gp-col gp-col-main">
          <div className="gp-lab">宽高比</div>
          <div className="gp-grid">
            {BANANA_ASPECTS.map((a) => (
              <button
                key={a}
                className={`gp-cell ${(d.aspect ?? "auto") === a ? "on" : ""}`}
                onClick={() => patch({ aspect: a })}
              >
                <ArIcon ratio={a} />
                {a}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="gp-col gp-col-main">
          <div className="gp-lab">
            尺寸
            <span className="gp-hint">{family === "gpt" ? "16 的倍数 · 比例 1:3~3:1 · 最大 3840x2160" : "自定义宽高或选预设"}</span>
          </div>
          <div className="gp-wh">
            <label>
              W
              <input
                className="input nodrag"
                type="number"
                step={16}
                min={256}
                max={3840}
                value={d.width ?? ""}
                placeholder="宽"
                onChange={(e) => patch({ width: e.target.value ? Number(e.target.value) : undefined, size: "default" })}
              />
            </label>
            <label>
              H
              <input
                className="input nodrag"
                type="number"
                step={16}
                min={256}
                max={3840}
                value={d.height ?? ""}
                placeholder="高"
                onChange={(e) => patch({ height: e.target.value ? Number(e.target.value) : undefined, size: "default" })}
              />
            </label>
          </div>
          <div className="gp-grid">
            {(family === "gpt" ? GPT_PRESETS : GENERIC_PRESETS).map((p) => {
              const tag = "tag" in p ? (p as { tag?: string }).tag : undefined;
              const on = d.width === p.w && d.height === p.h;
              return (
                <button key={`${p.w}x${p.h}`} className={`gp-cell ${on ? "on" : ""}`} title={`${p.w} × ${p.h}`}
                  onClick={() => setWH(p.w, p.h, p.ratio)}>
                  <ArIcon ratio={p.ratio} />
                  {p.ratio}
                  {tag ? <em>{tag}</em> : null}
                </button>
              );
            })}
            <button
              className={`gp-cell ${!d.width && !d.height ? "on" : ""}`}
              title="自动 / 跟随服务商默认"
              onClick={() => patch({ width: undefined, height: undefined, aspect: undefined, size: "default" })}
            >
              <ArIcon ratio="auto" />
              auto
            </button>
          </div>
        </div>
      )}

      <div className="gp-col gp-col-side">
        {family === "banana" ? (
          <>
            <div className="gp-lab">分辨率</div>
            <div className="gp-seg col">
              {BANANA_SIZES.map((r) => (
                <button
                  key={r}
                  className={(d.resolution ?? "1K") === r ? "on" : ""}
                  onClick={() => patch({ resolution: r })}
                >
                  {r}
                </button>
              ))}
            </div>
          </>
        ) : family === "gpt" ? (
          <>
            <div className="gp-lab">质量</div>
            <div className="gp-seg col">
              {GPT_QUALITIES.map((q) => (
                <button
                  key={q.value}
                  className={(d.quality ?? "auto") === q.value ? "on" : ""}
                  onClick={() => patch({ quality: q.value })}
                >
                  {q.label}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>

      <div className="gp-col gp-col-count">
        <div className="gp-lab">数量</div>
        <div className="gp-grid n">
          {Array.from({ length: maxN }, (_, i) => i + 1).map((n) => (
            <button key={n} className={`gp-cell ${(d.count ?? 1) === n ? "on" : ""}`} onClick={() => patch({ count: n })}>
              {n} 张
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
