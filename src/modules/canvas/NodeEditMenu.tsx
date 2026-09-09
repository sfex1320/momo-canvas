/**
 * 悬浮工具条「编辑」— 全部直接作用于当前节点，不再派生下游处理节点：
 *   聚焦裁剪：进入图上框选（EditSurface），本胶囊变为比例/确认条，确认后裁出局部生成新图片节点；
 *   局部重绘：进入图上蒙版涂抹，本胶囊变为工具条（工具/笔刷/提示词/通道/运行），结果就地写回；
 *   高清增强 / 扩图 / 尺寸调整：弹卡内调参运行，结果就地写回（可 Ctrl+Z 撤销）；
 *   视频节点：视频配音（产物是新音轨视频，仍派生下游节点）。
 */
import { useEffect, useRef, useState } from "react";
import { outPortType, useBoard } from "../../core/stores/boardStore";
import { evenSplit, toast, useUi } from "../../core/stores/uiStore";
import { applyCropToNewNode, applyEnhance, applyGridSplitFractional, applyInpaint, applyMark, applyOutpaint, applyResize, createStoryboardGroup, nodeMainImage, redrawElementImage, retouchElementText, spawnAiPresetNode } from "../../core/nodeEdit";
import { AI_PRESETS, AI_PRESET_GROUPS, type AiPreset } from "../../core/aiPresets";
import { collectUpstreamParts } from "../../core/runner";
import { imageDims } from "../../core/imageInfo";
import { PopLayer, PopSelect } from "../../ui/PopSelect";
import { NumInput } from "../../ui/kit";
import {
  IcArrowL, IcBox, IcBrush, IcCheck, IcChevronD, IcClose, IcCrop, IcDub, IcEnhance, IcExpand, IcGrid, IcIdCard, IcImage, IcLayers, IcLoading, IcOrbit, IcPerson, IcPose, IcResize, IcScan, IcTag, IcText, IcTimer, IcTrash, IcUndo, IcUpscale, IcVector, IcWand,
} from "../../ui/icons";
import type { EditChannel, ImageData, NodeKind, OutpaintPads, ResizeParams } from "../../core/types";

/* ================= 主入口：按会话/输出类型决定渲染什么 ================= */

export function NodeEditMenu({ id }: { id: string }) {
  const me = useUi((s) => (s.mediaEdit?.nodeId === id ? s.mediaEdit : null));
  const out = useBoard((s) => {
    const n = s.nodes.find((x) => x.id === id);
    return n ? outPortType(n.type as NodeKind, n.data as Record<string, unknown>) : null;
  });
  const hasImage = useBoard((s) => !!nodeMainImage(s.nodes.find((n) => n.id === id)));

  if (me?.mode === "crop") return <CropBar id={id} />;
  if (me?.mode === "gridsplit") return <GridSplitBar id={id} />;
  if (me?.mode === "inpaint") return <InpaintBar id={id} />;
  if (me?.mode === "mark") return <MarkBar id={id} />;
  if (out === "video") return <VideoDubButton id={id} />;
  if (out === "image" && hasImage) return <EditMenuButton id={id} />;
  return null;
}

/* ================= 视频：视频配音（派生下游节点，唯一保留的派生动作） ================= */

function VideoDubButton({ id }: { id: string }) {
  const spawn = () => {
    const s = useBoard.getState();
    const exist = s.edges.find((e) => e.source === id && s.nodes.find((n) => n.id === e.target)?.type === "videoDub");
    if (exist) {
      s.onNodesChange([{ type: "select", id: exist.target, selected: true }]);
      toast("画布上已有该处理节点，已为你选中", "ok");
      return;
    }
    s.spawnEdit(id, "videoDub");
  };
  return (
    <button className="nt-btn" title="视频配音：在下游新建配音节点（翻译/换音轨）" onClick={spawn}>
      <IcDub size={14} /> 视频配音
    </button>
  );
}

/* ================= 图片：编辑菜单 + 参数卡 ================= */

type View = "menu" | "enhance" | "outpaint" | "resize" | "gridAI" | "elemRedraw" | "elemText";

