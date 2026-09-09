/**
 * H3 项目包导出（导演台 3.3 · 方案 §5.3 project-package）
 *
 * 把导演项目导出成 h3-script-package 规范的双语项目包目录（可重新直录、可交付他人）：
 *   项目名包/
 *   ├─ 完整剧本.md
 *   ├─ 全部素材/资产提示词.md（MOMO_ASSET_CATALOG_V1 格式 + 图片拷贝）
 *   ├─ 分段资产库/NN_标题/（每段参考图 + 提示词）
 *   ├─ 分段剧本-中.md（## H3-XX｜标题｜时长 + <<<PROMPT_START>>>围栏，三态直录格式）
 *   └─ 分段剧本-英.md（可选：LLM 逐段翻译）
 * 导出前跑包校验（§5.3 validate）：围栏成对、每段有提示词、资产编号稳定、空占位检测。
 * 浏览器预览模式不支持写目录，给明确提示。
 */
import { useDirector } from "./stores/directorStore";
import { useAssets } from "./stores/assetStore";
import { useUi } from "./stores/uiStore";
import { chatOnce } from "./services/llm";
import { resolveModelCard } from "./stores/settingsStore";
import { compileSegmentPrompt } from "./directorQueue";
import { isTauri, errMsg } from "./utils";
import { jobCenter } from "./studio/jobCenter";
import type { DirectorProject, DirectorSlotValue } from "./types";

export type PackageValidation = { level: "error" | "warning" | "info"; message: string };

const fence = (body: string) => `<<<PROMPT_START>>>\n${body.trim()}\n<<<PROMPT_END>>>`;

/** 组装分段剧本（中文主稿；promptFinalOverride > promptOverride > 现场编译） */
async function buildSegmentScript(project: DirectorProject): Promise<{ text: string; empty: string[] }> {
  const segs = project.scenes.flatMap((s) => s.segments);
  const parts: string[] = [
    `# ${project.name}`,
    "",
    `> 目标时长 ${project.targetDurationSec}s · ${project.aspect} · 共 ${segs.length} 段`,
    project.ruleSet?.positive.style ? `> 全局风格：${project.ruleSet.positive.style}` : "",
    "",
  ];
  const empty: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    let body = seg.promptFinalOverride?.trim() || seg.promptOverride?.trim() || "";
    if (!body) {
      try {
        body = (await compileSegmentPrompt(project, seg, "video-t2v")).prompt;
      } catch {
        body = "";
      }
    }
    if (!body.trim()) empty.push(`${String(i + 1).padStart(2, "0")} ${seg.summary.slice(0, 16)}`);
    parts.push(`## H3-${String(i + 1).padStart(2, "0")}｜${seg.summary.slice(0, 24)}｜${seg.durationSec}秒`, "");
    parts.push(fence(body || "（本段无提示词——请补写）"), "");
    if (seg.dialogue.length) parts.push(`对白：${seg.dialogue.join(" / ")}`, "");
  }
  return { text: parts.filter((x) => x !== "").join("\n"), empty };
}

/** 组装资产册（从参考槽资产生成 MOMO_ASSET_CATALOG_V1 条目；图片相对路径按拷贝位置） */
function buildAssetCatalog(entries: Array<{ cat: string; name: string; file: string; role: string; segs: number; zh: string; en: string }>): string {
  const lines = [
    "# 资产提示词（MOMO_ASSET_CATALOG_V1）",
    "",
    "> 项目素材唯一清单：每项一张真实图片 + 双语提示词；重导按 资产编号 原位同步。",
    "",
    "| 资产编号 | 资产名称 | 图片 | 类型 | 使用分段 | 参考顺序 | 中文提示词 | English Prompt |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const e of entries) {
    lines.push(`| ${e.cat} | ${e.name} | ${e.file} | ${e.role} | ${e.segs < 0 ? "全部" : e.segs || "未绑定"} | 自动 | ${e.zh.replace(/\|/g, "／")} | ${e.en.replace(/\|/g, "／")} |`);
  }
  return lines.join("\n");
}

