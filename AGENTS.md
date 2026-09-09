# AGENTS.md

> **导演台方案基线（3.4 起）**：3.1 文档曾要求收缩七工位，3.2/3.3 已明确保留七工位——**以 3.2/3.3 及本文件的现状描述为准**，不要按 3.1 反向改造。旧方案文档与现状冲突时，先看代码再动手。


This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## 项目

MOMO 智能画布：Tauri 2 (Rust 壳) + React 19 + TypeScript + React Flow (@xyflow/react) + Zustand 的桌面 AI 创作工作站。单一画布范式——图片、提示词、生图、生视频、ComfyUI 工作流都是画布节点，连线即工作流；对话/Agent/语音收在右侧「创作助手」侧栏。UI 文案、代码注释、commit message 全部使用中文。

## 海报元素路线约束

用户已明确排除 Qwen-Image-Layered 及依赖该模型的封装路线，后续不再推荐或集成。目标是整图生成 → 元素识别与人工校准 → 精修蒙版 → 按需逐元素高清重绘 → 原位合成与分层导出。风格文字层当前仍是位图，「改字」是模型重绘，不等于原生字体编辑。图片编辑入口收敛为元素、高清、局部重绘、创意模板及整理工具；实验平面稿收进更多工具。图层组的 layerOutputScale 控制合成/PSD 倍率，默认旧组 1 倍、高清拆解新组 2 倍；layerGeometry/positionedLayer 为预览与 PSD 的统一位置规则。

## 常用命令

```bash
pnpm tauri dev      # 开发运行（Vite 固定端口 1430，被占用会直接失败；弹宠项目占用 1420）
npx tsc --noEmit    # 类型检查（最常用的验证手段；本项目无测试、无 lint 配置）
pnpm build          # tsc && vite build，仅前端产物，可作完整验证
pnpm tauri build    # 打包发行版 —— 仅在用户明确要求时执行
```

开发闭环：`.Codex/settings.json` 配置了 Stop hook（`.Codex/hooks/restart-app.ps1`），每轮结束时自动确保 dev 应用在跑（健康实例不会被杀，Vite HMR / tauri dev 自身热更新即可生效；日志在 `.Codex/dev-server.log`）。**不要手动启动 `pnpm tauri dev`**，改完代码结束回合即可看到效果。

## 架构（分层，依赖只向下）

```
src/core/types.ts       全部共享类型的唯一来源：节点 data、设置（含历次迁移的 Legacy 类型）、资产、ComfyUI 模板、快捷键
src/core/stores/        Zustand stores；React 外部一律用 useX.getState() 访问
src/core/services/      纯协议适配层：吃 ModelCard + 请求参数，吐结果，不碰 store
src/core/runner.ts      节点运行引擎：收集上游 → 调 service → 结果写回节点 + 收录资产库
src/core/agentEngine.ts 创作助手引擎：聊天（多轮 + 前情摘要压缩）与 Agent（JSON 动作协议循环）
src/core/capability/     能力层（统一执行信封）：注册表 + executeCapability + 统一预算闸 budget.ts + 内置能力 builtin.ts + MCP 适配器 mcp.ts；创作助手 tool 动作 / MCP 服务器工具共用这一个入口
src/core/voiceChat.ts   语音通话状态机：录音 VAD 断句 → ASR → 助手 → TTS → 自动续听（可插话打断）
src/core/modelMeta.ts   绘画家族参数推断 + 对话模型能力（vision / builtinSearch）
src/modules/            React UI（canvas / agent / assets / charlib / shell / settings / comfy）
src/ui/                 手绘 SVG 图标集 icons.tsx、轻组件 kit.tsx、ModelPicker、PopSelect/PopLayer、Thumb
src/styles/theme.css    三主题设计令牌（云白/深空蓝/深邃黑），样式只用 var(--token)
src-tauri/              Rust 壳：插件配置（dialog/fs/http/store/opener + asset 协议）+ 自定义命令（本地超分/矢量化/分层导出/本地 LLM/DPAPI/桌面快捷方式/sysmon 系统资源监控）
```

### 数据流转（读懂 runner.ts 即读懂本项目）

- **端口已统一**：任意输出可接任意输入，实际传什么由源节点的 `outPortType` 决定；连线只拦重复边与成环（`wouldCycle`，已含组成员隐式边）。
- `collectUpstream(nodeId)` 递归收集直接前驱的输出；防环用**当前 DFS 路径**（进入 add、返回 delete），不是全局已访问集——同一上游被两条路径引用是正常拓扑。
- 组节点按成员位置排序聚合；`data.ignored` 的节点不向下游传递；角色卡按勾选素材展开多图（`collectImageRefsFor` 与 `collectUpstream` 必须同序，否则 @图N 编号错位）。
- 生成节点提示词留空时自动取上游文本；连了上游图片自动转图生图。
- 节点上的「生成/运行」按钮统一走 `runFlow(id)`：DFS 后序把上游可运行节点按依赖顺序先跑一遍再跑自己；`runAllFlows()` 按连通分量并行、分量内串行。可自动运行的节点类型登记在 `RUNNERS` 表。

### 模型配置（改动设置结构必看）

- `ProviderCard`（服务商卡片）：一个 Base URL + API Key，含 **chat / image / video / audio / asr 五个** `RoleSlot`，每槽 `models: string[]` 多模型。
- 节点/默认选模用复合键 **`providerId::model`**（`modelKey` / `splitModelKey`），旧数据可能只有 providerId。
- 服务层只消费扁平化的 `ModelCard`，入口是 `resolveModelCard(role, key?)`：节点指定 > 角色默认 > 第一家可用，无可用时抛中文提示。
- 设置结构已历经 v1→v2→v3→v4 迁移（Legacy 类型都在 types.ts）。**改 Settings 结构必须同步加迁移**，加载路径是 settingsStore 的 `normalize()`。
- `modelMeta.ts` 按模型名推断生图「家族」（banana / gpt / seedream / flux / qwen / kolors / generic），决定 GenConfigPanel 展示哪组参数、runner 发哪些字段。
  - ⚠️ 家族判定**只看模型名**，中转站以 OpenAI 兼容协议提供 nano-banana / gemini-image 很常见：此时 `aspect`/`resolution` 只有原生 gemini 分支会读，`imageGen.genOpenAI` 里必须把 aspect 折算成 `size`，否则一律回落 1024×1024 出方图。
  - `chatCaps(card)` 推断对话模型的**视觉输入**与**自带联网**能力；`builtinSearchTools(model)` 产出各家 tools 请求体，两者必须一致（自带联网以能否真的构造出 tools 为准）。

### 新增节点类型的完整清单

1. `types.ts`：加 `NodeKind` 成员 + `XxxData` 类型（必含 `status` / `error`）
2. `boardStore.ts`：`defaultData` / `outPortType` / `NODE_INPUTS` / `NODE_LABEL`
3. `nodeCatalog.tsx`：加入 `NODE_CATALOG`（添加坞/快速菜单共用）
4. `nodes/XxxNode.tsx`：用 `NodeShell` 包裹、`memo` 导出，在 `SmartCanvas.tsx` 的 nodeTypes 注册
5. 可运行的：`runner.ts` 加 `runXxx` 并登记进 `RUNNERS`

### 生成协议链路（protoPresets / customProto）——自定义协议功能已移除

