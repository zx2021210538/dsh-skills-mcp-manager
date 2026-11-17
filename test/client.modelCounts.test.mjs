/**
 * 面板的「模型可见几个」必须用 Host 现算的模型侧投影（issue #4）。
 *
 * 场景：`user-dsh` 里有个被停用的技能 `hyperframes`（原生影子，rank 399），`claude` 里有个
 * 同名的启用技能（rank 450）。宿主按 rank 决胜 → 399 的停用候选赢 → 模型一个都调不到。
 *
 * 本地估算 `countSkills` 只按「启用的行」挑胜者，会算出「可见 1」；Host 的 `modelView.counts`
 * 才是 0。面板必须显示后者，否则又回到「面板说可用、模型说不可用」。
 *
 * 夹具里的 `counts` / `shadowedBy` 直接由 Host 的实现（`modelViewOf`）算出来，不手写数字 ——
 * 手写会跟实现漂移，测试就只剩「四个键接线正确」这点价值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootPanel, emptyDoc, skipWithoutBundle, textOf } from '../scripts/lib/client-harness.mjs'
import { modelViewOf } from '../src/skills/modelView.js'

const PATH_DECLARED = '/h/.dsh/skills/hyperframes/SKILL.md'
const PATH_CLAUDE = '/h/.claude/skills/hyperframes/SKILL.md'

/** 治理快照的行：原生根那份被用户关掉了（自身开关），外部那份是启用的。 */
const rows = [
  {
    name: 'hyperframes', description: '', path: PATH_DECLARED, realPath: '', source: 'user-dsh',
    scope: 'global', rank: 399, native: true, readonly: false, ownEnabled: false, enabled: false, category: '',
  },
  {
    name: 'hyperframes', description: '', path: PATH_CLAUDE, realPath: '', source: 'claude',
    scope: 'global', rank: 450, native: false, readonly: true, ownEnabled: true, enabled: true, category: '',
  },
]

const sources = [
  {
    key: 'user-dsh', label: '用户 · DSH', scope: 'global', rank: 399, native: true,
    readonly: false, exists: true, enabled: true, count: 1, skills: [rows[0]],
  },
  {
    key: 'claude', label: 'Claude Code', scope: 'global', rank: 450, native: false,
    readonly: true, exists: true, enabled: true, count: 1, skills: [rows[1]],
  },
]

const governance = {
  sources,
  providerInstalled: true,
  modelView: modelViewOf({ sources, skills: rows }),
}

const makeFetch = (doc) => async () => ({
  ok: true, status: 200,
  json: async () => ({
    serverTools: [], serverStatus: [], serverToolsError: { reason: '', detail: '' },
    servers: [], skills: [], skillDirs: {}, workspaces: doc.workspaces ?? [], currentWorkspace: '',
    filter: {}, probe: {}, oauth: { servers: {} }, discovery: {}, skillGovernance: doc.skillGovernance,
  }),
})

const boot = async (overrides = {}) => {
  const doc = emptyDoc({ skillGovernance: governance, workspaces: [], ...overrides })
  const panel = await bootPanel(doc, { fetch: makeFetch(doc) })
  const tab = panel.find((node) => String(node.props?.className ?? '').includes('smp-tab') && textOf(node).startsWith('Skills'))
  assert.ok(tab !== null, '找不到 Skills 页签')
  panel.click(tab)
  for (let guard = 0; guard < 20; guard += 1) {
    const collapsed = panel.findAll((node) => (
      String(node.props?.className ?? '').split(/\s+/).includes('smp-skillSourceToggle')
      && node.props['aria-expanded'] === false
    ))
    if (collapsed.length === 0) break
    panel.click(collapsed[0])
  }
  return panel
}

test('总账用 Host 的模型侧口径：可见 0，差额记「技能停用」和「同名覆盖」', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    const ledger = panel.find((node) => String(node.props?.className ?? '').split(/\s+/).includes('smp-ledger'))
    assert.ok(ledger !== null, '找不到总账')
    const text = textOf(ledger)
    const counted = governance.modelView.counts.all
    assert.match(text, new RegExp(`${counted.visible} / ${counted.total}`), `总账应显示 Host 的可见数：${text}`)
    assert.equal(counted.visible, 0, '模型一个都调不到（399 的停用影子赢）')
    assert.match(text, /技能停用 1/, '被自己开关关掉的那份要算「技能停用」')
    assert.match(text, /同名覆盖 1/, 'claude 那份是启用却输掉，要算「同名覆盖」')
    assert.doesNotMatch(text, /全部可用/, '一个都调不到时不能说全部可用')
  } finally {
    panel.restore()
  }
})

test('页签计数同样用模型口径（0，而不是本地估算的 1）', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    const tab = panel.find((node) => String(node.props?.className ?? '').includes('smp-tab') && textOf(node).startsWith('Skills'))
    assert.match(textOf(tab).trim(), /Skills\s*（?0）?|Skills\(0\)|Skills 0/, `页签数字应为 0：${textOf(tab)}`)
  } finally {
    panel.restore()
  }
})

test('卡片按 Host 的覆盖关系标注「被「用户 · DSH」覆盖」', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    assert.match(panel.text(), /被「用户 · DSH」覆盖/, 'claude 那份应注明被谁覆盖（它自己启用，但赢不了）')
  } finally {
    panel.restore()
  }
})

test('旧 Host 没有 modelView 时回退到本地估算（不崩、不显示 0 以外的错值）', { skip: skipWithoutBundle() }, async () => {
  const legacy = { ...governance }
  delete legacy.modelView
  const panel = await boot({ skillGovernance: legacy })
  try {
    const ledger = panel.find((node) => String(node.props?.className ?? '').split(/\s+/).includes('smp-ledger'))
    assert.ok(ledger !== null, '找不到总账')
    // 回退口径只看启用的行 → 它认为 claude 那份可见（旧 Host 就是这样），至少不能是 NaN 或空。
    assert.match(textOf(ledger), /\d+ \/ \d+/, `回退路径也要给出数字：${textOf(ledger)}`)
  } finally {
    panel.restore()
  }
})
