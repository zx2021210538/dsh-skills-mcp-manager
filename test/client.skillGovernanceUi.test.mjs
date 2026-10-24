/**
 * 技能页（来源分组视图）的两件事：
 *
 *   1. **编辑**：页签合并后，编辑入口从「文件列表」搬到了来源分组的技能卡片上。
 *   2. **只读来源不显示写操作**：外部 Agent 目录（Claude Code / Codex …）永远不出现编辑/删除，
 *      因为那边按了也只能失败 —— 与其让人点一次再看到错误，不如不显示。
 *
 * 另外钉住唯一的过滤器：范围（全局 / 某工作区，**互斥**）。分类已从界面整套移除。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootPanel, emptyDoc, skipWithoutBundle, textOf } from '../scripts/lib/client-harness.mjs'

const mkSkill = (name, source, scope, category = '') => ({
  name,
  description: '',
  path: `${scope === 'global' ? '/h' : scope}/${source.endsWith('agents') ? '.agents' : '.dsh'}/skills/${name}/SKILL.md`,
  source,
  scope,
  rank: 400,
  readonly: source === 'claude',
  enabled: true,
  category,
})

const group = (source, label, scope, skills) => ({
  key: source,
  label,
  path: `${scope === 'global' ? '/h' : scope}/${source.endsWith('agents') ? '.agents' : '.dsh'}/skills`,
  scope,
  rank: 400,
  native: source !== 'claude',
  readonly: source === 'claude',
  exists: true,
  enabled: true,
  count: skills.length,
  skills,
})

const GOVERNANCE = {
  sources: [
    group('user-dsh', '用户 · DSH', 'global', [mkSkill('global-skill', 'user-dsh', 'global', '写作')]),
    group('claude', 'Claude Code', 'global', [mkSkill('claude-skill', 'claude', 'global')]),
    group('project-dsh', '项目 · DSH', '/p/one', [mkSkill('one-skill', 'project-dsh', '/p/one')]),
    // 目录不存在：不该出现在页面上（十几个这样的空壳会把页面撑得很长）
    { ...group('codex', 'Codex', 'global', []), exists: false, readonly: true },
    // 目录存在但没有技能：同样不显示
    group('user-agents', '用户 · Shared Agent', 'global', []),
  ],
  categories: [{ name: '写作', enabled: true, count: 1 }],
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
    workspaces: [{ path: '/p/one', title: '工作区1' }],
  })
  const panel = await bootPanel(doc, { fetch: makeFetch(doc) })
  const tab = panel.find((node) => String(node.props?.className ?? '').includes('smp-tab') && textOf(node).startsWith('Skills'))
  assert.ok(tab !== null, '找不到 Skills 页签')
  panel.click(tab)
  return panel
}

const expandAll = (panel) => {
  for (let guard = 0; guard < 20; guard += 1) {
    const collapsed = panel.findAll((node) => (
      String(node.props?.className ?? '').split(/\s+/).includes('smp-skillSourceToggle')
      && node.props['aria-expanded'] === false
    ))
    if (collapsed.length === 0) break
    panel.click(collapsed[0])
  }
}

const skillNames = (panel) => panel
  .findAll((node) => String(node.props?.className ?? '').split(/\s+/).includes('smp-skillName'))
  .map((node) => textOf(node).trim())

test('编辑：可写来源的技能卡片有「编辑」，点了打开编辑对话框', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    expandAll(panel)
    const row = panel.findAll((node) => String(node.props?.className ?? '').split(/\s+/).includes('smp-skillCard'))
      .find((node) => textOf(node).includes('global-skill'))
    assert.ok(row !== undefined, '找不到 global-skill 的卡片')

    const edit = panel.findAll((node) => node.type === 'button' && textOf(node).trim() === '编辑')
      .find((node) => String(node.props?.className ?? '').includes('smp-button'))
    assert.ok(edit !== undefined, '可写来源的技能应有「编辑」按钮')
    panel.click(edit)

    const modal = panel.find((node) => String(node.props?.['data-modal'] ?? '').includes('编辑技能'))
    assert.ok(modal !== null, `应打开编辑对话框：${panel.text().slice(0, 200)}`)
  } finally {
    panel.restore()
  }
})

test('只读来源的技能没有编辑与删除', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    expandAll(panel)
    const rows = panel.findAll((node) => String(node.props?.className ?? '').split(/\s+/).includes('smp-skillCard'))
    const claudeRow = rows.find((node) => textOf(node).includes('claude-skill'))
    assert.ok(claudeRow !== undefined, '找不到 claude 来源的技能卡片')
    assert.equal(textOf(claudeRow).includes('编辑'), false, '只读来源不该出现「编辑」')
    assert.equal(textOf(claudeRow).includes('删除'), false, '只读来源不该出现「删除」')
  } finally {
    panel.restore()
  }
})

test('不显示不存在的来源，也不显示没有技能的来源', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    expandAll(panel)
    const labels = panel.findAll((node) => String(node.props?.className ?? '').split(/\s+/).includes('smp-skillSourceToggle'))
      .map((node) => textOf(node).replace(/\s+/g, ' ').trim())

    assert.equal(labels.some((label) => label.includes('Codex')), false, '目录不存在的来源不该有标题行')
    assert.equal(labels.some((label) => label.includes('Shared Agent')), false, '没有技能的来源不该有标题行')
    assert.equal(panel.text().includes('来源目录不存在'), false, '也不该出现这类空壳说明')

    // 默认（全局）下只剩两个「存在且确实有技能」的来源
    assert.equal(labels.length, 2, `默认应只剩两个有内容的来源，实际 ${JSON.stringify(labels)}`)
  } finally {
    panel.restore()
  }
})

test('过滤器：只剩「范围」一个，分类已从界面移除', { skip: skipWithoutBundle() }, async () => {
  /**
   * 分类这一层整套撤掉了（设计评审第 2 条）：它只是"给技能分组浏览"，却和来源、技能自身
   * 叠加成三层 opt-out，用户算不出"到底生效没生效"。撤的是**界面**，数据仍在 state.json 里 ——
   * 所以这里断言"看得到的东西里没有分类"，而不是"Host 忘了分类"。
   *
   * 范围选择也从原生 `<select>` 换成了分段控件：互斥的两三项摊开在页面上，不用点开才知道
   * 有哪几个，也不会出现"这看着不像下拉框"的问题。
   */
  const panel = await boot()
  try {
    const segments = () => panel.findAll((node) => (
      String(node.props?.className ?? '').split(/\s+/).includes('smp-segment')
    ))
    const segLabels = segments().map((node) => textOf(node).trim())
    assert.deepEqual(segLabels, ['全局', '工作区1'], `范围分段控件的选项不对：${JSON.stringify(segLabels)}`)

    // 页面上不该再有任何原生 select（范围已改成分段控件，分类已删）
    assert.equal(panel.findAll((node) => node.type === 'select').length, 0, '不该再有原生下拉')

    // 只看某个工作区
    panel.click(segments()[1])
    expandAll(panel)
    assert.deepEqual(skillNames(panel), ['one-skill'], '只看工作区时应只有它的技能')

    // 切回全局：全局范围是「全局来源 + 外部 Agent 来源」的并集，所以是两个技能
    // （原先这里只看到 global-skill，是因为当时还挂着一个分类过滤器把另一个挡住了）
    panel.click(segments()[0])
    expandAll(panel)
    assert.deepEqual(
      skillNames(panel).sort(),
      ['claude-skill', 'global-skill'],
      '全局范围应列出全局来源与外部 Agent 技能的并集',
    )
  } finally {
    panel.restore()
  }
})

