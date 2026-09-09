/**
 * 统一预算闸 —— 全部扣费路径的唯一入口（从 runner.ts 抽出，画布与创作助手共用）。
 * 同一笔花费必须过同一道门；perRunCap（单次上限）在此获得第一个消费者：
 * 单次预估超过即阻断（此前该配置只有定义没有消费点）。
 */
import { useSettings } from "../stores/settingsStore";
import { useUsage } from "../stores/usageStore";

/**
 * 预算护栏：超单次上限/日预算阻断、超确认阈值弹确认（block/confirm 由调用方处理）。
 * label 用于拼出用户能看懂的那一笔是什么，如「生成 3 张图片」。
 * opts.skipPerRunCap：批量等聚合预检时跳过单次上限——perRunCap 语义是「单次生成」，
 * 应逐段检查而不是拿整批总和去比（否则 30 段 × ¥1 的合法批次会被 ¥5 上限整批拦掉）。
 */
export function budgetGate(
  cost: number,
  label = "本次生成",
  opts?: { skipPerRunCap?: boolean; billing?: "subscription" },
): { block?: string; confirm?: string } {
  if(opts?.billing==="subscription")return {}; // Codex 共享额度由官方查询，不受 API 人民币日预算影响
  const budget = useSettings.getState().settings.budget;
  if (!budget.dailyCap && !budget.perRunCap && !budget.confirmOverCost) return {};
  const today = useUsage.getState().todayCost();
  if (!opts?.skipPerRunCap && budget.perRunCap && cost > budget.perRunCap) {
    return { block: `${label}预估花费 ¥${cost.toFixed(2)}，超过单次上限 ¥${budget.perRunCap.toFixed(2)}。可到「设置 → 用量」调整预算或减少本次数量` };
  }
  if (budget.dailyCap && today + cost > budget.dailyCap) {
    return { block: `已达日预算上限（今日已 ¥${today.toFixed(2)} + ${label}预估 ¥${cost.toFixed(2)} > 上限 ¥${budget.dailyCap}）。可到「设置 → 用量」调整` };
  }
  if (budget.confirmOverCost && cost > budget.confirmOverCost) {
    return { confirm: `${label}预估花费 ¥${cost.toFixed(2)}（今日已 ¥${today.toFixed(2)}），是否继续？` };
  }
  return {};
}