声明式协议跑「模板渲染 → 提交 → 可选轮询 → 路径取结果」。**3.6 起协议只来自内置预设**（设置里的「协议」页、协议助手、校准、自愈、报错中心协议修复全部删除，`protoCalibrate/protoSelfHeal/protoSpec/protoTabStore/ProtocolTab` 已不存在）：

- **唯一协议来源 `core/protoPresets.ts`**：65535 生图 / APIMart 生图 / APIMart 生视频（站点接口有变化改这里）；执行器仍是 `services/customProto.ts`（图片/视频/音频共用），槽位协议标识维持 `custom:<id>`。
- **绑定与对账在 `settingsStore.syncPresetProtocols`**（每次加载/导入配置幂等跑）：①协议名精简（历史括号/「·修正版」标注剥掉，认得的旧名换「中转站+用途」简名）；②同名旧协议收敛到 `preset-<key>` 确定性 id；③只留仍被槽位引用的协议，孤儿清除；④`preset-*` 条目内容强制刷新为当前预设；⑤baseUrl 命中 `hostMatch` 且槽位还走内置协议的服务商自动换绑（已绑任何 `custom:` 协议的不动，如 Grsai 历史协议）。
- **xfetch 默认 90 秒超时**（`services/http.ts`，`opts.timeoutMs` 可调/置 null 关闭）：没有这层兜底时挂起连接（跨境代理不回包）会让生成节点永久「生成中」；超时错误是中文「请求超时」——不含「取消/abort」字样（不会误判用户停止），且计入 `isTransientError` 可重试。已付费结果下载放宽：图片 5 分钟、视频 10 分钟。
- 轮询循环的宽容兜底（状态路径/完成取值/结果字段多重兜底、status_url 替补切换、连续空状态切轮询地址）都在 `runCustomFlow`，别拆。

### 导演台 / ComfyUI 模板 / Skill

