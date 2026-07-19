/**
 * ComfyUI 工作流示意图 — 布局与中文词典
 *  - 分层自动布局（最长路径分层 + 一趟重心排序减少交叉）
 *  - 常见节点类型 / 输入名的中文词典
 *  （能力识别 analyzeCaps / 忽略节点 canDisable 在 services/comfy.ts）
 */
import type { ComfyWfNode } from "../../core/types";

/* ---------------- 中文词典 ---------------- */

const CLASS_ZH: Record<string, string> = {
  KSampler: "K采样器",
  KSamplerAdvanced: "K采样器（高级）",
  CheckpointLoaderSimple: "加载大模型",
  CLIPTextEncode: "提示词编码",
  CLIPSetLastLayer: "CLIP 跳层",
  VAEDecode: "VAE 解码",
  VAEEncode: "VAE 编码",
  VAEEncodeForInpaint: "VAE 编码（重绘）",
  VAELoader: "加载 VAE",
  EmptyLatentImage: "空白画布（潜空间）",
  EmptySD3LatentImage: "空白画布（SD3）",
  LoadImage: "加载图片",
  LoadImageMask: "加载蒙版",
  SaveImage: "保存图片",
  PreviewImage: "预览图像",
  ImageScale: "图像缩放",
  ImageScaleBy: "图像倍数缩放",
  UpscaleModelLoader: "加载放大模型",
  ImageUpscaleWithModel: "模型放大图像",
  LatentUpscale: "潜空间放大",
  LatentUpscaleBy: "潜空间倍数放大",
  LoraLoader: "加载 LoRA",
  LoraLoaderModelOnly: "加载 LoRA（仅模型）",
  ControlNetLoader: "加载 ControlNet",
  ControlNetApply: "应用 ControlNet",
  ControlNetApplyAdvanced: "应用 ControlNet（高级）",
  InpaintModelConditioning: "重绘条件",
  DualCLIPLoader: "加载双 CLIP",
  TripleCLIPLoader: "加载三 CLIP",
  CLIPLoader: "加载 CLIP",
  UNETLoader: "加载 UNet",
  SamplerCustom: "自定义采样器",
  SamplerCustomAdvanced: "自定义采样器（高级）",
  BasicScheduler: "基础调度器",
  KSamplerSelect: "选择采样器",
  RandomNoise: "随机噪声",
  ImageInvert: "图像反相",
  ImageBatch: "图像组批",
  ImageCrop: "图像裁剪",
  ImagePadForOutpaint: "扩图补边",
  ConditioningCombine: "条件合并",
  ConditioningConcat: "条件拼接",
  ConditioningSetArea: "条件区域",
  ConditioningZeroOut: "条件清零",
  FluxGuidance: "Flux 引导强度",
  ModelSamplingSD3: "SD3 模型采样",
  CLIPVisionLoader: "加载视觉 CLIP",
  CLIPVisionEncode: "视觉编码",
  StyleModelLoader: "加载风格模型",
  StyleModelApply: "应用风格模型",
  GrowMask: "蒙版扩张",
  MaskToImage: "蒙版转图像",
  ImageToMask: "图像转蒙版",
  InvertMask: "蒙版反相",
  SetLatentNoiseMask: "设置潜空间蒙版",
  RepeatLatentBatch: "潜空间重复组批",
  ImageCompositeMasked: "蒙版合成图像",
  DifferentialDiffusion: "差分扩散",
  "PlaySound|pysssss": "播放提示音",
};

const INPUT_ZH: Record<string, string> = {
  seed: "种子",
  noise_seed: "噪声种子",
  steps: "步数",
  cfg: "提示词强度 CFG",
  denoise: "重绘幅度",
  sampler_name: "采样器",
  scheduler: "调度器",
  text: "文本",
  prompt: "提示词",
  width: "宽",
  height: "高",
  batch_size: "出图张数",
  image: "图片",
  images: "图像",
  mask: "蒙版",
  filename_prefix: "文件名前缀",
  ckpt_name: "模型文件",
  vae_name: "VAE 文件",
  lora_name: "LoRA 文件",
  unet_name: "UNet 文件",
  clip_name: "CLIP 文件",
  control_net_name: "ControlNet 文件",
  strength: "强度",
  strength_model: "模型强度",
  strength_clip: "CLIP 强度",
  upscale_method: "放大算法",
  upscale_model: "放大模型",
  scale_by: "放大倍数",
  resolution: "分辨率",
  max_resolution: "最大分辨率",
  color_correction: "色彩校正",
  positive: "正面条件",
  negative: "负面条件",
  model: "模型",
  clip: "CLIP",
  vae: "VAE",
  latent_image: "潜空间图像",
  samples: "采样结果",
  pixels: "像素图",
  conditioning: "条件",
  guidance: "引导强度",
  megapixels: "百万像素",
  crop: "裁剪方式",
  upload: "上传",
  grow_mask_by: "蒙版扩张量",
  batch: "批量",
  amount: "数量",
  start_step: "起始步",
  end_step: "结束步",
  add_noise: "添加噪声",
  return_with_leftover_noise: "保留剩余噪声",
  stop_at_clip_layer: "CLIP 停止层",
};

