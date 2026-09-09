/**
 * 内置能力第一批 —— 只读查询 + 提案型写入（能力总线第一阶段）
 *
 * 只读四件（导演项目概览 / 片段状态 / 画布节点 / Comfy 模板）+
 * 提案一件（修订片段提示词 → useAgentProposals 审核池，应用走 agentGateway
 * 的受控应用器，AI 永不直写项目）。扣费类能力在统一预算闸与用量记账
 * 跑稳之后再接入（第三阶段）。
 */
import { registerCapability } from "./index";
import type { DirectorProject } from "../types";
import { useDirector } from "../stores/directorStore";
import { useUi } from "../stores/uiStore";
import { useBoard, NODE_LABEL } from "../stores/boardStore";
import { useComfy } from "../stores/comfyStore";
import { readProjectContext, useAgentProposals } from "../studio/agentGateway";
import { runBatch, collectBatchTasks, estimateBatchTasks } from "../directorQueue";
import { runFlow } from "../runner";

/* ---------- 公共小件 ---------- */

function str(v: unknown, field: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new Error(`缺少 ${field}`);
  return s;
}

/** 解析目标导演项目：导演台当前打开的 > 调用方绑定的 > 最近一个项目 */
function currentProject(ctxProjectId?: string): { proj: DirectorProject; viaFallback: boolean } | null {
  const openId = useUi.getState().directorProjectId;
  const id = ctxProjectId ?? openId;
  const proj = (id ? useDirector.getState().getById(id) : undefined) ?? useDirector.getState().projects[0];
  if (!proj) return null;
  return { proj, viaFallback: proj.id !== id };
}

function allSegments(proj: DirectorProject) {
  return proj.scenes.flatMap((s) => s.segments);
}

/* ---------- 只读：导演台项目概览 ---------- */

registerCapability({
  id: "director.project_summary",
  title: "导演台项目概览",
  description: "查看当前导演台项目的剧本摘要、角色连续性、片段总数与采用进度、待审提案数",
  risk: "read",
  inputSchema: { type: "object", properties: {} },
  validate: () => ({}),
  confirm: () => ({ type: "none" }),
  run: (_args, ctx) => {
    const hit = currentProject(ctx.projectId);
    if (!hit) throw new Error("当前没有可读取的导演台项目（可提示用户先在导演台创建或打开项目）");
    const { proj, viaFallback } = hit;
    const segs = allSegments(proj);
    const approved = segs.filter((s) => s.approvedTakeId).length;
    const pending = useAgentProposals.getState().pendingOf(proj.id).length;
    const text = [
      viaFallback ? `（导演台当前未打开，以下读取的是最近项目「${proj.name}」）` : "",
      readProjectContext(proj),
      `片段采用进度：${approved}/${segs.length}（未采用 = 缺片或未选版）`,
      pending ? `待审核提案：${pending} 条（在导演台·AI 导演工位审核）` : "待审核提案：无",
    ]
      .filter(Boolean)
      .join("\n");
    return { text };
  },
});

/* ---------- 只读：片段状态清单 ---------- */

registerCapability({
  id: "director.segment_status",
  title: "片段状态清单",
  description: "逐段查看导演台项目的片段：序号、摘要、时长、是否已采用（Take）、是否锁定/已精炼",
  risk: "read",
  inputSchema: {
    type: "object",
    properties: {
      only_missing: { type: "boolean", description: "true = 只列未采用（缺片）的片段，默认全部" },
    },
  },
  validate: (args) => ({
    only_missing: !!(args && typeof args === "object" && (args as Record<string, unknown>).only_missing),
  }),
  confirm: () => ({ type: "none" }),
  run: (args, ctx) => {
    const hit = currentProject(ctx.projectId);
    if (!hit) throw new Error("当前没有可读取的导演台项目");
    const { proj } = hit;
    const segs = allSegments(proj);
    const rows = segs
      .map((s, i) => ({
        i: i + 1,
        s,
        approved: !!s.approvedTakeId,
        finalLocked: !!s.promptFinalOverride || !!s.locks?.executionEn,
        refined: !!s.h3Prompt?.en || !!s.promptOverride,
        takeCount: s.takes?.length ?? 0,
      }))
      .filter((r) => (args.only_missing ? !r.approved : true));
    if (!rows.length) {
      return { text: args.only_missing ? `「${proj.name}」没有缺片片段（${segs.length} 段全部已采用）` : `「${proj.name}」没有任何片段（请先在导演台拆分剧本）` };
    }
    const text = `项目「${proj.name}」片段状态（${args.only_missing ? "仅缺片" : "全部"}，共 ${rows.length}/${segs.length} 段）：\n` +
      rows
        .map(
          (r) =>
            `${String(r.i).padStart(2, "0")} ${r.s.summary.slice(0, 30)} · ${r.s.durationSec}s · ` +
            (r.approved ? "已采用" : `缺片（Take ${r.takeCount} 次未选版）`) +
            (r.finalLocked ? " · 锁定稿" : r.refined ? " · 已精炼" : ""),
        )
        .join("\n");
    return { text };
  },
});

