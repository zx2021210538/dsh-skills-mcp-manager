/**
 * 仓库技能的生命周期：安装 → 检查/预览更新 → 更新（带备份）→ 回滚 → 卸载。
 *
 * ## 这一层为什么单独放
 *
 * `repositories.js` 只读远端、只写本插件自己的缓存目录；本模块**会写用户的技能目录**，
 * 安全边界完全不同：目标必须落在已知可写根内、绝不覆盖已存在的技能、更新前必须先备份。
 * 混在一起写，迟早会出现「一个读操作顺手写了盘」。
 *
 * ## 内容签名是这套机制的基石
 *
 * zip 里没有 commit SHA（见 `repositories.js`），所以「本地这份是不是远端那份」用
 * `skillSignature`（路径 + 大小 + 内容哈希）判断。安装时把签名记进 install 记录，之后：
 *
 *   · 盘上签名 ≠ 记录签名  → 用户手工改过（**本地修改**，更新时要保护）
 *   · 盘上签名 = 记录签名，但 ≠ 仓库签名 → 远端有新版（**可更新**）
 *   · 三者一致 → 已是最新
 *
 * 这样「远端变了」和「本地被人改过」是两个可区分的事实，而不是一个含糊的「有更新」。
 */
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { unzipSync } from 'fflate'
import { assertZipWithinLimit } from './zipLimit.js'
import { readCachedArchive, skillSignature } from './repositories.js'
import { managerHomePath } from './state.js'
import { validateSkillName, writableRoots } from './write.js'
import { isInsideRoot } from './trash.js'

/** `$DSH_HOME/dsh-skills-mcp-manager/backups` */
export function backupRootPath(dshHome) {
  return join(managerHomePath(dshHome), 'backups')
}

/** 一条 install 记录的稳定 id（同时用作备份目录名，所以必须路径安全）。 */
export function installIdFor({ scope, destId, project, name }) {
  const projectKey = scope === 'project' ? createHash('sha1').update(String(project ?? '')).digest('hex').slice(0, 8) : ''
  return ['repo', scope, destId, projectKey, name].filter((part) => part !== '').join('-')
}

/** 把面板传的 `{ scope, destId, project }` 解析成一个真实可写目录。 */
export function resolveDestination({ dshHome = '', agentsHome = '', destination = {} }) {
  const scope = destination?.scope === 'project' ? 'project' : 'global'
  const destId = destination?.destId === 'agents' ? 'agents' : 'dsh'
  const projectRoot = scope === 'project' ? String(destination?.project ?? '').trim() : ''
  if (scope === 'project' && projectRoot === '') return { ok: false, reason: '选了项目级就必须指定工作区' }
  const roots = writableRoots({ dshHome, agentsHome, projectRoot })
  const root = roots.find((item) => item.scope === scope && item.id === destId)
  if (root === undefined) return { ok: false, reason: '这个目标位置不可写' }
  return { ok: true, root, project: projectRoot }
}

/** 递归列出目录里的文件（相对路径，排序）。 */
async function listFiles(dir, base = dir, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await listFiles(full, base, out)
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

/** 一个已安装目录的内容签名（与仓库侧的 `skillSignature` 同一算法，可直接比较）。 */
export async function installedSignature(dir) {
  const files = []
  for (const path of await listFiles(dir)) {
    const bytes = new Uint8Array(await readFile(join(dir, path)))
    files.push({ path, size: bytes.byteLength, hash: createHash('sha256').update(bytes).digest('hex') })
  }
  return { signature: skillSignature(files), files }
}

/** 从缓存压缩包里取出某个技能的文件（`{ 'rel/path': bytes }`）。 */
export function skillFilesFromArchive(bytes, dirInRepo) {
  // 缓存里的 zip 只在**扫描时**校验过一次；这里每次安装/更新/预览都会重新解压，所以闸门
  // 必须再走一遍（缓存文件也可能被替换或损坏）。
  assertZipWithinLimit(bytes)
  const entries = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  const prefix = `${String(dirInRepo).replace(/\/+$/, '')}/`
  const files = new Map()
  for (const [path, content] of Object.entries(entries)) {
    if (path.endsWith('/')) continue
    if (!path.startsWith(prefix)) continue
    files.set(path.slice(prefix.length), content)
  }
  return files
}

/** 把一组文件写进目标目录（调用方保证目标此前不存在）。 */
export async function writeSkillFiles(target, files) {
  for (const [relativePath, content] of files) {
    const full = join(target, ...relativePath.split('/'))
    // 防御：压缩包里的 `../` 之类不能逃出目标目录
    if (!resolve(full).startsWith(resolve(target) + sep)) throw new Error(`压缩包里有越界路径：${relativePath}`)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content)
  }
}

