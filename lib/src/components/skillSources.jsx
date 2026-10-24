/**
 * 技能视图：按**来源目录**分组，逐技能 / 逐来源启停。
 *
 * 数据由调用方传入，交互只通过回调抛出去 —— 这个文件不读运行时、不写设置，
 * 所以它既没有 hooks，也没有副作用，可以在测试里直接调用并遍历返回的元素树。
 *
 * 每个来源的形状：
 *
 *   { key, label, path, enabled, exists, readonly, skills: [{ name, description, path, enabled }] }
 *
 * 几条刻意的取舍：
 *
 *   · `exists: false`（目录不在）时**不渲染来源开关**，只给一行灰色说明。一个操作不了任何
 *     东西的开关比没有开关更糟：它会让人以为「关掉就能解决」，而真相是目录压根不存在。
 *   · `readonly`（外部 Agent 目录）**仍然允许启停**：启停是策略层，不改磁盘文件。只读只
 *     意味着这里不能出现会写文件的动作（删除 / 编辑），而这个视图本来就只有查看与启停。
 *   · 来源停用时该组技能整体压暗，但开关保持可读、可点 —— 压暗表达的是「这些技能暂时不会
 *     被用上」，不是「这里不能操作」。开关的 disabled 只跟 `busy` 走，两个语义不混用。
 *   · 组内不折叠：一屏看全所有来源的启停状态，比省下几次点击重要。
 */
import { installForSkill } from '../skillInstalls.js'

/** 描述压成一行（卡片自身的 CSS 会把视觉上封在两行，完整文本留在 `title` 里）。 */
function descriptionText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 插件自己的开关形态。
 *
 * 与 `client.js` 的 `switchControl` 保持同一份 DOM（`button[role=switch]` + `aria-checked`
 * + `data-on`），因为那个不可用时它就是 fallback，两者长得一模一样才不会在同一个页面里
 * 出现两种开关。这里的组件是纯函数，拿不到 Host 的 `primitives.Switch`，所以直接用我们自己
 * 的胶囊；主 agent 接线时如果拿到了 `primitives.Switch`，可以替换掉这一个 helper。
 *
 * `data-kind` 只为了区分「来源开关」与「技能开关」，也方便测试与接线方定位。
 */
function switchNode({ kind, on, label, disabled, onToggle }) {
  return (
    <button
      className="smp-switch"
      type="button"
      role="switch"
      data-kind={kind}
      data-on={on ? 'true' : 'false'}
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        if (typeof onToggle === 'function') onToggle(!on)
      }}
    >
      <span className="smp-switchKnob" />
    </button>
  )
}

/**
 * 一行技能卡片：名称 + 描述 + 「查看详情」+ 开关。
 *
 * 复用 MCP 卡片的骨架（`smp-card` / `smp-cardRow` / `smp-cardMain` / `smp-cardHead` /
 * `smp-cardActions`），因为它已经在同一个页面里渲染了几十张行，技能行跟着它走才不会
 * 读成另一种产品。只有名称需要等宽（技能名是文件名，`SKILL.md` 也一样），用
 * `smp-skillName` 覆盖字号与字族。
 */