/** 包校验（§5.3）：导出前跑，返回问题列表（error 阻止导出，warning 提示） */
export function validatePackage(project: DirectorProject, segScript: string, empty: string[]): PackageValidation[] {
  const out: PackageValidation[] = [];
  const opens = (segScript.match(/<<<PROMPT_START>>>/g) ?? []).length;
  const closes = (segScript.match(/<<<PROMPT_END>>>/g) ?? []).length;
  if (opens !== closes) out.push({ level: "error", message: `围栏不配对：START ${opens} 个 / END ${closes} 个` });
  for (const e of empty) out.push({ level: "warning", message: `「${e}」没有提示词，将导出占位文本` });
  const segs = project.scenes.flatMap((s) => s.segments);
  if (!segs.length) out.push({ level: "error", message: "项目没有片段——先在剧本库送入项目拆分" });
  // 资产编号稳定：同图（同资产 id）不得占用两个编号
  const seen = new Map<string, string>();
  let i = 0;
  for (const seg of segs) {
    i++;
    for (const slot of seg.slots ?? []) {
      for (const aid of slot.assetIds) {
        const prev = seen.get(aid);
        const label = `段${String(i).padStart(2, "0")}:${slot.label ?? slot.semantic}`;
        if (prev && prev !== label) out.push({ level: "info", message: `资产 ${aid.slice(-4)} 被多段引用（${prev} / ${label}）——资产册只记首见编号` });
        else seen.set(aid, label);
      }
    }
  }
  return out;
}

