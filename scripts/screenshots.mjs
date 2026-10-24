/**
 * Regenerate the README screenshots (`docs/images/*.png`).
 *
 * These are not photos of a live app: the script renders the *real* built client
 * bundle in an offline page — the same stub ModuleLoader trick the client tests use —
 * with sample data, then screenshots it in headless Chrome. That keeps the images
 * reproducible and free of anything private (real server URLs, paths).
 *
 * Required inputs (the script skips with a clear reason when one is missing):
 *   · lib/client.js        — run `npm run build:client` first
 *   · headless Chrome      — SMP_CHROME (Windows: C:\Program Files\Google\Chrome\Application\chrome.exe)
 *   · React UMD            — SMP_PREVIEW_DIR with react.js / react-dom.js (React 18 UMD)
 *   · DSH theme tokens     — SMP_THEME_CSS, a file of `--dsw-*: value;` lines
 *
 *   node scripts/screenshots.mjs
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, 'docs', 'images')

const BUNDLE = join(root, 'lib', 'client.js')
const CHROME = process.env.SMP_CHROME
  ?? (process.platform === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
const previewDir = process.env.SMP_PREVIEW_DIR ?? '/tmp/preview'
const themeCss = process.env.SMP_THEME_CSS

const missing = [
  [existsSync(BUNDLE), `缺少 ${BUNDLE}（先跑 npm run build:client）`],
  [existsSync(CHROME), `缺少 headless Chrome：${CHROME}（用 SMP_CHROME 指定路径）`],
  [existsSync(join(previewDir, 'react.js')), `缺少 ${previewDir}/react.js（React UMD）`],
  [existsSync(join(previewDir, 'react-dom.js')), `缺少 ${previewDir}/react-dom.js`],
  [typeof themeCss === 'string' && themeCss !== '' && existsSync(themeCss), '缺少主题 token：用 SMP_THEME_CSS 指向一个 `--dsw-*: value;` 的 CSS 文件'],
].filter(([ok]) => !ok).map(([, why]) => why)

if (missing.length > 0) {
  console.log('  · 跳过截图生成：')
  for (const why of missing) console.log(`      - ${why}`)
  process.exit(0)
}

/* ---------------------------------------------------------------- 样本数据 */
// 全是编造的公开数据：真实截图会把用户自己的服务器地址与路径带进 README。
const PROJECT = '/Users/me/projects/acme-web'

/** One MCP row, same shape the panel gets from `/[NS]/runtime`. */
const row = (entryId, serverName, extra = {}) => ({
  entryId,
  id: entryId,
  serverName,
  scope: 'global',
  transport: 'streamable-http',
  target: `https://${serverName}.example/mcp`,
  url: `https://${serverName}.example/mcp`,
  command: '',
  args: [],
  env: {},
  headers: {},
  headersText: '',
  failOnStartupError: false,
  reconnectInitialDelayMs: '',
  reconnectMaxDelayMs: '',
  reconnectMaxAttempts: '',
  toolCallTimeoutMs: '',
  enabled: true,
  phase: 'active',
  ...extra,
})

const toolsOf = (server, pairs) =>
  pairs.map(([name, description]) => ({ name: `mcp__${server}__${name}`, description }))

const SERVERS = [
  row('include:mcp-context7', 'context7'),
  row('include:mcp-deepwiki', 'deepwiki'),
  row('include:mcp-github', 'github', {
    transport: 'stdio',
    target: 'npx -y @modelcontextprotocol/server-github',
    url: '',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
  }),
  row('include:mcp-filesystem', 'filesystem', {
    transport: 'stdio',
    target: 'npx -y @modelcontextprotocol/server-filesystem ~/Documents',
    url: '',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '~/Documents'],
    enabled: false,
  }),
  // 项目级：scope 是工作区根，只有该项目的会话才挂载
  row('project:postgres', 'postgres', {
    scope: PROJECT,
    target: 'http://127.0.0.1:8787/mcp',
    url: 'http://127.0.0.1:8787/mcp',
    phase: '',
    loaderManaged: false,
  }),
]

