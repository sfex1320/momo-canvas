import type { DirectorProject } from "../types";

/** 只给出下一步入口，不自动拆剧本、不生成、不改采用版本。 */
export function nextStudioStep(project: DirectorProject) {
  const segments = project.scenes.flatMap(scene => scene.segments);
  if (!segments.length) return { station: "scripts" as const, label: "导入剧本", hint: "已有剧本直接导入，也可到分段编写逐行记录。", stage: 0 };
  const running = segments.find(s => s.takes?.some(t => t.status === "running" || t.status === "queued"));
  if (running) return { station: "h3" as const, segmentId: running.id, label: "查看生成进度", hint: "已有任务执行中，可以查看当前片段。", stage: 2 };
  const empty = segments.find(s => ![s.summary, s.promptOverride, s.promptFinalOverride, s.h3Prompt?.en?.promptBody].some(t => t?.trim()));
  if (empty) return { station: "director" as const, segmentId: empty.id, label: "补全分镜内容", hint: "先补这一段的描述或执行提示词，再选择配方。", stage: 1 };
  const unfinished = segments.find(s => !s.approvedTakeId || !s.takes?.some(t => t.id === s.approvedTakeId && t.status === "done"));
  if (unfinished) {
    const done = unfinished.takes?.some(t => t.status === "done");
    return { station: "h3" as const, segmentId: unfinished.id, label: done ? "挑选采用版本" : "检查并生成片段", hint: done ? "这一段已有结果，选中满意版本并采用。" : "确认提示词、参考素材和配方；有需要时再用素材定义、制图或 3D。", stage: 2 };
  }
  return { station: "post" as const, label: "预演并导出成片", hint: "全部片段已采用，检查顺序、声音和字幕后交付。", stage: 3 };
}
