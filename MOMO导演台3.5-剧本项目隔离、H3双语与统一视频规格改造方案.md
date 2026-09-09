# MOMO 导演台 3.5：剧本项目隔离、H3 双语与统一视频规格改造方案

> 日期：2026-08-30  
> 性质：产品与技术实施方案  
> 适用范围：导演台、剧本库、角色库、H3 导演台、AI 制图、AI MV、成片交付、资产库、Skill、ComfyUI 与外部视频模型  
> 本文基于当前代码和现有 `h3-script-package`、`minimax-h3-prompt` Skill 核查，不以截图中的文案作为数据事实。

## 0. 结论先行

用户提出的目标完全可行，而且应该作为导演台下一轮最优先的数据模型修正。

核心原则只有三条：

1. **一个独立剧本故事 = 一个导演项目 = 一个项目文件夹 = 一套角色/片段/资产/Take/时间线。**
2. **选择另一个独立剧本时，切换的是整个 `DirectorProject`，不是只切换项目内部的一个 `ScriptDocument`。**
3. **统一视频规格只包含分辨率、帧率、时长；优先识别每个分段里的明确规格，项目设置只作默认值，外部模型与 ComfyUI 再分别翻译执行。**

当前问题的根源不是 H3 页面少填了几个输入框，而是“剧本文档”和“导演项目”的边界混在了一起：

- `ScriptDocument` 只是 `DirectorProject.scripts` 里的文档；
- 选择剧本只写 `project.studioUi.scriptId`；
- 角色库仍读取 `project.characters`；
- H3 仍读取 `project.scenes[].segments`；
- AI 制图、MV、时间线、Skill、资产引用也仍挂在同一个 `project.id` 下。

因此，当前选择不同剧本不会自然得到不同角色库、H3 片段和资产库。这不是刷新问题，而是数据归属设计问题。

推荐产品定义：

```text
剧本项目（DirectorProject）
├─ 唯一项目文件夹绑定
├─ 一个主剧本及其版本
├─ 本项目角色库
├─ 本项目场景与 H3 片段
├─ 本项目双语提示词
├─ 本项目资产绑定与物理输出
├─ 本项目 Take、接力、音频与时间线
├─ 本项目 Skill/配方
└─ 本项目统一视频规格
```

剧本库仍可以保存多个文档，但其语义应改成：同一故事的草稿、版本、补充材料和改编稿。完全不同的故事默认创建新导演项目，不再默认塞进当前项目。

---

## 1. 当前代码为何产生用户看到的现象

### 1.1 选择剧本没有切换项目

当前剧本库的选择逻辑是：

```ts
const selectedId = project.studioUi?.scriptId;
updateProject(project.id, {
  studioUi: { ...project.studioUi, scriptId: docId },
});
```

它只改变当前编辑器选择的文档，没有改变 `project.id`。而其他工位全部继续使用原来的 `project`：

```text
角色库       → project.characters
H3 片段      → project.scenes[].segments
参考槽       → project.globalSlots / segment.slots
AI 制图      → project.imageStudio
AI MV        → project.mvProjects
时间线       → project.timeline / postTimeline
Skill        → project.skillBindings
生成配方     → project.recipes / defaultRecipeId
```

所以当前“剧本选择器”实际上是文档选择器，不是制作项目选择器。

### 1.2 资产库是全局库，项目关系只是可选标签

`AssetItem` 目前是全局持久化实体，项目关系主要依赖：

```ts
director?: {
  projectId: string;
  sceneId?: string;
  segmentId?: string;
  takeId?: string;
  role?: ...;
}
```

这个结构可以支持按项目筛选，但目前没有真正的 `projectRoot` 和物理输出路由。因此生成结果通常先落入 AppData 资产体系，不会自动写入用户所选剧本目录。

### 1.3 H3 成品包导入会丢掉结构化字段

当前 `importPromptSegments` 对成品提示词包主要只写：

```ts
{
  summary,
  durationSec,
  dialogue: [],
  shots: [],
  promptOverride: promptBody,
  locked: true,
}
```

这会造成：

- 英文 H3 正文进入 `promptOverride`；
- 对白、镜头、承接上段、结束状态没有解析回 UI 字段；
- `locked: true` 又会让 `analyzeSegmentsWithLLM` 和 Skill 精炼跳过该段；
- 最终呈现为“提示词有内容，旁边很多导演字段却是空的”。

这正是截图中 H3 检查器大量字段没有填入的直接原因。

### 1.4 软件只保存一份 H3 提示词

现有字段只有：

```ts
promptOverride?: string;
promptFinalOverride?: string;
```

它没有区分：

- 中文审阅稿；
- 英文执行稿；
- 实际运行时插入参考编号后的请求；
- 用户最终锁定的英文稿；
- 中英文是否仍同步。

现有双语资产册已经保存 `promptZh/promptEn`，但分段提示词还没有同等级的双语模型。

### 1.5 视频规格目前是散落的，而且没有完整识别分段

当前规格分散在多个位置：

