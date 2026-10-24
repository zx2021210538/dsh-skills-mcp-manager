/**
 * 仓库技能的生命周期：安装 → 预览（三种状态）→ 更新（先备份）→ 回滚 → 卸载。
 *
 * 三种状态必须能区分，这是整个更新机制的价值：
 *   · up-to-date      远端没变
 *   · update-available 远端有新版（本地没动过）
 *   · locally-modified 本地被改过（直接覆盖会丢东西，必须先提醒）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { repositoryArchivePath } from '../src/skills/repositories.js'
import {
  backupRootPath, installIdFor, installList, installSkill, installSkillEntry,
  installedSignature, latestBackup, previewInstall, resolveDestination,
  rollbackInstalled, updateInstalled, dropInstall,
} from '../src/skills/repository-install.js'
import { moveSkillToTrash, trashList } from '../src/skills/trash.js'
import { emptyManagerState } from '../src/skills/state.js'

const SKILL_MD = (name, body = '# body') => strToU8(`---\nname: ${name}\ndescription: 演示\n---\n\n${body}\n`)

/** 造一份仓库压缩包并写进缓存（相当于「添加/刷新仓库」的结果）。 */
async function cacheArchive(dshHome, repoId, { body = '# body', extra = 'x\n' } = {}) {
  const zip = zipSync({
    'repo-main/skills/alpha/SKILL.md': SKILL_MD('alpha', body),
    'repo-main/skills/alpha/extra.md': strToU8(extra),
  })
  const path = repositoryArchivePath(dshHome, repoId)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, zip)
}

const setup = async () => {
  const base = await mkdtemp(join(tmpdir(), 'smp-inst-'))
  const dshHome = join(base, 'dsh')
  const agentsHome = join(base, 'agents')
  const project = join(base, 'proj')
  await mkdir(dshHome, { recursive: true })
  await mkdir(agentsHome, { recursive: true })
  await mkdir(project, { recursive: true })
  const repo = {
    id: 'o__r',
    skills: [{ name: 'alpha', description: '演示', dir: 'repo-main/skills/alpha', fileCount: 2, signature: 'sig' }],
  }
  const skill = repo.skills[0]
  return { base, dshHome, agentsHome, project, repo, skill }
}

test('resolveDestination：四个可写目标，项目级必须指定工作区', () => {
  const dshHome = 'C:/dsh'
  const agentsHome = 'C:/agents'
  assert.equal(resolveDestination({ dshHome, agentsHome, destination: { scope: 'global', destId: 'dsh' } }).ok, true)
  assert.equal(resolveDestination({ dshHome, agentsHome, destination: { scope: 'global', destId: 'agents' } }).ok, true)
  assert.equal(resolveDestination({ dshHome, agentsHome, destination: { scope: 'project', destId: 'dsh', project: 'C:/p' } }).ok, true)
  assert.equal(
    resolveDestination({ dshHome, agentsHome, destination: { scope: 'project', destId: 'dsh', project: '' } }).ok,
    false,
    '项目级没工作区必须拒绝',
  )
})

test('installIdFor：同一目标稳定，不同工作区不撞车', () => {
  const a = installIdFor({ scope: 'project', destId: 'dsh', project: 'C:/p1', name: 'alpha' })
  const b = installIdFor({ scope: 'project', destId: 'dsh', project: 'C:/p1', name: 'alpha' })
  const c = installIdFor({ scope: 'project', destId: 'dsh', project: 'C:/p2', name: 'alpha' })
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^repo-project-dsh-[a-f0-9]{8}-alpha$/)
})

test('安装：文件落进 <root>/<name>，记录带上装完那一刻的签名', async () => {
  const { dshHome, repo, skill } = await setup()
  await cacheArchive(dshHome, repo.id)

  const done = await installSkill({
    dshHome, repo, skill, destination: { scope: 'global', destId: 'dsh' },
  })
  assert.equal(done.ok, true, done.reason)
  const dir = done.install.dir
  assert.equal(existsSync(join(dir, 'SKILL.md')), true)
  assert.equal(existsSync(join(dir, 'extra.md')), true)
  assert.match(await readFile(join(dir, 'SKILL.md'), 'utf8'), /name: alpha/)
  assert.equal(done.install.installedSignature, (await installedSignature(dir)).signature)
  assert.equal(done.install.repoId, 'o__r')
})

test('安装：目标已有同名技能时拒绝，绝不覆盖', async () => {
  const { dshHome, repo, skill } = await setup()
  await cacheArchive(dshHome, repo.id)
  const root = join(dshHome, 'skills')
  await mkdir(join(root, 'alpha'), { recursive: true })
  await writeFile(join(root, 'alpha', 'SKILL.md'), '用户自己的\n', 'utf8')

  const done = await installSkill({ dshHome, repo, skill, destination: { scope: 'global', destId: 'dsh' } })
  assert.equal(done.ok, false)
  assert.match(String(done.reason), /未覆盖/)
  assert.equal(await readFile(join(root, 'alpha', 'SKILL.md'), 'utf8'), '用户自己的\n')
})

test('安装：缓存丢了要说「先刷新」，而不是报一个看不懂的错误', async () => {
  const { dshHome, repo, skill } = await setup()
  const done = await installSkill({ dshHome, repo, skill, destination: { scope: 'global', destId: 'dsh' } })
  assert.equal(done.ok, false)
  assert.match(String(done.reason), /刷新/)
})

