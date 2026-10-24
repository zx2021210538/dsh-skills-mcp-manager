/**
 * 在线市场路由：`POST /<name>/skills-catalog`。
 *
 * ## 为什么单独一条路由
 *
 * 市场操作**会打外网**（12 秒超时），而治理路由是串行队列 —— 把搜索塞进同一个队列，
 * 一次网络卡顿就会让「启停某个技能」这种本该毫秒级的操作排在后面等十几秒。
 * 路由分开、队列也就分开了，慢的东西慢在自己那条线上。
 *
 * 请求体很小（只有 query 与标识），所以沿用默认的 256 KB 上限。
 */
import { NAME } from '../identity.js'
import { guardWrite, readBody, sendJson } from './http.js'

export const SKILL_CATALOG_PATH = `/${NAME}/skills-catalog`

/** Register the catalog route. `apply` is injected so this module stays free of IO and fetch. */
export function registerSkillCatalogRoute(ctx, { apply }) {
  /** 市场操作也串行：同一次搜索连着点两下没有意义，串行还能避免同名的两次安装撞在一起。 */
  let queue = Promise.resolve()

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SKILL_CATALOG_PATH,
    handler: async (req, res) => {
      if (!guardWrite(ctx, req, res)) return

      let request
      try {
        const body = JSON.parse(await readBody(req))
        request = {
          op: String(body?.op ?? ''),
          catalog: body?.catalog === 'clawhub' ? 'clawhub' : 'skillsh',
          q: String(body?.q ?? ''),
          cursor: String(body?.cursor ?? ''),
          limit: Number(body?.limit ?? 0),
          source: String(body?.source ?? ''),
          skillId: String(body?.skillId ?? ''),
          owner: String(body?.owner ?? ''),
          slug: String(body?.slug ?? ''),
          name: String(body?.name ?? ''),
          scope: body?.scope === 'project' ? 'project' : 'global',
          destId: body?.destId === 'agents' ? 'agents' : 'dsh',
          project: String(body?.project ?? ''),
        }
      } catch (error) {
        sendJson(res, 400, { ok: false, reason: String(error?.message ?? error) })
        return
      }

      const run = queue.then(async () => {
        try {
          sendJson(res, 200, await apply(request))
        } catch (error) {
          ctx.logger.warn('dsh-skills-mcp-manager: catalog command failed: %s', String(error?.message ?? error))
          sendJson(res, 200, { ok: false, reason: String(error?.message ?? error) })
        }
      })
      queue = run.catch(() => {})
      await run
    },
  }))
}
