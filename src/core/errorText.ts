/** 错误只保留诊断文本，避免图片编码进入 DOM、状态和持久化日志。先截取再清洗，处理量有上限。 */
export function compactError(text: string): string {
  const clipped = text.slice(0, 8192)
    .replace(/data:[^\s,]{1,100};base64,[A-Za-z0-9+/=_-]+/gi, "[已省略媒体编码]")
    .replace(/[A-Za-z0-9+/=_-]{200,}/g, "[已省略超长编码]");
  const suffix = text.length > 8192 || clipped.length > 1000 ? "\n（错误详情过长，已截断）" : "";
  return clipped.slice(0, 1000) + suffix;
}