| 规格 | 当前来源 | 分段内容识别 | ComfyUI | 外部模型 | 实际问题 |
| --- | --- | --- | --- | --- | --- |
| 分辨率 | `project.resolutionMP`、`ruleSet.generation.resolution` | **未结构化识别** | 已转 MP/宽高 | **导演队列未传** | 分段写了 1080p 也不会成为本段参数 |
| 帧率 | `ruleSet.generation.fps` | **未结构化识别** | 未传给生成工作流 | 通常未传 | 分段写了 24fps 只会留在文本里 |
| 时长 | `segment.durationSec` | **只识别部分标题格式** | 已传 | 已传 | 正文元数据中的时长可能漏掉，且无来源说明 |

`scriptInspect.ts` 当前只通过 `parseSegmentTitle()` 从类似 `01-标题-11秒` 的标题尾部提取时长；它没有为分辨率和帧率定义字段。`extractGlobalStyle()` 虽会保留含“规格/帧率/FPS”的文本行，但这只是风格字符串，不会写入生成参数。因此目前既不能称为统一视频规格，也没有恢复 1.0 所强调的“识别分段内信息”。

---

## 2. 正确的数据边界

### 2.1 以 `DirectorProject` 作为剧本制作隔离边界

推荐保持 `DirectorProject` 为聚合根，不要给角色、场景、H3、MV、时间线等所有实体再补一层 `scriptId`。

原因：

- 给每个业务实体补 `scriptId` 容易漏链路；
- 任务、Take、接力、时间线、资产、Skill 都要同步过滤；
- 一旦某处忘记过滤，就会再次串项目；
- 当前绝大多数函数已经以 `projectId` 为入口，复用成本最低。

新的关系应是：

```text
导演台项目索引
├─ Project A · 倩女幽魂
│  ├─ rootPath = D:/项目/倩女幽魂
│  ├─ primaryScriptId = SCRIPT-A
│  ├─ characters = A 的角色
│  ├─ scenes/segments = A 的 H3 片段
│  └─ assets/takes/timeline = A 的结果
└─ Project B · 水墨打戏
   ├─ rootPath = D:/项目/水墨打戏
   ├─ primaryScriptId = SCRIPT-B
   ├─ characters = B 的角色
   ├─ scenes/segments = B 的 H3 片段
   └─ assets/takes/timeline = B 的结果
```

### 2.2 “切换剧本”改成“切换剧本项目”

导演台顶栏新增项目选择器：

```text
[倩女幽魂 ▾]  已绑定：D:/项目/倩女幽魂  [重新扫描] [打开文件夹]
```

选择另一个项目时，整个 `projectId` 切换，所有工位自然一起切换。

原剧本库内部的文档切换仍保留，但只用于同一故事的版本管理，不再隐式切换角色与 H3 数据。

### 2.3 导入剧本时必须让用户明确选择语义

当用户导入一个与当前项目不同的剧本时，默认弹出：

1. **新建剧本项目（推荐）**：创建新 `DirectorProject`，绑定该剧本所在文件夹。
2. 作为当前剧本的新版本：只加入当前项目的版本时间线。
3. 追加为当前项目的新场次：保留现有片段并追加，必须显示差异预演。

不能再把三个语义都藏在“送入项目”中。

---

## 3. 项目文件夹绑定

### 3.1 锁定的含义

“锁定剧本文件”不建议实现为操作系统排他锁。正确语义是：

- 保存剧本文件绝对路径；
- 保存项目根目录绝对路径；
- 保存内容指纹和最后修改时间；
- 重启后仍能恢复绑定；
- 外部文件被修改时提示“检测到外部更新”，由用户确认重新同步；
- 不因为改名或短暂离线就静默创建另一份项目。

### 3.2 新增数据结构

```ts
type DirectorWorkspaceBinding = {
  mode: "managed" | "linked";
  rootPath: string;
  sourceScriptPath?: string;
  sourceScriptHash?: string;
  manifestPath: string;
  assetCatalogPath?: string;
  segmentRootPath?: string;
  lastIndexedAt?: number;
  indexFingerprint?: string;
  status: "ready" | "missing" | "changed" | "conflict";
  writePolicy: "copy-into-project" | "reference-in-place";
};
```

在 `DirectorProject` 新增：

```ts
workspace?: DirectorWorkspaceBinding;
primaryScriptId?: string;
videoSpecDefaults?: VideoSpecDefaults;
```

### 3.3 推荐目录结构

目录需兼容 `h3-script-package` 的现有交付格式，同时允许软件增加运行产物：

```text
[故事名称]/
├─ .momo/
│  ├─ project.json
│  ├─ index.json
│  └─ snapshots/
├─ 完整剧本.md
├─ 分段剧本-中.md
├─ 分段剧本-英.md
├─ 全部素材/
│  ├─ 资产提示词.md
│  ├─ 人物/
│  ├─ 场景/
│  ├─ 道具/
│  ├─ 音频/
│  └─ 其它/
├─ 分段资产库/
│  ├─ 01_雨夜失路/
│  │  ├─ 提示词-中.md
│  │  ├─ 提示词-英.md
│  │  ├─ RefImgN_空间站位图.png
│  │  ├─ Takes/
│  │  ├─ 接力/
│  │  └─ 音频/
│  └─ 02_押影换愿/
├─ 成片/
├─ 报告/
└─ 缓存/
```

