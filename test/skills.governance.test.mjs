/**
 * 技能治理引擎：来源扫描、启停策略、provider 候选。
 *
 * 这里钉的是**「停用要真的生效」**这条底线：停用不是在面板里画个灰条，而是要让 DSH 认为
 * 该技能不可调用 —— 做法是以「比原生 rank 小 1」的同名候选盖过官方 provider，并把
 * `invocation` 置为 false。测不到这条，就等于没测。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { governedSkills } from '../src/skills/governance.js'
import { discoverSkills } from '../src/skills/discover.js'
import { createGovernanceProvider, PROVIDER_NAME } from '../src/skills/provider.js'
import {
  emptyManagerState, effectiveEnabled, managerStatePath, readManagerState,
  setSkillEnabled, setSourceEnabled, skillPolicyKey, sourceEnabled, writeManagerState,
  assignCategory, categoryList, categoryOf, createCategory, deleteCategory,
  normalizeCategoryName, renameCategory, setCategoryEnabled,
} from '../src/skills/state.js'
import { NATIVE_RANKS, POLICY_RANK_OFFSET, policyRank } from '../src/skills/sources.js'

/** 写一个最简技能目录（`<root>/<name>/SKILL.md`）。 */
async function makeSkill(root, name, description = '演示技能') {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`, 'utf8')
  return join(dir, 'SKILL.md')
}

/** 一套隔离的 home：`dsh/skills`、`agents/skills`、外部 `.claude/skills`。 */
async function makeHomes() {
  const base = await mkdtemp(join(tmpdir(), 'smp-gov-'))
  const dshHome = join(base, 'dsh')
  const agentsHome = join(base, 'agents')
  const home = join(base, 'userhome')
  await mkdir(join(dshHome, 'skills'), { recursive: true })
  await mkdir(join(agentsHome, 'skills'), { recursive: true })
  await mkdir(join(home, '.claude', 'skills'), { recursive: true })
  return { base, dshHome, agentsHome, home }
}

const scan = (homes, extra = {}) => governedSkills({
  dshHome: homes.dshHome, agentsHome: homes.agentsHome, home: homes.home, env: {}, ...extra,
})

test('policyRank：原生来源必须比官方小 1，否则盖不住官方 provider', () => {
  for (const [source, rank] of Object.entries(NATIVE_RANKS)) {
    assert.equal(policyRank(source), rank + POLICY_RANK_OFFSET, `${source} 的 rank 应小于原生`)
    assert.ok(policyRank(source) < rank, `${source} 的 rank 必须更小（数值小 = 优先级高）`)
  }
  // 外部来源不与原生重名，给个固定值即可，但必须比 user-dsh 靠后
  assert.ok(policyRank('claude') > policyRank('user-dsh'))
})

test('governedSkills：扫出两个来源的技能，默认全部启用', async () => {
  const homes = await makeHomes()
  await makeSkill(join(homes.dshHome, 'skills'), 'alpha', '用户技能')
  await makeSkill(join(homes.home, '.claude', 'skills'), 'beta-claude', '外部技能')

  const snapshot = await scan(homes)
  const byKey = new Map(snapshot.sources.map((group) => [group.key, group]))

  assert.equal(byKey.get('user-dsh').exists, true)
  assert.equal(byKey.get('user-dsh').count, 1)
  assert.equal(byKey.get('claude').exists, true)
  assert.equal(byKey.get('claude').count, 1)
  assert.equal(byKey.get('claude').readonly, true, '外部 Agent 目录必须标成只读')
  assert.equal(byKey.get('codex').exists, false, '不存在的来源要如实说 exists=false')

  assert.equal(snapshot.skills.length, 2)
  assert.ok(snapshot.skills.every((skill) => skill.enabled === true), '默认全部启用')
  assert.equal(snapshot.statePath, managerStatePath(homes.dshHome))
})

test('停用来源：该来源下所有技能都变成不可用，别的来源不受影响', async () => {
  const homes = await makeHomes()
  await makeSkill(join(homes.dshHome, 'skills'), 'alpha')
  await makeSkill(join(homes.home, '.claude', 'skills'), 'beta-claude')

  const state = emptyManagerState()
  setSourceEnabled(state, 'claude', false)
  const snapshot = await scan(homes, { state })

  const claude = snapshot.sources.find((group) => group.key === 'claude')
  const dsh = snapshot.sources.find((group) => group.key === 'user-dsh')
  assert.equal(claude.enabled, false)
  assert.equal(claude.skills[0].enabled, false, '来源停用 ⇒ 其技能不可用')
  assert.equal(dsh.skills[0].enabled, true, '别的来源不能被连坐')
})

test('停用单个技能：只影响它自己，且按 source+scope+name 记录', async () => {
  const homes = await makeHomes()
  const alpha = await makeSkill(join(homes.dshHome, 'skills'), 'alpha')
  await makeSkill(join(homes.dshHome, 'skills'), 'gamma')

  const state = emptyManagerState()
  setSkillEnabled(state, { source: 'user-dsh', scope: 'global', name: 'alpha' }, false)
  const snapshot = await scan(homes, { state })

  const rows = snapshot.sources.find((group) => group.key === 'user-dsh').skills
  assert.equal(rows.find((row) => row.name === 'alpha').enabled, false)
  assert.equal(rows.find((row) => row.name === 'gamma').enabled, true)
  assert.ok(alpha.endsWith('SKILL.md'))
  assert.deepEqual(Object.keys(state.skills), [skillPolicyKey({ source: 'user-dsh', scope: 'global', name: 'alpha' })])
})

test('重新启用会把覆盖记录删掉（而不是留一个 true）', () => {
  const state = emptyManagerState()
  const entry = { source: 'user-dsh', scope: 'global', name: 'alpha' }
  setSkillEnabled(state, entry, false)
  assert.equal(effectiveEnabled(state, 'user-dsh', entry), false)
  setSkillEnabled(state, entry, true)
  assert.deepEqual(state.skills, {}, '启用 = 回到默认，不该在文件里留痕')
  assert.equal(effectiveEnabled(state, 'user-dsh', entry), true)
})

test('状态文件：原子写入 + 读回一致，损坏时退回空状态而不是抛错', async () => {
  const homes = await makeHomes()
  const state = emptyManagerState()
  setSourceEnabled(state, 'codex', false)
  setSkillEnabled(state, { source: 'user-dsh', scope: 'global', name: 'alpha' }, false)
  await writeManagerState(homes.dshHome, state)

  const again = await readManagerState(homes.dshHome)
  assert.deepEqual(again.sources, { codex: { enabled: false } })
  assert.equal(Object.keys(again.skills).length, 1)

  // 坏文件不能让技能页整体读不出来：退回空状态（技能本身从未被改动，可恢复）
  await writeFile(managerStatePath(homes.dshHome), '{ this is not json', 'utf8')
  const recovered = await readManagerState(homes.dshHome)
  assert.deepEqual(recovered.sources, {})
  assert.deepEqual(recovered.skills, {})
})

test('provider：停用的技能仍被列出，但 invocation 变成不可调用', async () => {
  const homes = await makeHomes()
  await makeSkill(join(homes.dshHome, 'skills'), 'alpha')
  await makeSkill(join(homes.dshHome, 'skills'), 'gamma')

  const state = emptyManagerState()
  setSkillEnabled(state, { source: 'user-dsh', scope: 'global', name: 'alpha' }, false)
  const provider = createGovernanceProvider({ snapshot: () => scan(homes, { state }) })

  const candidates = await provider.list({})
  assert.equal(provider.name, PROVIDER_NAME)
  assert.equal(candidates.length, 2)

  const alpha = candidates.find((item) => item.name === 'alpha')
  const gamma = candidates.find((item) => item.name === 'gamma')
  assert.equal(alpha.invocation.modelInvocable, false, '停用后模型不得调用')
  assert.equal(alpha.invocation.userInvocable, false)
  assert.equal(gamma.invocation.modelInvocable, true)
  // rank 必须压过官方那条同名候选，否则「停用」在真实运行时会被官方条目盖回来
  assert.equal(alpha.rank, policyRank('user-dsh'))
  assert.ok(alpha.rank < NATIVE_RANKS['user-dsh'])
  assert.equal(alpha.locator, alpha.path, 'get 靠 locator 回读正文')
})

test('provider.get：回读完整正文（不是面板那个 4KB 预览投影）', async () => {
  const homes = await makeHomes()
  const path = await makeSkill(join(homes.dshHome, 'skills'), 'alpha')
  const provider = createGovernanceProvider({ snapshot: () => scan(homes) })
  const [candidate] = await provider.list({})
  const skill = await provider.get(candidate)
  assert.ok(skill.content.includes('# alpha'))
  assert.equal(candidate.path, path)
})

test('外部目录里名字不是 kebab-case 的技能被跳过：一条坏数据不能拖垮整张列表', async () => {
  const homes = await makeHomes()
  const claudeRoot = join(homes.home, '.claude', 'skills')
  await makeSkill(claudeRoot, 'Bad_Name')
  await makeSkill(claudeRoot, 'good-name')

  const snapshot = await scan(homes)
  const claude = snapshot.sources.find((group) => group.key === 'claude')
  assert.deepEqual(claude.skills.map((skill) => skill.name), ['good-name'])
})

// ── 分类 ────────────────────────────────────────────────────────────────────────────

test('分类名：去空白、拒绝空名与超长名', () => {
  assert.equal(normalizeCategoryName('  写作  '), '写作')
  assert.equal(normalizeCategoryName('a  b'), 'a b', '内部连续空白压成一个')
  assert.equal(normalizeCategoryName('   '), '')
  assert.equal(normalizeCategoryName('x'.repeat(41)), '', '超长名不可用')
  assert.equal(normalizeCategoryName('a\u0001b'), '', '控制字符不可用')
})

test('分类：创建/改名/删除，成员跟着走，不移动任何文件', () => {
  const state = emptyManagerState()
  assert.equal(createCategory(state, '写作'), true)
  assert.equal(createCategory(state, '写作'), false, '同名不能重复创建')

  const entry = { source: 'user-dsh', scope: 'global', name: 'alpha' }
  assert.equal(assignCategory(state, entry, '写作'), true)
  assert.equal(categoryOf(state, entry), '写作')

  assert.equal(renameCategory(state, '写作', '文档'), true)
  assert.equal(categoryOf(state, entry), '文档', '改名后成员关系不变')
  assert.equal(state.categories['写作'], undefined)

  assert.equal(deleteCategory(state, '文档'), true)
  assert.equal(categoryOf(state, entry), '', '删除分类后技能回到未分类')
  assert.deepEqual(categoryList(state), [])
})

test('分类：一个技能只能在一个分类里（再分配会自动从旧分类移走）', () => {
  const state = emptyManagerState()
  createCategory(state, 'A')
  createCategory(state, 'B')
  const entry = { source: 'user-dsh', scope: 'global', name: 'alpha' }

  assignCategory(state, entry, 'A')
  assignCategory(state, entry, 'B')
  assert.equal(categoryOf(state, entry), 'B')
  assert.equal(state.categories.A.skills.length, 0, '旧分类里必须已经移走')
  assert.equal(state.categories.B.skills.length, 1)

  assignCategory(state, entry, '')
  assert.equal(categoryOf(state, entry), '')
  assert.equal(state.categories.B.skills.length, 0, '取消分类要清干净')
})

test('分类不再参与生效判定：停用分类不影响任何技能（设计决策 A）', async () => {
  /**
   * 设计评审第 2 条（用户拍板方案 A）：三成 opt-out（来源 ∧ 分类 ∧ 技能）叠加，用户算不出
   * "到底生效没生效"；分类降级为**纯分组标签**，启用 = 来源 ∧ 技能。
   *
   * 这条用例钉住新契约：把分类置为停用，技能的 `enabled` **一点都不能变**（历史状态里那个
   * `categories[].enabled` 只为回滚保留，不参与判断）。
   */
  const homes = await makeHomes()
  await makeSkill(join(homes.dshHome, 'skills'), 'alpha')

  const state = emptyManagerState()
  createCategory(state, '写作')
  const before = await scan(homes, { state })
  const alpha = before.skills.find((skill) => skill.name === 'alpha')
  assignCategory(state, alpha, '写作')

  setCategoryEnabled(state, '写作', false)
  const after = await scan(homes, { state })
  const still = after.skills.find((skill) => skill.name === 'alpha')
  assert.equal(still.category, '写作', '分类归属仍然可见（它只是标签）')
  assert.equal(still.enabled, true, '停用分类不得影响技能的生效状态')
  assert.equal(still.ownEnabled, true)
})
test('governance 快照带分类清单与计数（面板据此渲染分类区）', async () => {
  const homes = await makeHomes()
  await makeSkill(join(homes.dshHome, 'skills'), 'alpha')
  const state = emptyManagerState()
  createCategory(state, '写作')
  createCategory(state, '空分类')
  assignCategory(state, { source: 'user-dsh', scope: 'global', name: 'alpha' }, '写作')

  const snapshot = await scan(homes, { state })
  assert.deepEqual(snapshot.categories, [
    { name: '空分类', enabled: true, count: 0 },
    { name: '写作', enabled: true, count: 1 },
  ])
})

test('同名技能在两个根里：磁盘扫描只留一份，治理快照保留每个根的真实路径', async () => {
  /**
   * 真机 bug 的来源（0.5.25）：`~/.dsh/skills` 与 `~/.agents/skills` 里有同一批技能名。
   *
   *   · `discoverSkills` 按 `scope + name` 去重 → 全局只保留**先扫到的那个根**；
   *   · 治理快照按来源列出**每个根**的实际路径。
   *
   * 预览读正文原来只校验磁盘扫描结果，于是「面板上看得见（来自治理快照）、点开详情却说
   * 不在扫描结果里」。所以读取校验必须同时认两份投影。
   */
  const homes = await makeHomes()
  const dshSkill = await makeSkill(join(homes.dshHome, 'skills'), 'dup-name')
  const agentsSkill = await makeSkill(join(homes.agentsHome, 'skills'), 'dup-name')

  const discovered = await discoverSkills({
    projectRoots: [], dshHome: homes.dshHome, agentsHome: homes.agentsHome,
  })
  const kept = discovered.filter((entry) => entry.name === 'dup-name')
  assert.equal(kept.length, 1, '磁盘扫描按名字去重，只保留一份')
  assert.equal(kept[0].path, dshSkill, '先扫到的根（user-dsh）胜出')

  const snapshot = await scan(homes)
  const paths = snapshot.skills
    .filter((skill) => skill.name === 'dup-name')
    .map((skill) => skill.path)
    .sort()
  assert.deepEqual(paths, [agentsSkill, dshSkill].sort(), '治理快照要保留两个根的真实路径')
})


test('ownEnabled 与 enabled 分开报：来源停用时技能自身开关仍是 true', async () => {
  /**
   * 面板的勾选框绑 `ownEnabled`（用户点得动的只有这个值），而 `enabled` 是有效值。
   *
   * 只报有效值会让开关变成「点了没反应」：来源停用时勾选框显示关，点一下把自身置为开，
   * 有效值仍是关、界面毫无变化。所以两个值都要给，界面才能既正确显示又能提示为什么没生效。
   */
  const homes = await makeHomes()
  await makeSkill(join(homes.dshHome, 'skills'), 'alpha')

  const state = emptyManagerState()
  setSourceEnabled(state, 'user-dsh', false)
  const snapshot = await scan(homes, { state })

  const dsh = snapshot.sources.find((group) => group.key === 'user-dsh')
  const skill = dsh.skills[0]
  assert.equal(skill.enabled, false, '有效值：来源停用 ⇒ 不生效')
  assert.equal(skill.ownEnabled, true, '自身开关：用户没关过它，仍是开')
})

test('项目来源的启停按工作区独立：关掉一个工作区不影响另一个', async () => {
  /**
   * 结构 key（`project-dsh`）在项目级被多个工作区共用，而启停是「对这一个工作区的这个
   * 来源」做的决定。按结构 key 存会一关全关 —— 审计发现的 P1。
   *
   * 两段式：先从快照里取出真实的策略键（治理层可能把项目根规范化），再按它停用。
   */
  const homes = await makeHomes()
  const one = join(homes.base, 'one')
  const two = join(homes.base, 'two')
  await makeSkill(join(one, '.dsh', 'skills'), 'one-skill')
  await makeSkill(join(two, '.dsh', 'skills'), 'two-skill')

  const before = await scan(homes, { projectRoots: [one, two], state: emptyManagerState() })
  const pick = (snapshot, root) => snapshot.sources.find((group) => group.key === 'project-dsh' && group.scope === root)
  const groupOne = pick(before, one)
  const groupTwo = pick(before, two)
  assert.ok(groupOne !== undefined && groupTwo !== undefined, '两个工作区都应各有一个项目来源')
  assert.notEqual(groupOne.policyKey, groupTwo.policyKey, '每个工作区必须有各自的策略键')

  const state = emptyManagerState()
  setSourceEnabled(state, groupOne.policyKey, false)
  const after = await scan(homes, { projectRoots: [one, two], state })
  assert.equal(pick(after, one).enabled, false, '被关掉的那个工作区来源应停用')
  assert.equal(pick(after, two).enabled, true, '另一个工作区不能被连坐')
})
test('sourceEnabled：旧状态文件的结构 key 停用仍然生效', () => {
  const state = emptyManagerState()
  setSourceEnabled(state, 'project-dsh', false)
  assert.equal(sourceEnabled(state, 'project-dsh@/p/one'), false, '旧的整层停用要继续生效')
  assert.equal(sourceEnabled(state, 'project-dsh'), false)
})

