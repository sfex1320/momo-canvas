/**
 * 协议自愈 — 自定义协议运行失败时的自动闭环：
 *  发现错误（捕获失败 + 执行现场）→ 理解错误（交给用户配置的对话模型）→ 修改错误（生成修正协议）
 *  → 衔接（用修正协议自动重试一次；成功才写回设置，失败回滚不留坏协议）
 * 网络/鉴权/额度类错误不属于协议配置问题，不触发自愈（避免白花重试费用）。
 */
import type { CustomProtocol } from "../types";
import { toast } from "../stores/uiStore";
import { errMsg } from "../utils";

/** 这些错误修协议也没用：跳过自愈，直接按原错误上报 */
const SKIP_PATTERNS = [
  /\b40[13]\b/, /unauthorized/i, /forbidden/i,
  /\b429\b/, /rate.?limit/i, /quota/i, /insufficient/i, /余额|欠费|额度/,
  /error sending request/i, /dns/i, /no such host/i, /certificate|ssl|tls/i,
  /协议不存在/, /的用途是/,
];

function repairable(msg: string): boolean {
  return !SKIP_PATTERNS.some((re) => re.test(msg));
}

const REPAIR_SYSTEM = `你是 API 协议修复专家。momo 画布用一份声明式 JSON 协议调用 AI 生成中转站。
模板占位符：{{baseUrl}} {{apiKey}} {{model}} {{prompt}} {{size}} {{n}} {{taskId}} {{image}}（首图 dataURL）{{image2}}（第二图）{{images}}（参考图 JSON 数组，不加引号）{{mask}}（蒙版 PNG dataURL）。
JSON 路径语法：点号访问字段，数组展开加 []（可嵌套，如 data.result.images[].url[]，末段是字符串数组时也要加 []）。

本次调用失败了。你会看到：当前协议 JSON、报错信息、执行现场（真实请求与响应，密钥已脱敏）。
请对照真实响应找出协议配置的偏差（常见：taskIdPath / poll.url / poll.statusPath / poll.doneValue / resultPath 写错，或同步异步判断错误）。
只输出修正后的完整协议 JSON（保留原 id、name、role），不要解释。
若你判断问题不在协议配置（如网络、鉴权、余额、服务商故障），只输出 {"noFix":true}。`;

/** 让对话模型依据执行现场修协议；修不了/没必要修返回 null */
async function aiRepair(proto: CustomProtocol, error: string, trace: string[]): Promise<CustomProtocol | null> {
  const { resolveModelCard } = await import("../stores/settingsStore");
  const { chatOnce } = await import("./llm");
  const card = resolveModelCard("chat");
  const user = [
    `当前协议 JSON：\n${JSON.stringify(proto, null, 1)}`,
    `报错信息：\n${error}`,
    `执行现场：\n${trace.join("\n") || "（无）"}`,
  ].join("\n\n");
  const out = await chatOnce(card, REPAIR_SYSTEM, user.slice(0, 24000));
  const json = out.match(/```json\s*([\s\S]*?)```/)?.[1] ?? out.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    const p = JSON.parse(json) as CustomProtocol & { noFix?: boolean };
    if (p.noFix) return null;
    if (!p.submit?.url || !p.resultPath) return null;
    // 关键身份字段以原协议为准，AI 不许改
    p.id = proto.id;
    p.name = proto.name;
    p.role = proto.role;
    delete (p as { noFix?: boolean }).noFix;
    if (JSON.stringify(p) === JSON.stringify(proto)) return null; // 没改等于没修
    return p;
  } catch {
    return null;
  }
}

/** 对比修复前后的关键字段，生成一句人话的改动摘要 */
function diffSummary(a: CustomProtocol, b: CustomProtocol): string {
  const changes: string[] = [];
  const cmp = (label: string, x?: string, y?: string) => {
    if ((x ?? "") !== (y ?? "")) changes.push(`${label}：${x ?? "（无）"} → ${y ?? "（无）"}`);
  };
  cmp("taskIdPath", a.taskIdPath, b.taskIdPath);
  cmp("resultPath", a.resultPath, b.resultPath);
  cmp("submit.url", a.submit.url, b.submit.url);
  cmp("poll.url", a.poll?.url, b.poll?.url);
  cmp("statusPath", a.poll?.statusPath, b.poll?.statusPath);
  cmp("doneValue", a.poll?.doneValue, b.poll?.doneValue);
  if (!changes.length && a.submit.body !== b.submit.body) changes.push("submit.body 请求体");
  return changes.join("；") || "细节字段";
}

/**
 * 自愈执行器：run 失败且像协议配置问题时，AI 修协议 → 自动重试一次。
 * 重试成功 → 修复写回设置（后续运行直接用好协议）；重试失败 → 不写回，抛出综合错误。
 */
export async function runWithSelfHeal<T>(
  proto: CustomProtocol,
  label: string,
  run: (p: CustomProtocol, trace: string[]) => Promise<T>,
  onProgress?: (msg: string) => void,
): Promise<T> {
  const trace: string[] = [];
  try {
    return await run(proto, trace);
  } catch (e) {
    const first = errMsg(e);
    const { useSettings } = await import("../stores/settingsStore");
    if (!useSettings.getState().settings.protoSelfHeal || !repairable(first)) throw e;

    onProgress?.("运行失败，AI 正在依据执行现场修复协议…");
    let fixed: CustomProtocol | null = null;
    try {
      fixed = await aiRepair(proto, first, trace);
    } catch {
      fixed = null; // 修复分析本身失败 → 按原错误上报
    }
    if (!fixed) throw e;

    onProgress?.("协议已自动修复，正在重试…");
    toast(`${label}：协议「${proto.name}」运行出错，AI 已自动修复（${diffSummary(proto, fixed)}），正在重试…`, "info");
    try {
      const result = await run(fixed, []);
      // 重试成功才把修复写回设置，坏修复不落盘；跑通即等同真实测试通过，顺手盖「已校准」章
      const st = useSettings.getState();
      const stamped = { ...fixed, verifiedAt: Date.now() };
      st.update("customProtocols", [...st.settings.customProtocols.filter((x) => x.id !== stamped.id), stamped]);
      toast(`${label}：自愈成功 ✓ 修复后的协议「${fixed.name}」已保存`, "ok");
      return result;
    } catch (e2) {
      throw new Error(
        `${first}\n—— AI 自动修复（${diffSummary(proto, fixed)}）后重试仍失败：${errMsg(e2)}。修复未保存，可到报错中心「AI 分析」继续排查`,
      );
    }
  }
}
