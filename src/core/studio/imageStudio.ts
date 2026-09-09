/**
 * AI 制图引擎（导演台 3.0 · 方案 §6.4）
 *
 * 文生图 / 图生图 / 图片编辑三种模式；引擎统一「本地 ComfyUI 配方 | 远程 Provider 模型」
 * ——火山 Seedream 只是 Provider 之一，不写专用逻辑。结果收录资产库（带 director 来源、
 * 可反向定位），同时写进 project.imageStudio.history（参数复用/重跑/收藏）。
 * 生成动作不内置确认闸——工位 UI 在调用前统一走费用预检确认（§10.2）。
 */
import { brandPrompt } from "../stores/designStore";
import { budgetGate } from "../capability/budget";
import { estimateCost } from "../pricing";
import { useUsage } from "../stores/usageStore";
import { isAbortError } from "../runControl";
import { generateImage } from "../services/imageGen";
import { analyzeCaps, runComfyTemplate } from "../services/comfy";
import { assetToDataUrl } from "../services/assetFiles";
import { resolveModelCard } from "../stores/settingsStore";
import { useComfy } from "../stores/comfyStore";
import { useSettings } from "../stores/settingsStore";
import { useAssets } from "../stores/assetStore";
import { useDirector } from "../stores/directorStore";
import { errMsg, uid } from "../utils";
import { jobCenter, useJobCenter } from "./jobCenter";
import { mirrorProjectAsset } from "./projectAssetRouter";
import { useUi } from "../stores/uiStore";
import { routeSkillBindings } from "./skillRoute";
import type { ImageStudioRecord } from "../types";

export type ImageStudioParams = {
  mode: "t2i" | "i2i" | "edit";
  prompt: string;
  negative?: string;
  /** 图生图/编辑输入资产 id（有序；远程走 refImages，Comfy 走 upstreamImages） */
  inputAssetIds: string[];
  /** 引擎与目标：二选一 */
  engine: "comfy" | "provider";
  recipeId?: string;
  providerModelKey?: string;
  /** 画幅 "16:9"…；远程家族按 aspect / size 折算 */
  aspect?: string;
  resolution?: string;
  n?: number;
  seed?: number;
  params?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
  /** 确认时冻结实际请求，不受随后切换画布/品牌影响 */
  finalPrompt?: string;
  confirmed?: boolean;
};

export type ImageStudioResult = { record: ImageStudioRecord; assetIds: string[] };

/** aspect → 远程 size 折算（1K 档；家族原生 aspect 走 req.aspect） */
function aspectToSize(aspect: string): string {
  const [w, h] = aspect.split(":").map((x) => Number(x) || 1);
  const long = 1024;
  const scale = long / Math.max(w, h);
  return `${Math.round(w * scale / 8) * 8}x${Math.round(h * scale / 8) * 8}`;
}

/** 与生成确认共用同一个最终提示词编译入口。 */
export function imageStudioPrompt(projectId: string, p: ImageStudioParams): string {
  const project = useDirector.getState().getById(projectId);
  if (!project) throw new Error("项目不存在");
  const skills = routeSkillBindings(project, { engine:p.engine==="comfy"?"local":"remote", model:p.providerModelKey?.split("::").pop(), templateName:project.recipes.find(r=>r.id===p.recipeId)?.name }, ["studio.image","prompt.image"]);
  return brandPrompt(project.boardId, [p.prompt,...skills.map(s=>s.system)].join("\n\n"));
}
const runningProjects = new Set<string>();

