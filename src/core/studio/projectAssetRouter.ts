/**
 * 项目产物物理输出路由（3.5 P2 · 方案 §3.5）—— 所有导演台产物统一走这里，不许各工位自己拼路径。
 *
 * 资产仍先进 AppData 资产库（真源 + 缩略图 + 指纹去重），随后镜像复制进项目目录（交付可见性）；
 * AssetItem.projectMirrors 记「projectId → 项目内绝对路径」——同一个去重资产被多个项目引用时
 * 各项目各有镜像路径，后一次绑定不会覆盖前一次（projectRelPath 保留为最近一次镜像，兼容旧 UI）。
 * 项目未绑定时跳过（托管模式）。
 */
import { useAssets } from "../stores/assetStore";
import { useDirector } from "../stores/directorStore";
import { isTauri } from "../utils";
import { segmentNumber } from "./projectWorkspace";
import type { AssetItem, DirectorProject } from "../types";

export type ProjectAssetCategory = "character" | "scene" | "prop" | "take" | "relay" | "audio" | "export" | "post" | "image" | "mv";

const join = (a: string, b: string) => `${a.replace(/[\\/]+$/, "")}/${b.replace(/^[\\/]+/, "")}`;

/** 类别 → 项目目录相对路径（§3.5 路由表）。
 *  分段目录（take/relay/audio/post）必须用真实片段编号与片段标题，segmentId 缺失时绝不退化成项目名——
 *  落到项目级目录（音频根目录）或直接不路由（take 没有片段号无意义）。 */
export function relDirFor(category: ProjectAssetCategory, segN: number, segTitle: string): string | null {
  const safe = segTitle.replace(/[\\/:*?"<>|]/g, "_").slice(0, 24).trim() || "未命名";
  const segDir = segN > 0 ? `分段资产库/${String(segN).padStart(2, "0")}_${safe}` : "";
  switch (category) {
    case "character":
      return "全部素材/人物";
    case "scene":
      return "全部素材/场景";
    case "prop":
      return "全部素材/道具";
    case "take":
      return segN > 0 ? `${segDir}/Takes` : null; // Take 必属于片段；没有片段号不落分段目录
    case "relay":
      return segN > 0 ? `${segDir}/接力` : null;
    case "audio":
      return segN > 0 ? `${segDir}/音频` : "音频"; // 项目级音轨（无片段绑定）进根目录 音频/
    case "post":
      return segN > 0 ? `${segDir}/后处理` : "后处理";
    case "export":
      return "成片";
    case "image":
      return "全部素材/AI制图";
    case "mv":
      return "AI MV";
  }
}

/** 镜像落盘计划（纯函数，测试直测）：目录 + 文件名；null = 不路由（托管模式/资产不可读/目录无意义） */
export function planMirror(
  project: DirectorProject | undefined,
  asset: AssetItem | undefined,
  input: { segmentId?: string; category: ProjectAssetCategory; segTitle?: string },
): { dir: string; name: string } | null {
  const w = project?.workspace;
  if (!w || w.mode !== "linked" || w.status === "missing") return null;
  if (!asset?.path || /^(blob:|data:|https?:)/i.test(asset.path)) return null;
  // 已写过本项目（多项目镜像账本：本项目的路径已记录）不重复复制
  if (asset.projectMirrors?.[project!.id]?.startsWith(w.rootPath)) return null;
  if (!asset.projectMirrors?.[project!.id] && asset.projectRelPath?.startsWith(w.rootPath)) return null; // 旧数据兼容
  const segN = input.segmentId ? segmentNumber(project!, input.segmentId) : 0;
  const rel = relDirFor(input.category, segN, input.segTitle ?? "");
  if (!rel) return null;
  const ext = (asset.path.match(/\.([^.]+)$/)?.[1] ?? "bin").toLowerCase();
  const name = `${input.category}_${new Date(asset.createdAt ?? Date.now()).toISOString().slice(0, 19).replace(/[:T]/g, "")}_${asset.id.slice(-4)}.${ext}`;
  return { dir: join(w.rootPath, rel), name };
}

/**
 * 把已收录资产镜像进项目目录（fire-and-forget 安全：失败只 console，不阻断生成流程）。
 * 写入规则：同指纹且本项目已写过（projectMirrors[projectId]）不重复复制；
 * 多项目引用各自记账，互不覆盖。
 */
export async function mirrorProjectAsset(input: {
  projectId: string;
  segmentId?: string;
  category: ProjectAssetCategory;
  assetId: string;
  /** 片段标题（take/relay/audio/post 路由进分段目录用） */
  segTitle?: string;
}): Promise<void> {
  if (!isTauri) return;
  const project = useDirector.getState().getById(input.projectId);
  const asset = useAssets.getState().items.find((a) => a.id === input.assetId);
  const plan = planMirror(project, asset, input);
  if (!plan || !asset) return;
  try {
    const { readFile, writeFile, mkdir } = await import("@tauri-apps/plugin-fs");
    await mkdir(plan.dir, { recursive: true }).catch(() => undefined);
    const bytes = await readFile(asset.path);
    const abs = join(plan.dir, plan.name);
    await writeFile(abs, bytes);
    // 多项目镜像账本：projectId → 本项目内绝对路径（后一个项目不会覆盖前一个的记录）
    useAssets.getState().patchItem(asset.id, {
      projectMirrors: { ...(asset.projectMirrors ?? {}), [input.projectId]: abs },
      projectRelPath: abs,
    });
  } catch (e) {
    console.warn("[projectAssetRouter] 镜像落盘失败（不影响资产库）:", e);
  }
}
