import { beginTask, endTask, isAbortError } from "./runControl";
/**
 * 元素工坊核心 —「画布即图层」的识别与拆解编排（3.6 重构）：
 *  视觉模型识别元素清单（名称/角色/bbox/文字原文）→ 双档拆解成透明 PNG 图片节点 → 收进图层组（组内 y 序 = 层序）。
 *  拆分双档（不依赖本地大模型，任何 API 中转站可跑）：
 *   - 保像素档：bbox 裁切 + 色键抠图（边缘采样背景色），不重画、与原图像素一致；
 *   - 重绘档：逐元素图生图（纯白背景指令）→ 色键抠图，元素更干净但有轻微风格漂移（计费）。
 *  编辑闭环的另一半（单元素重绘 / 改字）在 nodeEdit.ts（与局部重绘同族的节点编辑动作）。
 */
import { flatElementsToCanvas } from "./elementFlat";
import { useBoard } from "./stores/boardStore";
import { resolveModelCard } from "./stores/settingsStore";
import { pushError, toast } from "./stores/uiStore";
import { chatCaps, imageFamily, nearestAspect } from "./modelMeta";
import { chatStream } from "./services/llm";
import { generateImage } from "./services/imageGen";
import { estimateCost } from "./pricing";
import { budgetGate } from "./capability/budget";
import { useUsage } from "./stores/usageStore";
import { chromaKey, cropByRect, loadImg } from "./maskCanvas";
import { completeBackgroundToDataUrl } from "./layering";
import { stackLayers } from "./stitchCanvas";
import { elementRedrawPrompt } from "./editPrompts";
import { nodeMainImage } from "./nodeEdit";
import { imageDims } from "./imageInfo";
import { errMsg, isTauri, parseJsonLoose, uid } from "./utils";
import type { ElementFlatOptions, ElementRole, ImageData, ModelCard } from "./types";

export type ElementItem = {
  /** 用户核对的原像素透明裁片；边界框改变后失效。 */
  cutout?: string;
  id: string;
  /** 元素外观描述（识别时要求描述性——它同时是重绘档的提示词） */
  name: string;
  role: ElementRole;
  /** 归一化 x/y/w/h */
  box: [number, number, number, number];
  /** role=text 时：图上文字的原文（改字弹卡展示） */
  text?: string;
};

export const ELEMENT_ROLE_LABEL: Record<ElementRole, string> = {
  text: "文字",
  subject: "主体",
  logo: "Logo",
  decoration: "装饰",
};

