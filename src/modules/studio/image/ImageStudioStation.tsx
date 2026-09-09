/**
 * AI 制图工位（导演台 3.0 · 方案 §6.4 · Z-IMAGE STUDIO 同位功能）
 *
 * 生成历史/预设 │ 参数与提示词主区 │ 结果与版本
 *  - 文生图 / 图生图 / 图片编辑三个一级标签；
 *  - 引擎统一：本地 ComfyUI 配方 ⇄ 远程 Provider（火山 Seedream 只是 Provider 之一）；
 *  - 远程生成前计费确认；结果自动入库（成组、带 director 来源可反向定位）；
 *  - 一键：设为角色参考 / 设为场景图 / 绑定到所选片段 / 参数复用重跑。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ReferencePlan } from "../../../ui/ReferencePlan";
import { resolveModelCard, modelKey } from "../../../core/stores/settingsStore";
import { isAbortError } from "../../../core/runControl";
import { useDirector } from "../../../core/stores/directorStore";
import { ENGINE_ICONS, SI, opt } from "../shared/selectIcons";
import { useAssets } from "../../../core/stores/assetStore";
import { useUi } from "../../../core/stores/uiStore";
import { useDirectorCtx } from "../../../core/directorContext";
import { runImageStudio, imageStudioPrompt, toggleImageRecordFav, type ImageStudioParams } from "../../../core/studio/imageStudio";
import { errMsg } from "../../../core/utils";
import { DockPanel } from "../shared/DockPanel";
import { SkillStationBadge } from "../shared/SkillBindingCard";
import { ModelPicker } from "../../../ui/ModelPicker";
import { PopSelect } from "../../../ui/PopSelect";
import { Thumb } from "../../../ui/Thumb";
import { assetUrl } from "../../../core/services/assetFiles";
import {
  IcBrush, IcSparkles, IcLoading, IcStar, IcRefresh, IcUpload, IcCheck, IcImage, IcPerson, IcFilmFrame, IcLink,
} from "../../../ui/icons";
import type { DirectorProject, ImageStudioRecord } from "../../../core/types";

const MODES: Array<{ id: ImageStudioParams["mode"]; label: string; desc: string }> = [
  { id: "t2i", label: "文生图", desc: "提示词直接出图" },
  { id: "i2i", label: "图生图", desc: "参考图 + 提示词改绘" },
  { id: "edit", label: "编辑图", desc: "按参考图局部重绘/扩展" },
];

const ASPECTS = ["auto", "16:9", "9:16", "1:1", "4:3", "21:9"];

export function ImageStudioStation({ project }: { project: DirectorProject }) {
  return <ImageStudioWorkspace key={project.id} project={project}/>;
}
function ImageStudioWorkspace({ project }: { project: DirectorProject }) {
  const boardId=project.boardId;
  const controller=useRef<AbortController|null>(null);
  useEffect(()=>()=>controller.current?.abort(),[]);
  const updateProject = useDirector((s) => s.updateProject);
  const assets = useAssets((s) => s.items);
  const history = project.imageStudio?.history ?? [];
  const mode = project.studioUi?.imageMode ?? "t2i";
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [engine, setEngine] = useState<"comfy" | "provider">("provider");
  const [providerKey, setProviderKey] = useState<string>("");
  const [recipeId, setRecipeId] = useState<string>("");
  const [aspect, setAspect] = useState("auto");
  const [n, setN] = useState(1);
  const [seed, setSeed] = useState<string>("");
  const [inputIds, setInputIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [resultIds, setResultIds] = useState<string[]>([]);
  const [pending, setPending] = useState<ImageStudioParams|null>(null);
  const confirmOpen=!!pending;
  const setConfirmOpen=(open:boolean)=>{if(!open){setPending(null);return;}try{const plan=buildParams();if(plan.engine==="provider"){const card=resolveModelCard("image",plan.providerModelKey);plan.providerModelKey=modelKey(card.id,card.model);}setPending({...plan,finalPrompt:imageStudioPrompt(project.id,plan)});}catch(e){useUi.getState().pushError("制图预检",errMsg(e));}};
  const fileRef = useRef<HTMLInputElement>(null);
  const ctxSegId = useDirectorCtx((s) => s.segId);
  const seg = useMemo(() => project.scenes.flatMap((s) => s.segments).find((x) => x.id === ctxSegId), [project, ctxSegId]);
  const imageRecipes = project.recipes.filter((r) => r.output === "image");

  const applyRecord = (r: ImageStudioRecord) => {
    setPrompt(r.prompt);
    setEngine(r.engine);
    setRecipeId(r.recipeId ?? "");
    setProviderKey(r.providerModelKey ?? "");
    setInputIds(r.inputAssetIds ?? []);
    updateProject(project.id, { studioUi: { ...project.studioUi ?? { station: "h3" }, imageMode: r.mode } });
    setAspect(String(r.params.aspect || "auto"));
    setSeed(String(r.params.seed ?? ""));
    setN(Number(r.params.n)||1);
    setNegative(String(r.params.negative??""));
    setResultIds(r.assetIds);
  };

  const buildParams=():ImageStudioParams=>({mode,prompt,negative:negative||undefined,inputAssetIds:mode==="t2i"?[]:[...inputIds],engine,recipeId:engine==="comfy"?recipeId:undefined,providerModelKey:engine==="provider"?providerKey||undefined:undefined,aspect:aspect==="auto"?undefined:aspect,n:engine==="comfy"?1:n,seed:seed?Number(seed):undefined});
  const run = async () => {
    if(controller.current) return;
    const plan=pending;if(!plan)return;
    setPending(null);setBusy(true);
    const ctrl=new AbortController();controller.current=ctrl;
    try {
      const r=await runImageStudio(project.id,{...plan,signal:ctrl.signal,confirmed:true});
      if(!ctrl.signal.aborted)setResultIds(r.assetIds);
    } catch(e){if(!ctrl.signal.aborted&&!isAbortError(e))useUi.getState().toast(errMsg(e),"err");}
    finally{controller.current=null;setBusy(false);}
  };

  /** 绑定到所选片段参考槽（图片槽末位追加） */
  const bindToSegment = (assetId: string) => {
    if (!seg) return;
    useDirector.getState().updateProject(project.id, {
      scenes: (useDirector.getState().getById(project.id)?.scenes ?? []).map((s) => ({
        ...s,
        segments: s.segments.map((g) =>
          g.id === seg.id ? { ...g, slots: [...(g.slots ?? []), { semantic: "referenceImage" as const, assetIds: [assetId], auto: false }] } : g,
        ),
      })),
    });
    useUi.getState().toast?.(`已绑定到片段「${seg.summary.slice(0, 16)}」的参考图槽`, "ok");
  };

  return (
    <>
      <DockPanel
        className="im-left"
        title="历史与预设"
        projectId={project.id}
        widthKey="imLeft"
        width={project.studioUi?.panelWidths?.imLeft ?? 240}
      >
        <div className="im-history">
          {history.length === 0 ? <span className="st-hint">生成历史会保留最近 60 条（含全部参数，可复用重跑）。</span> : null}
          {history.map((h) => {
            const cover = h.assetIds.map((id) => assets.find((a) => a.id === id)).find(Boolean);
            return (
              <div key={h.id} className="im-hcard" title={`${h.prompt.slice(0, 80)} · ${h.mode}`} onClick={() => applyRecord(h)}>
                <div className="im-thumb">{cover?.thumb ? <img src={assetUrl(cover.thumb)} alt="" /> : cover ? <Thumb src={assetUrl(cover.path)} style={{ width: "100%", height: "100%" }} /> : null}</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 11.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.prompt.slice(0, 22) || "（空）"}</div>
                  <div className="st-hint">{MODES.find((m) => m.id === h.mode)?.label} · {h.engine === "comfy" ? "本地" : "远程"} · {h.assetIds.length} 张</div>
                </div>
                <button
                  className="st-iconbtn"
                  style={{ width: 24, height: 24 }}
                  title="收藏预设"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleImageRecordFav(project.id, h.id);
                  }}
                >
                  <IcStar size={12} style={{ color: h.fav ? "var(--warn)" : undefined }} />
                </button>
              </div>
            );
          })}
        </div>
      </DockPanel>

      {/* 中：参数与提示词主区 */}
      <section className="im-main">
        <div className="st-context">
          {MODES.map((m) => (
            <button key={m.id} className={`st-btn sm${mode === m.id ? " primary" : ""}`} title={m.desc} onClick={() => updateProject(project.id, { studioUi: { ...project.studioUi ?? { station: "h3" }, imageMode: m.id } })}>
              {m.label}
            </button>
          ))}
          <SkillStationBadge project={project} context="studio.image" />
          <span className="st-hint" style={{ marginLeft: "auto" }}>
            {engine === "comfy" ? "本地 ComfyUI（生成时显示模型加载与显存阶段）" : "远程 Provider（按量计费）"}
          </span>
        </div>
        <div className="st-panel-b" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <textarea
            className="st-area"
            rows={3}
            placeholder="画面描述…（主体 / 动作 / 环境 / 光线 / 风格）"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <textarea
            className="st-area"
            rows={2}
            placeholder="负向提示词（可选）：不想出现的内容"
            value={negative}
            onChange={(e) => setNegative(e.target.value)}
          />
          {mode !== "t2i" ? (
            <div className="st-field">
              <label>输入图（{mode === "i2i" ? "参考图" : "编辑底图"}；可多张）</label>
              <div className="im-inputs">
                {inputIds.map((id) => {
                  const a = assets.find((x) => x.id === id);
                  return (
                    <div key={id} className="ch-ref" style={{ width: 64 }} title={a?.name}>
                      {a ? <Thumb src={assetUrl(a.path)} style={{ width: "100%", height: "100%" }} /> : null}
                      <button className="rm" onClick={() => setInputIds(inputIds.filter((x) => x !== id))}>×</button>
                    </div>
                  );
                })}
                <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={async (e) => {
                  const files = e.target.files;
                  if (!files) return;
                  const ids: string[] = [];
                  for (const f of Array.from(files)) {
                    const a = await useAssets.getState().importFileGetItem(f);
                    if (a) ids.push(a.id);
                  }
                  setInputIds((prev) => [...prev, ...ids]);
                  e.target.value = "";
                }} />
                <button className="st-btn sm" onClick={() => fileRef.current?.click()}><IcUpload size={12} /> 添加图片</button>
              </div>
            </div>
          ) : null}
          <ReferencePlan boardId={boardId} projectId={project.id} prompt={prompt} ids={mode==="t2i"?[]:inputIds} onChange={ids=>{setInputIds(ids);if(mode==="t2i")updateProject(project.id,{studioUi:{...project.studioUi??{station:"image"},imageMode:"i2i"}});}} target={`${engine==="comfy"?"本地配方":"远程模型"} · ${engine==="comfy"?recipeId||"待选择":providerKey||"默认模型"}`} />
          <div className="st-row" style={{ flexWrap: "wrap", gap: 10 }}>
            <div className="st-field">
              <label>引擎</label>
              <PopSelect
                value={engine}
                onChange={(v) => setEngine(v as "comfy" | "provider")}
