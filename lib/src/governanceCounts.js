/**
 * 技能计数：**唯一口径 = 模型实际看得见几个**。
 *
 * 这个文件存在的原因是同一个问题被踩了三次：
 *
 *   1. 页签写"共 24"，列表列 24 项，但其中 14 个的开关是关的 —— 页签数字回答的是
 *      "磁盘上有几个"，用户问的是"现在能用几个"。
 *   2. 总账在选中某个工作区时仍显示"全局 24 · 生效 10"，把两个互斥作用域的统计
 *      混在一张卡里 —— 既然选了范围，卡里就只该有这个范围的数。
 *
 * 所以：**凡是给用户看的数字，一律按"实际提供给模型"计数**；"磁盘上共多少"只在明确
 * 标注"共"的地方出现。这里把口径写成一个纯函数，页签、摘要、总账都调它，
 * 谁也别再自己 `reduce` 一遍。
 */

/** 同名技能里谁生效：rank 数值小者优先（与 Host 的决胜规则一致，只统计有效值开着的那份）。 */
function winnerPathByName(sources) {
  const best = new Map()
  for (const group of Array.isArray(sources) ? sources : []) {
    const rank = Number(group?.rank ?? 0)
    for (const skill of Array.isArray(group?.skills) ? group.skills : []) {
      if (skill?.enabled !== true) continue
      const name = String(skill?.name ?? '')
      const path = String(skill?.path ?? '')
      if (name === '' || path === '') continue
      const current = best.get(name)
      if (current === undefined || rank < current.rank) best.set(name, { rank, path })
    }
  }
  return best
}

/**
 * 统计某个范围内的技能：总数、模型可见数、以及不可见的三种互斥原因。
 *
 * @param sources - 治理快照的 `sources`。
 * @param scope - `'global'` / 某个工作区路径 / `'all'`（不按范围筛）。
 * @returns `{ total, visible, shadowed, disabledSelf, disabledSource }`
 */
export function countSkills(sources, scope = 'all') {
  const winners = winnerPathByName(sources)
  let total = 0
  let visible = 0
  let shadowed = 0
  let disabledSelf = 0
  let disabledSource = 0
  for (const group of Array.isArray(sources) ? sources : []) {
    if (scope !== 'all' && String(group?.scope ?? 'global') !== String(scope)) continue
    for (const skill of Array.isArray(group?.skills) ? group.skills : []) {
      total += 1
      if (skill?.ownEnabled === false) { disabledSelf += 1; continue }
      if (skill?.enabled !== true) { disabledSource += 1; continue }
      const winner = winners.get(String(skill?.name ?? ''))
      if (winner !== undefined && winner.path !== String(skill?.path ?? '')) { shadowed += 1; continue }
      visible += 1
    }
  }
  return { total, visible, shadowed, disabledSelf, disabledSource }
}
