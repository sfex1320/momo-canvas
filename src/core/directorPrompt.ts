/**
 * 导演台提示词编译器 — 把模型无关的镜头结构编译成目标模型所需的提示词
 *
 * 方案 §7.3 / §23.3：导演台内保存的是模型无关的镜头结构，不直接把最终 H3 提示词当作唯一真相。
 * 生成前由 PromptCompiler 根据配方编译：
 *  - 公共层：人物连续性、场景、动作、景别、镜头运动、光线、对白、音效和音乐
 *  - 图片配方：编译静态构图（不混入无意义的视频时序描述）
 *  - 视频配方：组织成带时间点的镜头、摄影机与音频描述
 *
 * 编译结果同时保存：
 *  - 用户可编辑的导演描述（镜头大纲里存的）
 *  - 编译后的实际请求提示词（Take 快照里存的）
 *  - 生成时的配方、工作流指纹、参数和素材顺序快照（Take 快照里存的）
 */
import type {
  DirectorCharacter,
  DirectorProject,
  DirectorRuleSet,
  DirectorScene,
  DirectorSegment,
  DirectorShot,
} from "./types";

/** 模型无关的镜头描述（编译的中间结构，编译前） */
export type ShotContext = {
  segment: DirectorSegment;
  shot?: DirectorShot;
  scene: DirectorScene;
  characters: DirectorCharacter[];
  /** 上一镜头的结束状态（连续性继承） */
  prevEndState?: string;
  /** 项目规则 */
  ruleSet?: DirectorRuleSet;
  /** 单镜头覆盖（用户手填） */
  override?: string;
};

/** 编译目标 */
export type CompileTarget =
  | "image-t2i" // 文生图（分镜概念图）
  | "image-i2i" // 图生图（关键帧润色）
  | "video-t2v" // 文生视频
  | "video-i2v" // 图生视频（首帧）
  | "video-fl2v" // 首尾帧视频
  | "video-r2v"; // 多参考视频

/**
 * 编译镜头上下文成模型无关的提示词结构。
 * 这是「导演语言」层，不针对任何具体模型。
 */
export function compileShotStructure(ctx: ShotContext): {
  subject: string;
  scene: string;
  action: string;
  shotSize: string;
  camera: string;
  lighting: string;
  style: string;
  audio: string;
  continuity: string;
  negative: string[];
} {
  const { segment, shot, scene, characters, prevEndState, ruleSet, override } = ctx;
  const parts = {
    subject: characters.length
      ? characters.map((c) => `${c.name}（${c.continuity}）`).join("；")
      : "",
    scene: scene.location,
    action: shot?.action ?? segment.summary,
    shotSize: shot?.shotSize ?? "",
    camera: shot?.camera ?? "",
    lighting: ruleSet?.positive.lighting ?? "",
    style: [ruleSet?.positive.style, ruleSet?.positive.visualTone].filter(Boolean).join("，"),
    audio: shot?.audio ?? segment.dialogue.join(" / "),
    continuity: [prevEndState, segment.continuityIn].filter(Boolean).join("；"),
    negative: [] as string[],
  };
  // 负向规则
  if (ruleSet?.negative.noSubtitles) parts.negative.push("字幕", "文字", "水印");
  if (ruleSet?.negative.noWatermark) parts.negative.push("水印", "logo");
  if (ruleSet?.negative.noBackgroundMusic) parts.negative.push("背景音乐");
  if (ruleSet?.negative.noText) parts.negative.push("任何文字");
  if (ruleSet?.negative.noDialogue) parts.negative.push("对白", "对话", "旁白");
  if (ruleSet?.negative.extra && Array.isArray(ruleSet.negative.extra)) parts.negative.push(...ruleSet.negative.extra);
  // 用户覆盖追加到最后
  if (override) parts.action = `${parts.action}。${override}`;
  return parts;
}

/** 把镜头结构编译成最终提示词字符串（按目标模型类型）。
 *  ctx 可传单个镜头上下文或整段全部镜头（导演台 2.0：通用编译路径从「只编译第一个 Shot」
 *  改为编译片段内所有 Shot，方案 §13.1——多镜头段落逐时段输出）。 */
