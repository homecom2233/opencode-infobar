# 发布与上架

给维护者看的操作手册。用户看 [README.md](README.md) 就行。

## 0. 先搞清楚「插件市场」是什么

opencode **没有**官方的插件商店。分发链路是这样的：

| 渠道 | 性质 | 怎么上 |
| --- | --- | --- |
| **npm** | 官方唯一真正的分发方式（`opencode plugin add <包名>`） | `npm publish` |
| [opencode.im](https://opencode.im) | 社区市场，有分类、排名、搜索 | 自动发现 + 人工审核，或手动投稿 |
| [官方 ecosystem 列表](https://opencode.ai/docs/ecosystem) | 文档里的一张表 | 给 `anomalyco/opencode` 提 PR |
| [awesome-opencode](https://github.com/awesome-opencode/awesome-opencode) | 社区 awesome 列表 | PR |
| [opencode.cafe](https://opencode.cafe) | 社区聚合站 | 按其说明提交 |

所以「打包发布到插件市场」= **先发 npm，再让它被这些索引收录**。

## 1. npm 发布（必做，其它渠道都依赖它）

### 前置

- npm 账号，开启 2FA（`npm publish` 会要一次性验证码）
- 包名 `opencode-infobar` **已确认可用**（`https://registry.npmjs.org/opencode-infobar` 返回 404）
- 本机 npm 能写缓存目录；本沙箱里 npm 默认缓存写不进去，用 `--cache` 指到工作区

### 发布

```bash
cd D:/DSHwork/opencode-infobar
npm login                     # 只需一次，凭据存在本机
node test/smoke.cjs           # prepublishOnly 也会跑，先本地过一遍
npm publish --cache ./npm-cache
```

发布成功后会出现在 `https://www.npmjs.com/package/opencode-infobar`。

### 发版

```bash
npm version patch   # 或 minor / major，会改 package.json 并打 tag
git push && git push --tags
npm publish --cache ./npm-cache
```

### 打包内容由 `files` 白名单决定

当前清单：`gui-experimental.cjs`、`README.md`、`README.en.md`、`LICENSE`、`assets`。
新增文件（比如以后加 `index.js`）必须同步加进 `files`，否则不会进 tarball。

发版前用这个确认清单：

```bash
npm pack --dry-run --cache ./npm-cache
```

`test/` 不进包（只是开发用）；`package.json` 的 `prepublishOnly` 会跑冒烟测试，测试挂了就发不出去。

## 2. opencode.im（社区市场）

两种收录方式：

1. **自动发现**：官方说明是「npm 包带 `opencode-plugin` keyword，且 README 里有 OpenCode 安装示例，每天扫描一次，候选人工审核后发布」。本仓库两个条件都满足（`package.json` 的 `keywords` 含 `opencode-plugin`，README 的「安装」章节有 `opencode plugin add opencode-infobar`）。
2. **手动投稿**：打开 https://opencode.im/submit ，填
   - Source：`npm Package`
   - npm 包名：`opencode-infobar`
   - npm 包页面 / 作者主页（可选）：仓库地址
   - 提交后等审核

分类建议：**UI & Themes**（备选 Observability & Cost）。

也可以走 GitHub-only 投稿（填仓库地址），但既然要发 npm，用 npm 那条更稳。

## 3. 官方 ecosystem 列表（PR）

文档页 https://opencode.ai/docs/ecosystem 的表是手写的，改这个文件：

```
services/site/src/docs/content/ecosystem.mdx
```

在 `## Plugins` 表格里加一行（保持字母序不强制）：

```markdown
| [opencode-infobar](https://github.com/homecom2233/opencode-infobar) | 底部状态栏：缓存命中率、输出速度、上下文比例环 |
```

提 PR 到 `anomalyco/opencode` 的 `dev` 分支。

## 4. 其它列出渠道

- **awesome-opencode**：`awesome-opencode/awesome-opencode` 提 PR，加到 Plugins 小节
- **opencode.cafe**：按其站点说明提交

这些不影响可用性，只影响曝光。

## 5. 本仓库的工作流（重要）

| 目录 | 角色 |
| --- | --- |
| `D:\DSHwork\opencode-infobar` | **工作目录**，也是桌面版插件实际加载的位置（`opencode.json` 指向这里） |
| `D:\AKU\GitHub\opencode-infobar` | **推送目录**，GitHub Desktop 的克隆，只用来 commit + push |

改动只发生在工作目录，然后同步到推送目录：

```powershell
$src = 'D:\DSHwork\opencode-infobar'
$dst = 'D:\AKU\GitHub\opencode-infobar'
Copy-Item "$src\gui-experimental.cjs","$src\package.json","$src\README.md","$src\README.en.md","$src\LICENSE","$src\.gitignore","$src\.gitattributes" -Destination $dst -Force
Copy-Item "$src\test","$src\assets" -Destination $dst -Recurse -Force
git -C $dst add -A
git -C $dst commit -m "…"
git -C $dst push origin main
```

不要在推送目录里手改文件——下次同步会被覆盖。

## 6. 发版检查清单

- [ ] `node test/smoke.cjs` 全绿
- [ ] `npm pack --dry-run` 清单正确（含 `gui-experimental.cjs`）
- [ ] `package.json` 版本号已按语义化版本更新
- [ ] `CHANGELOG.md` 补了本次变更
- [ ] README 的安装示例与实际包名一致（`opencode plugin add opencode-infobar`）
- [ ] 工作目录 → 推送目录已同步，`git status` 干净
- [ ] `npm publish` 成功，npm 页面能打开、截图能看到
- [ ] opencode.im 搜索 `opencode-infobar` 能查到（自动发现可能要等一天）
- [ ] 在干净机器（或清掉 `~/.cache/opencode/packages/…`）上验证安装后状态栏出现
