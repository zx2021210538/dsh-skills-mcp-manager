/**
 * DSH 的 skills provider：把治理快照变成「候选 + 可调用性」。
 *
 * ## 停用是怎么生效的
 *
 * `SkillCandidate.invocation` 是 `{ modelInvocable, userInvocable }`。停用一个技能**不是**
 * 把它从列表里删掉 —— 删掉只对「我们独家提供的来源」有效；对 DSH 原生根（`user-dsh` 等）
 * 官方 provider 照样会列出它，模型照样能调用。
 *
 * 所以对原生技能我们报出**同名**候选，带 `sources.policyRank()` 的低 rank（压过官方那条），
 * 并把 invocation 置为 false。这样「面板停用」才真的等于「模型看不见、用户也调不到」，
 * 而源文件一个字节都不用动。
 *
 * 技能仍然留在列表里（只是不可调用），这也让面板能把它显示成「已停用」而不是消失。
 */
import { loadGovernedSkillContent } from './governance.js'

/** Provider 名字；`SkillSummary.provider` 会带上它，便于面板区分条目来源。 */
export const PROVIDER_NAME = 'dsh-skills-mcp-manager'

/**
 * Build the provider object.
 *
 * `snapshot()` is called on every `list()`: DSH caches the catalog itself and asks us to
 * `invalidate()` after a write, so recomputing here is both cheap and always correct.
 */
export function createGovernanceProvider({ snapshot, log = null }) {
  /**
   * 上一次成功列出的结果。
   *
   * `snapshot()` 会读 `state.json`，而读取可能因瞬时占用（EBUSY/EACCES）失败。那时代理
   * **不能**把异常抛给 DSH：`skills.list()` 是全局调用，抛错会让整个 profile 的技能目录
   * 一起不可用（连不归本插件管的技能也读不出来）。退回上一次成功的结果，最坏只是策略状态
   * 慢一拍，面板自己的路由会把真实错误显示出来。
   */
  let lastGood = []
  /**
   * 清掉"上一次结果"。
   *
   * 策略被改过（`invalidate()`）之后不能再拿旧结果兜底：否则「刚点完停用 → 下一次快照读失败」
   * 会把停用前的策略当成答案返回，模型照样能调用 —— 失败方向变成 fail-open，与整个治理的目标
   * 相反。清空后失败时返回空列表（本插件独家来源暂时不可见，原生来源不受影响）。
   */
  const resetCache = () => { lastGood = [] }
  return {
    name: PROVIDER_NAME,
    resetCache,
    async list() {
      let skills = null
      try {
        skills = (await snapshot()).skills
      } catch (error) {
        if (typeof log === 'function') log(`技能快照读取失败，沿用上一次结果：${String(error?.message ?? error)}`)
        return lastGood
      }
      lastGood = skills.map((skill) => ({
        name: skill.name,
        description: skill.description === '' ? `技能：${skill.name}` : skill.description,
        invocation: {
          modelInvocable: skill.enabled === true,
          userInvocable: skill.enabled === true,
        },
        source: skill.source,
        path: skill.path,
        provider: PROVIDER_NAME,
        rank: skill.rank,
        locator: skill.path,
      }))
      return lastGood
    },
    async get(candidate) {
      const path = String(candidate?.locator ?? candidate?.path ?? '')
      const { content } = await loadGovernedSkillContent(path)
      return { ...candidate, content }
    },
  }
}

/**
 * Register the provider on a context that already has `skills` injected.
 *
 * @returns `{ installed, invalidate, dispose }` — `invalidate()` 在治理状态变化后必须调用，
 *   否则 DSH 的目录缓存会一直返回旧的 invocation 策略（表现为「停用了但还能用」）。
 */
