# Adapter 边界与上游契约

本文档记录 dsh-tianshu-tui 与官方 DeepSeek Harness(`@deepseek-ai/*`)之间的边界规则、
服务面契约与"刻意不做"清单。任何改动都应先对照本文——违反边界的改动是设计错误,
不是功能缺失。

## 边界规则(纯展示契约)

TUI 是**纯展示层**:

- **不注册任何 prompt、工具或上下文面**——模型可见的内容必须已经记录在会话日志中
  ("Model-visible ⟺ logged")。
- **用户输入成为普通日志消息**——TUI 不拥有 agent 循环、不路由、不生成内容。
  turn 运行中的提交先落 TUI 本地队列(立即回显不直发),turn/end 按序 drain 投递为
  followup,中断不投递;插队(Ctrl+Enter)= cancel(keepInbox) + 落定后直发。
- **所有渲染状态派生自会话事件流**——不另起数据源、不写 sidecar(会话标题等少量
  只读纯函数 fallback 除外,见 SOURCE-MAP.md)。

违背边界的行为示例:在 TUI 里实现 AgentLoop、把路由/意图写进冻结 system prompt、
用 TUI 命令直接改 agent 请求体。

## 服务依赖面

### 必选(经 `ctx.inject`,缺则 TUI 不启动)

| 服务 | 用途 |
|---|---|
| `sessions` | 会话创建/切换/持久化 |
| `agents` | agent 铸造、会话恢复 |
| `agentDefaultModel` | 默认模型选择(读写) |

### 装配后应有(本包 bundle 挂 `agent-preset-registry`;缺则新会话无工具面)

| 服务 | 用途 |
|---|---|
| `agentPresets` | 注册表;`setup` 里 `mount` / `composeFrom`;`/preset` `recompose` |

### 可选(经 `ctx.reflect.get`,缺则相关能力 fails loud,不阻塞启动)

| 服务 | 消费方 | 缺失行为 |
|---|---|---|
| `goals` | `/goal` | ⚠ 警告 |
| `subagents` | `/subagents` 委派树、subagent 运行行 | ⚠ 警告 |
| `memory` | `/remember` `/memory` | ⚠ 警告 |
| `compact` | `/compact` | 优先当前 agent isolate,host 回退;都无则 ⚠ |
| `tasks` | `/tasks` 窗格 | ⚠ 警告 |
| `skills` | `/skills` 面板 | ⚠ 警告(注册表仍在 host,按 scope 分层) |
| `sessionProjections` | `/status` 面板(goal/todos/plan) | ⚠ 警告(会话汇总段仍可用) |
| `workflowEngine` | `/workflow` 面板 | 优先当前 agent isolate,host 回退;都无则 ⚠ |
| `planMode` | plan 模式状态 | 优先当前 agent isolate,host 回退;都无则徽标不显示 |
| `llm` | 模型选择器目录、pi-ai 草稿模型发现、识图模态刷新 | ⚠ 警告；provider 可手输模型 |
| `visionBridge` | 视觉桥自动探测 | 图片不发送并警告 |
| `userQuestions` | 结构化提问面板 | 降级 |
| `tools` | 工具卡 presenter 桥 | 软降级 |
| `sessionPersistence` | 会话恢复列表 | 降级 |
| `settings` / `permission` / `credentials` | `/config` 面板；`/key` profile/key 保存 | 对应段不渲染；pi-ai 编辑回退 key-only，新建不可用 |
| `lsp` | LSP 诊断徽标 | 内置桥降级 |
| `appExit` / `cmdlineArgs` | 退出 / --help | 降级 |
| `commands` | slash 注册表(tui.commands 服务) | /help 警告 |

## 事件订阅清单

TUI 只订阅、只读、从不发布以下事件(会话事件按 owner 过滤):

| 事件 | 用途 |
|---|---|
| `session/event` | 会话事件流(消息/工具/推理/usage/turn 边界) |
| `workflow/start` `phase` `log` `agent-start` `agent-end` `end` | workflow 运行面板 |
| `subagent/start` `subagent/end` | 委派树与运行行 |
| `approval/request` | 审批卡(waterfall 委托) |

审批结算只有 `allowed-once` / `rejected` / `cancelled` 三态回传——协议 decided 无文本
通道:`f` 拒绝附反馈的文本经 steer 旁路送达 agent(宿主既有消息面,非审批协议扩展);
`p`/`t` 的命令前缀/工具白名单是 TUI 本地短路态(单会话作用域,切会话复位),不落协议。

## 能力边界(刻意不做,防重复踩坑)

以下方向经调研确认**不可行或越权**,不要再次尝试:

1. **请求体改写(spark 截断等)**:`agent/request` waterfall 只能替换
   `LlmCallConfig`(provider/model/effort 等),官方契约明确 *"this waterfall cannot
   mutate messages"*。wire 序列化在 harness `llm-deepseek` 内部,TUI 无 hook 面。
   结论:思维链截断等 wire 变换只能由 harness 侧实现(见 docs/2026-08-15-dsh-kernel-collab-design.md)。
2. **workflow 控制面**:`workflow/*` 事件 observe-only(seam 契约 *"never expose run
   control"*),TUI 拿不到 run handle、看不到 result value;启动/取消/销毁属
   holder 职责。
3. **审批 diff 编辑**:`ApprovalRequest` 无 diff/patch 字段,结算无内容回传——
   Claude Code 式"编辑 diff 再接受"需要 harness 扩展审批契约,当前不可做。
4. **路由/意图注入**:展示层不能成为路由权威;意图必须走 harness 侧插件。
5. **auto-compact 自动触发**:主动调 compact 服务越展示层边界;只做提示
   (上下文 ≥95% ⚠ 水位)。

## Bundle Patch

`cordis.patch.yml` 在 `dsh-base` 之上插入 `tui-runner` 与官方 `agent-preset-registry`
（0.2.0 起取代旧 `dsh-agent-presets` 花名册包；预设以 `dsh-agent-preset` 声明行
随包携带，与官方 web-app 的 presets/*.patch.yml 逐字同源），并关掉 host 上的
agent 面行（由 shipped 预设再挂）。插件名 `tui-runner` 固定。
`lib/index.js` 是打包产物,必须跟仓(见 docs/RELEASE.md)。

## 契约版本线

- peerDependencies:宿主相关 `@deepseek-ai/*` `^0.2.1-rc.4`（`dsh-invariants` 为 `^0.2.0-rc.2`）、`@deepseek-ai/cordis` `^4.0.5`
- README 里的官方 CLI `0.2.1-rc.4`（npm `next` 标签）是宿主版本,不是本包版本
- 宿主版本漂移时:先升级 peer 范围再发版,不静默容忍
