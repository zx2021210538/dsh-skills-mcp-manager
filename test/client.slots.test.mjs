/**
 * 槽位注册：同一个面板要有两个入口（设置页 + 侧栏主面板），且两处的 id 必须一致。
 *
 * `sidebar.panellist` 的 id 与 `main` 槽位的 key 对应 —— 槽位说明原话：「Each list id addresses
 * the matching main panel」。漏掉任何一个，表现为「侧栏图标点了没反应」，而这类问题在单元测试
 * 之外很难发现（界面上只是没跳转）。
 *
 * 另外钉住主面板页的**滚动容器**：设置页由宿主的内容列滚动，`main` 槽位不滚 —— 少了这层外壳，
 * 内容超过一屏就被裁掉且滚不动（真机上出过这个 bug）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootPanel, emptyDoc, skipWithoutBundle } from '../scripts/lib/client-harness.mjs'

const boot = () => bootPanel(emptyDoc())

test('注册了设置页、主面板页与侧栏图标三处，且 id/key 一致', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    const slots = panel.registrations.map((item) => item.slot).sort()
    assert.deepEqual(slots, ['main', 'settings.section', 'sidebar.panellist'])

    const settings = panel.registrations.find((item) => item.slot === 'settings.section')
    const main = panel.registrations.find((item) => item.slot === 'main')
    const sidebar = panel.registrations.find((item) => item.slot === 'sidebar.panellist')

    assert.equal(settings.entry.id, 'skills-mcp')
    assert.equal(sidebar.entry.id, settings.entry.id, '侧栏图标 id 必须与设置页一致')
    assert.equal(main.entry.key, sidebar.entry.id, 'main 的 key 必须等于侧栏图标的 id')

    assert.equal(typeof sidebar.Component, 'function', '侧栏要渲染一个图标组件')
    assert.equal(typeof main.Component, 'function')

    // 两处入口都要能把 form 注入进去，否则主面板页拿不到设置文档
    assert.equal(typeof main.entry.inject, 'function')
    assert.equal(typeof settings.entry.inject, 'function')
  } finally {
    panel.restore()
  }
})

test('主面板页自带滚动容器，设置页没有（否则会变成滚动条套滚动条）', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    const settings = panel.registrations.find((item) => item.slot === 'settings.section')
    const main = panel.registrations.find((item) => item.slot === 'main')

    assert.notEqual(main.Component, settings.Component, '主面板页必须比设置页多一层外壳')

    const shell = main.Component({ form: panel.doc })
    assert.equal(shell.props.className, 'smp-mainShell', '外壳要带上滚动容器类名')

    // 设置页不加外壳：它由宿主的内容列滚动
    const settingsTree = settings.Component({ form: panel.doc })
    assert.equal(settingsTree.props.className, 'smp-page', '设置页仍是原来的根节点')

    const css = readFileSync(join(process.cwd(), 'lib', 'src', 'styles', 'panel.css'), 'utf8')
    const rule = /\.smp-mainShell\{[^}]*\}/.exec(css)
    assert.ok(rule !== null, 'CSS 里必须有 .smp-mainShell 规则')
    assert.match(rule[0], /overflow-y:auto/, '外壳必须能纵向滚动')
    assert.match(rule[0], /min-height:0/, 'min-height:0 是「内部滚动而不是撑开容器」的关键')
  } finally {
    panel.restore()
  }
})
