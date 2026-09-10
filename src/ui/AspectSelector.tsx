/**
 * 宽高比 / 分辨率 选择器（角色卡、电商长图等节点的设置弹窗共用）。
 * 按所选绘画模型的家族动态出参数，与底部生成栏视觉一致（复用 gp-grid / gp-cell / gp-seg / ar-ic 样式）：
 *  - banana：宽高比（带示意图标）+ 1K/2K/4K
 *  - gpt：比例档 + 分辨率档 + 质量四档
 *  - 通用（seedream/flux/qwen/kolors/generic）：预设比例档
 * 只写 aspect / resolution / quality；实际宽高由服务层 genOpenAI/genCustom 按 aspect→size 折算兜底，
 * 因此调用方无需持有 width/height/size（与底部生成栏的「完整编辑器」分工：这里是精简版）。
 */
import {
  BANANA_ASPECTS,
  BANANA_SIZES,
  familyPresets,
  gptQualities,
  GPT_RATIOS,
  GPT_TIERS,
  type ImageFamily,
} from "../core/modelMeta";

/** 宽高比示意小图标（按 w/h 画一个小方框；auto 显示 A） */
export function ArIcon({ ratio }: { ratio: string }) {
  if (ratio === "auto") return <span className="ar-ic">A</span>;
  const [w, h] = ratio.split(":").map(Number);
  if (!w || !h) return <span className="ar-ic">A</span>;
  const r = w / h;
  const bw = r >= 1 ? 15 : Math.max(15 * r, 6);
  const bh = r >= 1 ? Math.max(15 / r, 6) : 15;
  return (
    <span className="ar-ic">
      <i style={{ width: bw, height: bh }} />
    </span>
  );
}

export function AspectSelector({
  family,
  model,
  qualityNotice,
  aspect,
  resolution,
  quality,
  patch,
}: {
  family: ImageFamily;
  model?: string;
  qualityNotice?: string;
  aspect?: string;
  resolution?: string;
  quality?: string;
  patch: (p: { aspect?: string; resolution?: string; quality?: string }) => void;
}) {
  if (family === "banana") {
    return (
      <>
        <div className="gp-sec-title">
          宽高比<span className="gp-hint">自动 = 有参考图时取第一张图的比例</span>
        </div>
        <div className="gp-grid ratios">
          {BANANA_ASPECTS.map((a) => (
            <button
              key={a}
              className={`gp-cell ${(aspect ?? "auto") === a ? "on" : ""}`}
              onClick={() => patch({ aspect: a })}
            >
              <ArIcon ratio={a} />
              {a}
            </button>
          ))}
        </div>
        <div className="gp-sec-title">分辨率</div>
        <div className="gp-seg">
          {BANANA_SIZES.map((r) => (
            <button key={r} className={(resolution ?? "1K") === r ? "on" : ""} onClick={() => patch({ resolution: r })}>
              {r}
            </button>
          ))}
        </div>
      </>
    );
  }

  if (family === "gpt") {
    return (
      <>
        <div className="gp-sec-title">比例</div>
        <div className="gp-grid ratios">
          <button
            className={`gp-cell ${!aspect ? "on" : ""}`}
            title="自动：有参考图时取第一张图的比例"
            onClick={() => patch({ aspect: undefined })}
          >
            <ArIcon ratio="auto" />
            auto
          </button>
          {GPT_RATIOS.map((r) => (
            <button key={r} className={`gp-cell ${aspect === r ? "on" : ""}`} onClick={() => patch({ aspect: r })}>
              <ArIcon ratio={r} />
              {r}
            </button>
          ))}
        </div>
        <div className="gp-sec-title">分辨率</div>
        <div className="gp-seg">
          {GPT_TIERS.map((t) => (
            <button key={t} className={(resolution ?? "1K") === t ? "on" : ""} onClick={() => patch({ resolution: t })}>
              {t}
            </button>
          ))}
        </div>
        <div className="gp-sec-title">质量</div>
        <div className="gp-seg">
          {gptQualities(model).map((q) => (
            <button
              disabled={Boolean(qualityNotice)}
              key={q.value}
              className={(quality ?? "auto") === q.value ? "on" : ""}
              onClick={() => patch({ quality: q.value })}
            >
              {q.label}
            </button>
          ))}
        </div>
        {qualityNotice && <p className="gp-hint">{qualityNotice}</p>}
      </>
    );
  }

  // 通用家族（seedream / flux / qwen / kolors / generic）
  const presets = familyPresets(family);
  // 去重比例（不同预设可能同比例不同尺寸，选择器只关心比例）
  const ratios = Array.from(new Set(presets.map((p) => p.ratio)));
  return (
    <>
      <div className="gp-sec-title">
        预设比例<span className="gp-hint">自动 = 有参考图时取第一张图的比例</span>
      </div>
      <div className="gp-grid ratios">
        <button
          className={`gp-cell ${!aspect ? "on" : ""}`}
          title="自动：有参考图时取第一张图的比例"
          onClick={() => patch({ aspect: undefined })}
        >
          <ArIcon ratio="auto" />
          auto
        </button>
        {ratios.map((r) => (
          <button key={r} className={`gp-cell ${aspect === r ? "on" : ""}`} onClick={() => patch({ aspect: r })}>
            <ArIcon ratio={r} />
            {r}
          </button>
        ))}
      </div>
    </>
  );
}
