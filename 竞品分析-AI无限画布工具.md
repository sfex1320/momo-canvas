# AI 无限画布工具竞品分析

> 调研日期：2026-07-20 · 覆盖国内 3 款 + 国外 9 款「无限画布 / 节点式 AI 创作」工具
> 目的：梳理各家优势/劣势与画布功能，筛选可加入 MOMO 智能画布的实用功能，并给出优先级建议。

---

## 〇、一句话总览

**「无限画布 + 类型化端口 + 连线即工作流」已成为 2025–2026 行业收敛范式**——Flora 开创，Krea Nodes、Freepik Spaces、Recraft Studio、LibTV 全部跟进。MOMO 的节点画布方向与头部产品完全一致。同时 2024–2025 年独立画布产品被巨头收购殆尽（Weavy→Figma 约 $200M、Visual Electric→Perplexity 后关停、Invoke 团队→Adobe、Leonardo→Canva），云端订阅制的「失败也扣积分」「积分暗改」是全行业最大量级差评来源——**「本地桌面 + 自带 API Key」恰好免疫这一点，是 MOMO 的天然差异化卖点**。

### 竞品速查表

| 工具 | 画布范式 | 模型策略 | 突出点 | 最大短板 |
|---|---|---|---|---|
| 即梦AI（字节） | 双画布：图层精修 + 自由布局（右侧 Agent 对话栏） | 自研封闭（Seedream/Seedance） | 框选局部重绘出多候选「选卡」、全链路成片 | 付费缩水吐槽多、重绘不稳 |
| LiblibAI / LibTV | 无限画布 + 节点连线（**与 MOMO 形态最像**） | 自研 + 20+ 外部模型聚合 | 斜杠命令、聚焦框选、工作流打组模板 | 产品早期、一致性不稳 |
| 可灵AI（快手） | 无画布，工具页 + 对话式指令编辑 | 自研封闭（可灵/可图/O1） | 参考图框选主体、运动笔刷、主体库 | 贵、抽卡不退、无项目组织 |
| Krea.ai | 实时画布 + 独立节点工作流 Nodes | 聚合 60+ 且有自研/开源 | <50ms 实时生成、Node Agent、成本预估 | 计费/客服口碑差（Trustpilot ~2.7） |
| Recraft | 无限画板 + 节点工作流编辑器 | 自研为主（V4） | 原生矢量 SVG、风格作为一等资产 | SVG 输出脏、稳定性差 |
| Freepik Spaces（Magnific） | 节点式无限画布（2025-11 上线） | 纯聚合 40+ | Spotlight 加节点、列表节点批处理、协作 | 失败扣费、「无限」政策反悔 |
| Flora | 节点+连线画布先驱 | 纯聚合 50+，零自研 | 分支可见、Ctrl+F 搜节点、模板播种画布 | 学习曲线陡、视频贵 |
| Weavy（Figma Weave） | 节点画布 | 聚合 12 家 | 多模型并排 A/B、编辑操作全节点化 | 积分双重收费、收购后前景不明 |
| OpenArt | 聚合平台 + 图层画布 | 聚合 100+ | 作品带参数一键 Remix、Recipes 表单化 | 失败扣费、积分暗改、口碑翻车 |
| Visual Electric（已关停） | 设计师无限画布 | SD 系 + 自研 VE2 | 风格从 moodboard 反推、4 联落画布比稿 | 单点形态无法独立存活（教训） |
| Invoke AI（开源） | 统一画布 + 图层 + 节点 | 本地 SD/FLUX | **Bounding Box 取景器、staging 候选区**（重绘体验天花板） | 无视频、新模型适配慢 |
| Leonardo.ai | 全家桶 + 实时画布 | 自研 + 80+ 聚合 | Flow State 维度化变体、擦除替换笔刷 | token 浮动、失败扣费 |

---

## 一、国内三款重点分析

### 1. 即梦AI（jimeng.jianying.com，字节跳动）

**定位与模型**：面向大众创作者的一站式图像+视频平台，深绑剪映/抖音生态。图片 Seedream 4.0（4K 直出、单次 10 张参考图入、15 张关联组图出）、视频 Seedance、数字人 OmniHuman。