/** 让出一帧给渲染（全分辨率像素操作前的既定姿势，layering 先例） */
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** 视觉模型识别元素清单（analyzeEcom 同款骨架：默认 chat 模型 + vision 硬校验 + chatStream 带图） */
export async function analyzeElements(src: string, signal?:AbortSignal): Promise<ElementItem[]> {
  const card = resolveModelCard("chat", undefined);
  if (!chatCaps(card).vision) {
    throw new Error(`当前对话模型「${card.model}」不支持视觉输入，请在「设置」里为 chat 角色选择多模态模型（如 GLM-4.5V / Qwen-VL）`);
  }
  const system = [
    "你是平面设计稿元素分析器。只返回严格 JSON，不要 Markdown，第一个字符必须是 {。坐标全部归一化到 0..1。",
    '格式：{"elements":[{"name":"元素外观描述","role":"text|subject|logo|decoration","box":[x,y,w,h],"text":"仅 role=text 时填：图上文字的原文"}]}',
    "规则：",
    "- 识别海报、美陈、文化墙或展陈效果图中的标题/副标题/正文块（role=text，text 必须填图上原文）、人物/商品主体（role=subject）、Logo/徽章（role=logo）、装饰图形/边框/图标（role=decoration）；",
    "- name 必须是外观描述（如「红色毛笔字大标题」「穿蓝色卫衣的男孩半身像」「金色圆形徽章」），不要只写「标题」「元素」——它会直接用作重绘提示词；",
    "- 同类的独立对象分开列；背景不要列；框要完整包住元素但尽量紧；最多 16 项。",
  ].join("\n");
  const result = await chatStream(
    card,
    [{ role: "user", text: "分析这张图片的可编辑元素。优先保证文字块、主体和 Logo 完整；不要把阴影或背景纹理误判为元素。", images: [src] }],
    { system, signal },
  );
  const raw = parseJsonLoose(result.text) as { elements?: unknown[] } | null;
  if (!raw || !Array.isArray(raw.elements)) {
    throw new Error(`模型没有按 JSON 格式返回元素清单（回复前 200 字：${result.text.slice(0, 200)}），请重试或换一个对话模型`);
  }
  const allowed = new Set<ElementRole>(["text", "subject", "logo", "decoration"]);
  const items: ElementItem[] = [];
  for (const item of raw.elements) {
    if (!item || typeof item !== "object" || items.length >= 16) continue;
    const rec = item as Record<string, unknown>;
    const role = String(rec.role ?? "decoration") as ElementRole;
    if (!allowed.has(role)) continue;
    const b = Array.isArray(rec.box) ? rec.box.map(Number) : [];
    if (b.length !== 4 || b.some((n) => !Number.isFinite(n))) continue;
    const x = Math.min(0.985, clamp01(b[0]));
    const y = Math.min(0.985, clamp01(b[1]));
    const w = Math.max(0.015, Math.min(1 - x, b[2]));
    const h = Math.max(0.015, Math.min(1 - y, b[3]));
    const name = String(rec.name ?? "").trim() || ELEMENT_ROLE_LABEL[role];
    items.push({
      id: `elem_${items.length}_${uid(4)}`,
      name,
      role,
      box: [x, y, w, h],
      text: role === "text" ? String(rec.text ?? "").trim() || undefined : undefined,
    });
  }
  if (!items.length) throw new Error("视觉模型没有识别到可用元素，请换一张图或重试");
  return items;
}

export type SplitOptions = {
  /** pixel = 保像素（裁切+色键，免费）；redraw = 重绘（图生图纯白背景+色键，计费） */
  mode: "pixel" | "redraw" | "flat";
  flat?: ElementFlatOptions;
  /** 背景层做本地遮挡补全（BFS 边界扩散），默认开 */
  bgComplete: boolean;
  onProgress?: (message: string, pct: number) => void;
  onItemDone?: (id: string) => void;
};

