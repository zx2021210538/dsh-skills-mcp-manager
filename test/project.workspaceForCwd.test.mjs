/**
 * `workspaceForCwd`：把一个会话的工作目录映射到已注册工作区。
 *
 * 面板用它给「项目级」默认值：只有一个确定的工作区时才预选，多工作区同时活跃时必须留空。
 * 判定与 MCP 项目级挂载共用 `scopeCovers`（目录前缀 + Windows 归一化），嵌套工作区取最长前缀。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { singleWorkspaceForCwds, workspaceForCwd } from '../src/project/mount.js'

const ws = (...paths) => paths.map((path, index) => ({ id: `w${index}`, title: `t${index}`, path }))

test('workspaceForCwd：工作区根与子目录都算命中', () => {
  const workspaces = ws('/p/tcl', '/p/other')
  assert.equal(workspaceForCwd('/p/tcl', workspaces), '/p/tcl')
  assert.equal(workspaceForCwd('/p/tcl/packages/web', workspaces), '/p/tcl')
  assert.equal(workspaceForCwd('/p/other/sub', workspaces), '/p/other')
})

test('workspaceForCwd：嵌套工作区取最长的注册路径', () => {
  const workspaces = ws('/p/repo', '/p/repo/packages/web')
  assert.equal(workspaceForCwd('/p/repo/packages/web/src', workspaces), '/p/repo/packages/web')
  assert.equal(workspaceForCwd('/p/repo/other', workspaces), '/p/repo')
})

test('workspaceForCwd：前缀相似但不同的目录不算命中', () => {
  const workspaces = ws('/p/app')
  assert.equal(workspaceForCwd('/p/application', workspaces), '', '"/p/app" 不能覆盖 "/p/application"')
  assert.equal(workspaceForCwd('/p', workspaces), '')
})

test('workspaceForCwd：没有命中、空 cwd、空注册表都返回空', () => {
  assert.equal(workspaceForCwd('/p/nowhere', ws('/p/app')), '')
  assert.equal(workspaceForCwd('', ws('/p/app')), '')
  assert.equal(workspaceForCwd('/p/app', []), '')
  assert.equal(workspaceForCwd(null, ws('/p/app')), '')
  assert.equal(workspaceForCwd('/p/app', undefined), '')
})

test('workspaceForCwd：Windows 上分隔符与大小写不同的同一路径算命中', { skip: process.platform !== 'win32' }, () => {
  const workspaces = ws('C:\\Work\\App')
  assert.equal(workspaceForCwd('C:/Work/App', workspaces), 'C:\\Work\\App')
  assert.equal(workspaceForCwd('c:\\work\\app\\sub', workspaces), 'C:\\Work\\App')
})

test('singleWorkspaceForCwds：所有会话属于同一个工作区时才给默认值', () => {
  const workspaces = ws('/p/a', '/p/b')
  assert.equal(singleWorkspaceForCwds(['/p/a', '/p/a/sub'], workspaces), '/p/a',
    '同一工作区里的多个会话（含子目录）仍算同一个')
  assert.equal(singleWorkspaceForCwds(['/p/a', '/p/b'], workspaces), '',
    '两个工作区同时活跃时不猜')
  assert.equal(singleWorkspaceForCwds(['/p/a', '/p/elsewhere'], workspaces), '',
    '有一个会话不属于任何已注册工作区时不猜')
  assert.equal(singleWorkspaceForCwds([], workspaces), '')
  assert.equal(singleWorkspaceForCwds(undefined, workspaces), '')
})
