/**
 * Reading the harness tool registry.
 *
 * The MCP client registers every server's tools on the harness registry under
 * `mcp__<serverName>__<rawName>`, so that registry — not a second connection — is
 * the source of truth for "what did this server actually connect with". A Loader
 * row is mounted by the harness in the root scope, which carries no scope tag, so
 * the unscoped `schemas()` view is exactly where its tools land.
 *
 * Failure is reported as a *reason*, not as a bare empty result. "The registry is
 * unreachable" and "this server exposes nothing" look identical in the UI if the
 * reader only returns a list, and the first one is actionable (restart, or fix the
 * conflict) while the second is just a fact. The panel shows the reason verbatim.
 *
 * Kept free of any host import so it can be unit-tested directly (the `ctx` is the
 * only dependency, and it is passed in).
 */
import { MCP_PREFIX, SERVER_SEPARATOR, matchServer } from './filter.js'

/** Every reason the inventory can be unreadable, in the order they are checked. */
export const TOOL_READ_REASONS = {
  /** `ctx.get('tools')` threw: cordis throws on a bare access before injection. */
  lookupFailed: 'lookup-failed',
  /** The tools service is not mounted in this profile at all. */
  serviceMissing: 'service-missing',
  /** The service exists but exposes no `schemas()` (an older or different build). */
  apiMissing: 'api-missing',
  /** `schemas()` threw — typically a visible tool whose parameters are not JSON. */
  readFailed: 'read-failed',
  /** `schemas()` returned something that is not an array. */
  badShape: 'bad-shape',
}

/** Human-readable text for each reason, shown in the panel. */
const REASON_TEXT = {
  [TOOL_READ_REASONS.lookupFailed]: '无法访问工具服务（cordis 服务尚未注入）',
  [TOOL_READ_REASONS.serviceMissing]: '当前配置里没有工具注册表（dsh-tools 未挂载）',
  [TOOL_READ_REASONS.apiMissing]: '工具注册表版本过旧，没有 schemas() 接口',
  [TOOL_READ_REASONS.readFailed]: '读取工具注册表出错',
  [TOOL_READ_REASONS.badShape]: '工具注册表返回了意外的数据形状',
}

/**
 * 把「真正进了注册表的工具」与「服务器报过、但被过滤器挡下的工具」合并成面板的清单。
 *
 * ## 为什么必须合并
 *
 * allow 模式的过滤器把没勾选的工具**挡在注册表之外**（这是它唯一能让工具不被模型看到的
 * 手段）。如果面板的勾选框也从这个注册表读，重启之后那个工具从未注册成功 → 清单里没有它
 * → 用户永远没法把它勾回来。真机上就是这样丢过一次工具：勾 4 个、重启、第 5 个彻底消失。
 *
 * 所以清单要来自「服务器报了什么」（过滤器的观察者在挡下之前记下的），而不是「我们放行了
 * 什么」。注册表那侧的条目优先 —— 它有真实描述，且反映当前这一代连接的实际情况。
 *
 * @param servers - `toolsByServer` 的结果（注册表视角）。
 * @param seenByServer - `Map<serverName, Map<leafName, description>>`，登记过的全部工具。
 * @returns 同样形状的数组，但每个服务器的 `tools` 是并集（按名字排序）。
 */
export function mergeKnownTools(servers, seenByServer) {
  const ledger = seenByServer instanceof Map ? seenByServer : null
  const list = Array.isArray(servers) ? servers : []
  return list.map((entry) => {
    const serverName = String(entry?.serverName ?? '')
    const prefix = `${MCP_PREFIX}${serverName}${SERVER_SEPARATOR}`
    const byName = new Map()
    for (const tool of Array.isArray(entry?.tools) ? entry.tools : []) {
      if (typeof tool?.name !== 'string' || tool.name === '') continue
      byName.set(tool.name, { name: tool.name, description: String(tool?.description ?? '') })
    }
    const seen = ledger?.get(serverName)
    if (seen instanceof Map) {
      for (const [leaf, description] of seen) {
        if (typeof leaf !== 'string' || leaf === '') continue
        const name = `${prefix}${leaf}`
        if (!byName.has(name)) byName.set(name, { name, description: String(description ?? '') })
      }
    }
    return {
      serverName,
      tools: [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)),
    }
  })
}

