# 发包与上架（维护者）

从「改完代码」到「别人能装 + 插件自己检查更新」的完整流程。
面向的是**维护者**；普通用户只需要看 [README 的安装一节](../README.md#安装)。

- 包名：`dsh-skills-mcp-manager`（**无 scope**，0.6.0 起自有身份）
- 仓库：<https://github.com/zx2021210538/dsh-skills-mcp-manager>
- **发布源 = GitHub Releases**：插件「设置 → Skills & MCP → 获取技能 → 插件更新」读
  `releases/latest` 的 tag（没有 release 时退回 `main` 分支的 `package.json`，见
  [`src/update.js`](../src/update.js)）。发布一个 Release = 用户能检查到新版本、也能下载到
  可安装的 `.tgz`。
- npm 是**可选通道**：仓库配置了 `NPM_TOKEN` 时 `publish.yml` 会顺手发一份到 registry；
  没配置就跳过，不算失败。市场收录也以 GitHub 仓库为准。

> 改包名时必须同步改五处：`package.json#name`、`lib/src/client.js` 的
> `__ModuleLoader__.load({ id })`、`cordis.patch.yml` 的 bundle `name`、
> `src/update.js` 的 `PACKAGE_NAME`、脚本/文档里的路径。
> `test/pluginIdentity.test.mjs` 会把它们钉在一起，漏一处就红。
> 行 id、settings 命名空间和运行时接口前缀是**另外两个概念**（`dsh-skills-mcp-manager`），
> 改包名不必改它们。

`package.json` 里与发布相关的字段（当前形态）：

```jsonc
{
  "name": "dsh-skills-mcp-manager",
  "version": "0.6.0",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/zx2021210538/dsh-skills-mcp-manager.git" },
  "homepage": "https://github.com/zx2021210538/dsh-skills-mcp-manager#readme",
  "bugs": { "url": "https://github.com/zx2021210538/dsh-skills-mcp-manager/issues" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web", "immediately": true, "inject": ["…"] } },
  "engines": { "node": ">=20", "dsh": ">=0.2.0-0" },
  "files": ["dist", "lib/client.js", "cordis.patch.yml", "icon.svg", "locale", "README.md", "FORK.md", "CHANGELOG.md", "LICENSE"],
  "publishConfig": { "access": "public" }
}
```

> `dist/` 与 `lib/client.js` 在 `.gitignore` 里（不提交构建产物），但 `files` 白名单优先级更高，
> 它们**会被打进 tarball**。每次靠 `npm pack --dry-run` 确认一遍。

---

## 1. 发版检查（本地）

```bash
npm ci
npm run build           # dist/（Host，tsc）+ lib/client.js（Client，esbuild）
npm test                # 全量单测
npm run gate            # check:names → build:client → npm test → smoke → 预览基线
npm pack --dry-run      # 只看清单：应有 dist/**、lib/client.js、cordis.patch.yml、icon.svg、README/LICENSE/CHANGELOG
```

`npm pack --dry-run` 是发版前最后一道自检：

- 出现 `lib/src/**` 或 `test/**` → `files` 写错了；
- 缺少 `dist/index.js` → 忘了 build（`prepare` 也会补，但别指望它兜住所有情况）；
- tarball 名字应是 `dsh-skills-mcp-manager-<版本>.tgz`（无 scope 包没有账号前缀）。

## 2. 发布 GitHub Release（主通道）

分支约定：`main` 是发布线，`dev-*` 是开发线。**发布只认 release tag**，`publish.yml`
没有 push/branch 触发条件，所以开发分支不可能误发。

### 2.1 每个版本的步骤

```bash
# 1) 改版本 + CHANGELOG（版本号必须与将要打的 tag 一致，去掉 v 前缀）
npm version minor --no-git-tag-version

# 2) 提交并推到发布线
git add -A && git commit -m "release: v0.6.0"
git push origin main

# 3) 打 tag 并推送
git tag v0.6.0
git push origin v0.6.0
```

然后在 GitHub 上 **Releases → Draft a new release**，选 `v0.6.0`，发布（Publish release）。
`publish.yml` 会自动：

1. 校验 `v<package.json version>` == release tag（不一致直接失败，绝不发出号不对的包）；
2. `npm ci` → `npm run build` → `npm run gate`（CI 上没有本机 DSH / 预览夹具的两项会显式跳过）；
3. `npm pack` 生成 `dsh-skills-mcp-manager-<版本>.tgz`；
4. 把这个 tarball **上传到同一个 Release**（`gh release upload`）。

> 如果 Actions 不可用或失败，可手动上传：`npm pack` 后在 Release 页面把 `.tgz` 拖进去即可。
> 只想演练不发布：Actions → **publish** → *Run workflow* → 勾 `dry_run`，只 build + pack，不碰 Release。

### 2.2 发布后的验证

```bash
# 更新检查读的就是它（tag 去掉 v 后的版本号）
curl -s https://api.github.com/repos/zx2021210538/dsh-skills-mcp-manager/releases/latest | grep tag_name

# 插件里：设置 → Skills & MCP → 获取技能 → 插件更新 → 检查插件更新
# 应显示「已是最新（<版本>）」和「发布页」链接；把本机版本临时改小可验证「有新版本」分支。
```

### 2.3 可选：同时发到 npm

仓库 Secrets 里配了 `NPM_TOKEN` 时，`publish.yml` 会额外执行 `npm publish --provenance`；
没配就跳过。首次发 npm 前需要：

```bash
npm login
npm publish              # 第一个版本必须手动发（可信发布只能给已存在的包配置）
npm view dsh-skills-mcp-manager version
```

之后可在 npmjs.com 给这个包配置 GitHub Actions Trusted Publisher（workflow `publish.yml`），
把 `NPM_TOKEN` 删掉也能发。`publishConfig.access=public` 已写在 `package.json` 里。

## 3. 本地 tarball（离线 / 开发）

```bash
npm pack                                   # 生成 dsh-skills-mcp-manager-<版本>.tgz
dsh plugin --profile <profile> add ./dsh-skills-mcp-manager-<版本>.tgz
```

`npm pack` 会跑 `prepare`（= `npm run build`），所以 tarball 里一定是当次构建的 `dist/` 与
`lib/client.js`。升级就是把新 tarball 再 `add` 一次；回退就是把旧 tarball 再 `add` 回去。
GitHub Release 里的 tgz 就是这个文件，二者等价。

## 4. 上架 DSH 插件市场

市场里的插件列表来自精选目录 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（站点与 dshmarket 都从它生成的 `plugins.json` 取数）。
**不要往 dshmarket 仓库提条目**——那里只是市场应用本身。

### 4.1 新增一个文件

fork `awesome-dsh-plugin/awesome-dsh-plugin`，新建 **一个** 文件：

```
data/plugins/<owner>__dsh-skills-mcp-manager.yml
```

文件名规则是 `<owner>__<repo>.yml`。内容用本仓库的 [`docs/market-entry.yml`](market-entry.yml)
模板（`<owner>` 已按本仓库填成 `zx2021210538`，核对即可）：

```yaml
url: 'https://github.com/zx2021210538/dsh-skills-mcp-manager'
name: 'zx2021210538/dsh-skills-mcp-manager'
category: ui
description:
  en: '…英文一行…'
  zh: '…中文一行…'
```

校验器只认这几个键（多写会被拒）：`url`（必填，必须与仓库地址完全一致）、`name`（必填）、
`category`（必填，从既定分类里选）、`description`（必填 `en`，`zh` 可选；单行，含 `: ` 时要加引号）、
`tarball`（可选，只有仓库无法从源码安装时才需要）。
**没有 `npm:` 字段**——npm 与仓库的对应关系由 CI 从 npm 的 `repository` 自动探测，
所以 `package.json` 的 `repository` 必须保持指向本仓库。

### 4.2 提 PR

- 一个 PR **最多 3 条**；只加自己这一条，别顺手改别人的；
- 不需要特定的 PR 标题格式；反馈会以 PR 评论的形式指名要改什么；
- CI 依次跑：条目数 → 从仓库 `package.json` 取 `dsh.bundle`（拿不到就拒）→ **仓库年龄 ≥ 1 天** →
  `awesome-lint` + 站点构建；
- 维护者还会**读源码逐条核对描述**，所以描述别写没有的功能。

### 4.3 截图

截图不写在目录条目里，而是放在**仓库根目录**的 `screenshots.json`（本仓库已加）：

```json
["docs/images/mcp-panel.png", "docs/images/skills-panel.png"]
```

1–8 张，相对路径（不能以 `/` 开头、不能有 `..`），或 GitHub 图床上的 https 绝对地址。
图片本身由 `node scripts/screenshots.mjs` 生成到 `docs/images/`（需要 headless Chrome + 预览夹具）。

### 4.4 生效时间

合并后站点与市场**通常一天内**自动收录；dshmarket 每次打开都会实时拉 `plugins.json`，不使用过期缓存。
之后发新版只要保证 `version` 提升 + `repository` 不变，市场会自动显示新版本号与下载量。

## 5. 本机（开发）安装

```bash
npm run deploy     # 先跑 smoke，通过后拷进 $DSH_HOME/profiles/desktop/node_modules/dsh-skills-mcp-manager
```

再把包名挂进 profile 的 bundles（`$DSH_HOME/profiles/desktop/package.json` → `dsh.profile.bundles`）：

```jsonc
"dsh-skills-mcp-manager"
```

**重启 DSH** 让 Host 半生效；之后只改客户端的话，`npm run deploy` + 刷新页面即可。
回滚：profile 的 `node_modules/dsh-skills-mcp-manager.backup-<时间戳>` 改回原名。

## 6. 每次发版的清单

- [ ] `package.json` 的 `version` 已提升，`CHANGELOG.md` 已写
- [ ] `npm run gate` 本地全绿；`npm pack --dry-run` 清单正确（有 `dist/`、`lib/client.js`，没有 `lib/src/`、`test/`）
- [ ] 提交推到 `main`，打 tag（`v<版本>`，与 `package.json` 一致）并推送
- [ ] 在 GitHub 上按该 tag 发 Release → Actions 的 publish 工作流自动打包并上传 tgz
- [ ] 工作流跑完后核对：Release 里有 `dsh-skills-mcp-manager-<版本>.tgz`；`releases/latest` 的 tag 正确
- [ ] 插件里点「检查插件更新」显示「已是最新（<版本>）」、发布页链接可打开
- [ ] 市场已收录时：确认卡片显示新版本（收录前先按第 4 节提 PR）
