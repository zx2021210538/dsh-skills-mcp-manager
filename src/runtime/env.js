/**
 * Runtime environment helpers for stdio MCP servers.
 *
 * A desktop-launched Host inherits `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, where
 * neither `node` nor `npx` exists, so every stdio child needs the login shell's
 * PATH. npm-family commands must NOT get a redirected cache (see `commandEnv`).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Where `$DSH_HOME` lives. Defaults to `$DSH_HOME` or `~/.dsh`; the plugin entry
 * injects the app's own resolver (which also handles a symlinked home).
 */
let homeResolver = () => process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** Current `$DSH_HOME` (the injected resolver when the host provided one). */
export function dshHome() {
  return homeResolver()
}

/** Inject the host application's home resolver. */
export function setHomeResolver(resolve) {
  if (typeof resolve === 'function') homeResolver = resolve
}

const commandCache = new Map()
/**
 * The user's login shell, or a portable fallback.
 *
 * macOS 桌面端是 zsh，但这里不能写死 `/bin/zsh`：Linux 上它通常不存在，查 PATH 会直接抛错，
 * 于是 stdio MCP 子进程拿不到 PATH（CI 上就是这样挂的）。优先用 `$SHELL`，退回 POSIX sh。
 */
function loginShell() {
  const shell = String(process.env.SHELL ?? '')
  if (shell.startsWith('/') && existsSync(shell)) return shell
  return '/bin/sh'
}

/**
 * Resolve a bare stdio command through the user's login shell.
 *
 * A desktop-launched Host inherits PATH=/usr/bin:/bin:/usr/sbin:/sbin, so `npx`
 * and friends are invisible; an absolute path always passes through untouched.
 */
export function resolveCommand(command) {
  const raw = String(command ?? '')
  if (raw === '' || raw.includes('/')) return raw
  if (commandCache.has(raw)) return commandCache.get(raw)
  let resolved = raw
  try {
    const found = execFileSync(loginShell(), ['-lc', `command -v ${JSON.stringify(raw)}`], { encoding: 'utf8', timeout: 5000 }).trim()
    if (found !== '') resolved = found.split('\n').pop().trim()
  } catch {
    // keep the raw spelling; the spawn error is the user's signal
  }
  commandCache.set(raw, resolved)
  return resolved
}
let cachedLoginPath = null
/** The user's login-shell PATH, resolved once. */
export function loginPath() {
  if (cachedLoginPath !== null) return cachedLoginPath
  let found = ''
  try {
    // `printf %s "$PATH"` 在 sh/bash/zsh 里都成立；原来的 `print -r -- $PATH` 只有 zsh 认。
    const out = execFileSync(loginShell(), ['-lc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5000 }).trim()
    found = out === '' ? '' : out.split('\n').pop().trim()
  } catch (error) {
    // An empty login PATH silently changes how stdio MCP servers resolve npx.
    if (process.env.SMP_DEBUG) console.error('[dsh-skills-mcp-manager] login PATH lookup failed', error)
  }
  // 查不到登录 PATH（Linux 上没有 zsh、`-l` 失败等）时退回本进程的 PATH：
  // 完全不给 PATH 会让 `#!/usr/bin/env node` 的子进程直接死掉，比继承一份不完整的更糟。
  cachedLoginPath = found !== '' ? found : String(process.env.PATH ?? '')
  return cachedLoginPath
}
/**
 * Extra child environment for a stdio server.
 *
 * A desktop-launched Host inherits `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, where
 * neither `node` nor `npx` exists — a spawn of `/opt/homebrew/bin/npx` then dies
 * in its `#!/usr/bin/env node` shebang. So every stdio server gets the login
 * shell's PATH.
 */
/** Parse `KEY=VALUE` lines into a child-environment dict. */
export function parseEnv(text) {
  const out = {}
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at <= 0) continue
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
  }
  return out
}
let cachedRuntime
/** The harness's bundled runtime: Node plus pnpm/pnpx (it ships no npm/npx). */
export function bundledRuntime() {
  if (cachedRuntime !== undefined) return cachedRuntime
  cachedRuntime = null
  try {
    const root = join(homeResolver(), 'dsh-runtimes')
    for (const id of readdirSync(root)) {
      const node = join(root, id, 'dependencies', 'node', 'bin', 'node')
      const pnpx = join(root, id, 'dependencies', 'pnpm', 'bin', 'pnpx.mjs')
      if (existsSync(node) && existsSync(pnpx)) {
        cachedRuntime = { node, pnpx, binDir: dirname(node) }
        break
      }
    }
  } catch {
    // no bundled runtime: fall back to the login shell
  }
  return cachedRuntime
}
export function commandEnv(command) {
  const env = {}
  const path = loginPath()
  if (path !== '') env.PATH = path
  // NOTE: do not inject npm_config_cache here. A redirected cache makes
  // `npx -y <pkg>` die silently inside the app's child environment (verified:
  // same binary + same cache works from a login shell, fails when spawned by
  // the Host, while dropping the variable starts the server immediately).
  // npm-family commands therefore use the user's own cache; when that cache has
  // root-owned leftovers, fix it with `sudo chown -R $(whoami) ~/.npm`.
  return env
}
/**
 * Space-separated argument text -> argv list.
 *
 * ## 为什么要认引号
 *
 * 面板把一个 stdio 行的 argv 投影成**一行空格分隔的文本**（`configuredMcpRows`），编辑后再
 * 由这里切回数组。这个往返对有空格参数是**有损**的：`D:\…\KBase MCP\server.py` 是一个目录，
 * 切完却成了两个参数 —— 表现为「只改了个名字，kbase 就连不上了」。
 *
 * 所以投影侧（{@link formatArgs}）给需要保护的参数加引号，这一侧认引号：
 * `'…'` 内的内容原样保留，`"…"` 内的内容认 `\"` 转义。反斜杠**不是**转义字符 ——
 * 这是一份 Windows 优先的配置，`D:\WorkSpace\…` 必须原样往返。
 */