triggerIcon
                options={[
                  { value: "provider", label: "远程 Provider", icon: ENGINE_ICONS.provider },
                  { value: "comfy", label: "本地 ComfyUI", icon: ENGINE_ICONS.comfy },
                ]}
              />
            </div>
            {engine === "provider" ? (
              <div className="st-field">
                <label>生图模型（火山 Seedream 等以 Provider 配置）</label>
                <ModelPicker role="image" value={providerKey} onChange={(k) => setProviderKey(k ?? "")} />
              </div>
            ) : (
              <div className="st-field">
                <label>本地图片配方</label>
                <PopSelect
                  value={recipeId}
                  onChange={(v) => setRecipeId(String(v))}
                  triggerIcon
                  options={[opt("", "选择配方…", SI.flow), ...imageRecipes.map((r) => ({ value: r.id, label: r.name, icon: SI.image }))]}
                />
              </div>
            )}
            <div className="st-field">
              <label>画幅</label>
              <PopSelect value={aspect} onChange={(v) => setAspect(String(v))} triggerIcon
              options={ASPECTS.map((a) => ({ value: a, label: a, icon: SI.crop }))} />
            </div>
            <div className="st-field">
              <label>{engine==="comfy"?"单次配方输出":"张数"}</label>
              {engine==="comfy"?<small>张数由工作流决定</small>:<PopSelect value={String(n)} onChange={(v) => setN(Number(v))} triggerIcon
              options={[1, 2, 4].map((x) => ({ value: String(x), label: `${x} 张`, icon: SI.layers }))} />}
            </div>
            <div className="st-field">
              <label>种子（留空随机）</label>
              <input className="st-input" style={{ width: 110 }} value={seed} onChange={(e) => setSeed(e.target.value.replace(/\D/g, ""))} placeholder="随机" />
            </div>
          </div>
          <div className="st-row">
            <button className="st-btn primary" disabled={busy || !prompt.trim()} onClick={() => setConfirmOpen(true)}>
              {busy ? <IcLoading size={13} /> : <IcSparkles size={13} />} 生成{engine === "provider" ? "（计费确认）" : ""}
            </button>
            {busy ? <><button className="st-btn" onClick={()=>controller.current?.abort()}>停止</button><span className="st-hint">停止等待；远程已提交任务以服务商为准</span></> : null}
          </div>
          <div className="im-results">
            {resultIds.length === 0 ? (
              <div className="st-empty" style={{ gridColumn: "1 / -1" }}>
                <IcBrush size={28} />
                <b>还没有结果</b>
                <span>生成后结果自动存入资产库；可设为角色参考 / 场景图 / 绑定片段。</span>
              </div>
            ) : null}
            {resultIds.map((id) => {
              const a = assets.find((x) => x.id === id);
              if (!a) return null;
              return (
                <div key={id} className="im-result" title={a.prompt?.slice(0, 80)}>
                  <Thumb src={assetUrl(a.path)} style={{ width: "100%" }} />
                  <div style={{ display: "flex", gap: 4, padding: 6, flexWrap: "wrap" }}>
                    <button className="st-btn sm" title="在 H3 检查器把它绑到当前选中片段的参考图槽" disabled={!seg} onClick={() => bindToSegment(id)}>
                      <IcLink size={11} /> 绑片段
                    </button>
                    <button
                      className="st-btn sm"
                      title="设为第一个角色的参考图（正面位）"
                      disabled={!project.characters.length}
                      onClick={() => {
                        const c = project.characters[0];
                        useDirector.getState().updateProject(project.id, {
                          characters: project.characters.map((x) =>
                            x.id === c.id
                              ? { ...x, assetIds: [...(x.assetIds ?? []), id], refViews: { ...(x.refViews ?? {}), front: [...(x.refViews?.front ?? []), id] } }
                              : x,
                          ),
                        });
                        useUi.getState().toast?.(`已加到角色「${c.name}」的正面参考`, "ok");
                      }}
                    >
                      <IcPerson size={11} /> 角色参考
                    </button>
                    <button
                      className="st-btn sm"
                      title="设为项目全局参考图槽（所有片段可用）"
                      onClick={() => {
                        useDirector.getState().updateProject(project.id, {
                          globalSlots: [...project.globalSlots, { semantic: "referenceImage" as const, assetIds: [id], auto: false }],
                        });
                        useUi.getState().toast?.("已加入项目全局参考槽", "ok");
                      }}
                    >
                      <IcFilmFrame size={11} /> 场景参考
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* 右：当前结果操作（结果与版本） */}
      <DockPanel className="im-right" title="结果与版本" projectId={project.id} widthKey="imRight" width={project.studioUi?.panelWidths?.imRight ?? 280}>
        <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="st-hint">
            <IcImage size={11} style={{ verticalAlign: -1 }} /> 结果自动存入资产库（成组、带项目来源，可反向定位）。
          </span>
          {resultIds.length ? (
            <>
              <button className="st-btn sm" onClick={() => setConfirmOpen(true)} disabled={busy}>
                <IcRefresh size={12} /> 同参数重跑
              </button>
              <button
                className="st-btn sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(prompt);
                  useUi.getState().toast?.("提示词已复制", "ok");
                }}
              >
                复制提示词
              </button>
            </>
          ) : (
            <span className="st-hint">生成后在历史里可随时复用参数（含引擎 / 模型 / 画幅 / 种子）。</span>
          )}
        </div>
      </DockPanel>

      {/* 远程计费确认（§10.2 远程付费生成必须确认） */}
      {confirmOpen ? (
        <div className="st-diff-mask" onClick={() => setConfirmOpen(false)}>
          <div className="st-diff" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
            <div className="st-diff-h"><IcSparkles size={15} /> 生成请求确认</div>
            <div style={{ padding: "14px 16px", fontSize: 12.5, lineHeight: 1.8, color: "var(--studio-text-2)" }}>
              {pending?.engine==="provider"?"远程模型":"本地 ComfyUI 配方"}：{pending?.providerModelKey||pending?.recipeId||"默认模型"}；{pending?.engine==="comfy"?"一次配方（输出张数由工作流决定）":`${pending?.n} 张`}；{pending?.aspect||"自动画幅"}。
              <p>参考图 {pending?.inputAssetIds.length} 张，顺序与上方一致。远程提交后可能产生费用。</p>
              <details open><summary>实际提示词</summary><pre style={{whiteSpace:"pre-wrap",maxHeight:260,overflow:"auto"}}>{pending?.finalPrompt}</pre></details>

            </div>
            <div className="st-diff-f">
              <button className="st-btn" onClick={() => setConfirmOpen(false)}>取消</button>
              <button className="st-btn primary" onClick={() => void run()}><IcCheck size={13} /> 确认生成</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
