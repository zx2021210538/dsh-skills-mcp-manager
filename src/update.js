/**
 * 本插件的自更新检查：问 GitHub 仓库「最新发布版本是多少」，与本机版本比一下。
 *
 * ## 更新源就是本仓库
 *
 * 发布方式是 GitHub Release：tag 形如 `v0.6.0`，并附上打包好的 `.tgz`。
 * 检查逻辑优先读 **releases/latest**；如果仓库还没创建任何 release（例如刚建仓），
 * 退回读默认分支的 `package.json`，这样「版本号在仓库里」永远是可查的。
 *
 * ## 只做「检查」，不做「安装」
 *
 * 插件自己替换自己的文件是危险的：宿主进程已经加载了这一代模块，换掉磁盘上的文件之后
 * 进程里跑的仍是旧代码，界面上却以为更新成功了。DSH 的插件管理器本来就有安装 / 升级通道，
 * 所以这里只负责**回答「有没有新版」**，把「怎么升」留给它（或用户按 README 重装一次）。
 */

/** 本包的 npm 名字（与 package.json 的 name 一致；以后若发布到 registry 可直接复用）。 */
export const PACKAGE_NAME = 'dsh-skills-mcp-manager'

/** 更新源仓库（owner/name）。发版、检查更新都以这里为准。 */
export const REPOSITORY = 'zx2021210538/dsh-skills-mcp-manager'

/** 读不到 release 时回退读取的分支。 */
export const DEFAULT_BRANCH = 'main'

/** 人看的发布页。 */
export const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`

const GITHUB_API = 'https://api.github.com'
const RAW_GITHUB = 'https://raw.githubusercontent.com'
const TIMEOUT_MS = 8000

/** GitHub API 要求带 UA；不带会被 403。 */
const HEADERS = {
  accept: 'application/vnd.github+json',
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
async function getJson(fetchImpl, url, what) {
  let response
  try {
    response = await fetchImpl(url, {
      headers: HEADERS,
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
 * 问 GitHub 仓库最新版本是多少。
 *
 * 顺序：`GET /repos/<repo>/releases/latest` → 取不到（没有 release / API 403 限流 /
 * 网络失败）时退到 `GET https://raw.githubusercontent.com/<repo>/<branch>/package.json`。
 * 退路很重要：GitHub API 对匿名请求有每小时 60 次的限额，而 raw 文件没有这个限制；
 * 版本号本来就在 package.json 里，没必要因为限流就告诉用户「检查更新失败」。
 *
 * @returns `{ ok: true, current, latest, updateAvailable, url, source }`
 *          或 `{ ok: false, reason }`
 */
export async function checkForUpdate({
  currentVersion,
  repository = REPOSITORY,
  branch = DEFAULT_BRANCH,
  fetchImpl = globalThis.fetch,
} = {}) {
  const current = String(currentVersion ?? '').trim()
  if (current === '') return { ok: false, reason: '不知道当前版本' }
  if (typeof fetchImpl !== 'function') return { ok: false, reason: '当前环境没有 fetch' }
  const repo = String(repository ?? '').trim()
  if (repo === '') return { ok: false, reason: '没有配置更新源仓库' }
  const releasesPage = `https://github.com/${repo}/releases`

  let latest = ''
  let url = releasesPage
  let source = 'release'

  const release = await getJson(fetchImpl, `${GITHUB_API}/repos/${repo}/releases/latest`, 'GitHub 发布版本')
  if (release.ok === true) {
    const tag = String(release.payload?.tag_name ?? '').trim()
    if (tag === '') return { ok: false, reason: 'GitHub 最新发布没有 tag 名' }
    latest = tag.replace(/^v/i, '')
    if (typeof release.payload?.html_url === 'string' && release.payload.html_url !== '') url = release.payload.html_url
  } else {
    // release 读不到（404 未发布 / 403 限流 / 网络失败等）：退到默认分支的 package.json。
    const rawBranch = String(branch ?? '').trim() === '' ? 'main' : String(branch).trim()
    const manifest = await getJson(
      fetchImpl,
      `${RAW_GITHUB}/${repo}/${encodeURIComponent(rawBranch)}/package.json`,
      '仓库里的 package.json',
    )
    if (manifest.ok !== true) {
      return {
        ok: false,
        reason: `${String(release.reason ?? '读不到 GitHub 发布版本')}；仓库里的 package.json 也读不到（${String(manifest.reason ?? '')}）`,
      }
    }
    latest = String(manifest.payload?.version ?? '').trim()
    if (latest === '') return { ok: false, reason: '仓库里的 package.json 没有 version 字段' }
    url = `https://github.com/${repo}`
    source = 'package.json'
  }

  const order = compareVersions(latest, current)
  if (order === null) {
    return { ok: false, reason: `版本号无法比较（本机 ${current}，仓库 ${latest}）` }
  }
  return { ok: true, current, latest, updateAvailable: order > 0, url, source }
}
