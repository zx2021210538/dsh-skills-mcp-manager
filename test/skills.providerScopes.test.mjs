/**
 * 技能治理 provider 的**分作用域**注册：root + 每个 agent 的 scope。
 *
 * ## 这条测试钉的是什么
 *
 * DSH 0.2.1 的 skills 服务是分层的：`dsh-skill/lib/index.js:298-330` 的 `collectFresh()`
 * 按 `[global, ...chainLayers(scope)]` 合并，**更近的作用域层同名条目直接胜出**，rank 只在
 * 同一层内决胜。桌面版把原生 `skill-filesystem` 从宿主层挪到了每个 agent preset 的 scope
 * （`dsh-web-app/cordis.patch.yml:505-518`、`presets/*.patch.yml`）。
 *
 * 因此「面板停用 → 模型侧不可调用」不能只靠 root（global 层）的 `rank = 原生 − 1`：那条候选
 * 会在「层」这一关输给 preset。修复是把同一份 provider 也注册进**每个 agent 自己的 scope**
 * （`registerGovernanceProvider(agent.ctx…)`），让它与 preset 同链且更近。
 *
 * 这里用 stub 的 agents/skills 钉住生命周期与语义：
 *   · 现有 agent（apply 时 `agents.list()` 里已有的）都注册；
 *   · 后创建的 agent 也注册；
 *   · disposed 后 disposer 被调用、记账清掉；
 *   · created 事件与 list() 重叠时不重复注册；
 *   · 插件卸载时全部释放；
 *   · 缺 `skills` 服务 / `agent.ctx` 不可用时安全降级，不把插件拖垮；
 *   · 候选语义不变：停用者仍是同名、rank = 原生 − 1、invocation 双 false。
 *
 * 「agent 层一定赢 preset 层」是宿主规则，不是本插件的实现细节；本文件只证明**注册落到了
 * agent 的 ctx 上**（fixture 记录 inject 发生在哪个 ctx），以及注册/释放生命周期正确。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  createGovernanceProvider,
  createGovernanceRegistrar,
  registerGovernanceProvider,
  PROVIDER_NAME,
} from '../src/skills/provider.js'
import { NATIVE_RANKS, POLICY_RANK_OFFSET, policyRank } from '../src/skills/sources.js'

/** A `skills` service stub: records every factory, its control spies, and its disposer. */
function fakeSkills() {
  const registrations = []
  const service = {
    registerProvider(create) {
      const record = { provider: null, control: null, invalidated: 0, disposed: false }
      const controller = new AbortController()
      const control = {
        signal: controller.signal,
        invalidate() {
          record.invalidated += 1
        },
      }
      record.control = control
      record.provider = create(control)
      registrations.push(record)
      return () => {
        record.disposed = true
        controller.abort(new Error('governance provider disposed'))
      }
    },
  }
  return { service, registrations }
}

/** A minimal cordis-like ctx for `inject(['skills'], cb)`; returns a disposable fiber. */
function fakeCtx(fixture, { skills = true, throwOnInject = false } = {}) {
  const fiber = {
    disposed: false,
    dispose() {
      if (this.disposed) return
      this.disposed = true
      fixture.fibers.push(this)
    },
  }
  return {
    inject(deps, callback) {
      fixture.injects.push({ deps, skills })
      if (throwOnInject) throw new Error('agent context is already disposed')
      if (skills) callback({ skills: fixture.skillsService })
      return fiber
    },
  }
}

/** Snapshot stub: one disabled native skill + one enabled external one. */
const disabledSnapshot = () => ({
  skills: [
    {
      name: 'archify',
      description: '架构图',
      source: 'project-agents',
      rank: policyRank('project-agents'),
      enabled: false,
      path: '/workspace/.agents/skills/archify/SKILL.md',
    },
    {
      name: 'claude-only',
      description: '',
      source: 'claude',
      rank: policyRank('claude'),
      enabled: true,
      path: '/home/user/.claude/skills/claude-only/SKILL.md',
    },
  ],
})

function harness({ snapshot = disabledSnapshot } = {}) {
  const skills = fakeSkills()
  const fixture = {
    skillsService: skills.service,
    registrations: skills.registrations,
    injects: [],
    fibers: [],
    logs: [],
  }
  const registrar = createGovernanceRegistrar({
    snapshot,
    log: (message) => fixture.logs.push(message),
  })
  return { registrar, fixture }
}

