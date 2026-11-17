/**
 * 模型侧投影（issue #4）：同一份技能经多个来源出现时，模型只能算一个。
 *
 * 这条链路上有两个必须同时成立的事实，缺一个就回到「面板说可用、模型说不可用」：
 *
 *   1. **同一真实文件**（Junction / symlink）的多个来源折成一条，启停取并集；
 *   2. **影子候选只为盖住 DSH 原生 provider** —— 外部目录停用时不上报。
 *
 * 另外钉住宿主真正会用的决胜规则：同层按 rank 升序，再按上报顺序，然后按名字去重
 * （`dsh-skill` 的 `compareIndexedCandidates`）。停用的原生影子候选**会**赢，这正是它的职责。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { governedSkills } from '../src/skills/governance.js'
import { createGovernanceProvider } from '../src/skills/provider.js'
import { countModel, modelCountsByScope, modelViewOf, modelViews, modelWinners } from '../src/skills/modelView.js'
import { emptyManagerState, setSourceEnabled } from '../src/skills/state.js'

/** 一行治理快照的最小形状（`realPath`/`native` 与 production 一致）。 */
const row = (name, overrides = {}) => ({
  name,
  description: '',
  path: `/h/${name}/SKILL.md`,
  realPath: '',
  source: 'user-dsh',
  scope: 'global',
  rank: 399,
  native: true,
  readonly: false,
  ownEnabled: true,
  enabled: true,
  ...overrides,
})

/** 建一个目录联接到 `target`（Windows 用 junction，其它平台用 symlink）。 */
function linkDirectory(link, target) {
  mkdirSync(join(link, '..'), { recursive: true })
  if (process.platform === 'win32') {
    execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' })
    return
  }
  symlinkSync(target, link, 'dir')
}

function makeSkill(root, name) {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: demo\n---\n\n# ${name}\n`)
}

/** 真机形状的夹具：`<home>/.agents/skills` 是指向 `<home>/.claude/skills` 的目录联接。 */
async function aliasedHome(state) {
  const home = mkdtempSync(join(tmpdir(), 'smp-modelview-'))
  makeSkill(join(home, '.claude', 'skills'), 'hyperframes')
  linkDirectory(join(home, '.agents', 'skills'), join(home, '.claude', 'skills'))
  const dshHome = join(home, '.dsh')
  mkdirSync(dshHome, { recursive: true })
  const snapshot = await governedSkills({
    projectRoots: [], dshHome, agentsHome: join(home, '.agents'), env: {}, home, state,
  })
  const provider = createGovernanceProvider({ snapshot: async () => snapshot })
  return { home, snapshot, provider }
}

const candidateOf = async (provider, home, name) => (await provider.list({ cwd: home }))
  .find((candidate) => candidate.name === name)

// ── 单元：分组与策略 ────────────────────────────────────────────────────────────────

test('modelViews：同一真实文件的两行折成一条，启停取并集，rank 取原生根', () => {
  const views = modelViews([
    row('hyperframes', { source: 'claude', rank: 450, native: false, enabled: false, path: '/h/.claude/skills/hyperframes/SKILL.md' }),
    row('hyperframes', {
      source: 'user-agents', rank: 499, path: '/h/.agents/skills/hyperframes/SKILL.md',
      realPath: '/h/.claude/skills/hyperframes/SKILL.md',
    }),
  ])
  assert.equal(views.length, 1, '真实路径相同时是一个技能')
  const [view] = views
  assert.equal(view.enabled, true, '任一来源启用即可用')
  assert.equal(view.emittable, true)
  assert.equal(view.rank, 499, 'rank 取原生根（user-agents 499 < 原生 500），停用才能盖住原生条目')
  assert.equal(view.source, 'user-agents', '代表行取启用的那份')
})

test('modelViews：外部来源停用且没有别名时不上报（没有需要盖的原生候选）', () => {
  const views = modelViews([row('only-claude', { source: 'claude', rank: 450, native: false, enabled: false })])
  assert.equal(views.length, 1)
  assert.equal(views[0].emittable, false)
})

