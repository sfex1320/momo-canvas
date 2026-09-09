/**
 * 报错帮助 — 常见英文/网络错误翻译成中文提示 + AI 报错分析（报错中心用）
 */
import { useSettings } from "./stores/settingsStore";

/** 常见英文/网络报错 → 中文解释；匹配不到返回 null */
export function humanizeError(msg: string): string | null {
  const rules: [RegExp, string][] = [
    [/error sending request|connection (refused|reset|closed)|failed to connect|ECONNREFUSED/i,
      "网络请求发送失败：无法连接到该服务商地址。常见原因：本机网络不通或需要代理、Base URL 写错、服务商域名被墙或已失效"],
    [/dns error|no such host|name (not|or service not) (resolved|known)|ENOTFOUND/i,
      "域名解析失败：Base URL 里的域名不存在，或本机 DNS 异常"],
    [/timed? ?out|ETIMEDOUT/i, "请求超时：服务商响应太慢或网络不稳定，可稍后重试"],
    [/certificate|ssl|tls/i, "HTTPS 证书校验失败：服务商证书异常，或本机系统时间/代理软件干扰了加密连接"],
    [/\b401\b|unauthorized|invalid[ _-]?(api[ _-]?key|token)|incorrect api key|authentication/i,
      "鉴权失败（401）：API Key 无效、过期或填错位置，请到「设置 → 模型配置」核对"],
    [/\b403\b|forbidden|permission denied/i, "无权限（403）：这个 Key 没有该模型/接口的访问权限，或该服务限制了地区/套餐"],
    [/\b404\b|not found/i, "接口不存在（404）：Base URL 或接口路径不对——最常见的是结尾多了或少了 /v1"],
    [/\b429\b|rate.?limit|quota|insufficient|exceeded|余额|欠费/i, "限流或额度不足（429）：请求太频繁，或该 Key 的余额/配额已用完"],
    [/\b50[0-4]\b|internal server error|bad gateway|service unavailable|gateway timeout/i,
      "服务商内部错误（5xx）：对方服务暂时异常，稍后重试或换一个模型/服务商"],
    [/unexpected token|not valid json|响应不是 JSON/i, "服务商返回了非 JSON 内容：多半是中转站报错页/登录页，检查 Base URL 与 Key 是否正确"],
  ];
  for (const [re, tip] of rules) if (re.test(msg)) return tip;
  return null;
}

/** 状态码是否可重试（429 限流 / 5xx 服务端错误）。用于幂等请求与生成类重试判定 */
export function isRetryableStatus(s: number): boolean {
  return s === 429 || (s >= 500 && s <= 599);
}

/**
 * 错误消息是否属于「瞬时错误」可重试（网络/超时/429/5xx）。
 * 三分类，默认 false（未知错误不盲目重试，避免无谓重试浪费额度/扣费）：
 *  ① 计费问题（余额/欠费/quota）→ 重试无益，直接换备用或失败
 *  ② 鉴权/路径/证书/非 JSON（401/403/404/SSL）→ 重试也没用
 *  ③ 网络/超时/限流/5xx → 才重试
 */
export function isTransientError(msg: string): boolean {
  if (/余额|欠费|insufficient[ _-]?quota|quota[ _-]?exhaust|额度/.test(msg)) return false;
  if (
    /\b401\b|unauthorized|invalid[ _-]?(api[ _-]?key|token)|\b403\b|forbidden|permission denied|\b404\b|not found|certificate|ssl|tls|not valid json|响应不是 JSON|协议不存在|的用途是/.test(
      msg,
    )
  )
    return false;
  if (
    /connection (refused|reset|closed)|failed to connect|ECONNREFUSED|error sending request|timed? ?out|ETIMEDOUT|请求超时|\b429\b|rate.?limit|\b5\d{2}\b|internal server error|bad gateway|service unavailable|gateway timeout/i.test(
      msg,
    )
  )
    return true;
  return false;
}

export const ERR_ANALYZE_SYSTEM = `你是 momo 智能画布（调用各类 AI 生成服务的桌面应用）的排障专家。用户给你一条应用内的报错，以及当前配置上下文（服务商 Base URL 列表与协议绑定，均不含密钥）。
请用中文精炼输出：
1.【原因】一句话点明最可能的原因
2.【解决】具体可操作的解决步骤，对应到应用内位置（如「设置 → 模型配置」）`;

/** 组装脱敏的配置上下文（不含任何密钥） */
export function buildErrContext(): string {
  const s = useSettings.getState().settings;
  const providers = s.models.providers.map((p) => ({
    名称: p.name,
    baseUrl: p.baseUrl,
    槽位: Object.fromEntries(Object.entries(p.models).map(([r, slot]) => [r, { 协议: slot!.protocol, 模型: slot!.models }])),
  }));
  return JSON.stringify({ 服务商: providers }, null, 1).slice(0, 6000);
}
