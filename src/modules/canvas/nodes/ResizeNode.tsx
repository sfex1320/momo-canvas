/**
 * 尺寸调整节点 — 真实重采样上游图片像素（非虚值）：
 *  总像素（MP）/ 单边定长 / 倍率 三种模式，可缩小也可放大；
 *  接入图片自动测量当前尺寸并推荐最接近的常用比例/分辨率；
 *  输出可切换：处理后的图片，或推荐比例/推荐分辨率/实际比例/实际分辨率文本
 *  （文本接生成图像节点时会自动替换其尺寸设置，不会混进提示词）
 */
import { memo, useEffect, useState } from "react";
import type { NodeProps } from "@xyflow/react";
import { NodeShell, PortImageIn, PortOut } from "../NodeShell";
import { IcLoading, IcResize } from "../../../ui/icons";
import { useBoard } from "../../../core/stores/boardStore";
import { useUi } from "../../../core/stores/uiStore";
import { collectUpstream, runFlow } from "../../../core/runner";
import { exactRatio, imageDims } from "../../../core/imageInfo";
import { recommendAspect, recommendRes, targetSize } from "../../../core/resizeMath";
import { Thumb } from "../../../ui/Thumb";
import type { ResizeData, ResizeMode, ResizeOut, ResizeSideRef } from "../../../core/types";

const MODES: { value: ResizeMode; label: string; desc: string }[] = [
  { value: "mp", label: "总像素", desc: "按目标总像素（百万）等比缩放" },
  { value: "side", label: "单边", desc: "指定某一边的长度，另一边按比例自动计算" },
  { value: "scale", label: "倍率", desc: "按百分比缩放，大于 100% 即放大" },
];

const SIDES: { value: ResizeSideRef; label: string }[] = [
  { value: "long", label: "最长边" },
  { value: "short", label: "最短边" },
  { value: "width", label: "宽" },
  { value: "height", label: "高" },
];

const MP_CHIPS = [0.5, 1, 2, 4];
const SIDE_CHIPS = [512, 768, 1024, 1536, 2048];
const SCALE_CHIPS = [25, 50, 75, 150, 200];

/** 数字输入：聚焦全选、可清空后重输（清空期间不回填占位值），失焦时才钳制提交 */
function NumInput({
  value,
  min,
  max,
  step,
  width = 76,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  width?: number;
  onCommit: (v: number) => void;
}) {
  const [txt, setTxt] = useState<string | null>(null); // null = 未在编辑，显示外部值
  const commit = (raw: string) => {
    const v = parseFloat(raw);
    if (Number.isFinite(v)) onCommit(Math.min(max, Math.max(min, v)));
  };
  return (
    <input
      className="input nodrag"
      type="number"
      step={step}
      min={min}
      max={max}
      style={{ width }}
      value={txt ?? String(value)}
      onFocus={(e) => {
        setTxt(String(value));
        e.target.select();
      }}
      onChange={(e) => {
        setTxt(e.target.value);
        commit(e.target.value);
      }}
      onBlur={() => {
        if (txt !== null) commit(txt);
        setTxt(null);
      }}
    />
  );
}

