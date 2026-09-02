# 交互手册

dsh-tianshu-tui 的全部交互:快捷键、命令、输入面与交互面板。

## 快捷键

### 会话与全局

| 按键 | 作用 |
|---|---|
| `Ctrl+N` | 新会话 |
| `Ctrl+S` | 恢复最近会话 |
| `Ctrl+Q` | 退出(同 `/exit`;Ctrl+C 连按两次也可退出——有草稿时第一次清空草稿再按一次退出,打断中第二次直接退出) |
| `Ctrl+.` | 键位表 overlay(随时呼出) |
| `Ctrl+P` | 命令面板(模糊搜索 + Enter 回填) |
| `Ctrl+F` / `Ctrl+R` | 历史搜索(输入即过滤;`Enter` 确认后 `n`/`N` 下一个,`p`/`P` 上一个) |

多会话切换走 `/session list|switch`(或 `Ctrl+S` 恢复最近)。

### 输入

| 按键 | 作用 |
|---|---|
| `Ctrl+E` | 用 `$EDITOR` 打开输入行(可经 `editorKey` 配置) |
| `Ctrl+T` | 中轮转向(不中断地纠正方向) |
| `Ctrl+Enter` | 插队:打断当前回合并立即发送草稿(cancel-and-send;需终端支持 kitty 键盘增强协议,`RIVET_KITTY_KEYBOARD=1` 可强制开启) |
| `Ctrl+V` | 粘贴剪贴板图片(无图时回退剪贴板文本) |
| `Alt+W` | 把选区复制到系统剪贴板(OSC52) |
| `Tab` | `@`-路径补全;接受 slash 菜单选中项 |
| `↑`/`↓` | 输入历史(slash 菜单打开时为选择;有排队消息时空输入 `↑` 取回队首) |
| `→`(光标末尾) | 接受历史建议 ghost(fish 式:输入前缀匹配最近历史条目的剩余部分,dim 显示;`/` 开头走 slash ghost 优先;`ghostSuggest` prefs 可关) |
| `PageUp`/`PageDown` | slash 菜单翻页;长草稿输入视窗翻页 |
| `Esc` | 关闭菜单/overlay/检查面板;取消挂起提问 |

### 回复与工具

| 按键 | 作用 |
|---|---|
| `Ctrl+C` | 打断在途回合(即时) |
| `Esc`(在途) | 打断在途回合(对齐 Claude Code 单次 Esc;lone ESC 80ms 防误触——单独 ESC 字节刷新超时 `escapeTimeoutMs` 缺省 80ms,见 `input-handler.ts`;overlay/菜单/检查面板打开时仍先关闭) |
| `Esc`(检查面板) | 关闭 `/config` `/skills` `/status` `/lsp` `/tasks`(有草稿也关,不布防 rewind) |
| `Esc`+`Esc`(空闲) | 打开 rewind 回退面板(Claude Code 的 Esc+Esc 时间回溯;1s 双击窗口,同 `/rewind`;第一下布防时提示「再按 Esc 打开 rewind」;打断在途后 1s grace 期内不布防防误触) |
| `Ctrl+O` | 展开/收起最近推理块 |
| `Enter`(空输入) | 切换最后一张进行中工具卡的展开(显示参数 JSON) |
| `Shift+Tab` | 模式循环:normal → plan → always-approve |

输入轨上方默认是统一活动带(`◐ N 子代理 · M 工作流` + 每项一行统计,封顶 `activityBandMaxRows`):子代理结束塌成 `✓ {label} · N 工具 · X tok · 12s`,工作流结束再提交一行摘要。`activityBand: false` 回退为每条运行中子代理一行 spinner。

### 交互面板

| 按键 | 作用 |
|---|---|
| `y` | 审批卡:允许一次 |
| `p` | 审批卡:此命令前缀不再问(仅 bash 类工具;本会话内同前缀命令自动放行) |
| `t` | 审批卡:记住此工具(本会话内该工具自动放行) |
| `a` | 审批卡:本会话放行(always-approve + 结算当前请求) |
| `n` | 审批卡:拒绝 |
| `f` → `Enter` | 审批卡:拒绝并说明(反馈文本经 steer 投递给 agent;Esc 返回选项) |
| `Esc` / `Ctrl+C` | 审批卡:取消 |
| `f` → `Enter` | plan-review 反馈模式(Keep planning + 自定义反馈) |
| 数字键 | 结构化提问面板选项 |
| 选择器中:`↑`/`↓`(j/k)选择、`Enter` 应用(本会话)、`S` 设为默认、`Esc`/`q` 关闭 | `/model` `/theme` `/effort` 选择器(会话/`/key` 选择器无 S) |
| 会话列表:按今天/昨天/本周/更早分组后逐行打印 | `/session list` |
| 会话选择器:`↑`/`↓` 滚动(跳过分组头) | `/session` 无参选择器(今天/昨天/本周/更早 + 标题/相对年龄，不分页) |

## 命令全表(40 条)

### 会话

