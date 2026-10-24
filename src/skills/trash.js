/**
 * 回收站：删除技能时先移进本插件自己的目录，可恢复、可彻底删除。
 *
 * ## 为什么不是 `unlink`
 *
 * 技能目录里可能有用户手写的内容（正文、脚本、附件），一次误点就没了是最差的失败方式。
 * 移进回收站是一个**可撤销**的操作，而「彻底删除」是用户显式点第二次才发生的事。
 *
 * ## 安全边界（三条）
 *
 * 1. 只对**可写来源**开放：`user-dsh` / `user-agents` / 项目两个根。外部 Agent 目录
 *    （Claude Code、Codex…）永远只读，它们的文件我们一个字节都不碰。
 * 2. 被移动的条目必须来自**当前扫描结果**（`index.js` 的 `skillAt` 校验路径确实在扫描
 *    结果里）。客户端只发一个路径，不做这层校验就等于把「删除任意文件」开成一个端点。
 * 3. 恢复时目标已存在就**拒绝**，绝不覆盖：那条路径上可能已经有用户新建的同名技能；
 *    彻底删除则只允许删回收站目录里面的东西（`state.json` 是用户可手改的文件）。
 *
 * 移动用 `rename`（同一文件系统内是原子的）；跨设备时退回「复制 → 删源」。
 */
import { cp, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { existsSync } from 'node:fs'

/** `$DSH_HOME/dsh-skills-mcp-manager/trash` */
export function trashRootPath(dshHome) {
  return join(String(dshHome ?? ''), 'dsh-skills-mcp-manager', 'trash')
}

/** `true` when `target` is inside `root` (both resolved; the root itself counts as outside). */
export function isInsideRoot(root, target) {
  if (root === '' || target === '') return false
  const left = resolve(root)
  const right = resolve(target)
  if (left === right) return false
  return right.startsWith(left.endsWith(sep) ? left : `${left}${sep}`)
}

/**
 * Move one skill into the trash.
 *
 * @param options - `{ dshHome, entry }` where `entry` is a governed skill
 *   (`{ name, path, source, scope, readonly }`).
 * @returns `{ ok: true, record }` or `{ ok: false, reason }`.
 */
export async function moveSkillToTrash({ dshHome, entry, allowedRoots = null }) {
  const name = String(entry?.name ?? '')
  const path = resolve(String(entry?.path ?? ''))
  if (name === '' || path === '') return { ok: false, reason: '缺少技能名称或路径' }
  if (entry?.readonly === true) return { ok: false, reason: '外部 Agent 目录只读，不能删除' }
  /**
   * 路径必须落在**允许的写盘根**里。
   *
   * 调用方（技能删除、仓库卸载）都可能把 `state.json` 里的路径原样传进来，而那个文件是允许
   * 用户手改的 —— 一个填错的值会让"删除"把任意目录整体移走。`trash.js` 的注释一直声称做了
   * 这项校验，实际没有；现在补上，并且**没有给 allowedRoots 时拒绝移动**（fail-closed）。
   */
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    return { ok: false, reason: '缺少允许的写盘根，拒绝移动（内部错误）' }
  }
  const itemCandidate = basename(path).toLowerCase() === 'skill.md' ? dirname(path) : path
  if (!allowedRoots.some((root) => isInsideRoot(String(root), itemCandidate))) {
    return { ok: false, reason: `路径不在允许的写盘根内，已拒绝移动：${itemCandidate}` }
  }

  // 一个技能的 path 是它的 SKILL.md 或 `<name>.md`；要移动的是**承载它的那一项**。
  const isBundle = basename(path).toLowerCase() === 'skill.md'
  const itemPath = isBundle ? dirname(path) : path
  if (!existsSync(itemPath)) return { ok: false, reason: '该技能已不在磁盘上' }

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const target = join(trashRootPath(dshHome), id)
  await mkdir(trashRootPath(dshHome), { recursive: true })
  try {
    await rename(itemPath, target)
  } catch (error) {
    if (error?.code !== 'EXDEV') return { ok: false, reason: `移动失败：${String(error?.message ?? error)}` }
    // 跨设备（例如 profile 与技能根不在同一个卷）：复制后再删源，失败就把半成品清掉。
    try {
      await cp(itemPath, target, { recursive: true })
      await rm(itemPath, { recursive: true, force: true })
    } catch (copyError) {
      await rm(target, { recursive: true, force: true }).catch(() => {})
      return { ok: false, reason: `移动失败：${String(copyError?.message ?? copyError)}` }
    }
  }

  return {
    ok: true,
    record: {
      id,
      name,
      source: String(entry?.source ?? ''),
      scope: String(entry?.scope ?? ''),
      // 记原路径，恢复时原样放回去
      path: itemPath,
      trashPath: target,
      deletedAt: new Date().toISOString(),
    },
  }
}

