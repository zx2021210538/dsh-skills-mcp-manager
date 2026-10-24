/**
 * lib/src/skillInstalls.js 单测：把安装记录对到治理快照里的技能上。
 *
 * 匹配依据是**落盘目录**，不是名字 —— 同名技能可以同时存在于不同来源，
 * 只有目录能确定"这一份是装进来的"（也就只有它才有更新/回滚/卸载可谈）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installForSkill, installMapForSkills } from '../lib/src/skillInstalls.js'

const install = (overrides = {}) => ({
  id: 'inst-1',
  repoId: 'repo-1',
  skill: 'alpha',
  name: 'alpha',
  dir: 'C:/Users/tester/.dsh/skills/alpha',
  scope: 'global',
  destId: 'dsh',
  ...overrides,
})

test('installForSkill：按落盘目录匹配，Windows 反斜杠与大小写不影响', () => {
  const found = installForSkill(
    [install({ dir: 'C:\\Users\\Tester\\.dsh\\skills\\alpha' })],
    'C:/Users/tester/.dsh/skills/alpha/SKILL.md',
    'global',
  )
  assert.equal(found?.id, 'inst-1')
})

test('installForSkill：目录对不上就是普通技能（返回 null）', () => {
  assert.equal(installForSkill([install()], 'C:/skills/other/SKILL.md', 'global'), null)
  // 名字相同但目录不同 → 也不是同一个东西
  assert.equal(installForSkill([install()], 'C:/elsewhere/alpha/SKILL.md', 'global'), null)
})

test('installForSkill：非数组 / 空数组按「没有任何安装」处理', () => {
  assert.equal(installForSkill(null, 'C:/x/SKILL.md', 'global'), null)
  assert.equal(installForSkill([], 'C:/x/SKILL.md', 'global'), null)
})

test('installForSkill：早期记录没有 dir 时按名字兜底，但必须作用域一致', () => {
  const legacy = install({ dir: '', name: 'alpha', scope: 'global' })
  assert.equal(installForSkill([legacy], 'C:/Users/tester/.dsh/skills/alpha/SKILL.md', 'global')?.id, 'inst-1')
  // 同一份记录不能认成项目层的那份
  assert.equal(installForSkill([legacy], 'C:/ws/.dsh/skills/alpha/SKILL.md', 'project'), null)
})

test('installMapForSkills：只给"装进来的"技能建索引', () => {
  const map = installMapForSkills(
    [install()],
    [
      { name: 'alpha', path: 'C:/Users/tester/.dsh/skills/alpha/SKILL.md', scope: 'global' },
      { name: 'beta', path: 'C:/Users/tester/.dsh/skills/beta/SKILL.md', scope: 'global' },
    ],
  )
  assert.equal(map.size, 1)
  assert.equal(map.get('C:/Users/tester/.dsh/skills/alpha/SKILL.md')?.id, 'inst-1')
})