function skillCardNode(skill, options, key) {
  /**
   * 勾选框绑的是**这个技能自己的开关**（`ownEnabled`），不是有效值（`enabled`）。
   *
   * 用户点得动的只有自身那个值：绑有效值的话，来源停用时勾选框显示"关"，点一下把技能
   * 自身置为开，有效值仍然是关、界面毫无变化 —— 体验上就是「点了没反应」。
   * 有效值另作标注（下面那行灰字），说明为什么它现在不生效。
   */
  const own = skill.ownEnabled === undefined ? skill.enabled !== false : skill.ownEnabled !== false
  const on = own
  /** 自身开着、但因为来源或分类被停用而不生效。 */
  const suppressed = own && skill.enabled === false
  const path = String(skill.path ?? '')
  const name = String(skill.name ?? '')
  const description = descriptionText(skill.description)
  /**
   * 这一份是不是仓库装进来的。
   *
   * 按**落盘目录**匹配（见 `skillInstalls.js`），不是按名字：同名技能可以同时来自
   * 不同来源，只有目录能确定"这一份是装进来的"，也就只有它才有更新/回滚可谈。
   */
  const install = installForSkill(options.installs, path, skill.scope)
  const menuOpen = install !== null && String(options.installMenuFor ?? '') === path
  const preview = install === null ? undefined : options.installPreview?.[String(install.id ?? '')]
  const previewStatus = preview?.status
  const previewDetail = preview === undefined
    ? ''
    : [
      (preview?.additions ?? []).length > 0 ? `新增 ${preview.additions.length}` : '',
      (preview?.changes ?? []).length > 0 ? `修改 ${preview.changes.length}` : '',
      (preview?.removals ?? []).length > 0 ? `删除 ${preview.removals.length}` : '',
    ].filter((part) => part !== '').join(' / ')
  const statusLabel = install === null
    ? ''
    : String(options.installStatusLabel?.(previewStatus) ?? '')
  return (
    <li className="smp-card smp-skillCard" key={key} data-skill-on={on ? 'true' : 'false'}>
      <div className="smp-cardRow" key="row">
        <div className="smp-cardMain" key="main">
          <div className="smp-cardHead" key="head">
            {/*
              * 多选勾选框：给"批量启停"用（设计决策 A 的配套——去掉分类开关后，整组操作
              * 不能再靠"停用整个分类"实现）。它与卡片右侧的启用开关是**两件事**：
              * 这个只表示"选中"，不改变任何状态。
              */}
            <input
              className="smp-skillPickInput"
              type="checkbox"
              aria-label={`选择技能「${name}」`}
              checked={Array.isArray(options.selectedPaths) && options.selectedPaths.includes(path)}
              disabled={options.busy}
              onChange={() => { if (typeof options.onSelectSkill === 'function') options.onSelectSkill(path) }}
            />
            <span className="smp-cardIdentity smp-skillName" title={name}>{name}</span>
            {(() => {
              const shadowedBy = options.shadowedSkillBy instanceof Map ? options.shadowedSkillBy.get(path) : undefined
              if (typeof shadowedBy !== 'string' || shadowedBy === '') return null
              return (
                <span
                  className="smp-tag" data-tone="neutral"
                  title={`同名技能由「${shadowedBy}」提供（优先级更高），这一份不会提供给模型`}
                >{`被「${shadowedBy}」覆盖`}</span>
              )
            })()}
            {suppressed ? (
              <span
                className="smp-tag" data-tone="neutral"
                title="技能自身是启用的；它所在的来源被停用了，所以现在不提供给模型"
              >来源已停用</span>
            ) : null}
          </div>
          {description === '' ? null : (
            <div className="smp-cardDescription" title={description} key="desc">{description}</div>
          )}
        </div>
        <span className="smp-cardActions smp-skillActions" key="actions">
          {/*
            * 这里原先有一个「所属分类」下拉。分类这一层已整套从界面撤掉（设计评审第 2 条）：
            * 来源 ∧ 分类 ∧ 技能 三层 opt-out 叠加时，用户算不出"到底生效没生效"。
            * 数据没删，仍留在本插件的 state.json 里；界面上不再出现，也就不该再有"归属"控件。
            */}
          <button
            className="smp-button"
            data-variant="outline"
            type="button"
            disabled={options.busy}
            onClick={() => {
              if (typeof options.onPreview === 'function') options.onPreview(path)
            }}
          >
            查看详情
          </button>
          {/* 只对可写来源显示删除/编辑：外部 Agent 目录只读，那边按了也只能失败。
              删除是**移进回收站**（可恢复），所以这里不必做二次确认。 */}
          {skill.readonly === true || typeof options.onEdit !== 'function' ? null : (
            <button
              className="smp-button"
              data-variant="outline"
              type="button"
              disabled={options.busy}
              onClick={() => { options.onEdit(path) }}
            >
              编辑
            </button>
          )}
          {skill.readonly === true || typeof options.onTrash !== 'function' ? null : (
            <button
              className="smp-button"
              data-variant="outline"
              type="button"
              disabled={options.busy}
              title="移进回收站，可以恢复"
              onClick={() => { options.onTrash(path) }}
            >
              移入回收站
            </button>
          )}
          {/*
            * 「…」只对**仓库装进来的**技能出现：普通技能没有版本可更新、也没有仓库可回滚，
            * 给它一个空菜单比没有菜单更糟。展开的是卡片下方的一行动作，不是浮层菜单 ——
            * 卡片本来就在列表里，就地展开不会遮住别的技能，也不需要测锚点。
            */}
          {install === null ? null : (
            <button
              className="smp-button smp-skillMoreTrigger"
              data-variant="outline"
              type="button"
              aria-expanded={menuOpen ? 'true' : 'false'}
              aria-label={`技能「${name}」的仓库操作`}
              title="仓库操作：检查更新 / 更新 / 回滚 / 卸载"
              disabled={options.busy}
              onClick={() => {
                if (typeof options.onToggleInstallMenu === 'function') options.onToggleInstallMenu(path)
              }}
            >
              ⋯
            </button>
          )}
          {/*
            * 右侧是**状态色标**，不是开关（0.5.52 起）。
            *
            * 启停动作在左侧勾选框 + 批量条上：勾一个就是"单独启停"，勾多个就是"批量启停"。
            * 右侧原来还有一个开关，同一件事两个控件 —— 用户会问"左边勾了到底生效没"。
            * 现在右侧只表达状态：绿=启用中 / 灰=未启用 / 黄=被更高优先级副本覆盖。
            */}
          {(() => {
            const shadowedBy = options.shadowedSkillBy instanceof Map
              ? options.shadowedSkillBy.get(path)
              : undefined
            const covered = typeof shadowedBy === 'string' && shadowedBy !== ''
            /**
             * 状态色标表达的是**模型实际会不会看到它**，所以必须先看有效值。
             *
             * 之前这里只看 `on`（技能自身开关）：来源被停用、有效值为关时，卡片右侧仍是
             * 绿色「启用中 / 已提供给模型」，同一张卡上还挂着「来源已停用」标签、组标题写着
             * 0/N —— 三处互相矛盾，用户只能猜哪个是真的。
             */
            const state = covered
              ? 'covered'
              : (suppressed ? 'suspended' : (on ? 'on' : 'off'))
            const tone = state === 'covered' || state === 'suspended'
              ? 'warn'
              : (state === 'on' ? 'ok' : 'neutral')
            const text = state === 'covered'
              ? '被覆盖'
              : (state === 'suspended' ? '来源停用' : (state === 'on' ? '启用中' : '未启用'))
            const hint = state === 'covered'
              ? `同名技能由「${shadowedBy}」提供（优先级更高），这一份不会提供给模型`
              : (state === 'suspended'
                ? '技能自身是启用的，但它所在的来源被停用了，所以现在不提供给模型'
                : (state === 'on' ? '已提供给模型' : '不提供给模型（勾选后点「批量启用」可恢复）'))
            return (
              <span className="smp-status" key="state" title={hint}>
                <span className="smp-dot" data-dot={tone} aria-hidden="true" />
                <span className="smp-statusText">{text}</span>
              </span>
            )
          })()}
        </span>
      </div>
      {/*
        * 仓库动作行：只在「…」展开时出现。这些动作原先只在「获取技能 → 已安装」里，
        * 同一个技能在两处出现、动作却只在别处 —— 用户得自己把两张清单对上号。
        */}
      {menuOpen ? (
        <div className="smp-skillMore" key="more">
          {statusLabel === '' ? null : (
            <span
              className="smp-tag"
              data-tone={previewStatus === 'update-available' || previewStatus === 'locally-modified' ? 'warn' : 'neutral'}
            >{statusLabel}</span>
          )}
          {previewDetail === '' ? null : <span className="smp-skillMoreNote">{previewDetail}</span>}
          {install.dir === '' ? null : (
            <span className="smp-skillMoreNote" title={String(install.dir)}>
              {`落盘：${String(install.dir)}`}
            </span>
          )}
          <span className="smp-skillMoreActions">
            <button
              className="smp-button" data-variant="outline" type="button"
              disabled={Boolean(options.repoBusy)}
              onClick={() => { if (typeof options.onCheckInstall === 'function') options.onCheckInstall(String(install.id ?? '')) }}
            >检查更新</button>
            <button
              className="smp-button" data-variant="primary" type="button"
              disabled={Boolean(options.repoBusy) || preview === undefined || previewStatus === 'up-to-date'}
              onClick={() => {
                if (typeof options.onRepoAction === 'function') options.onRepoAction('repo-update', String(install.id ?? ''))
              }}
            >更新</button>
            <button
              className="smp-button" data-variant="outline" type="button"
              disabled={Boolean(options.repoBusy)}
              onClick={() => {
                if (typeof options.onRepoAction === 'function') options.onRepoAction('repo-rollback', String(install.id ?? ''))
              }}
            >回滚</button>
            <button
              className="smp-button" data-variant="outline" type="button"
              disabled={Boolean(options.repoBusy)}
              onClick={() => {
                if (typeof options.onRepoAction === 'function') options.onRepoAction('repo-uninstall', String(install.id ?? ''))
              }}
            >卸载</button>
          </span>
        </div>
      ) : null}
    </li>
  )
}

