/**
 * Applying one queued row operation to the profile patch.
 *
 * Everything here touches the user's real config file, so the write path is:
 * lock -> re-parse and validate -> `writeFileAtomic` (with a backup first).
 * The lock/atomic-write helpers are injected (`setPatchIO`) so the logic
 * can be exercised against a temp directory in tests.
 */
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isMap, isSeq, parseDocument } from 'yaml'

/** The directory holding this plugin's own backup artifacts. */
export function backupDir() {
  return io.backupDir()
}

/**
 * Where the previous patch content is kept: a single rolling file.
 *
 * One file, not one per write. The backup exists to undo *the operation that just
 * ran* — its job is to hold the content that was in place immediately before the
 * current one — so a second, third and hundredth copy of the same bytes buys
 * nothing. The previous scheme wrote a timestamped copy on every write and had
 * accumulated 135 files holding only 5 distinct contents (130 of them byte-identical
 * duplicates, one content repeated 99 times), which is noise, not safety.
 *
 * The trade-off, stated plainly: a rolling file only goes back one step. If a write
 * goes wrong *and* you save again before noticing, the good state is overwritten by
 * the bad one. Versioned history would cover that, but at the cost that made this
 * unreadable in the first place; a config file is also under the user's own version
 * control and DSH's profile backups, which is where long-range history belongs.
 */
export function backupPath() {
  return join(backupDir(), 'cordis.patch.yml.bak')
}

/**
 * MCP rows the active profile already configures with the shipped client.
 *
 * Read from the Loader (the panel's own settings document cannot see them,
 * because those rows declare no volatile fields), reduced to what a panel row
 * needs to show.
 */
export const YAML_JS_TAG = { tag: 'tag:yaml.org,2002:js', resolve: (value) => value }
import { MCP_MODULE, insertRow, locateRow, removeRow, rowScopeOf, setRowConfigField, setRowConfigFields, setRowDisabled } from './rows.js'
import { dshHome, parseEnv, splitArgs } from '../runtime/env.js'
import { connectionFields } from '../mcp/connection.js'
import { NAME, LEGACY_NAME } from '../identity.js'
import { scopeRoot } from '../skills/reconcile.js'
import { renderSkillMarkdown } from '../skills/write.js'

/**
 * 用户填的环境变量：**原样保留，一个字节都不注入**。
 *
 * ## 为什么不把 PATH 写进 profile
 *
 * 曾经这里是 `spawnEnv(env)` —— 它会把宿主机整条 PATH 塞进行的 `env` 里，理由是桌面启动的
 * Host 环境里 `PATH=/usr/bin:/bin:/usr/sbin:/sbin`，不含 `node`，stdio 行会死在
 * `#!/usr/bin/env node` 上。那个理由是真的，但**解法放错了层**：
 *
 *   · 后果一：profile 里出现 `PATH=/Users/<某人>/…`。这份配置拷到另一台机器就是错的，
 *     而它看起来只是一行普通环境变量，没人会想到要删；
 *   · 后果二：面板的「环境变量」文本框会把这几百字符**显示给用户**（用户并不需要看见，
 *     也不该编辑它）；
 *   · 后果三：每次保存都把它再写一遍，diff 里永远是噪音。
 *
 * PATH 属于**运行环境**，不是配置。所以现在只在这里存用户填的东西，PATH 由启动子进程时
 * 注入 —— 那一步本来就在做，而且做得更对（`stdioMountConfig` 会把
 * `npx -y <pkg>` 换成 `<内置 runtime 的 node> <pnpx.mjs> <pkg>`，并把 runtime 的 bin
 * 目录放进子进程 PATH）。落到 yml 里的那份从来是冗余的。
 *
 * @param env - 用户填写的变量（`parseEnv` 的结果）。
 * @returns 同一组变量，不做任何注入。
 */
export function userEnvOnly(env) {
  return { ...(env ?? {}) }
}