/** 执行一次制图（同步等待全部结果；进度经任务中心观察） */
export async function runImageStudio(projectId: string, p: ImageStudioParams): Promise<ImageStudioResult> {
  const project = useDirector.getState().getById(projectId);
  if (!project) throw new Error("项目不存在");
  if (!p.prompt.trim()) throw new Error("请先填写提示词");
  if (p.mode !== "t2i" && !p.inputAssetIds.length) throw new Error(p.mode === "i2i" ? "图生图需要至少一张输入图" : "图片编辑需要至少一张输入图");

  if(runningProjects.has(projectId)) throw new Error("本项目已有制图任务，请等待或停止后重试");
  p = {...p,inputAssetIds:[...p.inputAssetIds],params:{...p.params},finalPrompt:p.finalPrompt ?? imageStudioPrompt(projectId,p)};
  const controller=new AbortController();
  const signal=p.signal ? AbortSignal.any([p.signal,controller.signal]) : controller.signal;
  signal.throwIfAborted();
  const card=p.engine==="provider"?resolveModelCard("image",p.providerModelKey):undefined;
  if(card){const gate=budgetGate(estimateCost(card.model,{images:p.n??1}),"AI 制图");if(gate.block)throw new Error(gate.block);if(!p.confirmed)throw new Error(gate.confirm || "请先确认本次生成请求");}
  runningProjects.add(projectId);
  const t0 = Date.now();
  const label = p.mode === "t2i" ? "文生图" : p.mode === "i2i" ? "图生图" : "图片编辑";
  const job = jobCenter.begin({ projectId, kind: "image", label: `${label} · ${p.prompt.slice(0, 18)}`, cancellable:true, cancelRun:()=>controller.abort(), retryNote:"按原提示词、模型和参考图重试；远程再次提交可能计费。",retryRun:async()=>{await runImageStudio(projectId,{...p,signal:undefined,confirmed:true});} });

  try {
    const refImages: string[]=[];
    if(p.mode!=="t2i") for(const id of p.inputAssetIds){
      signal.throwIfAborted();
      const a=useAssets.getState().items.find(x=>x.id===id);
      if(!a || a.kind!=="image") throw new Error(`参考图已丢失：${id}，请重新选择`);
      refImages.push(await assetToDataUrl(a.path,a.mime));
    }
    signal.throwIfAborted();
    let outputUrls: string[]=[];
    const finalPrompt=p.finalPrompt!;
    if (p.engine === "comfy") {
      // 本地 ComfyUI：配方模板 + 参考图按序投喂（复用画布同一执行层）
      const recipe = project.recipes.find((r) => r.id === p.recipeId);
      if (!recipe?.templateId) throw new Error("请选择一个本地 ComfyUI 图片配方（或切换到远程引擎）");
      const tpl = useComfy.getState().templates.find((t) => t.id === recipe.templateId);
      if (!tpl) throw new Error("配方引用的模板已不存在，请先在模板管理里恢复");
      const host = useSettings.getState().settings.comfy.host || "http://127.0.0.1:8188";
      job.stage("ComfyUI 队列（本地引擎）");
      const values={...(recipe.defaultParams??{}),...(p.params??{})};
      // 明确写正/负文本入口，防配方中的非空旧值覆盖工位最终提示词。
      const runtime=structuredClone(tpl);
      const textEntries=analyzeCaps(runtime.workflow).textEntries;
      for(const entry of textEntries){const value=entry.negative?(p.negative??""):finalPrompt;runtime.workflow[entry.nodeId].inputs[entry.input]=value;values[`${entry.nodeId}.${entry.input}`]=value;}
      for(const def of [...runtime.params,...(runtime.variants?.find(v=>v.id==="default")?.params??[])]){
        if(def.kind==="seed")values[def.key]=p.seed??"";
        const entry=textEntries.find(e=>e.nodeId===def.nodeId&&e.input===def.input);if(entry)values[def.key]=entry.negative?(p.negative??""):finalPrompt;
      }
      const r = await runComfyTemplate(host, runtime, values, {
        upstreamImages: refImages,
        upstreamTexts: [finalPrompt],
        resolution:p.aspect?{aspect:p.aspect,mp:1}:undefined,
        signal,
        onProgress: (msg, pct) => job.stage(msg, pct),
      });
      outputUrls = r.images.filter(Boolean);
    } else {
      // 远程 Provider：模型卡解析 + 家族参数（aspect/size/negative 全部交给 imageGen 内部家族分支）
      if(!card) throw new Error("生图模型不可用");
      job.stage(`远程生成 · ${card.name}`);
      outputUrls = await generateImage(card, {
        prompt: finalPrompt,
        n: p.n ?? 1,
        refImages: p.mode === "t2i" ? [] : refImages,
        aspect: p.aspect,
        resolution: p.resolution,
        size: p.aspect ? aspectToSize(p.aspect) : undefined,
        seed: p.seed,
        negative: p.negative,
        signal,
      });
    }
    useJobCenter.getState().patch(job.id,{retryRun:undefined});
    if(card)useUsage.getState().record(card,{ok:outputUrls.length>0,images:outputUrls.length,durMs:Date.now()-t0});
    if (!outputUrls.length) throw new Error("引擎没有返回图片");

    // 收录资产库：同批多图成组（groupSlot），带 director 来源可反向定位（方案 §14 验收）
    const groupId = uid(8);
    const assetIds: string[] = [];
    for (let i = 0; i < outputUrls.length; i++) {
      const asset = await useAssets.getState().collect({
        src: outputUrls[i],
        kind: "image",
        name: `制图_${p.prompt.slice(0, 20)}${outputUrls.length > 1 ? `_${i + 1}` : ""}`,
        prompt: finalPrompt,
        director: { projectId, role: "generated" },
        gen: {
          nodeKind: "imageGen" as const,
          prompt: finalPrompt,
          modelId: p.engine === "comfy" ? undefined : p.providerModelKey,
          aspect: p.aspect,
          resolution: p.resolution,
          seed: p.seed,
          negative: p.negative,
        },
        group: { groupId, groupLabel: label, groupKind: "generation" as const, groupSlot: String(i + 1) },
        durationMs: Date.now() - t0,
      });
      if (asset) {
        assetIds.push(asset.id);
        // 3.5 P2：绑定项目文件夹时镜像进 全部素材/AI制图/（失败不阻断）
        void mirrorProjectAsset({ projectId, category: "image", assetId: asset.id });
      }
    }

    if(!assetIds.length) throw new Error("图片已生成，但资产收录失败，请检查存储空间");
    // 写制图历史（参数复用入口）
    const record: ImageStudioRecord = {
      id: uid(10),
      mode: p.mode,
      prompt: p.prompt,
      inputAssetIds: p.inputAssetIds,
      engine: p.engine,
      recipeId: p.recipeId,
      providerModelKey: p.providerModelKey,
      params: { ...p.params, aspect: p.aspect ?? "", resolution: p.resolution ?? "", seed: p.seed ?? "", n:p.n??1, negative:p.negative??"", finalPrompt },
      assetIds,
      createdAt: Date.now(),
      durationMs: Date.now() - t0,
    };
    const proj = useDirector.getState().getById(projectId);
    if(!proj)throw new Error("项目已删除，生成结果已保留到资产库");
    useDirector.getState().updateProject(projectId, {
      imageStudio: { history: [record, ...(proj.imageStudio?.history ?? [])].slice(0, 60) },
    });
    const missing=p.engine==="provider"?Math.max(0,(p.n??1)-assetIds.length):0;
    if(missing){useJobCenter.getState().patch(job.id,{retryNote:`已保存 ${assetIds.length} 张，只补剩余 ${missing} 张，远程提交可能计费。`,retryRun:async()=>{await runImageStudio(projectId,{...p,n:missing,signal:undefined,confirmed:true});}});job.fail(`已完成 ${assetIds.length} 张，剩余 ${missing} 张可续跑`);}else job.done(`${label}完成（${assetIds.length} 张）`);
    return { record, assetIds };
  } catch (e) {
    if(signal.aborted || isAbortError(e)){job.cancel();throw e;}
    const msg = errMsg(e);
    job.fail(msg);
    useUi.getState().pushError("AI 制图", msg); // 3.2 §5.1：运行错误统一进报错中心
    throw e;
  } finally { runningProjects.delete(projectId); }
}

/** 历史操作：收藏/取消收藏 */
export function toggleImageRecordFav(projectId: string, recordId: string): void {
  const proj = useDirector.getState().getById(projectId);
  const history = proj?.imageStudio?.history ?? [];
  if (!proj) return;
  useDirector.getState().updateProject(projectId, {
    imageStudio: { history: history.map((h) => (h.id === recordId ? { ...h, fav: !h.fav } : h)) },
  });
}

/** 引擎可用性预检（方案 §6.4：本地显示加载/显存状态，远程显示计费提示由 UI 层做） */
export function imageEngineStatus(): { comfyHost: string; providerReady: boolean } {
  return {
    comfyHost: useSettings.getState().settings.comfy.host,
    providerReady: (()=>{try{return !!resolveModelCard("image").model;}catch{return false;}})(),
  };
}
