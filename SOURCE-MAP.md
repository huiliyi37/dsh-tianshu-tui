# dsh-tianshu-tui source map

本包渲染核心移植自天枢（Tianshu，曾用代号 Rivet）终端 UI 引擎，Apache License 2.0：

- 上游：https://github.com/huiliyi37/Tianshu-Tui（`src/tui/` 子树）
- port 时点：本仓提交 `b26ebed`（2026-08-10）自上游 `src/tui` @ `bc2aa2a0c` 移植；上游快照不随仓分发
- 上游版权：Apache License 2.0, Copyright 2025-2026 Tianshu Contributors（许可全文见 `LICENSE`；再分发与修改声明见 `NOTICE`）

状态图例（封闭枚举；`tests/source-map.spec.ts` 校验 src 全覆盖与取值合法，不做同一性核验）：

- `ported` — 自上游对应文件移植，port 后无本地改动。**不主张字节同一性**：上游快照不在仓内，无法机械核验；port 期的 lint 适配若产生差异则该文件归 `modified`。
- `modified` — 移植后为 dsh 接缝适配过；Apache §4(b) 的修改声明集中记录于本表与 `NOTICE`。
- `new` — dsh 原创，非上游作品的一部分（与本包其余部分同按 Apache-2.0 分发）。

## src/ ↔ 上游映射

上游列 `—` 表示无上游对应文件（`new`）。