/** 拆解到画布：背景层（补全/原图）+ 逐元素透明 PNG → 图层组（创建序 = 层序，背景最先 = 最底）。返回是否成功（失败已 toast） */
export async function splitElementsToCanvas(srcNodeId: string, items: ElementItem[], opts: SplitOptions): Promise<boolean> {
  if (opts.mode === "flat") {
    if (!opts.flat) return false;
    return flatElementsToCanvas(srcNodeId, items, opts.flat, opts.onProgress, opts.onItemDone);
  }
  const s = useBoard.getState();
  const srcNode = s.nodes.find((n) => n.id === srcNodeId);
  const src = nodeMainImage(srcNode);
  if (!srcNode || !src) {
    toast("当前节点没有可拆解的图片", "err");
    return false;
  }
  if (!items.length) {
    toast("请至少勾选一个要拆解的元素", "err");
    return false;
  }

  // 重绘档先摊开账单（逐元素图生图 × N），确认后才花钱
  let imageCard: ModelCard | undefined;
  if (opts.mode === "redraw") {
    try {
      imageCard = resolveModelCard("image", undefined);
    } catch (e) {
      toast(errMsg(e), "err");
      return false;
    }
    const est = estimateCost(imageCard.model, { images: 1 }) * items.length;
    const gate = budgetGate(est, "元素高清重绘", { skipPerRunCap: true,billing:imageCard.protocol==="codex"?"subscription":undefined });
    if (gate.block) { toast(gate.block, "err"); return false; }
    const msg = `将重新绘制 ${items.length} 个元素（每个一次图生图，纯白背景后抠图成透明图层）。${est > 0 ? `\n预估费用：约 ¥${est.toFixed(2)}（按「${imageCard.model}」单价）。` : ""}\n确定开始拆解？`;
    let go: boolean;
    if (isTauri) {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      go = await ask(msg, { title: "重绘拆解", kind: "warning" });
    } else {
      go = window.confirm(msg);
    }
    if (!go) return false;
  }

  const parent = srcNode.parentId ? s.nodes.find((n) => n.id === srcNode.parentId) : undefined;
  const absX = srcNode.position.x + (parent?.position.x ?? 0);
  const absY = srcNode.position.y + (parent?.position.y ?? 0);
  const h = srcNode.measured?.height ?? 320;
  const baseName = (srcNode.data as Record<string, unknown>).name;
  const base = typeof baseName === "string" && baseName ? baseName : "原图";

  const taskId=`element-split:${srcNodeId}`,signal=beginTask(taskId,"元素分层"),originBoard=s.activeId;
  const check=()=>{signal.throwIfAborted();if(useBoard.getState().activeId!==originBoard)throw new DOMException("已取消：画布已切换","AbortError");};
  const report = (message: string, pct: number) => opts.onProgress?.(message, pct);
  try {
    // 虚拟画布：图层组内按原图空间位置摆放（位置即语义——元素在原图哪里，图层节点就在组内哪里）
    const srcD = (await imageDims(src)) ?? { w: 1024, h: 1024 };
    const CW = 720;
    const CH = Math.round((CW * srcD.h) / srcD.w);
    // 1) 背景层（最先创建 = 数组序最前 = 合成/拼回最底层）
    report(opts.bgComplete ? "补全被元素遮挡的背景…" : "准备背景层…", 4);
    await nextFrame();
    let bgSrc = src;
    if (opts.bgComplete) {
      try {
        bgSrc = await completeBackgroundToDataUrl(src, items.map((i) => i.box));
      } catch {
        bgSrc = src; // 补全失败退回原图背景，不阻塞拆解
      }
    }
    check();
    const created: string[] = [];
    // 背景的 elemMeta.box = 全画布：按原位拼回/PSD 原位导出时第一层铺满
    created.push(
      useBoard.getState().addNode("image", { x: absX, y: absY + h + 140 }, {
        src: bgSrc,
        name: `${base} · 背景`,
        status: "done",
        elemMeta: { role: "decoration", box: [0, 0, 1, 1] },
      }),
    );

    // 2) 逐元素拆解：保像素 = 裁切+色键（边缘采样）；重绘 = 局部特写图生图（高清放大）+ 色键（白色键显式指定）
    const failed: string[] = [];
    const placedBoxes: Array<[number, number, number, number]> = [];
    for (let i = 0; i < items.length; i++) {
      if(signal.aborted||useBoard.getState().activeId!==originBoard)break;
      const it = items[i];
      report(`拆解元素 ${i + 1}/${items.length}：${it.name}…`, 8 + Math.round((i / items.length) * 84));
      await nextFrame();
      try {
        let png: string;
        if (opts.mode === "pixel") {
          const crop = await cropByRect(src, { x: it.box[0], y: it.box[1], w: it.box[2], h: it.box[3] });
          png = it.cutout ?? await chromaKey(crop.dataUrl);
        } else {
          // 高清重绘：先裁出局部特写作参考（模型注意力聚焦在元素本身），按 2 倍目标尺寸重画——
          // 拆出来的每层都是高清素材，按原位拼回/导 PSD 即得到「高清分层重建」
          const card = imageCard!;
          const gate = budgetGate(estimateCost(card.model, { images: 1 }), "元素高清重绘",{billing:card.protocol==="codex"?"subscription":undefined});
          if (gate.block) throw new Error(gate.block);
          const crop = await cropByRect(src, { x: it.box[0], y: it.box[1], w: it.box[2], h: it.box[3] });
          const fam = imageFamily(card);
          const up = (v: number) => Math.max(256, Math.min(2048, Math.round((v * 2) / 8) * 8));
          const started = Date.now();
          const results = await generateImage(card, {
            prompt: elementRedrawPrompt(it.name),
            refImages: [crop.dataUrl],
            n: 1, signal,
            size: fam === "banana" ? undefined : `${up(crop.w)}x${up(crop.h)}`,
            aspect: fam === "banana" ? nearestAspect(crop.w / crop.h) : undefined,
            resolution: fam === "banana" ? "2K" : undefined,
          });
          if (!results.length) throw new Error("绘画模型未返回元素图片");
          useUsage.getState().record(card, { ok: true, images: results.length, durMs: Date.now() - started });
          png = await chromaKey(results[0], { key: [255, 255, 255], tolerance: 36, soft: 24 });
        }
        check();
        // 摆放位先落在源节点下方（建组后由 placeGroupMembers 统一改写为原图位置）
        const row = Math.floor(i / 4);
        const col = i % 4;
        created.push(
          useBoard
            .getState()
            .addNode("image", { x: absX + 360 + col * 340, y: absY + h + 140 + row * 330 }, {
              src: png,
              name: it.name,
              status: "done",
              elemMeta: { role: it.role, text: it.text, box: it.box },
            }),
        );
        placedBoxes.push(it.box);
        opts.onItemDone?.(it.id);
      } catch (e) {
        if(isAbortError(e))break;
        failed.push(`${it.name}（${errMsg(e).slice(0, 60)}）`);
      }
    }

    // 3) 收进图层组 → 原位摆放：背景在左上（整画布语义），元素中心 = 原图 box 中心映射到虚拟画布
    if (failed.length) pushError("元素分层",failed.join("；"));
    if (created.length >= 2 && useBoard.getState().activeId===originBoard) {
      const bs = useBoard.getState();
      bs.onNodesChange(bs.nodes.map(n => ({ type: "select" as const, id: n.id, selected: created.includes(n.id) })));
      bs.groupSelected();
      const s3 = useBoard.getState();
      const gid = s3.nodes.find((n) => n.id === created[1])?.parentId;
      if (gid) {
        const pos: Record<string, { x: number; y: number }> = { [created[0]]: { x: 20, y: 56 } };
        const NODE_W = 240;
        for (let i = 0; i < placedBoxes.length; i++) {
          const nid = created[i + 1];
          if (!nid) break;
          const b = placedBoxes[i];
          const cx = 20 + (b[0] + b[2] / 2) * CW;
          const cy = 56 + (b[1] + b[3] / 2) * CH;
          const ratio = (b[2] * srcD.w) / (b[3] * srcD.h || 1);
          const h = Math.max(48, Math.min(420, Math.round(NODE_W / (ratio || 1))));
          pos[nid] = { x: Math.round(cx - NODE_W / 2), y: Math.round(cy - h / 2) };
        }
        s3.placeGroupMembers(gid, pos, { w: CW + 40, h: CH + 110 });
        s3.updateData(gid, { layerGroup: true, title: `图层组 · ${base}` });
      }
      toast(
        `已拆解 ${created.length - 1} 个元素 + 背景层，图层按原图位置摆放${failed.length ? `；${failed.length} 个失败已跳过` : ""}。改完点组头「合成图层」按原位拼回`,
        "ok",
      );
      report("拆解完成", 100);
      return created.length-1===items.length;
    }
    if(signal.aborted)return false;
    toast("没有成功拆解出任何元素", "err");
    if (failed.length) pushError("元素分层", `以下元素拆解失败已跳过：${failed.join("；")}`);
    return false;
  } catch (e) {
    if(isAbortError(e))return false;
    const msg = errMsg(e);
    pushError("元素分层", msg);
    toast(`拆解失败：${msg}`, "err");
    return false;
  } finally {endTask(taskId);}
}

