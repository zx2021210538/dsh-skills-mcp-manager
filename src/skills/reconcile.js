/**
 * DSH skills on disk: the panel mirrors `config.skills[]` into the root each entry
 * names — `<dshHome>/skills` or `<agentsHome>/skills` for a global skill, and the
 * matching `.dsh/skills` or `.agents/skills` under the project root for a project
 * one — and removes directories that are no longer configured.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { dshHome } from '../runtime/env.js'
import { NAME, LEGACY_NAME } from '../identity.js'

const stateFile = () => join(dshHome(), `${NAME}.state.json`)

/** Nearest ancestor holding `.git` — the same project-root rule as the skill provider. */
export function projectRootOf(dir) {
  let current = resolve(dir)
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(dir)
    current = parent
  }
}

/** `~/.agents`, honoured overridable the same way DSH does it. */
export function agentsHome() {
  return process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents')
}

/**
 * The skills directory one entry writes into.
 *
 * `id` selects **which** of the two roots under a scope: `dsh` or `agents`. It defaults to
 * `dsh`, which is what every entry written before this option existed means.
 *
 * This parameter is not cosmetic. The panel offers all four roots, and DSH's provider reads
 * all four, so an entry recorded without its root would be *moved* by the next reconcile:
 * the file the user just wrote to `~/.agents/skills` would be deleted and rewritten under
 * `~/.dsh/skills` (or vice versa), with no error anywhere.
 */
export function scopeRoot(scope, id = 'dsh') {
  const useAgents = id === 'agents'
  if (scope === 'global' || scope === '' || scope === undefined) {
    return join(useAgents ? agentsHome() : dshHome(), 'skills')
  }
  return join(projectRootOf(scope), useAgents ? '.agents' : '.dsh', 'skills')
}

/** Frontmatter plus body, exactly what the filesystem skill provider parses. */
export function renderSkill(skill) {
  const description = skill.description || skill.name
  return `---\nname: ${skill.name}\ndescription: ${description}\n---\n\n${(skill.body || '').trim()}\n`
}

export async function readState() {
  try {
    let text
    try {
      text = await readFile(stateFile(), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      text = await readFile(join(dshHome(), `${LEGACY_NAME}.state.json`), 'utf8')
      // Validate before importing; never overwrite a state another instance created.
      JSON.parse(text)
      try {
        await writeFile(stateFile(), text, { flag: 'wx' })
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        text = await readFile(stateFile(), 'utf8')
      }
    }
    return JSON.parse(text)
  } catch (error) {
    // "State file missing" and "state file unreadable" must not look identical.
    if (process.env.SMP_DEBUG) console.error('[dsh-skills-mcp-manager] skill state unreadable', error)
    return { files: [] }
  }
}

/**
 * 旧的「按状态文件对账磁盘 → 删除多余目录」逻辑已经删除（0.5.32）。
 *
 * 它从未被调用，却会对状态文件里出现的**任意 dirname** 递归删除目录 —— 一个永远不会被
 * 触发的函数，带着一个一旦误用就会删用户文件的实现。留着只有风险，没有收益。
 */