| Target (this package) | Upstream (Tianshu src/tui/) | Status |
|---|---|---|
| src/actions/types.ts | — | new（统一 action registry 类型：KeyBinding/KeyAction/ActionContext/BlockingKeyContext） |
| src/actions/registry.ts | — | new（ActionRegistry：match + 同域键位冲突校验 + confirmMs 双击布防集中管理） |
| src/actions/builtin-actions.ts | — | new（内置键位动作表：原 handleKey if 链动作化，early/main/tail 相位对齐原分支位置） |
| src/actions/key-contexts.ts | — | new（阻塞态键上下文统一接口：question/btw/approval/inspect 的 isActive/handleKey 轮询） |
| src/actions/overlay-router.ts | — | new（overlay 键路由委派表驱动化：activeId → 键目标，'close'|'handled' 收尾 deactivate/rerender） |
| src/actions/projections.ts | — | new（展示面投影：keymap 条目 / footer 提示段从动作表生成） |
| src/activity-status.ts | activity-status.ts | modified |
| src/activity-store.ts | activity-store.ts | modified |
| src/adapter/agent-scope-service.ts | — | new（isolate 服务优先从 agent 预设面读：compact / planMode / workflowEngine） |
| src/adapter/fork-agent.ts | — | new（/fork /branch：agents.create({ seed, meta }) 铸 child，避免 sessions.fork 后再 resume live 会话） |
| src/adapter/live.ts | — | new |
| src/adapter/preset-join.ts | — | new（create mount / resume resolvePresetId / child composeFrom，setup 里加入官方预设面） |
| src/adapter/send.ts | — | new |
| src/adapter/session-title.ts | — | new（/session list 会话标题展示：官方 log-backed session/title 事件 fold → 确定性 fallback → 「新对话」；纯函数只读，不调 API、不写 sidecar） |
| src/adapter/sessions.ts | — | new |
| src/adapter/tool-view.ts | — | new（presenter 桥：镜像 apiproxy viewFor 的 presentCall/presentResult 软降级消费） |
| src/adapter/transcript.ts | — | new |
| src/block-stream-writer.ts | block-stream-writer.ts | modified |
| src/box-chars.ts | box-chars.ts | ported |
| src/braille-spinner.ts | braille-spinner.ts | modified |
| src/command-palette.ts | command-palette.ts | modified |
| src/commands/registry.ts | — | new |
| src/commands/model-validate.ts | — | new（回流 tianshu 8cc0cbe589：/model 目录分级校验（advisory 契约：provider 硬拒 / 目录外就近建议 / 空目录放行 / 未装配跳过）+ SPARK_ALIASES 一键别名表，自 registry 提取） |
| src/commands/startup-commands.ts | — | new（/theme /model /effort /preset：Enter/带参=本会话，S 或末尾 default=启动默认） |
| src/completion/file-completer.ts | file-completer.ts | modified（目录重排 src/tui/ → src/completion/；`resolveFileCompletion` Tab 协调入口为 dsh 新增） |
| src/config-panel.ts | — | new |
| src/controllers/approval-controller.ts | — | new |
| src/controllers/btw-controller.ts | — | new |
| src/controllers/question-controller.ts | — | new |
| src/controllers/attachment-preview.ts | — | new（composer 附件缩略图域自 ui/app.ts C4 提取：半块预览 + 代际号丢弃迟到解码 + 底色解析） |
| src/controllers/submit-queue.ts | — | new（运行中提交本地排队：turn/end 按序投递、↑ 取回队首、切会话丢弃回显——宿主 followup 无取回 API 故 TUI 自建；对标 CC queue） |
| src/controllers/session-manager.ts | — | new |
| src/controllers/inspect-surface.ts | — | new（检查类 live 面板互斥开闭与键分发，从 ui/app.ts 抽出保棘轮） |
| src/controllers/skill-surface.ts | — | new（#39 技能展示面：快照缓存 + userInvocable 过滤 + slash 菜单投影 + 手势 MRU + skills/change 订阅，从 ui/app.ts 提取） |
| src/controllers/workflow-surface.ts | — | new（T2.2 workflow 六事件订阅 + 运行/终态双缓存 + 视图折叠，从 ui/app.ts 抽出保棘轮；渲染与通知经 opts 回调交还宿主） |
| src/controllers/delegation-surface.ts | — | new（T2.1 子代理委派域：委派树预取/对话流运行行双缓存 + 他会话投影入口，从 ui/app.ts 抽出保棘轮；end 终态数据经 onRunFinished 交还宿主格式化落盘） |
| src/controllers/commit-surface.ts | — | new（C4 第二波滚动区提交写入域：原子提交编舞/overlay 暂存补写队列/用户气泡与识图三态提示/终端图片与半块回退链路，从 ui/app.ts 抽出保棘轮；渲染调度经 flushRender、overlay 判定与 vision 态经回调交还宿主） |
| src/delegation-panel.ts | — | new（activity 状态形对齐活区卡语言：running ⠋ / inactive ›；截断走 live-card truncateToLiveWidth） |
| src/engine/ansi.ts | engine/ansi.ts | modified（新增 DECSCUSR 光标形状常量：稳态竖条 + 默认恢复，overlay 输入光标用） |
| src/engine/clipboard-image.ts | engine/clipboard-image.ts | modified（移除未声明的 @mariozechner/clipboard native 路径，保留 shell 链 + 注入点；readText 注入测试密封化） |
| src/engine/commit-engine.ts | engine/commit-engine.ts | modified |
| src/engine/image-attach.ts | engine/image-attach.ts | modified（三级自适应压缩：1568px 保透明 PNG / JPEG 0.82 → JPEG 0.55 → 1024px+0.55，语义对齐上游 desktop 子树 image-compress.ts 的 compressImageSafe；probeImageSize 头部解析为 dsh 新增） |
| src/engine/image-preview.ts | engine/image-preview.ts | ported（2026-08 回流：半块字符图片预览——sharp 懒加载降级、游程合并；消费：commitUserPrompt 气泡回退 + composer 缩略图） |
| src/engine/image-tool.ts | engine/image-tool.ts | modified（新增 resizeJpegCandidates——长边缩放 + JPEG 质量候选链，win32 脚本含 EncoderParameter 质量参数；语义对齐上游 desktop 子树 image-compress.ts；resize 链 sips 显式 -s format png） |
| src/engine/input-controller.ts | engine/input-controller.ts | modified（类型内联；`tabComplete` Tab 补全状态机驱动） |
| src/engine/route-key.ts | — | new（回流 tianshu e289f6d980：parseRouteKey 首斜杠分割 provider/model 路由键——模型 id 自身可含 /，picker 行与 /model 实参同一文法） |
| src/engine/input-handler.ts | engine/input-handler.ts | modified（+Kitty CSI u / xterm modifyOtherKeys 完整解码：Ctrl+字母映射 ctrl_* 名、release 事件只消费、冒号修饰段解析、带修饰可打印键保留 char——天枢 59d00152 同步） |
| src/engine/insert-remap.ts | — | new（vim insert 两键序列→Esc（jj 等，对标 CC vimInsertModeRemaps）：prefs 校验 + 首字符即时上屏/命中整段回删状态机，1s 窗光标连续性校验无计时器） |
| src/engine/input-line.ts | engine/input-line.ts | modified（多行 ↑↓ 导航 grapheme 列保持——CJK/emoji 跨行不拆簇；2026-08 天枢长文本优化整文件同步：charDisplayWidth 折行缓存（10 万字符草稿按键 ~1.3s→~10ms）+ 粘贴折叠阈值 100 行/10000 字 + 输入视窗 16 行上限（… 上/下 N 行）+ Home/End/Ctrl+U/K 逻辑行域 + PageUp/Down 翻页 + ↑↓ 软折行视觉导航 + 换行模式粘贴并入草稿）；#55 vim 光标形态：insert 竖线占格/normal 反色块（wrap/无 wrap/空值三路径，ASCII 档 |） |
| src/engine/vim-input.ts | engine/vim-input.ts | new（issue #51：vi/vim 键位引擎——Claude Code interactive-mode Vim 表为基准；hjkl/w e b W B E/0$^/ggG/fFtT;,，d c y × motion + 数字前缀 + 文本对象 iw aw iW aW，行级 dd/cc/yy 与 dd-EOF 收边，`.` 重放管线复用 spliceRange 记 undo，visual v/V 两端含字符宿主面） |
| src/engine/live-budget.ts | — | new（Working 行封顶 / skipPad 只裁不垫 / 动态段预算 / 空闲 ticker key，从 live-engine 抽出守 750 红线） |
| src/engine/live-engine.ts | engine/live-engine.ts | modified |
| src/engine/metrics-glance-controller.ts | engine/metrics-glance-controller.ts | modified |
| src/engine/overlay-controller.ts | engine/overlay-controller.ts | modified |
| src/engine/overlay-engine.ts | engine/overlay-engine.ts | modified（caret 钩子：输入类 overlay 硬件光标 + DECSCUSR 稳态竖条，caret 写不受空 diff 短路；退出恢复光标形状） |
| src/engine/perf-monitor.ts | engine/perf-monitor.ts | modified |
| src/engine/resize-handler.ts | engine/resize-handler.ts | ported |
| src/engine/stream-renderer.ts | engine/stream-renderer.ts | modified |
| src/engine/term-image.ts | engine/term-image.ts | modified |
| src/engine/write-batcher.ts | engine/write-batcher.ts | ported |
| src/external-editor.ts | external-editor.ts | modified |
| src/fluency-hook.ts | fluency-hook.ts | modified |
| src/format/activity-labels.ts | format/activity-labels.ts | modified |
| src/format/approval-card.ts | — | new（审批卡：圆角轨 + diff 体 + y/n/a/esc 键位，纯渲染） |
| src/format/btw-panel.ts | — | new |
| src/format/chrome-colors.ts | — | new（输入轨/footer 雾蓝 chrome token，对齐 dsh-cc-tui Gentle Mist Blue） |
| src/format/collapsed-bash.ts | format/collapsed-bash.ts | modified |
| src/format/confirm-hints.ts | — | new（双击布防提示行：「再按 Ctrl+C 退出」「再按 Esc 打开 rewind」——registry confirmSince 数据源 + 窗口过期自清） |
| src/format/diff.ts | format/diff.ts | modified |
| src/format/doctor-report.ts | — | new |
| src/format/error-recovery.ts | — | new（agent 错误 → 恢复指引尾注：401/超长/超时模式识别表 + 警告 hint 尾随行组装，纯函数） |
| src/format/activity-band.ts | format/activity-band.ts | ported（2026-08 回流：统一活动带——subagent/workflow/task 折叠 + 封顶渲染；纯函数层并入，live 接线待 owner 决策） |
| src/format/bg-block.ts | format/bg-block.ts | ported（2026-08 回流：消息面底色垫宽 withBgFill/withBgFillLines；纯函数层并入，气泡接线待 owner 决策） |
| src/format/export.ts | — | new（/export 会话导出：事件日志 → Markdown 转录，纯渲染） |
| src/format/fluency-policy.ts | fluency-policy.ts | modified（目录重排：上游根 → src/format/） |
| src/format/glance-bar.ts | format/glance-bar.ts | modified（hideSegments 段过滤：prefs.glance.hideSegments 透传，model/stalled 永不可隐藏） |
| src/format/glance-metrics.ts | — | new（glance metrics 投影：app 缓存字段 → formatGlanceBar 输入；C4 自 ui/app.ts 提取，时间注入可测） |
| src/format/lsp-diagnostics.ts | — | new（诊断展示纯函数：工具卡徽标 + /lsp 面板段，severity 语义色） |
| src/format/hidden-lines.ts | format/hidden-lines.ts | ported |
| src/format/history-search-overlay.ts | — | modified（两阶段输入 #55：编辑段全字符进 query（n/N 不再被劫持）、Enter 确认进跳转段 n/N/p/P 跳转；搜索栏标注「会话历史」语义） |
| src/format/scroll-pager-overlay.ts | — | new（/scroll 分页查看器 overlay：scrollback-transcript 消费端——消息单元滚动浏览/实时搜索/n·N 跳转/g·G 首尾，键位路由收敛类内） |
| src/format/input-frame.ts | — | new（输入轨：上下圆角横线 ╭─╮/╰─╯，左右不封，纯渲染） |
| src/format/highlight.ts | — | new（搜索命中子串高亮纯函数（A2）：ANSI 感知——转义零宽跳过不参与匹配、plain 投影位置映射原位包裹；smart-case 口径单源导出） |
| src/format/keymap-panel.ts | — | new |
| src/format/live-card.ts | — | new（活区共享卡片 chrome：›/⠋/✗/? 状态形 + ⎿ body + suffix 右起丢弃——工具卡/委派树/后台任务统一语言，天枢 f636eb0e 同步） |
| src/format/markdown.ts | format/markdown.ts | modified |
| src/format/memory-overlay.ts | — | new |
| src/format/permission-diff.ts | format/permission-diff.ts | modified |
| src/format/pricing.ts | — | new（成本估算：内置 $/MTok 定价表 + estimateCost 纯函数，$cost 段数据源） |
| src/format/prompt-footer.ts | — | new（C4 概念稿底部 footer：模式徽标 + 快捷键提示，纯渲染） |
| src/format/reasoning.ts | — | new（think 推理两态渲染：live shimmer 头行 + 尾巴、结算全文块，纯渲染） |
| src/format/rewind-overlay.ts | — | new |
| src/format/separator.ts | separator.ts | modified（目录重排：上游根 → src/format/） |
| src/format/session-cost.ts | — | new（/cost 会话成本汇总：usage 按模型分桶累计 + 报告渲染，纯函数） |
| src/format/shimmer.ts | — | new（光带扫过动画：tick 驱动逐字符插值，样式源用户提供的 deep-diving.gif） |
| src/format/slash-menu.ts | — | new（grok slash_dropdown 移植：slash 命令下拉菜单，纯渲染） |
| src/format/subagent-line.ts | — | new（grok SubagentBlock 移植：subagent 对话流状态行，纯渲染） |
| src/format/spinner-status.ts | format/spinner-status.ts | modified |
| src/format/steer-message.ts | — | new |
| src/format/task-panel.ts | — | new（todo checklist 保持 [ ]/⏳/[x]——清单不是进程卡；截断复用 live-card） |
| src/format/todos-panel.ts | format/todos-panel.ts | ported（/todos 紧凑待办面板纯函数层；回流 tianshu a7b8f63392） |
| src/format/tool-card.ts | format/tool-card.ts | modified（消费 live-card 共享常量与 liveCardGlyph——去重本地 ⎿ 前缀/spinner 分支；live 无 tick 进行中形 ●→⠋） |
| src/format/tool-family.ts | tool-family.ts | modified（目录重排：上游根 → src/format/） |
| src/format/tool-group.ts | — | new |
| src/format/tool-view-card.ts | — | new（presenter 结算卡：diff/terminal 结构化渲染 + generic 回落；renderFileDiff 与审批预览共用） |
| src/format/tool-meta.ts | — | new |
| src/format/turn-summary.ts | turn-summary.ts | modified（上游单文件拆为模型+渲染，此为渲染半；模型半见 src/turn-summary.ts） |
| src/format/turn-status.ts | — | new（C4 概念稿 turn_status：spinner/◆ + 阶段文本，纯渲染） |
| src/format/user-message.ts | format/user-message.ts | modified |
| src/format/welcome.ts | format/welcome.ts | modified |
| src/format/whale.ts | — | new（欢迎页鲸鱼品牌像素画：半块字符双色渲染，品牌固定色 + 色深/宽度档降级，纯渲染） |
| src/format/pixel-grid.ts | — | new（半块像素画共享 blitter：像素网格 → ANSI 行，透明格不涂背景/行尾透明丢弃/RESET 收尾；whale 复古画共用） |
| src/format/welcome-title-frames.ts | — | new（生成物：star 标题 figlet 艺术字两档（Standard/Mini）；scripts/generate-welcome-title.mjs 产出，勿手改） |
| src/format/whale-star-frames.ts | — | new（生成物：star 鲸鱼 44×34 索引像素 + 15 色板；scripts/generate-welcome-star.mjs 由 assets/welcome-star-source.png（字幕带已切除）产出，勿手改；44 列为 ambiguous 宽渲染终端的折行安全上限） |
| src/format/whale-star.ts | — | new（star 欢迎页紫鲸举星像素画：half-block 实色轨 44×17 文本格 + 星光/喷水/白褶肚，品牌固定色 + 色深/宽度档降级（level 1 现场最近邻 ANSI16），纯渲染） |
| src/gutter.ts | gutter.ts | ported |
| src/git-status.ts | — | new（git 仓库探测三函数：isGitRepo/gitBranch/gitDirtyCount，exec 注入；C4 自 ui/app.ts 提取） |
| src/index.ts | — | new |
| src/input-history.ts | — | new（输入历史持久化：~/.dsh-tui/input-history.json，1000 条上限、进程内追加队列 + 重读合并原子写；上游 history.ts 模式，去重语义取本仓更强的全列表去重） |
| src/lsp/lsp-bridge.ts | — | new（LSP 诊断桥：懒生命周期 + 展示层诊断缓存；扩展名不支持/server 未安装一次标记；per-file 合并与冷却） |
| src/lsp/manager.ts | lsp/manager.ts | modified（initialize 竞速进程早夭：rpc 无超时，进程死掉时 pending 请求永不 settle → error/close settle 入 catch，防 ensure() 永久挂起） |
| src/lsp/multi-manager.ts | lsp/multi-manager.ts | modified（spawn 简化：弃上游 spawnHidden/resolve-node-cli 桌面 bundle 适配，用 node:child_process spawn 直连；win32 经 cmd.exe /d /c 派发 .cmd——npx 不经 shell 直接 spawn 抛 EINVAL） |
| src/lsp/rpc.ts | lsp/rpc.ts | ported（JSON-RPC over stdio：Content-Length 帧编解码 + 请求/通知分发） |
| src/lsp/server-registry.ts | lsp/server-registry.ts | ported（语言 → server 映射：typescript 经 npx / pyright / gopls / rust-analyzer / clangd / jdtls + which 探测） |

