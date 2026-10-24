/**
 * Profile-patch row surgery: locating rows and editing them in place.
 *
 * Pure functions over a parsed `yaml` document — no cordis context, no file IO.
 * The file-level concerns (locking, backup, validation) live in `applyRowOp`,
 * which calls into this module.
 */
import { isMap, isScalar, isSeq, Scalar } from 'yaml'

/** The shipped MCP client every managed row instantiates. */
export const MCP_MODULE = '@deepseek-ai/dsh-mcp-client'

/** Tag a `!!js` expression carries in the profile patch (see `YAML_JS_TAG` in `apply.js`). */
export const JS_TAG = 'tag:yaml.org,2002:js'

/**
 * 每个字段「什么都没配」的写法。
 *
 * 保存时最刺眼的噪音是「用户没动这个字段，文件里却凭空长出一个空壳」：`args: []`、
 * `env: {}`。它们在语义上等于「这个键不存在」，所以判等时两者必须视为同一件事，
 * 否则一次只改名字的保存也会给 stdio 行添上一行 `args: []`。
 */
const EMPTY_VALUE = { env: {}, headers: {}, args: [], reconnect: null }

/** A second `!!js` spelling a user may type into the panel: the explicit opt-in form. */
const EXPLICIT_EXPRESSION = /^!!js\s+/

/** Find a row by id, whether it sits at the top level or inside an `insert:` list. */
export function locateRow(document, rawEntryId) {
  const entryId = String(rawEntryId).replace(/^include:/, '')
  const tops = document.contents
  if (!isSeq(tops)) throw new Error('profile patch must be a YAML sequence')
  for (const [index, item] of tops.items.entries()) {
    if (!isMap(item)) continue
    if (document.getIn([index, 'id']) === entryId) return { container: tops, index, item, place: 'top' }
    const insert = item.get('insert')
    if (!isSeq(insert)) continue
    for (const [inner, row] of insert.items.entries()) {
      if (isMap(row) && row.get('id') === entryId) return { container: insert, index: inner, item: row, place: 'insert' }
    }
  }
  return null
}

/** Drop one row, and the now-empty `insert:` directive that carried it. */
export function removeRow(document, entryId) {
  const found = locateRow(document, entryId)
  if (found === null) return false
  found.container.items.splice(found.index, 1)
  if (found.place === 'insert' && found.container.items.length === 0) {
    const tops = document.contents
    const outer = tops.items.findIndex((item) => isMap(item) && item.get('insert') === found.container)
    if (outer >= 0) tops.items.splice(outer, 1)
  }
  return true
}

/**
 * A YAML node reduced to the plain value it stands for.
 *
 * `config.get(field)` **unwraps scalars** (an ordinary string comes back as a string,
 * which is why tags are invisible to it); `config.get(field, true)` returns the node.
 * Every caller below needs the node, so `keepScalar` is always on.
 */
function plainOf(node) {
  if (node === undefined) return undefined
  if (isScalar(node)) return node.value
  return node.toJSON()
}

/** Structural equality over the plain values a patch field can hold. */
function samePlain(left, right) {
  if (left === right) return true
  if (left === null || right === null || left === undefined || right === undefined) return false
  if (typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left)) {
    return left.length === right.length && left.every((item, index) => samePlain(item, right[index]))
  }
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => Object.hasOwn(right, key) && samePlain(left[key], right[key]))
}

/**
 * Whether writing `value` over `node` would change nothing.
 *
 * Absent and empty are the same state: a row without `env` and a row with `env: {}`
 * mean the same thing, so adding the shell is not an edit the user made.
 */
function equivalent(field, node, value) {
  const empty = Object.hasOwn(EMPTY_VALUE, field) ? EMPTY_VALUE[field] : null
  const wanted = value === null || value === undefined ? empty : value
  const current = node === undefined ? empty : plainOf(node)
  return samePlain(current, wanted)
}

/** An existing key holding a `!!js` expression. */
const isExpression = (node) => isScalar(node) && node.tag === JS_TAG

/**
 * The node to write for one `env` / `headers` value.
 *
 * ## Why an expression has to stay an expression
 *
 * The tag is not decoration: `!!js process.env.TAVILY_API_KEY` is evaluated by the
 * Loader, while the same text without the tag is the literal string
 * `"process.env.TAVILY_API_KEY"` — which `dsh-mcp-client` would cheerfully send as
 * the secret, producing a 401 and a server that stays broken.
 *
 * So a key whose value the user **did not touch** keeps its node untouched (that is
 * `mergeStringMap`'s early exit), and a key whose expression the user **did** edit
 * keeps the `!!js` tag: editing an expression is not how one asks for a literal.
 * Writing a literal where an expression used to be needs an escape hatch, and the
 * escape hatch is the other direction: a plain value stays plain unless it is spelled
 * with an explicit `!!js ` prefix.
 */
