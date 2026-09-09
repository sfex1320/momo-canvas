# MOMO 导演台 3.3：双通道生成体系与 Skill 编排补全方案

> 文档状态：导演台 3.2 的生成体系专项补全方案  
> 规划日期：2026-08-29  
> 适用范围：导演台视频生产链、项目 Skill、提示词编译、远程 Provider、本地 ComfyUI  
> 核心原则：一个制片链、两类执行通道、多种模型配方；不为每个模型再造一个导演台

---

## 0. 结论先行

用户提出的两类生成方向可以全部纳入导演台，但不能继续使用当前“本地/远程 + 模型名关键词”的粗粒度路由。

正确结构是：

```text
同一个导演项目与片段真相
        ↓
模型无关的片段执行意图
        ↓
能力解析器选择可用模式与素材组合
        ↓
Skill 流水线按阶段生成目标提示词
        ↓
┌──────────────────────┬──────────────────────┐
│ 本地工作流            │ 外调第三方 API        │
│ MiniMax H3 / LTX 等  │ Seedance / Wan /     │
│ ComfyUI 配方          │ Google / 其他 Provider│
└──────────────────────┴──────────────────────┘
        ↓
统一任务、Take、资产、质检、连续性与成片
```

导演台不增加新的剧本、角色、资产或后期子系统。需要补的是三层基础设施：

1. **模型能力档案**：模型能接什么素材、支持什么任务、时长和分辨率边界是什么；
2. **协议适配器**：把统一请求准确翻译成火山方舟、DashScope、Gemini/Veo、自定义协议或 ComfyUI 工作流；
3. **Skill 编排器**：把“项目规划”“片段写作”“模型适配”“结果校验”分阶段执行，禁止把 Skill 全文直接拼到最终提示词后面。

---

## 1. 本次核查范围

本方案基于以下真实对象交叉核查：

- 当前导演台核心代码：配方、参考槽、批量队列、提示词编译、Skill 路由和远程视频服务；
- 当前 AppData 中的导演项目、ComfyUI 模板、模型配置和已安装 Skill；
- 已同步的 `剧本拆分MiniMax H3` 与 `minimax-h3-prompt`；
- 本地 `h3-script-package` 和 `h3-prompt-writing` Skill 的完整规则；
- MiniMax H3、LTX、Google、火山方舟和阿里云 Model Studio 的当前官方能力说明。

这里区分三种状态：

| 状态 | 含义 |
| --- | --- |
| 已贯通 | UI、数据、执行请求和结果回流都真实可用 |
| 半贯通 | 有数据结构或 UI，但请求没有完整送达模型 |
| 仅声明 | 代码里有模型名或参数说明，不等于已经实现官方 API |

---

## 2. 当前真实现状

### 2.1 已经做得较完整的部分

本地 H3 不是从零开始，以下能力已经有较好的基础：

- 片段、参考槽、配方、Take、采用版本和批量任务已形成统一项目链；
- 图片、视频、音频三类参考素材可以按槽序送入 ComfyUI；
- `<Picture N>/<Video N>/<Audio N>` 编号与真实槽序已有统一逻辑；
- 首帧、尾帧、普通参考图具有语义区分；
- 相邻已采用/最近成功 Take 可以抽稳定尾帧，并按需截取末尾两秒作为空间接力；
- `opening / continuity_relay / hard_cut` 已能阻止硬切片段错误继承上一段素材；
- 本地工作流支持停止、清队列、清显存、细粒度进度、失败重试和 Take 快照；
- ComfyUI 的图、视、音输入、提示词、画幅、百万像素和时长已经有统一投喂路径；
- 生成结果进入统一 AssetStore，成片检查可继续消费。

这些能力应保留，不能因接入远程模型再重做第二套。

### 2.2 当前 Skill 的实际安装与绑定状态

当前软件已安装两份用户 Skill：

| Skill | 当前 contexts | 当前 phase | 实际职能 |
| --- | --- | --- | --- |
| `剧本拆分MiniMax H3` | `director.project` | `authoring` | 剧本切段、片段标题、时长与接力规划 |
| `minimax-h3-prompt` | `prompt.text`, `director.project` | `authoring` | H3/Ref2VA 提示词结构与参考编号规则 |