test('停用的来源（目录里确实有技能）仍然显示，开关也在', { skip: skipWithoutBundle() }, async () => {
  /**
   * 这条钉的是一个**容易推错**的关系：
   *
   *   · 「停用来源」= 它的技能不再提供给模型（策略层，`invocation` 置为不可调用）；
   *   · 「显示来源」= 目录存在且里面确实有技能（视图层，与启用状态无关）。
   *
   * 两者不能混。曾经在讨论里把它推成「停用后整组都不显示，于是开关也消失」——那是错的：
   * 用户要的正是「停用之后还能再启用回来」，所以停用的来源必须照样列出来、开关照样在。
   */
  const disabled = {
    ...group('user-dsh', '用户 · DSH', 'global', [mkSkill('global-skill', 'user-dsh', 'global')]),
    enabled: false,
  }
  const doc = emptyDoc({ skillGovernance: { ...GOVERNANCE, sources: [disabled, GOVERNANCE.sources[1]] }, workspaces: [] })
  const panel = await bootPanel(doc, { fetch: makeFetch(doc) })
  try {
    const tab = panel.find((node) => String(node.props?.className ?? '').includes('smp-tab') && textOf(node).startsWith('Skills'))
    panel.click(tab)

    const toggle = panel.find((node) => String(node.props?.className ?? '').split(/\s+/).includes('smp-skillSourceToggle'))
    assert.ok(toggle !== null, '停用的来源必须仍然有标题行')
    assert.ok(textOf(toggle).includes('用户 · DSH'))

    const switches = panel.findAll((node) => node.props?.role === 'switch')
    assert.ok(switches.length >= 1, '停用的来源必须仍然有启停开关')
    const sourceSwitch = switches.find((node) => String(node.props['aria-label'] ?? '').includes('来源「用户 · DSH」'))
    assert.ok(sourceSwitch !== undefined, `找不到来源开关：${JSON.stringify(switches.map((n) => n.props['aria-label']))}`)
    assert.equal(sourceSwitch.props['aria-checked'], false, '开关状态要如实显示「已停用」')
  } finally {
    panel.restore()
  }
})

