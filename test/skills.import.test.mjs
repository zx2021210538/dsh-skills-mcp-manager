/**
 * 技能导入：zip / 单个 SKILL.md / 磁盘目录。
 *
 * 三种输入最后共用一份「落到目标目录」的实现，所以边界只测一次就够：
 * 同名不覆盖、越界路径、目标在源目录里面。另外几个是导入特有的：压缩包里多个技能时
 * 必须明确拒绝（而不是随便挑一个），没有 frontmatter 的正文必须补一份可用的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import {
  decodeBase64, importFolder, importMarkdown, importZip, skillFromZip,
} from '../src/skills/import.js'

const SKILL_MD = (name, body = '# body') => `---\nname: ${name}\ndescription: 演示\n---\n\n${body}\n`
const toBase64 = (bytes) => Buffer.from(bytes).toString('base64')

const setup = async () => {
  const base = await mkdtemp(join(tmpdir(), 'smp-import-'))
  const dshHome = join(base, 'dsh')
  await mkdir(dshHome, { recursive: true })
  return { base, dshHome }
}

const DEST = { scope: 'global', destId: 'dsh', project: '' }

test('decodeBase64：普通 base64 与 data URL 都接受，非法输入给原因', () => {
  const bytes = new Uint8Array([1, 2, 3])
  assert.equal(decodeBase64(toBase64(bytes)).ok, true)
  assert.equal(decodeBase64(`data:application/zip;base64,${toBase64(bytes)}`).ok, true)
  assert.equal(decodeBase64('').ok, false)
  assert.equal(decodeBase64('这不是 base64').ok, false, '非 ASCII 必须被拒')
})

test('skillFromZip：只认一个 SKILL.md；多个或没有都明确拒绝', () => {
  const one = zipSync({
    'pkg/skills/alpha/SKILL.md': strToU8(SKILL_MD('alpha')),
    'pkg/skills/alpha/extra.md': strToU8('x\n'),
    'pkg/README.md': strToU8('readme\n'),
  })
  const found = skillFromZip(one)
  assert.equal(found.ok, true, found.reason)
  assert.deepEqual([...found.files.keys()].sort(), ['SKILL.md', 'extra.md'])
  assert.equal(found.fallbackName, 'alpha')

  const none = zipSync({ 'pkg/README.md': strToU8('x') })
  assert.match(String(skillFromZip(none).reason), /没有 SKILL\.md/)

  const many = zipSync({
    'pkg/a/SKILL.md': strToU8(SKILL_MD('a')),
    'pkg/b/SKILL.md': strToU8(SKILL_MD('b')),
  })
  assert.match(String(skillFromZip(many).reason), /一次只能导入一个技能/)
})

test('importZip：文件落到 <root>/<name>，名字取 frontmatter', async () => {
  const { dshHome } = await setup()
  const zip = zipSync({
    'pkg/whatever/SKILL.md': strToU8(SKILL_MD('imported-one')),
    'pkg/whatever/notes.md': strToU8('n\n'),
  })
  const done = await importZip({ dshHome, base64: toBase64(zip), destination: DEST })
  assert.equal(done.ok, true, done.reason)
  assert.equal(done.name, 'imported-one')
  assert.equal(existsSync(join(dshHome, 'skills', 'imported-one', 'SKILL.md')), true)
  assert.equal(existsSync(join(dshHome, 'skills', 'imported-one', 'notes.md')), true)
  assert.match(await readFile(join(dshHome, 'skills', 'imported-one', 'SKILL.md'), 'utf8'), /name: imported-one/)
})

test('importZip：目标已有同名技能时拒绝，不覆盖', async () => {
  const { dshHome } = await setup()
  await mkdir(join(dshHome, 'skills', 'imported-one'), { recursive: true })
  await writeFile(join(dshHome, 'skills', 'imported-one', 'SKILL.md'), '用户自己的\n', 'utf8')
  const zip = zipSync({ 'pkg/x/SKILL.md': strToU8(SKILL_MD('imported-one')) })

  const done = await importZip({ dshHome, base64: toBase64(zip), destination: DEST })
  assert.equal(done.ok, false)
  assert.match(String(done.reason), /未覆盖/)
  assert.equal(await readFile(join(dshHome, 'skills', 'imported-one', 'SKILL.md'), 'utf8'), '用户自己的\n')
})

test('importZip：压缩包里的 ../ 越界路径被拒绝，且不留下半个目录', async () => {
  const { dshHome } = await setup()
  const zip = zipSync({
    'pkg/x/SKILL.md': strToU8(SKILL_MD('sneaky')),
    'pkg/x/../../../evil.md': strToU8('evil\n'),
  })
  const done = await importZip({ dshHome, base64: toBase64(zip), destination: DEST })
  assert.equal(done.ok, false)
  assert.match(String(done.reason), /越界/)
  assert.equal(existsSync(join(dshHome, 'skills', 'sneaky')), false, '失败时不能留下半成品目录')
})

test('importMarkdown：有 frontmatter 原样写入；没有则补一份可用的', async () => {
  const { dshHome } = await setup()
  const withMeta = await importMarkdown({
    dshHome, markdown: SKILL_MD('plain-one'), destination: DEST,
  })
  assert.equal(withMeta.ok, true, withMeta.reason)
  assert.match(await readFile(join(dshHome, 'skills', 'plain-one', 'SKILL.md'), 'utf8'), /name: plain-one/)

  // 没有 frontmatter：给个名字，正文要保住，并且补出 DSH 认得的 frontmatter
  const bare = await importMarkdown({
    dshHome, markdown: '# 只有正文\n', destination: DEST, name: 'bare-body',
  })
  assert.equal(bare.ok, true, bare.reason)
  const text = await readFile(join(dshHome, 'skills', 'bare-body', 'SKILL.md'), 'utf8')
  assert.match(text, /^---\n/)
  assert.match(text, /name: bare-body/)
  assert.match(text, /# 只有正文/, '正文不能丢')
})

test('importMarkdown：空内容与非法名字都被拒绝', async () => {
  const { dshHome } = await setup()
  assert.equal((await importMarkdown({ dshHome, markdown: '   ', destination: DEST })).ok, false)
  const bad = await importMarkdown({ dshHome, markdown: '# x\n', destination: DEST, name: 'Bad Name' })
  assert.equal(bad.ok, false)
  assert.match(String(bad.reason), /kebab-case/)
})

test('importFolder：复制目录；缺 SKILL.md 拒绝；目标在源目录里拒绝', async () => {
  const { base, dshHome } = await setup()
  const source = join(base, 'my-skill')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'SKILL.md'), SKILL_MD('folder-one'), 'utf8')
  await writeFile(join(source, 'helper.md'), 'h\n', 'utf8')

  const done = await importFolder({ dshHome, path: source, destination: DEST })
  assert.equal(done.ok, true, done.reason)
  assert.equal(existsSync(join(dshHome, 'skills', 'folder-one', 'helper.md')), true)

  const empty = join(base, 'empty-dir')
  await mkdir(empty, { recursive: true })
  assert.match(String((await importFolder({ dshHome, path: empty, destination: DEST })).reason), /没有 SKILL\.md/)

  // 源在目标里面：把 dsh/skills 下的一个目录再导入到 dsh/skills 里
  const inside = join(dshHome, 'skills', 'folder-one')
  const nested = await importFolder({ dshHome, path: inside, destination: DEST, name: 'copy-of-folder-one' })
  assert.equal(nested.ok, true, '同一根下的兄弟目录是允许的（不算递归）')

  // 真正会递归的情形：目标目录就是源目录本身
  const self = await importFolder({ dshHome, path: inside, destination: DEST })
  assert.equal(self.ok, false)
  assert.equal(existsSync(join(dshHome, 'skills', 'folder-one', 'SKILL.md')), true, '源目录必须完好')
})