const SERVER_TOOLS = [
  {
    serverName: 'context7',
    tools: toolsOf('context7', [
      ['resolve-library-id', 'Resolves a package name to a Context7-compatible library ID'],
      ['query-docs', 'Retrieves and queries up-to-date documentation and code examples'],
    ]),
  },
  {
    serverName: 'deepwiki',
    tools: toolsOf('deepwiki', [
      ['read_wiki_structure', 'Get a list of documentation topics for a repository'],
      ['read_wiki_contents', 'View full documentation about a GitHub repository'],
      ['ask_wiki_question', 'Ask any question about a repository and get an AI-powered answer'],
    ]),
  },
  {
    serverName: 'github',
    tools: toolsOf('github', [
      ['get_issue', 'Get details of a specific issue in a GitHub repository'],
      ['list_issues', 'List issues in a GitHub repository with optional filters'],
      ['search_issues', 'Search for issues across GitHub repositories'],
      ['create_issue', 'Create a new issue in a GitHub repository'],
      ['get_file_contents', 'Get the contents of a file or directory from a repository'],
      ['create_pull_request', 'Create a new pull request in a GitHub repository'],
      ['merge_pull_request', 'Merge a pull request in a GitHub repository'],
      ['delete_file', 'Delete a file from a GitHub repository'],
    ]),
  },
  { serverName: 'filesystem', tools: [] },
  { serverName: 'postgres', tools: [] },
]

const SERVER_STATUS = [
  { serverName: 'context7', tier: 'global', scope: '', status: 'connected', toolCount: 2 },
  { serverName: 'deepwiki', tier: 'global', scope: '', status: 'connected', toolCount: 3 },
  { serverName: 'github', tier: 'global', scope: '', status: 'connected', toolCount: 8 },
  { serverName: 'filesystem', tier: 'global', scope: '', status: 'disabled', toolCount: 0 },
  { serverName: 'postgres', tier: 'project', scope: PROJECT, status: 'unmounted', toolCount: 0 },
]

/** One governance skill row (same projection `src/skills/governance.js` produces). */
const skill = (name, description, source, scope, extra = {}) => ({
  name,
  description,
  path: `${scope === 'global' ? '/Users/me' : scope}/${source === 'claude' ? '.claude' : source.endsWith('agents') ? '.agents' : '.dsh'}/skills/${name}/SKILL.md`,
  source,
  scope,
  rank: 400,
  readonly: source === 'claude',
  category: '',
  ownEnabled: true,
  enabled: true,
  ...extra,
})

const group = (key, label, scope, skills, extra = {}) => ({
  key,
  label,
  path: `${scope === 'global' ? '/Users/me' : scope}/${key === 'claude' ? '.claude' : key.endsWith('agents') ? '.agents' : '.dsh'}/skills`,
  scope,
  rank: 400,
  native: key !== 'claude',
  readonly: key === 'claude',
  exists: true,
  enabled: true,
  policyKey: key,
  count: skills.length,
  skills,
  ...extra,
})

const GOVERNANCE = {
  sources: [
    group('user-dsh', '用户 · DSH', 'global', [
      skill('code-review', '按团队的检查清单过一遍改动，先看风险再给建议', 'user-dsh', 'global'),
      skill('release-notes', '把本轮的改动整理成一份发版说明', 'user-dsh', 'global'),
      skill('db-migrate', '生成并校验数据库迁移脚本', 'user-dsh', 'global'),
    ]),
    group('user-agents', '用户 · Shared Agent', 'global', [
      skill('api-mock', '为前端起一个本地 mock 服务', 'user-agents', 'global'),
      skill('changelog', '按约定式提交生成 CHANGELOG', 'user-agents', 'global'),
    ]),
    group('claude', 'Claude Code', 'global', [
      skill('review', 'Review a pull request and report findings', 'claude', 'global'),
    ]),
    group('project-dsh', '项目 · DSH', PROJECT, [
      skill('project-conventions', '本仓库的编码与提交约定', 'project-dsh', PROJECT),
      skill('smoke-runner', '跑一遍本仓库的冒烟检查', 'project-dsh', PROJECT),
    ]),
    // 目录不存在 / 空目录不该出现在页面上（真实快照里它们也在，由面板过滤）
    group('codex', 'Codex', 'global', [], { exists: false, readonly: true }),
  ],
  categories: [],
  trash: [{ id: 'trash-1', name: 'old-skill', source: 'user-dsh', deletedAt: '2026-10-03T10:12:00.000Z', exists: true }],
  repositories: [],
  installs: [],
  providerInstalled: true,
  scanError: '',
  statePath: '/Users/me/.dsh/dsh-skills-mcp-manager/state.json',
}

