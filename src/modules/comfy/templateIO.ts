/**
 * ComfyUI 模板导入/导出工具 — 模板管理器与设置页共用
 *  - 识别三种 JSON：原始 API 工作流 / 单个模板 / 模板包（数组或 {momoComfyTemplates, templates}）
 *  - 原始工作流可自动暴露常用参数直接成模板（批量导入用）
 *  - 导出走 Tauri 保存对话框，浏览器预览退回 a[download]
 */
import type { ComfyExposedParam, ComfyTemplate, ComfyWfNode } from "../../core/types";
import { guessOutputNode, isApiWorkflow, listWorkflowInputs, type WfInputInfo } from "../../core/services/comfy";
import { useComfy } from "../../core/stores/comfyStore";
import { errMsg, isTauri, uid } from "../../core/utils";

export type ExposeMap = Record<string, { label: string; kind: ComfyExposedParam["kind"] }>;

/** 自动暴露最常用的参数：提示词文本 / 种子 / LoadImage */
export function autoExposeMap(inputs: WfInputInfo[]): ExposeMap {
  const map: ExposeMap = {};
  for (const i of inputs) {
    const key = `${i.nodeId}.${i.input}`;
    const label = `${i.nodeTitle} · ${i.input}`;
    if (i.classType === "CLIPTextEncode" && i.input === "text") map[key] = { label, kind: "text" };
    else if (i.kind === "seed") map[key] = { label, kind: "seed" };
    else if (i.kind === "image") map[key] = { label, kind: "image" };
  }
  return map;
}

/** 暴露表 → 参数列表（保存模板 / 自动建模板共用） */
export function paramsFromExpose(workflow: Record<string, ComfyWfNode>, expose: ExposeMap): ComfyExposedParam[] {
  const params: ComfyExposedParam[] = [];
  for (const i of listWorkflowInputs(workflow)) {
    const key = `${i.nodeId}.${i.input}`;
    const ex = expose[key];
    if (!ex) continue;
    params.push({
      key,
      nodeId: i.nodeId,
      input: i.input,
      label: ex.label || `${i.nodeTitle} · ${i.input}`,
      kind: ex.kind,
      value: i.value as string | number | boolean,
    });
  }
  return params;
}

/** 原始 API 工作流 → 自动暴露参数的完整模板（批量导入时免手工勾选） */
export function autoTemplate(workflow: Record<string, ComfyWfNode>, name: string): ComfyTemplate {
  return {
    id: uid(8),
    name,
    workflow,
    params: paramsFromExpose(workflow, autoExposeMap(listWorkflowInputs(workflow))),
    outputNodeId: guessOutputNode(workflow),
    createdAt: Date.now(),
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const looksTemplate = (t: any): boolean =>
  !!t && typeof t === "object" && typeof t.name === "string" && isApiWorkflow(t.workflow);

/**
 * 从任意 JSON 里解析出模板列表：
 * 模板包 {momoComfyTemplates, templates:[…]} / 模板数组 / 单个模板对象；都不是则返回 null
 */
export function templatesFromJson(json: unknown): ComfyTemplate[] | null {
  const j = json as any;
  const arr: unknown[] | null = Array.isArray(j)
    ? j
    : Array.isArray(j?.templates)
      ? j.templates
      : looksTemplate(j)
        ? [j]
        : null;
  if (!arr) return null;
  const out: ComfyTemplate[] = [];
  for (const raw of arr) {
    const t = raw as any;
    if (!looksTemplate(t)) continue;
    out.push({
      id: typeof t.id === "string" && t.id ? t.id : uid(8),
      name: t.name,
      workflow: t.workflow,
      params: Array.isArray(t.params) ? (t.params as ComfyExposedParam[]) : [],
      outputNodeId: typeof t.outputNodeId === "string" ? t.outputNodeId : undefined,
      createdAt: typeof t.createdAt === "number" ? t.createdAt : Date.now(),
    });
  }
  return out.length ? out : null;
}

/** 模板列表 → 可再导入的模板包 JSON 文本 */
export function packTemplates(tpls: ComfyTemplate[]): string {
  return JSON.stringify({ momoComfyTemplates: 1, exportedAt: new Date().toISOString(), templates: tpls }, null, 2);
}

/**
 * 批量导入模板文件：每个文件可以是原始 API 工作流（自动暴露常用参数直接成模板）、
 * 单个模板或模板包；返回成功数与失败明细
 */
export async function importTemplateFilesAuto(files: Iterable<File>): Promise<{ saved: number; errs: string[] }> {
  let saved = 0;
  const errs: string[] = [];
  const upsert = useComfy.getState().upsert;
  for (const f of Array.from(files)) {
    try {
      const json: unknown = JSON.parse(await f.text());
      if (isApiWorkflow(json)) {
        upsert(autoTemplate(json, f.name.replace(/\.json$/i, "")));
        saved++;
        continue;
      }
      const tpls = templatesFromJson(json);
      if (!tpls) throw new Error("不是 API 格式工作流，也不是 momo 模板/模板包");
      for (const t of tpls) upsert(t);
      saved += tpls.length;
    } catch (e) {
      errs.push(`${f.name}：${errMsg(e)}`);
    }
  }
  return { saved, errs };
}

/** 保存文本到本地文件（Tauri 保存对话框 / 浏览器下载） */
export async function saveTextFile(filename: string, text: string): Promise<boolean> {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: filename, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return false;
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(path, text);
    return true;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  return true;
}
