/**
 * 本插件自己的技能治理状态（与 profile 的 `cordis.patch.yml` **分开**）。
 *
 * ## 为什么不写进 profile
 *
 * profile 是「Loader 要加载什么」，属于用户的配置文件；而「某个技能被管理面板停用了」
 * 是这一层 UI 的策略状态，两者生命周期与备份语义都不同。把策略混进 profile 会让用户的
 * `git diff` 出现一堆与自己无关的开关，也会让 DSH 的 profile 备份变脏。
 *
 * 所以状态落在 `$DSH_HOME/dsh-skills-mcp-manager/state.json`，形状刻意保持扁平、可读、
 * 可手改：
 *
 * ```json
 * {
 *   "version": 1,
 *   "sources": { "claude": { "enabled": false } },
 *   "skills":  { "user-dsh\u0000global\u0000my-skill": { "enabled": false } },
 *   "categories": {},
 *   "trash": []
 * }
 * ```
 *
 * 写入走「同目录临时文件 + rename」：rename 在同一文件系统上是原子的，中途崩溃不会留下
 * 半个 JSON（这个文件坏了会让整个面板的技能页读不出来）。
 */
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 本插件在 `$DSH_HOME` 下的私有目录名。 */
export const MANAGER_DIR = 'dsh-skills-mcp-manager'

/** `$DSH_HOME/dsh-skills-mcp-manager` */
export function managerHomePath(dshHome) {
  return join(String(dshHome ?? ''), MANAGER_DIR)
}

/** `$DSH_HOME/dsh-skills-mcp-manager/state.json` */
export function managerStatePath(dshHome) {
  return join(managerHomePath(dshHome), 'state.json')
}

/** A fresh state document. */
export function emptyManagerState() {
  return { version: 1, sources: {}, skills: {}, categories: {}, trash: [], repositories: [], installs: [] }
}

/** Coerce whatever was on disk into the shape the rest of the module expects. */
function normalizeState(raw) {
  const state = emptyManagerState()
  if (raw === null || typeof raw !== 'object') return state
  if (raw.sources !== null && typeof raw.sources === 'object' && !Array.isArray(raw.sources)) state.sources = raw.sources
  if (raw.skills !== null && typeof raw.skills === 'object' && !Array.isArray(raw.skills)) state.skills = raw.skills
  if (raw.categories !== null && typeof raw.categories === 'object' && !Array.isArray(raw.categories)) state.categories = raw.categories
  if (raw.trash !== null && Array.isArray(raw.trash)) state.trash = raw.trash
  if (Array.isArray(raw.repositories)) state.repositories = raw.repositories
  if (Array.isArray(raw.installs)) state.installs = raw.installs
  return state
}

/**
 * Read the state document.
 *
 * A missing file is the normal first-run case and yields the empty state. A **corrupt** file
 * is copied aside and then yields the empty state: the panel must still render, and policy
 * flags are recoverable (the skills themselves were never touched) — but the copy means the
 * user can still hand-recover what was in there.
 *
 * **A file that cannot be read at all is not "empty state"**: it throws. Treating EBUSY /
 * EACCES as "no state" used to be silent data loss — the very next write (one switch click,
 * one delete) would persist the empty state over the real file, taking the trash, install
 * records, repositories and categories with it.
 */
export async function readManagerState(dshHome) {
  const path = managerStatePath(dshHome)
  let text = ''
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyManagerState()
    throw error
  }
  try {
    return normalizeState(JSON.parse(text))
  } catch {
    try {
      await copyFile(path, `${path}.corrupt-${Date.now()}`)
    } catch {
      // A failed copy must not mask the parse problem: the caller still gets the empty state.
    }
    return emptyManagerState()
  }
}

/**
 * Write the state document atomically.
 *
 * Temporary file in the **same directory** so `rename` stays a same-volume operation.
 */
