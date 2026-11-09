/**
 * provider 的项目级技能作用域。
 *
 * 背景：治理快照是跨工作区的（面板要管理所有工作区），但模型目录不能跨。provider 挂在
 * global 层，它的候选会并进**每个** agent 的目录 —— 不过滤就等于把 A 项目的技能指令递给
 * B 项目的模型。DSH 原生 `dsh-skill-filesystem` 按会话 cwd 的项目根给项目级技能上作用域，
 * 这里必须跟它一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGovernanceProvider } from '../src/skills/provider.js'

const namesOf = (candidates) => candidates.map((item) => item.name).sort()

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'smp-provider-scope-'))
  const repoA = join(home, 'repoA')
  const repoB = join(home, 'repoB')
  mkdirSync(join(repoA, '.git'), { recursive: true })
  mkdirSync(join(repoA, 'packages', 'web'), { recursive: true })
  mkdirSync(join(repoB, '.git'), { recursive: true })
  const skills = [
    // 用户级：所有会话都能用
    { name: 'global-skill', scope: 'global', source: 'user-dsh', enabled: true, rank: 399, description: '', path: join(home, '.dsh', 'skills', 'global-skill', 'SKILL.md') },
    // A 项目：只有 A 的会话能用
    { name: 'alpha', scope: repoA, source: 'project-dsh', enabled: true, rank: 99, description: '', path: join(repoA, '.dsh', 'skills', 'alpha', 'SKILL.md') },
    // A 项目里被停用的那个：在 A 里仍要出现（invocation=false），在 B 里不出现
    { name: 'alpha-off', scope: repoA, source: 'project-agents', enabled: false, rank: 199, description: '', path: join(repoA, '.agents', 'skills', 'alpha-off', 'SKILL.md') },
    // B 项目：只有 B 的会话能用
    { name: 'beta', scope: repoB, source: 'project-dsh', enabled: true, rank: 99, description: '', path: join(repoB, '.dsh', 'skills', 'beta', 'SKILL.md') },
    // 历史快照/外部来源没有 scope：按用户级处理（生产快照由 governance.js 保证带 scope）
    { name: 'legacy', source: 'claude', enabled: true, rank: 450, description: '', path: join(home, '.claude', 'skills', 'legacy', 'SKILL.md') },
  ]
  return { home, repoA, repoB, skills }
}

test('provider：cwd 只决定项目级技能，用户级技能对所有会话可见', async () => {
  const { repoA, repoB, skills } = fixture()
  const provider = createGovernanceProvider({ snapshot: async () => ({ skills }) })

  assert.deepEqual(namesOf(await provider.list({ cwd: repoA })), ['alpha', 'alpha-off', 'global-skill', 'legacy'])
  assert.deepEqual(namesOf(await provider.list({ cwd: join(repoA, 'packages', 'web') })), ['alpha', 'alpha-off', 'global-skill', 'legacy'],
    '子目录会话属于同一个项目根')
  assert.deepEqual(namesOf(await provider.list({ cwd: repoB })), ['beta', 'global-skill', 'legacy'],
    'B 项目不能看到 A 项目的技能')
})

test('provider：没有 cwd 时与 DSH 原生一致——不列项目级技能', async () => {
  const { skills } = fixture()
  const provider = createGovernanceProvider({ snapshot: async () => ({ skills }) })
  assert.deepEqual(namesOf(await provider.list()), ['global-skill', 'legacy'],
    'cwd 缺失时 DSH 原生 provider 也不读项目根，我们不能多给')
  assert.deepEqual(namesOf(await provider.list({})), ['global-skill', 'legacy'])
})

test('provider：停用的项目级技能只在自己的项目里出现，且仍不可调用', async () => {
  const { repoA, repoB, skills } = fixture()
  const provider = createGovernanceProvider({ snapshot: async () => ({ skills }) })

  const inA = (await provider.list({ cwd: repoA })).find((item) => item.name === 'alpha-off')
  assert.ok(inA !== undefined, 'A 项目的停用技能必须仍被列出（面板要显示已停用）')
  assert.equal(inA.invocation.modelInvocable, false)
  assert.equal(inA.invocation.userInvocable, false)
  assert.equal((await provider.list({ cwd: repoB })).some((item) => item.name === 'alpha-off'), false)
})

test('provider：快照失败回退的是未过滤快照，按调用方 cwd 重新过滤', async () => {
  const { repoA, repoB, skills } = fixture()
  let fail = false
  const provider = createGovernanceProvider({
    snapshot: async () => {
      if (fail) throw new Error('EBUSY: state.json')
      return { skills }
    },
  })
  await provider.list({ cwd: repoA })
  fail = true
  assert.deepEqual(namesOf(await provider.list({ cwd: repoB })), ['beta', 'global-skill', 'legacy'],
    '回退缓存不能把上一次 cwd 的过滤结果端给另一个工作区')
})

test('provider：策略失效后不再用旧快照兜底（代价是本次读取可能让停用短暂失效）', async () => {
  const { repoA, skills } = fixture()
  let fail = false
  const provider = createGovernanceProvider({
    snapshot: async () => {
      if (fail) throw new Error('EBUSY: state.json')
      return { skills }
    },
  })
  assert.ok((await provider.list({ cwd: repoA })).length > 0)
  provider.resetCache()
  fail = true
  assert.deepEqual(await provider.list({ cwd: repoA }), [], '失效后读盘失败要返回空，而不是停用前的策略')
  /**
   * 注意这里的取舍：返回空列表 = 我们不再输出 invocation=false 的影子候选，原生 rank 100/200
   * 条目仍然可调用 —— 对「停用」来说这一次是 fail-open。另一条路是保留旧快照，但那样会把
   * 停用前的策略当成答案（同样 fail-open，还更隐蔽）。空列表至少让「我们没读到盘」这件事
   * 可被下一次成功读取立即纠正。
   */
})
