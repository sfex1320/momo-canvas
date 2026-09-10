/** 独立浏览器来源的真实组件验收；只使用人工样例，不初始化用户持久化数据。 */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ReactFlowProvider } from "@xyflow/react";
import "../../src/styles/theme.css";
import "../../src/styles/base.css";
import "../../src/modules/settings/settings.css";
import { AssetLibrary } from "../../src/modules/assets/AssetLibrary";
import { SmartCanvas } from "../../src/modules/canvas/SmartCanvas";
import { CodexConsole } from "../../src/modules/agent/CodexConsole";
import { useAssets, assetVisibleInProject } from "../../src/core/stores/assetStore";
import { useDirector } from "../../src/core/stores/directorStore";
import { useBoard } from "../../src/core/stores/boardStore";
import { useUi } from "../../src/core/stores/uiStore";
import { projectHasContent, projectDisplayName } from "../../src/core/studio/projectDisplay";
import { gptQualities, grsaiGptRoute } from "../../src/core/modelMeta";
import { appendImageModels, catalogPrice } from "../../src/core/modelCatalog";
import type { AssetItem, ProviderCard, ModelCard } from "../../src/core/types";
import { StudioShell } from "../../src/modules/studio/StudioShell";
import { generateImage } from "../../src/core/services/imageGen";

