/**
 * 回收站：删除 = 移进插件自己的目录，可恢复；「彻底删除」才是不可逆的那一步。
 *
 * 这是本插件唯一真正移动/删除**用户文件**的模块，所以每个用例都在验证边界：
 * 只读来源不许删、不存在的路径不许删、原位置被占用时恢复必须拒绝、彻底删除不能越出
 * 回收站目录（`state.json` 是用户可手改的文件）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dropTrashRecord, isInsideRoot, moveSkillToTrash, purgeFromTrash,
  restoreFromTrash, trashList, trashRootPath,
} from '../src/skills/trash.js'
import { emptyManagerState } from '../src/skills/state.js'

const makeBundle = async (root, name, body = '# body') => {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  await writeFile(file, `---\nname: ${name}\ndescription: 演示\n---\n\n${body}\n`, 'utf8')
  return { dir, file }
}

const homes = async () => {
  const base = await mkdtemp(join(tmpdir(), 'smp-trash-'))
  const dshHome = join(base, 'dsh')
  const skills = join(dshHome, 'skills')
  await mkdir(skills, { recursive: true })
  return { base, dshHome, skills }
}

test('isInsideRoot：根本身不算「在里面」，前缀相同的兄弟目录也不算', () => {
  assert.equal(isInsideRoot('/a/b', '/a/b/c'), true)
  assert.equal(isInsideRoot('/a/b', '/a/b'), false, '根本身不算在里面')
  assert.equal(isInsideRoot('/a/b', '/a/bc'), false, '兄弟目录不能算进去')
  assert.equal(isInsideRoot('/a/b', '/a/c/d'), false)
})

test('删除一个目录束技能：整个目录进回收站，原位置消失', async () => {
  const { dshHome, skills } = await homes()
  const { dir, file } = await makeBundle(skills, 'alpha', '# 手写内容')

  const moved = await moveSkillToTrash({
    dshHome,
    allowedRoots: [join(dshHome, 'skills')],
    entry: { name: 'alpha', path: file, source: 'user-dsh', scope: 'global', readonly: false },
  })
  assert.equal(moved.ok, true)
  assert.equal(existsSync(dir), false, '原目录必须消失')
  assert.ok(moved.record.trashPath.startsWith(trashRootPath(dshHome)))
  assert.equal(existsSync(join(moved.record.trashPath, 'SKILL.md')), true, '内容整体搬走')
  assert.equal(await readFile(join(moved.record.trashPath, 'SKILL.md'), 'utf8').then((text) => text.includes('# 手写内容')), true)
  assert.equal(moved.record.path, dir, '记录的是原目录路径（恢复时原样放回）')
  assert.equal(moved.record.name, 'alpha')
  assert.ok(moved.record.deletedAt !== '')
})

test('删除一个平铺 .md 技能：移动的是这个文件本身', async () => {
  const { dshHome, skills } = await homes()
  const file = join(skills, 'flat.md')
  await writeFile(file, '---\nname: flat\n---\n\n# flat\n', 'utf8')

  const moved = await moveSkillToTrash({
    dshHome,
    allowedRoots: [join(dshHome, 'skills')],
    entry: { name: 'flat', path: file, source: 'user-dsh', scope: 'global', readonly: false },
  })
  assert.equal(moved.ok, true)
  assert.equal(existsSync(file), false)
  assert.equal(moved.record.path, file)
})

test('只读来源（外部 Agent 目录）一律不许删', async () => {
  const { dshHome, skills } = await homes()
  const { dir, file } = await makeBundle(skills, 'beta')
  const result = await moveSkillToTrash({
    dshHome,
    allowedRoots: [join(dshHome, 'skills')],
    entry: { name: 'beta', path: file, source: 'claude', scope: 'global', readonly: true },
  })
  assert.equal(result.ok, false)
  assert.equal(existsSync(dir), true, '文件必须原地不动')
})

test('已经不在磁盘上的技能：删除是失败，不是静默成功', async () => {
  const { dshHome, skills } = await homes()
  const result = await moveSkillToTrash({
    dshHome,
    allowedRoots: [join(dshHome, 'skills')],
    entry: { name: 'ghost', path: join(skills, 'ghost', 'SKILL.md'), source: 'user-dsh', readonly: false },
  })
  assert.equal(result.ok, false)
  assert.match(String(result.reason), /已不在磁盘上/)
})

test('恢复：放回原位置，内容不变', async () => {
  const { dshHome, skills } = await homes()
  const { dir, file } = await makeBundle(skills, 'gamma', '# 正文')
  const moved = await moveSkillToTrash({
    dshHome,
    allowedRoots: [join(dshHome, 'skills')], entry: { name: 'gamma', path: file, source: 'user-dsh', readonly: false },
  })
  assert.equal(moved.ok, true)

  const restored = await restoreFromTrash({ record: moved.record, allowedRoots: [join(dshHome, 'skills')] })
  assert.equal(restored.ok, true, restored.reason)
  assert.equal(existsSync(dir), true)
  assert.match(await readFile(file, 'utf8'), /# 正文/)
  assert.equal(existsSync(moved.record.trashPath), false, '回收站里不该留副本')
})

test('恢复：原位置已被占用时拒绝，绝不覆盖，回收站里的东西还在', async () => {
  const { dshHome, skills } = await homes()
  const { dir, file } = await makeBundle(skills, 'delta', '# 旧的')
  const moved = await moveSkillToTrash({
    dshHome,
    allowedRoots: [join(dshHome, 'skills')], entry: { name: 'delta', path: file, source: 'user-dsh', readonly: false },
  })
  await makeBundle(skills, 'delta', '# 新的')

  const restored = await restoreFromTrash({ record: moved.record, allowedRoots: [join(dshHome, 'skills')] })
  assert.equal(restored.ok, false)
  assert.match(String(restored.reason), /未覆盖/)
  assert.match(await readFile(file, 'utf8'), /# 新的/, '新内容不能被旧内容替换')
  assert.equal(existsSync(join(moved.record.trashPath, 'SKILL.md')), true, '旧内容仍留在回收站')
})

test('彻底删除：抹掉回收站里的文件；记录可以随之摘掉', async () => {
  const { dshHome, skills } = await homes()
  const { file } = await makeBundle(skills, 'eps')
  const moved = await moveSkillToTrash({
    dshHome,
    allowedRoots: [join(dshHome, 'skills')], entry: { name: 'eps', path: file, source: 'user-dsh', readonly: false },
  })

  const state = emptyManagerState()
  state.trash = [moved.record]
  assert.equal(trashList(state).length, 1)
  assert.equal(trashList(state)[0].exists, true)

  const purged = await purgeFromTrash({ dshHome, record: moved.record })
  assert.equal(purged.ok, true)
  assert.equal(existsSync(moved.record.trashPath), false)

  dropTrashRecord(state, moved.record.id)
  assert.deepEqual(state.trash, [])
})

test('彻底删除：记录被手改成回收站之外的路径时必须拒绝', async () => {
  const { dshHome, skills } = await homes()
  const { file } = await makeBundle(skills, 'zeta')
  // 模拟 state.json 被手工改坏：指向一个真实存在但不在回收站里的技能
  const result = await purgeFromTrash({
    dshHome,
    record: { id: 'evil', name: 'zeta', path: file, trashPath: join(skills, 'zeta') },
  })
  assert.equal(result.ok, false)
  assert.match(String(result.reason), /拒绝删除回收站目录之外/)
  assert.equal(existsSync(join(skills, 'zeta')), true, '真实技能必须还在')
})

test('trashList：按删除时间倒序，并标出文件是否还在', () => {
  const state = emptyManagerState()
  state.trash = [
    { id: 'old', name: 'a', source: 'user-dsh', path: '/x/a', trashPath: '/nowhere/old', deletedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'new', name: 'b', source: 'user-dsh', path: '/x/b', trashPath: '/nowhere/new', deletedAt: '2026-02-01T00:00:00.000Z' },
  ]
  const rows = trashList(state)
  assert.deepEqual(rows.map((row) => row.id), ['new', 'old'], '最近的排最前')
  assert.equal(rows.every((row) => row.exists === false), true, '文件不在时要如实标出')
})