普通角色、场景、道具只保留在“全部素材”作为唯一真源；片段通过资产 ID 和相对路径逻辑绑定，不复制第二套文件。空间站位图是 `h3-script-package` 规定的例外，可以无损复制到分段目录作为执行文件。

### 3.4 文件夹识别顺序

扫描器必须按确定性优先级识别，不先调用模型：

1. `.momo/project.json`：已有 MOMO 项目，直接恢复 ID 关系。
2. `完整剧本.md`：主剧本候选。
3. `分段剧本-中.md` + `分段剧本-英.md`：双语分段对。
4. `全部素材/资产提示词.md`：双语资产册。
5. `分段资产库/NN_标题/提示词-中.md` + `提示词-英.md`：单段双语对。
6. `分段资产库/NN_标题/媒体`：绑定第 NN 段。
7. 人物/场景/道具/音频目录：生成候选分类。
8. 文件名中的 `H3-02`、`第03段`、`03_标题`：作为后备分段号。
9. 无法确定的文件进入“待分类”，不擅自绑定。

扫描完成必须先显示变更预演：

```text
将创建 12 个片段
将导入 6 个角色候选
将导入 18 个图片资产、3 个音频资产
将建立 27 个片段参考绑定
2 个文件无法分类
```

用户确认后才写项目状态。

### 3.5 所有导演台产物的物理输出路由

新增统一服务，不允许各工位自行拼路径：

```ts
collectProjectAsset({
  projectId,
  segmentId,
  category: "character" | "scene" | "prop" | "take" | "relay" | "audio" | "export",
  src,
  metadata,
});
```

路由规则：

| 产物 | 物理目录 | 资产归属 |
| --- | --- | --- |
| 角色设定图 | `全部素材/人物/` | 当前 projectId + characterId |
| 场景图 | `全部素材/场景/` | 当前 projectId + sceneId |
| 道具图 | `全部素材/道具/` | 当前 projectId |
| H3 Take | `分段资产库/NN_标题/Takes/` | 当前 projectId + segmentId + takeId |
| 尾帧/微参考 | `分段资产库/NN_标题/接力/` | 下一段绑定，记录来源 Take |
| 对白/TTS | `分段资产库/NN_标题/音频/` | 当前 segmentId |
| 背景音乐 | `全部素材/音频/` | 当前 projectId |
| 成片 | `成片/` | 当前 projectId + export role |

若项目未绑定文件夹，继续使用 AppData 托管模式，但 UI 必须明确显示“托管项目”，不能让用户误以为文件已写入剧本目录。

---

## 4. H3 双语数据模型

### 4.1 不再用一个字符串承载所有状态

建议新增：

```ts
type H3PromptLanguageData = {
  title: string;
  purpose?: string;
  continuityMode?: "opening" | "continuity_relay" | "hard_cut";
  continuityIn?: string;
  spatialLock?: string;
  continuityOut?: string;
  referenceOrder?: string[];
  characters?: string;
  scene?: string;
  props?: string;
  dialogue?: string[];
  camera?: string;
  promptBody: string;
};

type H3BilingualPrompt = {
  zh: H3PromptLanguageData;
  en: H3PromptLanguageData;
  source: "paired-files" | "skill" | "manual" | "legacy";
  syncStatus: "synced" | "zh-newer" | "en-newer" | "conflict";
  generatedAt?: number;
  skillSnapshots?: SkillRunSnapshot[];
};

type SegmentLocks = {
  structure: boolean;
  reviewZh: boolean;
  executionEn: boolean;
};
```

在 `DirectorSegment` 新增：

```ts
h3Prompt?: H3BilingualPrompt;
locks?: SegmentLocks;
videoSpec?: SegmentVideoSpec;
```

旧字段保留一个迁移周期：

- `locked` → `locks.structure`；
- H3 格式的 `promptOverride` → `h3Prompt.en.promptBody`；
- `promptFinalOverride` → `h3Prompt.en.promptBody` + `locks.executionEn = true`；
- 普通非 H3 的 `promptOverride` 暂时继续走旧编译路径。

### 4.2 H3 检查器字段如何使用

| 当前/建议字段 | 正确语义 | 自动填入来源 | 用户操作后的影响 |
| --- | --- | --- | --- |
| 摘要 | 中文导演摘要，不是完整 prompt | 中文标题、Purpose、剧本分析 | 可编辑；未锁定时可由分析更新 |
| 时长 | 本段目标时长 | 标题时长、分段元数据、模型能力 | 参与统一视频规格解析 |
| 片段配方 | 本段执行引擎/模式 | 项目默认或导入声明 | 决定能力、参考槽与提示词合同 |
| 对白 | 原语言有声文本 | `<d>[Language]...</d>` 或 Dialogue | 中英文稿必须逐字一致；供 TTS/字幕 |
| 承接上一段 | 下一段开场需复现的状态 | Continuity bridge in | 只对 continuity_relay 生效 |
| 结束状态 | 本段最后状态，供下一段继承 | Continuity bridge out | 建议在 UI 中补回，不应只存后台 |
| 空间锁 | 机位、方向、左右前后、人物位置 | Spatial lock | 与站位图共同约束，不应混入摘要 |
| 中文审阅稿 | 给用户理解和校对 | 中文分段文件或双语 Skill | 默认展示，不直接发送视频模型 |
| 英文执行稿 | H3 真正消费的模型提示词 | 英文分段文件或 H3 adapter Skill | 生成前校验并发送 |
| 实际请求 | 英文执行稿 + 运行时真实参考编号说明 | 编译器动态生成 | 只读预览，写入 Take 快照 |
| 最终锁定 | 禁止 Skill/角色同步静默改写英文执行稿 | 用户显式点击锁定 | 参考变化只标“已过期”，不自动覆盖 |
| 结构锁定 | 禁止重新拆段、删除或重排该段 | 成品包直录或用户显式操作 | 不等同于最终提示词锁定 |

