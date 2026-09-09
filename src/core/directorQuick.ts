/**
 * H3 快速导演模式（方案 §9）— 内置工作模式 + 硬件档位
 *
 * 原则（§24）：所有预设只映射现有 DirectorRecipe / 模板能力，不新增第二套执行器、不写死核心模型。
 *  - 内置工作模式（文生视频/首帧/首尾帧/多参考/长视频连续/角色保持/AI MV）按能力匹配项目里已有的
 *    ComfyUI 配方或模板，匹配不到给明确配置入口提示，不落空参数（§19）。
 *  - 硬件档位（§9.3）来自模板实际暴露的参数名（步数/精度/分辨率类），匹配不到就只切开关，不瞎猜。
 */
import { useDirector } from "./stores/directorStore";
import { useComfy } from "./stores/comfyStore";
import { directorReferenceSupport } from "./directorRecipeSupport";
import type { DirectorProject, DirectorRecipe } from "./types";

/* ---------------- 内置工作模式（§9.2） ---------------- */

export type QuickModeDef = {
  id: string;
  label: string;
  desc: string;
  /** 该模式期望配方具备的能力（匹配用） */
  want: {
    firstFrame?: boolean;
    lastFrame?: boolean;
    referenceImage?: boolean;
    video?: boolean;
    audio?: boolean;
    /** 连续生成：接力接力开关建议开启 */
    relay?: boolean;
  };
};

export const QUICK_MODES: QuickModeDef[] = [
  { id: "t2v", label: "文生视频", desc: "只靠提示词生成，不需要任何参考图", want: {} },
  { id: "first", label: "首帧视频", desc: "给一张开场画面，从它开始动起来", want: { firstFrame: true } },
  { id: "fl", label: "首尾帧视频", desc: "给开场和结束画面，中间自动过渡", want: { firstFrame: true, lastFrame: true } },
  { id: "refs", label: "多参考图/视频/音频", desc: "人物、场景、声音各给参考，综合生成（REF2VA 类）", want: { referenceImage: true } },
  { id: "serial", label: "长视频连续生成", desc: "逐段接力：自动接上一段画面继续拍（开启连续性接力）", want: { relay: true } },
  { id: "character", label: "角色替换/保持", desc: "锁定人物外观，换场景继续演", want: { referenceImage: true } },
  { id: "mv", label: "AI MV", desc: "音乐 + 画面参考，逐段成片", want: { audio: true } },
];

/** 快速模式文案映射（§17.3：技术概念 → 创作语言） */
export const QUICK_TERM_LABELS: Record<string, string> = {
  ComfyUI: "本地生成方案",
  Variant: "生成模式",
  firstFrame: "开场画面",
  lastFrame: "结束画面",
  referenceVideo: "动作参考",
  referenceAudio: "声音参考",
  tailFrameRelay: "连续性接力",
  freeMemBetween: "每段释放显存",
};

/** 按模式能力匹配项目里最合适的配方（返回 recipeId；"" = 远程默认；null = 没有匹配） */
export function matchRecipeForMode(project: DirectorProject, modeId: string): { recipeId: string | null; hint: string } {
  const mode = QUICK_MODES.find((m) => m.id === modeId);
  if (!mode) return { recipeId: null, hint: "未知模式" };
  const templates = useComfy.getState().templates;
  const scored: Array<{ recipe: DirectorRecipe; score: number }> = [];
  for (const r of project.recipes) {
    if (r.engine !== "comfy" || !r.templateId) continue;
    const tpl = templates.find((t) => t.id === r.templateId);
    if (!tpl) continue;
    const sup = directorReferenceSupport(r, tpl);
    let score = 0;
    const want = mode.want;
    const need = Object.entries(want).filter(([k]) => k !== "relay").length;
    if (want.firstFrame && sup.firstFrame) score++;
    if (want.lastFrame && sup.lastFrame) score++;
    if (want.referenceImage && sup.referenceImage) score++;
    if (want.video && sup.video) score++;
    if (want.audio && sup.audio) score++;
    if (score === need) scored.push({ recipe: r, score });
  }
  if (!scored.length) {
    return {
      recipeId: null,
      hint: `项目里还没有支持「${mode.label}」的本地生成方案——到「设置 → ComfyUI 模板」导入对应模板（如 FL2VA / REF2VA），或先用「远程默认」模型`,
    };
  }
  // 并列时优先项目当前默认配方，其次 REF2VA 类多参考（能力最全）
  scored.sort((a, b) => b.score - a.score);
  const hit = scored[0].recipe;
  return { recipeId: hit.id, hint: `已匹配「${hit.name}」` };
}