/** 导出 H3 项目包（桌面端；withEn = 同步产出英文分段剧本，LLM 逐段翻译） */
export async function exportH3Package(projectId: string, opts: { withEn?: boolean } = {}): Promise<{ dir: string; segments: number; warnings: number } | null> {
  if (!isTauri) {
    useUi.getState().toast("H3 项目包导出需要桌面端（写目录）——浏览器预览模式请用「导出项目包」数据包", "err");
    return null;
  }
  const project = useDirector.getState().getById(projectId);
  if (!project) throw new Error("项目不存在");
  const job = jobCenter.begin({ projectId, kind: "extract", label: `导出 H3 项目包 · ${project.name}` });
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const dir = await save({ title: "选择项目包保存位置（将创建同名子目录）", defaultPath: `${project.name.replace(/[^\w-]/g, "_")}_H3包` });
    if (!dir || typeof dir !== "string") {
      job.cancel();
      return null;
    }
    const root = dir.replace(/[\\/](H3包)?\.?\w*$/, "") === dir ? dir : dir;
    void root;
    const baseDir = dir.endsWith(".momoh3pack") ? dir.slice(0, -".momoh3pack".length) : dir;
    const pkg = `${baseDir}/${project.name.replace(/[\\/:*?"<>|]/g, "_")}_H3包`;
    const fs = await import("@tauri-apps/plugin-fs");
    const mkdir = (p: string) => fs.mkdir(p, { recursive: true }).catch(() => undefined);
    const writeFile = async (p: string, data: Uint8Array | string) => {
      try {
        if (typeof data === "string") await fs.writeTextFile(p, data);
        else await fs.writeFile(p, data);
      } catch (e) {
        throw new Error(`写入 ${p.split("/").pop()} 失败：${errMsg(e)}`);
      }
    };

    job.stage("组装分段剧本", 10);
    const { text: segScript, empty } = await buildSegmentScript(project);
    const problems = validatePackage(project, segScript, empty);
    const errs = problems.filter((p) => p.level === "error");
    if (errs.length) {
      job.fail(`校验未通过：${errs[0].message}`);
      throw new Error(`包校验未通过：${errs.map((e) => e.message).join("；")}`);
    }
    await mkdir(pkg);
    await mkdir(`${pkg}/全部素材`);
    await mkdir(`${pkg}/分段资产库`);

    // ① 完整剧本
    job.stage("写入完整剧本", 20);
    await writeFile(`${pkg}/完整剧本.md`, `# ${project.name} · 完整剧本\n\n${project.script || "（项目没有剧本正文）"}\n`);

    // ② 资产册 + 图片拷贝（全局槽 + 各段槽，按资产 id 去重）
    job.stage("收集资产册", 35);
    const assets = useAssets.getState().items;
    const used = new Map<string, { segs: Set<number>; role: string }>();
    const segs = project.scenes.flatMap((s) => s.segments);
    for (const slot of [...project.globalSlots, ...segs.flatMap((s) => s.slots ?? [])] as DirectorSlotValue[]) {
      for (const aid of slot.assetIds) {
        const ent = used.get(aid) ?? { segs: new Set<number>(), role: slot.referenceRole === "spatialLayout" ? "站位图" : "参考" };
        segs.forEach((s, i) => {
          if ((s.slots ?? []).some((x) => x.assetIds.includes(aid))) ent.segs.add(i + 1);
        });
        if (slot.referenceRole === "spatialLayout") ent.role = "站位图";
        used.set(aid, ent);
      }
    }
    const catalogEntries: Array<{ cat: string; name: string; file: string; role: string; segs: number; zh: string; en: string }> = [];
    let assetIdx = 0;
    for (const [aid, meta] of used) {
      const a = assets.find((x) => x.id === aid);
      if (!a || a.kind !== "image") continue;
      assetIdx++;
      const cat = `REF-${String(assetIdx).padStart(2, "0")}`;
      const ext = a.path.match(/\.([^.]+)$/)?.[1] ?? "png";
      const file = `${cat}.${ext}`;
      try {
        const bytes = await (await import("@tauri-apps/plugin-fs")).readFile(a.path);
        await writeFile(`${pkg}/全部素材/${file}`, new Uint8Array(bytes));
      } catch {
        problems.push({ level: "warning", message: `资产 ${a.name} 图片读取失败，已跳过拷贝` });
      }
      catalogEntries.push({
        cat,
        name: a.name,
        file,
        role: meta.role,
        segs: meta.segs.size === segs.length ? -1 : (Math.min(...meta.segs) || 0),
        zh: a.promptZh ?? a.prompt ?? a.name,
        en: a.promptEn ?? "",
      });
    }
    await writeFile(`${pkg}/全部素材/资产提示词.md`, buildAssetCatalog(catalogEntries) + "\n");

    // ③ 分段资产库（每段：提示词 + 该段参考图拷贝）
    job.stage("写入分段资产库", 55);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const dirName = `${pkg}/分段资产库/${String(i + 1).padStart(2, "0")}_${seg.summary.slice(0, 12).replace(/[\\/:*?"<>|]/g, "_")}`;
      const segAssets = (seg.slots ?? []).flatMap((s) => s.assetIds).map((id) => assets.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => !!a && a.kind === "image");
      if (!segAssets.length && !seg.promptOverride && !seg.summary) continue; // 空占位段不建目录（§5.3）
      await mkdir(dirName);
      let body = seg.promptFinalOverride?.trim() || seg.promptOverride?.trim() || "";
      if (!body) {
        try {
          body = (await compileSegmentPrompt(project, seg, "video-t2v")).prompt;
        } catch {
          body = seg.summary;
        }
      }
      await writeFile(`${dirName}/提示词.md`, `## H3-${String(i + 1).padStart(2, "0")}｜${seg.summary.slice(0, 24)}｜${seg.durationSec}秒\n\n${fence(body)}\n`);
      let k = 0;
      for (const a of segAssets) {
        k++;
        try {
          const bytes = await (await import("@tauri-apps/plugin-fs")).readFile(a.path);
          await writeFile(`${dirName}/${String(k).padStart(2, "0")}.${a.path.match(/\.([^.]+)$/)?.[1] ?? "png"}`, new Uint8Array(bytes));
        } catch { /* 单图失败不阻断 */ }
      }
    }

    // ④ 中文分段剧本
    job.stage("写入分段剧本（中）", 75);
    await writeFile(`${pkg}/分段剧本-中.md`, segScript + "\n");

    // ⑤ 英文分段剧本（可选：LLM 整包翻译，控制为一次调用）
    if (opts.withEn) {
      job.stage("翻译英文分段剧本", 85);
      try {
        const card = resolveModelCard("chat");
        const en = await chatOnce(
          card,
          "把下面的 H3 分段剧本翻译成英文执行稿：保持 ## 标题行与 <<<PROMPT_START>>>/<<<PROMPT_END>>> 围栏结构完全不变，只翻译内容；对白保持原语言并附英文注释；只输出译文。",
          segScript.slice(0, 24000),
        );
        await writeFile(`${pkg}/分段剧本-英.md`, en.trim().replace(/^```(?:markdown|md)?|```$/g, "") + "\n");
      } catch (e) {
        problems.push({ level: "warning", message: `英文稿翻译失败（${errMsg(e)}），已跳过` });
      }
    }

    // ⑥ 校验报告
    if (problems.length) {
      await writeFile(`${pkg}/导出校验报告.md`, `# 导出校验报告\n\n${problems.map((p) => `- [${p.level}] ${p.message}`).join("\n")}\n`);
    }
    job.done(`项目包已导出（${segs.length} 段 · ${catalogEntries.length} 资产 · ${problems.length} 条提醒）`);
    useUi.getState().toast(`H3 项目包已导出：${pkg}${problems.length ? `（${problems.length} 条校验提醒见目录内报告）` : ""}`, problems.length ? "info" : "ok");
    return { dir: pkg, segments: segs.length, warnings: problems.length };
  } catch (e) {
    if (!["cancelled", "已取消"].includes(errMsg(e))) useUi.getState().toast(`项目包导出失败：${errMsg(e)}`, "err");
    try { job.fail(errMsg(e)); } catch { /* job 可能已完结 */ }
    throw e;
  }
}