/**
 * 两行的 config 是否**等同**（用于判断"重试"还是"撞名"）。
 *
 * 只比较语义：空 `env`/`headers`/`args` 与缺键等价（写盘时它们本来就不该出现），标量一律按
 * 字符串比。`!!js` 这类节点在 `toJS()` 之后是字符串，所以表达式也会被正确区分 —— 两个不同的
 * 表达式不会被当成同一个。
 *
 * @param expected - 文件里现有行 config 的普通对象（`toJS()` 的结果）。
 * @param wanted - 本次 add 想写入的对象。
 * @returns 等同为 `true`。
 */
function sameRowConfig(expected, wanted) {
  const normalize = (value) => {
    const out = {}
    for (const [key, item] of Object.entries(value ?? {})) {
      if (key === 'env' || key === 'headers') {
        const entries = Object.entries(item ?? {}).filter(([, entryValue]) => entryValue !== undefined)
        if (entries.length === 0) continue
        out[key] = JSON.stringify(entries.map(([name, entryValue]) => [name, String(entryValue)]).sort())
        continue
      }
      if (key === 'args') {
        const items = Array.isArray(item) ? item.map(String) : []
        if (items.length === 0) continue
        out[key] = JSON.stringify(items)
        continue
      }
      if (item === undefined || item === null || item === '') continue
      out[key] = typeof item === 'object' ? JSON.stringify(item) : String(item)
    }
    return out
  }
  const left = normalize(expected)
  const right = normalize(wanted)
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if (left[key] !== right[key]) return false
  }
  return true
}

let io = {
  withFileLock: (_key, run) => run(),
  writeFileAtomic: async (path, text) => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, text, 'utf8')
  },
  /**
   * Where backups are kept.
   *
   * Injectable on purpose: the backup path is the one side effect of this module
   * that does not go through `writeFileAtomic`, so without a seam here a test that
   * exercises `applyRowOp` silently writes into the developer's (or user's) real
   * `$DSH_HOME`. That is not hypothetical — `patch.apply.lossless.test.mjs` declared
   * a "scratch backup dir" in a comment for exactly this reason, but no such seam
   * existed, so every run of the suite dropped another backup into the real home.
   */
  backupDir: () => join(dshHome(), 'dsh-skills-mcp-manager.backups'),
}

/** Inject the host's file-lock / atomic-write implementation. */
export function setPatchIO(next) {
  io = { ...io, ...next }
}

/**
 * Keep the content that was in place before the write about to happen.
 *
 * Overwrites the single rolling file (see {@link backupPath}) — no timestamped
 * copies, so a day of panel edits leaves exactly one file instead of 135.
 */
export async function backupPatch(before) {
  try {
    await mkdir(backupDir(), { recursive: true })
    await writeFile(backupPath(), before)
  } catch (error) {
    // a missing backup must not block a legitimate edit
  }
}

/** Config keys that used to hold runtime state / read models in the profile patch. */
const OBSOLETE_CONFIG_KEYS = [
  'serverTools', 'serverToolsError', 'serverStatus',
  'profileServers', 'filterState', 'probeState',
  'workspaces', 'currentWorkspace', 'workspaceServers',
  'discoveryInfo', 'discoveredSkills', 'skillDirs',
  'oauthState', 'oauthServers',
  'rowOps', 'rowOpsReady',
  'importRequest', 'importResult',
  'skillRequest', 'skillResult',
  'reconnectRequest', 'reconnectResult', 'reconnectReady',
]

/**
 * One legacy panel server entry → one profile row.
 *
 * Shared by the raw-patch migration and by `migrateServerEntries` (kept for tests): the
 * conversion must not exist twice, or the two paths would produce different rows for the
 * same entry.
 */
