# MOMO × Eagle 点对点资产桥实施规格

> 文档用途：直接交给 GLM 或其他编码代理，在现有 MOMO 智能画布中实现 Eagle 资产库双向衔接。
>
> 文档回答三个问题：**做什么、怎么做、为什么这样做**。
>
> 核验日期：2026-08-27。
>
> 首版基线：Windows 桌面版 MOMO（Tauri 2）与本机 Eagle 4.0 Build 21+；推荐 Eagle Build 22 或更新版本。

---

## 0. 给编码代理的强制要求

实现前必须完整阅读仓库根目录 `AGENTS.md`，并遵守其中的中文 UI、中文注释、中文提交信息、设置迁移、错误中心、资产落盘和浏览器预览降级约定。

不得一口气完成全部阶段。必须按本文阶段顺序实施，每一阶段先通过验收，再进入下一阶段。

必须遵守以下红线：

1. 不直接修改 Eagle 素材库中的 `metadata.json`。
2. 不让 MOMO 与 Eagle 共用同一个可写物理文件，不使用软链接或硬链接。
3. 不在同步时自动永久删除另一端文件。
4. 不把整个 Eagle 素材库一次性复制进 MOMO。
5. 不用 `getAll()` 高频全库扫描；必须使用分页、限定范围和 `modifiedAt` 增量检查。
6. 不因 Eagle 未启动、版本过低或插件未安装导致 MOMO 白屏或资产库不可用。
7. 大视频和音频不得整文件读入前端内存后再复制；必须走 Rust 流式文件复制与流式指纹。
8. MOMO 生成任务完成不能等待 Eagle 同步完成；同步只能异步入队。
9. 同一同步任务重复执行必须幂等，不能在 Eagle 中不断产生重复副本。
10. 第三方 Eagle 插件没有统一远程调用协议时，不得假装可以从 MOMO 调用全部插件。MOMO 负责接收插件处理后的结果。

实现时优先使用 Eagle 官方 Web API V2 和 Plugin API：

- Web API V2：<https://developer.eagle.cool/web-api>
- Item API：<https://developer.eagle.cool/plugin-api/api/item>
- Folder API：<https://developer.eagle.cool/plugin-api/api/folder>
- 后台服务插件：<https://developer.eagle.cool/plugin-api/get-started/plugin-types/service>
- Inspector 插件：<https://developer.eagle.cool/plugin-api/get-started/plugin-types/inspector>
- AI Search：<https://developer.eagle.cool/plugin-api/extra-module/ai-search>

Eagle Web API V2 仍在演进。编码前必须在用户当前 Eagle 的 API Playground 中核对实际端点、请求字段和返回字段，所有差异只允许收口在 `eagleApi.ts`，UI、store 和同步引擎不得直接拼端点。

---

## 1. 做什么

### 1.1 产品定位

MOMO 与 Eagle 不互相替代：

```text
MOMO  = 生成、画布编排、导演台、Agent 决策、版本采用
Eagle = 收集、浏览、整理、搜索、查重、插件加工、长期素材记忆
```

本功能命名为：

```text
MOMO × Eagle 资产桥
```

用户最终应获得一条闭环：

```text
MOMO 生成作品
  → 自动进入 MOMO 资产库
  → 后台同步到 Eagle
  → 在 Eagle 中浏览、分类、搜索、查重或用插件处理
  → 处理结果作为新版本回到 MOMO
  → 继续进入画布、导演台或下一轮生成
```

### 1.2 首版必须完成的用户能力

1. MOMO 自动检测本机 Eagle 是否运行、版本和当前素材库。
2. 用户在设置中启用 Eagle 连接，选择或创建 `MOMO` 根文件夹。
3. MOMO 新生成的图片、视频、音频、SVG、PDF 可异步推送到 Eagle。
4. MOMO 资产卡可手动执行“同步到 Eagle”“在 Eagle 中打开”“解除绑定”。
5. MOMO 可分页浏览、关键词搜索 Eagle 素材，但不自动复制全部文件。
6. 用户把 Eagle 素材用于 MOMO 时，文件复制进入 MOMO AppData 后再建立资产。
7. MOMO 与 Eagle 之间同步名称、标签、说明、评分和文件夹映射。
8. 同一个 MOMO 资产重复同步不会产生重复 Eagle 项目。
9. Eagle 文件变化后，MOMO 能检测到，并以非破坏方式生成新版本。
10. 任意一端不可用时，任务进入可重试队列，不影响本地资产使用。

### 1.3 第二阶段插件能力

开发 `MOMO Link for Eagle` 插件套件：

- 后台服务插件：连接状态、同步通知、选中素材发送到 MOMO、同步队列和冲突入口。
- Inspector 扩展：在 Eagle 右侧显示 MOMO 来源、提示词、模型、项目、片段、Take 和操作按钮。
- Eagle 中选中素材后可以：
  - 发送到 MOMO 当前画布；
  - 作为导演台参考图、首帧、尾帧、参考视频或参考音频；
  - 在 MOMO 中定位；
  - 请求 MOMO 放大、矢量化、生成变体、图生视频；
  - 接收 MOMO 结果并默认创建衍生版本。

