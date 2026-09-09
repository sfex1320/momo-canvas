/** 独立浏览器来源验收；真实模型须手动点击，最多两次图片提交。 */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ReactFlow, ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "../../src/styles/theme.css";
import "../../src/styles/base.css";
import "../../src/modules/canvas/canvas.css";
import { StylePresetNode } from "../../src/modules/canvas/nodes/StylePresetNode";
import { NodeEditMenu } from "../../src/modules/canvas/NodeEditMenu";
import { useBoard } from "../../src/core/stores/boardStore";
import { useSettings, resolveModelCard } from "../../src/core/stores/settingsStore";
import { useUi } from "../../src/core/stores/uiStore";
import { composePositionedLayers, layeredPsdBytes, type ExportLayer } from "../../src/core/layering";
import { layerRect, layerOutputSize } from "../../src/core/layerGeometry";
import { chromaKey, loadImg } from "../../src/core/maskCanvas";
import { analyzeElements, splitElementsToCanvas, layerGroupForExport } from "../../src/core/elementSplit";
import { generateImage } from "../../src/core/services/imageGen";
import { elementRedrawPrompt } from "../../src/core/editPrompts";
import { readPsd } from "ag-psd";

if (location.hostname !== "[::1]") throw Error("验收限定独立 [::1] 来源");
document.documentElement.dataset.theme = "light";
useBoard.getState().newBoard();
function canvas(w: number, h: number, color: string) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d")!; ctx.fillStyle = color; ctx.fillRect(0, 0, w, h); return c;
}
const fixture = canvas(400, 500, "#faf2db");
const f = fixture.getContext("2d")!; f.fillStyle = "#a52121"; f.font = "bold 48px sans-serif"; f.fillText("春日上新", 40, 80); f.fillRect(90, 180, 180, 220);
const source = useBoard.getState().addNode("image", { x: 0, y: 0 }, { src: fixture.toDataURL(), name: "海报样例", status: "done" });
useBoard.getState().addNode("stylePreset", { x: 0, y: 0 }, { category: "海报", selected: [], status: "idle" });