**画布功能（有两代并存）**：
- **智能画布（图层精修工作台）**：扩图（拖边缘）、局部重绘（矩形框选 + 笔刷两种选区，框选后写提示词**一次出 2–4 个候选**对比后应用）、超清放大 4×、发丝级抠图（出透明 PNG）、改文字（框选后 AI 匹配原字体/颜色/排版重排）、智能消除；多图层、非破坏编辑、全程可撤销。
- **无限画布（2025 新一代）**：左侧自由画布 + 右侧 Agent 对话区，图片在两侧之间直接拖动；批量 2K 组图、一次多尺寸；选中图浮出工具栏（重绘/消除/放分辨率/补帧）；多张图串成连贯视频 + AI 配乐一键成片。

**优势**：中文语义理解强；图→精修→视频→配乐→成片全链路闭环；Seedream 组图一致性是画布场景底层支撑；上手门槛低、生成快、多候选降低抽卡挫败感。

**劣势**：手部畸形是重灾区，局部重绘也难修好；重绘结果不稳（「奇葩风格」）；新模型能力未完整适配进画布；**付费体验滑坡吐槽最集中**（涨价、积分缩水、基础功能拆分收费、付费仍排队）；无协作。

**可借鉴**：框选 + 提示词 = 局部生成且**多候选「选卡」**；画布↔对话双向拖拽桥接；改文字工具；非破坏编辑心智。

### 2. LiblibAI / LibTV（liblib.art / liblib.tv）

**定位与模型**：三层矩阵——liblib.art（10 万+ 社区模型/LoRA + 在线 ComfyUI）、星流（Star-3 Alpha 设计 Agent）、**LibTV（2026-03 发布的无限画布 + 节点工作流视频创作平台，即用户给的 canvas 入口）**。模型走**中立聚合**路线：自研 + Seedream 5.0、Midjourney V7、可灵 3.0、Wan 2.6、Vidu 等 20+ 款，连竞品模型都接。

**画布功能（LibTV）**：
- 双击画布任意位置建节点；文本/图片/视频/音频/脚本 5 类节点，连线即工作流
- **工作流打组存为模板**加入工具箱，一键复刻（还可暴露给 Agent 当 Skill 调用——人与 Agent 双入口共享同一套能力）
- **斜杠命令**：输入 `/` 快速调用九宫格/25 宫格连贯分镜、剧情推演四宫格、角色三视图、画面推演
- **聚焦（Focus）**：在上游节点画面里**框选主体或局部**作为下游生成的参考——比传整张图更精准的引用粒度
- 画布内直接剪视频片段、视频放大 2/4/6×、帧率提升、分镜解析
- 图像工具集 10 项（增强/扩图/多角度/打光/重绘/擦除/抠图/宫格切分/标注/裁剪）
- 剧本→分镜→成片流水线，全程可单条重生成

**优势**：模型生态最强（一个画布内自由切换）；工作流「打组→模板→Skill」三级复用；价格激进（宣称比竞品低约 70%）；斜杠命令对创意卡壳场景针对性强。

**劣势**：产品太早期，很多能力在开发中；人物跨镜头一致性仍不稳；高峰排队；专业模式参数面板密、入口分散。

**可借鉴**：斜杠命令场景化生成器；聚焦框选；打组模板体系；画布内剪视频。**LibTV 是 MOMO 最直接的同构竞品，值得持续跟踪。**

### 3. 可灵AI（klingai.com，快手）

**定位与模型**：视频模型优先的创意生产力平台（全球 4500 万用户）。视频可灵 2.6（音画同出）→ 3.0（智能分镜、15 秒连续）→ O1（统一多模态编辑引擎）；图像可图 3.0。

**产品形态**：**没有自由画布**，是「功能入口 + 参数面板 + 生成队列」的经典工具形，但用模型能力实现了画布类产品的部分目标：
- **多图参考**：上传 1–4 张参考图并**框选图中的人/物/场景**，提示词描述互动生成融合视频
- **运动笔刷**：涂抹选区 + 手绘运动轨迹控制元素怎么动（「空间型 prompt」）
- **O1 对话式编辑**：无遮罩无关键帧，「移除路人」「白天改黄昏」一句话完成
- **主体库**：角色 = 脸 + 音色绑定，一致性做成可管理的资产实体
- 智能分镜、首尾帧、视频延长、对口型、专业运镜

