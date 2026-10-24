/**
 * `!!js` 表达式的无损写回 —— 这个 bug 的回归测试。
 *
 * ## 被钉住的 bug
 *
 * 在面板里编辑一张卡片并保存（**哪怕只改 `serverName`**），该行 `config.env` /
 * `config.headers` 里的 `!!js` 表达式会被重写成普通字符串：
 *
 *     env:
 *       TAVILY_API_KEY: !!js process.env.TAVILY_API_KEY   →   TAVILY_API_KEY: process.env.TAVILY_API_KEY
 *
 * `dsh-mcp-client` 会把字面量 `"process.env.TAVILY_API_KEY"` 当作真实密钥发给下游，
 * 于是 401、按退避策略重试、最终该 server 在界面上永久失效。两条链共同致病：
 *
 *   1. **门控被兜底抵消**：`commonFields()` 每次编辑都带上 `env` 文本，而 Host 侧的
 *      `else if (op.env !== '')` 把「字段非空」误当成「用户改过」，`envChanged` 保护形同虚设；
 *   2. **整段替换**：`setRowConfigField('env', plainObject)` 用一份新的普通对象替换
 *      整个子树的节点，tag 随之消失。
 *
 * 这里同时覆盖两条链的返回值：既断言「只改名字时文件只差一行」，也断言「真的改了某个
 * 键时，其它键的表达式一个字节都不动」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { applyRowOp, setPatchIO, YAML_JS_TAG } from '../src/patch/apply.js'
import { draftFromRow, updateServerOp } from '../lib/src/crud/servers.js'

const PATCH = `# header comment that must survive
- insert:
    - id: mcp-tavily
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: tavily_search
        transport: stdio
        command: tavily-mcp
        cwd: !!js process.cwd()
        env:
          TAVILY_API_KEY: !!js process.env.TAVILY_API_KEY
          DEBUG_LEVEL: info
        failOnStartupError: true

    # a comment inside the insert list, between two rows
    - id: mcp-kbase
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: kbase
        transport: stdio
        command: 'D:\\WorkSpace\\.venv\\Scripts\\python.exe'
        args: [ 'D:\\WorkSpace\\KBase MCP\\server.py' ]
        cwd: !!js process.cwd()

- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: github
    transport: streamable-http
    url: https://api.githubcopilot.com/mcp/
    headers:
      Authorization: !!js "'Bearer ' + process.env.GITHUB_PERSONAL_ACCESS_TOKEN"
`

const scratchBackup = mkdtempSync(join(tmpdir(), 'smp-tags-bak-'))
let writes = 0

/** 注入直通锁与计数原子写：`writes` 因此能回答「这次到底有没有落盘」。 */
const usePlainIO = () => {
  writes = 0
  setPatchIO({
    withFileLock: (_key, run) => run(),
    writeFileAtomic: async (path, text) => {
      writes += 1
      writeFileSync(path, text, 'utf8')
    },
    backupDir: () => scratchBackup,
  })
}

const makeProfile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'smp-tags-'))
  writeFileSync(join(dir, 'cordis.patch.yml'), PATCH)
  writeFileSync(join(dir, 'package.json'), '{}\n')
  return { dir, path: join(dir, 'cordis.patch.yml') }
}

const ctxFor = (dir) => ({ get: (name) => (name === 'profileContext' ? { dir } : undefined), logger: { info() {}, warn() {} } })

const read = (path) => readFileSync(path, 'utf8')

/** `!!js` 出现次数：任何一次标签丢失都会让它变小。 */
const jsCount = (text) => (text.match(/!!js/g) ?? []).length

/** 逐行位置比较（仅在前后行数相同时有意义）。 */
const differing = (before, after) => {
  const left = before.split('\n')
  const right = after.split('\n')
  assert.equal(right.length, left.length, '这个用例里行数不该变化')
  const out = []
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) out.push({ index, before: left[index], after: right[index] })
  }
  return out
}

