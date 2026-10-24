import { NAME as NS } from '../../src/identity.js'
// Shared with the Host half on purpose: the form must open on the same reconnect numbers the
// write path fills in, and duplicating them here is how the two drift apart.
import { CONNECTION_DRAFT_DEFAULTS } from '../../src/mcp/connection.js'
import { IMPORT_CHOICES } from './importSources.js'
import { countSkills } from './governanceCounts.js'
import { snapshotOf, statusOf } from './config.js'
import { Chevron } from './components/chevron.jsx'
import { field } from './components/field.jsx'
import { filterRow } from './components/filterRow.jsx'
import { tabStrip } from './components/tabs.jsx'
import { pageHead } from './components/head.jsx'
import { matchesName } from './components/filters.js'
import { orderedScopeGroups, scopeKey } from './components/scopeOrder.js'
import { pendingAdds as pendingAddsOf, pendingLabel, settleInflight } from './crud/inflight.js'
import { emptyMcpText } from './components/sections.js'
import { HINTS } from './components/form.js'
import { detailNodes, hasInjectedPath, rowDetailPairs, toolsForServer } from './components/card.jsx'
import { anchorStyle, measureMenuAnchor } from './components/menuAnchor.js'
import { AUTH_CHANNEL, AUTH_DONE } from '../../src/mcp/oauth/channel.js'
import { toolListNode } from './components/toolList.jsx'
import { skillSourceGroupsNode } from './components/skillSources.jsx'
import { deleteConfirmDialog } from './components/dialog.jsx'
import { skillPreviewDialog } from './components/skillPreview.jsx'
import { skillDialogView } from './components/skillDialog.jsx'
import { dropOptimisticSkill, hideSkillUntilGone, removalTargetOf } from './crud/skills.js'
import { addServerOp, connectionDraft, deleteServerOp, draftFromRow, headersDraft, inflightKeyForRow, rowEntryId, toggleServerOp, updateServerOp } from './crud/servers.js'
import { importLabel, splitImport, takenNames as takenNamesOf } from './crud/import.js'
import panelCss from './styles/panel.css'

/**
 * Client half of the Skills & MCP panel.
 *
 * Layout mirrors Settings → 内置插件 (`dsh-client-ui-settings-plugin-inventory`):
 * page head, tab strip, one filter row (search + project switch), then two
 * collapsible tiers per tab — 全局 and 项目级 — rendering the same card grid.
 * Same metrics and `--dsw-alias-*` tokens, no Harness Client package imports.
 */
window.__ModuleLoader__.load({
  // 必须与 package.json 的 `name` 完全一致 —— 否则宿主按包名找不到这个 bundle，客户端不挂载。
  id: 'dsh-skills-mcp-manager',
  factory(require) {
    const React = require('react')
    // JSX 文件通过这个全局拿 React（见 esbuild.config.mjs 的 jsxFactory）
    globalThis.__dshReact = React
    /** Official UI primitives (Modal/Button) — same dialogs the built-in pages use. */
    const primitives = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives')
      } catch {
        return null
      }
    })()
    const h = React.createElement
    /**
     * One boolean control: the Host's own `Switch` when available, our capsule otherwise.
     *
     * Extracted because it had been written out three times (MCP card, skill card, form) with
     * slightly different labels and callbacks; a fourth copy for the connection-policy rows
     * would have made "which switch is this" a per-site question. One renderer also means the
     * fallback path is exercised by every call site, not just the one that happened to keep it.
     *
     * @param checked - current state.
     * @param onChange - receives the **next** state (not an event).
     * @param label - accessible name; also what the fallback button announces.
     * @param disabled - when true the control cannot change.
     */
    const switchControl = (checked, onChange, label, disabled = false) => (
      primitives?.Switch !== undefined
        ? <primitives.Switch key="switch" checked={checked} disabled={disabled} label={label} onChange={onChange} />
        : (
          <button
            className="smp-switch" key="switch" type="button"
            role="switch" aria-checked={checked} aria-label={label}
            data-on={checked ? 'true' : 'false'} disabled={disabled}
            onClick={() => onChange(!checked)}
          >
            <span className="smp-switchKnob" key="k" />
          </button>
        )
    )
    const { useState, useEffect, useMemo, useRef } = React

    /**
     * 「检查插件更新」的更新源是否已接入。
     *
     * 更新源是我们自己的 GitHub 仓库（`src/update.js` 的 `REPOSITORY`，读 releases/latest，
     * 没有 release 时退回默认分支的 package.json）。接入后按钮回来：点击发 `update-check`，
     * Host 侧回答「有没有新版」，发布页链接由结果带回。
     *
     * 保留 `false` 分支作为「换源/离线时」的占位形态：只显示当前版本 + 一行说明，
     * 不渲染按钮、不发请求——一块能点但只会失败的按钮比没有更糟。
     */
    const UPDATE_SOURCE_READY = true

    /**
     * 自己这一版的版本号（「插件更新」区块里显示）。
     *
     * 客户端拿不到 Host 的 package.json，所以这里放一个常量；它必须与
     * `package.json` 的 `version` 一致 —— `test/pluginIdentity.test.mjs` 会读源码对账。
     */
    const PLUGIN_VERSION = '0.6.1'

