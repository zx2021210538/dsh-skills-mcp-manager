/**
 * components/filters 接口测试：名称搜索与页签计数标签。
 *
 * `filterByName` / `serversForScope` 已删除：面板全部直接用 `matchesName` 过滤，
 * 这两个导出只剩自己的测试在用。测试也一并删掉，避免「死代码 + 为死代码续命的测试」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchesName, tabLabel } from '../lib/src/components/filters.js'

test('matchesName：只按名称、忽略大小写、空查询全通过', () => {
  assert.equal(matchesName('Demo-Skill', 'demo'), true)
  assert.equal(matchesName('github', 'HUB'), true, '大小写不敏感：github 含 hub')
  assert.equal(matchesName('github', 'gitlab'), false)
  assert.equal(matchesName('anything', '  '), true)
  assert.equal(matchesName(undefined, 'x'), false)
})

test('tabLabel：标签带计数（0 也照实显示）', () => {
  assert.equal(tabLabel('MCP', 5), 'MCP（5）')
  assert.equal(tabLabel('Skills', 0), 'Skills（0）')
})