### 1.4 智能阶段能力

- MOMO 创作助手以自然语言检索 Eagle。
- 用当前图片做 Eagle 相似图检索，自动建立参考板。
- 利用 Eagle AI Action 的命名、描述、分类、标签和评分结果反哺 MOMO。
- 利用 Eagle 颜色、形状、智能文件夹和查重能力治理批量生成结果。
- 根据素材使用记录向导演台推荐人物、场景、道具和空间站位参考。

### 1.5 非目标

首版不做：

- 在 MOMO 内复刻 Eagle 完整界面。
- 远程控制每一款第三方 Eagle 插件。
- 跨机器或公网同步。
- 团队多用户合并。
- 自动级联永久删除。
- 直接使用 Eagle 库内文件作为 MOMO 唯一文件来源。
- 在浏览器预览模式中模拟真实 Eagle 连接。

---

## 2. 为什么采用“双层连接”

### 2.1 基础层：MOMO 直接连接 Eagle Web API V2

```text
MOMO → http://127.0.0.1:41595/api/v2/ → Eagle
```

原因：

- 不安装插件也能完成健康检查、读取、搜索、添加、修改、文件夹和标签管理。
- MOMO 是外部 Tauri 应用，Web API 是 Eagle 官方为外部工具提供的确定性接口。
- 基础同步不应依赖插件窗口是否打开。
- 便于先做小范围技术验证，降低首版复杂度。

### 2.2 增强层：Eagle 内安装 MOMO Link 插件

原因：

- 只有插件能自然读取 Eagle 当前选中项并在 Eagle 内提供按钮和右侧 Inspector。
- 后台服务插件可随 Eagle 启动，并在素材库切换时调整绑定。
- 插件可以使用 Eagle Item 实例的 `replaceFile()`、`refreshThumbnail()`、`select()`、`open()` 等深层能力。
- 用户在 Eagle 里操作时无需回到 MOMO 再找同一份素材。

### 2.3 为什么不用 Eagle MCP 作为同步底层

MCP/Skill 适合“整理我的标签”“重新规划文件夹”这类高层自然语言任务，不适合作为资产同步协议：

- 输出和执行路径不如固定 API 可预测。
- 不适合持续增量同步和幂等任务。
- 不应让基础文件复制依赖 AI 决策。

正确分工：

```text
确定性资产读写 → Web API / Plugin API
高层整理意图   → Eagle MCP / Skill / AI Action
```

---

## 3. 现有 MOMO 基础与改造边界

编码代理必须复用现有实现：

- `src/core/types.ts`：共享类型唯一来源。
- `src/core/stores/assetStore.ts`：资产收录、导入、回收站、标签和文件夹。
- `src/core/services/assetFiles.ts`：资产文件落盘、缩略图和格式识别。
- `src/modules/assets/AssetLibrary.tsx`：资产库 UI、原生拖出、导出和预览。
- `src/core/stores/settingsStore.ts`：设置加载、规整、版本迁移和 DPAPI 密钥处理。
- `src/core/services/http.ts`：网络请求统一入口 `xfetch`。
- `src/App.tsx`：各 store 初始化顺序。
- `src-tauri/src/lib.rs`：Rust 命令注册。

不得另建第二套本地资产存储。Eagle 拉回的文件最终仍需进入 `AppData/assets/`，并由 `AssetItem` 管理。

---

## 4. 总体技术架构

```text
┌────────────────────────────────────────────────────┐
│ MOMO React                                         │
│                                                    │
│ Settings/EagleTab   AssetLibrary   Agent/Director │
│           │             │               │          │
│           └────── useEagleStore ─────────┘          │
│                         │                          │
│                 eagleSyncEngine                   │
│            状态机 / 队列 / 幂等 / 冲突             │
│                │                  │                │
│         eagleApi.ts        Tauri commands         │
│         Web API V2        流式复制/哈希/桥服务      │
└───────────────┬──────────────────┬─────────────────┘
                │                  │
       127.0.0.1:41595     127.0.0.1:随机端口
                │                  │
┌───────────────▼──────────────────▼─────────────────┐
│ Eagle                                              │
│ Web API V2     MOMO Link Service     Inspector    │
│      │                  │                │         │
│      └──────── Eagle Item / Folder / Tag ─────────┘│
└────────────────────────────────────────────────────┘
```

依赖方向必须保持：

```text
UI → store / sync engine → service adapter → xfetch / Tauri command
```

`eagleApi.ts` 只做协议适配，不访问 Zustand。`eagleSyncEngine.ts` 负责业务编排和 store 写入。

---

## 5. 数据模型

### 5.1 设置结构

在 `src/core/types.ts` 增加：

