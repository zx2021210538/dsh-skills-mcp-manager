/**
 * 勾选工具之后，UI 状态不能被「设置壳层重挂载 section」吃掉。
 *
 * ## 真机现象
 *
 * 面板给每台 MCP 服务器提供逐工具勾选。勾选写的是 settings 文档
 * （`write('toolFilters', …)` → `form.set`），而设置壳层在这份文档变更后会重新挂载
 * section —— 组件内的 `useState` 随之清零：
 *
 *   · 已展开的服务器卡片被收起（工具列表消失）；
 *   · 页签跳回默认的 MCP。
 *
 * 于是「给一台服务器连续勾选多个工具」变成「勾一个、重新展开一次」的拉锯。
 *
 * 修法有两层：主修是**保存闸门**（勾选只改本地草稿，见 `client.filterSaveGate.test.mjs`），
 * 它让勾选过程完全不写文档、也就完全不重载；这一层是补强——保存那**一次**写入仍会触发
 * 重挂载，把 `tab` / `expanded` 提到模块作用域（见 `PANEL_UI`）后，那次重载不会收走你正在
 * 看的卡片和页签。这里用 `panel.remount()` 复现壳层的那次重挂载。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootPanel, emptyDoc, skipWithoutBundle } from '../scripts/lib/client-harness.mjs'

const row = (entryId, serverName) => ({
  entryId, serverName, scope: '', transport: 'streamable-http',
  target: `https://${serverName}.invalid/mcp`,
  command: '', args: '', env: '', headersText: '', failOnStartupError: false,
  reconnectInitialDelayMs: '', reconnectMaxDelayMs: '', reconnectMaxAttempts: '',
  enabled: true, phase: 'active',
})

const boot = () => bootPanel(emptyDoc({
  profileServers: [row('mcp-context7', 'context7'), row('mcp-github', 'github')],
  serverTools: [
    {
      serverName: 'context7',
      tools: [
        { name: 'mcp__context7__resolve', description: 'Resolve a library' },
        { name: 'mcp__context7__docs', description: 'Fetch docs' },
      ],
    },
    { serverName: 'github', tools: [{ name: 'mcp__github__search', description: 'Search' }] },
  ],
  serverStatus: [
    { serverName: 'context7', tier: 'global', scope: '', status: 'connected', toolCount: 2 },
    { serverName: 'github', tier: 'global', scope: '', status: 'connected', toolCount: 1 },
  ],
}))

const classIs = (name) => (node) => String(node.props?.className ?? '') === name
const classHas = (name) => (node) => String(node.props?.className ?? '').split(/\s+/).includes(name)

test('重挂载后：已展开的服务器卡片仍然是展开的', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    const openCards = () => panel.findAll(classHas('smp-cardToggle')).filter((node) => node.props['aria-expanded'] === true)
    const toggles = panel.findAll(classHas('smp-cardToggle'))
    assert.ok(toggles.length > 0, '应至少渲染出一张 MCP 卡片')

    panel.click(toggles[0])
    assert.equal(openCards().length, 1, '点击一张卡片后应只有它展开')

    panel.remount()
    // 重挂载后列表要重新拉一次 `/runtime`，所以等它落定再看结果。
    await panel.settle()
    assert.equal(openCards().length, 1, '重挂载后卡片必须保持展开 —— 否则连续勾选工具就要反复展开')
  } finally {
    panel.restore()
  }
})

test('重挂载后：页签停在用户选的那一个', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    const tabs = () => panel.findAll(classIs('smp-tab'))
    const active = () => tabs().findIndex((node) => node.props['data-active'] === true)

    assert.equal(tabs().length, 2, 'MCP / Skills 两个页签')
    const start = active()
    panel.click(tabs()[1 - start])
    assert.equal(active(), 1 - start, '点击后应切到另一个页签')

    panel.remount()
    await panel.settle()
    assert.equal(active(), 1 - start, '重挂载后不该跳回默认页签')
  } finally {
    panel.restore()
  }
})
