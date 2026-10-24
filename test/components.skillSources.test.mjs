/**
 * components/skillSources 接口测试。
 *
 * 这个视图是纯函数：直接调用 `skillSourceGroupsNode(...)` 并遍历返回的元素树，
 * 不需要浏览器，也不依赖 React 的渲染器（与 components.toolList.test.mjs 同一套写法）。
 *
 * 重点覆盖「启停」与「只读 / 目录不存在」这两种容易混淆的语义：
 *   · 目录不存在 → 不渲染来源开关（操作不了的东西不该出现开关）；
 *   · 只读来源   → **仍然可以启停**（策略层，不写文件），但不能出现在此视图里没有的写动作。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { skillSourceGroupsNode } from '../lib/src/components/skillSources.jsx'

globalThis.__dshReact = React

const ALPHA_PATH = 'C:/skills/alpha/SKILL.md'
const BETA_PATH = 'C:/skills/beta/SKILL.md'

/** 一个来源。默认两个技能：alpha 启用、beta 停用。 */
const source = (overrides = {}) => ({
  key: 'user-dsh',
  label: 'DSH 用户目录',
  path: 'C:/Users/tester/.dsh/skills',
  enabled: true,
  exists: true,
  readonly: false,
  skills: [
    { name: 'alpha', description: '第一个技能', path: ALPHA_PATH, enabled: true },
    { name: 'beta', description: '第二个技能', path: BETA_PATH, enabled: false },
  ],
  ...overrides,
})

/** Children with nulls dropped — JSX `{null}` branches still occupy raw props slots. */
const kids = (node) => React.Children.toArray(node?.props?.children)

const hasClass = (node, cls) => String(node?.props?.className ?? '').split(/\s+/).includes(cls)

const isElement = (value) => value !== null && typeof value === 'object' && value.props !== undefined

/** Depth-first search over an element tree; returns every element matching `predicate`. */
function findAll(node, predicate) {
  const found = []
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!isElement(value)) return
    if (predicate(value)) found.push(value)
    visit(value.props.children)
  }
  visit(node)
  return found
}

const switchesIn = (node) => findAll(node, (n) => n.type === 'button' && n.props.role === 'switch')

const skillCardsIn = (node) => kids(findAll(node, (n) => hasClass(n, 'smp-skillList'))[0])
  .filter((child) => hasClass(child, 'smp-skillCard'))

/** Collect callback calls so a click can be asserted without a renderer. */
function harness(overrides = {}) {
  const calls = { skill: [], source: [], preview: [] }
  return {
    calls,
    props: {
      onToggleSkill: (path, next) => calls.skill.push([path, next]),
      onToggleSource: (key, next) => calls.source.push([key, next]),
      onPreview: (path) => calls.preview.push(path),
      ...overrides,
    },
  }
}

test('skillSourceGroupsNode：空 groups 给出「还没有发现任何技能」', () => {
  const node = skillSourceGroupsNode({ groups: [] })
  assert.equal(node.props.className, 'smp-skillSources')
  const hints = findAll(node, (n) => hasClass(n, 'smp-empty'))
  assert.equal(hints.length, 1)
  assert.match(hints[0].props.children, /还没有发现任何技能/)
  // 没有来源就没有开关
  assert.equal(switchesIn(node).length, 0)
  // 非数组的 groups 同样按空处理，而不是抛异常
  assert.match(findAll(skillSourceGroupsNode({ groups: undefined }), (n) => hasClass(n, 'smp-empty'))[0].props.children, /还没有发现任何技能/)
})

test('skillSourceGroupsNode：点来源开关 → onToggleSource(key, 取反后的布尔)', () => {
  const { calls, props } = harness()
  const node = skillSourceGroupsNode({ groups: [source()], ...props })
  const sourceSwitch = switchesIn(node).find((s) => s.props['data-kind'] === 'source')
  assert.equal(sourceSwitch.props['aria-checked'], true)
  sourceSwitch.props.onClick()
  assert.deepEqual(calls.source, [['user-dsh', false]])
  // 技能开关不会误触发来源回调
  assert.deepEqual(calls.skill, [])
})

test('skillSourceGroupsNode：目录不存在 → 不渲染来源开关，只给一行说明', () => {
  const { props } = harness()
  const node = skillSourceGroupsNode({ groups: [source({ exists: false, skills: [] })], ...props })
  const notes = findAll(node, (n) => hasClass(n, 'smp-skillMissing'))
  assert.equal(notes.length, 1)
  assert.match(notes[0].props.children, /不存在/)
  // 整个来源下没有任何开关（来源开关不该出现，空技能列表也没有技能开关）
  assert.equal(switchesIn(node).length, 0)
  // 也不该出现「这个来源下还没有技能」的第二条说明：目录不存在才是原因
  assert.doesNotMatch(JSON.stringify(notes), /还没有技能/)
})

