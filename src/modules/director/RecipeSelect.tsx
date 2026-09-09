/**
 * 生成配方统一选择器 — 导演台所有配方下拉共用（UI 规范：下拉选项一律图标 + 文字）
 *
 *  - 选项：远程默认 / 已有配方 / 未建配方的 ComfyUI 模板（直选自动建配方）
 *  - 模板被删除 → 引用它的配方自动清理（pruneDeadRecipes，任何下拉挂载/模板变化时执行）
 *  - 末项「管理配方…」打开配方管理弹窗（生成页不再常驻配方卡，入口收进下拉）
 *  - target："project" 写项目默认配方；"segment" 写单段配方（生成时 片段 > 项目 > 远程默认）
 */
import { useEffect, useMemo, useState } from "react";
import { useDirector } from "../../core/stores/directorStore";
import { useComfyTemplates } from "../../core/stores/comfyStore";
import { resolveRecipeSelection, type ComfyTplLike } from "../../core/directorEngine";
import { MODE_LABEL, profileForRecipe } from "../../core/studio/capabilityProfile";
import { PopSelect } from "../../ui/PopSelect";
import { IcGlobe, IcFlow, IcGear } from "../../ui/icons";
import { RecipeManagerDialog, pruneDeadRecipes } from "./RecipeManager";
import type { DirectorProject } from "../../core/types";

const MANAGE = "__manage__";

/** 配方下拉选项：图标 + 文字（3.3 §9.1：标注模式/时长/音画；官方适配未贯通的远程配方明确「通用协议」） */
export function recipeOptions(
  project: DirectorProject,
  templates: ComfyTplLike[],
): Array<{ value: string; label: string; icon: React.ReactNode; disabled?: boolean }> {
  const withRecipe = new Set(project.recipes.map((r) => r.templateId).filter((v): v is string => !!v));
  const tplName = (id?: string) => templates.find((t) => t.id === id)?.name;
  return [
    { value: "", label: "远程默认（设置里的视频模型 · 通用协议）", icon: <IcGlobe size={14} /> },
    ...project.recipes.map((r) => {
      const p = profileForRecipe(r, tplName(r.templateId));
      const official = p.channel === "local" || p.officialAdapter;
      return {
        value: r.id,
        label: `${r.name} · ${MODE_LABEL[r.mode] ?? r.mode} · ≤${p.duration.max}s${p.output.nativeAudio ? " · 音画" : ""}${official ? "" : p.adapterReady ? " · 官方适配器待联调" : " · 通用协议"}`,
        icon: r.engine === "comfy" ? <IcFlow size={14} /> : <IcGlobe size={14} />,
      };
    }),
    ...templates
      .filter((t) => !withRecipe.has(t.id))
      .map((t) => ({ value: `tpl:${t.id}`, label: `${t.name} · ComfyUI 模板`, icon: <IcFlow size={14} /> })),
  ];
}

export function RecipeSelect({
  project,
  target,
  segmentId,
  className,
  title,
}: {
  project: DirectorProject;
  /** project = 写项目默认配方（顶栏/批量条）；segment = 写单段配方（需给 segmentId） */
  target: "project" | "segment";
  segmentId?: string;
  className?: string;
  title?: string;
}) {
  const templates = useComfyTemplates();
  const updateProject = useDirector((s) => s.updateProject);
  const [manageOpen, setManageOpen] = useState(false);

  // 模板被删除的配方自动清理（多实例挂载幂等：有死配方才写回）
  useEffect(() => {
    pruneDeadRecipes(project.id);
  }, [project.id, templates]);

  const value = useMemo(() => {
    if (target === "project") return project.defaultRecipeId ?? "";
    const seg = project.scenes.flatMap((s) => s.segments).find((g) => g.id === segmentId);
    return seg?.recipeId ?? "";
  }, [target, segmentId, project]);

  const options = useMemo(
    () => [...recipeOptions(project, templates), { value: MANAGE, label: "管理配方…", icon: <IcGear size={14} /> }],
    [project, templates],
  );

  const pick = (v: string) => {
    if (v === MANAGE) {
      setManageOpen(true);
      return;
    }
    const sel = resolveRecipeSelection(project, v, templates);
    // 模板直选会新建配方（recipes 增量）与选择动作一次写回；读最新项目防覆盖期间的其它改动
    const cur = useDirector.getState().getById(project.id);
    if (!cur) return;
    if (target === "project") {
      updateProject(project.id, { ...(sel.recipes ? { recipes: sel.recipes } : {}), defaultRecipeId: sel.recipeId });
    } else if (segmentId) {
      updateProject(project.id, {
        ...(sel.recipes ? { recipes: sel.recipes } : {}),
        scenes: cur.scenes.map((s) => ({
          ...s,
          segments: s.segments.map((g) => (g.id === segmentId ? { ...g, recipeId: sel.recipeId } : g)),
        })),
      });
    }
  };

  return (
    <>
      <PopSelect
        className={className}
        title={title ?? "生成配方：远程模型，或本地 ComfyUI 模板（选择模板自动建配方）"}
        value={value}
        options={options}
        triggerIcon
        onChange={pick}
      />
      {manageOpen ? <RecipeManagerDialog projectId={project.id} onClose={() => setManageOpen(false)} /> : null}
    </>
  );
}
