/**
 * components/form 接口测试：用户可见文案（提示语）与技能表单字段定义。
 *
 * 这里曾经还测过 `serverFieldDefs` / `isValidName` / `validateServerDraft` /
 * `validateSkillDraft` / `fieldApplies`。那五个导出没有任何调用方（面板的校验在
 * Host 侧，失败原因由 Host 回传并显示在对话框里），只为这组测试而存在，所以随导出一起
 * 删掉了 —— 给死代码留测试只会让「删掉它」的成本越来越高。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HINTS, skillFieldDefs } from '../lib/src/components/form.js'

test('文案被固定住：名称提示与环境变量示例', () => {
  assert.equal(HINTS.serverName, '例如 context7，最多 32 字符')
  assert.match(HINTS.env, /^TEST_TOKEN=sk-xxxxxxx/)
  assert.match(HINTS.env, /多个变量一行一个/)
  assert.equal(HINTS.project, '请选择项目')
})

test('skillFieldDefs：名称/描述/正文', () => {
  assert.deepEqual(skillFieldDefs().map((f) => f.key), ['name', 'description', 'body'])
})
