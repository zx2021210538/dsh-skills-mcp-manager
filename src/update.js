/**
 * 本插件的自更新检查：回答「有没有比本机更新的版本」，从不自己安装。
 *
 * ## 更新源与插件市场的安装源保持一致
 *
 * 首选 **npm registry 的 latest**（`https://registry.npmjs.org/<name>/latest`）：市场里的
 * 安装/升级走的就是这个包，所以「检查到的新版本」永远是可安装的那一版；npm 读取不需要认证，
 * 也没有 GitHub 匿名 API 的每小时限流。网络或 registry 读不到时，依次回退：
 *
 *   1. GitHub Release `releases/latest` 的 tag（正常发布时与 npm 同版本，因为发版流水线会
 *      校验 tag == package.json version 并发 npm）；
 *   2. 默认分支的 `package.json`（仓库是否发布过都能读出「源码里的版本号」）。
 *
 * ## 只做「检查」，不做「安装」
 *
 * 插件自己替换自己的文件是危险的：宿主进程已经加载了这一代模块，换掉磁盘上的文件之后
 * 进程里跑的仍是旧代码，界面上却以为更新成功了。DSH 的插件管理器本来就有安装 / 升级通道，
 * 所以这里只负责**回答「有没有新版」**，把「怎么升」留给它（或用户按 README 重装一次）。
 */

/** 本包的 npm 名字（与 package.json 的 name 一致）。 */
export const PACKAGE_NAME = 'dsh-skills-mcp-manager'

/** 发布仓库（owner/name）。版本回退与「发布页」链接都以这里为准。 */
export const REPOSITORY = 'zx2021210538/dsh-skills-mcp-manager'

/** 读不到 release 时回退读取的分支。 */
export const DEFAULT_BRANCH = 'main'

/** 人看的发布页。 */
export const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`

const REGISTRY = 'https://registry.npmjs.org'
const GITHUB_API = 'https://api.github.com'
const RAW_GITHUB = 'https://raw.githubusercontent.com'
const TIMEOUT_MS = 8000

const HEADERS_GITHUB = {
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-skills-mcp-manager-update-check',
}

const HEADERS_NPM = {
  accept: 'application/json',
  'user-agent': 'dsh-skills-mcp-manager-update-check',
}

/**
 * 比较两个点分数字版本。
 *
 * 只做数字段比较，`-rc.1` 这类预发布后缀按「同一段」处理 —— 我们自己的版本号是纯数字，
 * 过度解析只会引入误判。无法解析时返回 `null`（调用方据此说「版本号无法比较」而不是猜）。
 *
 * @returns `-1` / `0` / `1`，或 `null`
 */
export function compareVersions(left, right) {
  const parse = (value) => {
    const text = String(value ?? '').trim().replace(/^v/i, '').split('-')[0]
    if (!/^\d+(\.\d+)*$/.test(text)) return null
    return text.split('.').map((part) => Number(part))
  }
  const a = parse(left)
  const b = parse(right)
  if (a === null || b === null) return null
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const one = a[index] ?? 0
    const other = b[index] ?? 0
    if (one > other) return 1
    if (one < other) return -1
  }
  return 0
}

/**
 * 取 JSON；网络异常与解析异常都折叠成 `{ ok:false, status, reason }`，
 * 调用方只负责翻译业务含义。
 *
 * @returns `{ ok: true, status, payload }` 或 `{ ok: false, status, reason }`
 */
async function getJson(fetchImpl, url, what, headers) {
  let response
  try {
    response = await fetchImpl(url, {
      headers,
      redirect: 'error',
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
    })
  } catch (error) {
    return { ok: false, status: 0, reason: `请求 ${what}失败：${String(error?.message ?? error)}` }
  }
  const status = Number(response?.status ?? 0)
  if (response?.ok !== true) return { ok: false, status, reason: `${what} 返回 HTTP ${status}` }
  try {
    return { ok: true, status, payload: await response.json() }
  } catch {
    return { ok: false, status, reason: `${what} 返回的不是有效 JSON` }
  }
}

/**
 * 问「最新可安装版本」是多少。
 *
 * 顺序：npm registry latest → GitHub Release tag → 默认分支 `package.json`。
 *
 * @returns `{ ok: true, current, latest, updateAvailable, url, source }`
 *          或 `{ ok: false, reason }`
 */
export async function checkForUpdate({
  currentVersion,
  packageName = PACKAGE_NAME,
  repository = REPOSITORY,
  branch = DEFAULT_BRANCH,
  fetchImpl = globalThis.fetch,
} = {}) {
  const current = String(currentVersion ?? '').trim()
  if (current === '') return { ok: false, reason: '不知道当前版本' }
  if (typeof fetchImpl !== 'function') return { ok: false, reason: '当前环境没有 fetch' }
  const name = String(packageName ?? '').trim()
  if (name === '') return { ok: false, reason: '没有配置包名' }
  const repo = String(repository ?? '').trim()
  if (repo === '') return { ok: false, reason: '没有配置更新源仓库' }
  const releasesPage = `https://github.com/${repo}/releases`

  /** 比较并组装结果；版本号缺失或无法解析时返回 null，让调用方继续回退。 */
  const finish = (rawLatest, source, url) => {
    const latest = String(rawLatest ?? '').trim().replace(/^v/i, '')
    if (latest === '') return null
    const order = compareVersions(latest, current)
    if (order === null) return null
    return { ok: true, current, latest, updateAvailable: order > 0, url, source }
  }

  let npmReason = ''
  const npmMeta = await getJson(fetchImpl, `${REGISTRY}/${encodeURIComponent(name)}/latest`, 'npm registry', HEADERS_NPM)
  if (npmMeta.ok === true) {
    const result = finish(npmMeta.payload?.version, 'npm', releasesPage)
    if (result !== null) return result
    npmReason = 'npm registry 没有给出有效版本号'
  } else {
    npmReason = String(npmMeta.reason ?? '读不到 npm registry')
  }

  let githubReason = ''
  const release = await getJson(fetchImpl, `${GITHUB_API}/repos/${repo}/releases/latest`, 'GitHub 发布版本', HEADERS_GITHUB)
  if (release.ok === true) {
    const tag = String(release.payload?.tag_name ?? '').trim()
    const url = typeof release.payload?.html_url === 'string' && release.payload.html_url !== ''
      ? release.payload.html_url
      : releasesPage
    const result = tag === '' ? null : finish(tag, 'GitHub Release', url)
    if (result !== null) return result
    githubReason = 'GitHub 最新发布没有有效 tag'
  } else {
    githubReason = String(release.reason ?? '读不到 GitHub 发布版本')
  }

  let manifestReason = ''
  const rawBranch = String(branch ?? '').trim() === '' ? 'main' : String(branch).trim()
  const manifest = await getJson(
    fetchImpl,
    `${RAW_GITHUB}/${repo}/${encodeURIComponent(rawBranch)}/package.json`,
    '仓库里的 package.json',
    HEADERS_GITHUB,
  )
  if (manifest.ok === true) {
    const result = finish(manifest.payload?.version, 'package.json', `https://github.com/${repo}`)
    if (result !== null) return result
    manifestReason = '仓库里的 package.json 没有有效 version'
  } else {
    manifestReason = String(manifest.reason ?? '读不到仓库里的 package.json')
  }

  return {
    ok: false,
    reason: `检查不到可用版本：npm（${npmReason}）；GitHub（${githubReason}）；package.json（${manifestReason}）`,
  }
}