```ts
export type EagleSyncMode = "manual" | "push" | "bidirectional";

export type EagleDeletePolicy = "unlink" | "trash-after-confirm";

export type EagleMetaPolicy = {
  name: "momo" | "eagle" | "newer";
  annotation: "momo" | "eagle" | "newer";
  tags: "union" | "momo" | "eagle";
  rating: "momo" | "eagle" | "newer";
};

export type EagleCfg = {
  enabled: boolean;
  host: string;
  /** 首版仅本机；为未来局域网保留。非空时必须 DPAPI 加密落盘。 */
  apiToken: string;
  syncMode: EagleSyncMode;
  autoPushGenerated: boolean;
  autoPullLinked: boolean;
  rootFolderId?: string;
  rootFolderName: string;
  pollIntervalMs: number;
  metadata: EagleMetaPolicy;
  deletePolicy: EagleDeletePolicy;
};
```

在 `Settings` 增加：

```ts
eagle: EagleCfg;
```

建议默认值：

```ts
eagle: {
  enabled: false,
  host: "http://127.0.0.1:41595",
  apiToken: "",
  syncMode: "manual",
  autoPushGenerated: false,
  autoPullLinked: false,
  rootFolderName: "MOMO",
  pollIntervalMs: 5000,
  metadata: {
    name: "newer",
    annotation: "newer",
    tags: "union",
    rating: "newer",
  },
  deletePolicy: "unlink",
}
```

为什么默认关闭自动同步：

- 用户可能有多个 Eagle 素材库。
- 首次启用前必须明确目标根文件夹。
- 大视频复制可能占用磁盘空间。
- 自动写入第三方软件必须由用户主动开启。

设置持久化必须新增版本，例如 `settings.json / v4`，并实现 v3 → v4 迁移。不能只在 `normalize()` 里加默认值后继续写 v3。`apiToken` 必须纳入现有 DPAPI 加解密流程。

### 5.2 AssetItem 扩展

在 `AssetItem` 中增加可选字段：

```ts
export type EagleAssetLink = {
  /** 对素材库路径做规范化后计算的稳定指纹，不假设 Eagle 一定提供 libraryId。 */
  libraryKey: string;
  libraryName?: string;
  itemId: string;
  pairId: string;
  linkedAt: number;
  lastRemoteModifiedAt?: number;
  lastLocalFingerprint?: string;
  lastRemoteFingerprint?: string;
  state: EagleLinkState;
};

export type EagleLinkState =
  | "synced"
  | "queued"
  | "pushing"
  | "pulling"
  | "local-dirty"
  | "remote-dirty"
  | "conflict"
  | "offline"
  | "error";

export type AssetLineage = {
  parentAssetId?: string;
  rootAssetId: string;
  revision: number;
  reason?: "eagle-edit" | "momo-regenerate" | "plugin-derived" | "manual-import";
};
```

并扩展：

```ts
source: "canvas" | "import" | "eagle";
rating?: 0 | 1 | 2 | 3 | 4 | 5;
annotation?: string;
eagle?: EagleAssetLink;
lineage?: AssetLineage;
```

为什么绑定信息需要进入 AssetItem：

- 资产卡需要无额外查询即可展示同步状态。
- 资产导出/备份时可保留来源关系。
- 重启后能恢复绑定。

### 5.3 独立同步运行数据

新增 `eagle-sync.json / v1`，只保存运行信息，不混入 `assets.json`：

```ts
export type EagleSyncPersist = {
  activeLibrary?: EagleLibraryRef;
  folders: Record<string, string>;
  queue: EagleSyncJob[];
  lastScan?: {
    libraryKey: string;
    completedAt: number;
  };
  ignoredRemoteItems: string[];
};
```

`folders` 的 key 采用 MOMO 文件夹、画布或导演项目的稳定键，value 是 Eagle folderId。

同步队列必须只保存可恢复的信息：资产 ID、Eagle itemId、任务类型、重试次数和时间，不保存 File、Blob、Response 或临时 URL。

### 5.4 Eagle DTO

Eagle API 返回值不得直接散落到 UI。集中定义最小 DTO：

```ts
export type EagleRemoteItem = {
  id: string;
  name: string;
  ext: string;
  size: number;
  width?: number;
  height?: number;
  filePath: string;
  thumbnailURL?: string;
  tags: string[];
  folders: string[];
  annotation?: string;
  star: number;
  importedAt?: number;
  modifiedAt?: number;
  isDeleted?: boolean;
};
```

必须写 `normalizeRemoteItem(raw)` 宽容解析 Eagle 版本差异，未知字段忽略，缺字段提供安全默认。

---

## 6. Web API 适配层

新增：

```text
src/core/services/eagleApi.ts
```

只暴露业务语义，不向上层暴露具体 URL：

