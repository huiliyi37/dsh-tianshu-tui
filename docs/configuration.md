# 配置

dsh-tianshu-tui 的配置分三层:**装配时配置**(TuiRunnerConfig,插件注入)、
**环境变量**(进程级)、**运行时配置**(TUI 内命令/面板)。

## 装配时配置(TuiRunnerConfig)

插件装配方(TuiRunnerConfig,全部可选)经 `dsh plugin` 的配置面注入:

| 字段 | 缺省 | 说明 |
|---|---|---|
| `stdin` / `stdout` | 进程流 | 键盘输入流 / 渲染输出流(测试替身注入用) |
| `initialSessionId` | 新建会话 | 启动即切入的会话 id |
| `editorKey` | `ctrl_e` | 外部编辑器触发键(`ctrl+o` 保留给推理展开) |
| `vimEnabled` | `false` | 是否启用 Vim 键位 |
| `vision.supportsVision` | llm catalog 自动刷新 | 主控模型是否原生识图(图片直发) |
| `vision.bridgeEnabled` | 按宿主 `visionBridge` 服务存在性自动探测 | 是否配置独立识图桥模型 |
| `vision.bridgeSource` | — | 识图桥来源(configured / auto / none) |
| `workflowHistoryLimit` | `50` | `/workflow` 面板已结算 run 缓存上限(drop-oldest) |
| `activityBand` | `true` | 输入轨上方统一活动带;`false` 回退每条子代理一行 spinner |
| `activityBandMaxRows` | `5` | 活动带 item 行封顶(正整数;超限折叠为 `+N`) |
| `lsp.enabled` | `true` | LSP 诊断拉取开关(本地语言服务桥) |
| `lsp.timeoutMs` | `2000` | 单次诊断拉取超时 |
| `autoRestartOnUpdate` | `true` | 启动自更新落盘后自动重启生效;`false` 时仅提示,手动 `/restart` |
| `theme` | prefs.json | 主题名(`'auto'`/内置名/`custom:<name>`);优先级:装配 > prefs.json > `'auto'` |
| `prefsPath` | `~/.dsh-tui/prefs.json` | 本地偏好文件路径;`null` 显式禁用(不读写) |
| `inputHistoryPath` | `~/.dsh-tui/input-history.json` | 输入历史文件路径;`null` 显式禁用 |

### 装配 agent 预设（`/preset`）

本包 `cordis.patch.yml` 已插入 `agent-presets`（`default: standard`），并关掉
host 上由官方 `standard` 预设再挂的 agent 面行。`plugin add` 本包会连带安装
`@deepseek-ai/dsh-agent-presets@0.1.1-rc.2`。命令名是 `/preset`，没有 `/presets`。
新会话在 `setup` 里 `mount`；空白会话 `/preset <id>` 走官方 `recompose`。

## 环境变量

| 变量 | 说明 |
|---|---|
| `DEEPSEEK_API_KEY` | API key(欢迎页/状态行按 credentials 分层判断) |
| `DSH_TUI_SKIP_UPDATE` | `1` 时跳过启动时的 npm 更新检查 |
| `DSH_TUI_SKIP_NOTIFY` | `1`/`true` 时关闭系统通知,`/config` 开关不可切 |
| `DSH_TUI_UPDATE_REGISTRY` | 自更新检查的 registry 链(逗号分隔多个,优先于缺省链;缺省 `registry.npmjs.org` → `registry.npmmirror.com` 镜像回退,官方源直连超时时自动落镜像) |
| `EDITOR` / `VISUAL` | `Ctrl+E` 外部编辑器的命令(Windows 上支持 `.cmd`/`.bat`) |
| `HTTP_PROXY` / `HTTPS_PROXY` | 网络代理(自更新等联网操作) |

> **自更新的包管理器适配**:启动自更新按 profile 锁文件自动选择包管理器
> (`pnpm-lock.yaml` → pnpm,`package-lock.json` → npm,`yarn.lock` → yarn,
> 无锁文件默认 pnpm)。无需手动配置;仍可用 `DSH_TUI_SKIP_UPDATE=1` 关闭。

## 运行时配置

### 本地偏好与历史(`~/.dsh-tui/`)

TUI 的启动默认存在 `prefs.json`;带参 `/theme` `/density` `/preset` 默认只改本会话,
选择器按 S 或命令末尾 `default` 才写入:

- **`prefs.json`** — 启动默认主题(含 `custom:` 与 `auto`)、密度、agent 预设,
  `/subagents` `/workflow` 常驻面板显隐、`/glance` 隐藏的 metrics 段、
  系统通知(`notifyOs`,缺省开)、历史建议 ghost(`ghostSuggest`,缺省开)、
  欢迎页风格(`welcomeStyle`:`star` 新版抱星鲸鱼,缺省 / `retro` 复古小鲸鱼)、
  scrollback 行数上限(`scrollbackMaxLines`,缺省 1000——调高增加内存与
  回放/快照成本)。损坏/缺失静默回到缺省;删文件即恢复出厂。
- **`input-history.json`** — 输入框历史(上限 1000 条,Ctrl+P/N 翻阅)。
  内容为用户输入原文——介意隐私时删除该文件即可清空。

### `/config` 面板

`/config` 打开设置面板。终端段始终在最前;空的宿主段不渲染。

- **终端**:系统通知开关(`●` 开 / `○` 关)与紧凑渲染。空输入按 `n` 切通知、
  `d` 切密度(写入 `prefs.json`);或 `/config notify` / `notify on` / `notify off`。
  `DSH_TUI_SKIP_NOTIFY` 锁定时通知显示关且不可切,`d` 仍可用。
- **宿主设置**:宿主 settings 服务 describe 输出(空则折叠)
- **权限预设**:组合了 `dsh-permission` 的 PermissionSelect;
  服务缺失时该段不渲染
- **凭据**:凭据状态(只显示存在性,不显示明文;空则折叠)

### 常用运行时设置命令

| 命令 | 作用 |
|---|---|
| `/theme [name] [default]` | 切换主题(Enter/带参=本会话; S 或末尾 `default`=启动默认) |
| `/density [default]` | 切换紧凑渲染(开关=本会话; `/density default`=启动默认) |
| `/model [target] [effort] [default]` | 查看/切换模型(Enter/带参=本会话; S 或 `default`=启动默认) |
| `/effort off\|high\|max\|auto\|default` | 推理等级(带参=本会话; S 或 `default`=启动默认) |
| `/preset [name] [default]` | 切换 agent 预设(带参=本会话; 末尾 `default`=新会话启动默认) |
| `/yolo [on\|off]` | 全放行模式(等价 Shift+Tab 进 always-approve) |
| `Shift+Tab` | 模式循环:normal → plan → always-approve |

### 配置持久化

- 模型/effort 的启动默认经 `agentDefaultModel.saveSelection` 写入(选择器 S 或
  命令末尾 `default`);带参切换只热切当前会话。always-approve 是会话级本地态,
  切换/退出时复位。
- 会话恢复时,输入框历史、会话列表来自宿主持久化(`sessionPersistence`)。
