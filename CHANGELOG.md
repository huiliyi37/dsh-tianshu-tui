# Changelog

版本更新记录。安装与当前版本见 [README](README.md)；完整历史在此。
`/changelog` 在 TUI 内查看（默认当前版本，`/changelog all` 全部，`/changelog N` 最近 N 版）。

## [0.1.2-rc.30] - 2026-09-12

宿主线上到 0.1.5（官方 `latest` 已于 09-11 切到 0.1.5-rc.1，#57 同期）。

### 宿主 0.1.5 线适配

- **依赖钉线** — 52 个 `@deepseek-ai/dsh-*` peer `^0.1.5-rc.1` / dev `^0.1.5-rc.2`（`dsh-agent-presets` 精确钉同步；spine demo 夹具仍钉 alpha.2）；新增 `dsh-http-proxy`（dsh-subprocess rc.2 直连依赖）
- **流式事件改批** — `assistant/chunk` 逐 delta 事件被移除，改 `assistant/attempt` 批量事件：transcript 折叠 / btw 答案收集 / live 流式三处经官方 `expandAssistantStream` 展开，语义不变；btw 面板对即时完成（无增量事件）的回合回退读 `assistant/message` 正文
- **sessionPersistence 契约适配** — `list()` 返回 `{header,…}` 快照（不再是裸 header），`inspect`/`readFrom` 被 `open(id,'read')` + `handle.read()` 取代：适配层在 seam 内翻译，消费方零改动；`locate` 透传
- **真机防御** — 跨格式混合库中 `createdAt` 缺失的行不再让 `/session list` 崩 `Invalid time value`、欢迎页不再渲染 `NaN-NaN-NaN`（渲染「未知时间」）
- **组合测试** — llm-replay 夹具升 v3 格式（session header 必填、attempt 事件、空文件拒绝）；组合 spec 补 `dsh-http-proxy` 模块
- **e2e 加固** — artifact 匹配 `session*.jsonl.zstd`；注入占位 key 防 0.1.5 key-flow 弹窗吞键入

### 真机验证

vendor/dev 宿主 0.1.5-rc.2：pty e2e 全绿（启动、v3 zstd 持久化、/session list、16 会话、选择器、同目录重启复用、跨目录 artifact 清理）；typecheck 0；root 2716/2716 + vision-ask 32/32（`--no-file-parallelism`）。

## [0.1.2-rc.29] - 2026-09-09

欢迎页三模式 + 宿主线 0.1.2-rc.1 适配。

### 宿主线 0.1.2-rc.1 适配（官方 2026-09-03 发布，`next` 标签）

- **依赖钉线整体切换** — 52 个 `@deepseek-ai/dsh-*` peer/dev 依赖 `^0.1.1-rc.2 → ^0.1.2-rc.1`（`dsh-agent-presets` 精确钉同步；spine demo 夹具钉 alpha.2——rc 线无发布）；cordis `^4.0.2` / include `^1.0.7` / loader `^1.0.3` / timer `^1.1.4` / schemastery `^3.18.2`；新增 `dsh-util-values`（JsonValue 新家）
- **Session.events getter 移除适配** — 约 10 处调用点（导出/摘要/transcript 重放/fork seed/btw seed/wire 工具名等）改走 `snapshotEvents()`；fork 血缘参数从 `meta.seedLength` 改为 `meta.isSeeded` + 顶层 `inheritedEventCount`（`/fork`、`/branch`、`/btw` 三路径）
- **userQuestions waterfall wire** — `registerProvider` 已被官方移除，改挂 `ctx.on('user-questions/request')` answerer 并以 `{ global: true }` 注册（事件为 scope-filtered，TUI 插件 fiber 不在任何 agent 作用域链上，global 是唯一全局收口；重叠请求沿用 ASK_CANCELLED）
- **CallId → ToolCallId** — dsh-llm 根导出改名，22 文件类型跟随
- **preset 目录 PTC 更名** — 官方 id `code → ptc`（`/preset code` 经别名折到 `ptc`），别名表翻转
- **todo/write 本地类型合并** — 事件类型声明随官方 dsh-tool-todo 外移出核心 SessionEventMap，statusline 工作流相位本地合并同款结构
- **宿主线守卫（fail-loud）** — attach 探测 `Session.prototype.snapshotEvents`：旧宿主（≤0.1.1-rc.2）启动即报错并给出升级官方 CLI / 回退插件的可行动指引，绝不在会话路径深处炸 TypeError
- **组合测试线适配** — 三个 real-spine 组合显式装配 `agent-loop` 插件（factory 注册不再由 spine demo 代办）；`tests/spine-events-compat.ts` 给停在 alpha.2 的 spine demo 桥一层 `Session.events → snapshotEvents()` 垫片（官方发 rc 线 spine 后移除）；组合测试提问场景补 `request.agent` 载体
- **bundle patch 补 subagent-model-selection-settings** — rc.1 起 standard preset 的 tool-subagent 行开 `modelSelectionSettings: true`，要求 Host scope 有该服务（官方 web-app 有、dsh-base 无），不挂则 standard 挂载整体失败、会话无工具面（shipped 组成默认关）
- **真机验证** — vendor/dev 宿主重建到 0.1.2-rc.1（`node_modules.rc2-bak` 可回滚），pty e2e 全绿：启动、会话持久化、/session list/选择器、同目录重启复用、空会话 artifact 清理

### 欢迎页三模式

blue「蓝鲸抱星 + 艺术字大标题」默认登场，star「紫鲸举星 + 艺术字标题」与 retro 复古小鲸鱼可切换。