function EditMenuButton({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("menu");
  const wrapRef = useRef<HTMLDivElement>(null);
  const openMediaEdit = useUi((s) => s.openMediaEdit);
  // 元素图层元数据：元素工坊拆解产物才有的「元素重绘 / 改字」专属入口
  const elemMeta = useBoard((s) => (s.nodes.find((n) => n.id === id)?.data as ImageData | undefined)?.elemMeta ?? null);
  const close = () => {
    setOpen(false);
    setView("menu");
  };
  return (
    <div ref={wrapRef} className="pop-wrap">
      <button className={`nt-btn ${open ? "on" : ""}`} title="直接编辑这张图片（标记/裁剪/重绘/扩图/尺寸/增强）" onClick={() => setOpen((v) => !v)}>
        <IcWand size={14} />
        编辑
        <IcChevronD size={12} className="chev" />
      </button>
      {open ? (
        <PopLayer anchorRef={wrapRef} onClose={close} className={view === "menu" ? "ne-menu-pop" : view === "gridAI" ? "ne-ai-pop" : "ne-pop"}>
          {view === "menu" ? (
            <div className="pop-list ne-menu2">
              <button className="pop-item" onClick={() => { close(); openMediaEdit(id, "crop"); }}>
                <span className="pi-icon"><IcCrop size={16} /></span>
                <span className="pi-text">
                  <span className="pi-label">聚焦裁剪</span>
                  <span className="pi-desc">在图上框选局部，裁出为新节点</span>
                </span>
              </button>
              <button className="pop-item" onClick={() => { close(); openMediaEdit(id, "inpaint"); }}>
                <span className="pi-icon"><IcBrush size={16} /></span>
                <span className="pi-text">
                  <span className="pi-label">局部重绘</span>
                  <span className="pi-desc">在图上涂抹蒙版，只重画选区</span>
                </span>
              </button>
              {elemMeta ? (
                <button className="pop-item" onClick={() => setView("elemRedraw")}>
                  <span className="pi-icon"><IcWand size={16} /></span>
                  <span className="pi-text">
                    <span className="pi-label">元素重绘</span>
                    <span className="pi-desc">按描述重画这个图层元素，仍抠回透明底</span>
                  </span>
                </button>
              ) : null}
              {elemMeta?.role === "text" && elemMeta.text ? (
                <button className="pop-item" onClick={() => setView("elemText")}>
                  <span className="pi-icon"><IcText size={16} /></span>
                  <span className="pi-text">
                    <span className="pi-label">改字</span>
                    <span className="pi-desc">替换文字内容，保持字体风格与颜色</span>
                  </span>
                </button>
              ) : null}
              <button className="pop-item" onClick={() => { close(); openMediaEdit(id, "gridsplit"); }}>
                <span className="pi-icon"><IcGrid size={16} /></span>
                <span className="pi-text">
                  <span className="pi-label">宫格切分</span>
                  <span className="pi-desc">图上拖线调格，勾选宫格一键创建分镜组</span>
                </span>
              </button>
              <button className="pop-item" onClick={() => setView("gridAI")}>
                <span className="pi-icon"><IcWand size={16} /></span>
                <span className="pi-text">
                  <span className="pi-label">AI 模板…</span>
                  <span className="pi-desc">分镜推演/多机位/三视图/设定图：铺生成节点图生图，可再切分建组</span>
                </span>
              </button>
              <button className="pop-item" onClick={() => { close(); openMediaEdit(id, "mark"); }}>
                <span className="pi-icon"><IcTag size={16} /></span>
                <span className="pi-text">
                  <span className="pi-label">标记</span>
                  <span className="pi-desc">画笔、点位与框选标记，合成后就地写回</span>
                </span>
              </button>
              <button className="pop-item" onClick={() => { close(); useUi.getState().setPlanarSheetNodeId(id); }}>
                <span className="pi-icon"><IcVector size={16}/></span><span className="pi-text"><span className="pi-label">立体转平面矢量…</span><span className="pi-desc">立体效果图 → 平面部件总稿 → SVG → 原图拆件与重绘</span></span>
              </button>
              <button className="pop-item" onClick={() => { close(); useUi.getState().setLayerEditorNodeId(id); }}>
                <span className="pi-icon"><IcLayers size={16} /></span>
                <span className="pi-text">
                  <span className="pi-label">元素分层…</span>
                  <span className="pi-desc">识别文字/主体/Logo，拆成透明图层（可重绘、改字、合成）</span>
                </span>
              </button>
              <button className="pop-item" onClick={() => setView("enhance")}>
                <span className="pi-icon"><IcEnhance size={16} /></span>
                <span className="pi-text">
                  <span className="pi-label">高清增强</span>
                  <span className="pi-desc">云端重绘式放大提清，就地写回</span>
                </span>
              </button>
              <button className="pop-item" onClick={() => { close(); useBoard.getState().spawnEdit(id, "enhanceLocal"); }}>
                <span className="pi-icon"><IcUpscale size={16} /></span>
                <span className="pi-text">
                  <span className="pi-label">超清放大</span>
                  <span className="pi-desc">本地 GPU 多模型超分 4K/8K，非破坏（新建节点，结果入资产库）</span>
                </span>
              </button>
              <button className="pop-item" onClick={() => { close(); useBoard.getState().spawnEdit(id, "vectorize"); }}>
                <span className="pi-icon"><IcVector size={16} /></span>
                <span className="pi-text">
                  <span className="pi-label">智能矢量</span>
                  <span className="pi-desc">本地 VTracer 位图转 SVG（Logo/打卡框/文化墙），可导出 AI/CDR</span>
                </span>
              </button>
              <button className="pop-item" onClick={()=>{close();useBoard.getState().spawnEdit(id,"vectorize");const n=useBoard.getState().nodes.find(n=>n.selected&&n.type==="vectorize");if(n)useBoard.getState().updateData(n.id,{preset:"flat",flatColors:12,quality:"high-fidelity",filterSpeckle:1});}}>
                <span className="pi-icon"><IcVector size={16}/></span><span className="pi-text"><span className="pi-label">平面拆件清理与矢量</span><span className="pi-desc">整理色块 → 矢量路径 → 高清 PNG / 矢量 PDF</span></span>
              </button>
              <button className="pop-item" onClick={() => setView("outpaint")}>
                <span className="pi-icon"><IcExpand size={16} /></span>
                <span className="pi-text">
                  <span className="pi-label">扩图</span>
                  <span className="pi-desc">向四周延展画面，就地写回</span>
                </span>
              </button>
              <button className="pop-item" onClick={() => setView("resize")}>
                <span className="pi-icon"><IcResize size={16} /></span>
                <span className="pi-text">
                  <span className="pi-label">尺寸调整</span>
                  <span className="pi-desc">本地重采样像素，就地写回</span>
                </span>
              </button>
            </div>
          ) : view === "enhance" ? (
            <EnhanceCard id={id} onBack={() => setView("menu")} onDone={close} />
          ) : view === "outpaint" ? (
            <OutpaintCard id={id} onBack={() => setView("menu")} onDone={close} />
          ) : view === "gridAI" ? (
            <AiPresetMenu id={id} onDone={close} />
          ) : view === "elemRedraw" ? (
            <ElemRedrawCard id={id} onBack={() => setView("menu")} onDone={close} />
          ) : view === "elemText" ? (
            <ElemTextCard id={id} orig={elemMeta?.text ?? ""} onBack={() => setView("menu")} onDone={close} />
          ) : (
            <ResizeCard id={id} onBack={() => setView("menu")} onDone={close} />
          )}
        </PopLayer>
      ) : null}
    </div>
  );
}

/** 参数卡头部：返回箭头 + 标题 */
function CardHead({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="pop-title gd-more-head">
      <button className="icon-btn" title="返回" onClick={onBack}>
        <IcArrowL size={13} />
      </button>
      {title}
    </div>
  );
}

/** 运行按钮（带 running 态） */
function RunBtn({ id, label, onRun }: { id: string; label: string; onRun: () => void }) {
  const running = useBoard((s) => s.nodes.find((n) => n.id === id)?.data.status === "running");
  return (
    <button className="btn primary" disabled={!!running} style={{ opacity: running ? 0.6 : 1 }} onClick={onRun}>
      {running ? <IcLoading size={15} /> : <IcCheck size={15} />}
      {running ? "处理中…" : label}
    </button>
  );
}

/* ---------- 高清增强 ---------- */
function EnhanceCard({ id, onBack, onDone }: { id: string; onBack: () => void; onDone: () => void }) {
  const [factor, setFactor] = useState(2);
  const [focus, setFocus] = useState<"detail" | "face" | "none" | "flat">("detail");
  return (
    <>
      <CardHead title="高清增强" onBack={onBack} />
      <div className="gp-sec-title">放大倍率</div>
      <div className="gp-seg">
        {[2, 4].map((f) => (
          <button key={f} className={factor === f ? "on" : ""} onClick={() => setFactor(f)}>
            {f}×
          </button>
        ))}
      </div>
      <div className="gp-sec-title">
        增强侧重<span className="gp-hint">重绘式增强（绘画模型）；更专业的放大可接 ComfyUI 节点</span>
      </div>
      <div className="gp-seg">
        {([["flat", "平面拆件清理"], ["detail", "细节纹理"], ["face", "人物面部"], ["none", "纯放大"]] as const).map(([v, lab]) => (
          <button key={v} className={focus === v ? "on" : ""} onClick={() => setFocus(v)}>
            {lab}
          </button>
        ))}
      </div>
      <RunBtn
        id={id}
        label={`增强并写回（${factor}×）`}
        onRun={() => {
          onDone();
          void applyEnhance(id, { factor, focus });
        }}
      />
    </>
  );
}

/* ---------- 扩图 ---------- */
const OP_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16"];

function OutpaintCard({ id, onBack, onDone }: { id: string; onBack: () => void; onDone: () => void }) {
  const [pads, setPads] = useState<OutpaintPads>({ left: 0.25, right: 0.25, up: 0, down: 0 });
  const [prompt, setPrompt] = useState("");
  const [channel, setChannel] = useState<EditChannel>("auto");
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    let on = true;
    const src = nodeMainImage(useBoard.getState().nodes.find((n) => n.id === id));
    if (src) void imageDims(src).then((d) => on && d && setDims(d));
    return () => {
      on = false;
    };
  }, [id]);

  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const round2 = (v: number) => Math.round(v * 100) / 100;
  /** 按目标比例居中外扩（只扩不裁） */
  const applyRatio = (r: string) => {
    if (!dims) return;
    const [a, b] = r.split(":").map(Number);
    const target = a / b;
    const cur = dims.w / dims.h;
    if (target > cur * 1.001) {
      const pad = clamp((dims.h * target - dims.w) / 2 / dims.w);
      setPads({ left: round2(pad), right: round2(pad), up: 0, down: 0 });
    } else if (target < cur * 0.999) {
      const pad = clamp((dims.w / target - dims.h) / 2 / dims.h);
      setPads({ up: round2(pad), down: round2(pad), left: 0, right: 0 });
    } else {
      setPads({ left: 0, right: 0, up: 0, down: 0 });
    }
  };
  const outW = dims ? Math.round(dims.w * (1 + pads.left + pads.right)) : 0;
  const outH = dims ? Math.round(dims.h * (1 + pads.up + pads.down)) : 0;
  const changed = pads.left + pads.right + pads.up + pads.down > 0;

  return (
    <>
      <CardHead title="扩图" onBack={onBack} />
      <div className="gp-sec-title">
        快捷比例<span className="gp-hint">按目标比例居中外扩（只扩不裁）</span>
      </div>
      <div className="gp-seg">
        {OP_RATIOS.map((r) => (
          <button key={r} title={`居中外扩到 ${r}`} onClick={() => applyRatio(r)}>
            {r}
          </button>
        ))}
      </div>
      <div className="gp-sec-title">
        各边幅度<span className="gp-hint">{dims ? `输出 ${outW} × ${outH}` : "读取原图尺寸中…"}</span>
      </div>
      {([["left", "左"], ["right", "右"], ["up", "上"], ["down", "下"]] as const).map(([side, lab]) => (
        <label key={side} className="ne-slider nodrag">
          <span>{lab}</span>
          <input
            type="range"
            className="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(pads[side] * 100)}
            onChange={(e) => setPads((p) => ({ ...p, [side]: Number(e.target.value) / 100 }))}
          />
          <b>{Math.round(pads[side] * 100)}%</b>
        </label>
      ))}
      <input
        className="input nodrag"
        placeholder="扩展区域想要什么（留空 = 自然延伸）"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <PopSelect
        title="模型通道"
        value={channel}
        options={[
          { value: "auto", label: "自动", desc: "GPT 系走真蒙版，其余走指令式" },
          { value: "mask", label: "真蒙版", desc: "images/edits mask 参数，需中转站如实转发" },
          { value: "instruct", label: "指令式", desc: "原图 + 红色标注图，兼容性最好" },
        ]}
        onChange={(v) => setChannel(v as EditChannel)}
      />
      <RunBtn
        id={id}
        label="扩图并写回"
        onRun={() => {
          if (!changed) {
            toast("请先选择扩展方向与幅度（至少一边大于 0）", "err");
            return;
          }
          onDone();
          void applyOutpaint(id, pads, prompt, channel);
        }}
      />
    </>
  );
}

