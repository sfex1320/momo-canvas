/**
 * Comfy 工作流同步 · 纯逻辑：路径规范化与身份对账（规格 FR-006 / FR-007）
 *
 * 改名/移动识别不做任何 IO：engine 扫描后把「消失的记录」和「新出现的文件」的
 * 身份信号（graphId / semanticHash / structureFingerprint）喂进来，本模块做一对一配对。
 * 有歧义（多个候选同分）不强行配对，交给上层按「新发现」处理，绝不猜错导致重复模板。
 */

/** 规范化相对路径：`\`→`/`、去开头 `./`、整体小写（Windows 大小写不敏感，规格 §12.1） */
export function normRel(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/** 规范化绝对路径（比较用；存储保留原样） */
export function normAbs(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

export type IdentitySignals = {
  graphId?: string;
  semanticHash?: string;
  structureFingerprint?: string;
};

export type GoneRecord = IdentitySignals & { workflowId: string };

export type NewFileRecord = IdentitySignals & { rel: string };

export type RenameMatch = {
  workflowId: string;
  rel: string;
  /** 命中的信号级别（弱命中建议 UI 提示用户确认，规格 FR-006 第 6 级） */
  level: "graphId" | "semantic" | "structure";
};

/**
 * 消失记录 × 新文件 一对一配对。优先级（规格 FR-006）：
 * graphId（UI Workflow 自带 id）> semanticHash（内容完全一致）> structureFingerprint（结构一致，弱）。
 * 同一候选出现多对一/一对多时该候选整体放弃（宁可让用户确认，不可猜错）。
 */
export function matchRenames(gone: GoneRecord[], fresh: NewFileRecord[]): RenameMatch[] {
  const out: RenameMatch[] = [];
  const usedRel = new Set<string>();
  const usedId = new Set<string>();
  const tryLevel = (
    level: RenameMatch["level"],
    keyOf: (s: IdentitySignals) => string | undefined,
  ) => {
    for (const g of gone) {
      if (usedId.has(g.workflowId)) continue;
      const key = keyOf(g);
      if (!key) continue;
      const hits = fresh.filter((f) => !usedRel.has(f.rel) && keyOf(f) === key);
      if (hits.length !== 1) continue; // 0 或歧义：本级不配
      usedId.add(g.workflowId);
      usedRel.add(hits[0].rel);
      out.push({ workflowId: g.workflowId, rel: hits[0].rel, level });
    }
  };
  tryLevel("graphId", (s) => s.graphId);
  tryLevel("semantic", (s) => s.semanticHash);
  tryLevel("structure", (s) => s.structureFingerprint);
  return out;
}
