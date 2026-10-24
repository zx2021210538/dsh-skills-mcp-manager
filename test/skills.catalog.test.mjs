/**
 * 在线市场（skills.sh / ClawHub）：搜索、榜单、下载、安装。
 *
 * 全部离线：`fetchImpl` 是注入的，所以能精确喂「真实形状」「缺字段」「脏条目」「坏 JSON」
 * 这些情况。外部服务的格式漂移是常态 —— 这里的价值恰恰是**漂移时给出可读原因，而不是把页面打崩**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import {
  catalogIdentity, installCatalogSkill, listClawHub, loadCatalogSkill,
  searchClawHub, searchSkillsSh,
} from '../src/skills/catalog.js'

/** 造一个 fetch：按 URL 关键词返回预设响应。 */
const jsonReply = (payload, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  arrayBuffer: async () => strToU8(JSON.stringify(payload)).buffer,
})

const bytesReply = (bytes, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
})

const SKILL_MD = (name) => `---\nname: ${name}\ndescription: 演示\n---\n\n# ${name}\n`

test('searchSkillsSh：只保留字段合法的条目，id 由 source/skillId 拼出', async () => {
  const result = await searchSkillsSh('pdf', {
    fetchImpl: jsonReply({
      skills: [
        { source: 'owner/repo', skillId: 'pdf-tools', name: 'PDF Tools', installs: 12 },
        { source: 'bad', skillId: 'x', name: 'nope' },
        { source: 'owner/repo', skillId: 'pdf-tools', name: 'PDF Tools' },
        { source: 'owner/repo', skillId: 'bad id', name: 'x' },
      ],
    }),
  })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.items.length, 1, `重复与非法的都要滤掉，实际 ${JSON.stringify(result.items)}`)
  assert.equal(result.items[0].id, 'owner/repo/pdf-tools')
  assert.equal(result.items[0].installs, 12)
})

test('searchSkillsSh：空查询、坏 JSON、HTTP 失败都给出可读原因', async () => {
  assert.match(String((await searchSkillsSh('', { fetchImpl: jsonReply({}) })).reason), /搜索词/)
  assert.match(String((await searchSkillsSh('x'.repeat(101), { fetchImpl: jsonReply({}) })).reason), /搜索词/)
  assert.match(String((await searchSkillsSh('pdf', { fetchImpl: bytesReply(strToU8('not json')) })).reason), /不是有效 JSON/)
  assert.match(String((await searchSkillsSh('pdf', { fetchImpl: jsonReply({}, 500) })).reason), /HTTP 500/)
  assert.match(
    String((await searchSkillsSh('pdf', { fetchImpl: async () => { throw new Error('offline') } })).reason),
    /请求失败/,
  )
})

test('searchClawHub：两种 owner 形状都认，非法 slug 被滤掉', async () => {
  const result = await searchClawHub('review', {
    fetchImpl: jsonReply({
      results: [
        { ownerHandle: 'alice', slug: 'pr-review', displayName: 'PR Review', summary: 's', stats: { downloads: 7 } },
        { owner: { handle: 'bob' }, slug: 'code-review' },
        { ownerHandle: 'alice', slug: 'bad slug' },
      ],
    }),
  })
  assert.equal(result.ok, true, result.reason)
  assert.deepEqual(result.items.map((item) => item.slug), ['pr-review', 'code-review'])
  assert.equal(result.items[0].downloads, 7)
  assert.equal(result.items[1].name, 'code-review', '没有 displayName 时退回 slug')
})

test('listClawHub：返回 items 与 nextCursor', async () => {
  const result = await listClawHub({
    fetchImpl: jsonReply({ items: [{ ownerHandle: 'a', slug: 'b', displayName: 'B' }], nextCursor: 'c1' }),
  })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.items.length, 1)
  assert.equal(result.nextCursor, 'c1')

  const empty = await listClawHub({ fetchImpl: jsonReply({ items: [] }) })
  assert.equal(empty.nextCursor, '')
})

