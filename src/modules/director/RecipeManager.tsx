/**
 * 配方管理弹窗 — 从配方下拉的「管理配方…」打开（生成页不再常驻配方卡）
 *
 *  - 配方 = 调用方式（本地 ComfyUI 模板 / 远程模型 + 模式），模板直选会自动建配方，这里只作高级微调
 *  - 模板被删除 → 引用它的配方连带项目默认/片段上的引用一并自动清理（不留「模板已删除」残骸）
 *  - 编辑字段上下排布（每行：标签 + 控件）
 */
import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useDirector } from "../../core/stores/directorStore";
import { useComfy, useComfyTemplates } from "../../core/stores/comfyStore";
import { useSettings } from "../../core/stores/settingsStore";
import { toast } from "../../core/stores/uiStore";
import { isVideoLoaderClass, isAudioLoaderClass } from "../../core/services/comfy";
import { MODE_LABEL as MODE_LABELS } from "../../core/studio/capabilityProfile";
import { uid } from "../../core/utils";
import { IcClose, IcWand, IcZap, IcPlus, IcGlobe, IcFlow, IcImage, IcVideo, IcText, IcLayers, IcFilmFrame } from "../../ui/icons";
import { PopSelect } from "../../ui/PopSelect";
import type { DirectorRecipe } from "../../core/types";

/**
 * 清理模板已删除的死配方：配方直接删掉，并连带清项目默认配方 / 片段上指向它们的引用。
 * 幂等（没有死配方时不写回）；RecipeSelect 与配方管理都会调用，删完模板即刻生效。
 */
export function pruneDeadRecipes(projectId: string): void {
  const cur = useDirector.getState().getById(projectId);
  if (!cur) return;
  const exists = new Set(useComfy.getState().templates.map((t) => t.id));
  const dead = new Set(
    cur.recipes.filter((r) => r.engine === "comfy" && !!r.templateId && !exists.has(r.templateId)).map((r) => r.id),
  );
  if (!dead.size) return;
  const scenes = cur.scenes.map((s) => ({
    ...s,
    segments: s.segments.map((g) => (g.recipeId && dead.has(g.recipeId) ? { ...g, recipeId: undefined } : g)),
  }));
  useDirector.getState().updateProject(projectId, {
    recipes: cur.recipes.filter((r) => !dead.has(r.id)),
    scenes,
    ...(cur.defaultRecipeId && dead.has(cur.defaultRecipeId) ? { defaultRecipeId: undefined } : {}),
  });
  toast(`已自动清理 ${dead.size} 个模板已删除的配方`, "info");
}

/** 配方模式徽章文案（单一来源：capabilityProfile 的 MODE_LABEL，3.3 模式补全） */
const MODE_LABEL = MODE_LABELS;