async function regression(write: (s: string) => void) {
  let passed = 0;
  const check = (ok: boolean, name: string) => { if (!ok) throw Error(name); passed++; write("通过 · " + name); };
  for (const scale of [1, 2, 4]) {
    const size = layerOutputSize(100, 80, scale);
    const layers: ExportLayer[] = [{ name: "背景", src: canvas(100, 80, "white").toDataURL(), box: [0, 0, 1, 1] }, { name: "高清元素", src: canvas(80, 64, "red").toDataURL(), box: [.2, .25, .4, .4] }];
    const composite = await composePositionedLayers(layers, size.width, size.height);
    const psd = readPsd(await layeredPsdBytes({ ...size, layers, composite }), { useImageData: true });
    const child = psd.children![0], rect = layerRect(layers[1].box!, size.width, size.height);
    check(psd.width === 100 * scale && psd.height === 80 * scale, `${scale} 倍输出保留尺寸`);
    check(child.left === rect.left && child.top === rect.top && child.imageData!.width === rect.width && child.imageData!.height === rect.height, `${scale} 倍 PSD 图层不越位`);
    const reconstructed = canvas(size.width, size.height, "transparent"), ctx = reconstructed.getContext("2d")!;
    for (const layer of [...psd.children!].reverse()) {
      const c = canvas(layer.imageData!.width, layer.imageData!.height, "transparent"); c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(layer.imageData!.data), c.width, c.height), 0, 0); ctx.drawImage(c, layer.left!, layer.top!);
    }
    const expected = canvas(size.width, size.height, "transparent"); expected.getContext("2d")!.drawImage(await loadImg(composite), 0, 0);
    const a = ctx.getImageData(0, 0, size.width, size.height).data, b = expected.getContext("2d")!.getImageData(0, 0, size.width, size.height).data;
    check(a.every((v, i) => v === b[i]), `${scale} 倍 PSD 重组与 PNG 逐像素一致`);
  }
  const highlight = canvas(60, 60, "white"), h = highlight.getContext("2d")!;
  h.fillStyle = "red"; h.fillRect(10, 10, 40, 40); h.fillStyle = "white"; h.fillRect(20, 20, 20, 20);
  const output = await chromaKey(highlight.toDataURL(), { key: [255, 255, 255], edgeConnected: true });
  h.clearRect(0, 0, 60, 60); h.drawImage(await loadImg(output), 0, 0);
  check(h.getImageData(0, 0, 1, 1).data[3] === 0 && h.getImageData(30, 30, 1, 1).data[3] === 255, "背景透明且封闭白色高光保留");
  check(elementRedrawPrompt("艺术标题", "春日上新").includes("逐字绘制「春日上新」"), "艺术字重绘保留原文指令");
  const cap = layerOutputSize(6000, 4000, 4);
  check(cap.width <= 8192 && cap.width * cap.height <= 24_010_000, "大图输出内存上限");
  const board = useBoard.getState();
  const gid = board.addNode("group", { x: 0, y: 0 }, { layerGroup: true, layerOutputScale: 2, layerCanvasSize: { width: 100, height: 80 } });
  const bgid = board.addNode("image", { x: 0, y: 0 }, { src: canvas(200, 160, "white").toDataURL(), elemMeta: { role: "decoration", box: [0, 0, 1, 1] } });
  const fgid = board.addNode("image", { x: 0, y: 0 }, { src: canvas(80, 64, "red").toDataURL(), elemMeta: { role: "subject", box: [.2, .25, .4, .4] } });
  useBoard.setState(s => ({ nodes: s.nodes.map(n => [bgid, fgid].includes(n.id) ? { ...n, parentId: gid } : n) }));
  let exported = await layerGroupForExport(gid);
  check(exported?.width === 200 && exported?.height === 160, "替换高清背景不改变海报基准尺寸");
  board.removeNode(bgid);
  exported = await layerGroupForExport(gid);
  check(exported?.width === 200 && exported?.height === 160, "移除背景后元素仍按原海报坐标导出");
  board.removeNode(fgid); board.removeNode(gid);
  const oldGroup = board.addNode("group", { x: 0, y: 0 }, { layerGroup: true });
  const oldBg = board.addNode("image", { x: 0, y: 0 }, { src: canvas(100, 80, "white").toDataURL() });
  const oldFg = board.addNode("image", { x: 0, y: 0 }, { src: canvas(153, 200, "red").toDataURL() });
  useBoard.setState(s => ({ nodes: s.nodes.map(n => [oldBg, oldFg].includes(n.id) ? { ...n, parentId: oldGroup } : n) }));
  const legacy = (await layerGroupForExport(oldGroup))!;
  const legacyPsd = readPsd(await layeredPsdBytes(legacy), { useImageData: true });
  check(legacyPsd.children![0].left === 19 && legacyPsd.children![0].imageData!.width === 61, "旧图层组等比缩放保持半像素舍入位置");
  board.removeNode(oldBg); board.removeNode(oldFg); board.removeNode(oldGroup);
  write(`回归完成 · ${passed} 项通过`);
}

