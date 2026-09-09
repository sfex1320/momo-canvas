/**
 * 提示词「工具」合并弹窗（提示词节点用）：AI 工具（优化/扩写/精简/译英/反推/自定义指令）
 *  与提示词历史（搜索/收藏/回填）收进同一个弹窗；按钮渲染在节点悬浮工具条里（headExtra）。
 */
import { useEffect, useRef, useState } from "react";
import { PopLayer } from "./PopSelect";
import { PROMPT_AI_OPS, runPromptAiOp } from "./PromptAiTools";
import { usePromptHist } from "../core/stores/promptHistStore";
import { isCaptionOp } from "../core/runner";
import { skillsForContext } from "../core/stores/skillStore";
import { runSkill, defaultSkillValues } from "../core/skillEngine";
import { toast } from "../core/stores/uiStore";
import { errMsg } from "../core/utils";
import { IcHistory, IcLoading, IcSparkles, IcTrash, IcWand } from "./icons";
import type { LlmTextOp } from "../core/types";
import type { MomoSkill } from "../core/skillTypes";

export function PromptToolsBtn({
  value,
  image,
  onApply,
}: {
  /** 当前文本（AI 工具的输入；历史回填/AI 结果都写回这里） */
  value: string;
  /** 反推类操作的图片（上游第 1 张；没有时反推项置灰） */
  image?: string;
  onApply: (t: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"main" | "custom" | "skill">("main");
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [kw, setKw] = useState("");
  const [activeSkill, setActiveSkill] = useState<MomoSkill | null>(null);
  const [skillVals, setSkillVals] = useState<Record<string, string | number | boolean>>({});
  const wrapRef = useRef<HTMLDivElement>(null);
  const items = usePromptHist((s) => s.items);
  const availableSkills = [
    ...skillsForContext("prompt.text"),
    ...(image ? skillsForContext("prompt.image") : []),
  ].filter((s, i, arr) => arr.findIndex((x) => x.id === s.id) === i);

  useEffect(() => {
    void usePromptHist.getState().init();
  }, []);

  const close = () => {
    setOpen(false);
    setView("main");
    setActiveSkill(null);
  };

  const run = async (op: LlmTextOp) => {
    setBusy(op);
    try {
      const out = await runPromptAiOp(op, custom, value, image);
      if (out) {
        onApply(out);
        close();
      }
    } finally {
      setBusy(null);
    }
  };

  const runActiveSkill = async () => {
    if (!activeSkill) return;
    setBusy("skill:" + activeSkill.id);
    try {
      if (!value.trim() && !image) {
        toast("先写点内容或接入图片，再让 Skill 处理", "err");
        return;
      }
      const out = await runSkill(activeSkill, skillVals, value, image);
      if (out && out.trim()) {
        onApply(out);
        close();
      } else {
        toast("Skill 返回空结果，未替换文本", "err");
      }
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      setBusy(null);
    }
  };

  const pickSkill = (s: MomoSkill) => {
    setActiveSkill(s);
    setSkillVals(defaultSkillValues(s));
    setView("skill");
  };

  const hist = items
    .filter((i) => !kw || i.text.toLowerCase().includes(kw.toLowerCase()))
    .sort((a, b) => Number(b.pin) - Number(a.pin) || b.ts - a.ts)
    .slice(0, 30);

  return (
    <div ref={wrapRef} className="pop-wrap">
      <button
        className={`nt-btn nodrag ${open ? "on" : ""}`}
        disabled={!!busy}
        title="提示词工具：AI 优化/扩写/反推 + 历史回填"
        onClick={() => setOpen((v) => !v)}
      >
        {busy ? <IcLoading size={15} /> : <IcSparkles size={15} />}
        工具
      </button>
      {open ? (
        <PopLayer anchorRef={wrapRef} onClose={close} className="pt-pop">
          {view === "main" ? (
            <>
              <div className="pop-title">AI 工具（结果就地替换当前文本）</div>
              <div className="pt-ops">
                {PROMPT_AI_OPS.map((o) => {
                  const noImg = isCaptionOp(o.op) && !image;
                  return (
                    <button
                      key={o.op}
                      className="pt-op"
                      disabled={!!busy || noImg}
                      title={o.desc + (noImg ? "（需接入上游图片）" : "")}
                      onClick={() => (o.op === "custom" ? setView("custom") : void run(o.op))}
                    >
                      {busy === o.op ? <IcLoading size={13} /> : null}
                      {o.label}
                    </button>
                  );
                })}
              </div>
              {availableSkills.length ? (
                <>
                  <div className="pa-skill-title"><IcWand size={13} /> Skill</div>
                  {availableSkills.map((s) => (
                    <button key={s.id} className="pop-item" disabled={!!busy} onClick={() => pickSkill(s)}>
                      <span className="pi-text">
                        <span className="pi-label">{s.name}</span>
                        <span className="pi-desc">{s.description || s.instructions.slice(0, 40) + "…"}</span>
                      </span>
                    </button>
                  ))}
                </>
              ) : null}
              <div className="pop-title pt-hist-title">
                <IcHistory size={13} /> 历史
                {items.some((i) => !i.pin) ? (
                  <button className="icon-btn" title="清空未收藏的历史" onClick={() => usePromptHist.getState().clear()}>
                    <IcTrash size={12} />
                  </button>
                ) : null}
              </div>
              <input className="input" placeholder="搜索提示词…" value={kw} onChange={(e) => setKw(e.target.value)} />
              <div className="pt-hist">
                {hist.length === 0 ? (
                  <div className="pt-hist-empty">{items.length ? "没有匹配的提示词" : "暂无历史——生成成功后自动收录"}</div>
                ) : (
                  hist.map((i) => (
                    <div key={i.id} className={`pt-hist-item ${i.pin ? "pin" : ""}`}>
                      <span
                        className="t"
                        title={`${i.text}\n\n点击回填`}
                        onClick={() => {
                          onApply(i.text);
                          close();
                        }}
                      >
                        {i.text}
                      </span>
                      <button
                        className={`star ${i.pin ? "on" : ""}`}
                        title={i.pin ? "取消收藏" : "收藏置顶"}
                        onClick={() => usePromptHist.getState().togglePin(i.id)}
                      >
                        ★
                      </button>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : view === "skill" && activeSkill ? (
            <div className="pa-custom">
              <div className="pop-title">{activeSkill.name}</div>
              <div className="sec-desc" style={{ marginBottom: 8, fontSize: 12 }}>{activeSkill.description}</div>
              {activeSkill.variables.length ? (
                <div className="pa-skill-vars nodrag nowheel">
                  {activeSkill.variables.map((v) => (
                    <div key={v.key} className="pa-skill-var">
                      <label className="pi-desc" style={{ fontWeight: 500 }}>{v.label}</label>
                      {v.type === "select" ? (
                        <select className="input sm nodrag" value={String(skillVals[v.key] ?? v.default ?? "")} onChange={(e) => setSkillVals((m) => ({ ...m, [v.key]: e.target.value }))}>
                          {(v.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : v.type === "boolean" ? (
                        <input type="checkbox" className="nodrag" checked={!!skillVals[v.key]} onChange={(e) => setSkillVals((m) => ({ ...m, [v.key]: e.target.checked }))} />
                      ) : (
                        <input className="input sm nodrag" type={v.type === "number" ? "number" : "text"} value={String(skillVals[v.key] ?? v.default ?? "")} placeholder={v.hint} onChange={(e) => setSkillVals((m) => ({ ...m, [v.key]: v.type === "number" ? Number(e.target.value) : e.target.value }))} />
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="sec-desc" style={{ fontSize: 12, marginBottom: 8, maxHeight: 120, overflow: "auto", whiteSpace: "pre-wrap" }}>{activeSkill.instructions.slice(0, 200)}…</div>
              )}
              <div className="pa-custom-foot">
                <button className="btn sm" onClick={() => setView("main")}>返回</button>
                <button className="btn sm primary" disabled={!!busy} onClick={() => void runActiveSkill()}>
                  {busy ? <IcLoading size={14} /> : <IcWand size={14} />} 执行并替换
                </button>
              </div>
            </div>
          ) : (
            <div className="pa-custom">
              <div className="pop-title">自定义指令</div>
              <textarea
                className="textarea nodrag nowheel"
                rows={3}
                placeholder="例：把风格改成赛博朋克 / 把配色换成黄昏暖色调——只改指令涉及的部分，其余原样保留"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
              />
              <div className="pa-custom-foot">
                <button className="btn sm" onClick={() => setView("main")}>
                  返回
                </button>
                <button className="btn sm primary" disabled={!!busy || !custom.trim()} onClick={() => void run("custom")}>
                  {busy ? <IcLoading size={14} /> : null}
                  执行并替换
                </button>
              </div>
            </div>
          )}
        </PopLayer>
      ) : null}
    </div>
  );
}
