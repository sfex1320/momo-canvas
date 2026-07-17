# MOMO 智能画布

一款以「智能画布」为核心的 AI 创作工作站。单一画布范式：把图片、提示词、对话、生图、视频、ComfyUI 工作流都变成画布上的节点，连线即工作流。

> 技术栈：Tauri 2 (Rust) · React 19 · TypeScript · React Flow (@xyflow) · Zustand
> 目标平台：Windows（主）/ macOS（后续分发）

## 启动

```bash
pnpm install
pnpm tauri dev      # 开发调试
pnpm tauri build    # 打包发行（需明确要求时再执行）
```

## 功能地图

| 模块 | 说明 |
| --- | --- |
| 智能画布 | 11 种节点，三组：输入（图片/提示词/风格预设/备注）· 智能（对话/反推描述/文本处理/拼接文本）· 生成（生成图像/生成视频/ComfyUI） |
| 模型配置 | **卡片式多套配置**：对话/绘画/视频三类各可添加任意多张卡（同一中转站可配多套模型），单选默认，节点上可单独选用 |
| 多协议 | 对话：OpenAI 兼容 / Anthropic Claude / Google Gemini；绘画：OpenAI images / Gemini 生图；视频：智谱 / 硅基流动 / OpenAI 任务式 |
| 资产库 | 独立模块：画布生成内容自动落盘收录；分类分区、文件夹、条件筛选、批量删除/移动；缩略图卡片 + 原分辨率预览（图片/视频/音频/PDF） |
| 联网搜索 | Tavily / 博查 / SearXNG，对话节点一键开关，回答带来源 |
| 图片保存 | 保存目录、PNG/JPG/WebP、命名模板、生成后自动保存（独立于资产库收录） |
| ComfyUI | 直连本地服务；导入 API 格式工作流 → 勾选暴露输入/参数/输出节点 → 存为模板 → 画布节点直接运行 |
| 生成记录 | 会话内时间线（右侧坞），完整历史在资产库 |
| 主题 | 云白 / 深空蓝，标题栏一键切换 |

## 画布操作

| 操作 | 方式 |
| --- | --- |
| 平移 / 缩放 | 中键/右键拖拽 或 Space+左键；滚轮缩放 |
| 框选 | 左键拖拽空白处；Shift/Ctrl 加选 |
| 添加节点 | 双击空白 · 底部工具坞点击/拖放 · 从输出端口拖线到空白处 |
| **贴近自动连线** | 把节点拖到另一节点的左/右侧贴近（≤90px 且纵向有重叠）松手，自动按端口类型连线 |
| 撤销 / 重做 | Ctrl+Z / Ctrl+Y（右下角也有按钮） |
| 导入图片 | 拖入文件 / Ctrl+V 粘贴 / 图片节点点击导入 |
| 复制 / 删除 | Ctrl+D / Del；适应全部：F；沉浸模式：Tab |

## 数据流转规则

- 端口分两类：**紫色 = 文本**，**蓝色 = 图片**，只允许同色连接。
- 生成节点提示词留空时，自动取上游文本（提示词/对话/反推/文本处理/拼接/风格预设）。
- 拼接文本会递归物化其上游；风格预设输出选中片段的英文串。
- 生成节点连接上游图片时自动转为图生图（ComfyUI 依次填入图片参数并自动上传）。
- 每个生成/智能节点可在节点上单独选择模型卡片，默认跟随「设置 → 模型配置」中的单选默认。

## 目录结构（模块化）

```
src/
  core/
    services/      llm(3协议) / imageGen(2协议) / videoGen(3协议) / webSearch / comfy / imageSaver / assetFiles / http
    stores/        settings(模型卡片v2) / board(撤销重做+贴近连线) / comfy / assets / ui
    runner.ts      节点运行引擎（上游递归收集 → 调服务 → 回写 + 收录资产库）
    stylePresets.ts 内置风格片段库
  modules/
    canvas/        SmartCanvas + 11 种节点 + 添加坞 + 快速菜单
    assets/        资产库（分类/文件夹/筛选/批量/全格式预览）
    shell/         标题栏 / 生成记录坞
    settings/      设置面板（卡片式模型配置）
    comfy/         工作流模板管理器
  ui/              SVG 图标集 + 轻量组件 + ModelPicker
  styles/          设计令牌（双主题）+ 基础样式
src-tauri/         Rust 壳（dialog / fs / http / store / opener + asset 协议）
```

## 数据存放

- 设置 / 画布 / 模板 / 资产索引：AppData（tauri-plugin-store JSON）。
- 资产文件：`AppData/site.jinpengi.momo/assets/`（缩略图在 `assets/thumbs/`），删除资产会同步删除磁盘文件。
- API Key 以明文存本机配置文件，请勿把 AppData 目录同步到公共位置。

## 路线图

- [ ] ComfyUI WebSocket 实时进度 / 节点级进度条
- [ ] 局部重绘（蒙版）节点、放大节点
- [ ] 音乐生成节点（等模型角色扩充）
- [ ] 资产库标签系统与拖拽入画布
- [ ] macOS 打包分发
