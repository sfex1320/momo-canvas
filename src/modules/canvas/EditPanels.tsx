/**
 * 编辑类节点底部面板 — 与生成节点同款：单选「超清放大 / 智能矢量」节点时出现在画布下方。
 * 参数全部收进面板（节点本体只留预览/进度/空态）；选项图标用文字徽章 / 手绘图标，不再用彩色圆点。
 * 超清放大：目标 / 质量 / 格式 + 高级（内容模式·细节强度·Tile）；智能矢量：类型 + 参数弹卡 + 导出/入库。
 */
import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useBoard } from "../../core/stores/boardStore";
import { useAssets } from "../../core/stores/assetStore";
import { toast } from "../../core/stores/uiStore";
import { runFlow } from "../../core/runner";
import { estimateEnhanceResources } from "../../core/enhanceEstimate";
import { nodeMainImage } from "../../core/nodeEdit";
import { useImageDims } from "../../core/imageInfo";
import { useSettings } from "../../core/stores/settingsStore";
import { PopSelect } from "../../ui/PopSelect";
import { NodeParamsPop } from "../../ui/NodeParamsPop";
import { NumInput, Switch, TxBadge } from "../../ui/kit";
import {
  IcBrush,
  IcCheck,
  IcClose,
  IcContrast,
  IcDiamond,
  IcDownload,
  IcEdit,
  IcFilter,
  IcGear,
  IcIdCard,
  IcImage,
  IcLayers,
  IcLibrary,
  IcLoading,
  IcPalette,
  IcScissors,
  IcSparkles,
  IcUpscale,
  IcVector,
  IcZap,
} from "../../ui/icons";
import { errMsg, isTauri } from "../../core/utils";
import type { EnhanceLocalData, VectorizeData } from "../../core/types";

/** 单选某类型节点时返回其 id（否则 null），与 GenConfigPanel 同款选择器 */
function useSelId(kind: "enhanceLocal" | "vectorize"): string | null {
  return useBoard((s) => {
    const sel = s.nodes.filter((n) => n.selected);
    return sel.length === 1 && sel[0].type === kind ? sel[0].id : null;
  });
}

/** 参数弹卡 chip（统一复用 NodeParamsPop）：触发按钮 + 向上弹出的圆角参数卡 */
function ParamsPop({ icon, label, title, children }: { icon?: ReactNode; label: string; title: string; children: ReactNode }) {
  return (
    <NodeParamsPop icon={icon} label={label} title={title} up>
      {children}
    </NodeParamsPop>
  );
}

/* ================= 超清放大 ================= */

