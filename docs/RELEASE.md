# 发版手册

后续发版**只按本文**执行。历史筹备清单见 [PUBLISH-PLAN.md](PUBLISH-PLAN.md)（已过期，不要当步骤跑）。

当前线上：`@huiliyi37/dsh-tianshu-tui@0.1.2-rc.29`（npm `latest`）。发版后更新此行。

## 仓库坐标

| 角色 | 地址 | remote 名 |
|---|---|---|
| **主仓**（Issue、tag、GitHub Release、npm `repository`） | https://github.com/huiliyi37/dsh-tianshu-tui | `github` |
| **组织 fork**（omdsh-dev 目录入口，与主仓同步） | https://github.com/omdsh-dev/dsh-tianshu-tui | `omdsh` |
| 本地备份 bundle | `/tmp/dsh-backup/dsh-tui-baseline.bundle` | `origin` |

- 发版推送：`github` **和** `omdsh`（先主仓，再 fork）。
- **禁止** `git push origin`。`origin` 不是 GitHub。
- 代理：`HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890`（`gh` / `git push` / `npm`）。
- 命令前缀：`rtk`（本机约定）。

## 硬约束（不要改）

- 插件 id 固定 `tui-runner`。
- 包名固定 `@huiliyi37/dsh-tianshu-tui`（不要改成 `@deepseek-ai/*` 或 `@dsh-external/*`）。
- 只 bump 根 `package.json` 的 `"version"`。不要顺手 bump `peerDependencies` 里的官方 `@deepseek-ai/*`（那是宿主 CLI 线，现为 `^0.1.0-rc.6`）。
- 不要 bump `vision-ask/`，除非这次明确发那个包。
- README 里写的官方 CLI `0.1.0-rc.6` 是宿主版本，不是本包版本。
- `lib/index.js` / `lib/invariant.js` **必须跟仓**（github / npm 安装吃 bundle，不在宿主里再打包）。改了 `src/` 就要同步 bundle。
- 不要提交 `.npmrc` / token。
- 不要 force-push `main`。
- 不要把 `tianshu-public` 整仓推进本插件仓。

## 自更新与 dist-tag

启动时对照 npm **`latest`**（见 `src/self-update.ts`）。  
预发布号（如 `0.1.2-rc.1`）若不用 `--tag latest`，会落到 `rc` 标签，**已装用户拉不到**。

发版一律：

```sh
npm publish --access public --tag latest
```

`github:` / `link:` 安装不会改写成 npm 包。不想联网检查：`DSH_TUI_SKIP_UPDATE=1`。

## 发版步骤

在本仓根目录、干净工作树（或只含本次发版改动）上做。

### 1. 定版本

改且只改根 `package.json` 的 `"version"`。建议沿 `0.1.x-rc.n` 或用户指定的 semver。

### 2. 跟仓 bundle

若改了 `src/`：重建或手工同步 `lib/index.js`（与现有跟仓方式一致），确认自更新逻辑仍打进 bundle。

### 3. 文档

- 把上一版的 Unreleased 条目从 `CHANGELOG.md` 顶部改成 `## [<version>] - <date>`（Keep a Changelog 风格；`/changelog` 命令读的就是这份文件，必须随版本更新）。
- 中英文 README「更新说明」只写当前版本要点与升级方式，完整历史在 `CHANGELOG.md`（不再往 README 堆版本历史）。
- 改完 README 后更新 `README.i18n.yaml` 配对哈希（架构守护校验的是裸内容
  sha1，不是 git blob 哈希）：

```sh
shasum -a 1 README.md README.en.md
```

### 4. 测试门

至少：

```sh
rtk pnpm exec vitest run tests/self-update.spec.ts tests/bundle-contract.spec.ts
```

改了 UI / 审批 / 会话再跑对应 spec。本仓独立 `pnpm vitest` 可能缺 peer `@deepseek-ai/dsh-session`；完整套件在能解析官方 peer 的工作区跑。

### 5. 提交

Conventional Commits，说明**为什么**发这一版。不要把 `.npmrc` 加进去。

### 6. 打 tag、建 GitHub Release、双推

README「更新说明」的 GitHub Release 链接指向 `releases/tag/v<version>`——不发 Release 链接就是死的：