function scalarFor(text, wasExpression) {
  const explicit = EXPLICIT_EXPRESSION.test(text)
  if (!explicit && !wasExpression) return text
  const scalar = new Scalar(explicit ? text.replace(EXPLICIT_EXPRESSION, '') : text)
  scalar.tag = JS_TAG
  return scalar
}

/**
 * Key-level merge for `env` / `headers`.
 *
 * A whole-map `set` replaces the subtree, and a replacement node carries no tags: that
 * is how one unrelated edit used to flatten every `!!js` expression in the row. Here
 * the map node stays the one from the file, so only the pairs that actually differ are
 * touched and every other pair — expression, quoting, order — is preserved verbatim.
 *
 * Deleting a key is still a delete: the pair the user removed from the textarea is
 * removed from the map, and an emptied map takes its own key with it (no `env: {}`).
 */
function mergeStringMap(config, field, value) {
  const wanted = value ?? {}
  const node = config.get(field, true)
  if (!isMap(node)) {
    if (Object.keys(wanted).length > 0) config.set(field, wanted)
    return
  }
  for (const pair of [...node.items]) {
    const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key)
    if (!Object.hasOwn(wanted, key)) node.delete(key)
  }
  for (const [key, text] of Object.entries(wanted)) {
    const existing = node.get(key, true)
    // 原文一致就是「没改过」：连节点都不碰，tag 与引号随之保留。
    if (isScalar(existing) && String(existing.value) === text) continue
    node.set(key, scalarFor(text, isExpression(existing)))
  }
  if (node.items.length === 0) config.delete(field)
}

/**
 * Write a set of `config` fields into one row, touching only what really changes.
 *
 * Invariants this upholds (see the module docs): an untouched field keeps its original
 * node, so `!!js` expressions, comments and key order survive an edit that never
 * mentioned them. `value === null` means "clear this key", `undefined` means "this
 * request says nothing about it" — the two must not be conflated, or a caller that
 * omits a field would silently delete a configured value.
 *
 * @returns `false` only when the row itself is missing.
 */
export function setRowConfigFields(document, entryId, fields) {
  const found = locateRow(document, entryId)
  if (found === null) return false
  let config = found.item.get('config')
  if (!isMap(config)) {
    if (Object.values(fields).every((value) => value === undefined)) return true
    found.item.set('config', {})
    config = found.item.get('config')
  }
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (field === 'env' || field === 'headers') {
      mergeStringMap(config, field, value)
      continue
    }
    const existing = config.get(field, true)
    if (equivalent(field, existing, value)) continue
    if (value === null) config.delete(field)
    else config.set(field, value)
  }
  return true
}

/** Set or clear one field inside a row's `config`, creating the map when absent. */
export function setRowConfigField(document, entryId, field, value) {
  return setRowConfigFields(document, entryId, { [field]: value })
}

/**
 * The row's `config.scope`, or null when the row does not exist.
 *
 * An absent scope means `global` (that is what the plugin's own model assumes), so callers
 * can compare against {@link GLOBAL_SCOPE} without special-casing the empty string.
 */
export function rowScopeOf(document, entryId) {
  const found = locateRow(document, entryId)
  if (found === null) return null
  const config = found.item.get('config')
  if (!isMap(config)) return 'global'
  const scope = config.get('scope')
  return typeof scope === 'string' && scope !== '' ? scope : 'global'
}

/** Enable/disable a whole row (the Loader's own `disabled` flag). */
export function setRowDisabled(document, entryId, disabled) {
  const found = locateRow(document, entryId)
  if (found === null) return false
  if (disabled) found.item.set('disabled', true)
  else found.item.delete('disabled')
  return true
}

/**
 * Append a fresh mcp-client row to the patch's first `insert:` instruction.
 *
 * `disabled` is written for a **project-scoped** row: the Loader instantiates every row it
 * is not told to skip, and a project row must not be connected by the Loader — this plugin
 * mounts it into the agent whose working directory the row's `scope` covers. Leaving it
 * enabled would connect the same server twice (two clients, two tool generations, one
 * namespace). A disabled row still appears in `loader.entries()` with its config intact
 * (`disabled` is an entry getter, not a filter on the store), which is exactly what the
 * mount path needs to read.
 */
export function insertRow(document, id, config, options = {}) {
  const row = { id, name: MCP_MODULE, config }
  if (options.disabled === true) row.disabled = true
  const contents = document.contents
  if (isSeq(contents)) {
    for (const item of contents.items) {
      if (isMap(item)) {
        const existing = item.get('insert', true)
        if (isSeq(existing)) {
          existing.add(row)
          return true
        }
      }
    }
    contents.add({ insert: [row] })
    return true
  }
  // Empty (or non-sequence) document: start a fresh sequence.
  document.contents = document.createNode([{ insert: [row] }])
  return true
}
