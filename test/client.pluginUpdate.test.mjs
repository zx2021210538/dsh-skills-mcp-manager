/**
 * 「插件更新」区块：更新源接入后的形态。
 *
 * 更新源是我们的 GitHub 仓库（`src/update.js#REPOSITORY`）。这个区块有三条硬要求：
 *
 *   1. 显示当前版本；
 *   2. 有「检查插件更新」按钮，点击后发 `update-check`，并显示结论
 *      （「已是最新」/「有新版本 x」）与发布页链接；
 *   3. 失败时把原因写在区块里（不能静默、也不能写进「在线市场」的提示里）。
 *
 * 旧的「更新源未接入」占位形态仍保留在 `lib/src/client.js`（由 `UPDATE_SOURCE_READY`
 * 控制），那是换源/离线时的降级形态；当前常量为 true，所以这里按可用形态断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLE, bootPanel, emptyDoc, skipWithoutBundle, textOf } from '../scripts/lib/client-harness.mjs'

/** 版本号从 package.json 来：每次发版只改一处，测试跟着走。 */
const PKG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
const VERSION = PKG.version
const NEXT_VERSION = VERSION.replace(/(\d+)$/, (digits) => String(Number(digits) + 1))
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const RELEASES_URL = `https://github.com/zx2021210538/dsh-skills-mcp-manager/releases/tag/v${VERSION}`

/**
 * 构建产物可能早于源码（例如只跑了 npm test 没 build）。用 ASCII 标识符判断，
 * 不要用中文：esbuild 默认 charset=ascii，bundle 里的中文是 \uXXXX。
 */
const skipWhenBundleIsStale = () => skipWithoutBundle()
  || (readFileSync(BUNDLE, 'utf8').includes('UPDATE_SOURCE_READY') ? false : 'lib/client.js 早于本次改动（先 npm run build:client）')

/** 只回答面板需要的端点；`/skills-catalog` 按 op 回答，并记录收到的命令。 */
const makeFetch = (doc, updateResult) => async (url, init) => {
  const target = String(url)
  if (target.endsWith('/skills-catalog')) {
    const body = JSON.parse(String(init?.body ?? '{}'))
    doc.catalogCommands = [...(doc.catalogCommands ?? []), body]
    if (body?.op === 'update-check') {
      return { ok: true, status: 200, json: async () => updateResult }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, reason: '', items: [] }) }
  }
  return {
    ok: true, status: 200,
    json: async () => ({
      serverTools: [], serverStatus: [], serverToolsError: { reason: '', detail: '' },
      servers: [], skills: [], skillDirs: {}, workspaces: [], currentWorkspace: '',
      filter: {}, probe: {}, oauth: { servers: {} }, discovery: {},
      skillGovernance: { sources: [], trash: [] },
    }),
  }
}

/** 打开 Skills 页 → 切到「获取技能」子页签（插件更新区块只在这一页）。 */
async function bootFetchTab(doc, updateResult) {
  const panel = await bootPanel(doc, { fetch: makeFetch(doc, updateResult) })
  const skillsTab = panel.find((node) => String(node.props?.className ?? '').includes('smp-tab') && textOf(node).startsWith('Skills'))
  assert.ok(skillsTab !== null, '找不到 Skills 页签')
  panel.click(skillsTab)
  const fetchTab = panel.find((node) => String(node.props?.className ?? '') === 'smp-subTab' && textOf(node).startsWith('获取技能'))
  assert.ok(fetchTab !== null, '找不到「获取技能」子页签')
  panel.click(fetchTab)
  await panel.settle()
  return panel
}

const OK_SAME = { ok: true, reason: '', current: VERSION, latest: VERSION, updateAvailable: false, url: RELEASES_URL }

test('插件更新：显示当前版本、有按钮、没有「未接入」占位', { skip: skipWhenBundleIsStale() }, async () => {
  const doc = emptyDoc()
  const panel = await bootFetchTab(doc, OK_SAME)
  try {
    const page = panel.text()
    assert.match(page, /插件更新/, '区块标题要在')
    assert.match(page, new RegExp(escape(VERSION)), '要显示当前版本')
    assert.doesNotMatch(page, /更新源未接入/, '更新源已接入，不该再显示占位文案')
    const button = panel.find((node) => node.type === 'button' && textOf(node).trim() === '检查插件更新')
    assert.ok(button !== null, '更新源接入后要有「检查插件更新」按钮')
  } finally {
    panel.restore()
  }
})

test('插件更新：点击后发 update-check，显示「已是最新」与发布页链接', { skip: skipWhenBundleIsStale() }, async () => {
  const doc = emptyDoc()
  const panel = await bootFetchTab(doc, OK_SAME)
  try {
    const button = panel.find((node) => node.type === 'button' && textOf(node).trim() === '检查插件更新')
    assert.ok(button !== null, '找不到「检查插件更新」按钮')
    panel.click(button)
    await panel.settle()

    const updates = (doc.catalogCommands ?? []).filter((command) => command?.op === 'update-check')
    assert.equal(updates.length, 1, `应恰好发一次 update-check，实际 ${updates.length} 次`)
    const page = panel.text()
    assert.match(page, new RegExp(`已是最新（${escape(VERSION)}）`), `结论要显示出来：${page.slice(0, 400)}`)
    assert.match(page, /发布页/, '结果里要有发布页链接')
    const link = panel.find((node) => node.type === 'a' && String(node.props?.href ?? '') === RELEASES_URL)
    assert.ok(link !== null, '发布页链接要指向 releases 页面')
  } finally {
    panel.restore()
  }
})

test('插件更新：有新版本时显示版本号对比', { skip: skipWhenBundleIsStale() }, async () => {
  const doc = emptyDoc()
  const panel = await bootFetchTab(doc, {
    ok: true, reason: '', current: VERSION, latest: NEXT_VERSION, updateAvailable: true,
    url: `https://github.com/zx2021210538/dsh-skills-mcp-manager/releases/tag/v${NEXT_VERSION}`,
  })
  try {
    const button = panel.find((node) => node.type === 'button' && textOf(node).trim() === '检查插件更新')
    panel.click(button)
    await panel.settle()
    assert.match(panel.text(), new RegExp(`有新版本 ${escape(NEXT_VERSION)}（本机 ${escape(VERSION)}）`))
  } finally {
    panel.restore()
  }
})

test('插件更新：失败原因写在区块里（不静默）', { skip: skipWhenBundleIsStale() }, async () => {
  const doc = emptyDoc()
  const panel = await bootFetchTab(doc, { ok: false, reason: 'GitHub 发布版本 返回 HTTP 500' })
  try {
    const button = panel.find((node) => node.type === 'button' && textOf(node).trim() === '检查插件更新')
    panel.click(button)
    await panel.settle()
    assert.match(panel.text(), /HTTP 500/, '失败原因要显示')
  } finally {
    panel.restore()
  }
})