/**
 * Install one skill from a repository into a writable root.
 *
 * Refuses when the target already exists: 「同名不覆盖」是上游的行为，也是一个正确的默认 ——
 * 覆盖等于把用户可能改过的本地副本直接抹掉，而这类损失很难被察觉。
 */
export async function installSkill({ dshHome, agentsHome = '', repo, skill, destination }) {
  const name = validateSkillName(skill?.name)
  if (name.ok !== true) return { ok: false, reason: name.reason }
  const resolved = resolveDestination({ dshHome, agentsHome, destination })
  if (resolved.ok !== true) return resolved

  const target = join(resolved.root.dir, name.value)
  try {
    await stat(target)
    return { ok: false, reason: '目标位置已经有同名技能，未覆盖（可先卸载或换个位置）' }
  } catch {
    // 不存在 = 可以装
  }

  const archive = await readCachedArchive(dshHome, repo.id)
  if (archive === null) return { ok: false, reason: '仓库缓存不见了，请先「刷新」这个仓库' }

  const files = skillFilesFromArchive(archive, skill.dir)
  if (files.size === 0) return { ok: false, reason: '压缩包里找不到这个技能的文件，请刷新仓库' }

  await mkdir(target, { recursive: true })
  try {
    await writeSkillFiles(target, files)
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(() => {})
    return { ok: false, reason: `写入失败：${String(error?.message ?? error)}` }
  }

  const installed = await installedSignature(target)
  return {
    ok: true,
    install: {
      id: installIdFor({ scope: resolved.root.scope, destId: resolved.root.id, project: resolved.project, name: name.value }),
      repoId: String(repo.id ?? ''),
      skill: String(skill.name),
      name: name.value,
      dir: target,
      scope: resolved.root.scope,
      destId: resolved.root.id,
      project: resolved.project,
      installedAt: new Date().toISOString(),
      // 装完那一刻的实际内容签名：之后它是「本地有没有被改过」的基准
      installedSignature: installed.signature,
    },
  }
}

/**
 * Compare one install against the repository's current archive.
 *
 * @returns `{ status, additions, removals, changes }` where status is one of
 *   `missing` / `locally-modified` / `update-available` / `up-to-date`.
 */
export async function previewInstall({ dshHome, install, repo, skill }) {
  const dir = String(install?.dir ?? '')
  const onDisk = await installedSignature(dir)
  if (onDisk.files.length === 0) return { status: 'missing', additions: [], removals: [], changes: [] }

  const archive = await readCachedArchive(dshHome, String(repo?.id ?? install?.repoId ?? ''))
  if (archive === null) return { status: 'missing', additions: [], removals: [], changes: [], reason: '仓库缓存不见了，请先刷新' }
  const wanted = skillFilesFromArchive(archive, skill?.dir)
  if (wanted.size === 0) return { status: 'missing', additions: [], removals: [], changes: [], reason: '压缩包里找不到这个技能' }

  const wantedIndex = new Map()
  for (const [path, content] of wanted) {
    wantedIndex.set(path, {
      size: content.byteLength,
      hash: createHash('sha256').update(content).digest('hex'),
    })
  }
  const haveIndex = new Map(onDisk.files.map((file) => [file.path, file]))

  const additions = [...wantedIndex.keys()].filter((path) => !haveIndex.has(path)).sort()
  const removals = [...haveIndex.keys()].filter((path) => !wantedIndex.has(path)).sort()
  const changes = [...wantedIndex.keys()]
    .filter((path) => haveIndex.has(path) && haveIndex.get(path).hash !== wantedIndex.get(path).hash)
    .sort()

  const sameAsRepo = additions.length === 0 && removals.length === 0 && changes.length === 0
  const localEdited = onDisk.signature !== String(install?.installedSignature ?? onDisk.signature)

  // 「本地被改过」优先报出来：它和「远端有新版」都需要更新，但前者意味着直接覆盖会丢东西，
  // 面板必须先提醒。两个事实都能从 diff 里看到，这里只是给一个主状态。
  const status = localEdited
    ? 'locally-modified'
    : (sameAsRepo ? 'up-to-date' : 'update-available')
  return { status, additions, removals, changes }
}

