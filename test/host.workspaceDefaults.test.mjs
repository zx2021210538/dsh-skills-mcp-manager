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
  assert.match(source, /singleWorkspaceForCwds\(cwds, spaces\)/,
    '默认工作区要用注册表路径匹配（支持子目录），且要求所有会话属于同一个')
  assert.match(source, /const currentWorkspaceRoot = singleListedRoot\(cwds, spaces\.map\(/,
    '技能默认值要独立发布项目根，且必须落在「技能工作区」下拉的选项域内')
  assert.match(source, /currentWorkspace,\s*\n\s*currentWorkspaceRoot,/, '/runtime 必须同时返回两个字段')
})

test('agent 增删后快照 memo 立刻失效（新根下的停用技能不能晚一拍）', () => {
  assert.match(source, /const attachAgent = \(agent\) => \{[\s\S]*?invalidateSnapshotCache\(\)/,
    '新 agent 的 cwd 可能带来新项目根：快照 1s memo 不清，它第一次 list({cwd}) 看不到该根下被停用的技能')
  assert.match(source, /const detachAgent = \(agent\) => \{[\s\S]*?invalidateSnapshotCache\(\)/,
    'agent 移除后根集合变小，同样要让快照失效')
})
