/**
 * 「添加」对话框的默认工作区。
 *
 * 旧实现取**第一个 live agent** 的 cwd 再归一化：多会话时默认目标会落到另一个项目上
 * （MCP 挂到了别人 scope、技能写进了别的工作区），而且没有提示。现在 Host 只在能确定时
 * 给值：`currentWorkspace`（注册表路径，MCP 用）与 `currentWorkspaceRoot`（项目根，技能用）；
 * 不能确定时为空，对话框显示「全局 / 请选择工作区」，由用户决定。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootPanel, emptyDoc, skipWithoutBundle, textOf } from '../scripts/lib/client-harness.mjs'

const doc = (overrides = {}) => emptyDoc({
  servers: [], profileServers: [], skills: [], discoveredSkills: [],
  workspaces: [], currentWorkspace: '', currentWorkspaceRoot: '',
  ...overrides,
})

const openSkillsTab = (panel) => {
  panel.click(panel.find((node) => String(node.props?.className ?? '').includes('smp-tab') && textOf(node).startsWith('Skills')))
}
const openMcpAdd = (panel) => {
  panel.click(panel.find((node) => String(node.props?.className ?? '').includes('smp-button') && textOf(node).trim() === '添加服务器'))
}
const openSkillAdd = (panel) => {
  panel.click(panel.find((node) => String(node.props?.className ?? '').includes('smp-button') && textOf(node).trim() === '添加技能'))
}
/** MCP 表单里的作用域下拉（唯一带「自定义路径…」的那个）。 */
const scopeSelect = (panel) => panel.findAll((node) => node.type === 'select'
  && (node.children ?? []).flat(4).some((option) => option?.props?.value === '__custom__'))[0]
/** 技能对话框的层级下拉（全局 / 项目级）。 */
const tierSelect = (panel) => panel.findAll((node) => node.type === 'select'
  && (node.children ?? []).flat(4).some((option) => option?.props?.value === 'project'))[0]

test('默认值：单会话时 MCP 预选注册表路径、技能预选项目根', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(doc({
    currentWorkspace: '/p/tcl',
    currentWorkspaceRoot: '/p/tcl-root',
    workspaces: [{ id: 'w1', title: 'tcl', path: '/p/tcl', root: '/p/tcl-root' }],
  }))
  try {
    openMcpAdd(panel)
    assert.equal(scopeSelect(panel).props.value, '/p/tcl',
      'MCP 作用域按路径前缀匹配，默认值必须是注册表路径而不是 Git 根')
  } finally {
    panel.restore()
  }

  const skills = await bootPanel(doc({
    currentWorkspace: '/p/tcl',
    currentWorkspaceRoot: '/p/tcl-root',
    workspaces: [{ id: 'w1', title: 'tcl', path: '/p/tcl', root: '/p/tcl-root' }],
  }))
  try {
    openSkillsTab(skills)
    openSkillAdd(skills)
    skills.change(tierSelect(skills), 'project')
    assert.equal(scopeSelect(skills).props.value, '/p/tcl-root',
      '技能写盘按 projectRootOf 归一化，默认值必须是仓库根')
  } finally {
    skills.restore()
  }
})

test('默认值：多个工作区同时活跃时不给项目默认值（MCP 回到「全局」，技能留空）', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(doc({
    // Host 在两个工作区同时活跃时这两个字段都是空 —— 不能拿第一个会话猜。
    currentWorkspace: '', currentWorkspaceRoot: '',
    workspaces: [
      { id: 'w1', title: 'a', path: '/p/a', root: '/p/a' },
      { id: 'w2', title: 'b', path: '/p/b', root: '/p/b' },
    ],
  }))
  try {
    openMcpAdd(panel)
    assert.equal(scopeSelect(panel).props.value, 'global', '不给默认时 MCP 应显示「全局」，而不是某个工作区')
  } finally {
    panel.restore()
  }

  const skills = await bootPanel(doc({
    currentWorkspace: '', currentWorkspaceRoot: '',
    workspaces: [
      { id: 'w1', title: 'a', path: '/p/a', root: '/p/a' },
      { id: 'w2', title: 'b', path: '/p/b', root: '/p/b' },
    ],
  }))
  try {
    openSkillsTab(skills)
    openSkillAdd(skills)
    skills.change(tierSelect(skills), 'project')
    assert.equal(scopeSelect(skills).props.value, '', '技能工作区应留空（「请选择工作区」），不能预选一个')
  } finally {
    skills.restore()
  }
})

test('默认值：只有项目根能确定时，技能仍预选根（同仓库多个工作区）', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(doc({
    // 两个工作区在同一个 Git 仓库里：MCP 的路径不确定，但技能的项目根唯一。
    currentWorkspace: '', currentWorkspaceRoot: '/p/repo',
    workspaces: [
      { id: 'w1', title: 'a', path: '/p/repo/a', root: '/p/repo' },
      { id: 'w2', title: 'b', path: '/p/repo/b', root: '/p/repo' },
    ],
  }))
  try {
    openSkillsTab(panel)
    openSkillAdd(panel)
    panel.change(tierSelect(panel), 'project')
    assert.equal(scopeSelect(panel).props.value, '/p/repo', '技能默认值只看项目根，根唯一就够')
  } finally {
    panel.restore()
  }
})