export function compilePrompt(ctx: ShotContext | ShotContext[], target: CompileTarget): string {
  const ctxs = Array.isArray(ctx) ? ctx : [ctx];
  const first = ctxs[0];
  if (!first) return "";
  const p = compileShotStructure(first);
  const isImage = target.startsWith("image");

  // 图片配方：静态构图，不混入视频时序
  if (isImage) {
    return [
      p.subject,
      p.scene,
      p.action,
      p.shotSize,
      p.camera && `${p.camera}构图`,
      p.lighting,
      p.style,
    ].filter(Boolean).join("，");
  }

  // 视频配方：带时间点的镜头描述
  if (ctxs.length > 1 && ctxs.every((c) => c.shot)) {
    // 多镜头：每 Shot 一行「起-止秒：景别/运镜/动作/音频」，共享字段（角色/场景/风格）只写一次
    const shotLines = ctxs.map((c) => {
      const sp = compileShotStructure(c);
      const head = [sp.shotSize, sp.camera].filter(Boolean).join("，");
      const audio = sp.audio ? `（音频：${sp.audio}）` : "";
      return `${c.shot!.startSec}–${c.shot!.endSec}秒：${head ? `${head}，` : ""}${sp.action}${audio}`;
    });
    return [
      ...shotLines,
      p.subject && `角色：${p.subject}`,
      p.scene && `场景：${p.scene}`,
      p.lighting && `光线：${p.lighting}`,
      p.continuity && `承接：${p.continuity}`,
      p.style && `风格：${p.style}`,
    ].filter(Boolean).join("\n");
  }

  const timeAxis = ctxs[0].shot
    ? `${ctxs[0].shot.startSec}-${ctxs[0].shot.endSec}秒`
    : `0-${ctxs[0].segment.durationSec}秒`;
  return [
    `${timeAxis}：${p.action}`,
    p.subject && `角色：${p.subject}`,
    p.scene && `场景：${p.scene}`,
    p.shotSize && `景别：${p.shotSize}`,
    p.camera && `摄影机：${p.camera}`,
    p.lighting && `光线：${p.lighting}`,
    p.audio && `音频：${p.audio}`,
    p.continuity && `承接：${p.continuity}`,
    p.style && `风格：${p.style}`,
  ].filter(Boolean).join("\n");
}

/** 编译负向提示词（独立字段，方案 §23.3） */
export function compileNegative(ctx: ShotContext): string {
  const p = compileShotStructure(ctx);
  return p.negative.join("，");
}

/**
 * H3 R2V 专用：按参考素材的最终连接顺序注入 <Picture N> / <Video N> / <Audio N> 标签。
 * 方案 §7.6：R2V 提示词标签按实际连接顺序产生，素材卡片拖动排序后必须重新编译标签。
 *
 * 注：导演台生成链路当前由 directorRefs.refsNoteFromSnapshot 承担同一职责（编号与槽序严格一致），
 * 本函数保留给需要「kind/usage/label 三元组」自定义前缀的场景。
 *
 * @param basePrompt 编译好的基础提示词
 * @param refs 参考素材列表（按连接顺序）：每项标注用途
 */
export function injectR2VTags(
  basePrompt: string,
  refs: Array<{ kind: "image" | "video" | "audio"; usage: string; label: string }>,
): string {
  const picN: string[] = [];
  const vidN: string[] = [];
  const audN: string[] = [];
  for (const r of refs) {
    if (r.kind === "image") picN.push(`<Picture ${picN.length + 1}>：${r.label}（${r.usage}）`);
    else if (r.kind === "video") vidN.push(`<Video ${vidN.length + 1}>：${r.label}（${r.usage}）`);
    else if (r.kind === "audio") audN.push(`<Audio ${audN.length + 1}>：${r.label}（${r.usage}）`);
  }
  const tags = [...picN, ...vidN, ...audN];
  return tags.length ? `${basePrompt}\n\n参考素材：\n${tags.join("\n")}` : basePrompt;
}

/* ---------------- H3 成品提示词解析（分镜卡框格化展示用） ---------------- */