export function toolReasonText(reason) {
  return REASON_TEXT[reason] ?? '工具清单不可读'
}

/**
 * Tools currently registered for each given server.
 *
 * ## Why a scope is needed
 *
 * `tools.register()` files a definition under **the registering context's scope**, and
 * `schemas()` reads the **global** view when called without one. A `mcp-client` row the
 * Loader mounts at the root registers globally, so the unscoped read sees it. A *project*
 * server is mounted by this plugin into an agent's scope (see `src/project/mount.js`), so
 * its tools live in that agent's layer and are simply **absent** from the global view.
 *
 * Reading unscoped for both tiers therefore reports every project server as having no tools
 * — and because "no tools" and "not mounted" look the same in a list, the panel showed an
 * empty tool list for a server that was mounted and connected. Passing the agent's own scope
 * (`scopeKey`, the very object the scope was minted with) asks the registry the question the
 * user is actually asking: what does the model see in *that* workspace.
 *
 * @param ctx - cordis context; `ctx.get('tools')` is the harness tool registry.
 * @param serverNames - the server names to report on, in order.
 * @param scope - optional scope key (an agent) selecting the view; omitted = global view.
 * @returns `{ ok: true, servers: [{ serverName, tools }] }` when the registry was
 *   read, or `{ ok: false, reason, detail }` when it was not. The two are never
 *   conflated: `ok: true` with an empty `tools` array is a real answer.
 */
export function toolsByServer(ctx, serverNames, scope = undefined) {
  let registry = null
  try {
    registry = ctx.get?.('tools') ?? null
  } catch (error) {
    // A bare service access throws in cordis before the service is injected.
    return { ok: false, reason: TOOL_READ_REASONS.lookupFailed, detail: String(error?.message ?? error) }
  }
  if (registry === null || registry === undefined) {
    return { ok: false, reason: TOOL_READ_REASONS.serviceMissing, detail: '' }
  }
  if (typeof registry.schemas !== 'function') {
    return { ok: false, reason: TOOL_READ_REASONS.apiMissing, detail: '' }
  }
  let schemas = null
  try {
    // One argument either way: `schemas(undefined)` and `schemas()` are the same call, and
    // keeping the shape uniform means the scoped form cannot silently degrade to the global
    // one through a forgotten branch.
    schemas = registry.schemas(scope)
  } catch (error) {
    // `schemas()` throws when any visible tool's parameters are not lossless JSON.
    const detail = String(error?.message ?? error)
    ctx.logger?.warn?.('dsh-skills-mcp-manager: cannot read the tool registry: %s', detail)
    return { ok: false, reason: TOOL_READ_REASONS.readFailed, detail }
  }
  if (!Array.isArray(schemas)) {
    return { ok: false, reason: TOOL_READ_REASONS.badShape, detail: typeof schemas }
  }
  const wanted = [...new Set(
    (Array.isArray(serverNames) ? serverNames : [])
      .filter((name) => typeof name === 'string' && name !== ''),
  )]
  /**
   * 归属用**最长前缀**判定，而不是简单的 `startsWith`。
   *
   * 服务器 `a` 与 `a__b` 互为前缀：按 `startsWith('mcp__a__')` 归属，`a__b` 的工具会被算进
   * `a` 的清单（列表串台、计数虚高）。`filter.js` 的 `matchServer` 早就按最长前缀处理，
   * 这里必须一致 —— 否则"过滤按一个服务器判、展示按另一个服务器算"。
   */
  const owner = new Map()
  for (const schema of schemas) {
    const matched = matchServer(String(schema?.name ?? ''), wanted)
    if (matched !== undefined) owner.set(schema.name, matched.serverName)
  }
  const servers = wanted.map((serverName) => {
    const tools = schemas
      .filter((schema) => typeof schema?.name === 'string' && owner.get(schema.name) === serverName)
      .map((schema) => ({
        // Keep the public name as-is: it is what the model must call. Stripping the
        // prefix could not recover the raw name anyway (long names are truncated
        // and suffixed with a hash).
        name: schema.name,
        description: String(schema.description ?? ''),
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
    return { serverName, tools }
  })
  return { ok: true, servers, total: schemas.length }
}
