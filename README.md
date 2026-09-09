# dsh-tianshu-tui — DeepSeek Harness coding 终端 

[![npm](https://img.shields.io/npm/v/@huiliyi37/dsh-tianshu-tui.svg)](https://www.npmjs.com/package/@huiliyi37/dsh-tianshu-tui)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/node/v/@huiliyi37/dsh-tianshu-tui.svg)](https://www.npmjs.com/package/@huiliyi37/dsh-tianshu-tui)
[![release](https://img.shields.io/github/v/release/huiliyi37/dsh-tianshu-tui?include_prereleases)](https://github.com/huiliyi37/dsh-tianshu-tui/releases)
[![dshfind](https://dshfind.com/api/badge/huiliyi37/dsh-tianshu-tui?lang=zh)](https://dshfind.com/zh/plugins/huiliyi37/dsh-tianshu-tui?ref=badge)

中文 | [English](README.en.md)

![dsh-tianshu-tui](docs/promo.png)

**dsh-tianshu-tui**（`@huiliyi37/dsh-tianshu-tui`）是官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 上的交互式终端 UI 插件。渲染核心为自研的 ANSI 极简引擎（由作者自己的开源项目 [天枢 Tianshu-harness](https://github.com/huiliyi37/Tianshu-harness) 演进而来，Apache-2.0；逐文件来源见 [SOURCE-MAP.md](SOURCE-MAP.md)），渲染轻量不打断，使用体验流畅。UI 是纯展示层：所有 agent 状态都来自会话事件流。在此之上做了 harness 工程层的个性化改造，如图像与视觉桥接、代码智能检索、记忆与跨会话召回等。


> [!WARNING]
> **生态边界（Ecosystem boundary）**：本插件属于官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`@deepseek-ai/*` 生态）——peerDependencies 与代码 import 均指向 `@deepseek-ai/*`。**不要把它装配进 oh-my-tianshu（`@huiliyi37` 生态，CLI 为 `@huiliyi37/dsh-tianshu`）的 tui profile**。oh-my-tianshu 的官方 TUI 是 `@huiliyi37/dsh-tui`：两者同源（共享 109/117 个 TUI 源文件）但生态不同，混装会让插件在运行时靠 `~/.dsh/profiles/node_modules` 中指向官方 dsh 的旧符号链接兜底解析 `@deepseek-ai/*`，形成跨生态脆弱耦合。

## 文档

| 文档 | 说明 |
|---|---|
| [快速开始](docs/getting-started.md) | 安装、启动与常见问题 |
| [交互手册](docs/interaction.md) | 快捷键与命令全表 |
| [配置](docs/configuration.md) | 装配选项、环境变量与运行时配置 |
| [架构](docs/architecture.md) | 分层、数据流与设计决策 |
| [主题](docs/themes.md) | 16 个内置主题与自定义 |
| [插件生态](docs/plugins.md) | 伴生插件与扩展点 |
| [VS Code](docs/vscode.md) | 在 VS Code 中使用 |
| [ADAPTER.md](ADAPTER.md) | TUI ↔ harness 边界契约 |
| [贡献指南](CONTRIBUTING.md) | PR 规范与验证矩阵 |
| [开发说明](DEVELOPING.md) | 结构、构建与发布 |

## 安装

本包不是独立程序。须先有官方 CLI [`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)（npm `latest`，当前 `0.1.1-rc.2`；需 ≥ `0.1.0-rc.8`，peer 依赖对齐）。只 `npm i` 本包跑不起来。

**一键安装（推荐）**：仓库自带跨平台脚本，自动检测 Node/pnpm、经 pnpm 安装官方 CLI + 装配本插件并启动（国内网络默认走 npmmirror 镜像）：

```sh
# macOS / Linux（bash）
bash <(curl -fsSL https://raw.githubusercontent.com/huiliyi37/dsh-tianshu-tui/main/scripts/install-tui.sh)
# 只安装不启动：
bash <(curl -fsSL https://raw.githubusercontent.com/huiliyi37/dsh-tianshu-tui/main/scripts/install-tui.sh) --no-launch

# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/huiliyi37/dsh-tianshu-tui/main/scripts/install-tui.ps1 | iex"
# 只安装不启动：
powershell -ExecutionPolicy Bypass -File scripts\install-tui.ps1 -NoLaunch   # 克隆仓库后本地跑
```

### 1. 准备环境

- [Node.js](https://nodejs.org/) `^22.19 || >=24`
- [`pnpm`](https://pnpm.io/installation)（`dsh plugin` 会转发给它；没有时 `corepack enable` 即可——Node 自带 corepack）

> ⚠ **npm 11 的 OOM 坑**：官方 CLI `@deepseek-ai/dsh` 依赖树较大（60+ 子包），**npm 11（Node 24 自带）安装时会 JavaScript heap out of memory**（卡住数分钟后 OOM，实测复现）。请用 pnpm（下方命令）。若你已经在用 `npx -y @deepseek-ai/dsh` 且卡住/报 heap OOM，切到 pnpm 即可。

**不要直接敲 `dsh`。** 若 PATH 上已有旧的 `dsh`（例如 `~/.local/bin/dsh`，`dsh --version` 低于 `0.1.0-rc.8`），会走到本地 staging，出现 `ERR_FS_EISDIR` / `Path is a directory .../@deepseek-ai/dsh`。请始终用下面的 `pnpm dlx` 命令。

### 2. 把本插件装进 tui profile

```sh
pnpm dlx @deepseek-ai/dsh plugin --profile tui add @huiliyi37/dsh-tianshu-tui
```

pnpm 可能提示 peer missing，可忽略：peer 由官方 `dsh` 宿主提供，不必另装。没有 pnpm 也可以 `npx -y pnpm dlx @deepseek-ai/dsh plugin --profile tui add @huiliyi37/dsh-tianshu-tui`。

从 npm 安装后，每次启动会对照 npm `latest`：有新版本就写入 profile，提示重启后生效。也可在 TUI 里敲 `/update` 手动检查（只查不装，给出更新命令）。不想联网检查时设 `DSH_TUI_SKIP_UPDATE=1`。`github:` / `link:` 安装不会改写成 npm 包。

也可以从 Git 装：`pnpm dlx @deepseek-ai/dsh plugin --profile tui add github:huiliyi37/dsh-tianshu-tui`（仓库已包含 `lib/index.js`，不必再打包）。

### 3. 启动

```sh
pnpm dlx @deepseek-ai/dsh --profile tui
```

看到欢迎页品牌 **dsh-tianshu-tui** 即成功。`Ctrl+Q` 或 `/exit` 退出。

已全局安装官方 CLI（`pnpm add -g @deepseek-ai/dsh`）且 `dsh --version` 不低于 `0.1.0-rc.8` 时，把上面的 `pnpm dlx @deepseek-ai/dsh` 换成 `dsh` 即可。

### 4. agent 预设（`/preset`）

命令是 `/preset`（没有 `/presets`）。本包 bundle 对标官方 web：关掉 host 上的 agent 面，挂上 `@deepseek-ai/dsh-agent-presets`（依赖钉死 `0.1.1-rc.2`，npm `latest` 仍停在过时的 `0.0.1-rc.1`）。`plugin add` 本包即连带装上花名册；新会话在 `setup` 里 `mount`，`/preset` 换的是官方 shipped 面（标准 / PTC / 极简 / 创造），不是叠在 `dsh-base` 工具上。

用法：

- `/preset` —— 列出每套预设的能力与工具集，`*` 标当前项；footer / 欢迎顶栏也会显示当前短名（标准 / PTC / 极简 / 创造）。说过话后还附最近一次请求的 `wire:` 工具面
- `/preset <id>` —— 切换到指定预设（仅空白会话可换：先 `/session new` 再切；`ptc`/`creative` 是 `code`/`cordis` 的别名）

若 `npx` 仍报 `ERR_FS_EISDIR`，是 `~/.dsh/profiles/node_modules` 里旧的安装 fallback 与官方 CLI 冲突。换干净目录再启动：

```sh
DSH_HOME=/tmp/dsh-tianshu pnpm dlx @deepseek-ai/dsh plugin --profile tui add @huiliyi37/dsh-tianshu-tui
DSH_HOME=/tmp/dsh-tianshu pnpm dlx @deepseek-ai/dsh --profile tui
```

不要在 DeepSeek Harness 工作区根目录对本包跑 tsdown：会把未发布的 `@deepseek-ai/dsh-root` 写进 bundle，加载必失败。

## 与其他发行版共存

本插件运行在官方 DeepSeek Harness（`@deepseek-ai/dsh`）之上，数据 home 为 `~/.dsh`。
独立集成发行 **oh-my-tianshu**（原 tianshu-public，`@huiliyi37/dsh-tianshu`，自带 `tianshu`
CLI 的完整 harness）是另一条独立发行线，使用独立的 `$DSH_HOME`（默认值独立化落地后为
`~/.dsh-tianshu`）——两套系统 home 隔离，**可同时安装、互不干扰**（会话 / profile /
settings 各自独立）。共存时 tianshu 侧设 `export DSH_HOME=~/.dsh-tianshu` 即可。

**命名备忘（防止混淆）**：

| 名字 | 是什么 |
|---|---|
| `dsh-tianshu-tui`（本插件） | 官方 dsh 的 TUI 插件（本仓库） |
| `oh-my-tianshu` / `@huiliyi37/oh-my-tianshu`（原 tianshu-public） | 独立集成发行，自带 CLI（命令 `oh-my-tianshu`） |
| `Tianshu-Tui`（上游） | 本插件渲染核心的 Apache-2.0 来源（天枢） |

> 2026-08-16 已改名：原 `@huiliyi37/dsh-tianshu`（命令 `tianshu`）统一为
> `@huiliyi37/oh-my-tianshu`（命令 `oh-my-tianshu`），与仓库名一致；旧包已
> deprecate，请迁移安装。

需要图片再询问能力时，再装配同仓伴生包 `vision-ask/`。LSP 模型工具面（`lsp_goto_definition` / `lsp_find_references` / `lsp_diagnostics`）已随本包内置（`@huiliyi37/dsh-lsp` 伴生插件，bundle patch 自动 insert）——装 TUI 一个包即得展示桥 + 模型工具面，二者共享同一 LSP server 集（不双份 spawn）。TUI 桥的诊断源探测顺序：内置伴生插件 `lsp` 服务（getDiagnostics 形状）→ 官方 `ctx.lsp` seam（deepseek-harness 的 dsh-lsp，经 query(getDiagnostics) 适配）→ 内置桥降级。⚠ 此前单独装过旧社区版（`github:omdsh-dev/dsh-lsp`）的用户请先 `plugin remove` 旧版再升级——新旧同时装配会重复注册同名模型工具。

## 更新说明

当前 npm `latest`：[`@huiliyi37/dsh-tianshu-tui@0.1.2-rc.28`](https://www.npmjs.com/package/@huiliyi37/dsh-tianshu-tui)（[GitHub Release](https://github.com/huiliyi37/dsh-tianshu-tui/releases/tag/v0.1.2-rc.28)）。

**0.1.2-rc.28（2026-08-29）**：回应 #55 的 vim 优化——光标形态分模式（NORMAL 反色块 / insert 竖线）、历史搜索两阶段输入（编辑段可输 n/N，`Enter` 后跳转、搜索对象显式标注）、搜索命中子串高亮（含 `/scroll`）；另投递失败自动回填输入行 + README 键位表一致性守卫。

**0.1.2-rc.27（2026-08-29）**：回流 Tianshu 两项——错误时刻可行动（错误落底 + 指引之外，最近一条已投递消息自动回填输入行，`↩` 告知「可能未被完整处理」，改一下即可重发；成功回合清底料、有草稿不抢写）；plan-review 决策卡视觉分层（dim 决策区分隔线 + approve `❯`/success 主操作高亮，主题不传时渲染不变）。

**0.1.2-rc.26（2026-08-28）**：P1 交互打磨六连——Esc 分层收尾（打断 grace 期 + 布防提示行）、glance 拟人动词池、footer 显式分级降级、错误恢复指引（每个错误附下一步操作）、定高视口强化（chrome 开合输入轨不跳）、fish 式历史建议 ghost（`→` 接受）；`/scroll` 上限可配。

**0.1.2-rc.25（2026-08-28）**：P0 交互三连——键位/命令/提示统一 action registry（app.ts 棘轮 4359→4140）、审批卡六档决策梯度（新增 `p` 命令前缀白名单、`f` 拒绝附反馈，bash 审批带命令预览与危险标注）、运行中消息排队（`↑` 收回、`Ctrl+Enter` 插队、打断保队列）；另含 `/scroll` 分页查看器、完成响铃、vim remap、主题对比度校验。

**0.1.2-rc.24（2026-08-27）**：vi/vim 编辑模式完整落地（#51，`/vim` 开关、Claude Code 键位表对标）+ 内置 LSP 三件套依赖闭包补齐（#54：修复 pnpm 下启动即 `ERR_MODULE_NOT_FOUND` 整树失败）。

**0.1.2-rc.23（2026-08-27）**：LSP 三件套对齐 tianshu-public 0.6.0 官方 seam 线（单 `lsp` 工具四操作 + 本地 provider 默认 tsserver），诊断源能力门控防 `/lsp` 面板退化；宿主 peer 对齐 `^0.1.1-rc.2`。

**0.1.2-rc.22（2026-08-27）**：LSP 模型工具面随包内置首版（伴生插件自动挂载，装 TUI 一个包即得展示桥 + 模型工具面；旧社区版请先移除）。

**0.1.2-rc.21（2026-08-27）**：社区反馈三连修——输入框光标反色化（#50）、preset 缺省 standard（#48）、`malformed SSE payload` 根因定位并上报官方（#49）。

完整版本历史见 [CHANGELOG.md](CHANGELOG.md)；TUI 内 `/changelog` 查看（`/changelog all` 全部）。

## 亮点

- **终端内的完整会话工作区** — 实时渲染、只增滚动转录、启动时会话恢复、`/fork` 探索分支、`/rewind` 回退（会话截断 + 可选文件回退）、`/export` 导出 Markdown 转录、中轮转向（`/steer` / `Ctrl+T`）。
- **图片端到端** — 剪贴板粘贴（`Ctrl+V` / 终端菜单粘贴）、以终端图形协议内联渲染（kitty / iTerm2）、经 harness 附件服务投递、让具备视觉能力的模型真正看见——主模型不识图时自动经独立视觉模型把图片转成描述（视觉桥）。
- **完整输入面** — grok 风格 slash 下拉菜单（模糊前缀匹配、MRU 排序、ghost 预览）、`@`-路径 Tab 补全与 `@mention` 展开、bracketed paste、可选 vim 键位、外部编辑器（`Ctrl+E`）、历史搜索（`Ctrl+F`/`Ctrl+R`）——`Ctrl+.` 随时调出完整键位表。
- **终端内交互面** — 结构化提问面板（数字键选择、plan-review 反馈模式）、带内联 `diff` 预览的挂起审批卡片、模式循环（`Shift+Tab`：normal → plan → always-approve）、命令面板，以及 status / config / skills / tasks / 委派树 / workflow 实时面板。
- **推理过程可视化** — think 通道以实时头行流动、在滚动区折叠为紧凑行（`✻ 思考 (3.2s) · 12 行`）、`Ctrl+O` 原位展开（对标竞品：默认折叠）。
- **个性化 harness 集成** — `/doctor` 终端诊断、`/memory` 项目记忆浏览器、`/btw` 后台 agent 侧问、`/model` + `/effort` 热切换（当前会话立即生效）。
- **构造上可审计** — TUI 自身不注册任何 prompt、工具或上下文面；用户输入成为普通日志消息，所有渲染状态都派生自会话事件。
- **与 harness 协同演化** — 在 2026-08-09 基线快照之上与 harness 侧能力同步开发（250+ 提交）：图片/视觉链路、DeepSeek Spark 模型工程、会话持久化与文件快照、记忆、验证门与失败路由、代码智能、git 工具。见下一节。

## 与 harness 协同演化的能力（2026-08-09 基线以来）

终端 UI 从 [天枢 Tianshu-Tui](https://github.com/huiliyi37/Tianshu-Tui) 演进而来（Apache-2.0；逐文件来源见 [SOURCE-MAP.md](SOURCE-MAP.md)）。本 bundle 随后在 DeepSeek Harness 基线快照 `snapshots/20260809T140917Z` 之上与 harness 侧工作同步开发——2026-08-10 至 2026-08-13 共 250+ 提交。下列能力位于宿主 harness（独立包，不随本 bundle 分发）；TUI 是它们的主要交互面：

- **图片链路与视觉桥** — `image` ContentBlock 加入 merge-extensible 内容词汇，`dsh-llm-deepseek` 把用户图片 block 序列化为 OpenAI 风格 `image_url` content parts——用户图片端到端可达 wire（剪贴板 → 输入行 → 会话 → 模型请求）。模型经 `supportsVision` 声明识图能力（`LlmModelInfo` + llm-deepseek catalog）。`dsh-vision-bridge` 覆盖 text-only 主控：`agent/pre-step` 时经独立视觉模型描述图片附件（`visionAutoBridge` 在未指定 provider/model 时自动选首个识图模型；备用模型 fallback + data URL 校验；prompt 按 UI/报错关键词在通用结构与 OCR 级精确转写间自动选择），描述作为 plugin-source user message 注入——Model-visible ⟺ logged；桥失败降级为可见提示，绝不整轮 failed。
- **DeepSeek Spark 别名** — 官方 API 没有 `spark` 模型，本宿主也不注册 `deepseek-spark` provider。`/model spark-flash` / `spark-pro` 映射到已注册的 `deepseek-official` 路由，wire 模型分别为 `deepseek-v4-flash` / `deepseek-v4-pro`。
- **会话持久化与文件快照** — `Session.truncate` 回卷事件日志并重置派生状态；持久化后端新增 `deleteFrom` 与 truncate 协调器，回滚跨重载存活；`dsh-fs-snapshot` 移植 FileHistory（trackEdit / rewindToBoundary），在写入工具执行前快照。TUI 入口：`/rewind`（会话截断 + 可选文件回退）。
- **记忆** — `dsh-memory`（MemoryService + Markdown 文件后端、非 git 兜底）与 `tool-memory`（`memory_save` / `memory_search` + 记忆摘要注入）提供跨会话召回。TUI 入口：`/memory`、`/remember`。
- **验证门与失败路由** — `dsh-evidence-gate` 强制执行 RED-first 验证：义务状态机、编辑/验证计数、TDD 门（`enforce` 模式）、探针建议 + 冷却、L2 终审门，原生接入 `str_replace_editor` 与 headless-agent 装配。`dsh-agent-router` 依据回合历史预测步骤失败并路由工作——含验证子代理调度与按 profile 工具限制——带真实回合 e2e 覆盖。
- **代码智能与检索** — `dsh-semantic-index`（BM25 + salience/RRF/向量融合、增量更新）以 `semantic_search` 工具暴露；`dsh-meridian` 代码索引（node:sqlite schema、TypeScript/Python/Go 三语言 tree-sitter 解析器、graph/impact/flow 查询、行为信号、后台回填）以 `repo_graph` 与 `<codebase-index>` 摘要暴露；`dsh-pheromone` 文件级信息素 + 原子 JSON 持久化，经 `file_info` 与 read 工具 `focus` 语义上屏。
- **Git 服务与工具** — `dsh-git` 服务接缝（GitLocal CLI provider，服务类即插件）+ `dsh-tool-git` 面向模型的单一 git 工具（operation 判别：status / diff / log / commit），装配进 base bundle。

## 功能

### 会话管理

| 能力 | 说明 |
|---|---|
| `/session new\|list\|switch` | 新建、列出、切换会话；恢复时经同一渲染桥重放完整转录 |
| 恢复面板 | 启动时把可恢复会话列表写入滚动区 |
| `/fork [directive]` · `/branch` | 分叉当前会话（历史复制到新子会话），可选带起始指令 |
| `/rewind` | 回退到指定消息——会话截断和/或文件回退到边界前快照 |
| `/export` | 把当前会话转录导出为 Markdown 文件 |
| `/clear` | 清空当前会话滚动区视图 |

### 输入面

- **Slash 命令菜单** — 输入 `/` 打开下拉菜单：模糊前缀匹配、`↑↓` / `PageUp` / `PageDown` 选择、`Tab` 接受、`Enter` 提交、MRU 排序、参数占位 ghost 与输入行 ghost 预览。
- **剪贴板与图片粘贴** — `Ctrl+V` 读取剪贴板图片（回退到文本）；终端菜单粘贴检测图片；看起来像图片的粘贴路径按附件加载；`Alt+W` / vim yank 经 OSC52 把选区复制到系统剪贴板。
- **图片提交** — 附件图片显示 `📎 N images` 标记，提交时在用户气泡下方以内联图形渲染，并经附件服务到达模型；气泡携带识图提示（已转发 / 经视觉模型桥接 / 未发送）。超大图发送前自适应压缩：长边 1568px 封顶（PNG 保留透明），逐级 JPEG 0.82 → 0.55 → 1024px + 0.55 直到低于 provider 上限，全程只缩不放。
- **Vim 编辑键位（[#51](https://github.com/huiliyi37/dsh-tianshu-tui/issues/51)）** — `Esc` 进 NORMAL，键位表对标 Claude Code：`h j k l / w e b W B E / 0 $ ^ / gg G / f F t T ; ,` 导航与查找重放、`d c y × motion` + 数字前缀、文本对象 `iw aw iW aW`、行级 `dd cc yy Y` 与 `p P` 粘贴、`x X D C s S r o O J u .`；`v/V` visual 选区两端含光标下字符。多行草稿 `j/k` 保持列移动；中文连续段成词不逐字跳。运行时 `/vim` 开关，`/vim default` 设为启动默认。insert 两键序列→Esc（`vimInsertRemaps`，如 `{"jj":"esc"}` 写入 prefs；1 秒窗防误触）。光标形态随模式区分：NORMAL 反色块、insert 竖线（#55）。NORMAL `/` 打开会话历史搜索（两阶段：输入即过滤，`Enter` 确认后 `n`/`N` 跳转——搜索词可含 n/N）。
- **编辑** — 外部编辑器（`Ctrl+E`）、Tab 文件补全、`@mention` 展开、输入历史、多行输入、bracketed paste（多行/长文本粘贴整段进输入行，不逐行提交）；输入行绘制为完整圆角框体。
- **运行中排队（对标 Claude Code queue）** — agent 运行时提交的消息进入输入轨上方的本地队列（立即回显、不直发）；回合结束按序自动投递，中断不投递（留给你 ↑ 取回的余地）；空输入 `↑` 取回队首回输入行；切换会话丢弃并回显条数。中轮即时纠偏仍走 `/steer` / `Ctrl+T`。
- **图片再询问** — 同仓伴生插件 `@deepseek-ai/dsh-vision-ask` 登记已发送图片，并经 `ask_image` 回答模型的定向问题（见 [vision-ask](vision-ask/README.md)）。

### 渲染与投影

- **对话流** — markdown 渲染、工具族着色 + 逐工具计时、并行工具调用折叠为组。
- **工具卡实时结算** — 已结算的工具结果按 harness presenter 意图渲染为滚动区卡片：`diff` 结果渲染结构化红/绿文件差异（与审批预览共用）、`terminal` 结果带命令标题 + cwd + 退出/信号徽标、其余折叠为文本卡片。
- **推理通道** — 思考中实时 shimmer 头行、段末折叠滚动行、`Ctrl+O` 在 live 区展开全文。
- **流利度折叠** — 重复的例行工具流量在 quiet 策略下折叠；compact 模式（`/density`）只保留头行。
- **轮次状态** — braille spinner + 阶段文本状态行、workflow 运行汇总、委派树、任务窗格、config/skills 面板作为 live-region 面板；turn 结束（非中断）且有工具调用时落 dim 摘要行（`turn N · 读X 改Y · 耗时`）。
- **Subagent 运行** — 每个运行一条 live spinner 行；终态以 `✓`/`✗`/`◌` 条目落入滚动区。
- **窗口 chrome** — 欢迎页（品牌头、友好会话短 id、环境检查行）、顶部栏（cwd + git 分支 + 模型）、底部三行区：输入行（底边线随模式着色）→ footer（模式徽标 + 快捷键提示）→ metrics 行（模型 / token 用量 / 缓存命中率）。
- **主题** — 内置调色板 + `custom:<name>`；自动终端检测与 16 色降级；尊重 `NO_COLOR`；自定义主题加载时按声明背景做对比度警告（WCAG < 3.0，不阻断）。

### 交互面板

- **结构化提问** — 数字键选择、`Esc` 取消、重叠保护；plan-review 反馈模式（`f` 进入、`Enter` 提交 Keep planning + 自定义反馈）。
- **审批卡片** — `y`/`N`/`Ctrl+C` 结算挂起审批；工具可 diff 时内联差异预览；diff 不可见时盲批提示；非当前会话请求委托给下一个监听者。
- **模式循环** — `Shift+Tab` 循环 normal → plan → always-approve；plan 状态驱动 footer 徽标，always-approve 为会话级本地态（切换/退出时复位）。
- **实时面板** — `/status`（goal/todos/plan 投影快照；subagent 域见 `/subagents`）、`/config`（终端通知（完成时系统通知 + BEL 响铃，响铃在 SSH 会话下同样可达）/紧凑渲染 + 宿主 settings / permission / credentials）、`/skills` 浏览（↑↓ 详情）、`/tasks` 窗格、`/subagents` 委派树、`/workflow` 运行。检查类面板互斥，`Esc` 关闭。宿主服务未装配时对应段折叠；`/config` 的终端段不依赖宿主。其它面板在 backing 服务缺失时回显 `⚠` 警告（不静默空白）。
- **命令面板（`Ctrl+P`）/ 键位表（`Ctrl+.`）/ 历史搜索（`Ctrl+F`/`Ctrl+R`）overlay**。

### 模型与视觉

- `/model` — 查看并切换模型（默认 + 当前会话热切）；`spark-flash` / `spark-pro` 别名映射到 `deepseek-official` + 官方 wire id `deepseek-v4-flash` / `deepseek-v4-pro`。`/model <provider/model|alias> [off|high|max]` 同一条命令内设置推理等级。
- `/effort` — 设置推理等级（`off` / `high` / `max`；`auto` 回模型默认），当前会话热切。
- **视觉桥** — 识图能力按模型声明（`supportsVision`，经 llm catalog 自动刷新）并驱动气泡提示；主模型不识图时，自动选定的视觉模型在提交前生成图片描述（一次性路径；见已知限制）。桥可用性来源：装配方传入 `vision.bridgeEnabled`，或宿主视觉桥插件 provide `visionBridge` 服务（TUI 提交图片前按服务存在性自动探测）；两者皆无则图片不发送并警告。
- **视觉副驾** — 装配同仓伴生插件 `@deepseek-ai/dsh-vision-ask` 后，每张已发送图片被登记为短 id（`img_1` …），模型可经 `ask_image` 反复询问——定向问题、换角度、不限次数；同图同角度重复提问命中 per-image 描述缓存。细节与配置见 [vision-ask README](vision-ask/README.md)。
- `/mcp` — 列出已连接 MCP server 与工具数；`tools <name>` 查看某 server 的工具清单。

### 命令

| 命令 | 作用 |
|---|---|
| `/session new\|list\|switch` | 会话管理（list/选择器按今天/昨天/本周/更早分组） |
| `/fork [directive]` · `/branch` | 分叉当前会话，可选带起始指令 |
| `/rewind` | 两阶段回滚（消息列表 → 粒度） |
| `/export [path]` | 导出转录为 Markdown |
| `/scroll` | 分页查看器：全文浏览转录（滚动 / 实时搜索 / `n`·`N` 跳转 / `g`·`G` 首尾） |
| `/clear` | 清空滚动区视图 |
| `/compact` | 压缩会话上下文 |
| `/steer <text>` | 中轮转向（不中断地纠正方向） |
| `/model [target] [effort]` | 查看/切换模型（别名：`spark-flash`、`spark-pro`） |
| `/effort off\|high\|max\|auto` | 设置推理等级（热切） |
| `/theme [name]` | 切换主题 |
| `/density` | 切换紧凑工具卡渲染 |
| `/vim [on\|off\|default]` | 切换 vi/vim 编辑键位；`default` 写入启动默认 |
| `/lsp` | 切换 LSP 诊断面板（agent 触碰文件时自动拉取该文件诊断；诊断徽标上工具卡） |
| `lsp_goto_definition` · `lsp_find_references` · `lsp_diagnostics` | LSP 模型工具面（伴生插件 `lsp/` 注册；定义跳转 / 引用查找 / 文件诊断） |
| `/status` | 切换状态面板（goal/todos/plan 投影 + 会话汇总段） |
| `/config [notify [on\|off]]` | 切换设置面板（空输入 `n` 通知、`d` 密度）。无参开关面板 |
| `/skills` | 切换技能浏览面板 |
| `/tasks` | 任务窗格（后台任务） |
| `/goal` | 目标管理（创建 / 暂停 / 恢复 / 完成 / 阻塞） |
| `/subagents` | 委派树面板 |
| `/workflow` | workflow 运行面板 |
| `/btw <question>` | 向后台 agent 侧问 |
| `/remember <text>` | 保存一条记忆 |
| `/memory` | 记忆浏览器（列表 / 过滤 / 删除 / 预览） |
| `/doctor` | 终端诊断 + 修复指引 |
| `/mcp [tools <name>]` | 列出 MCP server；查看某 server 的工具 |

### 快捷键

| 按键 | 作用 |
|---|---|
| `Enter` | 发送 |
| `Shift+Enter` | 换行（或 `\`+Enter 续行） |
| `Ctrl+N` | 新会话 |
| `Ctrl+S` | 恢复最近会话 |
| `Ctrl+Q` | 退出（同 `/exit`） |
| `Ctrl+P` | 命令面板 |
| `Ctrl+.` | 键位表 overlay |
| `Ctrl+F` / `Ctrl+R` | 历史搜索（输入即过滤；`Enter` 确认后 `n`/`N` 下一个、`p`/`P` 上一个） |
| `Ctrl+O` | 展开/收起最近推理块 |
| `Ctrl+E` | 用 `$EDITOR` 打开输入行（可经 `editorKey` 配置） |
| `Ctrl+T` | 中轮转向 |
| `Ctrl+Enter` | 插队：打断当前回合并立即发送草稿（需终端支持 kitty 键盘增强协议，`RIVET_KITTY_KEYBOARD=1` 可强制开启） |
| `Ctrl+C` | 打断在途回合（空闲时空输入双击退出） |
| `Ctrl+V` | 粘贴剪贴板图片（无图时回退剪贴板文本） |
| `Alt+W` | 把选区复制到系统剪贴板（OSC52） |
| `Shift+Tab` | 模式循环：normal → plan → always-approve |
| `Tab` | `@`-路径补全；接受 slash 菜单选中项 |
| `Ctrl+U` | 删除到行首 |
| `↑`/`↓` | 输入历史（slash 菜单打开时为选择；有排队消息时空输入 ↑ 取回队首） |
| `PageUp`/`PageDown` | slash 菜单翻页 |
| `Esc` | 关闭菜单/overlay/检查面板；取消挂起提问；空闲双击 rewind |
| `t` | 审批卡：记住此工具（本会话内该工具自动放行，其他工具仍逐卡审批） |
| `a` | 审批卡：本会话放行（always-approve + 结算当前请求） |

## 装配

bundle patch 在 `dsh-base` 之上插入 `tui-runner` 插件：

```yaml
- id: tui-runner
  name: '@huiliyi37/dsh-tianshu-tui'
```

`TuiRunnerConfig`（均可选）：`stdin`/`stdout`（流注入，缺省走进程流）、`initialSessionId`、`editorKey`（缺省 `ctrl_e`；`ctrl+o` 保留给推理展开）、`vimEnabled`（缺省 `false`）、`vision`（supportsVision / bridgeEnabled / bridgeSource；未传入时 supportsVision 经 llm catalog 自动刷新、bridgeEnabled 按宿主 `visionBridge` 服务存在性自动探测——视觉桥插件装配时应 provide 该服务）、`workflowHistoryLimit`（缺省 `50`）、`lsp`（enabled / timeoutMs；缺省启用、单次拉取超时 2000ms——本地语言服务桥：agent 触碰文件时按扩展名懒启动 LSP server（typescript 经 npx 默认可用，pyright/gopls/rust-analyzer/clangd/jdtls 按 PATH 探测）拉取诊断，展示于工具卡徽标与 `/lsp` 面板；诊断只进 TUI 本地展示缓存，不写会话事件、不注册任何模型面）。

服务依赖：`sessions`/`agents`/`agentDefaultModel` 必需（必选 inject）；`goals`/`subagents`/`memory`/`compact`/`tasks`/`skills`/`sessionProjections`/`workflowEngine`/`planMode` 可选——未装配时相关命令与面板 fails loud 报不可用，绝不静默吞，也不阻塞 TUI 启动。

## 验证

```sh
npm test
```

## Model Experience

无——TUI 渲染已记录的会话事件并转发普通用户输入；不注册任何 prompt、工具或上下文面。

#### KV Cache 影响

无直接影响；经 TUI 提交的用户输入成为普通日志消息，其请求影响归属 session 与 loop 包。

## 已知限制与待办

- **图片再询问需伴生插件** — `ask_image` 工具与会话图片注册表位于 `@deepseek-ai/dsh-vision-ask`（同仓独立包）；TUI bundle 本体不携带它们。未装配插件时，已发送图片无法再次询问，同角度重复描述会再次调用视觉模型；视觉桥仍覆盖一次性提交时描述路径。
- **LSP 桥的运行时限制** — 模型工具面（goto/find/diagnostics）已随包内置（`@huiliyi37/dsh-lsp`）；如天枢 edit-diff 的 diagnostics-narrowing 这类深度集成仍属未来工作。server 初始化慢于超时（默认 2s）时静默无诊断，下次触碰文件重拉；大仓库 tsserver 常驻内存（懒启动缓解，无空闲回收）；切会话不重启 server（rootUri 沿用首会话 cwd）。
- **app.ts 单体（约 3.2k 行）** — 挂起状态机已控制器化（question/approval），渲染组合与键仲裁仍在 app.ts；C4 拆分方案（纯函数面板段）持续推进。
- **投影层部分接线** — 四个纯折叠模型中 turn-summary（turn/end 摘要行）与 summary-state（`/status` 会话汇总段，宿主投影总线缺失时仍有数据）已接线；activity-status/activity-store 有意保留未接线（statusline 是自包含投影，替换无收益；activity-store 暂无消费方）。当前状态记录于 [docs/projection-layer.md](docs/projection-layer.md)。

## 许可与来源

Apache-2.0。终端渲染引擎从 [天枢 Tianshu-Tui](https://github.com/huiliyi37/Tianshu-Tui) 演进而来（Apache-2.0）；逐文件来源与修改声明见 [SOURCE-MAP.md](SOURCE-MAP.md) 与 [NOTICE](NOTICE)。

## 友情链接

| 项目 | 简介 |
|---|---|
| [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) | DSH Web UI 插件与皮肤合集 |
| [dshfind](https://dshfind.com/zh) | DeepSeek Harness 中文学习与分享社区 |
| [deepseek-harness-ux](https://github.com/ayuanwong/deepseek-harness-ux) | 长任务不刷屏：关键进度清晰可见，完成后自动折叠 |
| [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) | Claude Code 风格全屏交互终端插件 |
| [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | 侧边栏完整工作台：第三方 Tab、文件/终端/Git/子代理 |
| [DSH Desktop](https://github.com/anywhere-labs/deepseek-harness-desktop) | DeepSeek Harness 社区桌面端（Electron，Windows x64 / macOS Apple Silicon 安装包），下载即用、免配置命令行环境。内置本地 Harness 宿主与插件系统，支持 iOS/Android 远程下发任务、跟踪 agent 进度。 |
| [dsh-whale-report](https://github.com/SenmuuuuW/dsh-whale-report) | 把 session、token、cost、tool call 与风险异常转成可读的 Agent 报告 |
