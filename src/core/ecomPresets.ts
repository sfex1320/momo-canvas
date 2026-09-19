import { ECOM_CONTINUITY_RULES } from "./ecomContinuity";
/**
 * 电商长图节点共享定义
 *  - 视觉分析用的系统提示词（输出严格 JSON：产品属性 + 各切片生图提示词与文案）
 *  - 与 charPresets 的 charAnalysisSystem 同构：声明式规格 + 强约束 JSON
 */
import type { EcomAnalysis, EcomSlide } from "./types";

/**
 * 视觉分析系统提示词：分析产品拍照图 → 提炼属性 + 规划 N 个上下拼接的详情页切片。
 * 每个 slice.prompt 都必须重复产品核心视觉特征，保证拼成长图后风格统一。
 */
export function ecomAnalysisSystem(opts: {
  styleTone?: string;
  sliceCount?: number;
  aspect?: string;
  productDesc?: string;
}): string {
  const n = Math.max(2, Math.min(8, opts.sliceCount ?? 6));
  const aspect = opts.aspect ?? "3:4";
  const tone = opts.styleTone?.trim();
  const toneLine = tone
    ? `\n整体风格调性（每张切片必须严格遵守，保证长图风格统一）：${tone}`
    : "";
  const descLine = opts.productDesc?.trim()
    ? `\n用户给出的产品介绍 / 卖点 / 适用人群等描述（必须体现在产品属性与各切片文案中；图中看不出的信息可据此补全）：${opts.productDesc}`
    : "";
  return `你是资深电商视觉设计师与 AI 绘画提示词专家。用户会发来一张产品的拍照图（可能角度/光线/背景不完美）。请完成两件事：
1. 分析产品，提炼属性（名称 / 品类 / 材质 / 主色 / 特征 / 卖点 / 适用人群）与整体风格调性；
2. 为一张 ${aspect} 竖版电商详情页长图规划 ${n} 个上下拼接的切片。每个切片是连续长图中的一个窗口（如：主图、卖点 banner、细节特写、使用场景、规格信息等，按产品特点合理编排，覆盖一条详情页的完整叙事），并为每个切片写一段可直接用于 AI 绘画的高质量中文提示词。${toneLine}${descLine}

要求：
${ECOM_CONTINUITY_RULES}
- 每个切片的提示词都必须完整重复产品的核心视觉特征（产品外观、配色、材质、品牌调性），保证 ${n} 张拼在一起风格统一、像同一套详情页；
- 用户的拍照图可能不理想，提示词要在保持产品真实外观的前提下优化为专业电商大片质感（干净背景、精准光影、高清晰度），并按需补全图中未拍全的部分（结合用户描述合理推断，不要凭空捏造与产品冲突的元素）；
- 每个切片提示词要写明画面内容与版式，并把卖点文案作为画面的一部分直接设计进图里（用电商海报风格的精美排版写在产品旁的空白区，文字清晰可读、不乱码、不溢出），${aspect} 竖版构图；
- 文案 copy 是要直接写进画面的实际卖点短语（中文，精炼、有感染力，适合作为海报大字 / 标语；不要长段落），提示词里要规划好它的位置与排版风格。

严格只输出以下 JSON：第一个字符必须是 {，不要 markdown 代码块、不要任何解释、不要思考过程（不要 <think> 之类的标签、不要前后缀文字）：
{"product":{"name":"产品名","category":"品类","material":"材质","color":"主色","features":["特征"],"sellingPoints":["卖点"],"audience":"适用人群","styleTone":"风格调性"},"slides":[{"title":"切片标题","prompt":"该切片生图提示词","copy":"配套文案","entryEdge":"顶部边缘计划","exitEdge":"底部边缘计划"}]}`;
}

/** H5 长文模式系统提示词：把一篇长文案按内容切成若干切片，每片配一段画面提示词 + 核心文案。 */
export function h5AnalysisSystem(opts: { styleTone?: string; sliceCount?: number; aspect?: string }): string {
  const n = Math.max(2, Math.min(8, opts.sliceCount ?? 6));
  const aspect = opts.aspect ?? "3:4";
  const tone = opts.styleTone?.trim();
  const toneLine = tone
    ? `\n整体风格调性（所有切片必须严格遵守，保证 H5 风格统一）：${tone}`
    : "\n所有切片的画风、配色、版式基调必须统一，像同一套 H5 长图。";
  return `你是资深 H5 / 长图文案策划与 AI 绘画提示词专家。用户会给一篇较长的文案。请把它切成约 ${n} 个适合做长图切片的小节（按内容、段落、主题自然切分；每节是连续长图中的一个窗口，覆盖文案的完整叙事），并为每节产出：
1. title：该小节的简短标题；
2. prompt：该节画面的高质量中文生图提示词——要体现该节文案的内容与意境，${aspect} 竖版构图，并把该节核心文案作为画面文字直接设计进去（电商海报风格的精美排版，清晰可读、不乱码）；
3. copy：要写进画面的该节核心文案（精炼短语，不要整段照搬）。${toneLine}

要求：
${ECOM_CONTINUITY_RULES}
- 每个切片提示词都要写明画面内容与文案在画面中的排版位置；
- 相邻切片的画面要有过渡、像一条连续的长图，不要割裂。

严格只输出 JSON（第一个字符必须是 {，不要 markdown 代码块、不要思考过程、不要解释）：
{"product":{"name":"长图标题","styleTone":"风格调性"},"slides":[{"title":"小节标题","prompt":"画面提示词","copy":"核心文案","entryEdge":"顶部边缘计划","exitEdge":"底部边缘计划"}]}`;
}