当前持久化项目中，只有一个项目绑定了“剧本拆分”Skill；提示词 Skill 虽已安装，但没有看到同项目有效绑定。也就是说：**安装成功不等于已进入项目执行栈**。

更重要的是，这两份 Skill 目前都处于 `authoring`，并且都挂在 `director.project`。系统难以判断当前是在：

- 拆剧本；
- 精读片段；
- 生成 H3 最终提示词；
- 给远程模型改写提示词；
- 校验最终输出。

因此容易出现“拆分 Skill 和提示词 Skill 同时被塞进一轮请求”的互相污染。

### 2.3 当前 ComfyUI 与配方现状

当前模板库中可见：

- `MiniMax H3文生图`；
- `MiniMax H3`；
- 若干图片生成、放大和编辑模板；
- 暂未看到 LTX 视频模板。

当前配方自动识别还有一个严重误判：`添加 H3 配方` 会把所有名称命中 H3 的模板都创建成视频配方，并根据是否为 R2V 决定 `r2v/fl2v`。因此 `MiniMax H3文生图` 也可能被标成 `output=video + mode=fl2v`。

这说明现在的配方能力主要来自名称猜测和固定默认值，而不是模板真实能力。

### 2.4 当前远程通道只是“通用视频任务壳”

现有远程视频服务支持四类协议入口：

- 智谱风格；
- SiliconFlow 风格；
- OpenAI 风格；
- 用户自定义协议。

模型家族表虽然包含 Veo、Seedance、Wan、Kling 等名称和 UI 参数，但家族识别大部分只影响时长、比例和通用字段。它并不等于已经实现：

- 火山方舟 Seedance 的 `content[]` 多模态角色与任务接口；
- 阿里云 Wan 的 `input.media[]`、`driving_audio`、`first_clip` 和区域化异步任务；
- Google Gemini Omni / Veo 的官方生成、编辑、延展和引用对象；
- 各家不同的任务取消、尾帧返回、费用信息和安全错误结构。

因此当前在设置中填一个 `seedance`、`wan` 或 `veo` 模型名，最多会触发对应 UI 元数据，不能视为官方协议已经贯通。

### 2.5 远程导演队列丢失的素材

导演台执行远程视频时目前实际发送：

- prompt；
- aspect；
- duration；
- first frame；
- last frame；
- reference images。

但没有从导演片段贯通：

- reference videos；
- reference audios / driving audio；
- native audio 开关；
- video continuation 的输入视频；
- 编辑任务的源视频和遮罩/区间；
- 模型专属 negative prompt、seed、prompt extend、watermark 等参数。

`VideoGenReq` 虽已有 `video/refAudio/audio` 字段，但导演队列没有完整传入，通用协议也没有为各家准确转换。这属于典型的“类型已预留、功能未闭环”。

### 2.6 H3 提示词当前被错误统一成六段式

当前 `refineSegmentPrompts` 使用固定的 H3 六段式合同：

```text
subject_definitions
summary
retention_analysis
detailed_description
overall_soundscape
non_diegetic_music
```

但 H3 Skill 的真实规则是：

| H3 模式 | 正确结构 |
| --- | --- |
| T2VA 文生音视频 | 基础三段式，无参考对齐指令 |
| I2VA 首帧音视频 | 基础三段式 + 首帧严格对齐 |
| FL2VA 首尾帧音视频 | 基础三段式 + 首尾帧对齐 + 结尾精确时间点 |
| L2VA 仅尾帧音视频 | 基础三段式 + 尾帧对齐 |
| Ref2VA 全参考音视频 | 六段式 + subject/summary/retention + 图视音编号 |

六段式只适合 Ref2VA，不应覆盖所有 H3 模式。当前配方类型里也没有 `l2v`，所以“仅尾帧反推”无法被准确表达。

### 2.7 时长规则存在冲突

已同步的两份 Skill 使用过 `4–18 秒`；H3 项目包和提示词规则以单段不超过 15 秒为硬边界；MiniMax 官方当前也说明 H3 最高 15 秒。