const ENH_TARGET_OPTS = [
  { value: "4k", label: "4K", desc: "3840 长边", icon: <TxBadge t="4K" /> },
  { value: "8k", label: "8K", desc: "7680 长边", icon: <TxBadge t="8K" /> },
  { value: "16k", label: "16K 尺寸", desc: "15360 · 神经超分后插值扩展", icon: <TxBadge t="16K" /> },
  { value: "print", label: "印刷尺寸", desc: "mm × DPI 算像素（文化墙/展陈）", icon: <TxBadge t="mm" /> },
];
const ENH_PRESET_OPTS = [
  { value: "fast", label: "极速", desc: "SPAN 单模型 · 秒级出图", icon: <IcZap size={15} /> },
  { value: "balanced", label: "海报·文化墙", desc: "Nomos 保结构 · 手动开启细节融合", icon: <IcLayers size={15} /> },
  { value: "portrait", label: "人像", desc: "单主模型 + 人脸原貌保护", icon: <IcIdCard size={15} /> },
  { value: "professional", label: "印刷精修", desc: "保真融合 · 大重叠 · 无损后期", icon: <IcDiamond size={15} /> },
];
const ENH_FORMAT_OPTS = [
  { value: "png", label: "PNG", desc: "无损 · 默认", icon: <TxBadge t="PNG" /> },
  { value: "tiff", label: "TIFF", desc: "印刷工作流", icon: <TxBadge t="TIFF" wide /> },
  { value: "jpeg", label: "JPEG", desc: "有损 · 体积小", icon: <TxBadge t="JPEG" wide /> },
];
const ENH_CM_OPTS = [
  { value: "auto", label: "自动", desc: "均衡权重（通用）", icon: <IcSparkles size={15} /> },
  { value: "photo", label: "照片", desc: "低细节权重，保自然质感", icon: <IcImage size={15} /> },
  { value: "illustration", label: "插画", desc: "高细节权重，锐化线条", icon: <IcBrush size={15} /> },
  { value: "poster", label: "海报", desc: "中高权重，色块干净", icon: <IcLayers size={15} /> },
  { value: "portrait", label: "人像", desc: "最低权重，保肤质", icon: <IcIdCard size={15} /> },
];
const ENH_DEJPG_OPTS = [
  { value: "auto", label: "自动", desc: "压缩痕迹明显时才跑（默认）", icon: <IcSparkles size={15} /> },
  { value: "on", label: "强制开", desc: "每次都先跑 1x-DeJPG 去块", icon: <IcCheck size={15} /> },
  { value: "off", label: "关", desc: "不做去压缩预处理", icon: <IcClose size={15} /> },
];
const ENH_FACE_OPTS = [
  { value: "identity", label: "原貌保护", desc: "回注原图五官结构，不生成新细节（默认）", icon: <IcCheck size={15} /> },
  { value: "faceup", label: "FaceUpDAT", desc: "128–256px 人脸 ROI 增强 · 可能改变细节", icon: <IcIdCard size={15} /> },
  { value: "gfpgan", label: "GFPGAN", desc: "生成式小脸修复 · 340MB 按需下载", icon: <IcSparkles size={15} /> },
  { value: "codeformer", label: "CodeFormer", desc: "生成式小脸修复 · 377MB 按需下载", icon: <IcIdCard size={15} /> },
];

