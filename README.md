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
| 智能画布 | 6 种节点：图片 / 提示词 / 对话 / 生成图像 / 生成视频 / ComfyUI |
| 模型配置 | 对话（多模态+思考+流式）、绘画、视频三类，OpenAI 兼容接口 |
| 联网搜索 | Tavily / 博查 / SearXNG 三种提供商，对话节点一键开关 |
| 图片保存 | 保存目录、PNG/JPG/WebP、命名模板（{date} {time} {model} {prompt} {seed}）、生成后自动保存 |
| ComfyUI | 直连本地服务；导入 API 格式工作流 → 勾选暴露输入/参数/输出节点 → 存为模板 → 画布节点直接运行 |
| 生成记录 | 会话内全部生成结果时间线，可定位节点 / 保存 |
| 主题 | 云白（白色）/ 深空蓝（偏蓝深色），标题栏一键切换 |

## 画布操作

| 操作 | 方式 |
| --- | --- |
| 平移 | 中键 / 右键拖拽，或按住 Space + 左键 |
| 缩放 | 滚轮（光标为中心） |
| 框选 | 左键拖拽空白处；Shift/Ctrl 加选 |
| 添加节点 | 双击空白 · 底部工具坞点击/拖放 · 从输出端口拖线到空白处 |
| 导入图片 | 直接拖入文件 / Ctrl+V 粘贴 / 图片节点点击导入 |
| 复制节点 | Ctrl+D；删除：Del |
| 适应全部 | F；沉浸模式（隐藏 UI）：Tab |

## 数据流转规则

- 端口分两类：**紫色 = 文本**，**蓝色 = 图片**，只允许同色连接。
- 生成节点提示词留空时，自动取上游「提示词/对话」文本。
- 生成节点连接上游图片时自动转为图生图（ComfyUI 则依次填入图片参数并自动上传）。
- 对话节点会把上游图片作为视觉输入随消息发送。

## 目录结构（模块化）

```
src/
  core/            类型、工具、持久化
    services/      llm / imageGen / videoGen / webSearch / comfy / imageSaver / http
    stores/        settings / board / comfy / ui （Zustand）
    runner.ts      节点运行引擎（收集上游 → 调服务 → 回写结果）
  modules/
    canvas/        SmartCanvas + 6 种节点 + 添加坞 + 快速菜单
    shell/         标题栏（无边框窗口）/ 生成记录坞
    settings/      设置面板
    comfy/         工作流模板管理器
  ui/              SVG 图标集 + 轻量组件
  styles/          设计令牌（双主题）+ 基础样式
src-tauri/         Rust 壳（dialog / fs / http / store / opener 插件）
```

## 配置存放

- 设置 / 画布 / 模板均存于系统 AppData（tauri-plugin-store JSON 文件）。
- API Key 以明文存本机配置文件，请勿把 AppData 目录同步到公共位置。

## 路线图

- [ ] 撤销 / 重做
- [ ] 节点结果的资产库（磁盘化，减小画布存档体积）
- [ ] ComfyUI WebSocket 实时进度 / 节点级进度条
- [ ] 局部重绘（蒙版）节点、放大节点
- [ ] 提示词卡片库（迁移 mengbi promptMall 数据）
- [ ] macOS 打包分发
