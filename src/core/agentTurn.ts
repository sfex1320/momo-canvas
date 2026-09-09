/** 一轮助手任务的取消边界，等待用户与等待网络使用同一信号。 */
export function checkAgentTurn(signal: AbortSignal) {
  if (signal.aborted) throw new Error("已取消");
}

export function waitAgentTurn<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("已取消"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    task.then(value => { if (signal.aborted) abort(); else resolve(value); }, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** 明确上传的新素材优先，其次最近成图，最后才回溯旧附件。 */
export function generationRefs(messages: Array<{ role: string; images?: string[]; referenceMode?: "auto" | "none"; results?: Array<{ kind: string; src: string }> }>, current: string[] = []) {
  const latestUser = [...messages].reverse().find(m => m.role === "user");
  if (latestUser?.referenceMode === "none") return [];
  const latestResult = [...messages].reverse().find(m => m.results?.some(r => r.kind === "image"));
  const previousUpload = [...messages].reverse().find(m => m.role === "user" && m.images?.length);
  return [...new Set(current.length ? current : latestUser?.images?.length ? latestUser.images
    : latestResult?.results?.filter(r => r.kind === "image").map(r => r.src) ?? previousUpload?.images ?? [])].slice(0, 6);
}
