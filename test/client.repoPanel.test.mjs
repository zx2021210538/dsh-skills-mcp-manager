/**
 * 技能仓库面板：添加 / 逐技能安装 / 已安装的状态与操作。
 *
 * 这里钉的是**请求体本身**：`repo-install` 必须把「安装目标」的三个字段一起带上
 * （scope / destId / project）。丢了它们，Host 会退回默认目标，技能就装到别处了 ——
 * 而这种错在界面上看不出来，只有回读目录才发现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootPanel, emptyDoc, skipWithoutBundle, textOf } from '../scripts/lib/client-harness.mjs'

const GOVERNANCE = '/skills-governance'

/** 只回答面板需要的三个端点：`/runtime`、治理写路由、导入写路由。 */
const makeFetch = (doc) => async (url, init) => {
  const target = String(url)
  if (target.endsWith(GOVERNANCE)) {
    doc.governanceCommands = [...(doc.governanceCommands ?? []), JSON.parse(String(init?.body ?? '{}'))]
    return { ok: true, status: 200, json: async () => ({ ok: true, reason: '' }) }
  }
  if (target.endsWith('/skills-import')) {
    doc.importCommands = [...(doc.importCommands ?? []), JSON.parse(String(init?.body ?? '{}'))]
    return { ok: true, status: 200, json: async () => ({ ok: true, reason: '', skill: { name: 'x' } }) }
  }
  if (target.endsWith('/skills-catalog')) {
    const body = JSON.parse(String(init?.body ?? '{}'))
    doc.catalogCommands = [...(doc.catalogCommands ?? []), body]
    if (body.op === 'catalog-search') {
      return {
        ok: true, status: 200,
        json: async () => ({
          ok: true,
          reason: '',
          items: [{ catalog: 'skillsh', id: 'o/r/pdf', source: 'o/r', skillId: 'pdf', name: 'PDF Tools', installs: 3 }],
        }),
      }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, reason: '', skill: { name: 'PDF Tools' } }) }
  }
  return {
    ok: true, status: 200,
    json: async () => ({
      serverTools: [], serverStatus: [], serverToolsError: { reason: '', detail: '' },
      servers: [], skills: [], skillDirs: {}, workspaces: [], currentWorkspace: '',
      filter: {}, probe: {}, oauth: { servers: {} }, discovery: {},
      skillGovernance: doc.skillGovernance,
    }),
  }
}

const ROW = {
  entryId: 'mcp-x', serverName: 'x', scope: '', transport: 'streamable-http', target: 'https://x.invalid/mcp',
  command: '', args: '', env: '', headersText: '', failOnStartupError: false,
  reconnectInitialDelayMs: '', reconnectMaxDelayMs: '', reconnectMaxAttempts: '', enabled: true, phase: 'active',
}

const boot = async (governance, over = {}) => {
  const doc = emptyDoc({ profileServers: [ROW], skillGovernance: governance, ...over })
  const panel = await bootPanel(doc, { fetch: makeFetch(doc) })
  openSkills(panel)
  return panel
}

/** 仓库 / 导入 / 市场都在「获取技能」子页签下，先切过去。 */
function openSkills(panel) {
  const tab = panel.find((node) => String(node.props?.className ?? '').includes('smp-tab') && textOf(node).startsWith('Skills'))
  assert.ok(tab !== null, '找不到 Skills 页签')
  panel.click(tab)
  const sub = panel.find((node) => String(node.props?.className ?? '') === 'smp-subTab' && textOf(node).startsWith('获取技能'))
  assert.ok(sub !== null, '找不到「获取技能」子页签')
  panel.click(sub)
}

const commands = (panel) => panel.doc.governanceCommands ?? []
const classIs = (name) => (node) => String(node.props?.className ?? '') === name
const classHas = (name) => (node) => String(node.props?.className ?? '').split(/\s+/).includes(name)

const REPO = {
  id: 'o__r',
  owner: 'o',
  name: 'r',
  skills: [
    { name: 'alpha', description: '第一个', fileCount: 2, dir: 'repo-main/skills/alpha', signature: 'sig' },
  ],
}

