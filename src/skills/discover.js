/**
 * Discover skills already on disk.
 *
 * The panel writes its own entries into `config.skills[]`, but DSH's filesystem
 * provider also reads skills placed by other tools. This module scans the same
 * roots (same names and same precedence) so the panel can list them too.
 *
 * Roots, in DSH's order (first wins for a duplicate name):
 *   project-dsh    <projectRoot>/.dsh/skills
 *   project-agents <projectRoot>/.agents/skills
 *   user-dsh       <dshHome>/skills
 *   user-agents    <agentsHome>/skills
 *
 * A root contains either directory bundles (`<name>/SKILL.md`) or flat files
 * (`<name>.md`), matching what the DSH provider accepts.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/**
 * 一条技能文件的**真实路径**（解析掉 Junction / symlink / 路径别名）。
 *
 * 用途只有一个：同一个真实文件经两个来源出现时（典型是 `~/.agents/skills` 是
 * `~/.claude/skills` 的 Windows Junction），模型侧只能算**一个**技能 —— 否则「停用一个
 * 重复来源」会按名字把另一份启用的一起压掉（issue #4）。
 *
 * 读不到真实路径时退回原始路径：宁可当成两个技能（老行为），也不能让扫描失败。
 */
function safeRealPath(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** The scan roots for one or more project roots plus the user-level roots. */
export function skillRootsFor({ projectRoots = [], dshHome = '', agentsHome = '' }) {
  const roots = []
  for (const projectRoot of projectRoots) {
    if (projectRoot === '') continue
    roots.push({ path: join(projectRoot, '.dsh/skills'), source: 'project-dsh', scope: projectRoot })
    roots.push({ path: join(projectRoot, '.agents/skills'), source: 'project-agents', scope: projectRoot })
  }
  if (dshHome !== '') roots.push({ path: join(dshHome, 'skills'), source: 'user-dsh', scope: 'global' })
  if (agentsHome !== '') roots.push({ path: join(agentsHome, 'skills'), source: 'user-agents', scope: 'global' })
  return roots
}

/** `name`/`description` from a SKILL.md frontmatter block (best effort). */
export function parseFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(markdown ?? ''))
  if (match === null) return {}
  try {
    const parsed = parseYaml(match[1])
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Bytes of SKILL.md body returned on demand for the preview dialog.
 *
 * Keep this small: the body travels through the settings document, which is a
 * single file DSH rewrites in full — one long preview used to inflate it to 40KB+
 * and every later write got slower. 4KB covers essentially all real skills.
 */
const BODY_LIMIT = 4000

/**
 * The markdown body without the frontmatter block, capped for the projection.
 *
 * This is the **exact inverse of `renderSkillMarkdown`**, which writes
 * `---\n<front>\n---\n\n<body>` and strips leading newlines from the body. So the blank line
 * between the closing `---` and the text is **formatting, not content**, and reading it back as
 * part of the body made the editor open with an empty first line (「正文多了一行，然后才到正文」);
 * saving then persisted that blank line, so the file grew on every round-trip.
 *
 * Consuming exactly that separator is what makes read the inverse of write, and it is why this
 * cannot simply use `\s*` — that also eats a body's leading **indentation**, which the writer
 * preserves (a body starting with an indented block is legitimate, e.g. inside a code fence).
 */
export function bodyOf(markdown) {
  // Trailing spaces on the `---` line are tolerated; the two separator newlines are consumed;
  // anything after that is content, indentation included.
  const text = String(markdown ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n(?:\r?\n)?/, '')
  if (text.length <= BODY_LIMIT) return text
  return `${text.slice(0, BODY_LIMIT)}\n\n…（已截断，完整内容见文件）`
}

/** Read one directory bundle or flat markdown file into a skill record. */
async function readSkillFile(file, name, base, realPath = '') {
  const text = await readFile(file, 'utf8')
  const meta = parseFrontmatter(text)
  return {
    name: typeof meta.name === 'string' && meta.name !== '' ? meta.name : name,
    description: typeof meta.description === 'string' ? meta.description : '',
    path: file,
    // 只在「根是别名」时才带，且与自身不同才留：普通行省掉这份重复的长字符串。
    realPath: realPath !== '' && realPath !== file ? realPath : '',
    source: base.source,
    scope: base.scope,
  }
}

/** Scan one root; a missing root simply yields nothing. */
export async function scanSkillRoot(root) {
  let entries = []
  try {
    entries = await readdir(root.path, { withFileTypes: true })
  } catch {
    return []
  }
  /**
   * 真实根**只解析一次**。
   *
   * 条目级的 Junction / symlink 不会走到这里（`readdir` 对它们报 `isSymbolicLink`，
   * 既不是 `isDirectory` 也不是 `isFile`，与 DSH 原生 provider 以外的历史行为一致），
   * 所以「真实根 + 条目名」与逐文件 `realpath` 对能被扫到的行等价；而逐文件解析是**同步**
   * 调用，100 个技能每次扫描多阻塞约 20ms，被 1 秒 TTL 的快照放大成可感知的卡顿。
   */
  const realRoot = safeRealPath(root.path)
  const aliased = realRoot !== '' && realRoot !== root.path
  const found = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      const file = join(root.path, entry.name, 'SKILL.md')
      const realPath = aliased ? join(realRoot, entry.name, 'SKILL.md') : ''
      try {
        found.push(await readSkillFile(file, entry.name, root, realPath))
      } catch {
        // a directory without SKILL.md is not a skill
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const file = join(root.path, entry.name)
      const realPath = aliased ? join(realRoot, entry.name) : ''
      try {
        found.push(await readSkillFile(file, entry.name.replace(/\.md$/, ''), root, realPath))
      } catch {
        // unreadable file: skip
      }
    }
  }
  return found
}

/** Scan every root; duplicates keep the first (more specific) one. */
export async function discoverSkills(options) {
  const seen = new Set()
  const out = []
  for (const root of skillRootsFor(options)) {
    for (const skill of await scanSkillRoot(root)) {
      const key = `${skill.scope}\u0000${skill.name}`
      if (seen.has(key)) continue
      seen.add(key)
      /**
       * 这份列表只给面板的「磁盘上有哪些技能」用（`/runtime.skills`），客户端只读
       * `name` / `scope` / `path`。`realPath` 只在治理侧（`governedSkills`）有意义，
       * 不跟着进 `/runtime`：否则每个技能都会多带一份路径。
       */
      const published = { ...skill }
      delete published.realPath
      out.push(published)
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