“承接上一段”不是上一段的时长。建议 UI 改名为“接力进入状态”，旁边单独显示来源 Take、稳定桥接帧和末尾动作参考。

### 4.3 双语界面

提示词区域建议改成四个标签：

```text
[中文审阅] [英文执行] [左右对照] [实际请求]
```

- 中文审阅：普通用户默认入口。
- 英文执行：专业用户修改 H3 真实提示词。
- 左右对照：按元数据和六段式/三段式小节对齐，不做简单字符对比。
- 实际请求：只读，展示本次真实 `<Picture N>/<Video N>/<Audio N>` 编号和最终参数。

若用户修改中文稿：

1. `syncStatus` 变为 `zh-newer`；
2. 不静默覆盖英文；
3. 显示“同步生成英文执行稿”；
4. 生成前若英文仍旧，预检提示并要求确认；
5. 英文锁定时禁止自动同步，只允许复制中文作为新修订提案。

### 4.4 双语文件导入

如果项目目录已有：

```text
分段剧本-中.md
分段剧本-英.md
```

或每段已有：

```text
提示词-中.md
提示词-英.md
```

必须使用稳定键配对：

1. 显式段号 `H3-01`；
2. 中文段号 `第01分段`；
3. 分段目录号 `01_标题`；
4. 标题只用于校验，不作为唯一身份。

配对后校验：

- 分段数一致；
- 时长一致；
- continuity mode 一致；
- 对白原文和语言标签一致；
- 参考数量和顺序一致；
- 英文提示区除有声原文外无中文说明；
- 缺一侧时明确标记“未配对”，不能假装同步完成。

---

## 5. H3 Skill 的正确职责与填入方式

### 5.1 `h3-script-package`

它是项目包规范 Skill，不应该在每次视频生成时拼进 prompt。

它负责：

- 识别/生成项目目录；
- 完整剧本和双语汇总稿；
- 分段资产目录；
- 双语资产册；
- 中英文数量、时长、对白、参考顺序校验；
- 项目导出和重扫。

软件中的作用位置：

```text
绑定项目文件夹
→ 扫描项目包
→ 导入/校验双语稿
→ 分发角色、资产、片段、参考槽
```

它不直接填 `promptFinalOverride`，也不应该参与每次 H3 精炼。

### 5.2 `minimax-h3-prompt`

它是模型适配 Skill，负责把一个结构化片段编译为 H3 英文执行稿：

- `subject_definitions`；
- `summary`；
- `retention_analysis`；
- `detailed_description`；
- `overall_soundscape`；
- `non_diegetic_music`；
- 原语言对白；
- 参考顺序和连续性接力。

它应该填：

```text
h3Prompt.en.*
```

同时编排器应从输出元数据回写：

```text
summary
dialogue
continuityIn
continuityOut
空间锁
camera / shots（有明确时码时）
```

当前 `refineSegmentPrompts` 只写 `promptOverride`，需要升级为“解析结构化 H3 输出并按锁状态写入多个字段”。

### 5.3 中文审阅稿如何产生

优先级：

1. 项目目录已有 `提示词-中.md`：直接导入，零模型调用。
2. 已有中文结构化片段：由核心编译器生成中文审阅稿。
3. 只有英文 H3 稿：运行一次双语对齐任务，产出中文审阅稿，不修改英文原文。
4. 新建片段并运行 Skill：一次返回中文审阅结构 + 英文执行结构，统一校验后写入。

建议新增核心合同而不是把双语规则硬塞回现有 Skill：

```ts
type H3BilingualDraftResult = {
  zh: H3PromptLanguageData;
  en: H3PromptLanguageData;
};
```

Skill 仍决定 H3 方言，核心编排器决定 JSON 外壳、双语一致性和写回权限。

### 5.4 自动写回保护

自动填入遵循：

```text
字段为空且未锁定       → 自动填写
字段已有值但未锁定     → 形成提案，显示差异，用户确认后覆盖
字段已锁定             → 只标记上游已变化，不覆盖
英文最终稿已锁定       → 任何 Skill 都不能重写
```

---

## 6. 统一视频规格

### 6.1 产品定义：只有三项

导演台的“统一视频规格”只包含：

1. **分辨率**：如 `720p`、`1080p`、`1920×1080`；
2. **帧率**：如 `24fps`、`25fps`、`30fps`；
3. **时长**：每个分段的目标秒数。

画幅、音频、Seed、质量档、负向提示词仍可以存在，但不属于这个统一规格控件，也不能混进这次功能定义。

统一不等于所有分段强制用同一个值。正确语义是：