/** 写回的文件必须仍然能被 `!!js` 感知的解析器读回。 */
const assertValid = (text) => {
  const document = parseDocument(text, { customTags: [YAML_JS_TAG] })
  assert.deepEqual(document.errors, [], '写回后必须是合法 YAML')
}

test('只改 serverName：env 里的 !!js、cwd 表达式、注释全部逐字保留，diff 只有一行', async () => {
  usePlainIO()
  const { dir, path } = makeProfile()
  const before = read(path)

  // 走客户端真实路径：面板行 → draft → 只改名字 → op
  const row = {
    entryId: 'mcp-tavily', serverName: 'tavily_search', transport: 'stdio',
    command: 'tavily-mcp', args: '', env: 'TAVILY_API_KEY=process.env.TAVILY_API_KEY\nDEBUG_LEVEL=info',
    headersText: '', runtime: 'system', failOnStartupError: true,
  }
  const draft = draftFromRow(row)
  draft.serverName = 'tavily_renamed'
  const op = updateServerOp(row.entryId, draft, row)

  // 回归钉子：面板**每次都带上** env 文本（`commonFields()` 无条件包含它），
  // 但 `envChanged` 是 false。旧实现正是被 `op.env !== ''` 的兜底分支骗了过去。
  assert.equal(op.envChanged, false, '没动过 env，客户端必须算出 false')
  assert.match(op.env, /TAVILY_API_KEY=process\.env\.TAVILY_API_KEY/, '但文本照样随请求发出')

  await applyRowOp(ctxFor(dir), op)
  const after = read(path)

  const changed = differing(before, after)
  assert.equal(changed.length, 1, `只该有一行变化，实际：${JSON.stringify(changed)}`)
  assert.match(changed[0].after, /serverName: tavily_renamed/)
  assert.equal(jsCount(after), jsCount(before), '!!js 数量不得变化')
  assert.match(after, /TAVILY_API_KEY: !!js process\.env\.TAVILY_API_KEY/, '表达式必须保持 !!js')
  assert.match(after, /cwd: !!js process\.cwd\(\)/, '未在面板字段表里的 cwd 更不能被动')
  assertValid(after)
})

test('只改 serverName（http 行）：headers 里的 !!js 同样不被冲掉', async () => {
  usePlainIO()
  const { dir, path } = makeProfile()
  const before = read(path)
  const row = {
    entryId: 'mcp-github', serverName: 'github', transport: 'streamable-http',
    url: 'https://api.githubcopilot.com/mcp/', command: '', args: '', env: '',
    headersText: "Authorization='Bearer ' + process.env.GITHUB_PERSONAL_ACCESS_TOKEN",
    runtime: 'system',
  }
  const draft = draftFromRow(row)
  draft.serverName = 'github_renamed'
  const op = updateServerOp(row.entryId, draft, row)
  assert.equal(op.headersChanged, false)

  await applyRowOp(ctxFor(dir), op)
  const after = read(path)
  assert.equal(differing(before, after).length, 1)
  assert.match(after, /Authorization: !!js "'Bearer ' \+ process\.env\.GITHUB_PERSONAL_ACCESS_TOKEN"/)
  assertValid(after)
})

test('env 加一条新变量：原有 !!js 保留，新键写成普通字符串', async () => {
  usePlainIO()
  const { dir, path } = makeProfile()
  await applyRowOp(ctxFor(dir), {
    op: 'update', entryId: 'mcp-tavily', serverName: 'tavily_search', transport: 'stdio',
    command: 'tavily-mcp',
    env: 'TAVILY_API_KEY=process.env.TAVILY_API_KEY\nDEBUG_LEVEL=info\nEXTRA_VAR=hello',
    envChanged: true,
  })
  const after = read(path)
  assert.match(after, /TAVILY_API_KEY: !!js process\.env\.TAVILY_API_KEY/, '没动过的键必须保留 tag')
  assert.match(after, /EXTRA_VAR: hello/)
  assert.doesNotMatch(after, /EXTRA_VAR: !!js/, '新键是用户填的字面量，不该被当成表达式')
  assertValid(after)
})

