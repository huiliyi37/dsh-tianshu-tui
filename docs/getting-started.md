# 快速开始

dsh-tianshu-tui 是官方 DeepSeek Harness 的交互式终端 UI 插件。本文带你从零跑起来。
更详细的安装说明见根 README「安装」一节。

## 前置条件

- [Node.js](https://nodejs.org/) `>=24.9.0`
- PATH 上有 [`pnpm`](https://pnpm.io/installation)(`dsh plugin` 会转发给它)
- 运行模型需要 API key:环境变量 `DEEPSEEK_API_KEY`(或用官方 CLI 的登录流程)

> **不要直接敲 `dsh`。** 若 PATH 上已有旧的 `dsh`(如 `~/.local/bin/dsh`,
> `dsh --version` 低于 `0.2.2-rc.1`),会走到本地 staging,出现 `ERR_FS_EISDIR` /
> `Path is a directory .../@deepseek-ai/dsh`。请始终用下面的 `npx` 命令。

## 安装

```sh
# 1. 把插件装进 tui profile
npx -y @deepseek-ai/dsh@next plugin --profile tui add @huiliyi37/dsh-tianshu-tui

# 2. 启动
npx -y @deepseek-ai/dsh@next --profile tui
```

看到欢迎页品牌 **dsh-tianshu-tui** 即成功。`Ctrl+Q` 或 `/exit` 退出。

- pnpm 可能提示 peer missing,可忽略:peer 由官方 `dsh` 宿主提供。
- 已全局安装官方 CLI 且版本正确时,把 `npx -y @deepseek-ai/dsh@next` 换成 `dsh`。
- 从 Git 安装:`dsh plugin --profile tui add github:huiliyi37/dsh-tianshu-tui`。

## 首次使用

启动后你会看到:

- **欢迎页**:品牌头 + 会话短 id + 环境检查行(API key / git 是否就绪)
- **顶部栏**:`📁 cwd · 模型 · (git 分支 ●未提交数)`
- **底部三行**:输入行(圆角框体)→ footer(模式徽标 + 快捷键提示)→ metrics 行
  (模型 / 成本 / 上下文% / tokens / 耗时)

直接输入问题回车即可开始对话。常用操作:

| 想做什么 | 怎么做 |
|---|---|
| 查看全部快捷键 | `Ctrl+.` |
| 切换模型 | `/model`(回车后 ↑↓ 选择)或 `/model <provider/model>` |
| 切换主题 | `/theme`(回车后 ↑↓ 选择) |
| 新会话 / 恢复会话 | `Ctrl+N` / `Ctrl+S` |
| 中断当前回复 | `Ctrl+C` |
| 退出 | `Ctrl+Q` |

## 常见问题

**`ERR_FS_EISDIR` / `Path is a directory ...`**
`~/.dsh/profiles/node_modules` 里有旧的安装 fallback 与官方 CLI 冲突。换干净目录:

```sh
DSH_HOME=/tmp/dsh-tianshu npx -y @deepseek-ai/dsh@next plugin --profile tui add @huiliyi37/dsh-tianshu-tui
DSH_HOME=/tmp/dsh-tianshu npx -y @deepseek-ai/dsh@next --profile tui
```

**`plugin add` 报 `plugin command failed`（pnpm ≥ 11.7 / 0.2.2 宿主）**
0.2.2 宿主依赖树含原生构建脚本（node-pty 等），pnpm ≥ 11.7 对未裁决的构建以
exit 1 失败。打开 `$DSH_HOME/profiles/tui/pnpm-workspace.yaml`，把 `allowBuilds`
段的占位值（`set this to true or false`）逐条改成 `false`（保留
`@deepseek-ai/dsh-subprocess-local: true`——它只负责 chmod node-pty 的预编译
helper），然后重跑 `plugin add`。
若首次失败后 profile 里插件已列进 dependencies 但没进 `dsh.profile.bundles`
（启动后无 TUI、无报错），先 `plugin remove @huiliyi37/dsh-tianshu-tui` 再重新
`plugin add`——重跑 reconcile 只登记「新增」依赖。

**插件市场（dsh-plugin-hub）一键安装失败，报 `plugin is not installed`（[#60](https://github.com/huiliyi37/dsh-tianshu-tui/issues/60)）**
该报错不是本包安装失败：`plugin is not installed` 是市场安装器**自身**的状态守卫
消息（其卸载/定位接口的前置检查），说明市场界面缓存的「已安装」状态与其服务端
实际读到的 profile 依赖表不一致——安装命令根本没有执行过。凭据就在失败报告里：
「实际执行的安装命令：unknown (no executed command recorded)」且无「已尝试的安装
方式」段，npm 分发物（`lib/index.js` + `cordis.patch.yml`）完整、从未被下载校验。
安装器把这条自产消息误归类为「插件侧安装失败」自动投递了 Issue。绕过方式：用
上文的一键脚本或命令行安装（Windows）：

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/huiliyi37/dsh-tianshu-tui/main/scripts/install-tui.ps1 | iex"
```

若要协助定位市场侧缺陷，把 `~/.dsh/profiles/<profile>/hub.log` 反馈给
[dsh-plugin-hub](https://github.com/dshplugin/dsh-plugin-hub)。

**提示"插件已更新到 …,请重启 dsh 后生效"**
自更新机制把 profile 里的包升到了 npm 新版本,重启即可。

**不想联网检查更新**
设 `DSH_TUI_SKIP_UPDATE=1`。

**图片发不出去/模型说看不见图片**
主模型不识图时,装配视觉桥插件(`dsh-vision-bridge`,provide `visionBridge` 服务)
或注入 vision 配置;两者皆无则图片不发送并警告(这是有意的 fails loud)。

**需要模型可调 LSP 工具面**
装配社区插件 [`omdsh-dev/dsh-lsp`](https://github.com/omdsh-dev/dsh-lsp);TUI 展示桥
自动消费其 `lsp` 服务,与模型工具面共享同一 LSP server 集。

**`/preset` 提示「agent-presets 服务不可用」**
更新到本包含 agent 面装配的版本（`plugin add` 本包会连带装上官方预设注册表）。
命令是 `/preset`,不是 `/presets`。已装旧版的 profile 自更新后会带上新依赖。

## 下一步

- [交互手册](interaction.md):快捷键与命令全表
- [配置](configuration.md):装配选项与环境变量
- [架构](architecture.md):TUI 是怎么工作的
