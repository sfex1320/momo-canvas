// 把 Tauri 打包产物同步到项目根目录的 APP/ 文件夹
// 包含：① 安装包（msi/nsis，连带 .sig）  ② 便携版目录（release 主 exe + models/ 内嵌模型 + portable.txt 标记）
//       ③ 便携版 zip（内部扁平：exe/models 在压缩包根，解压即用；应用内便携更新 Expand-Archive
//          直接解到程序目录覆盖，套外层文件夹会把更新解成双层目录导致替换失败，务必保持扁平）
//       ④ latest.json（读 .sig 组装应用内更新清单）  ⑤ 构建说明.md（逐文件中文备注，变更摘自 CHANGELOG）
// 背景：Tauri 2 不支持自定义 bundle 输出目录，也不提供官方 portable target；
//       便携版 = 内嵌前端资源的 release 主 exe，依赖系统 WebView2，拷走即用。
//       超清模型经 tauri.conf.json bundle.resources 内嵌（NSIS 释放到 exe 同级 models/）；
//       便携 zip 不走安装器，由本脚本把 models/sr 塞到 exe 同级，保持同一 resourceDir 约定。
//       APP/ 每次整体重建，只保留最新一次构建的产物（老版本自动覆盖，不留残留）。
// 用法：
//   pnpm app:dist   → tauri build 完成后自动调用本脚本
//   node scripts/collect-app.mjs  → 仅收集已存在的产物
import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(fileURLToPath(import.meta.url), '..', '..')
const bundleDir = join(rootDir, 'src-tauri', 'target', 'release', 'bundle')
const releaseDir = join(rootDir, 'src-tauri', 'target', 'release')
const appDir = join(rootDir, 'APP')

const conf = JSON.parse(readFileSync(join(rootDir, 'src-tauri', 'tauri.conf.json'), 'utf8'))
const productName = conf.productName || 'app'
const version = conf.version || ''
const dataDir = conf.identifier || 'app'
// 仓库坐标取自 updater.ts 的 GH_REPO（换仓库时只改那一处，本脚本跟随）
const ghRepo = (readFileSync(join(rootDir, 'src', 'core', 'services', 'updater.ts'), 'utf8').match(/GH_REPO\s*=\s*"([^"]+)"/) || [])[1] || 'owner/repo'

if (!existsSync(bundleDir)) {
  console.error(`[收集] 未找到打包目录：${relative(rootDir, bundleDir)}`)
  console.error('[收集] 请先运行 pnpm app:dist（或 pnpm tauri build）进行打包。')
  process.exit(1)
}

// 递归列出目录下所有文件（保留相对子目录结构）
const listFiles = (dir, base = dir, acc = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) listFiles(p, base, acc)
    else acc.push({ src: p, rel: relative(base, p) })
  }
  return acc
}

// 每次重建 APP，保证目录永远等于最新一次构建的产物（不留旧版本残留）
if (existsSync(appDir)) rmSync(appDir, { recursive: true, force: true })
mkdirSync(appDir, { recursive: true })

const copyOne = (src, dst) => {
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)
  return (statSync(src).size / 1024 / 1024).toFixed(2)
}

// ① 安装包：msi / nsis（连带 .sig 签名）。bundle 目录会累积历次版本，按当前版本号过滤，确保 APP/ 只留本次
const bundleFiles = listFiles(bundleDir).filter(({ rel }) => !version || rel.includes(version))
console.log('[收集] 安装包：')
for (const { src, rel } of bundleFiles) {
  const size = copyOne(src, join(appDir, rel))
  console.log(`  - ${rel}  (${size} MB)`)
}
const msiEntry = bundleFiles.find(f => f.rel.toLowerCase().endsWith('.msi'))
const nsisEntry = bundleFiles.find(f => f.rel.toLowerCase().endsWith('.exe'))
const sigContent = p => (existsSync(p) ? readFileSync(p, 'utf8').trim() : undefined)

// ② 便携版：release 顶层主 exe（前端资源已内嵌，单文件免安装）
//    target/release 下可能有多个 [[bin]] 产物（如 quality_gate_audit），只取与 Cargo 包名同名的主程序 exe
const cargoPkg = (readFileSync(join(rootDir, 'src-tauri', 'Cargo.toml'), 'utf8').match(/^\s*name\s*=\s*"([^"]+)"/m) || [])[1] || productName
const mainExeName = `${cargoPkg.toLowerCase()}.exe`
const portableExes = readdirSync(releaseDir)
  .filter(n => n.toLowerCase() === mainExeName)
  .map(n => join(releaseDir, n))
  .filter(p => statSync(p).isFile())

