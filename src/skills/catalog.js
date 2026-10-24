/**
 * 在线技能市场：skills.sh 与 ClawHub 的搜索、榜单、下载、安装。
 *
 * ## 只构造固定官方地址
 *
 * 这个模块**不接受调用方传入 URL**。所有端点都由常量拼出来，用户输入只作为 query /
 * identifier 参与构造。这不是洁癖：一个能传 URL 的「下载并写入磁盘」接口就是 SSRF + 任意
 * 写盘的组合。
 *
 * ## 两个市场的协议不一样
 *
 *   · skills.sh：搜索 `GET /api/search?q=`；下载 `GET /api/download/<owner>/<repo>/<skillId>`
 *     返回 `{ files: [{ path, contents }] }`（**JSON 里的文件内容**）。
 *   · ClawHub：搜索 `GET /api/v1/search`、榜单 `GET /api/v1/skills`；
 *     下载 `GET /api/v1/download?owner=&slug=` 返回一个 **zip**。
 *
 * 所以解析拆成两个函数、安装共用一条落盘路径（`installFilesToDestination`）。外部服务的
 * 格式漂移是常态，所以每个字段都做类型与长度校验，解析失败给可读原因，而不是让整页崩掉。
 */
import { installFilesToDestination, skillFromZip } from './import.js'

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_QUERY = 100
const MAX_TEXT_BYTES = 1 << 20
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
const MAX_FILES = 200
const TIMEOUT_MS = 12_000

/** 文件相对路径：不许绝对、不许 `..`、不许盘符。越界的包直接拒绝。 */
const SAFE_PATH = /^[^/\\:][^:]*$/

const fail = (reason) => ({ ok: false, reason })

/** 读响应体并卡上限；超限就取消读取，不把内存吃光。 */
async function readBounded(response, limit) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel?.().catch(() => undefined)
    return fail('响应过大')
  }
  try {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > limit) return fail('响应过大')
    return { ok: true, bytes }
  } catch (error) {
    return fail(`读取响应失败：${String(error?.message ?? error)}`)
  }
}

/** 统一的取数：固定 URL、固定 accept、固定超时，失败收敛成可读原因。 */
async function fetchFixed(url, { fetchImpl, accept }) {
  if (typeof fetchImpl !== 'function') return fail('当前环境没有 fetch')
  let response
  try {
    response = await fetchImpl(url, {
      headers: { accept },
      redirect: 'error',
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
    })
  } catch (error) {
    return fail(`请求失败：${String(error?.message ?? error)}`)
  }
  if (response.ok !== true) return fail(`服务返回 HTTP ${Number(response.status ?? 0)}`)
  return { ok: true, response }
}

const text = (value, limit = 512) => (
  typeof value === 'string' && value.trim() !== '' && value.length <= limit ? value.trim() : ''
)
const count = (value) => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
)

/**
 * skills.sh 搜索。
 *
 * 每条结果自带 `source`（`owner/repo`）与 `skillId` —— 也就是说「从市场装一个技能」等价于
 * 「到这个 GitHub 仓库里取这一个技能」，安装时复用仓库那套下载/校验。
 */
export async function searchSkillsSh(query, { fetchImpl = globalThis.fetch } = {}) {
  const q = String(query ?? '').trim()
  if (q === '' || q.length > MAX_QUERY) return fail('搜索词不能为空且不能超过 100 个字符')
  const url = new URL('https://skills.sh/api/search')
  url.searchParams.set('q', q)
  const got = await fetchFixed(url, { fetchImpl, accept: 'application/json' })
  if (got.ok !== true) return got
  const body = await readBounded(got.response, MAX_TEXT_BYTES)
  if (body.ok !== true) return body
  let payload
  try {
    payload = JSON.parse(new TextDecoder().decode(body.bytes))
  } catch {
    return fail('skills.sh 返回的不是有效 JSON')
  }
  if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.skills)) {
    return fail('skills.sh 返回结构无效')
  }
  const items = []
  const seen = new Set()
  for (const entry of payload.skills) {
    if (entry === null || typeof entry !== 'object') continue
    const source = text(entry.source, 256)
    const [owner, repo] = source.split('/')
    if (!IDENTIFIER.test(owner ?? '') || !IDENTIFIER.test(repo ?? '')) continue
    const skillId = text(entry.skillId, 128)
    if (!IDENTIFIER.test(skillId)) continue
    const name = text(entry.name, 256)
    if (name === '') continue
    const id = `${source}/${skillId}`
    if (seen.has(id)) continue
    seen.add(id)
    const item = { catalog: 'skillsh', id, source, owner, repo, skillId, name }
    const installs = count(entry.installs)
    if (installs !== undefined) item.installs = installs
    items.push(item)
    if (items.length >= 100) break
  }
  return { ok: true, items }
}

