/**
 * 生成参数二级面板 — 选中「生成图像」节点时出现在画布左下角
 * 按所选模型家族动态出参数：
 *  - Nano Banana / Gemini：宽高比（带示意图标）+ 1K/2K/4K
 *  - GPT Image：质量四档 + 自定义宽高 + 常用预设
 *  - 通用：预设尺寸 + 自定义宽高
 */
import { useEffect, useMemo, useState } from "react";
import { useBoard } from "../../core/stores/boardStore";
import { modelKey, providersOfRole, resolveModelCard, useSettings } from "../../core/stores/settingsStore";
import { toast, useUi } from "../../core/stores/uiStore";
import { runBatchImages, runBatchPrompts, runModelCompare } from "../../core/runner";
import {
  BANANA_ASPECTS,
  BANANA_SIZES,
  FAMILY_LABEL,
  familyPresets,
  GPT_RATIOS,
  GPT_TIERS,
  GPT_QUALITIES,
  familyMaxCount,
  familyMaxRef,
  gptSize,
  imageFamily,
  type ImageFamily,
} from "../../core/modelMeta";
import { ModelPicker } from "../../ui/ModelPicker";
import { IcGear, IcLayers, IcRows } from "../../ui/icons";
import type { ImageGenData } from "../../core/types";

/** 创意度档位说明 */
function creativityLabel(v: number): string {
  if (v <= 15) return "严格还原原图";
  if (v <= 40) return "贴近原图微调";
  if (v < 65) return "均衡（默认）";
  if (v <= 85) return "自由发挥";
  return "大胆重构";
}