export function registerGovernanceProvider(ctx, { snapshot, log }) {
  const noop = { installed: false, invalidate: () => {}, dispose: () => {} }
  const skills = ctx?.skills
  if (skills === undefined || typeof skills.registerProvider !== 'function') {
    log?.('skills service unavailable: governance provider not registered')
    return noop
  }
  let invalidate = () => {}
  const dispose = skills.registerProvider((control) => {
    const provider = createGovernanceProvider({ snapshot, log })
    const upstream = typeof control?.invalidate === 'function' ? control.invalidate : () => {}
    invalidate = () => { provider.resetCache(); upstream() }
    return provider
  })
  return {
    installed: true,
    invalidate: () => invalidate(),
    dispose: typeof dispose === 'function' ? dispose : () => {},
  }
}

/**
 * 按**作用域**注册技能治理 provider 的注册器（root + 每个 agent）。
 *
 * ## 为什么需要它
 *
 * DSH 0.2.1 的 `skills` 服务是分层的：`dsh-skill/lib/index.js:298-330` 的 `collectFresh()`
 * 按 `[global, ...chainLayers(scope)]` 合并，**后面的层（更近的作用域）同名条目直接胜出**，
 * `rank` 只在同一层内决胜。而桌面版把原生 `skill-filesystem` 从宿主层移到了每个 agent preset
 * 的 scope（`dsh-web-app/cordis.patch.yml:505-518`，`presets/*.patch.yml` 各自 `insert` 一个
 * `dsh-skill-filesystem`）。
 *
 * 所以只在 root（global 层）注册 provider 时，我们报出的 `rank = 原生 − 1` 同名候选
 * 会在「层」这一关就输给 preset 层的候选 —— 面板停用了，模型照样能看到、能调用。
 * 把同一份 provider **也注册进每个 agent 自己的 scope** 之后，候选与 preset 处在同一条读链上
 * 且层更近，`collectFresh` 后写入时由我们的候选覆盖 preset 的，`invocation: false` 才生效。
 *
 * ## 生命周期
 *
 * 一个 agent 一个注册，用 agent 对象本身做键（`scopeOf(agent.ctx)` 就是它，`dsh-agent-loop`
 * 的 `createScope(loopCtx, this)` 见 `lib/index.js:778`）。注册通过 `agent.ctx.inject(['skills'])`
 * 完成：Cordis 的 traceable 服务读取会把调用方的 ctx 交给 `registerProvider`（`cordis/lib/index.js`
 * Service tracker `property: 'ctx'`），因此 provider 落进 **agent 层**，并随该 fiber 一起释放。
 * 本注册器另外保存 `/registerProvider` 的 disposer（`ctx.inject` 的返回 fiber），显式释放：
 * 重复事件、agent disposed、插件卸载三条路径都必须能收干净，否则热重载会撞「provider 重名」。
 */