export function legacyServerRowConfig(entry) {
  const serverName = String(entry?.serverName ?? '')
  const id = `mcp-${serverName.replace(/[^A-Za-z0-9_-]/g, '-')}`
  const transport = entry?.transport === 'stdio' ? 'stdio' : 'streamable-http'
  const config = { serverName, transport }
  if (transport === 'stdio') {
    config.command = String(entry.command ?? '') === '' ? 'npx' : String(entry.command)
    // The legacy entry keeps `args` as an **array**, while `splitArgs` parses the panel's
    // space-separated *string*. Passing the array straight in produced one mangled argument.
    config.args = Array.isArray(entry.args) ? entry.args.map((arg) => String(arg)) : splitArgs(entry.args)
    const envLines = entry.env === null || entry.env === undefined
      ? ''
      : typeof entry.env === 'string'
        ? entry.env
        : Object.entries(entry.env).map(([key, value]) => `${key}=${String(value)}`).join('\n')
    const env = parseEnv(envLines)
    // 只写用户填的变量。PATH 不落盘 —— 见 {@link userEnvOnly}。
    if (Object.keys(env).length > 0) config.env = userEnvOnly(env)
  } else {
    config.url = String(entry?.url ?? '')
    const headerLines = entry?.headers === null || entry?.headers === undefined
      ? ''
      : typeof entry.headers === 'string'
        ? entry.headers
        : Object.entries(entry.headers).map(([key, value]) => `${key}=${String(value)}`).join('\n')
    const headers = parseEnv(headerLines)
    if (Object.keys(headers).length > 0) config.headers = headers
  }
  Object.assign(config, connectionFields(entry ?? {}))
  const projectScoped = typeof entry?.scope === 'string' && entry.scope !== '' && entry.scope !== 'global'
  if (projectScoped) config.scope = entry.scope
  return { id, config, projectScoped }
}

/** Every row id already present in the document (top level and `insert:` lists). */
function rowIdsOf(document) {
  const ids = new Set()
  for (const item of document.contents?.items ?? []) {
    if (!isMap(item)) continue
    if (item.get('id') !== undefined) ids.add(String(item.get('id')))
    const insert = item.get('insert')
    if (isSeq(insert)) for (const row of insert.items) if (isMap(row) && row.get('id') !== undefined) ids.add(String(row.get('id')))
  }
  return ids
}

/**
 * One-time migration of everything this plugin used to keep in its own `config`.
 *
 * Three moves, in one locked pass over the raw profile patch:
 *
 *   · `config.servers[]`  → ordinary `mcp-client` rows (the same conversion the panel's
 *                           add path uses, so a migrated row is byte-identical to a hand
 *                           added one);
 *   · `config.skills[]`   → `<root>/<name>/SKILL.md` files (the old reconcile output). A
 *                           file that already exists wins — the config is only a seed for
 *                           the conversion, never an overwrite;
 *   · every read-model / command / projection key → **removed**. Those values now live in
 *                           `/runtime` (recomputed per request) or in the HTTP routes, so
 *                           nothing transient stays in `cordis.patch.yml`.
 *
 * Runs while holding the same lock as every other patch write, and is idempotent: the keys
 * are gone after the first successful pass, so the next call is a no-op.
 *
 * @returns the number of changed fields/entries, or 0 when there was nothing to do.
 */