- 导演台五页：剧本（三态导入）→ 分镜（预处理中心）→ 生成 → 成片检查 → 3D。核心在 `src/core/director*.ts` + `src/modules/director/`。3D 页（ds3d.css）的 `--d3-*` 令牌已映射全局主题（面板/文字/悬停/accent 都走 var(--token)），3D 视口本身与直悬画布的覆盖层（名牌/取景框/轴向球）保持深色；轴向 XYZ 色与实体色板 PALETTE 属 3D 数据色，不接主题。批量开关（清显存/尾帧接力）走共享组件 `BatchSwitches`，确认卡片走 `AskCard`，别再加第三份。
- **剧本三态导入**（`directorEngine.detectScriptKind`）：完整剧本走 `splitScript`（LLM）；已分段分镜脚本走 `structuredSplit`；成品分段提示词包走 `importPromptSegments` 直录——**通用结构 = 定调前言 + 片段标题 + 片段内容/围栏提示词块**（首选显式围栏 `<<<PROMPT_START>>>…<<<PROMPT_END>>>`（一对即一段，遮罩/计数/切段全链路最优先）；启发式后备：`## H3-XX` 头、`subject_definitions:`、带围栏块的 ## 小节、或「序号-标题-时长」裸标题行（`01-古刹闻客-11秒`，配 `# 第X分段` 中文数字序号头也认）的无围栏包都认；风格/定调类小节不作片段起点）。全文进 `promptOverride` 并标 `locked`，认全角｜与「12 秒」中文单位、剥代码围栏与段尾 ---；裸标题行只认 1-3 位数字前缀防误吞年份。前言主标题作场景名，「风格/定调」小节提取进 `ruleSet.positive.style`，无小节无围栏时逐行筛（故事概述/总分段数/总时长等元信息行不进风格）（H3 成品路径由 `compileSegmentPrompt` 拼在每段提示词前；编译路径由 `compilePrompt` 自己消费，不重复）。`splitScript` 第四参 `skillSystem` 可注入项目绑定 Skill 作拆分补充规范——「拆分能力」就靠它做成 Skill 扩展。规则切段（检测分段）产物的原文存 `segment.scriptText`，用 `analyzeSegmentsWithLLM` 逐段精读提取摘要/时长/对白/镜头（跳过 locked 与已有内容的段）。
- **Skill 精炼**：`refineSegmentPrompts` 用项目绑定的 Skill（如 MiniMax H3 Prompt）作 system + 参考槽顺序逐段产出 H3 成品提示词；Ref2VA 最终正文严格只含官方六段，第一行 `subject_definitions:`，不得先放 Purpose/Characters/Reference image order 私有前言。`<Subject N>` 与 `(S1)` 都是每段局部连续编号，图片槽 `<Picture 1..N>` 来自本次真实上传且最多9张。`promptOverride` 通过 `isOfficialH3Prompt` 时 `compileSegmentPrompt` 原样直发，不再拼项目风格、Skill 或负向词；运行时槽位/降级说明只注入 `detailed_description`，不得破坏六段结构。
- **参考槽三类**（`directorRefs.ts`）：`syncRefSlots` 同步上游图/视/音三类；手动添加的槽位必须 `auto:false`（同步对账只清自动槽，旧数据缺省视为自动）。`resolveSlotMedia` 返回图/视/音有序列表，**槽序即 `<Picture N>/<Video N>/<Audio N>` 编号序**；`refsNoteFromSnapshot` 的编号必须与其严格一致。
- **空间接力包**（`directorQueue.ts`）：`runBatch` 在每段执行前只读取故事顺序中紧邻的上一段，优先采用Take、否则最新成功Take；从结尾前约0.25秒抽稳定桥接帧，Comfy R2V有空余视频槽时再用 `trimVideo` 截末尾2秒。`fillRelaySlots` 把真实素材收录资产库并追加到下一段 `referenceImage/referenceVideo` 槽，写 `relayKind/relaySourceTakeId` 防重复截取；关闭开关时槽位和资产保留但 `directorRefs.effectiveSlots` 不投喂。执行层 `withRelayFrame` 默认保持追加的Picture位，有首帧入口且无人工首帧时提升为 `firstFrame`；`refsNoteFromSnapshot` 按真实槽序注入对应 `<Picture N>/<Video N>` 空间锁定。容量裁剪移除站位图时，`rewriteOmittedSpatialPictureRefs` 必须同时把静态提示词里原来的站位图 `<Picture N>` 改成文字计划，防止它误指向补位后的桥接帧。不得把“所选/缺失”列表中两个非相邻任务直接串接。
- **双语资产册**（`directorAssetCatalog.ts` + H3 工位)：H3 导演台批量菜单“**资产册绑定…**”在剧本已产生片段后选择项目根目录或 `全部素材`，读取 `MOMO_ASSET_CATALOG_V1` 的 `资产提示词.md`；它和“文件夹绑定（备用）”二选一。每项要求媒体路径（Markdown 图片；视频/音频可用普通链接或 `文件:` 元数据，扩展名推断 `media`）+ 中文提示词 + English Prompt，可选 `使用分段` 和 `参考顺序`；`参考顺序` 支持统一数字或 `01=2, 03=4` 分段映射，缺省按场景→人物→道具/装备→站位图降级。媒体按内容指纹只落库一次，重导按 `catalogId` 原位同步；绑定按媒体分通道——图片→`referenceImage`/`layoutGuide`、视频→`referenceVideo`、音频→`referenceAudio`，音频条目「类型」含对白/旁白/音乐/音效/环境时再补一条 `audioTracks` 混音轨（对白轨供字幕「从对白生成」取词）。空间站位图写 `referenceRole:spatialLayout`/`layoutGuide`，运行时 `refsNoteFromSnapshot` 明确只读空间、不复制标注；配方图片槽不足时 `constrainPictureCapacity` 只移除站位图图片，优先保留真实桥接帧和外观参考，并把资产的英文空间锁转成文字注入。
- **3.5 剧本项目隔离与统一视频规格**（P0/P1 已落地；方案全文见 `MOMO导演台3.5-*.md`）：
  - **项目切换**：`uiStore.directorProjectId` 是导演台打开的 canonical 项目 id（打开入口都同时写 nodeId+projectId；DirectorStudio 按 id 解析，nodeId 兜底）。顶栏 `ProjectSwitcher` 按 projectId 整体切换——切换前清 `useDirectorCtx`（segId/对比态），在途批量任务 AskCard 确认（结果仍写回原项目）。**不同故事的剧本默认新建独立 DirectorProject**：剧本库导入语义三分（每次询问/总是新项目/总是草稿），新项目路径 `ingestIntoNewProject` 建 id 后自动切换。
  - **P2 项目文件夹绑定**（`studio/projectWorkspace.ts` + `studio/projectAssetRouter.ts`）：顶栏「绑定文件夹」→ 确定性扫描（manifest→完整剧本→双语分段→资产册→分段目录→媒体计数，§3.4 顺序）→ AskCard 预演（**含与已有片段的冲突预演与中英规格冲突，全部写入前展示**）→ 写 `.momo/project.json`（一个目录只绑一个项目，重复绑定被拦；`manifestBlocksBind` 纯函数判定）。**绑定即导入**走 `applyBindImport`（fs 经 `WorkspaceFs` 注入可测）：英文分段真正写进 scenes、中文稿稳定键配对、资产册按 `assetCatalogPath`（**只存相对路径，绝不存 Markdown 内容**）读取导入；幂等靠 `workspace.imported` 内容指纹（**merge 模式没执行分段导入就不记 segEn 指纹**——否则后续 overwrite 会被误判跳过）。解绑（`unbindProjectFolder`→`removeManifestFor`）删 manifest 且保留产物；目录离线时记 `pendingManifestCleanups`，`checkWorkspace` 上线时补清理。绑定后 **Take 生成自动镜像落盘**到 `分段资产库/NN_标题/Takes/`——镜像账本是 `AssetItem.projectMirrors`（projectId→路径，多项目互不覆盖；`projectRelPath` 只是最近一次，兼容旧 UI）；路由表含 take/relay/audio/post/export/image/mv/character/scene/prop（`relDirFor`：分段类必须有真实片段号与标题，segmentId 缺失绝不退化成项目名——take/relay 直接不路由）。未绑定保持 AppData 托管；目录离线只标 `status:"missing"` 不清数据（`checkWorkspace` 在打开、切项目、窗口 focus 时都会跑）。
  - **P3 H3 双语**（`studio/h3BilingualCore.ts` 纯解析+配对+校验 + `h3Bilingual.ts` 生成流程；切段/标题解析已提取到 `segmentParse.ts` 纯模块，directorEngine re-export）：`H3BilingualPrompt`（zh 审阅/en 执行 + syncStatus）与 `SegmentLocks`（结构/中文/执行稿三锁分离）；直录导入经 `h3PatchForSegment` 回填对白/接力/空间锁/h3Prompt（不再只有 promptOverride 一个字符串）；H3 检查器提示词区为**四视图**（中文审阅/英文执行/左右对照/实际请求）——英文执行稿以 `promptOverride` 为唯一真源（编译路径零回归），`promptFinalOverride` 与执行稿锁双写兼容；`schemaVersion` 已升 5（v4ToV5：locked→locks、H3 稿→h3Prompt.en）。英文执行稿是模型请求真相，中文稿绝不发给模型。
  - **统一视频规格**（`studio/videoSpec.ts`，快测 `videoSpec.test.ts` 可 `node --experimental-strip-types` 直跑）：严格只有**分辨率/帧率/时长**三项。`parseVideoSpecFromSegment` 从分段标题（`01-标题-12秒｜1080p｜24fps`）/元数据行/正文确定性识别，保留命中原文与行号；`resolveVideoSpec` 逐项独立取值（用户手改 `videoSpec.user` > 分段识别 > 项目前言 `videoSpecFromPrefix` > 项目默认 > 配方默认），能力处理：区间钳制写 adjustments、**能力为 null（如各协议无 FPS 直出参数）则该项不发送且 applied 缺省、adjustments 明确「未应用」**；step 对齐后必须再钳 max。**远程与 ComfyUI 双通道都只消费 ResolvedVideoSpec**（此前远程从不传 resolution/fps；ComfyUI 帧数 = 本段最终 fps × duration）。Take 快照存 requested/applied/sources/adjustments——**applied 只写真实注入成功的项**：远程靠适配器 `onSpecApplied` 回调（`AdapterSpecReport`，三家官方适配器 + 通用协议 + 自定义协议都有，内部钳制如实上报），ComfyUI 靠 `runComfyTemplate` 返回的 `videoSpecApplyReport`（`applyVideoSpecToWorkflow` 纯函数：哪些项命中了哪些节点/入口，无入口出 warning），合并入口在 `studio/specCapability.ts`（`specCapabilityFor` 组装配方快照+协议能力，`mergeAdapterReport`/`mergeComfySpecReport` 把报告合并进 Take 快照）。分段三项可在 H3 检查器手动设置（PopSelect 逐项「自动」恢复，手改后 source=user；时长手改同步写 `videoSpec.user.durationSec`）。`DirectorProject.videoSpecDefaults` 为项目默认（顶栏 `VideoSpecDefaultsControl`）；`schemaVersion` 已升 4（v3ToV4：主剧本推断 + 旧规格收敛 + 直录段重扫）。预检对每段报告规格调整；适配器三家均显式构造请求体（`req.fps` 不透传未知字段，协议零破坏）。
  - **3.5 收尾补全（P2/P3 全落地）**：`refineSegmentPrompts` 精炼结果解析进 `h3Prompt.en` 并回填对白/接力（只填空不覆盖手填）；四视图中文空态提供「生成中文审阅稿」（chat 对齐，对白逐字不动）；**绑定即导入**（见上 P2 条目）；`pairBilingualDocs`（h3BilingualCore）**按稳定键配对**（段号 H3-01/第01分段/01-裸标题归一；主序随英文文档与 importPromptSegments 切段一致；缺段/重复编号/时长/对白冲突全部报 warning，配对有差异标 conflict 不静默 synced；`segmentKeyOfTitle` 在 `segmentParse.ts` 纯模块）；「生成中文审阅稿」生成后强制 `validateZhAgainstEn` 对白逐字校验——不过关存 `zhDraft` 草稿 + syncStatus=conflict（H3 检查器提供确认/丢弃）；`refineSegmentPrompts` 过滤 `isExecutionLocked`（执行稿锁或 promptFinalOverride——二者都不许 Skill 精炼改写）；资产库「本项目」默认开启（`assetVisibleInProject` 谓词，切项目自动跟随）；schemaVersion 已升 6（v5ToV6：主剧本前言识别 `videoSpecFromPrefix`）。
