/**
 * ComfyUI 设置面板 — 与生成图像同款底部弹窗：
 * 选中单个 ComfyUI 节点时弹出；chips 行 = 模板选择 / 分支选择（多分支时）/ 模板管理 / 上游传入计数与详情 / 圆形运行按钮；
 * 模板暴露的参数在卡内直接调整（文本留空自动取上游、图片留空自动用上游图）。
 */
import { useEffect, useState } from "react";
import { useBoard } from "../../core/stores/boardStore";
import { useComfyTemplates } from "../../core/stores/comfyStore";
import { useUi } from "../../core/stores/uiStore";
import { collectUpstream, runFlow } from "../../core/runner";
import { buildImageEntries, COMFY_SLOT_NONE, effectiveParams, enrichParamsWithCombo, fetchObjectInfo, findVariant } from "../../core/services/comfy";
import { useSettings } from "../../core/stores/settingsStore";
import { PopSelect } from "../../ui/PopSelect";
import { Thumb } from "../../ui/Thumb";
import { IcClose, IcGear, IcLoading, IcPlay } from "../../ui/icons";
import { UpstreamPanel } from "./GenPromptBar";
import { ParamField } from "./nodes/ComfyNode";
import type { ComfyData } from "../../core/types";

/** 输入映射弹卡 — 把上游图片精确分配到工作流的每个图片入口（深度图口/图生图口…）。
 *  入口 = 暴露的图片参数 + 未占用的 LoadImage 节点，顺序与引擎默认分配完全一致；
 *  未映射的入口仍走默认顺序（第 i 张图进第 i 个入口）。 */
