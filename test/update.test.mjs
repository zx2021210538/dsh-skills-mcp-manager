/**
 * 自更新检查：只回答「有没有新版」，绝不自己替换文件。
 *
 * 更新源顺序与插件市场安装源对齐：**npm registry latest** → GitHub Release tag →
 * 默认分支 `package.json`。插件替换自己的文件是危险的：宿主进程已加载这一代模块，
 * 换了磁盘上的文件后进程里跑的仍是旧代码，界面却会以为升级成功。所以这里只测取数与
 * 比较，升级交给插件管理器。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PACKAGE_NAME, REPOSITORY, checkForUpdate, compareVersions } from '../src/update.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const reply = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
})

/** URL 路由式 fetch 桩：命中第一条 pattern 就用它的响应，没命中即报错（防止悄悄请求别处）。 */
const routed = (routes) => async (url) => {
  const target = String(url)
  for (const [pattern, respond] of routes) {
    if (pattern.test(target)) return respond()
  }
  throw new Error(`unexpected fetch: ${target}`)
}

test('compareVersions：点分数字比较，预发布后缀不影响主段', () => {
  assert.equal(compareVersions('0.5.18', '0.5.17'), 1)
  assert.equal(compareVersions('0.5.17', '0.5.18'), -1)
  assert.equal(compareVersions('0.5.18', '0.5.18'), 0)
  assert.equal(compareVersions('0.6', '0.5.99'), 1, '缺的段按 0 补')
  assert.equal(compareVersions('v1.0.0', '1.0'), 0, '允许 v 前缀')
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), 0, '预发布后缀按同一段处理')
  assert.equal(compareVersions('abc', '1.0.0'), null, '无法解析返回 null，不猜')
  assert.equal(compareVersions('', '1.0.0'), null)
})

test('checkForUpdate：首选 npm registry latest，来源与市场安装源一致', async () => {
  let asked = ''
  const result = await checkForUpdate({
    currentVersion: '0.6.2',
    fetchImpl: async (url) => {
      asked = String(url)
      return reply({ name: PACKAGE_NAME, version: '0.6.3' })
    },
  })
  assert.equal(asked, `https://registry.npmjs.org/${PACKAGE_NAME}/latest`)
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.latest, '0.6.3')
  assert.equal(result.updateAvailable, true)
  assert.equal(result.source, 'npm')
  assert.equal(result.url, `https://github.com/${REPOSITORY}/releases`)
})

test('checkForUpdate：已是最新 / 本机更新都不提示「有更新」', async () => {
  const same = await checkForUpdate({
    currentVersion: '0.6.3',
    fetchImpl: async () => reply({ version: '0.6.3' }),
  })
  assert.equal(same.ok, true, same.reason)
  assert.equal(same.updateAvailable, false)

  const newer = await checkForUpdate({
    currentVersion: '0.7.0',
    fetchImpl: async () => reply({ version: '0.6.3' }),
  })
  assert.equal(newer.updateAvailable, false, '本机比 registry 新时不该提示降级')
})

test('checkForUpdate：npm 404 时回退 GitHub Release 的 tag', async () => {
  const result = await checkForUpdate({
    currentVersion: '0.6.2',
    fetchImpl: routed([
      [/registry\.npmjs\.org\/dsh-skills-mcp-manager\/latest$/, () => reply({}, 404)],
      [/\/releases\/latest$/, () => reply({ tag_name: 'v0.6.3', html_url: 'https://github.com/x/y/releases/tag/v0.6.3' })],
    ]),
  })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.latest, '0.6.3')
  assert.equal(result.source, 'GitHub Release')
  assert.match(result.url, /releases\/tag\/v0\.6\.3$/)
})

test('checkForUpdate：npm 网络失败 / 版本号无效时也回退 GitHub', async () => {
  const offline = await checkForUpdate({
    currentVersion: '0.6.2',
    fetchImpl: routed([
      [/registry\.npmjs\.org/, () => { throw new Error('offline npm') }],
      [/\/releases\/latest$/, () => reply({ tag_name: 'v0.6.4' })],
    ]),
  })
  assert.equal(offline.ok, true, offline.reason)
  assert.equal(offline.latest, '0.6.4')
  assert.equal(offline.source, 'GitHub Release')

  const invalid = await checkForUpdate({
    currentVersion: '0.6.2',
    fetchImpl: routed([
      [/registry\.npmjs\.org/, () => reply({ version: 'not-a-version' })],
      [/\/releases\/latest$/, () => reply({ tag_name: 'v0.6.4' })],
    ]),
  })
  assert.equal(invalid.ok, true, invalid.reason)
  assert.equal(invalid.latest, '0.6.4')
})

test('checkForUpdate：npm 与 GitHub 都失败时回退默认分支 package.json', async () => {
  const result = await checkForUpdate({
    currentVersion: '0.6.2',
    repository: 'x/y',
    fetchImpl: routed([
      [/registry\.npmjs\.org/, () => { throw new Error('offline npm') }],
      [/\/releases\/latest$/, () => reply({ message: 'rate limited' }, 403)],
      [/raw\.githubusercontent\.com\/x\/y\/main\/package\.json$/, () => reply({ version: '0.6.5' })],
    ]),
  })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.latest, '0.6.5')
  assert.equal(result.source, 'package.json')
  assert.equal(result.updateAvailable, true)
})

test('checkForUpdate：三条链路都读不到时把各自原因带出来', async () => {
  const result = await checkForUpdate({
    currentVersion: '0.6.2',
    repository: 'x/y',
    fetchImpl: routed([
      [/registry\.npmjs\.org/, () => reply({}, 500)],
      [/\/releases\/latest$/, () => reply({}, 404)],
      [/package\.json$/, () => reply({}, 500)],
    ]),
  })
  assert.equal(result.ok, false)
  assert.match(String(result.reason), /npm/)
  assert.match(String(result.reason), /GitHub/)
  assert.match(String(result.reason), /package\.json/)
})

test('checkForUpdate：scoped 包名编码成 %2F，且自定义仓库/分支可用', async () => {
  const seen = []
  const result = await checkForUpdate({
    currentVersion: '1.0.0',
    packageName: '@scope/pkg',
    repository: 'me/plugin',
    branch: 'release/stable',
    fetchImpl: async (url) => {
      seen.push(String(url))
      if (String(url).includes('registry.npmjs.org')) return reply({}, 404)
      if (String(url).includes('/releases/latest')) return reply({}, 404)
      return reply({ version: '1.0.0' })
    },
  })
  assert.equal(result.ok, true, result.reason)
  assert.equal(seen[0], 'https://registry.npmjs.org/%40scope%2Fpkg/latest')
  assert.equal(seen[1], 'https://api.github.com/repos/me/plugin/releases/latest')
  assert.equal(seen[2], 'https://raw.githubusercontent.com/me/plugin/release%2Fstable/package.json')
})

test('更新源常量与 package.json 一致', () => {
  assert.equal(PACKAGE_NAME, pkg.name, 'PACKAGE_NAME 必须与 package.json 的 name 一致')
  assert.equal(REPOSITORY, 'zx2021210538/dsh-skills-mcp-manager')
  assert.match(String(pkg.repository?.url ?? ''), new RegExp(REPOSITORY.replace('/', '\\/') + '(?:\\.git)?$'))
})