test('Skills 页搜索框真的过滤列表（不只是改页签数字）', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    expandAll(panel)
    const before = skillNames(panel).length
    assert.ok(before > 0, '默认应能看到技能')

    const search = panel.byPlaceholder('搜索技能名称')
    panel.change(search, 'global-skill')
    expandAll(panel)
    const after = skillNames(panel)
    assert.deepEqual(after, ['global-skill'], `搜索后应只剩匹配项：${JSON.stringify(after)}`)

    // 清空搜索要回到全部
    panel.change(panel.byPlaceholder('搜索技能名称'), '')
    expandAll(panel)
    assert.ok(skillNames(panel).length >= before, '清空搜索后应恢复')
  } finally {
    panel.restore()
  }
})

test('回收站「彻底删除」先弹确认，不会一点就抹掉', { skip: skipWithoutBundle() }, async () => {
  const doc = emptyDoc({
    skillGovernance: {
      ...GOVERNANCE,
      trash: [{ id: 't1', name: 'gone-skill', path: '/h/.dsh/skills/gone-skill', source: 'user-dsh', scope: 'global', trashedAt: new Date().toISOString() }],
    },
    workspaces: [],
  })
  const panel = await bootPanel(doc, { fetch: makeFetch(doc) })
  try {
    const skillsTab = panel.find((node) => String(node.props?.className ?? '').includes('smp-tab') && textOf(node).startsWith('Skills'))
    panel.click(skillsTab)
    const trashTab = panel.find((node) => String(node.props?.className ?? '') === 'smp-subTab' && textOf(node).startsWith('回收站'))
    assert.ok(trashTab !== null, '要有回收站子页签')
    panel.click(trashTab)

    const purge = panel.findAll((node) => node.type === 'button' && textOf(node).trim() === '彻底删除' && String(node.props?.className ?? '').includes('smp-button'))
    assert.equal(purge.length, 1, '找不到「彻底删除」按钮')
    panel.click(purge[0])

    // 点了之后应当先出现确认对话框，且还没有发出 trash-purge 命令
    const modal = panel.find((node) => String(node.props?.['data-modal'] ?? '').includes('删除'))
    assert.ok(modal !== null, '应弹出确认对话框')
    assert.equal((panel.doc.governanceCommands ?? []).some((item) => item.op === 'trash-purge'), false,
      '确认之前不该发 trash-purge')
  } finally {
    panel.restore()
  }
})