test('预览：刚装完是 up-to-date；远端变了是 update-available；本地被改过是 locally-modified', async () => {
  const { dshHome, repo, skill } = await setup()
  await cacheArchive(dshHome, repo.id)
  const done = await installSkill({ dshHome, repo, skill, destination: { scope: 'global', destId: 'dsh' } })
  const install = done.install

  let preview = await previewInstall({ dshHome, install, repo, skill })
  assert.equal(preview.status, 'up-to-date', JSON.stringify(preview))

  // 远端出新版：换一份缓存里的压缩包
  await cacheArchive(dshHome, repo.id, { body: '# 新版', extra: 'y\n' })
  preview = await previewInstall({ dshHome, install, repo, skill })
  assert.equal(preview.status, 'update-available')
  assert.deepEqual(preview.changes.sort(), ['SKILL.md', 'extra.md'])

  // 本地被手工改过（本地改动优先报出来）
  await writeFile(join(install.dir, 'extra.md'), 'local edit\n', 'utf8')
  preview = await previewInstall({ dshHome, install, repo, skill })
  assert.equal(preview.status, 'locally-modified')

  // 目录被删掉
  await rm(install.dir, { recursive: true, force: true })
  preview = await previewInstall({ dshHome, install, repo, skill })
  assert.equal(preview.status, 'missing')
})

test('更新：先备份再替换，返回新签名；备份目录里有旧内容', async () => {
  const { dshHome, repo, skill } = await setup()
  await cacheArchive(dshHome, repo.id)
  const install = (await installSkill({ dshHome, repo, skill, destination: { scope: 'global', destId: 'dsh' } })).install

  await cacheArchive(dshHome, repo.id, { body: '# 新版', extra: 'y\n' })
  const done = await updateInstalled({ dshHome, install, skill })
  assert.equal(done.ok, true, done.reason)
  assert.match(await readFile(join(install.dir, 'SKILL.md'), 'utf8'), /# 新版/)

  const backup = await latestBackup({ dshHome, install })
  assert.ok(backup !== null, '必须留下备份')
  assert.ok(backup.startsWith(backupRootPath(dshHome)), '备份放在插件自己的目录里')
  assert.match(await readFile(join(backup, 'SKILL.md'), 'utf8'), /# body/, '备份是更新前的内容')

  install.installedSignature = done.installedSignature
  const preview = await previewInstall({ dshHome, install, repo, skill })
  assert.equal(preview.status, 'up-to-date', '更新完就该是最新')
})

test('回滚：把最近一次备份换回来', async () => {
  const { dshHome, repo, skill } = await setup()
  await cacheArchive(dshHome, repo.id)
  const install = (await installSkill({ dshHome, repo, skill, destination: { scope: 'global', destId: 'dsh' } })).install

  await cacheArchive(dshHome, repo.id, { body: '# 新版', extra: 'y\n' })
  await updateInstalled({ dshHome, install, skill })
  assert.match(await readFile(join(install.dir, 'SKILL.md'), 'utf8'), /# 新版/)

  const back = await rollbackInstalled({ dshHome, install })
  assert.equal(back.ok, true, back.reason)
  assert.match(await readFile(join(install.dir, 'SKILL.md'), 'utf8'), /# body/, '回到更新前的内容')
  assert.match(await readFile(join(install.dir, 'extra.md'), 'utf8'), /^x/, '多出来的文件也要回滚')

  // 没有备份时回滚必须失败而不是假装成功
  const fresh = await setup()
  await cacheArchive(fresh.dshHome, fresh.repo.id)
  const another = (await installSkill({ dshHome: fresh.dshHome, repo: fresh.repo, skill: fresh.skill, destination: { scope: 'global', destId: 'dsh' } })).install
  const none = await rollbackInstalled({ dshHome: fresh.dshHome, install: another })
  assert.equal(none.ok, false)
  assert.match(String(none.reason), /没有可回滚的备份/)
})

test('卸载：目录进回收站，安装记录可以被摘掉', async () => {
  const { dshHome, repo, skill } = await setup()
  await cacheArchive(dshHome, repo.id)
  const install = (await installSkill({ dshHome, repo, skill, destination: { scope: 'global', destId: 'dsh' } })).install

  const state = emptyManagerState()
  state.installs = [install]
  assert.equal(installList(state).length, 1)

  const moved = await moveSkillToTrash({ dshHome, entry: installSkillEntry(install), allowedRoots: [join(dshHome, 'skills')] })
  assert.equal(moved.ok, true, moved.reason)
  assert.equal(existsSync(install.dir), false, '安装目录必须消失')
  state.trash = [moved.record]
  assert.equal(trashList(state)[0].name, 'alpha')

  dropInstall(state, install.id)
  assert.deepEqual(state.installs, [])
})

test('安装记录：目录已不在时标 missing（否则面板会把它显示成"已安装"的死角）', async () => {
  /**
   * 用户手删目录 / 面板改名 / 移除工作区之后，记录还指着不存在的路径。
   * 面板靠这个标记把它显示成「记录失效」+「清除记录」——
   * 否则技能页没有卡片（因而没有「…」）、仓库列表又只写「已安装」，四个动作全无入口。
   */
  const { dshHome, repo, skill } = await setup()
  await cacheArchive(dshHome, repo.id)
  const install = (await installSkill({ dshHome, repo, skill, destination: { scope: 'global', destId: 'dsh' } })).install

  const state = emptyManagerState()
  state.installs = [install]
  assert.equal(installList(state)[0].missing, false, '目录还在时不应标 missing')

  await rm(install.dir, { recursive: true, force: true })
  assert.equal(installList(state)[0].missing, true, '目录消失后必须标 missing')
  // 记录本身不动：摘不摘由用户决定（Host 的 repo-uninstall 对这种情况是幂等的）
  assert.equal(state.installs.length, 1)
})
