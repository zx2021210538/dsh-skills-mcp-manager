/**
 * 条目级的软链 / Junction（0.6.9）。
 *
 * DSH 原生 provider 会对 `isSymbolicLink()` 的条目再 stat 一次、当作目录或文件，所以模型那边
 * 能加载。我们如果跳过，就会出现「模型能用、面板里没有这一行」——不能启停、计数偏少，正是
 * issue #4 要消灭的那类不一致的另一面。
 *
 * 这里钉三件事：软链的技能目录扫得到、软链的平铺 md 扫得到、断链不会让扫描炸掉；另外两个
 * 目录软链到同一份技能时，真实路径相同 → 模型侧合并成一个（由 `skills/modelView` 负责，
 * 这一层只保证 `realPath` 正确）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSkills, scanSkillRoot } from '../src/skills/discover.js'

/** 建目录链接：Windows 用 Junction（不需要管理员），其它平台用 symlink。 */
function linkDirectory(link, target) {
  mkdirSync(join(link, '..'), { recursive: true })
  if (process.platform === 'win32') {
    execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' })
    return
  }
  symlinkSync(target, link, 'dir')
}

const skillAt = (dir, name, description = name) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`)
}

test('scanSkillRoot：条目是软链的目录也要扫进来（与 DSH 原生 provider 一致）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'smp-link-'))
  const skills = join(root, 'skills')
  const shared = join(root, 'shared', 'linked-skill')
  skillAt(shared, 'linked-skill', '通过软链共享的技能')
  mkdirSync(skills, { recursive: true })
  linkDirectory(join(skills, 'linked-skill'), shared)

  const found = await scanSkillRoot({ path: skills, source: 'user-dsh', scope: 'global' })
  assert.deepEqual(found.map((skill) => skill.name), ['linked-skill'])
  assert.equal(found[0].description, '通过软链共享的技能')
  // 真实路径指向链接目标（不是链接本身）：模型侧据此把同一份技能合并成一个。
  assert.equal(found[0].realPath, join(shared, 'SKILL.md'))
})

test('scanSkillRoot：断链跳过，不影响同目录里其它技能', async () => {
  const root = mkdtempSync(join(tmpdir(), 'smp-link-broken-'))
  const skills = join(root, 'skills')
  skillAt(join(skills, 'good'), 'good')
  linkDirectory(join(skills, 'gone'), join(root, 'does-not-exist'))

  const found = await scanSkillRoot({ path: skills, source: 'user-dsh', scope: 'global' })
  assert.deepEqual(found.map((skill) => skill.name), ['good'])
})

test('scanSkillRoot：软链的平铺 md 也算技能', { skip: process.platform === 'win32' }, async () => {
  // Windows 上文件软链需要开发者模式/管理员权限，所以这条只在类 Unix 上跑。
  const root = mkdtempSync(join(tmpdir(), 'smp-link-md-'))
  const skills = join(root, 'skills')
  const target = join(root, 'shared', 'flat-skill.md')
  mkdirSync(join(root, 'shared'), { recursive: true })
  writeFileSync(target, '---\nname: flat-skill\ndescription: 软链 md\n---\n\n正文\n')
  mkdirSync(skills, { recursive: true })
  symlinkSync(target, join(skills, 'flat-skill.md'))

  const found = await scanSkillRoot({ path: skills, source: 'user-dsh', scope: 'global' })
  assert.deepEqual(found.map((skill) => skill.name), ['flat-skill'])
  assert.equal(found[0].realPath, target)
})

test('两个来源各软链同一份技能：都能被发现，且真实路径一致', async () => {
  /**
   * 面板会看到两行（两个来源各一行），但它们的 `realPath` 相同 —— 模型侧据此合并成一个。
   * 注意 `discoverSkills` 会把 `realPath` 剥掉（`/runtime.skills` 不需要它），所以这里直接用
   * `scanSkillRoot` 比对真实路径，用 `discoverSkills` 证明两行都进了面板。
   */
  const root = mkdtempSync(join(tmpdir(), 'smp-link-two-'))
  const shared = join(root, 'shared', 'dup-skill')
  skillAt(shared, 'dup-skill')
  const project = join(root, 'proj')
  const dshHome = join(root, 'dsh')
  const agentsHome = join(root, 'agents')
  mkdirSync(join(project, '.git'), { recursive: true })
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(join(agentsHome, 'skills'), { recursive: true })
  const projectRoot = join(project, '.agents', 'skills')
  const userRoot = join(agentsHome, 'skills')
  linkDirectory(join(projectRoot, 'dup-skill'), shared)
  linkDirectory(join(userRoot, 'dup-skill'), shared)

  const skills = await discoverSkills({ projectRoots: [project], dshHome, agentsHome })
  const dup = skills.filter((skill) => skill.name === 'dup-skill')
  assert.equal(dup.length, 2, '两个来源各发现一次')
  assert.equal(Object.prototype.hasOwnProperty.call(dup[0], 'realPath'), false, '面板列表不带 realPath')

  const rows = [
    ...await scanSkillRoot({ path: projectRoot, source: 'project-agents', scope: project }),
    ...await scanSkillRoot({ path: userRoot, source: 'user-agents', scope: 'global' }),
  ].filter((skill) => skill.name === 'dup-skill')
  assert.deepEqual(rows.map((skill) => skill.realPath), [join(shared, 'SKILL.md'), join(shared, 'SKILL.md')])
})