test('skillSourceGroupsNode：点「查看详情」把技能路径交给 onPreview', () => {
  const { calls, props } = harness()
  const node = skillSourceGroupsNode({ groups: [source()], ...props })
  const preview = findAll(skillCardsIn(node)[0], (n) => n.type === 'button' && n.props.children === '查看详情')[0]
  preview.props.onClick()
  assert.deepEqual(calls.preview, [ALPHA_PATH])
})

test('来源标题显示「已启用/总数」而不是只有总数', () => {
  // 夹具：alpha 启用、beta 停用 → 1/2
  const tree = skillSourceGroupsNode({ groups: [source()] })
  const counts = findAll(tree, (node) => hasClass(node, 'smp-skillCount'))
  assert.equal(counts.length, 1, '标题行应只有一个计数')
  assert.equal(String(counts[0].props.children), '1/2', '要显示已启用/总数')

  // 全部停用 → 0/N（来源开关关掉时技能一个都没提供给模型，标题必须如实这么写）
  const allOff = skillSourceGroupsNode({
    groups: [source({
      skills: [
        { name: 'alpha', description: '', path: ALPHA_PATH, enabled: false },
        { name: 'beta', description: '', path: BETA_PATH, enabled: false },
      ],
    })],
  })
  assert.equal(String(findAll(allOff, (node) => hasClass(node, 'smp-skillCount'))[0].props.children), '0/2')
})

test('技能卡片：右侧是状态色标（绿/灰/黄），不是开关', () => {
  /**
   * 0.5.52 起启停动作在左侧勾选框 + 批量条上，右侧只表达**状态**：
   * 绿=启用中 / 灰=未启用 / 黄=被更高优先级副本覆盖。
   *
   * 原来左右各一个控件、干同一件事，用户会问"左边勾了到底生效没"。
   */
  const tree = skillSourceGroupsNode({ groups: [source()] })
  const dots = findAll(tree, (node) => hasClass(node, 'smp-dot'))
  const tones = dots.map((node) => String(node.props['data-dot']))
  // 夹具：alpha 启用、beta 停用
  assert.deepEqual(tones.sort(), ['neutral', 'ok'], `色标状态不对：${JSON.stringify(tones)}`)
  // 技能卡片上不再有 role=switch 的控件
  const switches = findAll(tree, (node) => node.props?.role === 'switch' && node.props?.onClick !== undefined)
  assert.equal(switches.length, 1, '只剩来源开关一个（技能开关已移除）')
})

test('技能卡片：来源停用时色标必须说「来源停用」，不能还是绿色「启用中」', () => {
  /**
   * 一张卡上三处状态必须说的是同一件事：组标题 0/N、卡片挂着「来源已停用」标签、
   * 右侧色标。右边原先只看技能**自身**开关，于是来源停用后它仍是绿色「启用中 / 已提供给
   * 模型」—— 用户只能猜哪个是真的。色标表达的是"模型实际会不会看到它"，必须先看有效值。
   */
  const tree = skillSourceGroupsNode({
    groups: [source({
      enabled: false,
      skills: [
        // ownEnabled 开、但来源停了 → 有效值关
        { name: 'alpha', description: '', path: ALPHA_PATH, ownEnabled: true, enabled: false },
      ],
    })],
  })
  const status = findAll(tree, (node) => hasClass(node, 'smp-status'))
  assert.equal(status.length, 1)
  const text = String(findAll(status[0], (n) => hasClass(n, 'smp-statusText'))[0].props.children)
  assert.equal(text, '来源停用')
  const dot = findAll(status[0], (n) => hasClass(n, 'smp-dot'))[0]
  assert.equal(dot.props['data-dot'], 'warn', '来源停用要用黄色，不是绿色')
  assert.equal(status[0].props.title.includes('来源'), true)
})

test('技能卡片：被更高优先级副本覆盖时色标为黄', () => {
  const shadowedBy = new Map([[BETA_PATH, '用户 · DSH']])
  const tree = skillSourceGroupsNode({ groups: [source()], shadowedSkillBy: shadowedBy })
  const dots = findAll(tree, (node) => hasClass(node, 'smp-dot'))
  assert.ok(dots.some((node) => node.props['data-dot'] === 'warn'), '被覆盖的技能应有黄色色标')
})

