/**
 * 「这个技能是不是仓库装进来的」——把安装记录对到治理快照里的技能上。
 *
 * 为什么需要它：仓库的更新 / 回滚 / 卸载原先只出现在「获取技能 → 已安装」区块里，
 * 用户看到的是两张互不相干的清单 —— 技能页里那个技能，和已安装列表里那个同名条目，
 * 得靠自己判断是同一个东西。一个对象应该只有一个家：动作长在技能自己身上。
 *
 * 匹配依据是**落盘目录**（安装记录记了 `dir`，技能记了 `SKILL.md` 的完整路径），
 * 不是名字：同名技能可以同时存在于不同来源，只有目录能唯一确定"这一份是装进来的"。
 * 名字只在 `dir` 缺失（早期记录）时兜底，且必须同时满足作用域。
 */

/** `C:\a\b/` → `c:/a/b`：Windows 上大小写与斜杠都可能不一致。 */
function normalizeDir(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/** `…/foo/SKILL.md` → `…/foo`。技能路径可能是 `SKILL.md`，也可能就是目录。 */
function parentDir(path) {
  const text = String(path ?? '').replace(/\\/g, '/')
  const cut = text.lastIndexOf('/')
  if (cut <= 0) return text
  // 只有以 SKILL.md 结尾时才砍掉最后一段；已经是目录就原样返回。
  return /\/SKILL\.md$/i.test(text) ? text.slice(0, cut) : text
}

/**
 * 找这条技能对应的安装记录。
 *
 * @param installs - `governance.installs`（Host 下发，含 `dir` / `scope` / `name`）。
 * @param skillPath - 技能的 `SKILL.md` 路径。
 * @param scope - 技能所在作用域（`'global'` / `'project'`），仅用于名字兜底时排除错层。
 * @returns 安装记录，或 `null`。
 */
export function installForSkill(installs, skillPath, scope) {
  const list = Array.isArray(installs) ? installs : []
  if (list.length === 0) return null
  const wanted = normalizeDir(parentDir(skillPath))
  if (wanted !== '') {
    for (const install of list) {
      const dir = normalizeDir(install?.dir)
      if (dir !== '' && dir === wanted) return install
    }
  }
  // 兜底：早期记录可能没有 `dir`。名字 + 作用域都对上才算，避免把全局那份认成项目那份。
  const name = wanted === '' ? '' : wanted.slice(wanted.lastIndexOf('/') + 1)
  if (name === '') return null
  const scopeText = scope === 'project' ? 'project' : 'global'
  for (const install of list) {
    if (normalizeDir(install?.dir) !== '') continue
    if (String(install?.name ?? '').toLowerCase() !== name) continue
    if (String(install?.scope ?? 'global') !== scopeText) continue
    return install
  }
  return null
}

/**
 * 一批技能 → `Map<技能路径, 安装记录>`。
 *
 * 页面每 5 秒重渲染，逐卡片线性扫安装列表是无所谓的（通常个位数），但把它们算成
 * 一份 Map 传给渲染函数更清楚：卡片只需要问"我有没有安装记录"。
 */
export function installMapForSkills(installs, skills) {
  const map = new Map()
  const list = Array.isArray(skills) ? skills : []
  if (!Array.isArray(installs) || installs.length === 0) return map
  for (const skill of list) {
    const path = String(skill?.path ?? '')
    if (path === '') continue
    const install = installForSkill(installs, path, skill?.scope)
    if (install !== null) map.set(path, install)
  }
  return map
}
