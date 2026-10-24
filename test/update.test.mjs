/**
 * 自更新检查：只回答「有没有新版」，绝不自己替换文件。
 *
 * 更新源是本仓库的 GitHub Release（`releases/latest` 的 tag），没有 release 时退回默认
 * 分支的 `package.json`。插件替换自己的文件是危险的：宿主进程已加载这一代模块，换了磁盘
 * 上的文件后进程里跑的仍是旧代码，界面却会以为升级成功。所以这里只测「取数与比较」，
 * 升级交给插件管理器（或用户按 README 重装）。
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

test('checkForUpdate：读 GitHub Release 的 tag，发现新版本', async () => {
  let asked = ''
  const result = await checkForUpdate({
    currentVersion: '0.6.0',
    fetchImpl: async (url) => {
      asked = String(url)
      return reply({ tag_name: 'v0.6.1', html_url: 'https://github.com/x/y/releases/tag/v0.6.1' })
    },
  })
  assert.equal(asked, `https://api.github.com/repos/${REPOSITORY}/releases/latest`)
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.latest, '0.6.1', 'v 前缀要去掉')
  assert.equal(result.updateAvailable, true)
  assert.equal(result.source, 'release')
  assert.match(result.url, /releases\/tag\/v0\.6\.1$/)
})

test('checkForUpdate：已是最新 / 本机更新都不提示「有更新」', async () => {
  const same = await checkForUpdate({
    currentVersion: '0.6.0',
    fetchImpl: async () => reply({ tag_name: 'v0.6.0' }),
  })
  assert.equal(same.ok, true, same.reason)
  assert.equal(same.updateAvailable, false)

  const newer = await checkForUpdate({
    currentVersion: '0.7.0',
    fetchImpl: async () => reply({ tag_name: 'v0.6.0' }),
  })
  assert.equal(newer.updateAvailable, false, '本机比仓库新时不该提示降级')
})

test('checkForUpdate：仓库还没有 release 时退回默认分支的 package.json', async () => {
  const result = await checkForUpdate({
    currentVersion: '0.6.0',
    repository: 'x/y',
    fetchImpl: routed([
      [/\/releases\/latest$/, () => reply({ message: 'Not Found' }, 404)],
      [/raw\.githubusercontent\.com\/x\/y\/main\/package\.json$/, () => reply({ version: '0.6.2' })],
    ]),
  })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.latest, '0.6.2')
  assert.equal(result.source, 'package.json')
  assert.equal(result.updateAvailable, true)
  assert.match(result.url, /github\.com\/x\/y$/)
})

test('checkForUpdate：release 是 404、回退的 package.json 也读不到时给出原因', async () => {
  const result = await checkForUpdate({
    currentVersion: '0.6.0',
    fetchImpl: routed([
      [/\/releases\/latest$/, () => reply({}, 404)],
      [/package\.json$/, () => reply({}, 500)],
    ]),
  })
  assert.equal(result.ok, false)
  assert.match(String(result.reason), /仓库里的 package\.json 也读不到/)
  assert.match(String(result.reason), /HTTP 500/)
})

test('checkForUpdate：GitHub API 被限流（403）时仍能从 package.json 读出结论', async () => {
  // GitHub 匿名 API 限额 60 次/小时；插件不应因为限流就告诉用户「检查更新失败」。
  const result = await checkForUpdate({
    currentVersion: '0.6.0',
    fetchImpl: routed([
      [/\/releases\/latest$/, () => reply({ message: 'API rate limit exceeded' }, 403)],
      [/raw\.githubusercontent\.com\/.*\/main\/package\.json$/, () => reply({ version: '0.6.0' })],
    ]),
  })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.source, 'package.json')
  assert.equal(result.updateAvailable, false)
})

test('checkForUpdate：网络失败、HTTP 错误、缺 tag、缺 version 都给出原因', async () => {
  assert.match(
    String((await checkForUpdate({ currentVersion: '1.0.0', fetchImpl: async () => { throw new Error('offline') } })).reason),
    /请求 GitHub 发布版本失败/,
  )
  assert.match(
    String((await checkForUpdate({ currentVersion: '1.0.0', fetchImpl: async () => reply({}, 500) })).reason),
    /HTTP 500/,
  )
  assert.match(
    String((await checkForUpdate({ currentVersion: '1.0.0', fetchImpl: async () => reply({}) })).reason),
    /没有 tag 名/,
  )
  assert.match(
    String((await checkForUpdate({ currentVersion: '1.0.0', fetchImpl: async () => reply({ tag_name: 'abc' }) })).reason),
    /版本号无法比较/,
  )
  assert.match(String((await checkForUpdate({ currentVersion: '' })).reason), /当前版本/)
  assert.match(String((await checkForUpdate({ currentVersion: '1.0.0', repository: '' })).reason), /更新源仓库/)
})

test('checkForUpdate：自定义仓库与分支（URL 编码，不拼接奇怪字符）', async () => {
  const seen = []
  await checkForUpdate({
    currentVersion: '1.0.0',
    repository: 'me/plugin',
    branch: 'release/stable',
    fetchImpl: async (url) => {
      seen.push(String(url))
      if (String(url).includes('/releases/latest')) return reply({}, 404)
      return reply({ version: '1.0.0' })
    },
  })
  assert.equal(seen[0], 'https://api.github.com/repos/me/plugin/releases/latest')
  assert.equal(seen[1], 'https://raw.githubusercontent.com/me/plugin/release%2Fstable/package.json')
})

test('更新源常量与 package.json 一致', () => {
  assert.equal(PACKAGE_NAME, pkg.name, 'PACKAGE_NAME 必须与 package.json 的 name 一致')
  assert.equal(REPOSITORY, 'zx2021210538/dsh-skills-mcp-manager')
  assert.match(String(pkg.repository?.url ?? ''), new RegExp(REPOSITORY.replace('/', '\\/') + '(?:\\.git)?$'))
})
