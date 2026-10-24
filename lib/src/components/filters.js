/**
 * Filtering helpers for the panel's search box.
 *
 * The panel searches by NAME only (a deliberate choice: matching description or
 * body made hits feel random), case-insensitively.
 *
 * The list-level helpers that used to live here (`filterByName`,
 * `serversForScope`) had no call sites left — the panel filters inline with
 * `matchesName` — so they were removed rather than kept alive by their tests.
 */

/** Name-only match, case-insensitive; an empty query matches everything. */
export function matchesName(name, query) {
  const needle = (query ?? '').trim().toLowerCase()
  if (needle === '') return true
  if (typeof name !== 'string') return false
  return name.toLowerCase().includes(needle)
}

/** Tab counters, with the "0" case spelled out for the UI. */
export function tabLabel(title, count) {
  // 全角括号：与面板既有渲染一致（'MCP（5）'）
  return `${title}（${count}）`
}