导演台应把时长视为模型能力，而不是写死在 Skill 文字里：

- H3：按当前模型/工作流上限，默认不超过 15 秒；
- Seedance 2.0：当前官方 API 为整数 4–15 秒；
- Wan 2.7：当前官方 API 为整数 2–15 秒；
- LTX：由具体模板、帧数、显存与模型版本决定；
- Google：由具体模型和任务类型决定。

Skill 只表达“遵守能力档案”，不重复维护数字。

---

## 3. 目标产品结构：一个生成工位，两条执行通道

不增加新一级页面。现有 H3 主工位升级为“视频生成工位”，仍保留 H3 作为本地主力，但可选择两类通道：

```text
视频生成
├─ 本地工作流
│  ├─ MiniMax H3 · T2VA / I2VA / FL2VA / L2VA / Ref2VA
│  ├─ LTX · T2V / I2V / Audio2V / 多关键帧 / 延展 / V2V
│  └─ 其他 ComfyUI 视频模板
└─ 外调 API
   ├─ Seedance 2.0
   ├─ Wan 2.7
   ├─ Google Gemini Omni Flash
   ├─ Google Veo 3.1
   └─ 其他 Provider / 自定义协议
```

页面仍然只维护一套：

- 片段列表；
- 参考槽；
- 最终提示词；
- 配方选择；
- 批量范围；
- Take 和采用版本；
- 进度、停止、重试；
- 连续性与成片回流。

切换配方只改变“当前模型可以使用哪些槽、提示词如何编译、请求如何发送”，不复制片段和素材。

### 3.1 与创作助手、AI 导演的边界

| 产品 | 主管职能 | 是否批量 | 是否管理项目连续性 | 是否直接执行 |
| --- | --- | --- | --- | --- |
| 创作助手 | 聊清单次方案，快捷出图/出片 | 否 | 否 | 经确认闸后执行单次任务 |
| AI 导演 | 项目诊断、提案、试跑计划和模型选择建议 | 产出计划 | 是 | 不直接生成 |
| 视频生成工位 | 片段配方、参考、提示词、批量 Take | 是 | 执行接力与回流 | 是 |

AI 导演可以建议“03–05 用本地 H3 Ref2VA，06 用 Veo 延展，07 用 Wan 首尾帧”，但真正的槽位、参数、费用确认和执行仍在视频生成工位完成。

---

## 4. 模型无关的中间层

### 4.1 片段执行意图

导演台保存的主数据不应是某家最终 prompt，而应先形成模型无关结构：

```ts
type VideoGenerationIntent = {
  segmentId: string;
  purpose: "new-shot" | "continue" | "interpolate" | "edit" | "motion-transfer";
  durationSec: number;
  aspect: string;
  resolution: string;
  narrative: {
    subject: string;
    environment: string;
    action: string;
    camera: string;
    lighting: string;
    style: string;
    dialogue: string[];
    soundscape: string;
    music: string;
  };
  continuityMode: "opening" | "continuity_relay" | "hard_cut";
  references: DirectorSlotValue[];
};
```

H3、LTX、Seedance、Wan 和 Google 都从这份意图编译，不在项目里维护五份互相漂移的提示词真相。

### 4.2 完整任务模式

配方模式应补全为：

```text
t2v      文生视频
i2v      首帧图生视频
fl2v     首尾帧视频
l2v      仅尾帧反推
r2v      多参考生成
audio2v  音频驱动视频
extend   视频延展/接续
v2v      视频重绘/动作迁移
edit     多模态视频编辑
```

UI 不必永远展示九个按钮。只有能力档案命中的模式才出现在配方选择和参考槽中。

### 4.3 模型能力档案

新增统一 `VideoCapabilityProfile`，替代“从模型名猜参数 + 配方里手填快照”：

```ts
type VideoCapabilityProfile = {
  family: "h3" | "ltx" | "seedance" | "wan" | "gemini-omni" | "veo" | "generic";
  channel: "local" | "remote";
  modes: VideoMode[];
  inputs: {
    firstFrame: boolean;
    lastFrame: boolean;
    referenceImages: number;
    referenceVideos: number;
    referenceAudios: number;
    sourceVideo: boolean;
  };
  output: {
    nativeAudio: boolean;
    returnsLastFrame: boolean;
  };
  duration: { min: number; max: number; step?: number };
  resolutions: string[];
  aspects: string[];
  promptDialect: string;
  protocolAdapter: string;
};
```