/** 图层组合成（组头「合成图层」按钮）：成员带 elemMeta.box 时按原图位置拼回（画布=背景层尺寸，数组序=层序）；
 *  老图层组没有 box 则回退 y 序居中堆叠。产物放组右侧 */
export async function composeLayerGroup(groupId: string): Promise<void> {
  const s = useBoard.getState();
  const group = s.nodes.find((n) => n.id === groupId);
  if (!group) return;
  // 数组序 = 创建序 = 层序（背景最先创建 = 最底层；原位模式下 y 序不再可靠）
  const members = s.nodes.filter((n) => n.parentId === groupId);
  const srcs = members.map((n) => nodeMainImage(n)).filter((v): v is string => !!v);
  if (srcs.length < 2) {
    toast("图层组里至少需要 2 张图才能合成", "err");
    return;
  }
  const gx = group.position.x + (group.measured?.width ?? 640) + 160;
  try {
    const boxes = members.map((n) => (n.data as ImageData).elemMeta?.box);
    if (boxes.every((b) => b) && nodeMainImage(members[0])) {
      // 按原位拼回：高清重绘后的每层贴回原位 =「高清分层重建」的合成
      const bgD = (await imageDims(nodeMainImage(members[0])!)) ?? { w: 1024, h: 1024 };
      const c = document.createElement("canvas");
      c.width = Math.max(64, bgD.w);
      c.height = Math.max(64, bgD.h);
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("无法创建合成画布上下文");
      for (const m of members) {
        const src = nodeMainImage(m);
        const b = (m.data as ImageData).elemMeta?.box;
        if (!src || !b) continue;
        const img = await loadImg(src);
        ctx.drawImage(img, b[0] * c.width, b[1] * c.height, b[2] * c.width, b[3] * c.height);
      }
      useBoard.getState().addNode("image", { x: gx, y: group.position.y }, { src: c.toDataURL("image/png"), name: "图层合成（原位拼回）", status: "done" });
      toast(`已按原图位置拼回 ${members.length} 层（背景铺底），需要 AI 融合光影可把合成图接入图生图`, "ok");
      return;
    }
    const out = await stackLayers(srcs);
    useBoard.getState().addNode("image", { x: gx, y: group.position.y }, { src: out.dataUrl, name: "图层合成", status: "done" });
    toast(`已按 ${srcs.length} 层合成（组内排在上面/靠左的成员在底层），需要 AI 融合光影可把合成图接入图生图`, "ok");
  } catch (e) {
    toast(`合成失败：${errMsg(e)}`, "err");
  }
}

