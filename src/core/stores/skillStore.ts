import {PLANAR_SHEET_RULES} from "../planarSheetPrompt";
import {H3_AUTHOR_RULES} from "../studio/h3AuthoringCore";
/**
 * Skill Store — 安装 / 更新 / 启停 / 收藏 / 独立持久化
 * 落盘到 skills.json；Skill 本体存这里，节点/导演项目只保存 SkillBinding。
 */
import { ELEMENT_FLAT_RULES } from "../elementFlatPlan";
import { create } from "zustand";
import { loadJSON, saveJSON } from "../persist";
import { uid } from "../utils";
import type { MomoSkill } from "../skillTypes";
import {mergeSkillCatalog} from "../skillCatalog";

type PersistShape = { skills: MomoSkill[]; deletedBuiltinIds?: string[]; schemaVersion: 1 | 2 };

type SkillState = {
  skills: MomoSkill[];
  deletedBuiltinIds: string[];
  loaded: boolean;
  init: () => Promise<void>;
  install: (skill: MomoSkill) => void; // 新增或更新（同 id 覆盖）
  remove: (id: string) => void;
  restoreDeletedBuiltins: () => void;
  toggleEnabled: (id: string) => void;
  toggleStarred: (id: string) => void;
  getById: (id: string) => MomoSkill | undefined;
  /** 按上下文查询已启用的 Skill（供选择器使用） */
  byContext: (ctx: string) => MomoSkill[];
};

let initOnce: Promise<void> | null = null;