test('catalogIdentity：两个市场各自的标识校验', () => {
  assert.equal(catalogIdentity({ catalog: 'skillsh', source: 'o/r', skillId: 's' }).ok, true)
  assert.equal(catalogIdentity({ catalog: 'skillsh', source: 'o', skillId: 's' }).ok, false)
  assert.equal(catalogIdentity({ catalog: 'skillsh', source: 'o/r', skillId: '' }).ok, false)
  assert.equal(catalogIdentity({ catalog: 'clawhub', owner: 'o', slug: 's' }).ok, true)
  assert.equal(catalogIdentity({ catalog: 'clawhub', owner: '', slug: 's' }).ok, false)
})

test('loadCatalogSkill（skills.sh）：JSON 里的文件变成文件表；缺 SKILL.md 拒绝', async () => {
  const ok = await loadCatalogSkill({ catalog: 'skillsh', source: 'o/r', skillId: 's' }, {
    fetchImpl: jsonReply({ files: [{ path: 'SKILL.md', contents: SKILL_MD('from-market') }] }),
  })
  assert.equal(ok.ok, true, ok.reason)
  assert.equal(new TextDecoder().decode(ok.files.get('SKILL.md')).includes('from-market'), true)

  const missing = await loadCatalogSkill({ catalog: 'skillsh', source: 'o/r', skillId: 's' }, {
    fetchImpl: jsonReply({ files: [{ path: 'README.md', contents: 'x' }] }),
  })
  assert.match(String(missing.reason), /缺少 SKILL\.md/)
})

test('loadCatalogSkill（skills.sh）：越界文件路径必须拒绝', async () => {
  const result = await loadCatalogSkill({ catalog: 'skillsh', source: 'o/r', skillId: 's' }, {
    fetchImpl: jsonReply({
      files: [
        { path: 'SKILL.md', contents: SKILL_MD('x') },
        { path: '../evil.md', contents: 'evil' },
      ],
    }),
  })
  assert.equal(result.ok, false)
  assert.match(String(result.reason), /非法文件路径/)
})

test('loadCatalogSkill（ClawHub）：zip 包复用导入的解析', async () => {
  const zip = zipSync({ 'pkg/s/SKILL.md': strToU8(SKILL_MD('claw-one')) })
  const result = await loadCatalogSkill({ catalog: 'clawhub', owner: 'o', slug: 's' }, {
    fetchImpl: bytesReply(new Uint8Array(zip)),
  })
  assert.equal(result.ok, true, result.reason)
  assert.equal(new TextDecoder().decode(result.files.get('SKILL.md')).includes('claw-one'), true)
})

test('installCatalogSkill：下载后落到目标目录，名字取 frontmatter', async () => {
  const dshHome = await mkdtemp(join(tmpdir(), 'smp-catalog-'))
  await mkdir(dshHome, { recursive: true })
  const done = await installCatalogSkill({
    dshHome,
    identity: { catalog: 'skillsh', source: 'o/r', skillId: 's' },
    destination: { scope: 'global', destId: 'dsh', project: '' },
    fetchImpl: jsonReply({ files: [{ path: 'SKILL.md', contents: SKILL_MD('market-skill') }] }),
  })
  assert.equal(done.ok, true, done.reason)
  assert.equal(done.name, 'market-skill')
  assert.equal(existsSync(join(dshHome, 'skills', 'market-skill', 'SKILL.md')), true)
  assert.match(await readFile(join(dshHome, 'skills', 'market-skill', 'SKILL.md'), 'utf8'), /name: market-skill/)
})

test('installCatalogSkill：下载失败时不留下半个目录', async () => {
  const dshHome = await mkdtemp(join(tmpdir(), 'smp-catalog-fail-'))
  await mkdir(dshHome, { recursive: true })
  const done = await installCatalogSkill({
    dshHome,
    identity: { catalog: 'skillsh', source: 'o/r', skillId: 's' },
    destination: { scope: 'global', destId: 'dsh', project: '' },
    fetchImpl: jsonReply({}, 502),
  })
  assert.equal(done.ok, false)
  assert.equal(existsSync(join(dshHome, 'skills')), false, '失败不该创建 skills 目录')
})
