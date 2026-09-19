// 真实 runner/store 的无请求回归：验证预检、执行输入和界面引用顺序一致。
import { useBoard } from "../../src/core/stores/boardStore";
import { collectUpstream, collectImageRefsFor, collectUpstreamParts } from "../../src/core/runner";
import { canvasReferenceImages } from "../../src/core/nodeImages";
import type { AppNode } from "../../src/core/types";

const output = document.querySelector("#result")!;
const passed: string[] = [];
const same = (actual: unknown, expected: unknown, name: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(name);
  passed.push(name);
};
try {
  const gen = { id: "edit", type: "imageGen", position: { x: 0, y: 0 }, data: { imageOperation: "edit", referenceImages: ["snapshot-a", "snapshot-b"] } } as AppNode;
  useBoard.setState({ nodes: [gen], edges: [] });
  same(collectUpstream("edit").images, ["snapshot-a", "snapshot-b"], "无参考副本节点时，执行/重试仍收到冻结原图");
  same(collectImageRefsFor("edit").map(r => r.src), collectUpstream("edit").images, "引用缩略图与执行图片顺序一致");
  same(collectUpstreamParts("edit").filter(r => r.kind === "image").map(r => r.value), collectUpstream("edit").images, "输入审阅与执行图片顺序一致");
  const fresh = { id: "fresh", type: "image", position: { x: 0, y: 0 }, data: { src: "new-source" } } as AppNode;
  useBoard.setState({ nodes: [gen, fresh], edges: [{ id: "edge", source: "fresh", target: "edit" }] });
  same(collectUpstream("edit").images, ["new-source"], "手工连接新原图后覆盖历史快照");
  same(collectImageRefsFor("edit").map(r => r.src), ["new-source"], "换图后缩略图同步");
  same(collectUpstreamParts("edit").filter(r => r.kind === "image").map(r => r.value), ["new-source"], "换图后输入审阅同步");
  const group = { id: "group", type: "group", position: { x: 100, y: 100 }, data: {} } as AppNode;
  const child = { ...fresh, parentId: "group", position: { x: 0, y: 20 } };
  const upscale = { id: "upscale", type: "enhanceLocal", parentId: "group", position: { x: 0, y: 0 }, data: { results: ["first", "picked"], picked: 1 } } as AppNode;
  same(canvasReferenceImages([group, child, upscale], [group, child]), ["picked", "new-source"], "多选与整组送助手：展开成员、读取当前放大结果、去重并保序");
  output.textContent = `通过 ${passed.length} 项\n${passed.join("\n")}`;
} catch (error) { output.textContent = `失败：${String(error)}\n${passed.join("\n")}`; throw error; }
