/**
 * 项目级 Skill 绑定卡（导演台 3.0）— 旧分镜页绑定卡在新壳的回归 + 引擎路由
 *
 *  - 绑定列表：启停 / 生效范围（全部引擎 · 仅本地 ComfyUI · 仅外调远程）/ 模型关键词匹配；
 *  - 变量编辑：Skill 声明的变量就地填值（随绑定持久化）；
 *  - 候选筛选：contexts 命中 director.project / director.segment / studio.* 的已启用 Skill；
 *  - 路由徽标：按当前片段配方的路线（本地/外调）显示「本路线生效 N/M」。
 * 双路线语义：H3 六段式 Skill 设「仅本地」，外调规范 Skill（内置「外调视频提示词规范」）
 * 设「仅外调」——同项目混用 Kling / Veo / 本地 H3 时各吃各的栈，互不污染。
 */
import { useMemo, useState } from "react";
import { useDirector } from "../../../core/stores/directorStore";
import { ENGINE_ICONS } from "./selectIcons";
import { useSkills } from "../../../core/stores/skillStore";
import { defaultSkillValues } from "../../../core/skillEngine";
import { purposeOfSkill, routeCtxOfRecipe, routeSkillBindings } from "../../../core/studio/skillRoute";
import { SKILL_PURPOSE_LABEL } from "../../../core/skillTypes";
import { PopSelect } from "../../../ui/PopSelect";
import { IcPlus, IcTrash, IcCheck, IcWand } from "../../../ui/icons";
import type { DirectorProject } from "../../../core/types";
import type { SkillBinding, SkillContext } from "../../../core/skillTypes";
import { SKILL_CONTEXT_LABEL } from "../../../core/skillTypes";

/** 候选 Skill 的 contexts 筛选口径（项目级 + 新工位扩展点） */
const BINDABLE_CONTEXTS = ["director.project", "director.segment", "studio.director", "studio.image", "studio.mv", "prompt.video", "prompt.image"];

/**
 * 工位 Skill 生效徽标：显示当前工位 context 命中且启用的绑定（引擎路由后），
 * 点击跳 H3 导演台的「Skill 栈」分组统一管理（单一入口，§3.2）。
 */
export function SkillStationBadge({ project, context }: { project: DirectorProject; context: SkillContext }) {
  const updateProject = useDirector((s) => s.updateProject);
  const skills = useSkills((s) => s.skills);
  const active = useMemo(() => {
    return (project.skillBindings ?? []).filter((b) => {
      if (!b.enabled) return false;
      const sk = skills.find((s) => s.id === b.skillId);
      return sk?.enabled && sk.contexts.includes(context);
    });
  }, [project.skillBindings, skills, context]);
  if (!active.length) return null;
  const label = SKILL_CONTEXT_LABEL[context];
  return (
    <button
      className="st-pill accent"
      style={{ border: 0, cursor: "pointer" }}
      title={`${label}已生效 ${active.length} 个 Skill：${active.map((b) => skills.find((s) => s.id === b.skillId)?.name).join("、")}\n点击前往 H3 导演台的「Skill 栈」管理`}
      onClick={() => updateProject(project.id, { studioUi: { ...(project.studioUi ?? { station: "h3" }), station: "h3", inspectorOpen: { ...(project.studioUi?.inspectorOpen ?? {}), skills: true } } })}
    >
      <IcWand size={10} /> Skill ×{active.length}
    </button>
  );
}

const SCOPE_OPTIONS = [
  { value: "all", label: "全部引擎" },
  { value: "local", label: "仅本地 ComfyUI（H3/LTX）" },
  { value: "remote", label: "仅外调远程（Kling/Veo/Claude）" },
];

