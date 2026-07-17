/**
 * 节点运行引擎：收集上游 → 调用对应服务 → 结果写回节点 + 收录资产库
 */
import { useBoard } from "./stores/boardStore";
import { useSettings, resolveModelCard } from "./stores/settingsStore";
import { useComfy } from "./stores/comfyStore";
import { toast, useUi } from "./stores/uiStore";
import { useAssets } from "./stores/assetStore";
import { chatStream, chatOnce, OPTIMIZE_SYSTEM } from "./services/llm";
import { generateImage } from "./services/imageGen";
import { generateVideo } from "./services/videoGen";
import { webSearch, searchContext } from "./services/webSearch";
import { runComfyTemplate, uploadImageToComfy } from "./services/comfy";
import { autoSaveImage } from "./services/imageSaver";
import { imageFamily } from "./modelMeta";
import { errMsg } from "./utils";
import type {
  CaptionData,
  ChatData,
  ChatMsg,
  ComfyData,
  CombineData,
  ImageData,
  ImageGenData,
  LlmTextData,
  NodeKind,
  PromptData,
  StylePresetData,
  VideoGenData,
} from "./types";

const SEPARATORS: Record<CombineData["separator"], string> = {
  comma: ", ",
  newline: "\n",
  space: " ",
};

/* ---------- 上游收集 ----------
   直接前驱取值；纯文本节点（拼接/风格预设）会向上递归物化自己的输出；
   组节点按成员位置顺序聚合；「忽略」的节点不向下游传递 */

/** 单个节点自身的输出（文本 / 图片） */
function nodeOutput(src: { id: string; type?: string; data: unknown }, visited: Set<string>): { texts: string[]; images: string[] } {
  const texts: string[] = [];
  const images: string[] = [];
  const kind = src.type as NodeKind;
  const d = src.data as Record<string, unknown>;
  switch (kind) {
    case "prompt": {
      const t = ((d as PromptData).text ?? "").trim();
      if (t) texts.push(t);
      break;
    }
    case "chat": {
      const msgs = (d as ChatData).messages ?? [];
      const last = [...msgs].reverse().find((m) => m.role === "assistant");
      if (last?.text) texts.push(last.text.trim());
      break;
    }
    case "caption": {
      const t = ((d as CaptionData).result ?? "").trim();
      if (t) texts.push(t);
      break;
    }
    case "llmText": {
      const t = ((d as LlmTextData).result ?? "").trim();
      if (t) texts.push(t);
      break;
    }
    case "combine": {
      const cd = d as CombineData;
      const up = collectUpstream(src.id, visited);
      const parts = [...up.texts, (cd.extra ?? "").trim()].filter(Boolean);
      if (parts.length) texts.push(parts.join(SEPARATORS[cd.separator] ?? ", "));
      break;
    }
    case "stylePreset": {
      const sel = (d as StylePresetData).selected ?? [];
      if (sel.length) texts.push(sel.join(", "));
      break;
    }
    case "image": {
      const s = (d as ImageData).src;
      if (s) images.push(s);
      break;
    }
    case "imageGen": {
      const g = d as ImageGenData;
      const s = g.results?.[g.picked ?? 0];
      if (s) images.push(s);
      break;
    }
    case "comfy": {
      const g = d as ComfyData;
      const s = g.results?.[g.picked ?? 0];
      if (s) images.push(s);
      break;
    }
    default:
      break;
  }
  return { texts, images };
}

export function collectUpstream(nodeId: string, visited = new Set<string>()): { texts: string[]; images: string[] } {
  const { nodes, edges } = useBoard.getState();
  const texts: string[] = [];
  const images: string[] = [];
  if (visited.has(nodeId)) return { texts, images };
  visited.add(nodeId);

  for (const e of edges) {
    if (e.target !== nodeId) continue;
    const src = nodes.find((n) => n.id === e.source);
    if (!src) continue;
    if ((src.data as Record<string, unknown>).ignored) continue;
    if (src.type === "group") {
      // 组：成员按位置（上→下、左→右）依次输出；按出口类型分流
      const members = nodes
        .filter((n) => n.parentId === src.id && !(n.data as Record<string, unknown>).ignored)
        .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
      for (const m of members) {
        const o = nodeOutput(m, visited);
        if (e.sourceHandle === "out-image") images.push(...o.images);
        else texts.push(...o.texts);
      }
      continue;
    }
    const o = nodeOutput(src, visited);
    texts.push(...o.texts);
    images.push(...o.images);
  }
  return { texts, images };
}

const upd = (id: string, patch: Record<string, unknown>) => useBoard.getState().updateData(id, patch);

async function maybeAutoSave(images: string[], meta: { prompt?: string; model?: string }) {
  const { save } = useSettings.getState().settings;
  if (!save.autoSave) return;
  try {
    let last = "";
    for (const img of images) last = await autoSaveImage(img, save, meta);
    if (last) toast(`已自动保存 ${images.length} 张 → ${last}`, "ok");
  } catch (e) {
    toast(`自动保存失败：${errMsg(e)}`, "err");
  }
}