const ALL_SKILLS = GOVERNANCE.sources.flatMap((entry) => entry.skills)

/** The settings document (`form.snapshot.value`) — only plugin-owned fields live here. */
const DOCUMENT = {
  toolFilters: { github: { mode: 'allow', tools: ['get_issue', 'list_issues', 'search_issues'] } },
  oauthServers: {
    context7: { present: false, refreshable: false, waiting: false, authorizeUrl: '', expiresAt: '', expired: false, at: '' },
  },
  oauthState: { ready: true, reason: '', detail: '', sdkVersion: '2.2.0', redirectUri: 'http://127.0.0.1:8765/callback' },
}

/** The `/[NS]/runtime` payload. */
const RUNTIME = {
  servers: SERVERS,
  serverTools: SERVER_TOOLS,
  serverStatus: SERVER_STATUS,
  serverToolsError: { reason: '', detail: '' },
  skills: ALL_SKILLS,
  skillGovernance: GOVERNANCE,
  skillDirs: { userDsh: '/Users/me/.dsh/skills', userAgents: '/Users/me/.agents/skills' },
  workspaces: [{ path: PROJECT, title: 'acme-web', agentsSkillsDir: `${PROJECT}/.agents/skills` }],
  currentWorkspace: PROJECT,
  filter: { installed: true, reason: '', dropped: [], preExisting: [] },
  probe: { installed: true, reason: '', results: [] },
  oauth: {
    ready: true, reason: '', detail: '', sdkVersion: '2.2.0', redirectUri: 'http://127.0.0.1:8765/callback',
    servers: DOCUMENT.oauthServers,
  },
  discovery: { at: '2026-10-03T11:00:00.000Z', roots: [PROJECT], count: ALL_SKILLS.length, error: '' },
}

/* --------------------------------------------------------------- 离线预览页 */
const tokens = readFileSync(themeCss, 'utf8')
  .split('\n')
  .map((line) => /^(--dsw-[a-z0-9-]+):\s*(.+?);?$/.exec(line.trim()))
  .filter(Boolean)
  .map((match) => `  ${match[1]}: ${match[2]};`)
  .join('\n')

const SHELL = "body{margin:0;background:var(--dsw-alias-bg-base);font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',system-ui,sans-serif;color:var(--dsw-alias-label-primary)}"
  + ".shell{display:flex;min-height:100vh}.shellNav{width:240px;flex:none;padding:24px 16px;border-right:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:14px}"
  + ".shellNav div{padding:10px 12px;border-radius:var(--dsw-radius-lg)}.shellNav div[data-active=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}"
  + ".content{flex:1;min-width:0;display:flex;flex-direction:column}"

const NAV = ['账号与余额', '通用设置', '模型', '内置插件']
  .map((label) => `<div>${label}</div>`).join('')
  + '<div data-active="true">Skills &amp; MCP</div>'
  + ['Agent 预设', '插件市场'].map((label) => `<div>${label}</div>`).join('')

