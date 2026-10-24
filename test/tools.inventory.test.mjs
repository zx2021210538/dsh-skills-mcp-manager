/**
 * toolsByServer：从 harness 工具注册表读出每个 MCP 服务器已注册的工具。
 *
 * 数据源是 `ctx.tools.schemas()`（MCP 客户端把工具注册成 `mcp__<server>__<tool>`）。
 * 重点覆盖**失败原因**：只返回「空」的话，「注册表读不到」与「该服务器没有工具」
 * 在界面上长得一样，而前者可操作、后者只是一个事实。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOL_READ_REASONS, mergeKnownTools, toolReasonText, toolsByServer } from '../src/mcp/tools.js'

/** A fake ctx exposing just the `tools` service the function reads. */
function ctxWith(schemas, { throwOnGet = false, throwOnSchemas = false, noService = false, noApi = false } = {}) {
  const warnings = []
  return {
    warnings,
    get(name) {
      if (throwOnGet) throw new Error('service lookup failed')
      if (name !== 'tools' || noService) return undefined
      if (noApi) return {}
      return {
        schemas() {
          if (throwOnSchemas) throw new Error('parameters are not lossless JSON')
          return schemas
        },
      }
    },
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
  }
}

const SCHEMAS = [
  { name: 'mcp__context7__query-docs', description: 'Query docs' },
  { name: 'mcp__context7__resolve-library-id', description: 'Resolve a package' },
  { name: 'mcp__deepwiki__read_wiki_structure', description: 'Wiki topics' },
  { name: 'read_file', description: 'A built-in tool, not from MCP' },
]

test('成功时按 serverName 归组，且只收该服务器的工具', () => {
  const out = toolsByServer(ctxWith(SCHEMAS), ['context7', 'deepwiki'])
  assert.equal(out.ok, true)
  assert.equal(out.total, 4)
  assert.equal(out.servers.length, 2)
  assert.deepEqual(out.servers[0].tools.map((t) => t.name), [
    'mcp__context7__query-docs',
    'mcp__context7__resolve-library-id',
  ])
  assert.equal(out.servers[1].tools.length, 1)
  // 内置工具不带 mcp__ 前缀，不能被算进任何服务器
  const all = out.servers.flatMap((entry) => entry.tools.map((t) => t.name))
  assert.ok(!all.includes('read_file'))
})

test('前缀不会把相似名字的服务器混在一起', () => {
  const schemas = [
    { name: 'mcp__git__status', description: '' },
    { name: 'mcp__github__status', description: '' },
  ]
  const out = toolsByServer(ctxWith(schemas), ['git', 'github'])
  assert.deepEqual(out.servers[0].tools.map((t) => t.name), ['mcp__git__status'])
  assert.deepEqual(out.servers[1].tools.map((t) => t.name), ['mcp__github__status'])
})

test('已连接但该服务器没有工具：ok=true 且 tools 为空（这不是失败）', () => {
  const out = toolsByServer(ctxWith(SCHEMAS), ['nothere'])
  assert.equal(out.ok, true)
  assert.deepEqual(out.servers, [{ serverName: 'nothere', tools: [] }])
})

test('每种失败都给出各自的原因，而不是笼统的「读不到」', () => {
  assert.equal(toolsByServer(ctxWith(SCHEMAS, { throwOnGet: true }), ['a']).reason, TOOL_READ_REASONS.lookupFailed)
  assert.equal(toolsByServer(ctxWith(SCHEMAS, { noService: true }), ['a']).reason, TOOL_READ_REASONS.serviceMissing)
  assert.equal(toolsByServer(ctxWith(SCHEMAS, { noApi: true }), ['a']).reason, TOOL_READ_REASONS.apiMissing)
  assert.equal(toolsByServer(ctxWith(SCHEMAS, { throwOnSchemas: true }), ['a']).reason, TOOL_READ_REASONS.readFailed)
  assert.equal(toolsByServer(ctxWith('not-an-array'), ['a']).reason, TOOL_READ_REASONS.badShape)
})

test('读取出错时留下告警并带上原始信息，便于排查', () => {
  const throwing = ctxWith(SCHEMAS, { throwOnSchemas: true })
  const out = toolsByServer(throwing, ['a'])
  assert.equal(out.ok, false)
  assert.match(out.detail, /not lossless JSON/)
  assert.equal(throwing.warnings.length, 1)
  assert.match(throwing.warnings[0], /tool registry/)
})

test('每种原因都有中文说明，且互不相同', () => {
  const texts = Object.values(TOOL_READ_REASONS).map((r) => toolReasonText(r))
  assert.equal(new Set(texts).size, texts.length)
  for (const text of texts) {
    assert.ok(text.length > 0 && text !== '工具清单不可读', `原因缺说明: ${text}`)
  }
  // 未知原因退回通用文案，不能是 undefined
  assert.equal(toolReasonText('nonsense'), '工具清单不可读')
})

test('工具按名字排序，描述缺失时给空串', () => {
  const out = toolsByServer(ctxWith([
    { name: 'mcp__s__z', description: undefined },
    { name: 'mcp__s__a', description: 'first' },
  ]), ['s'])
  assert.deepEqual(out.servers[0].tools.map((t) => t.name), ['mcp__s__a', 'mcp__s__z'])
  assert.equal(out.servers[0].tools[0].description, 'first')
  assert.equal(out.servers[0].tools[1].description, '')
})