/** 图层组导出准备：成员按层序读成图层数组（box 供 PSD 原位放置）+ 本地合成预览（PSD 需要 composite 底图） */
export async function layerGroupForExport(
  groupId: string,
): Promise<{ layers: Array<{ name: string; src: string; box?: [number, number, number, number] }>; composite: string; width: number; height: number } | null> {
  const s = useBoard.getState();
  const members = s.nodes.filter((n) => n.parentId === groupId);
  type LayerEntry = { name: string; src: string; box?: [number, number, number, number] };
  const layers = members
    .map((n): LayerEntry | null => {
      const src = nodeMainImage(n);
      const name = String((n.data as Record<string, unknown>).name ?? "图层");
      const box = (n.data as ImageData).elemMeta?.box;
      return src ? { name, src, box } : null;
    })
    .filter((v): v is LayerEntry => !!v);
  if (!layers.length) return null;
  if (layers.every(l => l.box)) {
    const bg = await loadImg(layers[0].src);
    const c = document.createElement("canvas"); c.width = bg.naturalWidth; c.height = bg.naturalHeight;
    const ctx = c.getContext("2d"); if (!ctx) throw new Error("无法创建图层导出预览");
    for (const layer of layers) {
      const [x, y, w, h] = layer.box!;
      ctx.drawImage(await loadImg(layer.src), x * c.width, y * c.height, w * c.width, h * c.height);
    }
    return { layers, composite: c.toDataURL("image/png"), width: c.width, height: c.height };
  }
  const out = await stackLayers(layers.map((l) => l.src));
  return { layers, composite: out.dataUrl, width: out.w, height: out.h };
}
