/**
 * 技能治理写路由：`POST /<name>/skills-governance`。
 *
 * 它只改**策略**（谁可调用），不碰任何用户文件——这是它和 `/skills` 的本质区别：
 * `/skills` 会创建/改名/删除 `SKILL.md`，这里只写本插件自己的 `state.json`。
 *
 * 与 `/skills` 一样走 HTTP 而不是 settings 文档：settings 文档每次写入都会让设置壳层
 * 重挂载 section（这个代价在 0.5.8 里刚被踩过），而这里是「点一下开关」级别的交互，
 * 必须立刻、且不能刷新页面。
 */
import { NAME } from '../identity.js'
import { guardWrite, readBody, sendJson } from './http.js'

export const GOVERNANCE_PATH = `/${NAME}/skills-governance`

/**
 * Register the governance route.
 *
 * `apply` is injected so this module stays free of disk IO and a test can drive the whole
 * request/response cycle (same seam as `/skills`).
 */
export function registerGovernanceRoute(ctx, { apply }) {
  /** One write at a time, in arrival order: two toggles must not read-modify-write the same state. */
  let queue = Promise.resolve()

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: GOVERNANCE_PATH,
    handler: async (req, res) => {
      if (!guardWrite(ctx, req, res)) return

      let request
      try {
        const body = JSON.parse(await readBody(req))
        request = {
          op: String(body?.op ?? ''),
          // 技能用文件路径标识（它唯一，且改名/移动后旧记录自然失效）；来源/分类用名字。
          path: String(body?.path ?? ''),
          source: String(body?.source ?? ''),
          name: String(body?.name ?? ''),
          from: String(body?.from ?? ''),
          to: String(body?.to ?? ''),
          category: String(body?.category ?? ''),
          // 回收站记录 id（恢复/彻底删除用它定位，不用客户端再给一次路径）
          id: String(body?.id ?? ''),
          // 仓库地址（添加时由用户粘贴，Host 侧负责解析与校验）
          url: String(body?.url ?? ''),
          // 仓库安装：技能名、目标位置（与「添加技能」同一套 scope/destId/project）
          skill: String(body?.skill ?? ''),
          scope: body?.scope === 'project' ? 'project' : 'global',
          destId: body?.destId === 'agents' ? 'agents' : 'dsh',
          project: String(body?.project ?? ''),
          enabled: body?.enabled !== false,
        }
      } catch (error) {
        sendJson(res, 400, { ok: false, reason: String(error?.message ?? error) })
        return
      }

      const run = queue.then(async () => {
        try {
          sendJson(res, 200, await apply(request))
        } catch (error) {
          ctx.logger.warn('dsh-skills-mcp-manager: skill governance failed: %s', String(error?.message ?? error))
          // 200 + `{ok:false}`：面板按回执展示原因，而不是把它当成网络故障。
          sendJson(res, 200, { ok: false, reason: String(error?.message ?? error) })
        }
      })
      queue = run.catch(() => {})
      await run
    },
  }))
}
