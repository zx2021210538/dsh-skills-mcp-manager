/**
 * 写路由共用的 HTTP 守卫与编解码。
 *
 * 这些守卫是**安全边界**，不是样板：`/skills` 与 `/skills-governance` 都会改磁盘或改
 * 可调用性，规则必须一模一样。复制一份就会有第二份，第二份迟早与第一份漂移 ——
 * 那时一条路由比另一条松，而这种差异没人会注意到。所以只有这一份。
 *
 * 三条规则：
 *   · `connection.requestRejection` 先跑（它挡的是跨站来源）；
 *   · 只接受 POST —— GET 永远不该走到写路径；
 *   · 必须 `application/json` —— 跨站 HTML 表单发不出这个类型。
 */

/** 请求体上限。技能正文是文本，256 KB 已经很宽松。 */
export const MAX_BODY = 256 * 1024

/**
 * 导入路由的上限：base64 会把体积放大 4/3，而一个技能压缩包通常几十 KB。
 * 16 MB 足够容纳「含图片的技能包」，同时仍然是一个明确的拒绝线。
 */
export const MAX_IMPORT_BODY = 16 * 1024 * 1024

/** 读完请求体（超限直接 destroy，不把内存耗光）。 */
export function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

/** 统一的 JSON 响应（一律 no-store：响应里有刚落盘的路径与开关状态）。 */
export function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Apply the write-route guards.
 *
 * @returns `true` when the request may proceed; `false` when this function already answered.
 */
export function guardWrite(ctx, req, res) {
  const rejection = ctx.connection.requestRejection(req)
  if (rejection !== undefined) {
    res.statusCode = rejection
    res.end()
    return false
  }
  res.setHeader('cache-control', 'no-store')
  if (req.method !== 'POST') {
    res.statusCode = 405
    res.setHeader('allow', 'POST')
    res.end()
    return false
  }
  const type = String(req.headers?.['content-type'] ?? '')
  if (!type.includes('application/json')) {
    res.statusCode = 415
    res.end(JSON.stringify({ ok: false, reason: 'content-type must be application/json' }))
    return false
  }
  return true
}
