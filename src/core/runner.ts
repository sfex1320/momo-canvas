/**
 * 节点运行引擎：收集直接上游 → 调用对应服务 → 结果写回节点
 */
import { useBoard } from "./stores/boardStore";
import { useSettings } from "./stores/settingsStore";
import { useComfy } from "./stores/comfyStore";
import { toast, useUi } from "./stores/uiStore";
import { chatStream, chatOnce, OPTIMIZE_SYSTEM } from "./services/llm";
import { generateImage } from "./services/imageGen";
import { generateVideo } from "./services/videoGen";
import { webSearch, searchContext } from "./services/webSearch";
import { runComfyTemplate, uploadImageToComfy } from "./services/comfy";
import { autoSaveImage } from "./services/imageSaver";
import { errMsg } from "./utils";
import type {
  ChatData,
  ChatMsg,
  ComfyData,
  ImageData,
  ImageGenData,
  NodeKind,
  PromptData,
  VideoGenData,
} from "./types";

/* ---------- 上游收集（仅直接前驱） ---------- */
export function collectUpstream(nodeId: string): { texts: string[]; images: string[] } {
  const { nodes, edges } = useBoard.getState();
  const texts: string[] = [];
  const images: string[] = [];
  for (const e of edges) {
    if (e.target !== nodeId) continue;
    const src = nodes.find((n) => n.id === e.source);
    if (!src) continue;
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
  const cfg = useSettings.getState().settings.image;
  upd(id, { status: "running", error: undefined });
  try {
    const size = data.size === "default" ? cfg.size : data.size;
    const results = await generateImage(cfg, {
      prompt,
      size,
      n: data.count ?? 1,
      refImages: images.length ? images : undefined,
    });
    upd(id, { status: "done", results, picked: 0 });
    for (const src of results) {
      useUi.getState().addGallery({ kind: "image", src, prompt, model: cfg.model, nodeId: id });
    }
    void maybeAutoSave(results, { prompt, model: cfg.model });
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
  const cfg = useSettings.getState().settings.video;
  upd(id, { status: "running", error: undefined, progress: "提交任务…", resultUrl: undefined });
  try {
    const url = await generateVideo(cfg, {
      prompt,
      image: images[0],
      onProgress: (m) => upd(id, { progress: m }),
    });
    upd(id, { status: "done", resultUrl: url, progress: undefined });
    useUi.getState().addGallery({ kind: "video", src: url, prompt, model: cfg.model, nodeId: id });
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
        // 上游图片依次上传填入图片参数
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
        // 上游文本填入第一个空的文本参数
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

    await chatStream(settings.chat, history, {
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
    const optimized = await chatOnce(useSettings.getState().settings.chat, OPTIMIZE_SYSTEM, text);
    upd(id, { text: optimized, optimizing: false });
  } catch (e) {
    upd(id, { optimizing: false });
    toast(errMsg(e), "err");
  }
}