- **工位拖拽导入**（`studio/dropImport.ts`，挂在 StudioShell `.st-content`，七个工位通用）。**同段多稿有序入槽**：`draftRankOf` 认「首尾帧稿 > 403 稿 > 103 稿」（中文数字也认，纯数字不误伤 14033），散料绑槽按稿别序插入——`<Video 1>` = 首尾帧稿、`<Video 2>` = 403、`<Video 3>` = 103，不随文件系统顺序漂移；**首尾帧语义自动入槽**（`semanticForMediaRel` + 资产册 `slotSemanticFor`）：图片/条目名含「首帧/first frame」→ firstFrame、「尾帧/末帧/last frame」→ lastFrame（单例槽，第二条降级普通参考；「首尾帧」整稿名不占单例语义），模板有具名首尾帧入口时精确映射；剧本库右栏另有「绑定总文件夹…」入口（复用 bindProjectFolderFlow，一键导入中英剧本 + 资产册 + 人物进角色库）；批量菜单「Skill 精炼提示词」显示未精炼计数（`unrefinedSegments`：无 promptOverride/promptFinalOverride/h3Prompt.en 的段，预检同样提示，不静默自动调 LLM）。资源管理器拖文件/文件夹进内容区即导入——含 `资产提示词.md` 的目录整目录走资产册；`.md/.txt/.json` 经 `scriptInspect.ts` 深解析后存入剧本库（自动命名=前言主标题>文件名，提取段数/每段时长/衔接模式/引擎线索/提示词围栏/参考图提及/`<d>`对白，显示在剧本库右栏「内容解析」表）；**在剧本库工位拖入时自动处理**——成品提示词包/分段脚本且项目为空则直接送入拆分（风格锚定+targetDurationSec），完整剧本或项目已有片段则出预演卡/引导确认，绝无不确认的覆盖；图片/视频/音频散料入资产库，文件名或所在子目录带分段号（`01-`、`第03段`、`H3-02`、`分段资产库/01_标题/…`）自动绑到该分段参考槽，音频按名称含对白/旁白/音乐/音效/环境补混音轨。`entriesFromDataTransfer` 用 `webkitGetAsEntry` 递归展开目录（readEntries 每批约 100 条须循环读尽）；带 `momo/*` 自定义类型的内部拖拽（画布节点、参考槽 chip）不触发。
- **ComfyUI 模板两种格式**：API 格式直接导入；前端格式（nodes/links/definitions）走 `src/modules/comfy/frontendConvert.ts` 转换——需 ComfyUI 在线（/object_info 提供 widget 名序），支持一层子图展开（FL2VA 的「Image to Video (MiniMax H3)」子图节点，接口槽 = 虚拟节点 -10 / 输出 = -20）。
- **Comfy 工作流无感同步**（规格 v1.0 M1+M2+M3，方案全文见 `G:\ciomfyui AI\ComfyUI-aki-v3\MOMO ComfyUI 工作流无感同步插件 开发规格 v1.0.md`；代码 `src/core/comfySync/`（engine/classify/identity/writeBack/workflowDiff/widgetLayout）+ `src/core/stores/comfySyncStore.ts` + `src/modules/comfySync/SyncCenter.tsx` + Rust `src-tauri/src/comfy_sync.rs` + `comfy_bridge.rs`）：一次配置来源后 ComfyUI 里新建/保存/改名工作流自动同步进 MOMO。**完整 UI Workflow 是主数据**（存 `<AppData>/comfy-sync/workflows|revisions/`，Rust 命令读写，前端 store 只存索引到 comfy-sync.json），API Prompt 由 `convertFrontendWorkflow` 派生进 `ComfyTemplate`（带 `workflowId` 关联，画布/导演台零改动）；默认 `comfy_master` 只读不写回。链路：notify watcher（Rust，事件 `comfy-sync-fs-event`，100ms 聚合）→ 前端 750ms 防抖 → `scanSource` 对账（stat 变化才读正文算 SHA-256；**改名/移动**靠 graphId > 语义哈希 > 结构指纹一对一配对，歧义不猜）→ `syncOne`（200ms×2 稳定性检测、坏 JSON 按 300/600/1200ms 重试后标 `invalid` **绝不覆盖旧版本**）→ 版本快照（保留策略：最近 20 + 7 天内 + pin，`computeRevisionKeep`）→ 模板联动（`mergeSyncedTemplate`：**参数默认值跟随源文件**（用户没改过时），改过的保留为待写回补丁；失效定义剔除；**画布实例 `ComfyData.params` 覆盖值完全不经手**，孤儿覆盖键在画布参数面板灰显可清；default 分支 nodeIds/outputNodeIds 跟随新工作流，自定义分支只剔除失效 id）。首扫只列候选（`untracked`）由用户勾选，此后新增按来源 `autoTrackNewWorkflows`；来源离线走指数退避复扫（5→60s）绝不判删除，恢复在线补建 watcher；`derive_failed`（ComfyUI 离线派生不了）在上线后 `rederivePending` 自动补；**依赖检查**（FR-016：缺自定义节点/疑似缺模型只进 warnings 不阻塞）。
  - **M2 双向写回**（`writeBack.ts` + engine `writeBackWorkflow`，规格 FR-010/§11.3）：仅 `bidirectional`（同步中心工作流行 PopSelect 开启，确认后 `enableBidirectional` 同时授权来源 `allowWriteBack`）或 `momo_master` 允许。**MOMO 只写参数值**（模板暴露参数的默认值改动，经 `patchesFromValues` 与 `baseParamValues` 基线 diff 出补丁），图结构永远以 ComfyUI 源为权威（不从 API Prompt 反向生成）。补丁按 `widgetLayoutOf` 位序写回源文件 `widgets_values`（**位序规则已提取 `widgetLayout.ts` 纯模块**，frontendConvert re-export，读回/写回/转换三处同源；「连接槽带 widget」的补偿位按出现序在布局末尾）。流程：读源 → 源哈希==基线 → 最小补丁直写；源变了先 `detectPatchConflicts` 字段级三方检测（源同字段也改且值不同 → 存 `ComfySyncConflict` 冲突记录等用户选，**绝不静默覆盖**；冲突正文不落索引：基线取 revision 快照、源文本解决时现读）→ 首次写回 `injectStableNodeIds` 注入 `properties.momoSyncNodeId`（保留原属性）→ Rust `comfy_sync_write_source` 同目录临时文件原子替换（canonicalize 校验目标在授权根内，`.momo-tmp` 扩展不被扫描认领）+ 写后读回真实哈希 → **写入令牌**（路径+内容哈希，TTL 5 分钟）在 `syncOne` 入口匹配消费，自己的写不当外部修改 → MOMO 侧账本对齐（revision origin=momo 留档、基线刷新）。冲突 UI 在同步中心：使用 ComfyUI 版（重新同步源）/ 使用 MOMO 值（force 写回）/ 另存新文件 / 稍后处理；模板管理保存双向模板即 `maybeWriteBackTemplate`（`saveDraft` 同时修了「保存丢 workflowId 关联」的旧 bug）。**差异查看**（FR-014 `workflowDiff.ts`）：工作流行「MOMO ↔ 源文件」、版本行「该版本 ↔ 当前」，节点/参数/连线/位置/分组/扩展字段分类列出。
  - **M3 同步桥**（Rust `comfy_bridge.rs` + engine 桥函数，规格 §4.3）：同步中心顶栏「装同步桥」→ 选 ComfyUI 根目录/custom_nodes → Rust 生成 `custom_nodes/momo_sync_bridge/`（`__init__.py` 空节点 + `js/momo_bridge.js`，**候选端口 39871-39875 与持久 token（AppData/comfy-bridge.json）在安装时嵌进 JS**——MOMO 重启换端口时扩展逐个探通自愈）→ 重启 ComfyUI 生效。扩展 wrap `window.fetch` 捕获 userdata/workflows 的 POST（Ctrl+S 落盘）→ `POST /notify?token` 通知 MOMO（环回 HTTP，token 恒定时间比较，全路由带 CORS 头，body 不读）→ engine 收 `comfy-bridge-save` 事件按 relPath 匹配工作流**跳过防抖立即对账**（网络盘不再等 60s 复扫，NFR-002 <3s）；「在 ComfyUI 中打开」= `comfy_bridge_set_pending_open` 放一次性队列 + 打开 ComfyUI 页面，扩展每 2s 轮询 `GET /pending-open` 取走后 `app.loadGraphData` 直达（桥是否已装：`GET {host}/extensions` 含 momo_bridge）。桥随 startEngine 启动、lib.rs Exit 清理。**收尾项**：来源离线时正常态工作流标 `source_offline`（恢复在线且内容未变自动收敛回 synced）；`source_deleted`/`detached` 行提供「重新关联」（选来源目录内新文件，路径校验后原地更新立即同步）与「保留本地副本」；来源设置补齐默认模式/忽略规则（每行一条 glob）/允许写回；列表有模式过滤、上次同步时间（title 含文件修改时间）、批量暂停（勾选集同时服务「同步所选」与「批量暂停」，前者只取 untracked）；关联模板丢失时行内出现「关联现有模板」子面板（`bindWorkflowToTemplate`，§16.2 迁移入口）；模板仍在的工作流行有「配置模板」铅笔按钮——收起同步中心并 `setTemplateMgr(true, templateId)` 直达模板编辑器（同步中心↔模板管理双向可达：模板管理列表的链接按钮反向打开同步中心）。
  - 入口：标题栏工作流图标（状态点灰/绿/蓝/黄/红）+ 设置页 ComfyUI 卡片（`settings.comfy.syncV2Enabled` 功能开关，默认开，关掉完全回退旧路径）；同步派生的模板在模板管理显示「同步」角标、隐藏旧往返编辑按钮（避免与源文件双轨冲突，未同步模板保留旧往返）。纯逻辑快测 `comfySync.test.ts` 可 `node --experimental-strip-types` 直跑（74 项）。
