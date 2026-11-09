/**
 * Host 侧两处「默认值 / 扫描范围」的接线检查。
 *
 * 这类逻辑嵌在插件 apply() 里，没有独立的纯函数可测；但它们的回归代价很高：截断会让面板
 * 静默少列工作区，currentWorkspace 退回「第一个 agent」又会让默认目标指错项目。源码级断言
 * 不优雅，但能把这两条钉住（与 `skills.providerScopes.test.mjs` 的接线检查同一做法）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8')

test('扫描根不再静默截断：两处 refresh 都接收完整项目根列表', () => {
  assert.doesNotMatch(source, /slice\(0,\s*12\)/,
    'refreshGovernance / refreshDiscovered 里不能再用 slice(0, 12)：超过 12 个根的工作区会从面板里整段消失')
  const full = source.match(/const roots = Array\.isArray\(projectRoots\) \? \[\.\.\.projectRoots\] : \[\]/g) ?? []
  assert.equal(full.length, 2, '两处 refresh 都必须逐字传完整列表（少一处就还是有一半数据被截）')
})

test('项目根去重只有一份规则（distinctProjectRoots）', () => {
  assert.match(source, /return distinctProjectRoots\(dirs\)/,
    'governanceProjectRoots 必须用 roots.js 的去重/归一化，不能自己再写一套')
})

test('currentWorkspace 不再取第一个 live agent，并且同时发布项目根', () => {
  assert.doesNotMatch(source, /currentWorkspace:\s*cwds\[0\]/,
    '第一个 agent 只是创建顺序，不是用户正在看的会话')
  assert.doesNotMatch(source, /currentWorkspace:\s*projectRootOf\(cwds\[0\]\)/,
    '不能再把第一个 cwd 归一化后当默认工作区')
  assert.match(source, /workspaceForCwd\(cwd, spaces\)/, '默认工作区要用注册表路径匹配（支持子目录）')
  assert.match(source, /const currentWorkspaceRoot = singleProjectRoot\(cwds\)/,
    '技能默认值要独立发布项目根：同仓库多工作区时根仍可确定')
  assert.match(source, /currentWorkspace,\s*\n\s*currentWorkspaceRoot,/, '/runtime 必须同时返回两个字段')
})