/** 备份一个目录到 `backups/<installId>/<时间戳>`，返回备份路径。 */
export async function backupInstalled({ dshHome, install }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(backupRootPath(dshHome), String(install.id), stamp)
  await mkdir(dirname(target), { recursive: true })
  await cp(String(install.dir), target, { recursive: true })
  return target
}

/** 最近一次备份目录，没有则 null。 */
export async function latestBackup({ dshHome, install }) {
  const root = join(backupRootPath(dshHome), String(install.id))
  let names
  try {
    names = (await readdir(root)).sort()
  } catch {
    return null
  }
  const last = names[names.length - 1]
  return last === undefined ? null : join(root, last)
}

/**
 * Update an installed skill from the current archive.
 *
 * 顺序不可换：**先备份**再动磁盘。备份失败就中止 —— 一个「更新成功但没法回滚」的结果比
 * 更新失败更糟。
 */
export async function updateInstalled({ dshHome, agentsHome = '', install, skill }) {
  const archive = await readCachedArchive(dshHome, String(install?.repoId ?? ''))
  if (archive === null) return { ok: false, reason: '仓库缓存不见了，请先刷新这个仓库' }
  const files = skillFilesFromArchive(archive, skill?.dir)
  if (files.size === 0) return { ok: false, reason: '压缩包里找不到这个技能' }

  let backup
  try {
    backup = await backupInstalled({ dshHome, install })
  } catch (error) {
    return { ok: false, reason: `备份失败，已中止更新：${String(error?.message ?? error)}` }
  }

  const dir = String(install.dir)
  /**
   * `install.dir` 来自我们自己的 `state.json`，但那个文件是可以手改的（也是我们要求"可读可
   * 手改"的）：一个坏掉/被填错的值会让这里 `rm -rf` 掉任意目录。所以删除前必须确认它落在
   * 某一个**允许的写盘根**里 —— 与回收站路径用的是同一条判据（`isInsideRoot`）。
   */
  const allowedRoots = writableRoots({
    dshHome,
    // `install` 记录里**没有** agentsHome 字段（历史遗留），所以必须由调用方传进来：
    // 只从记录里取会让「安装位置 = Shared Agent」的全局安装永远被判"路径不在允许的根内"。
    agentsHome: String(agentsHome ?? ''),
    projectRoot: String(install.project ?? ''),
  }).map((root) => root.dir)
  if (!allowedRoots.some((root) => isInsideRoot(root, dir))) {
    return { ok: false, reason: `安装记录里的路径不在允许的根内，已拒绝删除：${dir}` }
  }
  try {
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    await writeSkillFiles(dir, files)
  } catch (error) {
    // 写坏了就把备份放回去，别留一个半截的技能目录
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    await cp(backup, dir, { recursive: true }).catch(() => {})
    return { ok: false, reason: `更新失败，已回滚到更新前：${String(error?.message ?? error)}` }
  }

  const installed = await installedSignature(dir)
  return {
    ok: true,
    backup,
    updatedAt: new Date().toISOString(),
    installedSignature: installed.signature,
  }
}

