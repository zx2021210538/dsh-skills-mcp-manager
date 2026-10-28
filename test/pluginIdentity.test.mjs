/**
 * 自有身份一致性：包名 / 版本 / 客户端挂载 id / bundle patch / 更新检查模块。
 *
 * 这条测试存在的原因很具体：这五处**必须完全一致**，而它们分散在四个文件里，任何一处漏改
 * 的表现都不是报错，而是「静默不生效」——
 *
 *   · `package.json#name` ≠ `lib/src/client.js` 的 ModuleLoader `id`  → 宿主按包名找不到
 *     bundle，**面板整块不出现**，日志里也没有明显错误；
 *   · `package.json#name` ≠ `cordis.patch.yml` 的 bundle `name` → 补丁装配不上，同样静默；
 *   · `package.json#version` ≠ 客户端显示的 `PLUGIN_VERSION` → 界面报的版本与包不符；
 *   · `src/update.js#PACKAGE_NAME` ≠ 包名 → 以后接更新源时查的是别人家的包。
 *
 * 另外顺带钉一条「旧标识清零」：全仓自有文件里不得再出现上游的包名/账号名
 * （构建产物 `dist/`、`lib/client.js` 由 `npm run build` 生成，单独由构建保证；
 * 这里扫的是**源文件**，也就是人改得到的那些）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PACKAGE_NAME, REPOSITORY } from '../src/update.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const pkg = JSON.parse(read('package.json'))

/** 上游标识：拼出来的（连账号名的数字串都不留），避免这条测试自己成为最后一次出现它的地方。 */
const OLD_IDENTIFIER = ['j', '6226', '878', '1', '-', 'alt'].join('')

test('package.json：自有身份 0.6.3，仓库字段指向我们自己的仓库', () => {
  assert.equal(pkg.name, 'dsh-skills-mcp-manager')
  assert.equal(pkg.version, '0.6.3')
  assert.equal(Object.prototype.hasOwnProperty.call(pkg, 'author'), false, '不写上游作者')
  assert.equal(REPOSITORY, 'zx2021210538/dsh-skills-mcp-manager')
  const repoUrl = String(pkg.repository?.url ?? '')
  assert.match(repoUrl, /^git\+https:\/\/github\.com\/zx2021210538\/dsh-skills-mcp-manager\.git$/)
  assert.match(String(pkg.homepage ?? ''), /^https:\/\/github\.com\/zx2021210538\/dsh-skills-mcp-manager#readme$/)
  assert.match(String(pkg.bugs?.url ?? ''), /^https:\/\/github\.com\/zx2021210538\/dsh-skills-mcp-manager\/issues$/)
  assert.equal(pkg.license, 'MIT', 'LICENSE 与 license 字段保留（MIT 归属声明不动）')
  assert.equal(pkg.publishConfig?.access, 'public', 'publishConfig 保留')
})

test('客户端挂载 id 与包名一致（否则面板整块不出现）', () => {
  const source = read('lib/src/client.js')
  const id = /window\.__ModuleLoader__\.load\(\{\s*(?:\/\/[^\n]*\n\s*)*id:\s*'([^']+)'/.exec(source)
  assert.ok(id !== null, '在 lib/src/client.js 里找不到 ModuleLoader 的 id')
  assert.equal(id[1], pkg.name, 'ModuleLoader id 必须与 package.json#name 完全一致')
})

test('客户端显示的版本与 package.json 一致', () => {
  const source = read('lib/src/client.js')
  const version = /const PLUGIN_VERSION = '([^']+)'/.exec(source)
  assert.ok(version !== null, '在 lib/src/client.js 里找不到 PLUGIN_VERSION')
  assert.equal(version[1], pkg.version, '「插件更新」区块显示的是这一版的版本号')
})

test('bundle patch 与更新检查模块都用同一个名字', () => {
  const patch = read('cordis.patch.yml')
  const name = /^\s*name:\s*'([^']+)'\s*$/m.exec(patch)
  assert.ok(name !== null, 'cordis.patch.yml 里找不到 bundle name')
  assert.equal(name[1], pkg.name, 'bundle patch 的 name 必须与包名一致')
  assert.match(patch, /^\s*- id: dsh-skills-mcp-manager\s*$/m, 'Host 行 id 保持不变')

  assert.equal(PACKAGE_NAME, pkg.name, 'src/update.js 的 PACKAGE_NAME 必须与包名一致')
})

/**
 * 归因文件白名单：市场维护者要求条目描述里点名 fork 来源（MIT）并说明不能同装，
 * 所以 FORK.md / README / 市场条目模板必须出现上游名字。除这三处外，自有文件
 * （尤其代码、package.json、cordis.patch.yml）仍然不得携带上游标识。
 */
const ATTRIBUTION_FILES = new Set(['FORK.md', 'README.md', 'CHANGELOG.md', 'docs/market-entry.yml'])

test('上游标识只允许出现在归因文件里（代码/清单里必须清零）', () => {
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.preview'])
  const SKIP_FILES = new Set(['lib/client.js'])
  const walk = (dir, out = []) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const rel = full.slice(ROOT.length + 1).split('\\').join('/')
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full, out)
      } else if (!SKIP_FILES.has(rel) && !rel.endsWith('.tgz')) {
        out.push(rel)
      }
    }
    return out
  }
  const hits = []
  for (const rel of walk(ROOT)) {
    // 只扫文本类文件：二进制（png/webp/tgz）读成 utf8 会得到替换字符，没有意义。
    if (!/\.(mjs|js|jsx|json|md|yml|yaml|css|svg|txt|html)$|(^|\/)(LICENSE|\.gitignore)$/.test(rel)) continue
    if (read(rel).includes(OLD_IDENTIFIER)) hits.push(rel)
  }
  const unexpected = hits.filter((rel) => !ATTRIBUTION_FILES.has(rel))
  assert.deepEqual(unexpected, [], `这些非归因文件里还留着上游标识：${unexpected.join(', ')}`)
  for (const rel of ATTRIBUTION_FILES) {
    assert.equal(hits.includes(rel), true, `${rel} 应写明 fork 来源（市场条目要求）`)
  }
})
