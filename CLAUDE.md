# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目

MOMO 智能画布：Tauri 2 (Rust 壳) + React 19 + TypeScript + React Flow (@xyflow/react) + Zustand 的桌面 AI 创作工作站。单一画布范式——图片、提示词、对话、生图、生视频、ComfyUI 工作流都是画布节点，连线即工作流。UI 文案、代码注释、commit message 全部使用中文。

## 常用命令

```bash
pnpm tauri dev      # 开发运行（Vite 固定端口 1420，被占用会直接失败）
npx tsc --noEmit    # 类型检查（最常用的验证手段；本项目无测试、无 lint 配置）
pnpm build          # tsc && vite build，仅前端产物，可作完整验证
pnpm tauri build    # 打包发行版 —— 仅在用户明确要求时执行
```

开发闭环：`.claude/settings.json` 配置了 Stop hook（`.claude/hooks/restart-app.ps1`），每轮结束时自动确保 dev 应用在跑（健康实例不会被杀，Vite HMR / tauri dev 自身热更新即可生效；日志在 `.claude/dev-server.log`）。**不要手动启动 `pnpm tauri dev`**，改完代码结束回合即可看到效果。

## 架构（分层，依赖只向下）

```
src/core/types.ts     全部共享类型的唯一来源：节点 data、设置（含历次迁移的 Legacy 类型）、资产、ComfyUI 模板
src/core/stores/      Zustand stores；React 外部一律用 useX.getState() 访问
src/core/services/    纯协议适配层：吃 ModelCard + 请求参数，吐结果，不碰 store
src/core/runner.ts    节点运行引擎：收集上游 → 调 service → 结果写回节点 + 收录资产库
src/modules/          React UI（canvas / assets / shell / settings / comfy）
src/ui/               手绘 SVG 图标集 icons.tsx、轻组件 kit.tsx、ModelPicker、Thumb
src/styles/theme.css  双主题设计令牌（云白/深空蓝），样式只用 var(--token)
src-tauri/            Rust 壳，仅插件配置（dialog/fs/http/store/opener + asset 协议），无自定义命令
```

### 数据流转（读懂 runner.ts 即读懂本项目）

- 端口两类：**text（紫）/ image（蓝）**，同色才能连（`outPortType` / `NODE_INPUTS` 定义在 boardStore）。
- `collectUpstream(nodeId)` 递归收集直接前驱的输出；拼接/风格预设等纯文本节点会向上物化自己的输出；组节点按成员位置排序聚合；`data.ignored` 的节点不向下游传递。
- 生成节点提示词留空时自动取上游文本；连了上游图片自动转图生图。
- 节点上的「生成/运行」按钮统一走 `runFlow(id)`：DFS 后序把上游可运行节点按依赖顺序先跑一遍再跑自己；`runAllFlows()` 按连通分量并行、分量内串行。可自动运行的节点类型登记在 `RUNNERS` 表（对话节点需用户输入，不参与）。

### 模型配置（改动设置结构必看）

- `ProviderCard`（服务商卡片）：一个 Base URL + API Key，含 chat/image/video 三个 `RoleSlot`，每槽 `models: string[]` 多模型。
- 节点/默认选模用复合键 **`providerId::model`**（`modelKey` / `splitModelKey`），旧数据可能只有 providerId。
- 服务层只消费扁平化的 `ModelCard`，入口是 `resolveModelCard(role, key?)`：节点指定 > 角色默认 > 第一家可用，无可用时抛中文提示。
- 设置结构已历经 v1→v2→v3→v4 迁移（Legacy 类型都在 types.ts）。**改 Settings 结构必须同步加迁移**，加载路径是 settingsStore 的 `normalize()`。
- `modelMeta.ts` 按模型名推断生图「家族」（banana / gpt / generic），决定 GenConfigPanel 展示哪组参数、runner 发哪些字段。

### 新增节点类型的完整清单

1. `types.ts`：加 `NodeKind` 成员 + `XxxData` 类型（必含 `status` / `error`）
2. `boardStore.ts`：`defaultData` / `outPortType` / `NODE_INPUTS` / `NODE_LABEL`
3. `nodeCatalog.tsx`：加入 `NODE_CATALOG`（添加坞/快速菜单共用）
4. `nodes/XxxNode.tsx`：用 `NodeShell` 包裹、`memo` 导出，在 `SmartCanvas.tsx` 的 nodeTypes 注册
5. 可运行的：`runner.ts` 加 `runXxx` 并登记进 `RUNNERS`

## 关键约定

- **报错**：service 层抛带中文信息的 `Error`；runner 捕获后走 `pushError(source, msg)`（uiStore）→ 报错中心（标题栏铃铛）+ 可点击 toast。不要裸 `toast(..., "err")` 报运行类错误。
- **节点内大图必须用 `<Thumb>`**（`src/ui/Thumb.tsx`）而非 `<img>`：图片全程是 dataURL，原图直塞 img 会让画布拖动掉帧；原图仅用于灯箱预览/保存/传模型。
- React Flow 节点内的可交互元素加 `nodrag` class，否则拖不了输入框选不了文本。
- 持久化走 `persist.ts` 的 `loadJSON/saveJSON`：Tauri 下是 tauri-plugin-store（AppData JSON），纯浏览器预览退回 localStorage。`isTauri` 判定环境——所有功能需兼容浏览器预览模式（降级即可，不能白屏）。
- 网络请求用 `services/http.ts` 的 `xfetch`（Tauri plugin-http 绕 CORS，浏览器退回 fetch）。
- 中转站返回格式五花八门：imageGen 的 `normalizeResults` 做了大量兼容解析，改动时保持宽容。
- 画布载入时 `sanitizeNodes` 会把上次退出时 `running` 的节点标成中断错误（`INTERRUPTED_MSG`），不能静默重置。
- 撤销/重做快照、贴近自动连线、防环（`wouldCycle`）都在 boardStore，改节点/边操作时留意是否需要入历史。
- 新图标手绘 SVG 加进 `src/ui/icons.tsx`，不引第三方图标库。

## 其他

- 包管理器是 **pnpm**。数据/密钥存本机 AppData（`site.jinpengi.momo`），API Key 明文，不要提交任何真实 Key。
- 产品路线图（未完成事项）维护在 README.md「路线图」一节。