/** 节点显示名：用户自定义标题 > 中文词典 > 原类名 */
export function zhNode(node: ComfyWfNode): string {
  const t = node._meta?.title?.trim();
  if (t && t !== node.class_type) return t;
  return CLASS_ZH[node.class_type] ?? node.class_type;
}

/** 输入名中文（词典没有的保留原名） */
export function zhInput(name: string): string {
  return INPUT_ZH[name] ?? name;
}

/* ---------------- 自动布局 ---------------- */

const isConn = (v: unknown): v is [string, number] => Array.isArray(v) && v.length === 2 && typeof v[0] === "string";

export const WFG_W = 172;
export const WFG_H = 60;
const GAP_X = 64;
const GAP_Y = 18;

export type WfLayout = {
  pos: Record<string, { x: number; y: number }>;
  edges: { from: string; to: string; toInput: string }[];
  width: number;
  height: number;
};

/** 最长路径分层 + 一趟重心排序的左→右布局 */
export function layoutWorkflow(wf: Record<string, ComfyWfNode>): WfLayout {
  const ids = Object.keys(wf);
  const edges: WfLayout["edges"] = [];
  const deps = new Map<string, string[]>(); // node ← 其上游
  for (const id of ids) deps.set(id, []);
  for (const id of ids) {
    for (const [input, v] of Object.entries(wf[id].inputs ?? {})) {
      if (isConn(v) && wf[v[0]]) {
        edges.push({ from: v[0], to: id, toInput: input });
        deps.get(id)!.push(v[0]);
      }
    }
  }

  // 最长路径分层（环兜底：访问中再遇到按 0 处理）
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const layerOf = (id: string): number => {
    const got = layer.get(id);
    if (got !== undefined) return got;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const ds = deps.get(id) ?? [];
    const l = ds.length ? Math.max(...ds.map(layerOf)) + 1 : 0;
    visiting.delete(id);
    layer.set(id, l);
    return l;
  };
  ids.forEach(layerOf);

  const cols = new Map<number, string[]>();
  for (const id of ids) {
    const l = layer.get(id) ?? 0;
    (cols.get(l) ?? cols.set(l, []).get(l)!).push(id);
  }
  const byNum = (a: string, b: string) => Number(a) - Number(b) || a.localeCompare(b);
  const rowIdx = new Map<string, number>();
  const maxLayer = Math.max(0, ...cols.keys());
  for (let l = 0; l <= maxLayer; l++) {
    const col = (cols.get(l) ?? []).sort(byNum);
    if (l > 0) {
      // 重心排序：按上游平均行号排，减少连线交叉
      col.sort((a, b) => {
        const bary = (id: string) => {
          const ups = (deps.get(id) ?? []).map((u) => rowIdx.get(u) ?? 0);
          return ups.length ? ups.reduce((s, x) => s + x, 0) / ups.length : 999;
        };
        return bary(a) - bary(b) || byNum(a, b);
      });
    }
    col.forEach((id, i) => rowIdx.set(id, i));
    cols.set(l, col);
  }

  const pos: WfLayout["pos"] = {};
  let width = 0;
  let height = 0;
  for (let l = 0; l <= maxLayer; l++) {
    for (const [i, id] of (cols.get(l) ?? []).entries()) {
      const x = l * (WFG_W + GAP_X);
      const y = i * (WFG_H + GAP_Y);
      pos[id] = { x, y };
      width = Math.max(width, x + WFG_W);
      height = Math.max(height, y + WFG_H);
    }
  }
  return { pos, edges, width: width + 8, height: height + 8 };
}
