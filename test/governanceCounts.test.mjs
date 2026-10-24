/**
 * lib/src/governanceCounts.js 单测：数字口径 = **按当前范围、按实际生效**。
 *
 * 这两条口径都被用户当面纠正过：
 *   · 页签写「Skills (24)」而实际生效只有 10 个 —— 数字回答的问题错了；
 *   · 选了工作区，卡里还并排写着全局的统计 —— 卡里混了别的范围。
 * 所以口径收敛到这一个纯函数，页签/摘要/总账都调它。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countSkills } from '../lib/src/governanceCounts.js'

const skill = (name, overrides = {}) => ({
  name,
  path: `/h/${name}/SKILL.md`,
  scope: 'global',
  ownEnabled: true,
  enabled: true,
  ...overrides,
})

const source = (overrides = {}) => ({
  key: 'user-dsh',
  scope: 'global',
  rank: 400,
  skills: [],
  ...overrides,
})

test('countSkills：只数当前范围，不把别的范围算进来', () => {
  const sources = [
    source({ key: 'user-dsh', scope: 'global', skills: [skill('a'), skill('b')] }),
    source({ key: 'project-dsh', scope: '/p/one', skills: [skill('c', { scope: '/p/one', path: '/p/one/c/SKILL.md' })] }),
  ]
  assert.deepEqual(countSkills(sources, 'global'), { total: 2, visible: 2, shadowed: 0, disabledSelf: 0, disabledSource: 0 })
  assert.deepEqual(countSkills(sources, '/p/one'), { total: 1, visible: 1, shadowed: 0, disabledSelf: 0, disabledSource: 0 })
  assert.equal(countSkills(sources, 'all').total, 3)
})

test('countSkills：可见数扣掉三种互斥原因（自身停用 / 来源停用 / 同名覆盖）', () => {
  const sources = [
    source({
      rank: 400,
      skills: [
        skill('ok'),
        skill('self-off', { ownEnabled: false, enabled: false }),
        skill('src-off', { enabled: false }),
        skill('dup'),
      ],
    }),
    // 同名 dup 的另一份，rank 更大 → 被覆盖
    source({ key: 'claude', rank: 450, skills: [skill('dup', { path: '/h/claude/dup/SKILL.md' })] }),
  ]
  const counted = countSkills(sources, 'all')
  assert.equal(counted.total, 5)
  assert.equal(counted.visible, 2, '只有 ok 与 dup（rank 小的那份）可见')
  assert.equal(counted.disabledSelf, 1)
  assert.equal(counted.disabledSource, 1)
  assert.equal(counted.shadowed, 1)
  // 自洽：可见 + 三种被挡下 = 总数
  assert.equal(
    counted.visible + counted.disabledSelf + counted.disabledSource + counted.shadowed,
    counted.total,
  )
})

test('countSkills：来源整体停用时，它下面的技能算「来源停用」而不是「同名覆盖」', () => {
  const sources = [
    source({ skills: [skill('a'), skill('b')] }),
    // 同一份来源停用后，它下面所有技能的有效值都是 false
    source({ key: 'claude', rank: 450, skills: [skill('a', { path: '/h/claude/a/SKILL.md', enabled: false })] }),
  ]
  const counted = countSkills(sources, 'all')
  assert.equal(counted.visible, 2)
  assert.equal(counted.shadowed, 0, '来源停用的那份不参与"谁覆盖谁"')
  assert.equal(counted.disabledSource, 1)
})

test('countSkills：非数组输入按空处理（别抛异常）', () => {
  assert.deepEqual(countSkills(null, 'all'), { total: 0, visible: 0, shadowed: 0, disabledSelf: 0, disabledSource: 0 })
  assert.deepEqual(countSkills([], 'global'), { total: 0, visible: 0, shadowed: 0, disabledSelf: 0, disabledSource: 0 })
})