**优势**：视频硬实力第一梯队；一致性方案（多图参考 + 主体库 + 音色绑定）最系统；API 成熟——「别人做画布，可灵做引擎」（LibTV 就接了可灵）。

**劣势**：贵且抽卡不退（5 秒视频约 3.5–10 元）；结果不稳定；排队久；**没有项目/画布组织能力**——这正是画布类产品的机会。

**可借鉴**：参考图框选主体；运动笔刷；主体库（一致性资产化）；对话式编辑把专业概念藏进自然语言。

---

## 二、国外九款重点分析

### 4. Krea.ai —— 实时生成 + 节点工作流

三套画布：**Realtime Canvas**（左画右出图 <50ms，支持手绘/摄像头/录屏/文本四种输入，**AI Strength 滑杆**一根轴解决「忠于草图↔放飞创意」）、编辑画布（inpaint/outpaint/背景替换/多模型切换）、**Krea Nodes**（端口按数据类型着色、从端口拖线到空白弹「可连节点」菜单、不跑模型的工具节点、分组/便签/section 整理、**Node App Builder** 把 30+ 节点工作流打包成 5–7 个输入的表单 App、**Node Agent** 自然语言自动搭节点图且计划审批制、**运行前逐节点显示算力成本**）。

- 优势：实时交互独一档；聚合 60+ 模型且自研开源（Krea Realtime 14B）；免费档慷慨。
- 劣势：**Trustpilot 约 2.7 分**——取消订阅继续扣款、客服只靠 Discord；低配硬件卡顿；结果不可复现。
- 可借鉴：AI Strength 单滑杆；运行前成本预估；工作流打包成 App；Node Agent 的「计划审批 + 动作落画布」姿势。

### 5. Recraft —— 原生矢量 + 风格资产化

面向职业设计师：真 SVG 生成（带路径锚点）、50+ 命名风格库 + **上传品牌素材训练自定义风格**、AI Mockup、位图转矢量、V4.1 图内长文排版；新增节点式工作流编辑器与 agentic 生成模式。
- 优势：矢量是护城河；**风格是可收藏/训练/复用的一等资产**，解决「批量出图不像一家人」。
- 劣势：SVG 锚点脏要人工清理；2025-02 全站故障 5 天+；尺寸控制不听话；免费档强制公开禁商用。
- 可借鉴：风格资产化思路（MOMO 风格预设节点可向「用户自建风格库」演化）。

### 6. Freepik Spaces（2026-04 起改名 Magnific）—— 节点协作画布

7 类节点（媒体/文本/图像/视频/音频/工具/内嵌设计编辑器）；**类型安全连线**（不兼容的线拉不出来）；**Spotlight 添加节点**（空格或 `/` 呼出搜索面板键入即定位）；**列表节点 = 批处理原语**（一组输入批量过同一管线）；节点级评论 + 多人光标协作；工作流存为可复用 app；拖参考图代替写 prompt。
- 优势：生态整合（AI + 2.5 亿库存素材 + 放大 + 设计编辑器一张画布）；20 分钟上手；母公司 $230M ARR 盈利。
- 劣势：**失败也扣 credits 无退款**（Reddit 头号抱怨）；「无限生成」政策反悔坑老用户。
- 可借鉴：Spotlight 键盘流加节点；列表节点批处理；内嵌编辑器作为节点。

### 7. Flora —— 节点画布范式先驱

Text/Image/Video 三种 Block + 连线即上下文（上游输出自动成为下游输入——与 MOMO `collectUpstream` 同源）；**所有创意分支同屏可见、随时回溯重混**；**Ctrl+F 画布内搜索节点并高亮**；**模板直接在画布「播种」一套连好线的工作流**；Fauna agent 每个生成步骤都落为画布上可观察/可干预/可复现的节点；生成前显示按模型计的真实单价。
- 优势：UX 打磨最精（Nike/Netflix/Pentagram 客户）；分支探索哲学；团队定价友好。
- 劣势：节点思维对非技术创意人门槛高；视频贵且不稳；免费档只够试用。
- 可借鉴：Ctrl+F 搜节点；模板播种；agent 产物全部落节点。

### 8. Weavy（现 Figma Weave，$200M 被收购）—— 专业节点工作流