/**
 * 一个来源：标题行（名称 / 数量 / 只读标记 / 来源开关）+ 真实路径 + 技能列表。
 *
 * 路径单独占一行而不是塞进标题行：它通常很长，挤在标题右边会把开关推走，也会把标题
 * 压成一条省略号 —— 而这个视图里路径恰好是用户唯一能确认「这是哪个目录」的东西。
 */
function sourceGroupNode(group, options, index) {
  const sourceOn = group.enabled !== false
  const exists = group.exists !== false
  const readonly = group.readonly === true
  const skills = Array.isArray(group.skills) ? group.skills : []
  const label = String(group.label ?? group.key ?? '')
  const path = String(group.path ?? '')
  /**
   * 折叠状态由调用方拥有（`expanded === null` 表示「没人接管」→ 全展开）。
   *
   * 默认收起是刻意的：来源一多，全部平铺会把页面拉得很长，而用户多数时候只关心某几个来源。
   */
  const key = String(group.key ?? '')
  /**
   * 「已启用 / 总数」，例如 `10/12`。
   *
   * 只显示总数看不出这个来源到底有没有在生效：来源开关关着时 12 个技能一个都没提供给模型，
   * 标题上却仍写着 12 个，读起来像「都在用」。这里用 `skill.enabled`（已把来源与分类一起
   * 算进去的**有效**状态）统计，标题就和模型实际看到的一致。
   */
  const enabledCount = skills.filter((skill) => skill.enabled !== false).length
  const open = options.expanded === null ? true : options.expanded.includes(key)
  return (
    <section
      className="smp-group smp-skillSource"
      key={`${String(group.key ?? label ?? 'source')}-${index}`}
      data-source-key={group.key}
      data-source-on={sourceOn ? 'true' : 'false'}
      data-source-exists={exists ? 'true' : 'false'}
      data-source-readonly={readonly ? 'true' : 'false'}
      data-source-open={open ? 'true' : 'false'}
    >
      <div className="smp-groupTitleRow" key="head">
        {/* 整条标题是折叠开关：来源名 + 数量 + 只读标记都可点。 */}
        <button
          type="button"
          className="smp-skillSourceToggle"
          aria-expanded={open}
          aria-label={`${open ? '收起' : '展开'}来源「${label}」`}
          onClick={() => {
            if (typeof options.onToggleExpanded === 'function') options.onToggleExpanded(key)
          }}
        >
          <span className="smp-skillSourceChevron" data-open={open ? 'true' : 'false'} aria-hidden="true">▸</span>
          {/*
            * 来源名是**分组标签**，不是页面主角：13px/500、次要色。
            * 原来借用 `.smp-groupTitle`（14px/600 主色），结果每个分组标题比它下面的技能名
            * 还重还大 —— 视线先被"Claude Code"抓住，再去找真正的对象（技能）。
            */}
          <span className="smp-skillSourceLabel">{label}</span>
          <span
            className="smp-skillCount"
            title={`已启用 ${enabledCount} 个，共 ${skills.length} 个`}
          >{`${enabledCount}/${skills.length}`}</span>
          {readonly ? <span className="smp-tag" data-tone="neutral">只读</span> : null}
        </button>
        {/* 来源开关是另一个动作，不能连带触发折叠。 */}
        {exists ? (
          <span
            className="smp-skillSourceSwitch" key="switch"
            onClick={(event) => { if (typeof event?.stopPropagation === 'function') event.stopPropagation() }}
          >
            {switchNode({
              kind: 'source',
              on: sourceOn,
              label: `${sourceOn ? '停用' : '启用'}来源「${label}」`,
              disabled: options.busy,
              onToggle: (next) => {
                // 传**策略键**：项目级来源在多个工作区之间共用结构 key，按它存会让
                // 「关掉 A 工作区的项目来源」连带关掉 B 的。
                if (typeof options.onToggleSource === 'function') {
                  options.onToggleSource(String(group.policyKey ?? group.key), next)
                }
              },
            })}
          </span>
        ) : null}
      </div>
      {open && path !== '' ? (
        <div className="smp-groupSub smp-skillSourcePath" key="path">{path}</div>
      ) : null}
      {exists ? null : (
        <p className="smp-note smp-skillMissing" key="missing">来源目录不存在，没有可启停的技能。</p>
      )}
      {open && skills.length === 0 && exists ? (
        <p className="smp-note" key="none">这个来源下还没有技能。</p>
      ) : null}
      {open && skills.length > 0 ? (
        <ul className="smp-cards smp-skillList" key="list" data-off={sourceOn ? 'false' : 'true'}>
          {skills.map((skill, skillIndex) => skillCardNode(
            skill,
            options,
            String(skill.path ?? skill.name ?? skillIndex),
          ))}
        </ul>
      ) : null}
    </section>
  )
}