test('env 删一条：只删该键，另一个键（含 !!js）不受影响', async () => {
  usePlainIO()
  const { dir, path } = makeProfile()
  const before = read(path)
  await applyRowOp(ctxFor(dir), {
    op: 'update', entryId: 'mcp-tavily', serverName: 'tavily_search', transport: 'stdio',
    command: 'tavily-mcp',
    env: 'TAVILY_API_KEY=process.env.TAVILY_API_KEY',
    envChanged: true,
  })
  const after = read(path)
  assert.doesNotMatch(after, /DEBUG_LEVEL/)
  assert.match(after, /TAVILY_API_KEY: !!js process\.env\.TAVILY_API_KEY/)
  assert.equal(jsCount(after), jsCount(before), '删除普通键不该减少表达式数量')
  assertValid(after)
})

test('改表达式原文：写回新的 !!js 表达式，而不是把它固化成字面量', async () => {
  usePlainIO()
  const { dir, path } = makeProfile()
  await applyRowOp(ctxFor(dir), {
    op: 'update', entryId: 'mcp-tavily', serverName: 'tavily_search', transport: 'stdio',
    command: 'tavily-mcp',
    env: 'TAVILY_API_KEY=process.env.TAVILY_KEY_ROTATED\nDEBUG_LEVEL=info',
    envChanged: true,
  })
  const after = read(path)
  // 用户在表达式输入框里改原文，语义仍然是「这是个表达式」
  assert.match(after, /TAVILY_API_KEY: !!js process\.env\.TAVILY_KEY_ROTATED/)
  assert.doesNotMatch(after, /TAVILY_API_KEY: process\.env\.TAVILY_KEY_ROTATED/)
  assertValid(after)
})

test('显式 `!!js ` 前缀：把一个普通键升级成表达式', async () => {
  usePlainIO()
  const { dir, path } = makeProfile()
  await applyRowOp(ctxFor(dir), {
    op: 'update', entryId: 'mcp-tavily', serverName: 'tavily_search', transport: 'stdio',
    command: 'tavily-mcp',
    env: 'TAVILY_API_KEY=process.env.TAVILY_API_KEY\nDEBUG_LEVEL=!!js process.env.DEBUG_LEVEL',
    envChanged: true,
  })
  const after = read(path)
  assert.match(after, /DEBUG_LEVEL: !!js process\.env\.DEBUG_LEVEL/, '显式前缀是「我要写表达式」的出口')
  assert.doesNotMatch(after, /DEBUG_LEVEL: !!js !!js/, '前缀本身不该被写进表达式原文')
  assertValid(after)
})

test('headers 改表达式：保持 !!js；清空则整个键移除', async () => {
  usePlainIO()
  const { dir, path } = makeProfile()
  const before = read(path)

  await applyRowOp(ctxFor(dir), {
    op: 'update', entryId: 'mcp-github', serverName: 'github', transport: 'streamable-http',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: "Authorization='Bearer ' + process.env.GH_PAT_2", headersChanged: true,
  })
  let after = read(path)
  assert.match(after, /Authorization: !!js "'Bearer ' \+ process\.env\.GH_PAT_2"/)
  assertValid(after)

  await applyRowOp(ctxFor(dir), {
    op: 'update', entryId: 'mcp-github', serverName: 'github', transport: 'streamable-http',
    url: 'https://api.githubcopilot.com/mcp/', headers: '', headersChanged: true,
  })
  after = read(path)
  assert.doesNotMatch(after, /Authorization/)
  assert.doesNotMatch(after, /headers/, '清空即删键，不留 `headers: {}`')
  assert.equal(jsCount(after), jsCount(before) - 1)
})

