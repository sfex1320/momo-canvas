/**
 * ComfyUI 前端格式（graph JSON：nodes/links/definitions）→ API 格式（{nodeId:{class_type,inputs}}）转换器
 *
 *  - 需要 ComfyUI 在线拉取的 /object_info：widget 名序只能从节点类型定义拿（widgets_values 是纯数组）
 *  - 支持一层子图展开（definitions.subgraphs；MiniMax H3 FL2VA 的「Image to Video (MiniMax H3)」子图）：
 *    接口输入槽 = 虚拟节点 -10（origin_slot = sg.inputs 索引），输出收集 = -20；
 *    实例的 widget 值按 sg.inputs 中非连接型槽的顺序取 widgets_values
 *  - MarkdownNote 等纯展示节点剔除；mute(mode 2)/bypass(mode 4) 节点剔除并由 pruneDisabled 跨接
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ComfyWfNode } from "../../core/types";
import { pruneDisabled } from "../../core/services/comfy";
import { layoutForComfy, layoutWorkflow } from "./wfGraph";
// widgets_values 位序唯一来源已提取为无依赖纯模块（Comfy 同步写回共用 + node 直跑测试可用）；此处 re-export 保持老调用方兼容
export { widgetLayoutOf, type WidgetSlot } from "../../core/comfySync/widgetLayout";
import { widgetLayoutOf, isAutoGrowType as isAutoGrow, isWidgetType } from "../../core/comfySync/widgetLayout";

/** 前端格式判定：nodes + links 数组（API 格式没有这两个顶层数组） */
export function isFrontendWorkflow(json: unknown): boolean {
  const j = json as any;
  return !!j && typeof j === "object" && !Array.isArray(j) && Array.isArray(j.nodes) && Array.isArray(j.links);
}

type FLink = { id: number; origin_id: number; origin_slot: number; target_id: number; target_slot: number };

type FNode = {
  id: number;
  type: string;
  title?: string;
  mode?: number;
  pos?: unknown;
  size?: unknown;
  inputs?: Array<{ name: string; type?: string; link?: number | null; label?: string; widget?: { name: string } }>;
  widgets_values?: unknown[];
};

/** 前端节点的 pos/size 字段兼容数组与 {0:x,1:y} 对象两种形态（LiteGraph 序列化版本差异） */
const num2 = (v: unknown): [number, number] | undefined => {
  if (Array.isArray(v) && typeof v[0] === "number" && typeof v[1] === "number") return [v[0], v[1]];
  if (v && typeof v === "object" && typeof (v as any)[0] === "number" && typeof (v as any)[1] === "number")
    return [(v as any)[0], (v as any)[1]];
  return undefined;
};

/** links 数组兼容两种形态：主图是数组元组 [id,src,srcSlot,dst,dstSlot,type]，子图里是对象 */
function normalizeLinks(raw: any[]): FLink[] {
  return (raw ?? []).map((l) =>
    Array.isArray(l)
      ? { id: l[0], origin_id: l[1], origin_slot: l[2], target_id: l[3], target_slot: l[4] }
      : { id: l.id, origin_id: l.origin_id, origin_slot: l.origin_slot, target_id: l.target_id, target_slot: l.target_slot },
  );
}

/** 连接类型判定：全大写类型名（IMAGE/MODEL/CLIP…）且不属于 widget 基础类型
 *  （注意：DYNAMICCOMBO 历史上按连接处理——保持原判定，避免子图接口槽序变化） */
const WIDGET_BASE = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);
const isConnType = (t: unknown): boolean =>
  typeof t === "string" && /^[A-Z][A-Z0-9_]*$/.test(t) && !WIDGET_BASE.has(t);

/** 纯展示节点（无执行意义，剔除） */
const isNoteNode = (type: string) => /markdownnote|^note$|sticky/i.test(type);

/**
 * 前端工作流 JSON → API 格式。
 * @param json 前端 graph JSON
 * @param objectInfo ComfyUI /object_info（调用方保证已在线拉取）
 */