export function createGovernanceRegistrar({ snapshot, log = null } = {}) {
  /** 每个作用域一条注册记录；键是 agent 对象（root 不走这里，见 `trackRoot`）。 */
  const scopes = new Map()
  /** 所有已安装 provider 的 `invalidate`，面板改策略后要全部清一遍。 */
  const invalidators = new Set()
  let rootProvider = null

  const report = (message) => {
    if (typeof log !== 'function') return
    try {
      log(message)
    } catch {
      // 诊断日志失败不能反过来弄坏注册/释放。
    }
  }

  const remember = (provider) => {
    if (provider?.installed === true && typeof provider.invalidate === 'function') invalidators.add(provider.invalidate)
  }

  const forget = (provider) => {
    if (typeof provider?.invalidate === 'function') invalidators.delete(provider.invalidate)
  }

  const disposeFiber = (fiber) => {
    if (fiber === null || fiber === undefined) return
    try {
      if (typeof fiber === 'function') fiber()
      else if (typeof fiber.dispose === 'function') fiber.dispose()
    } catch (error) {
      report(`技能治理 provider 释放失败：${String(error?.message ?? error)}`)
    }
  }

  /**
   * 在一个 ctx 的作用域里注册 provider；同一个键只注册一次。
   *
   * @returns 注册到的 provider（`skills` 服务缺席时注入回调不会执行，返回 null）。
   */
  const registerScope = (key, scopeCtx) => {
    if (key === undefined || key === null || scopeCtx === null || scopeCtx === undefined) return null
    const existing = scopes.get(key)
    if (existing !== undefined) return existing.provider ?? null
    const record = { provider: null, fiber: null, disposed: false }
    scopes.set(key, record)
    const install = (scopedCtx) => {
      // 释放已经发生过（agent disposed / 插件卸载）时，迟到的注入回调不能再注册。
      if (record.disposed) return
      const provider = registerGovernanceProvider(scopedCtx, { snapshot, log })
      record.provider = provider
      remember(provider)
    }
    try {
      if (typeof scopeCtx.inject === 'function') record.fiber = scopeCtx.inject(['skills'], install)
      else install(scopeCtx)
    } catch (error) {
      // agent.ctx 可能已经 dispose / 不是完整的 Context：如实记下，别让一个 agent 拖垮整个插件。
      scopes.delete(key)
      report(`技能治理 provider 无法注册到该作用域：${String(error?.message ?? error)}`)
      return null
    }
    return record.provider ?? null
  }

  const releaseScope = (key) => {
    const record = scopes.get(key)
    if (record === undefined) return false
    scopes.delete(key)
    record.disposed = true
    const provider = record.provider
    forget(provider)
    // 先调 registerProvider 的 disposer（把 provider 从宿主的层里摘掉），再释放注入 fiber。
    // 两条都做是刻意的：真实 cordis 下前者是层的 effect、后者是作用域 fiber；只做一条时，
    // 任何一条路径（agent disposed / 插件卸载 / 热重载）出错都会留下旧注册。两者都幂等。
    if (provider?.installed === true && typeof provider.dispose === 'function') {
      try {
        provider.dispose()
      } catch (error) {
        report(`技能治理 provider disposer 释放失败：${String(error?.message ?? error)}`)
      }
    }
    disposeFiber(record.fiber)
    return true
  }

  return {
    /**
     * 给一个 agent 的 scope 注册 provider；已注册或 `agent.ctx` 不可用时安全返回。
     * @returns boolean 本次是否建立了注册（`skills` 服务缺席也算已建立，回调会在服务出现时执行）。
     */
    attachAgent(agent) {
      if (agent === null || agent === undefined) return false
      if (scopes.has(agent)) return true
      const agentCtx = agent.ctx
      if (agentCtx === null || agentCtx === undefined) return false
      registerScope(agent, agentCtx)
      return scopes.has(agent)
    },
    /** 释放一个 agent 的注册；未注册时是 no-op。 */
    detachAgent(agent) {
      if (agent === null || agent === undefined) return false
      return releaseScope(agent)
    },
    /** 登记 root（global 层）provider：其 fiber 由插件自己的 ctx 管理，这里只记 invalidate。 */
    trackRoot(provider) {
      rootProvider = provider ?? null
      remember(rootProvider)
      return rootProvider
    },
    /** 面板改策略后调用：root 与每个 agent 的目录缓存都要失效。 */
    invalidate() {
      let count = 0
      for (const invalidate of [...invalidators]) {
        try {
          invalidate()
          count += 1
        } catch (error) {
          report(`技能治理 provider 失效失败：${String(error?.message ?? error)}`)
        }
      }
      return count
    },
    /** 插件卸载时调用：释放所有 agent 注册并清空记账（root 随插件 ctx 一起释放）。 */
    disposeAll() {
      for (const key of [...scopes.keys()]) releaseScope(key)
      forget(rootProvider)
      rootProvider = null
      invalidators.clear()
    },
    /** 当前已注册的作用域数量（root 不计入；诊断/测试用）。 */
    scopeCount() {
      return scopes.size
    },
    /** 当前已安装 provider 的作用域数量（诊断/测试用）。 */
    installedScopeCount() {
      let count = 0
      for (const record of scopes.values()) if (record.provider?.installed === true) count += 1
      return count
    },
    /** 当前可失效的 provider 数量，含 root（诊断/测试用）。 */
    invalidatorCount() {
      return invalidators.size
    },
    /** root provider 是否安装成功（诊断/测试用）。 */
    get rootInstalled() {
      return rootProvider?.installed === true
    },
  }
}