/** 多模型对比：勾选若干模型 → 克隆节点并行出图 */
function ComparePicker({ nodeId, currentModel }: { nodeId: string; currentModel?: string }) {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const options = providersOfRole("image").flatMap((p) =>
    (p.models.image?.models ?? []).map((m) => ({ key: modelKey(p.id, m), label: `${p.name} · ${m}` })),
  );
  const toggle = (k: string) => setSel((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  const run = () => {
    if (!sel.length) return;
    setOpen(false);
    void runModelCompare(nodeId, sel);
    setSel([]);
  };
  if (options.length < 2) return null;
  return (
    <div className="cmp-wrap nodrag">
      <button className="btn" onClick={() => setOpen(!open)} title="同一提示词/参考图，用多个模型并排出图对比（自动克隆节点并复制上游连线）">
        <IcLayers size={15} /> 多模型对比
      </button>
      {open ? (
        <div className="cmp-pop glass nowheel">
          <div className="cmp-head">勾选要对比的模型（各生成一个节点）</div>
          <div className="cmp-list">
            {options.map((o) => (
              <label key={o.key} className={`cmp-item ${o.key === currentModel ? "cur" : ""}`} title={o.key === currentModel ? "当前节点已在用这个模型" : o.label}>
                <input type="checkbox" checked={sel.includes(o.key)} onChange={() => toggle(o.key)} />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
          <button className="btn primary" disabled={!sel.length} style={{ opacity: sel.length ? 1 : 0.5 }} onClick={run}>
            生成对比（{sel.length}）
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 批量出图：一行一条提示词并行克隆生成；≥2 路参考图时还可按图批量（每张单独处理一遍） */
function BatchPicker({ nodeId, refCount }: { nodeId: string; refCount: number }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const run = () => {
    if (!lines.length) return;
    setOpen(false);
    void runBatchPrompts(nodeId, lines);
    setText("");
  };
  return (
    <div className="cmp-wrap nodrag">
      <button className="btn" onClick={() => setOpen(!open)} title="一行一条提示词并行出图；节点/上游里的提示词会作为共用风格附加到每一条">
        <IcRows size={15} /> 批量出图
      </button>
      {open ? (
        <div className="cmp-pop glass nowheel">
          <div className="cmp-head">一行一条提示词（当前 {lines.length} 条）</div>
          <textarea
            className="textarea nodrag nowheel"
            rows={6}
            placeholder={"赛博朋克霓虹街头，雨夜\n水彩风格的山谷清晨\n宇航员在花田里野餐"}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="cmp-note">
            共用风格/定调：写在本节点提示词框或接一个上游提示词节点，会自动附加到每一条前面；上游参考图各条共用。
          </div>
          <button className="btn primary" disabled={!lines.length} style={{ opacity: lines.length ? 1 : 0.5 }} onClick={run}>
            并行生成（{lines.length} 个节点）
          </button>
          {refCount >= 2 ? (
            <button
              className="btn"
              title="每路上游图片各克隆一个生成节点单独处理（提示词连线全部继承），并行运行"
              onClick={() => {
                setOpen(false);
                void runBatchImages(nodeId);
              }}
            >
              按参考图批量（{refCount} 路各出一遍）
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 自定义比例输入：宽比、高比各一个数字框（如 16 和 9），两边都填了就生效 */
function RatioPair({ current, onApply }: { current?: string; onApply: (r: string) => void }) {
  const parse = (v?: string): [string, string] => {
    const m = v?.match(/^(\d+(?:\.\d+)?)[:：xX×/](\d+(?:\.\d+)?)$/);
    return m ? [m[1], m[2]] : ["", ""];
  };
  const [a, setA] = useState(() => parse(current)[0]);
  const [b, setB] = useState(() => parse(current)[1]);
  useEffect(() => {
    const [pa, pb] = parse(current);
    setA(pa);
    setB(pb);
  }, [current]);
  const commit = (na: string, nb: string) => {
    const va = parseFloat(na);
    const vb = parseFloat(nb);
    if (va > 0 && vb > 0) onApply(`${na}:${nb}`);
  };
  return (
    <span className="ratio-pair nodrag">
      <input
        className="input"
        type="number"
        min={1}
        placeholder="宽比"
        value={a}
        onChange={(e) => {
          setA(e.target.value);
          commit(e.target.value, b);
        }}
      />
      <i>:</i>
      <input
        className="input"
        type="number"
        min={1}
        placeholder="高比"
        value={b}
        onChange={(e) => {
          setB(e.target.value);
          commit(a, e.target.value);
        }}
      />
    </span>
  );
}

/** 比例格子的悬停提示：按当前分辨率档换算后的实际宽高 */
function ratioSizeTitle(ratio: string, tier: string): string {
  const s = gptSize(ratio, tier);
  return s ? `${ratio} @ ${tier} → ${s.w} × ${s.h}` : ratio;
}

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
  const suppressed = useUi((s) => s.genPanelSuppressed);

  const family: ImageFamily = useMemo(() => {
    if (!d) return "generic";
    try {
      return imageFamily(resolveModelCard("image", d.modelId));
    } catch {
      return "generic";
    }
  }, [d, models]);

  if (!selId || !d || suppressed) return null;

  const refCount = edges.filter((e) => e.target === selId && e.targetHandle === "in-image").length;
  const maxN = familyMaxCount(family);
  const patch = (p: Partial<ImageGenData>) => upd(selId, p);
  const setWH = (w: number, h: number, ratio?: string) => patch({ width: w, height: h, aspect: ratio, size: "default" });

  /* --- GPT Image：比例 × 分辨率档 → 实际宽高 --- */
  const gptTier = d.resolution ?? "1K";
  const applyGptRatio = (ratio: string) => {
    const s = gptSize(ratio, gptTier);
    if (!s) {
      toast("比例格式如 16:9，范围 1:3 ~ 3:1", "err");
      return;
    }
    patch({ aspect: ratio.replace(/\s/g, ""), width: s.w, height: s.h, size: "default" });
  };
  const applyGptTier = (tier: string) => {
    const base = d.aspect ?? (d.width && d.height ? `${d.width}:${d.height}` : undefined);
    const s = base ? gptSize(base, tier) : null;
    patch({ resolution: tier, ...(s ? { width: s.w, height: s.h, size: "default" } : {}) });
  };

  return (
    <div className="gen-panel glass">
      <div className="gp-col gp-col-info">
        <div className="gp-head">
          <IcGear size={15} />
          生成设置
          <span className="gp-fam">{FAMILY_LABEL[family]}</span>
        </div>
        <ModelPicker role="image" value={d.modelId} onChange={(v) => patch({ modelId: v })} />
        <div className="gp-row2">
          <div className="gp-seg" style={{ flex: 1 }} title="提示词语言：中文原文直发 / 生成前先译成英文">
            <button className={(d.lang ?? "zh") === "zh" ? "on" : ""} onClick={() => patch({ lang: "zh" })}>
              中文
            </button>
            <button className={d.lang === "en" ? "on" : ""} onClick={() => patch({ lang: "en" })}>
              译英
            </button>
          </div>
          {refCount > 0 ? (
            <div
              className="gp-cre"
              title={`创意度 ${d.creativity ?? 50}（${creativityLabel(d.creativity ?? 50)}）：低 = 忠于参考图微调；高 = 大胆重新演绎`}
            >
              <span className="gp-lab" style={{ margin: 0 }}>创意度</span>
              <input
                type="range"
                className="range nodrag"
                min={0}
                max={100}
                step={5}
                value={d.creativity ?? 50}
                onChange={(e) => patch({ creativity: +e.target.value })}
              />
            </div>
          ) : null}
        </div>
        <div className="gp-row2">
          <ComparePicker nodeId={selId} currentModel={(() => {
            try {
              const c = resolveModelCard("image", d.modelId);
              return modelKey(c.id, c.model);
            } catch {
              return undefined;
            }
          })()} />
          <BatchPicker nodeId={selId} refCount={refCount} />
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
                title={a === "auto" ? "自动：有参考图时取第一张图的比例，没有参考图时由模型决定" : undefined}
                onClick={() => patch({ aspect: a })}
              >
                <ArIcon ratio={a} />
                {a}
              </button>
            ))}
          </div>
        </div>
      ) : family === "gpt" ? (
        <div className="gp-col gp-col-main">
          <div className="gp-lab">
            比例
            <span className="gp-hint">选比例 → 右侧选分辨率档；当前 {d.width && d.height ? `${d.width}×${d.height}` : "自动"}</span>
          </div>
          <div className="gp-grid ratios">
            {GPT_RATIOS.map((r) => (
              <button key={r} className={`gp-cell ${d.aspect === r ? "on" : ""}`} title={ratioSizeTitle(r, gptTier)} onClick={() => applyGptRatio(r)}>
                <ArIcon ratio={r} />
                {r}
              </button>
            ))}
            <button
              className={`gp-cell ${!d.width && !d.height && !d.aspect ? "on" : ""}`}
              title="自动：有参考图时取第一张图的比例，没有参考图时跟随服务商配置的默认尺寸"
              onClick={() => patch({ width: undefined, height: undefined, aspect: undefined, size: "default" })}
            >
              <ArIcon ratio="auto" />
              auto
            </button>
          </div>
          <div className="gp-wh inline">
            <span className="gp-lab" title="宽高 16 的倍数 · 比例 1:3~3:1 · 长边 ≤3840">自定义</span>
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
                onChange={(e) => patch({ width: e.target.value ? Number(e.target.value) : undefined, aspect: undefined, size: "default" })}
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
                onChange={(e) => patch({ height: e.target.value ? Number(e.target.value) : undefined, aspect: undefined, size: "default" })}
              />
            </label>
            <label title="只知道比例就填这里：宽比、高比各一个框，自动按分辨率档换算宽高">
              比
              <RatioPair current={d.aspect} onApply={applyGptRatio} />
            </label>
          </div>
        </div>
      ) : (
        <div className="gp-col gp-col-main">
          <div className="gp-lab">
            尺寸
            <span className="gp-hint">自定义宽高或选预设</span>
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
            {familyPresets(family).map((p) => {
              const on = d.width === p.w && d.height === p.h;
              return (
                <button key={`${p.w}x${p.h}`} className={`gp-cell ${on ? "on" : ""}`} title={`${p.w} × ${p.h}`}
                  onClick={() => setWH(p.w, p.h, p.ratio)}>
                  <ArIcon ratio={p.ratio} />
                  {p.ratio}
                </button>
              );
            })}
            <button
              className={`gp-cell ${!d.width && !d.height ? "on" : ""}`}
              title="自动：有参考图时取第一张图的比例，没有参考图时跟随服务商配置的默认尺寸"
              onClick={() => patch({ width: undefined, height: undefined, aspect: undefined, size: "default" })}
            >
              <ArIcon ratio="auto" />
              auto
            </button>
          </div>
        </div>
      )}

      <div className={`gp-col gp-col-side ${family === "gpt" ? "wide" : ""}`}>
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
            <div className="gp-lab">分辨率</div>
            <div className="gp-seg">
              {GPT_TIERS.map((t) => (
                <button
                  key={t}
                  title={`按当前比例换算宽高（${t === "1K" ? "约 100 万" : t === "2K" ? "约 400 万" : "约 800 万"}像素）`}
                  className={gptTier === t ? "on" : ""}
                  onClick={() => applyGptTier(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="gp-lab" style={{ marginTop: 8 }}>质量</div>
            <div className="gp-seg">
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