/** 收录进资产库（后台静默） */
function collectToLibrary(kind: "image" | "video", srcs: string[], meta: { prompt?: string; model?: string }) {
  for (const src of srcs) {
    void useAssets.getState().collect({ src, kind, prompt: meta.prompt, model: meta.model });
  }
}

/* ---------- 生成图像 ---------- */
export async function runImageGen(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as ImageGenData;
  if (data.status === "running") return;
  const { texts, images } = collectUpstream(id);
  const prompt = (data.prompt ?? "").trim() || texts.join("\n");
  if (!prompt && !images.length) {
    toast("请输入提示词，或连接一个提示词/对话节点", "err");
    return;
  }
  upd(id, { status: "running", error: undefined });
  try {
    const card = resolveModelCard("image", data.modelId);
    const family = imageFamily(card);
    // 自定义宽高优先；Nano Banana 走 aspect/resolution，不传 size
    const customSize = data.width && data.height ? `${data.width}x${data.height}` : undefined;
    const size = family === "banana" ? undefined : customSize ?? (data.size === "default" ? card.size : data.size);
    const results = await generateImage(card, {
      prompt,
      size,
      n: data.count ?? 1,
      refImages: images.length ? images : undefined,
      aspect: family === "banana" ? data.aspect : undefined,
      resolution: family === "banana" ? data.resolution : undefined,
      quality: family === "gpt" ? data.quality : undefined,
    });
    upd(id, { status: "done", results, picked: 0 });
    for (const src of results) {
      useUi.getState().addGallery({ kind: "image", src, prompt, model: card.model, nodeId: id });
    }
    collectToLibrary("image", results, { prompt, model: card.name });
    void maybeAutoSave(results, { prompt, model: card.model });
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e) });
    toast(errMsg(e), "err");
  }
}

/* ---------- 生成视频 ---------- */
export async function runVideoGen(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as VideoGenData;
  if (data.status === "running") return;
  const { texts, images } = collectUpstream(id);
  const prompt = (data.prompt ?? "").trim() || texts.join("\n");
  if (!prompt && !images.length) {
    toast("请输入视频描述，或连接提示词/图片节点", "err");
    return;
  }
  upd(id, { status: "running", error: undefined, progress: "提交任务…", resultUrl: undefined });
  try {
    const card = resolveModelCard("video", data.modelId);
    const url = await generateVideo(card, {
      prompt,
      image: images[0],
      onProgress: (m) => upd(id, { progress: m }),
    });
    upd(id, { status: "done", resultUrl: url, progress: undefined });
    useUi.getState().addGallery({ kind: "video", src: url, prompt, model: card.model, nodeId: id });
    collectToLibrary("video", [url], { prompt, model: card.name });
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e), progress: undefined });
    toast(errMsg(e), "err");
  }
}

/* ---------- ComfyUI ---------- */
export async function runComfy(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as ComfyData;
  if (data.status === "running") return;
  const tpl = useComfy.getState().templates.find((t) => t.id === data.templateId);
  if (!tpl) {
    toast("请先为该节点选择一个 ComfyUI 模板", "err");
    return;
  }
  const settings = useSettings.getState().settings;
  const { texts, images } = collectUpstream(id);
  upd(id, { status: "running", error: undefined, progress: "准备参数…" });
  try {
    const values: Record<string, string | number | boolean> = {};
    let imgIdx = 0;
    let firstTextFilled = false;
    for (const p of tpl.params) {
      const own = data.params?.[p.key];
      if (p.kind === "image") {
        if (imgIdx < images.length) {
          upd(id, { progress: `上传参考图 ${imgIdx + 1}…` });
          values[p.key] = await uploadImageToComfy(settings.comfy.host, images[imgIdx]);
          imgIdx++;
        } else if (own !== undefined && own !== "") {
          values[p.key] = own;
        } else {
          throw new Error(`图片参数「${p.label}」缺少输入：请连接上游图片节点`);
        }
        continue;
      }
      if (p.kind === "text" && !firstTextFilled && texts.length && (own === undefined || own === "")) {
        values[p.key] = texts.join("\n");
        firstTextFilled = true;
        continue;
      }
      values[p.key] = own !== undefined ? own : (p.value as string | number | boolean);
    }
    const { images: results } = await runComfyTemplate(settings.comfy.host, tpl, values, {
      onProgress: (m) => upd(id, { progress: m }),
    });
    upd(id, { status: "done", results, picked: 0, progress: undefined });
    const promptText = String(values[tpl.params.find((p) => p.kind === "text")?.key ?? ""] ?? "");
    for (const src of results) {
      useUi.getState().addGallery({ kind: "image", src, prompt: promptText, model: tpl.name, nodeId: id });
    }
    collectToLibrary("image", results, { prompt: promptText, model: `ComfyUI · ${tpl.name}` });
    void maybeAutoSave(results, { prompt: promptText, model: tpl.name });
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e), progress: undefined });
    toast(errMsg(e), "err");
  }
}