export function RecipeManagerDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const project = useDirector((s) => s.projects.find((p) => p.id === projectId));
  const updateProject = useDirector((s) => s.updateProject);
  const templates = useComfyTemplates();
  const providers = useSettings((s) => s.settings.models.providers);
  const videoModels = useMemo(
    () =>
      providers.flatMap((p) =>
        (p.models.video?.models ?? []).map((m) => ({ key: `${p.id}::${m}`, label: `${p.name} · ${m}` })),
      ),
    [providers],
  );
  // Esc 关闭；打开即清理模板已删除的死配方
  useEffect(() => {
    pruneDeadRecipes(projectId);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [projectId, onClose]);

  if (!project) return null;
  const updateRecipes = (recipes: DirectorRecipe[]) => updateProject(project.id, { recipes });

  const addRecipe = () => {
    const recipe: DirectorRecipe = {
      id: uid(6),
      name: "新配方",
      engine: "comfy",
      output: "video",
      mode: "i2v",
      defaultParams: {},
    };
    updateRecipes([...project.recipes, recipe]);
  };

  /** 从已导入的 H3 模板一键建配方：按模板真实节点判职能（3.3 §2.3 修复）——
   *  文生图模板（无视频/音频入口）建成 image 配方，不再误标成 fl2v 视频配方；
   *  REF2VA/含视频入口 → r2v；L2VA → l2v（仅尾帧反推）；其余 FL2VA → fl2v。同模板不重复。 */
  const addH3Recipes = () => {
    const h3 = templates.filter((t) => /MiniMax[_ ]?H3|T2VA|I2VA|FL2VA|L2VA|REF2VA/i.test(t.name));
    if (!h3.length) {
      toast("没有找到 H3 模板——请先在「设置 → ComfyUI 模板」导入 MiniMax H3 工作流 JSON（前端格式可直接导入）", "info");
      return;
    }
    const exist = new Set(project.recipes.map((r) => r.templateId));
    const added: DirectorRecipe[] = [];
    for (const t of h3) {
      if (exist.has(t.id)) continue;
      const types = Object.values(t.workflow as Record<string, { class_type?: string }>).map((n) => n?.class_type ?? "");
      const hasVideo = types.some(isVideoLoaderClass);
      const hasAudio = types.some(isAudioLoaderClass);
      // 模式判定（按真实节点 + 名字特征，3.3 §2.3）：
      //  T2VA 文生音视频——无媒体入口但确是视频模板 → t2v；
      //  文生图 / 无任何媒体入口且非 T2VA → image 配方（不再误标 fl2v 视频）；
      //  REF2VA 或含视频入口 → r2v；L2VA 仅尾帧 → l2v；其余 FL2VA → fl2v。
      const nameT2V = /T2VA|文生视频/i.test(t.name);
      const nameImg = /文生图/i.test(t.name);
      const noMediaEntry = !hasVideo && !hasAudio;
      if (nameImg || (noMediaEntry && !nameT2V)) {
        added.push({
          id: uid(6),
          name: t.name,
          engine: "comfy",
          output: "image",
          mode: "t2i",
          templateId: t.id,
          defaultParams: {},
        });
        continue;
      }
      const isL2V = /(?<![FR])L2VA|仅尾帧/i.test(t.name) && !hasVideo;
      const isR2V = !nameT2V && (/REF2VA|多参考/i.test(t.name) || hasVideo);
      added.push({
        id: uid(6),
        name: t.name,
        engine: "comfy",
        output: "video",
        mode: nameT2V ? "t2v" : isL2V ? "l2v" : isR2V ? "r2v" : "fl2v",
        templateId: t.id,
        capabilitySnapshot: {
          firstFrame: !nameT2V,
          lastFrame: !isR2V && !nameT2V,
          referenceImages: nameT2V ? 0 : 4,
          referenceVideos: hasVideo ? 3 : 0,
          referenceAudio: hasAudio ? 3 : 0,
          nativeAudio: true,
        },
        defaultParams: {},
      });
    }
    if (!added.length) {
      toast("H3 配方已存在（同模板不重复创建）", "info");
      return;
    }
    updateRecipes([...project.recipes, ...added]);
    toast(`已添加 ${added.length} 个 H3 配方：${added.map((r) => `${r.name}（${r.output === "image" ? "图片" : r.mode}）`).join("、")}`, "ok");
  };

  const updateRecipe = (id: string, patch: Partial<DirectorRecipe>) => {
    updateRecipes(project.recipes.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };
  const removeRecipe = (id: string) => updateRecipes(project.recipes.filter((r) => r.id !== id));

  return createPortal(
    <div
      className="ds-recipe-modal nodrag nowheel"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="ds-recipe-modal-card">
        <div className="ds-card-head">
          <span className="ds-card-ic">
            <IcWand size={16} />
          </span>
          <div>
            <div className="ds-card-title">配方管理</div>
            <div className="ds-card-desc">
              配方 = 调用方式（本地 ComfyUI 模板 / 远程模型 + 模式）。下拉里直选模板会自动建配方，只在需要微调时打开这里
            </div>
          </div>
          <span className="spacer" />
          <button className="icon-btn" title="关闭（Esc）" onClick={onClose}>
            <IcClose size={16} />
          </button>
        </div>
        <div className="ds-card-body">
          <div className="dsg-recipe-tools">
            <button className="btn sm" title="从已导入的 MiniMax H3 模板（FL2VA/REF2VA）一键建配方" onClick={addH3Recipes}>
              <IcZap size={13} /> 添加 H3 配方
            </button>
            <button className="btn sm" onClick={addRecipe}>
              <IcPlus size={13} /> 新增配方
            </button>
          </div>
          {project.recipes.length ? (
            project.recipes.map((r) => (
              <details key={r.id} className="ds-recipe">
                  <summary className="ds-recipe-summary">
                    <b>{r.name}</b>
                    <span className="dsg-recipe-badges">
                      <span className="ds-badge">{r.engine === "comfy" ? "本地 ComfyUI" : "远程 API"}</span>
                      <span className="ds-badge">{r.output === "video" ? "视频" : "图片"}</span>
                      <span className="ds-badge">{MODE_LABEL[r.mode]}</span>
                    </span>
                  </summary>
                  <div className="ds-recipe-edit nodrag">
                    <label className="ds-threed-field">
                      名称
                      <input className="input sm" value={r.name} onChange={(e) => updateRecipe(r.id, { name: e.target.value })} />
                    </label>
                    <label className="ds-threed-field">
                      引擎
                      <PopSelect
                        value={r.engine}
                        triggerIcon
                        options={[
                          { value: "comfy", label: "本地 ComfyUI", icon: <IcFlow size={14} /> },
                          { value: "provider", label: "远程 API", icon: <IcGlobe size={14} /> },
                        ]}
                        onChange={(v) => updateRecipe(r.id, { engine: v as "comfy" | "provider" })}
                      />
                    </label>
                    <label className="ds-threed-field">
                      输出
                      <PopSelect
                        value={r.output}
                        triggerIcon
                        options={[
                          { value: "image", label: "图片", icon: <IcImage size={14} /> },
                          { value: "video", label: "视频", icon: <IcVideo size={14} /> },
                        ]}
                        onChange={(v) => updateRecipe(r.id, { output: v as "image" | "video" })}
                      />
                    </label>
                    <label className="ds-threed-field">
                      模式
                      <PopSelect
                        value={r.mode}
                        triggerIcon
                        options={[
                          { value: "t2v", label: "文生视频", icon: <IcText size={14} /> },
                          { value: "i2v", label: "图生视频", icon: <IcImage size={14} /> },
                          { value: "fl2v", label: "首尾帧视频", icon: <IcFilmFrame size={14} /> },
                          { value: "r2v", label: "多参考视频", icon: <IcLayers size={14} /> },
                          { value: "t2i", label: "文生图", icon: <IcText size={14} /> },
                          { value: "i2i", label: "图生图", icon: <IcImage size={14} /> },
                        ]}
                        onChange={(v) => updateRecipe(r.id, { mode: v as DirectorRecipe["mode"] })}
                      />
                    </label>
                    {r.engine === "comfy" ? (
                      <label className="ds-threed-field">
                        ComfyUI 模板
                        <PopSelect
                          value={r.templateId ?? ""}
                          placeholder="（选择模板）"
                          triggerIcon
                          options={templates.map((t) => ({ value: t.id, label: t.name, icon: <IcFlow size={14} /> }))}
                          onChange={(v) => updateRecipe(r.id, { templateId: v || undefined })}
                        />
                      </label>
                    ) : (
                      <label className="ds-threed-field">
                        远程视频模型
                        <PopSelect
                          value={r.providerModelKey ?? ""}
                          placeholder="（选择模型）"
                          triggerIcon
                          options={videoModels.map((m) => ({ value: m.key, label: m.label, icon: <IcGlobe size={14} /> }))}
                          onChange={(v) => updateRecipe(r.id, { providerModelKey: v || undefined })}
                        />
                      </label>
                    )}
                    <button className="btn sm danger" onClick={() => removeRecipe(r.id)}>
                      删除配方
                    </button>
                  </div>
                </details>
              ))
          ) : (
            <div className="ds-empty">
              <div className="ds-empty-title">还没有配方</div>
              <div className="ds-empty-desc">不需要手动建：在顶栏或分镜页的配方下拉里直接选 ComfyUI 模板即可自动创建。</div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