/* ---------- 尺寸调整 ---------- */
/* ---------- 元素重绘：透明图层 → 铺白底图生图 → 色键抠回透明 ---------- */
function ElemRedrawCard({ id, onBack, onDone }: { id: string; onBack: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  return (
    <>
      <CardHead title="元素重绘" onBack={onBack} />
      <textarea
        className="textarea nodrag nowheel"
        rows={3}
        placeholder="描述要怎么改（留空 = 保持原样提升质量），如：换成红色外套、帽子改成贝雷帽"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="gp-foot">重绘后自动抠回透明底写回本图层（Ctrl+Z 可撤销）；使用图像角色默认模型，计费。</div>
      <RunBtn
        id={id}
        label="重绘元素"
        onRun={() => {
          onDone();
          void redrawElementImage(id, text);
        }}
      />
    </>
  );
}

/* ---------- 改字：文字图层换内容，保字体风格 ---------- */
function ElemTextCard({ id, orig, onBack, onDone }: { id: string; orig: string; onBack: () => void; onDone: () => void }) {
  const [text, setText] = useState("");
  return (
    <>
      <CardHead title="改字" onBack={onBack} />
      <div className="gp-sec-title">
        原文<span className="gp-hint">{orig ? `「${orig}」` : "（未识别出原文）"}</span>
      </div>
      <textarea
        className="textarea nodrag nowheel"
        rows={2}
        placeholder="输入替换成的新文字"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="gp-foot">保持原字体、颜色与质感，只换文字内容；改完仍抠回透明图层。</div>
      <RunBtn
        id={id}
        label="替换文字"
        onRun={() => {
          onDone();
          void retouchElementText(id, text);
        }}
      />
    </>
  );
}

/* ================= 会话条：宫格切分（图上拖线调格 + 勾选宫格 → 拆出 / 分镜组） ================= */

function GridSplitBar({ id }: { id: string }) {
  const me = useUi((s) => s.mediaEdit);
  const patch = useUi((s) => s.patchMediaEdit);
  const close = useUi((s) => s.closeMediaEdit);
  const [specOpen, setSpecOpen] = useState(false);
  const specRef = useRef<HTMLDivElement>(null);
  // 自定义宫格悬停选格器（1-5 行 × 1-5 列）
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  if (!me) return null;
  const rows = me.gridYs.length + 1;
  const cols = me.gridXs.length + 1;
  const total = rows * cols;
  const uniform = rows === cols && [2, 3, 4, 5].includes(rows);
  const applyGrid = (nr: number, nc: number) =>
    patch({ gridRows: nr, gridCols: nc, gridXs: evenSplit(nc), gridYs: evenSplit(nr), gridPicked: [] });
  const pickedCount = me.gridPicked.length;
  return (
    <>
      <div ref={specRef} className="pop-wrap">
        <button className={`nt-btn ${specOpen ? "on" : ""}`} title="宫格规格：预设等分，或悬停选自定义行列（应用后仍可在图上拖动微调）" onClick={() => setSpecOpen((v) => !v)}>
          <IcGrid size={14} /> {uniform ? `${rows * rows}宫格（${rows}×${rows}）` : `自定义 ${rows}×${cols}`}
          <IcChevronD size={12} className="chev" />
        </button>
        {specOpen ? (
          <PopLayer anchorRef={specRef} onClose={() => setSpecOpen(false)} className="ne-pop gs-spec-pop">
            <div className="gs-spec">
              <div className="pop-list">
                {[2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    className={`pop-item ${uniform && rows === n ? "on" : ""}`}
                    onClick={() => {
                      applyGrid(n, n);
                      setSpecOpen(false);
                    }}
                  >
                    <span className="pi-icon"><IcGrid size={15} /></span>
                    <span className="pi-text">
                      <span className="pi-label">{n * n}宫格（{n}×{n}）</span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="gs-picker">
                <div className="gs-picker-t">自定义宫格</div>
                <div className="gs-picker-grid" onPointerLeave={() => setHover(null)}>
                  {Array.from({ length: 25 }, (_, k) => {
                    const r = Math.floor(k / 5);
                    const c = k % 5;
                    const on = !!hover && r <= hover.r && c <= hover.c;
                    return (
                      <button
                        key={k}
                        className={`gs-pick-cell ${on ? "on" : ""}`}
                        aria-label={`${r + 1} 行 ${c + 1} 列`}
                        onPointerEnter={() => setHover({ r, c })}
                        onClick={() => {
                          applyGrid(hover ? hover.r + 1 : 3, hover ? hover.c + 1 : 3);
                          setSpecOpen(false);
                        }}
                      />
                    );
                  })}
                </div>
                <div className="gs-picker-n">{hover ? `${hover.r + 1} 行 × ${hover.c + 1} 列 · 点击应用` : "悬停选行列（1-5）"}</div>
              </div>
            </div>
          </PopLayer>
        ) : null}
      </div>
      <button className="nt-btn" title="切割线恢复等分（保留已勾选的格子）" onClick={() => patch({ gridXs: evenSplit(cols), gridYs: evenSplit(rows) })}>
        <IcUndo size={13} /> 重置均分
      </button>
      <button className="nt-btn" title="按原图行列顺序全选，建立无缝整体；不裁掉任何内容" onClick={() => { close(); void createStoryboardGroup(id, Array.from({ length: total }, (_, i) => `${Math.floor(i / cols)}-${i % cols}`), me.gridXs, me.gridYs); }}>
        <IcGrid size={14} /> 整图无缝拆组
      </button>
      <span className="nt-label" title="在图上点击格子按点击顺序勾选（再点取消）">
        已选 {pickedCount}/{total}
      </span>
      <button className="nt-btn" title="退出切分（Esc）" onClick={close}>
        <IcClose size={13} />
      </button>
      <button
        className="nt-btn"
        title={`按当前切割线拆出全部 ${total} 格（阅读序摆在原图下方）`}
        onClick={() => {
          close();
          void applyGridSplitFractional(id, me.gridXs, me.gridYs);
        }}
      >
        <IcCrop size={14} /> 全部拆出
      </button>
      <button
        className="nt-btn primary"
        title="把勾选的格子按点击顺序包成一个无边框分镜组（整组可拖动，每片与原图连线）"
        disabled={!pickedCount}
        style={{ opacity: pickedCount ? 1 : 0.5 }}
        onClick={() => {
          close();
          void createStoryboardGroup(id, me.gridPicked, me.gridXs, me.gridYs);
        }}
      >
        <IcCheck size={14} /> 创建分镜组{pickedCount ? `（${pickedCount}）` : ""}
      </button>
    </>
  );
}

/* ================= 参数卡：AI 模板（分类大面板 → 铺生成节点，LibTV「九宫格 ▾」同款动线） ================= */

function aiPresetIcon(p: AiPreset) {
  switch (p.id) {
    case "ai-after3":
    case "ai-before5":
      return <IcTimer size={15} />;
    case "ai-portrait":
      return <IcPerson size={15} />;
    case "ai-cinema":
      return <IcEnhance size={15} />;
    case "ai-pano":
      return <IcOrbit size={15} />;
    case "ai-face3":
      return <IcScan size={15} />;
    case "ai-char3":
      return <IcPose size={15} />;
    case "ai-char-sheet":
      return <IcIdCard size={15} />;
    case "ai-scene-sheet":
      return <IcImage size={15} />;
    case "ai-product-sheet":
      return <IcBox size={15} />;
    default:
      return <IcGrid size={15} />;
  }
}

function AiPresetMenu({ id, onDone }: { id: string; onDone: () => void }) {
  const pick = (p: AiPreset) => {
    const upstreamText = collectUpstreamParts(id)
      .filter((x) => x.kind === "text")
      .map((x) => x.value)
      .join("\n")
      .trim();
    const nid = spawnAiPresetNode(id, p, upstreamText);
    onDone();
    if (nid)
      toast(
        p.kind === "grid"
          ? `已铺「${p.label}」生成节点：可补场景描述后点生成；出图后「编辑 → 宫格切分」勾选创建分镜组`
          : `已铺「${p.label}」生成节点：可直接生成，也可先补场景描述`,
        "ok",
      );
  };
  return (
    <div className="ai-menu" role="group" aria-label="AI 模板分类">
      {AI_PRESET_GROUPS.map((group) => (
        <div key={group} className="ai-col">
          <div className="ai-col-t">{group}</div>
          {AI_PRESETS.filter((p) => p.group === group).map((p) => (
            <button key={p.id} className="ai-item" title={p.desc} onClick={() => pick(p)}>
              <span className="ai-ic">{aiPresetIcon(p)}</span>
              <span className="ai-label">{p.label}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function ResizeCard({ id, onBack, onDone }: { id: string; onBack: () => void; onDone: () => void }) {
  const [params, setParams] = useState<ResizeParams>({ mode: "mp", mp: 1, sideRef: "long", sideLen: 1024, scalePct: 50 });
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    let on = true;
    const src = nodeMainImage(useBoard.getState().nodes.find((n) => n.id === id));
    if (src) void imageDims(src).then((d) => on && d && setDims(d));
    return () => {
      on = false;
    };
  }, [id]);
  const patch = (p: Partial<ResizeParams>) => setParams((v) => ({ ...v, ...p }));
  return (
    <>
      <CardHead title="尺寸调整" onBack={onBack} />
      <div className="gp-sec-title">
        方式<span className="gp-hint">{dims ? `原图 ${dims.w}×${dims.h}` : ""} · 本地重采样，不调模型</span>
      </div>
      <div className="gp-seg">
        {([["mp", "总像素"], ["side", "边长"], ["scale", "倍率"]] as const).map(([v, lab]) => (
          <button key={v} className={params.mode === v ? "on" : ""} onClick={() => patch({ mode: v })}>
            {lab}
          </button>
        ))}
      </div>
      {params.mode === "mp" ? (
        <label className="ne-slider nodrag" title="目标总像素（百万）">
          <span>像素</span>
          <input type="range" className="range" min={1} max={40} step={1} value={Math.round(params.mp * 10)} onChange={(e) => patch({ mp: Number(e.target.value) / 10 })} />
          <b>{params.mp.toFixed(1)}M</b>
        </label>
      ) : params.mode === "side" ? (
        <div className="ne-inline nodrag">
          <PopSelect
            value={params.sideRef}
            options={[
              { value: "long", label: "长边" },
              { value: "short", label: "短边" },
              { value: "width", label: "宽" },
              { value: "height", label: "高" },
            ]}
            onChange={(v) => patch({ sideRef: v as ResizeParams["sideRef"] })}
          />
          <NumInput className="input" min={16} max={8192} value={params.sideLen} onCommit={(n) => patch({ sideLen: n })} />
        </div>
      ) : (
        <label className="ne-slider nodrag" title="缩放百分比（100 = 原尺寸）">
          <span>倍率</span>
          <input type="range" className="range" min={10} max={400} step={5} value={params.scalePct} onChange={(e) => patch({ scalePct: Number(e.target.value) })} />
          <b>{params.scalePct}%</b>
        </label>
      )}
      <RunBtn
        id={id}
        label="重采样并写回"
        onRun={() => {
          onDone();
          void applyResize(id, params);
        }}
      />
    </>
  );
}

/* ================= 会话条：聚焦裁剪（图上框选时替换工具条内容） ================= */

const CROP_ASPECTS: [string, string][] = [
  ["free", "自由"],
  ["1:1", "1:1"],
  ["3:2", "3:2"],
  ["2:3", "2:3"],
  ["4:3", "4:3"],
  ["3:4", "3:4"],
  ["16:9", "16:9"],
  ["9:16", "9:16"],
];

function CropBar({ id }: { id: string }) {
  const me = useUi((s) => s.mediaEdit);
  const patch = useUi((s) => s.patchMediaEdit);
  const close = useUi((s) => s.closeMediaEdit);
  if (!me) return null;
  return (
    <>
      <span className="nt-label">
        <IcCrop size={13} /> 框选裁剪
      </span>
      <PopSelect
        title="裁剪比例"
        value={me.aspect}
        options={CROP_ASPECTS.map(([v, lab]) => ({ value: v, label: lab }))}
        onChange={(v) => patch({ aspect: v, rect: undefined })}
      />
      <button className="nt-btn" title="清除当前框选，重新拖拽" disabled={!me.rect} style={{ opacity: me.rect ? 1 : 0.45 }} onClick={() => patch({ rect: undefined })}>
        <IcUndo size={13} /> 重选
      </button>
      <button className="nt-btn" title="退出裁剪（Esc）" onClick={close}>
        <IcClose size={13} /> 取消
      </button>
      <button
        className="nt-btn primary"
        title="把框选区域裁出为一个新的图片节点"
        disabled={!me.rect}
        style={{ opacity: me.rect ? 1 : 0.45 }}
        onClick={() => me.rect && void applyCropToNewNode(id, me.rect)}
      >
        <IcCheck size={14} /> 裁剪输出
      </button>
    </>
  );
}

/* ================= 会话条：局部重绘（图上涂抹时替换工具条内容） ================= */

function InpaintBar({ id }: { id: string }) {
  const me = useUi((s) => s.mediaEdit);
  const patch = useUi((s) => s.patchMediaEdit);
  const close = useUi((s) => s.closeMediaEdit);
  const running = useBoard((s) => s.nodes.find((n) => n.id === id)?.data.status === "running");
  if (!me) return null;
  return (
    <>
      <span className="nt-label">
        <IcBrush size={13} /> 局部重绘
      </span>
      <span className="nt-seg">
        {([["brush", "涂抹"], ["rect", "框选"], ["eraser", "橡皮"]] as const).map(([v, lab]) => (
          <button key={v} className={me.tool === v ? "on" : ""} onClick={() => patch({ tool: v })}>
            {lab}
          </button>
        ))}
      </span>
      {me.tool !== "rect" ? (
        <span className="nt-brush" title="笔刷大小（原图像素）">
          <input type="range" className="range" min={8} max={180} step={4} value={me.brush} onChange={(e) => patch({ brush: Number(e.target.value) })} />
        </span>
      ) : null}
      <input
        className="input nt-prompt nodrag"
        placeholder="选区改成什么（留空 = 自然修复）"
        value={me.prompt}
        onChange={(e) => patch({ prompt: e.target.value })}
      />
      <PopSelect
        title="模型通道"
        value={me.channel}
        options={[
          { value: "auto", label: "自动", desc: "GPT 系走真蒙版，其余走指令式" },
          { value: "mask", label: "真蒙版", desc: "images/edits mask 参数" },
          { value: "instruct", label: "指令式", desc: "兼容性最好" },
        ]}
        onChange={(v) => patch({ channel: v as EditChannel })}
      />
      <button className="nt-btn" title="撤销一步涂抹" onClick={() => patch({ undoTick: me.undoTick + 1 })}>
        <IcUndo size={13} />
      </button>
      <button className="nt-btn" title="清空蒙版" onClick={() => patch({ clearTick: me.clearTick + 1 })}>
        <IcTrash size={13} />
      </button>
      <button className="nt-btn" title="退出重绘（Esc）" onClick={close}>
        <IcClose size={13} /> 取消
      </button>
      <button
        className="nt-btn primary"
        title="只重绘涂抹区域，结果写回本节点"
        disabled={!!running || !me.mask}
        style={{ opacity: running || !me.mask ? 0.5 : 1 }}
        onClick={() => void applyInpaint(id)}
      >
        {running ? <IcLoading size={13} /> : <IcCheck size={14} />}
        {running ? "重绘中" : "重绘"}
      </button>
    </>
  );
}

/* ================= 会话条：标记（图上彩色批注，确认后本地合成） ================= */

function MarkBar({ id }: { id: string }) {
  const me = useUi((s) => s.mediaEdit);
  const patch = useUi((s) => s.patchMediaEdit);
  const close = useUi((s) => s.closeMediaEdit);
  const running = useBoard((s) => s.nodes.find((n) => n.id === id)?.data.status === "running");
  if (!me) return null;
  const tools = [
    ["brush", "画笔"], ["point", "点位"], ["rect", "框选"], ["roundRect", "圆角框"], ["eraser", "橡皮"],
  ] as const;
  return (
    <>
      <span className="nt-label"><IcTag size={13} /> 标记</span>
      <span className="nt-seg" role="group" aria-label="标记工具">
        {tools.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={me.markTool === value ? "on" : ""}
            aria-pressed={me.markTool === value}
            onClick={() => patch({ markTool: value })}
          >
            {label}
          </button>
        ))}
      </span>
      <label className="nt-color" title="标记颜色">
        <span className="sr-only">标记颜色</span>
        <input type="color" value={me.markColor} onChange={(e) => patch({ markColor: e.target.value })} />
      </label>
      <label className="nt-brush" title="线条或点位大小（原图像素）">
        <span className="sr-only">标记粗细</span>
        <input type="range" className="range" min={4} max={180} step={2} value={me.brush} onChange={(e) => patch({ brush: Number(e.target.value) })} />
      </label>
      <label className="nt-opacity" title="标记透明度">
        <span>透明度</span>
        <input type="range" className="range" min={20} max={100} step={5} value={Math.round(me.markOpacity * 100)} onChange={(e) => patch({ markOpacity: Number(e.target.value) / 100 })} />
      </label>
      <button className="nt-btn" aria-label="撤销一步标记" title="撤销一步（Ctrl+Z）" onClick={() => patch({ undoTick: me.undoTick + 1 })}><IcUndo size={13} /></button>
      <button className="nt-btn" aria-label="清空标记" title="清空所有标记" onClick={() => patch({ clearTick: me.clearTick + 1 })}><IcTrash size={13} /></button>
      <button className="nt-btn" title="退出标记（Esc）" onClick={close}><IcClose size={13} /> 取消</button>
      <button
        className="nt-btn primary"
        title="把标记层与原图合成为 PNG，并就地写回当前节点"
        disabled={!!running || !me.mark}
        style={{ opacity: running || !me.mark ? 0.5 : 1 }}
        onClick={() => void applyMark(id)}
      >
        {running ? <IcLoading size={13} /> : <IcCheck size={14} />}
        {running ? "合成中" : "合并标记"}
      </button>
    </>
  );
}