test('仓库技能：点「安装」发出的请求带上当前选择的安装目标', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot({ repositories: [REPO], installs: [], categories: [], trash: [] })
  try {
    const skillRow = panel.find(classHas('smp-repoSkill'))
    assert.ok(skillRow !== null, '应渲染出仓库里的技能行')
    assert.ok(textOf(skillRow).includes('alpha'))

    const install = panel.byText('安装')
    assert.ok(install !== null, '未安装的技能要有「安装」按钮')
    panel.click(install)
    await panel.settle()

    const sent = commands(panel)
    assert.equal(sent.length, 1, `应发出一条治理命令，实际 ${sent.length}`)
    assert.equal(sent[0].op, 'repo-install')
    assert.equal(sent[0].id, 'o__r')
    assert.equal(sent[0].skill, 'alpha')
    assert.equal(sent[0].scope, 'global', '默认目标 = 用户目录')
    assert.equal(sent[0].destId, 'dsh', '默认位置 = DSH skills')
    assert.equal(sent[0].project, '')
    // 仓库操作走 HTTP，不该写 settings 文档（写一次会让设置壳层重挂载）
    assert.deepEqual(panel.doc.setCalls ?? [], [])
  } finally {
    panel.restore()
  }
})

test('安装目标改到「指定工作区」但没选工作区时，安装按钮不可点', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot(
    { repositories: [REPO], installs: [], categories: [], trash: [] },
    { workspaces: [{ path: '/p/one', title: 'one' }] },
  )
  try {
    const scopeSelect = panel.findAll((node) => node.type === 'select' && node.props['aria-label'] === '安装范围')
    assert.equal(scopeSelect.length, 1)
    panel.change(scopeSelect[0], 'project')

    const install = panel.byText('安装')
    assert.equal(install.props.disabled, true, '没选工作区时不能安装')

    // 选了工作区就可以
    const projectSelect = panel.findAll((node) => node.type === 'select' && node.props['aria-label'] === '目标工作区')
    assert.equal(projectSelect.length, 1, '切到项目级后应出现工作区下拉')
    panel.change(projectSelect[0], '/p/one')
    assert.equal(panel.byText('安装').props.disabled, false)
  } finally {
    panel.restore()
  }
})

