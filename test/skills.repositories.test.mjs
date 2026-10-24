/**
 * 技能仓库的「读」这一半：解析地址、下载、扫描、缓存。
 *
 * 用 fflate 现场造压缩包，所以这些用例不联网：既能覆盖真实 GitHub zip 的目录形状
 * （`<repo>-<ref>/<...>/SKILL.md`），也能造出坏输入（根目录的 SKILL.md、非 kebab 名字）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import {
  downloadRepositoryArchive, dropRepositoryCache, parseRepositoryInput,
  readCachedArchive, readRepositorySkills, repositoryArchivePath,
  repositoryZipUrl, scanAndCacheRepository, skillSignature,
} from '../src/skills/repositories.js'

const SKILL = (name, description = '演示') => strToU8(`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`)

/** 造一个 GitHub 形状的压缩包：根目录是 `<repo>-main/`。 */
const makeZip = (files) => zipSync(files)

const SAMPLE = () => makeZip({
  'repo-main/README.md': strToU8('# repo\n'),
  'repo-main/SKILL.md': SKILL('root-level'),
  'repo-main/skills/alpha/SKILL.md': SKILL('alpha', '第一个'),
  'repo-main/skills/alpha/extra.md': strToU8('extra\n'),
  'repo-main/skills/beta/SKILL.md': strToU8('# 没有 frontmatter\n'),
  'repo-main/Bad_Name/SKILL.md': SKILL('Bad_Name'),
})

const homes = async () => {
  const dshHome = await mkdtemp(join(tmpdir(), 'smp-repo-'))
  return { dshHome }
}

test('parseRepositoryInput：四种常见写法归一成同一个仓库', () => {
  const wanted = { owner: 'MichengAI', name: 'dsh-skills-manager', id: 'michengai__dsh-skills-manager' }
  for (const input of [
    'MichengAI/dsh-skills-manager',
    'github.com/MichengAI/dsh-skills-manager',
    'https://github.com/MichengAI/dsh-skills-manager',
    'https://github.com/MichengAI/dsh-skills-manager.git',
    'https://github.com/MichengAI/dsh-skills-manager/',
  ]) {
    const parsed = parseRepositoryInput(input)
    assert.equal(parsed.ok, true, input)
    assert.equal(parsed.owner, wanted.owner, input)
    assert.equal(parsed.name, wanted.name, input)
    assert.equal(parsed.id, wanted.id, `${input} 的缓存 id 必须一致`)
    assert.equal(parsed.ref, '')
  }
})

test('parseRepositoryInput：/tree/<分支> 解析成分支，其它网址给出可读原因', () => {
  const tree = parseRepositoryInput('https://github.com/o/r/tree/feat/x')
  assert.equal(tree.ok, true)
  assert.equal(tree.ref, 'feat/x')

  assert.equal(parseRepositoryInput('').ok, false)
  assert.equal(parseRepositoryInput('https://gitlab.com/o/r').ok, false, '只支持 GitHub')
  assert.equal(parseRepositoryInput('https://github.com/o').ok, false)
  assert.match(String(parseRepositoryInput('https://github.com/o/r/extra/path').reason), /只支持 GitHub/)
})

test('repositoryZipUrl：默认走 HEAD，显式 ref 会按段编码', () => {
  assert.equal(repositoryZipUrl({ owner: 'a', name: 'b' }), 'https://codeload.github.com/a/b/zip/HEAD')
  assert.equal(
    repositoryZipUrl({ owner: 'a', name: 'b', ref: 'feat/x' }),
    'https://codeload.github.com/a/b/zip/feat/x',
  )
})

test('readRepositorySkills：认深层的 SKILL.md，跳过根目录与非法名字', () => {
  const scanned = readRepositorySkills(SAMPLE())
  assert.equal(scanned.ok, true)
  assert.deepEqual(scanned.skills.map((skill) => skill.name), ['alpha', 'beta'])

  const alpha = scanned.skills.find((skill) => skill.name === 'alpha')
  assert.equal(alpha.description, '第一个')
  assert.equal(alpha.dir, 'repo-main/skills/alpha')
  assert.equal(alpha.fileCount, 2, 'SKILL.md + extra.md')
  assert.match(alpha.signature, /^[a-f0-9]{64}$/)

  const beta = scanned.skills.find((skill) => skill.name === 'beta')
  assert.equal(beta.description, '', '没有 frontmatter 时描述为空')
  assert.equal(beta.name, 'beta', '名字退回目录名')

  // 根目录的 SKILL.md（没有技能目录）与非 kebab 名字都不该出现
  assert.equal(scanned.skills.some((skill) => skill.name === 'root-level'), false)
  assert.equal(scanned.skills.some((skill) => skill.name === 'Bad_Name'), false)
})

test('readRepositorySkills：坏压缩包给出原因而不是抛错', () => {
  const result = readRepositorySkills(new Uint8Array([1, 2, 3, 4]))
  assert.equal(result.ok, false)
  assert.match(String(result.reason), /压缩包无法解开/)
})

test('skillSignature：内容相同 → 签名相同；改一个字节 → 签名不同', () => {
  const base = [
    { path: 'SKILL.md', size: 10, hash: 'a'.repeat(64) },
    { path: 'x.md', size: 4, hash: 'b'.repeat(64) },
  ]
  assert.equal(skillSignature(base), skillSignature([...base]))
  assert.notEqual(skillSignature(base), skillSignature([{ ...base[0], size: 11 }, base[1]]))
  assert.notEqual(skillSignature(base), skillSignature([base[0]]))
})

test('downloadRepositoryArchive：404/429 变成人话，成功返回字节', async () => {
  const reply = (status, body) => async () => ({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  })

  const notFound = await downloadRepositoryArchive({
    owner: 'o', name: 'r', fetchImpl: reply(404, new Uint8Array()),
  })
  assert.equal(notFound.ok, false)
  assert.match(String(notFound.reason), /不存在|私有/)

  const limited = await downloadRepositoryArchive({
    owner: 'o', name: 'r', fetchImpl: reply(429, new Uint8Array()),
  })
  assert.match(String(limited.reason), /限流/)

  const ok = await downloadRepositoryArchive({ owner: 'o', name: 'r', fetchImpl: reply(200, SAMPLE()) })
  assert.equal(ok.ok, true)
  assert.ok(ok.bytes.byteLength > 0)
})

test('scanAndCacheRepository：下载 → 扫描 → 压缩包落缓存，记录带签名', async () => {
  const { dshHome } = await homes()
  const fetched = { ok: true, bytes: SAMPLE(), url: 'x' }
  const result = await scanAndCacheRepository({ dshHome, input: 'o/r', fetched })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.record.id, 'o__r')
  assert.deepEqual(result.record.skills.map((skill) => skill.name), ['alpha', 'beta'])
  assert.ok(result.record.scannedAt !== '')

  const cached = await readCachedArchive(dshHome, result.record.id)
  assert.ok(cached instanceof Uint8Array, '压缩包必须落到缓存，安装/更新预览要用')
  assert.equal(existsSync(repositoryArchivePath(dshHome, result.record.id)), true)

  await dropRepositoryCache(dshHome, result.record.id)
  assert.equal(await readCachedArchive(dshHome, result.record.id), null, '移除仓库时缓存一起删')
})

test('scanAndCacheRepository：地址非法时不下载', async () => {
  const { dshHome } = await homes()
  let called = false
  const result = await scanAndCacheRepository({
    dshHome, input: 'https://gitlab.com/o/r',
    fetchImpl: async () => { called = true; return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) } },
  })
  assert.equal(result.ok, false)
  assert.equal(called, false)
})