// 便携版目录名带版本号，与 zip 名对齐（APP/ 内一眼可辨）
const portableDir = join(appDir, `${productName}_${version}_portable`)
// 生产模型清单（顶层声明：便携段拷贝与构建说明.md 的逐文件备注都要用）
const modelManifest = JSON.parse(readFileSync(join(rootDir, 'scripts', 'production-models.json'), 'utf8'))
// 超清模型逐个的中文备注（构建说明.md 用；按文件名前缀匹配）
const MODEL_NOTES = [
  ['4xNomosWebPhoto_esrgan', '超清放大·照片模型（ESRGAN 架构 4 倍，质量取向，速度较慢）'],
  ['4xNomosWebPhoto_RealPLKSR', '超清放大·照片模型（RealPLKSR 架构 4 倍，质量速度均衡，默认首选）'],
  ['4xNomosUni_span_multijpg', '超清放大·通用模型（SPAN 架构 4 倍，体积最小，抗 JPG 压损）'],
  ['1xDeJPG_realplksr_otf_60', 'JPG 画质修复模型（1 倍去压缩伪影，只修复不放大）'],
]
const modelNote = fileName => MODEL_NOTES.find(([prefix]) => fileName.startsWith(prefix))?.[1] ?? '超清放大本地模型'

if (portableExes.length > 0) {
  mkdirSync(portableDir, { recursive: true })
  console.log('[收集] 便携版（免安装，双击即用，需系统 WebView2）：')
  portableExes.forEach((src, i) => {
    const outName = i === 0 ? `${productName}.exe` : `${productName}-${i + 1}.exe`
    const size = copyOne(src, join(portableDir, outName))
    console.log(`  - ${relative(appDir, portableDir)}/${outName}  (${size} MB)`)
  })
  // 安装器会自动收录 release 同级 DLL，便携版也必须携带（尤其 DirectML，缺失会使本地超清失效）。
  for (const name of readdirSync(releaseDir).filter(n => n.toLowerCase().endsWith('.dll'))) {
    const src = join(releaseDir, name)
    if (!statSync(src).isFile()) continue
    const size = copyOne(src, join(portableDir, name))
    console.log(`  - ${relative(appDir, portableDir)}/${name}  (${size} MB)`)
  }
  // 内嵌超清模型：bundle.resources 只覆盖安装版（NSIS 释放到 exe 同级 models/），
  // 便携 zip 是裸 exe，必须手动塞 models/ 才能走 resourceDir 内嵌解析（与安装版同一约定）
  const modelsSrc = join(rootDir, 'models', 'sr')
  if (existsSync(modelsSrc)) {
    for (const model of modelManifest.models) {
      const src = join(modelsSrc, model.fileName)
      if (!existsSync(src) || statSync(src).size !== model.size) {
        throw new Error(`生产模型缺失或大小不符：${model.fileName}（请先运行 pnpm models:prepare）`)
      }
      const size = copyOne(src, join(portableDir, 'models', model.fileName))
      console.log(`  - ${relative(appDir, portableDir)}/models/${model.fileName}  (${size} MB)`)
    }
    copyOne(join(rootDir, 'models', 'THIRD_PARTY_MODELS.txt'), join(portableDir, 'models', 'THIRD_PARTY_MODELS.txt'))
    console.log(`  - ${relative(appDir, portableDir)}/models/THIRD_PARTY_MODELS.txt`)
  } else {
    console.warn('[收集] 警告：未找到 models/sr，便携版超清模型将首跑时联网下载')
  }
  // 便携版使用说明
  const readme = [
    `${productName} · 便携版 v${version}`,
    '==============================',
    `直接双击 ${productName}.exe 即可运行，无需安装。`,
    '请先完整解压到固定目录，再运行 EXE，不要在压缩软件的临时目录中直接运行。',
    '启动会自动创建桌面快捷方式；同名旧快捷方式会更新为当前 EXE，已指向当前目录则不重复创建。',
    '',
    '运行依赖：Windows 系统自带的 WebView2 运行时（Win10 1803+ / Win11 通常已预装）。',
    `运行数据保存在：%APPDATA%\\${dataDir}\\（API Key 已加密绑定本机，拷给他人无效）`,
    '',
    '注意：同目录 DLL 是运行依赖，models/ 文件夹是超清放大的本地模型，',
    '移动程序时请连同 DLL、models/ 和 portable.txt 一起拷贝，不要只移动 EXE。',
    '更新：可在「设置 → 关于与更新」内一键升级，也可重新下载新版 zip 解压覆盖。',
  ].join('\n') + '\n'
  writeFileSync(join(portableDir, '便携版说明.txt'), readme, 'utf8')
  console.log(`  - ${relative(appDir, portableDir)}/便携版说明.txt`)
  // 便携版标记：updater 靠它区分安装版/便携版（services/updater.ts isPortable）
  writeFileSync(join(portableDir, 'portable.txt'), 'portable\n', 'utf8')
  console.log(`  - ${relative(appDir, portableDir)}/portable.txt（便携版标记，更新判定用）`)

  // ③ 便携版 zip：内部扁平（exe/models/portable.txt 在压缩包根）。
  //    - 手动场景：资源管理器右键「全部解压」默认解到与 zip 同名的文件夹，双击 exe 即用，可直接外发；
  //    - 自动更新：updater.ts 的 Expand-Archive -DestinationPath 程序目录 直接覆盖（套外层文件夹会替换失败）。
  const zipName = `${productName}_v${version}_portable.zip`
  const zipPath = join(appDir, zipName)
  console.log('[收集] 便携版 zip：')
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path "${portableDir}\\*" -DestinationPath "${zipPath}" -Force`], { stdio: 'inherit' })
  console.log(`  - ${zipName}  (${(statSync(zipPath).size / 1024 / 1024).toFixed(2)} MB)`)
}

// ④ latest.json：应用内自动更新清单（安装版 Tauri updater 拉取；仓库名取自 updater.ts GH_REPO）
const msiSig = msiEntry && sigContent(join(appDir, msiEntry.rel + '.sig'))
const nsisSig = nsisEntry && sigContent(join(appDir, nsisEntry.rel + '.sig'))
const dlUrl = name => `https://github.com/${ghRepo}/releases/download/v${version}/${name}`
if (msiSig && nsisSig && msiEntry && nsisEntry) {
  // 更新说明取 CHANGELOG 当前版本节的要点标题（更新弹窗展示用，保持简短）
  const heads = [...changelogSection(version).matchAll(/^- \*\*(.+?)\*\*/gm)].map(m => m[1]).slice(0, 8)
  const notes = (heads.length
    ? heads.join('；')
    : `v${version} 更新`) + '。安装版下载 .exe 安装包；便携版下载 *_portable.zip 解压即用（应用内均可自动更新）。'
  const latest = {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': { signature: msiSig, url: dlUrl(msiEntry.rel.split(/[\\/]/).pop()) },
      'windows-x86_64-msi': { signature: msiSig, url: dlUrl(msiEntry.rel.split(/[\\/]/).pop()) },
      'windows-x86_64-nsis': { signature: nsisSig, url: dlUrl(nsisEntry.rel.split(/[\\/]/).pop()) },
    },
  }
  writeFileSync(join(appDir, 'latest.json'), JSON.stringify(latest, null, 2) + '\n', 'utf8')
  console.log('[收集] latest.json（应用内更新清单，上传 GitHub Release 后生效）')
} else {
  console.warn('[收集] 警告：缺少 .sig 签名（tauri.conf.json createUpdaterArtifacts 未生效？），跳过 latest.json')
}