export function SkillBindingCard({ project }: { project: DirectorProject }) {
  const updateProject = useDirector((s) => s.updateProject);
  const skills = useSkills((s) => s.skills);
  const [adding, setAdding] = useState(false);
  const [openVars, setOpenVars] = useState<string | null>(null);

  const bindings = project.skillBindings ?? [];
  const candidates = useMemo(
    () => skills.filter((s) => s.enabled && s.contexts.some((c) => BINDABLE_CONTEXTS.includes(c)) && !bindings.some((b) => b.skillId === s.id)),
    [skills, bindings],
  );

  /** 当前片段配方的路线徽标（本地/外调各生效几个） */
  const routed = useMemo(() => {
    const seg = project.scenes.flatMap((s) => s.segments).find((x) => x.id === project.studioUi?.segId) ?? project.scenes[0]?.segments[0];
    const recipe = seg
      ? project.recipes.find((r) => r.id === (seg.recipeId ?? project.defaultRecipeId))
      : project.recipes.find((r) => r.id === project.defaultRecipeId);
    const ctx = routeCtxOfRecipe(project, recipe);
    return {
      ctx,
      local: routeSkillBindings(project, { ...ctx, engine: "local" }).length,
      remote: routeSkillBindings(project, { ...ctx, engine: "remote" }).length,
    };
  }, [project]);

  const patchBinding = (skillId: string, patch: Partial<SkillBinding>) => {
    updateProject(project.id, {
      skillBindings: bindings.map((b) => (b.skillId === skillId ? { ...b, ...patch } : b)),
    });
  };

  const addBinding = (skillId: string) => {
    const sk = skills.find((s) => s.id === skillId);
    if (!sk) return;
    setAdding(false);
    updateProject(project.id, {
      skillBindings: [...bindings, { skillId, enabled: true, values: defaultSkillValues(sk) }],
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="st-row between">
        <span className="st-hint">
          本路线生效 {routed.ctx.engine === "local" ? routed.local : routed.remote} / {bindings.filter((b) => b.enabled).length} 个
          （{routed.ctx.engine === "local" ? `本地 ${routed.ctx.templateName ?? "ComfyUI 配方"}` : `外调 ${routed.ctx.model ?? "远程模型"}`}）
        </span>
        <button className="st-btn sm" onClick={() => setAdding(!adding)} disabled={!candidates.length && !adding} title="把 Skill 绑定到本项目（可设生效引擎路线）">
          <IcPlus size={11} /> 绑定 Skill
        </button>
      </div>

      {adding ? (
        <div style={{ border: "1px solid var(--studio-border)", borderRadius: 5, padding: 6, display: "flex", flexDirection: "column", gap: 4 }}>
          {candidates.length === 0 ? <span className="st-hint">没有可绑定的新 Skill——先在 Skill 管理器导入并启用。</span> : null}
          {candidates.map((s) => (
            <button key={s.id} className="st-btn sm ghost" style={{ justifyContent: "flex-start" }} title={s.description} onClick={() => addBinding(s.id)}>
              <IcWand size={12} /> {s.name}
              <span className="st-hint">{s.contexts.filter((c) => BINDABLE_CONTEXTS.includes(c)).length} 个适用位置 · v{s.version}</span>
            </button>
          ))}
        </div>
      ) : null}

      {bindings.length === 0 && !adding ? (
        <span className="st-hint">
          未绑定 Skill。推荐组合：H3 六段式提示词 Skill（仅本地）+ 内置「外调视频提示词规范」（仅外调）。
        </span>
      ) : null}

      {bindings.map((b) => {
        const sk = skills.find((s) => s.id === b.skillId);
        if (!sk) {
          return (
            <div key={b.skillId} className="st-row between" style={{ padding: "4px 0" }}>
              <span className="st-hint">Skill 已被删除（绑定残留）</span>
              <button className="st-iconbtn" style={{ width: 24, height: 24 }} title="移除残留绑定" onClick={() => updateProject(project.id, { skillBindings: bindings.filter((x) => x.skillId !== b.skillId) })}>
                <IcTrash size={12} />
              </button>
            </div>
          );
        }
        const hasVars = sk.variables.length > 0;
        const purpose = purposeOfSkill(sk);
        return (
          <div key={b.skillId} style={{ border: "1px solid var(--studio-border)", borderRadius: 5, padding: "6px 8px", display: "flex", flexDirection: "column", gap: 6, opacity: b.enabled ? 1 : 0.55 }}>
            <div className="st-row between">
              <label className="st-hint" style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: "var(--studio-text-1)" }}>
                <input type="checkbox" checked={b.enabled} onChange={(e) => patchBinding(b.skillId, { enabled: e.target.checked })} />
                {sk.name}
                <span
                  className="st-pill"
                  title={`职能：${SKILL_PURPOSE_LABEL[purpose]}${purpose === "script-plan" || purpose === "project-package" ? "（只进拆分/导出链路，不进生成提示词）" : purpose.startsWith("compile") ? "（生成提示词栈的模型方言）" : ""}`}
                >
                  {SKILL_PURPOSE_LABEL[purpose]}
                </span>
              </label>
              <div className="st-row" style={{ gap: 2 }}>
                {hasVars ? (
                  <button className="st-iconbtn" style={{ width: 24, height: 24 }} title="编辑变量值" onClick={() => setOpenVars(openVars === b.skillId ? null : b.skillId)}>
                    <IcWand size={12} />
                  </button>
                ) : null}
                <button className="st-iconbtn" style={{ width: 24, height: 24 }} title="移除绑定（Skill 本体保留）" onClick={() => updateProject(project.id, { skillBindings: bindings.filter((x) => x.skillId !== b.skillId) })}>
                  <IcTrash size={12} />
                </button>
              </div>
            </div>
            <div className="st-row" style={{ gap: 6 }}>
              <PopSelect
                value={b.scope ?? "all"}
                onChange={(v) => patchBinding(b.skillId, { scope: v as SkillBinding["scope"] })}
                triggerIcon
                options={SCOPE_OPTIONS.map((s) => ({ value: s.value, label: s.label, icon: ENGINE_ICONS[s.value as keyof typeof ENGINE_ICONS] }))}
              />
              <input
                className="st-input"
                style={{ flex: 1, minWidth: 0, height: 26 }}
                placeholder="模型/模板关键词，如 H3,LTX"
                value={b.modelPattern ?? ""}
                onChange={(e) => patchBinding(b.skillId, { modelPattern: e.target.value || undefined })}
                title="逗号分隔的关键词，命中模型名或配方名才生效；留空匹配该路线全部引擎"
              />
            </div>
            {b.scope === "local" || b.scope === "remote" || b.modelPattern ? (
              <span className="st-hint" style={{ fontSize: 10.5 }}>
                {b.scope === "local" ? "本地 ComfyUI 配方生成时注入" : b.scope === "remote" ? "外调远程模型生成时注入" : "全部引擎注入"}
                {b.modelPattern ? ` · 仅匹配「${b.modelPattern}」` : ""}
              </span>
            ) : null}
            {openVars === b.skillId ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid var(--studio-border)", paddingTop: 6 }}>
                {sk.variables.map((v) => (
                  <div key={v.key} className="st-field">
                    <label>{v.label}{v.required ? " *" : ""}</label>
                    {v.type === "select" ? (
                      <PopSelect
                        value={String(b.values[v.key] ?? v.default ?? "")}
                        onChange={(x) => patchBinding(b.skillId, { values: { ...b.values, [v.key]: x } })}
                        triggerIcon
                        options={v.options?.map((o) => ({ value: o, label: o, icon: ENGINE_ICONS.all })) ?? []}
                      />
                    ) : v.type === "boolean" ? (
                      <input type="checkbox" checked={!!b.values[v.key]} onChange={(e) => patchBinding(b.skillId, { values: { ...b.values, [v.key]: e.target.checked } })} />
                    ) : (
                      <input
                        className="st-input"
                        type={v.type === "number" ? "number" : "text"}
                        value={String(b.values[v.key] ?? "")}
                        title={v.hint}
                        onChange={(e) => patchBinding(b.skillId, { values: { ...b.values, [v.key]: v.type === "number" ? Number(e.target.value) : e.target.value } })}
                      />
                    )}
                  </div>
                ))}
                <button className="st-btn sm" onClick={() => setOpenVars(null)}><IcCheck size={11} /> 完成</button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
