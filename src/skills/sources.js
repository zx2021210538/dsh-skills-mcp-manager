/**
 * Every directory that can hold skills — native DSH roots plus third-party agent roots.
 *
 * ## 为什么需要这一层
 *
 * DSH 官方的 filesystem provider 只认识四个根（`user-dsh` / `user-agents` /
 * `project-dsh` / `project-agents`）。Codex、Claude Code、Cursor 这些工具把技能放在**自己的**
 * 目录里，DSH 完全看不见 —— 本模块把那些目录也列出来，由 {@link module:./provider.js}
 * 注册成 provider 喂给 DSH。
 *
 * ## rank 的方向（关键）
 *
 * `SkillCandidate.rank` **数值越小优先级越高**，且「同一层里同名条目由 rank 决胜」。
 * 官方 provider 的 rank 是 project-dsh=100、project-agents=200、user-dsh=400、user-agents=500。
 *
 * 因此「停用一个 DSH 原生技能」要真正生效，我们必须以 **比原生小 1** 的 rank 报出**同名**
 * 候选（只把 invocation 置成不可调用）—— 只是不列出它没有用，原生那条仍在册、仍可调用。
 * 这就是 {@link policyRank} 存在的原因，也是这一整套「不改源文件启停」的地基。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 官方四个根的 rank，与 DSH filesystem provider 一致。 */
export const NATIVE_RANKS = {
  'project-dsh': 100,
  'project-agents': 200,
  'user-dsh': 400,
  'user-agents': 500,
}

/** 我们的策略条目要比原生条目「更靠前」一位，才能盖过它。 */
export const POLICY_RANK_OFFSET = -1

/** 外部 Agent 目录读不到原生排名，取一个 user-dsh 之后的固定值即可（它们不与原生重名）。 */
export const EXTERNAL_RANK = 450

/**
 * 第三方 Agent 的技能根。
 *
 * `env` 是环境变量覆盖（与上游实现一致），方便测试和多套安装目录。
 * 这些目录**只读**：启停是策略层的事，绝不写它们的文件。
 */
const EXTERNAL_SOURCES = [
  { key: 'cc-switch', label: 'CC Switch', env: 'DSH_CC_SWITCH_HOME', dir: '.cc-switch' },
  { key: 'codex', label: 'Codex', env: 'DSH_CODEX_HOME', dir: '.codex' },
  { key: 'claude', label: 'Claude Code', env: 'DSH_CLAUDE_HOME', dir: '.claude' },
  { key: 'gemini', label: 'Gemini', env: 'DSH_GEMINI_HOME', dir: '.gemini' },
  { key: 'cursor', label: 'Cursor', env: 'DSH_CURSOR_HOME', dir: '.cursor' },
  { key: 'copilot', label: 'Copilot', env: 'DSH_COPILOT_HOME', dir: '.copilot' },
  { key: 'trae', label: 'Trae', env: 'DSH_TRAE_HOME', dir: '.trae' },
  { key: 'roo', label: 'Roo Code', env: 'DSH_ROO_HOME', dir: '.roo' },
  { key: 'qoder', label: 'Qoder', env: 'DSH_QODER_HOME', dir: '.qoder' },
  { key: 'lingma', label: 'Lingma', env: 'DSH_LINGMA_HOME', dir: '.lingma' },
]

/**
 * The rank our candidate for `source` must carry.
 *
 * Native sources get `native - 1` so the policy entry outranks the official one; external
 * sources get a flat rank because nothing else lists them.
 */
export function policyRank(source) {
  const native = NATIVE_RANKS[source]
  return native === undefined ? EXTERNAL_RANK : native + POLICY_RANK_OFFSET
}

/** Whether we can write into this source (native roots only; third-party dirs stay untouched). */
const WRITABLE = new Set(['user-dsh', 'user-agents', 'project-dsh', 'project-agents'])

/**
 * Build the full source list.
 *
 * Order is by `rank` (highest priority first), which is also the order the panel should
 * display: the roots DSH itself prefers come first.
 *
 * @param options - `{ dshHome, agentsHome, projectRoots, env, home }`.
 * @returns source records `{ key, label, path, scope, rank, native, readonly, exists, project }`.
 */
export function skillSources(options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const dshHome = String(options.dshHome ?? '')
  const agentsHome = String(options.agentsHome ?? '')
  const projectRoots = Array.isArray(options.projectRoots) ? options.projectRoots : []

  const sources = []
  for (const projectRoot of projectRoots) {
    if (typeof projectRoot !== 'string' || projectRoot === '') continue
    sources.push({
      key: 'project-dsh', label: '项目 · DSH', path: join(projectRoot, '.dsh', 'skills'),
      scope: projectRoot, rank: policyRank('project-dsh'), native: true, project: true,
    })
    sources.push({
      key: 'project-agents', label: '项目 · Agent', path: join(projectRoot, '.agents', 'skills'),
      scope: projectRoot, rank: policyRank('project-agents'), native: true, project: true,
    })
  }
  if (dshHome !== '') {
    sources.push({
      key: 'user-dsh', label: '用户 · DSH', path: join(dshHome, 'skills'),
      scope: 'global', rank: policyRank('user-dsh'), native: true, project: false,
    })
  }
  if (agentsHome !== '') {
    sources.push({
      key: 'user-agents', label: '用户 · Shared Agent', path: join(agentsHome, 'skills'),
      scope: 'global', rank: policyRank('user-agents'), native: true, project: false,
    })
  }
  for (const external of EXTERNAL_SOURCES) {
    const override = String(env[external.env] ?? '')
    const base = override !== '' ? override : join(home, external.dir)
    sources.push({
      key: external.key, label: external.label, path: join(base, 'skills'),
      scope: 'global', rank: EXTERNAL_RANK, native: false, project: false,
    })
  }
  for (const source of sources) {
    source.readonly = !WRITABLE.has(source.key)
    /**
     * 来源启停用的策略键。
     *
     * 结构 key（`project-dsh` / `project-agents`）在项目级被**多个工作区共用**，而启停是
     * 用户对「这一个工作区的这个来源」做的决定：按结构 key 存，关掉 A 工作区的项目来源会
     * 连带关掉 B 的 —— 审计发现的 P1。
     *
     * 所以策略键带上作用域。结构 key 保持不动：它还被写盘判定、回收站、安装目标当作
     * 「这是哪个根」的标识用，改它牵连太广。
     */
    source.policyKey = source.project === true ? `${source.key}@${source.scope}` : source.key
  }
  return sources.sort((left, right) => left.rank - right.rank || left.key.localeCompare(right.key))
}
