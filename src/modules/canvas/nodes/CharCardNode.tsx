/**
 * 角色卡节点 — 人物图片 → 视觉模型提炼档案 + 各素材提示词 → 一键生成三视图/表情/立绘/设定卡
 *  也可从「角色库」应用预设（档案与提示词已就绪，直接生成）
 */
import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { NodeShell, OutModeToggle, PortImageIn, PortOut, PortTextIn } from "../NodeShell";
import { IcCheck, IcCopy, IcIdCard, IcLoading, IcRefresh, IcSparkles } from "../../../ui/icons";
import { ModelPicker } from "../../../ui/ModelPicker";
import { useBoard } from "../../../core/stores/boardStore";
import { toast, useUi } from "../../../core/stores/uiStore";
import { regenCharDeliverable, runFlow } from "../../../core/runner";
import { CARD_STYLES, CHAR_DELIVERABLES } from "../../../core/charPresets";
import { Thumb } from "../../../ui/Thumb";
import type { CharCardData, CharDeliverable } from "../../../core/types";

export const CharCardNode = memo(function CharCardNode({ id, data, selected }: NodeProps) {
  const d = data as CharCardData;
  const upd = useBoard((s) => s.updateData);
  const setLightbox = useUi((s) => s.setLightbox);
  const running = d.status === "running";
  const p = d.profile;
  const hasPrompts = Object.values(d.prompts).some((t) => (t ?? "").trim());
  const mode = d.outMode ?? (d.genImages === false ? "prompt" : "image");

  const toggleDeliv = (k: CharDeliverable) => {
    const has = d.deliverables.includes(k);
    upd(id, { deliverables: has ? d.deliverables.filter((x) => x !== k) : [...d.deliverables, k] });
  };

  const copyPrompt = async (k: CharDeliverable) => {
    const t = (d.prompts[k] ?? "").trim();
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      toast("提示词已复制", "ok");
    } catch {
      toast("复制失败：请从下方「查看/编辑提示词」里手动复制", "err");
    }
  };

  /** 清空档案与产出，重新走一遍分析 */
  const reset = () =>
    upd(id, { profile: undefined, prompts: {}, results: {}, status: "idle", error: undefined, presetName: undefined });

  return (
    <NodeShell
      id={id}
      title={p ? `角色卡 · ${p.name}` : "角色卡"}
      icon={<IcIdCard size={17} />}
      status={d.status}
      error={d.error}
      selected={selected}
      width={380}
      headExtra={
        <span className="acts nodrag" style={{ opacity: 1, display: "flex", alignItems: "center", gap: 5 }}>
          <OutModeToggle id={id} mode={mode} />
          {p ? (
            <button className="icon-btn" title="清空档案与产出，重新分析" onClick={reset}>
              <IcRefresh size={15} />
            </button>
          ) : null}
        </span>
      }
    >
      <div className="mnode-body">
        {p ? (
          <div className="cc-profile nodrag">
            <div className="cc-name">
              <b>{p.name}</b>
              {p.nameEn ? <i>{p.nameEn}</i> : null}
              {d.presetName ? <span className="cc-preset-tag">角色库预设</span> : null}
            </div>
            <div className="cc-meta">
              {[p.age ? `${p.age} 岁` : "", p.occupation, p.artStyle].filter(Boolean).join(" · ")}
            </div>
            {p.keywords?.length ? (
              <div className="cc-chips">
                {p.keywords.slice(0, 6).map((k) => (
                  <span key={k} className="chip on">
                    {k}
                  </span>
                ))}
              </div>
            ) : null}
            {p.palette?.length ? (
              <div className="cc-palette">
                {p.palette.slice(0, 8).map((c, i) => (
                  <i key={i} style={{ background: c }} title={c} />
                ))}
              </div>
            ) : null}
            {p.intro ? <div className="cc-intro">{p.intro}</div> : null}
          </div>
        ) : (
          <div className="gen-sum nodrag">
            <IcIdCard size={13} />
            <span>连接一张人物图片或一段角色文字描述后运行：模型提炼角色档案并产出整套素材；也可从「角色库」应用预设</span>
          </div>
        )}

        {!p ? (
          <>
            <div className="cc-lab nodrag">设定卡排版风格</div>
            <div className="opt-grid nodrag" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
              {CARD_STYLES.map((s) => (
                <button
                  key={s.value}
                  title={s.desc}
                  className={`opt-cell ${d.style === s.value ? "on" : ""}`}
                  onClick={() => upd(id, { style: s.value })}
                >
                  <span className="oc-lab">{s.label}</span>
                </button>
              ))}
            </div>
            <div className="ctl-row nodrag" title="生图提示词的语言：多数绘画模型英文效果更好">
              <span className="cc-lab" style={{ margin: 0 }}>提示词语言</span>
              <span style={{ flex: 1 }} />
              <span className="lang-seg">
                <button className={d.lang === "zh" ? "on" : ""} onClick={() => upd(id, { lang: "zh" })}>
                  中
                </button>
                <button className={d.lang === "en" ? "on" : ""} onClick={() => upd(id, { lang: "en" })}>
                  EN
                </button>
              </span>
            </div>
          </>
        ) : null}

        <div className="cc-lab nodrag">产出素材（勾选）</div>
        <div className="cc-delivs nodrag">
          {CHAR_DELIVERABLES.map((dv) => {
            const on = d.deliverables.includes(dv.value);
            const imgs = d.results[dv.value] ?? [];
            const hasP = !!(d.prompts[dv.value] ?? "").trim();
            return (
              <div key={dv.value} className={`cc-deliv ${on ? "" : "off"}`}>
                {/* 单素材输出端口：只把这一种素材（提示词/图片）接给下游 */}
                <Handle
                  type="source"
                  position={Position.Right}
                  id={`dl-${dv.value}`}
                  data-lab={`${dv.label}出`}
                  title={`单独输出「${dv.label}」${mode === "prompt" ? "提示词" : "图片"}`}
                  className={`port port-${mode === "prompt" ? "text" : "image"} port-deliv`}
                />
                <button className={`cc-check ${on ? "on" : ""}`} title={dv.desc} onClick={() => toggleDeliv(dv.value)}>
                  {on ? <IcCheck size={12} /> : null}
                </button>
                <span className="cc-deliv-name" title={dv.desc}>
                  {dv.label}
                </span>
                {imgs.length ? (
                  <span className="cc-deliv-thumbs">
                    {imgs.slice(0, 3).map((s, i) => (
                      <Thumb key={i} src={s} alt="" onClick={() => setLightbox(s)} />
                    ))}
                  </span>
                ) : null}
                <span style={{ flex: 1 }} />
                {hasP ? (
                  <>
                    <button className="icon-btn" title="复制该素材的提示词" onClick={() => void copyPrompt(dv.value)}>
                      <IcCopy size={14} />
                    </button>
                    {mode === "image" ? (
                      <button
                        className="icon-btn"
                        title="单独重新生成该素材"
                        disabled={running}
                        onClick={() => void regenCharDeliverable(id, dv.value)}
                      >
                        <IcRefresh size={14} />
                      </button>
                    ) : null}
                  </>
                ) : null}
              </div>
            );
          })}
        </div>

        {hasPrompts ? (
          <details className="cc-prompts nodrag">
            <summary>查看 / 编辑提示词</summary>
            {CHAR_DELIVERABLES.filter((dv) => (d.prompts[dv.value] ?? "").trim()).map((dv) => (
              <div key={dv.value} className="cc-prompt-item">
                <span className="cc-lab">{dv.label}</span>
                <textarea
                  className="textarea nodrag nowheel"
                  rows={3}
                  value={d.prompts[dv.value]}
                  onChange={(e) => upd(id, { prompts: { ...d.prompts, [dv.value]: e.target.value } })}
                />
              </div>
            ))}
          </details>
        ) : null}

        <div className="cc-models nodrag">
          <label title="分析人物图片/描述用的视觉对话模型">
            <span>分析</span>
            <ModelPicker role="chat" value={d.chatModelId} onChange={(v) => upd(id, { chatModelId: v })} />
          </label>
          {mode === "image" ? (
            <label title="生成素材图片用的绘画模型">
              <span>绘画</span>
              <ModelPicker role="image" value={d.imageModelId} onChange={(v) => upd(id, { imageModelId: v })} />
            </label>
          ) : null}
        </div>
        <button
          className="btn primary nodrag"
          disabled={running || (!!p && mode === "prompt" && hasPrompts)}
          title={
            p && mode === "prompt" && hasPrompts
              ? "提示词已就绪：在上方逐条复制，或从输出端口接给下游节点；切到「出图」可直接生成图片"
              : undefined
          }
          onClick={() => void runFlow(id)}
        >
          {running ? <IcLoading size={17} /> : <IcSparkles size={17} />}
          {running
            ? "运行中…"
            : p
              ? mode === "image"
                ? "生成整套素材"
                : "提示词已就绪"
              : mode === "image"
                ? "分析并生成"
                : "仅生成提示词"}
        </button>
        {running && d.progress ? (
          <div className="progress-line nodrag">
            <IcLoading size={14} />
            {d.progress}
          </div>
        ) : null}
      </div>
      <PortTextIn />
      <PortImageIn />
      {/* 主输出放头部（素材行的独立端口在各行右侧，避免混在一起） */}
      <PortOut kind={mode === "prompt" ? "text" : "image"} top={26} />
    </NodeShell>
  );
});