/** H3 六段式正文段名 → 中文标签 */
export const H3_SECTION_LABELS: Record<string, string> = {
  subject_definitions: "角色与场景定义",
  summary: "内容摘要",
  retention_analysis: "保真分析",
  detailed_description: "动作时序描述",
  overall_soundscape: "声音环境",
  non_diegetic_music: "音乐（非剧情内）",
};

/** H3 元数据字段 → 中文标签（不认识的字段原样显示） */
export const H3_META_LABELS: Record<string, string> = {
  Purpose: "段落目的",
  "Continuity bridge in": "承接桥（入）",
  "Continuity bridge out": "衔接桥（出）",
  "Reference image order": "参考图顺序",
  Characters: "角色",
  Scene: "场景",
  Props: "道具",
  Dialogue: "对白",
  Camera: "摄影机",
};

export type ParsedH3Prompt = {
  /** 标题行三段：H3-01 / 三岁的画 / 12秒 */
  code: string;
  title: string;
  duration: string;
  /** 元数据字段（`**Label**: value` 行，值可多行） */
  meta: Array<{ label: string; value: string }>;
  /** 六段正文 */
  sections: Array<{ name: string; text: string }>;
};

/**
 * 解析 H3 成品提示词为框格化展示结构（标题行 + 元数据 + 六段正文）。
 * 无 `## H3-` 头且无 `subject_definitions:` 正文时返回 null，调用方回落纯文本预览。
 */
export function parseH3Prompt(text: string): ParsedH3Prompt | null {
  const t = text.trim();
  if (!t) return null;
  const lines = t.split(/\r?\n/);
  let code = "";
  let title = "";
  let duration = "";
  let i = 0;
  // 标题行：## H3-01 | 三岁的画 | 12秒（全角｜/省略尾段都认）
  const head = lines[0].match(/^##\s*(H3[-_]?[\w-]*)\s*[|｜]\s*([^|｜]*?)\s*(?:[|｜]\s*(.*))?$/i);
  if (head) {
    code = head[1];
    title = head[2].trim();
    duration = (head[3] ?? "").trim();
    i = 1;
  } else if (!/subject_definitions\s*:/i.test(t)) {
    return null;
  }
  const metaBufs: Array<{ label: string; lines: string[] }> = [];
  const secBufs: Array<{ name: string; lines: string[] }> = [];
  let curMeta: { label: string; lines: string[] } | null = null;
  let curSec: { name: string; lines: string[] } | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const secM = line.match(
      /^(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music)\s*:\s*(.*)$/i,
    );
    if (secM) {
      curMeta = null;
      curSec = { name: secM[1].toLowerCase(), lines: secM[2].trim() ? [secM[2].trim()] : [] };
      secBufs.push(curSec);
      continue;
    }
    if (curSec) {
      curSec.lines.push(line.trimEnd());
      continue;
    }
    const metaM = line.match(/^\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/);
    if (metaM) {
      curMeta = { label: metaM[1].trim(), lines: metaM[2].trim() ? [metaM[2].trim()] : [] };
      metaBufs.push(curMeta);
      continue;
    }
    if (curMeta) curMeta.lines.push(line.trim());
  }
  return {
    code,
    title,
    duration,
    meta: metaBufs.filter((m) => m.label).map((m) => ({ label: m.label, value: m.lines.join("\n").trim() })),
    sections: secBufs.map((s) => ({ name: s.name, text: s.lines.join("\n").trim() })).filter((s) => s.text),
  };
}

/**
 * 判断角色是否在本段出场（方案 §13.1：角色按本段实际出场过滤，不默认把项目全部角色写进每段）。
 * 判定素材：摘要、对白、镜头动作/音频、承接说明、剧本原文——正文提及角色名即视为出场。
 */
export function appearingCharacters(
  project: DirectorProject,
  segment: DirectorSegment,
): DirectorCharacter[] {
  const all = project.characters ?? [];
  if (segment.characterIds) return all.filter(c => segment.characterIds!.includes(c.id));
  if (!all.length) return [];
  const text = [
    segment.summary,
    segment.dialogue.join("\n"),
    segment.shots.map((s) => `${s.action}\n${s.audio}`).join("\n"),
    segment.continuityIn ?? "",
    segment.continuityOut ?? "",
    segment.scriptText ?? "",
  ].join("\n");
  const hit = all.filter((c) => c.name && text.includes(c.name));
  // 一个都匹配不上时不冒险丢主角（可能正文用了代词）：回退全部角色
  return hit.length ? hit : all;
}