if (location.hostname !== "[::1]") throw Error("验收限定独立 [::1] 来源");
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "light";
const project = useDirector.getState().createProject("qa-refactor", "qa-refactor", "未命名项目");
useDirector.getState().updateProject(project.id, { script: "# 山海共生\n文化墙设计与品牌视觉", scenes: [] });
const empty = useDirector.getState().createProject("qa-empty", "qa-refactor", "未命名项目");
const other = useDirector.getState().createProject("qa-other", "qa-refactor", "城南旧事");
useDirector.getState().updateProject(other.id, { script: "另一个项目的故事" });
useUi.setState({ directorProjectId: project.id, directorNodeId: project.nodeId, directorOpen: true });
const pic = (i: number) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240"><rect width="360" height="240" fill="hsl(${i * 47},30%,88%)"/><circle cx="180" cy="100" r="58" fill="hsl(${i * 47},36%,55%)"/><path d="M0 200L130 140L360 230V240H0" fill="hsl(${i * 47},28%,35%)"/></svg>`)}`;
const names = ["山海 · 主视觉", "角色 · 正面参考", "片头 · 生成稿", "场景 · 竹林", "场景 · 黄昏", "封面 · 方案一", "封面 · 方案二", "跨项目共用素材", "别的项目素材", "品牌字体规范"];
const items: AssetItem[] = names.map((name, i) => ({ id: `qa-asset-${i}`, name, kind: i === 2 ? "video" : i === 9 ? "pdf" : "image", path: pic(i), thumb: pic(i), size: 2048, mime: "image/svg+xml", width: 360, height: 240, createdAt: Date.now() - i * 86400000, fav: i < 2, tags: [i < 5 ? "山海" : "封面"], folderId: i < 5 ? "qa-visual" : undefined, director: i === 7 ? undefined : { projectId: i === 8 ? other.id : project.id, role: i === 1 ? "reference" : "generated" }, projectMirrors: i === 7 ? { [project.id]: "qa/shared.png" } : undefined, groupId: i === 5 || i === 6 ? "qa-covers" : undefined, groupSlot: i === 5 || i === 6 ? String(i) : undefined }));
useAssets.setState({ items, folders: [{ id: "qa-visual", name: "视觉素材" }], trash: [], open: true, loaded: true });
useBoard.getState().addNode("imageGen", { x: 70, y: 90 }, { prompt: "测试按钮和文本框不拖动，说明与空白可拖动" });
useBoard.getState().addNode("prompt", { x: 550, y: 90 }, { text: "拖动节点验收" });
const checks: string[] = [];
const check = (value: unknown, name: string) => { if (!value) throw Error(name); checks.push(name); };
check(!projectHasContent(empty), "空项目可收起");
check(projectHasContent(useDirector.getState().getById(project.id)!), "有剧本的未命名项目不隐藏");
check(projectDisplayName(useDirector.getState().getById(project.id)!).includes("山海共生"), "项目标题可辨识");
check(assetVisibleInProject(items[7], project.id, true) && !assetVisibleInProject(items[8], project.id, true), "项目资产包含共享镜像且排除其他项目");
check(gptQualities("p::gpt-image-2.5-flare").length === 6 && gptQualities("gpt-image-2").length === 4, "2.5 与旧版质量范围独立");
const provider: ProviderCard = { id: "qa", name: "测试", baseUrl: "https://grsai.dakka.com.cn", apiKey: "", models: { image: { protocol: "custom:banana", models: ["nano-banana-2"] } } };
const merged = appendImageModels(provider, ["gpt-image-2.5", "gpt-image-2.5", "bad-model"]);
check(merged.models.image?.models.length === 2 && merged.models.image?.protocol === "custom:banana", "批量添加幂等且保留旧配置");
const card: ModelCard = { id: "qa", role: "image", name: "测试", baseUrl: provider.baseUrl, apiKey: "", protocol: "custom:banana", model: "gpt-image-2.5" };
check(grsaiGptRoute(card).baseUrl.endsWith("/v1") && grsaiGptRoute({ ...card, model: "nano-banana-2" }).protocol === "custom:banana", "Grsai 两种图片路由不混用");
check(catalogPrice({ pricing: { amount: 1 } }).includes("缺少") && catalogPrice({ pricing: { amount: 0.15, currency: "CNY", unit: "张" } }).includes("0.15"), "报价必须带币种与单位");
function App() {
  const [mode, setMode] = useState("assets"), [consoleOpen, setConsoleOpen] = useState(false);
  const [protocolCheck, setProtocolCheck] = useState("");
  const checkProtocol = async () => {
    const original = window.fetch;
    const calls: { url: string; body: BodyInit | null | undefined }[] = [];
    window.fetch = async (url, init) => { calls.push({ url: String(url), body: init?.body }); return new Response(JSON.stringify({ data: [{ b64_json: "data:image/png;base64,QA" }] }), { status: 200, headers: { "Content-Type": "application/json" } }); };
    try {
      await generateImage(card, { prompt: "纯色测试", quality: "max", size: "1024x1024" });
      if (calls[0].url !== "https://grsai.dakka.com.cn/v1/images/generations" || JSON.parse(String(calls[0].body)).quality !== "max") throw Error("生成路由或质量错误");
      await generateImage(card, { prompt: "测试改图", quality: "xhigh", refImages: ["data:image/png;base64,AA=="] });
      if (!calls[1].url.endsWith("/images/edits") || !(calls[1].body instanceof FormData) || calls[1].body.get("quality") !== "xhigh" || !calls[1].body.get("image")) throw Error("编辑路由或素材错误");
      setProtocolCheck("生成与编辑请求通过（模拟响应，无付费调用）");
    } catch (e) { setProtocolCheck(String(e)); }
    finally { window.fetch = original; }
  };
  const nodes = useBoard(s => s.nodes);
  const currentId = useUi(s => s.directorProjectId);
  const current = useDirector(s => s.projects.find(p => p.id === currentId) ?? s.projects[0]);
  return <><nav style={{ position: "fixed", bottom: 4, left: 10, zIndex: 1800, display: "flex", gap: 8, background: "var(--panel-solid)", padding: 6 }}>
    <button onClick={() => { setMode("assets"); useAssets.getState().setOpen(true); }}>资产验收</button><button onClick={() => { setMode("canvas"); useAssets.getState().setOpen(false); }}>拖动验收</button><button onClick={() => { setMode("studio"); useAssets.getState().setOpen(false); }}>项目验收</button><button onClick={() => setConsoleOpen(true)}>Codex 验收</button><span>{checks.length} 项断言通过</span>{mode === "canvas" && <output>{nodes.map(n => `${n.type}=${Math.round(n.position.x)},${Math.round(n.position.y)}`).join("；")}</output>}
    <button onClick={() => void checkProtocol()}>协议验收</button><span>{protocolCheck}</span>
  </nav><div style={{ height: "100vh", width: "100vw" }}><ReactFlowProvider>{mode === "canvas" ? <SmartCanvas /> : null}</ReactFlowProvider>{mode === "studio" ? <StudioShell project={current} /> : null}</div><AssetLibrary />{consoleOpen && <CodexConsole onClose={() => setConsoleOpen(false)} />}</>;
}
createRoot(document.getElementById("root")!).render(<App />);
