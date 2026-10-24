import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zipSync } from 'fflate'
import { assertZipWithinLimit, declaredUnzippedBytes } from '../src/skills/zipLimit.js'
import { createGovernanceProvider } from '../src/skills/provider.js'

/** 造一个只有 EOCD 的最小 zip 头，用来喂 ZIP64 占位符。 */
function eocdWith({ entries = 1, cdSize = 0, cdOffset = 0 }) {
  const bytes = new Uint8Array(22)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x06054b50, true)
  view.setUint16(8, entries, true)
  view.setUint16(10, entries, true)
  view.setUint32(12, cdSize, true)
  view.setUint32(16, cdOffset, true)
  return bytes
}

/** 在真实 zip 里定位 EOCD（测试用来就地篡改字段 / 插入伪结构）。 */
function eocdOffset(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = bytes.length - 22; at >= 0; at -= 1) {
    if (view.getUint32(at, true) !== 0x06054b50) continue
    if (at + 22 + view.getUint16(at + 20, true) === bytes.length) return at
  }
  return -1
}

test('ZIP64：中央目录偏移是 0xFFFFFFFF 时必须判超限（否则体积闸门整闸放行）', () => {
  const zip64 = eocdWith({ cdSize: 0xffffffff, cdOffset: 0xffffffff })
  assert.equal(declaredUnzippedBytes(zip64), Number.POSITIVE_INFINITY)
  assert.throws(() => assertZipWithinLimit(zip64), /ZIP64/)
})

test('provider：快照失败时沿用上一次结果，并把原因写给日志', async () => {
  let calls = 0
  const logs = []
  const provider = createGovernanceProvider({
    log: (message) => logs.push(message),
    snapshot: async () => {
      calls += 1
      if (calls === 1) return { skills: [{ name: 'alpha', description: '', enabled: true, source: 'user-dsh', path: '/h/a/SKILL.md', rank: 399 }] }
      throw new Error('EBUSY: state.json')
    },
  })
  const first = await provider.list()
  assert.deepEqual(first.map((item) => item.name), ['alpha'])
  const second = await provider.list()
  assert.deepEqual(second.map((item) => item.name), ['alpha'], '失败时不能把技能列表清空')
  assert.equal(logs.length, 1, '失败必须留一行日志（否则用户查不到原因）')
  assert.match(logs[0], /EBUSY/)
})

test('伪造包一：把 EOCD 的总条目数（+10）改成 0 不能放行', () => {
  /**
   * 复查发现的第一条绕过路径。
   *
   * 闸门原来读 EOCD+10（总条目数），`fflate` 读 EOCD+8（本盘条目数）。造一个 +8 不变、
   * +10 改成 0 的包：我们一个条目都不数 → total 0 → 放行；fflate 照样按 +8 全解出来。
   * 现在两处不一致直接 fail-closed（分卷归档本来就不该出现在这里）。
   */
  const zip = zipSync({ 'big.bin': new Uint8Array(1024 * 1024) })
  const eocd = eocdOffset(zip)
  assert.ok(eocd > 0, '找不到 EOCD')
  const forged = Uint8Array.from(zip)
  const view = new DataView(forged.buffer)
  view.setUint16(eocd + 10, 0, true)
  assert.equal(declaredUnzippedBytes(forged), Number.POSITIVE_INFINITY)
  assert.throws(() => assertZipWithinLimit(forged, 1024))
})

test('伪造包二：经典 EOCD 前面挂 ZIP64 定位符不能放行', () => {
  /**
   * 第二条绕过路径：经典 EOCD 指向一个 0 条目的伪中央目录（total 0 → 放行），
   * 真正的条目由 ZIP64 结构描述。所以"EOCD 前 20 字节是 ZIP64 定位符"本身就是拒绝理由。
   */
  const zip = zipSync({ 'big.bin': new Uint8Array(1024 * 1024) })
  const eocd = eocdOffset(zip)
  const locator = new Uint8Array(20)
  new DataView(locator.buffer).setUint32(0, 0x07064b50, true)
  const forged = new Uint8Array(zip.length + 20)
  forged.set(zip.slice(0, eocd), 0)
  forged.set(locator, eocd)
  forged.set(zip.slice(eocd), eocd + 20)
  assert.equal(declaredUnzippedBytes(forged), Number.POSITIVE_INFINITY)
  assert.throws(() => assertZipWithinLimit(forged, 1024))
})

test('正常小包仍然放行（闸门不能把合法输入一起挡掉）', () => {
  const zip = zipSync({
    'a/SKILL.md': new TextEncoder().encode('hello'),
    'b.txt': new TextEncoder().encode('world'),
  })
  assert.equal(declaredUnzippedBytes(zip), 10)
  assert.doesNotThrow(() => assertZipWithinLimit(zip))
  // 空归档（0 个条目）也算正常输入
  const empty = zipSync({})
  assert.equal(declaredUnzippedBytes(empty), 0)
})

test('declaredUnzippedBytes：读得出真实压缩包的未压缩总量', () => {
  const zip = zipSync({ 'a/SKILL.md': new TextEncoder().encode('hello'), 'b.txt': new TextEncoder().encode('world') })
  assert.equal(declaredUnzippedBytes(zip), 10)
  // 短到连 EOCD 都装不下的输入：算不出来也不算异常（交给 fflate 去报格式错误）
  assert.equal(declaredUnzippedBytes(new Uint8Array([1, 2, 3, 4])), 0)
})

test('算不出总量时必须 fail-closed：尾随字节 / 非 zip / 截断的中央目录', () => {
  /**
   * 这条钉的是**闸门的方向**。
   *
   * `fflate` 的解压是"从尾部回溯签名"，对尾随字节很宽容：一个末尾多 1 字节的包，
   * 我们按 `at + 22 + 注释长度 === 文件长度` 找不到 EOCD，但 fflate 照样能正常解开。
   * 这里如果返回 0（=放行），体积闸门对"算不出来的包"就完全失效了。
   */
  const zip = zipSync({ 'a.txt': new TextEncoder().encode('0123456789') })

  // ① 尾部多 1 字节：EOCD 不再是最后一个结构
  const trailing = new Uint8Array(zip.length + 1)
  trailing.set(zip, 0)
  assert.equal(declaredUnzippedBytes(trailing), Number.POSITIVE_INFINITY)
  assert.throws(() => assertZipWithinLimit(trailing), /ZIP64|超过/)

  // ② 长度够但完全不是 zip（≥22 字节，绕不过早返回）
  const garbage = new Uint8Array(64).fill(0x41)
  assert.equal(declaredUnzippedBytes(garbage), Number.POSITIVE_INFINITY)
  assert.throws(() => assertZipWithinLimit(garbage))

  // ③ EOCD 正常但中央目录被截断：算不出来同样拒绝
  const truncated = zip.slice(0, zip.length - 30)
  assert.equal(declaredUnzippedBytes(truncated), Number.POSITIVE_INFINITY)
})

test('assertZipWithinLimit：超限抛错，未超限放行', () => {
  const zip = zipSync({ 'a.txt': new TextEncoder().encode('0123456789') })
  assert.doesNotThrow(() => assertZipWithinLimit(zip))
  assert.throws(() => assertZipWithinLimit(zip, 5), /超过/)
})