/** 恢复最近一次备份（把当前目录换回备份内容）。 */
export async function rollbackInstalled({ dshHome, agentsHome = '', install }) {
  const backup = await latestBackup({ dshHome, install })
  if (backup === null) return { ok: false, reason: '这个技能没有可回滚的备份' }
  const dir = String(install.dir)
  /**
   * `install.dir` 来自我们自己的 `state.json`，但那个文件是可以手改的（也是我们要求"可读可
   * 手改"的）：一个坏掉/被填错的值会让这里 `rm -rf` 掉任意目录。所以删除前必须确认它落在
   * 某一个**允许的写盘根**里 —— 与回收站路径用的是同一条判据（`isInsideRoot`）。
   */
  const allowedRoots = writableRoots({
    dshHome,
    // `install` 记录里**没有** agentsHome 字段（历史遗留），所以必须由调用方传进来：
    // 只从记录里取会让「安装位置 = Shared Agent」的全局安装永远被判"路径不在允许的根内"。
    agentsHome: String(agentsHome ?? ''),
    projectRoot: String(install.project ?? ''),
  }).map((root) => root.dir)
  if (!allowedRoots.some((root) => isInsideRoot(root, dir))) {
    return { ok: false, reason: `安装记录里的路径不在允许的根内，已拒绝删除：${dir}` }
  }
  try {
    await rm(dir, { recursive: true, force: true })
    await cp(backup, dir, { recursive: true })
  } catch (error) {
    return { ok: false, reason: `回滚失败：${String(error?.message ?? error)}` }
  }
  const installed = await installedSignature(dir)
  return { ok: true, installedSignature: installed.signature, backup }
}

/** 生成一条 install 记录的删除计划（文件本身由 `trash.js` 移走）。 */
export function installSkillEntry(install) {
  /**
   * `scope` 在**条目**语义里是"哪个工作区"，不是层级名。
   *
   * 安装记录里 `scope` 存的是层级（`'global'` / `'project'`），真正的工作区在 `project`。
   * 原来直接把层级名当 scope 传出去，回收站记录里就留下 `scope: 'project'`；恢复时按它算
   * 允许根得到相对路径 `project\.dsh\skills`，`isInsideRoot` 必然为假 —— 项目级安装的技能
   * 一旦卸载就**永远恢复不了**。
   */
  const global = String(install?.scope ?? 'global') === 'global'
  return {
    name: String(install?.name ?? ''),
    path: join(String(install?.dir ?? ''), 'SKILL.md'),
    source: install?.destId === 'agents' ? 'user-agents' : 'user-dsh',
    scope: global ? 'global' : String(install?.project ?? ''),
    readonly: false,
  }
}

/** 从状态里摘掉一条 install 记录。 */
export function dropInstall(state, id) {
  state.installs = (Array.isArray(state.installs) ? state.installs : [])
    .filter((install) => String(install?.id ?? '') !== String(id ?? ''))
  return state
}

/** 面板用的安装清单（不含备份路径等内部细节）。 */
export function installList(state) {
  return (Array.isArray(state.installs) ? state.installs : []).map((install) => {
    const dir = String(install?.dir ?? '')
    let missing = false
    try {
      /**
       * 记录指向的目录还在不在。
       *
       * 用户手删目录、面板改名、或把工作区从 profile 里移除之后，记录会变成**死角**：
       * 技能页没有对应卡片（因而没有「…」），仓库列表却说"已安装"并不给安装按钮 ——
       * 更新 / 回滚 / 卸载 / 重装全都没有入口。面板拿到这个标记才能把它显示成
       * 「记录失效」并给一个「清除记录」。
       */
      missing = dir === '' || !statSync(dir).isDirectory()
    } catch {
      missing = true
    }
    return {
      id: String(install?.id ?? ''),
      repoId: String(install?.repoId ?? ''),
      skill: String(install?.skill ?? ''),
      name: String(install?.name ?? ''),
      dir,
      scope: String(install?.scope ?? 'global'),
      destId: String(install?.destId ?? 'dsh'),
      project: String(install?.project ?? ''),
      installedAt: String(install?.installedAt ?? ''),
      missing,
    }
  })
}

/** 目录改名（回滚/更新失败时用不到，但卸载前确认目录存在时用得上）。 */
export async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 把整个目录原子地换成另一份（跨设备时退回复制）。 */
export async function replaceDir(from, to) {
  try {
    await rm(to, { recursive: true, force: true })
    await rename(from, to)
  } catch {
    await cp(from, to, { recursive: true })
    await rm(from, { recursive: true, force: true })
  }
}