- **blue 新版欢迎页（默认）** — 左：品牌像素画（蓝鲸抱星，水面倒影/气泡/腮红粉构图，44×34 索引像素自 9-02 品牌原图经生成管线产出（44 列 = omts 同款上限：块字符在 ambiguous 宽渲染终端占 2 列，88 列内不折行）——边缘洪泛抠图 + 逐格统计采样（覆盖率掩码保细线条 + 格内中位色抗噪），`scripts/generate-welcome-blue.mjs` → `format/whale-blue-frames.ts`，median-cut 9 主色 + 锚定 6 关键色（星核/星金/腮红粉/白肚/身体主蓝/高光蓝）15 色板；精细化后处理（8 邻填洞修采样裂缝、最深色中段簇定位眼睛补高光点）；half-block 实色双拼渲染（渐变图不用盲文点阵——混色格亮点归前景点/暗点归背景即成麻点，omts 渲染默认 half 档同理），背景透明、品牌固定色）；右：figlet ANSI Shadow 艺术字标题块（`DeepSeek` + `< Harness >` 纯文本副标，ANSI Shadow 64 / Standard 44 / Mini 33 三档随右栏宽度伸缩，`scripts/generate-welcome-title.mjs` 生成期固化）+ `@tianshu` 贡献者标识行（附版本号）+ 环境行 + Tips。鲸鱼以品牌块为锚垂直对齐
- **star 紫鲸欢迎页（可切换）** — 同一 hero 布局（`format/welcome.ts` 共享像素画 hero 核）：紫罗兰鲸鱼托举光晕金星（8-22 品牌原图字幕带已切除，`scripts/generate-welcome-star.mjs` → `format/whale-star-frames.ts` 同款管线）+ figlet Standard/Mini 艺术字标题块（`DeepSeek»` + `< Harness >`）
- **`/welcome [blue|star|retro]` 切换 + prefs `welcomeStyle` 持久化** — 无参查看当前风格；带参落盘下次启动生效（欢迎页启动时已 commit 进 scrollback，运行中不重渲染）
- **降级链** — blue/star 门禁（分别 ≥82/≥83 列宽、≥24 行高、有色、非 legacy 全角档）不满足时整体回落 retro 现行为；窄屏/矮屏/无色终端观感与此前逐字节一致
- **共享像素渲染核** — `format/pixel-grid.ts`（半块 blitter：whale 复古画与 whale-star/whale-blue 共用，retro 画逐字节不变）；三条生成管线（`generate-welcome-blue.mjs` / `generate-welcome-star.mjs` / `generate-welcome-title.mjs` → 对应 `format/*-frames.ts` 生成物）

## [0.1.2-rc.28] - 2026-08-29