能力来源按优先级：

1. ComfyUI 模板真实节点与暴露参数分析；
2. 官方 Provider 适配器内置档案；
3. 自定义协议声明的能力；
4. 用户手动覆盖；
5. 仅在以上都缺失时使用保守兜底。

模型名正则只负责推荐家族，不再作为最终真相。

---

## 5. 两份现有 H3 Skill 的正确拆分

### 5.1 `剧本拆分MiniMax H3`：项目规划 Skill

保留其核心价值，但调整职责：

```text
context: director.project
phase: analyze / authoring
purpose: script-plan
output: director-plan
```

它负责：

- 根据故事、场景、事件和时长规划片段；
- 每段只保留一个主场景、一个主要镜头路径和一条可执行动作链；
- 生成稳定片段 ID、标题、摘要、对白、镜头和时长建议；
- 明确 `opening / continuity_relay / hard_cut`；
- 规划段间接力，但不生成模型专属六段式 prompt；
- 时长从能力档案读取，不再写死 18 秒。

它不应参与最终生成请求。

### 5.2 `minimax-h3-prompt`：H3 模型适配 Skill

调整为：

```text
context: prompt.video, director.segment
phase: model-adapter
purpose: compile-video-prompt
family: h3
modes: t2v, i2v, fl2v, l2v, r2v
output: text
```

它负责：

- 根据配方模式选择 T2VA/I2VA/FL2VA/L2VA/Ref2VA 合同；
- 锁定 `<Picture N>/<Video N>/<Audio N>` 的真实运行顺序；
- 原语言对白与稳定 speaker ID；
- 镜头、时间、声音和音乐结构；
- Ref2VA 的 retention marker；
- 输出单个可直接执行的最终 prompt。

它不应参与剧本拆分，也不应作为一大段说明文字追加在普通提示词末尾。

### 5.3 需要补的 H3 项目包 Skill

现有拆分 Skill 还没有覆盖完整项目包。建议补一个独立的“项目交付规范”Skill：

```text
context: director.project
phase: validate
purpose: project-package
output: director-plan
```

它负责校验和导出：

```text
项目根目录/
├─ 完整剧本.md
├─ 全部素材/资产提示词.md
├─ 分段资产库/01_片段标题/...
├─ 分段剧本-中.md
└─ 分段剧本-英.md
```

并验证：

- 中英文执行稿一一对应；
- 每段 `<<<PROMPT_START>>>...<<<PROMPT_END>>>` 边界完整；
- 对白保持原语言；
- 资产编号稳定；
- 没有空占位目录和重复普通资产；
- 空间站位图在容量不足时正确降级成文字空间锁。

它只在“导出项目包/校验项目包”时运行，不进入每次生成。

---

## 6. 剩余模型如何纳入 Skill 体系

不建议为每个模型复制完整“导演 Skill”。使用一份公共片段写作 Skill，加薄模型适配 Skill。

### 6.1 公共视频片段写作 Skill

```text
context: director.segment
phase: authoring
family: all
```

只负责模型无关的：主体、场景、动作、镜头、光线、对白、声音、节奏、连续性和负向意图。

### 6.2 H3 适配 Skill

- 覆盖五种 H3 提示词方言；
- 支持全模态参考、原生双声道、2K 和 15 秒能力边界；
- 本地 ComfyUI 与未来官方/远程 H3 API可复用同一方言，协议适配器不同。

### 6.3 LTX 适配 Skill

LTX 不复用 H3 六段式。适配内容包括：

- T2V/I2V/Audio2V；
- 多关键帧和关键帧时间；
- 前向/后向视频延展；
- V2V/Retake/IC-LoRA 控制；
- LoRA 触发词与权重；
- 模板实际帧数、FPS、分辨率和显存约束；
- 原生音画联合描述。