test('设计契约①：页签计数 = 摘要计数 = 列表技能数（含外部 Agent 来源）', { skip: skipWithoutBundle() }, async () => {
  /**
   * 这是设计评审第 1 条要钉住的东西：**同一份事实只能有一个数字**。
   *
   * 历史问题：页签与摘要用 `runtime.skills`（只扫 4 个原生根），列表用治理快照（含外部
   * Agent 目录），于是出现「页签 0 / 摘要 0 / 列表 12」——从别的编辑器迁过来的人会以为
   * 迁移失败了。
   */
  const panel = await boot()
  try {
    const tabText = panel.text()
    // GOVERNANCE 夹具里：user-dsh 1 个、claude 1 个、project-dsh 1 个 = 3 个，全部启用
    assert.match(tabText, /Skills（3）/, `页签计数应从治理快照取，实际文本片段：${tabText.slice(0, 120)}`)
    /**
     * 页签与摘要的数字口径是**实际生效**，不是磁盘上有几个。
     *
     * 用户的原话：页签写 `Skills (24)` 而实际生效只有 10 个，这个数字就是错的。
     * 所以摘要现在写「N 生效 / 共 M」——两个数都在，但**主数字是生效的那个**。
     */
    assert.match(tabText, /3\s*生效 \/ 共 3/, '摘要没有按"生效 / 共"的口径给出数字')
    assert.match(tabText, /1 个来自外部 Agent/, '摘要没有按治理快照统计外部来源')

    const ledgerText = () => textOf(panel.find((node) => (
      String(node.props?.className ?? '').split(/\s+/).includes('smp-ledger')
    ))).trim()

    // 默认范围是「全局」：账面上只该有全局来源的 2 个，不掺项目级那 1 个
    assert.match(ledgerText(), /2 \/ 2/, `全局范围的总账应只算全局：${ledgerText()}`)
    assert.match(ledgerText(), /全局/, '总账要标明当前是哪个范围')

    // 列表侧：默认范围是「全局」，所以列表显示 2 个（user-dsh + claude）；project-dsh 属工作区。
    // **这是有筛选器解释的差异**，不是页签/摘要那种"同一份事实两个数字"的矛盾。
    expandAll(panel)
    assert.deepEqual(skillNames(panel).sort(), ['claude-skill', 'global-skill'], '默认范围下列表应与「全局」筛选一致')
    // 把范围切到项目工作区，列表与总账都应只讲那个工作区
    const workSegment = panel.findAll((node) => String(node.props?.className ?? '').split(/\s+/).includes('smp-segment'))
      .find((node) => textOf(node).trim() === '工作区1')
    assert.ok(workSegment !== undefined, '范围分段控件里应有「工作区1」')
    panel.click(workSegment)
    expandAll(panel)
    assert.deepEqual(skillNames(panel), ['one-skill'], '切到工作区后列表应只剩该工作区的技能')
    // 选了范围，卡里就只该有那个范围的数：1 / 1，且标明是「工作区1」
    assert.match(ledgerText(), /1 \/ 1/, `工作区范围的总账应只算该工作区：${ledgerText()}`)
    assert.match(ledgerText(), /工作区1/, '总账要标明当前是哪个范围')
  } finally {
    panel.restore()
  }
})

test('设计契约①：被筛选筛空时，空状态说明还有多少被挡住并可一键清除', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot()
  try {
    // 搜索一个不存在的名字 → 列表空，但不是"没有技能"
    panel.change(panel.byPlaceholder('搜索技能名称'), 'definitely-not-a-skill')
    const text = panel.text()
    assert.equal(text.includes('还没有发现任何技能'), false, '筛选生效时不能断言"没有技能"')
    assert.match(text, /另有 \d+ 个被范围\/搜索挡住/, `空状态没说清楚被挡住的数量：${text.slice(-200)}`)

    const reset = panel.findAll((node) => node.type === 'button' && textOf(node).trim() === '清除筛选')
    assert.equal(reset.length, 1, '应提供「清除筛选」按钮')
    panel.click(reset[0])
    expandAll(panel)
    // 清除筛选把范围回到默认的「全局」：夹具里全局侧有 user-dsh + claude 两个（project-dsh 属工作区）
    assert.deepEqual(skillNames(panel).sort(), ['claude-skill', 'global-skill'], '清除筛选后应恢复全局范围内的全部技能')
  } finally {
    panel.restore()
  }
})