```sh
git tag -a v<version> -m "<version>"
git push github v<version>
gh release create v<version> --repo huiliyi37/dsh-tianshu-tui --latest \
  --title "<version>" --notes-file <(sed -n "/^## \[<version>\]/,/^## /p" CHANGELOG.md | head -n -1)
git push omdsh v<version>
```

rc.21–rc.23 曾因只发 npm 未建 Release 导致 README/CHANGELOG 链接悬空，2026-08-27 已批量补建。

### 6. 打标签

```sh
rtk git tag -a v<version> -m "v<version>"
```

### 7. 推主仓

```sh
HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 rtk git push github HEAD
HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 rtk git push github v<version>
```

若 `github/main` 有别人的提交：先 `fetch` + rebase，**不要** `--force`。

### 8. 同步组织 fork

```sh
HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 rtk git push omdsh HEAD
HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 rtk git push omdsh v<version>
```

Issue / Release 仍开在主仓。fork 只镜像代码和 tag。

### 9. npm 发布

项目 `.npmrc` 是 `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`。环境变量空时会 401。从用户 `~/.npmrc` 注入，**不要打印 token**：

```sh
export NPM_TOKEN="$(python3 -c "
from pathlib import Path
for line in Path.home().joinpath('.npmrc').read_text().splitlines():
    s=line.strip()
    if s.startswith('//registry.npmjs.org/:_authToken='):
        print(s.split('=',1)[1].strip(), end='')
        break
")"
HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 npm whoami
HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 npm publish --access public --tag latest
```

身份应为 `huiliyi37`。`whoami` 失败就停，不要硬发。

rc.13 实测两坑（2026-08-22）：

- **预发布必须显式 tag**：新版 npm 对 `-rc.n` 这类 prerelease 拒绝无 tag 发布
  （报「You must specify a tag using --tag」）。按上方命令带 `--tag latest`
  即可，同时满足检查清单的「npm `latest` = 新版本」。
- **`~/.npm` 属主为 root 会卡死所有 npm 命令**：症状是 `whoami` / `publish` /
  `view` 全部 EPERM，且真实报错被「日志写不进 `~/.npm/_logs`」吞掉，看似与
  认证无关。会话级绕过：

  ```sh
  export NPM_CONFIG_CACHE=/tmp/npm-cache NPM_CONFIG_LOGS_DIR=/tmp/npmlogs
  ```

  永久修复一次即可：`sudo chown -R "$(id -u):$(id -g)" ~/.npm`。
- **调试认证严禁把 `.npmrc` 原文打进终端输出**：sed/grep 掩码命令要先在已知
  样例上自测再对真文件跑（掩码模式没命中就会原样打印整行）。token 一旦泄露
  进任何日志或会话记录，立即去 npmjs.com → Access Tokens 轮换并替换本地值。

### 10. GitHub Release（主仓）

```sh
HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 \
  rtk gh release create v<version> --repo huiliyi37/dsh-tianshu-tui \
  --title "v<version>" --notes "<与 README 更新说明一致的要点>"
```

### 11. 核对

```sh
HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 \
  npm view @huiliyi37/dsh-tianshu-tui version dist-tags --json
```

`version` 与 `dist-tags.latest` 都必须是刚发的版本。registry 可能有几秒延迟，对具体版本 `npm view @huiliyi37/dsh-tianshu-tui@<version>` 再查一次。

## 给已装用户

已能自更新的用户：下次启动会写入 profile，看到「插件已更新到 …，请重启 dsh 后生效」后重启。

尚未带自更新的旧装（`0.1.0-rc.6` 及更早）需手动一次：

```sh
npx -y @deepseek-ai/dsh plugin --profile tui add @huiliyi37/dsh-tianshu-tui
npx -y @deepseek-ai/dsh --profile tui
```

## 发版后检查清单

- [ ] 主仓 `main` + tag `v<version>` 已推 `github`
- [ ] 同样的 `main` + tag 已推 `omdsh`
- [ ] npm `latest` = 新版本
- [ ] 主仓 GitHub Release 已建
- [ ] README 更新说明已上 `main`
- [ ] `CHANGELOG.md` 已随版本更新（Unreleased → 版本号）
- [ ] 未推 `origin`、未提交 token、未改 `tui-runner`