/** 收集一个 segment 的完整镜头上下文（供 UI 预览编译结果用）。
 *  角色列表按本段实际出场过滤（导演台 2.0，方案 §13.1）。 */
export function segmentShotContexts(project: DirectorProject, segment: DirectorSegment): ShotContext[] {
  const scene = project.scenes.find((s) => s.id === segment.sceneId);
  if (!scene) return [];
  const chars = appearingCharacters(project, segment);
  return segment.shots.map((shot) => ({
    segment,
    shot,
    scene,
    characters: chars,
    ruleSet: project.ruleSet,
  }));
}

/* ---------------- 提示词来源图谱与引用编号校验（导演台 2.0，方案 §13.2 / §8.2） ---------------- */

/** 来源图谱的一节：最终提示词由这些来源拼接而成，检查器按节展示 */
export type PromptSourcePart = {
  key: string;
  label: string;
  text: string;
};

/**
 * 解析最终提示词的来源构成（只读分析，不改编译结果）：
 * 项目风格 / 角色连续性 / 片段镜头 / 用户修改 / Skill / 负向规则 / 参考编号。
 */
export function promptSourceMap(project: DirectorProject, segment: DirectorSegment, finalText: string): PromptSourcePart[] {
  const parts: PromptSourcePart[] = [];
  const gStyle = project.ruleSet?.positive.style?.trim();
  if (gStyle) parts.push({ key: "style", label: "项目风格", text: gStyle });
  const chars = appearingCharacters(project, segment);
  if (chars.length) {
    parts.push({
      key: "chars",
      label: "角色连续性",
      text: chars.map((c) => `${c.name}（${c.continuity}）`).join("；"),
    });
  }
  if (segment.shots.length) {
    parts.push({
      key: "shots",
      label: "片段镜头",
      text: segment.shots
        .map((s, i) => `镜${i + 1} ${s.startSec}-${s.endSec}s ${s.shotSize} ${s.camera} ${s.action}`.trim())
        .join("\n"),
    });
  }
  if (segment.promptOverride?.trim()) parts.push({ key: "user", label: "用户修改（片段提示词）", text: segment.promptOverride.slice(0, 400) });
  if (segment.promptFinalOverride?.trim()) parts.push({ key: "final", label: "最终稿（锁定自动编译）", text: segment.promptFinalOverride.slice(0, 400) });
  if (/^参考素材（按序/m.test(finalText)) {
    const m = finalText.match(/^参考素材（按序[^\n]*\n([\s\S]*?)(?=\n\n|$)/m);
    if (m) parts.push({ key: "refs", label: "参考编号", text: m[1] });
  }
  const neg = finalText.match(/负向：(.+)$/m);
  if (neg) parts.push({ key: "neg", label: "负向规则", text: neg[1] });
  return parts;
}

/**
 * 校验提示词里的 <Picture N> / <Video N> / <Audio N> 引用编号是否越界（方案 §8.2）。
 * counts 为三类素材的实际投喂数量；返回问题列表（空 = 全部合法）。
 */
export function validateRefTags(
  prompt: string,
  counts: { pictures: number; videos: number; audios: number },
): string[] {
  const problems: string[] = [];
  const check = (tag: "Picture" | "Video" | "Audio", max: number) => {
    const re = new RegExp(`<${tag}\\s+(\\d+)>`, "gi");
    for (const m of prompt.matchAll(re)) {
      const n = Number(m[1]);
      if (n < 1) problems.push(`<${tag} ${n}> 编号从 1 开始`);
      else if (n > max) problems.push(`<${tag} ${n}> 超出实际素材数（${max} 张）——编号会指错图`);
    }
  };
  check("Picture", counts.pictures);
  check("Video", counts.videos);
  check("Audio", counts.audios);
  return problems;
}