/* ---------- 只读：画布节点清单 ---------- */

registerCapability({
  id: "canvas.node_list",
  title: "画布节点清单",
  description: "查看当前画布的节点概况：各类型数量、运行/错误状态、节点名称或提示词摘要",
  risk: "read",
  inputSchema: { type: "object", properties: {} },
  validate: () => ({}),
  confirm: () => ({ type: "none" }),
  run: (_args, _ctx) => {
    const b = useBoard.getState();
    const rec = b.boards[b.activeId];
    const nodes = rec?.nodes ?? [];
    if (!nodes.length) return { text: `画布「${rec?.meta.name ?? b.activeId}」是空的` };
    const byKind = new Map<string, number>();
    const running: string[] = [];
    const errors: string[] = [];
    const names: string[] = [];
    for (const n of nodes) {
      const label = NODE_LABEL[n.type] ?? n.type;
      byKind.set(label, (byKind.get(label) ?? 0) + 1);
      const data = (n.data ?? {}) as Record<string, unknown>;
      const name =
        (typeof data.name === "string" && data.name) ||
        (typeof data.prompt === "string" ? data.prompt.slice(0, 24) : "") ||
        label;
      if (data.status === "running") running.push(name);
      else if (data.status === "error") errors.push(name);
      if (names.length < 30) names.push(`${label}「${name}」`);
    }
    const text = [
      `画布「${rec?.meta.name ?? "当前"}」共 ${nodes.length} 个节点、${rec?.edges.length ?? 0} 条连线。`,
      `类型分布：${[...byKind.entries()].map(([k, v]) => `${k}×${v}`).join("、")}`,
      running.length ? `运行中：${running.join("、")}` : "",
      errors.length ? `错误：${errors.join("、")}` : "",
      `节点：${names.join("；")}${nodes.length > 30 ? ` …（共 ${nodes.length} 个）` : ""}`,
    ]
      .filter(Boolean)
      .join("\n");
    return { text };
  },
});

/* ---------- 只读：ComfyUI 模板清单 ---------- */

registerCapability({
  id: "comfy.template_list",
  title: "ComfyUI 模板清单",
  description: "查看已导入的 ComfyUI 工作流模板：名称、分支数、是否由工作流同步维护",
  risk: "read",
  inputSchema: { type: "object", properties: {} },
  validate: () => ({}),
  confirm: () => ({ type: "none" }),
  run: (_args, _ctx) => {
    const templates = useComfy.getState().templates;
    if (!templates.length) return { text: "还没有导入任何 ComfyUI 模板（可在模板管理或同步中心导入）" };
    const text = `共 ${templates.length} 个 ComfyUI 模板：\n` +
      templates
        .map((t) => `· ${t.name}（${t.variants?.length ?? 1} 个分支${t.workflowId ? " · 工作流同步维护" : ""}）`)
        .join("\n");
    return { text };
  },
});

/* ---------- 提案型写入：修订片段提示词 ---------- */

