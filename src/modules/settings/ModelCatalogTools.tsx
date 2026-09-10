import { useState } from "react";
import { refreshGptProviders, type ModelRefreshResult } from "../../core/modelCatalog";
import { openExternal } from "../../core/external";

export function ModelCatalogTools() {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ModelRefreshResult[]>([]);
  const [error, setError] = useState("");
  const refresh = async () => {
    setBusy(true); setError("");
    try { setResults(await refreshGptProviders()); }
    catch { setError("同步未完成，请稍后重试"); }
    finally { setBusy(false); }
  };
  return <section className="set-card model-catalog-tools">
    <div className="set-card-h">绘画模型<button className="btn sm" disabled={busy} onClick={() => void refresh()}>{busy ? "查询各站点…" : "同步 GPT 2.5"}</button></div>
    <p>一次更新已配置 GPT Image 的服务商。保留原模型和默认选择；目录检查不发起付费生图。</p>
    <p>Flare 适合快速创作，Sunburst 面向复杂创作。质量是独立参数：自动、低、中、高、精细、最高；中转站可能只开放部分档位。</p>
    <button className="btn sm" onClick={() => void openExternal("https://developers.openai.com/api/docs/guides/image-generation")}>官方参数与计费</button>
    {results.length > 0 && <div role="status">{results.map(r => <details key={r.id}><summary>{r.name} · {r.models.length ? `已同步 ${r.models.length} 个型号` : "未更新"}</summary><p style={{ whiteSpace: "pre-wrap" }}>{r.note}</p></details>)}</div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