test('modelViews：原生来源停用时仍上报影子候选（否则原生 provider 的条目照样可调用）', () => {
  const views = modelViews([row('native-off', { source: 'user-dsh', rank: 399, enabled: false })])
  assert.equal(views[0].emittable, true, '原生根必须上报，rank 399 用来盖住原生 400')
  assert.equal(views[0].enabled, false)
})

test('modelViews：两个原生根指向同一文件时，一个停用不影响另一个启用（native↔native 别名）', () => {
  const views = modelViews([
    row('shared', { source: 'user-dsh', rank: 399, enabled: false, path: '/h/.dsh/skills/shared/SKILL.md' }),
    row('shared', {
      source: 'user-agents', rank: 499, path: '/h/.agents/skills/shared/SKILL.md',
      realPath: '/h/.dsh/skills/shared/SKILL.md',
    }),
  ])
  assert.equal(views.length, 1)
  assert.equal(views[0].enabled, true)
  assert.equal(views[0].rank, 399, '取原生根的最小值：399 同时盖住原生 400 与 500')
})

test('modelWinners：同排名按上报顺序决胜，停用的影子候选仍然赢（这是它的职责）', () => {
  const views = modelViews([
    row('dup', { source: 'claude', rank: 450, native: false, enabled: false }),
    row('dup', { source: 'user-dsh', rank: 399, enabled: true, path: '/h/.dsh/skills/dup/SKILL.md' }),
  ])
  const winner = modelWinners(views).get('dup')
  assert.equal(winner.rank, 399)
  assert.equal(winner.enabled, true)
})

// ── 单元：计数 ──────────────────────────────────────────────────────────────────────

test('countModel：可见 + 三种原因 = 真实技能数', () => {
  const skills = [
    row('ok'),
    row('off-self', { ownEnabled: false, enabled: false }),
    row('off-source', { enabled: false }),
    row('dup-a', { source: 'claude', rank: 450, native: false }),
    row('dup-a', { source: 'user-dsh', rank: 399, path: '/h/.dsh/skills/dup-a/SKILL.md' }),
  ]
  const counted = countModel(skills)
  assert.deepEqual(counted, { total: 5, visible: 2, shadowed: 1, disabledSelf: 1, disabledSource: 1 })
  assert.equal(
    counted.visible + counted.shadowed + counted.disabledSelf + counted.disabledSource,
    counted.total,
  )
})

test('countModel：停用的原生影子压掉外部同名技能时，如实算成「来源停用 + 同名覆盖」', () => {
  const skills = [
    row('dup', { source: 'user-dsh', rank: 399, enabled: false }),
    row('dup', { source: 'claude', rank: 450, native: false, path: '/h/.claude/skills/dup/SKILL.md' }),
  ]
  const counted = countModel(skills)
  assert.equal(counted.visible, 0, '模型实际一个都调不到（399 的停用影子赢）')
  assert.equal(counted.disabledSource, 1)
  assert.equal(counted.shadowed, 1)
})

test('modelCountsByScope：all / global / 项目根各自的数', () => {
  const skills = [
    row('g'),
    row('p', { source: 'project-dsh', scope: '/p/one', rank: 99, path: '/p/one/.dsh/skills/p/SKILL.md' }),
  ]
  const counts = modelCountsByScope(skills)
  assert.equal(counts.all.total, 2)
  assert.equal(counts.global.total, 1)
  assert.equal(counts['/p/one'].total, 1)
  assert.equal(counts['/p/one'].visible, 1)
})

test('modelViewOf：给出 shadowedBy（面板卡片据此标「被 X 覆盖」）', () => {
  const view = modelViewOf({
    sources: [
      { key: 'user-dsh', label: '用户 · DSH', skills: [] },
      { key: 'claude', label: 'Claude Code', skills: [] },
    ],
    skills: [
      row('dup', { path: '/h/.dsh/skills/dup/SKILL.md' }),
      row('dup', { source: 'claude', rank: 450, native: false, path: '/h/.claude/skills/dup/SKILL.md' }),
    ],
  })
  assert.deepEqual(view.shadowedBy, { '/h/.claude/skills/dup/SKILL.md': '用户 · DSH' })
  assert.equal(view.counts.all.total, 2)
  assert.equal(view.counts.all.visible, 1)
})