const page = (client, state) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>panel preview</title>
<style>:root{\n${tokens}\n}\n${SHELL}</style></head><body>
<div class="shell"><nav class="shellNav">${NAV}</nav>
<main class="content"><div id="root"></div></main></div>
<script src="./react.js"></script><script src="./react-dom.js"></script>
<script>
window.__DOC__ = ${JSON.stringify(DOCUMENT)};
window.__RUNTIME__ = ${JSON.stringify(RUNTIME)};
// 面板会去 /[NS]/runtime 拉运行时数据；离线页把这份 sample 当成 Host 的回答。
window.fetch = function (url) {
  var target = String(url);
  var ok = function (body) {
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  };
  if (target.indexOf('/runtime') >= 0) return ok(window.__RUNTIME__);
  if (target.indexOf('/skills-catalog') >= 0) return ok({ ok: true, reason: '', items: [] });
  if (target.indexOf('/skills-governance') >= 0) return ok({ ok: true, reason: '' });
  return ok({ ok: true, reason: '' });
};
var captured = null;
window.__ModuleLoader__ = { load: function (spec) {
  var mod = spec.factory(function (name) {
    if (name === 'react') return window.React;
    throw new Error('preview: unknown module ' + name);
  });
  var form = { snapshot: { value: window.__DOC__, status: 'ready', revision: 1 },
               set: function (field, value) { window.__DOC__[field] = value; return Promise.resolve(true); } };
  mod.apply({ slots: { inject: function (s, fn) { fn(); },
                       register: function (entry, Component) {
                         // 面板会往 slots 里注册三次（设置 section / 主面板 / 侧栏按钮），
                         // 这里只截设置里的那一份；侧栏那份没有 inject()，拍到它渲染就是空白。
                         if (entry && entry.name === 'settings.section') captured = { entry: entry, Component: Component };
                         return function () {};
                       } },
              configForms: { get: function () { return form; } } });
} };
</script>
<script>
${client}
</script>
<script>
(function () {
  if (captured === null) throw new Error('preview: 面板没有注册 settings.section');
  var props = typeof captured.entry.inject === 'function' ? captured.entry.inject() : {};
  ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(captured.Component, props));
  setTimeout(function () {
    var switched = false;
    // 数据是异步拉的（面板要等 fetch 回来才渲染），所以这里轮询着做页内状态：
    // 切页签、展开来源分组 / MCP 卡片。一到两次 setTimeout 抢在首帧之前，会是空白。
    var rounds = 0;
    var timer = setInterval(function () {
      rounds += 1;
      if ('${state}' === 'skills') {
        var tabs = document.querySelectorAll('.smp-tab');
        if (!switched) {
          for (var i = 0; i < tabs.length; i++) {
            if (tabs[i].textContent.indexOf('Skills') === 0) { tabs[i].click(); switched = true; }
          }
        }
        var toggles = document.querySelectorAll('.smp-skillSourceToggle[aria-expanded="false"]');
        for (var k = 0; k < toggles.length; k++) toggles[k].click();
      }
      // 工具过滤在展开卡片里，所以这一态要先把 github 那张卡展开（第 3 个 MCP 行）。
      if ('${state}' === 'tools') {
        var cards = document.querySelectorAll('.smp-cardToggle[aria-expanded="false"]');
        if (cards[2]) cards[2].click();
      }
      if (rounds >= 12) clearInterval(timer);
    }, 120);
  }, 60);
})();
</script></body></html>`

/* ------------------------------------------------------------------ 截图 */
const STATES = [
  { file: 'mcp-panel.png', state: 'mcp', width: 1440, height: 1000 },
  { file: 'tools-filter.png', state: 'tools', width: 1440, height: 1320 },
  { file: 'skills-panel.png', state: 'skills', width: 1440, height: 1120 },
]

const workDir = join(previewDir, 'smp-screenshots')
mkdirSync(workDir, { recursive: true })
mkdirSync(outDir, { recursive: true })
copyFileSync(join(previewDir, 'react.js'), join(workDir, 'react.js'))
copyFileSync(join(previewDir, 'react-dom.js'), join(workDir, 'react-dom.js'))

const client = readFileSync(BUNDLE, 'utf8')

/** Chrome writes the PNG and then sits there, so wait for the file, not the exit. */
function shoot(pagePath, outPath, width, height) {
  return new Promise((resolveShot, reject) => {
    rmSync(outPath, { force: true })
    const child = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(workDir, 'profile')}`,
      `--window-size=${width},${height}`,
      '--force-device-scale-factor=2',
      '--virtual-time-budget=4000',
      `--screenshot=${outPath}`,
      pathToFileURL(pagePath).href,
    ], { stdio: 'ignore' })
    const started = Date.now()
    let lastSize = -1
    const timer = setInterval(() => {
      const size = existsSync(outPath) ? statSync(outPath).size : -1
      // Stable size across two polls: Chrome finished writing it.
      if (size > 0 && size === lastSize) {
        clearInterval(timer)
        child.kill('SIGKILL')
        resolveShot(size)
        return
      }
      lastSize = size
      if (Date.now() - started > 60_000) {
        clearInterval(timer)
        child.kill('SIGKILL')
        reject(new Error('截图超时：' + outPath))
      }
    }, 250)
  })
}

for (const { file, state, width, height } of STATES) {
  const pagePath = join(workDir, `p-${state}.html`)
  const outPath = join(outDir, file)
  writeFileSync(pagePath, page(client, state))
  const bytes = await shoot(pagePath, outPath, width, height)
  console.log(`  ✓ docs/images/${file}（${width}x${height} @2x，${Math.round(bytes / 1024)}KB）`)
}
console.log('  · 预览页留在', workDir, '（可打开核对，或删掉重新生成）')
