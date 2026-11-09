/** skills/reconcile 接口测试：全局技能的落盘与回收。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NAME, LEGACY_NAME } from '../src/identity.js'
import { readState, scopeRoot } from '../src/skills/reconcile.js'

const home = mkdtempSync(join(tmpdir(), 'smp-skills-'))
process.env.DSH_HOME = home
const ctx = { logger: { warn() {}, info() {}, error() {} } }
// 契约：条目自带 scope（'global' 或项目路径）——面板写入时一定带上
const skill = { name: 'demo-skill', description: '演示技能', body: '# 标题\n\n正文', enabled: true, scope: 'global' }

test('scopeRoot：全局指向 $DSH_HOME/skills', () => {
  assert.equal(scopeRoot('global'), join(home, 'skills'))
})

test('scopeRoot：id 选根 —— agents 走 DSH_AGENTS_HOME，项目级两个根都在项目下', () => {
  /**
   * 每个作用域都有**两个**可写根，DSH 的 provider 两个都读。所以根是条目的一部分：
   * 少了它，写到 ~/.agents/skills 的文件会被下一轮 reconcile 搬到默认根去。
   */
  const agents = mkdtempSync(join(tmpdir(), 'smp-agents-'))
  process.env.DSH_AGENTS_HOME = agents
  // Project roots are absolute paths; on Windows `/p/app` would resolve against the
  // current drive, so build the fixture with `join` rather than asserting POSIX text.
  const project = process.platform === 'win32' ? 'C:\\p\\app' : '/p/app'
  try {
    assert.equal(scopeRoot('global', 'dsh'), join(home, 'skills'))
    assert.equal(scopeRoot('global', 'agents'), join(agents, 'skills'))
    assert.equal(scopeRoot(project, 'dsh'), join(project, '.dsh', 'skills'))
    assert.equal(scopeRoot(project, 'agents'), join(project, '.agents', 'skills'))
    // 缺省仍然是 dsh（旧条目没有这个字段，语义不能变）
    assert.equal(scopeRoot('global'), join(home, 'skills'))
    assert.equal(scopeRoot(project), join(project, '.dsh', 'skills'))
  } finally {
    delete process.env.DSH_AGENTS_HOME
  }
})

test('scopeRoot：工作区嵌在 Git 仓库里时仍落到仓库根（与 DSH 的 skill provider 一致）', () => {
  /**
   * 这条用例锁的是**与宿主对齐**，不是「工作区直觉」。
   *
   * DSH 0.2.2-rc.1（当前 npm latest）的 `@deepseek-ai/dsh-skill-filesystem` 以「最近的包含
   * `.git` 的祖先目录」为项目根（README「根目录与优先级」，源码 `findProjectRoot()`），
   * 不存在时退回 cwd。模型侧扫描的就是那个根下的 `.dsh/skills` / `.agents/skills`。
   *
   * 面板若自作主张改用工作区路径，就会把技能写到 DSH 不扫描、也不监听变更的目录：面板里
   * 看得到、模型侧却拿原生 provider 读不到，而且外部编辑不会触发目录刷新。0.5.38 / 0.5.41
   * 修掉的正是这类「写盘与扫描各用一个根」的分叉。
   */
  const checkout = mkdtempSync(join(tmpdir(), 'smp-git-root-'))
  const workspace = join(checkout, 'data', 'workspaces', 'bbbbbbb')
  mkdirSync(join(checkout, '.git'), { recursive: true })
  mkdirSync(workspace, { recursive: true })
  assert.equal(scopeRoot(workspace, 'dsh'), join(checkout, '.dsh', 'skills'))
  assert.equal(scopeRoot(workspace, 'agents'), join(checkout, '.agents', 'skills'))
})


/*
 * `reconcileSkills` 在 0.5.32 被删除：它从未被调用，却会按状态文件里的**任意 dirname**
 * 递归删除目录 —— 一个不会触发的函数带着一个误用即毁文件的实现。它对应的 4 条用例一并删除；
 * 上面两条 `scopeRoot` 与下面这条「旧清单导入」仍然覆盖着仍然存在的逻辑。
 */

/*
 * 原先这里还有「旧技能归属清单自动导入 / 移除旧配置后回收文件」一条用例：它验证的正是
 * 0.5.32 被删掉的 `reconcileSkills`（一个从未被调用、却会对状态文件里任意 dirname 递归
 * 删除目录的实现）。用例随实现一起删除 —— 保留一份"测着已删除代码"的测试没有意义。
 */