/** ClawHub 的条目：`{ ownerHandle, slug, displayName, summary, stats }`。 */
function clawHubItem(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const owner = text(entry.ownerHandle ?? entry.owner?.handle, 128)
  const slug = text(entry.slug, 128)
  if (!IDENTIFIER.test(owner) || !IDENTIFIER.test(slug)) return null
  const stats = entry.stats !== null && typeof entry.stats === 'object'
    ? entry.stats
    : entry.native?.skill?.stats
  const item = {
    catalog: 'clawhub',
    owner,
    slug,
    name: text(entry.displayName, 256) || slug,
    summary: text(entry.summary, 8192),
  }
  if (stats !== null && typeof stats === 'object') {
    const downloads = count(stats.downloads)
    if (downloads !== undefined) item.downloads = downloads
  }
  const downloads = count(entry.downloads)
  if (item.downloads === undefined && downloads !== undefined) item.downloads = downloads
  return item
}

/** ClawHub 搜索。 */
export async function searchClawHub(query, { fetchImpl = globalThis.fetch, limit = 20 } = {}) {
  const q = String(query ?? '').trim()
  if (q === '' || q.length > MAX_QUERY) return fail('搜索词不能为空且不能超过 100 个字符')
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100)
  const url = new URL('https://clawhub.ai/api/v1/search')
  url.searchParams.set('q', q)
  url.searchParams.set('limit', String(safeLimit))
  const got = await fetchFixed(url, { fetchImpl, accept: 'application/json' })
  if (got.ok !== true) return got
  const body = await readBounded(got.response, MAX_TEXT_BYTES)
  if (body.ok !== true) return body
  let payload
  try {
    payload = JSON.parse(new TextDecoder().decode(body.bytes))
  } catch {
    return fail('ClawHub 返回的不是有效 JSON')
  }
  if (!Array.isArray(payload?.results)) return fail('ClawHub 返回结构无效')
  const items = []
  for (const entry of payload.results) {
    const item = clawHubItem(entry)
    if (item === null) continue
    items.push(item)
    if (items.length >= safeLimit) break
  }
  return { ok: true, items }
}

/** ClawHub 下载榜（带游标分页）。 */
export async function listClawHub({ fetchImpl = globalThis.fetch, limit = 10, cursor = '' } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 10)
  const url = new URL('https://clawhub.ai/api/v1/skills')
  url.searchParams.set('sort', 'downloads')
  url.searchParams.set('limit', String(safeLimit))
  if (String(cursor) !== '') url.searchParams.set('cursor', String(cursor).slice(0, 4096))
  const got = await fetchFixed(url, { fetchImpl, accept: 'application/json' })
  if (got.ok !== true) return got
  const body = await readBounded(got.response, MAX_TEXT_BYTES)
  if (body.ok !== true) return body
  let payload
  try {
    payload = JSON.parse(new TextDecoder().decode(body.bytes))
  } catch {
    return fail('ClawHub 返回的不是有效 JSON')
  }
  if (!Array.isArray(payload?.items)) return fail('ClawHub 返回结构无效')
  const items = []
  for (const entry of payload.items) {
    const item = clawHubItem(entry)
    if (item === null) continue
    items.push(item)
    if (items.length >= safeLimit) break
  }
  const nextCursor = typeof payload.nextCursor === 'string' && payload.nextCursor !== '' ? payload.nextCursor : ''
  return { ok: true, items, nextCursor }
}