export function convertFrontendWorkflow(
  json: any,
  objectInfo: Record<string, any>,
): { workflow: Record<string, ComfyWfNode>; warnings: string[] } {
  const warnings: string[] = [];
  const subgraphs: any[] = Array.isArray(json.definitions?.subgraphs) ? json.definitions.subgraphs : [];
  const sgById = new Map<string, any>(subgraphs.map((s) => [s.id, s]));
  const mainLinks = new Map<number, FLink>(normalizeLinks(json.links ?? []).map((l) => [l.id, l]));

  const wf: Record<string, ComfyWfNode> = {};
  const bypassed: string[] = [];
  /** 子图实例输出重定向：实例 id（字符串） → 展开后的内部输出源 */
  const outputRedirect = new Map<string, [string, number]>();

  /**
   * 普通节点转换。idPrefix 非空表示正在转换子图内部节点（内部 id 加前缀防撞）；
   * innerIds 是当前子图的内部节点 id 集（判定 link 源是否内部节点）；
   * sgInputValues 是子图接口槽的值表（origin_id === -10 时取值）。
   */
  /** 连接槽但带了 widget（可切换输入/控件两用）：即使定义里 forceInput 也仍在序列化里占位，要补回来 */
  const asWidget = (n: FNode, name: string) => (n.inputs ?? []).some((i) => i.widget?.name === name);

  const convertNode = (
    n: FNode,
    linksMap: Map<number, FLink>,
    idPrefix: string,
    innerIds: Set<number> | null,
    sgInputValues: Map<number, unknown> | null,
  ): ComfyWfNode => {
    const inputs: Record<string, unknown> = {};
    // widgets_values 取值规则与反向 convertApiToFrontend 一致（widgetLayoutOf 唯一来源）：
    // forceInput 的 widget 不占位（除非 node.inputs[].widget 把它又摆回了控件）；seed 类后的注入位已计入下标
    const layout = widgetLayoutOf(n.type, objectInfo);
    const wvLen = layout.slots.reduce((s, x) => s + (x.cag ? 2 : 1), 0); // 布局占满后，asWidget 补偿位从这里往后顺延
    const extraIdx = new Map<string, number>();
    const wv = n.widgets_values ?? [];
    const widgetValue = (name: string) => {
      let idx = layout.index.get(name);
      if (idx === undefined && asWidget(n, name)) {
        idx = extraIdx.get(name) ?? wvLen + extraIdx.size;
        extraIdx.set(name, idx);
      }
      if (idx === undefined) return undefined;
      return idx < wv.length ? wv[idx] : undefined;
    };
    for (const inp of n.inputs ?? []) {
      if (inp.link != null) {
        const l = linksMap.get(inp.link);
        if (!l) continue;
        if (l.origin_id === -10) {
          // 子图接口输入槽：值 = 主图连线源（[nodeId, slot]）或实例 widget 值
          const v = sgInputValues?.get(l.origin_slot);
          if (v !== undefined) inputs[inp.name] = v;
          continue;
        }
        if (l.origin_id === -20) continue; // 输出收集节点不当输入源
        // 内部节点引用内部节点要加前缀；主图引用主图节点/子图实例无前缀（实例源二遍重定向）
        const fromInner = !!idPrefix && !!innerIds?.has(l.origin_id);
        inputs[inp.name] = [`${fromInner ? idPrefix : ""}${l.origin_id}`, l.origin_slot];
        continue;
      }
      if (inp.widget?.name) {
        const v = widgetValue(inp.widget.name);
        if (v !== undefined) inputs[inp.name] = v;
      }
    }
    // 独立 widget（不在 inputs 数组里的 widget 型输入，按序列化位序从 widgets_values 取值）
    for (const { name } of layout.slots) {
      if (inputs[name] !== undefined) continue;
      if (asWidget(n, name)) continue;
      const v = widgetValue(name);
      if (v !== undefined) inputs[name] = v;
    }
    const out: ComfyWfNode = {
      class_type: n.type,
      inputs,
      _meta: { title: n.title || n.type },
    };
    // 画布坐标保留（双向位置跟随的存储位；子图内部节点带的是展开后的相对坐标，够用）
    const fp = num2(n.pos);
    const fs = num2(n.size);
    if (fp) out.pos = fp;
    if (fs) out.size = fs;
    return out;
  };

  /** 子图实例展开：内部节点并入主图，接口槽映射为值或连线 */
  const expandSubgraph = (inst: FNode, sg: any, sgIdx: number): void => {
    const prefix = `sg${sgIdx}_`;
    const sgInputs: Array<{ name: string; type: string; label?: string }> = sg.inputs ?? [];
    const sgLinks = new Map<number, FLink>(normalizeLinks(sg.links ?? []).map((l) => [l.id, l]));
    // 嵌套子图检查
    for (const inner of sg.nodes ?? []) {
      if (sgById.has(inner.type)) {
        warnings.push(`子图「${sg.name ?? inst.type}」里嵌套了子图节点 #${inner.id}，未展开（仅支持一层）`);
      }
    }
    // 1. 接口槽值：widget 型槽按序取实例 widgets_values
    const sgInputValues = new Map<number, unknown>();
    const widgetSlots = sgInputs.map((s, i) => ({ s, i })).filter(({ s }) => !isConnType(s.type));
    const instWv = inst.widgets_values ?? [];
    widgetSlots.forEach(({ i }, j) => {
      if (j < instWv.length) sgInputValues.set(i, instWv[j]);
    });
    // 2. 连线槽：实例 inputs[k].link → 主图源；input 名对应 sg.inputs 同名槽（含 label 匹配）
    for (const inp of inst.inputs ?? []) {
      if (inp.link == null) continue;
      const l = mainLinks.get(inp.link);
      if (!l) continue;
      const idx = sgInputs.findIndex(
        (s) => s.name === inp.name || (inp.label && (s.label === inp.label || s.name === inp.label)),
      );
      if (idx < 0) continue;
      sgInputValues.set(idx, [String(l.origin_id), l.origin_slot]);
    }
    // 3. 内部节点入 wf
    const innerIds = new Set<number>((sg.nodes ?? []).map((x: FNode) => x.id));
    for (const inner of sg.nodes ?? []) {
      if (isNoteNode(inner.type)) continue;
      if (sgById.has(inner.type)) continue; // 嵌套子图已告警
      const id = `${prefix}${inner.id}`;
      wf[id] = convertNode(inner, sgLinks, prefix, innerIds, sgInputValues);
      if (inner.mode === 2 || inner.mode === 4) bypassed.push(id);
    }
    // 4. 实例输出 → 输出收集节点（-20）的输入源
    const outLink = [...sgLinks.values()].find((l) => l.target_id === -20);
    if (outLink && outLink.origin_id >= 0) {
      outputRedirect.set(String(inst.id), [`${prefix}${outLink.origin_id}`, outLink.origin_slot]);
    }
  };

  // 第一遍：主图节点（子图实例展开，普通节点转换）
  let sgIdx = 0;
  for (const n of json.nodes as FNode[]) {
    if (isNoteNode(n.type)) continue;
    const sg = sgById.get(n.type);
    if (sg) {
      expandSubgraph(n, sg, sgIdx++);
      continue;
    }
    wf[String(n.id)] = convertNode(n, mainLinks, "", null, null);
    if (n.mode === 2 || n.mode === 4) bypassed.push(String(n.id));
  }

  // 第二遍：指向子图实例的连线 → 展开后的内部输出源
  for (const node of Object.values(wf)) {
    for (const [k, v] of Object.entries(node.inputs)) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string") {
        const redirect = outputRedirect.get(v[0]);
        if (redirect) node.inputs[k] = redirect;
      }
    }
  }

  // mute/bypass 节点剔除 + 跨接
  const pruned = pruneDisabled(wf, bypassed);
  if (!Object.keys(pruned).length) throw new Error("转换结果为空：工作流里没有可执行节点");
  return { workflow: pruned, warnings };
}

