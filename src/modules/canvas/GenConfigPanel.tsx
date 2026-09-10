import { CanvasInputReview } from "./CanvasInputReview";
/**
 * 生成参数栏 — LibLib 式底部生成栏：选中生成节点时出现在画布下方。
 * 结构 = 提示词区（GenPromptBar）+ 底部 chips 工具栏：
 *   [模型选择] [参数 chip → 弹卡] [语言] [更多（批量/对比）] … [数量] [发送]
 * 所有参数收进弹性弹出的圆角卡片，按所选模型家族动态出参数：
 *  - Nano Banana / Gemini：宽高比（带示意图标）+ 1K/2K/4K
 *  - GPT Image：质量四档 + 比例档 + 自定义宽高
 *  - 通用：预设尺寸 + 自定义宽高
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBoard } from "../../core/stores/boardStore";
import { modelKey, providersOfRole, resolveModelCard, useSettings } from "../../core/stores/settingsStore";
import { toast, useUi } from "../../core/stores/uiStore";
import { collectUpstream, collectUpstreamParts, runBatchImages, runBatchPrompts, runFlow, runModelCompare } from "../../core/runner";
import { GRID_ASPECTS, GRID_PRESETS, buildGridPrompt, gridDims, gridSizePatch, presetById } from "../../core/gridPresets";
import type { GridAspect } from "../../core/types";
import { applyGridSplit } from "../../core/nodeEdit";
import {
  BANANA_ASPECTS,
  BANANA_SIZES,
  FAMILY_LABEL,
  familyPresets,
  GPT_RATIOS,
  GPT_TIERS,
  gptQualities,
  gptImageVariant,
  imageQualityNotice,
  familyMaxCount,
  familyMaxRef,
  gptSize,
  imageFamily,
  type ImageFamily,
} from "../../core/modelMeta";
import { ModelPicker } from "../../ui/ModelPicker";
import { PopLayer, PopSelect } from "../../ui/PopSelect";
import { NodeParamsPop } from "../../ui/NodeParamsPop";
import { AspectSelector, ArIcon } from "../../ui/AspectSelector";
import { CARD_STYLES, CHAR_DELIVERABLES } from "../../core/charPresets";
import { IcArrowL, IcArrowR, IcChevronD, IcCheck, IcClose, IcEcom, IcGlobe, IcGrid, IcIdCard, IcImage, IcLayers, IcLoading, IcPlus, IcRows, IcText, IcVideo } from "../../ui/icons";
import { useAssets } from "../../core/stores/assetStore";
import { assetToDataUrl, assetUrl } from "../../core/services/assetFiles";
import { errMsg } from "../../core/utils";
import { GenPromptBar } from "./GenPromptBar";
import { useGenPref, type GenTierPreset } from "../../core/stores/genPrefStore";
import { Thumb } from "../../ui/Thumb";
import { imageTierToParams, TIER_DESC, TIER_LABEL, videoTierToParams } from "../../core/tierMap";
import type { AudioGenData, CharCardData, EcomImageData, GenHistoryEntry, ImageGenData, VideoGenData } from "../../core/types";
import { videoFamily, videoMeta, type VideoFamily } from "../../core/videoMeta";

/** 创意度档位说明 */
function creativityLabel(v: number): string {
  if (v <= 15) return "严格还原原图";
  if (v <= 40) return "贴近原图微调";
  if (v < 65) return "均衡（默认）";
  if (v <= 85) return "自由发挥";
  return "大胆重构";
}

/** 参数弹卡 chip（统一复用 NodeParamsPop）：触发按钮 + 向上弹出的圆角参数卡 */
function ParamsPop({ icon, label, children }: { icon?: ReactNode; label: string; children: ReactNode }) {
  return (
    <NodeParamsPop icon={icon} label={label} title="生成参数" up>
      {children}
    </NodeParamsPop>
  );
}

/** 提示词语言 chip：中文原文直发 / 生成前先译成英文 */
function LangChip({ lang, onChange }: { lang?: string; onChange: (l: "zh" | "en") => void }) {
  return (
    <PopSelect
      up
      className="gd-lang"
      title="提示词语言"
      value={lang ?? "zh"}
      options={[
        { value: "zh", label: "中文", desc: "原文直发", icon: <IcText size={15} /> },
        { value: "en", label: "译英", desc: "生成前先译成英文", icon: <IcGlobe size={15} /> },
      ]}
      onChange={(v) => onChange(v as "zh" | "en")}
    />
  );
}