/**
 * 技能按来源分组的视图。
 *
 * @param groups - 来源数组；空数组（或非数组）时渲染一行「还没有发现任何技能」。
 * @param onToggleSkill - `(skillPath, nextEnabled)`，点击技能开关。
 * @param onToggleSource - `(sourceKey, nextEnabled)`，点击来源开关。
 * @param onPreview - `(skillPath)`，点击「查看详情」。
 * @param busy - 为真时所有开关与按钮 `disabled`（写入在途，避免连点）。
 */
export function skillSourceGroupsNode({
  groups = [],
  onToggleSkill,
  onToggleSource,
  onPreview,
  busy = false,
  onTrash = null,
  expanded = null,
  onToggleExpanded,
  onEdit = null,
  shadowedSkillBy = null,
  selectedPaths = [],
  onSelectSkill = null,
  emptyHint = '',
  onResetFilters = null,
  installs = null,
  installMenuFor = '',
  onToggleInstallMenu = null,
  installPreview = null,
  installStatusLabel = null,
  repoBusy = false,
  onRepoAction = null,
  onCheckInstall = null,
}) {
  const options = {
    onToggleSkill, onToggleSource, onPreview, busy: Boolean(busy),
    onTrash,
    onEdit,
    shadowedSkillBy: shadowedSkillBy instanceof Map ? shadowedSkillBy : null,
    selectedPaths: Array.isArray(selectedPaths) ? selectedPaths.map(String) : [],
    onSelectSkill,
    emptyHint: String(emptyHint ?? ''),
    onResetFilters,
    /**
     * 仓库安装：只有"这个技能是装进来的"时才在卡片上给出更新 / 回滚 / 卸载。
     * 三个都是**显式动作**，所以状态（有没有更新）由调用方点「检查更新」后另行传入，
     * 不在每次渲染时算 —— 那要读盘并逐个文件比哈希。
     */
    installs: Array.isArray(installs) ? installs : null,
    installMenuFor: String(installMenuFor ?? ''),
    onToggleInstallMenu,
    installPreview: installPreview !== null && typeof installPreview === 'object' ? installPreview : {},
    installStatusLabel: typeof installStatusLabel === 'function' ? installStatusLabel : null,
    repoBusy: Boolean(repoBusy),
    onRepoAction,
    onCheckInstall,
    // `null` = 调用方不接管折叠（全展开）；数组 = 只有列出的来源展开
    expanded: Array.isArray(expanded) ? expanded.map(String) : null,
    onToggleExpanded,
  }
  const list = Array.isArray(groups) ? groups : []
  if (list.length === 0) {
    return (
      <div className="smp-skillSources" key="skillSources">
        <>
          <p className="smp-empty">{emptyHint === '' ? '还没有发现任何技能' : emptyHint}</p>
          {emptyHint === '' || typeof onResetFilters !== 'function' ? null : (
            <button
              className="smp-button" data-variant="outline" type="button"
              onClick={() => { onResetFilters() }}
            >清除筛选</button>
          )}
        </>
      </div>
    )
  }
  return (
    <div className="smp-skillSources" key="skillSources">
      {list.map((group, index) => sourceGroupNode(group, options, index))}
    </div>
  )
}