| 命令 | 作用 |
|---|---|
| `/session new\|list\|switch <id>` | 会话管理(无参打开会话选择器) |
| `/fork [directive]` · `/branch` | 分叉当前会话(历史复制到新子会话) |
| `/rewind` | 两阶段回滚(会话截断 + 可选文件回退) |
| `/export [path]` | 导出转录为 Markdown |
| `/scroll` | 分页查看器:全文浏览转录(↑↓/PgUp/PgDn 滚动、实时搜索、`n`/`N` 跳转、`g`/`G` 首尾) |
| `/clear` | 清空滚动区视图 |
| `/compact` | 压缩会话上下文(需 compact 服务) |

### 模型与模式

| 命令 | 作用 |
|---|---|
| `/model [target] [effort] [default]` | 查看/切换模型(无参打开选择器; Enter=本会话, S 或末尾 `default`=启动默认; 别名 `spark-flash`/`spark-pro`) |
| `/effort off\|high\|max\|auto\|default` | 设置推理等级(无参打开选择器; Enter/带参=本会话, S 或 `default`=启动默认; `auto` 回模型默认) |
| `/preset [name] [default]` | 查看/切换 agent 预设(列出每套的能力与工具集; footer/顶栏显示当前短名; 带参=本会话整套 agent 面; 末尾 `default`=新会话启动默认; 仅空白会话可换; 别名 `ptc`→code、`creative`→cordis) |
| `/yolo [on\|off]` | 全放行模式 |
| `/density [default]` | 切换紧凑工具卡渲染(开关=本会话; `/density default`=启动默认) |
| `/glance [segment]` | 切换 footer metrics 段显隐(如 `/glance cost`;无参查看现状) |
| `/info` | 切换输入区信息密度: `full` 两行(状态行+指标行, 缺省) / `compact` 仅状态行 / `off` 全关; 持久化 |
| `/vim [on\|off\|default]` | 切换 vi/vim 编辑键位(`default` 写入启动默认) |
| `/welcome [blue\|star\|retro]` | 切换欢迎页风格(blue 蓝鲸抱星+艺术字标题,缺省 / star 紫鲸举星 / retro 复古小鲸鱼; 无参查看当前; 下次启动生效) |

### 认证

| 命令 | 作用 |
|---|---|
| `/key` · `/login` | 配置模型供应商 API 密钥(选择供应商 → 掩码输入 + 联网验证,保存即生效;`/login` 为别名) |

### 面板

| 命令 | 作用 |
|---|---|
| `/status` | 状态面板(goal/todos/plan 投影 + 会话汇总) |
| `/todos [all]` | 待办卡画在输入轨上方(无参显隐; `all` 看全表)。默认列出进行中置顶的最多 5 条;全完成缩回一行。模型首次写入非空待办会自动出现;关掉或 `/clear` 后本会话不再自动开 |
| `/config [notify [on\|off]]` | 设置面板(终端通知/密度置顶;空输入 `n`/`d`。检查面板互斥,Esc 关闭) |
| `/skills` | 技能浏览(空输入 ↑↓/j/k 展开选中详情) |
| `/tasks [kill <id>]` | 任务窗格 |
| `/goal` | 目标管理(创建/暂停/恢复/完成/阻塞) |
| `/subagents` | 委派树活区卡(进行中第二行、失败态;宿主有外部 run 时追加「⤷ 外部子代理」) |
| `/workflow` | workflow 运行面板(roster 在 childId 命中委派树时追加子会话 label / 运行态) |
| `/lsp` | LSP 诊断面板 |

### 记忆与诊断

| 命令 | 作用 |
|---|---|
| `/remember <text>` | 保存一条项目记忆 |
| `/memory [delete <id>]` | 记忆浏览器 |
| `/btw <question>` | 向后台 agent 侧问 |
| `/doctor` | 终端诊断 + 修复指引 |
| `/mcp [tools <name>]` | 列出 MCP server 与工具 |
| `/help [cmd]` | 命令帮助(无参打开命令面板分组浏览+过滤; `/help <cmd>` 单条详情) |
| `/changelog [all\|N]` | 版本更新内容(默认当前版本; `all` 全部; `N` 最近 N 版; 自动更新提示后查看本次改了什么) |
| `/cost` | 当前会话累计用量与成本估算(按模型分桶) |

### 其他

| 命令 | 作用 |
|---|---|
| `/theme [name] [default]` | 切换主题(无参打开选择器,含 `custom:`; Enter/带参=本会话, S 或末尾 `default`=启动默认);`auto` 随终端明暗;`export [name]` 导出当前主题为自定义模板 |
自定义主题(`~/.dsh-tui/themes/*.json`)加载时按声明背景做对比度警告(WCAG < 3.0,不阻断);`NO_COLOR` 显式压制全部主题色输出。
| `/steer <text>` | 中轮转向 |
| `/restart` | 重启当前 dsh 进程(同命令重新启动;插件更新后生效) |
| `/update` | 检查插件更新(对照 npm latest,只查不装;发现新版给出更新命令) |
| `/exit` | 退出 TUI |

