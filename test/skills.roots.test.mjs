/**
 * 项目根判据的单元测试。
 *
 * 这里钉的是「一个目录属于哪个项目」：DSH 的 `dsh-skill-filesystem` 用最近的 `.git` 祖先
 * （没有则 cwd），面板写盘、扫描、provider 过滤、默认工作区都必须走同一份规则。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { distinctProjectRoots, projectRootFor, samePath, singleListedRoot, singleProjectRoot } from '../src/skills/roots.js'

test('projectRootFor：最近的 .git 祖先是项目根，没有 .git 时退回目录本身', () => {
  const home = mkdtempSync(join(tmpdir(), 'smp-roots-'))
  const repo = join(home, 'repo')
  const nested = join(repo, 'data', 'workspaces', 'bbb')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(nested, { recursive: true })

  assert.equal(projectRootFor(nested), resolve(repo), '嵌套目录要归到仓库根')
  assert.equal(projectRootFor(repo), resolve(repo))
  const plain = join(home, 'plain')
  mkdirSync(plain, { recursive: true })
  assert.equal(projectRootFor(plain), resolve(plain), '没有 .git 时用目录自己')
  assert.equal(projectRootFor(''), '', '空输入不能变成进程 cwd')
  assert.equal(projectRootFor(null), '')
})

test('distinctProjectRoots：同一个仓库的多个目录折叠成一个根，按首次出现顺序', () => {
  const home = mkdtempSync(join(tmpdir(), 'smp-roots-'))
  const repo = join(home, 'repo')
  const nested = join(repo, 'sub')
  const other = join(home, 'other')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(nested, { recursive: true })
  mkdirSync(join(other, '.git'), { recursive: true })

  assert.deepEqual(
    distinctProjectRoots([nested, repo, '', null, other, nested]),
    [resolve(repo), resolve(other)],
  )
  assert.deepEqual(distinctProjectRoots([]), [])
  assert.deepEqual(distinctProjectRoots(undefined), [])
})

test('singleProjectRoot：只有一个根时返回它，零个或多个时返回空', () => {
  const home = mkdtempSync(join(tmpdir(), 'smp-roots-'))
  const repo = join(home, 'repo')
  const nested = join(repo, 'a')
  const other = join(home, 'other')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(nested, { recursive: true })
  mkdirSync(join(other, '.git'), { recursive: true })

  assert.equal(singleProjectRoot([repo, nested]), resolve(repo), '同仓库多个目录仍是一个根')
  assert.equal(singleProjectRoot([repo, other]), '', '两个项目不能猜一个')
  assert.equal(singleProjectRoot([]), '')
})

test('singleListedRoot：根必须在调用方可提供的选项里', () => {
  const home = mkdtempSync(join(tmpdir(), 'smp-roots-'))
  const repo = join(home, 'repo')
  const unregistered = join(home, 'session-only')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(unregistered, { recursive: true })

  assert.equal(singleListedRoot([repo], [resolve(repo)]), resolve(repo))
  assert.equal(singleListedRoot([repo], [resolve(unregistered)]), '',
    '默认值不在下拉选项里时必须留空，否则 select 显示空白但内部已有值')
  assert.equal(singleListedRoot([unregistered], []), '')
  assert.equal(singleListedRoot([], [resolve(repo)]), '')
  if (process.platform === 'win32') {
    assert.equal(singleListedRoot([repo], [repo.toUpperCase()]), resolve(repo), 'Windows 大小写不算域外')
  }
})

test('samePath：同一目录的不同写法视为相同（Windows 上忽略大小写与分隔符）', () => {
  const home = mkdtempSync(join(tmpdir(), 'smp-roots-'))
  const repo = join(home, 'repo')
  mkdirSync(repo, { recursive: true })

  assert.equal(samePath(repo, repo), true)
  assert.equal(samePath(join(repo, '..', 'repo'), repo), true, '相对写法先 resolve')
  assert.equal(samePath(repo, join(home, 'other')), false)
  assert.equal(samePath('', repo), false)
  assert.equal(samePath(null, repo), false)
  if (process.platform === 'win32') {
    assert.equal(samePath(repo.replace(/\\/g, '/'), repo), true, `Windows 上 D:/x 与 D:\\x 是同一目录`)
    assert.equal(samePath(repo.toUpperCase(), repo.toLowerCase()), true, 'Windows 路径大小写不敏感')
  }
})