独立插件 `@deepseek-ai/dsh-lsp`（omdsh-dev/dsh-lsp 独立仓，源码镜像于本仓 lsp/）复用
同一批移植文件（rpc/manager/multi-manager/server-registry 复制自本包 src/lsp/，同源
Apache-2.0）；`service.ts`（LspService 封装）、`tools.ts`（三个模型工具）、`index.ts`
（插件入口）为 `new`。TUI 展示桥经 `ctx.reflect.get('lsp')` 探测消费该插件服务。
| src/invariant.ts | — | new |
| src/live-tail-cap.ts | live-tail-cap.ts | modified |
| src/mention-expand.ts | — | new |
| src/mention-parser.ts | mention-parser.ts | modified |
| src/os-notify.ts | — | new（后台完成系统通知：darwin/linux/win32 固定 argv；DSH_TUI_SKIP_NOTIFY/SSH/CI/VITEST 与 prefs.notifyOs 门闸） |
| src/term-bell.ts | — | new（完成事件终端 BEL 通道：SSH 不抑制——BEL 穿透 pty 到本地终端响铃；共享 SKIP/VITEST/CI 与 prefs.notifyOs 门闸） |
| src/pi/latex-block.ts | pi/latex-block.ts | modified |
| src/pi/latex-to-unicode.ts | pi/latex-to-unicode.ts | modified |
| src/prefs.ts | — | new（本地偏好持久化：~/.dsh-tui/prefs.json——theme/density/preset/常驻面板/glance/notifyOs；容错解析 + 原子写 + VITEST 密封门） |
| src/picker.ts | — | new（Issue #31 交互式选择器：纯状态机 + 渲染 + PickerController，/model /theme /session 无参打开；S 设为默认） |
| src/startup-defaults.ts | — | new（会话 vs 启动默认：splitDefaultFlag + 回显文案 + newSession 应用 prefs.preset） |
| src/port.ts | — | new |
| src/preset-catalog.ts | — | new（官方 shipped 预设展示目录：standard/code/minimal/cordis 的短名、能力、工具集；ptc/creative 别名） |
| src/preset-surface.ts | — | new（agent 预设展示面纯投影：preset 名 = header 创建值 + agent-preset/selected 切换值 fold（官方 resolveSessionPreset 等价）；wire 工具面 = 最近 request/header 的 tools 集合（foldRequestHeader）；只消费日志事实，不重放 preset 插件私有晋升逻辑） |
| src/controllers/error-announcer.ts | — | new（错误落底/指引/回填自 ui/app.ts C4 提取；回流 Tianshu 807686a02 lastSubmittedText——投递记录/成功 settle 清/输入空才回填；无 abort 独立回填故 abort 不清底料） |
| src/question-panel.ts | — | modified（plan-review 决策卡视觉分层轻量适配：dim 决策区分隔线 + approve ❯/success 主操作高亮，theme 可选注入缺省无色——回流 Tianshu b15e90428） |
| src/render/live-panels.ts | — | new（后台任务快照走 formatLiveCard：running ⠋+⎿ detail / completed › 终态后退 / 其余 ✗） |
| src/render/live-snapshot.ts | — | new |
| src/restore-session.ts | restore-session.ts | modified |
| src/ring-buffer.ts | ring-buffer.ts | modified |
| src/scrollback-transcript.ts | scrollback-transcript.ts | modified |
| src/self-update.ts | — | new（启动自更新：对照 npm latest 写 profile，dsh 原创；1h 磁盘缓存免每启联网——~/.dsh-tui/update-cache.json 原子写；registry 镜像回退链 npmjs→npmmirror + DSH_TUI_UPDATE_REGISTRY 覆盖，#43） |
| src/session-label.ts | — | new（会话 id 显示短标签：剥离 `session-` 前缀后截 8 位，消除空壳 label；PR #37 的同类截断点统一） |
| src/restart.ts | — | new（#34：同命令行重启原语——argv 重放 + stdio inherit + POSIX detached；/restart 命令与更新后自动重启共用） |
| src/skill-panel.ts | — | new |
| src/status-panel.ts | — | new |
| src/statusline.ts | statusline.ts | modified（追加工作流投影层 + WorkflowStatusLine） |
| src/stream-window.ts | stream-window.ts | ported |
| src/summary-state.ts | summary-state.ts | modified |
| src/term-caps.ts | term-caps.ts | modified |
| src/theme-custom.ts | theme-custom.ts | modified（自定义主题根路径重指到本包 home；exportCurrentTheme：当前主题导出为自定义模板 + 就地注册） |
| src/theme-detect.ts | theme-detect.ts | modified（pause 对称恢复：仅在进入时为暂停态才 `pause()`） |
| src/theme-palettes.ts | theme-palettes.ts | modified |
| src/format/top-bar.ts | — | new（C4 概念稿顶部栏：cwd + 分支 + 模型，纯渲染） |
| src/theme-contrast.ts | — | new（自定义主题对比度校验：WCAG 相对亮度/对比比；对声明背景名义值 <3.0 警告 fail-open，loadCustomThemes 接线） |
| src/theme.ts | theme.ts | ported |
| src/tool-status.ts | tool-status.ts | modified |
| src/truncation-marker.ts | truncation-marker.ts | ported |
| src/turn-summary.ts | turn-summary.ts | modified（上游单文件拆为模型+渲染，此为模型半；渲染半见 src/format/turn-summary.ts） |
| src/ui-glyphs.ts | ui-glyphs.ts | ported |
| src/ui/activity-flow.ts | — | new（子代理/工作流活动带装配：fold/摘要/委派合并/外部 run 降级，自 app.ts 抽出保棘轮） |
| src/ui/app.ts | — | new（角色对应上游 engine/app.ts，为面向 dsh cordis 服务的独立装配实现，非逐行移植） |
| src/ui/config-flow.ts | — | new（/config 投影装配：宿主 settings/permission/credentials 可缺；终端通知段始终带上） |
| src/ui/inspect-panels.ts | — | new（检查类面板互斥标志、键语义与底栏 hint） |
| src/ui/startup-pickers.ts | — | new（/model /theme /effort 选择器：Enter 本会话、S 写启动默认，自 app.ts 抽出保棘轮） |
| src/ui/key-dialog.ts | ui/key-dialog.ts | ported（2026-08 回流：供应商 API Key 掩码输入对话框状态机） |
| src/ui/key-flow.ts | — | new（装配提取层：上游 TuiApp 的 openKeyDialog 系列提取，棘轮对冲；key-wizard/key-dialog 之上） |
| src/ui/key-wizard.ts | ui/key-wizard.ts | ported（2026-08 回流：/key 供应商选择纯函数层） |
| src/ui/render.ts | — | new |
| src/width.ts | width.ts | modified（+charDisplayWidth：单字符宽度两档有界缓存，输入框折行热路径专用，与 displayWidth 恒等） |
| src/workflow-panel.ts | — | new |

验证命令（映射覆盖护栏，随 tui 包测试执行）：

    npx vitest run tests/source-map.spec.ts