/* ---------- 对话 ---------- */
export async function sendChat(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as ChatData;
  if (data.status === "running") return;
  const draft = (data.draft ?? "").trim();
  if (!draft) return;
  const settings = useSettings.getState().settings;
  const { images } = collectUpstream(id);

  const userMsg: ChatMsg = { role: "user", text: draft, images: images.length ? images : undefined };
  let history: ChatMsg[] = [...(data.messages ?? []), userMsg];
  upd(id, { status: "running", error: undefined, draft: "", messages: history });

  try {
    const card = resolveModelCard("chat", data.modelId);
    let system: string | undefined;
    let sources: ChatMsg["sources"];
    if (data.webSearch) {
      upd(id, { messages: [...history, { role: "assistant", text: "", reasoning: "正在联网搜索…" }] });
      try {
        sources = await webSearch(settings.search, draft);
        system = searchContext(sources ?? []);
      } catch (e) {
        toast(`联网搜索失败，将直接回答：${errMsg(e)}`, "err");
      }
    }

    const assistant: ChatMsg = { role: "assistant", text: "", reasoning: "", sources };
    const commit = () => upd(id, { messages: [...history, { ...assistant }] });
    commit();

    await chatStream(card, history, {
      system,
      onText: (full) => {
        assistant.text = full;
        commit();
      },
      onReasoning: (full) => {
        assistant.reasoning = full;
        commit();
      },
    });
    history = [...history, { ...assistant }];
    upd(id, { status: "done", messages: history });
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e), messages: history });
    toast(errMsg(e), "err");
  }
}

/* ---------- 提示词 AI 优化 ---------- */
export async function optimizePrompt(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as PromptData;
  const text = (data.text ?? "").trim();
  if (!text) {
    toast("先写一点想法，再让 AI 帮你扩写", "err");
    return;
  }
  upd(id, { optimizing: true });
  try {
    const card = resolveModelCard("chat");
    const optimized = await chatOnce(card, OPTIMIZE_SYSTEM, text);
    upd(id, { text: optimized, optimizing: false });
  } catch (e) {
    upd(id, { optimizing: false });
    toast(errMsg(e), "err");
  }
}

/* ---------- 反推描述 ---------- */
const CAPTION_SYSTEMS: Record<CaptionData["mode"], string> = {
  prompt:
    "你是图像反推提示词专家。仔细观察用户发来的图片，输出一段可直接用于 AI 绘画复现该图的中文提示词：主体、构图、风格、光影、色彩、镜头、质感。只输出提示词本身。",
  detail: "你是图像分析师。详细描述用户发来的图片：主体内容、场景、风格、构图、色彩与值得注意的细节。用中文分段描述。",
  tags: "观察用户发来的图片，输出 15-25 个英文标签词（danbooru 风格，逗号分隔），从主体到风格到质感排列。只输出标签。",
};

export async function runCaption(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as CaptionData;
  if (data.status === "running") return;
  const { images } = collectUpstream(id);
  if (!images.length) {
    toast("请先连接一个上游图片节点", "err");
    return;
  }
  upd(id, { status: "running", error: undefined });
  try {
    const card = resolveModelCard("chat", data.modelId);
    const { text } = await chatStream(
      card,
      [{ role: "user", text: "请分析这张图片。", images: [images[0]] }],
      {
        system: CAPTION_SYSTEMS[data.mode] ?? CAPTION_SYSTEMS.prompt,
        onText: (full) => upd(id, { result: full }),
      },
    );
    upd(id, { status: "done", result: text.trim() });
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e) });
    toast(errMsg(e), "err");
  }
}

/* ---------- 文本处理 ---------- */
const LLM_TEXT_SYSTEMS: Record<Exclude<LlmTextData["op"], "custom">, string> = {
  optimize: OPTIMIZE_SYSTEM,
  zh2en: "把用户输入的绘画提示词翻译成地道的英文 AI 绘画提示词，保留专业术语，只输出翻译结果。",
  expand: "把用户输入的文字扩写得更丰富具体（补充细节、场景、氛围），保持原意，中文输出，只输出扩写结果。",
  shorten: "把用户输入的文字精简压缩，保留核心信息与关键词，只输出精简结果。",
};

export async function runLlmText(id: string) {
  const node = useBoard.getState().nodes.find((n) => n.id === id);
  if (!node) return;
  const data = node.data as LlmTextData;
  if (data.status === "running") return;
  const { texts } = collectUpstream(id);
  const input = texts.join("\n").trim();
  if (!input) {
    toast("请先连接上游文本节点（提示词/对话等）", "err");
    return;
  }
  upd(id, { status: "running", error: undefined });
  try {
    const card = resolveModelCard("chat", data.modelId);
    const system =
      data.op === "custom"
        ? (data.custom ?? "").trim() || "按用户期望处理输入文本，只输出处理结果。"
        : LLM_TEXT_SYSTEMS[data.op];
    const { text } = await chatStream(card, [{ role: "user", text: input }], {
      system,
      onText: (full) => upd(id, { result: full }),
    });
    upd(id, { status: "done", result: text.trim() });
  } catch (e) {
    upd(id, { status: "error", error: errMsg(e) });
    toast(errMsg(e), "err");
  }
}