test('modelViewOf：停用的行不写 shadowedBy（提示方向会反），也不计入「同名覆盖」', () => {
  const view = modelViewOf({
    sources: [
      { key: 'claude', label: 'Claude Code', skills: [] },
      { key: 'user-agents', label: '用户 · Shared Agent', skills: [] },
    ],
    skills: [
      // 停用的外部来源（rank 450）与启用的原生根（rank 499）同名
      row('dup', { source: 'claude', rank: 450, native: false, enabled: false, path: '/h/.claude/skills/dup/SKILL.md' }),
      row('dup', { source: 'user-agents', rank: 499, path: '/h/.agents/skills/dup/SKILL.md' }),
    ],
  })
  assert.deepEqual(view.counts.all, { total: 2, visible: 1, shadowed: 0, disabledSelf: 0, disabledSource: 1 })
  assert.deepEqual(view.shadowedBy, {}, '停用的那份不是「被覆盖」——它自己就是停用')
})

test('modelCountsByScope：项目范围与 provider 用同一数据集（global ∪ 本项目），别名跨 scope 时一致', async () => {
  /**
   * 现实形状：项目把自己根下的 `.dsh/skills` 用 Junction 指向 `~/.dsh/skills`。
   * 只停用「项目 · DSH」来源时，provider 走并集仍然可调用；如果计数只筛本项目行，
   * 就会算出「可见 0」而模型能调用 —— 与 issue #4 同类的矛盾，只是方向相反。
   */
  const home = mkdtempSync(join(tmpdir(), 'smp-modelview-scope-'))
  makeSkill(join(home, '.dsh', 'skills'), 'shared')
  const repoA = join(home, 'repoA')
  mkdirSync(join(repoA, '.git'), { recursive: true })
  linkDirectory(join(repoA, '.dsh', 'skills'), join(home, '.dsh', 'skills'))
  const dshHome = join(home, '.dsh')
  const state = emptyManagerState()
  setSourceEnabled(state, 'project-dsh@' + repoA, false)
  const snapshot = await governedSkills({
    projectRoots: [repoA], dshHome, agentsHome: join(home, '.agents'), env: {}, home, state,
  })
  const provider = createGovernanceProvider({ snapshot: async () => snapshot })
  const candidate = (await provider.list({ cwd: repoA })).find((item) => item.name === 'shared')
  assert.ok(candidate !== undefined, '别名跨 scope 时仍是一条候选')
  assert.equal(candidate.invocation.modelInvocable, true, '全局那份仍然启用 → 模型可调用')

  const counts = modelViewOf(snapshot).counts
  assert.equal(counts[repoA].visible, 1, `本项目范围的可见数必须与 provider 一致：${JSON.stringify(counts[repoA])}`)
  assert.equal(counts[repoA].total, 1, '全局技能不会被重复算进工作区总数')
  assert.equal(counts.global.visible, 1)
})

// ── 真机形状：Junction / symlink 目录别名（issue #4 的复现场景）─────────────────────

test('真实别名：停用 Claude 来源后，Shared Agent 那份仍然可调用（issue #4）', async () => {
  const state = emptyManagerState()
  setSourceEnabled(state, 'claude', false)
  const { home, snapshot, provider } = await aliasedHome(state)

  // 快照仍是「按来源分行」：面板要能分别管两个根
  const sources = snapshot.sources.filter((group) => group.exists)
  assert.deepEqual(sources.map((group) => group.key), ['claude', 'user-agents'])
  assert.equal(snapshot.skills.filter((skill) => skill.name === 'hyperframes').length, 2, '两行')
  assert.equal(snapshot.scanError, '', '扫描本身没有错误')

  const candidate = await candidateOf(provider, home, 'hyperframes')
  assert.ok(candidate !== undefined, '同一真实文件只上报一条候选')
  assert.equal(candidate.invocation.modelInvocable, true, '启用来源的那份必须可调用')
  assert.equal(candidate.rank, 499, 'rank 取 user-agents 的 499：既压过原生 500，又不虚高')
  assert.equal(candidate.source, 'user-agents')

  // 面板口径：一个真实技能、可见
  assert.deepEqual(modelViewOf(snapshot).counts.all, { total: 1, visible: 1, shadowed: 0, disabledSelf: 0, disabledSource: 0 })
})