// ⑤ 构建说明.md：逐文件中文备注 + 本版变更（摘自 CHANGELOG，避免两处手工同步）
writeFileSync(join(appDir, '构建说明.md'), buildReadme(), 'utf8')
console.log('[收集] 构建说明.md（含逐文件中文备注）')

/** 读 CHANGELOG.md 里指定版本的节正文（不含 "## vX.Y.Z（日期）" 标题行） */
function changelogSection(ver) {
  const md = readFileSync(join(rootDir, 'CHANGELOG.md'), 'utf8')
  for (const part of md.split(/^## /m)) {
    if (part.startsWith(`v${ver}`)) return part.slice(part.indexOf('\n') + 1).trim()
  }
  return ''
}

/** 组装构建说明.md */
function buildReadme() {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  const modelRows = modelManifest.models.map(m =>
    `| \`${relative(rootDir, portableDir).replace(/\\/g, '/')}/models/${m.fileName}\` | ${modelNote(m.fileName)}（${m.license}，作者 ${m.author}） |`,
  ).join('\n')
  const pending = readFileSync(join(rootDir, 'CHANGELOG.md'), 'utf8').match(/^## 未发布\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]?.trim()
  const changes = [pending ? `### 本次构建中的最新修复\n\n${pending}` : '', changelogSection(version)].filter(Boolean).join('\n\n') || '（未在 CHANGELOG.md 里找到本版本记录）'
  return `# MOMO 智能画布 v${version} 构建说明

- 版本号：${version}（package.json / src-tauri/tauri.conf.json 同步）
- 构建时间：${time}
- 构建命令：\`pnpm app:dist\`（models:prepare 模型校验 → tauri build → collect-app 收集）
- 签名环境（缺了 .sig/latest.json 不生成，且无终端时 CLI 挂起等密码）：
  \`TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" pnpm app:dist\`（私钥在 ~/.tauri/momo-canvas.key，空密码加密格式；安装包已产出只缺签名时，可用 \`pnpm tauri signer sign --private-key-path C:\\Users\\96311\\.tauri\\momo-canvas.key --password "" <安装包>\` 单独补）
- 故障排查：NSIS 阶段报 "mis-hashed files / Downloading nsis_tauri_utils.dll timeout" 时，用可用 IP 手动下载该 DLL 放回 %LOCALAPPDATA%\\tauri\\NSIS\\Plugins\\x86-unicode\\ 即可续跑
- 本目录（APP/）每次构建整体重建，只保留最新一次的产物，历史版本已自动清除

## 本版变更（摘自 CHANGELOG.md）

${changes}

## 产物清单（逐文件说明）

### 安装包（推荐普通用户）

| 文件 | 说明 |
| --- | --- |
| \`nsis/${productName}_${version}_x64-setup.exe\` | NSIS 安装包：双击安装，自动创建开始菜单/桌面快捷方式并释放超清模型 |
| \`nsis/${productName}_${version}_x64-setup.exe.sig\` | ↑ 的更新签名（应用内自动更新校验用，随 Release 一起上传） |
| \`msi/${productName}_${version}_x64_en-US.msi\` | MSI 安装包（企业环境批量部署备用） |
| \`msi/${productName}_${version}_x64_en-US.msi.sig\` | ↑ 的更新签名 |

### 便携版（免安装，解压即用，可直接外发）

| 文件 / 目录 | 说明 |
| --- | --- |
| \`${relative(rootDir, portableDir).replace(/\\/g, '/')}/\` | 便携版目录（主程序 + 运行 DLL + models + portable.txt） |
| ├ \`${productName}.exe\` | 主程序：完整解压后双击；自动创建桌面快捷方式，同名旧链接更新为当前程序，不写注册表 |
| ├ \`*.dll\` | 与安装版相同的运行依赖（含 DirectML 本地超清运行库），请随 EXE 一起保留 |
| ├ \`models/\` | 超清放大本地模型，必须与 exe 同目录（缺失时首次使用会联网重新下载） |
| ├ \`portable.txt\` | 便携版标记：应用据此识别便携模式（更新走 zip 整包替换，不走安装版更新器） |
| └ \`便携版说明.txt\` | 给最终用户的使用说明 |
| \`${productName}_v${version}_portable.zip\` | ↑ 整个便携目录的压缩包：发给他人解压到任意位置双击 exe 即用（zip 内部为扁平结构） |

#### models/ 内每个文件

| 文件 | 说明 |
| --- | --- |
${modelRows}
| \`models/THIRD_PARTY_MODELS.txt\` | 第三方模型许可与署名说明（再分发必须随包保留） |

### 更新清单

| 文件 | 说明 |
| --- | --- |
| \`latest.json\` | 应用内自动更新清单（内嵌安装包签名与下载地址）；上传 GitHub Release 后应用内「检查更新」生效 |

## 便携版行为要点

- 桌面快捷方式：每次启动核对目标路径（COM IShellLink 直写 .lnk）；缺失则创建、旧链接则更新为当前程序、正确则跳过
- 请先完整解压到固定目录，不要在压缩软件内直接运行 EXE，避免快捷方式指向临时解压目录
- 数据目录：%APPDATA%\\${dataDir}\\（API Key 经 DPAPI 加密绑定本机用户，拷贝数据目录到他人电脑无法解密）
- 便携版更新：应用内下载新版本 *_portable.zip → 退出后解压覆盖程序目录 → 自动重启（等价于手动下载覆盖）

## GitHub 发布

- 代码：master 分支推送
- Release：tag \`v${version}\`，资产 = setup.exe(+sig) / msi(+sig) / ${productName}_v${version}_portable.zip / latest.json
- 自动更新端点：https://github.com/${ghRepo}/releases/latest/download/latest.json
`
}

console.log(`[收集] 完成 → ${relative(rootDir, appDir)}/`)