export function splitArgs(text) {
  const input = String(text ?? '')
  const out = []
  let current = ''
  let quote = ''
  let started = false
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (quote !== '') {
      if (quote === '"' && char === '\\' && input[index + 1] === '"') {
        current += '"'
        index += 1
        continue
      }
      if (char === quote) {
        quote = ''
        continue
      }
      current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        out.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started) out.push(current)
  return out
}

/**
 * argv list -> the panel's one-line text, as the exact inverse of {@link splitArgs}.
 *
 * A bare argument is written bare; one that contains whitespace or a quote is wrapped so
 * that reading the text back yields the same list. Without this the form's own projection
 * could not round-trip, and saving an unrelated field would rewrite the array with the
 * directory name split at its space.
 */
export function formatArgs(args) {
  const list = Array.isArray(args) ? args : []
  return list.map((value) => {
    const text = String(value)
    if (text === '') return "''"
    if (!/[\s'"]/.test(text)) return text
    // 没有双引号 → 用双引号包起来，内部的单引号不必转义；含双引号 → 转义后再包。
    if (!text.includes('"')) return `"${text}"`
    return `"${text.replaceAll('"', '\\"')}"`
  }).join(' ')
}
/**
 * Child environment written into a profile row.
 *
 * A desktop-launched Host runs with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, where
 * `node` does not exist — a row with `command: npx` would die in its
 * `#!/usr/bin/env node` shebang. Writing the bundled runtime's bin directory in
 * front of the login PATH makes such a row work with no host-side patching.
 */
export function spawnEnv(extra) {
  const env = { ...(extra ?? {}) }
  const runtime = bundledRuntime()
  const path = runtime !== null ? `${runtime.binDir}:${loginPath() || '/usr/bin:/bin'}` : loginPath()
  if (path !== '') env.PATH = path
  return env
}
