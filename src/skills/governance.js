/**
 * 治理视图：把「磁盘上有什么」与「用户启停了什么」合成一份快照。
 *
 * 这一份快照同时喂两个消费者：
 *   · 面板（`/runtime` 里的 `skillGovernance`）—— 分组、计数、启停状态；
 *   · DSH 的 skills provider（见 `./provider.js`）—— 候选及其可调用性。
 *
 * 二者必须来自同一次计算，否则「面板说停用了、模型却还能调用」这种自相矛盾的状态
 * 就会真的出现（分开算两遍时它出现过）。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { bodyOf, scanSkillRoot } from './discover.js'
import { skillSources } from './sources.js'
import { categoryList, categoryOf, effectiveEnabled, managerStatePath, readManagerState, skillEnabled, sourceEnabled } from './state.js'
import { trashList } from './trash.js'
import { installList } from './repository-install.js'

/** DSH 只接受 kebab-case 技能名；外部目录里的怪名字跳过，否则一条坏数据会拖垮整个列表。 */
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Scan every source and apply the policy.
 *
 * @param options - `{ dshHome, agentsHome, projectRoots, env, home, state }`.
 *   `state` 可传入以避免重复读盘（写操作的调用方手里已经有一份）。
 * @returns `{ sources, skills, scanError, statePath }`
 *   `sources[]` 是**分组**（含该组的技能），`skills[]` 是扁平列表（provider 用）。
 */
export async function governedSkills(options = {}) {
  const dshHome = String(options.dshHome ?? '')
  const state = options.state ?? await readManagerState(dshHome)
  const groups = []
  const skills = []
  const errors = []

  for (const source of skillSources(options)) {
    const exists = existsSync(source.path)
    const rows = []
    if (exists) {
      try {
        const found = await scanSkillRoot({ path: source.path, source: source.key, scope: source.scope })
        for (const skill of found) {
          if (!KEBAB.test(String(skill.name ?? ''))) continue
          const entry = {
            name: skill.name,
            description: skill.description ?? '',
            path: skill.path,
            /**
             * 真实路径：同一份技能经 Junction / symlink 出现在两个来源时，模型侧只算一个。
             * 面板仍按来源分行展示（用户要能分别管两个根），合并发生在 `skills/modelView.js`。
             *
             * **只在解析结果与自身不同时才带**（别名行）：普通行省掉这份重复的长字符串，
             * `/runtime` 不必为「没有别名」付双倍路径体积。
             */
            realPath: typeof skill.realPath === 'string' && skill.realPath !== skill.path ? skill.realPath : '',
            source: source.key,
            scope: source.scope,
            rank: source.rank,
            /**
             * 这个来源是不是 DSH 原生 provider 也读的根。
             *
             * 决定停用时要不要上报影子候选：原生根必须盖住原生条目（rank − 1），外部目录
             * 只有本插件列，停用就不该再上报（否则会按名字压掉别的来源里同名但不同的技能）。
             */
            native: source.native === true,
            readonly: source.readonly,
          }
          // 必须在对象建好之后再算：`effectiveEnabled` 要把 entry 本身作为策略键的一部分。
          entry.category = categoryOf(state, entry)
          /**
           * `ownEnabled` = **这个技能自己的开关**，`enabled` = 有效值（来源 ∧ 分类 ∧ 自身）。
           *
           * 面板的勾选框必须绑 `ownEnabled`：它点击能改的只有这一个值。绑有效值的话，
           * 来源（或分类）停用时勾选框显示"关"，用户点一下只会把技能自身置为开，有效值仍是关，
           * 界面毫无变化 —— 看起来像"点了没反应"。有效值单独用来标注「被来源停用」。
           */
          entry.ownEnabled = skillEnabled(state, entry)
          entry.enabled = effectiveEnabled(state, source.policyKey ?? source.key, entry)
          rows.push(entry)
          skills.push(entry)
        }
      } catch (error) {
        // 一个来源读不动不能让整页空掉：记下来，其余来源照常。
        errors.push(`${source.key}: ${String(error?.message ?? error)}`)
      }
    }
    rows.sort((left, right) => left.name.localeCompare(right.name))
    groups.push({
      key: source.key,
      label: source.label,
      path: source.path,
      scope: source.scope,
      rank: source.rank,
      native: source.native === true,
      readonly: source.readonly === true,
      exists,
      enabled: sourceEnabled(state, source.policyKey ?? source.key),
    // 面板要把启停写回**这个**键（结构 key 会在多工作区间共享）。
    policyKey: source.policyKey ?? source.key,
      count: rows.length,
      skills: rows,
    })
  }

  skills.sort((left, right) => left.name.localeCompare(right.name) || left.rank - right.rank)
  return {
    sources: groups,
    skills,
    // 分类是纯管理视图（只存在状态文件里），这里给面板一份可直接渲染的清单。
    categories: categoryList(state),
    // 回收站：记录 + 文件是否还在（有人手清过 trash 目录时 exists 会是 false）。
    trash: trashList(state),
    // 技能仓库：只有元数据与已扫出的技能清单；压缩包留在缓存目录里，不下发到浏览器。
    repositories: Array.isArray(state.repositories) ? state.repositories : [],
    // 仓库安装记录（哪个技能装到了哪里、装的是哪一版签名）
    installs: installList(state),
    scanError: errors.join('; '),
    statePath: dshHome === '' ? '' : managerStatePath(dshHome),
  }
}

/**
 * Load one skill's full markdown, for the provider's `get`.
 *
 * **Full text, not the panel's 4 KB preview projection**: this is what the model reads.
 */
export async function loadGovernedSkillContent(path) {
  const text = await readFile(String(path ?? ''), 'utf8')
  return { content: text, preview: bodyOf(text) }
}