function ImageSlotPanel({ selId, onClose }: { selId: string; onClose: () => void }) {
  const node = useBoard((s) => s.nodes.find((n) => n.id === selId));
  const upd = useBoard((s) => s.updateData);
  const templates = useComfyTemplates();
  const [openKey, setOpenKey] = useState<string | null>(null);
  // 上游图（join/split 保证只在内容变化时重渲染）
  const upImgs = useBoard(() => {
    if (!selId) return "";
    return collectUpstream(selId).images.join("\n");
  })
    .split("\n")
    .filter(Boolean);
  if (!node) return null;
  const d = node.data as ComfyData;
  const tpl = templates.find((t) => t.id === d.templateId);
  if (!tpl) return null;

  // 入口列表：暴露图片参数（顺序=引擎顺序）+ 未被参数占用的 LoadImage 节点（按编号排序）
  const entries = buildImageEntries(tpl, d.variantId);
  const map = d.imageSlotMap ?? {};

  const pick = (key: string, val: string | undefined) => {
    const next = { ...map };
    if (val === undefined) delete next[key];
    else next[key] = val;
    upd(selId, { imageSlotMap: Object.keys(next).length ? next : undefined });
  };

  /** 入口当前生效的图：映射值（含 NONE 哨兵）> 默认顺序第 i 张 */
  const curOf = (key: string, i: number): string | undefined => {
    if (key in map) return map[key];
    return upImgs[i];
  };

  return (
    <div className="gd-side-panel glass nodrag nowheel">
      <div className="gd-up-head">
        <b>输入映射</b>
        <span className="gd-up-sum">{entries.length} 个图片入口 · 上游 {upImgs.length} 张</span>
        <button className="icon-btn" title="关闭" aria-label="关闭" onClick={onClose}>
          <IcClose size={14} />
        </button>
      </div>
      <div className="gd-up-body">
        {!entries.length ? (
          <div className="gp-hint">该工作流没有图片入口（没有图片参数，也没有 LoadImage 节点）。</div>
        ) : (
          <>
            <div className="gd-up-sec">
              上游图（共 {upImgs.length} 张）→ 点每行的缩略图，把它指定到对应入口；「自动」= 按顺序分配
            </div>
            {upImgs.length ? (
              <div className="gd-up-row">
                {upImgs.map((s, i) => (
                  <Thumb key={i} src={s} alt="" title={`图${i + 1}`} />
                ))}
              </div>
            ) : (
              <div className="gp-hint">没有上游图片：连图片节点到本节点的输入口后才有图可映射。</div>
            )}
            {entries.map((e, i) => {
              const cur = curOf(e.key, i);
              const none = cur === COMFY_SLOT_NONE;
              const auto = !(e.key in map);
              return (
                <div key={e.key}>
                  <div className="gd-slot-row" onClick={() => setOpenKey(openKey === e.key ? null : e.key)}>
                    <b className="gd-slot-lab" title={e.key}>
                      {e.label}
                    </b>
                    <span style={{ flex: 1 }} />
                    <span className={`gd-slot-state ${none ? "none" : auto ? "" : "mapped"}`}>
                      {none ? "无图" : auto ? `自动 · ${cur ? `图${upImgs.indexOf(cur) + 1}` : "无"}` : `图${upImgs.indexOf(cur ?? "") + 1 || "?"}`}
                    </span>
                    {cur && !none ? <Thumb src={cur} alt="" className="gd-slot-thumb" /> : <span className="gd-slot-thumb empty">无</span>}
                  </div>
                  {openKey === e.key ? (
                    <div className="gd-slot-pick">
                      <button className={`btn sm ${auto ? "primary" : ""}`} onClick={() => { pick(e.key, undefined); setOpenKey(null); }}>
                        自动（第 {i + 1} 张）
                      </button>
                      <button className={`btn sm ${none ? "primary" : ""}`} onClick={() => { pick(e.key, COMFY_SLOT_NONE); setOpenKey(null); }}>
                        无图
                      </button>
                      {upImgs.map((s, k) => (
                        <button
                          key={k}
                          className={`gd-slot-cell ${cur === s ? "on" : ""}`}
                          title={`图${k + 1}`}
                          onClick={() => { pick(e.key, s); setOpenKey(null); }}
                        >
                          <Thumb src={s} alt="" />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
            <div className="gp-hint" style={{ marginTop: 6 }}>
              「无图」= 明确不给该入口图（部分工作流可能因此报错）；映射存于节点数据，随画布保存。
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function ComfyConfigPanel() {
  const selId = useBoard((s) => {
    const sel = s.nodes.filter((n) => n.selected);
    return sel.length === 1 && sel[0].type === "comfy" ? sel[0].id : null;
  });
  const node = useBoard((s) => (selId ? s.nodes.find((n) => n.id === selId) : undefined));
  const upd = useBoard((s) => s.updateData);
  const templates = useComfyTemplates();
  const setTemplateMgr = useUi((s) => s.setTemplateMgr);
  const suppressed = useUi((s) => s.genPanelSuppressed);
  const [upOpen, setUpOpen] = useState(false);
  const [slotOpen, setSlotOpen] = useState(false);
  // 一次 collectUpstream 同时取文本数与图数（此前两次订阅 = 每次 store 变化跑两遍上游递归）
  const upN = useBoard(() => {
    if (!selId) return "0,0";
    const u = collectUpstream(selId);
    return `${u.texts.length},${u.images.length}`;
  });
  const [upTextN, upImgN] = upN.split(",").map(Number);
  // 本组件靠 return null 隐藏（不会卸载），换节点时手动收起上游面板
  useEffect(() => {
    setUpOpen(false);
    setSlotOpen(false);
  }, [selId]);

  // combo 下拉选项：从 ComfyUI 服务端 /object_info 拉取（缓存），有则参数面板渲染下拉
  // ⚠ hooks 全部在条件 return 之前；提前用 selector 取 templateId/variantId 供 effect 依赖
  const comfyHost = useSettings((s) => s.settings.comfy.host);
  const curTplId = useBoard((s) => {
    const n = s.nodes.find((x) => x.id === selId);
    return n?.type === "comfy" ? (n.data as ComfyData).templateId : undefined;
  });
  const curVariantId = useBoard((s) => {
    const n = s.nodes.find((x) => x.id === selId);
    return n?.type === "comfy" ? (n.data as ComfyData).variantId : undefined;
  });
  const tplEarly = templates.find((t) => t.id === curTplId);
  const [comboOptions, setComboOptions] = useState<Record<string, string[]> | null>(null);
  // object_info 是否拉取成功（false = ComfyUI 离线/失败）：疑似 combo 的参数据此显示提示
  const [comboOffline, setComboOffline] = useState(false);
  useEffect(() => {
    let on = true;
    if (!tplEarly) {
      setComboOptions(null);
      setComboOffline(false);
      return;
    }
    const base = effectiveParams(tplEarly, curVariantId);
    void (async () => {
      const info = await fetchObjectInfo(comfyHost);
      const r = await enrichParamsWithCombo(comfyHost, tplEarly.workflow, base);
      if (!on) return;
      setComboOffline(!info);
      const m: Record<string, string[]> = {};
      for (const p of r) if (p.options?.length) m[p.key] = p.options;
      setComboOptions(m);
    })();
    return () => {
      on = false;
    };
  }, [tplEarly, curVariantId, comfyHost]);

  if (!selId || !node || suppressed) return null;
  const d = node.data as ComfyData;
  const tpl = templates.find((t) => t.id === d.templateId);
  const running = d.status === "running";
  // 当前分支的有效参数；单分支模板 variantId 为空 → effectiveParams 回落顶层 params
  const variantId = d.variantId;
  const variants = tpl?.variants;
  const hasMultiVariants = !!variants && variants.length > 1;
  const effParams = tpl ? effectiveParams(tpl, variantId) : [];
  // 当前分支的参数值：paramsByVariant 优先（分支参数记忆），回落 data.params（老数据兼容）
  const branchParams = (variantId ? d.paramsByVariant?.[variantId] : undefined) ?? d.params ?? {};
  const setParam = (key: string, v: string | number | boolean) => {
    const next = { ...branchParams, [key]: v as string | number };
    const patch: Partial<ComfyData> = { params: next };
    // 多分支模板：同时把值记进 paramsByVariant，切换分支不丢参数
    if (variantId) patch.paramsByVariant = { ...(d.paramsByVariant ?? {}), [variantId]: next };
    upd(selId, patch);
  };
  // 切换分支：旧分支值已随 setParam 存入 paramsByVariant，这里只更新 variantId 和 params 展示
  const switchVariant = (newVid: string) => {
    const stored = d.paramsByVariant?.[newVid] ?? {};
    upd(selId, { variantId: newVid || undefined, params: stored });
  };

  return (
    <div className="gen-panel">
      <div className="gd-main glass">
        <div className="gd-toolbar nodrag">
          <PopSelect
            style={{ minWidth: 220 }}
            title="工作流模板"
            value={d.templateId ?? ""}
            placeholder="选择工作流模板…"
            options={templates.map((t) => {
              const vc = t.variants?.length ?? 0;
              const pc = effectiveParams(t).length;
              const desc = vc > 1 ? `${vc} 个分支 · ${pc} 个参数` : pc ? `${pc} 个参数` : undefined;
              return { value: t.id, label: t.name, desc };
            })}
            onChange={(v) => upd(selId, { templateId: v || undefined, variantId: undefined, params: {}, paramsByVariant: undefined })}
            up
          />
          {hasMultiVariants ? (
            <PopSelect
              style={{ minWidth: 150 }}
              title="子工作流分支"
              value={variantId ?? "default"}
              options={(variants ?? []).map((v) => {
                const cur = findVariant(tpl!, v.id);
                const pc = cur?.params.length ?? effParams.length;
                return { value: v.id, label: v.name, desc: pc ? `${pc} 个参数` : undefined };
              })}
              onChange={switchVariant}
              up
            />
          ) : null}
          <button
            className="icon-btn"
            title="管理模板（导入 / 编辑要暴露的参数）"
            aria-label="管理模板（导入 / 编辑要暴露的参数）"
            onClick={() => setTemplateMgr(true)}
          >
            <IcGear size={17} />
          </button>
          {upTextN > 0 || upImgN > 0 ? (
            <button
              className={`gd-up-toggle${upOpen ? " on" : ""}`}
              title="查看上游传入的提示词与图片（文本参数留空自动取上游文本，图片参数留空自动用上游图）"
              onClick={() => setUpOpen((v) => !v)}
            >
              上游{upTextN > 0 ? ` ${upTextN}段` : ""}
              {upImgN > 0 ? ` ${upImgN}图` : ""}
            </button>
          ) : null}
          {upImgN > 0 ? (
            <button
              className={`gd-up-toggle${slotOpen ? " on" : ""}`}
              title="输入映射：把上游图片精确分配到工作流的每个图片入口（深度图口 / 图生图口…），不再按顺序乱塞"
              onClick={() => setSlotOpen((v) => !v)}
            >
              输入映射
            </button>
          ) : null}
          <button
            className={`gd-up-toggle${d.freeAfter ? " on" : ""}`}
            title="运行结束后自动清理 ComfyUI 显存（卸载模型 + 释放缓存）；大工作流防显存堆积，代价是下次运行重新加载模型"
            onClick={() => upd(selId, { freeAfter: !d.freeAfter })}
          >
            清显存
          </button>
          <span className="gd-toolbar-sp" />
          <button
            className="gd-send"
            disabled={running || !tpl}
            title="运行工作流（上游未运行的节点会按依赖顺序先自动运行）"
            aria-label="运行工作流"
            onClick={() => void runFlow(selId)}
          >
            {running ? <IcLoading size={17} /> : <IcPlay size={16} />}
          </button>
        </div>
        {tpl ? (
          effParams.length ? (
            <>
            <div className="cf-params nodrag nowheel">
              {effParams.map((p) => (
                <ParamField
                  key={p.key}
                  p={p}
                  value={branchParams?.[p.key]}
                  onChange={(v) => setParam(p.key, v)}
                  options={comboOptions?.[p.key]}
                  comboOffline={comboOptions !== null && comboOffline}
                />
              ))}
            </div>
            {(() => {
              // 孤儿参数（规格 FR-009）：实例覆盖值还在，但模板定义里该输入已被移除（多为工作流升级后）。
              // 值保留不丢（运行时不生效），这里灰显 + 可单条清除
              const effKeys = new Set(effParams.map((p) => p.key));
              const orphans = Object.entries(branchParams ?? {}).filter(([k]) => !effKeys.has(k));
              if (!orphans.length) return null;
              const clearOrphan = (key: string) => {
                const next = { ...branchParams };
                delete next[key];
                const patch: Partial<ComfyData> = { params: next };
                if (variantId) patch.paramsByVariant = { ...(d.paramsByVariant ?? {}), [variantId]: next };
                upd(selId, patch);
              };
              return (
                <div className="cf-orphan nodrag">
                  <div className="gp-hint">已失效的参数覆盖（工作流定义里已移除，不参与运行；值已保留）：</div>
                  {orphans.map(([k, v]) => (
                    <div key={k} className="cf-orphan-row">
                      <span className="cf-orphan-key">{k}</span>
                      <span className="gp-hint cf-orphan-val">{String(v)}</span>
                      <button className="icon-btn" title="清掉这条失效覆盖值" onClick={() => clearOrphan(k)}>
                        <IcClose size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              );
            })()}
            </>
          ) : (
            <div className="gp-hint">
              该模板没有暴露参数——点左侧齿轮可勾选要暴露的参数；直接点右侧圆钮即可运行。
            </div>
          )
        ) : (
          <div className="gp-hint">
            还没有模板？点齿轮导入 ComfyUI 工作流（API 格式 JSON），并勾选要暴露的参数。
          </div>
        )}
      </div>
      {upOpen ? <UpstreamPanel nodeId={selId} onClose={() => setUpOpen(false)} /> : null}
      {slotOpen ? <ImageSlotPanel selId={selId} onClose={() => setSlotOpen(false)} /> : null}
    </div>
  );
}
