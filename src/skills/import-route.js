/**
 * 技能导入写路由：`POST /<name>/skills-import`。
 *
 * 与 `/skills-governance` 分开而不是共用一个入口，只有一个原因：**请求体上限不同**。
 * 治理命令是几十字节的开关，256 KB 绰绰有余；导入要带一个 base64 的压缩包，需要更大的窗口。
 * 与其把治理路由的上限放大到 16 MB（那会让每一个开关请求都能带着 16 MB 进来），
 * 不如各自守自己的门。
 */
import { NAME } from '../identity.js'
import { guardWrite, MAX_IMPORT_BODY, readBody, sendJson } from './http.js'

export const SKILL_IMPORT_PATH = `/${NAME}/skills-import`

/**
 * Register the import route.
 *
 * `apply` is injected so this module stays free of disk IO and a test can drive the whole
 * request/response cycle.
 */
export function registerSkillImportRoute(ctx, { apply }) {
  /** 导入会写磁盘，串行执行：两次导入撞同一个名字时不该有中间态。 */
  let queue = Promise.resolve()

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SKILL_IMPORT_PATH,
    handler: async (req, res) => {
      if (!guardWrite(ctx, req, res)) return

      let request
      try {
        const body = JSON.parse(await readBody(req, MAX_IMPORT_BODY))
        request = {
          op: String(body?.op ?? ''),
          base64: String(body?.base64 ?? ''),
          markdown: String(body?.markdown ?? ''),
          path: String(body?.path ?? ''),
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
          ctx.logger.warn('dsh-skills-mcp-manager: skill import failed: %s', String(error?.message ?? error))
          sendJson(res, 200, { ok: false, reason: String(error?.message ?? error) })
        }
      })
      queue = run.catch(() => {})
      await run
    },
  }))
}