```ts
export interface EagleClient {
  health(): Promise<EagleAppInfo>;
  libraryInfo(): Promise<EagleLibraryInfo>;
  getItems(input: EagleItemQuery): Promise<EaglePage<EagleRemoteItem>>;
  queryItems(query: string, page: EaglePageInput): Promise<EaglePage<EagleRemoteItem>>;
  getItemsByIds(ids: string[]): Promise<EagleRemoteItem[]>;
  getIdsWithModifiedAt(): Promise<Array<{ id: string; modifiedAt: number }>>;
  addFromPaths(items: EagleAddPathInput[], folderId?: string): Promise<string[]>;
  updateItem(id: string, patch: EagleItemPatch): Promise<void>;
  createFolder(input: EagleFolderCreate): Promise<EagleFolder>;
  listFolders(): Promise<EagleFolder[]>;
  openItem(id: string): Promise<void>;
  selectItems(ids: string[]): Promise<void>;
  aiSearchByText?(query: string, limit: number): Promise<EagleSearchHit[]>;
}
```

要求：

- 统一走 `xfetch`。
- host 必须去尾斜杠。
- 单次请求设置合理超时。
- 错误转换为中文 `Error`，包含“Eagle 未启动、版本过低、接口不存在、素材库不可写”等可行动信息。
- 不在 service 层 toast。
- 批量添加优先使用批量端点。
- API 返回 `status:error` 即使 HTTP 200 也必须抛错。
- 所有分页默认不超过 100 项；只有用户明确继续滚动才请求下一页。

浏览器预览模式：

- `health()` 返回明确的“不支持桌面连接”错误。
- UI 显示降级说明。
- 不能无限重试。

---

## 7. Rust 文件层与本地桥

### 7.1 为什么需要 Rust

现有前端文件导入会把文件读成 `Uint8Array`。图片可以接受，但几 GB 视频会造成前端内存峰值、WebView 卡顿甚至崩溃。

新增：

```text
src-tauri/src/eagle_bridge.rs
```

至少提供：

```rust
#[tauri::command]
async fn eagle_file_fingerprint(path: String) -> Result<FileFingerprint, String>;

#[tauri::command]
async fn eagle_copy_into_assets(
    source_path: String,
    preferred_ext: Option<String>,
) -> Result<CopiedAssetFile, String>;
```

要求：

- 分块流式读取和复制。
- 先复制到临时文件，完成并校验后原子改名。
- 指纹使用适合大文件的流式哈希；推荐 BLAKE3。
- 返回 size、mtime、extension、fingerprint 和最终绝对路径。
- 源路径必须是存在的普通文件，拒绝目录和设备路径。
- 目标路径只能在 MOMO AppData/assets 内。
- 失败时清理临时文件，不动源文件。

缩略图：

- 图片和普通视频沿用现有缩略图逻辑。
- 大视频缩略图失败不影响导入成功，使用类型占位图并在后台补做。

### 7.2 插件到 MOMO 的本地桥

插件阶段再增加环回 HTTP 服务：

```text
127.0.0.1:随机可用端口
```

MOMO 启动时将连接描述写入本机 AppData：

```json
{
  "schema": 1,
  "port": 41607,
  "token": "随机高熵令牌",
  "pid": 12345,
  "startedAt": 1787790000000
}
```

插件通过 Node.js `os` 与 `fs` 定位该文件，然后请求 MOMO。

安全要求：

- 只监听 `127.0.0.1`，禁止监听 `0.0.0.0`。
- 每次请求必须带 `X-MOMO-Bridge-Token`。
- 请求体上限 1 MB。
- 插件只发送 Eagle itemId、目标位置和动作，不发送任意本地路径。
- MOMO 收到 itemId 后重新向 Eagle API 查询可信 filePath。
- 令牌比较使用恒定时间比较。
- MOMO 退出时关闭服务并删除或作废连接描述。

首批本地桥端点：

```text
GET  /v1/health
POST /v1/import-selection
POST /v1/open-asset
POST /v1/send-to-canvas
POST /v1/send-to-director
POST /v1/request-operation
```

`request-operation` 涉及远程计费生成时，仍必须经过 MOMO 原有确认闸，插件请求不能绕过扣费确认。

---

## 8. 同步引擎

新增：

```text
src/core/eagleSyncEngine.ts
src/core/stores/eagleStore.ts
```

### 8.1 Store 职责

`useEagleStore` 保存：

- 当前连接状态；
- Eagle 应用和素材库信息；
- 当前远程搜索页；
- 同步队列摘要；
- 同步中数量、失败数量和冲突数量；
- 最近一次扫描时间；
- 启停、检测、搜索、手动同步、重试等 action。

不要把二进制文件或完整库项目长期放进 Zustand。

### 8.2 初始化顺序

在 `App.tsx` 中：

```text
settings.init
assets.init
eagle.init
```

`eagle.init` 必须等待设置和资产库 loaded 后再启动队列与增量扫描。未启用 Eagle 时不发任何请求。

### 8.3 状态机

```text
unlinked
  ↓ 用户同步
queued → pushing → synced
                    ├→ local-dirty → pushing
                    ├→ remote-dirty → pulling
                    ├→ conflict
                    ├→ offline
                    └→ error → queued（手动或退避重试）
```

任何状态迁移必须通过单一函数，例如：

```ts
transitionLink(assetId, event, detail?)
```

禁止 UI 组件直接拼 `eagle.state`。