12 家模型聚合 + 可导入自己的 LoRA；**同一提示词接多个模型节点并排 A/B，选优继续向下游走**；约 12 项专业编辑全部节点化非破坏（图层/文字/混合模式/裁剪/inpaint/**重打光**/upscale/色阶/遮罩）；改上游节点下游自动更新；工作流转「简化 UI 工具」给团队填参数。
- 优势：多模型一张画布全打通、图像→视频→编辑全链路业内公认最顺；「便宜模型迭代、贵模型出片」策略天然可行。
- 劣势：月费之外每次生成烧积分（Veo 单次约 120 积分）；不面向休闲玩家；收购后独立产品前景存疑。
- 可借鉴：**同节点换模型 A/B 对比**；编辑操作节点化让精修进入可复现管道；节点标成本。

### 9. OpenArt —— 聚合平台 + 工作流社区

100+ 模型、自训 LoRA、图层式 Edit Canvas、角色一致性（文本/单图/多图三种建法 + 姿态编辑器）、全球最大 ComfyUI 工作流分享社区（可下载 workflow JSON）、**Recipes 把多步工作流表单化**、**社区作品自带完整参数 + 一键 Remix**、一键故事视频。
- 劣势（口碑反面教材）：失败照扣积分是最高频投诉；积分过期不结转且有暗改；Character 2.0 改版把用户已有资产追溯锁进新收费体系引发爆发性不满；客服以周计。
- 可借鉴：**资产带参数快照 + 一键 Remix**；Recipes 表单化；以及教训——积分体系暗改是口碑毁灭器（MOMO 本地 + 自带 Key 天然免疫，可作宣传点）。

### 10. Visual Electric（2026-01 已关停）—— 设计师画布的教训

一次出 4 张直接铺画布空间化比稿；60+ 风格预设且**可从 moodboard 反推自定义风格**；Touch Up 笔刷局部重生成；带「创意度滑杆」的变体；Art Director 提示词润色。被 Perplexity 收购后关停。
- 教训：「只有画布 + 生图」的单点形态在模型商品化时代无法独立存活——画布必须叠加工作流/资产/多模态纵深。
- 可借鉴：多联生成直接落画布比稿；创意度滑杆；风格对象化。

### 11. Invoke AI（开源）—— 重绘画布天花板，对 MOMO 参考价值最高

**Unified Canvas**：文生图/图生图/重绘/扩图统一为一个心智模型——**Bounding Box 取景器**：框移到空白处 = 扩图，框住已有内容 = 重绘，框在哪生成哪。Raster + 蒙版图层（Q 键切换）；**控制条件即图层**（ControlNet 骨架图是画布上可见可改的图层）;**Regional Guidance 区域提示词**（刷遮罩给局部单独写提示）；**staging 候选区**（新生成先进候选条逐张接受/丢弃，不污染画布）；带图层导出 PSD。团队 2025-10 进 Adobe，开源版社区维护。
- 优势：inpaint/outpaint 交互业内最佳；学习曲线温和；免费开源本地私有。
- 劣势：无视频；新模型适配慢于 ComfyUI；性能弱。
- 可借鉴：**Bounding Box 范式、staging 候选区、区域提示词**——MOMO 路线图上的「局部重绘节点」应直接对标这套交互。

### 12. Leonardo.ai（Canva 旗下）—— 全家桶 + 实时画布