```text
项目统一设置 = 默认规格
分段内明确写出的规格 = 本段规格，优先于默认值
未写出的项 = 继承项目默认值
```

### 6.2 数据模型

```ts
type VideoResolution = {
  label: string;       // 1080p / 1920×1080
  width?: number;
  height?: number;
};

type VideoSpecValues = {
  resolution?: VideoResolution;
  fps?: number;
  durationSec?: number;
};

type VideoSpecSource = "segment-title" | "segment-metadata" | "segment-body" |
  "project-prefix" | "project-default" | "recipe-default" | "user";

type SegmentVideoSpec = VideoSpecValues & {
  sources: Partial<Record<keyof VideoSpecValues, {
    kind: VideoSpecSource;
    raw: string;       // 原始命中文本，便于用户核对
    line?: number;
  }>>;
};

type VideoSpecDefaults = Required<Pick<VideoSpecValues, "resolution" | "fps">> & {
  durationSec?: number; // 仅作为未识别出分段时长时的默认值
};
```

`DirectorProject.videoSpecDefaults` 保存统一默认值；`DirectorSegment.videoSpec` 保存从该分段识别出的值及来源。用户在片段检查器中手动修改后，来源记为 `user`，优先级最高。

### 6.3 恢复 1.0 的“分段规格识别”

当前 `parseSegmentTitle()` 只识别标题末尾时长。应新增确定性解析器：

```ts
parseVideoSpecFromSegment(rawSegment, titleLine): SegmentVideoSpec
```

按以下范围识别：

```text
标题：## H3-01｜雨夜失路｜15秒｜1080p｜24fps
元数据：分辨率：1920×1080
元数据：帧率：24 fps
元数据：时长：15 秒
英文元数据：Resolution: 1080p / FPS: 24 / Duration: 15s
正文明确句：24fps, 1920x1080, duration 15 seconds
```

推荐归一化规则：

- 分辨率支持 `480p/720p/1080p/2K/4K` 和 `宽×高`、`宽x高`；保留原文，同时转为标准 label/宽高。
- 帧率支持 `23.976/24/25/29.97/30/50/60 fps`；没有 `fps/帧率/frame rate` 语义的孤立数字不识别。
- 时长支持 `15秒/15 秒/15s/Duration: 15`；优先读取标题和显式元数据，不能把镜头内部 `0-3s` 的时间轴误认成本段总时长。
- 只扫描本分段边界内的文本；上一段的规格不得泄漏到下一段。
- 中文稿和英文稿均识别；同一分段中英文规格冲突时进入预演，不静默选择。
- 项目前言中的统一规格可作为项目默认值，但分段正文中的明确值优先。

识别结果必须在导入预演中显示：

```text
01 雨夜失路   1920×1080 · 24fps · 15s   来源：分段标题
02 押影换愿   1920×1080 · 30fps · 12s   来源：正文元数据
03 镜中看见   1080p · 24fps · 15s       时长来源：项目默认
```

用户确认后再写入片段；不能扫描完直接覆盖已有手工规格。

### 6.4 最终解析优先级

新增纯函数：

```ts
resolveVideoSpec(project, segment, recipe, capability): ResolvedVideoSpec
```

每一项分别独立取值：

```text
用户手动修改的分段规格
→ 分段中识别出的明确规格
→ 项目前言识别出的统一规格
→ 项目统一设置
→ 配方/模型默认值
```

不能把三项作为整包覆盖。例如分段只写了 `15秒`，则只覆盖时长，分辨率和帧率继续继承项目设置。

```ts
type ResolvedVideoSpec = {
  requested: Required<VideoSpecValues>;
  applied: Required<VideoSpecValues>;
  source: Partial<Record<keyof VideoSpecValues, VideoSpecSource>>;
  adjustments: Array<{
    field: "resolution" | "fps" | "durationSec";
    requested: unknown;
    applied: unknown;
    reason: string;
  }>;
};
```

### 6.5 外部模型映射

导演队列调用外部模型时统一提交：

```ts
type VideoGenReq = {
  // 现有其它字段省略
  resolution?: string;
  width?: number;
  height?: number;
  fps?: number;
  duration?: string;
};
```

各供应商适配器把这三项映射到真实协议。模型不支持某项时必须在预检中说明：

- 支持：原值提交；
- 只支持固定档位：提示并就近调整，或由严格模式阻断；
- 不支持 FPS：生成后在成片阶段补帧/转帧率，同时标明“模型未直接采用”；
- 不支持指定时长：显示模型实际时长档，不能假装已经传入。

自定义协议补充 `{{fps}}`，并和现有 `{{resolution}}`、`{{duration}}` 一起做协议体检。

### 6.6 ComfyUI 映射

ComfyUI 统一接收同一份解析结果：

```text
resolution → resolution / width + height / megapixels
fps        → fps / frame_rate
duration   → duration / duration_sec；若工作流只收帧数，则 frames = round(fps × duration)
```

建议模板暴露参数增加明确语义：

```ts
semantic?: "resolution" | "width" | "height" | "fps" | "duration" | "frames";
```

写入优先级为“显式语义绑定 > 已暴露参数名 > 安全的节点输入名兜底”。若时长需要换算帧数，必须使用本段最终 FPS；不能继续沿用模板内部另一个 FPS 值，否则成片时长会漂移。

