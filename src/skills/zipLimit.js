/**
 * 解压前的体积闸门。
 *
 * ## 为什么需要
 *
 * `fflate` 的 `unzipSync` 会把**全部条目一次性**解到内存。一个几十 KB 的压缩包可以合法地
 * 声明并展开成几 GB（zip bomb），直接把 Host 主进程卡死或打爆内存 —— 而这两处解压的输入
 * 都来自**网络**（远程仓库 zip、市场下载的技能包），不是用户自己的文件。
 *
 * ## 为什么不用解压后再检查
 *
 * 那就晚了：内存已经炸了。所以在解压**之前**读 zip 中央目录里声明的未压缩大小求和 ——
 * 这些字段是压缩包自己写的，可以被伪造得很小，但正常压缩包不会；我们要拦的是"一眼就不对"
 * 的包，而不是做安全对抗（真正的对抗要流式解压 + 边解边计数）。
 *
 * 顺带一提：`unzipSync` 本身对畸形输入会抛错，这个闸门只管体积。
 */

/** 允许的未压缩总量（比任何真实技能包都宽：256 MB）。 */
export const MAX_UNZIPPED_BYTES = 256 * 1024 * 1024

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
/** ZIP64 结尾定位符（紧挨在经典 EOCD 前面 20 字节处）。 */
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
/** EOCD 固定 22 字节 + 最多 65535 字节注释。 */
const EOCD_MAX_SCAN = 22 + 0xffff

/**
 * 从 zip 中央目录读出所有条目声明的未压缩大小之和。
 *
 * @param bytes - zip 内容。
 * @returns 总字节数；**算不出来时返回 `POSITIVE_INFINITY`**（fail-closed：闸门的存在
 *   意义就是拦住异常输入，算不出总量就必须拒绝，而不是当 0 放行）。唯一例外是长度
 *   短到连 EOCD 都放不下（< 22 字节）—— 那种输入 fflate 自己就会报格式错误。
 */
export function declaredUnzippedBytes(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (data.length < 22) return 0
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  // 从尾部往前找 EOCD：结尾可能有注释，所以最多回退 64KB。
  let eocd = -1
  const stop = Math.max(0, data.length - EOCD_MAX_SCAN)
  for (let at = data.length - 22; at >= stop; at -= 1) {
    if (view.getUint32(at, true) !== EOCD_SIGNATURE) continue
    /**
     * 必须同时核对注释长度：EOCD 是**最后一个**结构，`at + 22 + 注释长度` 应正好等于文件长度。
     * 只认签名的回溯会被"注释里恰好含 PK\x05\x06"的包骗到 —— 命中假 EOCD 后 count/offset
     * 变成 0、总量算成 0，体积闸门整闸放行（实测可复现，而威胁模型正是网络下载的包）。
     */
    if (at + 22 + view.getUint16(at + 20, true) !== data.length) continue
    eocd = at
    break
  }
  /**
   * 找不到 EOCD 时**按超限处理**（fail-closed）。
   *
   * 这里原来返回 0（=放行），而 `fflate` 的解压是"从尾部回溯签名"、对尾随字节很宽容 ——
   * 一个在末尾多 1 字节的包会让我们算不出总量、却照样被 fflate 正常解开（实测 2MB 条目
   * 通过闸门）。闸门的意义是拦住异常输入，算不出来就必须拒绝，而不是放行。
   */
  if (eocd < 0) return Number.POSITIVE_INFINITY

  /**
   * ZIP64 直接判为超限 —— 三条线索任一出现就拒绝。
   *
   * 中央目录里用 `0xFFFFFFFF` 占位表示"真实大小在 ZIP64 扩展字段里"。我们的解析器不读那些
   * 扩展字段，于是 total 会算成 0 —— **闸门整闸放行**，炸弹原样进 `unzipSync`（实测过）。
   * 归档本身有 8 MB 上限，ZIP64 的技能包不可能是合法输入，所以拒绝比放行安全。
   *
   * 第三条线索（EOCD 前面的 ZIP64 定位符）是复查补的：只挡住"经典 EOCD 里的占位符"不够，
   * 可以造一个**经典 EOCD 指向空的伪中央目录**（这里读出 0 个条目 → total 0），
   * 真正的条目交给 ZIP64 结构，`fflate` 顺着定位符照样能解开。
   */
  const zip64 = view.getUint16(eocd + 10, true) === 0xffff
    || view.getUint32(eocd + 12, true) === 0xffffffff
    || view.getUint32(eocd + 16, true) === 0xffffffff
    || (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIGNATURE)
  if (zip64) return Number.POSITIVE_INFINITY

  /**
   * 条目数必须两处一致：+8 是"本盘条目数"，+10 是"总条目数"。
   *
   * `fflate` 读 +8，我们原来读 +10 —— 把 +10 改成 0 就能让我们一个条目都不数（total 0 放行），
   * 而 fflate 仍按 +8 把条目全解出来。多卷归档本来就要拒绝（输入永远不该是分卷包），
   * 所以两者不等直接 fail-closed。
   */
  const countOnDisk = view.getUint16(eocd + 8, true)
  const countTotal = view.getUint16(eocd + 10, true)
  if (countOnDisk !== countTotal) return Number.POSITIVE_INFINITY

  const cdSize = view.getUint32(eocd + 12, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  if (cdOffset + cdSize > data.length) return Number.POSITIVE_INFINITY
  let offset = cdOffset
  let total = 0
  for (let index = 0; index < countTotal; index += 1) {
    // 中央目录被截断/对不上同样算"算不出来"→ 拒绝，理由同 EOCD。
    if (offset + 46 > data.length) return Number.POSITIVE_INFINITY
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) return Number.POSITIVE_INFINITY
    // 单个条目用 ZIP64 占位符同样判为超限（原因见上）。
    if (view.getUint32(offset + 24, true) === 0xffffffff) return Number.POSITIVE_INFINITY
    // 中央目录条目：偏移 24 是未压缩大小，28/30/32 是名字/扩展字段/注释的长度。
    total += view.getUint32(offset + 24, true)
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true)
  }
  /**
   * 走完声明的条目数后必须正好停在中央目录末尾。
   *
   * 对不上说明"我们数的"和"包声明的"不是同一个目录：要么漏数了条目（体积被低估），
   * 要么多读了东西。两种都不该放行。
   */
  if (offset !== cdOffset + cdSize) return Number.POSITIVE_INFINITY
  return total
}

/**
 * 体积超限就抛错。
 *
 * @param bytes - zip 内容。
 * @param limit - 允许的未压缩总量。
 */
export function assertZipWithinLimit(bytes, limit = MAX_UNZIPPED_BYTES) {
  const declared = declaredUnzippedBytes(bytes)
  if (declared <= limit) return
  if (declared === Number.POSITIVE_INFINITY) {
    // 说清楚"为什么拒绝"：这里已经不只是 ZIP64 一种原因（分卷、目录对不上、缺 EOCD 都会到这）。
    throw new Error('压缩包结构无法可靠解析（ZIP64 / 分卷 / 中央目录不一致），已拒绝解压')
  }
  const megabytes = Math.round(declared / (1024 * 1024))
  const cap = Math.round(limit / (1024 * 1024))
  throw new Error(`压缩包解压后约 ${megabytes} MB，超过 ${cap} MB 上限，已拒绝解压`)
}