/** 生成数量 chip（发送按钮左侧，LibLib 的 ✦1 位置） */
function CountChip({ count, max, onChange }: { count: number; max: number; onChange: (n: number) => void }) {
  return (
    <PopSelect
      up
      className="gd-count"
      layerClassName="align-right"
      title="生成数量"
      value={String(count)}
      options={Array.from({ length: max }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 张` }))}
      onChange={(v) => onChange(Number(v))}
    />
  );
}

/** 档位胶囊行：草稿/标准/精修 + 自定义档，一键切档（跨家族由 tierMap 翻译成具体参数） */
function TierRow({
  kind,
  family,
  videoFam,
  aspect,
  selId,
}: {
  kind: "imageGen" | "videoGen";
  family?: ImageFamily;
  videoFam?: VideoFamily;
  aspect?: string;
  selId: string;
}) {
  // selector 必须返回稳定引用：filter 会每次产生新数组 → Zustand 误判变化 → 无限重渲染白屏。
  // 改成订阅稳定引用 s.presets，组件内用 useMemo 过滤
  const allPresets = useGenPref((s) => s.presets);
  const activeId = useGenPref((s) => s.activeId[kind]);
  const presets = useMemo(() => allPresets.filter((p) => p.kind === kind), [allPresets, kind]);
  const apply = (p: GenTierPreset) => {
    // 运行中的节点不允许切档（updateData 会污染正在发的请求）
    const cur = useBoard.getState().nodes.find((n) => n.id === selId);
    if ((cur?.data as Record<string, unknown> | undefined)?.status === "running") {
      toast("节点运行中，无法切档", "err");
      return;
    }
    let data: Record<string, unknown>;
    if (p.intent) {
      // 内置档：按当前家族 + 比例实时翻译（banana=resolution、gpt=quality、通用=width/height）
      data =
        kind === "imageGen"
          ? imageTierToParams(p.intent, family ?? "generic", aspect)
          : videoTierToParams(p.intent, videoFam ?? "generic");
    } else {
      data = { ...p.data };
    }
    useBoard.getState().updateData(selId, data);
    // remember 已由 updateData 统一挂钩（全节点记忆），这里只记录档位选中态
    useGenPref.getState().setActive(kind, p.id);
  };
  return (
    <div className="gd-tier-row">
      {presets.map((p) => (
        <button
          key={p.id}
          className={`gd-tier${activeId === p.id ? " on" : ""}`}
          title={
            p.intent
              ? `${TIER_LABEL[p.intent]}：${TIER_DESC[p.intent]}`
              : `自定义档「${p.name}」${p.data.modelId ? "（含模型）" : ""}`
          }
          onClick={() => apply(p)}
        >
          {p.name}
        </button>
      ))}
    </div>
  );
}

/** 「历次」按钮：列出节点最近 10 次生成结果，点一条回退到该次的结果+参数（含 seed） */
function HistoryButton({ selId }: { selId: string }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const history = useBoard(
    (s) => (s.nodes.find((n) => n.id === selId)?.data as Record<string, unknown> | undefined)?.history as GenHistoryEntry[] | undefined,
  );
  if (!history?.length) return null;
  const apply = (e: GenHistoryEntry) => {
    // 还原那一次的结果与参数（含 seed），bumpRev 让下游感知内容已变（脏标记触发重算）
    useBoard.getState().updateData(selId, { status: "done", error: undefined, results: e.results, picked: 0, ...e.params }, { bumpRev: true });
    setOpen(false);
    toast(`已回退到 ${new Date(e.ts).toLocaleString()} 的结果与参数`, "ok");
  };
  return (
    <div ref={wrapRef} className="pop-wrap">
      <button className="gd-chip" title="查看本节点历次生成结果，点一条即回退" onClick={() => setOpen((v) => !v)}>
        历次 {history.length}
      </button>
      {open ? (
        /* 点击外部 / Esc 关闭走 PopLayer 自带机制（旧 .poplayer-overlay 无 CSS 定义，点击外部从未生效） */
        <PopLayer anchorRef={wrapRef} onClose={() => setOpen(false)} up className="hist-pop">
          <div className="hist-title">历次结果（点一条回退到该次的结果与参数）</div>
          {history.map((e, i) => (
            <div key={i} className="hist-row" onClick={() => apply(e)}>
              <div className="hist-thumbs">
                {e.results.slice(0, 3).map((src, j) => (
                  <Thumb key={j} src={src} className="hist-thumb" />
                ))}
              </div>
              <div className="hist-meta">
                <b>{e.prompt?.slice(0, 40) || "（无提示词）"}</b>
                {new Date(e.ts).toLocaleString()} · {e.results.length} 个结果 · {e.modelId?.split("::")[1] ?? ""}
                {e.params.seed ? ` · seed ${String(e.params.seed).slice(0, 8)}` : ""}
              </div>
            </div>
          ))}
        </PopLayer>
      ) : null}
    </div>
  );
}

/** 并行条数 chip（发送按钮左侧）：同参数同时发 N 条请求，结果合并回来挑 */
function ParallelChip({ parallel, onChange }: { parallel: number; onChange: (n: number) => void }) {
  return (
    <PopSelect
      up
      className="gd-count"
      layerClassName="align-right"
      title="并行条数：同参数同时发多条请求（中转站普遍支持并发），结果一起回来挑"
      value={String(parallel)}
      options={[1, 2, 3].map((n) => ({ value: String(n), label: `并行 ×${n}` }))}
      onChange={(v) => onChange(Number(v))}
    />
  );
}

/** 「更多」菜单：批量出图 / 多模型对比，菜单 → 子表单在同一弹卡内切换 */
function MorePicker({ nodeId, refCount, currentModel, role }: { nodeId: string; refCount: number; currentModel?: string; role: "image" | "video" }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"menu" | "batch" | "compare" | "grid">("menu");
  const wrapRef = useRef<HTMLDivElement>(null);
  const compareOptions = providersOfRole(role).flatMap((p) =>
    (p.models[role]?.models ?? []).map((m) => ({ key: modelKey(p.id, m), label: m, provider: p.name })),
  );
  const close = () => {
    setOpen(false);
    setView("menu");
  };
  return (
    <div ref={wrapRef} className="pop-wrap">
      <button className={`gd-chip ${open ? "open" : ""}`} title="批量出图 / 多模型对比" onClick={() => setOpen((v) => !v)}>
        <IcRows size={14} />
        <span className="gd-chip-lab">更多</span>
        <IcChevronD size={12} className="chev" />
      </button>
      {open ? (
        <PopLayer anchorRef={wrapRef} onClose={close} up className="gd-more-pop">
          {view === "menu" ? (
            <div className="pop-list">
              {role === "image" ? (
                <button className="pop-item" onClick={() => setView("grid")}>
                  <span className="pi-icon">
                    <IcGrid size={16} />
                  </span>
                  <span className="pi-text">
                    <span className="pi-label">九宫格抽卡</span>
                    <span className="pi-desc">一张网格图装 N×N 个关键帧，切分后首尾帧连拍</span>
                  </span>
                  <IcArrowR size={13} />
                </button>
              ) : null}
              <button className="pop-item" onClick={() => setView("batch")}>
                <span className="pi-icon">
                  <IcRows size={16} />
                </span>
                <span className="pi-text">
                  <span className="pi-label">批量出图</span>
                  <span className="pi-desc">一行一条提示词，并行克隆生成</span>
                </span>
                <IcArrowR size={13} />
              </button>
              {compareOptions.length >= 2 ? (
                <button className="pop-item" onClick={() => setView("compare")}>
                  <span className="pi-icon">
                    <IcLayers size={16} />
                  </span>
                  <span className="pi-text">
                    <span className="pi-label">多模型对比</span>
                    <span className="pi-desc">同一提示词/参考图，多模型并排对比</span>
                  </span>
                  <IcArrowR size={13} />
                </button>
              ) : null}
            </div>
          ) : view === "batch" ? (
            <BatchView nodeId={nodeId} refCount={refCount} onBack={() => setView("menu")} onDone={close} />
          ) : view === "grid" ? (
            <GridView nodeId={nodeId} onBack={() => setView("menu")} onDone={close} />
          ) : (
            <CompareView
              nodeId={nodeId}
              currentModel={currentModel}
              options={compareOptions}
              icon={role === "video" ? <IcVideo size={15} /> : <IcImage size={15} />}
              onBack={() => setView("menu")}
              onDone={close}
            />
          )}
        </PopLayer>
      ) : null}
    </div>
  );
}

/** 更多-子视图头部：返回箭头 + 标题 */
function MoreHead({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="pop-title gd-more-head">
      <button className="icon-btn" title="返回" aria-label="返回" onClick={onBack}>
        <IcArrowL size={13} />
      </button>
      {title}
    </div>
  );
}

/** 批量出图：一行一条提示词并行克隆生成；≥2 路参考图时还可按图批量（每张单独处理一遍） */
function BatchView({ nodeId, refCount, onBack, onDone }: { nodeId: string; refCount: number; onBack: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const run = () => {
    if (!lines.length) return;
    onDone();
    void runBatchPrompts(nodeId, lines);
    setText("");
  };
  return (
    <>
      <MoreHead title={`批量出图（当前 ${lines.length} 条）`} onBack={onBack} />
      <textarea
        className="textarea nodrag nowheel"
        rows={6}
        placeholder={"赛博朋克霓虹街头，雨夜\n水彩风格的山谷清晨\n宇航员在花田里野餐"}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="gd-more-note">
        共用风格/定调：写在本节点提示词框或接一个上游提示词节点，会自动附加到每一条前面；上游参考图各条共用。
      </div>
      {/* disabled 态 opacity 由 .btn:disabled 统一处理，不再内联 */}
      <button className="btn primary" disabled={!lines.length} onClick={run}>
        并行生成（{lines.length} 个节点）
      </button>
      {refCount >= 2 ? (
        <button
          className="btn"
          title="每路上游图片各克隆一个生成节点单独处理（提示词连线全部继承），并行运行"
          onClick={() => {
            onDone();
            void runBatchImages(nodeId);
          }}
        >
          按参考图批量（{refCount} 路各出一遍）
        </button>
      ) : null}
    </>
  );
}

/** 九宫格抽卡：按模板一次生成 N×N 关键帧网格图 → 一键切分成独立图片节点（相邻两帧首尾帧连拍成片） */
function GridView({ nodeId, onBack, onDone }: { nodeId: string; onBack: () => void; onDone: () => void }) {
  const d = useBoard((s) => s.nodes.find((n) => n.id === nodeId)?.data as ImageGenData | undefined);
  const upd = useBoard((s) => s.updateData);
  const [presetId, setPresetId] = useState(() => d?.gridPresetId ?? GRID_PRESETS[0].id);
  const preset = presetById(presetId) ?? GRID_PRESETS[0];
  // 画幅跟随下游视频画幅（N×N 等分网格每格比例 = 整图比例），默认 16:9 横屏（LibTV 同款）
  const [aspect, setAspect] = useState<GridAspect>(() => d?.gridAspect ?? "16:9");
  const dims = gridDims(preset, aspect);
  // 已抽过卡的节点提示词是包装后的模板全文，不作场景描述初始值；没抽过的带出当前提示词省得重打
  const [desc, setDesc] = useState(() => (d?.gridPresetId ? "" : (d?.prompt ?? "").trim()));
  const running = d?.status === "running";
  const done = d?.status === "done" && (d?.results?.length ?? 0) > 0;

  const run = () => {
    // 尺寸按当前模型家族写：非 banana 显式宽高（customSize 优先级最高，参考图自动跟随比例不会覆盖它）
    let family = "generic";
    try {
      family = imageFamily(resolveModelCard("image", d?.modelId));
    } catch {
      /* 未配模型/无默认：按通用家族写宽高，生成时 runImageGen 自会给出中文报错 */
    }
    // 场景描述优先级：表单填的 > 上游提示词文本（场景描述完全从之前传入的提示词获取）
    const upstreamText = collectUpstreamParts(nodeId)
      .filter((p) => p.kind === "text")
      .map((p) => p.value)
      .join("\n")
      .trim();
    upd(nodeId, {
      prompt: buildGridPrompt(preset, desc.trim() || upstreamText, aspect),
      ...gridSizePatch(preset, family, aspect),
      count: 1,
      parallel: 1,
      gridPresetId: preset.id,
      gridAspect: aspect,
      results: [],
      picked: 0,
      status: "idle",
      error: undefined,
    });
    void runFlow(nodeId);
  };

  return (
    <>
      <MoreHead title="九宫格抽卡" onBack={onBack} />
      <div className="gd-more-note">一张网格图装下 N×N 个关键帧（同次生成，主体/风格天然连贯）→ 切分成独立图片 → 框选后右键「首尾帧连拍」成片。</div>
      <div className="pop-list">
        {GRID_PRESETS.map((p) => (
          <button key={p.id} className={`pop-item ${presetId === p.id ? "on" : ""}`} onClick={() => setPresetId(p.id)}>
            <span className="pi-icon">
              <IcGrid size={15} />
            </span>
            <span className="pi-text">
              <span className="pi-label">
                {p.label}（{p.n}×{p.n}）
              </span>
              <span className="pi-desc">{p.desc}</span>
            </span>
            {presetId === p.id ? <IcCheck size={15} /> : null}
          </button>
        ))}
      </div>
      <div className="gp-sec-title">
        整图画幅<span className="gp-hint">每格比例 = 整图比例，跟随目标视频画幅选</span>
      </div>
      <div className="gp-seg">
        {GRID_ASPECTS.map((a) => (
          <button key={a.value} className={aspect === a.value ? "on" : ""} onClick={() => setAspect(a.value)}>
            {a.label}
          </button>
        ))}
      </div>
      <textarea
        className="textarea nodrag nowheel"
        rows={3}
        placeholder="场景描述：谁、在哪、干什么（各格围绕它展开；有上游参考图会一并参考）"
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
      />
      <button className="btn primary" disabled={running} onClick={run}>
        {running ? (
          <>
            <IcLoading size={15} /> 抽卡生成中…
          </>
        ) : (
          `开始抽卡（${dims.w}×${dims.h}）`
        )}
      </button>
      {d?.status === "error" && d.error ? <div className="gd-more-note">上次抽卡失败：{d.error}</div> : null}
      {done ? (
        <>
          <div className="gd-more-note">生成完成。每格约 {Math.round(dims.w / preset.n)}×{Math.round(dims.h / preset.n)}，连拍前可先「超清放大」补分辨率。</div>
          <button
            className="btn"
            onClick={() => {
              onDone();
              void applyGridSplit(nodeId, preset.n, preset.n);
            }}
          >
            切分成 {preset.n * preset.n} 张图片节点
          </button>
        </>
      ) : null}
    </>
  );
}

/** 多模型对比：勾选若干模型 → 克隆节点并行出图 */
function CompareView({
  nodeId,
  currentModel,
  options,
  icon,
  onBack,
  onDone,
}: {
  nodeId: string;
  currentModel?: string;
  options: { key: string; label: string; provider: string }[];
  icon: ReactNode;
  onBack: () => void;
  onDone: () => void;
}) {
  const [sel, setSel] = useState<string[]>([]);
  const toggle = (k: string) => setSel((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  const run = () => {
    if (!sel.length) return;
    onDone();
    void runModelCompare(nodeId, sel);
    setSel([]);
  };
  return (
    <>
      <MoreHead title="多模型对比" onBack={onBack} />
      <div className="gd-more-note">勾选要对比的模型（各克隆一个节点并行生成）</div>
      <div className="pop-list">
        {options.map((o) => (
          <button
            key={o.key}
            className={`pop-item ${sel.includes(o.key) ? "on" : ""}`}
            title={o.key === currentModel ? "当前节点已在用这个模型" : `${o.provider} · ${o.label}`}
            onClick={() => toggle(o.key)}
          >
            <span className="pi-icon">{icon}</span>
            <span className="pi-text">
              <span className="pi-label">{o.label}</span>
              <span className="pi-desc">{o.key === currentModel ? `${o.provider} · 当前使用` : o.provider}</span>
            </span>
            {sel.includes(o.key) ? <IcCheck size={15} /> : null}
          </button>
        ))}
      </div>
      <button className="btn primary" disabled={!sel.length} onClick={run}>
        生成对比（{sel.length}）
      </button>
    </>
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

/** 比例 chip 上的小示意图标（触发按钮用，尺寸略小） */
function chipAr(ratio: string): ReactNode {
  return <ArIcon ratio={ratio === "adaptive" ? "auto" : ratio} />;
}

function qualityNoticeForKey(key?: string) {
  try { return imageQualityNotice(resolveModelCard("image", key), useSettings.getState().settings.customProtocols ?? []); }
  catch { return undefined; }
}

export function GenConfigPanel() {
  const selId = useBoard((s) => {
    const sel = s.nodes.filter((n) => n.selected);
    return sel.length === 1 && sel[0].type === "imageGen" ? sel[0].id : null;
  });
  const node = useBoard((s) => (selId ? s.nodes.find((n) => n.id === selId) : undefined));
  const upd = useBoard((s) => s.updateData);
  // 参考图数与 runner 同源（collectUpstream 会展开组成员/角色卡多图），不能自己数边：
  // outPortType("group") 为 null，组接进来会被数成 0，导致创意度滑块消失、尾帧被锁死
  const refCount = useBoard(() => (selId ? collectUpstream(selId).images.length : 0));

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

  const isCodex=(d.modelId??models.defaults.image)?.startsWith("codex-membership")??false;
  const maxN = isCodex?1:familyMaxCount(family);
  // remember 由 updateData 统一挂钩，panel 只负责写节点数据
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

  const ratioNow = d.aspect ?? "auto";
  const paramLabel =
    family === "banana"
      ? `${ratioNow === "auto" ? "自动" : ratioNow} · ${d.resolution ?? "1K"}`
      : family === "gpt"
        ? `${ratioNow === "auto" ? "自动" : ratioNow} · ${gptTier}`
        : d.width && d.height
          ? `${d.width}×${d.height}`
          : "自动尺寸";

  return (
    <div className="gen-panel">
      <GenPromptBar
        nodeId={selId}
        kind="imageGen"
        toolbar={
          <>
            <ModelPicker role="image" value={d.modelId} onChange={(v) => patch({ modelId: v,...((v??models.defaults.image)?.startsWith("codex-membership")?{count:1,parallel:1}:{}) })} up />
            {(d.modelId??useSettings.getState().settings.models.defaults.image)?.startsWith("codex-membership")&&<label className="gd-chip" title="关闭时，引用 Codex 上一张结果会自动延续原对话；开启则只把图片当新参考"><input type="checkbox" checked={d.newConversation??false} onChange={e=>patch({newConversation:e.target.checked})}/>新会话</label>}
            <ParamsPop icon={<IcImage size={14}/>} label="生成输入"><CanvasInputReview nodeId={selId}/></ParamsPop>
            <ParamsPop icon={chipAr(ratioNow)} label={paramLabel}>
              {family === "banana" ? (
                <>
                  <div className="gp-sec-title">
                    宽高比<span className="gp-hint">自动 = 有参考图时取第一张图的比例，否则由模型决定</span>
                  </div>
                  <div className="gp-grid ratios">
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
                  <div className="gp-sec-title">分辨率</div>
                  <div className="gp-seg">
                    {BANANA_SIZES.map((r) => (
                      <button key={r} className={(d.resolution ?? "1K") === r ? "on" : ""} onClick={() => patch({ resolution: r })}>
                        {r}
                      </button>
                    ))}
                  </div>
                </>
              ) : family === "gpt" ? (
                <>
                  <div className="gp-sec-title">
                    比例<span className="gp-hint">当前 {d.width && d.height ? `${d.width}×${d.height}` : "自动"}</span>
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
                  <div className="gp-sec-title">分辨率</div>
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
                  <div className="gp-sec-title">质量<span className="gp-hint">{qualityNoticeForKey(d.modelId) || gptImageVariant(d.modelId ?? models.defaults.image) || "按模型支持的档位发送"}</span></div>
                  <div className="gp-seg">
                    {gptQualities(d.modelId ?? models.defaults.image).map((q) => (
                      <button disabled={Boolean(qualityNoticeForKey(d.modelId))} key={q.value} className={(d.quality ?? "auto") === q.value ? "on" : ""} onClick={() => patch({ quality: q.value })}>
                        {q.label}
                      </button>
                    ))}
                  </div>
                  <div className="gp-sec-title">
                    自定义<span className="gp-hint">宽高 16 的倍数 · 比例 1:3~3:1 · 长边 ≤3840</span>
                  </div>
                  <div className="gp-wh inline">
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
                </>
              ) : (
                <>
                  <div className="gp-sec-title">
                    预设尺寸<span className="gp-hint">自定义宽高或选预设</span>
                  </div>
                  <div className="gp-grid">
                    {familyPresets(family).map((p) => {
                      const on = d.width === p.w && d.height === p.h;
                      return (
                        <button key={`${p.w}x${p.h}`} className={`gp-cell ${on ? "on" : ""}`} title={`${p.w} × ${p.h}`} onClick={() => setWH(p.w, p.h, p.ratio)}>
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
                  <div className="gp-sec-title">自定义宽高</div>
                  <div className="gp-wh inline">
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
                </>
              )}
              {refCount > 0 ? (
                <>
                  <div className="gp-sec-title">
                    创意度
                    <span className="gp-hint">
                      {d.creativity ?? 50} · {creativityLabel(d.creativity ?? 50)}（低 = 忠于参考图微调；高 = 大胆重新演绎）
                    </span>
                  </div>
                  <input
                    type="range"
                    className="range nodrag"
                    min={0}
                    max={100}
                    step={5}
                    value={d.creativity ?? 50}
                    onChange={(e) => patch({ creativity: +e.target.value })}
                  />
                </>
              ) : null}
              <div className="gp-sec-title">
                随机种子
                <span className="gp-hint">锁定后同提示词+同参数可复现（不支持的家族会被忽略）</span>
              </div>
              <div className="gp-seed">
                <input
                  className="input nodrag"
                  type="number"
                  placeholder="随机"
                  value={d.seed ?? ""}
                  onChange={(e) => patch({ seed: e.target.value ? Number(e.target.value) : undefined })}
                />
                <button
                  className="btn sm nodrag"
                  title="掷一个随机种子锁定"
                  onClick={() => patch({ seed: Math.floor(Math.random() * 1_000_000_000) })}
                >
                  掷骰
                </button>
                {d.seed !== undefined ? (
                  <button className="btn sm nodrag" title="解除锁定，每次随机" onClick={() => patch({ seed: undefined })}>
                    清除
                  </button>
                ) : null}
              </div>
              <div className="gp-sec-title" style={{ marginTop: 8 }}>
                负向提示词
                <span className="gp-hint">不想出现的内容（仅支持的家族生效）</span>
              </div>
              <textarea
                className="textarea nodrag"
                placeholder="如：多余手指、文字水印、低质量、变形、模糊"
                value={d.negative ?? ""}
                onChange={(e) => patch({ negative: e.target.value })}
                style={{ width: "100%", minHeight: 46, fontSize: 12.5, resize: "vertical" }}
              />
              <div className="gp-foot">
                参考图：已接入 {refCount} 路 · 最多 {familyMaxRef(family)} 张 · {FAMILY_LABEL[family]}
              </div>
            </ParamsPop>
            <TierRow kind="imageGen" family={family} aspect={d.aspect} selId={selId} />
            <HistoryButton selId={selId} />
            <LangChip lang={d.lang} onChange={(l) => patch({ lang: l })} />
            <MorePicker
              nodeId={selId}
              refCount={refCount}
              role="image"
              currentModel={(() => {
                try {
                  const c = resolveModelCard("image", d.modelId);
                  return modelKey(c.id, c.model);
                } catch {
                  return undefined;
                }
              })()}
            />
          </>
        }
        trailing={
          <>
            <ParallelChip parallel={d.parallel ?? 1} onChange={(n) => patch({ parallel: n })} />
            {/* 换模型后旧张数可能超出新家族上限：显示与发送都收敛到合法域，避免 chip 变「请选择…」而请求仍按旧值发 */}
            <CountChip count={Math.min(d.count ?? 1, maxN)} max={maxN} onChange={(n) => patch({ count: n })} />
          </>
        }
      />
    </div>
  );
}

/** 视频生成参数栏 — 选中「生成视频」节点时出现在画布下方，按模型家族出参数 */
export function VideoConfigPanel() {
  const selId = useBoard((s) => {
    const sel = s.nodes.filter((n) => n.selected);
    return sel.length === 1 && sel[0].type === "videoGen" ? sel[0].id : null;
  });
  const node = useBoard((s) => (selId ? s.nodes.find((n) => n.id === selId) : undefined));
  const upd = useBoard((s) => s.updateData);
  // 与 runner 同源计数（组成员/角色卡多图会被展开）；自己数边会把组上游算成 0，尾帧开关被误锁
  const refCount = useBoard(() => (selId ? collectUpstream(selId).images.length : 0));
  const d = node?.data as VideoGenData | undefined;
  const models = useSettings((s) => s.settings.models);
  const suppressed = useUi((s) => s.genPanelSuppressed);

  const family: VideoFamily = useMemo(() => {
    if (!d) return "generic";
    try {
      return videoFamily(resolveModelCard("video", d.modelId));
    } catch {
      return "generic";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, models]);

  if (!selId || !d || suppressed) return null;
  const meta = videoMeta(family);
  const patch = (p: Partial<VideoGenData>) => upd(selId, p);
  const dur = d.duration ?? meta.defaultDuration;
  const res = d.resolution ?? meta.defaultResolution;
  const asp = d.aspect ?? meta.aspects[0];

  return (
    <div className="gen-panel">
      <GenPromptBar
        nodeId={selId}
        kind="videoGen"
        toolbar={
          <>
            <ModelPicker role="video" value={d.modelId} onChange={(v) => patch({ modelId: v })} up />
            <ParamsPop icon={chipAr(asp)} label={`${dur}s · ${res} · ${asp === "adaptive" ? "自适应" : asp}`}>
              <div className="gp-sec-title">
                时长（秒）<span className="gp-hint">当前 {dur}s</span>
              </div>
              <div className="gp-dur">
                <div className="gp-seg" style={{ flex: "0 0 auto" }}>
                  {meta.durations.map((t) => (
                    <button key={t} className={dur === t ? "on" : ""} style={{ minWidth: 44, flex: "0 0 auto" }} onClick={() => patch({ duration: t })}>
                      {t}s
                    </button>
                  ))}
                </div>
                {meta.durationRange ? (
                  <>
                    <input
                      type="range"
                      className="range nodrag"
                      style={{ flex: 1, minWidth: 90 }}
                      min={meta.durationRange.min}
                      max={meta.durationRange.max}
                      step={1}
                      title={`滑动选择 ${meta.durationRange.min}-${meta.durationRange.max} 秒（该家族支持任意整数秒）`}
                      value={Math.min(Math.max(Number(dur) || meta.durationRange.min, meta.durationRange.min), meta.durationRange.max)}
                      onChange={(e) => patch({ duration: e.target.value })}
                    />
                    <input
                      className="input nodrag"
                      type="number"
                      min={1}
                      max={600}
                      style={{ width: 68, minHeight: 26 }}
                      title="自定义秒数（可超出滑块范围；模型不支持会由服务商报错）"
                      value={Number(dur) || ""}
                      onChange={(e) => {
                        const v = Math.max(1, Math.min(600, Number(e.target.value) || 1));
                        patch({ duration: String(v) });
                      }}
                    />
                  </>
                ) : null}
              </div>
              {meta.aspects.length ? (
                <>
                  <div className="gp-sec-title">宽高比</div>
                  <div className="gp-grid ratios">
                    {meta.aspects.map((a) => (
                      <button
                        key={a}
                        className={`gp-cell ${asp === a ? "on" : ""}`}
                        title={a === "adaptive" ? "比例自适应（图生视频推荐，跟随首帧）" : a}
                        onClick={() => patch({ aspect: a })}
                      >
                        {a === "adaptive" ? <span className="ar-ic">A</span> : <ArIcon ratio={a} />}
                        {a === "adaptive" ? "自适应" : a}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <p className="sec-desc" style={{ margin: "4px 0 0" }}>该家族比例由模型按首帧/内容决定，无需设置。</p>
              )}
              <div className="gp-sec-title">分辨率</div>
              <div className="gp-seg">
                {meta.resolutions.map((r) => (
                  <button key={r} className={res === r ? "on" : ""} onClick={() => patch({ resolution: r })}>
                    {r}
                  </button>
                ))}
              </div>
              {(meta.maxRef ?? 0) > 0 && refCount > 0 ? (
                <>
                  <div className="gp-sec-title">
                    参考模式<span className="gp-hint">该家族支持角色/主体参考图模式（最多 {meta.maxRef} 张）</span>
                  </div>
                  <div className="gp-seg">
                    <button className={(d.refMode ?? "frame") === "frame" ? "on" : ""} onClick={() => patch({ refMode: "frame" })}>
                      首帧模式
                    </button>
                    <button className={d.refMode === "reference" ? "on" : ""} onClick={() => patch({ refMode: "reference" })}>
                      参考图模式
                    </button>
                  </div>
                </>
              ) : null}
              {meta.audioToggle || meta.tail ? <div className="gp-sec-title">选项</div> : null}
              <div className="gp-opts">
                {meta.audioToggle ? (
                  <label className="gp-check nodrag" title="生成音频（音效/配乐，按家族映射到对应字段）">
                    <input type="checkbox" checked={d.audio ?? true} onChange={(e) => patch({ audio: e.target.checked })} />
                    生成音频
                  </label>
                ) : null}
                {meta.tail ? (
                  <label
                    className="gp-check nodrag"
                    title="接入 2 路上游图片时：第 1 路作首帧、第 2 路作尾帧（首尾帧过渡）；关闭则只用首帧"
                  >
                    <input
                      type="checkbox"
                      disabled={refCount < 2}
                      checked={(d.useTail ?? true) && refCount >= 2}
                      onChange={(e) => patch({ useTail: e.target.checked })}
                    />
                    尾帧过渡{refCount < 2 ? "（需 2 路图）" : ""}
                  </label>
                ) : null}
              </div>
              <div className="gp-foot">
                {d.refMode === "reference" && (meta.maxRef ?? 0) > 0
                  ? `参考图：${refCount} 路全部作为角色/主体参考（最多 ${meta.maxRef} 张）`
                  : `参考图：${refCount} 路（第 1 路 = 首帧${meta.tail ? " · 第 2 路 = 尾帧" : ""}）· 参考视频 / 音频接入左侧输入口`}
                {meta.note ? ` · ${meta.note}` : ""}
              </div>
            </ParamsPop>
            <TierRow kind="videoGen" videoFam={family} aspect={d.aspect} selId={selId} />
            <HistoryButton selId={selId} />
            <LangChip lang={d.lang} onChange={(l) => patch({ lang: l })} />
            <MorePicker nodeId={selId} refCount={refCount} role="video" currentModel={d.modelId} />
          </>
        }
        trailing={<ParallelChip parallel={d.parallel ?? 1} onChange={(n) => patch({ parallel: n })} />}
      />
    </div>
  );
}

/** 音频生成参数栏 — 选中「生成音频」节点时出现：提示词栏 + 模型/音色 */
export function AudioConfigPanel() {
  const selId = useBoard((s) => {
    const sel = s.nodes.filter((n) => n.selected);
    return sel.length === 1 && sel[0].type === "audioGen" ? sel[0].id : null;
  });
  const node = useBoard((s) => (selId ? s.nodes.find((n) => n.id === selId) : undefined));
  const upd = useBoard((s) => s.updateData);
  const suppressed = useUi((s) => s.genPanelSuppressed);
  const d = node?.data as AudioGenData | undefined;
  if (!selId || !d || suppressed) return null;
  const patch = (p: Partial<AudioGenData>) => upd(selId, p);
  return (
    <div className="gen-panel">
      <GenPromptBar
        nodeId={selId}
        kind="audioGen"
        toolbar={
          <>
            <ModelPicker role="audio" value={d.modelId} onChange={(v) => patch({ modelId: v })} up />
            <input
              className="input gd-voice nodrag"
              placeholder="音色（如 alloy）"
              title="openai 协议 = voice 字段（alloy/echo/nova…）；预设协议用 {{voice}} 占位"
              value={d.voice ?? ""}
              onChange={(e) => patch({ voice: e.target.value || undefined })}
            />
          </>
        }
      />
    </div>
  );
}

/** File → dataURL（本地选图 / 拖入共用） */
function fileToDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error(`读取文件失败：${f.name}`));
    r.readAsDataURL(f);
  });
}

/** 资产选图网格（角色卡「生成参考图」用）— 弹层内多选资产库图片，确认后转 dataURL 交给调用方；也可从本地磁盘选文件 */
function AssetPickGrid({ onPick, onClose }: { onPick: (dataUrls: string[]) => void; onClose: () => void }) {
  const items = useAssets((s) => s.items).filter((a) => a.kind === "image");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => {
    const next = new Set(sel);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSel(next);
  };

  const confirm = async () => {
    if (!sel.size) return;
    setBusy(true);
    try {
      const urls: string[] = [];
      for (const id of sel) {
        const it = items.find((x) => x.id === id);
        if (!it) continue;
        urls.push(await assetToDataUrl(it.path, it.mime));
      }
      onPick(urls);
      onClose();
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(false);
    }
  };

  /** 本地磁盘选图（可多选，读成 dataURL 直接加入参考） */
  const pickLocal = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) return;
      setBusy(true);
      Promise.all(files.map(fileToDataUrl))
        .then((urls) => {
          onPick(urls);
          onClose();
        })
        .catch((e) => toast(errMsg(e), "err"))
        .finally(() => setBusy(false));
    };
    input.click();
  };

  return (
    <div className="cc-asset-pick">
      <div className="cc-asset-head">
        <span className="gp-sec-title" style={{ margin: 0 }}>
          从资产库选参考图（可多选：脸 / 腿 / 胸等局部图）
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn sm" disabled={busy} title="从本地磁盘选择图片文件（可多选）" onClick={pickLocal}>
          {busy ? "读取中…" : "本地文件"}
        </button>
        <button className="btn sm" onClick={onClose}>
          取消
        </button>
        <button className="btn sm primary" disabled={busy || !sel.size} onClick={() => void confirm()}>
          {busy ? "转换中…" : `用这 ${sel.size} 张作参考`}
        </button>
      </div>
      {items.length ? (
        <div className="cc-asset-grid">
          {items.map((it) => {
            const on = sel.has(it.id);
            return (
              <button
                key={it.id}
                className={`cc-asset-cell ${on ? "on" : ""}`}
                title={it.name || "资产图片"}
                onClick={() => toggle(it.id)}
              >
                <img src={assetUrl(it.thumb || it.path)} alt="" loading="lazy" />
                {on ? (
                  <span className="cc-asset-check">
                    <IcCheck size={12} />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="sec-desc" style={{ padding: "10px 0" }}>
          资产库还没有图片。画布上生成过的图片会自动收录进资产库。
        </div>
      )}
    </div>
  );
}

/** 角色卡参数栏 — 选中「角色卡」节点时出现在画布下方（与生图节点同款底部生成栏）。
 *  角色卡的设置类（分析/绘画模型、比例、设定卡风格、提示词语言）全收这里；节点本体只留档案 + 素材勾选 + 生成。 */
export function CharConfigPanel() {
  const selId = useBoard((s) => {
    const sel = s.nodes.filter((n) => n.selected);
    return sel.length === 1 && sel[0].type === "charCard" ? sel[0].id : null;
  });
  const node = useBoard((s) => (selId ? s.nodes.find((n) => n.id === selId) : undefined));
  const upd = useBoard((s) => s.updateData);
  const suppressed = useUi((s) => s.genPanelSuppressed);
  const models = useSettings((s) => s.settings.models);
  const d = node?.data as CharCardData | undefined;
  const family = useMemo<ImageFamily>(() => {
    if (!d) return "generic";
    try {
      return imageFamily(resolveModelCard("image", d.imageModelId));
    } catch {
      return "generic";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, models]);

  const [refPickerOpen, setRefPickerOpen] = useState(false);
  // ⚠ hooks 必须全部放在条件 return 之前：选中/取消选中时 hooks 数量不能变，否则 React 报
  // 「Rendered more hooks than during the previous render」直接白屏。上游图 join/split 保证
  // 只在内容变化时重渲染（同 refCount 模式）。
  const upstreamImgs = useBoard(() => {
    if (!selId) return "";
    return collectUpstream(selId).images.join("\n");
  })
    .split("\n")
    .filter(Boolean);
  if (!selId || !d || suppressed) return null;
  const patch = (p: Partial<CharCardData>) => upd(selId, p);
  const mode = d.outMode ?? (d.genImages === false ? "prompt" : "image");
  const aspectLabel = d.aspect && d.aspect !== "auto" ? d.aspect : "比例";
  const styleLabel = CARD_STYLES.find((s) => s.value === d.style)?.label ?? "风格";
  const hasPrompts = Object.values(d.prompts).some((t) => (t ?? "").trim());
  const toggleDeliv = (v: CharCardData["deliverables"][number]) => {
    const has = d.deliverables.includes(v);
    patch({ deliverables: has ? d.deliverables.filter((x) => x !== v) : [...d.deliverables, v] });
  };
  const genRefCount = d.genRefs?.length ?? 0;
  const removeRef = (i: number) => patch({ genRefs: (d.genRefs ?? []).filter((_, k) => k !== i) });

  /** 拖入本地图片文件 → dataURL 追加进已选参考 */
  const onDropFiles = async (e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (!files.length) {
      toast("拖入的文件里没有图片", "err");
      return;
    }
    try {
      const urls = await Promise.all(files.map(fileToDataUrl));
      patch({ genRefs: [...(d.genRefs ?? []), ...urls] });
      toast(`已添加 ${urls.length} 张参考图`, "ok");
    } catch (err) {
      toast(errMsg(err), "err");
    }
  };

  return (
    <div className="gen-panel">
      <div className="ed-main glass nowheel">
        <div className="gd-toolbar">
          <span className="ed-title">
            <IcIdCard size={15} /> 角色卡
          </span>
          <ModelPicker role="chat" value={d.chatModelId} onChange={(v) => patch({ chatModelId: v })} up />
          {mode === "image" ? (
            <>
              <ModelPicker role="image" value={d.imageModelId} onChange={(v) => patch({ imageModelId: v })} up />
              <NodeParamsPop
                icon={<ArIcon ratio={d.aspect && d.aspect !== "auto" ? d.aspect : "auto"} />}
                label={aspectLabel}
                title="图片比例 / 分辨率"
                up
              >
                <AspectSelector family={family} model={d.imageModelId ?? models.defaults.image} qualityNotice={qualityNoticeForKey(d.imageModelId)} aspect={d.aspect} resolution={d.resolution} quality={d.quality} patch={patch} />
              </NodeParamsPop>
            </>
          ) : null}
          <NodeParamsPop icon={<IcImage size={14} />} label={styleLabel} title="设定卡排版风格" up>
            <div className="gp-sec-title">设定卡排版风格</div>
            <div className="opt-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
              {CARD_STYLES.map((s) => (
                <button
                  key={s.value}
                  title={s.desc}
                  className={`opt-cell ${d.style === s.value ? "on" : ""}`}
                  onClick={() => patch({ style: s.value })}
                >
                  <span className="oc-lab">{s.label}</span>
                </button>
              ))}
            </div>
          </NodeParamsPop>
          <NodeParamsPop
            icon={<IcLayers size={14} />}
            label={`素材 ${d.deliverables.length}`}
            title="产出素材（勾选要生成的种类）"
            up
          >
            <div className="gp-sec-title">产出素材（勾选 · 逐张生成，「补一张」自动换组）</div>
            <div className="cc-check-grid">
              {CHAR_DELIVERABLES.map((dv) => {
                const on = d.deliverables.includes(dv.value);
                return (
                  <button
                    key={dv.value}
                    className={`cc-check-cell ${on ? "on" : ""}`}
                    title={dv.desc}
                    onClick={() => toggleDeliv(dv.value)}
                  >
                    <span className="cc-check">{on ? <IcCheck size={12} /> : null}</span>
                    <span>{dv.label}</span>
                  </button>
                );
              })}
            </div>
          </NodeParamsPop>
          <NodeParamsPop
            icon={<IcImage size={14} />}
            label={genRefCount ? `参考图 ${genRefCount}` : "参考图"}
            title="生成参考图：分析用图不变，只换生成套件的参考图"
            up
          >
            {/* 整个弹卡都是拖入区：把本地图片文件直接拖进来即可加入参考 */}
            <div
              className="cc-refs-wrap"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => void onDropFiles(e)}
            >
              <div className="gp-sec-title">生成参考图（可换更清晰的图 / 多张局部参考）</div>
              {/* 上游传入图：默认参考，只读展示 */}
              <div className="cc-ref-sect">
                <div className="cc-ref-sect-lab">上游传入{upstreamImgs.length ? `（${upstreamImgs.length} 张，默认参考）` : ""}</div>
                {upstreamImgs.length ? (
                  <div className="cc-ref-thumbs">
                    {upstreamImgs.map((src, i) => (
                      <span key={i} className="cc-ref-thumb ro" title={`上游传入图 ${i + 1}（默认参考）`}>
                        <Thumb src={src} alt="" />
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="sec-desc">没有上游图片：连一张人物图到输入口</div>
                )}
              </div>
              {/* 已选参考图：优先于上游，可移除 */}
              <div className="cc-ref-sect">
                <div className="cc-ref-sect-lab">
                  已选参考{genRefCount ? `（${genRefCount} 张）` : ""}
                  {d.genRefs === undefined ? (
                    <span className="cc-ref-sect-hint">未设置 = 用上游图</span>
                  ) : d.genRefs.length === 0 ? (
                    <span className="cc-ref-sect-hint">已清空 = 不带参考图</span>
                  ) : null}
                </div>
                {genRefCount ? (
                  <div className="cc-ref-thumbs">
                    {d.genRefs!.map((src, i) => (
                      <span key={i} className="cc-ref-thumb" title={`参考图 ${i + 1}`}>
                        <Thumb src={src} alt="" />
                        <button className="cc-ref-x" title="移除这张参考图" aria-label="移除这张参考图" onClick={() => removeRef(i)}>
                          <IcClose size={10} />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              {/* 添加块：虚线圆角矩形 + 号。点开资产库选图；也可直接拖图片文件进来 */}
              <button
                className="cc-ref-add"
                title="点开资产库选图；也可以直接把本地图片文件拖进这个弹卡"
                onClick={() => setRefPickerOpen((v) => !v)}
              >
                <IcPlus size={15} />
                <span>添加参考图</span>
                <span className="cc-ref-add-hint">点选资产库 · 或拖入本地图片</span>
              </button>
              {refPickerOpen ? (
                <AssetPickGrid
                  onPick={(urls) => patch({ genRefs: [...(d.genRefs ?? []), ...urls] })}
                  onClose={() => setRefPickerOpen(false)}
                />
              ) : null}
              {d.genRefs !== undefined ? (
                <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <button className="btn sm" title="回到默认：用上游传入的第一张图作参考" onClick={() => patch({ genRefs: undefined })}>
                    恢复上游默认
                  </button>
                  {genRefCount > 0 ? (
                    <button className="btn sm" title="生成时不带任何参考图（纯提示词）" onClick={() => patch({ genRefs: [] })}>
                      清空参考图
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </NodeParamsPop>
          {hasPrompts ? (
            <NodeParamsPop icon={<IcText size={14} />} label="提示词" title="各素材提示词（可手动修改）" up>
              <div className="gp-sec-title">各素材提示词（可手动修改）</div>
              {CHAR_DELIVERABLES.filter((dv) => (d.prompts[dv.value] ?? "").trim()).map((dv) => (
                <div key={dv.value} className="cc-prompt-item">
                  <span className="cc-lab">{dv.label}</span>
                  <textarea
                    className="textarea nodrag nowheel"
                    rows={3}
                    value={d.prompts[dv.value]}
                    onChange={(e) => patch({ prompts: { ...d.prompts, [dv.value]: e.target.value } })}
                  />
                </div>
              ))}
            </NodeParamsPop>
          ) : null}
          <LangChip lang={d.lang} onChange={(l) => patch({ lang: l })} />
        </div>
      </div>
    </div>
  );
}

/** 电商长图参数栏 — 选中「电商长图」节点时出现在画布下方（与生图节点同款底部生成栏）。
 *  设置类（视觉/绘画模型、比例、切片数、风格基调）全收这里；节点本体只留产品描述 + 切片预览 + 长图结果。 */
export function EcomConfigPanel() {
  const selId = useBoard((s) => {
    const sel = s.nodes.filter((n) => n.selected);
    return sel.length === 1 && sel[0].type === "ecomImage" ? sel[0].id : null;
  });
  const node = useBoard((s) => (selId ? s.nodes.find((n) => n.id === selId) : undefined));
  const upd = useBoard((s) => s.updateData);
  const suppressed = useUi((s) => s.genPanelSuppressed);
  const models = useSettings((s) => s.settings.models);
  const d = node?.data as EcomImageData | undefined;
  const family = useMemo<ImageFamily>(() => {
    if (!d) return "generic";
    try {
      return imageFamily(resolveModelCard("image", d.imageModelId));
    } catch {
      return "generic";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, models]);

  if (!selId || !d || suppressed) return null;
  const patch = (p: Partial<EcomImageData>) => upd(selId, p);
  const mode = d.outMode ?? "image";
  const aspectLabel = d.aspect && d.aspect !== "auto" ? d.aspect : "比例";
  const workMode = d.mode ?? "product";
  const tone = workMode === "h5" ? (d.h5StyleTone ?? "") : (d.styleTone ?? "");
  const n = d.sliceCount ?? 6;

  return (
    <div className="gen-panel">
      <div className="ed-main glass nowheel">
        <div className="gd-toolbar">
          <span className="ed-title">
            <IcEcom size={15} /> 电商长图
          </span>
          <PopSelect
            up
            className="gd-lang"
            title="工作模式"
            value={workMode}
            options={[
              { value: "product", label: "产品图", desc: "分析产品图 → 营销切片", icon: <IcImage size={15} /> },
              { value: "h5", label: "H5 长文", desc: "长文案 → 按内容切片 → 每段配图", icon: <IcRows size={15} /> },
            ]}
            onChange={(v) => patch({ mode: v as "product" | "h5" })}
          />
          <ModelPicker role="chat" value={d.chatModelId} onChange={(v) => patch({ chatModelId: v })} up />
          {mode === "image" ? (
            <>
              <ModelPicker role="image" value={d.imageModelId} onChange={(v) => patch({ imageModelId: v })} up />
              <NodeParamsPop
                icon={<ArIcon ratio={d.aspect && d.aspect !== "auto" ? d.aspect : "auto"} />}
                label={aspectLabel}
                title="切片比例 / 分辨率"
                up
              >
                <AspectSelector family={family} model={d.imageModelId ?? models.defaults.image} qualityNotice={qualityNoticeForKey(d.imageModelId)} aspect={d.aspect} resolution={d.resolution} quality={d.quality} patch={patch} />
              </NodeParamsPop>
            </>
          ) : null}
          <NodeParamsPop icon={<IcRows size={14} />} label={`${n} 片`} title="切片数（上下拼接成一张长图）" up>
            <div className="gp-sec-title">切片数（上下拼接成一张长图）</div>
            <div className="gp-seg">
              {[4, 5, 6, 7, 8].map((x) => (
                <button key={x} className={n === x ? "on" : ""} onClick={() => patch({ sliceCount: x })}>
                  {x}
                </button>
              ))}
            </div>
            <span className="gp-hint">改切片数/比例/风格后，点节点上的「重置」清掉旧分析才会重新规划。</span>
          </NodeParamsPop>
          <NodeParamsPop icon={<IcImage size={14} />} label="风格" title={workMode === "h5" ? "H5 默认切片风格" : "风格基调（统一调性）"} up>
            <div className="gp-sec-title">{workMode === "h5" ? "H5 默认切片风格（各切片保持统一调性，留空由模型定）" : "风格基调（各切片保持统一调性，留空由模型定）"}</div>
            <textarea
              className="textarea nodrag nowheel"
              rows={3}
              placeholder={workMode === "h5" ? "例：清新插画 / 杂志拼贴" : "例：高级简约白底大片 / 活泼拼贴风 / 国潮喜庆"}
              value={tone}
              onChange={(e) => patch(workMode === "h5" ? { h5StyleTone: e.target.value } : { styleTone: e.target.value })}
            />
          </NodeParamsPop>
          <NodeParamsPop icon={<IcLayers size={14} />} label={d.seed != null ? String(d.seed) : "种子"} title="随机种子" up>
            <div className="gp-sec-title">
              随机种子<span className="gp-hint">全片同一 seed → 色调/笔触基底一致（seedream/flux/qwen 有效）</span>
            </div>
            <div className="ecom-seed-row">
              <input
                className="input nodrag"
                type="number"
                min={0}
                placeholder="留空 = 随机"
                value={d.seed ?? ""}
                onChange={(e) => patch({ seed: e.target.value === "" ? undefined : Number(e.target.value) })}
              />
              <button className="btn sm" title="清空（随机生成）" onClick={() => patch({ seed: undefined })}>
                清空
              </button>
            </div>
          </NodeParamsPop>
          <NodeParamsPop
            icon={<IcText size={14} />}
            label="文案"
            title={workMode === "h5" ? "H5 长文案（按内容切片）" : "产品描述 / 卖点 / 适用人群"}
            up
          >
            <div className="gp-sec-title">
              {workMode === "h5"
                ? "H5 长文案（会按段落/主题自动切片，每段配一张图；也可连接上游文本节点）"
                : "产品描述 / 卖点 / 适用人群（留空也可只用产品图；连了上游文本会自动并入）"}
            </div>
            <textarea
              className="textarea nodrag nowheel"
              rows={workMode === "h5" ? 8 : 4}
              placeholder={workMode === "h5" ? "把整篇 H5 文案粘贴在这里…" : "例：便携式蓝牙音箱，IPX7 防水，20 小时续航，适合户外 / 运动人群"}
              value={d.productDesc ?? ""}
              onChange={(e) => patch({ productDesc: e.target.value })}
            />
          </NodeParamsPop>
        </div>
      </div>
    </div>
  );
}
