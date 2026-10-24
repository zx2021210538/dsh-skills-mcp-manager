/**
 * 工具过滤规则改动后，**立刻**把该放行却还没注册的工具补注册进注册表。
 *
 * ## 为什么必须有这条路由
 *
 * 过滤器（`src/mcp/filter.js`）是在 `tools.register()` 那一刻决定挡不挡的：被挡下的工具
 * 从未进入注册表。而用户改规则（例如把一台服务器切成「全部保留」）只改变**后续**判定，
 * 不会让 DSH 的 MCP 客户端重新上报它的工具 —— 于是：
 *
 *   · 面板徽标一直显示旧的「可用 4 个工具」；
 *   · 模型侧也真的调不到第 5 个工具；
 *   · 只有重启（客户端重连、重新注册全量工具）才会刷新。
 *
 * 这是设计缺陷，不是"应该重启"。修法：过滤器在挡下之前会收到**完整的工具定义**
 * （`installShadow` 的 `observe` 钩子），把那些定义按名字存起来；改完规则后调用这条路由，
 * 由它把"现在应该放行、但注册表里没有"的定义补注册进去。
 *
 * ## 边界
 *
 * - 只处理**曾经上报过**的工具（没见过定义就无法注册，也不该凭空造）。
 * - 以注册表现状为准：已经在表里的跳过，避免重复注册。
 * - 注册失败（同名的另一代已存在、定义已失效）只记数不抛错 —— 补注册是尽力而为，
 *   失败时用户仍可「停用再启用」那张卡片来强制重新上报。
 */
import { NAME } from '../identity.js'

/** 请求体上限（服务器名列表，几百字节足够）。 */
const MAX_BODY = 16 * 1024
export const TOOLS_SYNC_PATH = `/${NAME}/tools-sync`

/**
 * @param ctx - cordis context（含 `webServer` 与 `connection`）。
 * @param options.sync - `() => { registered, skipped, blocked }`，由 `src/index.js` 提供：
 *   它知道当前规则、注册表现状与观察到的定义。
 */
export function registerToolsSyncRoute(ctx, { sync }) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: TOOLS_SYNC_PATH,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      res.setHeader('cache-control', 'no-store')
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      // 与其它写路由同一道守卫：必须是 JSON 请求（跨站表单提交带不了这个 content-type）。
      const contentType = String(req.headers?.['content-type'] ?? '')
      if (!contentType.toLowerCase().includes('application/json')) {
        res.statusCode = 415
        res.end(JSON.stringify({ ok: false, reason: '需要 application/json' }))
        return
      }
      // 读请求体：`servers` 是本次规则改动涉及的服务器（只重启它们，别惊动整机）。
      let body = {}
      try {
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > MAX_BODY) throw new Error('body too large')
          chunks.push(chunk)
        }
        const text = Buffer.concat(chunks).toString('utf8')
        body = text === '' ? {} : JSON.parse(text)
      } catch (error) {
        res.statusCode = 400
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, reason: String(error?.message ?? error) }))
        return
      }
      const servers = Array.isArray(body?.servers)
        ? body.servers.filter((name) => typeof name === 'string' && name !== '')
        : []

      res.setHeader('content-type', 'application/json; charset=utf-8')
      try {
        const result = typeof sync === 'function'
          ? await sync(servers)
          : { registered: 0, restarted: 0, failed: 0 }
        res.statusCode = 200
        res.end(JSON.stringify({ ok: true, ...result }))
      } catch (error) {
        ctx.logger.warn('dsh-skills-mcp-manager: tool sync failed: %s', String(error?.message ?? error))
        res.statusCode = 200
        res.end(JSON.stringify({ ok: false, reason: String(error?.message ?? error) }))
      }
    },
  }))
}
