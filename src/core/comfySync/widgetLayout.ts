/**
 * widgets_values 位序规则 · 唯一来源（从 frontendConvert 提取为无依赖纯模块）
 *
 * 前端格式 ⇄ API 格式两个方向的转换、Comfy 同步的参数写回（writeBack.ts）都用它定位
 * widget 值在序列化数组里的下标。提取出来是为了让纯逻辑可被 node 直跑测试（frontendConvert
 * 的 import 链带 store）。frontendConvert re-export 本函数，老调用方不受影响。
 */

/** 连接类型判定：全大写类型名（IMAGE/MODEL/CLIP…）且不属于 widget 基础类型 */
const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);
/** V3 动态类型：DYNAMICCOMBO 是控件（值在 widgets_values）；AUTOGROW 是组合槽（值在其带点子槽 values.a）；MATCHTYPE 当连接处理 */
const isDynamicCombo = (t: unknown) => typeof t === "string" && /^COMFY_DYNAMICCOMBO/.test(t);
export const isAutoGrowType = (t: unknown) => t === "COMFY_AUTOGROW_V3";
export const isWidgetType = (t: unknown): boolean =>
  Array.isArray(t) || WIDGET_TYPES.has(t as string) || isDynamicCombo(t);

export type WidgetSlot = { name: string; cag: boolean };

/**
 * 某节点类型的 widgets_values 布局：
 *  - widget 名序 = object_info 定义序（required + optional，combo/动态下拉也是 widget）
 *  - forceInput 的 widget 在 ComfyUI 序列化里**不占** widgets_values 位（跳过）
 *  - 带 control_after_generate 标记的 widget（KSampler.seed 等）后面紧跟一个注入位（"fixed"/"increment"…），取值/回填都要 +1
 * 返回：slots = 占位的 widget 序（cag = 后面有注入位）；index = widget 名 → 在 widgets_values 里的正确下标
 */
export function widgetLayoutOf(
  classType: string,
  objectInfo: Record<string, any>,
): { slots: WidgetSlot[]; index: Map<string, number> } {
  const oi = objectInfo[classType];
  const slots: WidgetSlot[] = [];
  const index = new Map<string, number>();
  let wvIdx = 0;
  for (const group of [oi?.input?.required, oi?.input?.optional]) {
    for (const [name, def] of Object.entries<any>(group ?? {})) {
      const t = Array.isArray(def) ? def[0] : def?.type;
      if (!isWidgetType(t)) continue;
      const opts = Array.isArray(def) ? def[1] : def?.options;
      if (opts?.forceInput) continue; // 强制连线：序列化里不占位
      const cag = !!opts?.control_after_generate;
      slots.push({ name, cag });
      index.set(name, wvIdx);
      wvIdx += cag ? 2 : 1;
    }
  }
  return { slots, index };
}