### 8.4 MOMO → Eagle 推送

流程：

1. 检查资产存在且不是回收站项。
2. 检查 Eagle 在线、当前素材库与绑定素材库一致。
3. 计算本地快速指纹；未变化且已有 itemId 时直接成功。
4. 解析/创建目标 Eagle 文件夹。
5. 新资产调用批量 `addFromPaths`；已有资产只同步元数据，文件变化按用户策略处理。
6. 保存 itemId、libraryKey、modifiedAt 和指纹。
7. 失败写同步队列，并通过 `pushError("Eagle 同步", msg)` 进入报错中心。

自动推送接入点是 `assetStore.collect()` 成功落盘之后。只执行：

```ts
queueEaglePush(item.id)
```

不得 `await` 整个 Eagle 推送。

### 8.5 Eagle → MOMO 导入

流程：

1. 用户从 Eagle 搜索结果、插件选中项或绑定根目录请求导入。
2. MOMO 通过 Eagle API 按 itemId 获取元数据和可信 filePath。
3. Rust 流式复制到 MOMO AppData/assets。
4. 按扩展名识别 `AssetKind`，生成或补做缩略图。
5. 创建 `source:"eagle"` 的 AssetItem。
6. 写 Eagle 绑定、标签、说明、评分和导入时间。
7. 返回资产 ID，供画布节点或导演台参考槽使用。

同一 Eagle itemId 已绑定时，不得再次导入副本；应返回当前活动版本，除非检测到远端文件确实变化。

### 8.6 增量扫描

只在以下条件同时满足时运行：

- Tauri 桌面环境；
- Eagle enabled；
- syncMode 为 `bidirectional`；
- autoPullLinked 开启；
- 窗口可见或仍有未完成队列。

算法：

1. 调用 `getIdsWithModifiedAt()` 获取轻量 ID/时间列表。
2. 只比较 MOMO 已绑定 itemId，不读取全库详情。
3. modifiedAt 未变化则跳过。
4. 有变化的 ID 分批获取详情。
5. 先比较 metadata，再按需计算文件指纹。
6. 变更进入 `remote-dirty`，按冲突规则处理。

轮询间隔默认 5 秒；连续失败使用指数退避，最大 60 秒。Eagle 恢复在线后归零。

### 8.7 防同步回声

每次 MOMO 写入 Eagle 后记录：

```ts
lastWrite: {
  itemId: string;
  localFingerprint: string;
  expectedMetadataFingerprint: string;
  at: number;
}
```

下次扫描发现 modifiedAt 改变，但内容与预期完全一致时，视为本次写入的回声，只更新游标，不再反向同步。

---

## 9. 文件版本与冲突规则

### 9.1 默认非破坏策略

Eagle 中插件替换文件后，MOMO 默认创建新 AssetItem：

```text
原资产 A（保留）
  └─ Eagle 编辑版本 B（新资产，revision + 1）
```

Eagle 绑定转移到活动版本 B，A 保留 lineage 历史信息。画布和导演台中已经引用 A 的位置不自动换成 B，避免既有工程悄悄变化。

用户可在版本卡选择“采用此版本”，届时才替换指定引用。

### 9.2 元数据冲突

| 字段 | 默认策略 | 原因 |
|---|---|---|
| tags | 并集 | 两边新增标签通常都有效 |
| name | 较新一侧；双改则冲突 | 名称不能无损合并 |
| annotation | 较新一侧；双改则冲突 | 长文本覆盖风险高 |
| rating | 较新一侧 | 单一数值 |
| folders | 各自保留映射 | 两端目录体系不必完全相同 |
| prompt/gen/director | MOMO 为唯一真源 | Eagle 无对应结构字段 |

### 9.3 文件冲突

| 情况 | 行为 |
|---|---|
| 只有 MOMO 文件变化 | 推送为 Eagle 新版本或经确认替换 |
| 只有 Eagle 文件变化 | 拉回为 MOMO 新版本 |
| 两边文件都变化 | 建立双分支并显示冲突卡，禁止自动覆盖 |
| Eagle 新建衍生项目 | 导入新资产，并记录 parentAssetId |
| 一边删除 | 默认解除绑定，另一边保留 |

### 9.4 删除

首版固定 `unlink`：

- MOMO 删除：资产进入 MOMO 回收站，不删除 Eagle 项目。
- Eagle 删除：MOMO 标记“Eagle 端已删除”，本地资产保留。
- 解除绑定只清关系，不删任何文件。

`trash-after-confirm` 只能在后续版本开启，而且必须逐批确认。

---

## 10. 文件夹与元数据映射

### 10.1 Eagle 根目录

首次连接时让用户选择现有文件夹或创建：

```text
MOMO
├─ 画布
│  └─ {画布名称}
├─ 导演台
│  └─ {项目名称}
│     └─ {场景名称}
├─ 资产册参考
└─ 导出成片
```

MOMO 资产文件夹和 Eagle 文件夹用 ID 映射，不按名称反复创建。名称修改只更新显示，不改变稳定映射键。

