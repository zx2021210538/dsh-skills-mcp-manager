/**
 * 模型侧投影：把治理快照「一行一个根」折成 DSH 真正会看到的候选。
 *
 * ## 为什么需要单独一层
 *
 * 治理快照是**按来源分行**的（同一份技能可能通过多个来源各出现一次），而模型目录是
 * **按技能名去重**的。两套口径各算一遍，就会出现「面板说可用、模型说不可用」——
 * issue #4 正是这么来的：`~/.agents/skills` 是 `~/.claude/skills` 的 Junction，`claude`
 * 来源停用后仍上报了一条 rank 450 的 `invocation:false` 影子候选，把 `user-agents`
 * （rank 499）那条启用候选按名字压掉了。
 *
 * 所以把「一条技能的最终形态」收敛成这里的纯函数，provider 与面板计数**共用**：
 *
 *   · **同一真实文件**（`realPath` 相同：Junction / symlink / 路径别名）算**一个**技能，
 *     策略取并集 —— 任一来源启用就可用。否则「关掉一个重复来源」会连带关掉另一份。
 *   · **影子候选只为盖住 DSH 原生 provider**。外部目录（Claude Code、Codex…）只有本插件
 *     列，停用时直接不上报；上报只会按名字压过别的来源里同名但不同文件的技能。
 *   · rank 取该技能在**原生根**里的最小值（没有原生根就用组内最小值）：这样停用仍能盖住
 *     原生 provider 在 100 / 200 / 400 / 500 的条目，宿主的「停用即不可调用」不受影响。
 *
 * ## 已知边界（宿主侧配置能打破「外部目录只有我们列」这个前提）
 *
 * 宿主的 `dsh-skill-filesystem` 还有两个本模块没有建模的 rank：`customSkillDirs` 的 300 与
 * runtime 技能的 250。如果用户把 `~/.claude/skills` 这类外部目录**配置进官方 provider**：
 *
 *   · 外部来源停用后我们不再上报候选，官方那条 300 的候选仍然可调用；
 *   · 我们的 399/499 影子也压不住同名 250/300 候选。
 *
 * 这两条在 0.6.7 之前就存在（当时外部影子是 450，同样压不住 250/300），不是本模块引入的；
 * 真要在这种配置下也做到「面板 = 模型」，需要同时建模这两类 rank。
 *
 * ## 结果如何被使用
 *
 *   · {@link modelViews} → provider 的候选（模型目录）；
 *   · {@link modelViewOf} → `/runtime.skillGovernance.modelView`（面板的计数与「被谁覆盖」）。
 *
 * 两者都从同一份 `skills[]` 出发，所以「面板显示可见 N」与「模型实际能调用 N 个」是同一口径。
 */

/** 一条技能的真实身份：优先 `realPath`（解析掉 Junction/symlink），退回原始路径。 */
function identityOf(skill) {
  const realPath = typeof skill?.realPath === 'string' && skill.realPath !== '' ? skill.realPath : ''
  if (realPath !== '') return realPath
  return typeof skill?.path === 'string' ? skill.path : ''
}

function rankOf(skill) {
  const rank = Number(skill?.rank)
  return Number.isFinite(rank) ? rank : 0
}

/**
 * 按真实文件分组。
 *
 * @param skills - 治理快照的 `skills[]`（已经按作用域过滤过的行）。
 * @returns 数组的数组：每组是**同一个真实文件**的那些行（可能来自不同来源）。
 */
export function modelGroups(skills = []) {
  const groups = new Map()
  for (const skill of Array.isArray(skills) ? skills : []) {
    const id = identityOf(skill)
    if (id === '') continue
    const list = groups.get(id)
    if (list === undefined) groups.set(id, [skill])
    else list.push(skill)
  }
  return [...groups.values()]
}

/**
 * 一组（同一真实文件）的最终形态。
 *
 * @returns `{ rows, enabled, emittable, rank, name, description, source, path }`
 *   `enabled` 是**并集**（任一来源启用即可用）；`emittable` 表示要不要向 DSH 上报候选。
 */
export function groupView(list) {
  const rows = Array.isArray(list) ? list : []
  const natives = rows.filter((skill) => skill?.native === true)
  const enabled = rows.some((skill) => skill?.enabled === true)
  const rankPool = natives.length > 0 ? natives : rows
  const rank = rankPool.reduce((best, skill) => Math.min(best, rankOf(skill)), Number.POSITIVE_INFINITY)
  // 代表行只用来提供 name/description/path/source：优先取**启用的**那一行，让面板与
  // provider 都指向用户以为在用的那份；都停用时取 rank 最小的那一行。
  const pool = enabled ? rows.filter((skill) => skill?.enabled === true) : rows
  const representative = pool.reduce(
    (best, skill) => (best === null || rankOf(skill) < rankOf(best) ? skill : best),
    null,
  ) ?? rows[0] ?? {}
  return {
    rows,
    enabled,
    /**
     * 外部目录停用时不上报：DSH 原生 provider 不读那些目录，没有需要盖的候选。
     * 原生根停用必须上报影子候选（rank 比该根小 1），否则原生条目照旧可调用。
     */
    emittable: enabled || natives.length > 0,
    rank: Number.isFinite(rank) ? rank : 0,
    name: String(representative?.name ?? ''),
    description: String(representative?.description ?? ''),
    source: String(representative?.source ?? ''),
    path: String(representative?.path ?? ''),
  }
}

/** 所有技能的真实形态（每组一条）。 */
export function modelViews(skills = []) {
  return modelGroups(skills).map(groupView)
}