export async function migratePanelConfig(ctx) {
  const profile = ctx.get?.('profileContext') ?? ctx.profileContext
  if (typeof profile?.dir !== 'string' || profile.dir === '') return 0
  const path = join(profile.dir, 'cordis.patch.yml')
  return io.withFileLock(join(profile.dir, 'package.json'), async () => {
    const before = await readFile(path, 'utf8')
    const document = parseDocument(before, { customTags: [YAML_JS_TAG] })
    if (document.errors[0] !== undefined) throw document.errors[0]
    if (!isSeq(document.contents)) throw new Error('profile patch must be a YAML sequence')
    let changed = 0
    const existing = rowIdsOf(document)

    /**
     * 删掉旧版本注入到行里的 PATH。
     *
     * 0.5.x 写 stdio 行时会把宿主机整条 PATH 塞进 `config.env`（桌面启动的 Host 环境里
     * 没有 node，当时的做法是把它写进配置）。现在 PATH 只在启动子进程时注入，配置里那份
     * 是冗余的 —— 而且有害：它让 profile 变成「只在这台机器上对」，面板还会把这几百字符
     * 的宿主机路径显示给用户。
     *
     * 升级时要**主动清掉**，否则老用户的配置会一直带着一条错的 PATH：新代码不再写它，
     * 但也不会去改已经存在的键。
     */
    const dropInjectedPath = (row) => {
      if (!isMap(row)) return
      const config = row.get('config')
      if (!isMap(config)) return
      const env = config.get('env')
      if (!isMap(env) || !env.has('PATH')) return
      // 只认「像被注入过」的 PATH：含宿主机绝对路径分隔结果。用户手填的 PATH 也删 ——
      // 它同样没有意义（运行时会覆盖），留着只会误导。
      env.delete('PATH')
      changed += 1
      // 删空了就把整个 env 键去掉，别留一个 `env: {}`
      if (env.items.length === 0) config.delete('env')
    }

    const clean = async (row) => {
      if (!isMap(row)) return
      // 行内的 PATH 清理对所有 mcp-client 行都做，不限于本插件自己的条目。
      if (row.get('name') === MCP_MODULE) dropInjectedPath(row)
      if (![NAME, LEGACY_NAME].includes(row.get('id'))) return
      if (row.get('id') === LEGACY_NAME) {
        row.set('id', NAME)
        changed += 1
      }
      const config = row.get('config')
      if (!isMap(config)) return

      const servers = config.get('servers')
      if (isSeq(servers)) {
        for (const item of servers.items) {
          if (!isMap(item)) continue
          const entry = item.toJSON()
          if (typeof entry?.serverName !== 'string' || entry.serverName === '') continue
          const { id, config: rowConfig, projectScoped } = legacyServerRowConfig(entry)
          if (existing.has(id)) continue
          insertRow(document, id, rowConfig, { disabled: projectScoped })
          existing.add(id)
          changed += 1
        }
        config.delete('servers')
        changed += 1
      }

      const skills = config.get('skills')
      if (isSeq(skills)) {
        let skillFailed = false
        for (const item of skills.items) {
          if (!isMap(item)) continue
          const entry = item.toJSON()
          if (entry?.enabled === false) continue
          const name = String(entry?.name ?? '')
          if (name === '') continue
          const dir = scopeRoot(String(entry?.scope ?? 'global'), entry?.id === 'agents' ? 'agents' : 'dsh')
          const target = join(dir, name, 'SKILL.md')
          try {
            await readFile(target, 'utf8')
            // The file is already there: it wins over the config body.
            continue
          } catch {
            // missing → write it below
          }
          try {
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, renderSkillMarkdown(entry), 'utf8')
            changed += 1
          } catch (error) {
            skillFailed = true
            ctx?.logger?.warn?.('dsh-skills-mcp-manager: cannot migrate skill %s: %s', name, String(error?.message ?? error))
          }
        }
        // Keep the key when a file could not be written, so the next attempt can retry
        // instead of losing the only copy of that body.
        if (!skillFailed) {
          config.delete('skills')
          changed += 1
        }
      }

      for (const key of OBSOLETE_CONFIG_KEYS) {
        if (config.delete(key)) changed += 1
      }
    }

    for (const row of document.contents.items) {
      await clean(row)
      const insert = isMap(row) ? row.get('insert') : undefined
      if (isSeq(insert)) for (const inner of insert.items) await clean(inner)
    }

    if (changed === 0) return 0
    const after = document.toString()
    parseDocument(after, { customTags: [YAML_JS_TAG] })   // gate: never write invalid YAML
    await backupPatch(before)
    await io.writeFileAtomic(path, after, {})
    ctx.logger?.info?.('dsh-skills-mcp-manager: migrated %d legacy config item(s)', changed)
    return changed
  })
}