### 10.2 Annotation 格式

Eagle annotation 给人看，不塞完整 JSON。建议模板：

```text
来自 MOMO · 导演台 / 项目A / 片段03
模型：xxx
提示词：最多 300 字摘要
MOMO 资产：momo://asset/{assetId}
```

完整生成参数、种子、group、director、Take 和空间接力数据仍保存在 MOMO。

### 10.3 隐式身份

不要依赖用户可编辑的 annotation 或 tag 作为唯一身份。真正身份保存在 MOMO 的 `itemId + libraryKey + pairId`。

Eagle 插件可在自己的配置中保存 pairId 副本作为辅助恢复，但 MOMO 本地映射仍是主账本。

---

## 11. MOMO UI 实施

### 11.1 设置页

新增：

```text
src/modules/settings/tabs/EagleTab.tsx
```

在设置导航“通用”或新建“连接”分组中增加 `Eagle 资产库`。

必须使用现有设置页骨架：

```text
.set-page
.set-page-h
.set-page-t
.set-page-d
.set-card
.set-card-h
.set-hint
.set-badge
.set-stats
```

页面包含：

1. 连接状态卡：未启用 / 未运行 / 已连接 / 版本过低 / 素材库不匹配。
2. 地址与检测：默认 `http://127.0.0.1:41595`，按钮“检测 Eagle”。
3. 素材库信息：名称、路径、项目数、版本。
4. MOMO 根文件夹：用 `PopSelect` 选择，选项必须图标 + 文字。
5. 同步开关：自动推送、自动拉取。
6. 元数据策略。
7. 删除策略说明。
8. 同步统计：已同步、等待、冲突、失败。
9. 操作：立即核对、重试失败、安装/打开 MOMO Link 插件说明。

### 11.2 资产库

资产卡增加小型状态角标：

```text
Eagle ✓
待同步
Eagle 有更新
冲突
离线
```

右键菜单增加：

- 同步到 Eagle；
- 从 Eagle 刷新；
- 在 Eagle 中打开；
- 查看同步详情；
- 解除 Eagle 绑定。

多选栏增加“同步到 Eagle”。批量操作使用单一批量 API 和队列任务，不逐个弹 toast。

资产库侧栏增加 `Eagle` 虚拟来源。远程卡与本地 AssetItem 必须用不同类型：

- 远程卡只能预览、搜索和“导入到 MOMO”。
- 导入完成后才允许拖到画布、导演台和快捷栏。

为什么不直接拖 Eagle filePath：

- Eagle 可能切换库、移动库或删除项目。
- MOMO 工程必须在 Eagle 关闭时仍然可用。
- 资产生命周期必须归 MOMO 管理。

### 11.3 错误与提示

运行类错误统一：

```ts
pushError("Eagle 资产桥", message)
```

再显示可点击 toast。不得只裸 `toast(..., "err")`。

同类离线错误在一次离线周期内去重，不能每 5 秒污染报错中心。

---

## 12. Eagle 插件套件

建议目录：

```text
integrations/eagle/
├─ momo-link-service/
│  ├─ manifest.json
│  ├─ index.html
│  ├─ js/plugin.js
│  └─ assets/
└─ momo-link-inspector/
   ├─ manifest.json
   ├─ index.html
   ├─ js/inspector.js
   └─ assets/
```

### 12.1 Service 插件

`manifest.json` 使用：

```json
{
  "main": {
    "serviceMode": true,
    "url": "index.html",
    "width": 640,
    "height": 560
  }
}
```

功能：

- Eagle 启动时读取 MOMO 连接描述。
- `onLibraryChanged` 时重新报告素材库并暂停错误库同步。
- 插件窗口显示连接状态、最近任务和冲突。
- 获取当前选中项并发送 itemId 数组给 MOMO。
- 支持目标选择：当前画布、导演台参考、首帧、尾帧、视频、音频。
- MOMO 未启动时显示“启动 MOMO 后重试”，不自动执行不明程序路径。

### 12.2 Inspector 插件

针对首版支持格式登记：

```text
png,jpg,jpeg,webp,gif,avif,bmp,tif,tiff,svg,
mp4,webm,mov,mkv,m4v,
mp3,wav,ogg,flac,m4a,aac,
pdf
```

显示：

- MOMO 绑定状态；
- 来源画布/导演项目/片段/Take；
- 模型、画幅、分辨率、生成时间；
- 提示词摘要；
- 在 MOMO 中定位；
- 发送到当前画布或导演台；
- 请求 MOMO 处理。

插件请求“处理”时只发动作意图：

```ts
type MomoOperation =
  | "upscale"
  | "vectorize"
  | "variation"
  | "image-to-video"
  | "extract-first-frame"
  | "extract-last-frame";
```

MOMO 决定打开哪个 UI、是否需要参数和费用确认。插件不能直接跳过确认执行。

### 12.3 第三方插件结果接力

不尝试统一调用第三方插件。采用“观察结果”策略：

