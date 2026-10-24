/**
 * 导入既有技能：一个 zip、一个目录、或一份 `SKILL.md` 正文。
 *
 * ## 三种输入，一个落点
 *
 * 三者最后都变成「在某个可写目标下建一个 `<name>/` 目录并写入文件」，所以真正的工作只有
 * 一份（{@link installFilesToDestination}），三者只负责把输入变成 `Map<相对路径, 字节>`。
 * 分开写三遍的话，「同名不覆盖」「路径越界」这类边界迟早只在一个分支里存在。
 *
 * ## 为什么 zip 走 base64 JSON，而不是 multipart
 *
 * 本插件的写路由统一 JSON + 三道守卫（来源 / POST / content-type）。multipart 要引入一个
 * 解析器、要处理边界字符串与临时文件，收益只是省掉 base64 的 33% 体积——而导入的技能包
 * 通常只有几十 KB。所以：**少一个解析器，就少一类注入面**。
 *
 * 体积仍然有明确上限（见 `MAX_ZIP_BYTES`），超过就拒绝，不静默截断。
 */
import { cp, mkdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { assertZipWithinLimit } from './zipLimit.js'
import { parseFrontmatter } from './discover.js'
import { resolveDestination, writeSkillFiles } from './repository-install.js'
import { renderSkillMarkdown, validateSkillName } from './write.js'

/** 导入包上限（解码后的字节数）。 */
export const MAX_ZIP_BYTES = 8 * 1024 * 1024

/** 单份 `SKILL.md` 上限。 */
export const MAX_MARKDOWN_BYTES = 256 * 1024

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** base64 → 字节，带长度上限与格式校验。 */
export function decodeBase64(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return { ok: false, reason: '没有收到文件内容' }
  // 允许 data URL（浏览器 FileReader 的常见输出形态）
  const payload = raw.includes(',') && raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw
  if (!/^[A-Za-z0-9+/=\s]+$/.test(payload)) return { ok: false, reason: '文件内容不是合法的 base64' }
  const bytes = new Uint8Array(Buffer.from(payload, 'base64'))
  if (bytes.byteLength === 0) return { ok: false, reason: '解出来的文件是空的' }
  if (bytes.byteLength > MAX_ZIP_BYTES) {
    return { ok: false, reason: `技能包太大（${Math.round(bytes.byteLength / 1024)} KB），上限 ${MAX_ZIP_BYTES / 1024 / 1024} MB` }
  }
  return { ok: true, bytes }
}

/** 名字：优先调用方给的，其次 frontmatter，最后目录名；必须 kebab-case。 */
function pickName({ override = '', markdown = '', fallback = '' }) {
  const meta = markdown === '' ? {} : parseFrontmatter(markdown)
  const candidates = [String(override ?? ''), String(meta?.name ?? ''), String(fallback ?? '')]
  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    if (trimmed === '') continue
    const valid = validateSkillName(trimmed)
    if (valid.ok !== true) continue
    if (KEBAB.test(trimmed)) return { ok: true, name: trimmed }
  }
  return {
    ok: false,
    reason: '无法确定技能名：请填写一个 kebab-case 名字（小写字母、数字、连字符）',
  }
}

/**
 * 从一个 zip 里取出「一个技能」。
 *
 * 只接受**恰好一个** `SKILL.md`：导入是一个技能一次的操作，一次塞多个只会让「装成了哪些」
 * 变得含糊。发现多个时明确报错并列出它们，让用户压小范围再传。
 */
export function skillFromZip(bytes) {
  let entries
  try {
        // 解压前先按 zip 中央目录声明的未压缩大小求和，超限直接拒绝（zip bomb）。
    assertZipWithinLimit(bytes)
    entries = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  } catch (error) {
    return { ok: false, reason: `压缩包无法解开：${String(error?.message ?? error)}` }
  }
  const paths = Object.keys(entries).filter((path) => !path.endsWith('/'))
  const markers = paths.filter((path) => /(^|\/)SKILL\.md$/i.test(path))
  if (markers.length === 0) return { ok: false, reason: '压缩包里没有 SKILL.md，无法识别为技能' }
  if (markers.length > 1) {
    return { ok: false, reason: `压缩包里有 ${markers.length} 个 SKILL.md，一次只能导入一个技能` }
  }

  const marker = markers[0]
  const base = marker.replace(/\/?SKILL\.md$/i, '')
  const prefix = base === '' ? '' : `${base}/`
  const files = new Map()
  for (const path of paths) {
    if (prefix !== '' && !path.startsWith(prefix)) continue
    files.set(prefix === '' ? path : path.slice(prefix.length), entries[path])
  }
  if (files.size === 0) return { ok: false, reason: '压缩包里这个技能没有文件' }

  const markdown = strFromU8(entries[marker] ?? new Uint8Array())
  return {
    ok: true,
    files,
    markdown,
    fallbackName: base === '' ? '' : (base.split('/').pop() ?? ''),
  }
}

