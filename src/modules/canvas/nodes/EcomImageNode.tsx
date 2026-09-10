/**
 * 电商长图节点（紧凑版）— 节点本体留状态 + 两个按钮。
 * 切片工作台只管切片操作（编辑提示词 / 拖拽调序 / 参考图缩略 / 逐片重生成）+ 拼接长图（默认不自动拼）。
 * 生成设置（模式 / 模型 / 比例 / 切片数 / 风格 / 种子 / 文案 / 参考图上传）全部在画布底部生成栏。
 * 两种模式：product / h5。
 */
import { memo, useState } from "react";
import { PromptAiTools } from "../../../ui/PromptAiTools";
import { createPortal } from "react-dom";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, OutModeToggle, PortIn, PortOut } from "../NodeShell";
import { Modal } from "../../../ui/kit";
import { PopSelect } from "../../../ui/PopSelect";
import { IcDownload, IcEcom, IcLayers, IcLoading, IcRefresh, IcScan, IcSparkles } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { toast, useUi } from "../../../core/stores/uiStore";
import { analyzeEcom, generateEcom, regenEcomSlide, reorderEcomSlides, stitchEcomResult } from "../../../core/runner";
import { resolveModelCard, useSettings } from "../../../core/stores/settingsStore";
import { saveImageAs } from "../../../core/services/imageSaver";
import { errMsg } from "../../../core/utils";
import { Thumb } from "../../../ui/Thumb";
import { useOwnUpstreamImageRefs } from "../../../ui/AtTextArea";
import type { EcomImageData } from "../../../core/types";