- 若插件用 `replaceFile()` 替换原项目：通过 modifiedAt + 指纹检测。
- 若插件创建新 Eagle 项目：用户在 Inspector 点击“作为原素材衍生版本发送到 MOMO”。
- MOMO Link 自己发起的处理：请求中携带 parent pairId，回传时自动建立 lineage。

---

## 13. 创作助手与导演台接入

### 13.1 创作助手工具边界

新增内部确定性能力，不让 Agent 直接拼 HTTP：

```ts
searchEagleAssets(query, options)
findSimilarEagleAssets(assetId, limit)
importEagleAsset(itemId)
sendEagleAssetToCanvas(itemId)
```

Agent 搜索只读，不产生费用；导入和发送可直接执行。请求生成、放大或视频时仍走现有确认与预算护栏。

### 13.2 导演台

Eagle 素材导入导演台时，先进入 MOMO 资产库，再调用现有 `syncRefSlots` / 手动槽位逻辑。

手动添加的 Eagle 素材槽必须：

```ts
auto: false
```

图片、视频、音频槽序仍决定 `<Picture N>/<Video N>/<Audio N>` 编号，Eagle 接入不得改变现有排序规则。

建议目标动作：

```text
referenceImage
firstFrame
lastFrame
referenceVideo
referenceAudio
assetCatalog
```

---

## 14. 性能、可靠性与安全

### 14.1 性能

- 搜索分页，默认 50，最大 100。
- 增量扫描只取 ID + modifiedAt。
- 详情批量获取，建议每批 50。
- 文件先比 size/mtime/modifiedAt，再决定是否做完整哈希。
- 大文件流式复制和流式哈希。
- 同时文件复制默认 2 个，元数据请求默认 4 个。
- 应用退到后台且无任务时降低扫描频率。
- 缩略图与原文件复制解耦。

### 14.2 队列

任务类型：

```ts
type EagleSyncJobType =
  | "push-file"
  | "push-meta"
  | "pull-file"
  | "pull-meta"
  | "unlink"
  | "verify";
```

任务唯一键：

```text
libraryKey:itemId-or-assetId:jobType:targetFingerprint
```

重复键合并。旧任务成功后不能被较早快照重新写回；持久化要有与资产落盘类似的序号守卫。

### 14.3 重试

- 健康检查失败：退避到 60 秒。
- 元数据请求：最多自动重试 2 次。
- 文件添加/替换可能产生副作用：不能盲目重提；先按 pairId/itemId 核对是否已经成功。
- 磁盘空间不足：不自动重试，提示用户清理空间。
- 素材库切换：暂停，不当作失败重试。

### 14.4 安全

- 本机 API host 默认仅允许 loopback。
- 用户改成局域网地址时才显示 Token 输入和安全警告。
- Token DPAPI 加密落盘，不进导出的明文配置。
- 不记录 Token、完整请求头或用户绝对路径到普通日志。
- 插件桥只接受白名单动作和 itemId。
- 文件路径最终必须从 Eagle API 查询，拒绝插件传来的任意路径。

---

## 15. 具体文件改动清单

### 阶段 A：基础直连

新增：

```text
src/core/services/eagleApi.ts
src/core/eagleSyncEngine.ts
src/core/stores/eagleStore.ts
src/modules/settings/tabs/EagleTab.tsx
src/modules/assets/EagleBrowser.tsx
src-tauri/src/eagle_bridge.rs
```

修改：

```text
src/core/types.ts
src/core/stores/settingsStore.ts
src/core/stores/assetStore.ts
src/core/services/assetFiles.ts
src/modules/settings/SettingsDialog.tsx
src/modules/assets/AssetLibrary.tsx
src/modules/assets/assets.css
src/modules/settings/settings.css
src/ui/icons.tsx
src/App.tsx
src-tauri/src/lib.rs
src-tauri/Cargo.toml
src-tauri/capabilities/default.json（仅缺权限时最小补充）
```

### 阶段 B：插件

新增：

```text
integrations/eagle/momo-link-service/**
integrations/eagle/momo-link-inspector/**
src-tauri/src/eagle_plugin_server.rs
src/core/services/eaglePluginBridge.ts
```

### 阶段 C：智能检索

修改或新增：

```text
src/core/agentEngine.ts
src/core/eagleSearch.ts
src/modules/agent/AgentPanel.tsx
src/modules/director/SegmentRefEditor.tsx
```

不要在阶段 A 提前修改 Agent 协议；先把确定性资产链路跑通。

---

## 16. 分阶段实施与验收

### P0：API 勘察与只读探针

实现内容：

- Eagle 健康检查。
- 当前版本和素材库信息。
- 分页读取前 50 项。
- 读取文件夹。
- 核对 Web API V2 实际端点和返回结构。

验收：

- Eagle 关闭时 2 秒内返回中文离线状态。
- Eagle 开启时正确显示版本、库名和素材数量。
- 不写任何 Eagle 数据。
- 浏览器预览不白屏。

### P1：手动双向传输

实现内容：