const CSS = panelCss

    /**
     * 必须跨 section 重挂载存活的 UI 状态。
     *
     * ## 背景
     *
     * 设置壳层在 settings 文档变更后会**重新挂载** section，组件内的 `useState` 随之清零：
     * 展开的服务器卡片被收起、页签跳回默认。
     *
     * 造成它的主要来源已经堵掉了 —— 工具勾选不再逐次写文档，而是攒到「保存修改」一次提交
     * （见 `filterDraft`），所以勾选过程中不会有任何写入、也就不会有重载。剩下**保存那一
     * 次**写入仍会触发重挂载；把这两项放到模块作用域，那次重载就不会把你正在看的卡片和
     * 页签收走。
     *
     * 一次页面加载仍从默认值开始（见 `apply` 里的重置），所以关闭设置再打开能停在原处，
     * 又不会跨页面生命周期累积。
     */
    const PANEL_UI = { tab: 'mcp', expanded: [], filterDraft: {} }

    /** 主面板页与侧栏图标共用的 id：两处必须一致，否则图标点了没反应。 */
    const SIDEBAR_ID = 'skills-mcp'

    /**
     * 侧栏主面板页的外壳。
     *
     * ## 为什么需要这一层
     *
     * 设置面板的滚动由宿主的内容列负责，所以 `.smp-page` 自身没有任何高度/溢出规则。
     * 但 `main` 槽位的容器是**固定高度、不会替我们滚动**的：内容一超过一屏就被裁掉，
     * 既看不到也滚不动（真机报的正是这个）。所以主面板页必须自己当滚动容器。
     *
     * 只在 `main` 这一处包。给设置页也加 `height:100%` + `overflow` 会变成「滚动条套滚动条」。
     */
    function MainPanelShell(props) {
      return (
        <div className="smp-mainShell">
          <Panel {...props} />
        </div>
      )
    }

    /**
     * 侧栏主面板图标（原创图形，跟随宿主前景色）。
     *
     * 不用包里的 `icon.svg`：客户端 bundle 拿不到包内资源，而这个图标只需要一个可辨识的
     * 轮廓。`active` 时保持满不透明，未选中时略淡——侧栏按钮的选中态由宿主负责，这里只微调。
     */
    function SkillPanelIcon(props) {
      const size = Number(props?.size) > 0 ? Number(props.size) : 20
      return (
        <svg
          viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"
          style={{ display: 'block', opacity: props?.active === false ? 0.75 : 1 }}
        >
          <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="4" width="16" height="16" rx="3.5" />
            <path d="M8 9h8" />
            <path d="M8 12.5h5" />
          </g>
          <circle cx="16.4" cy="16.2" r="1.4" fill="currentColor" />
        </svg>
      )
    }

    /** Read through the settings form's own snapshot store. */

    
    function Panel(props) {
      const form = props.form
      const [tick, setTick] = useState(0)

    /**
     * Subscribe to the settings store itself.
     *
     * The 700ms poll below only re-renders; it does not force the renderer's
     * settings snapshot to refresh, so a change could take ~9.5s to show up (the
     * first create after opening the panel) while the Host had already published.
     * A real subscription reacts as soon as the store updates.
     */
    useEffect(() => {
      const store = form?.store ?? form
      const subscribe = typeof store?.subscribe === 'function' ? store.subscribe.bind(store) : null
      if (subscribe === null) return undefined
      const unsubscribe = subscribe(() => setTick((n) => n + 1))
      return typeof unsubscribe === 'function' ? unsubscribe : undefined
    }, [form])
      const [tab, setTab] = useState(PANEL_UI.tab)
      const [query, setQuery] = useState('')
      /**
       * 展开的卡片集合（**可以同时展开多张**）。
       *
       * 上一版是一个字符串，于是点开一张就会把上一张收起 —— 想对照两条服务器的 env / 工具清单
       * 时非常难受，而且 MCP 卡片本身是折叠列表，没有「同一时间只能看一张」的理由。
       */
      const [expandedCards, setExpandedCards] = useState(Array.isArray(PANEL_UI.expanded) ? PANEL_UI.expanded : [])
      /** 某张卡片是否展开。 */
      const isExpanded = (key) => expandedCards.includes(String(key))
      /** 展开/收起某一张，其它卡片不受影响。 */
      const toggleExpanded = (key) => setExpandedCards((current) => (
        current.includes(String(key)) ? current.filter((item) => item !== String(key)) : [...current, String(key)]
      ))
      /**
       * 把这两项写回模块作用域，供重挂载后恢复（见 `PANEL_UI`）。
       *
       * 用 effect 而不是包一层 setter：`setTab` / `setExpandedCards` 在十几处被直接调用，
       * 逐个改写只会增加漏改一处就悄悄失效的风险。effect 在渲染后同步跑，而重挂载是
       * 之后由设置壳层触发的，所以到那时模块里的值一定是最新的。
       */
      useEffect(() => { PANEL_UI.tab = tab }, [tab])
      useEffect(() => { PANEL_UI.expanded = expandedCards }, [expandedCards])
      /**
       * Which row's `…` popup is open, by `entryId` ('' = none).
       *
       * One at a time on purpose: two open menus cannot both be dismissed by a single
       * outside click, and the panel never needs two.
       */
      const [menuFor, setMenuFor] = useState('')
      /**
       * 弹出菜单锚点（视口坐标）。
       *
       * `null` = 没量到（测试渲染器没有布局）或菜单没开，此时退回 CSS 的绝对定位。
       * 有值时菜单用 `position: fixed` —— 既不受祖先 overflow 裁剪，也能自己决定上下。
       */
      const [menuAnchor, setMenuAnchor] = useState(null)
      const [editing, setEditing] = useState(null)
      const [draft, setDraft] = useState({})
      /**
       * The scope chosen in the server form: `{ value, custom }`.
       *
       * The project filter used to live in the toolbar because the project tier was a
       * separate, separately-stored list. Scope is a property of a server now, so the
       * choice moved into the form — and this is where the toolbar's project selector
       * functionality went.
       */
      const [scopeDraft, setScopeDraft] = useState({ value: '', custom: false })
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
        const [deleteDialog, setDeleteDialog] = useState(null)
      /** Per-server reconnect progress / error, shown in the `…` menu. */
      const [reconnectState, setReconnectState] = useState({})
    /** Delete progress: the confirm dialog stays open until the receipt lands. */
    const [deleteNonce, setDeleteNonce] = useState("")
    const [deletePending, setDeletePending] = useState(false)
    const [deleteError, setDeleteError] = useState("")
    /**
     * Optimistic inserts. The Host finishes a skill op instantly (the receipt comes
     * back in ~0ms), but the renderer's settings snapshot can arrive many seconds
     * later, so the list used to lag ~8s. Show the card immediately and let the real
     * data take over as soon as it lands.
     */
    const [optimistic, setOptimistic] = useState([])
    /**
     * Tombstones for deleted skills. The renderer's settings snapshot lags the Host by
     * seconds, so a deleted card stayed visible until the document caught up.
     */
    const [removedKeys, setRemovedKeys] = useState([])
    const opCtxRef = useRef(null)

    /**
     * 请求 nonce 的单调序号。
     *
     * 以前每处都写 `String(Date.now())`：同一毫秒内发出的两次操作会得到同一个串，
     * 于是「上一次的回执」会被当成这一次的回执 —— 表现是删除/保存的转圈一闪而过。
     * （客户端集成测试在 Node 18 上偶发复现过。）
     */
    const nonceSeqRef = useRef(0)
    const nextNonce = () => `${Date.now().toString(36)}-${(nonceSeqRef.current += 1)}`

    /** Path of the skill currently being deleted: its card shows a spinner. */
    const [skillPendingPath, setSkillPendingPath] = useState("")
    /** 正在提交的启停目标（技能路径或来源 key），空串 = 空闲。禁用对应开关防连点。 */
    const [governancePending, setGovernancePending] = useState("")
    /**
     * 当前查看哪个工作区（`''` = 全局 + 所有工作区）。
     *
     * 项目级技能散落在每个工作区的两个根里，全列出来时同一屏会出现 N 组
     * 「项目 · DSH / 项目 · Agent」；先选工作区再干活，与上游的项目页体验一致。
     */
    /**
     * 技能页唯一的过滤器：范围。
     *
     * `skillScope`：`'global'` = 只看全局来源，其它 = 只看那个工作区的来源。**没有「全部」** ——
     * 全局与某个工作区是互斥的两个视角，混着显示看不出某个技能属于哪一层。默认「全局」。
     *
     * 「分类」过滤器已移除（设计评审第 2 条）：分类这一层与来源、技能自身叠加成三层 opt-out，
     * 用户算不出"到底生效没生效"，而它本身只是"给技能分组浏览"的辅助视图。
     * **数据没删**：分类仍留在本插件的 state.json 里，界面上不再出现。
     */
    const [skillScope, setSkillScope] = useState("global")
    /**
     * Skills 页的子标签：把「浏览 / 文件 / 获取 / 回收站」拆开。
     *
     * 一处页面塞 8 个区块会很长，而且这些功能的使用场景本来就不重叠（看技能 vs 装技能 vs 找回过
     * 删除的东西）。拆成子页签后，每页只做一件事。
     */
    const [skillView, setSkillView] = useState("skills")
    /** 展开的来源 key 列表。默认全收起：来源一多，平铺会把页面拉得很长。 */
    const [expandedSources, setExpandedSources] = useState([])
    /** 技能多选（给批量启停用）。存 path。 */
    const [selectedSkills, setSelectedSkills] = useState([])
    /** 技能仓库：粘贴的地址、安装目标（一次选择，下面每个技能的「安装」都用它）。 */
    const [repoUrl, setRepoUrl] = useState("")
    const [repoDest, setRepoDest] = useState({ scope: "global", destId: "dsh", project: "" })
    /**
     * 每个已安装技能的检查结果，按 install id 索引。
     *
     * 只在用户点「检查更新」时算：状态需要读盘并对比签名，放进 `/runtime` 的轮询会让
     * 每 5 秒对每个安装做一遍全目录哈希，代价与收益完全不成比例。
     */
    const [repoStatus, setRepoStatus] = useState({})
    /**
     * 技能卡片上展开的「…」（值为技能路径，空串 = 没展开）。
     *
     * 与 MCP 行的 `menuFor` 分开：那个是**浮层菜单**（要测锚点），技能这里是卡片下方
     * 就地展开的一行动作 —— 状态各管各的，不会出现"打开一个关掉另一个"的错觉。
     */
    const [skillMenuFor, setSkillMenuFor] = useState("")
    /** 导入：可选技能名、目录路径、是否在提交。 */
    const [importName, setImportName] = useState("")
    const [importPath, setImportPath] = useState("")
    const [importPending, setImportPending] = useState(false)
    /** 在线市场：选中的市场、搜索词、结果、游标、状态提示。 */
    const [catalogMarket, setCatalogMarket] = useState("skillsh")
    const [catalogQueryText, setCatalogQueryText] = useState("")
    const [catalogItems, setCatalogItems] = useState([])
    const [catalogCursor, setCatalogCursor] = useState("")
    const [catalogPending, setCatalogPending] = useState(false)
    const [catalogNote, setCatalogNote] = useState("")
    /** 本插件自更新检查结果（只回答「有没有新版」，不自己替换文件）。 */
    const [pluginUpdate, setPluginUpdate] = useState(null)
    /** 最近一次安装的落点（回执上的「查看」用它切到对应范围）。 */
    const [lastInstalledScope, setLastInstalledScope] = useState(null)
    /** 插件更新检查的失败原因：只在这个区块显示，不写进「在线市场」的提示里。 */
    const [pluginUpdateNote, setPluginUpdateNote] = useState("")
    /** Skill preview dialog: the entry whose SKILL.md body is being shown. */
    const [skillPreview, setSkillPreview] = useState(null)
    /**
     * Add/edit dialog state: `{ mode, scope, project, projectCustom, id, prevName, path }`.
     *
     * The destination is three orthogonal fields rather than one 「区域」 key: 层级 (`scope`)、
     * 工作区 (`project`) 与 目录 (`id`). `regionKey` used to encode the same thing as a
     * `scope:id` string, which forced a parse at every read site and could not express "the
     * project is being typed right now" (`projectCustom`).
     */
    const [skillDialog, setSkillDialog] = useState(null)
    const [skillDraft, setSkillDraft] = useState({ name: "", description: "", body: "" })
    const [skillError, setSkillError] = useState("")
    const [skillNonce, setSkillNonce] = useState("")
    /** When the current skill op was sent (for freshness fallback matching). */
    /**
     * Clear the skill-dialog in-flight markers.
     *
     * Both markers are cleared by a **matching receipt**, which is fine while a request is
     * genuinely in flight — but an op that never produces one leaves them set forever. The
     * paths that do that are ordinary: cancelling an edit before its body arrives, a Host
     * reload mid-op, or a dropped request. The next dialog then opens already showing
     * 「保存中…」 and 「正在与磁盘同步…」 with nothing in flight, and the save button is dead.
     *
     * Called from **every** entry point (添加技能 / 编辑 / 取消), so a stale marker can never
     * leak across dialogs. The flag is deliberately not cleared while a dialog is open, or a
     * real in-flight op would lose its progress state.
     */
    const resetSkillPending = () => {
      setSkillNonce("")
      setEditBodyPending(false)
      setEditBodyNonce("")
    }

    /**
     * Finish a skill **delete**, from either channel.
     *
     * `deleteNonce` is cleared in both cases so a failed delete can be retried; the difference is
     * only whether the card is hidden (backed by the Host's tombstone) or merely dropped from the
     * optimistic list (a skill that really is still on disk stays listed by the document, so its
     * card comes back by itself).
     */
    const finishSkillDelete = (delResult) => {
      const target = deleteTargetRef.current
      setSkillPendingPath("")
      if (delResult?.ok === true) {
        setDeleteDialog(null)
        setDeleteError("")
        // Drop the card now: the renderer's snapshot can lag the Host, and a
        // panel-created skill also leaves an optimistic entry behind.
        if (target !== null) {
          setOptimistic((list) => dropOptimisticSkill(list, target.name))
          setRemovedKeys((list) => hideSkillUntilGone(list, target.name, target.scopeKey))
        }
      } else {
        // The dialog already closed, so surface the reason where the card was.
        setSkillError(String(delResult?.reason ?? "删除失败"))
        // A stale card for a skill the Host cannot find (already deleted from
        // disk) only made the user click 删除 again and again: drop the local
        // optimistic card.
        if (target !== null) setOptimistic((list) => dropOptimisticSkill(list, target.name))
      }
      deleteTargetRef.current = null
      setDeletePending(false)
      setDeleteNonce("")
    }

    /**
     * Apply a **successful** skill write to the local list.
     *
     * Shared by both channels: the HTTP route answers with the result directly, while the
     * settings-queue path learns about it later through `skillResult`. They must produce
     * identical state, or the same click would behave differently depending on which channel
     * happened to serve it.
     *
     * Only called from effects/handlers, never during render: it reads `form`, which is declared
     * later in this component (touching it during render hit its temporal dead zone).
     */
    const applyOptimisticSkillWrite = (ctx) => {
      if (ctx === null) return
      const dirs = runtime.skillDirs ?? {}
      const isProject = ctx.scope === "project" && String(ctx.project ?? "") !== ""
      const base = isProject
        ? `${String(ctx.project).replace(/\/+$/, "")}/${ctx.id === "dsh" ? ".dsh" : ".agents"}/skills`
        : String(ctx.id === "dsh" ? (dirs.userDsh ?? "") : (dirs.userAgents ?? ""))
      if (ctx.kind === "create" && ctx.name !== "") {
        // Show the card immediately: the projection needs a reconcile tick plus a publish,
        // which is where the multi-second wait came from.
        setOptimistic((list) => [...list.filter((e) => !(e.name === ctx.name && e.scope === (isProject ? ctx.project : "global"))), {
          name: ctx.name, description: ctx.description,
          source: `${isProject ? "project" : "user"}-${ctx.id === "dsh" ? "dsh" : "agents"}`,
          scope: isProject ? ctx.project : "global",
          path: base !== "" ? `${base}/${ctx.name}/SKILL.md` : "",
          optimistic: true,
        }])
      } else {
        const gone = ctx.kind === "delete" ? ctx.name : ctx.prevName
        setOptimistic((list) => list.filter((e) => e.name !== gone))
        if (ctx.kind === "delete") {
          const scopeKey = ctx.scope === "project" && String(ctx.project ?? "") !== "" ? ctx.project : "global"
          setRemovedKeys((list) => [...new Set([...list, `${gone}::${scopeKey}`])])
        }
      }
    }

    /**
     * The skill whose delete is in flight: `{ name, scopeKey, path }`.
     *
     * The delete goes through the same `skillRequest` channel as the dialog ops,
     * but it is not started from that dialog — so it cannot rely on `opCtxRef`
     * (which the dialog sets on save). Without this, a delete receipt matched no
     * context and the card was never dropped locally.
     */
    const deleteTargetRef = useRef(null)
    /** Preview body fetched on demand (the list no longer carries bodies). */
    const [previewBody, setPreviewBody] = useState("")
    const [previewPending, setPreviewPending] = useState(false)
    const [previewNonce, setPreviewNonce] = useState("")
    /** Edit needs the body too; the list no longer carries it. */
    const [editBodyNonce, setEditBodyNonce] = useState("")
    const [editBodyPending, setEditBodyPending] = useState(false)
      /**
       * A delete whose receipt never arrives (the Host can be reloaded mid-op)
       * must not spin forever on the card. The nonce is deliberately kept, so a
       * late receipt still drops the card.
       */
      useEffect(() => {
        if (skillPendingPath === "") return undefined
        const timer = setTimeout(() => {
          setSkillPendingPath("")
          setDeletePending(false)
          setSkillError("删除没有回执（应用可能正在重载），请刷新后再确认一次")
        }, 15000)
        return () => clearTimeout(timer)
      }, [skillPendingPath])
      /**
       * A body read whose receipt never arrives must not wedge the dialog.
       *
       * `editBodyPending` gates the save button ("never save an edit before the body arrived: it
       * would erase the file"), so a lost receipt would leave the dialog permanently unsaveable —
       * the same failure shape the delete flow's 15 s guard exists for.
       *
       * A **separate** effect on purpose: putting this inside the receipt effect above would
       * `return` early and skip every receipt handler below it.
       */
      useEffect(() => {
        if (!editBodyPending || editBodyNonce === "") return undefined
        const timer = setTimeout(() => {
          setEditBodyPending(false)
          setEditBodyNonce("")
          setSkillError("读取正文没有回执（应用可能正在重载），请关掉重开一次")
        }, 15000)
        return () => clearTimeout(timer)
      }, [editBodyPending, editBodyNonce])

      /**
       * Operations we started but whose effect we have not seen yet. The Host
       * clears its queue BEFORE writing the patch, so the queue alone would drop
       * the spinner while the row still looks unchanged — this keeps it up until
       * the projection actually reflects the change (or a safety timeout).
       */
      const [inflight, setInflight] = useState({})
      /**
       * Close the `…` popup on any click outside it, and on Escape.
       *
       * The scrim inside the menu already catches clicks that land on the page, but not
       * clicks on the browser chrome / another window, and not the keyboard at all. A menu
       * that outlives the interaction is worse than no menu: the next click lands on an
       * item the user never meant to reach.
       *
       * Bound only while a menu is open, so the panel adds no permanent global listener.
       */
      useEffect(() => {
        if (menuFor === '') return undefined
        // `document` is absent in the offline render harness, and a menu that cannot bind
        // a key handler is not worth crashing the whole panel over.
        if (typeof document === 'undefined') return undefined
        const onKey = (event) => { if (event.key === 'Escape') setMenuFor('') }
        document.addEventListener('keydown', onKey)
        /**
         * 滚动或改变窗口大小时关掉菜单。
         *
         * 菜单现在是视口坐标（fixed），页面一滚它就会停在原地、指向一个已经不在这儿
         * 的按钮。关掉比让它飘着好 —— 用户再点一次的成本是一次点击，而一个错位的
         * 菜单会让人点错东西。
         */
        const onReflow = () => setMenuFor('')
        document.addEventListener('scroll', onReflow, true)
        globalThis.window?.addEventListener?.('resize', onReflow)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('scroll', onReflow, true)
          globalThis.window?.removeEventListener?.('resize', onReflow)
        }
      }, [menuFor])
        const [importOpen, setImportOpen] = useState(false)
      const [importSource, setImportSource] = useState('claude')
      const [importScope, setImportScope] = useState('global')
      const [importProject, setImportProject] = useState('')
      const [importCustomProject, setImportCustomProject] = useState(false)
    /** The last scan answer, held in memory (it never touches the profile patch). */
    const [importScan, setImportScan] = useState(null)

      const refresh = () => setTick((n) => n + 1)

      /**
       * The Host writes its projection (profile rows, workspaces) straight into
       * the settings document; that does not reliably surface through the form's
       * own subscription, which is why the global list used to lag until you left
       * and reopened the page. Poll while the panel is open — a snapshot read.
       */
      useEffect(() => {
        const timer = setInterval(refresh, 700)
        return () => clearInterval(timer)
      }, [])
      useEffect(() => {
        const timer = setInterval(refresh, 1500)
        const unsubscribe = form?.subscribe?.(refresh)
        return () => {
          clearInterval(timer)
          if (typeof unsubscribe === 'function') unsubscribe()
        }
      }, [form])

      // The read-only inventory is the client's own view of the Loader: it always
      // names the MCP rows the profile configures, so it backs the 全局 tier when
      // the Host projection has not landed yet.
      const [inventoryRows, setInventoryRows] = useState([])
      useEffect(() => {
        let alive = true
        const load = () => {
          try {
            const list = props.inventory?.list
            if (typeof list !== 'function') return
            list().then((payload) => {
              if (!alive) return
              const entries = payload?.value?.entries ?? payload?.entries ?? []
              setInventoryRows((Array.isArray(entries) ? entries : []).map((row) => ({
                entryId: String(row?.entryId ?? row?.id ?? '?'),
                moduleName: String(row?.moduleName ?? row?.name ?? '?'),
                enabled: row?.enabled !== false,
                fiberPhase: String(row?.fiberPhase ?? ''),
              })))
            }).catch(() => {})
          } catch {
            // a missing or failing inventory must never blank the page
          }
        }
        load()
        const timer = setInterval(load, 10000)
        return () => { alive = false; clearInterval(timer) }
      }, [props.inventory])

      // Config-backed lists are gone: skills are disk-only and MCP rows come from /runtime.
      const [runtime, setRuntime] = useState({
        serverTools: [], serverStatus: [], serverToolsError: { reason: 'loading', detail: '' },
        /** Host 现算的完整读模型；任何一项缺失都按空值处理（旧 Host）。 */
        servers: [], skills: [], skillDirs: {}, workspaces: [], currentWorkspace: '',
        filter: {}, probe: {}, oauth: { servers: {} }, discovery: {},
      })
      /**
       * 回调页发来的「授权完成」信号计数。
       *
       * 把它放进下面那个 effect 的依赖里，信号一到就会**立刻**重新拉一次 `/runtime`，
       * 而不是等每 5 秒的轮询。授权是在另一个标签页里完成的，面板没有别的办法知道
       * 用户什么时候回来；同源广播是这里唯一可用的即时通道。
       */
      const [refreshPing, setRefreshPing] = useState(0)
      /**
       * 让面板**立刻**重新读一次运行时状态。
       *
       * 三个来源共用它：回调页的广播、一次成功的行命令、一次成功的技能写入。它们的共同点
       * 是「Host 那边刚发生了什么，别等下一个 5 秒轮询」。
       */
      const bumpRefresh = () => setRefreshPing((n) => n + 1)
      useEffect(() => {
        if (typeof BroadcastChannel === 'undefined') return undefined
        let channel
        try {
          channel = new BroadcastChannel(AUTH_CHANNEL)
        } catch {
          // 老浏览器 / 被策略禁用：静默降级到轮询，快只是附加价值，不是正确性的前提。
          return undefined
        }
        const onMessage = (event) => {
          if (event?.data === AUTH_DONE) bumpRefresh()
        }
        channel.addEventListener('message', onMessage)
        return () => {
          channel.removeEventListener('message', onMessage)
          channel.close()
        }
      }, [])
      useEffect(() => {
        let alive = true
        let pending = false
        let controller
        let lastLoadedAt = 0
        const load = async (force = false) => {
          /**
           * 为什么不再用 `document.visibilityState === 'hidden'` 来跳过一次拉取。
           *
           * 这个判断原先是一道「后台页别空转」的省电开关，但它把**「不可见」和「不该更新」
           * 混为一谈**，而真机上代价很大：只要浏览器（或 DSH 的 Web 视图）把页面判成
           * hidden，倒计时就会**永远停在某一个数字上**，而界面上没有任何迹象表明它在冻着 ——
           * 用户唯一能做的就是把卡片切换一下（那会重建 effect、立刻拉一次），于是现象变成
           * 「点一下才刷新」。
           *
           * 真正的省电手段是 `visibilitychange`：页面回到可见时立刻补一次（下面已经监听了）。
           * 所以这里只在**明确隐藏**时退让成低频，而不是完全不动 —— 后台页每 15 秒一次的成本
           * 可以忽略，换来的是「计时器永远在走」这个更重要的性质。
           */
          if (pending) return
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && !force) {
            // 隐藏时降频：距上次成功拉取不足 15s 就跳过。
            if (Date.now() - lastLoadedAt < 15000) return
          }
          pending = true
          controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 10000)
          try {
            const response = await fetch(`/${NS}/runtime`, {
              credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const payload = await response.json()
            if (!Array.isArray(payload?.serverTools) || !Array.isArray(payload?.serverStatus)
              || typeof payload?.serverToolsError?.reason !== 'string') throw new Error('响应格式无效')
            lastLoadedAt = Date.now()
            if (alive) setRuntime(payload)
          } catch (error) {
            // Keep the last known rows/skills: a transient runtime failure must not make the
            // list itself vanish. Only the observation data is cleared, and the status tag
            // says "unknown" instead of pretending the servers are gone.
            if (alive) setRuntime((current) => ({
              ...current,
              serverTools: [], serverStatus: [],
              serverToolsError: { reason: 'runtime-unavailable', detail: String(error?.message ?? error) },
            }))
          } finally {
            clearTimeout(timeout)
            pending = false
          }
        }
        load()
        const timer = setInterval(load, 5000)
        /** 回到前台立刻补一次（低频策略不能拖到下一个 5s 才「看见」）。 */
        const onVisible = () => { void load(true) }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        return () => {
          alive = false
          controller?.abort()
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
        }
        // `refreshPing`：回调页广播、或刚写完一次行/技能命令时立刻重拉一次。
      }, [tab, expandedCards, refreshPing])
      /**
       * Drop a delete tombstone once the runtime snapshot no longer lists that skill
       * (or once the list has moved on). This is local rendering state only.
       */
      useEffect(() => {
        if (removedKeys.length === 0) return
        const now = new Set((runtime.skills ?? []).map((entry) => `${entry.name}::${entry.scope ?? 'global'}`))
        const keep = removedKeys.filter((key) => now.has(key))
        if (keep.length !== removedKeys.length) setRemovedKeys(keep)
      }, [runtime.skills, removedKeys])
      const serverTools = runtime.serverTools
      /** Per-server tool filter rules, as the Host published them. */
      const toolFilters = useMemo(() => {
        const raw = snapshotOf(form)?.toolFilters
        return raw !== null && typeof raw === 'object' ? raw : {}
      }, [form, tick])
      /** Whether the register shadow is actually installed, and why not when it is not. */
      const filterState = runtime.filter ?? {}
      const serverToolsError = runtime.serverToolsError
      // Retry timing is inferred by the Host; labels must continue to say “预计”.
      const serverStatus = runtime.serverStatus


      /**
       * OAuth availability, as the Host published it.
       *
       * `ready` decides whether the 「需要授权」 note offers a button or falls back to the
       * manual-header advice. Both halves matter: on an older Host, or one where the SDK
       * could not be patched, there must be **no button** — a button that can only fail looks
       * like the user's mistake.
       */
      const oauthState = runtime.oauth ?? {}
      /** Per-server authorization state (`present` / `refreshable` / `waiting` / `expiresAt`). */
      const oauthServers = runtime.oauth?.servers ?? {}
      /** Result of the last `authorize` / `logout` this panel issued, per server. */
      const [oauthResult, setOauthResult] = useState({})
      /** The server whose authorize call is in flight, or ''. */
      const [oauthPending, setOauthPending] = useState('')
      /** Server whose authorization URL was just copied (for the 「已复制」 flash). */
      const [copiedUrlFor, setCopiedUrlFor] = useState('')

      /** The Host's per-server authorization state, or an empty shell. */
      const oauthServerState = (serverName) => {
        const entry = oauthServers[serverName]
        return entry !== null && typeof entry === 'object' ? entry : {}
      }

      /**
       * The authorization URL to show for one server.
       *
       * Two sources, and the local one wins: a URL this panel just received is fresher than
       * the 5 s projection, and it is the one the user is expected to open **now**. Falling
       * back to the projection covers the case where the transport hit a 401 on its own and
       * the Host recorded the URL without any panel request.
       */
      const authorizeUrlFor = (serverName) => {
        const local = String(oauthResult[serverName]?.authorizeUrl ?? '')
        if (local !== '') return local
        return String(oauthServerState(serverName).authorizeUrl ?? '')
      }

      /** The failure text for one server, or ''. */
      const oauthFailureFor = (serverName) => {
        const result = oauthResult[serverName]
        if (result === undefined || result === null) return ''
        if (result.ok === true) return ''
        const reason = String(result.reason ?? '')
        const detail = String(result.detail ?? '')
        if (detail !== '' && detail !== reason) return `${reason === '' ? '授权失败' : reason}：${detail}`
        return reason === '' ? '授权失败' : reason
      }

      /** Ask the Host to begin an authorization and show whatever it returns. */
      const startOAuth = async (serverName) => {
        if (oauthPending !== '') return
        setOauthPending(serverName)
        setCopiedUrlFor('')
        try {
          const result = await sendOAuth({ action: 'authorize', serverName })
          setOauthResult((previous) => ({ ...previous, [serverName]: result }))
        } finally {
          setOauthPending('')
        }
      }

      /** Drop the stored credentials for one server (the user asked to start over). */
      const revokeOAuth = async (serverName) => {
        if (oauthPending !== '') return
        setOauthPending(serverName)
        try {
          const result = await sendOAuth({ action: 'logout', serverName })
          setOauthResult((previous) => ({ ...previous, [serverName]: result }))
        } finally {
          setOauthPending('')
        }
      }

      /**
       * 「已复制」的临时提示。
       *
       * 原来只 `setCopiedUrlFor(serverName)`，没有任何回退 —— 一次复制之后那个按钮永远写着
       * 「已复制」，用户无法判断第二次到底有没有生效。1.5 秒后自动回到「复制链接」。
       */
      const copiedTimerRef = useRef(null)
      const markCopied = (serverName) => {
        setCopiedUrlFor(serverName)
        if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current)
        copiedTimerRef.current = setTimeout(() => {
          copiedTimerRef.current = null
          setCopiedUrlFor('')
        }, 1500)
      }
      useEffect(() => () => {
        if (copiedTimerRef.current !== null) {
          clearTimeout(copiedTimerRef.current)
          copiedTimerRef.current = null
        }
      }, [])

      /**
       * Copy the authorization URL.
       *
       * Same interaction DSH's own account login uses — 「复制登录链接」 rather than opening a
       * browser automatically. That is not laziness: a Host-side `open` cannot work in a
       * remote/headless session, and would fail silently there.
       */
      const copyAuthorizeUrl = (serverName) => {
        const url = authorizeUrlFor(serverName)
        if (url === '') return
        try {
          void navigator.clipboard?.writeText?.(url)
          markCopied(serverName)
        } catch {
          // Clipboard can be unavailable (insecure origin, denied permission). The URL is
          // already selectable in the input next to the button, so nothing is lost.
          setCopiedUrlFor('')
        }
      }

      /** Runtime rows first; the client-side Loader inventory is the fallback. */
      const profileRows = useMemo(() => {
        const runtimeRows = Array.isArray(runtime.servers) ? runtime.servers : []
        if (runtimeRows.length > 0) return runtimeRows
        return inventoryRows
          .filter((row) => row.moduleName === '@deepseek-ai/dsh-mcp-client')
          .map((row) => ({
            entryId: row.entryId,
            serverName: row.entryId.replace(/^include:/, '').replace(/^mcp-/, ''),
            transport: '',
            target: '',
            enabled: row.enabled,
            phase: row.fiberPhase,
          }))
      }, [runtime.servers, inventoryRows])

      const debugOn = typeof location !== 'undefined' && /(?:^|[?&])smp=debug/.test(location.search)
      const debugMcp = inventoryRows.filter((row) => /mcp/i.test(row.entryId) || /mcp/i.test(row.moduleName))

      // Row actions are backed by HTTP routes now; there is no capability marker to wait for.
      const rowOpsReady = true

      // 只按名称搜索（以前是整行 JSON 匹配，会把 URL/参数/环境变量也算进去）
      const matches = (row) => matchesName(row.serverName ?? row.name, query)
      const isGlobal = (row) => (row.scope ?? 'global') === 'global'

      /**
       * Skills are **one list across every workspace**, exactly like MCP.
       *
       * There used to be a 项目 filter on this tab, and it hid every project skill except the
       * selected one — so a skill you had just added to another workspace simply was not on
       * screen. MCP dropped that filter when both tiers became rows; skills now do the same.
       * The workspace a card belongs to is on the card (its scope tag), which is the same way
       * a server says it.
       *
       * The dialog still picks a region (and, for a project skill, a workspace) — that is a
       * property of the entry being created, not a filter over the list.
       */
      // Skills already on disk (DSH's own roots) — listed read-only, not managed here.
      const skillDirs = runtime.skillDirs ?? {}
      const discoveredFromDoc = runtime.skills ?? []
      const docKeys = new Set(discoveredFromDoc.map((entry) => `${entry.name}::${entry.scope}`))
      const removedSet = new Set(removedKeys)
      const discovered = [
        ...discoveredFromDoc.filter((entry) => !removedSet.has(`${entry.name}::${entry.scope}`)),
        ...optimistic.filter((entry) => !docKeys.has(`${entry.name}::${entry.scope}`)),
      ]
      /**
       * Which on-disk root a skill came from (`dsh` or `agents`), from its `source`
       * (`user-agents`, `project-dsh`, …).
       *
       * This is what the card's tag needs: the scope says *whose* the skill is, and this says
       * which of the two roots under it the file actually lives in.
       */
      const rootIdOfSource = (source) => (String(source).endsWith("-agents") ? "agents" : "dsh")
      /**
       * 技能列表的可见范围：只按搜索词过滤。
       *
       * 这是**旧的平铺列表**用的投影（0.5.23 起 `技能` 页由来源分组视图承担，这份只剩汇总计数
       * 还在用它）。范围过滤在来源分组视图那边做 —— 那边才看得到来源。
       */
      const discoveredOnly = discovered.filter((entry) => matchesName(entry.name, query))
      /**
       * Human label for a project path: the workspace registry title when we
       * have one, otherwise the last path segment. A path the user typed by hand
       * (not in the registry) keeps its full spelling.
       */
      const knownProjects = new Map((runtime.workspaces ?? [])
        .filter((workspace) => typeof workspace?.path === 'string' && workspace.path !== '')
        .map((workspace) => [workspace.path, typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : workspace.path]))
      const projectLabel = (path) => {
        if (typeof path !== 'string' || path === '') return ''
        const known = knownProjects.get(path)
        if (known !== undefined) return known
        // Not a registered workspace: the user typed it, so show it in full.
        return path
      }
      /**
       * A project scope as a short card tag: the workspace registry title when the
       * path is known, otherwise the path's last segment. A tag has room for a name,
       * not for a path — the full path stays in the expanded 「作用域」 row.
       */
      /**
       * A scope as the card's tag.
       *
       * Global reads 「全局」 — a project reads the workspace's name. This is the **same
       * vocabulary on both tabs**: MCP used to leave a global row untagged and a skill used to
       * tag by *root* (`dsh` / `agents`), which answered a different question. The tag says
       * whose entry it is; which of the two roots under that scope holds the file is the
       * 「落盘」 row in the expanded details.
       *
       * A path that is not in the registry is the user's own, so its last segment is used: a
       * tag has room for a name, not a path.
       */
      const scopeTagLabel = (path) => {
        if (typeof path !== 'string' || path === '' || path === 'global') return '全局'
        const known = knownProjects.get(path)
        if (known !== undefined) return known
        const parts = path.replace(/\/+$/, '').split('/')
        return parts[parts.length - 1] || ''
      }

      /**
       * The absolute directory a skill is written to — the real path, not a label.
       *
       * The panel offers **four** writable roots: two per scope. DSH's own provider reads all
       * four (`src/skills/discover.js`), so "全局" is not one place but two
       * (`~/.agents/skills`, `~/.dsh/skills`), and so is a project
       * (`<工作区>/.agents/skills`, `<工作区>/.dsh/skills`). Showing the actual path is what
       * makes the choice checkable — 「全局 · agents」 does not tell you where that is.
       */
      const skillRootLabel = (scope, id) => {
        const useAgents = id === 'agents'
        const leaf = useAgents ? '.agents/skills' : '.dsh/skills'
        if (typeof scope !== 'string' || scope === '' || scope === 'global') {
          // The two user-level roots. Use the same values the Host publishes so the label is
          // the path that will actually be written, not a guess (`~` is expanded there).
          const dirs = skillDirs
          if (useAgents) return dirs.userAgents || '~/.agents/skills'
          return dirs.userDsh || '~/.dsh/skills'
        }
        return `${scope.replace(/\/+$/, '')}/${leaf}`
      }
      /**
       * The workspace a new **project-scoped** entry proposes.
       *
       * The toolbar project switch is gone, so nothing is preselected there any more; this is
       * where "which workspace" comes from. The session's own workspace first (that is the one
       * the user is working in), then whatever the panel already has entries for. The field is
       * editable, so this is a default and not a constraint.
       *
       * Deliberately not state: the old version copied the workspace into state once, which
       * then went stale as soon as the session moved. This is read at the moment the dialog
       * opens.
       */
      const defaultWorkspace = () => {
        const current = runtime.currentWorkspace
        if (typeof current === 'string' && current !== '') return current
        const configured = profileRows.map((row) => row.scope).find((scope) => typeof scope === 'string' && scope !== '' && scope !== 'global')
        return configured ?? ''
      }

      /** Row ops still queued: the Host applies them within a couple of seconds. */
      useEffect(() => {
        setInflight((current) => settleInflight(current, { profileRows }))
      }, [tick, profileRows, inflight])

      const pendingOps = []
      const pendingOf = (entryId) => pendingOps.find((op) => String(op?.entryId ?? '').replace(/^include:/, '') === String(entryId).replace(/^include:/, '')) ?? null
      /**
       * Project picker options: the workspace registry first (published by the
       * Host), then any project scope already configured in this panel.
       */
      /**
       * 注册表原始路径 → 技能真正落盘的项目根。
       *
       * `runtime.workspaces[].path` 是注册表原值（MCP 的「作用域」要能选到仓库子目录），
       * `root` 才是技能写盘/扫描用的项目根。技能相关的展示与提交都要过这个映射，否则
       * monorepo 子目录下「将写入 …」会指向一个文件根本不在的位置。
       */
      const rootOfScope = useMemo(() => {
        const map = new Map()
        for (const workspace of runtime.workspaces ?? []) {
          const path = typeof workspace?.path === 'string' ? workspace.path : ''
          if (path === '') continue
          const root = typeof workspace?.root === 'string' && workspace.root !== '' ? workspace.root : path
          map.set(path, root)
        }
        return map
      }, [runtime.workspaces])

      const projectChoices = useMemo(() => {
        const map = new Map()
        for (const workspace of runtime.workspaces ?? []) {
          const path = typeof workspace?.path === 'string' ? workspace.path : ''
          if (path !== '') map.set(path, typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : path)
        }
        // Any project scope the panel already has entries for, so the add dialog can offer a
        // workspace that is not (or no longer) in the registry.
        for (const row of profileRows) {
          const scope = row?.scope
          if (typeof scope === 'string' && scope !== '' && scope !== 'global' && !map.has(scope)) map.set(scope, scope)
        }
        return [...map.entries()]
      }, [profileRows, runtime.workspaces, form, tick])

      /**
       * 技能相关的项目下拉：用**归一化到项目根**的路径，并按根去重。
       *
       * `projectChoices` 保留注册表原值（MCP 的「作用域」要能选到仓库子目录），而技能写盘与
       * 扫描用 `projectRootOf` 归一化到仓库根。两处混用会让 monorepo 子目录下的工作区：
       * 「将写入 …」显示成 `<子目录>/.dsh/skills`，而文件实际落在 `<仓库根>/.dsh/skills`。
       */
      const skillProjectChoices = useMemo(() => {
        const rootOf = new Map()
        for (const workspace of runtime.workspaces ?? []) {
          const path = typeof workspace?.path === 'string' ? workspace.path : ''
          if (path === '') continue
          const root = typeof workspace?.root === 'string' && workspace.root !== '' ? workspace.root : path
          rootOf.set(path, root)
        }
        const map = new Map()
        for (const [path, title] of projectChoices) {
          const root = rootOf.get(path) ?? path
          if (!map.has(root)) map.set(root, title)
        }
        return [...map.entries()]
      }, [projectChoices, runtime.workspaces])
      /**
       * Workspace paths in registry order — the order MCP groups are displayed in.
       *
       * Deliberately only the registry, not `projectChoices`: the picker appends
       * hand-typed paths so they stay selectable, but the *display* order should be the
       * one the user sees in DSH's own workspace list. Scopes outside the registry sort
       * after the known ones (see `orderedScopeGroups`).
       */
      const workspacePaths = useMemo(() => (runtime.workspaces ?? [])
        .map((workspace) => (typeof workspace?.path === 'string' ? workspace.path : ''))
        .filter((path) => path !== ''), [runtime.workspaces])

      /**
       * 技能落点用的项目根（去重）。
       *
       * `workspaces[].path` 是注册表原值（MCP 的「作用域」要能选到仓库子目录），`root` 才是
       * 技能写盘/扫描真正用的项目根。技能相关的下拉与展示必须用后者，否则「将写入 …」与
       * 文件的真实位置会不一致。
       */
      const skillWorkspaceRoots = useMemo(() => [...new Set((runtime.workspaces ?? [])
        .map((workspace) => String(workspace?.root ?? workspace?.path ?? ''))
        .filter((path) => path !== ''))], [runtime.workspaces])

      async function write(field_, value) {
        setBusy(true)
        setError('')
        try {
          if (typeof form?.set === 'function') await form.set(field_, value)
          else if (props.mutate) await props.mutate(NS, [{ op: 'set', path: [field_], value }])
          refresh()
          // 技能增删改也走这里；写完让运行时列表跟着刷新一次。
          bumpRefresh()
          // 调用方据此决定要不要清掉本地草稿（见 `saveFilters`）。
          return true
        } catch (cause) {
          setError(String(cause?.message ?? cause))
          return false
        } finally {
          setBusy(false)
        }
      }

      /**
       * The Host's own id for a row: the projection reports loader entry ids
       * (`include:mcp-context7`) while the profile patch keys rows by their bare id.
       */
      const bareRowId = (entryId) => String(entryId).replace(/^include:/, '').replace(/^[a-z-]+:/i, '')

      /**
       * Send one command against a profile-configured row.
       *
       * Over HTTP, to the Host's own route: the write takes ~1–5 ms, and this is the only
       * transport whose round-trip is in the same order of magnitude. The settings queue it
       * replaced cost 2–4 s of *waiting* per command (a 500 ms drain poll, a fixed 1200 ms
       * pause, the Loader reload, then this panel's own poll) — which is what made adding or
       * deleting a server feel like it needed a manual edit of the yml.
       *
       * The queue is still written when the route is unusable (an older Host, a profile without
       * a web server, or a request that failed outright): the Host drains both, so falling back
       * is safe, and the user's command is never silently dropped.
       *
       * Returns the Host's `{ ok, reason }`. Callers show `reason` on failure and roll their
       * optimistic state back — the point of the short path is that a failure is known in
       * milliseconds, not after a 15 s timeout.
       */
      const sendRowOp = async (op) => {
        const payload = { ...op, entryId: bareRowId(op.entryId) }
        if (typeof fetch !== 'function') return { ok: false, reason: '当前环境没有 fetch' }
        try {
          const response = await fetch(`/${NS}/rows`, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          // 404/405: this Host has no command route; 401/403: the request was not trusted.
          if (response.status === 404 || response.status === 405) {
            return { ok: false, reason: '这个 Host 没有行命令路由（Host 侧改动需要重启一次 DSH）' }
          }
          if (response.status === 401 || response.status === 403) {
            return { ok: false, reason: '请求未被信任（请从 DSH 面板里操作）' }
          }
          if (!response.ok) {
            let reason = `HTTP ${String(response.status)}`
            try {
              const body = await response.json()
              if (typeof body?.reason === 'string' && body.reason !== '') reason = body.reason
            } catch { /* keep the status code */ }
            return { ok: false, reason }
          }
          const result = await response.json()
          if (result?.ok === true) {
            return { ok: true, reason: '', servers: Array.isArray(result.servers) ? result.servers : null }
          }
          return { ok: false, reason: String(result?.reason ?? '写入失败') }
        } catch (error) {
          return { ok: false, reason: String(error?.message ?? error) }
        }
      }

      /**
       * Send one skill **write** to the Host, preferring the HTTP route.
       *
       * Same reasoning as `sendRowOp` above, and the same three-way fallback. The measured
       * problem: writing the file takes **1 ms**, but the settings-queue round-trip stacked four
       * polls (600 ms request drain + this panel's settings poll + the Host's 2 s reconcile tick
       * + the 5 s projection publish) for a worst case of **9.1 s**. Deleting only *looked* fast
       * because it drops its card optimistically — it used the same slow channel.
       *
       * `read` deliberately stays on the queue: it is a read, it already shows 「正在读取正文…」,
       * and the route refuses it (so a mistake here fails loudly instead of silently working).
       *
       * Returns `{ ok, reason, queued? }`. A queued send is reported as success because the Host
       * will drain it — the caller must not roll back an optimistic card in that case.
       */
      const sendSkillWrite = async (request) => {
        if (typeof fetch !== 'function') return { ok: false, reason: '当前环境没有 fetch' }
        try {
          const response = await fetch(`/${NS}/skills`, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request),
          })
          if (response.status === 404 || response.status === 405) {
            return { ok: false, reason: '这个 Host 没有技能写入路由（Host 侧改动需要重启一次 DSH）' }
          }
          if (response.status === 401 || response.status === 403) {
            return { ok: false, reason: '请求未被信任（请从 DSH 面板里操作）' }
          }
          if (!response.ok) {
            let reason = `HTTP ${String(response.status)}`
            try {
              const body = await response.json()
              if (typeof body?.reason === 'string' && body.reason !== '') reason = body.reason
            } catch { /* keep the status code */ }
            return { ok: false, reason }
          }
          const result = await response.json()
          if (result?.ok === true) return { ok: true, reason: '' }
          return { ok: false, reason: String(result?.reason ?? '写入失败') }
        } catch (error) {
          return { ok: false, reason: String(error?.message ?? error) }
        }
      }

      /** Read one skill body (GET; only files the Host's scan found are readable). */
      const readSkillBody = async (path) => {
        if (typeof fetch !== 'function') return { ok: false, reason: '当前环境没有 fetch' }
        if (typeof path !== 'string' || path === '') return { ok: false, reason: '没有文件路径' }
        try {
          const response = await fetch(`/${NS}/skill?path=${encodeURIComponent(path)}`, {
            credentials: 'same-origin', cache: 'no-store',
          })
          if (response.status === 404 || response.status === 405) {
            return { ok: false, reason: '这个 Host 没有技能读取路由（Host 侧改动需要重启一次 DSH）' }
          }
          if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
          return await response.json()
        } catch (error) {
          return { ok: false, reason: String(error?.message ?? error) }
        }
      }

      /** Run one reconnect command; the response is the outcome. */
      const sendReconnect = async ({ tier, serverName, scope }) => {
        if (typeof fetch !== 'function') return { ok: false, reason: '当前环境没有 fetch' }
        try {
          const response = await fetch(`/${NS}/reconnect`, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tier, serverName, scope }),
          })
          if (response.status === 404 || response.status === 405) {
            return { ok: false, reason: '这个 Host 没有重连路由（Host 侧改动需要重启一次 DSH）' }
          }
          if (response.status === 401 || response.status === 403) {
            return { ok: false, reason: '请求未被信任（请从 DSH 面板里操作）' }
          }
          if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
          return await response.json()
        } catch (error) {
          return { ok: false, reason: String(error?.message ?? error) }
        }
      }

      /** Ask the Host to scan one external tool's MCP config files. */
      const scanImport = async ({ source, scope, project }) => {
        if (typeof fetch !== 'function') return { ok: false, files: [], servers: [], error: '当前环境没有 fetch' }
        try {
          const response = await fetch(`/${NS}/import`, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source, scope, project }),
          })
          if (response.status === 404 || response.status === 405) {
            return { ok: false, files: [], servers: [], error: '这个 Host 没有导入扫描路由（Host 侧改动需要重启一次 DSH）' }
          }
          if (response.status === 401 || response.status === 403) {
            return { ok: false, files: [], servers: [], error: '请求未被信任（请从 DSH 面板里操作）' }
          }
          if (!response.ok) return { ok: false, files: [], servers: [], error: `HTTP ${response.status}` }
          return await response.json()
        } catch (error) {
          return { ok: false, files: [], servers: [], error: String(error?.message ?? error) }
        }
      }

      /**
       * Send one OAuth command to the Host.
       *
       * Unlike rows and skill writes this has **no fallback channel**, on purpose. The
       * settings queue cannot carry the answer: `authorize` must return an authorization URL
       * the user is about to open, and a queue round-trip is 2–4 s of blank dialog with
       * nothing to show. So a missing route is reported as "this Host cannot do OAuth"
       * rather than being silently downgraded — the honest failure is the useful one here.
       *
       * Returns `{ ok, ...payload }`. Never throws: a thrown error inside a click handler
       * would leave the card spinning forever.
       */
      const sendOAuth = async ({ action, serverName }) => {
        if (typeof fetch !== 'function') return { ok: false, reason: '当前环境没有 fetch，无法发起授权' }
        try {
          const response = await fetch(`/${NS}/oauth`, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, serverName }),
          })
          // 404/405: this Host has no OAuth route (older build, or the Host half failed to
          // register). 401/403: the request was not trusted. Both mean "the feature is not
          // available here", which the card must say instead of pretending to try.
          if (response.status === 404 || response.status === 405) {
            return { ok: false, reason: '这个 Host 版本没有 OAuth 通道（Host 侧改动需要重启一次 DSH）' }
          }
          if (response.status === 401 || response.status === 403) {
            return { ok: false, reason: '请求未被信任（请从 DSH 面板里操作）' }
          }
          if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
          const result = await response.json()
          return result !== null && typeof result === 'object' ? result : { ok: false, reason: '响应格式无效' }
        } catch (error) {
          return { ok: false, reason: String(error?.message ?? error) }
        }
      }

      /**
       * The filter rule for one server, in the shape the editor needs.
       *
       * The panel stores the rule per server, so every edit rewrites just that one
       * key and leaves the other servers' rules alone — the settings document is
       * shared, and replacing the whole map would clobber a concurrent edit.
       */
      const filterFor = (serverName) => {
        const rule = toolFilters[serverName]
        return {
          mode: rule?.mode === 'allow' || rule?.mode === 'deny' ? rule.mode : 'off',
          tools: Array.isArray(rule?.tools) ? rule.tools : [],
        }
      }

      /**
       * 未保存的工具勾选改动，按服务器名索引。
       *
       * ## 为什么勾选不能直接写文档
       *
       * 勾选原来每次都 `write('toolFilters', …)`，也就是每次都会改一次 settings 文档。
       * 而设置壳层在文档变更后会**重新挂载** section：展开的服务器卡片被收起、页签跳回
       * 默认。于是「连续勾选多个工具」变成「勾一个、重新展开一次」的拉锯。
       *
       * 现在勾选只改这份草稿，点「保存修改」才提交 —— 整份 `toolFilters` 是一个字段，
       * 所以无论改了几台服务器，都只有**一次**写入、一次重载。
       */
      const [filterDraft, setFilterDraft] = useState(PANEL_UI.filterDraft)
      /**
       * 草稿也写进模块作用域：勾到一半关掉设置面板（或保存那一次触发的重挂载）不该把
       * 未保存的勾选丢掉。页面重新加载时才清空（见 `apply`）。
       */
      useEffect(() => { PANEL_UI.filterDraft = filterDraft }, [filterDraft])

      /** 渲染用的规则：草稿优先，其次是已保存的值。 */
      const draftRuleFor = (serverName) => filterDraft[serverName] ?? filterFor(serverName)

      /** 有几台服务器带未保存的勾选改动。 */
      const filterDirtyCount = Object.keys(filterDraft).length

      /** 把一处改动放进草稿；改回与已保存一致时把这一条撤掉，免得脏计数虚高。 */
      const stageFilter = (serverName, next) => {
        setFilterDraft((current) => {
          const saved = filterFor(serverName)
          const sameTools = next.tools.length === saved.tools.length
            && next.tools.every((name) => saved.tools.includes(name))
          if ((next.mode ?? 'off') === saved.mode && sameTools) {
            if (!(serverName in current)) return current
            const rest = { ...current }
            delete rest[serverName]
            return rest
          }
          return { ...current, [serverName]: { mode: next.mode, tools: next.tools } }
        })
      }

      /** 提交草稿：一次写入整份 `toolFilters`。 */
      const saveFilters = async () => {
        const names = Object.keys(filterDraft)
        if (names.length === 0) return
        /** 提交出去的那一版草稿：成功后只清掉"与它一致"的项。 */
        const submitted = {}
        const map = { ...toolFilters }
        for (const name of names) {
          const rule = filterDraft[name]
          submitted[name] = JSON.stringify(rule)
          if (rule.mode === 'off') delete map[name]
          else map[name] = { mode: rule.mode, tools: rule.tools }
        }
        const saved = await write('toolFilters', map)
        // 写失败时**保留**草稿：`write` 已经把原因放进 error，用户勾的东西不能凭空消失。
        if (saved === false) return
        /**
         * 成功后**不能**整体清空草稿：写入要几百毫秒，期间用户可能又勾了一个工具 ——
         * 整体 `setFilterDraft({})` 会把那个还没来得及保存的勾选一起抹掉，看起来像"点了没生效"。
         * 所以只移除"提交时是什么样、现在还是什么样"的那些项；变过的（新勾的/新改的）留着继续脏。
         */
        setFilterDraft((current) => {
          const next = { ...current }
          for (const name of names) {
            if (JSON.stringify(current[name]) === submitted[name]) delete next[name]
          }
          return next
        })
        /**
         * 规则一改就让它**当场生效**。
         *
         * 过滤器在注册那一刻判定，被挡下的工具从未进注册表；只改规则不会让 DSH 的 MCP 客户端
         * 重新上报。所以主动请求 Host 把"该放行、但注册表里还缺"的工具补注册回去 ——
         * 否则徽标要等到重启才更新（用户已经为此抱怨过一次）。
         */
        void syncToolRegistrations(names).then(() => bumpRefresh())
      }

      /**
       * 请求 Host 补注册"该放行却还没注册"的工具。
       *
       * 失败也 resolve：这是尽力而为的动作，不该在界面上报错打断保存流程。
       */
      async function syncToolRegistrations(serverNames = []) {
        if (typeof fetch !== 'function') return { ok: false, reason: '当前环境没有 fetch' }
        try {
          const controller = typeof AbortController === 'function' ? new AbortController() : null
          const timer = controller === null ? null : setTimeout(() => controller.abort(), 40000)
          const response = await fetch(`/${NS}/tools-sync`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // 只重启本次规则改动涉及的服务器，别惊动整机。
            body: JSON.stringify({ servers: serverNames }),
            ...(controller === null ? {} : { signal: controller.signal }),
          }).finally(() => { if (timer !== null) clearTimeout(timer) })
          if (response?.ok !== true) return { ok: false, reason: `HTTP ${response?.status ?? '?'}` }
          return await response.json()
        } catch (error) {
          return { ok: false, reason: String(error?.message ?? error) }
        }
      }

      /** Strip the `mcp__<server>__` prefix so the list shows only what differs. */
      const leafOf = (serverName) => (fullName) => {
        const prefix = `mcp__${serverName}__`
        return fullName.startsWith(prefix) ? fullName.slice(prefix.length) : fullName
      }

      /**
       * Connection status for one server, as the Host published it.
       *
       * Matched on tier **and** scope: the same serverName can legitimately exist as a
       * global row and as a project entry, and they are different connections with
       * different fates — showing one's status on the other's card would be a lie.
       */
      const statusFor = (serverName, tier, scope) => {
        if (typeof serverName !== 'string' || serverName === '') return null
        const wantScope = scope ?? ''
        /**
         * 精确匹配 scope 优先；回退只在**没有歧义**时进行。
         *
         * 原来无条件回退到"同名同 tier 的第一条"：同名服务器同时存在于全局与某个项目、
         * 且该行状态缺失时，会把另一行的「已连接」显示出来 —— 串状态比"状态未知"更误导。
         */
        const matches = serverStatus.filter((item) => item.serverName === serverName && item.tier === tier)
        if (matches.length === 0) return null
        return matches.find((item) => (item.scope ?? '') === wantScope)
          ?? (matches.length === 1 ? matches[0] : null)
      }

      /**
       * Dotted status, in the shape Chrome's extension list uses: a small coloured dot,
       * then the state in words, then the supporting numbers.
       *
       * The pill these replaced read as a **badge** — a pebble sitting at the end of the
       * row, visually as heavy as the card's own tags (「已停用」/「配置文件」), which made a
       * routine state look like a warning and a real warning look like chrome. A dot does
       * the opposite: colour carries the signal at a glance, the word beside it carries the
       * meaning, and weight drops out of the way.
       *
       * Four colours cover every state, and only four — a fifth would mean two states that
       * look alike but need different actions:
       *   ok      绿  连上了，可用
       *   warn    黄  还在自己努力（连接中）**或**在等你动手（需要授权）
       *   danger  红  不会自愈（已放弃重试 / 异常）
       *   neutral 灰  没什么可报告（未挂载 / 状态未知 / 已关闭）
       *
       * 黄与红的分界是「要不要用户动手、以及会不会自己好」：连接中会在预算内自愈，
       * 需要授权等用户补凭据，两者都还没失败。红只留给必须用户处理且**不会**自己好的。
       * 主题里除红/绿外只有一档状态色，所以「需要授权」与「连接中」同为黄 —— 区分靠文字。
       *
       * `detail` rides on the `title`, which is where a long explanation belongs: the
       * row stays one line, and hovering gives the whole reason (including why an auth
       * challenge is not a failure).
       */
      const STATUS_DOTS = {
        connected: { dot: 'ok', text: '可用' },
        // 「连接中」同时覆盖首次连接（pending）与断线重试（retrying）：对用户来说是同一件事
        // ——还在连。区分它们只会让标签更长，而两档都不需要用户动手。
        retrying: { dot: 'warn', text: '连接中' },
        pending: { dot: 'warn', text: '连接中' },
        'gave-up': { dot: 'danger', text: '已放弃重试' },
        failed: { dot: 'danger', text: '异常' },
        // 需要授权**不是故障**：受保护的服务器拒绝未授权连接是协议规定的正常行为，
        // 红色会让人去修一台根本没坏的服务器。黄 = 有一件事等你做。
        'needs-auth': { dot: 'warn', text: '需要授权' },
        unmounted: { dot: 'neutral', text: '未挂载' },
        disabled: { dot: 'neutral', text: '已关闭' },
        // 观测机制没装上时如实说「状态未知」。只在 Host 明确报告 unknown 时出现
        // （旧 Host 根本不发布 serverStatus，那种情况整个标签都不渲染）——
        // 因为「看不见」和「一切正常」长得一样，是这类告警最坏的失败方式。
        unknown: { dot: 'neutral', text: '状态未知' },
      }

      const statusDot = (serverName, tier, scope) => {
        const item = statusFor(serverName, tier, scope) ?? (serverToolsError?.reason ? {
          status: 'unknown', detail: serverToolsError.reason === 'loading' ? '正在读取连接状态' : serverToolsError.detail,
        } : null)
        const spec = STATUS_DOTS[item?.status]
        if (spec === undefined) return null
        // 数字只对「已经量出来的东西」有意义：连上了才有工具数，重试中才有剩余时间。
        // 其余状态挂一个 0 只会让人以为「它没有工具」。
        const tools = item.status === 'connected' && item.toolCount > 0 ? `${item.toolCount} 个工具` : ''
        // Time left is an estimate from the configured budget, so it is labelled as one.
        const left = item.status === 'retrying' && item.remainingSeconds > 0 ? `约 ${item.remainingSeconds}s` : ''
        const trailing = [tools, left].filter((part) => part !== '')
        return (
          <span className="smp-status" key="status" title={item.detail || undefined}>
            <span className="smp-dot" data-dot={spec.dot} key="d" aria-hidden="true" />
            <span className="smp-statusText" key="t">{spec.text}</span>
            {trailing.map((part, index) => (
              <span className="smp-statusMeta" key={`m${index}`}>{part}</span>
            ))}
          </span>
        )
      }

      /**
       * Manual re-connect for a server that will not recover on its own.
       *
       * Offered exactly where it helps: the mcp-client gives up permanently once its
       * retry budget runs out, and only a **new instance** (or a raised budget) brings
       * it back. Not offered while connected, disabled, or unmounted — there would be
       * nothing to re-establish.
       *
       * Returns `{ node, failure }` rather than a bare node: the failure text belongs
       * inside the popup (under the item it came from), not beside the trigger, so the
       * caller needs both pieces.
       */
      const reconnectAction = (serverName, tier, scope) => {
        // 白名单，不是黑名单 —— 这个方向很重要。
        //
        // 「重连」只在**确实卡住且重连有意义**时才出现：已放弃重试 / 异常 / 连接中
        // （连接中给它是为了让用户能立刻催一次，而不是等预算跑完）。
        //
        // 其余一律不给，而且每一条都有理由：
        //   connected  连着，重连只会打断它
        //   needs-auth 缺的是**授权**不是连接 —— 重连治不了，给了等于教用户反复点无效按钮
        //   unknown    不知道状态，重连可能修好也可能搞坏一台正常的
        //   unmounted  当前会话里压根没挂，没有连接可重建
        //   disabled   停用了（调用方也会挡住整组操作）
        //
        // 写黑名单时漏掉一个状态就会多给一个按钮（needs-auth 就这么漏过一次），
        // 而白名单漏掉一个只是**少**给一个按钮 —— 后者是可以接受的失败方向。
        const item = statusFor(serverName, tier, scope)
        const RECONNECTABLE = new Set(['gave-up', 'failed', 'retrying', 'pending'])
        if (item === null || !RECONNECTABLE.has(item.status)) return null
        const state = reconnectState[serverName] ?? {}
        const waiting = state.pending === true
        const failure = String(state.error ?? '')
        return {
          node: (
            <button
              className="smp-menuItem" key="reconnect" disabled={busy || waiting}
              onClick={() => {
                setReconnectState((current) => ({ ...current, [serverName]: { pending: true, error: '' } }))
                void sendReconnect({ tier, serverName, scope: scope ?? '' }).then((result) => {
                  setReconnectState((current) => ({
                    ...current,
                    [serverName]: { pending: false, error: result.ok ? '' : String(result.reason ?? '重连失败') },
                  }))
                  if (result.ok) bumpRefresh()
                })
              }}
            >
              {waiting ? '重连中…' : '重连'}
            </button>
          ),
          failure,
        }
      }

      /**
       * A small horizontal switch, the shape a plugin list uses for on/off.
       *
       * Replaces the 「启用 / 停用」 button pair: a switch says which state the row is in
       * as well as offering the change, and it reads at a glance across a column of rows.
       * The button only said what clicking would do, so a disabled row looked identical
       * to an enabled one until you read the label.
       *
       * Optimistic while the op is in flight (`inflight` carries the expected value), so
       * the knob moves on click instead of after the Host's round trip — with a 2s window
       * and an HMR write behind it, waiting reads as "the click did nothing".
       */
      /**
       * Send a command, then either confirm it (drop the spinner) or undo it and say why.
       *
       * Optimistic UI is only honest if a failure is visible: the card disappeared (or the
       * switch moved) the moment it was clicked, so a rejected command has to put it back and
       * report the reason. Silently keeping the optimistic state would show the user a config
       * the file does not contain — worse than the wait this replaced.
       *
       * On success the entry is **kept but marked `confirmed`**, which is not the same as
       * settling it. The spinner means "we are still writing"; once the Host has answered, that
       * question is answered and the spinner must go — it used to stay until the *projection*
       * came back on the panel's next poll, which is up to ~1.5 s of spinning after a write
       * that took milliseconds. The entry stays until the row actually appears so the card
       * keeps rendering from the confirmed values: dropping it here would make an added card
       * vanish and flash back when the projection landed.
       */
      const commandRowOp = (op, entryId) => {
        const key = inflightKeyForRow(entryId)
        // 返回 Promise：表单要**等回执**再决定关不关，否则写失败时用户填的东西就没了。
        return sendRowOp(op).then((result) => {
          if (result.ok) {
            setInflight((m) => (m[key] === undefined ? m : { ...m, [key]: { ...m[key], confirmed: true } }))
            // The route answers with the rows it just wrote: apply them before the poll.
            if (Array.isArray(result.servers)) {
              setRuntime((current) => ({ ...current, servers: result.servers }))
            }
            bumpRefresh()
            return result
          }
          setInflight((m) => {
            const next = { ...m }
            delete next[key]
            return next
          })
          setError(result.reason)
          return result
        })
      }

      const enabledSwitch = (row) => {
        const key = inflightKeyForRow(row.entryId)
        const on = row.enabled !== false
        const expected = inflight[key]?.kind === 'toggle' ? inflight[key].expectEnabled : undefined
        const shown = expected === undefined ? on : expected
        const toggle = (next) => {
          setInflight((m) => ({ ...m, [key]: { kind: 'toggle', at: Date.now(), expectEnabled: next } }))
          commandRowOp(toggleServerOp(row.entryId, next), key)
        }
        const label = shown ? '停用' : '启用'
        /**
         * The Host's own switch, so this control looks like every other toggle in the
         * settings app — same capsule, same thumb, same brand colour, and the same rule that
         * the visual state keys off `aria-checked` rather than a parallel class. Our
         * hand-rolled pill was a different size *and* a different colour, which read as
         * "this is some third party's control".
         *
         * `@deepseek-ai/*` is external in the bundle, so this resolves against the running
         * Host and cannot drift. The fallback is only for a Host that predates it.
         *
         * Shared with the form's connection switches (`switchControl`) so there is one
         * implementation of "a boolean control in this panel", not three that drift.
         */
        return switchControl(shown, toggle, label, busy)
      }

      /**
       * The `…` trigger plus its vertical popup.
       *
       * Why a popup instead of a row of buttons: three buttons per card made the action
       * area wider than the identity it belonged to, and on a two-column grid they pushed
       * the server name out of view. A menu keeps the row calm and puts the actions one
       * click away, which is where a rarely used 删除 belongs anyway.
       *
       * The panel closes on outside click and on Escape, because a menu that survives an
       * unrelated click is a trap: the next click lands on a menu item the user never
       * meant to open.
       */
      const moreMenu = (row, items) => {
        const open = menuFor === row.entryId
        const visible = items.filter((item) => item !== null && item !== undefined)
        if (visible.length === 0) return null
        return (
          <span className="smp-more" key="more">
            <button
              className="smp-moreTrigger" key="t" type="button" disabled={busy}
              aria-haspopup="menu" aria-expanded={open} aria-label="更多操作"
              onClick={(event) => {
                if (open) {
                  setMenuFor('')
                  return
                }
                /**
                 * 打开前量一次触发按钮的位置，决定菜单往下还是往上，并换算成视口坐标。
                 * 量不出来（离线渲染、没有布局）时 anchor 为 null，菜单退回 CSS 的默认
                 * 绝对定位 —— 那正是测试渲染器走的那条路。
                 */
                const rect = event?.currentTarget?.getBoundingClientRect?.()
                setMenuAnchor(measureMenuAnchor({
                  rect,
                  // 每一版增删菜单项都会改变高度，所以按**当前**项数估，不写死数字。
                  itemCount: visible.length,
                  viewportWidth: globalThis.window?.innerWidth,
                  viewportHeight: globalThis.window?.innerHeight,
                }))
                setMenuFor(row.entryId)
              }}
            >
              ⋯
            </button>
            {open ? (
              <>
                {/* 点击遮罩关闭：不能让菜单在一次无关的点击后还开着，
                    否则下一次点击会落在用户没打算打开的菜单项上。 */}
                <span className="smp-menuScrim" key="scrim" onClick={() => setMenuFor('')} />
                <span
                  className="smp-menu" key="menu" role="menu"
                  data-placement={menuAnchor?.placement ?? 'down'}
                  style={anchorStyle(menuAnchor)}
                >
                  {visible}
                </span>
              </>
            ) : null}
          </span>
        )
      }

      const head = pageHead()

      const tabs = tabStrip({
        active: tab,
        /**
         * 页签数字 = **实际启用生效的数量**，不是"磁盘上有多少"。
         *
         * 用户的原话：显示 `Skills (24)` 而实际生效只有 10 个，这个数字就是错的。
         * 别的页面（设置里的插件清单）也都是"启用 N"，口径必须统一。
         *
         * 技能这边直接读 runtime：`governanceSources` 在后面才声明（TDZ），而页签需要更早
         * 拿到数字。口径由 `countSkills` 保证唯一 —— 页签、摘要、总账都走它。
         */
        counts: {
          mcp: profileRows.filter((row) => row.enabled !== false).length,
          skills: countSkills(runtime.skillGovernance?.sources, 'all').visible,
        },
        onSelect: (next) => { setTab(next); setEditing(null); setExpandedCards([]) },
      })

      /** One row holding the search and the project switch, like the reference page. */
      /**
       * The MCP "add" action, on the search row.
       *
       * It no longer needs a project to be selected first: the scope is chosen inside the
       * form. (It used to be disabled until a project was picked, because a project server
       * had nowhere to record its scope but the toolbar.)
       */
      const mcpAddButton = () => (
        <button
          className="smp-button" data-variant="primary" key="add" disabled={busy}
          onClick={() => {
            setEditing({ kind: "mcp", tier: "global", id: undefined })
            /**
             * A new server's form opens on the values that will actually be written.
             *
             * The reconnect numbers used to be blank with the default only in the placeholder
             * («500（默认）»), and the write path omitted the keys so the client supplied
             * them. That made the form read as "unset" while a real value was in force, and
             * the value lived in another package. Both halves now state them: the inputs are
             * prefilled and `connectionFields` writes them (see src/mcp/connection.js).
             *
             * `command` defaults to npx for the same reason — it is the overwhelmingly common
             * stdio executable, and typing it every time is friction with no decision behind it.
             */
            setDraft({
              transport: "streamable-http",
              command: HINTS.command,
              ...CONNECTION_DRAFT_DEFAULTS,
            })
            // The scope defaults to the session's own workspace when there is one — that is
            // almost always the one meant — and the form is where it gets changed. It used to
            // come from the toolbar's project selector, which no longer exists.
            setScopeDraft({ value: defaultWorkspace(), custom: false })
          }}
        >
          添加服务器
        </button>
      )

      /**
       * The skills "add" action, on the search row — the same slot MCP uses.
       *
       * No project is preselected from the toolbar any more: there is no toolbar project
       * switch (the list is cross-workspace now), so the dialog opens on a **global** root and
       * the region picker is where you choose. Picking a project region reveals the workspace
       * field, defaulted to the session's own workspace — that is almost always the one meant.
       */
      const skillsAddButton = () => (
        <button
          className="smp-button" data-variant="primary" key="add" disabled={busy}
          onClick={() => {
            setSkillError("")
            setSkillDraft({ name: "", description: "", body: "" })
            // Reset the in-flight markers. They are cleared by a matching receipt, so an op that
            // never got one (a cancel, a Host reload, a dropped request) used to leave the dialog
            // showing 「保存中…」 + 「正在与磁盘同步…」 the moment it opened — with nothing in flight.
            resetSkillPending()
            setSkillDialog({
              mode: "add", scope: "global", id: "dsh",
              // Remembered for when the tier is switched to 项目级: the workspace the user is
              // working in is almost always the one meant, but it is not preselected while the
              // destination is a user-level root.
              project: defaultWorkspace(), projectCustom: false, prevName: "",
            })
          }}
        >
          添加技能
        </button>
      )

      const filterRowView = filterRow({
        query,
        onQuery: setQuery,
        // Neither tab has a project switch: MCP never needed one (a server's scope is chosen in
        // its own form) and skills no longer do either (the list shows every workspace at once,
        // and a skill's workspace is chosen in the add dialog).
        placeholder: tab === 'mcp' ? '搜索名称' : '搜索技能名称',
        // Both tabs put their primary action on this row, in the same slot: the trigger and
        // the list it appends to stay on one screen. (MCP used to keep its form at the
        // bottom of the list while this button sat at the top, so the click looked inert.)
        actions: tab === 'mcp' ? mcpAddButton() : skillsAddButton(),
      })

      /**
       * The 「需要授权」block: what is happening, and the one action that can fix it.
       *
       * Rendered inside the expanded details rather than only as a tag: a tag alone leaves the
       * user with "需要授权" and no idea what to do, and the default assumption for a
       * non-connected server is "it is broken" — the exact misreading this status exists to
       * prevent. The Host's `detail` already says "这不是故障", so it is shown verbatim and
       * only the next step is added here.
       *
       * **Two different next steps**, decided by the Host's `oauthState.ready`:
       *
       *   · OAuth available → a 「授权」 button. Clicking it returns an authorization URL; the
       *     user opens it, logs in, and the callback lands on the Host's own port. This is
       *     the whole point of the feature.
       *   · OAuth unavailable → the old advice (add an `Authorization` header by hand), plus
       *     the Host's stated reason. Never a button that cannot work: a button that fails
       *     silently is worse than no button, because it looks like the user's fault.
       *
       * Deliberately still offers no 重连: reconnecting cannot supply a missing grant.
       */
      function needsAuthNote(serverName, tier, scope) {
        const item = statusFor(serverName, tier, scope)
        if (item?.status !== 'needs-auth') return null
        const why = String(item.detail ?? '') || '这台服务器要求先授权（OAuth）才能连接，这不是故障。'
        const ready = oauthState?.ready === true
        if (!ready) {
          const reason = String(oauthState?.detail ?? '')
          return (
            <p className="smp-note" key="needsAuth" style={{ marginTop: 6 }}>
              {`${why} 这个 Host 不支持 OAuth${reason === '' ? '' : `（${reason}）`}，改用 Authorization 请求头或带 token 的地址。`}
            </p>
          )
        }
        const failure = oauthFailureFor(serverName)
        const pending = oauthPending === serverName
        const status = oauthServerState(serverName)
        return (
          <div className="smp-note" key="needsAuth" style={{ marginTop: 6 }}>
            <p style={{ margin: 0 }}>{why}</p>
            <div className="smp-oauthRow">
              <button
                className="smp-button" data-variant="primary" type="button" disabled={pending}
                onClick={() => void startOAuth(serverName)}
              >
                {/**
                 * 「授权」还是「重新授权」，由**磁盘上有没有凭据**决定，和菜单里那个
                 * 入口用同一个判据。
                 *
                 * 真机上这两处曾经各说各话：菜单说「重新授权」（因为凭据确实在），
                 * 正文按钮说「授权」（因为它只看连接状态）。同一个动作两个名字，用户
                 * 会以为按钮要重新走一遍全新的流程。
                 */}
                {pending ? '正在获取授权链接…' : status.present ? '重新授权' : '授权'}
              </button>
              {status.present && status.refreshable === true ? (
                <button
                  className="smp-button" type="button" disabled={pending}
                  onClick={() => void revokeOAuth(serverName)}
                >
                  清除凭据
                </button>
              ) : null}
            </div>
            {/**
               * 已经有凭据却仍然被要求授权 —— 说明**服务器不接受这份令牌**，而不是
               * 「还没授权」。这两种情况要分开说：前者重试没有意义，得重新授权或去
               * 检查服务器端的鉴权配置；后者才是点一下就好。
               */}
            {status.present === true && failure === '' ? (
              <p className="smp-note" style={{ margin: '4px 0 0' }}>
                {"已经保存了授权凭据，但这台服务器仍然拒绝了连接。可能是令牌被撤销、或服务器端的鉴权配置变了 —— 重新授权通常能解决；若反复失败，请检查服务器是否还要求其它的请求头。"}
              </p>
            ) : null}
            {failure === '' ? null : <p className="smp-note smp-oauthError" style={{ margin: '4px 0 0' }}>{failure}</p>}
            {authorizeUrlFor(serverName) === '' ? null : (
              <div className="smp-oauthLink">
                <p style={{ margin: '6px 0 2px' }}>在浏览器里打开这个链接完成登录，完成后回到这里：</p>
                <div className="smp-oauthLinkRow">
                  <input
                    className="smp-oauthUrl" readOnly
                    value={authorizeUrlFor(serverName)}
                    onFocus={(event) => event.target.select()}
                  />
                  <button className="smp-button" data-variant="outline" type="button" onClick={() => copyAuthorizeUrl(serverName)}>
                    {copiedUrlFor === serverName ? '已复制' : '复制链接'}
                  </button>
                </div>
                <p className="smp-note" style={{ margin: '2px 0 0' }}>
                  授权完成后如果状态没变，点一次「重连」让它重新建立连接。
                </p>
              </div>
            )}
          </div>
        )
      }

      /**
       * One skill card — the **same** card the MCP tab renders.
       *
       * `smp-cardRow` puts 「标题 + 描述」 in the left column and the actions in the right,
       * with the whole row vertically centred. The earlier skills card kept its actions
       * inside `smp-cardHead`, so they centred against the title line only and sat high in a
       * two-line card — visibly different from the MCP rows next to them on the same page.
       *
       * Actions are a `…` menu for the same reason the MCP rows use one: three inline
       * buttons per card made the action area wider than the name it belonged to. Only the
       * **enabled switch** stays inline, and a skill genuinely has that state
       * (`enabled: false` keeps the entry but stops writing it), so the control means
       * something here rather than being copied for looks.
       *
       * `pending` replaces the whole action group with a plain spinner + label, exactly like
       * an MCP row does while a write is in flight. Rendering it *inside* the delete button
       * (the earlier approach) kept that button's danger border visible, which read as a
       * stray pill around 「删除中…」.
       */
      function card(key, identity, description, enabled, details, menuItems, pending, statusNode, authNote) {
        const isOpen = isExpanded(key)
        return (
          <li className="smp-card" key={key}>
            <div className="smp-cardRow" key="row">
              <div className="smp-cardMain" key="main">
                <div className="smp-cardHead" key="head">
                  <button
                    className="smp-cardToggle"
                    key="toggle"
                    aria-expanded={isOpen}
                    onClick={() => toggleExpanded(key)}
                  >
                    <Chevron key="c" open={isOpen} />
                    <span className="smp-cardIdentity" key="id">{identity}</span>
                  </button>
                  <span className="smp-cardEnd" key="end">
                    {/* 停用时状态整组不渲染：一个已停用的条目没有状态可报，留一个过期的
                        标签会撒谎。「已停用」本身就由右边的开关表达。 */}
                    {enabled === false ? null : statusNode ?? null}
                  </span>
                </div>
                {description ? <div className="smp-cardDescription" key="desc">{description}</div> : null}
              </div>
              {pending ? (
                <span className="smp-cardActions" key="pending">
                  <span className="smp-pending" key="p">
                    <span className="smp-spinner" key="s" />{pending}
                  </span>
                </span>
              ) : (
                <span className="smp-cardActions" key="actions">

                  {moreMenu({ entryId: key }, menuItems)}
                </span>
              )}
            </div>
            {isOpen ? (
              <div className="smp-cardDetails" key="details">
                <div className="smp-details" key="grid">{detailNodes(details, 'k')}</div>
                {authNote ?? null}
                {error ? <div className="smp-error" key="err" style={{ marginTop: 8 }}>{error}</div> : null}
              </div>
            ) : null}
          </li>
        )
      }

      /** Read-only row for an MCP entry the profile itself configures. */
      /**
       * One card for a configured row — used by **both** tabs.
       *
       * `tier` exists only to name the tab it belongs to (and therefore which form and
       * which status scope to use); the row, the actions and the tool list are identical,
       * because both tiers are now the same kind of thing. The project tab used to render
       * from the plugin's own `config.servers` with a second card implementation, which is
       * how the two drifted apart.
       */
      function profileCard(row, tier = 'global') {
        const isGlobalTier = tier === 'global'
        const rowKey = `profile:${row.entryId}`
        const rowOpen = isExpanded(rowKey)
        const rowStatusScope = isGlobalTier ? '' : (row.scope ?? '')
        // Edit in place: the row itself turns into the form.
        if (editing?.kind === 'mcp' && editing.tier === tier && editing.id === row.entryId) {
          return serverForm({ tier, scope: row.scope ?? 'global' })
        }
        /**
         * Whether to show the spinner.
         *
         * `confirmed` means the Host has already answered this command, so there is nothing
         * left to wait for: the write is done, and a spinner would misreport that as "still
         * working". The entry itself survives until the projection lists the row (an optimistic
         * add keeps rendering its own values); only the spinner goes.
         *
         * A command sent through the settings-queue fallback is never marked confirmed — its
         * write really is still pending until the Host drains the queue, so it keeps spinning.
         */
        const inflightInfo = inflight[inflightKeyForRow(row.entryId)]
        // A toggle's optimistic feedback is the switch itself. Hiding it behind a spinner
        // (as add/update/delete do) removes exactly the control that should visibly move,
        // and the test that clicks it looks for the switch right after the click.
        const spinning = inflightInfo !== undefined && inflightInfo.confirmed !== true && inflightInfo.kind !== 'toggle'
        const pending = pendingOf(row.entryId) !== null || spinning
        const reconnect = reconnectAction(row.serverName, tier, rowStatusScope)
        // 只有「启用中**且**确实异常」才给重连：停用的服务器没有连接可重建，
        // 而连接正常时重连只是一个会打断它的按钮。这两个条件都由 reconnectAction
        // 的 null 返回表达，所以这里只需要判它有没有。
        /**
         * OAuth 授权入口放在 `…` 菜单里。
         *
         * 之前它是卡片正文里的一颗按钮，只在状态恰好是「需要授权」时出现 —— 于是这台服务器
         * 一旦被判定成别的状态（或用户想重新授权、想提前换一个账号），入口就消失了。
         * 菜单是「对这台服务器能做什么」的固定清单，授权属于那一类：**一直在这里**，
         * 能不能用由服务器类型决定，而不是由某一刻的状态决定。
         *
         * 只在 OAuth 通道真的可用、且是 http 传输时才出现：一个点了只会失败的项目
         * 比没有更糟（与 filterState/probeState 的 reason 是同一条规矩）。
         */
        /**
         * 「授权 / 重新授权」什么时候该出现。
         *
         * 它不是「永远有用」的：一台**已经连上、又没有存过凭据**的服务器，已经用事实
         * 证明它不需要授权（context7 这类公开端点就是如此）。此时菜单里的「授权」不是
         * 能力清单的一部分，而是一个会把人带进 OAuth 弹窗的噪音 —— 点下去只会失败。
         *
         * 所以只在真有用的时候出现：
         *   · 存过凭据但没连上 → 「重新授权」（十有八九就是凭据坏了）；
         *   · 没存过凭据，且状态未知 → 「授权」（可能还没探到，给一个入口）；
         *   · 没存过凭据，但状态是「需要授权」 → 「授权」（唯一正确的下一步）；
         *   · 已连接 → 不出现（无论有没有凭据）；
         *   · 其它失败状态（重试中/已放弃）→ 不出现，那不是授权能治的。
         *
         * 想给一台公开服务器换账号的用户仍然有路：先「清除凭据」（正文注记里），
         * 状态回到未知后「授权」会重新出现。
         */
        const oauthCredentials = oauthServerState(row.serverName)
        const oauthRowStatus = statusFor(row.serverName, tier, rowStatusScope)
        const oauthWorthOffering = oauthCredentials.present === true
          ? oauthRowStatus?.status !== 'connected'
          : (oauthRowStatus === null || oauthRowStatus.status === 'needs-auth')
        const oauthMenuItem = oauthState?.ready === true && row.transport === 'streamable-http' && oauthWorthOffering ? (
          <button
            className="smp-menuItem" key="oauth" disabled={busy || oauthPending !== ''}
            onClick={() => {
              setMenuFor('')
              // `startOAuth` 会让 Host 直接拉起系统浏览器，用户不需要复制链接。
              void startOAuth(row.serverName)
            }}
          >
            {oauthPending === row.serverName
              ? '正在获取授权链接…'
              : oauthServerState(row.serverName).present
                ? '重新授权'
                : '授权'}
          </button>
        ) : null
        const menuItems = [
          reconnect === null ? null : reconnect.node,
          oauthMenuItem,
          <button
            className="smp-menuItem" key="edit" disabled={busy}
            onClick={() => {
              setMenuFor('')
              // `original` is kept so the save can tell "the user cleared
              // this field" from "the form never showed it" (an older Host
              // does not project the connection fields at all).
              setEditing({ kind: "mcp", tier, profile: row.entryId, id: row.entryId, original: row })
              setDraft(draftFromRow(row))
              // Prefill the scope picker from the row, and treat a path outside the
              // known workspaces as "custom" so it stays visible and editable.
              const rowScope = row.scope && row.scope !== 'global' ? row.scope : ''
              setScopeDraft({
                value: rowScope,
                custom: rowScope !== '' && !projectChoices.some(([path]) => path === rowScope),
              })
            }}
          >
            编辑
          </button>,
          <button
            className="smp-menuItem" data-variant="danger" key="del" disabled={busy}
            onClick={() => {
              setMenuFor('')
              const run = () => {
                setInflight((m) => ({ ...m, [inflightKeyForRow(row.entryId)]: { kind: "delete", at: Date.now() } }))
                commandRowOp(deleteServerOp(row.entryId), row.entryId)
              }
              if (primitives?.Modal === undefined) {
                if (window.confirm(`删除「${row.serverName || row.entryId}」？`)) run()
                return
              }
              setDeleteDialog({
                label: row.serverName || row.entryId,
                note: "会从 cordis.patch.yml 里移除这一行（写入前自动备份）。",
                // Row ops report progress on the row itself (spinner + label),
                // so this dialog closes immediately on confirm.
                closeOnConfirm: true,
                run,
              })
            }}
          >
            删除
          </button>,
          reconnect?.failure ? (
            <span className="smp-menuError" key="reconnectError">{reconnect.failure}</span>
          ) : null,
        ]
        return (
          <li className="smp-card" key={`profile:${row.entryId}`}>
            <div className="smp-cardRow" key="row">
            <div className="smp-cardMain" key="main">
            <div className="smp-cardHead" key="head">
              <button
                className="smp-cardToggle" key="toggle" aria-expanded={rowOpen}
                onClick={() => toggleExpanded(rowKey)}
              >
                <Chevron key="c" open={rowOpen} />
                <span className="smp-cardIdentity" key="name">
                  {row.serverName || row.entryId}
                  {/* 作用域跟着名字走：它描述的是「这台服务器是谁的」，与右边的运行状态
                      （连没连上）是两件事。
                      全局行也带标签：列表现在跨工作区混排，一个没标签的卡片会让人以为
                      「它没有归属」，而事实是「它属于所有工作区」。两个页签用同一套词表
                      （全局 / 工作区名），所以 MCP 与 Skills 的卡片读起来一致。 */}
                  <span className="smp-tag" data-tone="neutral" key="scope">{scopeTagLabel(row.scope)}</span>
                </span>
              </button>
              <span className="smp-cardEnd" key="end">
                {/* 停用时状态圆点整组不渲染：没有连接可报告，留着过期的绿点会撒谎。
                    关掉这件事本身由右边的开关表达（灰点 + 「已关闭」是同一个意思，
                    两个都画只是重复）。 */}
                {row.enabled === false ? null : statusDot(row.serverName, tier, rowStatusScope)}
              </span>
            </div>
            <div className="smp-cardDescription" key="desc">
              {row.target
                ? `${row.transport || "streamable-http"} · ${row.target}`
                : `${String(row.entryId).replace(/^include:/, "")}${row.phase ? ` · ${row.phase}` : ""}`}
            </div>
            </div>
            {/*
              操作区是**右列**，与「标题 + 描述」这一整列垂直居中对齐。
              它以前嵌在 cardHead 内部，于是只能跟标题那一行居中——而卡片有两行，
              结果就是偏上，与宿主设置页的分组行（左标题右控件、整行居中）不一致。
            */}
            {pending ? (
              <span className="smp-cardActions" key="pending">
                <span className="smp-pending" key="p">
                  <span className="smp-spinner" key="s" />
                  {pendingLabel(inflight[inflightKeyForRow(row.entryId)] ?? { kind: pendingOf(row.entryId)?.op })}
                </span>
              </span>
            ) : rowOpsReady ? (
              <span className="smp-cardActions" key="actions">
                {enabledSwitch(row)}
                {moreMenu(row, menuItems)}
              </span>
            ) : null}
          </div>
            {rowOpen ? (
              <div className="smp-cardDetails" key="details">
                <div className="smp-details" key="grid">{detailNodes(rowDetailPairs(row))}</div>
                {toolListNode(toolsForServer(serverTools, row.serverName, serverToolsError), `tools-${row.entryId}`, {
                  // 草稿优先：勾选只改本地草稿，不写 settings 文档（见 `filterDraft`）。
                  ...draftRuleFor(row.serverName),
                  leafOf: leafOf(row.serverName),
                  onMode: (mode) => {
                    // Entering a mode with nothing selected would leave the server
                    // either fully open (`allow`) or untouched (`deny`); the Host
                    // treats an empty allow rule as "not configured" for that reason.
                    const current = draftRuleFor(row.serverName)
                    stageFilter(row.serverName, { mode, tools: current.tools })
                  },
                  onToggle: (leaf, checked) => {
                    const current = draftRuleFor(row.serverName)
                    const next = checked
                      ? [...new Set([...current.tools, leaf])]
                      : current.tools.filter((name) => name !== leaf)
                    stageFilter(row.serverName, { mode: current.mode, tools: next })
                  },
                })}
                {filterDraft[row.serverName] !== undefined ? (
                  /* 卡片自己的保存按钮：勾选时视线就在这张卡片上，而列表上方的提示条可能已经
                     滚出视野。两处按钮做的是同一件事（提交整份草稿、只写一次文档）。 */
                  <div className="smp-filterBar" key="filterDirty" style={{ marginTop: 6 }}>
                    <span className="smp-filterBarText">这张卡片的工具勾选还没保存</span>
                    <button
                      className="smp-button" type="button" data-variant="primary" disabled={busy}
                      onClick={() => { void saveFilters() }}
                    >
                      保存修改
                    </button>
                  </div>
                ) : null}
                {/* Filtering that silently is not running must say so: "off" and
                    "could not be installed" look identical in the UI otherwise, and
                    only one of them is the user's own configuration. */}
                {filterState.installed !== true ? (
                  <p className="smp-note" key="filterOff" style={{ marginTop: 6 }}>
                    {`工具过滤当前未生效${filterState.reason ? `：${filterState.reason}` : ''}——勾选会被保存，但要等它可用后才会真正挡住工具。`}
                  </p>
                ) : null}
                {/* 「需要授权」必须给出下一步做什么。只标一个标签会让人以为服务器坏了，
                    而这恰恰是这个状态要避免的误解——它不是故障，是一次等待用户完成的授权。
                    用这张卡片自己的 tier/scope：合并成一个列表后，全局行与项目行都可能
                    出现「需要授权」，写死 'global' 会让项目行永远取不到自己的那条状态。 */}
                {needsAuthNote(row.serverName, tier, rowStatusScope)}
                {/* A tool already in the registry cannot be unregistered by this
                    plugin, so a rule turned on now only takes full effect once the
                    server re-registers its tools. The concrete way to force that is
                    this card's own 停用/启用: disabling disposes the mcp-client fiber,
                    which unregisters its tools, and enabling re-mounts it and re-runs
                    `syncTools` — every tool goes back through the shadow. Saying *how*
                    is the difference between a feature and a silent no-op. */}
                {filterState.installed === true && draftRuleFor(row.serverName).mode !== 'off' ? (
                  <p className="smp-note" key="filterSync" style={{ marginTop: 6 }} title="保存后插件会自动重连该服务器：MCP 客户端重新上报全量工具，过滤器重新判定。重连期间它的工具短暂不可用。">
                    保存后自动重连该服务器（几秒），工具随即按新规则生效。
                  </p>
                ) : null}
                {filterState.installed === true && Array.isArray(filterState.preExisting) && filterState.preExisting.length > 0 ? (
                  <p className="smp-note" key="filterLate" style={{ marginTop: 6 }}>
                    {`${filterState.preExisting.length} 个工具在过滤生效前已注册，重启 DSH 后才会消失。`}
                  </p>
                ) : null}
              </div>
            ) : null}
          </li>
        )
      }

      /** Import sources the Host can scan (ids must match the Host table). */

      /**
       * Explicit import. `scope: 'global'` reads a tool's user-level file and
       * writes profile rows; `'project'` reads the selected workspace and writes
       * panel project entries.
       */
      const importCard = (scope) => {
        const target = scope === 'global' ? '' : importProject
        const raw = importScan
        const result = raw !== null && typeof raw === 'object' && raw.scope === scope
          && (scope === 'global' || raw.project === target) ? raw : null
        const needsProject = scope === 'project' && target === ''
        // Import never overwrites: names already managed for this scope are skipped.
        const takenNames = takenNamesOf({ scope, target, profileRows })
        const { fresh: freshServers, skipped: skippedServers } = splitImport(result?.servers ?? [], takenNames)
        if (!importOpen) {
          return (
            <li className="smp-card" key="import">
              <div className="smp-cardHead" key="head">
                <span className="smp-cardIdentity" key="t">{scope === "global" ? "导入 MCP" : "导入 MCP"}</span>
                <span className="smp-cardActions" key="a">
                  <button
                    className="smp-button" data-variant="outline" key="go" disabled={busy}
                    onClick={() => setImportOpen(true)}
                  >
                    选择来源
                  </button>
                </span>
              </div>
              <div className="smp-cardDescription" key="d">
                {scope === "global"
                  ? "从其他编辑器/CLI 的用户级配置文件导入（写成配置文件行）。"
                  : "从其他编辑器/CLI 的项目级文件导入到面板的项目条目。"}
              </div>
            </li>
          )
        }
        return (
          <li className="smp-card" key="import">
            <div className="smp-cardHead" key="head">
              <span className="smp-cardIdentity" key="t">{scope === "global" ? "导入全局 MCP" : "导入项目 MCP"}</span>
              <span className="smp-cardActions" key="a">
                <button className="smp-button" data-variant="outline" key="close" onClick={() => setImportOpen(false)}>收起</button>
              </span>
            </div>
            <div className="smp-segment" key="segment">
              <button key="g" data-active={String(scope === "global")} onClick={() => setImportScope("global")}>全局</button>
              <button key="p" data-active={String(scope === "project")} onClick={() => setImportScope("project")}>项目级</button>
            </div>
            <div className="smp-formGrid" key="grid">
              {field("来源", (
                <select className="smp-select" value={importSource} onChange={(event) => setImportSource(event.target.value)}>
                  {IMPORT_CHOICES.map(([id, label]) => <option value={id} key={id}>{label}</option>)}
                </select>
              ))}
              {scope === "global" ? null : importCustomProject ? field("项目路径", (
                <div className="smp-actionsRow" style={{ marginTop: 0 }}>
                  <input
                    className="smp-input" placeholder="项目绝对路径" style={{ flex: "1 1 auto" }}
                    value={importProject} onChange={(event) => setImportProject(event.target.value)}
                  />
                  <button className="smp-button" data-variant="outline" key="back" onClick={() => setImportCustomProject(false)}>选工作区</button>
                </div>
              )) : field("项目", (
                <div className="smp-actionsRow" style={{ marginTop: 0 }}>
                  <select
                    className="smp-select" value={importProject} style={{ flex: "1 1 auto" }}
                    onChange={(event) => {
                      if (event.target.value === "__custom__") { setImportCustomProject(true); return }
                      setImportProject(event.target.value)
                    }}
                  >
                    <option value="" key="none">选择一个工作区…</option>
                    {projectChoices.map(([path, title]) => <option value={path} key={path}>{title}</option>)}
                    <option value="__custom__" key="custom">自定义路径…</option>
                  </select>
                  {importProject !== "" ? (
                    <button className="smp-button" data-variant="outline" key="clear" onClick={() => setImportProject("")}>清除</button>
                  ) : null}
                </div>
              ))}
            </div>
            {needsProject ? (
              <div className="smp-cardDescription" key="need">先选择一个工作区（或切到「全局」读用户级配置）。</div>
            ) : result === null ? (
              <div className="smp-cardDescription" key="hint">点「扫描」后，会把该工具在项目里的 MCP 文件与能导入的条目列出来。</div>
            ) : (
              <div key="result">
                {result.files.map((file) => (
                  <div className="smp-cardDescription" key={file.path}>
                    {`${file.exists ? "✓" : "✗"} ${file.path}${file.exists ? ` · 识别 ${file.servers.length} 个${file.unsupported > 0 ? `（${file.unsupported} 个形态不支持）` : ""}` : " · 文件不存在"}${file.error != null && file.error !== "" ? ` · ${file.error}` : ""}`}
                  </div>
                ))}
                {result.error !== null && result.error !== "" ? <div className="smp-error" key="err">{result.error}</div> : null}
                <div className="smp-cardDescription" key="sum">
                  {`新增 ${freshServers.length} 个：${freshServers.map((server) => server.serverName).join("、") || "—"}`}
                </div>
                {skippedServers.length > 0 ? (
                  <div className="smp-cardDescription" key="skip">
                    {`已存在 ${skippedServers.length} 个（跳过，不覆盖）：${skippedServers.map((server) => server.serverName).join("、")}`}
                  </div>
                ) : null}
              </div>
            )}
            <div className="smp-actionsRow" key="actions">
              <button
                className="smp-button" data-variant="primary" key="scan"
                disabled={busy || (scope === "project" && target === "")}
                onClick={() => {
                  setBusy(true)
                  setError("")
                  void scanImport({ source: importSource, scope, project: target }).then((payload) => {
                    setImportScan(payload)
                    setBusy(false)
                    if (payload?.ok !== true) setError(String(payload?.error ?? "扫描失败"))
                  })
                }}
              >
                扫描
              </button>
              {result !== null && freshServers.length > 0 ? (
                <button
                  className="smp-button" data-variant="outline" key="do"
                  onClick={() => {
                    const wantedScope = scope === "global" ? "global" : target
                    const existing = new Set(profileRows
                      .filter((row) => (row.scope ?? 'global') === wantedScope)
                      .map((row) => row.serverName))
                    for (const server of result.servers) {
                      if (existing.has(server.serverName)) continue
                      void sendRowOp(addServerOp({
                        serverName: server.serverName,
                        transport: server.transport,
                        url: server.transport === "stdio" ? "" : server.url,
                        command: server.transport === "stdio" ? server.command : "",
                        args: server.transport === "stdio" ? (server.args ?? []).join(" ") : "",
                        env: server.env ?? "", headers: server.headers ?? "",
                        scope: scope === "global" ? "" : target,
                        scopeChanged: scope !== "global",
                      })).then((outcome) => { if (!outcome.ok) setError(outcome.reason) })
                    }
                    setImportScan(null)
                  }}
                >
                  {importLabel({ scope, fresh: freshServers.length, skipped: skippedServers.length })}
                </button>
              ) : null}
            </div>
          </li>
        )
      }

      function serverForm(tier) {
        if (!editing || editing.kind !== "mcp" || editing.tier !== tier.tier) return null
        const scope = tier.scope
        const profileEntry = typeof editing.profile === "string" && editing.profile !== "" ? editing.profile : null
        const stdio = (draft.transport ?? "streamable-http") === "stdio"
        return (
          <li className="smp-card" key="form" data-wide="true">
            <div className="smp-cardDetails" key="body">
              <div className="smp-formGrid" key="grid">
                {field("名称（serverName）", (
                  <input
                    className="smp-input"
                    placeholder="例如 test，最多 32 字符"
                    value={draft.serverName ?? ""}
                    onChange={(e) => setDraft({ ...draft, serverName: e.target.value })}
                  />
                ))}
                {field("传输", (
                  <select
                    className="smp-select"
                    value={draft.transport ?? "streamable-http"}
                    onChange={(e) => {
                      const transport = e.target.value
                      // Switching to stdio prefills `npx` **only when the field is still empty**:
                      // a value the user typed (or one loaded from a row being edited) must not
                      // be overwritten by a convenience default.
                      const blank = String(draft.command ?? '').trim() === ''
                      setDraft({
                        ...draft,
                        transport,
                        ...(transport === 'stdio' && blank ? { command: HINTS.command } : {}),
                      })
                    }}
                  >
                    <option value="streamable-http" key="h">streamable-http</option>
                    <option value="stdio" key="s">stdio</option>
                  </select>
                ))}
                {/*
                  The scope picker, moved here from the toolbar.
                  It used to *filter* the list by project, which only made sense while the
                  project tier was a separate list of separately-stored entries. Now a
                  server's scope is simply a property of that server, so the choice belongs
                  where the server is created — and the same workspace list is reused.
                */}
                {field("作用域（哪个工作区可用）", (
                  <div className="smp-scopePick" key="scope">
                    <select
                      className="smp-select"
                      key="sel"
                      value={scopeDraft.custom ? "__custom__" : (scopeDraft.value || "global")}
                      onChange={(e) => {
                        const value = e.target.value
                        if (value === "__custom__") { setScopeDraft({ value: '', custom: true }); return }
                        setScopeDraft({ value: value === 'global' ? '' : value, custom: false })
                      }}
                    >
                      <option value="global" key="g">全局 —— 所有工作区都能用</option>
                      {projectChoices.map(([path, title]) => <option value={path} key={path}>{title}</option>)}
                      <option value="__custom__" key="c">自定义路径…</option>
                    </select>
                    {scopeDraft.custom ? (
                      <input
                        className="smp-input" key="custom"
                        placeholder="项目绝对路径"
                        value={scopeDraft.value}
                        onChange={(e) => setScopeDraft({ ...scopeDraft, value: e.target.value })}
                      />
                    ) : null}
                  </div>
                ))}
                {stdio
                  ? field("命令", (
                      <input
                        className="smp-input" placeholder={HINTS.command}
                        value={draft.command ?? ""}
                        onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                      />
                    ))
                  : field("URL", (
                      <input
                        className="smp-input" placeholder={HINTS.url}
                        value={draft.url ?? ""}
                        onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                      />
                    ))}
                {/* http 的鉴权头：host 端按 KEY=VALUE 解析（parseEnv），所以提示也用等号。
                    此前这个字段只在 form.js 里声明、从未渲染，等于没有写入入口。 */}
                {stdio
                  ? null
                  : field("请求头（KEY=VALUE，每行一个）", (
                      <textarea
                        className="smp-textarea" rows={3} placeholder={HINTS.headers}
                        value={draft.headers ?? ""}
                        onChange={(e) => setDraft({ ...draft, headers: e.target.value })}
                      />
                    ), true)}
                {stdio
                  ? field("参数（空格分隔）", (
                      <input
                        className="smp-input" placeholder={HINTS.args}
                        value={draft.args ?? ""}
                        onChange={(e) => setDraft({ ...draft, args: e.target.value })}
                      />
                    ))
                  : null}
                {stdio
                  ? field("运行时", (
                    /**
                     * 用哪个 npm 家族去跑 stdio 服务器。
                     *
                     * 默认是 **system**，不是 Harness —— 这个默认值原来是反的，而反的那一侧
                     * 根本跑不起来：Harness 自带的是 `node + pnpx`（内置 runtime 里没有 npm，
                     * 所以当初只能换 pnpx），而 pnpx 解析到 pnpm store 里那份包时，**依赖没有
                     * 被链接进去**：
                     *
                     *     Cannot find package 'zod' imported from
                     *     ~/Library/pnpm/store/v11/links/@modelcontextprotocol/server-memory/…/
                     *
                     * store 的 links 目录里只有包本身（`node_modules/@modelcontextprotocol`），
                     * 没有 `zod`。实测 `server-memory` / `server-filesystem` 都起不来，
                     * `server-everything` 却能起来 —— 取决于包自己怎么引依赖，用户无从预判。
                     *
                     * 所以文案也不能再写「推荐」：「自带 node」是真的，但「能跑起来」是假的。
                     * 现在的写法如实说明各自的适用范围，让碰到 pnpm 不兼容包的人知道该换哪边。
                     */
                      <select
                        className="smp-select"
                        value={draft.runtime ?? "system"}
                        onChange={(e) => setDraft({ ...draft, runtime: e.target.value })}
                      >
                        <option value="system" key="system">系统 npx（推荐：能装齐依赖）</option>
                        <option value="auto" key="auto">跟随 Harness（自带 node + pnpx；个别包会缺依赖）</option>
                      </select>
                    ))
                  : null}
                {stdio
                  ? field("环境变量（KEY=VALUE，每行一个）", (
                      <div className="smp-envField" key="env">
                        <textarea
                          className="smp-textarea" rows={3} placeholder={HINTS.env}
                          value={draft.env ?? ""}
                          onChange={(e) => setDraft({ ...draft, env: e.target.value })}
                        />
                        {/* 全局 stdio 行会被注入一条 PATH（让 npx/node 能被找到）。
                            它确实属于这一行，所以如实回填、不隐藏；但要讲清楚它是自动的，
                            否则用户会以为是自己配的，删掉就会让 stdio 服务器起不来。 */}
                        {hasInjectedPath(draft.env) ? (
                          <p className="smp-note" key="pathNote">
                            其中的 <code>PATH</code> 是 DSH 自动注入的（跟随系统 PATH，让 <code>npx</code>/<code>node</code> 能被找到）——保持原样即可，删掉会让这个 stdio 服务器启动失败。
                          </p>
                        ) : null}
                      </div>
                    ), true)
                  : null}
                {/* 连接策略：直接落进 MCP 客户端的 failOnStartupError / reconnect.*。

                    标题原来是「连接与重连（留空 = 用 DSH 默认值）」，但现在：
                      · 这个字段里只有一个开关，没有可「留空」的东西；
                      · 下面三个重连数字**预填了真实默认值**，也不再靠留空表达默认。
                    一条让用户去找输入框的提示，旁边却没有输入框，比不写还糟。

                    两个开关都用宿主自己的 `Switch`（与卡片上的启用开关同一个组件）：
                    布尔设置用开关比用勾选框更符合这个设置页的语言，而且开关同时说明
                    「现在是哪一档」，勾选框只说明「点了会怎样」。 */}
                {field("连接失败处理", (
                  <div className="smp-switchRow" key="fail">
                    <span className="smp-switchRowText">
                      {"连不上时拒绝激活（failOnStartupError）"}
                      <span className="smp-switchRowHint">默认关闭</span>
                    </span>
                    <span className="smp-switchSlot" key="slot">
                      {switchControl(
                        draft.failOnStartupError === true,
                        (next) => setDraft({ ...draft, failOnStartupError: next }),
                        "连不上时拒绝激活（failOnStartupError）",
                      )}
                    </span>
                  </div>
                ), true)}
                {/* 两个开关分属不同概念（连接策略 / OAuth 安全），中间要有一条横线。
                    没有它时两块文字挨在一起，读起来像一个开关组里的两行，而不是两项
                    各自独立的设置。`role="separator"` 让读屏也念出这是一处分隔。 */}
                <div className="smp-divider" role="separator" aria-orientation="horizontal" key="divider" />
                {/* 明文 token 端点的例外。**默认关闭**，而且刻意放在表单最下方、
                    紧挨着连接设置：它是个安全降级，不该出现在显眼位置让人顺手打开。
                    文案必须说清后果 —— 用户开它的时候要知道凭据会明文过网。 */}
                {field("内网 OAuth（仅 http 授权服务器）", (
                  <div className="smp-switchRow" key="allowInsecure">
                    <span className="smp-switchRowText">
                      {"允许明文 token 端点"}
                      <span className="smp-switchRowHint">
                        {"仅当授权服务器没有 TLS 时打开；开启后 access_token / refresh_token 会以明文发到内网，同网段可被嗅探"}
                      </span>
                    </span>
                    <span className="smp-switchSlot" key="slot">
                      {switchControl(
                        draft.allowInsecureTokenEndpoint === true,
                        (next) => setDraft({ ...draft, allowInsecureTokenEndpoint: next }),
                        "允许明文 token 端点",
                      )}
                    </span>
                  </div>
                ), true)}
                {field("工具调用超时（ms）", (
                  <input
                    className="smp-input" type="number" min={1} step={1}
                    placeholder={String(CONNECTION_DRAFT_DEFAULTS.toolCallTimeoutMs)}
                    value={draft.toolCallTimeoutMs ?? ""}
                    onChange={(e) => setDraft({ ...draft, toolCallTimeoutMs: e.target.value })}
                  />
                ))}
                {field("重连首次延迟（ms）", (
                  <input
                    className="smp-input" type="number" min={1} step={1} placeholder={String(CONNECTION_DRAFT_DEFAULTS.reconnectInitialDelayMs)}
                    value={draft.reconnectInitialDelayMs ?? ""}
                    onChange={(e) => setDraft({ ...draft, reconnectInitialDelayMs: e.target.value })}
                  />
                ))}
                {field("重连最大延迟（ms）", (
                  <input
                    className="smp-input" type="number" min={1} step={1} placeholder={String(CONNECTION_DRAFT_DEFAULTS.reconnectMaxDelayMs)}
                    value={draft.reconnectMaxDelayMs ?? ""}
                    onChange={(e) => setDraft({ ...draft, reconnectMaxDelayMs: e.target.value })}
                  />
                ))}
                {field("重连最大次数", (
                  <input
                    className="smp-input" type="number" min={1} step={1} placeholder={String(CONNECTION_DRAFT_DEFAULTS.reconnectMaxAttempts)}
                    value={draft.reconnectMaxAttempts ?? ""}
                    onChange={(e) => setDraft({ ...draft, reconnectMaxAttempts: e.target.value })}
                  />
                ))}
              </div>
              {error ? <div className="smp-error" key="err" style={{ marginTop: 8 }}>{error}</div> : null}
              {profileEntry !== null ? (
                <p className="smp-note" key="note" style={{ marginTop: 8 }}>
                  {`改的是配置文件行 ${profileEntry.replace(/^include:/, "")}，Host 会写回 profile patch（自动备份）。`}
                </p>
              ) : null}
              <div className="smp-actionsRow" key="actions">
                <button
                  className="smp-button" data-variant="primary" key="save"
                  disabled={busy || !draft.serverName}
                  onClick={() => {
                    const transport = draft.transport ?? "streamable-http"
                    const argList = String(draft.args ?? "").trim() === "" ? [] : String(draft.args).trim().split(/\s+/)
                    if (profileEntry !== null) {
                      // Edit the row in place: the Host rewrites the profile patch.
                      setInflight((m) => ({ ...m, [inflightKeyForRow(profileEntry)]: { kind: "update", at: Date.now(), expectName: draft.serverName ?? "" } }))
                      commandRowOp(updateServerOp(profileEntry, {
                        ...draft,
                        serverName: draft.serverName ?? "", transport,
                        url: transport === "stdio" ? "" : (draft.url ?? ""),
                        command: transport === "stdio" ? (draft.command ?? "") : "",
                        args: transport === "stdio" ? String(draft.args ?? "") : "",
                        env: transport === "stdio" ? String(draft.env ?? "") : "",
                        headers: transport === "stdio" ? "" : String(draft.headers ?? ""),
                        // 作用域也是这一行自己的属性：编辑时必须一起提交，否则表单里的
                        // 作用域选择器就是个纯装饰（选了也没用）。
                        scope: scopeDraft.value === "global" ? "" : scopeDraft.value,
                        scopeChanged: true,
                      }, editing.original), profileEntry).then((result) => {
                        // 回执为判据：写成功才关表单；失败时 `commandRowOp` 已经把原因放进
                        // error，表单留着让用户改（原来立刻关，等于把输入扔了）。
                        if (result?.ok === true) setEditing(null)
                      })
                    } else {
                      // Every new server becomes a real profile row — global or project.
                      // The only difference is `scope`, which the op carries; the Host
                      // writes it through the same lock + backup + validation path.
                      // The scope is recorded with the in-flight marker, not just sent in
                      // the op: the Host clears `rowOps` before it writes the patch, so by
                      // the time the row lands the op is gone and only this map still knows
                      // which workspace group the card belongs to.
                      //
                      // `draft` rides along so the card can be drawn **now**, from exactly the
                      // values being written, instead of showing a spinner for the round-trip.
                      const optimisticKey = inflightKeyForRow(rowEntryId(draft.serverName))
                      setInflight((m) => ({
                        ...m,
                        [optimisticKey]: {
                          kind: "add", at: Date.now(), scope: scopeDraft.value,
                          draft: { ...draft, transport },
                        },
                      }))
                      commandRowOp(addServerOp({
                        ...draft,
                        serverName: draft.serverName ?? "", transport,
                        url: transport === "stdio" ? "" : (draft.url ?? ""),
                        command: transport === "stdio" ? (draft.command ?? "") : "",
                        args: transport === "stdio" ? String(draft.args ?? "") : "",
                        env: transport === "stdio" ? String(draft.env ?? "") : "",
                        headers: transport === "stdio" ? "" : String(draft.headers ?? ""),
                        // The scope comes from the form's own picker: it is a property of
                        // this server, not of whatever the toolbar happened to be showing.
                        scope: scopeDraft.value,
                        scopeChanged: true,
                      }), optimisticKey).then((result) => {
                        // 同上：只有回执成功才关表单。
                        if (result?.ok === true) setEditing(null)
                      })
                    }
                  }}
                >
                  {profileEntry !== null ? "保存到配置行" : "保存"}
                </button>
                <button className="smp-button" data-variant="outline" key="cancel" onClick={() => setEditing(null)}>
                  取消
                </button>
              </div>
            </div>
          </li>
        )
      }

      /**
       * The `…` menu for a **discovered** skill (on disk, not in this panel's config).
       *
       * 预览/编辑/删除 act on the file the Host scanned; there is no config entry to remove,
       * which is why 删除 opens the confirm dialog with the backup wording rather than
       * dropping a `config.skills[]` row.
       */
      /**
       * 打开「编辑技能」对话框。
       *
       * 作用域与根从 `source` 解出来（`project-dsh` → 项目级 + dsh 根，`user-agents` → 全局 +
       * agents 根）：磁盘条目的来源是唯一真相，不能靠猜。正文按需异步加载。
       */
      const openSkillEditor = (skill) => {
        const parts = String(skill?.source ?? '').split('-')
        const scope = parts[0] === 'project' ? 'project' : 'global'
        const id = parts[1] === 'agents' ? 'agents' : 'dsh'
        setSkillError('')
        setSkillDraft({ name: skill.name, description: skill.description ?? '', body: skill.body ?? '' })
        resetSkillPending()
        setSkillDialog({
          mode: 'edit', scope, id,
          project: scope === 'project' ? String(skill.scope ?? '') : '',
          projectCustom: false, prevName: skill.name, path: skill.path ?? '',
        })
        loadSkillBody(skill)
      }

      function diskSkillMenuItems(skill) {
        return [
          <button
            className="smp-menuItem" key="view" disabled={busy || skillPendingPath === skill.path}
            onClick={() => { setMenuFor(''); openPreview(skill) }}
          >
            预览
          </button>,
          <button
            className="smp-menuItem" key="edit" disabled={busy || skillPendingPath === skill.path}
            onClick={() => { setMenuFor(''); openSkillEditor(skill) }}
          >
            编辑
          </button>,
          <button
            className="smp-menuItem" data-variant="danger" key="del" disabled={busy || skillPendingPath === skill.path}
            onClick={() => { setMenuFor(''); confirmDeleteSkill(skill) }}
          >
            删除
          </button>,
        ]
      }

      /**
       * Global MCP entries live in the profile patch as ordinary
       * `@deepseek-ai/dsh-mcp-client` rows — the same place the shipped rows live —
       * so this tier simply lists (and edits) those rows.
       */
      const pendingAdds = pendingAddsOf(inflight, profileRows)

      /**
       * The skills list — one list, grouped by scope in workspace order.
       *
       * Deliberately the same shape as the MCP list: 全局 first, then the workspaces in
       * registry order, then scopes the registry does not know. Two differences remain, and
       * both are about *data*, not layout:
       *
       *   · a skill is written to a **different directory per scope** (a server is not), so
       *     the 区域 picker survives in the dialog;
       *   · a skill can sit on disk **without** being in the panel's config (DSH's own
       *     roots), which is why a card is either "managed" (has config, gets a switch) or
       *     "discovered" (disk only, no switch — there is nothing to toggle).
       *
       * Grouping carries no heading of its own: the card states its own scope, exactly as on
       * the MCP tab, and a second layer of titles would only repeat it.
       */
      /**
       * Every skill, grouped by workspace in registry order — the same shape as the MCP list.
       *
       * A skill is a file; there is exactly one kind of entry now, so the card has no
       * "managed vs discovered" branch and no enable switch.
       */
      const skillGroups = orderedScopeGroups(
        discoveredOnly.map((skill) => ({ skill, scope: skill.scope ?? 'global' })),
        workspacePaths,
      )

      const skillCard = ({ skill }) => {
        const scopeValue = skill.scope ?? 'global'
        const rootId = rootIdOfSource(skill.source)
        const key = `disk:${skill.path}`
        const pending = skillPendingPath === skill.path ? '删除中…' : null
        const identity = [
          <span key="n">{skill.name}</span>,
          <span className="smp-tag" data-tone="neutral" key="scope">{scopeTagLabel(scopeValue)}</span>,
        ]
        return card(
          key,
          identity,
          skill.description || "(无描述)",
          undefined,
          [["来源", skill.source], ["路径", skill.path]],
          diskSkillMenuItems(skill),
          pending,
        )
      }

      /**
       * 旧的「平铺技能卡片列表」在 0.5.23 被来源分组视图取代（页签合并）。
       *
       * 这里只保留**汇总计数**需要的 `skillGroups`；渲染、`skillCard`、`…` 菜单与对话框式删除
       * 仍然留在文件里是为了不把一次 UI 合并做成大重构，但它们已经不再被渲染。
       * 后续清理时可以连同 `diskSkillMenuItems` / `confirmDeleteSkill` 一起删掉。
       */

      /** Removing a skill from disk is destructive-ish: confirm first (a backup is kept). */
      const confirmDeleteSkill = (skill) => {
        const parts = String(skill.source ?? "").split("-")
        const scope = parts[0] === "project" ? "project" : "global"
        const id = parts[1] === "dsh" ? "dsh" : "agents"
        setDeleteDialog({
          label: skill.name,
          note: "会先把目录备份到同级的 .smp-backup-* 再删除；备份会保留，需要时可手动恢复。",
          // Progress shows on the card itself, like MCP row deletes.
          closeOnConfirm: true,
          run: () => {
            const target = removalTargetOf(skill)
            deleteTargetRef.current = { ...target, path: String(skill.path ?? "") }
            setDeleteError("")
            setSkillPendingPath(String(skill.path ?? ""))
            setSkillError("")
            setSkillNonce("pending")
            const request = {
              op: "delete", scope, id,
              project: skill.scope === "global" ? "" : skill.scope,
              name: skill.name, prevName: "", description: "", body: "",
              path: skill.path ?? "", nonce: "",
            }
            void sendSkillWrite(request).then((result) => {
              setSkillNonce("")
              finishSkillDelete(result)
            })
          },
        })
      }

      /**
       * `config.skills[]` 条目没有 `path`：按 Host 的落盘规则推出来。
       *
       * 0.5.5 之后不再新建这类条目；保留这段只是为了老条目仍能预览。`id` 决定两个根中的
       * 哪一个（dsh / agents），少看它就会读错文件。
       */
      /**
       * 「这次正文请求还是不是当前那次」的令牌。
       *
       * 不加它的后果是**写坏磁盘**：打开编辑 A（正文还没回来）→ 取消 → 打开 B，A 的回包
       * 晚到，回调把 A 的正文写进 B 的草稿 —— 一点保存，A 的内容就成了 B 的。
       *
       * 每次请求领一个令牌；回调先比令牌，过期就整包丢弃（连错误提示一起丢，否则会
       * 在无关的对话框上冒出别人的失败原因）。关闭对话框时把令牌清空，迟到的包也就作废。
       */
      const editBodyReqRef = useRef("")
      /** 这一次编辑是否真的拿到了正文。没拿到就禁止保存 —— 否则会清空 SKILL.md。 */
      const editBodyLoadedRef = useRef(false)
      const previewBodyReqRef = useRef("")

      /** Load one skill's body on demand before editing it. */
      const loadSkillBody = (skill) => {
        if (!skill?.path) return
        const token = nextNonce()
        editBodyReqRef.current = token
        editBodyLoadedRef.current = false
        setEditBodyPending(true)
        setEditBodyNonce(token)
        void readSkillBody(skill.path).then((result) => {
          if (editBodyReqRef.current !== token) return
          editBodyReqRef.current = ""
          // 只有这一次真的读到了正文，才允许保存（否则保存会把文件正文写成空串）。
          editBodyLoadedRef.current = result.ok === true
          setSkillDraft((current) => ({
            ...current,
            body: result.ok === true ? String(result.body ?? "") : String(current.body ?? ""),
          }))
          setEditBodyPending(false)
          setEditBodyNonce("")
          if (result.ok !== true) setSkillError(String(result.reason ?? "读取正文失败"))
        })
      }

      const openPreview = (skill) => {
        const token = nextNonce()
        previewBodyReqRef.current = token
        setSkillPreview(skill)
        setPreviewBody("")
        setPreviewPending(true)
        setPreviewNonce(token)
        void readSkillBody(skill.path ?? "").then((result) => {
          if (previewBodyReqRef.current !== token) return
          previewBodyReqRef.current = ""
          setPreviewBody(result.ok === true ? String(result.body ?? "") : String(result.reason ?? "读取失败"))
          setPreviewPending(false)
          setPreviewNonce("")
        })
      }

      /**
       * The absolute directory the current dialog choices resolve to.
       *
       * Shown in the dialog as 「将写入 …」: the three pickers are what the user thinks in, but
       * DSH reads **two** roots per scope and a hand-typed project path is resolved to the
       * nearest enclosing project root, so the answers differ from the inputs often enough
       * that stating the result is worth a line.
       */
      const skillDialogTarget = skillRootLabel(
        skillDialog?.scope === 'project' ? (skillDialog?.project ?? '') : 'global',
        skillDialog?.id,
      )

      const skillDialogElement = skillDialogView({
        dialog: skillDialog, draft: skillDraft,
        resolvedPath: skillDialog === null || (skillDialog.scope === 'project' && String(skillDialog.project ?? '') === '')
          // Nothing to resolve yet: a project entry with no workspace picks nothing, and a
          // path would be a guess dressed up as a fact.
          ? ''
          : skillDialogTarget,
        workspaceChoices: skillProjectChoices,
        error: skillError, pending: skillNonce !== "" || editBodyPending, primitives,
        onScope: (scope) => setSkillDialog((current) => (current === null ? current : { ...current, scope })),
        onProject: (next) => setSkillDialog((current) => {
          if (current === null) return current
          // 「自定义路径…」 switches the same field into a free-text input; the value is kept so
          // switching back and forth does not lose what was typed.
          if (next === '__custom__') return { ...current, projectCustom: true }
          return { ...current, projectCustom: false, project: next }
        }),
        onProjectCustom: (next) => setSkillDialog((current) => (current === null ? current : { ...current, project: next })),
        onRoot: (id) => setSkillDialog((current) => (current === null ? current : { ...current, id: id === 'agents' ? 'agents' : 'dsh' })),
        onName: (name) => setSkillDraft((current) => ({ ...current, name })),
        onDescription: (description) => setSkillDraft((current) => ({ ...current, description })),
        onBody: (body) => setSkillDraft((current) => ({ ...current, body })),
        onCancel: () => { editBodyReqRef.current = ""; setSkillDialog(null); setSkillError(""); resetSkillPending() },
        onSave: () => {
          if (skillDialog === null) return
          // Never save an edit before the body arrived: it would erase the file.
          if (editBodyPending) return
          const isEdit = skillDialog.mode === "edit"
          const renamed = isEdit && (skillDraft.name ?? "") !== skillDialog.prevName
          const editOp = isEdit ? (renamed ? "rename" : "update") : "create"
          const sent = {
            kind: editOp,
            name: String(skillDraft.name ?? ""),
            prevName: String(skillDialog.prevName ?? ""),
            description: String(skillDraft.description ?? ""),
            scope: skillDialog.scope, id: skillDialog.id, project: skillDialog.project,
          }
          setSkillError("")
          setSkillNonce("pending")
          const request = {
            op: editOp,
            scope: skillDialog.scope, id: skillDialog.id, project: skillDialog.project,
            name: skillDraft.name ?? "", prevName: skillDialog.prevName ?? "",
            description: skillDraft.description ?? "", body: skillDraft.body ?? "",
            nonce: "",
          }
          /**
           * 正文没读到就保存 = 把 SKILL.md 的正文写成空串（草稿里的 body 还是初始值）。
           * 读正文是异步的，失败时只会显示错误、草稿仍是空的 —— 所以这里硬拦。
           */
          if (skillDialog?.mode === "edit" && (editBodyPending || editBodyLoadedRef.current !== true)) {
            setSkillError("正文还没读到，暂不能保存（否则会把文件正文清空）。请关闭后重新打开这个技能。")
            return
          }
          void sendSkillWrite(request).then((result) => {
            setSkillNonce("")
            if (result.ok === true) {
              applyOptimisticSkillWrite(sent)
              editBodyReqRef.current = ""
              setSkillDialog(null)
              setSkillError("")
              bumpRefresh()
              return
            }
            // Roll back visibly: the dialog stays open with the reason.
            setSkillError(String(result.reason ?? "写入失败"))
          })
        },
      })

      const skillPreviewDialogView = skillPreviewDialog({
        skill: skillPreview, body: previewBody, pending: previewPending, primitives,
        onClose: () => { previewBodyReqRef.current = ""; setSkillPreview(null); setPreviewPending(false); setPreviewNonce("") },
      })

      const confirmDeleteDialog = deleteConfirmDialog({
        dialog: deleteDialog,
        primitives,
        pending: deletePending,
        error: deleteError,
        onCancel: () => { setDeleteDialog(null); setDeletePending(false); setDeleteError(""); setDeleteNonce(""); },
        onConfirm: () => {
          // Skill deletes stay open with 删除中… until the receipt arrives (or shows
          // why it failed). Row deletes report progress on the row itself, so they
          // close right away and the card shows its own spinner.
          if (deleteDialog?.closeOnConfirm === true) {
            setDeleteDialog(null)
            setDeletePending(false)
            setDeleteError("")
            setDeleteNonce("")
          }
          const run = deleteDialog?.run
          if (typeof run === 'function') run()
        },
      })

      /**
       * One list, ordered 全局 → 工作区（按工作区顺序）→ 其他作用域.
       *
       * There used to be two sections — 全局 MCP and 项目级 MCP — because the two tiers were
       * genuinely different things: global servers were rows, project servers lived in a
       * field this plugin owned and were mounted at runtime. Both are rows now and `scope`
       * is the only difference, so a second list would be a distinction the data no longer
       * makes.
       *
       * What the *order* carries is which workspace a row belongs to. Within a group the
       * patch's own row order is kept, and that order **is** creation order — `insertRow`
       * appends — so a new server lands at the end of its own workspace without anything
       * extra having to remember that. Groups get no heading of their own: the card already
       * carries a workspace tag, and a second layer of titles would say it twice.
       */
      /**
       * The rows to draw: deletions we asked for are **already gone**.
       *
       * The patch write takes ~1–5 ms, but the panel only sees the result after a round-trip
       * (500 ms drain poll + Loader reload + republish), so a deleted card used to sit there
       * with a spinner for a couple of seconds — reading as "the click did nothing" and
       * inviting a second click. Hiding it on click is safe because `inflight` is not a
       * guess: `settleInflight` keeps the marker only while the row is still listed, and
       * drops it either when the projection catches up (nothing to hide any more) or after
       * its timeout — so if the delete silently failed, the card comes back on its own.
       */
      const deletedIds = new Set(
        Object.entries(inflight)
          .filter(([, info]) => info?.kind === 'delete')
          .map(([entryId]) => String(entryId).replace(/^include:/, '')),
      )
      const mcpRows = profileRows
        .filter((row) => !deletedIds.has(String(row.entryId).replace(/^include:/, '')))
        .filter(matches)
      // An add in flight has no row yet, so it needs a placeholder or the click looks like
      // nothing happened until the write lands. Bucketing it by scope keeps that placeholder
      // in the workspace it is being added to instead of at the end of the page.
      const pendingByScope = new Map()
      for (const [entryId, info] of pendingAdds) {
        const scope = scopeKey(info?.scope)
        pendingByScope.set(scope, [...(pendingByScope.get(scope) ?? []), entryId])
      }
      /**
       * A row we asked to add, rendered as a **real card** until the projection lists it.
       *
       * This used to be a bare spinner (「正在写入配置文件…」). Writing the patch takes ~1–5 ms
       * (measured), but the panel only learns about it a round-trip later: the Host drains
       * `rowOps` on a 500 ms poll, writes the patch, waits for the Loader to reload it, and
       * republishes. So the user filled in a form and then watched a placeholder for seconds —
       * for a row that already existed on disk. Rendering the card they described hides that
       * wait, and the card is replaced by the real one *in place* because both carry the same
       * `entryId`, which the op already knows at click time (`include:mcp-<name>`).
       *
       * A fallback spinner covers the one case with no draft to draw: an op queued by another
       * session, which this panel never saw typed.
       */
      const optimisticCard = (entryId) => {
        const info = inflight[entryId]
        const draftRow = info?.draft
        if (draftRow === undefined) {
          return (
            <li className="smp-card" key={`pending:${entryId}`}>
              <div className="smp-cardHead" key="head">
                <span className="smp-pending" key="p">
                  <span className="smp-spinner" key="s" />
                  {`正在写入配置文件…（${String(entryId).replace(/^include:mcp-/, "")}）`}
                </span>
              </div>
            </li>
          )
        }
        const scope = scopeKey(info?.scope)
        const stdio = (draftRow.transport ?? 'streamable-http') === 'stdio'
        // Keep the `include:` prefix: that is the shape the projection publishes (rows live in
        // an `insert:` list), and `profileCard` looks its own pending state up by that exact
        // key. Dropping it would make the optimistic card render live action buttons.
        return profileCard({
          entryId: String(entryId),
          serverName: draftRow.serverName ?? '',
          scope: scope === '' ? '' : scope,
          transport: draftRow.transport ?? 'streamable-http',
          target: stdio
            ? [draftRow.command, draftRow.args].filter((part) => String(part ?? '').trim() !== '').join(' ')
            : (draftRow.url ?? ''),
          command: draftRow.command ?? '',
          args: draftRow.args ?? '',
          env: draftRow.env ?? '',
          headersText: draftRow.headers ?? '',
          enabled: true,
          phase: '',
        }, scope === '' ? 'global' : 'project')
      }
      const mcpGroups = orderedScopeGroups(
        mcpRows,
        workspacePaths,
        // A scope whose only member is still being written must still get a group, or its
        // card would have nowhere to sit.
        [...pendingByScope.keys()],
      )
      const mcpList = (
        <ul className="smp-cards" key="cards">
          {mcpGroups.map((group) => [
            // `.map(profileCard)` would pass the array **index** as the `tier` argument —
            // which silently made every global card report its status against tier `0`, so
            // the tags vanished. Wrap the call.
            ...group.items.map((row) => profileCard(row, (row.scope ?? 'global') === 'global' ? 'global' : 'project')),
            ...(pendingByScope.get(group.scope) ?? []).map(optimisticCard),
          ])}
          {mcpRows.length === 0 && pendingAdds.length === 0 ? (
            <li className="smp-empty" key="empty" style={{ gridColumn: "1 / -1" }}>
              {emptyMcpText('')}
            </li>
          ) : null}
        </ul>
      )

      // The MCP tab is one list, so its heading had nothing to collapse. The summary it
      // carried now sits above the search box (see the page render below), and its count
      // follows the filtered list.
      // 与技能页同一套摘要语言：一个数字 + 一个悬停说明，不写整句。
      const mcpSummary = (
        <>
          <span className="smp-stat" key="n">
            <b className="smp-statNum">{mcpRows.length}</b>
            <span className="smp-statLabel">个服务器</span>
          </span>
          <span
            className="smp-info" key="cfg"
            title="改动写回 cordis.patch.yml；写前自动备份，重启 DSH 后生效"
          >配置位置</span>
        </>
      )

      const mcpSections = [
        <ul className="smp-cards" key="import">{importCard(importScope)}</ul>,
        // The form sits directly above the list it appends to — not at the bottom of it.
        // The trigger is on the search row; the form must not be a whole page away from it.
        editing?.kind === "mcp" && editing.id === undefined ? (
          <ul className="smp-cards" key="formWrap">{serverForm({ tier: editing.tier })}</ul>
        ) : null,
        // No heading and no wrapper: the summary line above the search box already says
        // what the list is, and a section around a single list only added spacing of its
        // own. As a plain sibling of the import card, this list inherits the page rhythm.
        mcpList,
      ]

      /**
       * The skills tab, rendered **the same way as MCP**: one list under a summary line,
       * with no per-tier section wrappers.
       *
       * The old shape was two collapsible sections (「全局技能」/「项目级技能」) whose headings
       * carried the add buttons. That made the two tabs look like different products even
       * though they manage the same kind of thing, and it hid the list behind a chevron the
       * MCP tab does not have. The workspace grouping those sections expressed is now the
       * list's *order* (see `skillGroups`).
       *
       * The line mirrors the MCP one: a count for **the list as rendered**, who the entries
       * belong to, and where a write lands. Deliberately not a per-tier breakdown — the list
       * is one list now, so "面板 N 个 · 磁盘 M 个" would describe two subsets the user cannot
       * tell apart on screen.
       */

      /**
       * 技能治理：按来源分组 + 逐技能/逐来源启停。
       *
       * 数据来自 `/runtime` 的 `skillGovernance`（Host 用同一份治理快照喂 DSH 的
       * skills provider，所以「面板停用」与「模型能不能调用」永远同源）。
       *
       * 启停走插件自己的 HTTP 路由而不是 settings 文档：一次点击必须立刻生效，且不能
       * 触发设置壳层的 section 重挂载（那会把展开状态和勾选一起收走，是 0.5.8 修过的坑）。
       */
      const governance = runtime.skillGovernance ?? {}
      const governanceSources = Array.isArray(governance.sources) ? governance.sources : []
      const governanceInstalled = governance.providerInstalled !== false

      /** 范围下拉的选项：已登记工作区 ∪ 治理快照里出现过的项目根。 */
      const workspaceChoices = (() => {
        const scopes = new Set(skillWorkspaceRoots)
        for (const group of governanceSources) {
          const scope = String(group?.scope ?? '')
          if (scope !== '' && scope !== 'global') scopes.add(scope)
        }
        return [...scopes].sort()
      })()

      /**
       * 范围下拉**实际生效**的值。
       *
       * `skillScope` 可能指向一个已被移除的工作区。那时 `<select>` 的 value 不在选项里，
       * 浏览器会显示「全局」，而过滤仍按旧路径走 —— 列表空着却看不出原因。
       * 收敛成 `global` 之后，显示与过滤就一致了。
       */
      const effectiveScope = skillScope === 'global' || workspaceChoices.includes(skillScope) ? skillScope : 'global'

      /**
       * 过滤后的来源分组。
       *
       * 三层，顺序固定：
       *   1. **只保留「目录存在且确实有技能」的来源** —— 不存在的目录、空目录对用户没有意义，
       *      列出来只会把页面撑长（十几个「来源目录不存在」的空壳）。
       *   2. 按范围筛：全局或某个工作区，二选一。
       *   3. 按搜索词筛技能；筛空的组整组隐藏（否则会留下一排 0 个技能的空壳）。
       *
       * 搜索词必须在这一层生效：Skills 页显示的**就是**这个治理视图，早先只在旧的平铺列表
       * 里过滤，于是 Skills 页输入关键字后列表纹丝不动，只有页签上的数字变了。
       */
      const visibleGovernanceSources = governanceSources
        .filter((group) => {
          if (group?.exists !== true) return false
          if (!Array.isArray(group?.skills) || group.skills.length === 0) return false
          const scope = String(group?.scope ?? 'global')
          return effectiveScope === 'global' ? scope === 'global' : scope === effectiveScope
        })
        .map((group) => {
          // 只按搜索词筛。「分类」这一层已经从界面移除（数据仍在 state.json 里）。
          const skills = (Array.isArray(group.skills) ? group.skills : []).filter(
            (skill) => matchesName(skill?.name, query),
          )
          return { ...group, skills, count: skills.length }
        })
        .filter((group) => Array.isArray(group.skills) && group.skills.length > 0)

      /**
       * 技能数量的**唯一真相**：治理快照。
       *
       * 之前页签与摘要用的是 `discoveredOnly`（只扫 DSH 的 4 个原生根、按名字去重），而列表用的是
       * 治理快照（4 个原生根 + 10 个外部 Agent 目录、按来源不去重）——同一屏给出两个互相矛盾的
       * 数字，从别的编辑器迁过来的人看到的正是"显示 0 个，下面却列着 12 张卡"。
       *
       * 现在三处（页签 / 摘要 / 列表）都从这里取，数字必然一致。
       */
      const governanceSkillTotal = governanceSources.reduce(
        (total, group) => total + (Array.isArray(group?.skills) ? group.skills.length : 0), 0,
      )
      /** 其中来自外部 Agent 目录（Claude Code / Cursor …）的数量，摘要里单独点出。 */
      const governanceSkillExternal = governanceSources.reduce(
        (total, group) => total + (group?.native === true ? 0 : (Array.isArray(group?.skills) ? group.skills.length : 0)), 0,
      )
      /**
       * 同名技能的「谁在生效」。
       *
       * 同一个技能可能在多个来源各有一份（`~/.dsh/skills/x` 与 `~/.claude/skills/x`）。DSH 按
       * rank 决胜（**数值小 = 优先级高**），只有一份真正提供给模型；其余那份的启停开关点了也
       * 不起作用 —— 但面板原来把它们平铺成两行，用户以为自己控制了两份。
       *
       * 这里算出 `path → 生效的那份来源名`，卡片据此标注「被 X 覆盖，未生效」并把开关置灰。
       */
      const shadowedSkillBy = (() => {
        const bestByName = new Map()
        for (const group of governanceSources) {
          for (const skill of Array.isArray(group?.skills) ? group.skills : []) {
            // **只算生效的**：来源或技能被停用时，它那份根本不会提供给模型，谈不上"覆盖"别人。
            if (skill?.enabled !== true) continue
            const name = String(skill?.name ?? '')
            if (name === '') continue
            const rank = Number(group?.rank ?? 0)
            const current = bestByName.get(name)
            if (current === undefined || rank < current.rank) {
              bestByName.set(name, { rank, label: String(group?.label ?? group?.key ?? ''), path: String(skill?.path ?? '') })
            }
          }
        }
        const map = new Map()
        for (const group of governanceSources) {
          for (const skill of Array.isArray(group?.skills) ? group.skills : []) {
            if (skill?.enabled !== true) continue
            const winner = bestByName.get(String(skill?.name ?? ''))
            const path = String(skill?.path ?? '')
            if (winner !== undefined && path !== '' && winner.path !== path) map.set(path, winner.label)
          }
        }
        return map
      })()
      /**
       * 总账：**当前范围**里模型实际能看到几个，差额被哪一层挡住。
       *
       * 两个口径问题在这一版一起修掉：
       *
       *   1. **不掺别的范围**。原来卡里同时写「全局 24 · 生效 10」和选中工作区的数字 ——
       *      既然用户已经选了一个范围，卡里就只该有这个范围的数。两个作用域的统计并排，
       *      读者得先在脑子里做减法才知道"我现在看的这层到底几个"。
       *   2. **"看不到"有三种原因**（去掉分类后开关只剩两层，但同名覆盖仍会让一份不可见）：
       *      自身停用 / 来源停用 / 同名覆盖。三者互斥，不会重复扣减。
       *
       * 口径由 `countSkills` 统一提供，页签与摘要用的是同一个函数。
       */
      const governanceOverall = countSkills(governanceSources, 'all')
      const governanceScope = effectiveScope === 'global' ? 'global' : effectiveScope
      const governanceScopeCounts = countSkills(governanceSources, governanceScope)
      const governanceScopeLabel = governanceScope === 'global'
        ? '全局'
        : (projectLabel(governanceScope) || '当前工作区')
      /** 当前筛选（范围/搜索）之外还剩多少：空列表时用来如实说明，而不是断言"没有技能"。 */
      const filteredOutSkillCount = Math.max(0, governanceSkillTotal - visibleGovernanceSources.reduce(
        (total, group) => total + (Array.isArray(group?.skills) ? group.skills.length : 0), 0,
      ))

      /**
       * 摘要条：只放**会变**的数字，路径规范这类"文档内容"退到悬停说明里。
       *
       * 原来这里是一整句：「共 24 个（其中 12 个来自外部 Agent 目录）· 作用域见卡片上的标签 ·
       * 全局写 C:\Users\…\.dsh\skills 或 …，项目级写 <工作区>/.dsh/skills 或 …」。
       * 它把计数、命名规则、磁盘路径三种东西混成一段话 —— 用户扫一眼读不完，也记不住。
       */
      const skillsSummary = (
        <>
          <span className="smp-stat" key="n" title={`共 ${governanceSkillTotal} 个，其中模型可见 ${governanceOverall.visible} 个`}>
            <b className="smp-statNum">{governanceOverall.visible}</b>
            <span className="smp-statLabel">{`生效 / 共 ${governanceSkillTotal}`}</span>
          </span>
          {governanceSkillExternal > 0 ? (
            <span
              className="smp-chip" key="ext"
              title="来自 Claude Code、Codex 等外部 Agent 目录（只读，可启停）"
            >{`${governanceSkillExternal} 个来自外部 Agent`}</span>
          ) : null}
          <span
            className="smp-info" key="dirs" aria-label="技能目录位置"
            title={[
              `全局：${skillDirs.userDsh || '~/.dsh/skills'} / ${skillDirs.userAgents || '~/.agents/skills'}`,
              '项目级：<工作区>/.dsh/skills / <工作区>/.agents/skills',
            ].join('\n')}
          >目录位置</span>
        </>
      )

      const sendGovernance = async (body, key) => {
        if (typeof fetch !== 'function') return { ok: false, reason: '当前环境没有 fetch' }
        setGovernancePending(key)
        try {
          const response = await fetch(`/${NS}/skills-governance`, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          // 404/405 = 这个 Host 没有治理路由（老版本或 Host 半边没起来）；401/403 = 请求未被信任。
          if (response.status === 404 || response.status === 405) {
            return { ok: false, reason: '这个 Host 没有技能治理通道（Host 侧改动需要重启一次 DSH）' }
          }
          if (response.status === 401 || response.status === 403) {
            return { ok: false, reason: '请求未被信任（请从 DSH 面板里操作）' }
          }
          if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
          const result = await response.json()
          return result !== null && typeof result === 'object' ? result : { ok: false, reason: '响应格式无效' }
        } catch (error) {
          return { ok: false, reason: String(error?.message ?? error) }
        } finally {
          setGovernancePending('')
        }
      }

      const toggleGovernance = async (body, key) => {
        const result = await sendGovernance(body, key)
        if (result.ok === true) {
          bumpRefresh()
          // 成功要清掉上一次的失败横幅：否则一次失败之后，后面每个成功操作都顶着红字，
          // 用户会以为还在出错。
          setError('')
          // 返回成败：调用方用它决定"输入框该不该清空"这类动作（例如添加仓库）。
          return true
        }
        setError(String(result.reason ?? '技能启停失败'))
        return false
      }

      /**
       * 批量启停：串行发送，一条失败不影响其余 —— 但**失败不能悄悄消失**。
       *
       * `toggleGovernance` 成功时会清掉错误横幅（这是对的：一次失败之后不该让后续每个成功
       * 操作都顶着红字）。可在批量循环里这就变成了"第 1 个失败、第 2 个成功 → 横幅被清"，
       * 用户看到的是"批量操作好像都成了"，而实际上有一个技能没改。所以循环结束后把失败数量
       * 重新写出来（只报数量，不逐个罗列 —— 一行横幅装不下，也没人愿意读）。
       */
      const runBatchToggle = async (op) => {
        const targets = [...selectedSkills]
        const failed = []
        for (const path of targets) {
          const ok = await toggleGovernance({ op, path }, path)
          if (ok !== true) failed.push(path)
        }
        setSelectedSkills([])
        if (failed.length > 0) {
          setError(`${failed.length} / ${targets.length} 个技能未能${op === 'skill-enable' ? '启用' : '停用'}，可重试`)
        }
      }

      /** 检查某个已安装技能是否有更新（只读，不回写状态）。 */
      const checkInstall = async (installId) => {
        const result = await sendGovernance({ op: 'repo-preview', id: installId }, `check:${installId}`)
        if (result.ok === true && result.preview !== undefined && result.preview !== null) {
          setRepoStatus((current) => ({ ...current, [installId]: result.preview }))
          return
        }
        setError(String(result.reason ?? '检查更新失败'))
      }

      /** 导入命令走单独的路由：它要带一个更大的请求体（base64 的技能包）。 */
      const sendImport = async (body) => {
        if (typeof fetch !== 'function') return { ok: false, reason: '当前环境没有 fetch' }
        setImportPending(true)
        try {
          const response = await fetch(`/${NS}/skills-import`, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          if (response.status === 404 || response.status === 405) {
            return { ok: false, reason: '这个 Host 没有导入通道（Host 侧改动需要重启一次 DSH）' }
          }
          if (response.status === 401 || response.status === 403) {
            return { ok: false, reason: '请求未被信任（请从 DSH 面板里操作）' }
          }
          if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
          const result = await response.json()
          return result !== null && typeof result === 'object' ? result : { ok: false, reason: '响应格式无效' }
        } catch (error) {
          return { ok: false, reason: String(error?.message ?? error) }
        } finally {
          setImportPending(false)
        }
      }

      /** 安装 / 导入共用的目标字段（顶部那个选择器）。 */
      const importTarget = () => ({
        scope: repoDest.scope, destId: repoDest.destId, project: repoDest.project,
      })

      /** 市场命令走单独的路由：它会打外网（12 秒超时），不该排在毫秒级的启停后面。 */
      const sendCatalog = async (body) => {
        if (typeof fetch !== 'function') return { ok: false, reason: '当前环境没有 fetch' }
        setCatalogPending(true)
        setCatalogNote('')
        try {
          const response = await fetch(`/${NS}/skills-catalog`, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
          if (response.status === 404 || response.status === 405) {
            return { ok: false, reason: '这个 Host 没有市场通道（Host 侧改动需要重启一次 DSH）' }
          }
          if (response.status === 401 || response.status === 403) {
            return { ok: false, reason: '请求未被信任（请从 DSH 面板里操作）' }
          }
          if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
          const result = await response.json()
          return result !== null && typeof result === 'object' ? result : { ok: false, reason: '响应格式无效' }
        } catch (error) {
          return { ok: false, reason: String(error?.message ?? error) }
        } finally {
          setCatalogPending(false)
        }
      }

      /** 跑一次搜索 / 榜单，用结果替换列表。 */
      const runCatalog = async (body, note = '') => {
        const result = await sendCatalog(body)
        if (result.ok !== true) {
          /**
           * 失败**不清空已有结果**：翻页失败时把前面几页一起抹掉，用户连刚看到的东西都没了。
           * 只有"新搜索"（不带 cursor）失败才适合清空 —— 那种情况下旧结果已经不对应当前查询。
           */
          if (String(body?.cursor ?? '') === '') {
            setCatalogItems([])
            setCatalogCursor('')
          }
          setCatalogNote(String(result.reason ?? '市场操作失败'))
          return
        }
        const items = Array.isArray(result.items) ? result.items : []
        // 「加载更多」是**追加**：直接覆盖会让翻页看起来像"结果被换掉了"。
        if (String(body?.cursor ?? '') === '') setCatalogItems(items)
        else if (items.length > 0) setCatalogItems((current) => {
          // 去重键取安装时要用的那几个字段：同一个技能在翻页里出现两次不该出两行。
          const keyOf = (item) => [item?.catalog ?? '', item?.source ?? '', item?.skillId ?? item?.slug ?? item?.name ?? ''].join('|')
          const seen = new Set(current.map(keyOf))
          return [...current, ...items.filter((item) => !seen.has(keyOf(item)))]
        })
        setCatalogCursor(String(result.nextCursor ?? ''))
        setCatalogNote(items.length === 0 ? '没有找到匹配的技能' : note)
      }

      /** 问 GitHub 仓库有没有新版本；插件不会自己替换文件，只把结论显示出来。 */
      const checkPluginUpdate = async () => {
        const result = await sendCatalog({ op: 'update-check' })
        if (result.ok === true) {
          setPluginUpdate({
            current: String(result.current ?? ''),
            latest: String(result.latest ?? ''),
            updateAvailable: result.updateAvailable === true,
            url: String(result.url ?? ''),
          })
          setPluginUpdateNote('')
          return
        }
        setPluginUpdate(null)
        // 错误必须写在**插件更新区块**里：原来写进 `catalogNote`，而那个只在「在线市场」渲染，
        // 于是失败原因永远看不见。
        setPluginUpdateNote(String(result.reason ?? '检查插件更新失败'))
      }

      const installMarketItem = async (item) => {        const result = await sendCatalog({
          op: 'catalog-install',
          catalog: item.catalog,
          source: item.source ?? '',
          skillId: item.skillId ?? '',
          owner: item.owner ?? '',
          slug: item.slug ?? '',
          ...importTarget(),
        })
        if (result.ok === true) {
          /**
           * 回执带**完整落点**（设计评审第 6 条）。
           *
           * 只给名字的话，用户装到某个工作区后回到技能页（默认看全局）会找不到它，只能怀疑
           * 安装失败。Host 返回 `path` 时就把它写出来；老 Host 不返回也不影响。
           */
          const landed = typeof result.path === 'string' && result.path !== '' ? ` → ${result.path}` : ''
          setCatalogNote(`已安装 ${result.skill?.name ?? item.name ?? ''}${landed}`)
          // 记下落点范围：回执上的「查看」要能一键切到装到的那个范围。
          setLastInstalledScope({ scope: repoDest.scope, project: repoDest.project })
          bumpRefresh()
        } else {
          setCatalogNote(String(result.reason ?? '安装失败'))
        }
      }

      const importFolderNow = async () => {
        const result = await sendImport({ op: 'import-folder', path: importPath, name: importName, ...importTarget() })
        if (result.ok === true) { setImportPath(''); setImportName(''); bumpRefresh() }
        else setError(String(result.reason ?? '导入失败'))
      }

      /** 读本地选中的文件：zip 走 data URL（base64），`.md` 走文本。 */
      const importFileNow = async (file) => {
        if (file === undefined || file === null) return
        const isZip = /\.zip$/i.test(String(file.name ?? ''))
        if (typeof FileReader === 'undefined') { setError('当前环境不支持读取本地文件'); return }
        const read = () => new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result)
          reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
          if (isZip) reader.readAsDataURL(file)
          else reader.readAsText(file)
        })
        let payload
        try {
          payload = await read()
        } catch (error) {
          setError(String(error?.message ?? error))
          return
        }
        const result = await sendImport({
          op: isZip ? 'import-zip' : 'import-markdown',
          ...(isZip ? { base64: String(payload) } : { markdown: String(payload) }),
          name: importName,
          ...importTarget(),
        })
        if (result.ok === true) { setImportName(''); bumpRefresh() }
        else setError(String(result.reason ?? '导入失败'))
      }

      const governanceSkillAt = (path) => {
        for (const group of governanceSources) {
          for (const skill of Array.isArray(group.skills) ? group.skills : []) {
            if (skill.path === path) return skill
          }
        }
        return null
      }

      const governanceTrash = Array.isArray(governance.trash) ? governance.trash : []


      /**
       * 回收站：删除是「移进去」，不是 `unlink` —— 技能目录里可能有用户手写的东西，
       * 撤销比确认更可靠。「彻底删除」是用户显式点的事，不做二次确认弹窗之外的花样。
       */
      const trashSection = (
        <section className="smp-group" key="trash">
          <div className="smp-groupTitleRow" key="h">
            <span className="smp-groupTitle">回收站</span>
            <span className="smp-skillCount">{`${governanceTrash.length} 项`}</span>
          </div>
          <div className="smp-groupSub" key="s">
            可原样恢复；「彻底删除」才真正抹掉文件。
          </div>
          {governanceTrash.length === 0 ? null : (
            <ul className="smp-skillCategories" key="list">
              {governanceTrash.map((record) => (
                <li className="smp-skillCategoryRow" key={String(record.id)}>
                  <span className="smp-skillCategoryName">{record.name}</span>
                  <span className="smp-skillCategoryCount">
                    {`${record.source || '未知来源'}${record.deletedAt ? ` · ${String(record.deletedAt).slice(0, 16).replace('T', ' ')}` : ''}`}
                  </span>
                  <span className="smp-skillCategoryActions">
                    {record.exists === false ? (
                      <span className="smp-note">文件已不在回收站</span>
                    ) : (
                      <button
                        className="smp-button" data-variant="primary" type="button"
                        disabled={governancePending !== ''}
                        onClick={() => { void toggleGovernance({ op: 'trash-restore', id: record.id }, record.id) }}
                      >
                        恢复
                      </button>
                    )}
                    <button
                      className="smp-button" data-variant="outline" type="button"
                      disabled={governancePending !== ''}
                      onClick={() => {
                        /**
                         * 彻底删除不可恢复，所以要确认 —— 与 MCP 卡的删除走同一个对话框，
                         * 而不是这里单独一个「点了就抹」。误点一次就没有回头路。
                         */
                        setDeleteDialog({
                          label: String(record.name ?? ''),
                          note: '彻底删除后无法恢复。',
                          closeOnConfirm: true,
                          run: () => { void toggleGovernance({ op: 'trash-purge', id: record.id }, record.id) },
                        })
                      }}
                    >
                      彻底删除
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )

      /**
       * 仓库安装记录 + 安装状态文案。
       *
       * 声明位置在 `governanceSection` **之前**是必须的：下面那段 JSX 在构造时就会求值，
       * 而 `const` 有暂时性死区 —— 页签计数为这个坑返工过一次。
       */
      const installs = Array.isArray(governance.installs) ? governance.installs : []
      const installStatusLabel = (status) => ({
        'up-to-date': '已是最新',
        'update-available': '有更新',
        'locally-modified': '本地已修改',
        missing: '目录缺失',
      })[String(status ?? '')] ?? ''

      const governanceSection = (
        <section className="smp-group" key="governance">
          {/*
            * 不再有「按来源启停」这种小标题。
            *
            * 页签写着「技能」、下面紧接着就是数字条和一组来源 —— 再加一句标题只是多一层
            * 加粗文字，把视线从内容上推开。页面的层级靠字号、间距和分组边框表达，不靠小标题。
            */}
          {/*
            * 总账（设计评审第 2 条）：用户不该在脑子里对三层开关做与运算。
            *
            * 这一行直接回答"模型现在实际能看到几个"，并说明差额被谁挡住 —— 去掉分类开关后
            * 只剩两层，所以"被挡下"只有两种原因，能一句话说清。
            */}
          {/*
            * 批量启停（设计决策 A 的配套）：去掉分类开关之后，"整组处理"不能再靠停用整个分类，
            * 所以选中多个技能后在这里一次启停。选中状态只影响这个动作条，不改变任何策略。
            */}
          {selectedSkills.length === 0 ? null : (
            <div className="smp-actionsRow" key="batch">
              <span className="smp-groupSub smp-summaryAbove">{`已选 ${selectedSkills.length} 个技能`}</span>
              <button
                className="smp-button" data-variant="outline" type="button" disabled={governancePending !== ''}
                onClick={() => { void runBatchToggle('skill-disable') }}
              >批量停用</button>
              <button
                className="smp-button" data-variant="outline" type="button" disabled={governancePending !== ''}
                onClick={() => { void runBatchToggle('skill-enable') }}
              >批量启用</button>
              <button
                className="smp-button" data-variant="outline" type="button"
                onClick={() => setSelectedSkills([])}
              >清除选择</button>
            </div>
          )}
          {/*
            * 总账做成**数字条**，且**只讲当前范围**。
            *
            * 两条规矩：
            *   · 用户已经选了范围，卡里就只出现这个范围的数 —— 不再把「全局 24 · 生效 10」
            *     和选中工作区的数字并排放，让人自己在脑子里对照。
            *   · 结论（可见 / 总数）用大字；被挡下的原因只在**非零**时作为彩色小标签出现，
            *     零值不占版面。
            */}
          {(() => {
            const reasons = [
              { key: 'self', label: '技能停用', value: governanceScopeCounts.disabledSelf, tone: 'neutral' },
              { key: 'source', label: '来源停用', value: governanceScopeCounts.disabledSource, tone: 'warn' },
              { key: 'shadow', label: '同名覆盖', value: governanceScopeCounts.shadowed, tone: 'warn' },
            ].filter((item) => item.value > 0)
            return (
              <div className="smp-ledger" key="ledger">
                <span className="smp-ledgerMain">
                  <b className="smp-ledgerNum">{`${governanceScopeCounts.visible} / ${governanceScopeCounts.total}`}</b>
                  <span className="smp-ledgerLabel">模型可见</span>
                </span>
                <span className="smp-chip" data-tone="neutral">{governanceScopeLabel}</span>
                {reasons.length === 0 ? (
                  <span className="smp-chip" data-tone="ok">全部可用</span>
                ) : (
                  <span className="smp-ledgerReasons">
                    {reasons.map((item) => (
                      <span className="smp-chip" key={item.key} data-tone={item.tone}>
                        {`${item.label} ${item.value}`}
                      </span>
                    ))}
                  </span>
                )}
              </div>
            )
          })()}
          {governanceInstalled ? null : (
            <div className="smp-groupSub" key="noProvider">当前 Host 没有 skills 服务，启停不会生效。</div>
          )}
          {governance.scanError ? <p className="smp-error" key="scan">{`扫描失败：${governance.scanError}`}</p> : null}
          {/*
            * 范围选择做成**分段控件**，不是原生下拉。
            *
            * 原生 <select> 在这个页面里没有箭头、没有边框语言，和周围的胶囊页签、圆角卡片
            * 不是一套东西；而且"全局 / 某个工作区"本来互斥，摊开比"点开才知道有哪几个"
            * 少一次点击。工作区多时允许换行 —— 换行的代价比藏起来小。
            */}
          <div className="smp-segmented" key="filters" role="group" aria-label="按范围过滤">
            <button
              type="button" className="smp-segment"
              data-active={effectiveScope === 'global' ? 'true' : 'false'}
              onClick={() => setSkillScope('global')}
            >全局</button>
            {workspaceChoices.map((path) => (
              <button
                key={path} type="button" className="smp-segment"
                data-active={effectiveScope === path ? 'true' : 'false'}
                title={path}
                onClick={() => setSkillScope(path)}
              >{projectLabel(path) || path}</button>
            ))}
          </div>
          {skillSourceGroupsNode({
            groups: visibleGovernanceSources,
            /**
             * 仓库动作直接长在技能卡片上（一个对象一个家）。
             *
             * 之前这些动作只在「获取技能 → 已安装」里，用户得自己在两张清单之间对号 ——
             * 技能页那个技能和已安装列表那个同名条目是同一个东西，却要人脑去连。
             */
            installs,
            installMenuFor: skillMenuFor,
            onToggleInstallMenu: (path) => setSkillMenuFor((current) => (current === path ? '' : path)),
            installPreview: repoStatus,
            installStatusLabel,
            repoBusy: governancePending !== '',
            onRepoAction: (op, id) => {
              void (async () => {
                await toggleGovernance({ op, id }, id)
                /**
                 * 更新 / 回滚 / 卸载之后，「有没有新版」这个结论就过期了。
                 *
                 * 不清掉的话卡片上会一直挂着上一次「有更新」的标签：用户点完更新，标签还在，
                 * 会以为更新失败（实际上成功了）。检查更新是显式动作，结论也只该活到下一次动作。
                 */
                setRepoStatus((current) => {
                  if (current[id] === undefined) return current
                  const next = { ...current }
                  delete next[id]
                  return next
                })
              })()
            },
            onCheckInstall: (id) => { void checkInstall(id) },
            busy: governancePending !== '',
            onTrash: (path) => {
              void toggleGovernance({ op: 'trash-skill', path }, path)
            },
            /**
             * 空状态必须**说实话**。
             *
             * 之前它无条件写「还没有发现任何技能」—— 可当范围默认是「全局」、而技能都在项目里时，
             * 这句话是错的（用户会以为迁移失败）。现在区分两种空：
             *   · 真没有（治理快照总数为 0）；
             *   · 被当前筛选挡住（还有 N 个在别处），并给一键清除。
             */
            emptyHint: governanceSkillTotal === 0
              ? '还没有发现任何技能。去「获取技能」装一个，或把范围切到对应工作区。'
              : (filteredOutSkillCount > 0
                ? `当前筛选下没有技能；另有 ${filteredOutSkillCount} 个被范围/搜索挡住。`
                : ''),
            onResetFilters: () => {
              /**
               * 「清除筛选」必须真的把技能带回来。
               *
               * 原来无条件重置成「全局」—— 当技能全在某个工作区、全局一个都没有时，
               * 点下去列表仍然是空的，看起来像"按钮坏了"。现在优先回全局（多数人的默认），
               * 全局确实为空才跳到第一个**有技能**的范围。
               */
              const withSkills = governanceSources.filter(
                (group) => Array.isArray(group?.skills) && group.skills.length > 0,
              )
              const globalHasSkills = withSkills.some((group) => String(group?.scope ?? 'global') === 'global')
              if (!globalHasSkills && withSkills.length > 0) {
                const scope = String(withSkills[0]?.scope ?? '')
                if (scope !== '' && scope !== 'global') setSkillScope(scope)
              } else {
                setSkillScope('global')
              }
              setQuery('')
            },
            onEdit: (path) => {
              const skill = governanceSkillAt(path)
              if (skill !== null) openSkillEditor(skill)
            },
            shadowedSkillBy,
            selectedPaths: selectedSkills,
            onSelectSkill: (path) => setSelectedSkills((current) => (current.includes(path) ? current.filter((item) => item !== path) : [...current, path])),
            expanded: expandedSources,
            onToggleExpanded: (key) => {
              setExpandedSources((current) => (
                current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
              ))
            },
            onToggleSkill: (path, enabled) => {
              void toggleGovernance({ op: enabled ? 'skill-enable' : 'skill-disable', path }, path)
            },
            onToggleSource: (key, enabled) => {
              void toggleGovernance({ op: enabled ? 'source-enable' : 'source-disable', source: key }, key)
            },
            onPreview: (path) => {
              const skill = governanceSkillAt(path)
              if (skill !== null) openPreview(skill)
            },
          })}
        </section>
      )

      const repositories = Array.isArray(governance.repositories) ? governance.repositories : []

      /** 安装目标：一次选择，仓库里每个技能的「安装」都用它。 */
      const repoDestinationRow = (
        <div className="smp-formRow" key="repo-dest">
          <span className="smp-formRowLabel">安装 / 导入目标</span>
          <div className="smp-formRowBody">
            <select
              className="smp-select" value={repoDest.scope}
              aria-label="安装范围"
              onChange={(event) => setRepoDest((current) => ({ ...current, scope: event.target.value }))}
            >
              <option value="global">用户目录</option>
              <option value="project">指定工作区</option>
            </select>
            {repoDest.scope === 'project' ? (
              <select
                className="smp-select" value={repoDest.project}
                aria-label="目标工作区"
                onChange={(event) => setRepoDest((current) => ({ ...current, project: event.target.value }))}
              >
                <option value="">选择工作区…</option>
                {skillWorkspaceRoots.map((path) => <option key={path} value={path}>{path}</option>)}
              </select>
            ) : null}
            <select
              className="smp-select" value={repoDest.destId}
              aria-label="安装位置"
              onChange={(event) => setRepoDest((current) => ({ ...current, destId: event.target.value }))}
            >
              <option value="dsh">DSH skills</option>
              <option value="agents">Shared Agent</option>
            </select>
          </div>
        </div>
      )

      /** 已安装技能的主状态（与 Host 的 `previewInstall` 一一对应）。文案见上面的 `installStatusLabel`。 */
      const installFor = (repoId, skillName) => installs.find(
        (item) => item.repoId === repoId && item.skill === skillName,
      )

      const repoBusy = governancePending !== ''
      const repoDestReady = repoDest.scope !== 'project' || repoDest.project !== ''

      /**
       * 技能仓库：粘贴地址 → 扫描 → 逐技能安装。
       *
       * 安装目标只在**一处**选（一次选择，下面每个「安装」都用它）：上游也是这么做的，
       * 否则每个技能前面挂三个下拉，一屏里会有几十个控件，反而更容易选错。
       */
      const repoSection = (
        <section className="smp-group" key="repos">
          <div className="smp-groupTitleRow" key="h">
            <span className="smp-groupTitle">技能仓库</span>
            <span className="smp-skillCount">{`${repositories.length} 个`}</span>
          </div>
          <div className="smp-groupSub" key="s">
            公开 GitHub 仓库；刷新只更新列表，不更新已装技能。
          </div>
          <div className="smp-formRow" key="add">
            <span className="smp-formRowLabel">仓库地址</span>
            <div className="smp-formRowBody">
              <input
                className="smp-input" value={repoUrl} placeholder="https://github.com/owner/repo"
                aria-label="仓库地址"
                onChange={(event) => setRepoUrl(event.target.value)}
              />
              <button
                className="smp-button" data-variant="primary" type="button"
                disabled={repoBusy || repoUrl.trim() === ''}
                onClick={() => {
                  // 成功才清空：URL 非法或离线时，用户刚粘进来的地址必须留着（重打一遍很烦）。
                  void toggleGovernance({ op: 'repo-add', url: repoUrl }, 'repo-add').then((ok) => {
                    if (ok === true) setRepoUrl('')
                  })
                }}
              >
                添加仓库
              </button>
            </div>
          </div>
          {repoDestinationRow}
          {repositories.length === 0 ? null : (
            <ul className="smp-skillCategories" key="list">
              {repositories.map((repo) => (
                <li className="smp-skillCategoryRow" key={String(repo.id)}>
                  <span className="smp-skillCategoryName">{`${repo.owner}/${repo.name}`}</span>
                  <span className="smp-skillCategoryCount">{`${(repo.skills ?? []).length} 个技能`}</span>
                  <span className="smp-skillCategoryActions">
                    <button
                      className="smp-button" data-variant="outline" type="button" disabled={repoBusy}
                      onClick={() => { void toggleGovernance({ op: 'repo-refresh', id: repo.id }, `refresh:${repo.id}`) }}
                    >
                      刷新
                    </button>
                    <button
                      className="smp-button" data-variant="outline" type="button" disabled={repoBusy}
                      onClick={() => { void toggleGovernance({ op: 'repo-remove', id: repo.id }, `remove:${repo.id}`) }}
                    >
                      移除
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {repositories.map((repo) => (
            <ul className="smp-skillCategories" key={`skills-${repo.id}`}>
              {(repo.skills ?? []).map((skill) => {
                const installed = installFor(repo.id, skill.name)
                return (
                  <li className="smp-repoSkill" key={`${repo.id}:${skill.name}`}>
                    <span className="smp-repoSkillName">{skill.name}</span>
                    <span className="smp-repoSkillDesc">{skill.description || '（无描述）'}</span>
                    <span className="smp-skillCategoryCount">{`${skill.fileCount} 个文件`}</span>
                    <span className="smp-skillCategoryActions">
                      {installed === undefined ? (
                        <button
                          className="smp-button" data-variant="primary" type="button"
                          disabled={repoBusy || !repoDestReady}
                          onClick={() => {
                            void toggleGovernance({
                              op: 'repo-install', id: repo.id, skill: skill.name,
                              scope: repoDest.scope, destId: repoDest.destId, project: repoDest.project,
                            }, `install:${repo.id}:${skill.name}`)
                          }}
                        >
                          安装
                        </button>
                      ) : (
                        /**
                         * 已装过：显示状态，但**不能让记录变成死角**。
                         *
                         * 用户手删目录 / 改名 / 移除工作区后，安装记录还指着那个不存在的目录：
                         * 技能页找不到卡片（于是没有「…」），这里若只写「已安装」，更新、回滚、
                         * 卸载、重装就全都没有入口 —— 只能手改 state.json。
                         * 现在把这种记录标成「记录失效」并给一个「清除记录」（Host 侧对
                         * "目录已不在"的卸载是幂等的：摘记录，不报错）。
                         */
                        <React.Fragment key="installed">
                          <span
                            className="smp-tag"
                            data-tone={installed.missing === true ? 'warn' : 'neutral'}
                            title={installed.missing === true
                              ? '安装记录指向的目录已经不存在（被手删、改名或工作区被移除），这条记录已失效'
                              : `已安装到 ${String(installed.dir ?? '')}`}
                          >{installed.missing === true ? '记录失效' : '已安装'}</span>
                          {installed.missing !== true ? null : (
                            <button
                              className="smp-button" data-variant="outline" type="button"
                              disabled={repoBusy}
                              title="摘掉这条失效的安装记录（不会动磁盘上的任何文件）"
                              onClick={() => {
                                void toggleGovernance({ op: 'repo-uninstall', id: installed.id }, `uninstall:${installed.id}`)
                              }}
                            >清除记录</button>
                          )}
                        </React.Fragment>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
          ))}
        </section>
      )

      /**
       * 导入：zip / 单个 SKILL.md / 磁盘目录。
       *
       * 只读来源（外部 Agent 目录）永远不是导入目标 —— 目标选择器给的是可写根，
       * 与「添加技能」完全同一套解析。
       */
      const importSection = (
        <section className="smp-group" key="import">
          <div className="smp-groupTitleRow" key="h">
            <span className="smp-groupTitle">导入技能</span>
          </div>
          <div className="smp-groupSub" key="s">
            从 zip、SKILL.md 或磁盘目录导入；同名不覆盖。
          </div>
          <div className="smp-formRow" key="file">
            <span className="smp-formRowLabel">从文件</span>
            <div className="smp-formRowBody">
              {/*
                * 整个框都是"选择文件"的触发区。
                *
                * 原生 input[type=file] 长得是「大框里嵌一个小按钮」，同一个动作两个点击目标 ——
                * 用户会先点框、发现没反应，再去找那个小按钮。这里把原生控件视觉上收掉，
                * 用 <label> 包住整块：点框任意位置都打开选择器，框里只显示规则与已选文件名。
                */}
              <label
                className="smp-filePick"
                data-busy={importPending ? 'true' : 'false'}
                title="选择 .zip 或 SKILL.md"
              >
                <input
                  className="smp-filePickInput"
                  type="file" accept=".zip,.md"
                  aria-label="选择技能包或 SKILL.md"
                  disabled={importPending}
                  onChange={(event) => { void importFileNow(event.target.files?.[0]) }}
                />
                <span className="smp-filePickText">{'选择 .zip 或 SKILL.md'}</span>
              </label>
              <input
                className="smp-input" value={importName} placeholder="技能名（可选）"
                aria-label="导入的技能名"
                onChange={(event) => setImportName(event.target.value)}
              />
            </div>
          </div>
          <div className="smp-formRow" key="folder">
            <span className="smp-formRowLabel">从目录</span>
            <div className="smp-formRowBody">
              <input
                className="smp-input" value={importPath} placeholder="技能目录的绝对路径"
                aria-label="技能目录路径"
                onChange={(event) => setImportPath(event.target.value)}
              />
              <button
                className="smp-button" data-variant="primary" type="button"
                disabled={importPending || importPath.trim() === ''}
                onClick={() => { void importFolderNow() }}
              >
                导入目录
              </button>
            </div>
          </div>
        </section>
      )

      /**
       * 在线市场：搜索 / 榜单 → 安装到同一个目标。
       *
       * 结果只保留「能安装的那几项」：市场返回的字段由外部服务决定，Host 侧已经校验过一遍，
       * 这里只负责展示。安装按钮与仓库的「安装」是同一套目标字段。
       */
      const marketSection = (
        <section className="smp-group" key="market">
          <div className="smp-groupTitleRow" key="h">
            <span className="smp-groupTitle">在线市场</span>
            {catalogItems.length === 0 ? null : (
              <span className="smp-skillCount">{`${catalogItems.length} 条结果`}</span>
            )}
          </div>
          <div className="smp-groupSub" key="s">
            从 skills.sh / ClawHub 搜索安装，需联网。
          </div>
          <div className="smp-formRow" key="search">
            <span className="smp-formRowLabel">搜索市场</span>
            <div className="smp-formRowBody">
              <select
                className="smp-select" value={catalogMarket} aria-label="选择市场"
                onChange={(event) => { setCatalogMarket(event.target.value); setCatalogItems([]); setCatalogCursor(''); setCatalogNote('') }}
              >
                <option value="skillsh">skills.sh</option>
                <option value="clawhub">ClawHub</option>
              </select>
              <input
                className="smp-input" value={catalogQueryText} placeholder="搜索技能"
                aria-label="市场搜索词"
                onChange={(event) => setCatalogQueryText(event.target.value)}
              />
              <button
                className="smp-button" data-variant="primary" type="button"
                disabled={catalogPending || catalogQueryText.trim() === ''}
                onClick={() => { void runCatalog({ op: 'catalog-search', catalog: catalogMarket, q: catalogQueryText }) }}
              >
                搜索
              </button>
              {catalogMarket !== 'clawhub' ? null : (
                <button
                  className="smp-button" data-variant="outline" type="button" disabled={catalogPending}
                  onClick={() => { void runCatalog({ op: 'catalog-list', limit: 10 }, '下载榜') }}
                >
                  下载榜
                </button>
              )}
            </div>
          </div>
          {catalogNote === '' ? null : (
            <div className="smp-groupSub" key="note">
              <span>{catalogNote}</span>
              {lastInstalledScope === null ? null : (
                <button
                  className="smp-button" data-variant="outline" type="button"
                  onClick={() => {
                    // 跳到技能页并把范围切到刚落点：否则装到工作区后回技能页（默认全局）会找不到。
                    setTab('skills')
                    setSkillView('skills')
                    setSkillScope(lastInstalledScope.scope === 'global' ? 'global' : lastInstalledScope.project)
                    setLastInstalledScope(null)
                  }}
                >在技能页查看</button>
              )}
            </div>
          )}
          {catalogItems.length === 0 ? null : (
            <ul className="smp-skillCategories" key="items">
              {catalogItems.map((item) => {
                const origin = item.catalog === 'clawhub'
                  ? `${item.owner ?? ''}/${item.slug ?? ''}`
                  : `${item.source ?? ''}/${item.skillId ?? ''}`
                const popularity = item.downloads !== undefined
                  ? `下载 ${item.downloads}`
                  : (item.installs !== undefined ? `安装 ${item.installs}` : '')
                return (
                  <li className="smp-repoSkill" key={`${item.catalog}:${origin}`}>
                    <span className="smp-repoSkillName">{item.name}</span>
                    <span className="smp-repoSkillDesc">
                      {item.summary ? `${origin} · ${item.summary}` : origin}
                    </span>
                    <span className="smp-skillCategoryCount">{popularity}</span>
                    <span className="smp-skillCategoryActions">
                      <button
                        className="smp-button" data-variant="primary" type="button"
                        disabled={catalogPending || !repoDestReady}
                        onClick={() => { void installMarketItem(item) }}
                      >
                        安装
                      </button>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
          {catalogCursor === '' ? null : (
            <div className="smp-skillCategoryRow" key="more">
              <span className="smp-skillCategoryActions">
                <button
                  className="smp-button" data-variant="outline" type="button" disabled={catalogPending}
                  onClick={() => { void runCatalog({ op: 'catalog-list', limit: 10, cursor: catalogCursor }) }}
                >
                  加载更多
                </button>
              </span>
            </div>
          )}
        </section>
      )

      /**
       * 插件自更新：只说结论。
       *
       * 单独成一个区块（原先挤在「在线市场」里），因为它是**插件本身**的状态，与「装什么技能」
       * 无关 —— 混在市场里读起来像是市场的一部分。真正升级走 DSH 的插件管理器（插件不替换自己的文件）。
       *
       * ## 现在有两种形态，由 `UPDATE_SOURCE_READY` 决定
       *
       * 已接入自有 GitHub 仓库时（当前形态）走下面第一份：按钮 + 结论 + 发布页链接；
       * 点击调用 `update-check`，答案来自 `src/update.js`（releases/latest，缺 release 时读
       * 默认分支的 package.json）。保留 `false` 分支作为换源/离线时的占位形态：
       * 只显示「当前版本 + 一行说明」，不渲染按钮、不发请求。
       */
      const pluginUpdateSection = UPDATE_SOURCE_READY ? (
        <section className="smp-group" key="plugin-update">
          <div className="smp-groupTitleRow" key="h">
            <span className="smp-groupTitle">插件更新</span>
          </div>
          <div className="smp-formRow" key="row">
            <span className="smp-formRowLabel">当前版本</span>
            <div className="smp-formRowBody">
              <span className="smp-skillCategoryCount">
                {pluginUpdate === null
                  ? PLUGIN_VERSION
                  : (pluginUpdate.updateAvailable
                    ? `有新版本 ${pluginUpdate.latest}（本机 ${pluginUpdate.current}）`
                    : `已是最新（${pluginUpdate.current}）`)}
              </span>
              {pluginUpdate !== null && typeof pluginUpdate.url === 'string' && pluginUpdate.url !== '' ? (
                <a className="smp-link" key="rel" href={pluginUpdate.url} target="_blank" rel="noreferrer">发布页</a>
              ) : null}
              <button
                className="smp-button" data-variant="outline" type="button" disabled={catalogPending}
                onClick={() => { void checkPluginUpdate() }}
              >
                检查插件更新
              </button>
            </div>
          </div>
          {pluginUpdateNote === '' ? null : (
            <p className="smp-error" key="note">{pluginUpdateNote}</p>
          )}
        </section>
      ) : (
        <section className="smp-group" key="plugin-update">
          <div className="smp-groupTitleRow" key="h">
            <span className="smp-groupTitle">插件更新</span>
          </div>
          <div className="smp-formRow" key="row">
            <span className="smp-formRowLabel">当前版本</span>
            <div className="smp-formRowBody">
              <span className="smp-skillCategoryCount">{PLUGIN_VERSION}</span>
            </div>
          </div>
          {/* 占位说明：这一行是**当前唯一**的更新状态文案，测试按它断言（test/client.pluginUpdate.test.mjs）。 */}
          <p className="smp-note" key="updateSourcePending">更新源未接入：插件发布到自有仓库后启用</p>
        </section>
      )


      /**
       * Skills 页的子页签。
       *
       * 用独立的 `smp-subTab` 类而不是复用 `smp-tab`：顶层那两个页签（MCP / Skills）有测试按
       * 数量钉着，混用会让「页面上到底有几个页签」说不清。
       *
       * 分组依据是**使用场景**，不是数据来源：
       *   · 技能    —— 看有什么、启停（日常最常来）
       *   · 文件列表 —— 逐个技能的编辑/删除（按磁盘条目）
       *   · 获取技能 —— 仓库、市场、导入、已安装（一次性动作）
       *   · 回收站  —— 找回误删
       */
      const skillViewTabs = [
        {
          id: 'skills',
          label: '技能',
          count: visibleGovernanceSources.reduce(
            (total, group) => total + (Array.isArray(group.skills) ? group.skills.length : 0), 0,
          ),
        },
        { id: 'fetch', label: '获取技能', count: null },
        { id: 'trash', label: '回收站', count: governanceTrash.length },
      ]

      const skillViewStrip = (
        <div className="smp-subTabs" key="subTabs">
          {skillViewTabs.map((item) => (
            <button
              key={item.id} type="button" className="smp-subTab"
              data-active={String(skillView === item.id)}
              onClick={() => setSkillView(item.id)}
            >
              {item.count === null ? item.label : `${item.label}（${item.count}）`}
            </button>
          ))}
        </div>
      )

      /**
       * 「获取技能」＝装东西的地方：仓库、导入、市场、插件更新。
       *
       * 这里原先还有一块「已安装（来自仓库）」。它和技能页是**同一个对象的两张清单**：
       * 更新 / 回滚 / 卸载在哪一块都不算错，但让用户自己去对号就是错。现在这些动作长在
       * 技能卡片自己的 `⋯` 上（见 `skillSources.jsx`），这个重复区块随之删掉。
       */
      const skillViewContent = skillView === 'fetch'
        ? [skillViewStrip, repoSection, importSection, marketSection, pluginUpdateSection]
        : skillView === 'trash'
          ? [skillViewStrip, trashSection]
          : [skillViewStrip, governanceSection]

      const skillsSections = skillViewContent.filter((section) => section !== null)

      return (
        <div className="smp-page">
          <style key="css">{CSS}</style>
          {head}
          {tabs}
          {/* One summary line per tab, in the same place: above the search box, describing
              the whole list. It replaced the per-section subtitles, which said the same
              numbers twice once the sections became one list. */}
          <div className="smp-groupSub smp-summaryAbove" key="summary">
            {tab === "mcp" ? mcpSummary : skillsSummary}
          </div>
          {filterRowView}
          {/* 工具勾选的保存闸门。
              勾选**不写** settings 文档（每写一次，设置壳层就重挂载一次 section，展开的
              卡片被收起）；攒到这里点一次保存，整份 `toolFilters` 一次提交，所以无论改
              了几台服务器都只有一次重载。 */}
          {tab === "mcp" && filterDirtyCount > 0 ? (
            <div className="smp-filterBar" key="filterbar">
              <span className="smp-filterBarText">
                {`工具勾选有 ${filterDirtyCount} 台服务器未保存`}
              </span>
              <button
                className="smp-button" type="button" data-variant="primary" disabled={busy}
                onClick={() => { void saveFilters() }}
              >
                保存修改
              </button>
              <button
                className="smp-button" type="button" disabled={busy}
                onClick={() => setFilterDraft({})}
              >
                撤销
              </button>
            </div>
          ) : null}
          {statusOf(form) === "loading" ? <p className="smp-empty" key="loading">正在读取设置…</p> : null}
          {error && !editing ? <p className="smp-error" key="err">{error}</p> : null}
          {/* A disk-skill delete fails with its dialog already closed, so its
              reason used to be written into state nobody rendered. */}
          {skillError !== "" && skillDialog === null ? <p className="smp-error" key="skillerr">{skillError}</p> : null}
          {confirmDeleteDialog}
          {skillPreviewDialogView}
          {skillDialogElement}
          {tab === "mcp" ? mcpSections : skillsSections}
          {debugOn ? (
            <section className="smp-group" key="debug">
              <div className="smp-groupTitleRow" key="h">
                <span className="smp-groupTitle">
                  {`Loader 诊断：共 ${inventoryRows.length} 行，其中 mcp 相关 ${debugMcp.length} 行`}
                </span>
              </div>
              <ul className="smp-cards" key="list">
                {debugMcp.map((row) => (
                  <li className="smp-card" key={row.entryId}>
                    <div className="smp-cardContent" key="c" style={{ cursor: "default" }}>
                      <div className="smp-cardMainRow" key="r">
                        <span className="smp-cardIdentity" key="i">{row.entryId}</span>
                        <span className="smp-cardEnd" key="e">
                          <span className="smp-tag" data-tone="neutral">
                            {`${row.enabled ? "on" : "off"}${row.fiberPhase ? ` · ${row.fiberPhase}` : ""}`}
                          </span>
                        </span>
                      </div>
                      <div className="smp-cardDescription" key="d">{row.moduleName}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )
    }

    return {
      inject: ['slots', 'configForms', 'remote', 'remote.pluginInventory'],
      apply(ctx) {
        /**
         * 一次页面加载 = 一份新的 UI 状态。
         *
         * `PANEL_UI` 是模块级的（它要跨 section 重挂载存活），所以这里把它拨回默认值：
         * 客户端半边每次激活都从「MCP 页签、无展开卡片」开始，而不是继承上一次进程内
         * 残留的状态。测试里每次 `bootPanel` 都会走一遍 apply，因此各用例之间也不会串味。
         */
        PANEL_UI.tab = 'mcp'
        PANEL_UI.expanded = []
        PANEL_UI.filterDraft = {}
        const form = ctx.configForms.get(NS)
        // Services reached through `remote` must be injected first; a bare access
        // throws in cordis and would fail the whole client half.
        let inventory
        try {
          inventory = ctx.remote?.pluginInventory
        } catch {
          inventory = undefined
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'skills-mcp',
          order: 20,
          label: () => 'Skills & MCP',
          inject: () => ({ form, inventory }),
        }, Panel))

        /**
         * 同一个面板也注册成**主面板页**，并在侧栏挂一个图标。
         *
         * `sidebar.panellist` 的 id 与 `main` 槽位的 key 对应（槽位说明原话：「Each list id
         * addresses the matching main panel」），所以这两处必须成对注册，缺一个按钮就点了没反应。
         *
         * 面板本身不依赖任何「设置」专属能力（不读 `close`），所以两处可以共用同一个组件 ——
         * 一份实现，两个入口。
         */
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: SIDEBAR_ID,
          order: 100,
          inject: () => ({ form, inventory }),
        }, MainPanelShell))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: SIDEBAR_ID,
          order: 100,
          label: () => 'Skills & MCP',
        }, SkillPanelIcon))
      },
    }
  },
})