### 6.7 统一规格 UI

导演台顶栏只显示三项默认值：

```text
[统一视频规格：1080p · 24fps · 默认15s ▾]
```

每张 H3 片段卡显示本段最终值和来源：

```text
规格  1920×1080 · 24fps · 12s
来源  分段 · 项目默认 · 分段
```

点击后可以查看“识别原文”，并对三项分别选择：

- 使用分段识别值；
- 改为手动值；
- 恢复项目默认值。

导入或重新扫描时，如果分段规格发生变化，只标记“检测到变化”，由用户确认应用；已经手动修改或锁定的规格不能被覆盖。

### 6.8 预检和 Take 快照

批量生成前逐段检查：

- 三项是否都有最终值；
- 当前外部模型或 ComfyUI 模板是否能接收；
- 分辨率是否被降档；
- FPS 是否直接生成、工作流补帧，还是仅在交付阶段转换；
- 时长是否被模型能力钳制；
- ComfyUI 的帧数是否和 `fps × duration` 一致。

Take 保存：

```ts
requestedVideoSpec: Required<VideoSpecValues>;
appliedVideoSpec: Required<VideoSpecValues>;
videoSpecSources: ResolvedVideoSpec["source"];
videoSpecAdjustments: ResolvedVideoSpec["adjustments"];
```

这样才能追溯每个 Take 的分辨率、帧率、时长来自分段还是项目默认，以及引擎实际采用了什么值。

---

## 7. 项目切换的完整行为

切换剧本项目时必须一次性完成：

1. 等待当前同步写入完成；
2. 若有在途任务，提示“继续后台运行 / 停止后切换”；
3. 切换 `activeProjectId`；
4. 加载项目 workspace manifest；
5. 校验根目录、主剧本和内容指纹；
6. 恢复该项目上次工位、选中片段和面板状态；
7. 角色库、H3、MV、成片、3D、任务、资产筛选全部使用新 `projectId`；
8. 清除不属于新项目的 `segId/characterId/mvId`；
9. 不自动把旧项目资产加入新项目；
10. 后台任务结果仍按其原 `projectId` 写回原项目。

如果根目录外部内容发生变化，先显示重扫差异，不能在切换时静默覆盖数据库。

---

## 8. 数据迁移

`DIRECTOR_SCHEMA_VERSION` 建议从 3 升到 4，并增加显式迁移。

### 8.1 现有多个剧本文档

当前一个项目可能有多个完全不同的 `ScriptDocument`。迁移时不能自动拆分并搬资产，因为无法可靠判断哪些角色/Take 属于哪个剧本。

提供迁移向导：

```text
当前项目包含 3 个剧本文档：
○ 保留“倩女幽魂”为主剧本，其余作为版本/资料
○ 将每个剧本拆成独立项目（资产暂留原项目，之后手动认领）
○ 稍后处理
```

默认主剧本优先级：

1. `primaryScriptId`；
2. 当前 `studioUi.scriptId`；
3. 状态为 official 的最新文档；
4. 第一份文档。

### 8.2 现有资产

- 已有 `asset.director.projectId` 的资产直接归入对应项目逻辑资产库；
- 没有项目标记的资产继续留在全局资产库；
- 首次绑定项目目录时只显示“复制/链接预演”，不自动移动原文件；
- 内容指纹相同的资产只建立新绑定，不重复复制，除非用户要求项目自包含。

### 8.3 现有 H3 提示词

- `promptFinalOverride` 迁移为已锁定英文执行稿；
- H3 格式 `promptOverride` 迁移为英文执行草稿；
- `locked` 只迁移为结构锁，不等于英文最终锁；
- 尝试从旧 H3 正文确定性提取标题、Purpose、Dialogue、Continuity；
- 无法解析的内容原文保留，标记“待生成中文审阅稿”。

### 8.4 现有视频规格

迁移优先级：

```text
resolutionMP 换算的分辨率
ruleSet.generation.resolution
ruleSet.generation.fps
segment.durationSec
```

迁移后立即对每个旧分段原文重新运行三项规格识别。发现分段识别值与旧项目默认值冲突时，在预演中逐项显示，不静默选一个。

---

## 9. 推荐代码落点

### 9.1 类型与迁移

- `src/core/types.ts`
  - `DirectorWorkspaceBinding`
  - `VideoSpecValues / VideoSpecDefaults / SegmentVideoSpec / ResolvedVideoSpec`
  - `H3BilingualPrompt / SegmentLocks`
  - `DirectorProject.workspace/primaryScriptId/videoSpecDefaults`
  - `DirectorSegment.h3Prompt/locks/videoSpec`
- `src/core/directorMigration.ts`
  - v3 → v4 显式迁移

### 9.2 项目与文件夹

建议新增：

- `src/core/studio/projectWorkspace.ts`
  - 绑定、解除、校验项目根目录
  - manifest 读写
  - 路径安全和原子保存
- `src/core/studio/projectIndexer.ts`
  - 确定性扫描和分类
  - 双语文件配对
  - 变更预演
- `src/core/studio/projectAssetRouter.ts`
  - 所有项目产物统一落盘