async function live(write: (s: string) => void, show: (s: string) => void) {
  const endpoint = "http://[::1]:1433", images: string[] = [], messages: string[] = [];
  const log = (s: string) => { messages.push(s); write(s); };
  const previous = useSettings.getState().settings;
  try {
    const config = await (await fetch(endpoint + "/config")).json();
    config.settings.models.defaults = { ...config.settings.models.defaults, ...config.selected };
    useSettings.setState({ settings: config.settings });
    log(`真实模型：${config.selected.chat} + ${config.selected.image}`);
    log("1/4 生成测试海报（第一次图片提交）");
    const results = await generateImage(resolveModelCard("image"), { prompt: "设计一张简洁高级的春季新品海报，竖版。奶油白纯色背景，中央偏下只有一个红色陶瓷杯，杯身一处白色圆形印花。杯子完整显示，包括把手，产品摄影质感。上方独立中文大标题“春日上新”，下方小字“慢享一杯好时光”。右上角一个小红色太阳装饰。严格四个分离的元素，彼此不重叠，文字与杯子明显分开。", size: "1024x1536", n: 1 });
    const src = results[0]; images.push(src); show(src);
    const id = useBoard.getState().addNode("image", { x: 600, y: 0 }, { src, name: "真实海报", status: "done" });
    log("2/4 视觉识别元素与文字");
    const items = await analyzeElements(src); log(JSON.stringify(items.map(({ name, role, box, text }) => ({ name, role, box, text }))));
    log("3/4 直接拆图组合基线");
    if (!await splitElementsToCanvas(id, items, { mode: "pixel", bgComplete: true })) throw Error("直接拆图未完整成功");
    const groups = () => useBoard.getState().nodes.filter(n => (n.data as any).layerGroup);
    const pixel = await layerGroupForExport(groups().at(-1)!.id); images.push(pixel!.composite); show(pixel!.composite);
    const subject = items.find(i => i.role === "subject"); if (!subject) throw Error("未识别到主体，不盲目重绘");
    log("4/4 单主体高清重绘（第二次图片提交）");
    const confirm = window.confirm; window.confirm = () => true;
    try {
      if (!await splitElementsToCanvas(id, [subject], { mode: "redraw", bgComplete: true, onProgress: message => log(message) })) throw Error("主体高清重绘未成功");
    } finally { window.confirm = confirm; }
    const result = await layerGroupForExport(groups().at(-1)!.id);
    images.push(result!.layers[1].src, result!.composite); show(result!.layers[1].src); show(result!.composite);
    log(`完成：${result!.width}×${result!.height}，${result!.layers.length} 层；文字本轮保持原图，未宣称原生可编辑。`);
  } catch (e) { log("流程未完成：" + String(e)); for (const error of useUi.getState().errlog.slice(0, 3)) log(error.source + "：" + error.message); }
  finally {
    useSettings.setState({ settings: previous });
    await fetch(endpoint + "/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ images, messages }) }).catch(() => {});
  }
}
function App() {
  const [logs, setLogs] = useState<string[]>([]), [images, setImages] = useState<string[]>([]), [busy, setBusy] = useState(false);
  const nodes = useBoard(s => s.nodes);
  const errors = useUi(s => s.errlog);
  const write = (s: string) => setLogs(v => [...v, s]);
  return <ReactFlowProvider><main style={{ padding: 24 }}><h2>海报流程验收</h2><div style={{ display: "flex", gap: 10, alignItems: "center" }}>
    <NodeEditMenu id={source} /><button className="btn" disabled={busy} onClick={async () => { setBusy(true); try { await regression(write); } catch (e) { write("失败 " + e); } finally { setBusy(false); } }}>运行本地回归</button>
    <button className="btn" disabled={busy} onClick={async () => { setBusy(true); try { await live(write, s => setImages(v => [...v, s])); } finally { setBusy(false); } }}>运行真实流程（2次生图）</button>
    {["light", "dark", "black"].map(t => <button className="btn" key={t} onClick={() => document.documentElement.dataset.theme = t}>{t}</button>)}</div>
    <div style={{ display: "grid", gridTemplateColumns: "390px 1fr", gap: 20, marginTop: 20 }}><div style={{ height: 660 }}><ReactFlow nodes={nodes.filter(n => n.type === "stylePreset")} edges={[]} nodeTypes={{ stylePreset: StylePresetNode }} defaultViewport={{ x: 20, y: 20, zoom: 1 }} /></div><div><pre style={{ whiteSpace: "pre-wrap" }}>{logs.join("\n")}</pre><div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>{images.map((s, i) => <img key={i} src={s} alt={`流程结果 ${i + 1}`} style={{ width: 230, objectFit: "contain", background: "var(--panel)" }} />)}</div></div></div>
    {!!errors.length && <details><summary>本轮错误详情</summary><pre style={{ whiteSpace: "pre-wrap" }}>{errors.map(e => e.message).join("\n")}</pre></details>}
  </main></ReactFlowProvider>;
}
createRoot(document.getElementById("root")!).render(<App />);