LTX 的接入主体是 ComfyUI 模板能力分析，不需要开发独立 LTX 页面。

### 6.4 Seedance 适配 Skill

当前正式目标先写为 `Seedance 2.0`，覆盖：

- 文字、图片、音频、视频四模态关系描述；
- 4–15 秒整数时长；
- 原生同步音频；
- 参考素材角色和任务语义；
- 连续视频所需尾帧返回；
- 火山可信素材 `asset://` 与肖像授权错误的友好提示。

“Seedance 2.5”只作为未来模型别名预留，未从官方能力档案加载前不得硬编码参数。

### 6.5 Wan 适配 Skill

当前正式目标写为 `Wan 2.7`，覆盖：

- T2V；
- 首帧 I2V；
- 首尾帧 FL2V；
- `first_clip` 视频延展；
- `driving_audio` 音频驱动；
- 原生声音、自动配音或指定音频；
- 2–15 秒、720P/1080P；
- `prompt_extend`、水印和种子。

“Wan 3.0”作为未来家族版本预留，不把尚未确认的字段写进当前 UI。

### 6.6 Google 适配 Skill

Google 不应只保留一个模糊 `veo` 家族：

- **Gemini Omni Flash**：默认的多模态视频生成与多轮对话式视频编辑；
- **Veo 3.1**：原生音频、视频延展、首尾帧控制和传统生成管线。

两者共用 Google Provider，但能力档案和协议任务不同。AI 导演可以按任务推荐，执行工位只展示真实可用模式。

### 6.7 通用远程适配 Skill

给没有专用方言的中转站模型保留一个保守版本：

- 单段自然语言；
- 明确主体、动作、摄影机、光线、时长和声音；
- 不输出 `<Picture N>` 等模型未声明支持的语法；
- 不声称远程模型支持本地 H3 的六段式；
- 仅投喂能力档案确认支持的素材。

---

## 7. Skill 路由必须从“关键词”升级为“任务选择器”

当前 `scope=local/remote + modelPattern` 可以继续兼容旧数据，但不能承担最终路由。

建议给 Skill 增加可选选择器：

```ts
type SkillSelector = {
  purposes?: Array<"script-plan" | "segment-authoring" | "compile-video-prompt" | "project-package" | "validate">;
  channels?: Array<"local" | "remote">;
  families?: string[];
  modes?: VideoMode[];
  requiredInputs?: Array<"firstFrame" | "lastFrame" | "referenceImage" | "referenceVideo" | "referenceAudio" | "sourceVideo">;
};
```

一次生成的 Skill 管线固定为：

```text
analyze
  → authoring
  → model-adapter
  → validate
```

规则：

- 项目拆分 Skill 不进入片段生成；
- 同一轮只允许一个主 `model-adapter` 产出最终模型 prompt；
- validate 只能检查和报告，不能静默改写最终 prompt；
- Skill 输出必须作为阶段结果解析，禁止把 `instructions` 原文拼进最终 prompt；
- 每个 Take 保存实际 Skill 版本、选择器、变量和最终产物快照。

---

## 8. 官方协议适配层

### 8.1 不再依赖“OpenAI 兼容 + 多塞几个字段”

每个正式 Provider 适配器应实现统一接口：

```ts
interface VideoProviderAdapter {
  profile(model: string): VideoCapabilityProfile;
  validate(req: UnifiedVideoRequest): ValidationIssue[];
  submit(req: UnifiedVideoRequest, signal?: AbortSignal): Promise<RemoteTask>;
  poll(task: RemoteTask, signal?: AbortSignal): Promise<TaskProgress | TaskResult>;
  cancel?(task: RemoteTask): Promise<void>;
}
```

第一批适配器：

1. `volcArkSeedanceAdapter`；
2. `dashscopeWanAdapter`；
3. `googleVideoAdapter`，内部区分 Omni 与 Veo；
4. 现有 OpenAI/Sora 适配器；
5. `customProtocolAdapter`。

ComfyUI 作为本地 adapter，实现同一上层合同，但保留模板节点、显存和 WebSocket 进度特性。

### 8.2 自定义协议也要声明能力