Rust/Tauri 只提供安全、可取消的文件系统原语，不把业务分类写进 Rust。

### 9.3 H3 双语

建议新增：

- `src/core/studio/h3Bilingual.ts`
  - H3 元数据解析
  - 中英文配对与验证
  - 旧提示词迁移
  - 双语同步状态
- 修改 `src/core/directorEngine.ts`
  - `importPromptSegments` 不再丢 Dialogue/Continuity 元数据
  - `refineSegmentPrompts` 写 `h3Prompt`，按锁规则回写结构字段
- 修改 `src/modules/studio/h3/H3Station.tsx`
  - 中文/英文/对照/实际请求四视图
  - 分离结构锁和执行稿锁

### 9.4 统一视频规格

建议新增：

- `src/core/studio/videoSpec.ts`
  - `resolveVideoSpec`
  - 分辨率、帧率、时长归一化
  - 能力校验与逐项规格降级
- 修改 `src/core/scriptInspect.ts`
  - 分段标题、元数据和正文的三项规格识别
  - 保存命中原文与行号
- 修改 `src/core/directorEngine.ts`
  - `importPromptSegments` 把识别结果写进片段，不再只识别标题时长
- 修改 `src/core/directorPrecheck.ts`
  - 每段规格预检
- 修改 `src/core/directorQueue.ts`
  - 两通道只消费 `ResolvedVideoSpec`
- 修改 `src/core/services/videoGen.ts`
  - 扩充分辨率、FPS、时长统一请求字段
- 修改 `src/core/services/videoAdapters.ts`
  - 各官方协议映射
- 修改 `src/core/services/comfy.ts`
  - resolution/fps/duration/frames 语义写入与应用报告
- 修改 `DirectorTake`
  - 保存请求规格和实际规格快照

### 9.5 项目切换 UI

- `src/core/stores/uiStore.ts`
  - 新增 `directorProjectId`，不能只保存 `directorNodeId`
- `src/modules/director/DirectorStudio.tsx`
  - 按 projectId 打开
  - 顶栏项目选择和目录状态
- `src/modules/studio/scripts/ScriptLibraryStation.tsx`
  - 导入时区分“新项目/新版本/追加”
- `src/modules/assets/AssetLibrary.tsx`
  - 项目资产视图默认按 activeProjectId 过滤

---

## 10. 实施顺序

### P0：先修项目隔离

1. 引入 `directorProjectId/activeProjectId`；
2. 导演台按 `projectId` 打开；
3. 新剧本默认新建项目；
4. 切换项目同步切换所有工位；
5. 处理重复 nodeId 项目和旧项目迁移。

没有完成 P0 之前，不建议继续扩展剧本库自动化，否则新功能仍会把数据写进错误项目。

### P1：统一视频规格

1. 新增三项规格类型与 `ResolvedVideoSpec`；
2. 恢复分段标题、元数据、正文中的分辨率/FPS/时长识别；
3. 顶栏提供三项项目默认值，片段卡显示识别值和来源；
4. directorQueue 双通道统一消费；
5. 外部适配器补分辨率、FPS、时长映射；
6. ComfyUI 补 resolution/fps/duration/frames 语义写入；
7. Take 保存请求值、实际值和来源。

### P2：项目文件夹与资产落盘

1. 绑定目录与 manifest；
2. 扫描预演；
3. 项目资产路由；
4. 所有导演台产物改走统一路由；
5. 目录变更检测和重扫。

### P3：H3 双语与字段回填

1. 双语数据模型；
2. 成品包元数据解析；
3. 中英文文件配对；
4. Skill 精炼结构化写回；
5. 四视图和锁状态；
6. Take 双语与 Skill 快照。

### P4：自动化闭环

1. 文件夹监听；
2. 角色/资产候选自动分发；
3. 双语同步提案；
4. 项目包增量导出；
5. 恢复、冲突与失败重试。

---

## 11. 验收用例

### 11.1 项目隔离

1. 创建剧本 A，导入 A 的 3 个角色和 12 个片段。
2. 创建剧本 B，导入 B 的 2 个角色和 8 个片段。
3. 切换到 A：只看到 A 的角色、H3 片段、Take、MV、时间线和资产。
4. 切换到 B：只看到 B 的对应内容。
5. B 生成完成时即使当前正在查看 A，结果仍写回 B。

### 11.2 文件夹绑定

1. 选择含完整 H3 项目包的目录。
2. 软件识别完整剧本、双语汇总稿、资产册和分段目录。
3. 确认预演后自动建立项目。
4. 角色、场景、道具、音频和分段参考进入正确位置。
5. 生成第 03 段后，Take 物理文件出现在 `分段资产库/03_标题/Takes/`。
6. 重启软件后仍恢复同一目录，不创建重复项目。

### 11.3 H3 双语

1. 导入 12 段中文稿和 12 段英文稿，软件成功一一配对。
2. 每段摘要、时长、对白、接力进入、结束状态、空间锁均显示。
3. 中文审阅稿与英文执行稿可左右对照。
4. 中文修改后状态显示 `zh-newer`，不静默覆盖英文。
5. 英文执行稿锁定后，Skill 重跑只能形成提案，不能覆盖。
6. 实际请求中的参考编号与真实槽序一致。