/**
 * API 格式 → ComfyUI 前端格式（graph JSON）。送 ComfyUI 界面编辑用——工作流库只认 nodes/links
 * 结构，API 格式点开是空白画布。需要在线 /object_info 提供 widget 名序/类型与默认值。
 *  - 数字节点键保持原值（往返同步后模板参数的 nodeId 不变）；非数字键（子图展开产物 sg0_5）从最大数字之后编号
 *  - widget 值按 widgetLayoutOf 的序列化位序回填（forceInput 不占位）；被连线占用的 widget 槽留类型默认值占位（界面以连线为准）
 *  - 带 control_after_generate 标记的 widget（KSampler.seed 等）后一位补 "fixed"（前端序列化如此，缺了会错位）
 *  - opts.spacing="comfy" 时用真实节点尺寸布局并补 size；opts.savedPos 时优先用 ComfyWfNode 里存的坐标/尺寸
 */
export function convertApiToFrontend(
  api: Record<string, ComfyWfNode>,
  objectInfo: Record<string, any>,
  opts?: {
    /** "comfy" = 用真实节点尺寸的布局 layoutForComfy（往返推送用）；默认沿用 MOMO 示意图布局 */
    spacing?: "comfy";
    /** true 且节点存了 pos/size（前端导入/上次合并保留的坐标）时优先用存储值，布局只兜底缺失节点 */
    savedPos?: boolean;
  },
): any {
  const keys = Object.keys(api);
  // 节点 id：数字键原样（保参数引用），非数字键顺延
  const idOf = new Map<string, number>();
  let maxId = 0;
  for (const k of keys) {
    const n = Number(k);
    if (Number.isInteger(n) && n > maxId && String(n) === k) maxId = n;
  }
  let next = maxId;
  for (const k of keys) {
    const n = Number(k);
    idOf.set(k, Number.isInteger(n) && String(n) === k ? n : ++next);
  }
  const isLink = (v: unknown): v is [string, number] =>
    Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && idOf.has(v[0]) && typeof v[1] === "number";

  type WDef = { name: string; def: any; widget: boolean };
  const defsOf = (type: string): WDef[] => {
    const oi = objectInfo[type];
    const out: WDef[] = [];
    if (!oi?.input) return out;
    for (const group of [oi.input.required, oi.input.optional]) {
      for (const [name, def] of Object.entries<any>(group ?? {})) {
        const t = Array.isArray(def) ? def[0] : def?.type;
        if (isAutoGrow(t)) continue; // AUTOGROW 组合槽本体不生成（其带点子槽按动态连接槽处理）
        out.push({ name, def, widget: isWidgetType(t) });
      }
    }
    return out;
  };
  /** AUTOGROW 子槽类型（如 values 的 template 里登记的 "FLOAT,INT,BOOLEAN"）——与 ComfyUI 界面生成的槽类型一致 */
  const autoGrowChildType = (type: string): string | undefined => {
    const oi = objectInfo[type];
    for (const group of [oi?.input?.required, oi?.input?.optional]) {
      for (const def of Object.values<any>(group ?? {})) {
        const t = Array.isArray(def) ? def[0] : def?.type;
        if (!isAutoGrow(t)) continue;
        const first = Object.entries<any>(def?.[1]?.template?.input?.required ?? {})[0];
        const ct = Array.isArray(first?.[1]) ? first[1][0] : undefined;
        if (typeof ct === "string") return ct;
      }
    }
    return undefined;
  };
  const typeName = (def: any) => {
    const t = Array.isArray(def) ? def[0] : def?.type;
    return typeof t === "string" ? t : "COMBO";
  };
  const defaultOf = (def: any) => {
    const t = Array.isArray(def) ? def[0] : def?.type;
    const opts = Array.isArray(def) ? def[1] : def?.options;
    if (opts && opts.default !== undefined) return opts.default;
    if (Array.isArray(t) && t.length) return t[0];
    if (t === "INT" || t === "FLOAT") return 0;
    if (t === "BOOLEAN") return false;
    return "";
  };

  // 第一遍：每节点 inputs[] 骨架（定义序：连接型 + 被连线占用的 widget），记录输入名 → 槽序
  const inputSlotOf = new Map<string, Map<string, number>>(); // nodeKey → inputName → target_slot
  const nodeInputs: Array<{ name: string; type: string; link: number | null; widget?: { name: string } }> = [];
  const skeleton = keys.map((k) => {
    const node = api[k];
    const defs = defsOf(node.class_type);
    const slots = new Map<string, number>();
    const inputs: typeof nodeInputs = [];
    for (const d of defs) {
      const v = (node.inputs ?? {})[d.name];
      const linked = isLink(v);
      if (d.widget) {
        if (linked) {
          slots.set(d.name, inputs.length);
          inputs.push({ name: d.name, type: typeName(d.def), link: null, widget: { name: d.name } });
        }
      } else {
        slots.set(d.name, inputs.length);
        inputs.push({ name: d.name, type: typeName(d.def), link: null });
      }
    }
    // AUTOGROW 动态槽（ref_images.ref_image_N / values.a 一类带点键，object_info 父键已跳过）：作普通连接槽
    // 追加，槽类型用定义里登记的子类型（"FLOAT,INT,BOOLEAN" 等，与界面生成的一致，否则装载时连线会被丢）；
    // 未连线的动态槽不生成（增行交给界面自己管）
    const covered = new Set(defs.map((d) => d.name));
    const childType = autoGrowChildType(node.class_type);
    for (const [name, v] of Object.entries(node.inputs ?? {})) {
      if (covered.has(name) || !isLink(v)) continue;
      slots.set(name, inputs.length);
      inputs.push({ name, type: childType ?? "*", link: null });
    }
    inputSlotOf.set(k, slots);
    return { key: k, node, defs, inputs };
  });

  // 第二遍：连线（元组 [id,src,srcSlot,dst,dstSlot,type]）+ outputs[].links 收集
  const links: Array<[number, number, number, number, number, string]> = [];
  const outLinks = new Map<string, number[]>(); // `${srcKey}:${slot}` → link ids
  let linkSeq = 1;
  const srcOutputType = (srcKey: string, slot: number, fallback: string) => {
    const spec = objectInfo[api[srcKey]?.class_type]?.output;
    const t = Array.isArray(spec?.[slot]) ? spec[slot][1] : undefined;
    return typeof t === "string" ? t : fallback;
  };
  for (const s of skeleton) {
    // 遍历节点全部输入（定义槽 + 带点动态槽都要能连线）
    for (const [name, v] of Object.entries(s.node.inputs ?? {})) {
      if (!isLink(v)) continue;
      const srcKey = v[0];
      const slot = inputSlotOf.get(s.key)?.get(name);
      if (slot === undefined || !idOf.has(srcKey)) continue;
      const d = s.defs.find((x) => x.name === name);
      const fallback = s.inputs[slot].type !== "*" ? s.inputs[slot].type : "IMAGE";
      const type = srcOutputType(srcKey, v[1], d ? typeName(d.def) : fallback);
      const id = linkSeq++;
      links.push([id, idOf.get(srcKey)!, v[1], idOf.get(s.key)!, slot, type]);
      const entry = s.inputs[slot];
      entry.link = id;
      if (entry.type === "*") entry.type = type;
      const ok = outLinks.get(`${srcKey}:${v[1]}`) ?? [];
      ok.push(id);
      outLinks.set(`${srcKey}:${v[1]}`, ok);
    }
  }

  // 第三遍：节点体（widgets_values 按 widgetLayoutOf 的序列化位序回填，forceInput 不占位、
  // control_after_generate 后补 "fixed"）+ outputs[] + pos/size
  const comfySpacing = opts?.spacing === "comfy";
  const cl = comfySpacing ? layoutForComfy(api, objectInfo) : null;
  const pos = cl ? cl.pos : layoutWorkflow(api).pos;
  const nodes = skeleton.map((s, i) => {
    const wv: unknown[] = [];
    const layout = widgetLayoutOf(s.node.class_type, objectInfo);
    for (const slot of layout.slots) {
      const d = s.defs.find((x) => x.name === slot.name);
      const v = (s.node.inputs ?? {})[slot.name];
      const linked = isLink(v);
      wv.push(!linked && v !== undefined ? v : d ? defaultOf(d.def) : "");
      if (slot.cag && !linked) wv.push("fixed");
    }
    const spec = objectInfo[s.node.class_type]?.output;
    const outputs = (Array.isArray(spec) ? spec : [["OUTPUT", "*"]] as Array<[string, string]>).map(
      ([name, type], slot) => ({
        name,
        type,
        links: outLinks.get(`${s.key}:${slot}`) ?? [],
        slot_index: slot,
      }),
    );
    // 位置：savedPos 且模板里存了坐标 → 用存储坐标（ComfyUI 里编辑过的位置原样保留）；否则布局兜底
    const saved = opts?.savedPos ? s.node.pos : undefined;
    const lp = pos[s.key];
    const p: [number, number] = saved ?? [lp?.x ?? 0, lp?.y ?? 0];
    const sz = opts?.savedPos && s.node.size ? s.node.size : cl?.size[s.key];
    const title = s.node._meta?.title;
    const out: Record<string, unknown> = {
      id: idOf.get(s.key)!,
      type: s.node.class_type,
      pos: [p[0], p[1]],
      flags: {},
      order: i,
      mode: 0,
      inputs: s.inputs,
      outputs,
      properties: { "Node name for S&R": s.node.class_type },
      widgets_values: wv,
    };
    if (sz) out.size = [sz[0], sz[1]];
    if (title && title !== s.node.class_type) out.title = title;
    return out;
  });

  return {
    last_node_id: next,
    last_link_id: linkSeq - 1,
    nodes,
    links,
    groups: [],
    config: {},
    extra: { note: "MOMO 智能画布推送" },
    version: 0.4,
  };
}