## 输入面

- **Slash 菜单**:输入 `/` 打开;模糊前缀匹配、MRU 排序、Tab 接受、Enter 提交、
  参数 ghost 预览。**userInvocable 技能也进菜单**(`🧭` 标记,数据源 `ctx.skills.list`
  按 `invocation.userInvocable` 过滤;技能目录变化经 `skills/change` 事件自动刷新)。
  空输入框 `Tab` 打开的命令菜单(`/` 全集)同样包含技能条目。
- **技能手势**:消息文本中任意词边界的 `/技能名`(kebab-case,如 `/find-skills`)由
  harness 的 tool-skill 钩子识别为「用户显式技能调用」——命中 userInvocable 技能时
  其指令体注入当轮上下文(转录侧显示为 `🧭 使用技能: <name>` 摘要行),未知名保持
  普通文本。提交 `/技能名` 不会落「未知命令」;已知命令优先于同名技能(命令命名
  空间客户端先行解析)。
- **@ 引用**:`@` 触发路径补全(Tab),提交时展开为文件摘要(@mention),带 cwd 边界
  与截断降级。
- **图片粘贴**:`Ctrl+V` 或终端菜单粘贴;超大图提交前自适应压缩(长边 1568px 封顶,
  逐级 JPEG 降质)。
- **多行输入与 bracketed paste**:粘贴多行/长文本整段进输入行,不逐行提交。
  长草稿编辑:输入视窗最多 16 行(超出折叠「… 上/下 N 行」),`↑↓` 按软折行
  移动、`PageUp/Down` 翻页、`Home/End/Ctrl+U/K` 以逻辑行为范围;超过
  100 行/10000 字的超大粘贴收纳为 `[paste #N]` 标记(提交时展开)。
- **Vim 键位**:可选(`vimEnabled`);Alt+W/yank 经 OSC52 复制选区。光标随模式区分:NORMAL 反色块、insert 竖线(#55;ASCII 档 `|`)。insert 两键序列→Esc(`vimInsertRemaps`,如 `{"jj":"esc"}` 写入 prefs;1 秒窗防误触)。
- **运行中排队(对标 CC queue)**:agent 运行时提交进输入轨上方本地队列(立即回显不直发);回合结束按序投递,中断不投递;空输入 `↑` 取回队首;切会话丢弃并回显。即时纠偏走 `/steer`/`Ctrl+T`;`Ctrl+Enter` 插队(先打断再发,需 kitty 键盘增强)。

## 交互面板

- **审批卡**:挂起审批内联 diff 预览;工具可 diff 时红绿渲染,bash 类附 `$ 命令`
  预览与危险模式标注(只警示不拦截),不可见时盲批提示。决策梯度:`y` 允许一次 ·
  `p` 此命令前缀不再问(仅 bash 类) · `t` 记住此工具 · `a` 本会话全放行 ·
  `n` 拒绝 · `f` 拒绝并说明(文本经 steer 投递;Esc 返回) · `esc` 取消;
  非当前会话请求委托下一个监听者。
- **提问面板**:数字键选择、Esc 取消、重叠保护;plan-review 反馈模式(反馈走输入行,光标编辑/粘贴完备)。决策卡带 dim 分隔线与主操作 success 高亮(❯ 批准项)。
- **错误时刻可行动**:agent 错误完整落底并附恢复指引尾注(401→`/key`、超长→`/compact`、超时→`↑`);输入行为空时自动回填最近一条已投递消息,`↩` 提示行告知「可能未被完整处理」——改一下回车即可重发(成功回合清底料,有草稿不抢写)。
- **选择器(issue #31)**:`/model` `/theme` `/effort` `/session` 无参打开,当前值 ● 高亮,
  启动默认 ★。`/model` `/theme` `/effort`：Enter 仅本会话, S 应用并写启动默认。
  会话与 `/key` 选择器不加 S。**主题选择器支持实时预览**:↑↓ 移动即切换主题,
  Enter 落定(不写 prefs)、S 写启动默认、Esc 还原打开前主题。
- **命令面板(Ctrl+P)**:命令模糊搜索 + 子序列匹配,按域分组浏览(会话/配置/认证/面板/技能/系统),Enter 回填 `/cmd `。
- **键位表(Ctrl+.)**:完整快捷键清单,随时呼出。
- **历史搜索(Ctrl+F / Ctrl+R,vim NORMAL `/`)**:两阶段——编辑段输入即过滤(所有字符含 n/N 都进搜索词,#55),`Enter` 确认进跳转段(`n`/`N` 下一个、`p`/`P` 上一个、再按 `Enter` 回编辑段);命中词行内反色高亮。

## Overlay 体系

全屏 overlay(命令面板、键位表、历史搜索、rewind、记忆浏览器、分页查看器、选择器)共享同一套
生命周期:打开进 alt screen、Esc/Ctrl+C 关闭、关闭后补写暂存 scrollback。流式输出
不会盖住打开的 overlay。
