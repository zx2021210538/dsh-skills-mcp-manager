/**
 * 技能仓库：从 GitHub 取一个仓库、扫描其中的技能、把压缩包缓存在本地。
 *
 * ## 为什么用 codeload 的 zip，而不是 git clone
 *
 * 三种做法都试过其代价：`git clone` 要求用户机器上有 git、要处理凭据与浅克隆、还会在磁盘上
 * 留下一份工作区；GitHub REST 列表接口有 60 次/小时的未认证限额，翻一棵大树要好几跳。
 * `https://codeload.github.com/<owner>/<repo>/zip/<ref>` 是**一次请求拿到整棵树**，不带 git、
 * 不带限额（走 CDN），解包用 fflate（纯 JS，无原生依赖）。
 *
 * 代价是：拿不到 commit SHA（zip 里只有 `<repo>-<ref>` 这个目录名）。所以「有没有更新」不靠
 * SHA，而靠**内容签名**（{@link skillSignature}）：路径 + 大小 + 内容哈希。这反而更准 ——
 * 用户手工改过本地副本时，签名能看出来，而 SHA 只反映远端变了没。
 *
 * ## 这一层只做「读」
 *
 * 添加 / 刷新 / 移除仓库，以及把压缩包落到本地缓存。**安装、卸载、更新、回滚在另一层**
 * （`repository-install.js`）：那一步会写用户的技能目录，安全边界不同，不该混在一起。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { assertZipWithinLimit } from './zipLimit.js'
import { managerHomePath } from './state.js'

/** 仓库名/拥有者的合法字符（GitHub 的规则比这宽，但多收一个非法名字只会让 URL 更难懂）。 */
const SEGMENT = /^[A-Za-z0-9._-]+$/

/** 压缩包上限。技能仓库都是文本，32 MB 已经远超正常规模。 */
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024

/** DSH 只接受 kebab-case 技能名。 */
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** `$DSH_HOME/dsh-skills-mcp-manager/repos` */
export function repositoryCacheDir(dshHome) {
  return join(managerHomePath(dshHome), 'repos')
}

/** 某个仓库缓存的压缩包路径。 */
export function repositoryArchivePath(dshHome, id) {
  return join(repositoryCacheDir(dshHome), `${String(id)}.zip`)
}

/**
 * Parse what a user pasted into the "添加仓库" box.
 *
 * Accepts `owner/repo`, `github.com/owner/repo`, `https://github.com/owner/repo(.git)`, with an
 * optional `/tree/<ref>` suffix. Anything else is refused **with a reason**, because "添加失败"
 * alone leaves the user guessing whether the problem is the URL or the network.
 *
 * @returns `{ ok: true, owner, name, ref, id, url }` or `{ ok: false, reason }`.
 */
export function parseRepositoryInput(input) {
  const raw = String(input ?? '').trim()
  if (raw === '') return { ok: false, reason: '请填写仓库地址' }
  let text = raw.replace(/^git\+/, '')
  text = text.replace(/^https?:\/\//i, '').replace(/^www\./i, '')
  let ref = ''
  // https://github.com/o/r/tree/main → 分支
  const tree = text.match(/^github\.com\/([^/]+)\/([^/]+)\/tree\/(.+)$/i)
  if (tree !== null) {
    ref = decodeURIComponent(tree[3].replace(/\/+$/, ''))
    text = `github.com/${tree[1]}/${tree[2]}`
  }
  if (text.toLowerCase().startsWith('github.com/')) text = text.slice('github.com/'.length)
  text = text.replace(/\/+$/, '').replace(/\.git$/i, '')
  const parts = text.split('/')
  if (parts.length !== 2) {
    return { ok: false, reason: '只支持 GitHub 仓库地址，形如 https://github.com/owner/repo' }
  }
  const [owner, name] = parts
  if (!SEGMENT.test(owner) || !SEGMENT.test(name) || name === '' || owner === '') {
    return { ok: false, reason: '仓库地址里的 owner / repo 不合法' }
  }
  return {
    ok: true,
    owner,
    name,
    ref,
    // 路径安全：id 只用于我们自己的缓存文件名，统一小写避免 Windows 大小写不敏感带来的碰撞
    id: `${owner}__${name}`.toLowerCase(),
    url: `https://github.com/${owner}/${name}`,
  }
}

/** The codeload URL for one repository (and optional ref). */
export function repositoryZipUrl({ owner, name, ref = '' }) {
  const suffix = ref === '' ? 'HEAD' : ref.split('/').map((part) => encodeURIComponent(part)).join('/')
  return `https://codeload.github.com/${owner}/${name}/zip/${suffix}`
}

/**
 * Download one repository archive.
 *
 * `HEAD` follows the default branch, which is what 「添加仓库」 means; an explicit ref is honoured
 * for a pinned branch/tag. Failures carry a reason a user can act on.
 */
export async function downloadRepositoryArchive({ owner, name, ref = '', fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') return { ok: false, reason: '当前环境没有 fetch' }
  const url = repositoryZipUrl({ owner, name, ref })
  let response
  try {
    response = await fetchImpl(url, { redirect: 'follow', headers: { accept: 'application/zip' } })
  } catch (error) {
    return { ok: false, reason: `下载失败：${String(error?.message ?? error)}` }
  }
  if (response.ok !== true) {
    const status = Number(response.status ?? 0)
    if (status === 404) return { ok: false, reason: '仓库不存在，或是私有仓库（本插件只读公开仓库）', status }
    if (status === 403 || status === 429) return { ok: false, reason: 'GitHub 拒绝了这次下载（可能触发限流，稍后再试）', status }
    return { ok: false, reason: `下载失败：HTTP ${status}`, status }
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0) return { ok: false, reason: '下载到的压缩包是空的' }
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    return { ok: false, reason: `仓库太大（${Math.round(bytes.byteLength / 1024 / 1024)} MB），超过 32 MB 上限` }
  }
  return { ok: true, bytes, url }
}

/** `name` / `description` from a SKILL.md frontmatter block (best effort). */
function frontmatterOf(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''))
  if (match === null) return {}
  const out = {}
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    if (key !== 'name' && key !== 'description') continue
    out[key] = line.slice(at + 1).trim().replace(/^['"]|['"]$/g, '')
  }
  return out
}