export async function writeManagerState(dshHome, state) {
  const path = managerStatePath(dshHome)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temporary, `${JSON.stringify(normalizeState(state), null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

/** The key one skill's policy is stored under (`source` + `scope` + `name`). */
export function skillPolicyKey(entry) {
  return [String(entry?.source ?? ''), String(entry?.scope ?? ''), String(entry?.name ?? '')].join('\u0000')
}

/** Whether a source is enabled (absent = enabled; a source is opt-out, not opt-in). */
export function sourceEnabled(state, key) {
  const sources = state?.sources ?? {}
  const entry = sources[key]
  if (entry !== undefined) return entry.enabled !== false
  /**
   * 回退到结构 key：`project-dsh@/p/one` 找不到时再看 `project-dsh`。
   *
   * 旧版本的状态文件只记结构 key（那时所有工作区共用一条），用户的"停用"意图应该继续
   * 生效，而不是升级后突然全部恢复启用。
   */
  const base = String(key).includes('@') ? String(key).slice(0, String(key).indexOf('@')) : ''
  if (base !== '') {
    const inherited = sources[base]
    if (inherited !== undefined) return inherited.enabled !== false
  }
  return true
}

/** Whether one skill is enabled, before the source-level switch is applied. */
export function skillEnabled(state, entry) {
  const record = state?.skills?.[skillPolicyKey(entry)]
  return record === undefined ? true : record.enabled !== false
}

/**
 * The effective flag: a skill is only live when **its source, its category and its own switch**
 * are all on.
 *
 * Source off wins over skill on — that is what "停用这个来源" means, and it keeps a
 * per-skill override from resurrecting a source the user just turned off wholesale. Same for a
 * category: 「停用这一组」 must not be undone by individual skills inside it.
 */
export function effectiveEnabled(state, sourceKey, entry) {
  if (!sourceEnabled(state, sourceKey)) return false
  /**
   * 分类**不参与**启用判定（0.5.45 起）。
   *
   * 设计评审第 2 条：三层 opt-out（来源 ∧ 分类 ∧ 技能）叠加，用户算不出"到底生效没生效"。
   * 分类降级为纯分组标签，启用 = 来源 ∧ 技能。状态文件里的历史 `categories[].enabled`
   * 保留不删（回滚时不至于丢数据），但不再参与判断。
   */
  return skillEnabled(state, entry)
}

/** Set (or clear, when `enabled` is true) a skill override. Returns the same document. */
export function setSkillEnabled(state, entry, enabled) {
  const key = skillPolicyKey(entry)
  if (enabled === true) delete state.skills[key]
  else state.skills[key] = { enabled: false }
  return state
}

/** Set (or clear) a source override. */
export function setSourceEnabled(state, key, enabled) {
  if (enabled === true) delete state.sources[key]
  else state.sources[key] = { enabled: false }
  return state
}

// ── 分类 ────────────────────────────────────────────────────────────────────────────
//
// 分类**只存在状态文件里**，不改磁盘上的任何位置 —— 这是刻意的：按目录挪文件会让
// DSH 的原生发现、以及用户自己的 git 记录一起变形，而分类是纯管理视图。

/** 分类名上限（够长，但仍能在一行里显示）。 */
export const CATEGORY_NAME_LIMIT = 40

/** Normalize/validate a category name. Returns '' when the name is unusable. */
export function normalizeCategoryName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (name === '' || name.length > CATEGORY_NAME_LIMIT) return ''
  // 控制字符会把标签渲染成乱码，且几乎必然是粘贴事故
  if (/[\u0000-\u001f\u007f]/.test(name)) return ''
  return name
}

/** The category a skill belongs to (`''` = uncategorized). At most one, by construction. */
export function categoryOf(state, entry) {
  const key = skillPolicyKey(entry)
  for (const [name, record] of Object.entries(state?.categories ?? {})) {
    if (Array.isArray(record?.skills) && record.skills.includes(key)) return name
  }
  return ''
}

/** Whether a category is enabled (absent = enabled). */
export function categoryEnabled(state, name) {
  const record = state?.categories?.[name]
  return record === undefined ? true : record.enabled !== false
}

/** `[{ name, enabled, count }]`, sorted by name. */
export function categoryList(state) {
  return Object.entries(state?.categories ?? {})
    .map(([name, record]) => ({
      name,
      enabled: record?.enabled !== false,
      count: Array.isArray(record?.skills) ? record.skills.length : 0,
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** Create a category. Returns `false` when the name is invalid or already taken. */
export function createCategory(state, rawName) {
  const name = normalizeCategoryName(rawName)
  if (name === '') return false
  if (state.categories[name] !== undefined) return false
  state.categories[name] = { enabled: true, skills: [] }
  return true
}

/** Rename a category, keeping its members and its enabled flag. */
export function renameCategory(state, rawFrom, rawTo) {
  const from = normalizeCategoryName(rawFrom)
  const to = normalizeCategoryName(rawTo)
  if (from === '' || to === '' || from === to) return false
  const record = state.categories[from]
  if (record === undefined || state.categories[to] !== undefined) return false
  state.categories[to] = record
  delete state.categories[from]
  return true
}

/** Delete a category. Its skills become uncategorized (the skills themselves are untouched). */
export function deleteCategory(state, rawName) {
  const name = normalizeCategoryName(rawName)
  if (name === '' || state.categories[name] === undefined) return false
  delete state.categories[name]
  return true
}

/**
 * Move one skill into `rawName` (or out of any category when it is empty).
 *
 * One category per skill: the assignment first removes the key from every category, so a
 * skill can never appear in two places at once (that would make "which switch governs it"
 * ambiguous).
 */
export function assignCategory(state, entry, rawName) {
  const key = skillPolicyKey(entry)
  for (const record of Object.values(state.categories ?? {})) {
    if (!Array.isArray(record?.skills)) continue
    const at = record.skills.indexOf(key)
    if (at >= 0) record.skills.splice(at, 1)
  }
  if (String(rawName ?? '') === '') return true
  const name = normalizeCategoryName(rawName)
  if (name === '' || state.categories[name] === undefined) return false
  state.categories[name].skills.push(key)
  return true
}

/** Enable/disable a whole category. */
export function setCategoryEnabled(state, rawName, enabled) {
  const name = normalizeCategoryName(rawName)
  const record = state.categories[name]
  if (record === undefined) return false
  if (enabled === true) delete record.enabled
  else record.enabled = false
  return true
}