test('空服务器名被忽略，不会把 mcp____ 前缀算进来', () => {
  const out = toolsByServer(ctxWith(SCHEMAS), ['', 'context7'])
  assert.equal(out.servers.length, 1)
  assert.equal(out.servers[0].serverName, 'context7')
})

test('作用域读取：项目级服务器的工具只在它自己的作用域视图里可见', () => {
  /**
   * 这是「配置了作用域却看不到工具」的根因。
   *
   * `tools.register()` 按**注册上下文的作用域**归档，而 `schemas()` 不带作用域时读的是
   * **全局视图**。项目级服务器被挂进 agent 作用域，它的工具在全局视图里根本不存在 ——
   * 不带作用域去读，每台项目级服务器都会被报成「没有工具」。这里用一个会区分作用域的
   * 假注册表把这个契约钉住。
   */
  const scoped = [
    { name: 'mcp__gitnexus__search', description: 'Search the graph' },
    { name: 'mcp__figma__get_file', description: 'Read a Figma file' },
  ]
  const global = [
    { name: 'mcp__context7__query-docs', description: 'Query docs' },
    { name: 'read_file', description: 'built-in' },
  ]
  const agent = { id: 'agent-1' }
  const seen = []
  const registry = {
    schemas(scope) {
      seen.push(scope)
      return scope === undefined ? global : scope === agent ? scoped : []
    },
  }
  const ctx = { get: (n) => (n === 'tools' ? registry : undefined), logger: { warn() {} } }

  // 全局视图：只有全局注册的工具，项目级的一概看不到（= 修复前的行为）
  const asGlobal = toolsByServer(ctx, ['context7', 'gitnexus'])
  assert.deepEqual(asGlobal.servers[0].tools.map((t) => t.name), ['mcp__context7__query-docs'])
  assert.deepEqual(asGlobal.servers[1].tools, [], '全局视图看不到项目级工具——这正是旧行为')

  // agent 作用域视图：能看到该作用域里注册的工具
  const asAgent = toolsByServer(ctx, ['gitnexus'], agent)
  assert.equal(asAgent.ok, true)
  assert.deepEqual(asAgent.servers[0].tools.map((t) => t.name), ['mcp__gitnexus__search'])

  // 作用域被原样透传（是 agent 对象本身，不是它的名字/id）
  assert.equal(seen[0], undefined)
  assert.equal(seen[1], agent)
})

test('作用域读取：该作用域里没有这个服务器时如实返回空，而不是回退到全局', () => {
  const agent = { id: 'a' }
  const ctx = {
    get: () => ({ schemas: (scope) => (scope === undefined ? SCHEMAS : [{ name: 'mcp__other__x', description: '' }]) }),
    logger: { warn() {} },
  }
  // 若实现错误地回退到全局视图，这里会读到 context7 的工具——那就把「没挂载」说成了「有工具」
  const scoped = toolsByServer(ctx, ['context7'], agent)
  assert.deepEqual(scoped.servers[0].tools, [])
  assert.equal(scoped.ok, true, '空的工具列表是真实答案，不是失败')
})

test('mergeKnownTools：被过滤器挡下的工具也要出现在清单里（否则永远勾不回来）', () => {
  /**
   * 真机 bug（0.5.29）：Tavily 有 5 个工具，用户勾 4 个、保存、重启 —— 第 5 个彻底消失。
   *
   * 原因：allow 模式唯一能让工具不生效的手段是**不让它进注册表**，而面板的勾选框如果只读
   * 注册表，被挡下的那个就永远是"不存在的工具"。所以清单 = 注册表 ∪ 服务器报过的全部工具。
   */
  const registered = [{
    serverName: 'tavily-mcp',
    tools: [
      { name: 'mcp__tavily-mcp__tavily_search', description: 'Search the web' },
      { name: 'mcp__tavily-mcp__tavily_crawl', description: 'Crawl a website' },
    ],
  }]
  const seen = new Map([
    ['tavily-mcp', new Map([
      ['tavily_search', 'Search the web'],
      ['tavily_crawl', 'Crawl a website'],
      ['tavily_extract', 'Extract content from URLs'],
      ['tavily_map', "Map a website's structure"],
      ['tavily_research', 'Deep research'],
    ])],
  ])

  const merged = mergeKnownTools(registered, seen)
  assert.equal(merged.length, 1)
  const names = merged[0].tools.map((tool) => tool.name)
  assert.equal(names.length, 5, `应合并出 5 个工具，实际 ${names.length}：${JSON.stringify(names)}`)
  // 注册表那侧的描述优先（它反映当前这一代连接的实际情况）
  const search = merged[0].tools.find((tool) => tool.name === 'mcp__tavily-mcp__tavily_search')
  assert.equal(search.description, 'Search the web')
  // 只被观察到的那个也有名字，描述来自注册时的定义
  const extract = merged[0].tools.find((tool) => tool.name === 'mcp__tavily-mcp__tavily_extract')
  assert.equal(extract.description, 'Extract content from URLs')
  // 排序稳定：按名字
  assert.deepEqual(names, [...names].sort())
})

test('mergeKnownTools：没有登记记录时原样返回注册表内容', () => {
  const registered = [{ serverName: 'github', tools: [{ name: 'mcp__github__list_issues', description: 'x' }] }]
  assert.deepEqual(mergeKnownTools(registered, new Map()), registered)
  assert.deepEqual(mergeKnownTools(registered, null), registered)
})

