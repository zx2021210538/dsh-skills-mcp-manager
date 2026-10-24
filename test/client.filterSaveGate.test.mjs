/**
 * 工具勾选的**保存闸门**。
 *
 * ## 真机现象
 *
 * 面板给每台 MCP 服务器提供逐工具勾选。此前每勾一下就 `form.set('toolFilters', …)`
 * 写一次 settings 文档，而设置壳层在文档变更后会**重新挂载** section：
 *
 *   · 已展开的服务器卡片被收起（工具列表消失）；
 *   · 页签跳回默认。
 *
 * 于是「给一台服务器连续勾选多个工具」变成「勾一个、重新展开一次」的拉锯。
 *
 * ## 现在的行为
 *
 * 勾选/切模式只改本地草稿（`filterDraft`），**不写文档**；点「保存修改」才把整份
 * `toolFilters` 一次提交。整份字段一次写入 ⇒ 无论改了几台服务器都只有一次重载。
 *
 * 判据是 harness 记录在 `doc.setCalls` 里的真实写入次数：勾选时必须是 0，保存时必须是 1。
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
  profileServers: [row('mcp-context7', 'context7')],
  serverTools: [{
    serverName: 'context7',
    tools: [
      { name: 'mcp__context7__resolve', description: 'Resolve a library' },
      { name: 'mcp__context7__docs', description: 'Fetch docs' },
    ],
  }],
  serverStatus: [{ serverName: 'context7', tier: 'global', scope: '', status: 'connected', toolCount: 2 }],
}))

const classHas = (name) => (node) => String(node.props?.className ?? '').split(/\s+/).includes(name)
const writes = (panel) => panel.doc.setCalls ?? []
const checkboxes = (panel) => panel.findAll((node) => node.type === 'input' && node.props.type === 'checkbox')

/** 展开第一张卡片，并切到「只保留勾选」——只有进入 picking 模式工具勾选框才会出现。 */
const openPicker = (panel) => {
  const toggles = panel.findAll(classHas('smp-cardToggle'))
  assert.ok(toggles.length > 0, '应至少渲染出一张 MCP 卡片')
  panel.click(toggles[0])
  const allow = panel.byText('只保留勾选')
  assert.ok(allow, '展开后应出现工具过滤模式')
  panel.click(allow)
  assert.ok(checkboxes(panel).length > 0, '切到「只保留勾选」后应出现逐工具勾选框')
}

test('勾选与切模式都不写 settings 文档 —— 这就是每次点击都刷新页面的根源', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    openPicker(panel)
    assert.equal(writes(panel).length, 0, '切模式不该写文档（写一次壳层就重挂载一次）')

    panel.toggle(checkboxes(panel)[0], true)
    assert.equal(writes(panel).length, 0, '勾选不该写文档')

    panel.toggle(checkboxes(panel)[1], true)
    assert.equal(writes(panel).length, 0, '连续勾选同样不写文档')

    // 草稿仍然生效：勾选框反映本地状态，而不是被丢弃
    const checked = checkboxes(panel).filter((node) => node.props.checked === true)
    assert.equal(checked.length, 2, '两次勾选都应体现在界面上')
  } finally {
    panel.restore()
  }
})

test('点「保存修改」只写一次，且写的就是草稿内容', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    openPicker(panel)
    panel.toggle(checkboxes(panel)[0], true)
    const save = panel.byText('保存修改')
    assert.ok(save, '有未保存改动时应出现保存按钮')

    panel.click(save)
    await panel.settle()

    const calls = writes(panel)
    assert.equal(calls.length, 1, `保存应只写一次文档，实际 ${calls.length} 次`)
    assert.equal(calls[0].field, 'toolFilters')
    assert.deepEqual(
      calls[0].value,
      { context7: { mode: 'allow', tools: ['resolve'] } },
      '写进文档的必须是用户勾的那一份',
    )
    assert.equal(panel.byText('保存修改'), null, '保存成功后提示条应消失')
  } finally {
    panel.restore()
  }
})

test('「撤销」丢掉草稿且不写文档', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    openPicker(panel)
    panel.toggle(checkboxes(panel)[0], true)
    const discard = panel.byText('撤销')
    assert.ok(discard, '有未保存改动时应出现撤销按钮')

    panel.click(discard)
    assert.equal(writes(panel).length, 0, '撤销不该写文档')
    assert.equal(panel.byText('保存修改'), null, '撤销后提示条应消失')
    assert.equal(checkboxes(panel).filter((node) => node.props.checked === true).length, 0, '撤销后勾选应清空')
  } finally {
    panel.restore()
  }
})

test('改回与已保存一致时不算「未保存」，否则脏计数永远清不掉', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    openPicker(panel)
    assert.ok(panel.byText('保存修改'), '切到「只保留勾选」就是一处改动，应提示未保存')

    // 改回「全部保留」（等价于没配规则）——应当不再算脏
    panel.click(panel.byText('全部保留'))
    assert.equal(panel.byText('保存修改'), null, '改回原样后不该再提示未保存')
  } finally {
    panel.restore()
  }
})
