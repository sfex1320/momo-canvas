/** 元素平面拆件：沿用绘画协议、预算、停止通道、资产分组与画布节点。 */
import type { ElementItem } from "./elementSplit";
import type { ElementFlatOptions } from "./types";
import { flatElementPrompt, flatOutputSize, FLAT_VIEW_LABEL } from "./elementFlatPlan";
import { pngDataUrlWithDpi } from "./pngDpi";
import { nodeMainImage } from "./nodeEdit";
import { useBoard } from "./stores/boardStore";
import { useAssets } from "./stores/assetStore";
import { resolveModelCard } from "./stores/settingsStore";
import { useUsage } from "./stores/usageStore";
import { pushError, toast } from "./stores/uiStore";
import { budgetGate } from "./capability/budget";
import { estimateCost } from "./pricing";
import { generateImage } from "./services/imageGen";
import { chromaKey, cropByRect, loadImg } from "./maskCanvas";
import { imageFamily, nearestAspect } from "./modelMeta";
import { beginTask, endTask, isAbortError } from "./runControl";
import { errMsg, isTauri, uid } from "./utils";

const running = new Set<string>();
export async function flatElementsToCanvas(nodeId: string, items: ElementItem[], options: ElementFlatOptions,
  onProgress?: (message: string, pct: number) => void, onItemDone?: (id: string) => void): Promise<boolean> {
  if (running.has(nodeId)) return false;
  running.add(nodeId);
  try {
    const board = useBoard.getState();
    const originBoard = board.activeId;
    const node = board.nodes.find(n => n.id === nodeId), src = nodeMainImage(node);
    if (!node || !src || !items.length) throw new Error("请提供效果图并勾选至少一个元素");
    const size = flatOutputSize(options);
    const card = resolveModelCard("image", options.modelId);
    const cost = estimateCost(card.model, { images: 1 });
    const gate = budgetGate(cost * items.length, "元素平面拆解", { skipPerRunCap: true,billing:card.protocol==="codex"?"subscription":undefined });
    if (gate.block) throw new Error(gate.block);
    const prompt = `将用 ${card.name} · ${card.model} 生成 ${items.length} 件${FLAT_VIEW_LABEL[options.view]}。\n每件 ${size.w}×${size.h} 像素；预估 ¥${(cost * items.length).toFixed(2)}。\n${options.view === "front" ? "保留正面设计，去除透视。" : "隐藏结构按描述推定，需核对。"}\n开始拆解？`;
    const approved = isTauri ? await (await import("@tauri-apps/plugin-dialog")).ask(prompt, { title: "单件视图重绘", kind: "info" }) : window.confirm(prompt);
    if (!approved) return false;
    const groupId = `flat-${uid(12)}`, created: string[] = [], failed: string[] = [];
    const taskId = `element-flat:${nodeId}`;
    const signal = beginTask(taskId, "单件视图重绘");
    const parent = node.parentId ? board.nodes.find(n => n.id === node.parentId) : undefined;
    const x = node.position.x + (parent?.position.x ?? 0), y = node.position.y + (parent?.position.y ?? 0) + (node.measured?.height ?? 320) + 120;
    try {
      for (const [i, item] of items.entries()) {
        if (signal.aborted || useBoard.getState().activeId !== originBoard) break;
        const currentGate = budgetGate(cost, "生成一个平面元素",{billing:card.protocol==="codex"?"subscription":undefined});
        if (currentGate.block) { failed.push(currentGate.block); break; }
        onProgress?.(`生成 ${i + 1}/${items.length}：${item.name}`, Math.round(i / items.length * 100));
        const started = Date.now();
        let billed = false;
        try {
          const crop = await cropByRect(src, { x: item.box[0], y: item.box[1], w: item.box[2], h: item.box[3] });
          const instruction = flatElementPrompt(item.name, item.text, options);
          const ratio = nearestAspect(size.w / size.h);
          const family = imageFamily(card);
          const scale = Math.min(1, 2048 / Math.max(size.w, size.h));
          const results = await generateImage(card, { prompt: instruction, refImages: [src, crop.dataUrl], n: 1, signal,
            ...(family === "banana" ? { aspect: ratio, resolution: "2K" } : { size: `${Math.max(256, Math.round(size.w * scale / 8) * 8)}x${Math.max(256, Math.round(size.h * scale / 8) * 8)}` }),
          });
          if (!results[0]) throw new Error("绘画模型未返回拆件图");
          useUsage.getState().record(card, { ok: true, images: results.length, durMs: Date.now() - started });
          billed = true;
          const png = await chromaKey(results[0], { key: [255, 0, 255], tolerance: 24, soft: 16 });
          const img = await loadImg(png);
          // 推定面的材质色由用户数值决定，不把模型近似色或残余色边当作生产色。
          const face=document.createElement("canvas");face.width=img.naturalWidth;face.height=img.naturalHeight;
          const faceCtx=face.getContext("2d")!;faceCtx.drawImage(img,0,0);
          // 清理背景色键残留的极低 alpha，避免指定背景被染色；保留正常抗锯齿过渡。
          const mask=faceCtx.getImageData(0,0,face.width,face.height);
          for(let p=3;p<mask.data.length;p+=4){if(mask.data[p]<24)mask.data[p]=0;else if(mask.data[p]>239)mask.data[p]=255;}
          faceCtx.putImageData(mask,0,0);
          if(options.view!=="front"){faceCtx.globalCompositeOperation="source-in";faceCtx.fillStyle=options.view==="back"?options.backColor:options.bottomColor;faceCtx.fillRect(0,0,face.width,face.height);}
          const canvas = document.createElement("canvas"); canvas.width = size.w; canvas.height = size.h;
          const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("无法创建平面画板");
          if (!options.transparent) { ctx.fillStyle = options.background; ctx.fillRect(0, 0, size.w, size.h); }
          const fit = Math.min(size.w / img.naturalWidth, size.h / img.naturalHeight);
          const w = img.naturalWidth * fit, h = img.naturalHeight * fit;
          ctx.drawImage(face, (size.w - w) / 2, (size.h - h) / 2, w, h);
          const raw = canvas.toDataURL("image/png");
          const output = options.unit === "mm" ? pngDataUrlWithDpi(raw, options.dpi) : raw;
          const name = `${item.name} · ${FLAT_VIEW_LABEL[options.view]}`;
          await useAssets.getState().collect({ src: output, kind: "image", name, prompt: instruction, model: card.model,
            group: { groupId, groupLabel: "单件视图重绘", groupKind: "generation", groupSlot: item.id } });
          onItemDone?.(item.id);
          // 在途切换画布时结果仍已入库，不往另一张画布插入节点。
          if (useBoard.getState().activeId !== originBoard) break;
          created.push(useBoard.getState().addNode("image", { x: x + i % 4 * 370, y: y + Math.floor(i / 4) * 390 }, {
            src: output, status: "done", name, flatMeta: { ...options, sourceNodeId: nodeId, elementName: item.name, pixelWidth: size.w, pixelHeight: size.h },
          }));
        } catch (error) {
          if (isAbortError(error)) break;
          if (!billed) useUsage.getState().record(card, { ok: false, durMs: Date.now() - started });
          failed.push(`${item.name}：${errMsg(error)}`);
        }
      }
    } finally { endTask(taskId); }
    if (created.length > 1 && useBoard.getState().activeId === originBoard) {
      const state = useBoard.getState();
      state.onNodesChange(state.nodes.map(n => ({ type: "select" as const, id: n.id, selected: created.includes(n.id) })));
      useBoard.getState().groupSelected();
      const gid = useBoard.getState().nodes.find(n => n.id === created[0])?.parentId;
      if (gid) useBoard.getState().updateData(gid, { title: `单件视图重绘 · ${FLAT_VIEW_LABEL[options.view]}` });
    }
    if (failed.length) pushError("单件视图重绘", failed.join("\n"));
    onProgress?.("拆解结束", 100);
    toast(`已生成 ${created.length} 件${failed.length ? `，${failed.length} 项未完成，详见报错中心` : ""}`, created.length ? "ok" : "info");
    return created.length === items.length;
  } catch (error) { pushError("单件视图重绘", errMsg(error)); return false; }
  finally { running.delete(nodeId); }
}