Realtime Canvas（草图约 2 秒实时出图 + Guidance 滑杆，上限 512/640 需再放大）；Canvas Editor（inpaint/outpaint/**擦除替换笔刷**、可对局部换模型重生成）；**Flow State「维度化随机」**：一个提示词持续生成无尽变体流，可锁 Vibe/光线/镜头/色彩四个维度或随机化，点 More Like This 定向发散。
- 劣势：token 消耗随 GPU 负载浮动、失败照扣、账单投诉集中；免费作品强制公开。
- 可借鉴：**Flow State 的维度锁定变体**（比「再来一批」聪明得多）；擦除替换笔刷；局部换模型。

---

## 三、行业趋势洞察

1. **节点画布已是收敛范式**——MOMO 方向被 Flora/Krea/Freepik/Recraft/LibTV 集体验证，不用怀疑路线。
2. **下一战场是 Agent 搭工作流**：Krea Node Agent（一句话生成节点图 + 计划审批制）、Flora Fauna（迭代推荐变体）、LibTV（人/Agent 双入口）。共识设计原则：**agent 的每一步动作都落为画布上可见、可干预、可复现的节点**，反黑箱。
3. **成本透明是口碑生死线**：失败扣费（Freepik/OpenArt/Leonardo）、积分暗改（OpenArt）、扣款纠纷（Krea）是全行业最大差评来源。Krea/Flora 的「运行前显示本次消耗」是最佳实践。**MOMO 自带 Key 模式天然没有平台抽成焦虑，应作为核心卖点明示。**
4. **一致性方案收敛**：主体/角色资产化（可灵主体库、OpenArt 角色库）+ 参考图框选局部（可灵多图参考、LibTV 聚焦）。MOMO 的角色卡 + 角色库 + @参考图已踩在正确方向上，可继续深化。
5. **工作流的两级消费**：专业者搭节点图，普通人用表单（Krea Node App、OpenArt Recipes、Weavy 简化 UI、LibTV 打组模板）——「把复杂图收敛为几个输入」是复用与分享的关键抽象。
6. **可靠性 > 功能数量**：Krea/Recraft 最大差评都不是生成质量而是稳定性/计费。桌面端在离线韧性、任务中断恢复上有天然优势（MOMO 的 `INTERRUPTED_MSG` 中断标记已是正确做法）。

---

## 四、可加入 MOMO 的功能清单（按优先级）

> 已排除 MOMO 已有能力：节点连线/类型化端口/防环、拖线出空白建节点、双击建节点、贴近/叠放自动连线、组、画布标签页、撤销重做、@参考图、提示词 AI 扩写、风格预设、角色卡/角色库、打光/多角度节点、资产库拖入拖出、ComfyUI 模板、自定义快捷键等。

### P0 —— 高价值，与现有架构契合，优先做

| # | 功能 | 抄谁 | 为什么值得做 / 易用性设计要点 | 落地思路（结合 MOMO 架构） |
|---|---|---|---|---|
| 1 | **局部重绘（蒙版）节点**（路线图已列） | 即梦 + Invoke | 全竞品标配、用户预期基线。易用性关键三点：① 框选/笔刷两种选区（即梦）② **一次出 2–4 候选「选卡」而非单张赌博**（即梦）③ 新结果先进候选区再应用，不直接覆盖（Invoke staging） | 新增 `inpaint` 节点：灯箱里做蒙版编辑器（canvas 涂抹导出蒙版 dataURL）；service 层生图协议大多支持 image+mask；ComfyUI 路径也可跑 |
| 2 | **放大/增强节点**（路线图已列） | LibTV / Krea / 即梦 | 出片刚需，且是重绘链路的下游标配（先重绘后放大）。给 2×/4× 档位即可，不要参数轰炸 | 优先走 ComfyUI 模板（本地免费），API 模型（如支持的中转站）作备选 |
| 3 | **一次多张候选 + 选卡** | 即梦 / Invoke / Visual Electric | 把「抽卡」变「选卡」是降低挫败感最有效的单点改进。生图节点加「张数 n」，结果以候选条展示，点选采用、其余仍收进资产库 | imageGen 服务多数支持 `n` 参数或循环调用；节点 data 存 `candidates[]`，选中者为输出 |
| 4 | **画布内搜索节点（Ctrl+F）** | Flora | 大画布刚需，成本极低收益高：按节点标题/类型/提示词内容搜索，命中后视口飞过去并高亮 | boardStore 里全量节点过滤 + `setCenter`；配自定义快捷键体系 |
| 5 | **Spotlight 快速添加节点** | Freepik / LibTV | 键盘流：空格或 `/` 呼出搜索面板，键入「生图」回车即在光标处建节点。比翻工具坞快，且天然承载未来更多节点类型 | 复用 `NODE_CATALOG` 做模糊过滤；与现有快速菜单合并实现 |
| 6 | **资产参数快照 + 一键 Remix** | OpenArt | 资产库已自动收录生成物，补记生成参数（提示词/模型/尺寸/上游引用）后：资产卡「Remix」拖回画布直接还原成配置好的生成节点。让资产库从「仓库」变「工作流起点」 | runner 写回时把请求参数存入资产 meta；assetStore 已有拖回画布通道，扩展为带参还原 |

### P1 —— 中等成本，显著提升竞争力

| # | 功能 | 抄谁 | 说明 | 落地思路 |
|---|---|---|---|---|
| 7 | **聚焦/局部引用节点** | LibTV「聚焦」/ 可灵多图参考 | 在上游图片上框选一个区域，输出该局部作为下游参考——比传整图精准一个粒度，是一致性利器 | 新增 `crop` 类编辑节点或图片节点内加「框选输出区域」；纯 canvas 裁剪，无模型成本 |
| 8 | **扩图（outpaint）节点** | 即梦 / Krea / Invoke | 与局部重绘共用蒙版基建：画布外扩 = 反向蒙版。Invoke 的「框移到哪生成哪」心智可简化为方向按钮 + 比例 | 与 #1 共用 image+mask 通道；Gemini/GPT 系生图均可做 |
| 9 | **抠图/去背节点** | 即梦（发丝级）/ Krea 工具节点 | 高频刚需，输出透明 PNG 进资产库 | ComfyUI rembg 模板零成本起步；也可接支持的 API |
| 10 | **组 → 模板/自定义节点** | LibTV 打组 / Krea Node App / Weavy | 把连好线的组保存为可复用模板，重新实例化时只暴露关键输入（提示词/参考图）。这是「工作流两级消费」的桌面端形态 | MOMO 已有组 + Comfy 模板管理器两套基建，做「画布组模板」是二者的自然合流 |
| 11 | **多模型对比运行** | Weavy / Krea | 生成节点上「对比模式」：同一输入并行跑选中的 2–4 个模型卡，结果并排落为多个图片节点。BYO-Key 多卡片体系（`providerId::model`）是现成地基，这是 MOMO 比云端竞品更适合做的功能 | runner 对同一节点循环多张模型卡并行调用；结果节点自动横排 + 连线 |
| 12 | **模板播种画布** | Flora / Freepik | 新手打开不是空白画布，而是可一键插入「文生图精修链」「角色三视图链」「分镜四格链」等连好线的示例工作流 | 内置 3–5 套节点+边的 JSON 预设；从添加坞/Spotlight 进入 |
| 13 | **创意度/强度滑杆** | Krea AI Strength / VE / Leonardo | 图生图的 denoise/strength 抽象成一根「像原图 ↔ 放飞」滑杆，藏掉专业术语 | GenConfigPanel 按模型家族映射到对应参数（modelMeta 已有家族推断机制） |

### P2 —— 长期方向 / 大工程

| # | 功能 | 抄谁 | 说明 |
|---|---|---|---|
| 14 | 区域提示词 | Invoke Regional Guidance | 蒙版基建成熟后的进阶：不同区域不同提示词 |
| 15 | 视频节点内剪辑/取段 | LibTV | 「5 秒里只有 2 秒能用」场景；视频链路加强后再做 |
| 16 | **AI 布线助手（Agent 搭工作流）** | Krea Node Agent / Flora Fauna | 对话描述意图 → agent 生成节点图（先出计划待确认）→ 逐步落节点可干预。MOMO 有 chat 节点 + runner + 节点目录，具备地基；是画布类产品的下一代竞争点 |
| 17 | 运动笔刷 | 可灵 | 视频方向的「空间型 prompt」，依赖模型侧支持 |
| 18 | 音乐/音频节点（路线图已列） | LibTV（ElevenLabs/Mureka） | 等模型接入扩充 |
| 19 | 主体库扩展 | 可灵主体库 | 角色库从「人物」扩展到「物品/场景」一致性资产 |
| 20 | 改文字工具 | 即梦 | 海报场景：框选文字区 AI 匹配原字体重排（依赖模型能力） |

### 明确不建议做的

- **实时生成画布**（Krea/Leonardo Realtime）：需要本地扩散模型或专用低延迟推理链路，与 MOMO「BYO API Key」架构不符，且 Leonardo 证明 512px 上限的实时画布只是玩具。
- **多人协作/评论**：桌面单机定位，投入产出比极低。
- **原生矢量生成**（Recraft）：纯模型侧能力，非画布层能解决。

---

## 五、对 MOMO 的定位建议

竞品的最大差评几乎全部集中在「计费与信任」：失败扣费、积分暗改、订阅难取消、政策反悔。MOMO 的**本地桌面 + 自带 API Key + 数据私有（AppData 本机存储）**组合天然免疫全部这些问题，且没有一家头部产品占据这个生态位（Invoke 最接近但无视频、无聚合 API、团队已进 Adobe）。建议在 README/宣传中明确这一定位：

> **「你的模型、你的 Key、你的硬盘——无积分焦虑的节点式 AI 创作画布。」**

功能侧的三步走：① 用 P0 补齐「编辑闭环」（重绘/放大/多候选），让生成物不出画布就能精修——这是与竞品的表面差距；② 用 P1 放大「多模型 BYO-Key」独有优势（多模型对比、组模板、Remix）；③ P2 的 Agent 布线是范式级机会，等 P0/P1 地基打完再上。

---

## 附：主要信息来源

- 即梦：[即梦教程·智能画布](https://runyoung0613.github.io/jimeng-tutorial/charpter/ch09-%E6%99%BA%E8%83%BD%E7%94%BB%E5%B8%83.html) · [腾讯新闻·无限画布](https://news.qq.com/rain/a/20251107A01IDK00) · [AIProductHub 全解析](https://aiproducthub.cn/jimeng-ai-full-analysis-of-functions-usage-methodsadvantages-and-disadvantages-and-latest-dynamics/)
- LiblibAI：[腾讯新闻·LibTV 深度实测](https://news.qq.com/rain/a/20260319A05XAY00) · [AIHub·LibTV](https://www.aihub.cn/tools/libtv/) · [AIHub·星流](https://www.aihub.cn/tools/design/xingliu/)
- 可灵：[量子位·年末连更](https://www.qbitai.com/2025/12/360022.html) · [中国日报·可灵O1](https://caijing.chinadaily.com.cn/a/202512/02/WS692e8a8ba310942cc49947dc.html) · [快手IR·多图参考](https://ir.kuaishou.com/news-releases/news-release-details/kuaishou-kling-ai-unveils-multi-image-reference-feature-further/)
- Krea：[Nodes 文档](https://www.krea.ai/docs/user-guide/features/nodes) · [Node Agent 公告](https://www.krea.ai/blog/ai-workflow-agent) · [Trustpilot](https://www.trustpilot.com/review/krea.ai)
- Recraft：[V4 发布](https://recraft.canny.io/changelog/introducing-recraft-v4-our-latest-design-led-model) · [DesignWhine 评测](https://www.designwhine.com/recraft-ai-review/)
- Freepik Spaces：[官方通稿](https://www.businesswire.com/news/home/20251104023735/en/) · [Spaces 文档](https://www.magnific.com/ai/docs/introduction-to-spaces) · [Magnific 改名](https://thenextweb.com/news/freepik-rebrands-as-magnific)
- Flora：[定价与团队模式](https://flora.ai/blog/a-new-pricing-model-for-flora-plus-nano-banana-on-us) · [Fauna agent](https://ppc.land/floras-fauna-the-ai-creative-agent-that-fights-back-against-generic/)
- Weavy：[Figma 收购](https://techcrunch.com/2025/10/30/figma-acquires-ai-powered-media-generation-company-weavy/) · [Chase Jarvis 评测](https://chasejarvis.com/blog/what-the-heck-is-weavy-the-100-honest-review-after-the-figma-acqusition/)
- OpenArt：[MimicPC 深评](https://www.mimicpc.com/learn/in-depth-openart-ai-review) · [belreos 口碑汇总](https://belreos.com/tools/openart)
- Visual Electric：[Perplexity 收购关停](https://techcrunch.com/2025/10/02/perplexity-acquires-the-team-behind-sequioa-backed-ai-design-startup-visual-electric/)
- Invoke：[v6.0.0 Release](https://github.com/invoke-ai/InvokeAI/releases/tag/v6.0.0) · [Bounding Box 文档](https://support.invoke.ai/support/solutions/articles/151000096702-inpainting-outpainting-and-bounding-box) · [团队进 Adobe](https://softuts.com/invokeai-commercial-platform-shuts-down-open-source-project-continues/)
- Leonardo：[Realtime Canvas 帮助](https://intercom.help/leonardo-ai/en/articles/8658301-realtime-canvas) · [Flow State](https://leonardo.ai/fast-track-your-creativity-with-flow-state) · [knowara 评测](https://knowara.com/ai-tools/image/leonardo-ai-review/)