registerCapability({
  id: "director.propose_prompt",
  title: "提交片段提示词修订提案",
  description: "为某个片段起草新的提示词并提交修订提案——先经用户在导演台·AI 导演工位审核确认，才会写入 promptOverride（锁定最终稿永不被 AI 改写）",
  risk: "write",
  inputSchema: {
    type: "object",
    properties: {
      segment_index: { type: "number", description: "片段序号（1 起，即片段清单里的序号）" },
      prompt: { type: "string", description: "完整的成品提示词草案" },
      reason: { type: "string", description: "一句话说明为什么改（进确认卡）" },
    },
    required: ["segment_index", "prompt"],
  },
  validate: (args) => {
    if (!args || typeof args !== "object") throw new Error("args 必须是对象");
    const a = args as Record<string, unknown>;
    const idx = Number(a.segment_index);
    if (!Number.isInteger(idx) || idx < 1) throw new Error("segment_index 必须是 ≥1 的片段序号");
    return {
      segment_index: idx,
      prompt: str(a.prompt, "prompt（提示词草案）"),
      reason: typeof a.reason === "string" ? a.reason.slice(0, 200) : "",
    };
  },
  confirm: () => ({ type: "proposal" }), // 写类的唯一通道：提案 → 用户审核 → 受控应用器
  idemKey: (a) => `propose_prompt:${a.segment_index}|${a.prompt.length}|${a.prompt.slice(0, 80)}`,
  run: (args, ctx) => {
    const hit = currentProject(ctx.projectId);
    if (!hit) throw new Error("当前没有可写入的导演台项目");
    const { proj } = hit;
    const segs = allSegments(proj);
    const seg = segs[args.segment_index - 1];
    if (!seg) throw new Error(`片段序号 ${args.segment_index} 超出范围（项目共 ${segs.length} 段；不确定序号时先用 director.segment_status 查）`);
    if (seg.locks?.executionEn || seg.promptFinalOverride) {
      throw new Error(`片段「${seg.summary.slice(0, 16)}」的执行稿已锁定，AI 不改写锁定稿——请提示用户在 H3 检查器里自行解锁后再试`);
    }
    const before = seg.promptOverride ?? "（空，尚未精炼）";
    const proposal = useAgentProposals.getState().submit({
      projectId: proj.id,
      kind: "prompt",
      title: `创作助手 · 修订片段 ${String(args.segment_index).padStart(2, "0")} 提示词`,
      summary: args.reason || "创作助手提交的提示词修订提案",
      before,
      after: args.prompt,
      targetId: seg.id,
      from: "assistant",
    });
    return {
      text: `已提交片段 ${String(args.segment_index).padStart(2, "0")}「${seg.summary.slice(0, 16)}」的提示词修订提案（提案号 ${proposal.id}）。注意：提案尚未生效，需用户在导演台·AI 导演工位审核确认后才写入；执行稿锁定段不可提案。`,
      data: { proposalId: proposal.id, segmentId: seg.id },
    };
  },
  verify: (result) => {
    const id = (result.data as { proposalId?: string } | undefined)?.proposalId;
    if (!id) return ["提案已提交但拿不到提案号，状态无法核对"];
    const p = useAgentProposals.getState().proposals.find((x) => x.id === id);
    if (!p || p.status === "rejected") return ["提案不在待审列表里（可能刚被拒绝）"];
    return [];
  },
});

/* ---------- 扣费：导演台批量生成（信封强制内联确认 + 预算 + 重入锁） ---------- */

/** BatchOp 里允许助手发起的三种（modified 是 UI 语义，不开放） */
type AgentBatchOp = "missing" | "selected" | "failed";
const OP_LABEL: Record<AgentBatchOp, string> = { missing: "补缺生成", selected: "生成所选", failed: "重跑失败" };

/** op=selected 时的序号 → 片段 id（越界丢弃；类型守卫收窄 filter(Boolean)） */
function selectedIdsOf(segs: DirectorProject["scenes"][number]["segments"], op: AgentBatchOp, indexes?: number[]): string[] | undefined {
  if (op !== "selected" || !indexes?.length) return undefined;
  return indexes.map((i) => segs[i - 1]?.id).filter((x): x is string => !!x);
}