/** 切片工作台：左栏生成+拼接+最终长图，右栏切片网格（编辑提示词 / 拖拽排序 / 参考图缩略 / 逐片重生成） */
export function EcomWorkshop({ id, d, onClose }: { id: string; d: EcomImageData; onClose: () => void }) {
  const setLightbox = useUi((s) => s.setLightbox);
  const upd = useBoard((s) => s.updateData);
  const slides = d.slides ?? [];
  const running = d.status === "running";
  const [cols, setCols] = useState(4);
  const [reversed, setReversed] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const hasImgs = slides.some((s) => s.img);

  const setPrompt = (i: number, prompt: string) => {
    const next = [...slides];
    next[i] = { ...next[i], prompt };
    upd(id, { slides: next });
  };

  // @引用：上游图 chips 点击插入到「最近点过的切片」提示词，作该片风格参考
  const upstreamRefs = useOwnUpstreamImageRefs(id);
  const [focusedSlide, setFocusedSlide] = useState(0);
  const insertRef = (label: string) => {
    setPrompt(focusedSlide, `${slides[focusedSlide]?.prompt ?? ""} @${label}`);
  };

  const save = async () => {
    if (!d.result) return;
    try {
      let model: string | undefined;
      try {
        model = resolveModelCard("image", d.imageModelId).model;
      } catch {
        /* 仅影响文件名 */
      }
      const p = await saveImageAs(d.result, useSettings.getState().settings.save, { prompt: d.analysis?.product.name ?? "电商长图", model });
      if (p) toast(`已保存 → ${p}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  // 反向查看只翻转展示顺序，携带原索引保证回调仍作用于正确切片
  const view = slides.map((s, i) => ({ s, i }));
  if (reversed) view.reverse();

  return (
    <Modal title={`切片工作台${d.analysis?.product.name ? " · " + d.analysis.product.name : ""}`} onClose={onClose} width={1240}>
      <div className="ecom-ws">
        {/* 左栏：生成 + 拼接 + 最终长图 */}
        <aside className="ecom-ws-side">
          <div className="gp-sec-title">生成</div>
          <button className="btn primary" disabled={running || !slides.length} onClick={() => void generateEcom(id)}>
            <IcSparkles size={15} /> 生成切片
          </button>
          <button
            className="btn"
            disabled={running || !hasImgs}
            title={d.result ? "按当前切片顺序重新拼接长图" : "把已生成的切片纵向拼成完整长图"}
            onClick={() => void stitchEcomResult(id)}
          >
            <IcLayers size={15} /> {d.result ? "重新拼接" : "拼接长图"}
          </button>
          {running && d.progress ? <div className="ecom-ws-progress">{d.progress}</div> : null}
          {d.result ? (
            <button className="btn" onClick={save}>
              <IcDownload size={15} /> 保存长图
            </button>
          ) : null}

          <div className="gp-sec-title" style={{ marginTop: 16 }}>
            最终长图
          </div>
          {d.result ? (
            <div className="ecom-ws-final">
              <Thumb className="ecom-ws-final-thumb" src={d.result} alt="" onClick={() => setLightbox(d.result!)} />
              <button className="btn sm" onClick={() => setLightbox(d.result!)}>
                <IcScan size={14} /> 放大查看
              </button>
            </div>
          ) : (
            <div className="hint">{hasImgs ? "切片已生成，点上方「拼接长图」合成完整长图（默认不自动拼）。" : "生成切片并点「拼接长图」后在此预览。"}</div>
          )}
        </aside>

        {/* 右栏：工具栏 + 切片网格 */}
        <div className="ecom-ws-main">
          <div className="ecom-ws-toolbar">
            <div className="ecom-ws-note">切片（{slides.length}）· 拖动卡片调整顺序 = 长图从上到下拼接顺序</div>
            <div className="ecom-ws-tools nodrag">
              <span className="ecom-ws-tool-label">每行</span>
              <PopSelect
                value={String(cols)}
                options={[3, 4, 5, 6].map((n) => ({ value: String(n), label: `${n} 列` }))}
                onChange={(v) => setCols(Number(v))}
                style={{ width: 80 }}
              />
              <button className={`btn sm ${reversed ? "primary" : ""}`} title="仅翻转查看顺序，不影响拼接" onClick={() => setReversed((v) => !v)}>
                反向
              </button>
            </div>
          </div>

          {upstreamRefs.length ? (
            <div className="ecom-ws-refchips nodrag">
              <span className="ecom-ws-refhint">参考图 · 点一下插到当前切片提示词（@引用，作该片风格参考）</span>
              <div className="ecom-ws-reflist">
                {upstreamRefs.map((r) => (
                  <button key={r.label} className="ecom-ws-refchip" title={`插入 @${r.label} 到当前切片`} onClick={() => insertRef(r.label)}>
                    <Thumb src={r.src} alt="" />
                    <span>{r.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {slides.length === 0 ? (
            <div className="hint">还没有切片：点节点上的「分析并规划」生成切片脚本。</div>
          ) : (
            <div className={`ecom-grid ${running ? "busy" : ""}`} style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${Math.max(180, 850 / cols)}px), 1fr))` }}>
              {view.map(({ s, i }) => (
                <div
                  key={i}
                  className={`ecom-card ${dragIdx === i ? "dragging" : ""} ${overIdx === i ? "drag-over" : ""}`}
                  draggable={!running}
                  onPointerDown={() => setFocusedSlide(i)}
                  onDragStart={(e) => {
                    const t = e.target as HTMLElement;
                    if (t.closest("textarea, input, button")) {
                      e.preventDefault();
                      return;
                    }
                    e.dataTransfer.setData("text/plain", String(i));
                    e.dataTransfer.effectAllowed = "move";
                    setDragIdx(i);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setOverIdx(i);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                      setOverIdx((v) => (v === i ? null : v));
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragIdx != null && dragIdx !== i) void reorderEcomSlides(id, dragIdx, i);
                    setDragIdx(null);
                    setOverIdx(null);
                  }}
                  onDragEnd={() => {
                    setDragIdx(null);
                    setOverIdx(null);
                  }}
                >
                  <div className="ecom-card-img">
                    {s.img ? (
                      <Thumb className="ecom-card-thumb" src={s.img} alt="" onClick={() => setLightbox(s.img!)} />
                    ) : (
                      <div className="ecom-card-empty">待生成</div>
                    )}
                    <span className="ecom-card-no">{String(i + 1).padStart(2, "0")}</span>
                  </div>
                  <div className="ecom-card-title" title={s.title}>
                    {s.title}
                  </div>
                  <p className="ecom-card-summary">{s.prompt || "尚未填写提示词"}</p>
                  <PromptAiTools value={s.prompt ?? ""} image={s.img ?? upstreamRefs[0]?.src} onApply={text => setPrompt(i, text)}/>
                  {s.copy ? (
                    <div className="ecom-card-copy" title={s.copy}>
                      {s.copy}
                    </div>
                  ) : null}
                  <div className="ecom-card-acts nodrag">
                    <span className="ecom-card-refs" title="本片生成时使用的参考图">
                      {(s.refs ?? []).length
                        ? (s.refs ?? []).map((r, k) => <Thumb key={r + ":" + k} className="ecom-card-ref" src={r} alt="" onClick={() => setLightbox(r)} />)
                        : <span className="ecom-card-refs-none">参考图</span>}
                    </span>
                    <button
                      className="icon-btn"
                      disabled={running || !s.prompt}
                      title="重新生成本切片（按当前参考图与风格）"
                      aria-label="重新生成本切片（按当前参考图与风格）"
                      onClick={() => void regenEcomSlide(id, i)}
                    >
                      <IcRefresh size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export const EcomImageNode = memo(function EcomImageNode({ id, data, selected }: NodeProps) {
  const d = data as EcomImageData;
  const setLightbox = useUi((s) => s.setLightbox);
  const upd = useBoard((s) => s.updateData);
  const running = d.status === "running";
  const mode = d.outMode ?? "image";
  const workMode = d.mode ?? "product";
  const a = d.analysis;
  const slides = d.slides ?? [];
  const [workshop, setWorkshop] = useState(false);

  const reset = () => upd(id, { analysis: undefined, slides: [], result: undefined, assetGroupId: undefined, status: "idle", error: undefined });

  const save = async () => {
    if (!d.result) return;
    try {
      let model: string | undefined;
      try {
        model = resolveModelCard("image", d.imageModelId).model;
      } catch {
        /* 仅影响文件名 */
      }
      const p = await saveImageAs(d.result, useSettings.getState().settings.save, { prompt: a?.product.name ?? "电商长图", model });
      if (p) toast(`已保存 → ${p}`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  const modeLabel = workMode === "h5" ? "H5 长文" : "产品图";
  const hasResult = !!d.result;
  const hasImgs = slides.some((s) => s.img);

  return (
    <NodeShell
      id={id}
      title={a?.product.name ? `电商长图 · ${a.product.name}` : "电商长图"}
      icon={<IcEcom size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={300}
      headExtra={
        <span className="acts nodrag">
          <OutModeToggle id={id} mode={mode} />
          {a ? (
            <button className="icon-btn" title="清空分析与产出，重新规划" aria-label="清空分析与产出，重新规划" onClick={reset}>
              <IcRefresh size={15} />
            </button>
          ) : null}
          {hasResult ? (
            <>
              <button className="nt-btn" title="放大预览长图" onClick={() => setLightbox(d.result!)}>
                <IcScan size={14} /> 放大
              </button>
              <button className="nt-btn" title="保存长图到本地" onClick={save}>
                <IcDownload size={14} /> 保存
              </button>
            </>
          ) : null}
        </span>
      }
    >
      <div className="mnode-body">
        <div className="ecom-mode-tag">
          <IcEcom size={13} /> {modeLabel}模式
        </div>

        {a ? (
          <div className="ecom-status">
            已规划 <b>{slides.length}</b> 切片{hasResult ? " · 长图已生成" : hasImgs ? " · 切片已生成" : ""}
          </div>
        ) : (
          <div className="node-hint">
            {workMode === "h5"
              ? "在底部「文案」里粘长文案，点「分析并规划」自动切片；确认提示词后「生成长图」"
              : "连接产品图，点「分析并规划」产出切片；确认提示词后「生成长图」"}
          </div>
        )}

        <button className="btn nodrag" disabled={!slides.length && !a} onClick={() => setWorkshop(true)} title="编辑提示词 / 调顺序 / 逐片重生成 / 拼接长图">
          <IcLayers size={15} /> 切片工作台{slides.length ? `（${slides.length}）` : ""}
        </button>

        <button className="btn primary nodrag" disabled={running} onClick={() => void (a ? generateEcom(id) : analyzeEcom(id))}>
          {running ? <IcLoading size={17} /> : <IcSparkles size={17} />}
          {running ? "运行中…" : a ? "生成长图" : workMode === "h5" ? "切片并规划" : "分析并规划"}
        </button>
        {running && d.progress ? (
          <div className="progress-line">
            <IcLoading size={14} />
            {d.progress}
          </div>
        ) : null}
      </div>
      <PortIn />
      <PortOut kind={mode === "prompt" ? "text" : "image"} />

      {workshop ? createPortal(<EcomWorkshop id={id} d={d} onClose={() => setWorkshop(false)} />, document.body) : null}
    </NodeShell>
  );
});