回应 [#55](https://github.com/huiliyi37/dsh-tianshu-tui/issues/55) 的 vim 模式优化一轮 + 细节复盘三连。

- **vim 光标形态分模式（#55-1）** — NORMAL 反色块（原字符反色，#50 语义）、insert 竖线（占格不吞字符，ASCII 档 `|`）；空值占位/折行/行尾三路径全覆盖，非 vim 行为逐字节不变
- **历史搜索两阶段输入（#55-2）** — 编辑段所有字符（含 n/N/p/P）都进搜索词——此前搜索词打不出 n/N；`Enter` 确认进跳转段（`n`/`N` 下一个、`p`/`P` 上一个、再按 `Enter` 回编辑）；搜索栏显式标注「搜索会话历史」防语义误解
- **搜索命中子串高亮** — 历史搜索与 `/scroll` 命中行内查询词反色包裹（ANSI 感知纯函数：转义序列不参与匹配、位置经 plain 投影映射，转录行原样保留）
- **消息投递失败自动回填** — 发送失败/排队投递失败时失败文本自动填回输入行（`↩` 告知、有草稿不抢写），失败→改→重发闭环
- **README 键位表一致性守卫** — 架构守护新增规则：registry 键位投影必须与 README 快捷键表一致（落地即抓到 Enter/Shift+Enter/Ctrl+U 三行漏登记，已补）

## [0.1.2-rc.27] - 2026-08-29

回流 Tianshu Harness（opencode-tui/revit）UX 审计波中两项适配本仓架构的优化：错误时刻可行动 + 决策卡视觉分层。

- **错误后自动回填上一条消息（ErrorAnnouncer）** — agent 错误在完整落底 + 恢复指引尾注之外，把最近一条已投递消息自动填回输入行并附 `↩ 可能未被完整处理` 提示——改一下回车即可重发；生命周期完整：直发与排队 flush 投递时记录、成功回合清除、有草稿不抢写、取走即清防双份（渲染错误块顺势 C4 提取为 `controllers/error-announcer`）
- **plan-review 决策卡视觉分层（轻量适配）** — 选项与键位提示之间加 dim 决策区分隔线；approve 主操作升 `❯` 前缀 + success 着色（BOLD 保留）；主题可选注入，不传时渲染逐字节不变——解决「审批按钮淹没在正文里」
- 筛选说明：上游 choice-panel 输入子模式修不回流（本仓提问反馈走真实 InputLine，光标/粘贴原生完备）

## [0.1.2-rc.26] - 2026-08-28

P1 交互打磨六连：Esc 分层收尾、拟人 spinner 词库、footer 显式分级降级、错误恢复指引、定高视口强化、fish 式历史建议。

- **Esc 语义分层收尾** — 打断在途后 1s grace 期内双击 Esc 不误开 rewind；首次按 Esc 布防时显示「再按 Esc 打开 rewind」提示行（与 Ctrl+C 布防提示同源）
- **glance 状态行拟人动词池** — running 回退文案从静态「● 运行中」改为 14 词 4s 时间片轮换（沉思中/琢磨中/腌制中/施法中…，池首恒「思考中」，reducedMotion 冻结语义不变）；清理无调用方的 formatSpinnerStatus
- **footer 行 1 显式分级降级** — 窄终端下审批 hints 先走长→短中间档再按 esc→f→n→a→p→t 位次丢段（y 恒留）；右段 rightSegments 升级 `{text, priority}` 显式丢序（git ●N 最次要先丢的隐式约定显式化）
- **错误恢复指引** — 每个错误都附下一步操作：echoWarn 支持 `↳` 尾随行；agent 错误按模式识别附 `/key`（401/鉴权）、`/compact`（上下文超长）、`↑ 重发`（超时/网络）；消息发送失败/会话切换失败/服务不可用族全部接线；主题加载警告从 stderr 收进 TUI 附 `/theme` 指引
- **定高视口强化** — todos/提问/审批卡并入 slashRows 高水位记账先例：chrome 开合不再让输入轨跳一格（帧级测试锚定）；vim 标签/附件/排队行评估后不纳入
- **fish 式历史建议 ghost** — 输入前缀匹配最近历史条目，剩余部分 dim 上屏；`→`（光标末尾）接受整条，键入即弃；`/` 开头 slash ghost 优先；vim normal/选区/光标不在末尾抑制；prefs `ghostSuggest` 可关
- **`/scroll` 上限可配** — prefs `scrollbackMaxLines`（缺省 1000 不变），调高增加内存与回放成本

## [0.1.2-rc.25] - 2026-08-28

P0 交互三连：键位/命令/提示统一 action registry、审批卡六档决策梯度、运行中消息排队与 Ctrl+Enter 插队；另含 /scroll 分页查看器、完成响铃、vim remap、主题对比度校验。

- **统一 action registry** — 键位/命令/提示单一事实源（`src/actions/`）：动作表 + 同域冲突校验 + 双击确认集中布防；handleKey 约 460 行 if 链收敛为约 40 行流水线；8 个 overlay 键路由统一收敛范式；键位表、命令面板分组、footer 提示三处从注册表同源投影，新增键位只改一处。app.ts 棘轮 4359→4140
- **审批卡六档决策梯度** — `y` 仅此一次 → `p` 此命令前缀不再问（仅 bash 类可提取命令时出现）→ `t` 此工具本会话 → `a` 全放行 → `n` 拒绝 → `f` 拒绝并说明（反馈经 steer 旁路送达 agent）；bash 审批告别盲批：`$ 命令` 预览 + 危险模式标注（`rm -rf` / `curl|sh` / fork bomb 等，只展示不拦截）
- **运行中消息排队 + 收回 + 插队** — turn 运行中发送进本地队列（输入轨上方可见），turn/end 按序投递，中断不清队；空输入 `↑` 收回队首重新编辑；`Ctrl+Enter` 插队（cancel-and-send：打断在途 + 保留队列 + 落定直发，终端需支持 kitty 键盘协议，`RIVET_KITTY_KEYBOARD=1` 可强制）；手动打断改传 `keepInbox` 不再清宿主 inbox 残留
- **`/scroll` 分页查看器** — scrollback 全文按消息单元只读浏览：↑↓/jk、PgUp/PgDn、g/G、实时子串搜索 + n/N 跳转、位置状态行
- **完成事件终端 BEL 响铃** — 子代理/工作流/后台任务完成响铃，SSH 下同样可达（BEL 穿透 pty）；共享系统通知偏好与 CI/测试门闸
- **vim insert 两键序列 → Esc** — 对标 Claude Code `vimInsertModeRemaps`（如 `jj`，1 秒窗 + 光标连续性双校验防误删）；另补 `Ctrl+R` 历史搜索别名
- **自定义主题 WCAG 对比度校验 + NO_COLOR 规范** — 主题加载时按声明背景档位近似校验对比度，低于阈值警告不阻断；支持 `NO_COLOR` 环境变量压制颜色
- **C4 第三波** — composer 附件缩略图域抽成 `controllers/attachment-preview`（app.ts 继续减重）

## [0.1.2-rc.24] - 2026-08-27

vi/vim 编辑模式完整落地（[#51](https://github.com/huiliyi37/dsh-tianshu-tui/issues/51)）+ 内置 LSP 三件套的 profile 装配修复（[#54](https://github.com/huiliyi37/dsh-tianshu-tui/issues/54)：启动崩溃 ERR_MODULE_NOT_FOUND）。

- **vi/vim 编辑键位完整支持（[#51](https://github.com/huiliyi37/dsh-tianshu-tui/issues/51)）** — 输入行 Esc 进 NORMAL（底部 `-- NORMAL --` 标签，insert 态隐藏），键位表对标 Claude Code interactive-mode：`h j k l Space`、`w e b W B E`、`0 $ ^`、`gg G`、`f F t T ; ,` 导航与查找重放；`d c y × motion` + 数字前缀（`2dd` / `3w` / `2fa`）；文本对象 `iw aw iW aW`；行级 `dd cc yy Y` 与 `p P` 行级粘贴；`x X D C s S r o O J u` / `Ctrl+R`；`.` 重放上一条变更（o/C/cw 等进入插入段的连打一并复现）。visual `v/V` 选区两端含光标下字符（vim 归属语义）。多行草稿 j/k 保持列移动，单行边缘翻历史；词类口径 `\w + CJK`——中文连续段成词不逐字跳
- **`/vim [on|off|default]` 运行时开关 + 启动默认持久化** — 无参切换、带参定向；`default` 写入本地 prefs（重启仍生效）；宿主显式传入 `vimEnabled` 配置时优先于 prefs。NORMAL 态 `/` 打开历史搜索 overlay（同 `Ctrl+F`）
- **内置 LSP 三件套依赖闭包补齐（[#54](https://github.com/huiliyi37/dsh-tianshu-tui/issues/54)）** — rc.23 起三件套把运行时依赖声明为 peerDependencies，pnpm `autoInstallPeers:false` 下不会自动补装，启动即 `ERR_MODULE_NOT_FOUND` 整树失败。现由 TUI 显式声明全部 `@huiliyi37/*` 运行时依赖（cordis / dsh-brand / dsh-llm / dsh-fs / dsh-subprocess / dsh-timeout / dsh-tools / dsh-scope / dsh-agent / dsh-attachment / dsh-code-runtime / dsh-sandbox / dsh-session / dsh-invariants / dsh-system-prompt，统一钉 0.6.0），并新增 bundle 契约守卫防再发


社区反馈[vim 编辑模式](https://github.com/huiliyi37/dsh-tianshu-tui/issues/51)：快捷键都用习惯了。

- **vi/vim 编辑键位完整支持（[#51](https://github.com/huiliyi37/dsh-tianshu-tui/issues/51)）** — 输入行 Esc 进 NORMAL（底部 `-- NORMAL --` 标签，insert 态隐藏），键位表对标 Claude Code interactive-mode：`h j k l Space`、`w e b W B E`、`0 $ ^`、`gg G`、`f F t T ; ,` 导航与查找重放；`d c y × motion` + 数字前缀（`2dd` / `3w` / `2fa`）；文本对象 `iw aw iW aW`；行级 `dd cc yy Y` 与 `p P` 行级粘贴；`x X D C s S r o O J u` / `Ctrl+R`；`.` 重放上一条变更（o/C/cw 等进入插入段的连打一并复现）。visual `v/V` 选区两端含光标下字符（vim 归属语义）。多行草稿 j/k 保持列移动，单行边缘翻历史；词类口径 `\w + CJK`——中文连续段成词不逐字跳
- **`/vim [on|off|default]` 运行时开关 + 启动默认持久化** — 无参切换、带参定向；`default` 写入本地 prefs（重启仍生效）；宿主显式传入 `vimEnabled` 配置时优先于 prefs。NORMAL 态 `/` 打开历史搜索 overlay（同 `Ctrl+F`）

## [0.1.2-rc.23] - 2026-08-27

LSP 三件套对齐 tianshu-public 0.6.0 官方 seam 线（修正 rc.22 误挂的旧构建线）+ 宿主线上对齐。

- **LSP 三件套** — `@huiliyi37/dsh-lsp`（ctx.lsp seam 注册表）+ `dsh-lsp-local`（stdio provider，默认 typescript-language-server npx 条目、懒启动）+ `dsh-tool-lsp`（单 `lsp` 工具四操作：goto-definition / find-references / goToImplementation / hover）；无 provider 时查询返回结构化 `LSP_UNAVAILABLE`，schema 稳定
- **诊断源能力门控** — 新增 `selectDiagnosticSource`：query 形状服务仅在声明支持 getDiagnostics 时才采纳为 `/lsp` 面板数据源，否则回落内置 multi-manager（修复 seam 盲采导致面板永久空的回归）
- **宿主线上对齐** — peer/dev 全量 `^0.1.0-rc.8 → ^0.1.1-rc.2`（官方 next/latest 已是 0.1.1-rc.2），补齐新线拆分包 devDeps 闭包（timeout / atomic-write / home-paths / settings 等 20+，实装后 2444 用例全绿——无 API 漂移）
- ⚠ 升级自 rc.22 的用户无需手动操作（依赖行自动切到 0.6.0 线）；单独装过旧社区版 `github:omdsh-dev/dsh-lsp` 的请先 remove


## [0.1.2-rc.22] - 2026-08-27

LSP 模型工具面随包内置：装 TUI 一个包即得展示桥 + 模型工具面，不再单独装配社区插件。

- **LSP 模型工具面内置（伴生包 `@huiliyi37/dsh-lsp@0.1.0-rc.1`）** — `lsp_goto_definition` / `lsp_find_references` / `lsp_diagnostics` 三个只读模型工具经 bundle patch 自动挂载；`provide('lsp')` 服务由 TUI 展示桥直接消费（single server set 不双份 spawn，诊断源探测顺序不变）。⚠ 旧社区版（`github:omdsh-dev/dsh-lsp`）与内置版二选一：升级用户请先 `plugin remove` 旧版再更新，同时装配会重复注册同名模型工具
- **根 lockfile 清理** — 移除 37 个历史孤儿宿主链条目（`npm ci --dry-run` 验证一致）


## [0.1.2-rc.21] - 2026-08-27

社区反馈三连修：光标体验、更新后 preset 缺省、SSE 畸形载荷根因定位。

- **输入框光标反色化（[#50](https://github.com/huiliyi37/dsh-tianshu-tui/issues/50)）** — 行中光标改为原字符反色高亮，不再插入占位块 █：移动光标不再推移左右字符，中文宽度守恒（旧实现占 1 格，CJK 帧还会缩行）；行尾无字符时保留块 █；选区覆盖光标格不嵌套包裹；IME 硬件光标锚定契约不变
- **preset 缺省 standard（[#48](https://github.com/huiliyi37/dsh-tianshu-tui/issues/48)）** — 新会话与旧会话恢复未指定预设时插件侧显式 mount `standard`，不再依赖 bundle patch 的 `config.default`（旧 profile 装配会忽略该键，更新后新会话直接进入无工具面 agent）；`agent-presets` 服务缺失时启动即 ⚠ 提示重装命令，不再静默跳过
- **malformed SSE payload 根因定位（[#49](https://github.com/huiliyi37/dsh-tianshu-tui/issues/49)）** — 缺陷在宿主包 `dsh-llm-deepseek`（最新 0.1.1-rc.2 仍在）：SSE 翻译层把空值 `data:` 心跳帧当 JSON 解析即抛，大上下文恢复会话的长静默窗口必现；已提交官方公测反馈仓 [dsh-external/issues#609](https://github.com/dsh-external/issues/issues/609)，等宿主发版解决


## [0.1.2-rc.20] - 2026-08-27

交互引导闭环版本：信息密度可调、新功能可发现、错误有纠错引导、更新内容可查。

- **输入区信息密度三档 `/info` + footer 两行分层** — 对齐 kimi-code：行 1 状态行（mode · 预设 · model · API · git），行 2 指标行（上下文/缓存/tokens/cost）；`/info` 循环 full / compact / off，持久化到 prefs
- **footer 提示 10s 轮播** — 空闲态提示按权重轮换（新功能优先），审批/检查面板等上下文态不轮播
- **命令面板按域分组** — Ctrl+P 按 会话/配置/认证/面板/技能/系统 分组浏览，外部插件命令归「其他」
- **欢迎页 Tips 动态化** — 未登录排首引导 `/key`；首次运行展示 `/help` 命令帮助面板引导（onboarded 一次性）
- **未知命令智能建议** — 笔误/歧义前缀给出相近命令（如 `/glans` → `/glance`），替代 40+ 命令刷屏
- **slash 空态提示** — 无匹配命令时提示「Enter 提交查看相近建议」，类路径输入不误报
- **/help 面板化** — 无参 `/help` 打开命令面板（分组浏览 + 过滤 + Enter 回填），`/help <cmd>` 单条详情保留
- **`/changelog` 版本更新内容** — 更新提示引导查看本次改了什么（默认当前版本，`all` 全部，`N` 最近 N 版）；CHANGELOG.md 从 README 拆出并随包分发
- **发布类型与守卫修复** — 相对导入统一 `.js` 扩展（发布 d.ts 不再引用不存在的 `.ts`）；README.i18n.yaml 哈希守卫


## [0.1.2-rc.19] - 2026-08-26

装本包即可 `/preset` 切换官方 shipped 面；列表写清每套能力与工具，footer 露出当前短名。

- **TUI 按 web 组 agent 面（[#47](https://github.com/huiliyi37/dsh-tianshu-tui/issues/47)）** — 本包 bundle 挂官方 `agent-presets` 并关掉 host agent 面；`plugin add` 本包即可 `/preset` 切换官方 shipped 预设，不必手改 profile `cordis.patch.yml`
- **`/preset` 补能力与工具集** — 标准 / PTC / 极简 / 创造各列一句话能力 + 工具行；footer 与欢迎顶栏显示短名；`ptc`/`creative` 是 `code`/`cordis` 的别名
- **glance 上下文占用条** — `上下文 N%` 后跟 8 格占用/剩余条（`▓`/`░`；ascii 回退 `[====----]`）
- **`/session` 按日历分组** — 选择器与 `/session list` 按今天 / 昨天 / 本周 / 更早分组；↑↓ 跳过分组头
- **系统通知** — 子代理 / 工作流 / 任务完成弹系统气泡（不打断 `turn/end`）；workflow 进行中不刷子代理完成通知；`DSH_TUI_SKIP_NOTIFY`、SSH、CI、测试环境静默
- **`/config` 终端段** — 面板置顶系统通知（空输入 `n`）与紧凑渲染（空输入 `d`，写入 `prefs.json`）；`/config notify [on|off]` 仍可用。无宿主设置/凭据不再占位
- **检查面板交互** — `/config` `/skills` `/status` `/lsp` `/tasks` 互斥（打开一项关掉其余）；`Esc` 先关检查面板（有草稿也关，不布防 rewind）；`/skills` 空输入 ↑↓/j/k 展开选中详情


## [0.1.2-rc.18] - 2026-08-26

待办卡离开思考区：挪到输入轨上方，默认列出条目。

- **待办卡贴输入轨上方** — 从 glance/思考上方挪到 chrome（活动带之下、提问/审批/输入轨之上）；小窗口从顶裁动态段时不再把待办裁掉，也不跟思考抢视线
- **默认列出条目** — 有进行中/待办时计数头 + 条目（进行中置顶），最多 5 条，超出 `└ …(+N)`；全完成仍一行；`/todos all` 看全表不封 5 条。计数头不再带 `· 当前项`


## [0.1.2-rc.17] - 2026-08-25

活动带与启动默认语义版本：子代理/工作流改走统一活动带，启动项区分「仅本会话」与「写默认」，待办首写自动弹卡，`/fork` `/branch` 修复。

- **子代理/工作流统一活动带** — 输入轨上方默认收敛为活动带（`◐ N 子代理 · M 工作流`）：进行中每项一行统计（封顶 `activityBandMaxRows`，默认 5，超限折叠为 `+N`），子代理结束塌成 `✓ {label} · N 工具 · X tok · 12s`，工作流结束再提交一行摘要；`activityBand: false` 回退为每条运行中子代理一行 spinner。`/subagents` 活区卡显示进行中第二行与失败态，宿主有外部 run 时追加「⤷ 外部子代理」；`/workflow` roster 在 childId 命中委派树时追加子会话 label / 运行态
- **启动项拆成「仅本会话」与「写默认」** — 选择器 Enter / 带参命令只热切当前会话；选择器按 `S` 或命令末尾 `default` 才写入 `prefs.json` 作为新会话启动默认（`/theme` `/model` `/effort` `/density` `/preset`）；回显点名差异，不再分不清默认与本会话
- **模型首次写入待办自动弹紧凑卡** — live 默认不画 todos 投影；模型第一次写入非空待办时自动弹出紧凑卡，手动关掉或 `/clear` 后本会话不再自动开
- **`/fork` `/branch` 修复** — 改用 `agents.create({ seed })` 一次铸 child，不再 resume live 子会话（官方 `persistence.prepare` 对已在内存的会话抛 `cannot prepare while it is live`，此前 fork 后必炸）


## [0.1.2-rc.16] - 2026-08-25

`/preset` 注入降级版本。

- **`/preset` 不再 `without inject`（[#46](https://github.com/huiliyi37/dsh-tianshu-tui/issues/46)）** — 未挂上 `agentPresets` 时，经 `reflect.get('agentPresets', false)` 读可选服务，回显「服务不可用」而不抛 `cannot get property "agentPresets" without inject`（与 `/compact` `/goal` 同款）；跟仓 `lib/index.js` 已对齐，`github:` 安装也会吃到修复。要真正启用预设，见上方「启用 agent 预设」：装包 **并且** 写入 profile `cordis.patch.yml`（[#47](https://github.com/huiliyi37/dsh-tianshu-tui/issues/47)）


## [0.1.2-rc.15] - 2026-08-25

手动更新 + 启动会话复用版本。

- **`/update` 手动更新检查** — 对照 npm `latest` 只查不装：发现新版本回显版本对与手动更新命令（`npx -y @deepseek-ai/dsh plugin --profile tui add @huiliyi37/dsh-tianshu-tui@latest`，或重启走启动自更新）；已最新回显当前版本；网络失败回显原因不抛。绕过 `DSH_TUI_SKIP_UPDATE`（显式要求检查时不尊重"不想联网"开关），复用启动自更新的 1h 缓存管线
- **启动复用空会话 id（社区 PR #45）** — 插件启动且 live store 为空时复用最近一个无内容会话的 id（不再每次铸造新 id），header.cwd 重绑启动目录；跨/同目录先清旧 artifact 再重建（规避后端 adopt 前缀校验拒绝）
- **`/session` 选择器摘要（社区 PR #45）** — 无参选择器展示会话摘要行（#短id · 标题 · 相对年龄；标题 = title 事件 fold → 首条真人消息 → 「新对话」），`/session list` 保持旧版直接打印
- **真机 e2e 资产（社区 PR #45）** — `scripts/e2e-tui.{sh,exp}` + `npm run e2e:tui`：expect 驱动 pty 里的官方 dsh CLI（独立 DSH_HOME），覆盖启动复用（含 adopt 错误回归）与 /session 两种形态
- **README 安装段修复** — 安装命令不再固定宿主 CLI `@0.1.0-rc.8`（npm latest 已到 `0.1.1-rc.2`），统一无版本（peer 依赖 `^0.1.0-rc.8` 兼容）


## [0.1.2-rc.14] - 2026-08-25

tianshu-public 交互面回流版本：/key 模型供应商密钥配置 + 图片发送预览 + 交互面增量（三波全量落地）。

- **`/key` `/login` 配置模型供应商 API 密钥** — 选择供应商（默认置首、已配置 ✓）→ 掩码输入（≤8 全显 •，>8 露末 4 位）→ 联网验证三分类（ok 直接落盘 / invalid 拒存回输入 / unknown 可强存）→ 落盘即生效（无需重启，欢迎行与 footer API ✓ 实时翻转）；`llm-deepseek` 段走官方端点探测，pi-ai 路由保存后自动补写 profile 让路由即刻注册；进程环境遮蔽（writable=false）与凭据存储缺席都有对应说明态；首启缺 key 时 TTY 自动弹一次（Esc 可跳过）
- **图片发送预览（半块字符缩略图）** — 附件挂上后输入轨显示最后一张图的降采样真彩预览（游程合并，毫秒级异步解码）；无图形协议终端发送图片后 scrollback 以半块字符回退渲染（每行都是真实滚动行，无残影）；sharp 懒加载、解码失败静默降级纯文本
- **交互面增量** — 统一活动带（`format/activity-band`：subagent/workflow/后台任务三来源折叠、分组计数头、⎿ 子行、封顶折叠）与消息面底色垫宽（`format/bg-block`）纯函数层入库，供后续接线
- **上游回流基准** — 相对 8-22 截止点后 22 个新提交经侦察判定无可回流 tui 内容（intent-bridge 出厂关闭=本仓现状）；宿主 seam（llm 目录/discoverModels/credentials.set/settings.mutate）四件套实测对齐


## [0.1.2-rc.13] - 2026-08-22

tianshu-public 修复回流版本：上游 8 月中旬以来 10 项 fix(tui) 全量回流——会话安全 + 输入/粘贴语义 + 模型路由正确性（B 批 UI 行为变化为本版头条）。

- **会话切换不再产生幽灵状态** — 切到不可恢复的会话时停留原会话并回显「⚠ 会话切换失败 + 原因」；Ctrl+S / 会话选择器等触发点不再逃逸 unhandled rejection，启动路径保持响亮失败
- **剪贴板大图不再静默丢失** — Ctrl+V 与右键粘贴位图走与文件路径同一条预算管线：超限截图要么自动压缩进预算、要么响亮失败并区分原因（无工具 / 仍超限），不再「挂上 📎 却在提交时被丢弃」；overlay 关闭后 1s 内 Ctrl+V 只走文本（焦点去抖接线）
- **slash 菜单不再顶推输入框** — 菜单行计入动态段高水位记账：开合、过滤全程输入框行位钉住，欢迎首帧不凭空垫白
- **rewind 面板可退出、只列真人消息** — Ctrl+C 第一次即关闭（不再被面板吞掉）、Esc 分阶段处理（选粒度时先回列表）；插件注入行与空助手行不再进检查点列表；无可回退消息时回显原因
- **/model 目录校验** — 拼写错误当场拒绝：未知 provider 硬拒并列已注册路由，目录外模型给至多三条就近建议（advisory 契约：空目录放行、llm 未装配跳过）；spark 别名目标未注册时响亮失败，不再静默保存死路由
- **含斜杠模型 id 不再截断** — openrouter 风格 `stealth/ox-alpha` 一类 id 按首个斜杠分割，选择器确认与 /model 实参都不再把 model 截成首段
- **输入框重影根修** — CPR 污染检测在输入增行/折行后作废基线：合法几何变化不再误判为外来写入触发欠回顶（旧帧顶部残留成「多一行」）
- **/clear 一并收起命令面板** — /config /skills 等 live 面板清屏后不再原样画回，需重新打开
- **Alt+控制键可达 + 空行 Alt+⌫ 删附件** — ESC+控制码组合（如 Alt+Backspace）正确路由；空行快捷移除末张图片附件（📎 行同步消失并提示键位），非空行仍是词删除
- **fork 会话标题不再撞父会话** — 标题认 `session/end-seed` 边界，优先展示 fork 自有标题或首条真人消息；未活跃 fork 与老日志行为不变


## [0.1.2-rc.12] - 2026-08-20

输入体验大版本：长文本性能 + 交互语义修复 + 界面语言统一（天枢同源优化三波）。

- **输入框长文本性能** — 折行逐字符量宽走缓存（10 万字符草稿每次按键 ~1.3s → ~10ms）；粘贴可编辑阈值抬至 100 行/10000 字（此前 10 行即收成标记）；输入视窗 16 行上限（超出折叠「… 上/下 N 行」）；`Home/End/Ctrl+U/K` 以逻辑行为范围、`PageUp/Down` 翻页、`↑↓` 按软折行移动；换行模式下粘贴并入草稿不提交
- **Ctrl+C 连按退出无死角** — 窗口内第二次恒退出（有草稿时第一次清空、`Ctrl+Z` 可恢复）；打断中第二次直接退出不用等落定；`vim` normal 下 Esc 空操作不再误弹 rewind；Kitty 键盘协议 CSI u 完整解码（Ctrl+C=CSI 99;5u、release 事件去重）
- **活区卡片语言统一** — 工具卡/委派树/后台任务一套符号：进行中 `⠋`、成功 `›`、失败 `✗`、正文 `⎿`；终态行后退（muted）；正在跑的子代理和 build 终于长得像同类对象
- **会话 tab 栏退场** — 常驻 tab 栏与 Ctrl+X/Alt+数字切换移除（多会话走 `/session` 与 `Ctrl+S`），界面少占一行
- **更新提示可操作化** — 自更新失败给出三行引导（重启重试/手动更新命令/关闭提示）；成功提示写明 `/restart` 用法


## [0.1.2-rc.11] - 2026-08-20

生态对齐 rc.8 + 个性化持久化 + Windows 修复大版本。

- **官方生态对齐 `^0.1.0-rc.8`** — 逐项核验 rc.6→rc.8 消费面：事件全为加法（`assistant/message` 新增 `interrupted`、新增 `team/*` 事件）；图片单图本地预算 10MB→3.5MB 对齐宿主新准入默认（避免原样放行的图被附件存储拒绝）；rc.8 官方 bash 提速（宿主侧工具调用 ~7s→0.3s）自动受益。安装需宿主 `0.1.0-rc.8`（`npx -y @deepseek-ai/dsh`）
- **本地偏好持久化（`~/.dsh-tui/prefs.json`）** — `/theme`、`/density`、`/subagents` `/workflow` 面板显隐、`/glance` metrics 段开关、系统通知（`notifyOs`）全部重启保留；`/theme auto` 可回退自动档；`/theme export [name]` 当前主题一键导出为自定义模板；主题选择器列出 `custom:` 主题
- **输入历史持久化** — `~/.dsh-tui/input-history.json` 上限 1000 条，Ctrl+P/N 跨重启可用（内容为输入原文，删文件即清空）
- **输入框多行导航修复** — 含 emoji/组合字符的长文本 ↑↓ 跨行不再拆簇错位（grapheme 列保持）
- **Windows 修复** — LSP 诊断启动修复（`.cmd` 派发）、12 处子进程补 `windowsHide`（不再闪控制台窗口）、剪贴板读图测试注入
- **自更新可靠性（#43）** — 官方 npm 源超时自动回退 `registry.npmmirror.com` 镜像；新增 `DSH_TUI_UPDATE_REGISTRY` 自定义源链；更新检查 1 小时磁盘缓存免每启联网
- **技能展示面（#39）** — `/` 菜单、Tab 菜单与 Ctrl+P 面板可见 userInvocable 技能（🧭），转录技能调用渲染为 chip
- **会话短标签修复（#37/#38）** — tab 栏/欢迎页/委派树等处不再显示 `[session-]` 空壳
- **主题切换即时重放（#40）** — 切主题后滚动区历史按新配色即时重绘；生态边界警告（#33）置顶 README


## [0.1.2-rc.10] - 2026-08-16

更新一步到位 + Windows 平台兼容 + 命令输入容错。

- **更新后自动重启（[#34](https://github.com/huiliyi37/dsh-tianshu-tui/issues/34)）** — 启动自更新落盘后自动重启生效（会话未开始工作时；已工作时只提示不打断）；`/restart` 命令手动重启同一进程（更新后不用再 `/exit` + 手动重跑）
- **自更新按锁文件选包管理器** — pnpm/npm/yarn 管理的 profile 各自走对应安装器，不再硬编码 pnpm（npm/yarn 用户不再混入 pnpm 锁文件）
- **`/help` 修复（[#36](https://github.com/huiliyi37/dsh-tianshu-tui/issues/36)）** — 此前一直报 `cannot get property "tui" without inject`，现经命令工厂注入正常列出全部命令
- **Tab 命令菜单（[#31](https://github.com/huiliyi37/dsh-tianshu-tui/issues/31) 跟进）** — 空输入框按 Tab 弹出全部命令菜单，选命令回车直接执行（`/model` `/theme` `/session` 直接进选择器），省去输入命令名一步（参考 Claude Code）
- **Windows/PowerShell 兼容** — Ctrl+C 打断不再触发「输入框消失」（0x03 字节与 SIGINT 双触发去重 + SIGINT 双注册 + 退出时终端兜底恢复）
- **`/` 开头文件路径容错** — `/src/main.ts`、`~/xxx`、Windows 盘符 `C:\...` 等路径不再被误判为 slash 命令报「未知命令」
- **打断恢复加固** — abort 时强制释放全屏 overlay（命令面板/搜索等），主屏输入框下一帧必然恢复；补「打断后输入框可见」回归测试

已装 `0.1.x-rc.6` 的用户下次启动会自动写入 profile。看到「插件已更新到 …，请重启 dsh 后生效」后重启即可（新版本会自动重启或输入 `/restart`）。


## [0.1.2-rc.9] - 2026-08-16

交互体验大补强:Esc 打断与双击回退、会话 tab 栏、成本汇总、主题实时预览。

- **Esc 双语义(对齐 Claude Code)** — 在途输出时单次 `Esc` 打断(与 Ctrl+C 同路径,80ms 防误触);空闲时 `Esc`+`Esc`(1s 窗口)打开 **rewind 回退面板**
- **rewind 时间线界面** — 消息列表升级:类型标记(❯ 用户/✦ 助手)+ 相对时间 + turn 分隔线 + 滚动窗口跟随选中(可滚到更早消息)
- **会话 tab 栏** — 多会话时输入轨上方常驻显示短 id 列表(当前 ● 高亮,窄宽折叠 `+N`);`Ctrl+X` 循环切换、`Alt+1`~`Alt+9` 直接跳转
- **`/cost` 会话成本汇总** — usage 按模型分桶累计,输出每模型明细(输入/缓存读/写/输出/推理)+ 合计 $ 估算
- **主题选择器实时预览** — `/theme` 选择器 ↑↓ 移动即切换主题,Enter 落定、Esc 还原
- 工程:`lib` bundle 随版本重建跟仓

已装 `0.1.x-rc.6` 的用户下次启动会自动写入 profile。看到「插件已更新到 …，请重启 dsh 后生效」后重启即可。


## [0.1.2-rc.8] - 2026-08-16

交互式选择器、Claude Code 对标补强、workflow 观察面、审计修复。

- **交互式选择器（[#31](https://github.com/huiliyi37/dsh-tianshu-tui/issues/31)）** — `/theme` `/model` `/session` 无参数回车即打开选择器：↑/↓（j/k）选择、PageUp/PageDown 翻页、Enter 确认、Esc 关闭，当前值 ● 高亮；模型列表来自 llm 目录，有参数用法不变
- **成本与上下文水位** — footer 新增 $ 成本估算（flash/pro 内置定价表，未知模型不猜价）；上下文占用 ≥95% 前缀 ⚠
- **git 未提交提示** — footer 显示 `●N`（未提交文件数，回合边界刷新）
- **`/help` 命令** — 注册表驱动的全部命令清单（`/help <cmd>` 单条详情）
- **工具卡手动展开** — 空输入 Enter 切换最后一张进行中工具卡，展开显示参数 JSON
- **workflow 面板观察面** — 运行时长改真实差值（此前误显时间戳）、meta 补全（run 名/描述/阶段数）、`workflow/log` 叙述行进展开视图
- **审计修复（[#30](https://github.com/huiliyi37/dsh-tianshu-tui/issues/30)）** — `dsh.runtime: "host"` 声明 + 4 处 subprocess 固定 argv 化（execSync → execFileSync）
- 工程：`lib` bundle 随版本重建跟仓

已装 `0.1.x-rc.6` 的用户下次启动会自动写入 profile。看到「插件已更新到 …，请重启 dsh 后生效」后重启即可。


## [0.1.2-rc.7] - 2026-08-15

功能核查大修：视觉桥可探测、服务缺失不再静默、投影层接线出轮次摘要；平台降级全部可见化。

- 主模型不识图且未注入 vision 配置时，按宿主 `visionBridge` 服务存在性自动探测识图桥（桥插件契约见装配节）
- 缺 goal/subagent 插件时整个 TUI 不再静默不启动（goals/subagents 改为可选服务）
- `/tasks` `/subagents` `/workflow` `/status` `/config` `/skills` 面板与 plan 模式在 backing 服务缺失时回显 ⚠ 警告，不再空白无提示
- `/clear` 真清屏（此前只清内部缓冲）；`Ctrl+.` 键位表补全到 20 条并修窄宽破版
- 投影层接线：回合结束落 `turn N · 读X 改Y · 耗时` 摘要行；`/status` 新增会话汇总段（宿主投影服务缺失时仍有数据）
- 平台降级可见化：剪贴板读图工具链缺失、外部编辑器启动失败、OSC52 终端不支持、自更新失败均有明确提示
- 修复：切会话/退出时挂起的审批与提问正确结算；fiber 重挂载不再抛 DUPLICATE_PROVIDER（组合测试拦截）
- 工程：构建两段化（tsc → tsdown，杜绝旧产物重打包）、typecheck 门禁、CI、vision-ask 对齐 rc.6 类型面

已装 `0.1.x-rc.6` 的用户下次启动会自动写入 profile。看到「插件已更新到 …，请重启 dsh 后生效」后重启即可。


## [0.1.2-rc.6] - 2026-08-14

退出时恢复终端光标并把 TTY 还给 shell；新增 `/exit`。

- `Ctrl+Q` / `/exit` 退出后恢复硬件光标，经宿主退出把终端还给 shell（[#22](https://github.com/huiliyi37/dsh-tianshu-tui/issues/22)）
- 无 launcher 宿主服务时 TUI 不再静默卡死
- 全屏 overlay 不再被流式输出盖住；Esc/Ctrl+C 关闭命令面板时不误提交
- 空闲空输入需连按两次 Ctrl+C 才退出；等待回复提示不再在回合结束后误显示

已装 `0.1.1-rc.6` 的用户下次启动会自动写入 profile。看到「插件已更新到 …，请重启 dsh 后生效」后重启即可。


## [0.1.1-rc.6] - 2026-08-14

启动时对照 npm `latest`，把 profile 里的本包升到新版本，提示重启后生效。

**从 `0.1.0-rc.8` 升级：** 那一版还没有自更新，需要手动加一次才会带上新逻辑：

```sh
npx -y @deepseek-ai/dsh plugin --profile tui add @huiliyi37/dsh-tianshu-tui
npx -y @deepseek-ai/dsh --profile tui
```

之后再发新版本，启动时会自动写入 profile。看到「插件已更新到 …，请重启 dsh 后生效」后重启即可。不想联网检查时设 `DSH_TUI_SKIP_UPDATE=1`。`github:` / `link:` 安装不会改写成 npm 包。

本版本还包含此前已上 `main` 的显示层对齐：

- 创建会话写入 `meta.cwd`，Web UI 能列出 TUI 会话
- 欢迎页 / 状态行按 credentials 分层判断 API key
- `/model` 后 footer glance 与视觉能力跟实际模型走
- `Ctrl+S` 可恢复磁盘上的会话

第一版本基线见 [docs/BASELINE-v0.1.0-rc.8.md](docs/BASELINE-v0.1.0-rc.8.md)。