当前自定义协议解决“怎么发请求”，但不知道“能做什么”。给协议增加可选 capability 声明：

- 支持模式；
- 图/视/音容量；
- 时长、画幅、分辨率；
- 是否原生音频；
- 是否能返回尾帧；
- 是否支持取消；
- 费用单位和预估字段。

没有声明时按最保守的 T2V/I2V 执行，不再默认开放所有槽位。

---

## 9. UI 改造：只改关键决策，不扩页面

### 9.1 顶部配方选择

配方下拉按两组展示：

```text
本地工作流
  MiniMax H3 · 全参考
  MiniMax H3 · 首尾帧
  LTX · 多关键帧

外调 API
  Seedance 2.0 · 多模态
  Wan 2.7 · 首尾帧
  Veo 3.1 · 延展
```

每项只显示四个最重要信息：

- 本地/远程；
- 任务模式；
- 最大时长；
- 是否音画同出。

不要在主页面展示所有 API 参数。

### 9.2 参考槽能力联动

选择配方后：

- 支持的槽正常显示；
- 不支持但已有素材的槽变灰并保留；
- 明确说明“该素材不会发送给当前配方”；
- 切回兼容配方后自动恢复；
- 不因切换模型删除资产或重排永久槽序。

### 9.3 最终提示词预览

预览弹窗增加三个只读标签：

- 通用导演稿；
- 目标模型方言；
- 实际请求预览。

用户编辑“最终稿”后继续保留整段直发能力，但系统应提示：切换模型后最终稿不会自动转译。用户可以选择“保留直发”或“按新模型重新编译”。

### 9.4 生成前检查

预检必须展示：

- 模型和通道；
- 模式识别结果；
- 实际投喂的图/视/音数量；
- 被忽略的槽；
- 时长和分辨率是否被裁剪；
- 本地显存风险或远程计费任务数；
- Skill 编译器和版本；
- 协议适配器。

这比再加一个“高级设置页”更有价值。

### 9.5 费用与停止语义

- 本地：显示预计显存档和队列数；停止可中断 ComfyUI；
- 远程：提交前显示任务数和可得的费用估算；
- 提交后若供应商支持取消则调用真实取消；
- 不支持取消时明确显示“只停止轮询和后续队列，已提交费用可能发生”。

---

## 10. 最小实施顺序

### P0：先修正错误，不增加功能

1. 把 H3 两份 Skill 的 context/phase 分开；
2. 把 H3 时长 18 秒统一改为读取能力档案，当前上限 15 秒；
3. 增加 H3 模式识别，六段式只用于 Ref2VA；
4. 新增 `l2v` 模式；
5. 修复 `MiniMax H3文生图` 被自动建成视频/首尾帧配方的问题；
6. 配方下拉显示“已贯通/仅声明”，避免用户误以为填模型名即可运行官方 API。

### P1：完成 Skill 编排闭环

1. 引入 purpose/selector；
2. 项目规划、片段写作、模型适配、校验分阶段；
3. 重写 `refineSegmentPrompts`，按当前配方模式选择合同；
4. 基础 H3 与 Ref2VA 使用不同解析/校验器；
5. Take 保存阶段产物与 Skill 快照；
6. 增加项目包导出校验 Skill。

### P2：完成远程能力真接入

按用户实际会用的顺序接入，不同时铺五家：

1. Seedance 2.0 火山方舟适配器；
2. Wan 2.7 DashScope 适配器；
3. Google Omni/Veo 适配器；
4. 导演队列贯通参考视频、参考音频、原生音频和延展输入；
5. 远程取消、尾帧回收、费用提示和供应商错误正规化。

### P3：补本地 LTX

1. 用户导入一个真实 LTX 模板；
2. 通过节点分析自动产生能力档案；
3. 只补模板暴露出来的模式和参数；
4. 增加 LTX 薄适配 Skill；
5. 复用现有 ComfyUI 队列、参考槽、Take、资产和显存机制。

没有真实模板前，不开发一套猜测性的 LTX 参数面板。

### P4：模型路由建议

最后才让 AI 导演根据任务、素材、质量、时长、成本和本地资源推荐配方。它只给建议和试跑计划，不自动切模型或发起计费任务。