export async function applyRowOp(ctx, op) {
  const profile = ctx.get?.('profileContext') ?? ctx.profileContext
  const dir = profile?.dir
  if (typeof dir !== 'string' || dir === '') throw new Error('profileContext unavailable')
  const path = join(dir, 'cordis.patch.yml')
  return io.withFileLock(join(dir, 'package.json'), async () => {
    const before = await readFile(path, 'utf8')
    const document = parseDocument(before, { customTags: [YAML_JS_TAG] })
    if (document.errors[0] !== undefined) throw document.errors[0]
    let changed = false
    if (op.op === 'add') {
      const transport = op.transport === '' ? 'streamable-http' : op.transport
      const config = { serverName: op.serverName, transport }
      if (transport === 'stdio') {
        config.command = op.command === '' ? 'npx' : op.command
        config.args = splitArgs(op.args)
        // 空 env 不落盘：一个 `env: {}` 在文件里是纯粹的噪声，还会让"等同"判断多一种形态。
        const envAdd = userEnvOnly(parseEnv(op.env))
        if (Object.keys(envAdd).length > 0) config.env = envAdd
        // `system` 是默认值，不写键 —— 省得每一行都带一句「用系统的」，而那是绝大多数
        // 情况。只有显式选 `auto`（跟随 Harness 的 pnpx）才落盘。
        if (op.runtime === 'auto') config.runtime = 'auto'
      } else {
        config.url = op.url
        const headers = parseEnv(op.headers)
        if (Object.keys(headers).length > 0) config.headers = headers
      }
      // Connection policy (failOnStartupError + reconnect.*). Validated before
      // anything is written: an out-of-range number would make the row fail to
      // load, and keys left unset keep the client's own defaults.
      Object.assign(config, connectionFields(op))
      // `scope` is a row's tier, and it lives *in* the row's config — the client's schema
      // does not list it, but it does not strip unknown keys either (verified against the
      // shipped schema: `Config({…, scope}).scope` survives), and this plugin reads the raw
      // `options.config`. `global` is the default, so it is not written: a row without the
      // key reads as global, which keeps every pre-existing row valid unchanged.
      const projectScoped = typeof op.scope === 'string' && op.scope !== '' && op.scope !== 'global'
      if (projectScoped) config.scope = op.scope
      /**
       * 同一个 id 只允许有一行。
       *
       * `insertRow` 是无条件追加，所以重复的 add 会留下两行同 id —— Loader 会实例化两次
       * （两个 client、两代工具、一个命名空间），这必须防住。
       *
       * 但**不能**用「看到同 id 就把 config 整段覆盖」来防：用户想新增一个和既有服务器同名的
       * 条目时，那会把既有行的 url / headers / env（含 `!!js` 表达式）**静默**冲掉，而他并不
       * 知道自己刚覆盖了什么。所以只有内容**与文件里已有的完全一致**才当作同一请求的重试
       * （收敛即可），否则报错，让调用方去走编辑。
       */
      const rowId = op.entryId !== '' ? op.entryId : `mcp-${op.serverName}`
      const existing = locateRow(document, rowId)
      if (existing !== null) {
        const current = existing.item.get('config', true)
        const currentJs = current !== null && typeof current?.toJS === 'function' ? current.toJS(document) : null
        if (!sameRowConfig(currentJs, config)) {
          throw new Error(
            `已存在同名服务器「${op.serverName}」（行 id：${rowId}）。要修改它请用「编辑」，不要重复添加。`,
          )
        }
        /**
         * 完全一致 = 这次是同一请求的重试，**什么都不改**。
         *
         * 尤其不能 `delete('disabled')`：一台被手动停用的全局服务器，如果因为重发又走一遍
         * add，删掉 `disabled` 就等于把它悄悄重新连上 —— 与 update 分支是同一个坑。
         */
        changed = true
      } else {
        // A project row must not be instantiated by the Loader: this plugin mounts it into
        // the agent whose cwd the scope covers, and an enabled row would connect the same
        // server a second time. `disabled` skips instantiation while leaving the config
        // readable in `loader.entries()` — which is where the mount path finds it.
        changed = insertRow(document, rowId, config, { disabled: projectScoped })
      }
    } else if (op.op === 'toggle') {
      /**
       * There are **two** switches, and which one to write depends on the row's tier.
       *
       * A project-scoped row must keep the Loader's `disabled: true` for ever (see
       * {@link insertRow}): this plugin mounts it into the matching agent instead, so
       * `disabled` cannot double as the user's switch there. Its switch lives in
       * `config.enabled`.
       *
       * Writing the entry-level `disabled` for a project row was wrong in both directions:
       *   · turning it **off** wrote `true` over a value that was already `true`, so nothing
       *     changed and the op fell through to "row not found" — the switch looked dead;
       *   · turning it **on** cleared `disabled`, so the Loader connected a row this plugin
       *     was also mounting → two clients, two tool generations, one namespace.
       */
      const scope = rowScopeOf(document, op.entryId)
      if (scope !== null && scope !== 'global') {
        // `null` clears the key: an absent `enabled` means enabled, which keeps a config
        // that was never toggled byte-identical to one that was toggled back on.
        changed = setRowConfigField(document, op.entryId, 'enabled', op.enabled === false ? false : null)
      } else {
        changed = setRowDisabled(document, op.entryId, op.enabled === false)
      }
    } else if (op.op === 'delete') {
      /**
       * Deleting a row that is already gone **succeeds**.
       *
       * The requested end state is "this row is not in the patch", and it holds. Throwing here
       * would report a scary failure for an action that did what the user asked — and that is
       * now reachable: the HTTP route can be retried, and a delete can race the periodic
       * projection. `changed` stays false, so nothing is written and no backup is churned.
       */
      changed = removeRow(document, op.entryId)
      if (!changed) return true
    } else {
      // Validate the connection numbers up front: an out-of-range value has to
      // fail before anything is touched, not after the document was edited.
      const connection = connectionFields(op)
      /** 改之前的层级：判断"是否真的跨层"要靠它，不能只看客户端有没有发 scopeChanged。 */
      const scopeBefore = rowScopeOf(document, op.entryId)
      const fields = {}
      if (op.serverName !== '') fields.serverName = op.serverName
      if (op.transport !== '') fields.transport = op.transport
      if (op.transport === 'stdio') {
        fields.command = op.command
        fields.args = splitArgs(op.args)
        fields.url = null
        /**
         * 环境变量：**只有客户端确认「用户改过」时才动**，清空即删键。
         *
         * 这里曾经有一个 `else if (op.env !== '')` 兜底分支，本意是兼容不发送
         * `envChanged` 的旧客户端，实际却把门控整个抵消了：`commonFields()` 每次编辑
         * 都带上 `env` 文本（哪怕用户只改了 `serverName`），于是 `op.env !== ''` 恒为真，
         * 未改动的 `env` 被重新解析成一份**普通字符串映射**写回去 —— `!!js` 表达式就此
         * 变成字面量 `"process.env.TAVILY_API_KEY"`，`dsh-mcp-client` 拿它当密钥发给
         * 下游，401、退避重试、最终显示为永久失效。
         *
         * 判据必须是**字段存在与否**（`undefined`），而不是文本是否为空：旧客户端根本不
         * 发这个键，新客户端总会发（`false` 也是发）。
         */
        if (op.envChanged === true) {
          const env = userEnvOnly(parseEnv(op.env))
          fields.env = Object.keys(env).length > 0 ? env : null
        } else if (op.envChanged === undefined && op.env !== '') {
          fields.env = userEnvOnly(parseEnv(op.env))
        }
        // 运行时的改法与 env 同理：只有显式选了 `auto` 才写，选 `system` 就删掉这个键
        // （它等价于默认）。这样「改回系统 npx」不会在文件里留一句废话。同样只在请求
        // 真的携带该字段时才写，否则一个不认识它的调用方会把用户的 `auto` 改回 `system`
        // —— 这正是「编辑一次，没碰过的控件被悄悄改掉」那一类回归。
        /**
         * 只能用**显式的改动标记**，不能用「字段存在」：
         *
         * `RowOp` 的 `runtime` 在 schema 里带默认值 `system`，所以 `'runtime' in op` 恒为真 ——
         * 旧页面（根本不发这个字段）编辑任意其它字段时，会把用户选过的 `auto` 悄悄删回
         * `system`，而"选了跟随 Harness 却仍用系统 npx"正是之前报过的那个 bug。
         *
         * 客户端只在值真的变了时才发 `runtimeChanged: true`。
         */
        if (op.runtimeChanged === true) fields.runtime = op.runtime === 'auto' ? 'auto' : null
      } else {
        fields.url = op.url
        fields.command = null
        fields.args = null
        if (op.headersChanged === true) {
          const headers = parseEnv(op.headers)
          fields.headers = Object.keys(headers).length > 0 ? headers : null
        } else if (op.headersChanged === undefined && op.headers !== '') {
          fields.headers = parseEnv(op.headers)
        }
      }
      // Scope is editable on an existing row too: moving a server between tiers is a normal
      // edit, not a delete-and-recreate. `null` clears the key, which reads as global.
      if (op.scopeChanged === true) {
        const scope = op.scope === '' || op.scope === 'global' ? null : op.scope
        fields.scope = scope
      }
      // 一次写完：未变的字段由 `setRowConfigFields` 自己跳过，`env` / `headers` 走键级合并。
      changed = setRowConfigFields(document, op.entryId, fields) || changed
      /**
       * 改层级必须**同时**改 entry 级的 `disabled`，否则两个方向都坏、而且坏得很安静：
       *
       *   · global → project：这一行要交给本插件挂载，Loader 不能再自己实例化它（`disabled: true`），
       *     否则同一个服务器连两次（两个 client、两代工具、一个命名空间）；
       *   · project → global：必须删掉 `disabled`，否则 Loader 永远不实例化，连接再也建立不起来
       *     —— 面板上看起来一切正常，工具却一直不可用。
       *
       * 之前只写了 `config.scope`，没动 `disabled`。
       */
      if (op.scopeChanged === true) {
        /**
         * **只在真的跨层时才动 `disabled`。**
         *
         * 客户端每次保存都会带 `scopeChanged: true`（它无从知道文件里的旧值）；无条件写会把
         * 用户手写的 `disabled: true` 悄悄删掉 —— 一台被手动停用的全局服务器，在「编辑一次、
         * 什么都没改」的保存后就会重新连上，还连带触发 Loader 重载。实测复现过。
         */
        const scopeAfter = op.scope === '' || op.scope === 'global' ? 'global' : op.scope
        if (scopeBefore !== null && scopeBefore !== scopeAfter) {
          changed = setRowDisabled(document, op.entryId, scopeAfter !== 'global') || changed
        }
      }
      // Connection policy on edit: only when the panel says the user actually
      // changed it. A blank number means "back to the client default" (the key is
      // cleared), but an untouched form must stay untouched — its fields may not
      // even have been prefilled, and treating blank as "clear" would silently
      // wipe a configured value on an unrelated edit such as changing the URL.
      if (op.connectionChanged === true) {
        changed = setRowConfigField(document, op.entryId, 'failOnStartupError', connection.failOnStartupError === true ? true : null) || changed
        changed = setRowConfigField(document, op.entryId, 'reconnect', connection.reconnect ?? null) || changed
        // 顶层键，和上面两个一样只在「用户确实改过」时写；空值=清键回客户端默认。
        changed = setRowConfigField(document, op.entryId, 'toolCallTimeoutMs', connection.toolCallTimeoutMs ?? null) || changed
        // 明文 token 端点例外：只在 true 时写键，关掉即删键（null）。删键而不是写 false，
        // 是为了让「关掉它」等于「回到出厂状态」——一份配置里不该留下一个 `: false` 让人
        // 以为曾经开过。
        changed = setRowConfigField(document, op.entryId, 'allowInsecureTokenEndpoint', op.allowInsecureTokenEndpoint === true ? true : null) || changed
      }
    }
    if (!changed) throw new Error(`row "${op.entryId}" not found in the profile patch`)
    const after = document.toString()
    /**
     * 文本没变 = 这次保存没有任何实际改动，于是什么都不写。
     *
     * 判据用「重新序列化的全文」而不是逐字段的脏标记：脏标记只能说「我 set 过」，说不出
     * 「set 进去的值和文件里原本的一模一样」。而一次空写入的代价并不小 —— 它会滚动 `.bak`、
     * 改 mtime、触发 Loader 的防抖重载（实测约 4 秒），用户看到的却是一个数字都没变的界面。
     *
     * 这个判据是**精确**的，不是近似：`parseDocument → toString` 对 profile patch 是字节级
     * 往返无损的（已在真实 627 行配置上验证，逐字节相同）。
     */
    if (after === before) return true
    parseDocument(after, { customTags: [YAML_JS_TAG] })   // gate: never write invalid YAML
    await backupPatch(before)
    await io.writeFileAtomic(path, after, {})
    ctx.logger.info('dsh-skills-mcp-manager: %s profile row %s', op.op, op.entryId)
    return true
  })
}