/**
 * 把路由传来的扁平字段校验成一个市场技能标识。
 *
 * @returns `{ ok, catalog, owner, slug, source, skillId }` 或 `{ ok: false, reason }`
 */
export function catalogIdentity(input) {
  const catalog = input?.catalog === 'clawhub' ? 'clawhub' : 'skillsh'
  if (catalog === 'clawhub') {
    const owner = String(input?.owner ?? '')
    const slug = String(input?.slug ?? '')
    if (!IDENTIFIER.test(owner) || !IDENTIFIER.test(slug)) return fail('ClawHub 技能标识无效')
    return { ok: true, catalog, owner, slug }
  }
  const source = String(input?.source ?? '')
  const skillId = String(input?.skillId ?? '')
  const [owner, repo] = source.split('/')
  if (!IDENTIFIER.test(owner ?? '') || !IDENTIFIER.test(repo ?? '') || !IDENTIFIER.test(skillId)) {
    return fail('skills.sh 技能标识无效')
  }
  return { ok: true, catalog, owner, repo, skillId, source, slug: skillId }
}

/** 从 JSON 里的 `{ files: [{ path, contents }] }` 建一份文件表（校验路径）。 */
function filesFromPayload(payload) {
  if (!Array.isArray(payload?.files) || payload.files.length === 0 || payload.files.length > MAX_FILES) {
    return fail('技能文件列表无效或过多')
  }
  const files = new Map()
  for (const entry of payload.files) {
    if (entry === null || typeof entry !== 'object') return fail('技能文件条目无效')
    const path = String(entry.path ?? '')
    const contents = entry.contents
    if (typeof contents !== 'string') return fail('技能文件内容无效')
    if (path === '' || !SAFE_PATH.test(path) || path.includes('..') || path.includes('\\')) {
      return fail(`技能包含非法文件路径：${path}`)
    }
    files.set(path, new Uint8Array(Buffer.from(contents, 'utf8')))
  }
  if (!files.has('SKILL.md')) return fail('技能缺少 SKILL.md')
  return { ok: true, files }
}

/** 下载一个市场技能的内容，返回可直接落盘的文件表。 */
export async function loadCatalogSkill(identity, { fetchImpl = globalThis.fetch } = {}) {
  const parsed = catalogIdentity(identity)
  if (parsed.ok !== true) return parsed

  if (parsed.catalog === 'skillsh') {
    const url = `https://skills.sh/api/download/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/${encodeURIComponent(parsed.skillId)}`
    const got = await fetchFixed(url, { fetchImpl, accept: 'application/json' })
    if (got.ok !== true) return got
    const body = await readBounded(got.response, MAX_TEXT_BYTES)
    if (body.ok !== true) return body
    let payload
    try {
      payload = JSON.parse(new TextDecoder().decode(body.bytes))
    } catch {
      return fail('skills.sh 返回的技能包不是有效 JSON')
    }
    const files = filesFromPayload(payload)
    if (files.ok !== true) return files
    return { ok: true, files: files.files }
  }

  const url = new URL('https://clawhub.ai/api/v1/download')
  url.searchParams.set('owner', parsed.owner)
  url.searchParams.set('slug', parsed.slug)
  const got = await fetchFixed(url, { fetchImpl, accept: 'application/zip' })
  if (got.ok !== true) return got
  const body = await readBounded(got.response, MAX_ARCHIVE_BYTES)
  if (body.ok !== true) return body
  // ClawHub 的包就是一个 zip，复用导入那套「只认一个 SKILL.md」的解析
  const zipped = skillFromZip(body.bytes)
  if (zipped.ok !== true) return zipped
  return { ok: true, files: zipped.files }
}

/** 下载并安装一个市场技能。 */
export async function installCatalogSkill({ dshHome, agentsHome = '', identity, destination, fetchImpl = globalThis.fetch }) {
  const loaded = await loadCatalogSkill(identity, { fetchImpl })
  if (loaded.ok !== true) return loaded
  const markdown = new TextDecoder().decode(loaded.files.get('SKILL.md') ?? new Uint8Array())
  return installFilesToDestination({
    dshHome, agentsHome, destination, name: '', markdown, files: loaded.files,
  })
}