---

## 11. 明确不做的过度开发

- 不为 Seedance、Wan、Google、LTX 各开发一套片段列表和资产区；
- 不在创作助手里复制导演项目、参考槽和批量 Take；
- 不让 AI 导演直接持有 Provider API 或 ComfyUI 执行权；
- 不为每个模型做一套永久数据结构；
- 不用模型名正则伪装成官方能力接入；
- 不把所有 Skill 指令全文拼进每一次最终提示词；
- 不在没有真实 LTX 模板时预造大量参数；
- 不把未来的 Seedance 2.5、Wan 3.0 参数提前写死；
- 不因当前配方不支持某个槽而删除用户素材；
- 不另建一套导演台资产库、角色卡或后期时间线。

---

## 12. 验收标准

### 12.1 H3

- T2VA/I2VA/FL2VA/L2VA/Ref2VA 能被独立识别；
- 只有 Ref2VA 使用六段式；
- 图/视/音编号与运行时槽序一致；
- 原语言对白和 speaker ID 稳定；
- 单段时长不超过当前 H3 能力档案；
- opening/hard_cut 不注入上一段接力素材；
- 最终 Take 可追溯到项目 Skill、提示词 Skill、模板和参数版本。

### 12.2 远程

- Seedance、Wan、Google 的官方适配器各自构造正确请求，不靠未知字段碰运气；
- 导演片段中的视频和音频参考可以真实送达支持它们的远程模型；
- 不支持的素材在预检中明确列出；
- 远程模型时长、分辨率和素材组合在提交前被验证；
- 用户能区分可取消任务与只能停止本地等待的任务；
- 未来模型版本通过更新能力档案和适配器接入，不改导演项目结构。

### 12.3 本地 LTX

- LTX 通过 ComfyUI 模板接入，不新增独立页面；
- 模式和参数来自真实模板分析；
- 多关键帧、音频、延展或 V2V 只在模板实际支持时开放；
- 继续复用 H3 已有批量、停止、清显存、Take 和资产链。

### 12.4 职能边界

- 创作助手仍是“聊方案 → 确认 → 单次出图/出片”；
- AI 导演负责诊断、模型建议和生产计划，不直接生成；
- 视频生成工位负责全部本地/远程片段执行；
- 角色卡、资产库、后期时间线仍以现有通用模块为唯一真相。

---

## 13. 最终定义

导演台的完整性不来自“页面越多”，而来自同一条制作链能够根据片段任务切换执行能力：

```text
项目规划 Skill
  → 模型无关片段意图
  → 目标模型 Prompt Skill
  → 本地或远程协议适配器
  → 统一 Take / 资产 / 连续性 / 后期
```

H3 应成为本地全模态制作能力的第一套完整实现，LTX 作为第二个本地模板家族接入；Seedance、Wan、Google 作为远程执行通道接入。它们共享导演项目和生产基础设施，但各自保留真实的能力档案、提示词方言和官方协议。

这样既能把未完成的模型覆盖进来，也不会再次制造与 MOMO 画布、创作助手、AI 导演、角色卡和资产库的职权重叠。

---

## 14. 当前能力基线来源

以下资料用于确认当前正式型号与能力边界；后续实现时仍应以接入当日的官方 API 文档为准：

- [MiniMax H3 官方发布说明](https://minimaxi.com/blog/minimax-h3)：全模态上下文、原生双声道、最高 15 秒 2K、V2V Motion Transfer；
- [Google Gemini API 视频生成说明](https://ai.google.dev/gemini-api/docs/video)：Gemini Omni Flash 与 Veo 3.1 的当前分工；
- [火山方舟视频生成 API](https://www.volcengine.com/docs/82379/1520758)：Seedance 正式任务接口与参数文档入口；
- [Wan 2.7 图生视频 API](https://www.alibabacloud.com/help/en/model-studio/image-to-video-general-api-reference)：首帧、首尾帧、音频驱动和视频延展；
- [LTX-Video 官方仓库](https://github.com/Lightricks/LTX-Video)：本地音画联合、多关键帧、延展、V2V、LoRA 与 ComfyUI 能力。