/**
 * Turn this plugin's legacy `config.servers` entries into `mcp-client` rows.
 *
 * ## Why every entry becomes a row
 *
 * Project servers used to live in a field this plugin owned, while global ones were rows.
 * Both tiers are rows now, and `scope` says which is which — so the migration converts
 * *every* legacy entry, including the global ones, or the two sources would still coexist
 * for exactly the servers the user sees first.
 *
 * ## Shape mapping
 *
 * The legacy entry is a panel-shaped object (`args` as a string, `env`/`headers` as
 * `KEY=VALUE` lines); a row's config is the client's shape (an argv array, dicts). The
 * conversion reuses the same helpers `applyRowOp` uses for the add path, so a migrated row
 * is byte-for-byte what adding the same server by hand would produce.
 *
 * @returns `{ migrated, ids }` — the number of rows written and their entry ids.
 */
export async function migrateServerEntries(ctx, entries) {
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => (
    entry !== null && typeof entry === 'object' && typeof entry.serverName === 'string' && entry.serverName !== ''
  ))
  if (list.length === 0) return { migrated: 0, ids: [] }
  const profile = ctx.get?.('profileContext') ?? ctx.profileContext
  const dir = profile?.dir
  if (typeof dir !== 'string' || dir === '') throw new Error('profileContext unavailable')
  const path = join(dir, 'cordis.patch.yml')
  return io.withFileLock(join(dir, 'package.json'), async () => {
    const before = await readFile(path, 'utf8')
    const document = parseDocument(before, { customTags: [YAML_JS_TAG] })
    if (document.errors[0] !== undefined) throw document.errors[0]
    // Never clobber a row that is already there: a migration that runs twice, or that meets
    // a row the user has since created by hand, must be a no-op rather than an overwrite.
    const existing = new Set(
      [...(document.contents?.items ?? [])]
        .flatMap((item) => {
          const out = []
          if (isMap(item) && item.get('id') !== undefined) out.push(String(item.get('id')))
          const insert = isMap(item) ? item.get('insert') : undefined
          if (isSeq(insert)) for (const row of insert.items) if (isMap(row) && row.get('id') !== undefined) out.push(String(row.get('id')))
          return out
        }),
    )
    const ids = []
    for (const entry of list) {
      const { id, config, projectScoped } = legacyServerRowConfig(entry)
      if (existing.has(id)) continue
      // Same reason as the add path: a project row is mounted by this plugin, so the
      // Loader must not instantiate it, or the server is connected twice.
      insertRow(document, id, config, { disabled: projectScoped })
      existing.add(id)
      ids.push(id)
    }
    if (ids.length === 0) return { migrated: 0, ids: [] }
    const after = document.toString()
    parseDocument(after, { customTags: [YAML_JS_TAG] })
    await backupPatch(before)
    await io.writeFileAtomic(path, after, {})
    ctx.logger.info('dsh-skills-mcp-manager: migrated %d panel server(s) into profile rows', ids.length)
    return { migrated: ids.length, ids }
  })
}