- **导演台→ComfyUI 必须显式传 `upstreamTexts`**（`directorQueue` 的 comfy 分支），否则编译好的提示词不进工作流。首尾帧模板用 `withOptionalFrameDrop` 按素材缺失临时忽略首/尾帧 LoadImage（降级 T2V/I2V，防占位图 1.png 执行报错，判定只看节点标题的首/尾帧字样）；`buildSlotMap` 把首/尾帧语义精确映射到模板图片入口。
- **runComfyTemplate 素材通道**：`upstreamImages / upstreamVideos / upstreamAudios` 按节点 id 升序喂 LoadImage / LoadVideo / LoadAudio 类节点（REF2VA 的 4 图 3 视 3 音按编号天然一一对应）。各媒体入口严格只保留本次真实素材数量：例如只有一条末尾短视频时只保留 Video 1，模板默认 Video 2/3 及其 `GetVideoComponents` 拆分链必须由 `pruneNodesWithServants` 一并旁路，绝不能继续使用模板内的完整视频或占位视频。模板暴露的图片参数只占用它自己那个入口；剩余上游图继续按序投喂未占用的 LoadImage，仍不够且有其它空缺 IMAGE 必填输入时自动注入 `momo_in_N` 节点——「只暴露 1 个框、拖 3 张图」时另 2 张会自动落到其余图片入口。
- **显存清理**（`freeComfyMemory`，ComfyUI `/free`）：导演台按项目开关 `freeMemBetween` 在每段生成/后处理结束后自动清理（`runBatch` / `runBatchPostProcess`）；画布 ComfyUI 节点按 `data.freeAfter` 在运行 finally 里清理；设置页有手动「立即清理显存」。清理会卸载模型，下次运行重新加载——默认不开，用户权衡。
- **导演台「停止」按钮**（`stopBatchHard`，生成页/分镜页批量进度条）：立即中断在途生成（模块级 `runAbort` 信号穿进 `runComfyTemplate` 的 `opts.signal`，轮询 sleep 立即 reject）+ 强停 ComfyUI（`interruptComfy` = `/interrupt` + `/queue` clear）+ `/free` 清显存内存；被掐断的 Take 标 `cancelled`（不进报错中心、不计失败）。与「取消批量」（`cancelBatch`，跑完当前段才停）是两个语义，别合并。远程计费任务已提交部分无法撤销，按钮 title 已注明。
- **分镜卡提示词一律弹窗**：H3 段走片段头 H3 弹窗；普通段走「分段提示词」按钮弹窗（查看编译结果 / 编辑 `promptOverride`），卡片上不放展开块与单行覆盖输入框。「最终提示词」弹窗（眼睛按钮）可编辑，保存写 `segment.promptFinalOverride`——`compileSegmentPrompt` 见到它即整段直发（跳过风格/Skill/负向自动拼接；参考素材编号说明仍由执行层前置），分镜卡以「最终稿」角标提示。
- **批量生成进度**：`runBatch` 的 onProgress 第 4 参 `detail{msg,pct}` 承载细粒度进度（executeXxxTake 的 onSub → `runComfyTemplate.onProgress`，ComfyUI WebSocket 按节点/步数换算百分比；远程任务无百分比）。生成页 `.dsg-batch-live` 双条：总进度 + 当前片段条（无百分比时流动动画）。注意 ComfyUI 0.33 起带源检查，应用内浏览器 WebSocket 握手会 403（服务端日志 non matching host and origin），WS 进度拿不到时 /queue 轮询文案兜底。
- **分辨率兜底（comfy.ts 1c-2）**：模板没暴露百万像素/宽高/比例参数时按节点输入名直写——`megapixels`/`width`/`height` 数字输入命中即写；`aspect_ratio` 下拉按 object_info 选项表前缀匹配（16:9 → 16:9 (Widescreen)），匹配不到保持模板原值，防下拉写非法值被 ComfyUI 整单拒绝。
- **死配方自动清理（RecipeManager.tsx `pruneDeadRecipes`）**：模板被删除 → 引用它的配方直接删掉，连带清项目默认配方与片段上的 recipeId 引用；RecipeSelect 挂载/模板变化、配方管理打开时都会执行（幂等，有死配方才写回），不再保留「模板已删除」红标残骸。
- **分镜卡提示词入口唯一**：片段头的「分段提示词」按钮 = 原「最终提示词」弹窗（可编辑、保存 `promptFinalOverride`）；卡片下部不再放提示词按钮/输入框，眼睛按钮已移除。H3 段另有结构化弹窗按钮。
- **参考槽悬停预览（SegmentRefEditor）**：素材格悬停 220ms 弹预览浮层（Portal 到 body，fixed 定位随鼠标）——图放大、视频 blob URL 自动播放（muted+loop+controls）、音频悬停即播；鼠标可移进浮层交互（140ms 接力保活）；视频/音频 blob URL 按资产 id 缓存。
- **连续性跳跃检查豁免**：`checkContinuity` 的 jump 项对「双方 locked 的成品直录对」跳过——直录段的连续性写在提示词正文里，没有结构化 continuityIn/Out 是常态，报「剧情跳跃」全是噪音。
- **成片检查页双栏（dse-cols）**：主列（缺片/放大/时间线/音频/交付）+ 连续性右轨（`.dse-continuity` sticky 吸顶、高度按内容锁定、超高内部滚动）；<1280px 退化为单列。
- **成片检查流程与层级**：主列顺序 ①缺片检查 → ②故事顺序·预演 → ③高清放大（PopLayer 参数浮层，覆盖值存 `project.upscaleParams[模板id]`，`runBatchUpscale` 第 4 参合并模板默认值）→ 音频 → ④交付导出；连续性在右轨。**导演台是 z-index 450 的全屏层**——所有 Portal 到 body 的浮层（参考槽悬停预览、资产库 .assetlib-mask 460、其预览 .a-preview 465）必须 z-index > 450，否则被整层盖住「看不见/没反应」。
- **宫格切分 / 分镜组（独立宫格节点已删除）**：宫格能力全在图片/生成节点的编辑会话里——「编辑 → 宫格切分」= mediaEdit `gridsplit` 模式（EditSurface `GridSplitOverlay` 图上拖线 + 点格勾选记点击序；`GridSplitBar` 会话条：预设/自定义悬停选格器/重置均分/全部拆出/创建分镜组）。切割线是归一化 `gridXs/gridYs`（不含 0/1），切格统一走 `nodeEdit.splitGridCells`。「创建分镜组」`createStoryboardGroup` 把所有格**中心裁到切分形状的等分比例**（统一尺寸的前提）后产出 layerGroup+`frameless` 的组（relayoutGroup 跳过 layerGroup），落位是严格网格；切片为 `storyTile` 无小标题图片节点（NodeShell `hideHead`），带溯源输入口（`NODE_INPUTS.image` 保持空，无传入徽标/不被贴近连线），`sanitizeEdges` 对 storyTile 入边豁免「无输入口丢弃」。分镜组数据（`storyOrder/storyCols/showOrder`）在 GroupData，组头工具条：每行格数重排/`stitchStoryboardGroup` 拼接 2K（stitchCanvas.stitchGrid）/序号角标（画在切片上，GroupNode 画会被成员盖住）/转普通组/解组。紧凑排布必须用 `core/imageInfo.mediaNodeWidth`（与节点实际渲染宽度同源），NodeShell 只 re-export。
- **AI 模板（`aiPresets.ts`，LibTV「九宫格 ▾」式）**：分类大面板（分镜叙事/质感调节/空间与机位/设定图），分 `grid`（复用 GRID_PRESETS，写 gridPresetId/gridAspect）与 `single`（自带提示词模板）两类；选中走 `nodeEdit.spawnAiPresetNode` **只铺下游 imageGen 节点不自动跑**（参考图靠 spawnEdit 连线自动带入，场景描述/画幅/画质用户在节点上调）——别再往菜单里塞画幅选择或自动 runFlow。
- **版本卡**：采用是开关（已采用显示「取消采用」清 approvedTakeId）；操作行 flex-wrap 防删除钮被 168px 卡宽顶出；参考素材格不再放前移/后移按钮（与拖拽重排重复）。
- **种子随机化（comfy.ts）**：`runComfyTemplate` 里 seed 类暴露参数留空即每轮随机；未暴露成参数的 `noise_seed`/`seed` 数字输入也每轮随机（进度消息可见 `随机种子 N → #节点`）。模板 JSON 里存的是导出那一刻的具体数字，不随机会每轮朝同方向出图；要可复现就把种子暴露成参数并填固定数字。
- **ComfyUI 节点位置保留（双向）**：`ComfyWfNode` 有可选 `pos`/`size`（前端格式导入时由 `convertFrontendWorkflow` 写入；API 格式无坐标，由 `applyComfyLayout` 用 `layoutForComfy`（wfGraph.ts，真实节点尺寸估算的拓扑布局，非示意图的 236×78 密网格）补一份存上）。推送回 ComfyUI 时 `convertApiToFrontend(wf, info, { spacing:"comfy", savedPos:true })` 优先用存储坐标；`mergeWorkflowText` 合并回来时把 ComfyUI 里编辑后的 pos/size 回写模板——位置始终跟随最后一次编辑。
- **widgets_values 位序唯一来源是 `widgetLayoutOf`（frontendConvert.ts）**：按 object_info 定义序排出 widgets_values 的取值位序，forceInput 的 widget 不占位、control_after_generate 注入位补 "fixed"——前端→API 与 API→前端两个方向都用它，别再各写一份 indexOf 直取（会错位）。
- **combo 参数类型矫正（comfy.ts `enrichParamsWithCombo`）**：object_info 定义是选项数组的参数一律 `kind:"text"` 带 options——数字枚举的 combo 会被值类型误判成 number 丢掉下拉。画布 ParamField 与模板编辑器 WidgetValue 的下拉都用 PopSelect。
- **ComfyUI 往返编辑（templateIO.ts，零配置自动）**：模板管理的「⬆」= `startComfyRoundTrip`：优先走 ComfyUI userdata HTTP 接口把模板写进它的工作流库——注意必须先经 convertApiToFrontend（frontendConvert.ts，需在线 object_info：widget 按定义序回填、control_after_generate 位补 "fixed"、COMFY_DYNAMICCOMBO_V3 算 widget、AUTOGROW 带点键（ref_images.ref_image_N / values.a）作动态连接槽且槽类型用定义 template 里登记的子类型（如 FLOAT,INT,BOOLEAN——用错类型 ComfyUI 装载时会丢连线）、连线遍历节点全部输入而非仅定义槽）转成前端格式，工作流库面板只认 nodes/links，API 格式点开是空白画布（`POST {host}/userdata/workflows%2F{MOMO_名}.json?overwrite=true`——**相对路径必须整体 encodeURIComponent，斜杠成 %2F 才能命中 aiohttp 路由**，字面斜杠会 404/405）→ `openExternal` 打开 ComfyUI → 模块级 `tripSessions` 每 2s GET 同一接口轮询，ComfyUI 里 Ctrl+S（前端格式）后 `mergeWorkflowText`（`frontendConvert` 转换，需在线）自动合并回模板并 toast（保留 id/名称/分支，失效暴露参数剔除）。该前端无 ?workflow= URL 参数（已核实 1.48.7 全部 chunk），打开后需用户在左侧列表点开 MOMO_*.json。没配服务地址才退回本地文件 + `ensureWorkflowDir`（选一次目录并记住）。↻ 为手动同步兜底（HTTP 优先）。
- **Skill 导入**（`skillImport.ts`）：SKILL.md 单文件 / Claude 风格 zip（找包内 SKILL.md，忽略 agents/ 与脚本）/ .momoskill 包；导入后在详情视图勾选适用位置（contexts，自定义小方框 `.skill-ctx`），`director.project` 上下文的 Skill 才会出现在导演台「项目级 Skill」绑定卡。详情视图可直接编辑名称/描述/指令；管理器窗口支持把文件拖入即导入。