test('已安装技能：「检查更新」在技能卡片的「…」里，发 repo-preview 且状态跟着结果出现', { skip: skipWithoutBundle() }, async () => {
  /**
   * 这块原先是「获取技能 → 已安装」里的一个独立列表。现在是**同一个技能卡片**上的 `…`：
   * 更新 / 回滚 / 卸载是"某个技能"的动作，不是"某张清单"的动作。
   */
  const install = {
    id: 'repo-global-dsh-alpha', repoId: 'o__r', skill: 'alpha', name: 'alpha',
    dir: '/skills/alpha', scope: 'global', destId: 'dsh', project: '',
    installedAt: '2026-01-01T00:00:00.000Z',
  }
  const doc = {
    repositories: [REPO], installs: [install], categories: [], trash: [], skills: [],
    // 面板只有在 Host 确实装了 skills 服务时才渲染分组视图
    providerInstalled: true,
    // 技能页按 `sources` 分组渲染；卡片的 `…` 靠落盘目录 `/skills/alpha` 对上安装记录
    sources: [{
      key: 'user-dsh', label: 'DSH 用户目录', path: '/tmp/smp-home/skills',
      scope: 'global', rank: 400, native: true, exists: true, enabled: true, readonly: false,
      policyKey: 'user-dsh', count: 1,
      skills: [{
        name: 'alpha', description: '', path: '/skills/alpha/SKILL.md', source: 'user-dsh',
        scope: 'global', rank: 400, ownEnabled: true, enabled: true,
      }],
    }],
  }
  const panel = await bootPanel(emptyDoc({ profileServers: [ROW], skillGovernance: doc }), {
    fetch: async (url, init) => {
      if (String(url).endsWith(GOVERNANCE)) {
        const body = JSON.parse(String(init?.body ?? '{}'))
        body.__recorded = true
        doc.governanceCommands = [...(doc.governanceCommands ?? []), body]
        return {
          ok: true, status: 200,
          json: async () => ({
            ok: true, reason: '',
            preview: { status: 'update-available', additions: ['new.md'], removals: [], changes: ['SKILL.md'] },
          }),
        }
      }
      return {
        ok: true, status: 200,
        json: async () => ({
          serverTools: [], serverStatus: [], serverToolsError: { reason: '', detail: '' },
          servers: [], skills: [], skillDirs: {}, workspaces: [], currentWorkspace: '',
          filter: {}, probe: {}, oauth: { servers: {} }, discovery: {}, skillGovernance: doc,
        }),
      }
    },
  })
  try {
    openSkills(panel)

    // 子页签会记住上次停留的位置（同一进程里前面的用例点过「获取技能」），
    // 所以这里显式点到「技能」再找卡片。
    const skillsTab = panel.find((node) => (
      String(node.props?.className ?? '').split(/\s+/).includes('smp-subTab')
      && textOf(node).trim().startsWith('技能')
    ))
    assert.ok(skillsTab !== null, '找不到「技能」子页签')
    panel.click(skillsTab)
    await panel.settle()

    // 来源分组默认折叠，先展开那一组才能看到卡片
    const toggle = panel.find((node) => (
      String(node.props?.className ?? '').split(/\s+/).includes('smp-skillSourceToggle')
      && node.props['aria-expanded'] === false
    ))
    assert.ok(toggle !== null, '来源分组应可展开')
    panel.click(toggle)
    await panel.settle()

    const trigger = panel.find((node) => String(node.props?.className ?? '').includes('smp-skillMoreTrigger'))
    assert.ok(trigger !== null, '仓库装进来的技能卡片上要有「…」')
    panel.click(trigger)
    await panel.settle()

    const check = panel.byText('检查更新')
    assert.ok(check !== null, '展开「…」后要有「检查更新」')
    panel.click(check)
    await panel.settle()

    const sent = doc.governanceCommands ?? []
    assert.equal(sent.length, 1)
    assert.equal(sent[0].op, 'repo-preview')
    assert.equal(sent[0].id, 'repo-global-dsh-alpha')

    // 状态标签与 diff 摘要都要出现（用户据此判断能不能直接更新）
    assert.ok(panel.text().includes('有更新'), `应显示「有更新」：${panel.text().slice(0, 200)}`)
    assert.ok(panel.text().includes('新增 1'), '应显示 diff 摘要')
  } finally {
    panel.restore()
  }
})

test('仓库行：「刷新」「移除」各自发出对应命令', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot({ repositories: [REPO], installs: [], categories: [], trash: [] })
  try {
    panel.click(panel.byText('刷新'))
    await panel.settle()
    panel.click(panel.byText('移除'))
    await panel.settle()

    const ops = commands(panel).map((command) => command.op)
    assert.deepEqual(ops, ['repo-refresh', 'repo-remove'])
  } finally {
    panel.restore()
  }
})


test('导入目录：发出的请求带上路径、可选名字与当前安装目标', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot({ repositories: [], installs: [], categories: [], trash: [] })
  try {
    const pathInput = panel.find((node) => node.type === 'input' && node.props['aria-label'] === '技能目录路径')
    assert.ok(pathInput !== null, '要有目录路径输入框')
    const nameInput = panel.find((node) => node.type === 'input' && node.props['aria-label'] === '导入的技能名')
    panel.change(pathInput, 'D:/skills/my-skill')
    panel.change(nameInput, 'my-skill')

    panel.click(panel.byText('导入目录'))
    await panel.settle()

    const sent = panel.doc.importCommands ?? []
    assert.equal(sent.length, 1, `应发出一条导入命令，实际 ${sent.length}`)
    assert.equal(sent[0].op, 'import-folder')
    assert.equal(sent[0].path, 'D:/skills/my-skill')
    assert.equal(sent[0].name, 'my-skill')
    assert.equal(sent[0].scope, 'global')
    assert.equal(sent[0].destId, 'dsh')
    // 导入同样不写 settings 文档
    assert.deepEqual(panel.doc.setCalls ?? [], [])
  } finally {
    panel.restore()
  }
})