/** Sorted relative paths under one skill directory. */
function filesUnder(paths, base) {
  const prefix = base === '' ? '' : `${base}/`
  return paths.filter((path) => path.startsWith(prefix) && path !== base).sort()
}

/**
 * Content signature of one skill directory.
 *
 * `sha256` over `relativePath\0size\0contentHash` for every file, sorted by path. Used to answer
 * 「远端的这个技能和本地装的那份是不是同一个东西」 without trusting a commit SHA (which the zip
 * cannot give us) — and it still detects a locally edited copy.
 */
export function skillSignature(files) {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(`${file.path}\u0000${file.size}\u0000${file.hash}\n`)
  }
  return hash.digest('hex')
}

/**
 * Read the skills inside a repository archive.
 *
 * A skill is any directory holding a `SKILL.md`. The archive root is `<repo>-<ref>/`, so a skill
 * sits at least one level below it (`<root>/<name>/SKILL.md`) or deeper
 * (`<root>/skills/<name>/SKILL.md`) — both are accepted, which is what real skill repositories
 * look like.
 *
 * @returns `{ ok: true, skills, fileCount }` or `{ ok: false, reason }`.
 */
export function readRepositorySkills(bytes) {
  let entries
  try {
        // 解压前先按 zip 中央目录声明的未压缩大小求和，超限直接拒绝（zip bomb）。
    assertZipWithinLimit(bytes)
    entries = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  } catch (error) {
    return { ok: false, reason: `压缩包无法解开：${String(error?.message ?? error)}` }
  }
  const paths = Object.keys(entries).filter((path) => !path.endsWith('/'))
  const byPath = new Map(paths.map((path) => [path, entries[path]]))

  const skills = []
  const seen = new Set()
  for (const path of paths) {
    if (!/(^|\/)SKILL\.md$/i.test(path)) continue
    const base = path.replace(/\/?SKILL\.md$/i, '')
    // 压缩包根目录（`<repo>-<ref>`）本身不是技能：它下面没有可直接认的名字
    if (base === '' || !base.includes('/')) continue
    if (seen.has(base)) continue
    seen.add(base)

    const candidates = filesUnder(paths, base)
    if (candidates.length === 0) continue
    const files = candidates.map((file) => {
      const content = byPath.get(file)
      return {
        path: file.slice(base.length + 1),
        size: content.byteLength,
        hash: createHash('sha256').update(content).digest('hex'),
      }
    })

    const markdown = strFromU8(byPath.get(path) ?? new Uint8Array())
    const meta = frontmatterOf(markdown)
    const fallback = base.split('/').pop() ?? ''
    const declared = typeof meta.name === 'string' && KEBAB.test(meta.name) ? meta.name : ''
    const derived = KEBAB.test(fallback) ? fallback : ''
    const name = declared !== '' ? declared : derived
    // 名字不合法就跳过：装进 DSH 后它也不会被接受，列出来只会让人白点一次
    if (name === '') continue

    skills.push({
      name,
      description: typeof meta.description === 'string' ? meta.description : '',
      dir: base,
      fileCount: files.length,
      signature: skillSignature(files),
    })
  }

  skills.sort((left, right) => left.name.localeCompare(right.name))
  return { ok: true, skills, fileCount: paths.length }
}

/**
 * Scan an archive and write it to the plugin's own cache.
 *
 * The archive is kept so 安装 / 更新预览 can work without another download (and so a later
 * "check for updates" can diff against exactly what was seen at add time).
 */
export async function scanAndCacheRepository({ dshHome, input, fetched, fetchImpl = globalThis.fetch }) {
  const parsed = parseRepositoryInput(input)
  if (parsed.ok !== true) return parsed

  const download = fetched ?? await downloadRepositoryArchive({
    owner: parsed.owner, name: parsed.name, ref: parsed.ref, fetchImpl,
  })
  if (download.ok !== true) return download

  const scanned = readRepositorySkills(download.bytes)
  if (scanned.ok !== true) return scanned

  await mkdir(repositoryCacheDir(dshHome), { recursive: true })
  await writeFile(repositoryArchivePath(dshHome, parsed.id), download.bytes)

  return {
    ok: true,
    record: {
      id: parsed.id,
      owner: parsed.owner,
      name: parsed.name,
      ref: parsed.ref,
      url: parsed.url,
      scannedAt: new Date().toISOString(),
      fileCount: scanned.fileCount,
      skills: scanned.skills,
    },
  }
}

/** 缓存里的压缩包（没有则返回 null；调用方据此提示「先刷新一次」）。 */
export async function readCachedArchive(dshHome, id) {
  try {
    return new Uint8Array(await readFile(repositoryArchivePath(dshHome, id)))
  } catch {
    return null
  }
}

/** 移除一个仓库的缓存（记录由调用方从状态里摘）。 */
export async function dropRepositoryCache(dshHome, id) {
  await rm(repositoryArchivePath(dshHome, id), { force: true })
}