## 关键约定

- **报错**：service 层抛带中文信息的 `Error`；runner 捕获后走 `pushError(source, msg)`（uiStore）→ 报错中心（标题栏铃铛）+ 可点击 toast。不要裸 `toast(..., "err")` 报运行类错误。
- **zustand v5 selector 禁止返回新引用**（曾致同步中心打开即白屏）：`useXxx((s) => s.items.filter(...))` / `.map(...)` / 对象字面量 `({ a: s.a })` 每次求值都是新引用 → `useSyncExternalStore` 快照不稳定 → Maximum update depth 无限重渲染 → 整树卸载白屏（tsc/build 均查不出，只有运行时炸）。正确写法：订阅原数组/原字段，组件里 `useMemo` 派生；多字段聚合用 `useShallow`。安全形态：`.filter().length`（number）、`.find()`（元素引用）、原始值比较。
- **节点内大图必须用 `<Thumb>`**（`src/ui/Thumb.tsx`）而非 `<img>`：图片全程是 dataURL，原图直塞 img 会让画布拖动掉帧；原图仅用于灯箱预览/保存/传模型。
- **参数浮层与底部栏样式必须隔离**：`NodeParamsPop` Portal 到 `document.body`，只能使用 `.gd-param-pop/.gp-scope` 作为参数内容作用域，禁止给浮层附加 `.gen-panel`（该类含底部绝对定位，会导致浮层二次偏移、留白和裁切）。浮层宽度应由内容类控制，并保留 `max-width: calc(100vw - …)` 的视口兜底。
- React Flow 节点内的可交互元素加 `nodrag` class，否则拖不了输入框选不了文本。
- 持久化走 `persist.ts` 的 `loadJSON/saveJSON`：Tauri 下是 tauri-plugin-store（AppData JSON），纯浏览器预览退回 localStorage。`isTauri` 判定环境——所有功能需兼容浏览器预览模式（降级即可，不能白屏）。
- 网络请求用 `services/http.ts` 的 `xfetch`（Tauri plugin-http 绕 CORS，浏览器退回 fetch）。
- 中转站返回格式五花八门：imageGen 的 `normalizeResults` 做了大量兼容解析，改动时保持宽容。
- **资产多结果必须成组收录**：同一次生成返回 2 张及以上时，为 `AssetItem` 写同一个 `groupId`，并用稳定的 `groupSlot` 标识组内位置；电商长图的切片与最终长图共用一组，最终图设 `groupCover`，单片重生沿用原 `groupSlot` 以替换旧资产。资产库列表只渲染一张叠卡，点击后在灰色聚焦层临时展开组成员。
- 画布载入时 `sanitizeNodes(nodes)` 会把上次退出时 `running` 的节点标成中断错误（`INTERRUPTED_MSG`），不能静默重置；**切换画布**走 `sanitizeNodes(nodes, false)`——本会话仍在跑的任务不能标中断，`updateData` 会把结果写回它所属的那张画布。
- `persist()` 的落盘带**序号守卫**（`saveSeq`）：externalize 是异步深走，慢的旧快照不能覆盖新快照。
- 拖动吸附：`onNodesChange` 里算出的偏移要缓存到 `lastSnap`，松手那次 `dragging:false` 的 position 变更必须补上同样的偏移，否则节点弹回未吸附坐标。
- 撤销/重做快照、贴近自动连线、防环（`wouldCycle`）都在 boardStore，改节点/边操作时留意是否需要入历史。
- 新图标手绘 SVG 加进 `src/ui/icons.tsx`，不引第三方图标库。
- 光晕/描边等颜色一律用 `color-mix(in srgb, var(--accent) N%, transparent)`，不要硬编码 `rgba(91,140,255,…)`——黑主题的强调色是暖橙，硬编码会出现橙边配蓝光。
- 新增快捷键：`types.ts` 的 `HotkeyAction` + `HOTKEY_LABEL` + `DEFAULT_HOTKEYS` 三处同步，`normalize()` 的 `{ ...DEFAULT_HOTKEYS, ...(v.hotkeys ?? {}) }` 会自动给老用户补默认值；再在 SmartCanvas 的 keydown 分支里接线，并加进 `src/modules/settings/tabs/HotkeysTab.tsx` 的 `HOTKEY_GROUPS`。
- **UI 精致度规范**（新功能一律照此，不再返工）：
  - 下拉一律用 `src/ui/PopSelect.tsx`，**禁止新增原生 `<select>`**；参数浮层/节点编辑浮层（`.gp-scope`/`.ne-pop`）内的 PopSelect 自动命中 30px 小号样式，不要再叠内联宽高。需要小号输入框用 `className="input sm"`（base.css 已定义，30px）。
  - **下拉选项一律「图标 + 文字」**：options 每项必须带 `icon`（手绘 SVG，从 `src/ui/icons.tsx` 选，缺了就新增），触发器同时传 `triggerIcon` 让当前项图标常显。导演台已统一（配方下拉走 `RecipeSelect`、批量范围、接入点等），后续新增任何下拉沿用此规则。
  - 参数浮层内的布局类（`.gp-wh`/`.gp-opts`/`.gp-check`/`.gp-dur`/`.gp-foot`/`.gp-seed` 等）选择器必须写 `:is(.gen-panel, .gp-scope)` 前缀——只写 `.gen-panel` 会在 Portal 到 body 的浮层里失效，控件塌成全宽傻大粗。
  - 提示/说明类文字一律灰色小字：`.gp-hint`（分区标题后缀）与 `.gp-foot`（浮层底注）均为 11.5px `var(--text-3)`；导演台用 `.ds-hint`、设置页统一用 `.set-hint`（协议页内部旧类为 `.proto-hint`，同规格）；不要给提示文字用正文大字重，也不要再新增裸 `.hint`（无全局样式，会以正文大小显示）。
  - 节点运行结果的关键指标用**角标**承载（如超清放大的分辨率角标、保真分角标），节点底部**不再放报告长文**；无角标可用的节点（如智能矢量）底部摘要（`.enh-report`）只放一行关键指标（10 余字符以内），完整诊断信息写入 `reportDetail` 字段，以悬停 title 展示。
  - 节点空态提示文字用 `.gen-empty`（限宽 220px、两行居中、不贴边），文案拆短句，别写一长串。
  - **设置页统一骨架**（`src/modules/settings/settings.css`）：每个 tab 套 `.set-page > .set-page-h(.set-page-t+.set-page-d) + 若干 .set-card(.set-card-h)`；说明文字一律 `.set-hint`（含 .warn/.ok/.danger），长段说明收进卡片标题右侧的 `SecHelp`（`settings/shared.tsx`）；指标大数字用 `.set-stats > .set-stat > b+span`，状态徽标用 `.set-badge`（.dim/.ok/.warn）。设置页内不再出现裸 `.hint`/`.sec-desc`。

