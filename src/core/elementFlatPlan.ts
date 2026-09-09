import type { ElementFlatOptions } from "./types";

export const ELEMENT_FLAT_RULES = `将美陈、文化墙或展陈立体效果图中的指定元素重建为独立平面稿。使用原图锁定内容、文字、轮廓和配色，局部参考锁定元素身份。输出严格正投影、无透视、无厚度、无投影，不把整面墙重新画一遍。正面保留原设计；背面按轮廓镜像和指定背面色表达；底面按指定底面色表达。不可见部分属于推定设计，不能声称恢复真实隐藏结构。不要绘制尺寸线、标尺、刀路或虚构工艺信息；尺寸由软件确定性设置。逐件输出，保留原图与生成稿，失败项允许重试。`;

export function flatOutputSize(options: ElementFlatOptions) {
  const factor = options.unit === "mm" ? options.dpi / 25.4 : 1;
  const w = Math.round(options.width * factor), h = Math.round(options.height * factor);
  if (![w, h, options.dpi].every(Number.isFinite) || w < 16 || h < 16 || options.dpi < 1)
    throw new Error("请输入有效尺寸（输出至少 16×16 像素）和 DPI");
  if (w > 8192 || h > 8192 || w * h > 24_000_000)
    throw new Error("输出过大：单边最多 8192 像素、总计最多 2400 万像素，请降低尺寸或 DPI");
  return { w, h };
}

export const FLAT_VIEW_LABEL = { front: "正面平面稿", back: "背面推定稿", bottom: "底面推定稿" };

/** 切换单位保持同一张画板的像素尺寸，不把 1024px 误变为 1024mm。 */
export function convertFlatUnit(options: ElementFlatOptions, unit: ElementFlatOptions["unit"]): ElementFlatOptions {
  if (options.unit === unit) return options;
  const size = flatOutputSize(options);
  return { ...options, unit, width: unit === "px" ? size.w : Number((size.w * 25.4 / options.dpi).toFixed(4)),
    height: unit === "px" ? size.h : Number((size.h * 25.4 / options.dpi).toFixed(4)) };
}
export function flatElementPrompt(name: string, text: string | undefined, options: ElementFlatOptions) {
  const view = options.view === "front"
    ? "只画正面：视线垂直于物体正面的一个平面，保留这个正面的设计与原配色。只允许看见正面，绝不显示侧面、顶面、底面或背面。立方体示例：只应得到一个正方形正面，不是十字展开图或六边形立体轮廓。"
    : options.view === "back"
      ? `只画背面：沿正面的相反方向正投影，只保留这一面的外轮廓（与正面轮廓左右镜像对应），内部纯色 ${options.backColor}。不显示底面或任何侧面，不印文字。立方体示例：一个纯色正方形。隐藏形状仅为推定设计。`
      : `只画底面：从物体正下方垂直投影，只保留接地底面的单个轮廓，内部纯色 ${options.bottomColor}。绝不显示背面、正面或侧面，不印文字。立方体示例：一个纯色正方形。隐藏形状仅为推定设计。`;
  return ["为美陈/文化墙输出指定元素的单面平面稿，每次严格只有一个视面。不是纸模展开图、包装展开图、拆装示意、多视图拼图或立体渲染。禁止透视、厚度、立体明暗、投影、折线、尺寸线与工艺标注。", `仅处理：${name}。图1锁定完整物体身份，图2为局部参考；请依据物体面向转换为本次指定视面。`,
    `本次唯一输出：${FLAT_VIEW_LABEL[options.view]}。${view}`,
    text && options.view === "front" ? `正面设计文字逐字保留：「${text}」，不改写、不增加文字。` : "不增加标签或文字。",
    "单个元素完整居中，四边留少量空白，不能裁切。背景统一纯品红 #FF00FF，无渐变、纹理和阴影，供软件抠底；主体不能包含背景色溢出。",
    `目标画板比例 ${options.width}:${options.height}。只输出这一件的平面图。`,
  ].join("\n");
}