let agentSeq = 0
function makeAgent(fixture, options = {}) {
  agentSeq += 1
  return { id: `agent-${agentSeq}`, ctx: fakeCtx(fixture, options) }
}

test('attachAgent：每个 agent 都在**自己的 ctx** 上注册，且候选语义不变（rank−1、停用者 invocation=false）', async () => {
  const { registrar, fixture } = harness()
  const first = makeAgent(fixture)
  const second = makeAgent(fixture)

  assert.equal(registrar.attachAgent(first), true)
  assert.equal(registrar.attachAgent(second), true)
  assert.equal(registrar.scopeCount(), 2)
  assert.equal(fixture.registrations.length, 2, '两个 agent 各注册一次')
  assert.deepEqual(fixture.injects.map((entry) => entry.deps), [['skills'], ['skills']])

  const list = await fixture.registrations[0].provider.list()
  const disabled = list.find((candidate) => candidate.name === 'archify')
  assert.ok(disabled, '停用的技能仍要报出来（只是不可调用）')
  assert.equal(disabled.rank, NATIVE_RANKS['project-agents'] + POLICY_RANK_OFFSET)
  assert.ok(disabled.rank < NATIVE_RANKS['project-agents'], 'rank 必须比原生小，同层才盖得住')
  assert.deepEqual(disabled.invocation, { modelInvocable: false, userInvocable: false })
  assert.equal(disabled.provider, PROVIDER_NAME)

  const enabled = list.find((candidate) => candidate.name === 'claude-only')
  assert.deepEqual(enabled.invocation, { modelInvocable: true, userInvocable: true })
  assert.equal(enabled.description, '技能：claude-only', '空描述要有兜底（宿主校验要求非空）')
  assert.equal(enabled.rank, policyRank('claude'))
})

test('后创建的 agent 通过 attachAgent 注册；重复 attach 不重复注册', () => {
  const { registrar, fixture } = harness()
  const late = makeAgent(fixture)

  assert.equal(registrar.attachAgent(late), true)
  assert.equal(registrar.attachAgent(late), true, 'created 事件与 list() 重叠时必须幂等')
  assert.equal(fixture.registrations.length, 1)
  assert.equal(fixture.injects.length, 1)
  assert.equal(registrar.scopeCount(), 1)
  assert.equal(registrar.installedScopeCount(), 1)
})

test('detachAgent：disposer 被调用、记账清掉，重新 attach 可以再次注册', () => {
  const { registrar, fixture } = harness()
  const agent = makeAgent(fixture)
  registrar.attachAgent(agent)
  const [registration] = fixture.registrations

  assert.equal(registrar.detachAgent(agent), true)
  assert.equal(registration.disposed, true, 'registerProvider 的 disposer 必须被调用')
  assert.equal(registrar.scopeCount(), 0)
  assert.equal(registrar.invalidatorCount(), 0)
  assert.equal(registrar.detachAgent(agent), false, '重复 detach 是 no-op')

  assert.equal(registrar.attachAgent(agent), true)
  assert.equal(fixture.registrations.length, 2, '释放后同一 agent 再注册要建立新 provider')
})

test('detachAgent 会释放注入 fiber（agent 的 scope 不能被旧注册占着）', () => {
  const { registrar, fixture } = harness()
  const agent = makeAgent(fixture)
  let disposedFiber = null
  agent.ctx.inject = (deps, callback) => {
    fixture.injects.push({ deps, skills: true })
    callback({ skills: fixture.skillsService })
    disposedFiber = {
      disposed: false,
      dispose() {
        this.disposed = true
        fixture.fibers.push(this)
      },
    }
    return disposedFiber
  }
  registrar.attachAgent(agent)
  registrar.detachAgent(agent)
  assert.equal(disposedFiber.disposed, true)
})

test('invalidate：root 与每个 agent 的 provider 都失效（只清 root 正是原 bug）', () => {
  const { registrar, fixture } = harness()
  const rootSkills = fakeSkills()
  const rootProvider = registerGovernanceProvider({ skills: rootSkills.service }, { snapshot: disabledSnapshot })
  registrar.trackRoot(rootProvider)

  registrar.attachAgent(makeAgent(fixture))
  registrar.attachAgent(makeAgent(fixture))
  assert.equal(registrar.invalidatorCount(), 3, 'root + 两个 agent')
  assert.equal(registrar.rootInstalled, true)

  assert.equal(registrar.invalidate(), 3)
  for (const registration of fixture.registrations) assert.equal(registration.invalidated, 1)
  assert.equal(rootSkills.registrations[0].invalidated, 1)
  assert.equal(registrar.invalidate(), 3, '可重复调用，且每次都通知到所有层')
})