/** 从原始模型文本里解析产品分析（剥 <think> 思考块 / 代码块围栏，兼容 {…} 对象与 […] 数组两种返回） */
export function parseEcomAnalysis(text: string): EcomAnalysis | null {
  const noThink = text.replace(/<(think|thinking|reason|reasoning|reflection|思考|分析)[\s\S]*?<\/\1\s*>/gi, "");
  const cleaned = noThink.replace(/```(?:json)?/g, "").trim();
  let obj: unknown = null;
  const s = cleaned.indexOf("{");
  const e = cleaned.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try {
      obj = JSON.parse(cleaned.slice(s, e + 1));
    } catch {
      /* 落到数组分支或返回 null */
    }
  }
  if (!obj) {
    const sa = cleaned.indexOf("[");
    const ea = cleaned.lastIndexOf("]");
    if (sa >= 0 && ea > sa) {
      try {
        obj = { slides: JSON.parse(cleaned.slice(sa, ea + 1)) };
      } catch {
        /* 忽略 */
      }
    }
  }
  return obj ? normalizeEcomAnalysis(obj) : null;
}

/** 把任意结构规整成最小可用的分析（兼容模型用不同字段名：prompt/imagePrompt/描述…） */
export function normalizeEcomAnalysis(parsed: unknown): EcomAnalysis | null {
  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as Record<string, unknown>;
  const productRaw = root.product && typeof root.product === "object" ? (root.product as Record<string, unknown>) : {};
  let slidesRaw: unknown = root.slides;
  if (!Array.isArray(slidesRaw)) slidesRaw = root.sections ?? root.cards ?? root.shots ?? root.segments;
  if (!Array.isArray(slidesRaw)) return null;

  const pickStr = (o: unknown, keys: string[]): string => {
    if (!o || typeof o !== "object") return "";
    for (const k of keys) {
      const v = (o as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  const slides = (slidesRaw as unknown[])
    .map((s): EcomSlide | null => {
      if (!s || typeof s !== "object") return null;
      const prompt = pickStr(s, [
        "prompt", "imagePrompt", "image_prompt", "image", "description", "desc", "detail",
        "提示词", "生图提示词", "画面描述", "画面", "content",
      ]);
      if (!prompt) return null;
      const title = pickStr(s, ["title", "name", "label", "标题", "小节"]) || "切片";
      const copy = pickStr(s, ["copy", "文案", "text", "营销文案", "slogan"]);
      return { title, prompt, copy: copy || undefined, entryEdge:pickStr(s,["entryEdge"])||undefined, exitEdge:pickStr(s,["exitEdge"])||undefined };
    })
    .filter((x): x is EcomSlide => !!x);
  if (!slides.length) return null;
  for(let i=1;i<slides.length;i++) {const edge=slides[i-1].exitEdge||slides[i].entryEdge;if(edge){slides[i-1].exitEdge=edge;slides[i].entryEdge=edge;}}

  const product: EcomAnalysis["product"] = {
    name: pickStr(productRaw, ["name", "名称", "title"]) || "产品",
    category: pickStr(productRaw, ["category", "品类", "类型"]) || undefined,
    material: pickStr(productRaw, ["material", "材质"]) || undefined,
    color: pickStr(productRaw, ["color", "颜色", "主色"]) || undefined,
    features: (productRaw.features ?? productRaw.特征) as string[] | undefined,
    sellingPoints: (productRaw.sellingPoints ?? productRaw.卖点 ?? productRaw.highlights) as string[] | undefined,
    audience: pickStr(productRaw, ["audience", "适用人群", "目标人群"]) || undefined,
    styleTone: pickStr(productRaw, ["styleTone", "风格", "调性", "style"]) || undefined,
  };
  return { product, slides: slides.slice(0, 8) };
}