test('市场：搜索把结果渲染出来，点「安装」带上市场标识与目标', { skip: skipWithoutBundle() }, async () => {
  const panel = await boot({ repositories: [], installs: [], categories: [], trash: [] })
  try {
    const query = panel.find((node) => node.type === 'input' && node.props['aria-label'] === '市场搜索词')
    assert.ok(query !== null, '要有市场搜索框')
    panel.change(query, 'pdf')

    panel.click(panel.byText('搜索'))
    await panel.settle()

    const all = panel.doc.catalogCommands ?? []
    assert.equal(all.length, 1)
    assert.equal(all[0].op, 'catalog-search')
    assert.equal(all[0].catalog, 'skillsh')
    assert.equal(all[0].q, 'pdf')

    // 结果行要显示名称，安装按钮能把标识带回去
    assert.ok(panel.text().includes('PDF Tools'), `结果应渲染出名称：${panel.text().slice(0, 200)}`)
    const install = panel.findAll((node) => node.type === 'button' && textOf(node).trim() === '安装')
    assert.equal(install.length, 1, '结果行应有一个安装按钮')
    panel.click(install[0])
    await panel.settle()

    const sent = (panel.doc.catalogCommands ?? [])
    assert.equal(sent.length, 2)
    assert.equal(sent[1].op, 'catalog-install')
    assert.equal(sent[1].catalog, 'skillsh')
    assert.equal(sent[1].source, 'o/r')
    assert.equal(sent[1].skillId, 'pdf')
    assert.equal(sent[1].scope, 'global')
    assert.equal(sent[1].destId, 'dsh')
  } finally {
    panel.restore()
  }
})

test('获取技能页：控件走「表单行」（12px 标签 + 32px 控件），不再塞进列表行样式的盒子', { skip: skipWithoutBundle() }, async () => {
  /**
   * 上一版的样式问题：字段标签（安装 / 导入目标）用了跟区块标题一样的 14px/500，还装在
   * 带边框的 `smp-skillCategoryRow` 里，于是既像标题又像输入框，整页读不出层级。
   *
   * 现在三层分开：区块标题 14px → 字段标签 12px/二级色 → 控件 32px。
   */
  const panel = await boot({ repositories: [REPO], installs: [], categories: [], trash: [] })
  try {
    const labels = panel.findAll((node) => String(node.props?.className ?? '').split(/\s+/).includes('smp-formRowLabel'))
      .map((node) => textOf(node).trim())
    for (const wanted of ['安装 / 导入目标', '仓库地址', '从文件', '从目录', '搜索市场']) {
      assert.ok(labels.includes(wanted), `缺少表单标签「${wanted}」：${JSON.stringify(labels)}`)
    }

    // 每个标签都必须在「表单行」里，而不是列表行里
    const rows = panel.findAll((node) => String(node.props?.className ?? '').split(/\s+/).includes('smp-formRow'))
    assert.ok(rows.length >= 5, `表单行数量不足：${rows.length}`)

    const css = readFileSync(join(process.cwd(), 'lib', 'src', 'styles', 'panel.css'), 'utf8')
    const labelRule = /\.smp-formRowLabel\{[^}]*\}/.exec(css)
    assert.ok(labelRule !== null, 'CSS 里要有 .smp-formRowLabel')
    assert.match(labelRule[0], /font-size:12px/, '字段标签必须比区块标题（14px）小一档')
    assert.match(labelRule[0], /color:var\(--dsw-alias-label-secondary\)/, '字段标签用二级色，不能和主色标题同级')

    const controlRule = /\.smp-formRowBody > \.smp-input,\s*\.smp-formRowBody > \.smp-select\{[^}]*\}/.exec(css)
    assert.ok(controlRule !== null, 'CSS 里要有表单行的控件尺寸规则')
    assert.match(controlRule[0], /height:32px/, '控件统一 32px（原生文件框也压到这一档）')
  } finally {
    panel.restore()
  }
})

