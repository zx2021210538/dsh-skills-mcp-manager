/**
 * 工作区视图：选一个工作区后，只显示它（与全局）的技能。
 *
 * 项目级技能散落在每个工作区的两个根里；全部列出来时一屏会出现 N 组重复的分组标题。
 * 这里钉住两件事：过滤真的生效，且**全局技能不会被一起藏掉** —— 项目副本可能覆盖同名
 * 全局技能，只留项目那份会让人以为全局的没了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootPanel, emptyDoc, skipWithoutBundle, textOf } from '../scripts/lib/client-harness.mjs'

const skill = (name, scope, source) => ({
  name,
  description: '',
  path: `${scope === 'global' ? '/h' : scope}/${source.endsWith('agents') ? '.agents' : '.dsh'}/skills/${name}/SKILL.md`,
  source,
  scope,
  rank: 400,
  readonly: false,
  enabled: true,
})

const group = (scope, source, label, names) => ({
  key: source,
  label,
  path: `${scope === 'global' ? '/h' : scope}/${source.endsWith('agents') ? '.agents' : '.dsh'}/skills`,
  scope,
  rank: 400,
  native: true,
  readonly: false,
  exists: true,
  enabled: true,
  count: names.length,
  skills: names.map((name) => skill(name, scope, source)),
})

const GOVERNANCE = {
  sources: [
    group('global', 'user-dsh', '用户 · DSH', ['global-skill']),
    group('/p/one', 'project-dsh', '项目 · DSH', ['one-skill']),
    group('/p/two', 'project-dsh', '项目 · DSH', ['two-skill']),
  ],
  categories: [],
  trash: [],
  repositories: [],
  installs: [],
  providerInstalled: true,
}

const makeFetch = (doc) => async () => ({
  ok: true, status: 200,
  json: async () => ({
    serverTools: [], serverStatus: [], serverToolsError: { reason: '', detail: '' },
    servers: [], skills: [], skillDirs: {}, workspaces: doc.workspaces ?? [], currentWorkspace: '',
    filter: {}, probe: {}, oauth: { servers: {} }, discovery: {}, skillGovernance: doc.skillGovernance,
  }),
})

const boot = async () => {
  const doc = emptyDoc({
    skillGovernance: GOVERNANCE,
    workspaces: [{ path: '/p/one', title: 'one' }, { path: '/p/two', title: 'two' }],
  })
  const panel = await bootPanel(doc, { fetch: makeFetch(doc) })
  const tab = panel.find((node) => String(node.props?.className ?? '').includes('smp-tab') && textOf(node).startsWith('Skills'))
  assert.ok(tab !== null, '找不到 Skills 页签')
  panel.click(tab)
  return panel
}

/** 来源默认收起（避免页面被拉长），断言技能名之前先全部展开。 */
const expandAllSources = (panel) => {
  for (let guard = 0; guard < 20; guard += 1) {
    const collapsed = panel.findAll((node) => (
      String(node.props?.className ?? '').split(/\s+/).includes('smp-skillSourceToggle')
      && node.props['aria-expanded'] === false
    ))
    if (collapsed.length === 0) break
    panel.click(collapsed[0])
  }
}

const names = (panel) => panel
  .findAll((node) => String(node.props?.className ?? '').split(/\s+/).includes('smp-skillName'))
  .map((node) => textOf(node).trim())

test('默认只看全局：工作区技能不出现在默认视图里', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    expandAllSources(panel)
    const shown = names(panel)
    assert.deepEqual(shown, ['global-skill'], `默认（全局）应只有全局技能：${JSON.stringify(shown)}`)
  } finally {
    panel.restore()
  }
})

test('来源默认收起：只看到来源标题，展开后才出现技能', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    assert.deepEqual(names(panel), [], '默认收起时不该有技能卡片')
    const toggles = panel.findAll((node) => String(node.props?.className ?? '').split(/\s+/).includes('smp-skillSourceToggle'))
    assert.equal(toggles.length, 1, `默认（全局）应只渲染全局来源，实际 ${toggles.length}`)
    assert.ok(panel.text().includes('用户 · DSH'), '收起时仍要显示来源名')

    panel.click(toggles[0])
    const shown = names(panel)
    assert.equal(shown.length, 1, `展开一个来源应只出现它的技能：${JSON.stringify(shown)}`)
  } finally {
    panel.restore()
  }
})

test('按范围过滤：全局与某个工作区互斥，切换即换视图', { skip: skipWithoutBundle() }, async () => {
  /**
   * 范围从原生 `<select>` 换成了分段控件：互斥的选项摊在页面上。
   * 这里钉的是**互斥性与切换结果**，与控件形态无关。
   */
  const panel = await boot()
  try {
    const segments = () => panel.findAll((node) => (
      String(node.props?.className ?? '').split(/\s+/).includes('smp-segment')
    ))
    const labels = segments().map((node) => textOf(node).trim())
    assert.ok(labels.includes('全局'), `范围里应有「全局」：${JSON.stringify(labels)}`)
    assert.equal(labels.includes('全部'), false, `不该有「全部」这一档：${JSON.stringify(labels)}`)

    const pick = (label) => {
      const target = segments().find((node) => textOf(node).trim() === label)
      assert.ok(target !== undefined, `找不到范围「${label}」：${JSON.stringify(labels)}`)
      panel.click(target)
    }

    pick('one')
    expandAllSources(panel)
    assert.deepEqual(names(panel), ['one-skill'], '只看工作区时应只有它的技能')

    pick('two')
    expandAllSources(panel)
    assert.deepEqual(names(panel), ['two-skill'], '换一个工作区应换成它的技能')

    pick('全局')
    expandAllSources(panel)
    assert.deepEqual(names(panel), ['global-skill'], '切回全局应只剩全局技能')
  } finally {
    panel.restore()
  }
})