/** 内置 Skill */
function builtinSkills(): MomoSkill[] {
  const now = Date.now();
  return [
    {id:"builtin-planar-sheet",name:"立体转平面矢量",version:"1.0.0",source:"builtin",kind:"workflow",description:"整张立体效果图重建为平面部件总稿，再转 SVG、原图拆件与模糊件重绘。",contexts:["prompt.image","studio.image","agent.image"],phase:"authoring",purpose:"compile-image-prompt",output:"text",instructions:PLANAR_SHEET_RULES,variables:[],enabled:true,createdAt:now,updatedAt:now},
    {id:"builtin-h3-bilingual-author",name:"H3 中文排版与英文执行",version:"1.0.0",source:"builtin",kind:"workflow",description:"中文文案按 H3 模式排版，翻译英文描述，保留原语对白、可见文字与参考编号。",contexts:["prompt.video","director.segment","agent.video"],phase:"authoring",purpose:"compile-video-prompt",output:"text",instructions:H3_AUTHOR_RULES,variables:[],enabled:true,createdAt:now,updatedAt:now},
    {
      id: "builtin-element-decompose", name: "单件视图重绘", version: "1.1.0", source: "builtin", kind: "workflow",
      description: "将美陈、文化墙立体效果图逐件重建为平面稿，支持正面/背面/底面、配色与尺寸。画布图片 → 编辑 → 元素分层 → 单件视图重绘。",
      contexts: ["prompt.image", "studio.image", "agent.image"], phase: "authoring", purpose: "compile-image-prompt", output: "text",
      instructions: ELEMENT_FLAT_RULES, triggers: ["单件正面重绘", "单件背面重绘", "单件底面重绘"],
      variables: [
        { key: "view", label: "视图", type: "select", options: ["正面", "背面", "底面"], default: "正面" },
        { key: "backColor", label: "背面颜色", type: "text", default: "#ffffff" },
        { key: "bottomColor", label: "底面颜色", type: "text", default: "#eeeeee" },
        { key: "background", label: "背景颜色", type: "text", default: "#ffffff" },
        { key: "size", label: "输出尺寸", type: "text", default: "1024×1024 px" },
      ], enabled: true, createdAt: now, updatedAt: now,
    },
    {
      id: "builtin-prompt-polish",
      name: "提示词精修",
      version: "1.0.0",
      description: "把粗糙的绘画意图优化为高质量中文提示词：补充主体细节、构图、光影、风格、质感、镜头信息",
      source: "builtin",
      // prompt.text 必须在列：提示词节点的工具弹窗在「无同路参考图」时只查 prompt.text，
      // 缺了它会出现「有图的节点能看到、没图的新节点上凭空消失」的错位
      contexts: ["prompt.text", "prompt.image", "prompt.video", "agent.image", "agent.video"],
      phase: "authoring",
      purpose: "compile-image-prompt",
      output: "text",
      instructions: `你是一位顶级 AI 绘画提示词专家。用户会给你一段绘画意图或粗糙提示词，请把它优化为一段高质量的中文绘画提示词。

要求：
- 补充主体细节（外貌、服装、材质、姿势）
- 补充构图（景别、视角、画面布局）
- 补充光影（光源方向、明暗对比、氛围）
- 补充风格与质感（绘画/摄影/3D、色调）
- 补充镜头信息（焦段、景深、运动）
- 保持原意，不改变用户的核心意图
- 只输出优化后的提示词本身，不要任何解释或前后缀`,
      variables: [
        {
          key: "style",
          label: "风格倾向",
          type: "select",
          options: ["自动", "电影感", "动漫", "写实摄影", "油画", "水彩", "3D 渲染"],
          default: "自动",
          hint: "引导优化方向；「自动」由模型判断",
        },
      ],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "builtin-remote-video-prompt",
      name: "外调视频提示词规范",
      version: "1.0.0",
      description:
        "外调第三方视频 API（Kling / Google Veo / Gemini 视频等）的提示词写法规范——自然语言段落式，与本地 H3 六段式互斥使用。绑定到项目并把生效范围设为「仅外调」即可。",
      source: "builtin",
      contexts: ["prompt.video", "director.project", "studio.mv"],
      phase: "model-adapter",
      purpose: "compile-video-prompt",
      output: "text",
      instructions: `【外调视频模型提示词规范（Kling / Veo / Gemini Video 等第三方 API）】

发送给外调视频模型的提示词请遵守以下规范（与本地 ComfyUI 的 H3 结构化六段式不同，外调模型偏好连贯自然语言）：

1. 用一段连贯的自然语言描述画面：主体（谁/什么）→ 动作（做什么、先后顺序）→ 环境（在哪里、时间/天气）→ 镜头（景别、运镜方式）→ 光线与色调 → 整体风格。
2. 单段叙事：一次生成只讲一个连续动作或场景变化，不写多镜头剪辑指令（外调单次生成不做剪辑）。
3. 运镜用通用词汇（push in / pull back / pan left / tracking shot / static shot），时长语义明确（"in X seconds" 仅在模型支持时使用）。
4. 禁止出现本地工作流专用的占位语法与结构标记：不写 <Picture N> / <Video N> / <Audio N>、不写 subject_definitions、不写六段式小节头。参考素材已在请求的媒体通道里，提示词里只描述内容本身。
5. 对白与拟声直接写成引号内的台词或声音描述，不使用标记包裹。
6. 保持与项目风格锚点（色调、胶片感等）一致；负向内容（字幕、水印）交给负向参数，不在正文中反复强调。
7. 提示词语言跟随目标模型的偏好（Kling 中文友好，Veo/Gemini 系建议英文段落）；输出前保持术语准确、无歧义。

本规范用于约束「要发给外调模型前的最终提示词」：如果输入已是符合上述规范的段落式提示词，原样输出即可。`,
      variables: [
        {
          key: "lang",
          label: "提示词语言",
          type: "select",
          options: ["自动", "中文", "英文"],
          default: "自动",
          hint: "外调模型的提示词语言倾向（Kling 中文友好，Veo/Gemini 建议英文）",
        },
      ],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "builtin-ltx-video-prompt",
      name: "LTX 视频提示词方言",
      version: "1.0.0",
      description:
        "本地 LTX-Video（ComfyUI 模板）的提示词适配：音画联合描述、多关键帧、延展与 V2V 语义。不复用 H3 六段式。绑定后把生效范围设为「仅本地」+ 关键词 LTX。",
      source: "builtin",
      contexts: ["prompt.video", "director.project"],
      phase: "model-adapter",
      purpose: "compile-video-prompt",
      output: "text",
      instructions: `【LTX-Video 提示词方言（本地 ComfyUI 通道）】

发送给 LTX 的提示词遵守以下规范（与 H3 结构化六段式不同，LTX 偏好连贯的音画联合自然语言）：

1. 一段连贯的英文优先描述：主体 → 动作与运镜（camera orbit / dolly in / static 等通用术语）→ 环境 → 光线 → 风格；把声音事件写进描述本身（LTX 支持音画联合生成，如 "waves crash as the camera pushes in"）。
2. 多关键帧模板：关键帧之间的过渡动作要写成时间上平滑衔接的一句；不写帧编号语法（帧已通过模板图片入口投喂）。
3. 延展（extend）：描述承接源视频结尾的动作延续，不重述已发生内容。
4. V2V / Retake：描述目标变化（动作、外观、风格），保持镜头与构图不变的部分明确写 "same camera, same framing"。
5. LoRA：触发词放在描述开头（如 "ltxl_realism v0.9,"），不在提示词里写权重数字（权重走模板参数）。
6. 时长/帧数/分辨率/显存约束由模板能力档案决定，提示词里不重复声明。
7. 中文需求先在内心翻译成英文再输出；对白保持原语言加引号。

本规范用于约束「发给 LTX 前的最终提示词」；若输入已符合上述规范，原样输出。`,
      variables: [],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export const useSkills = create<SkillState>((set, get) => ({
  skills: [],
  deletedBuiltinIds: [],
  loaded: false,

  init: () =>
    (initOnce ??= (async () => {
      const saved = await loadJSON<PersistShape>("skills.json", "v1");
      // 合并内置 Skill（用户可能禁用了内置项，保留用户的 enabled/starred 状态）
      const builtin = builtinSkills();
      // 防御：早期版本导入的 Skill 可能缺 id（展开覆盖 bug），加载时补发，避免 install 误判同 id 互相覆盖
      const userSkills = (saved?.skills ?? []).map((s) => (s.id ? s : { ...s, id: uid(8) }));
      // v1 没有删除标记，默认空；沿用 v1 存储键读取，下一次保存升级内容版本。
      const deletedBuiltinIds=Array.isArray(saved?.deletedBuiltinIds)?[...new Set(saved.deletedBuiltinIds.filter((id):id is string=>typeof id==="string"))]:[];
      set({ skills: mergeSkillCatalog(builtin,userSkills,deletedBuiltinIds), deletedBuiltinIds, loaded: true });
    })()),

  install: (skill) => {
    void (async () => {
      // 写操作前必须确保 init 完成：否则内存是空数组，会把内置 Skill 和已存数据整体覆盖落盘
      if (!get().loaded) await get().init();
      const s = get();
      const idx = s.skills.findIndex((x) => x.id === skill.id);
      const skills = idx >= 0 ? s.skills.map((x) => (x.id === skill.id ? { ...skill, updatedAt: Date.now() } : x)) : [...s.skills, skill];
      const deletedBuiltinIds=s.deletedBuiltinIds.filter(id=>id!==skill.id);
      set({ skills, deletedBuiltinIds });
      void saveJSON("skills.json", "v1", { skills, deletedBuiltinIds, schemaVersion: 2 } satisfies PersistShape);
    })();
  },

  remove: (id) => {
    void (async () => {
      if (!get().loaded) await get().init();
      const s = get();
      const target=s.skills.find(x=>x.id===id);if(!target)return;
      const isBuiltin=target.source==="builtin"||builtinSkills().some(x=>x.id===id);
      const deletedBuiltinIds=isBuiltin?[...new Set([...s.deletedBuiltinIds,id])]:s.deletedBuiltinIds;
      const skills = s.skills.filter((x) => x.id !== id);
      set({ skills, deletedBuiltinIds });
      void saveJSON("skills.json", "v1", { skills, deletedBuiltinIds, schemaVersion: 2 } satisfies PersistShape);
    })();
  },

  restoreDeletedBuiltins: () => {
    void (async()=>{
      if(!get().loaded)await get().init();
      const s=get(),ids=new Set(s.deletedBuiltinIds);
      const skills=[...s.skills,...builtinSkills().filter(x=>ids.has(x.id)&&!s.skills.some(y=>y.id===x.id))];
      set({skills,deletedBuiltinIds:[]});
      void saveJSON("skills.json","v1",{skills,deletedBuiltinIds:[],schemaVersion:2} satisfies PersistShape);
    })();
  },

  toggleEnabled: (id) => {
    void (async () => {
      if (!get().loaded) await get().init();
      const s = get();
      const skills = s.skills.map((x) => (x.id === id ? { ...x, enabled: !x.enabled, updatedAt: Date.now() } : x));
      set({ skills });
      void saveJSON("skills.json", "v1", { skills, deletedBuiltinIds:s.deletedBuiltinIds, schemaVersion: 2 } satisfies PersistShape);
    })();
  },

  toggleStarred: (id) => {
    void (async () => {
      if (!get().loaded) await get().init();
      const s = get();
      const skills = s.skills.map((x) => (x.id === id ? { ...x, starred: !x.starred } : x));
      set({ skills });
      void saveJSON("skills.json", "v1", { skills, deletedBuiltinIds:s.deletedBuiltinIds, schemaVersion: 2 } satisfies PersistShape);
    })();
  },

  getById: (id) => get().skills.find((x) => x.id === id),

  byContext: (ctx) => get().skills.filter((s) => s.enabled && s.contexts.includes(ctx as any)),
}));

/** 便利方法：React 外用 getState() 取已启用的某上下文 Skill */
export function skillsForContext(ctx: string): MomoSkill[] {
  const s = useSkills.getState();
  if (!s.loaded) void s.init();
  return s.byContext(ctx);
}

/** 新建空 Skill（导入向导用） */
export function newSkill(partial: Partial<MomoSkill>): MomoSkill {
  const now = Date.now();
  const merged: MomoSkill = {
    id: uid(8),
    name: "未命名 Skill",
    version: "1.0.0",
    description: "",
    source: "import",
    contexts: ["prompt.text"],
    phase: "authoring",
    output: "text",
    instructions: "",
    variables: [],
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
  // id 兜底必须在展开之后：partial.id 为 undefined/空串时展开会覆盖掉默认 uid，导致所有无 id 的导入互相覆盖
  if (!merged.id) merged.id = uid(8);
  return merged;
}
