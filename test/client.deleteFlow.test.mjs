/**
 * 技能写路由的失败面（与具体列表形态无关的部分）。
 *
 * 这个文件原先还覆盖「卡片上的删除流程」，但 0.5.23 把平铺卡片列表并进了来源分组视图，
 * 那套交互（`…` 菜单 + 确认对话框 + 乐观墓碑）已经不存在了。**这里的取舍是明说的**：
 * 与其留一份测着已删除 UI 的测试，不如只保留仍然成立的断言 —— 删除现在走回收站，
 * 由 `skills.trash.test.mjs` 与治理路由的用例覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootPanel, emptyDoc, skipWithoutBundle, textOf } from '../scripts/lib/client-harness.mjs'

test('技能写入：路由返回 404 时报错，不回退设置队列', { skip: skipWithoutBundle() }, async () => {
  const panel = await bootPanel(emptyDoc(), {
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  })
  const { doc, byClass, byText, click, change, restore } = panel
  try {
    click(panel.find((node) => String(node.props.className ?? '').includes('smp-tab') && textOf(node).startsWith('Skills')))
    click(byClass('smp-button', '添加技能'))
    change(panel.byPlaceholder('例如 my-skill'), 'fallback-skill')
    click(byText('创建'))
    await panel.settle()
    assert.equal(doc.skillRequest?.op ?? '', '', '不该再写设置队列')
    assert.deepEqual(doc.skillCommands ?? [], [], '404 不该被当成写入成功')
    assert.match(panel.text(), /没有技能写入路由/, '失败原因要显示出来')
  } finally {
    restore()
  }
})