/**
 * 把一组文件落到目标位置。三种导入共用这一份。
 *
 * @param options - `{ dshHome, agentsHome, destination, name, markdown, files }`
 * @returns `{ ok: true, name, dir, scope, destId, project }` 或 `{ ok: false, reason }`
 */
export async function installFilesToDestination({ dshHome, agentsHome = '', destination, name, markdown = '', files }) {
  const picked = pickName({ override: name, markdown, fallback: '' })
  if (picked.ok !== true) return picked
  const resolved = resolveDestination({ dshHome, agentsHome, destination })
  if (resolved.ok !== true) return resolved

  const target = join(resolved.root.dir, picked.name)
  try {
    await stat(target)
    return { ok: false, reason: '目标位置已经有同名技能，未覆盖' }
  } catch {
    // 不存在才能写
  }

  const content = files instanceof Map && files.size > 0 ? files : null
  await mkdir(target, { recursive: true })
  try {
    if (content !== null) await writeSkillFiles(target, content)
    else await writeSkillFiles(target, new Map([['SKILL.md', new Uint8Array(Buffer.from(String(markdown), 'utf8'))]]))
  } catch (error) {
    const { rm } = await import('node:fs/promises')
    await rm(target, { recursive: true, force: true }).catch(() => {})
    return { ok: false, reason: `写入失败：${String(error?.message ?? error)}` }
  }

  return {
    ok: true,
    name: picked.name,
    dir: target,
    scope: resolved.root.scope,
    destId: resolved.root.id,
    project: resolved.project,
  }
}

/** 导入一个 zip 包里的技能。 */
export async function importZip({ dshHome, agentsHome = '', base64, destination, name = '' }) {
  const decoded = decodeBase64(base64)
  if (decoded.ok !== true) return decoded
  const found = skillFromZip(decoded.bytes)
  if (found.ok !== true) return found
  return installFilesToDestination({
    dshHome, agentsHome, destination, name, markdown: found.markdown, files: found.files,
  })
}

/**
 * 导入一份 `SKILL.md` 正文。
 *
 * 正文缺 frontmatter 时补一份最小可用的（name + 空描述）—— 否则写进去的文件 DSH 不认，
 * 用户看到「导入成功」却在列表里找不到它，比导入失败更难查。
 */
export async function importMarkdown({ dshHome, agentsHome = '', markdown, destination, name = '' }) {
  const text = String(markdown ?? '')
  if (text.trim() === '') return { ok: false, reason: 'SKILL.md 内容为空' }
  if (Buffer.byteLength(text, 'utf8') > MAX_MARKDOWN_BYTES) return { ok: false, reason: 'SKILL.md 太大（超过 256 KB）' }

  const picked = pickName({ override: name, markdown: text })
  if (picked.ok !== true) return picked
  const meta = parseFrontmatter(text)
  const normalized = meta?.name === undefined
    ? renderSkillMarkdown({ name: picked.name, description: '', body: text })
    : text
  return installFilesToDestination({
    dshHome, agentsHome, destination, name: picked.name, markdown: normalized, files: null,
  })
}

/**
 * 导入磁盘上的一个技能目录（绝对路径）。
 *
 * 拒绝把目录复制进它自己（目标在工作区内时会发生），否则复制会无限递归。
 */
export async function importFolder({ dshHome, agentsHome = '', path, destination, name = '' }) {
  const source = resolve(String(path ?? '').trim())
  if (String(path ?? '').trim() === '') return { ok: false, reason: '请填写技能目录的绝对路径' }
  let info
  try {
    info = await stat(source)
  } catch {
    return { ok: false, reason: '这个路径不存在' }
  }
  if (info.isDirectory() !== true) return { ok: false, reason: '这个路径不是目录' }

  let markdown
  try {
    markdown = await readFile(join(source, 'SKILL.md'), 'utf8')
  } catch {
    return { ok: false, reason: '这个目录里没有 SKILL.md，无法识别为技能' }
  }
  const picked = pickName({ override: name, markdown, fallback: basename(source) })
  if (picked.ok !== true) return picked

  const resolved = resolveDestination({ dshHome, agentsHome, destination })
  if (resolved.ok !== true) return resolved
  const target = join(resolved.root.dir, picked.name)
  if (resolve(target) === source) return { ok: false, reason: '源目录就是目标目录，无需导入' }
  if (resolve(target).startsWith(source + sep)) return { ok: false, reason: '目标位置在源目录里面，不能这样导入' }
  try {
    await stat(target)
    return { ok: false, reason: '目标位置已经有同名技能，未覆盖' }
  } catch {
    // 不存在才能写
  }

  try {
    await cp(source, target, { recursive: true })
  } catch (error) {
    return { ok: false, reason: `复制失败：${String(error?.message ?? error)}` }
  }
  return {
    ok: true,
    name: picked.name,
    dir: target,
    scope: resolved.root.scope,
    destId: resolved.root.id,
    project: resolved.project,
  }
}