export function EnhanceConfigPanel() {
  const selId = useSelId("enhanceLocal");
  const node = useBoard((s) => (selId ? s.nodes.find((n) => n.id === selId) : undefined));
  const input = useBoard((s) => {
    if (!selId) return undefined;
    const edge = s.edges.find((e) => e.target === selId);
    return edge ? nodeMainImage(s.nodes.find((n) => n.id === edge.source)) : undefined;
  });
  const inputDims = useImageDims(input);
  const overlap = useSettings((s) => s.settings.enhance.tileOverlap);
  const upd = useBoard((s) => s.updateData);
  if (!selId || !node) return null;
  const d = node.data as EnhanceLocalData;
  const running = d.status === "running";
  const tObj = d.target as { mode?: "print"; wMm?: number; hMm?: number; dpi?: number };
  const isPrint = typeof d.target !== "string" && tObj.mode === "print";
  const print = isPrint ? { wMm: tObj.wMm ?? 0, hMm: tObj.hMm ?? 0, dpi: tObj.dpi ?? 300 } : null;
  const targetKey = typeof d.target === "string" ? d.target : isPrint ? "print" : "4k";
  const pxW = print ? Math.round((print.wMm / 25.4) * print.dpi) : 0;
  const pxH = print ? Math.round((print.hMm / 25.4) * print.dpi) : 0;
  const estimate = inputDims ? estimateEnhanceResources(inputDims.w, inputDims.h, d, overlap) : null;

  return (
    <div className="gen-panel">
      <div className="ed-main glass nowheel">
        <div className="gd-toolbar">
          <span className="ed-title">
            <IcUpscale size={15} /> 超清放大
          </span>
          <PopSelect
            triggerIcon
            up
            title="目标尺寸"
            value={targetKey}
            options={ENH_TARGET_OPTS}
            onChange={(v) => {
              if (v === "print") upd(selId, { target: { mode: "print", wMm: 1000, hMm: 700, dpi: 300 } });
              else upd(selId, { target: v as "4k" | "8k" | "16k" });
            }}
          />
          <PopSelect
            triggerIcon
            up
            title="质量"
            value={d.preset}
            options={ENH_PRESET_OPTS}
            onChange={(v) => upd(selId, { preset: v as EnhanceLocalData["preset"] })}
          />
          <PopSelect
            triggerIcon
            up
            title="输出格式"
            value={d.outputFormat}
            options={ENH_FORMAT_OPTS}
            onChange={(v) => upd(selId, { outputFormat: v as EnhanceLocalData["outputFormat"] })}
          />
          <ParamsPop icon={<IcGear size={14} />} label="高级" title="精度高级参数（影响双模型融合）">
            <div className="gp-sec-title">
              内容模式<span className="gp-hint">决定细节模型的融合权重（精度杠杆）</span>
            </div>
            <PopSelect
              value={d.contentMode}
              options={ENH_CM_OPTS}
              onChange={(v) => upd(selId, { contentMode: v as EnhanceLocalData["contentMode"] })}
            />
            <div className="gp-sec-title">
              细节强度<span className="gp-hint">0 = 生产保真；&gt;0 启用 UltraSharp V2（非商业许可）</span>
            </div>
            <label className="ne-slider nodrag">
              <span>强度</span>
              <input
                type="range"
                className="range"
                min={0}
                max={100}
                step={5}
                value={d.detailStrength}
                onChange={(e) => upd(selId, { detailStrength: Number(e.target.value) })}
              />
              <b>{d.detailStrength === 0 ? "自动" : d.detailStrength}</b>
            </label>
            <div className="gp-sec-title">
              去压缩<span className="gp-hint">JPEG 块效应预处理（1x-DeJPG），超分前跑</span>
            </div>
            <PopSelect
              value={d.dejpeg ?? "auto"}
              options={ENH_DEJPG_OPTS}
              onChange={(v) => upd(selId, { dejpeg: v as EnhanceLocalData["dejpeg"] })}
            />
            {d.preset === "portrait" ? (
              <>
                <div className="gp-sec-title">
                  人脸处理<span className="gp-hint">默认保护身份；FaceUpDAT/生成式修复均需显式选择</span>
                </div>
                <PopSelect
                  value={d.faceRestore ?? "identity"}
                  options={ENH_FACE_OPTS}
                  onChange={(v) => upd(selId, { faceRestore: v as EnhanceLocalData["faceRestore"] })}
                />
              </>
            ) : null}
            {d.preset === "professional" ? (
              <div className="ed-switch-row">
                <span>
                  16 位容器<em>减少后续编辑量化；模型采样仍为 8 位（仅 PNG/TIFF）</em>
                </span>
                <Switch on={d.bitDepth === 16} onChange={(v) => upd(selId, { bitDepth: v ? 16 : 8 })} />
              </div>
            ) : null}
            <div className="gp-sec-title">
              Tile 边长<span className="gp-hint">0 = 自动平衡显存/速度；失败会继续自动降档</span>
            </div>
            <NumInput className="input nodrag" min={0} step={32} value={d.tileSize} onCommit={(n) => upd(selId, { tileSize: n })} />
          </ParamsPop>
          <span className="gd-toolbar-sp" />
          <button className="btn primary" disabled={running} onClick={() => void runFlow(selId)}>
            {running ? <IcLoading size={15} /> : <IcSparkles size={15} />}
            {running ? `增强中 ${d.progressPct ?? 0}%` : "增强"}
          </button>
        </div>
        {isPrint && print ? (
          <div className="enh-print nodrag">
            <label>
              宽(mm)
              <NumInput min={1} value={print.wMm} onCommit={(n) => upd(selId, { target: { ...print, wMm: n } })} />
            </label>
            <label>
              高(mm)
              <NumInput min={1} value={print.hMm} onCommit={(n) => upd(selId, { target: { ...print, hMm: n } })} />
            </label>
            <label>
              DPI
              <NumInput min={72} value={print.dpi} onCommit={(n) => upd(selId, { target: { ...print, dpi: n } })} />
            </label>
            <span className="enh-px">≈ {pxW}×{pxH}px · 文化墙/展陈按实际尺寸算像素</span>
          </div>
        ) : null}
        {estimate ? (
          <div className={`enh-est ${estimate.risk}`} role="status">
            <span>预计 {estimate.width}×{estimate.height}</span>
            <span>{estimate.tiles} Tile</span>
            <span>自动 Tile {estimate.tileSize}</span>
            <span>显存约 {estimate.vramMb >= 1024 ? `${(estimate.vramMb / 1024).toFixed(1)}GB` : `${estimate.vramMb}MB`}</span>
            <span>内存峰值约 {estimate.ramMb >= 1024 ? `${(estimate.ramMb / 1024).toFixed(1)}GB` : `${estimate.ramMb}MB`}</span>
            <span>磁盘约 {estimate.diskMb >= 1024 ? `${(estimate.diskMb / 1024).toFixed(1)}GB` : `${estimate.diskMb}MB`}</span>
            <span>约 {estimate.secondsLow}–{estimate.secondsHigh}s</span>
            {estimate.risk !== "ok" ? <b>{estimate.risk === "critical" ? "高资源任务：建议降低尺寸或分批处理" : "大图任务：请预留内存与磁盘"}</b> : null}
            {estimate.note ? <em>{estimate.note}</em> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ================= 智能矢量 ================= */

const VEC_TYPE_OPTS = [
  { value: "flat", label: "平面拆件", desc: "整理纯色色块，保留轮廓与透明边界", icon: <IcPalette size={15} /> },
  { value: "auto", label: "自动", desc: "按上游内容分析选", icon: <IcSparkles size={15} /> },
  { value: "poster", label: "海报 / 色块", desc: "扁平色块、文化墙", icon: <IcLayers size={15} /> },
  { value: "comic", label: "插画 / 漫画", desc: "锐利尖角、细线条（爆炸贴/Logo）", icon: <IcBrush size={15} /> },
  { value: "bw", label: "黑白", desc: "单色 Logo / 剪影", icon: <IcContrast size={15} /> },
  { value: "line-art", label: "线稿", desc: "扫描/手绘线条", icon: <IcEdit size={15} /> },
  { value: "photo", label: "照片色阶", desc: "风格化轮廓近似，不是语义矢量", icon: <IcImage size={15} /> },
];
const VEC_CM_OPTS = [
  { value: "auto", label: "自动", desc: "随预设", icon: <IcSparkles size={15} /> },
  { value: "color", label: "彩色", desc: "多色堆叠", icon: <IcPalette size={15} /> },
  { value: "binary", label: "黑白", desc: "单色剪影", icon: <IcContrast size={15} /> },
];
const VEC_H_OPTS = [
  { value: "stacked", label: "堆叠", desc: "色块上下叠放（通用）", icon: <IcLayers size={15} /> },
  { value: "cutout", label: "镂空", desc: "挖空分层（喷绘/雕刻/文化墙）", icon: <IcScissors size={15} /> },
];
const VEC_QUALITY_OPTS = [
  { value: "fast", label: "极速", desc: "单候选直出，不评分", icon: <IcCheck size={15} /> },
  { value: "balanced", label: "标准", desc: "最多 3 候选 · 达标自动早停", icon: <IcSparkles size={15} /> },
  { value: "high-fidelity", label: "高保真", desc: "最多 5 候选 · 1024px 边缘回评", icon: <IcImage size={15} /> },
  { value: "few-nodes", label: "少节点", desc: "3 个简化候选 · 预算 8 千", icon: <IcScissors size={15} /> },
];

export function VectorizeConfigPanel() {
  const selId = useSelId("vectorize");
  const node = useBoard((s) => (selId ? s.nodes.find((n) => n.id === selId) : undefined));
  const upd = useBoard((s) => s.updateData);
  const [apps, setApps] = useState({ illustrator: false, coreldraw: false });

  useEffect(() => {
    if (!isTauri || !selId) return;
    invoke<{ illustrator: boolean; coreldraw: boolean }>("vector_export_apps")
      .then(setApps)
      .catch(() => {});
  }, [selId]);

  if (!selId || !node) return null;
  const d = node.data as VectorizeData;
  const running = d.status === "running";

  const saveSvg = async () => {
    if (!d.svg) return;
    try {
      if (!isTauri) {
        const a = document.createElement("a");
        a.href = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(d.svg)}`;
        a.download = `矢量_${Date.now()}.svg`;
        a.click();
        return;
      }
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const p = await save({ defaultPath: `矢量_${Date.now()}.svg`, filters: [{ name: "SVG", extensions: ["svg"] }] });
      if (p) {
        await writeTextFile(p, d.svg);
        toast(`已保存 SVG → ${p}`, "ok");
      }
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  const doExport = async (format: "ai" | "cdr" | "pdf" | "eps" | "png") => {
    if (!d.svg) return;
    const app = format === "cdr" ? "CorelDRAW" : "Illustrator";
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const p = await save({ defaultPath: `矢量_${Date.now()}.${format}`, filters: [{ name: format === "eps" ? "EPS" : app, extensions: [format] }] });
      if (!p) return;
      const wmm = format==="png" ? Math.round((d.resultW??1000)*(d.exportScale??4)) : d.exportWidthMm ?? ((d.resultW ?? 1000) / 96) * 25.4;
      const hmm = wmm * (d.resultH??1000)/(d.resultW??1000);
      // EPS 是本地独立导出（渐变降级纯填充，文字/位图不支持），不启动外部应用
      if (format === "ai" || format === "cdr") toast(`${app} 转换中（可能启动应用，请稍候，最多 180s）…`, "info");
      const r = await invoke<{ path: string; bytes: number; format: string }>("vector_export", {
        svg: d.svg, format, outPath: p, wMm: wmm, hMm: hmm,
      });
      toast(`已导出 ${format.toUpperCase()} → ${r.path}（${(r.bytes / 1024).toFixed(0)} KB）`, "ok");
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };

  /** 点击才把 SVG 收入资产库「矢量」分类（不再自动收录） */
  const collectSvg = async () => {
    if (!d.svg) return;
    if (d.productionReady === false && !window.confirm("这份 SVG 未通过生产质量门禁，仍要收入资产库吗？建议先改用「高保真」重跑。")) return;
    const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(d.svg)}`;
    const name = `智能矢量_${new Date().toLocaleTimeString("zh-CN", { hour12: false }).replace(/:/g, "-")}`;
    const it = await useAssets.getState().collect({ src, kind: "vector", name, model: "VTracer 智能矢量", nodeId: selId });
    toast(it ? "已收入资产库（矢量分类）" : "收入资产库失败", it ? "ok" : "err");
  };

  return (
    <div className="gen-panel">
      <div className="ed-main glass nowheel">
        <div className="gd-toolbar">
          <span className="ed-title">
            <IcVector size={15} /> 智能矢量
          </span>
          <PopSelect
            triggerIcon
            up
            title="矢量化类型"
            value={d.preset}
            options={VEC_TYPE_OPTS}
            onChange={(v) => upd(selId, { preset: v as VectorizeData["preset"] })}
          />
          <ParamsPop icon={<IcFilter size={14} />} label="参数" title="矢量化参数（VTracer）">
            {d.preset==="flat"&&<><div className="gp-sec-title">平面色盘<span className="gp-hint">较少颜色更干净；太少会合并相近色与细节</span></div><label className="ne-slider nodrag"><span>色数</span><input type="range" className="range" min={2} max={64} value={d.flatColors??12} onChange={e=>upd(selId,{flatColors:+e.target.value})}/><b>{d.flatColors??12}</b></label><p className="gp-hint">整理色块不改变构图。文字错误、缺件或轮廓畸变，请先用绘画模型重绘。</p></>}
            <div className="gp-sec-title">
              颜色精度<span className="gp-hint">{d.preset==="flat"?"平面拆件由上方色盘控制，描边使用完整色准":"0 = 自动（随预设）；越高颜色越丰富"}</span>
            </div>
            <label className="ne-slider nodrag">
              <span>精度</span>
              <input
                type="range"
                className="range"
                min={0}
                max={10}
                step={1}
                value={d.colorPrecision}
                disabled={d.preset==="flat"}
                onChange={(e) => upd(selId, { colorPrecision: Number(e.target.value) })}
              />
              <b>{d.colorPrecision === 0 ? "自动" : d.colorPrecision}</b>
            </label>
            <div className="gp-sec-title">
              去碎片<span className="gp-hint">0 = 自动；过滤小碎块，画面更干净</span>
            </div>
            <label className="ne-slider nodrag">
              <span>强度</span>
              <input
                type="range"
                className="range"
                min={0}
                max={40}
                step={1}
                value={d.filterSpeckle}
                onChange={(e) => upd(selId, { filterSpeckle: Number(e.target.value) })}
              />
              <b>{d.filterSpeckle === 0 ? "自动" : d.filterSpeckle}</b>
            </label>
            <div className="gp-sec-title">
              路径精度<span className="gp-hint">坐标小数位，越小文件越轻</span>
            </div>
            <label className="ne-slider nodrag">
              <span>位数</span>
              <input
                type="range"
                className="range"
                min={0}
                max={4}
                step={1}
                value={d.pathPrecision}
                onChange={(e) => upd(selId, { pathPrecision: Number(e.target.value) })}
              />
              <b>{d.pathPrecision}</b>
            </label>
            <div className="gp-sec-title">颜色模式</div>
            <PopSelect
              value={d.colorMode}
              options={VEC_CM_OPTS}
              onChange={(v) => upd(selId, { colorMode: v as VectorizeData["colorMode"] })}
            />
            <div className="gp-sec-title">分层方式</div>
            <PopSelect
              value={d.hierarchical}
              options={VEC_H_OPTS}
              onChange={(v) => upd(selId, { hierarchical: v as VectorizeData["hierarchical"] })}
            />
            <div className="gp-sec-title">
              质量档<span className="gp-hint">多候选跑几遍选最优；档越高越慢越精细</span>
            </div>
            <PopSelect
              value={d.quality ?? "balanced"}
              options={VEC_QUALITY_OPTS}
              onChange={(v) => upd(selId, { quality: v as VectorizeData["quality"] })}
            />
            <div className="ed-switch-row">
              <span>
                几何图元
                <em>尝试拟合圆/矩形等；仅在重渲染质量确有提升时接受</em>
              </span>
              <Switch on={d.geometry} onChange={(v) => upd(selId, { geometry: v })} />
            </div>
          </ParamsPop>
          <span className="gd-toolbar-sp" />
          <button className="btn primary" disabled={running} onClick={() => void runFlow(selId)}>
            {running ? <IcLoading size={15} /> : <IcSparkles size={15} />}
            {running ? "转化中" : "矢量化"}
          </button>
        </div>
        {d.svg ? (
          <div className="ed-exports nodrag">
            <label>宽 mm <input className="input" type="number" min={1} max={20000} style={{width:82}} value={d.exportWidthMm??Math.round((d.resultW??1000)/96*25.4)} onChange={e=>upd(selId,{exportWidthMm:+e.target.value})}/></label>
            <PopSelect title="高清 PNG 倍率" triggerIcon value={String(d.exportScale??4)} options={[1,2,4,8].map(v=>({value:String(v),label:`${v} 倍 PNG`,icon:<IcImage size={14}/>}))} onChange={v=>upd(selId,{exportScale:+v})}/>
            <button className="btn sm" title="从矢量路径直接渲染高清 PNG，透明背景保留" onClick={()=>void doExport("png")}>高清 PNG</button>
            <span className="ed-exp-cap">导出</span>
            <button className="btn sm" title="保存 SVG 矢量文件" onClick={saveSvg}>
              <IcDownload size={13} /> SVG
            </button>
            <button
              className="btn sm"
              title="独立导出 EPS（印刷交换格式；渐变降级为纯填充，文字/位图不支持）"
              onClick={() => doExport("eps")}
            >
              EPS
            </button>
            <button
              className="btn sm"
              title="独立导出矢量 PDF，保留路径与毫米尺寸，无需 Illustrator"
              onClick={() => doExport("pdf")}
            >
              PDF
            </button>
            <button
              className="btn sm"
              disabled={!apps.illustrator}
              title={apps.illustrator ? "经 Illustrator 另存为原生 .ai" : "未检测到 Illustrator"}
              onClick={() => doExport("ai")}
            >
              AI
            </button>
            <button
              className="btn sm"
              disabled={!apps.coreldraw}
              title={apps.coreldraw ? "经 CorelDRAW 另存为原生 .cdr" : "未检测到 CorelDRAW"}
              onClick={() => doExport("cdr")}
            >
              CDR
            </button>
            <span className="ed-sep" />
            <button className="btn sm primary" title="以 SVG 格式存入资产库「矢量」分类" onClick={collectSvg}>
              <IcLibrary size={13} /> 收入资产库
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