/**
 * 名字的最终胜者 —— 与 DSH 同层合并规则一致：**rank 升序**，同 rank 按上报顺序，然后按名字去重。
 *
 * 注意「停用的原生技能」也会赢（这正是影子候选的目的：盖住原生 provider 的同名条目）。
 */
export function modelWinners(views = []) {
  const emitted = (Array.isArray(views) ? views : [])
    .filter((view) => view?.emittable === true && view?.name !== '')
  const ordered = [...emitted].sort((left, right) => left.rank - right.rank)
  const winners = new Map()
  for (const view of ordered) if (!winners.has(view.name)) winners.set(view.name, view)
  return winners
}

/** 一组为什么不可用：`self` = 技能自己的开关；`source` = 来源（或分类）整体关掉。 */
function blockReasonOf(view) {
  const rows = Array.isArray(view?.rows) ? view.rows : []
  return rows.length > 0 && rows.every((skill) => skill?.ownEnabled === false) ? 'self' : 'source'
}

/**
 * 按**模型实际可见**的口径计数。
 *
 * 每条**真实技能**（同一文件经多个来源出现只算一条）恰好落到一个桶里，所以
 * `visible + shadowed + disabledSelf + disabledSource === total` 恒成立。
 *
 * 分桶顺序很重要：**先看自己是否停用，再看名字被谁拿走**。
 *
 *   · 停用的技能根本没进模型目录，它的问题是「停用」，不是「被覆盖」—— 把它记成
 *     「同名覆盖」会让卡片显示「被 X 覆盖」，可 X 的优先级其实比它低（用户重新打开那个
 *     来源就赢回去了），提示方向是反的。
 *   · 只有**启用**的同名技能输给别人，才是「同名覆盖」。
 *
 * @param skills - 参与「谁赢」的行（会话能看到的：global ∪ 本项目根）。
 * @param inScope - 可选：这个组是否计入 `total`（默认全部）。按范围统计时用它把
 *   「只属于别的范围的技能」排除在总数之外，但**不**排除它们参与决胜。
 * @returns `{ total, visible, shadowed, disabledSelf, disabledSource }`
 */
function countViews(views, inScope = () => true) {
  const winners = modelWinners(views)
  const counted = { total: 0, visible: 0, shadowed: 0, disabledSelf: 0, disabledSource: 0 }
  for (const view of views) {
    if (!inScope(view)) continue
    counted.total += 1
    if (view.enabled !== true) {
      if (blockReasonOf(view) === 'self') counted.disabledSelf += 1
      else counted.disabledSource += 1
      continue
    }
    if (winners.get(view.name) === view) counted.visible += 1
    else counted.shadowed += 1
  }
  return counted
}

/** 同 {@link countViews}，输入是治理快照的 `skills[]`（全部计入总数）。 */
export function countModel(skills = []) {
  return countViews(modelViews(skills))
}

function normaliseScope(scope) {
  const value = String(scope ?? '')
  return value === '' ? 'global' : value
}

/**
 * 按作用域算计数：`all`（不按范围筛）、`global`、以及快照里出现过的每个项目根。
 *
 * **每个具体范围用的数据集与 provider 相同**：`global ∪ 该范围`（provider 的 `visibleFor`
 * 就是这样过滤的）。否则别名跨 scope 时会分叉 —— 例如项目把全局技能目录用 junction 引进来，
 * 只停用项目来源时，provider 会因为并集仍然可调用，而「只筛本项目行」的计数算出可见 0。
 *
 * `total` 只统计**在该范围里至少有一行**的真实技能：全局技能算进「全局」层级，不会被
 * 算进某个工作区的总数（否则工作区数字会莫名其妙变大）。
 */
export function modelCountsByScope(skills = []) {
  const rows = Array.isArray(skills) ? skills : []
  const scopes = new Set(['all', 'global'])
  for (const row of rows) scopes.add(normaliseScope(row?.scope))
  const counts = {}
  for (const scope of scopes) {
    if (scope === 'all') {
      counts.all = countModel(rows)
      continue
    }
    const visibleRows = rows.filter((row) => {
      const rowScope = normaliseScope(row?.scope)
      return rowScope === 'global' || rowScope === scope
    })
    const inScope = scope === 'global'
      ? () => true
      : (view) => view.rows.some((row) => normaliseScope(row?.scope) === scope)
    counts[scope] = countViews(modelViews(visibleRows), inScope)
  }
  return counts
}

/**
 * `/runtime` 里那份「模型侧投影」：计数 + 每行「被谁覆盖」。
 *
 * `shadowedBy` 只标**启用却被同名技能压掉**的行：停用的行自己的原因已经由 `counts` 说清，
 * 再标「被覆盖」会把状态点从「来源停用」改成「被覆盖」，还会写出方向相反的优先级提示。
 *
 * 键是**行路径**（卡片用它标注「被「X」覆盖」），值是来源的 label —— 与快照里
 * `sources[].label` 同一个字符串（客户端的 i18n 键）。
 */
export function modelViewOf(snapshot = {}) {
  const skills = Array.isArray(snapshot?.skills) ? snapshot.skills : []
  const labelOf = new Map((Array.isArray(snapshot?.sources) ? snapshot.sources : [])
    .map((group) => [String(group?.key ?? ''), String(group?.label ?? group?.key ?? '')]))
  const views = modelViews(skills)
  const winners = modelWinners(views)
  const shadowedBy = {}
  for (const view of views) {
    if (view.enabled !== true) continue
    const winner = winners.get(view.name)
    if (winner === undefined || winner === view) continue
    const label = labelOf.get(winner.source) ?? winner.source
    for (const row of view.rows) {
      const path = String(row?.path ?? '')
      if (path !== '') shadowedBy[path] = label
    }
  }
  return { counts: modelCountsByScope(skills), shadowedBy }
}
