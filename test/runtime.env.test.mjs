/** runtime/env 接口测试：解析/命令解析/环境注入的形态。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bundledRuntime, commandEnv, formatArgs, parseEnv, resolveCommand, spawnEnv, splitArgs } from '../src/runtime/env.js'

test('parseEnv：KEY=VALUE 逐行解析，忽略空行与注释', () => {
  assert.deepEqual(parseEnv('A=1\n\n# c\nB=two=3'), { A: '1', B: 'two=3' })
  assert.deepEqual(parseEnv(''), {})
  assert.deepEqual(parseEnv('NOT_A_PAIR'), {})
})

test('splitArgs：空格分隔，空串得到空数组', () => {
  assert.deepEqual(splitArgs('-y @scope/pkg run x'), ['-y', '@scope/pkg', 'run', 'x'])
  assert.deepEqual(splitArgs('   '), [])
})

test('splitArgs / formatArgs 互为逆运算：含空格与引号的参数原样往返', () => {
  /**
   * 面板把 argv 投影成一行文本再切回来，这个往返必须无损，否则「改个名字」
   * 就会把 `KBase MCP` 这样的目录拆成两个参数，服务器直接起不来。
   */
  const cases = [
    ['-y', '@scope/pkg'],
    ['D:\\WorkSpace\\KBase MCP\\server.py'],
    ["it's"],
    ['a b', 'c'],
    [''],
    ['he said "hi"'],
    ["'quoted'", 'plain'],
  ]
  for (const argv of cases) {
    assert.deepEqual(splitArgs(formatArgs(argv)), argv, `往返失败：${JSON.stringify(argv)}`)
  }
  // 不含空格的普通文本保持裸写，面板里不会凭空多出引号
  assert.equal(formatArgs(['-y', 'pkg']), '-y pkg')
  // 反斜杠不是转义字符：Windows 路径必须原样保留
  assert.deepEqual(splitArgs('D:\\WorkSpace\\a.py'), ['D:\\WorkSpace\\a.py'])
})

test('resolveCommand：含 / 的绝对路径原样返回', () => {
  assert.equal(resolveCommand('/opt/homebrew/bin/npx'), '/opt/homebrew/bin/npx')
})

test('bundledRuntime：存在时给出 node 与 pnpx 路径，不存在返回 null', () => {
  const runtime = bundledRuntime()
  if (runtime === null) return
  assert.match(runtime.node, /node\/bin\/node$/)
  assert.match(runtime.pnpx, /pnpx\.mjs$/)
  assert.equal(runtime.binDir, runtime.node.replace(/\/node$/, ''))
})

test('commandEnv：注入登录 PATH，且不再注入 npm_config_cache', () => {
  const env = commandEnv('npx')
  assert.ok(typeof env.PATH === 'string' && env.PATH.length > 0)
  assert.equal('npm_config_cache' in env, false)
})

test('spawnEnv：合并用户变量，PATH 指向内置 runtime 优先', () => {
  const env = spawnEnv({ TOKEN: 't' })
  assert.equal(env.TOKEN, 't')
  assert.ok(env.PATH.length > 0)
  const runtime = bundledRuntime()
  if (runtime !== null) assert.ok(env.PATH.startsWith(runtime.binDir))
})