test('disposeAll：插件卸载时释放全部 agent 注册与记账（root 随插件 ctx 走）', () => {
  const { registrar, fixture } = harness()
  const rootSkills = fakeSkills()
  registrar.trackRoot(registerGovernanceProvider({ skills: rootSkills.service }, { snapshot: disabledSnapshot }))
  const agents = [makeAgent(fixture), makeAgent(fixture)]
  for (const agent of agents) registrar.attachAgent(agent)

  registrar.disposeAll()
  assert.equal(registrar.scopeCount(), 0)
  assert.equal(registrar.invalidatorCount(), 0)
  assert.equal(registrar.rootInstalled, false)
  for (const registration of fixture.registrations) assert.equal(registration.disposed, true)
  assert.equal(fixture.fibers.length, 2, '两个 agent 的注入 fiber 都要释放')
  assert.equal(registrar.invalidate(), 0, '卸载后 invalidate 不再触碰任何 provider')
})

test('缺 skills 服务：注入回调不执行，attach/detach 仍安全（不能拖垮插件）', () => {
  const { registrar, fixture } = harness()
  const agent = makeAgent(fixture, { skills: false })

  assert.equal(registrar.attachAgent(agent), true, '已建立注册记录（服务出现时会补装）')
  assert.equal(fixture.registrations.length, 0)
  assert.equal(registrar.installedScopeCount(), 0)
  assert.equal(registrar.invalidatorCount(), 0)

  assert.equal(registrar.detachAgent(agent), true)
  assert.equal(registrar.scopeCount(), 0)
})

test('agent.ctx 不可用 / inject 抛错：attach 返回 false 并记录原因，不抛异常', () => {
  const { registrar, fixture } = harness()

  assert.equal(registrar.attachAgent(null), false)
  assert.equal(registrar.attachAgent({ id: 'no-ctx' }), false)

  const broken = makeAgent(fixture, { throwOnInject: true })
  assert.equal(registrar.attachAgent(broken), false)
  assert.equal(registrar.scopeCount(), 0)
  assert.equal(fixture.logs.length, 1)
  assert.match(fixture.logs[0], /无法注册到该作用域/)
})

test('createGovernanceProvider 的 root 行为不变（旧测试的语义仍然成立）', async () => {
  const provider = createGovernanceProvider({ snapshot: disabledSnapshot })
  assert.equal(provider.name, PROVIDER_NAME)
  const list = await provider.list()
  const archify = list.find((candidate) => candidate.name === 'archify')
  assert.equal(archify.rank, NATIVE_RANKS['project-agents'] + POLICY_RANK_OFFSET)
  assert.equal(archify.invocation.modelInvocable, false)
  assert.equal(archify.invocation.userInvocable, false)
  assert.equal(archify.locator, archify.path, 'provider.get 用 locator/path 定位正文')
})

test('index.js 的接线没有丢（静态检查三处生命周期调用）', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8')

  assert.match(source, /import \{[^}]*createGovernanceRegistrar[^}]*\} from '\.\/skills\/provider\.js'/)
  assert.match(
    source,
    /const attachAgent = \(agent\) => \{[\s\S]*?governance\.attachAgent\(agent\)[\s\S]*?\n  \}/,
    'attachAgent 必须为 agent 注册 provider（现有/新 agent 都走它）',
  )
  assert.match(
    source,
    /const detachAgent = \(agent\) => \{[\s\S]*?governance\.detachAgent\(agent\)[\s\S]*?\n  \}/,
    'detachAgent 必须释放 agent 的 provider',
  )
  assert.match(source, /governance\.trackRoot\(provider\)/, 'root 那份仍要注册（global 层兜底）')
  assert.match(source, /governance\.invalidate\(\)/, '面板改策略后必须让所有层失效')
  assert.match(source, /governance\.disposeAll\(\)/, '插件卸载时必须释放所有 agent 注册')
  assert.match(source, /governanceSnapshot/, 'root 与 agent provider 共用同一份快照/TTL 缓存')
})