### 11.4 统一视频规格

项目规格设为：

```text
1080p · 24fps · 默认 15s
```

验收：

1. 第 01 段标题写 `12秒｜720p｜30fps`，软件识别为本段三项规格。
2. 第 02 段只写 `时长：10秒`，其分辨率和帧率继承项目的 1080p、24fps。
3. 中英文分段分别写出冲突规格时，导入预演明确提示，不静默覆盖。
4. 远程模型请求收到该分段解析后的分辨率、FPS、时长；不支持项明确显示实际处理方式。
5. ComfyUI 工作流收到对应分辨率、FPS、时长；只收帧数的模板得到 `fps × duration`。
6. 模板不支持 24fps 时，UI 明确显示模型实际 FPS 与后续转换策略。
7. 配方只支持 720p 时，显示 1080p → 720p 调整或阻断。
8. Take 卡能查看 requested/applied 两份规格以及三项来源。

### 11.5 安全与异常

1. 项目目录暂时离线时不清空项目数据。
2. 外部文件改变时只提示重扫，不自动覆盖锁定稿。
3. 未分类素材不会被错误绑定到角色或片段。
4. 删除项目只移除索引；删除物理目录必须单独确认。
5. 路径拼接拒绝绝对子路径和 `..` 穿越。
6. 同名目录不是 MOMO 项目时绝不递归删除或覆盖。

---

## 12. 明确不要这样修

- 不要只在 `ScriptDocument` 上加 `characterIds/segmentIds`，继续共用一个大项目。
- 不要只在 H3 页面根据 `scriptId` 过滤，其他工位仍不隔离。
- 不要扫描目录后未经预演直接覆盖项目。
- 不要把中文翻译稿发送给 H3，英文执行稿才是模型请求真相。
- 不要把结构锁、中文锁、英文最终锁继续合成一个 `locked`。
- 不要让 Skill 指令全文直接拼进视频模型 prompt。
- 不要把统一视频规格扩张成画幅、音频、Seed、质量档等大杂烩；本功能只有分辨率、帧率、时长。
- 不要把项目 FPS 显示成外部模型已按该 FPS 生成，除非适配器确实提交并被接受。
- 不要只给 ComfyUI 写规格而忘记外部模型，或反过来。
- 不要在各适配器里分别决定默认规格；默认值只来自 `resolveVideoSpec`。
- 不要在多个工位重复放一套分辨率/FPS/时长控件。
- 不要只识别分段标题中的时长；分段标题、元数据、正文中的三项都要识别并保留来源。

---

## 13. 可直接交给开发模型的任务摘要

> 将 MOMO 导演台改造为“一个独立剧本对应一个 DirectorProject 和一个可选项目根目录”。切换剧本必须切换整个 projectId，使角色、场景、H3 片段、参考槽、Take、AI 制图、MV、时间线、Skill、配方和资产天然隔离。剧本库内部只管理同一故事的版本；导入不同故事时默认创建新项目。
>
> 为 DirectorProject 新增 workspace、primaryScriptId 和统一视频规格默认值；为 DirectorSegment 新增 H3 双语提示词、分离锁状态和分段识别规格。实现项目目录确定性扫描、变更预演、双语文件配对、资产分类与统一物理输出路由。所有导演台生成物必须按 projectId/segmentId 写入绑定目录；未绑定目录时明确使用 AppData 托管模式。
>
> 改造 H3 导入和 Skill 精炼：不得只写 promptOverride。需要解析/生成中文审阅稿、英文执行稿、对白、连续性进入/结束、空间锁、参考顺序和镜头元数据；英文执行稿是模型请求真相，中文只用于审阅。结构锁、中文锁、英文最终锁必须分离，锁定内容不得被 AI 静默覆盖。
>
> 统一视频规格严格限定为分辨率、帧率、时长。恢复 1.0 的分段识别能力：从每个分段的标题、显式元数据和正文中确定性提取这三项并保存原文来源；分段明确值优先，项目设置只作默认兜底。新增 resolveVideoSpec 中间层，外部模型和 ComfyUI 都只消费解析结果；ComfyUI 需要支持 duration/fps/resolution，并在必要时用 fps×duration 换算帧数。Take 必须保存 requested/applied 规格、来源和调整原因。
>
> 必须增加 v3→v4 迁移、项目隔离测试、双语配对测试、目录扫描测试，以及外部模型/ComfyUI 双通道规格一致性测试。不得删除或覆盖用户现有项目、资产、Take 和锁定提示词。

---

## 14. 最终产品判断

这次改造完成后，导演台的自动化才真正成立：

```text
选择剧本项目
→ 锁定并扫描项目目录
→ 识别主剧本、双语稿、角色与全部素材
→ 自动建立该项目独有的角色库和 H3 片段
→ 按真实目录与段号绑定参考
→ 使用中文审阅、英文执行
→ 统一视频规格解析
→ 发送到外部模型或 ComfyUI
→ 结果回写本项目、本片段和本文件夹
→ Take、接力、音频、成片全程可追溯
```

这比在当前共享项目里继续补 `scriptId` 过滤更可靠，也更符合用户对“一个剧本就是一套完整制作工程”的直觉。
