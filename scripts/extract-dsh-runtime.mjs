/**
 * 把 DSH 安装包里的 `dsh/node_modules` 解到磁盘，供 `npm run smoke` 使用。
 *
 * ## 为什么需要它
 *
 * `npm run smoke` 要用 DSH 本体提供的 `@deepseek-ai/*` 包（schemastery、dsh-mcp-client、
 * dsh-atomic-write、dsh-home-paths…）。桌面端把它们打在 `app.asar` 里，而**普通 node 读不了
 * asar**（只有 Electron 主进程的 fs 打过补丁）。所以冒烟在本机跑不起来，只会打印一条
 * 「未运行 Host 冒烟」然后跳过 —— 而跳过不等于通过。
 *
 * 这个脚本把 asar 里的 `dsh/node_modules` 解出來，然后用环境变量指过去：
 *
 * ```powershell
 * node scripts/extract-dsh-runtime.mjs            # 默认解到 %TEMP%\dsh-asar
 * $env:DSH_APP_NODE_MODULES = "$env:TEMP\dsh-asar\dsh\node_modules"
 * npm run smoke
 * ```
 *
 * ## asar 的头部格式（实测，非文档）
 *
 * 前 16 字节：`[u32=4][u32][u32][u32=jsonLen]`，然后 JSON 从第 16 字节开始；
 * 文件数据从 `align4(16 + jsonLen)` 开始。条目要么是 `{ files: {...} }`（目录），
 * 要么是 `{ offset, size, unpacked? }`（文件，offset 是相对数据区的十进制字符串）。
 */
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const args = process.argv.slice(2)
const argOf = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

/** 桌面端默认安装位置（Windows）。macOS 请显式传 --resources。 */
const defaultResources = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources')
const resources = argOf('--resources') ?? defaultResources
const asar = join(resources, 'app.asar')
const unpacked = join(resources, 'app.asar.unpacked')
const out = argOf('--out') ?? join(tmpdir(), 'dsh-asar')
const only = 'dsh/node_modules/'

if (!existsSync(asar)) {
  console.error(`找不到 app.asar：${asar}`)
  console.error('用 --resources <DeepSeek Harness/resources 目录> 指定安装位置')
  process.exit(1)
}

const fd = openSync(asar, 'r')
const head = Buffer.alloc(16)
readSync(fd, head, 0, 16, 0)
const jsonLength = head.readUInt32LE(12)
const json = Buffer.alloc(jsonLength)
readSync(fd, json, 0, jsonLength, 16)
const tree = JSON.parse(json.toString('utf8'))
const dataStart = Math.ceil((16 + jsonLength) / 4) * 4

let files = 0
let bytes = 0
let missingUnpacked = 0

const walk = (node, parts) => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const next = [...parts, name]
    if (entry.files !== undefined) {
      walk(entry, next)
      continue
    }
    const rel = next.join('/')
    // 只要 dsh/node_modules：其余的（rust 侧、前端 dist）对冒烟没用
    if (!rel.startsWith(only)) continue
    const target = join(out, ...next)
    if (entry.unpacked === true) {
      const source = join(unpacked, ...next)
      if (!existsSync(source)) {
        missingUnpacked += 1
        continue
      }
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(source, target)
      files += 1
      continue
    }
    if (entry.link !== undefined) continue
    const size = Number(entry.size ?? 0)
    mkdirSync(dirname(target), { recursive: true })
    const buffer = Buffer.alloc(size)
    if (size > 0) readSync(fd, buffer, 0, size, dataStart + Number(entry.offset))
    writeFileSync(target, buffer)
    files += 1
    bytes += size
  }
}

const started = Date.now()
walk(tree, [])
closeSync(fd)

console.log(`解出 ${files} 个文件，${(bytes / 1024 / 1024).toFixed(1)} MB，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
if (missingUnpacked > 0) console.log(`（${missingUnpacked} 个 unpacked 条目在磁盘上不存在，已跳过）`)

const scope = join(out, 'dsh', 'node_modules', '@deepseek-ai')
const required = ['schemastery', 'cosmokit', 'dsh-atomic-write', 'dsh-home-paths', 'dsh-mcp-client']
const missing = required.filter((name) => !existsSync(join(scope, name)))
if (missing.length > 0) {
  console.error(`缺少冒烟必需的包：${missing.join(', ')}`)
  process.exit(1)
}

console.log('')
console.log('下一步：')
console.log(`  $env:DSH_APP_NODE_MODULES = "${join(out, 'dsh', 'node_modules')}"`)
console.log('  npm run smoke')