registerCapability({
  id: "director.run_batch",
  title: "导演台批量生成",
  description:
    "批量生成片段视频：missing=补缺（只生成没有成功 Take 的段）/ selected=指定段 / failed=重跑失败段。远程配方扣 API 费（确认卡会展示预估），本地 ComfyUI 配方免费；任务进导演台任务中心、可随时停止",
  risk: "spend",
  agentSpendAllowed: true, // 信封强制内联确认 + 预算；批量重入锁在 runBatch 里
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", description: "missing（默认）/ selected / failed" },
      segment_indexes: { type: "array", items: { type: "number" }, description: "op=selected 时的片段序号列表（片段清单里的 1 起序号）" },
    },
    required: ["op"],
  },
  validate: (args): { op: AgentBatchOp; segment_indexes?: number[] } => {
    if (!args || typeof args !== "object") throw new Error("args 必须是对象");
    const a = args as Record<string, unknown>;
    const rawOp = typeof a.op === "string" ? a.op : "missing";
    const op = rawOp as AgentBatchOp;
    if (!["missing", "selected", "failed"].includes(rawOp)) throw new Error("op 只能是 missing / selected / failed");
    const idx = Array.isArray(a.segment_indexes)
      ? a.segment_indexes.map(Number).filter((n) => Number.isInteger(n) && n >= 1)
      : undefined;
    return { op, segment_indexes: idx };
  },
  confirm: (_channel, args) => {
    // 确认话术带上实时预估（拿不到项目时退化为朴素文案，run 里自会报错）
    const hit = currentProject();
    if (hit) {
      const segs = allSegments(hit.proj);
      const selectedIds = selectedIdsOf(segs, args.op, args.segment_indexes);
      const tasks = collectBatchTasks(hit.proj, args.op, selectedIds);
      if (!tasks.length) return { type: "inline", prompt: `即将${OP_LABEL[args.op]}，但当前没有命中的片段（可能都已生成/序号越界）。确认前请先用 director.segment_status 核对。` };
      const est = estimateBatchTasks(hit.proj, tasks);
      const fee = est.remote
        ? `其中 ${est.remote} 段走远程模型，预估 ¥${est.cost.toFixed(2)}`
        : "全部走本地 ComfyUI，不扣 API 费（占用 GPU）";
      return { type: "inline", prompt: `即将${OP_LABEL[args.op]}：共 ${tasks.length} 段，${fee}。任务会进导演台任务中心、可随时停止。` };
    }
    return { type: "inline", prompt: `即将${OP_LABEL[args.op]}（未能预估花费，确认前建议先用 director.project_summary 查看项目）。` };
  },
  estimate: (args) => {
    const hit = currentProject();
    if (!hit) return null;
    const segs = allSegments(hit.proj);
    const selectedIds = selectedIdsOf(segs, args.op, args.segment_indexes);
    const tasks = collectBatchTasks(hit.proj, args.op, selectedIds);
    const est = estimateBatchTasks(hit.proj, tasks);
    if (!tasks.length || !est.remote) return null; // 纯本地批次不过预算闸（无 API 费），确认卡照常
    return { cost: est.cost, label: `${OP_LABEL[args.op]} ${tasks.length} 段（远程 ${est.remote} 段）` };
  },
  // 不设 idemKey：批次跑完后的同参重跑（补漏/重试）是合法诉求；防重入由 runBatch 内的重入锁 + 确认闸承担
  run: async (args, ctx) => {
    const hit = currentProject(ctx.projectId);
    if (!hit) throw new Error("当前没有可操作的导演台项目");
    const segs = allSegments(hit.proj);
    let selectedIds: string[] | undefined;
    if (args.op === "selected") {
      if (!args.segment_indexes?.length) throw new Error("op=selected 必须带 segment_indexes（序号见 director.segment_status）");
      const picked = selectedIdsOf(segs, args.op, args.segment_indexes) ?? [];
      if (!picked.length) throw new Error("segment_indexes 全部越界（先用 director.segment_status 核对序号）");
      selectedIds = picked;
    }
    const res = await runBatch(hit.proj.id, args.op, selectedIds, undefined, undefined, ctx.signal);
    const text = `${OP_LABEL[args.op]}完成：成功 ${res.done} / 失败 ${res.failed} / 取消 ${res.cancelled}。` +
      (res.failed ? "失败段的明细在导演台任务中心与报错中心；可先只读 segment_status 复核再决定是否重跑。" : "产物已按 Take 收进项目，可在成片检查页预演。");
    return { text, data: res };
  },
  verify: (result) => {
    const r = result.data as { done?: number; failed?: number; cancelled?: number } | undefined;
    if (!r) return ["批量结果里没有计数，无法核对"];
    if (!r.done && !r.cancelled && (r.failed ?? 0) > 0) return [`全部 ${r.failed} 段失败——不要声称已生成，请把失败原因如实告知用户`];
    return [];
  },
});

/* ---------- 扣费（本地）：运行 ComfyUI 模板 ---------- */