test('设计契约②：总账回答"模型可见几个 / 共几个"，并说明差额被哪一层挡住', { skip: skipWithoutBundle() }, async () => {
  /**
   * 总账是这个设计项的核心产出：用户不必再在脑子里对两层开关做与运算。
   *
   * 这里只钉**格式与口径**（可见 / 总数 / 两种被挡下的原因）。"点了开关数字立刻变"属于端到端
   * 行为：启停走 HTTP、快照要等下轮 `/runtime`，单元测试的假客户端不模拟那一跳，强行断言只会
   * 得到一个假绿。
   */
  const panel = await boot()
  try {
    expandAll(panel)
    const ledgerNode = () => panel.find((node) => (
      String(node.props?.className ?? '').split(/\s+/).includes('smp-ledger')
    ))
    const text = textOf(ledgerNode()).trim()

    /**
     * 卡里**只讲当前范围**：默认范围是「全局」，所以是 2 / 2
     * （夹具里 global-skill + claude-skill；one-skill 属工作区，不该被算进来）。
     */
    assert.match(text, /2 \/ 2/, `全局范围的总账应只算全局来源：${text}`)
    assert.match(text, /模型可见/, '总账没有说明这个数字是什么')
    assert.match(text, /全局/, '总账要标明当前范围')
    assert.match(text, /全部可用/, '全员启用时应说"全部可用"，而不是罗列 0 个被挡下')

    // 口径一致性：可见数 = 总数 − 被挡下（三种互斥原因：自身停用 / 来源停用 / 同名覆盖）
    const ledger = /(\d+) \/ (\d+)\s*模型可见/.exec(text)
    assert.ok(ledger !== null, `总账格式无法解析：${text}`)
    const visible = Number(ledger[1])
    const total = Number(ledger[2])
    const numOf = (pattern) => {
      const found = pattern.exec(text)
      return found === null ? 0 : Number(found[1])
    }
    const suppressedSelf = numOf(/技能停用 (\d+)/)
    const suppressedSource = numOf(/来源停用 (\d+)/)
    const suppressedShadow = numOf(/同名覆盖 (\d+)/)
    assert.equal(
      visible + suppressedSelf + suppressedSource + suppressedShadow,
      total,
      '总账数字必须自洽（可见 + 三种被挡下 = 总数）',
    )
  } finally {
    panel.restore()
  }
})
test('设计契约②：同名副本标注"被谁覆盖"，且该副本的开关不可点', { skip: skipWithoutBundle() }, async () => {
  /**
   * 同一技能在多个来源各有一份时，DSH 按 rank 决胜（数值小=优先级高），只有一份提供给模型。
   * 面板原来把它们平铺成两行，用户以为自己控制了两份 —— 另一份的开关点了也不起作用。
   *
   * 夹具里 user-dsh（rank 399）与 claude（rank 450）各有一个同名技能 dup-skill。
   */
  const duplicated = {
    ...GOVERNANCE,
    sources: [
      { ...group('user-dsh', '用户 · DSH', 'global', [{ ...mkSkill('dup-skill', 'user-dsh', 'global'), name: 'dup-skill' }]), rank: 399 },
      // 显式给不同路径：`mkSkill` 的默认路径规则会让两个副本撞成同一个 path，而"被覆盖"
      // 的判断正是按 path 区分的。
      {
        ...group('claude', 'Claude Code', 'global', [{
          ...mkSkill('dup-skill', 'claude', 'global'),
          name: 'dup-skill',
          path: '/h/.claude/skills/dup-skill/SKILL.md',
        }]),
        rank: 450,
        readonly: true,
      },
    ],
    categories: [],
  }
  const doc = emptyDoc({ skillGovernance: duplicated, workspaces: [] })
  const panel = await bootPanel(doc, { fetch: makeFetch(doc) })
  try {
    const tab = panel.find((node) => String(node.props?.className ?? '').includes('smp-tab') && textOf(node).startsWith('Skills'))
    panel.click(tab)
    expandAll(panel)
    const text = panel.text()
    assert.match(text, /被「用户 · DSH」覆盖/, `低优先级副本没有标注被谁覆盖：${text.slice(-300)}`)

    // 被覆盖那份的开关必须是 disabled（点了也不生效，不能让它看起来可操作）
    const rows = panel.findAll((node) => String(node.props?.className ?? '').split(/\s+/).includes('smp-skillCard'))
    const claudeRow = rows.find((node) => textOf(node).includes('被「用户 · DSH」覆盖'))
    assert.ok(claudeRow !== undefined, '找不到被覆盖的卡片')
    const switches = []
    const walk = (node) => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (node.props?.['role'] === 'switch') switches.push(node)
      walk(node.props?.children)
    }
    walk(claudeRow)
    assert.equal(switches.every((node) => node.props.disabled === true), true, '被覆盖的副本，开关应是禁用态')

    /**
     * 总账必须扣掉被覆盖的那一份。
     *
     * 夹具里两个副本的开关都是开的，但模型只看得到 rank 小的那份：所以「共 2」而
     * 「模型可见 1」，差额记在「同名覆盖」名下。原来这一项没扣，"模型可见 N" 比实际多算，
     * 而列表里又明晃晃写着「被 X 覆盖」—— 两个数字对不上，用户只会怀疑总账。
     */
    assert.match(text, /1 \/ 2/, `总账没扣掉被覆盖的副本：${text.slice(-260)}`)
    assert.match(text, /同名覆盖 1/, '被挡下的原因里要写清"同名覆盖"这一项')
  } finally {
    panel.restore()
  }
})