## 图片处理（本项目专用）

我（GLM-5.2）本身没有视觉模块，看不到用户发的图片。处理含图需求时遵循：

- 用户发图后，先调图片分析 MCP 工具（`mcp__zai-mcp-server__analyze_image` 或 `mcp__4_5v_mcp__analyze_image`）拿一段文字描述，作为大致参考——但这是工具的转述，不是原图。
- 两个绕不开的坑：① 工具描述会**失真**（颜色/位置/元素经常不准），不能当 ground truth；② 图片 URL 带**签名时效**（Expires），过一阵工具调会 400，要趁早调。
- 涉及**精确视觉位置**（红框框哪、按钮排布、贴边与否等 UI 改动）：基于工具描述 + 代码常识给出"我理解是 XX"，**先和用户核对一句再改**，不闷头改完让用户返工。
- 工具失败或没把握时，直接请用户用文字点一下关键元素，基于代码定位改动。

### 创作助手 / 语音（agentEngine.ts + voiceChat.ts）

- Agent 走「每次回复只输出一个 JSON 动作」的纯文本协议（search / ask / image / video / **tool** / reply），不依赖 function calling；模型偶尔按 function-calling 风格输出 `{"name":"能力id","arguments":{…}}`，`agentLoop` 会兜底识别为 tool 动作（name 必须能对上能力目录）。
- **能力层（`src/core/capability/`，统一执行信封）**：画布 runner、导演台队列、创作助手三条执行路径的统一闸门——校验 → 确认策略（read=直接执行 / write=提案送审 / spend=内联确认+预算）→ 预算 → 幂等（idemKey 内存账本，重放直接复用结果；扣费类**不设** idemKey——重跑是合法诉求，防重由确认闸+预算+批量重入锁承担）→ 执行 → 完成验证。Agent 的 **tool 动作**接 `agentToolCatalog()`（只读 + 提案型写入 + **显式声明 `agentSpendAllowed` 的扣费类**——`director.run_batch` / `comfy.run_template`，信封强制 inline 确认：先回 confirm 计划，助手确认卡问用户，带 `confirmed` 重进才执行；确认后再要确认=信封异常直接断）。内置能力在 `builtin.ts`：只读四件（`director.project_summary` / `director.segment_status` / `canvas.node_list` / `comfy.template_list`）+ 提案 `director.propose_prompt`（→ `useAgentProposals` 审核池，应用走 agentGateway 受控应用器，AI 永不直写）+ 扣费两件（`director.run_batch`：missing/selected/failed，确认卡带实时预估；`comfy.run_template`：本地免费，画布建节点走 runFlow）。**新能力只改 builtin.ts 注册（泛型入口从 validate 推断参数类型），协议与引擎零改动**。
  - ⚠️ **模块环教训（曾致启动白屏）**：`capability/index.ts` 必须保持无环（只依赖 types/budget），**绝不能 import builtin**——静态导入被提升到本模块求值之前执行，builtin 顶层 `registerCapability` 会撞上 `const registry` 的 TDZ（ReferenceError 白屏，tsc/build 均查不出来，只有运行时炸）。注册副作用放在消费方 `agentEngine` 的 `import "./capability/builtin"`；builtin 里需要画布落点时用本地 `agentCanvasPos` 内联，不 import agentEngine。