/** 一条仓库安装记录，落盘目录正好是 alpha 技能所在目录。 */
const ALPHA_INSTALL = {
  id: 'inst-1',
  repoId: 'repo-1',
  skill: 'alpha',
  name: 'alpha',
  dir: 'C:/skills/alpha',
  scope: 'global',
  destId: 'dsh',
}

const triggersIn = (node) => findAll(
  node,
  (n) => n.type === 'button' && hasClass(n, 'smp-skillMoreTrigger'),
)

const buttonByText = (node, text) => findAll(
  node,
  (n) => n.type === 'button' && String(n.props.children) === text,
)[0]

test('技能卡片：普通技能没有「…」仓库菜单', () => {
  /**
   * 「…」只对仓库装进来的技能出现。普通技能没有版本可更新、也没有仓库可回滚，
   * 给它一个点开为空（或点了报错）的菜单比没有菜单更糟。
   */
  const tree = skillSourceGroupsNode({ groups: [source()] })
  assert.equal(triggersIn(tree).length, 0)
  // 即使传了安装记录，目录对不上的那一个也不该有
  const partial = skillSourceGroupsNode({
    groups: [source()],
    installs: [{ ...ALPHA_INSTALL, dir: 'C:/elsewhere/alpha' }],
  })
  assert.equal(triggersIn(partial).length, 0)
})

test('技能卡片：仓库装进来的技能给出「…」，点击交回调用方', () => {
  const opened = []
  const tree = skillSourceGroupsNode({
    groups: [source()],
    installs: [ALPHA_INSTALL],
    onToggleInstallMenu: (path) => opened.push(path),
    installMenuFor: '',
  })
  const triggers = triggersIn(tree)
  assert.equal(triggers.length, 1, '只有 alpha 是装进来的')
  assert.equal(triggers[0].props['aria-expanded'], 'false')
  triggers[0].props.onClick()
  assert.deepEqual(opened, [ALPHA_PATH])
})

test('技能卡片：「…」展开后是检查更新 / 更新 / 回滚 / 卸载，且未检查前不能更新', () => {
  const repoCalls = []
  const checked = []
  const base = {
    groups: [source()],
    installs: [ALPHA_INSTALL],
    onRepoAction: (op, id) => repoCalls.push([op, id]),
    onCheckInstall: (id) => checked.push(id),
  }

  const closed = skillSourceGroupsNode(base)
  assert.equal(buttonByText(closed, '卸载'), undefined, '没展开时不该出现动作')
  assert.equal(triggersIn(closed)[0].props['aria-expanded'], 'false')

  const open = skillSourceGroupsNode({ ...base, installMenuFor: ALPHA_PATH })
  assert.equal(triggersIn(open)[0].props['aria-expanded'], 'true')
  for (const label of ['检查更新', '更新', '回滚', '卸载']) {
    assert.ok(buttonByText(open, label) !== undefined, `展开后应有「${label}」`)
  }
  // 没点过「检查更新」就不知道有没有新版（那是读盘比哈希的动作），所以「更新」先禁用
  assert.equal(buttonByText(open, '更新').props.disabled, true)

  buttonByText(open, '检查更新').props.onClick()
  buttonByText(open, '回滚').props.onClick()
  buttonByText(open, '卸载').props.onClick()
  assert.deepEqual(checked, ['inst-1'])
  assert.deepEqual(repoCalls, [['repo-rollback', 'inst-1'], ['repo-uninstall', 'inst-1']])
})

test('技能卡片：展开行显示状态与落盘路径（用户要知道改的是哪一份）', () => {
  const tree = skillSourceGroupsNode({
    groups: [source()],
    installs: [ALPHA_INSTALL],
    installMenuFor: ALPHA_PATH,
    installPreview: { 'inst-1': { status: 'update-available', additions: ['a'], changes: [], removals: [] } },
    installStatusLabel: (status) => (status === 'update-available' ? '有更新' : ''),
  })
  const tags = findAll(tree, (n) => hasClass(n, 'smp-tag')).map((n) => String(n.props.children))
  assert.ok(tags.includes('有更新'), `应显示安装状态：${JSON.stringify(tags)}`)
  const notes = findAll(tree, (n) => hasClass(n, 'smp-skillMoreNote'))
  assert.ok(notes.some((n) => String(n.props.children).includes('C:/skills/alpha')), '应显示落盘目录')
  assert.ok(notes.some((n) => String(n.props.children).includes('新增 1')), '应显示差异摘要')
  // 有更新可装时「更新」才可用
  assert.equal(buttonByText(tree, '更新').props.disabled, false)
})

