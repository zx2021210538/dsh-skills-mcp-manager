/**
 * 项目根的纯函数：把「一个目录属于哪个项目」收敛成一份规则。
 *
 * DSH 自己的 `@deepseek-ai/dsh-skill-filesystem` 把**最近的包含 `.git` 的祖先目录**当作
 * 项目根（`findProjectRoot()`；没有 `.git` 时退回 cwd），项目级技能只从
 * `<项目根>/.dsh/skills` 与 `<项目根>/.agents/skills` 读。
 *
 * 所以「技能写到哪」「这个会话能看到哪些项目级技能」「面板展示哪个根」必须用同一套判据，
 * 否则面板和模型会各看各的目录 —— 0.5.38 / 0.5.41 修的就是这类分叉。
 */
import { resolve } from 'node:path'
import { projectRootOf } from './reconcile.js'

/**
 * 两个路径是否指同一个目录。
 *
 * 技能来源里的 `scope` 是注册表路径归一化后的项目根，而会话 cwd 可能来自另一处写法：
 * Windows 上 `D:/Work` 与 `D:\Work` 都合法。先 `resolve` 再按平台比较，避免「同一目录两个
 * 字符串」把技能挡在目录外。
 */
export function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (left === '' || right === '') return false
  let a
  let b
  try {
    a = resolve(left)
    b = resolve(right)
  } catch {
    return false
  }
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** 一个目录的项目根；空输入返回 `''`（`resolve('')` 会变成进程 cwd，不能拿来当输入）。 */
export function projectRootFor(dir) {
  const raw = typeof dir === 'string' ? dir.trim() : ''
  if (raw === '') return ''
  const root = projectRootOf(raw)
  return typeof root === 'string' ? root : ''
}

/** 一组目录的项目根，按首次出现顺序去重；空项与无法解析的项被忽略。 */
export function distinctProjectRoots(dirs = []) {
  const roots = []
  for (const dir of Array.isArray(dirs) ? dirs : []) {
    const root = projectRootFor(dir)
    // 用 samePath 而不是字符串相等：Windows 上同一目录可能以不同大小写/分隔符出现，
    // 两套写法会让同一个仓库被扫两遍、来源列表里出现两条同名分组。
    if (root === '' || roots.some((existing) => samePath(existing, root))) continue
    roots.push(root)
  }
  return roots
}

/**
 * 所有目录共享的**唯一**项目根；零个或多个时返回 `''`。
 *
 * 「一个根」是能安全给默认值的前提：多个根说明用户同时在几个项目里工作，这时猜任何一个
 * 都会把默认目标指到别人身上（面板只应给空默认，让用户自己选）。
 */
export function singleProjectRoot(dirs = []) {
  const roots = distinctProjectRoots(dirs)
  return roots.length === 1 ? roots[0] : ''
}

/**
 * `singleProjectRoot` 的受限版本：根还必须出现在 `knownRoots` 里。
 *
 * 面板的「技能工作区」下拉只列注册表里的项目根（`spaces[].root`）。默认值如果落在集合外，
 * 下拉会拿到一个没有对应 option 的 value：浏览器显示成空选中，内部却已经有值，「将写入 …」
 * 还照样显示那个路径 —— 用户以为没选、点创建却写过去了。所以默认值必须和选项同一个域。
 */
export function singleListedRoot(dirs = [], knownRoots = []) {
  const root = singleProjectRoot(dirs)
  if (root === '') return ''
  return (Array.isArray(knownRoots) ? knownRoots : []).some((known) => samePath(known, root)) ? root : ''
}