/**
 * Restore one trash record to its original path.
 *
 * Refuses when the original path is occupied — silently overwriting would destroy a skill the
 * user created after the delete.
 */
export async function restoreFromTrash({ record, allowedRoots = null }) {
  const target = resolve(String(record?.path ?? ''))
  const trashPath = resolve(String(record?.trashPath ?? ''))
  if (target === '' || trashPath === '') return { ok: false, reason: '回收站记录不完整' }
  /**
   * 恢复 = 往磁盘写文件，所以和移动/彻底删除一样要校验根。
   *
   * `record.path` 来自可手改的 `state.json`：不校验的话，改一个值再点「恢复」就等于
   * 在任意路径下建父目录 + 移动文件 —— 与 purge 的边界不对称。
   */
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    return { ok: false, reason: '缺少允许的写盘根，拒绝恢复（内部错误）' }
  }
  if (!allowedRoots.some((root) => isInsideRoot(String(root), target))) {
    return { ok: false, reason: `路径不在允许的写盘根内，已拒绝恢复：${target}` }
  }
  if (!existsSync(trashPath)) return { ok: false, reason: '回收站里的文件已经不在了' }
  if (existsSync(target)) return { ok: false, reason: '原位置已经有同名技能，未覆盖' }
  try {
    await mkdir(dirname(target), { recursive: true })
    await rename(trashPath, target)
    return { ok: true, reason: '' }
  } catch (error) {
    if (error?.code !== 'EXDEV') return { ok: false, reason: `恢复失败：${String(error?.message ?? error)}` }
    try {
      await cp(trashPath, target, { recursive: true })
      await rm(trashPath, { recursive: true, force: true })
      return { ok: true, reason: '' }
    } catch (copyError) {
      return { ok: false, reason: `恢复失败：${String(copyError?.message ?? copyError)}` }
    }
  }
}

/** Permanently delete one trash record's files. */
export async function purgeFromTrash({ dshHome, record }) {
  const trashPath = resolve(String(record?.trashPath ?? ''))
  if (trashPath === '') return { ok: false, reason: '回收站记录不完整' }
  // 只允许删回收站目录里面的东西：state.json 是用户可以手改的文件，不能拿它当
  // 「删除任意路径」的入口。这是本模块唯一的破坏性操作，边界必须由代码保证。
  if (!isInsideRoot(trashRootPath(dshHome), trashPath)) {
    return { ok: false, reason: '拒绝删除回收站目录之外的路径' }
  }
  try {
    await rm(trashPath, { recursive: true, force: true })
    return { ok: true, reason: '' }
  } catch (error) {
    return { ok: false, reason: `彻底删除失败：${String(error?.message ?? error)}` }
  }
}

/** 回收站目录里的实际条目数（诊断用：与记录数不一致说明有人手改过目录）。 */
export async function countTrashEntries(dshHome) {
  try {
    return (await readdir(trashRootPath(dshHome))).length
  } catch {
    return 0
  }
}

/** `[{ ...record, exists }]`，按删除时间倒序（最近删的排最前）。 */
export function trashList(state) {
  const records = Array.isArray(state?.trash) ? state.trash : []
  return records
    .map((record) => ({
      id: String(record?.id ?? ''),
      name: String(record?.name ?? ''),
      source: String(record?.source ?? ''),
      scope: String(record?.scope ?? ''),
      path: String(record?.path ?? ''),
      deletedAt: String(record?.deletedAt ?? ''),
      exists: existsSync(String(record?.trashPath ?? '')),
    }))
    .sort((left, right) => right.deletedAt.localeCompare(left.deletedAt))
}

/** 从状态里摘掉一条记录（恢复/彻底删除成功后）。 */
export function dropTrashRecord(state, id) {
  const records = Array.isArray(state?.trash) ? state.trash : []
  state.trash = records.filter((record) => String(record?.id ?? '') !== String(id ?? ''))
  return state
}

/** 供 UI 显示「删除到哪去了」时用的简短路径。 */
export function relativeTrashPath(dshHome, record) {
  const trashPath = String(record?.trashPath ?? '')
  if (trashPath === '') return ''
  return relative(trashRootPath(dshHome), trashPath)
}

/** 记录恢复前的最后校验：源文件还在不在（不存在时 UI 应禁用「恢复」）。 */
export async function trashRecordExists(record) {
  try {
    await lstat(String(record?.trashPath ?? ''))
    return true
  } catch {
    return false
  }
}