- **MCP 适配器（`capability/mcp.ts` + `services/mcpClient.ts`/`mcpFormat.ts`）**：设置「MCP 工具」页管理 Streamable HTTP 服务器（`settings.mcp.servers`，stdio 不支持——需 Rust 进程管道；鉴权头单行 `Header: 值`）。连接成功后工具整批注册为 `mcp__<服务器>__<工具>`（source:"mcp"、risk:"read"——用户主动配置的外部服务器，动不了 MOMO 数据、不触发扣费），**每次同步先清后建**不留残骸；App 启动 `initMcpSync()` + settings 订阅指纹防抖（800ms）重连。会话要点：initialize 握手 → notifications/initialized → tools/list；响应 JSON 或 SSE（`parseSseData`/`pickRpcById` 按 id 匹配）；`Mcp-Session-Id` 头续会话；纯逻辑快测 `mcpClient.test.ts` 可 `node --experimental-strip-types` 直跑（13 项）。
- **统一预算闸**：`budgetGate` 从 runner.ts 抽到 `capability/budget.ts`——画布/助手/导演台同一道门；`perRunCap`（单次上限）在此生效（此前只有定义无消费点）。**聚合预检传 `{ skipPerRunCap: true }`**（perRunCap 语义是「单次生成」，拿整批总和去比会误杀合法批次）：`runBatch` 批首只查日预算+确认阈值，**单次上限与日预算逐段在循环里查**（超标段标失败给原因、不拦整批，中途日预算被吃满也在此拦）。助手 image/video 执行前过闸、确认后二次过闸、成功/失败 `useUsage.record`；**导演台远程 Take 同样记账**（executeVideoTake/executeImageTake 成功按 videoSec/images 记、失败记 fails；本地 ComfyUI 配方不计）。
- **Skill 分型分析（`skillAnalyzer.ts`）**：Skill 详情「AI 分析分型」按钮——chatOnce 读指令正文判 rule/workflow + 提炼 triggers，**预览后手动应用**（不静默改）。
- **画幅必须自己兜底**：模型经常漏填/乱填 `aspect`/`resolution`，`agentLoop` 的解析顺序是「本轮已确认规格 > 动作字段 > 提示词措辞 > 用户对话原话」，每一级先经 `normAspect`/`normResolution` 归一化（"竖屏"/"1920×1080"/"1080p" 这类写法折算成 "9:16"/"2K"，认不出就丢弃走下一级），全都没有就强制 ask 一轮再生成。
- **生成确认闸（防自动扣费）**：image / video 动作执行前必须过一次用户确认（`confirmedSig` 记录已确认的方案签名：提示词+画幅+张数/时长，方案变了就重新问；「再改改」类回答会清掉已确认规格并回炉方案）。生成成功交付后确认闸复位，新需求重新确认。系统提示词已告知模型收到「用户已确认」反馈时原样重发动作。
- 聊天模式的上下文：最近 10 条原样带，更早的每积 8 条压缩成「前情摘要」；压缩带 `epoch` 守卫，清空对话会作废在途的旧摘要。
- 语音通话是**轮流对讲**（VAD 断句 + 请求/响应 + TTS），不是实时双工；需要 `asr` 角色模型，`audio` 角色可选（没配就只做语音输入不朗读）。
- **Skill 分型（skillTypes）**：`MomoSkill.kind: "rule" | "workflow"`（缺省 rule=纯规范文本；workflow=带分步计划的扩展型，现阶段仅登记元数据）+ `triggers`（**只作 Agent 路由提示，绝不放行扣费/写入**——放行只认 purpose/scope + 信封闸门的确定性链）。`SKILL_CONTEXTS` **已冻结**（12 成员封顶）：context 轴混了媒介/对象/工位/入口四种维度，新工位入口聚合改由 purpose/scope（skillRoute）+ 能力层承担。**精炼链空过滤 fail-loud**：`refineSegmentPrompts` 里职能路由把绑定全过滤时直接报错指路，不再回退全量（防拆分规范污染提示词，§2.2 回归）。

## 其他

- 包管理器是 **pnpm**。数据/密钥存本机 AppData（`site.jinpengi.momo`），API Key 明文，不要提交任何真实 Key。
- 产品路线图（未完成事项）维护在 README.md「路线图」一节。