test('toggle：文件里只多一行 disabled', async () => {
  usePlainIO()
  const { dir, path } = makeProfile()
  const before = read(path)
  await applyRowOp(ctxFor(dir), { op: 'toggle', entryId: 'mcp-github', enabled: false })
  const after = read(path)
  assert.equal(after.replace(/^\s*disabled: true\n/m, ''), before, '除新增的 disabled 行外必须逐字相同')
  assertValid(after)
})

test('编辑没有 env 的行：args 里带空格的路径不会被拆成两个参数', async () => {
  /**
   * 面板把 argv 投影成**一行空格分隔的文本**，编辑后再切回数组。`KBase MCP` 是一个目录，
   * 早期实现切完变成两个参数 —— 表现为「只改了个名字，kbase 就连不上了」。投影与解析现在
   * 互为逆运算（`formatArgs` / `splitArgs`），所以没改过的 args 原样往返。
   */
  usePlainIO()
  const { dir, path } = makeProfile()
  const before = read(path)
  await applyRowOp(ctxFor(dir), {
    op: 'update', entryId: 'mcp-kbase', serverName: 'kbase_renamed', transport: 'stdio',
    command: 'D:\\WorkSpace\\.venv\\Scripts\\python.exe',
    // 这是 `formatArgs(['D:\WorkSpace\KBase MCP\server.py'])` 的产出
    args: '"D:\\WorkSpace\\KBase MCP\\server.py"',
    envChanged: false,
  })
  const after = read(path)
  const changed = differing(before, after)
  assert.equal(changed.length, 1, `只该改名字，实际：${JSON.stringify(changed)}`)
  assert.match(after, /args: \[ 'D:\\WorkSpace\\KBase MCP\\server\.py' \]/, '含空格的参数必须仍是**一个**')
  assert.match(after, /cwd: !!js process\.cwd\(\)/)
  assertValid(after)
})

test('旧客户端（不发送 envChanged）在未改动 env 时也不破坏 tag', async () => {
  /**
   * 兜底分支存在的意义是兼容旧面板。即使走那条路径，只要文本与文件里的一致，
   * 键级合并也会跳过该键 —— 兼容不等于必须写坏。
   */
  usePlainIO()
  const { dir, path } = makeProfile()
  const before = read(path)
  await applyRowOp(ctxFor(dir), {
    op: 'update', entryId: 'mcp-tavily', serverName: 'tavily_renamed', transport: 'stdio',
    command: 'tavily-mcp',
    env: 'TAVILY_API_KEY=process.env.TAVILY_API_KEY\nDEBUG_LEVEL=info',
    // 没有 envChanged 字段
  })
  const after = read(path)
  assert.equal(differing(before, after).length, 1)
  assert.match(after, /TAVILY_API_KEY: !!js process\.env\.TAVILY_API_KEY/)
})

test('什么都没改的保存不写盘、不滚动备份、不惊动 Loader 重载', async () => {
  usePlainIO()
  const { dir, path } = makeProfile()
  const before = read(path)
  const result = await applyRowOp(ctxFor(dir), {
    op: 'update', entryId: 'mcp-tavily', serverName: 'tavily_search', transport: 'stdio',
    command: 'tavily-mcp', args: '', env: 'TAVILY_API_KEY=process.env.TAVILY_API_KEY\nDEBUG_LEVEL=info',
    envChanged: false,
  })
  assert.equal(result, true, '行存在就是成功')
  assert.equal(writes, 0, '一个字节都没变就不该写盘')
  assert.equal(read(path), before)
})

test('不存在的行：更新必须抛错且文件一字未改', async () => {
  usePlainIO()
  const { dir, path } = makeProfile()
  const before = read(path)
  await assert.rejects(
    () => applyRowOp(ctxFor(dir), { op: 'update', entryId: 'mcp-ghost', serverName: 'x', transport: 'stdio', command: 'y', envChanged: true, env: '' }),
    /not found/,
  )
  assert.equal(read(path), before)
  assert.equal(writes, 0)
})