registerCapability({
  id: "comfy.run_template",
  title: "运行 ComfyUI 模板",
  description:
    "在画布上创建 ComfyUI 模板节点并立即运行（本地 GPU，不扣 API 费；大工作流可能需要数分钟）。按模板名称或 id 指定，可选传少量参数覆盖",
  risk: "spend", // 占用本地 GPU；estimate 恒 null（无 API 费，不过预算闸，只走确认）
  agentSpendAllowed: true,
  inputSchema: {
    type: "object",
    properties: {
      template: { type: "string", description: "模板名称或 id（清单见 comfy.template_list）" },
      params: { type: "object", description: "参数覆盖（key → 文本/数字），如 {\"种子\": 42}" },
    },
    required: ["template"],
  },
  validate: (args) => {
    if (!args || typeof args !== "object") throw new Error("args 必须是对象");
    const a = args as Record<string, unknown>;
    const template = str(a.template, "template（模板名称或 id）");
    const rawParams = a.params && typeof a.params === "object" ? (a.params as Record<string, unknown>) : {};
    // ComfyData.params 只收 string|number；其余类型丢弃（能力层不做布尔→字符串的暗转换）
    const params: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(rawParams)) {
      if (typeof v === "string" || typeof v === "number") params[k] = v;
    }
    return { template, params };
  },
  confirm: (_channel, args) => {
    const tpl = resolveTemplate(args.template);
    return {
      type: "inline",
      prompt: `即将在画布上用本地 ComfyUI 模板「${tpl ? tpl.name : args.template}」生成（占用 GPU，可能需要数分钟；${tpl ? "" : "模板名将由运行时精确匹配，"}不扣 API 费）。`,
    };
  },
  estimate: () => null, // 本地运行无 API 费；GPU 占用已由确认卡告知
  run: async (args, _ctx) => {
    const tpl = resolveTemplate(args.template);
    if (!tpl) {
      const names = useComfy.getState().templates.map((t) => t.name).slice(0, 8).join("、");
      throw new Error(`找不到模板「${args.template}」${names ? `；现有模板：${names}${useComfy.getState().templates.length > 8 ? " 等" : ""}` : "（还没有导入任何模板）"}`);
    }
    // 环形导入说明：agentEngine → capability → 本模块 → agentEngine 只取运行期函数（函数声明提升），模块求值期安全
    const nodeId = useBoard.getState().addNode("comfy", agentCanvasPos(-200, -180), {
      templateId: tpl.id,
      params: args.params,
    });
    await runFlow(nodeId,_ctx.signal);
    _ctx.signal?.throwIfAborted();
    const node = useBoard.getState().nodes.find((n) => n.id === nodeId);
    const d = (node?.data ?? {}) as Record<string, unknown>;
    if (d.status !== "done") throw new Error(`模板运行未成功（节点状态：${String(d.status ?? "未知")}；错误：${String(d.error ?? "无")}）——完整日志见画布节点与报错中心`);
    const imgs = Array.isArray(d.results) ? d.results.length : 0;
    const vids = Array.isArray(d.videoResults) ? d.videoResults.length : 0;
    const textOut = typeof d.textOut === "string" && d.textOut.trim() ? `\n文本输出：${d.textOut.slice(0, 400)}` : "";
    return {
      text: `已在画布用模板「${tpl.name}」完成生成：图片 ${imgs} 张、视频 ${vids} 条，产物已收录资产库。${textOut}`,
      data: { nodeId, images: imgs, videos: vids },
    };
  },
});

function resolveTemplate(key: string) {
  const list = useComfy.getState().templates;
  return (
    list.find((t) => t.id === key) ??
    list.find((t) => t.name === key) ??
    list.find((t) => t.name.includes(key) || key.includes(t.name))
  );
}

/**
 * 新节点落点（画布可视区中心，扣掉标题栏与右侧助手面板）。
 * 与 agentEngine.canvasCenterPos 同款逻辑——这里内联而不 import，
 * 是为了断开 builtin → agentEngine → capability 的模块环（启动期 TDZ 白屏的根源）。
 */
function agentCanvasPos(offsetX = 0, offsetY = 0) {
  const b = useBoard.getState();
  const vp = b.boards[b.activeId]?.meta.viewport ?? { x: 0, y: 0, zoom: 1 };
  const tbH = 46; // 标题栏高度（theme.css 的 --tb-h）
  const panelW = useUi.getState().agentOpen ? Math.min(400, window.innerWidth * 0.92) : 0;
  const cx = (window.innerWidth - panelW) / 2;
  const cy = tbH + (window.innerHeight - tbH) / 2;
  return {
    x: (cx - vp.x) / vp.zoom + offsetX + Math.random() * 60,
    y: (cy - vp.y) / vp.zoom + offsetY + Math.random() * 60,
  };
}