export const ResizeNode = memo(function ResizeNode({ id, data, selected }: NodeProps) {
  const d = data as ResizeData;
  const upd = useBoard((s) => s.updateData);
  const setLightbox = useUi((s) => s.setLightbox);
  const running = d.status === "running";
  // 第一张上游图（内容没变不会重渲染）
  const upSrc = useBoard(() => collectUpstream(id).images[0] ?? null);

  /* 接入/更换上游图时自动测量尺寸写回（推荐展示与文本输出都依赖它） */
  useEffect(() => {
    if (!upSrc) return;
    let on = true;
    void imageDims(upSrc).then((dm) => {
      if (on && dm && (dm.w !== d.srcW || dm.h !== d.srcH)) upd(id, { srcW: dm.w, srcH: dm.h });
    });
    return () => {
      on = false;
    };
  }, [upSrc, id, d.srcW, d.srcH, upd]);

  const sw = upSrc ? d.srcW : undefined;
  const sh = upSrc ? d.srcH : undefined;
  const tgt = sw && sh ? targetSize(d, sw, sh) : null;
  const rec = sw && sh ? recommendRes(sw, sh) : null;
  const out = d.out ?? "image";

  const setOut = (o: ResizeOut) => {
    if (o === out) return;
    // 图片 ↔ 文本切换会改变输出端口类型，需断开旧下游连线
    if ((o === "image") !== (out === "image")) {
      const s = useBoard.getState();
      const doomed = s.edges.filter((e) => e.source === id);
      if (doomed.length) s.onEdgesChange(doomed.map((e) => ({ type: "remove" as const, id: e.id })));
    }
    upd(id, { out: o });
  };

  const outOptions: { value: ResizeOut; label: string }[] = [
    { value: "image", label: "处理后的图片" },
    { value: "recAspect", label: `推荐比例${sw && sh ? ` · ${recommendAspect(sw, sh)}` : ""}` },
    { value: "recRes", label: `推荐分辨率${rec ? ` · ${rec.w}x${rec.h}` : ""}` },
    { value: "actAspect", label: `实际比例${sw && sh ? ` · ${exactRatio(sw, sh)}` : ""}` },
    { value: "actRes", label: `实际分辨率${sw && sh ? ` · ${sw}x${sh}` : ""}` },
  ];

  return (
    <NodeShell
      id={id}
      title="尺寸调整"
      icon={<IcResize size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={300}
    >
      <div className="mnode-body">
        {sw && sh ? (
          <div className="gen-sum nodrag" title="上游图片的实际尺寸与最接近的常用比例/分辨率">
            <IcResize size={13} />
            <span>
              原图 {sw}×{sh} · {exactRatio(sw, sh)} · {((sw * sh) / 1e6).toFixed(1)}MP
              {rec ? ` ｜ 推荐 ${recommendAspect(sw, sh)} / ${rec.w}×${rec.h}` : ""}
            </span>
          </div>
        ) : (
          <div className="gen-sum nodrag">
            <IcResize size={13} />
            <span>连接上游图片后自动测量尺寸，并推荐最接近的常用比例与像素</span>
          </div>
        )}

        <div className="lang-seg nodrag" style={{ alignSelf: "stretch", display: "flex" }}>
          {MODES.map((m) => (
            <button
              key={m.value}
              title={m.desc}
              style={{ flex: 1 }}
              className={d.mode === m.value ? "on" : ""}
              onClick={() => upd(id, { mode: m.value })}
            >
              {m.label}
            </button>
          ))}
        </div>

        {d.mode === "mp" ? (
          <>
            <div className="ctl-row nodrag" title="目标总像素（百万），按现有长宽比等比缩放">
              <span>目标</span>
              <NumInput value={d.mp} min={0.05} max={60} step={0.1} onCommit={(v) => upd(id, { mp: v })} />
              <span>MP</span>
            </div>
            <div className="ctl-row nodrag" style={{ flexWrap: "wrap", gap: 5 }}>
              {MP_CHIPS.map((v) => (
                <button key={v} className={`chip ${d.mp === v ? "on" : ""}`} onClick={() => upd(id, { mp: v })}>
                  {v}MP
                </button>
              ))}
            </div>
          </>
        ) : d.mode === "side" ? (
          <>
            <div className="ctl-row nodrag" title="指定哪条边为参照，另一边按比例自动计算">
              <span>参照</span>
              <select
                className="select"
                style={{ flex: 1, minHeight: 32 }}
                value={d.sideRef}
                onChange={(e) => upd(id, { sideRef: e.target.value as ResizeSideRef })}
              >
                {SIDES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <NumInput value={d.sideLen} min={16} max={8192} step={16} width={82} onCommit={(v) => upd(id, { sideLen: v })} />
              <span>px</span>
            </div>
            <div className="ctl-row nodrag" style={{ flexWrap: "wrap", gap: 5 }}>
              {SIDE_CHIPS.map((v) => (
                <button key={v} className={`chip ${d.sideLen === v ? "on" : ""}`} onClick={() => upd(id, { sideLen: v })}>
                  {v}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="ctl-row nodrag" title="按百分比缩放：小于 100% 缩小，大于 100% 放大">
              <span>倍率</span>
              <NumInput value={d.scalePct} min={1} max={800} step={5} onCommit={(v) => upd(id, { scalePct: v })} />
              <span>%</span>
            </div>
            <div className="ctl-row nodrag" style={{ flexWrap: "wrap", gap: 5 }}>
              {SCALE_CHIPS.map((v) => (
                <button key={v} className={`chip ${d.scalePct === v ? "on" : ""}`} onClick={() => upd(id, { scalePct: v })}>
                  {v}%
                </button>
              ))}
            </div>
          </>
        )}

        {tgt ? (
          <div className="gen-sum nodrag">
            <span>
              → 输出 {tgt.w}×{tgt.h}（{((tgt.w * tgt.h) / 1e6).toFixed(2)}MP
              {sw && sh && tgt.w * tgt.h < sw * sh ? "，缩小" : sw && sh && tgt.w * tgt.h > sw * sh ? "，放大" : ""}）
            </span>
          </div>
        ) : null}

        <div className="ctl-row nodrag" title="输出图片，或输出尺寸文本（接生成图像节点会自动替换其尺寸设置）">
          <span>输出</span>
          <select className="select" style={{ flex: 1, minHeight: 32 }} value={out} onChange={(e) => setOut(e.target.value as ResizeOut)}>
            {outOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <button
          className="btn primary nodrag"
          disabled={running || (out !== "image" && !!sw)}
          title={out !== "image" && sw ? "尺寸文本已就绪，从输出端口接给生成节点即可" : undefined}
          onClick={() => void runFlow(id)}
        >
          {running ? <IcLoading size={17} /> : <IcResize size={17} />}
          {running ? "处理中…" : out === "image" ? "处理图片" : sw ? "尺寸已就绪" : "读取上游尺寸"}
        </button>

        {out === "image" && d.result ? (
          <>
            <Thumb className="img-main nodrag" src={d.result} alt="" res onClick={() => setLightbox(d.result!)} />
            {d.outW && d.outH && sw && sh ? (
              <div className="gen-sum nodrag">
                <span>
                  {sw}×{sh} → {d.outW}×{d.outH} · 约 {(((d.result.length * 3) / 4) / 1024 / 1024).toFixed(2)}MB
                </span>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      <PortImageIn top={26} />
      <PortOut kind={out === "image" ? "image" : "text"} />
    </NodeShell>
  );
});