- 单个/批量 MOMO 资产同步到 Eagle。
- Eagle 搜索和按需导入 MOMO。
- 稳定 itemId/libraryKey 绑定。
- “在 Eagle 中打开”。
- Rust 流式复制与指纹。

验收：

- 图片、视频、音频、SVG、PDF 各至少一份往返成功。
- 同一资产连续同步 3 次，Eagle 只存在一个绑定项目。
- 2 GB 视频导入时 WebView 内存不随文件等量增长。
- Eagle 关闭后 MOMO 已导入资产仍可用。

### P2：元数据、文件夹与自动推送

实现内容：

- 名称、标签、说明、评分映射。
- MOMO 根文件夹和项目子目录。
- collect 后异步入队。
- 队列持久化、重试和错误中心。

验收：

- 生成完成 UI 不等待 Eagle。
- Eagle 离线时生成正常，队列保留；重新启动 Eagle 后可恢复。
- 画布/导演项目不会因重命名而重复创建文件夹。
- 批量同步只给一个汇总进度和结果。

### P3：增量拉取、版本和冲突

实现内容：

- modifiedAt 增量扫描。
- 防同步回声。
- 非破坏版本 lineage。
- 冲突卡和采用版本。
- 删除只解除绑定。

验收：

- Eagle 替换文件后，MOMO 生成 revision + 1，原版保留。
- 两端同时修改时不会静默覆盖。
- MOMO 自己写入 Eagle 不会被再次拉回形成循环。
- Eagle 切换素材库时立即暂停错误库同步。

### P4：Eagle 插件

实现内容：

- Service 插件。
- Inspector 插件。
- 环回桥、配对令牌和白名单动作。
- 发送到画布/导演台。

验收：

- Eagle 选中多项可一次发送到 MOMO。
- MOMO 未启动时插件有明确提示。
- 非法 token 和非法动作被拒绝。
- 插件不能绕过 MOMO 生成确认闸。

### P5：AI Search 与工作流放大

实现内容：

- 文字语义检索。
- 以图搜图。
- 创作助手搜索动作。
- 参考板与导演台素材推荐。

验收：

- AI Search 插件未安装时自动降级关键词搜索。
- 搜索结果先作为远程卡，不自动占用 MOMO 磁盘。
- 导入后槽位编号与现有导演台规则完全一致。

---

## 17. 验证命令与人工检查

每阶段至少执行：

```bash
npx tsc --noEmit
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
```

涉及 Rust 哈希、路径校验、状态机纯函数时增加 Rust 单元测试。项目当前没有前端测试框架，不要只为本功能引入大型测试框架；前端状态机尽量写成纯函数，并通过类型检查与集成清单验证。

不要手动启动 `pnpm tauri dev`，仓库 Stop hook 会维持开发应用。

人工矩阵：

| 场景 | 必测 |
|---|---|
| Eagle 未安装/未启动 | 是 |
| Eagle 版本低于 Build 21 | 是 |
| 空素材库 | 是 |
| 20 万项库的增量检查 | 是，不能 getAll 详情 |
| 素材库切换 | 是 |
| 同名文件 | 是 |
| 相同内容不同文件名 | 是 |
| 大视频 | 是 |
| 磁盘空间不足 | 是 |
| MOMO 重启恢复队列 | 是 |
| Eagle 修改名称/标签 | 是 |
| Eagle 插件替换文件 | 是 |
| 双端同时修改 | 是 |
| 双端删除 | 是 |
| 浏览器预览模式 | 是 |

---

## 18. 完成定义

只有同时满足以下条件，才能称为“点对点衔接完成”：

1. 每个已绑定资产都有稳定的 `libraryKey + itemId + pairId`。
2. 文件和元数据均可双向流转。
3. 重复执行幂等。
4. 大文件不经前端整块复制。
5. Eagle 离线不影响 MOMO 本地工作。
6. 第三方插件修改可被识别为新版本。
7. 冲突不静默覆盖。
8. 删除默认不级联。
9. 已有画布、导演台和资产引用不会因同步自动改变。
10. 设置有迁移、Token 有加密、错误进报错中心。
11. 浏览器预览能够安全降级。
12. `tsc`、前端 build 和 Rust check 全部通过。

---

## 19. 推荐给 GLM 的执行指令

可将以下文字连同本文直接交给 GLM：

> 请完整阅读 `AGENTS.md` 与 `MOMO_EAGLE_ASSET_BRIDGE_IMPLEMENTATION.md`。先只实施 P0，不得提前写 P1-P5。实施前检查当前工作树并保留用户已有修改。Eagle API 端点必须以当前 Eagle Web API V2 Playground 实测为准，差异全部收口在 `src/core/services/eagleApi.ts`。完成 P0 后执行 `npx tsc --noEmit`、`pnpm build` 和 `cargo check --manifest-path src-tauri/Cargo.toml`，报告改动文件、实测端点、降级行为和未解决问题，等待确认后再进入 P1。

后续每阶段都采用相同方式：一次只做一个阶段，先验收再继续。
