/**
 * Form copy for servers and skills: hint texts and the skill field list.
 *
 * The hint texts are part of the product copy (they explain the accepted shape
 * of each field), so they live here with tests pinning them.
 *
 * The client-side validators that used to live here (`serverFieldDefs`,
 * `isValidName`, `validateServerDraft`, `validateSkillDraft`, `fieldApplies`)
 * were removed: the panel never called them — the Host validates every write
 * and reports the reason in the dialog — so they were dead code that only
 * their own tests kept alive.
 */

/** Hint texts, kept in one place because they are user-facing copy. */
export const HINTS = {
  serverName: '例如 context7，最多 32 字符',
  command: 'npx',
  args: '-y @scope/pkg@latest',
  env: 'TEST_TOKEN=sk-xxxxxxx\n多个变量一行一个，例如：\nAPI_KEY=sk-abc\nREGION=cn',
  url: 'https://…/mcp',
  headers: 'Authorization=Bearer sk-xxxxxxx\n多个请求头一行一个，用等号连接（与 Host 的解析一致）',
  project: '请选择项目',
}

/** Fields of a skill form. */
export function skillFieldDefs() {
  return [
    { key: 'name', label: '技能名', hint: '例如 code-review，最多 64 字符' },
    { key: 'description', label: '描述', hint: '一句话说明这个技能做什么' },
    { key: 'body', label: '正文（SKILL.md）', kind: 'textarea' },
  ]
}
