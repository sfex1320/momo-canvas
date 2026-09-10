/**
 * 提示词 AI 工具菜单（生成弹窗 / 提示词节点共用）：
 * 优化扩写 / 丰富细节 / 精简压缩 / 译英 / 图片反推 / 自定义指令 —— 结果就地替换当前文本，不新增节点。
 * 整合了原「文本处理」节点的全部操作与提示词节点的「AI 扩写优化」（优化扩写 = 原两者合并）。
 */
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "./kit";
import { PopLayer } from "./PopSelect";
import { IcLoading, IcSparkles, IcWand } from "./icons";
import { isCaptionOp, llmTextTransform } from "../core/runner";
import { toast } from "../core/stores/uiStore";
import { errMsg } from "../core/utils";
import { skillsForContext } from "../core/stores/skillStore";
import { runSkill, defaultSkillValues } from "../core/skillEngine";
import type { LlmTextOp } from "../core/types";
import type { MomoSkill } from "../core/skillTypes";

const OPS: { op: LlmTextOp; label: string; desc: string }[] = [
  { op: "optimize", label: "优化扩写", desc: "改写为高质量绘画提示词：补主体细节、构图、光影、风格" },
  { op: "expand", label: "丰富细节", desc: "保持原意，补充场景与氛围描写" },
  { op: "shorten", label: "精简压缩", desc: "保留核心信息，删去冗余" },
  { op: "zh2en", label: "译成英文", desc: "翻成地道的英文绘画提示词" },
  { op: "capPrompt", label: "反推提示词", desc: "从图片反推一段可复现的绘画提示词" },
  { op: "capDetail", label: "详细描述", desc: "分段描述图片内容、风格与细节" },
  { op: "capTags", label: "反推标签", desc: "输出英文标签词（danbooru 风格，逗号分隔）" },
  { op: "custom", label: "自定义指令…", desc: "写一条处理指令，按指令改写文本" },
];

/** AI 工具清单（PromptToolsBtn 合并弹窗复用） */
export const PROMPT_AI_OPS = OPS;

/** 执行一次 AI 文本处理：校验输入 → 调模型 → 返回结果文本（失败已 toast，返回 null） */
export async function runPromptAiOp(op: LlmTextOp, custom: string, value: string, image?: string): Promise<string | null> {
  if (isCaptionOp(op) && !image) {
    toast("反推需要先接入一张上游图片", "err");
    return null;
  }
  if (!isCaptionOp(op) && !value.trim()) {
    toast("先写点内容，再让 AI 处理", "err");
    return null;
  }
  try {
    return await llmTextTransform(op, custom, value, image);
  } catch (e) {
    toast(errMsg(e), "err");
    return null;
  }
}