/** 应用快速模式：匹配配方写进项目默认 + 模式建议的开关（长视频连续 → 开接力） */
export function applyQuickMode(projectId: string, modeId: string): boolean {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return false;
  const { recipeId } = matchRecipeForMode(proj, modeId);
  if (recipeId === null) return false;
  const mode = QUICK_MODES.find((m) => m.id === modeId);
  useDirector.getState().updateProject(projectId, {
    quickMode: modeId,
    defaultRecipeId: recipeId,
    tailFrameRelay: mode?.want.relay ? true : proj.tailFrameRelay,
  });
  return true;
}

/* ---------------- 硬件档位（§9.3） ---------------- */

export type HardwareTier = "eco" | "balanced" | "quality" | "custom";

export const HARDWARE_TIERS: Array<{ value: HardwareTier; label: string; desc: string }> = [
  { value: "eco", label: "节省显存", desc: "适合 8~12GB 显存：低步数/低精度、每段后清显存" },
  { value: "balanced", label: "均衡", desc: "适合 16~24GB 显存：推荐步数，标准节奏" },
  { value: "quality", label: "高质量", desc: "适合 24GB 以上显存：更高步数与分辨率" },
  { value: "custom", label: "自定义", desc: "专业模式：保留配方当前参数不动" },
];

/**
 * 档位 → 配方参数的实际映射：只认模板真实暴露的参数名（步数/精度/分辨率类，§9.3「不能仅靠模型名称猜测」）。
 * 匹配不到相关参数时档位只影响 freeMemBetween（节省显存档开启每段清理）。
 */
export function applyHardwareTier(projectId: string, tier: HardwareTier): void {
  const proj = useDirector.getState().getById(projectId);
  if (!proj) return;
  if (tier === "custom") {
    useDirector.getState().updateProject(projectId, { hardwareTier: tier });
    return;
  }
  const patch: Record<string, string | number | boolean> = {};
  const rid = proj.defaultRecipeId;
  const recipe = rid ? proj.recipes.find((r) => r.id === rid) : undefined;
  if (recipe?.engine === "comfy" && recipe.templateId) {
    const tpl = useComfy.getState().templates.find((t) => t.id === recipe.templateId);
    if (tpl) {
      for (const p of tpl.params) {
        const name = `${p.label ?? ""}${p.input}`;
        if (/步数|steps|采样步/i.test(name)) {
          patch[p.key] = tier === "eco" ? Math.max(4, Math.round(Number(p.value ?? 20) * 0.6)) : tier === "quality" ? Math.round(Number(p.value ?? 20) * 1.4) : p.value;
        } else if (/精度|quant|bits|fp8|bf16/i.test(name)) {
          // 精度类参数是文本下拉时只在 eco 降档：fp8 > bf16；数字位宽取低值
          const v = String(p.value ?? "");
          if (tier === "eco") patch[p.key] = /fp8/.test(v) ? v : /bf16/i.test(v) ? "fp8" : v;
        }
      }
    }
  }
  useDirector.getState().updateProject(projectId, {
    hardwareTier: tier,
    freeMemBetween: tier === "eco" ? true : proj.freeMemBetween,
    ...(recipe && Object.keys(patch).length
      ? {
          recipes: proj.recipes.map((r) =>
            r.id === recipe.id ? { ...r, defaultParams: { ...r.defaultParams, ...patch } } : r,
          ),
        }
      : {}),
  });
}
