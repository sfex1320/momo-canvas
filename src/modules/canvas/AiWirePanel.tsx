/**
 * AI 布线助手面板 — 一句话 → 工作流方案预览 → 确认落画布
 * 方案可见可拒绝，落下即普通节点（可继续手工调整），不做黑箱
 */
import { useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { applyWirePlan, buildWirePlan, wireNodeLabel, type WirePlan } from "../../core/aiWire";
import { toast, useUi } from "../../core/stores/uiStore";
import { errMsg } from "../../core/utils";
import { IcArrowR, IcCheck, IcLoading, IcWand } from "../../ui/icons";

export function AiWirePanel() {
  const open = useUi((s) => s.aiWireOpen);
  const setOpen = useUi((s) => s.setAiWireOpen);
  const { screenToFlowPosition } = useReactFlow();
  const [intent, setIntent] = useState("");
  const [plan, setPlan] = useState<WirePlan | null>(null);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const gen = async () => {
    if (!intent.trim() || busy) return;
    setBusy(true);
    setPlan(null);
    try {
      setPlan(await buildWirePlan(intent.trim()));
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    if (!plan) return;
    const pos = screenToFlowPosition({ x: window.innerWidth * 0.3, y: window.innerHeight * 0.28 });
    applyWirePlan(plan, pos);
    setOpen(false);
    setPlan(null);
    setIntent("");
    toast("工作流已落到画布：图片节点需要你导入素材，然后点任意生成节点运行", "ok");
  };

  return (
    <div className="palette-wrap" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="palette glass aiwire">
        <div className="pal-input">
          <IcWand size={16} />
          <input
            autoFocus
            className="nodrag"
            placeholder="描述你想做什么，如：把一张人物照片换 3 个机位再拼成短视频…"
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void gen();
              if (e.key === "Escape") setOpen(false);
            }}
          />
          <button className="btn primary" disabled={busy || !intent.trim()} style={{ opacity: intent.trim() ? 1 : 0.5 }} onClick={() => void gen()}>
            {busy ? <IcLoading size={15} /> : <IcWand size={15} />}
            {busy ? "规划中…" : plan ? "重新规划" : "生成方案"}
          </button>
        </div>
        <div className="pal-list nowheel">
          {busy ? (
            <div className="pal-empty">对话模型正在规划工作流…</div>
          ) : plan ? (
            <>
              <div className="aw-summary">{plan.summary}</div>
              {plan.nodes.map((n) => (
                <div key={n.ref} className="pal-item aw-node">
                  <b>{wireNodeLabel(n.kind)}</b>
                  <span>{n.note || (typeof n.data.text === "string" ? (n.data.text as string).slice(0, 40) : "")}</span>
                </div>
              ))}
              <div className="aw-edges">
                {plan.edges.map((e, i) => {
                  const from = plan.nodes.find((n) => n.ref === e.from);
                  const to = plan.nodes.find((n) => n.ref === e.to);
                  return (
                    <span key={i} className={`aw-edge ${e.port}`}>
                      {from ? wireNodeLabel(from.kind) : e.from}
                      <IcArrowR size={12} />
                      {to ? wireNodeLabel(to.kind) : e.to}
                    </span>
                  );
                })}
              </div>
              <button className="btn primary" style={{ margin: "8px 6px" }} onClick={apply}>
                <IcCheck size={15} /> 满意，落到画布
              </button>
            </>
          ) : (
            <div className="pal-empty dim">
              一句话生成连好线的工作流（方案先预览、确认才落画布）。
              <br />
              例：「参考图反推提示词，换赛博朋克风重画 4 张并放大」
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