function PromptAiMenu({
  value,
  image,
  onApply,
  className,
  up,
  disabled,
  onBusyChange,
}: {
  /** 当前文本（文本类操作的输入） */
  value: string;
  /** 反推类操作的图片（一般取上游第 1 张；没有时反推项置灰） */
  image?: string;
  /** 处理完成：用结果就地替换文本 */
  onApply: (t: string) => void;
  className?: string;
  /** 强制向上弹出（底部生成面板用）；不传则按视口空间自动翻转（节点内用） */
  up?: boolean;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"menu" | "custom" | "skill">("menu");
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [activeSkill, setActiveSkill] = useState<MomoSkill | null>(null);
  const [skillVals, setSkillVals] = useState<Record<string, string | number | boolean>>({});
  const wrapRef = useRef<HTMLDivElement>(null);
  // 拿当前上下文适用的 Skill：有图时含 prompt.image，无图时含 prompt.text
  const availableSkills = [
    ...skillsForContext("prompt.text"),
    ...(image ? skillsForContext("prompt.image") : []),
  ].filter((s, i, arr) => arr.findIndex((x) => x.id === s.id) === i); // 去重
  const close = () => {
    setOpen(false);
    setView("menu");
    setActiveSkill(null);
  };

  const run = async (op: LlmTextOp) => {
    if (busy || disabled) return;
    onBusyChange?.(true);
    setBusy(op);
    try {
      const out = await runPromptAiOp(op, custom, value, image);
      if (out) {
        onApply(out);
        close();
      }
    } finally {
      setBusy(null);
      onBusyChange?.(false);
    }
  };

  const runActiveSkill = async () => {
    if (!activeSkill || busy || disabled) return;
    onBusyChange?.(true);
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
      onBusyChange?.(false);
    }
  };

  const pickSkill = (s: MomoSkill) => {
    setActiveSkill(s);
    setSkillVals(defaultSkillValues(s));
    setView("skill");
  };

  return (
    <div ref={wrapRef} className={`pop-wrap ${className ?? ""}`}>
      <button
        className={`btn sm nodrag ${open ? "on" : ""}`}
        disabled={!!busy || disabled}
        title="AI 文本工具：优化 / 扩写 / 精简 / 译英 / 图片反推 —— 结果就地替换当前文本"
        onClick={() => setOpen((v) => !v)}
      >
        {busy ? <IcLoading size={15} /> : <IcSparkles size={15} />}
        {busy ? "处理中" : "AI 工具"}
      </button>
      {open ? (
        <PopLayer anchorRef={wrapRef} onClose={close} up={up} className="pa-pop">
          {view === "menu" ? (
            <div className="pop-list">
              {OPS.map((o) => {
                const noImg = isCaptionOp(o.op) && !image;
                return (
                  <button
                    key={o.op}
                    className="pop-item"
                    disabled={!!busy || disabled || noImg}
                    onClick={() => (o.op === "custom" ? setView("custom") : void run(o.op))}
                  >
                    <span className="pi-text">
                      <span className="pi-label">
                        {busy === o.op ? <IcLoading size={13} /> : null}
                        {o.label}
                      </span>
                      <span className="pi-desc">
                        {o.desc}
                        {noImg ? "（需接入上游图片）" : ""}
                      </span>
                    </span>
                  </button>
                );
              })}
              {availableSkills.length ? (
                <>
                  <div className="pa-skill-title">
                    <IcWand size={13} /> Skill（创作规则包）
                  </div>
                  {availableSkills.map((s) => (
                    <button
                      key={s.id}
                      className="pop-item"
                      disabled={!!busy}
                      onClick={() => pickSkill(s)}
                    >
                      <span className="pi-text">
                        <span className="pi-label">{s.name}</span>
                        <span className="pi-desc">
                          {s.description || s.instructions.slice(0, 50) + "…"}
                        </span>
                      </span>
                    </button>
                  ))}
                </>
              ) : null}
            </div>
          ) : view === "skill" && activeSkill ? (
            <div className="pa-custom">
              <div className="pop-title">{activeSkill.name}</div>
              <div className="sec-desc" style={{ marginBottom: 8, fontSize: 12 }}>
                {activeSkill.description}
              </div>
              {activeSkill.variables.length ? (
                <div className="pa-skill-vars nodrag nowheel">
                  {activeSkill.variables.map((v) => (
                    <div key={v.key} className="pa-skill-var">
                      <label className="pi-desc" style={{ fontWeight: 500 }}>{v.label}</label>
                      {v.type === "select" ? (
                        <select
                          className="input sm nodrag"
                          value={String(skillVals[v.key] ?? v.default ?? "")}
                          onChange={(e) => setSkillVals((m) => ({ ...m, [v.key]: e.target.value }))}
                        >
                          {(v.options ?? []).map((o) => (
                            <option key={o} value={o}>{o}</option>
                          ))}
                        </select>
                      ) : v.type === "boolean" ? (
                        <input
                          type="checkbox"
                          className="nodrag"
                          checked={!!skillVals[v.key]}
                          onChange={(e) => setSkillVals((m) => ({ ...m, [v.key]: e.target.checked }))}
                        />
                      ) : (
                        <input
                          className="input sm nodrag"
                          type={v.type === "number" ? "number" : "text"}
                          value={String(skillVals[v.key] ?? v.default ?? "")}
                          placeholder={v.hint}
                          onChange={(e) =>
                            setSkillVals((m) => ({
                              ...m,
                              [v.key]: v.type === "number" ? Number(e.target.value) : e.target.value,
                            }))
                          }
                        />
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="sec-desc" style={{ fontSize: 12, marginBottom: 8, maxHeight: 120, overflow: "auto", whiteSpace: "pre-wrap" }}>
                  {activeSkill.instructions.slice(0, 200)}…
                </div>
              )}
              <div className="pa-custom-foot">
                <button className="btn sm" onClick={() => setView("menu")}>
                  返回
                </button>
                <button
                  className="btn sm primary"
                  disabled={!!busy}
                  onClick={() => void runActiveSkill()}
                >
                  {busy ? <IcLoading size={14} /> : <IcWand size={14} />}
                  执行并替换
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
                <button className="btn sm" onClick={() => setView("menu")}>
                  返回
                </button>
                <button
                  className="btn sm primary"
                  disabled={!!busy || !custom.trim()}
                  onClick={() => void run("custom")}
                >
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

/** 所有操作先修改草稿，保存时才替换原文。 */
export function PromptAiTools(props: { value: string; image?: string; onApply: (text: string) => void; className?: string; up?: boolean }) {
  const [open, setOpen] = useState(false), [draft, setDraft] = useState("");
  const [instruction,setInstruction] = useState(""), [busy,setBusy] = useState(false);
  const session = useRef(0), activeSession = session.current;
  const close = () => { session.current++; setOpen(false); setBusy(false); };
  const transform = async (op:LlmTextOp) => {
    if(busy)return;
    const version=session.current;setBusy(true);
    try{const result=await runPromptAiOp(op,instruction,draft,props.image);if(result&&version===session.current)setDraft(result);}
    finally{if(version===session.current)setBusy(false);}
  };
  return <><button className={`btn sm nodrag ${props.className ?? ""}`} onClick={() => { session.current++; setDraft(props.value); setBusy(false); setOpen(true); }}><IcSparkles size={14}/>调整</button>
    {open && createPortal(<Modal title="调整提示词" width={800} onClose={close} footer={<><button className="btn" disabled={busy} onClick={() => setDraft(props.value)}>还原原文</button><button className="btn primary" disabled={busy} onClick={() => { props.onApply(draft); close(); }}>保存调整</button></>}>
      <div className="prompt-adjust-toolbar" style={{marginBottom:12}}>{OPS.slice(0,4).map(o=><button className="btn sm" key={o.op} disabled={busy} onClick={()=>void transform(o.op)}>{o.label}</button>)}</div>
      <div className="prompt-adjust-toolbar" style={{marginBottom:12}}><input className="input" style={{flex:1}} value={instruction} disabled={busy} onChange={e=>setInstruction(e.target.value)} placeholder="自定义调整，例如：改为暖色，保留人物和构图"/><button className="btn sm" disabled={busy||!instruction.trim()} onClick={()=>void transform("custom")}>{busy?"处理中…":"按指令调整"}</button></div>
      <div className="prompt-adjust-toolbar"><PromptAiMenu value={draft} image={props.image} disabled={busy} onApply={text=>{if(activeSession===session.current)setDraft(text);}} onBusyChange={value=>{if(activeSession===session.current)setBusy(value);}}/><span className="hint">图片反推与 Skill 在 AI 工具中；也可直接修改下方文字。</span></div>
      <textarea className="textarea nodrag nowheel" aria-label="提示词草稿" rows={12} disabled={busy} value={draft} onChange={e => setDraft(e.target.value)} style={{width:"100%", marginTop:12, maxHeight:"48vh"}}/>
      <small className="hint">{draft.length} 字 · 保存后用于后续生成</small>
    </Modal>, document.body)}
  </>;
}