test('真实别名：反向停用 Shared Agent，Claude 那份仍然可调用', async () => {
  const state = emptyManagerState()
  setSourceEnabled(state, 'user-agents', false)
  const { home, provider } = await aliasedHome(state)
  const candidate = await candidateOf(provider, home, 'hyperframes')
  assert.equal(candidate.invocation.modelInvocable, true)
})

test('真实别名：两个来源都停用时彻底不可调用（影子候选仍要盖住原生 500）', async () => {
  const state = emptyManagerState()
  setSourceEnabled(state, 'claude', false)
  setSourceEnabled(state, 'user-agents', false)
  const { home, provider } = await aliasedHome(state)
  const candidate = await candidateOf(provider, home, 'hyperframes')
  assert.ok(candidate !== undefined, '原生根停用必须上报影子候选')
  assert.equal(candidate.invocation.modelInvocable, false)
  assert.equal(candidate.rank, 499)
})

test('真实别名：同名但真实文件不同时不合并，停用的外部来源不压掉启用的原生技能', async () => {
  const home = mkdtempSync(join(tmpdir(), 'smp-modelview-'))
  makeSkill(join(home, '.claude', 'skills'), 'dup')
  makeSkill(join(home, '.agents', 'skills'), 'dup')
  const dshHome = join(home, '.dsh')
  mkdirSync(dshHome, { recursive: true })
  const state = emptyManagerState()
  setSourceEnabled(state, 'claude', false)
  const snapshot = await governedSkills({
    projectRoots: [], dshHome, agentsHome: join(home, '.agents'), env: {}, home, state,
  })
  const provider = createGovernanceProvider({ snapshot: async () => snapshot })

  const candidates = (await provider.list({ cwd: home })).filter((candidate) => candidate.name === 'dup')
  assert.equal(candidates.length, 1, '停用的外部来源不再上报同名候选')
  assert.equal(candidates[0].source, 'user-agents')
  assert.equal(candidates[0].invocation.modelInvocable, true)

  assert.deepEqual(modelViewOf(snapshot).counts.all, { total: 2, visible: 1, shadowed: 0, disabledSelf: 0, disabledSource: 1 })
  assert.deepEqual(modelViewOf(snapshot).shadowedBy, {},
    '停用的那份不算「被覆盖」：它自己的原因是来源停用，重新打开该来源就会赢回来')
})

test('条目级软链：两个来源各软链同一份技能时合并成一个，停用一侧不影响另一侧', async () => {
  /**
   * 0.6.9 起条目级的软链也会被扫描进来，所以「同一份技能经两个软链出现」与根级别名同构：
   * 真实路径相同 → 模型侧只算一个，启停取并集。
   */
  const home = mkdtempSync(join(tmpdir(), 'smp-modelview-entry-'))
  const shared = join(home, 'shared', 'linked-skill')
  makeSkill(join(home, 'shared'), 'linked-skill')
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
  mkdirSync(join(home, '.agents', 'skills'), { recursive: true })
  linkDirectory(join(home, '.claude', 'skills', 'linked-skill'), shared)
  linkDirectory(join(home, '.agents', 'skills', 'linked-skill'), shared)
  const dshHome = join(home, '.dsh')
  mkdirSync(dshHome, { recursive: true })
  const state = emptyManagerState()
  setSourceEnabled(state, 'claude', false)
  const snapshot = await governedSkills({
    projectRoots: [], dshHome, agentsHome: join(home, '.agents'), env: {}, home, state,
  })

  // 面板两行（两个来源各一行），模型一条候选、可调用。
  assert.equal(snapshot.skills.filter((skill) => skill.name === 'linked-skill').length, 2)
  const provider = createGovernanceProvider({ snapshot: async () => snapshot })
  const candidates = (await provider.list({ cwd: home })).filter((candidate) => candidate.name === 'linked-skill')
  assert.equal(candidates.length, 1, '同一份真实文件只上报一条候选')
  assert.equal(candidates[0].invocation.modelInvocable, true, '启用的那条来源（user-agents）仍然可用')
  assert.deepEqual(modelViewOf(snapshot).counts.all, { total: 1, visible: 1, shadowed: 0, disabledSelf: 0, disabledSource: 0 })
})
