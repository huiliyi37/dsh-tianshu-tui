/**
 * TuiApp — 会话界面主装配（中等 MVP）。
 *
 * 装配关系（渲染核心 + 适配层 + 本装配）：
 * - CommitEngine：scrollback 转录区（不可回退的已提交行）
 * - LiveEngine：底部 live 区（输入行 + 状态行 + 流式尾巴）
 * - InputHandler：raw-mode 键盘事件 → 键路由
 * - InputLine：输入缓冲区/光标/历史
 * - BlockStreamWriter + StreamRenderer：assistant 流式块 → markdown 提交
 * - adapter.transcript：会话事件日志 → TranscriptView 投影
 * - adapter.send：提交/取消 → AgentControls
 * - adapter.sessions：会话列表/新建/切换/退出 flush
 * - adapter.live：agent 实时状态（status/inbox/error）
 *
 * 反目标（不做）：设置/权限审批/主题定制/插件管理、slash 命令全集、
 * worker/星域面板。本装配只覆盖目标 1-6。
 *
 * @module @deepseek-ai/dsh-tianshu-tui/ui
 */
import type { ReadStream, WriteStream } from 'node:tty';
import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import { type ModelSelection } from '@deepseek-ai/dsh-agent';
import { type KeyName } from '../engine/input-handler.js';
import { type SessionSummary } from '../adapter/sessions.js';
import type { MultiLspOptions } from '../lsp/multi-manager.js';
/** TuiApp 构造选项。 */
export interface TuiAppOptions {
    ctx: Context;
    stdout: WriteStream;
    stdin: ReadStream;
    /** 启动时切入的会话 id；缺省优先恢复最近会话（live store 为空才新建）。 */
    initialSessionId?: SessionId;
    /** 主题名；'auto' 走系统终端配色探测。优先级：装配 > prefs.json > 'auto'。 */
    theme?: string;
    /** 偏好文件路径（theme/density/常驻面板/glance 段）；null 显式禁用。
     *  缺省：生产 ~/.dsh-tui/prefs.json，VITEST 下 null（测试密封门）。 */
    prefsPath?: string | null;
    /** 输入历史文件路径；null 显式禁用。缺省同 prefs 的密封门规则。 */
    inputHistoryPath?: string | null;
    /** 输入行为空时 Ctrl+C 的退出回调（raw-mode 下 Ctrl+C 是数据字节非 SIGINT）。 */
    onExit?: () => void;
    /** /restart 与更新后自动重启的回调（装配方负责 dispose + spawn 同 argv + 退出）。 */
    onRestart?: () => void;
    /** 外部编辑器触发键（KeyName）；缺省 'ctrl_e'（ctrl+o 已恢复为推理展开，Phase 6.4）。 */
    editorKey?: KeyName;
    /** 外部编辑器命令；缺省 $VISUAL/$EDITOR/平台缺省（测试注入点）。 */
    editorCommand?: string;
    /** 是否启用 Vim 键位（Phase 6.5）；缺省 false。 */
    vimEnabled?: boolean;
    /**
     * 禁用 /key 首启自动弹窗（attach 尾缺 key 引导；缺省 false=启用）。
     * 宿主/测试装配可显式关闭——TTY 替身与真实终端无法从 stdin 区分。
     */
    disableKeyAutoPrompt?: boolean;
    /** 启动期收集的主题警告（loadCustomThemes 回调路由；attach 后 echoWarn + /theme 指引落 scrollback）。 */
    themeWarnings?: readonly string[];
    /**
     * 主控模型的识图能力与视觉桥状态（图片附件的用户气泡提示数据源；
     * 由装配方按 agent 配置注入——TUI 是纯表现层，不自行查询模型能力）。
     */
    vision?: {
        /** 主控模型是否原生支持识图（图片直发）。 */
        supportsVision?: boolean;
        /** 是否配置了独立识图桥模型（主控不识图时经桥转文字描述）。 */
        bridgeEnabled?: boolean;
        /** 识图桥来源（configured=显式配置 / auto=自动选用）。 */
        bridgeSource?: 'configured' | 'auto' | 'none';
    };
    /**
     * LSP 诊断桥（本地语言服务；懒启动——首个触碰文件才 spawn server）。
     * 诊断只进 TUI 本地展示缓存，不写会话事件、不注册任何模型面。
     */
    lsp?: {
        /** 是否启用诊断拉取；缺省 true。 */
        enabled?: boolean;
        /** 单次诊断拉取超时（毫秒）；缺省 2000。 */
        timeoutMs?: number;
        /** 测试注入：语言 server spawn（透传 LspBridgeOptions.spawnFor）。 */
        spawnFor?: MultiLspOptions['spawnFor'];
        /** 测试注入：server 可用性探测（透传 LspBridgeOptions.which）。 */
        which?: MultiLspOptions['which'];
    };
    activityBand?: boolean;
    activityBandMaxRows?: number;
    workflowHistoryLimit?: number;
}
/**
 * 解析 slash 命令（最小唯一前缀匹配，委托 registry 解析核心）。
 * 兼容导出（steer.spec.ts 消费）；TuiApp 内部走实例注册表（含扩展命令）。
 * @param input - 输入行提交的原始文本（已 trim）。
 * @returns 匹配的命令名与剥离后的参数文本；未匹配返回 null。
 */
export declare function parseSlashCommand(input: string): {
    kind: string;
    text: string;
} | null;
/**
 * 会话界面主装配。生命周期：构造 → attach()（接管终端）→ dispose()（恢复终端）。
 * attach 前不写终端；dispose 后终端恢复 raw-mode 前状态。
 */
export declare class TuiApp {
    private readonly ctx;
    private readonly stdout;
    private readonly stdin;
    private readonly commit;
    private readonly commitSurface;
    private readonly live;
    private readonly input;
    private readonly inputLine;
    private readonly resize;
    private readonly blockWriter;
    private readonly streamRenderer;
    /** 渲染性能监测（--debug-perf / RIVET_DEBUG_TELEMETRY=1 时激活；默认零开销）。 */
    private readonly perfMonitor;
    /** 输入状态控制器（slash 提示 / Tab 补全数据源，W-B5 提取的输入状态）。 */
    private readonly inputController;
    /** Slash 命令注册表：内置命令 + 'tui.commands' 服务面（外部插件可扩展）。 */
    private readonly slash;
    /** Ctrl+P 命令面板（overlay 渲染经 OverlayController 进出 alt screen）。 */
    private palette;
    /** API key 就绪标志（footer 右侧段；attach 时经 credentials.describe 刷新）。 */
    private apiKeyReady;
    /** composer 附件缩略图（半块预览；提取为 controllers/attachment-preview）。 */
    private attachmentPreview;
    /** 运行中提交的本地排队（turn/end 投递、↑ 取回；见 controllers/submit-queue）。 */
    private readonly submitQueue;
    /** /key、/login：API Key 设置对话框（掩码输入 + 联网验证 + 落盘）。 */
    private keyDialog;
    /** /key 供应商密钥配置装配层（key-wizard/key-dialog 之上；deps 注入 openKeyDialog）。 */
    private keyFlow;
    /** /key 首启自动弹窗禁用（宿主/测试装配显式关闭；缺省 false=启用）。 */
    private readonly disableKeyAutoPrompt;
    private readonly themeWarnings;
    private overlay;
    /** C3 项 3：rewind overlay（/rewind 双阶段回退面板）。 */
    private rewindOverlay;
    /** P2：memory 浏览器 overlay（/memory 记忆列表/过滤/删除）。 */
    private memoryOverlay;
    /** #31：交互式选择器 overlay（/model /theme /session 无参打开；上下键选择）。 */
    private picker;
    /** 统一 action registry：键路由/快捷键面板/footer 提示的单一事实来源。 */
    private readonly actions;
    /** 动作执行上下文门面（createActionContext 装配；闭包注入私有方法）。 */
    private readonly actionCtx;
    /** 阻塞态键上下文轮询表（现状顺序保持：question > btw > approval）。 */
    private readonly blockingKeys;
    /** slash 命令菜单键上下文（轮询位置在主段动作之后、inspect 之前——现状顺序）。 */
    private readonly menuKeys;
    /** inspect 上下文键（轮询位置在 slash 菜单之后——现状顺序保持）。 */
    private readonly inspectKeys;
    /** overlay 键路由器（key-dialog/picker/search/scroll/rewind/memory/palette 委派）。 */
    private readonly overlayRouter;
    /** footer 检查面板提示段（registry 构造期投影；审批段改由 renderLive 逐帧投影——p 段动态）。 */
    private readonly footerInspectHints;
    /** Phase 9d：流利度追踪（tool 事件 → 渲染策略；stale 提示消费于 renderLive）。 */
    private readonly fluency;
    /** Phase 5.3：底部 glance（状态/错误行派生 + 节流；renderLive 消费 current()）。 */
    private readonly glance;
    /** Phase 5.3：glance metrics 行的 model 名缓存（会话挂载时更新一次；
     *  renderLive 每帧读缓存，不重复查询 agentDefaultModel——模型定路是
     *  mount 时的决策，渲染不该引入额外的 currentSelection 读取）。 */
    private glanceModelName;
    /** 推理努力度缓存（挂载时 request/header 优先、currentSelection 兜底；
     *  request/header 事件更新——与 glanceModelName 同生命周期）。 */
    private glanceEffort;
    /** 会话内最后一条 assistant/message 的 usage（缓存命中/上下文占比数据源；
     *  streamFeed 折叠，随会话挂载/卸载）。 */
    private usageFold;
    /** 会话成本累计（assistant/message usage 按模型分桶；/cost 数据源，
     *  随会话卸载复位）。 */
    private sessionCosts;
    /** 当前模型路由的上下文窗口（request/context 事件折叠；adapter 未报时 null）。 */
    private contextWindow;
    /** git 未提交改动文件数（gitDirtyCount 快照；attach + turn/end 刷新，0 = 干净/非仓库）。 */
    private gitDirty;
    /** A5：手动展开的进行中工具卡 callId（空输入 Enter 切换；turn/end 复位）。 */
    private expandedToolCallId;
    private transcript;
    private liveAgent;
    private controls;
    /** 工作流阶段/活动投影（Phase 5.1/6.2）；随会话挂载/卸载，dispose 时解绑订阅。 */
    private statusLine;
    /** 流式提交供给的 session/event 订阅；随会话挂载/卸载。 */
    private streamFeed;
    /** 本层经 create/resume 铸造的 handle；非 registry 兜底的裸 agent。dispose 时释放。 */
    private ownedHandle;
    private readonly initialSessionId;
    private readonly themeName;
    private readonly onExit;
    private readonly onRestart;
    /** 外部编辑器触发键（Phase 6.4）；缺省 ctrl_e（ctrl+o 已恢复为推理展开）。 */
    private readonly editorKey;
    /** 外部编辑器命令注入（测试用）；缺省走环境变量/平台缺省。 */
    private readonly editorCommand;
    /** T1.1：5 域投影缓存（snapshot 全量 + onChanged 按 key 分流；服务缺失时为 null → 整体降级）。 */
    private projectionCache;
    /** T4：任务窗格——sessionProjections 任务单元投影快照（服务缺失时为 null）。 */
    private taskItems;
    /** T2.1：委派树面板显隐（/subagents 切换）。 */
    private subagentsPanelVisible;
    /** T2.2：workflow 运行中面板显隐（/workflow 切换）。 */
    private workflowPanelVisible;
    /** T2.1：子代理委派域（树缓存/运行行缓存/他会话投影入口）——提取自本文件，见 controllers/delegation-surface.ts。 */
    private readonly delegationSurface;
    private readonly activityBandEnabled;
    private readonly activityBandMaxRows;
    /** T2.2：workflow 事件域（订阅/运行态缓存/终态折叠）——提取自本文件，见 controllers/workflow-surface.ts。 */
    private readonly workflowSurface;
    /** T2.3：后台任务同步快照（tasks.list() 每次事件/会话挂载刷新）。 */
    private taskSnapshots;
    /** T2.3：onTaskDone 完成通知（live 区提示行；一次性，渲染后清空）。 */
    private taskNotice;
    /** T3.2：/config 面板投影（打开后恒有终端段；null = 尚未刷新）。 */
    private configProjection;
    /** #39：技能展示面控制器（快照缓存 + userInvocable 过滤 + slash 菜单投影 + 手势 MRU）。 */
    private readonly skillSurface;
    /** 检查类面板（/config /skills /status /lsp /tasks）互斥开闭。 */
    private readonly inspect;
    /** LSP：诊断桥（懒创建——首次工具触碰文件或 /lsp 打开时实例化；dispose 销毁）。 */
    private lspBridge;
    /** LSP：装配配置（enabled/timeoutMs/spawnFor/which；缺省启用）。 */
    private readonly lspConfig;
    /** T3.1：userQuestions provider 注册 disposer；attach 注册、dispose 释放。 */
    private interactionDisposer;
    /** T3.1：挂起提问状态机（pendingQuestion + questionFeedbackMode；Wave 1 提取）。 */
    private readonly question;
    /** C3 项 4：审批挂起状态机（pendingApproval + alwaysApprove；Wave 1 提取）。 */
    private readonly approval;
    /** P1：/btw 侧问状态机（临时 btw agent 旁路；Esc 折叠答案入 scrollback）。 */
    private readonly btw;
    /** T2.1：subagent 生命周期事件订阅 disposer；随会话挂载/卸载。 */
    private subagentDisposer;
    /** T2.2：workflow 事件订阅 disposer；attach 订阅、dispose 释放（跨会话运行）。 */
    private workflowDisposer;
    /** T2.3：tasks onTaskDone 订阅 disposer；随会话挂载/卸载。 */
    private taskDoneDisposer;
    /** T2.3：tasks attachSurface('tui') 控制面 disposer；attach 声明、dispose 释放。 */
    private taskSurfaceDisposer;
    /** T1.4：plan 投影 active 态（驱动 statusline [plan] 徽标；服务缺失时为 false）。 */
    private planState;
    /** C2 项 4：当前会话的模型选择 ref（newSession/switchSession 挂载；registry 兜底为 null）。 */
    private modelRef;
    /** C2 项 2：历史搜索 overlay（Ctrl+F；attach 时注册，消息快照激活时提供）。 */
    private searchOverlay;
    private scrollPager;
    /** /todos 紧凑待办面板显隐（/todos 切换；数据源为 todos 投影的保留快照）。 */
    private todosPanelVisible;
    /** /todos all 看全表（false = 默认最多 5 条）。 */
    private todosExpanded;
    /**
     * todos 保留快照：只吸收非空投影值。todos 投影在 turn/start 时被 fold 重置
     * 为 null（tool-todo 的投影语义：清单随回合开始清空），若面板直接跟随投影，
     * 每回合开始都会闪烁消失——保留快照让已显示的清单跨回合黏滞，null 只在
     * 会话首次写入前出现（渲染「尚无待办」空态）。
     */
    private todosRetained;
    /** 本会话仍允许首次非空 todos 自动开面板；关掉或 /clear 后解除。 */
    private todosAutoArmed;
    /** T4：任务投影变更订阅 disposer；随会话卸载释放。 */
    private projectionDisposer;
    /** T5：紧凑渲染模式（/density 切换）——工具卡仅标题行。 */
    private compactMode;
    /** reasoning 流缓冲（reasoning-delta 累积）；段结束 commitReasoningBlock 落底清空。 */
    private reasoningText;
    /** 当前推理段起点（首个 reasoning-delta 的事件时间，Unix epoch ms）；live/落底耗时数据源。 */
    private reasoningStartedAt;
    /** 最近一次已落底推理块（折叠头行 + 保留全文；Ctrl+O 展开查看）。会话切换清理。 */
    private lastReasoningBlock;
    /** Ctrl+O 展开/收起最近推理块（live 区展示全文；scrollback 保持折叠头行）。 */
    private reasoningExpanded;
    /** 进行中工具的 presentCall 标题覆盖（callId → title）；result/abort/换会话清理。 */
    private readonly pendingCallTitles;
    private activeSessionId;
    private history;
    /** P1：本地偏好（~/.dsh-tui/prefs.json；prefsPath null = 禁用——VITEST 密封门）。 */
    private prefsPath;
    private prefs;
    private inputHistoryPath;
    private tick;
    private ticker;
    /** 上一帧 idle key；overlay 退出时置空，强制下一帧组装。 */
    private lastIdleKey;
    /** 错误落底/回填控制器（C4 提取；回流 Tianshu lastSubmittedText 语义）。 */
    private readonly errorAnnouncer;
    /** 历史渐进重放代际（commitRows 每次递增；快速切换会话时旧链自毁）。 */
    private replayEpoch;
    /** 历史重放进行中（streamFeed 新事件进 backlog 排队，见 commitRows）。 */
    private replayActive;
    /** 重放窗口内排队的 stream 事件（重放完按序回放 handleStreamEvent）。 */
    private streamEventBacklog;
    /** ticker 路径才允许 shouldSkipIdleAssemble；flush/batcher 必须组装。 */
    private renderLiveFromTicker;
    private disposed;
    /** attach() 完成后才往 scrollback 写更新提示（避免欢迎页之前的空窗）。 */
    private attached;
    private pendingUpdateNotice;
    /** 自更新失败提示（attach 前排队，attach 后 flush；P1-1）。 */
    private pendingUpdateFailNotice;
    /** OSC52 不支持警告：每进程首次触发时提示一次（P1-1；newSession 不重置，避免重复打扰）。 */
    private osc52WarningShown;
    /** bracketed paste 处理器 disposer（attach 注册，dispose 释放）。 */
    private pasteDisposer;
    /**
     * 动态段高水位（display rows），跨轮保留。回缩会使输入框上跳，并把旧轨线
     * 留在空隙里（重影）。新会话 / 切会话时归零。
     */
    private dynamicRowsHighWater;
    /** 渲染帧合并器：事件路径走 schedule（16ms 合并），critical 路径走 flushLiveRender。 */
    private renderBatcher;
    /** 上次输入框获得焦点的时间戳（Ctrl+V 剪贴板读图防抖；overlay 关闭后
     *  FOCUS_DEBOUNCE_MS 内走文本路径，避免把 overlay 里的图误附进输入框）。 */
    private lastInputFocusAt;
    /** 主控模型是否原生支持识图（图片附件气泡提示；装配方经 options.vision 注入）。 */
    private supportsVision;
    /** 是否配置独立识图桥模型（主控不识图时经桥转文字描述后发送）。
     *  装配方经 options.vision 注入；未注入时提交图片前按 visionBridge 服务
     *  存在性探测补齐（resolveVisionBridge）。 */
    private visionBridgeEnabled;
    /** 识图桥来源（'configured' / 'auto' / 'none'；气泡提示文案用）。 */
    private visionBridgeSource;
    /** 投影层：turn 级工具统计 fold（turn/end 摘要行数据源；mountSession 复位）。 */
    private turnSummary;
    /** 投影层：会话级跨 turn 汇总 fold（/status 会话段数据源；mountSession 重放重建）。 */
    private sessionSummary;
    constructor(options: TuiAppOptions);
    /** Phase 8：审批 answerer 订阅的 disposer（dispose 时解绑）。 */
    private approvalDisposer;
    /** 当前会话 id（null = 尚未 attach）。 */
    get sessionId(): SessionId | null;
    /**
     * A1/A2：等待若干服务完成激活（fiber state 2，即 init 钩子已跑完、文件数据
     * 已装载）后再做首帧渲染。credentials/settings 由 dsh-base 异步激活（读文件 +
     * watcher），可能晚于本 runner——不等的话欢迎页会误报 API Key ✗、顶栏显示
     * 默认模型（settings 里的 agent-default-model 未生效）。
     *
     * 服务未注册（不在本 profile 组成中）时跳过；有界等待避免服务缺失时挂死。
     * 超时仍未激活则 warn 后继续（fail-soft：启动不挂死，但模型/API Key 可能仍是缺省）。
     * @param names - 要等待的服务名。
     * @param timeoutMs - 最大等待毫秒（缺省 5000）。
     */
    private waitForServicesReady;
    /**
     * 宿主服务（cmdlineArgs/appExit）就绪窗口：launcher 在 boot prepare 里
     * provide，正常时序下 attach 时已注册（0 等待）；仅当检测到宿主特征
     * （任一服务已注册）时为缺失方做短窗口轮询，覆盖 provide 略晚于装配的
     * 罕见时序。两服务均未注册 = 非宿主环境，立即返回。
     * @param timeoutMs - 最大等待毫秒（缺省 200）。
     */
    private waitForHostServices;
    /**
     * 接管终端：切主题（'auto' 探测背景）、装配会话、注册键路由与 resize、启动渲染 ticker。
     * @param initialSessionId - 覆盖构造选项的起始会话；缺省用构造 initialSessionId，
     *   再缺省恢复最近会话（live store 为空才新建）。
     */
    attach(initialSessionId?: SessionId): Promise<void>;
    /**
     * 自更新落盘后的用户提示。模块已加载，新代码要重启才生效。
     * attach 完成前调用则排队，完成后写入 scrollback。
     */
    notifyPluginUpdated(version: string): void;
    /** 自更新后将自动重启的提示（装配方随后触发重启）。 */
    notifyAutoRestart(version: string): void;
    /**
     * 当前会话是否 blank：无消息且无未结算工具调用。
     * /preset recompose 与更新后自动重启的守卫共用（非空白不打断会话）。
     */
    isBlankSession(): boolean;
    /** 更新提示落盘：attach 完成前排队（pendingUpdateNotice），完成后写 scrollback。 */
    private notifyUpdateLine;
    /**
     * 自更新失败的用户提示（P1-1；文案 #43 反馈优化）：可操作引导优先——
     * 重试/手动命令/关闭开关，而不是只甩环境变量。attach 完成前调用则排队。
     */
    notifyPluginUpdateFailed(error: string): void;
    /** T3.1：结构化提问 answerer——薄转发 QuestionController（渲染/ESC/重绘由控制器回调承担）。 */
    private handleQuestionRequest;
    /**
     * bracketed paste 文本落地（右键粘贴/终端菜单粘贴）：先尝试剪贴板读图
     * （命中则附图并吞掉这段 paste——粘贴进来的文本是图片字节的乱码，不插图
     * 会污染输入框）；再识别图片路径加载为附件；最后才是普通文本插入。
     * @param text - 终端传来的粘贴文本
     */
    private handlePaste;
    /**
     * Ctrl+V 处理：优先读剪贴板图片 → 失败则 fallback 到文本粘贴。
     * 焦点防抖：输入框在最近 FOCUS_DEBOUNCE_MS 内刚「重获焦点」（overlay
     * 关闭近似——终端 raw mode 下无窗口焦点事件）时跳过读图，避免把粘贴进
     * 对话框/选择器的那次 Ctrl+V 再当一次读图。
     */
    private handleCtrlV;
    /**
     * 剪贴板位图附件化：dataUrl 解回字节后走与文件路径同一条预算管线
     * （magic 校验 + 原样直发 + 三级自适应压缩）——超限大图在此被压缩或
     * 响亮失败，而不是挂上后在提交时被静默丢弃。
     * @param dataUrl - 剪贴板读图结果（data:image/...;base64,...）。
     * @param name - 附件显示名。
     */
    private attachClipboardImage;
    /**
     * 设置当前主控模型的识图能力与桥接状态（图片附件气泡提示数据源）。
     * 由装配方按 agent 配置注入；TUI 是纯表现层，不自行查询模型能力。
     * @param supportsVision - 主控模型是否原生支持识图（图片直发）
     * @param bridgeEnabled - 是否配置了独立识图桥模型（主控不识图时经桥转描述）
     * @param bridgeSource - 识图桥来源（configured/auto/none；气泡提示文案用）
     */
    setVisionInfo(supportsVision: boolean, bridgeEnabled: boolean, bridgeSource?: 'configured' | 'auto' | 'none'): void;
    /**
     * 宿主视觉桥探测：视觉桥插件（dsh-vision-bridge）装配时应 provide('visionBridge')
     * 服务，存在即视为桥可用（来源按 configured 处理，装配方注入过 bridgeSource 时
     * 保留注入值）。显式注入 vision.bridgeEnabled 时短路；否则每次提交图片前补探，
     * 覆盖桥插件晚于 tui-runner 激活的装配时序（reflect.get 是字典读，代价可忽略）。
     * @returns 当前是否有可用识图桥。
     */
    private resolveVisionBridge;
    /** T3.1：结算挂起的提问（用户选择/取消）——薄转发。 */
    private settleQuestion;
    /** T3.1：取消挂起的提问（Esc/Ctrl+C）——薄转发。 */
    private cancelQuestion;
    /**
     * 查 DEEPSEEK_API_KEY 是否已配置：优先 credentials.describe（含 file / .env 层），
     * 服务缺失或抛错时回退 process.env。欢迎页与 footer 共用，避免只看环境变量的误报。
     */
    private refreshApiKeyReady;
    /**
     * 按当前主控模型刷新识图标志。llm 服务缺失或查询失败时保持原值；
     * inputModalities 含 image 才直发图片，否则走桥或「未发送」。
     */
    private refreshVisionForSelection;
    /** 当前会话工作区：header.cwd 优先，缺省回退启动目录。 */
    private sessionCwd;
    /**
     * 懒创建诊断桥：首次工具触碰文件或 /lsp 打开时实例化（rootUri = 当时
     * 会话 cwd）；缓存更新回调触发 renderLive（WriteBatcher 节流）。
     */
    private ensureLspBridge;
    /**
     * 从工具参数提取文件路径并触发诊断拉取（write/read/edit 族；无 path 参数
     * 的工具如 bash 不触发）。嵌套工具调用（multi_tool_use 的 tool_uses）递归
     * 展开。只读展示：拉取失败/超时静默，不阻塞工具流。
     * @param argumentsRaw - tool/call 事件参数原文。
     */
    private touchLspPaths;
    /** /lsp 面板数据源：桥未创建（从未触碰文件）→ []。 */
    private lspDiagnosticsView;
    /**
     * 工具卡标题徽标：参数里的文件有已就绪诊断 → `⚠ 1错 2警`；否则 null
     * （拉取中/无诊断/桥未创建/无 path 参数均不显示，不干扰标题）。
     */
    private lspBadgeFor;
    /**
     * Ctrl+S / 欢迎「恢复」：切到 listSessions 里最近的非当前会话（含 persistence）。
     * live store 没有时走 switchSession → resume。
     */
    private restoreRecentOtherSession;
    /**
     * Phase 9b：把可恢复会话列表写进 scrollback（启动时）。
     * 排除当前活跃会话；无其他可恢复会话时静默（不占位）。
     * live 标注取 live store（listSessions 的 header 无 live 字段，
     * 经 ctx.sessions.list() 的 id 集合判定）。
     */
    private renderRestorableSessions;
    /**
     * 新建会话：经 ctx.agents.create 铸造 session+agent，本层持有 handle。
     * 模型定路取 agentDefaultModel 当前选择（settings 用户层实时生效），并经
     * installModelSelection 耦合 prompt 装配与请求路由（headless 同款接线）。
     * 会话 id 由本层铸造（session-<uuid>），create 返回的 handle 由 ownedHandle 持有、
     * detach/dispose 时释放；controls 走 controlsFromHandle（驱动 handle.agent）。
     * 先卸载当前挂载（与 switchSession 对称）：否则 transcript/liveAgent/
     * statusLine/streamFeed 被覆盖即泄漏监听器，旧 ownedHandle 丢失即泄漏 agent。
     * @param reuse - 可选的启动复用空会话：id 复用、header.cwd 重绑启动目录；
     *   跨目录复用时先清掉旧目录的空 artifact（后端按 cwd 分目录存 artifact，
     *   同 id 双目录会被 duplicate/collision 拒绝）；清理不可行则退回全新 id。
     * @returns 新会话的 id（本层铸造或复用）。
     */
    newSession(reuse?: SessionSummary): Promise<SessionId>;
    /**
     * C2 项 4：热切当前会话的模型。改 modelRef.current——下一次 agent 步进
     * （prompt assembly）自动生效，不中断当前步骤。registry 兜底的会话
     * （ref 由其他装配方持有）返回 false，调用方提示不可热切。
     * @param selection - 新的 provider/model。
     * @returns 是否已热切（modelRef 存在）。
     */
    switchLiveModel(selection: ModelSelection): boolean;
    /** A3：create({ seed }) 铸 child；禁止 fork 后再 resume live 会话。 */
    forkSession(opts?: {
        directive?: string;
    }): Promise<SessionId>;
    /**
     * C3 项 3：打开 rewind overlay（/rewind）。检查点 = transcript 里真人用户
     * 说过的非空 `user/message`；执行回调做「文件回退 + 会话截断 + 持久化截断」。
     * @returns 是否已打开（无活跃会话或无可回退用户消息时 false）。
     */
    rewindSession(): boolean;
    /**
     * P1：发起 /btw 侧问——BtwController 旁路（临时 btw agent，不持 ownedHandle、
     * 不经过 switchSession）。返回是否已发起：无活跃会话或已有挂起侧问时 false
     * （命令分发层回显提示）；创建/提问失败抛错由 runSlash 统一回显。
     * @param question - 侧问文本（已 trim）。
     * @returns 是否已发起。
     */
    private askBtw;
    /**
     * T3：/export 会话导出——把当前会话完整事件日志渲染为 Markdown 并写盘。
     * 数据源是 session.events（权威事件流，非渲染视图）：完整内容、无折叠截断。
     * path 缺省 = 会话创建目录下 `dsh-export-<id>.md`（header.cwd 缺失时回退
     * 当前进程 cwd）。无活跃会话或写盘失败抛错——命令分发层回显失败（fails loud）。
     * @param path - 目标文件路径；缺省由会话 cwd 决定。
     * @returns 实际写入的导出文件路径。
     */
    private exportTranscript;
    /**
     * P2：打开 memory 浏览器 overlay。条目快照 + 删除回调在激活时经 memory
     * 服务注入（reflect 动态获取；服务缺失返回 false，命令层回显不可用）。
     * @returns 是否已打开。
     */
    private openMemoryBrowser;
    /** #31：打开模型选择器（Enter 本会话 / S 写默认）。 */
    private openModelPicker;
    /**
     * C2 项 2：历史搜索 overlay 开关（Ctrl+F 与 vim NORMAL '/' 共用入口）。
     * 打开时快照 transcript 消息；已打开则关闭。
     */
    private toggleHistorySearchOverlay;
    /** /scroll 分页查看器开关：打开时快照 CommitEngine 全文，已打开则关闭。 */
    private toggleScrollPager;
    /** P1：偏好原子落盘（禁用态 no-op；prefs 已就地变更）。 */
    private persistPrefs;
    /** P1.5：提交文本进输入历史——内存（Ctrl+P/N 即时可用）+ 磁盘异步追加（重启恢复）。 */
    private pushHistory;
    /** P1：应用主题并持久化（/theme 与 picker 确认共用的写透点；未知主题 no-op）。 */
    private applyThemeAndPersist;
    /** /theme auto：探测明暗；persist 时才写 prefs。 */
    private applyThemeAuto;
    /** P1：/theme export——委托 theme-custom（模板构建 + 就地注册属于主题域）。 */
    private exportTheme;
    /** #31/#33：主题选择器（Enter 本会话 / S 写默认；↑↓ 预览，Esc 还原）。 */
    private openThemePicker;
    /** /effort 无参：推理等级选择器。 */
    private openEffortPicker;
    /** #31：打开会话选择器（今天/昨天/本周/更早分组；当前 ● 高亮）。 */
    private openSessionPicker;
    /**
     * C3 项 3：执行回退。mode 决定范围：
     * - convo：仅截断会话（内存 + 持久化）
     * - code：仅文件回退（FileHistory.rewindToBoundary）
     * - both：两者
     * 持久化失败向上抛（RewindOverlay 显示错误）；文件快照缺失计入 filesSkipped。
     * @returns 文件变更数/缺口数与截断 seq。
     */
    private executeRewind;
    /** 文件回退：收集 atSeq 之后的写工具 callId，经 fs-snapshot FileHistory 恢复。 */
    private rewindFiles;
    /**
     * 会话截断：先持久化后内存——truncateStored 失败时内存不动（状态一致、
     * 可重试），成功后再截内存态（同步纯内存操作，不抛错）。
     * 公开版 dsh-session 以 fork 派生代替内存截断，Session 无 truncate 能力
     * 时 fails loud（rewind 的 convo/both 模式在无截断能力的宿主上不可用）。
     * @param atSeq - 截断到的 seq（含）。
     */
    private truncateSession;
    /**
     * 切换到既有会话：卸载旧投影/控制面（并释放本层持有的旧 handle），
     * 再 agent-ensure 目标会话——registry 有 live agent 走 controlsFromRegistry 兜底
     * （非自有，不 dispose）；无则 resume 拿 handle（本层持有并 dispose）。
     * resume 的模型定路沿用会话持久化的 request header（跨重启续模），
     * 无 header（从未成功发起请求的会话）才落 agentDefaultModel 当前选择。
     * 恢复先于任何切换状态提交：目标不可恢复时在此抛错，应用停留在原会话（不进入半切换态）。
     * @param id - 目标会话 id；live 会话或可恢复的持久化会话。
     */
    switchSession(id: SessionId): Promise<void>;
    /** 按键面切换：失败回显 ⚠ 并停留原会话（rejection 不逃逸成 unhandled）。 */
    private switchSessionGuarded;
    /** 首次非空 todos 打开紧凑卡；关掉或 /clear 后本会话不再自动开。 */
    private tryAutoOpenTodos;
    /**
     * 挂载当前会话的投影与控制面：transcript/live/controls 就位后，
     * 将已提交的历史渲染进 scrollback。
     * @param id - 目标会话 id（activeSessionId 已在调用方设置）。
     */
    private mountSession;
    /** T3.2：刷新 /config 投影（宿主服务可缺；终端段始终带上）。 */
    private refreshConfigProjection;
    /** /config notify 与空输入 n：写 prefs 并刷新终端段。 */
    private applyNotifyPref;
    /** 回显警告行到 scrollback（fails-loud 提示共用出口）；hint 给 dim 色 `  ↳ ` 恢复指引尾随行。 */
    private echoWarn;
    /** 当前主题（动态读取，切主题后立即生效）。 */
    private get theme();
    /**
     * 统一 scrollback 写入委托（C4 第二波：实现已抽至 controllers/commit-surface——
     * 原子提交编舞 / overlay 暂存补写 / 用户气泡与图片链路，详见该模块 docstring）。
     * 全仓 ~28 个调用点保留本薄委托，签名不变。
     */
    private commitToScrollback;
    /**
     * 提交用户输入：追加输入历史、将用户消息渲染进 scrollback、
     * 走 adapter.send 的 followup 驱动 agent。slash 命令（/steer）分流到 handleSteer。
     * @param text - 输入框提交的文本；空文本但无图时 no-op
     * @param images - 输入框携带的图片附件 data URL 列表（可省略）
     */
    handleSubmit(text: string, images?: string[]): void;
    /** turn/end → 本地队列按序投递（气泡 → followup）；aborted 不 flush——打断后可能想 ↑ 取回。 */
    private flushSubmitQueue;
    /**
     * 执行一条 slash 命令：注册表解析 → handler 运行 → 回显/错误提示。
     * 命令回显写 scrollback（用户可见），但不写回 session log（dsh 纪律：
     * 命令执行是 UI 层副作用，session 事件词汇不变）。
     * @param input - 输入行提交的原始文本（已 trim，以 / 开头）。
     */
    private runSlash;
    /**
     * A1：把未命中的 slash 输入委托给 CommandService（cordis 命令通道）。
     * 无会话、commands 服务未装配、或命令未知名（execute 返回 undefined）时
     * 返回 false，由调用方维持「未知命令」回显；成功/失败回显在此完成。
     * @param input - 完整 slash 输入（含 / 前缀）。
     * @param echo - scrollback 回显回调。
     * @returns 命令是否被 CommandService 受理（true 时调用方不再回显未知命令）。
     */
    private runCordisCommand;
    /**
     * 提交中轮转向：渲染差异化 steer 消息（marker/颜色区分 user）进 scrollback，
     * 走 adapter.send 的 steer API。空文本 no-op（/steer 无参数、Ctrl+T 空输入）。
     * @param text - 转向文本。
     */
    private handleSteer;
    /**
     * 取消当前 agent 活动：Ctrl-C 走 adapter.cancel（cause { kind: 'user' }）。
     * 空闲时 Ctrl-C 幂等 no-op。
     */
    /**
     * Phase 8：审批 answerer 入口——薄转发 ApprovalController（短路/委托/挂起
     * 由控制器内聚，会话归属经 getCurrentSessionId 注入）。
     * @param req - 待决审批请求。
     * @param next - waterfall 委托（不处理时调用）。
     * @returns 用户决定（allowed-once/rejected/cancelled）或 next() 结果。
     */
    private handleApprovalRequest;
    /** 取消当前运行（Esc/Ctrl+C）：cancel agent（keepInbox——宿主 inbox 未消费的 steer/排队残留保留）、丢弃未发出的流式/推理缓冲并重置流渲染。 */
    /** 最近一次 Ctrl+C 字节（0x03）处理时间戳；0 = 未处理过（SIGINT 防抖用）。 */
    private lastCtrlCAt;
    /** 最近一次 handleAbort 时间戳；0 = 未打断过（双击 Esc rewind 的 grace 守卫数据源）。 */
    private lastAbortAt;
    /**
     * Windows 双触发防护：最近 800ms 内 Ctrl+C 字节（0x03）已处理（打断/退出）时，
     * 紧随的 SIGINT 应被忽略——否则刚打断的 TUI 被 teardown 拆掉（输入框消失、
     * 进程存活）。装配层（index.ts）的 SIGINT handler 先查此门再决定是否退出。
     * @param now - 当前时间戳（注入便于测试）。
     * @returns true = SIGINT 应忽略（0x03 刚处理过）。
     */
    shouldDeferSigint(now: number): boolean;
    /** slash 注册表当前命令名集合（现取——/lsp 等动态注册命令不误判为路径）。 */
    private isKnownCommand;
    /** name 是否为某个已注册命令的前缀（/h → help；模糊输入仍视为命令）。 */
    private isCommandPrefix;
    handleAbort(): void;
    /**
     * Phase 6.4：打开外部编辑器编辑当前输入行。编辑器是外部进程，必须暂时退出
     * raw-mode（spawnSync 阻塞期间 ticker 暂停），任何路径（含失败）都恢复。编辑结果回填输入行。
     */
    private openExternalEditor;
    /**
     * Tab 补全（Phase 6.3）：委托 InputController 状态机——首次 Tab 解析
     * 光标前 @ 路径 token 的候选并应用首项，再次 Tab 循环。无 @ token 时
     * 返回 false，Tab 保持原行为（InputLine 照常发出 'tab' 事件）。
     */
    private handleTabComplete;
    /** 把 slash 注册表投影到 InputController（菜单 / Tab 补全数据源）。
     * 注册表可被外部插件经 tui.commands 服务在构造后扩展（回流 tianshu
     * bc5cec1359：bundle 行序使插件 apply 晚于 TUI 构造），故每次输入变化前
     * 重投影一次；#39 技能条目由 skillSurface 缓存合并，重投影不会丢。
     * 列表很小，成本可忽略。
     */
    private syncSlashHints;
    /** slash ghost 预览：菜单选中命令补全剩余（/th→eme）；完整命令名+尾空格 → 参数占位。
     *  菜单关闭/光标不在末尾/无补全关系 → null。 */
    private slashGhostText;
    /** fish 式历史建议 ghost：prefs 关 / `/` 开头 / 光标不在末尾 / 有选区 / vim normal → null。 */
    private historyGhostText;
    /** 接受 slash 菜单当前选中项（Tab / Enter）：Enter 且输入已是完整命令名 →
     *  关菜单直接提交（opts.submit）；否则补全命令名（有 argsHint 补到 `cmd `
     *  留参数位，参数建议留待下一批）后关菜单。 */
    private acceptSlashCompletion;
    /**
     * C3 项 4：Shift+Tab 三态循环（对齐 grok 的两轴模型，plan 与 permission 正交）：
     * Normal → Plan（planMode.set(true)）→ Always-Approve（plan off + 本地短路）→ Normal。
     * plan 切换经 planMode 服务（投影总线驱动 planState 徽标）；always-approve 是
     * 纯 TUI 本地标志（不持久化，退出即失），对审批 answerer 短路放行。
     * alwaysApprove 优先判断：它是同步本地态；planState 经投影异步更新，
     * 若按投影判断会在 Always-Approve 态误走回 Plan 分支。
     */
    private cycleMode;
    /**
     * /yolo：全放行模式快捷入口（approval always-approve 的显式开关）。
     * 与 Shift+Tab 循环进 always-approve 同语义（allowed-once 短路），但提供
     * 命令入口；退出会话时 app 侧复位逻辑（setAlwaysApprove(false)）同样覆盖。
     * @param flag - true 开启全放行（后续审批自动放行）；false 关闭。
     */
    private setYoloMode;
    /** C3 项 4：经 planMode 服务切换 plan 状态（服务缺失时回显警告，不再静默）。 */
    private setPlanMode;
    /** /key：Ctrl+V 读剪贴板文本进 Key 字段（空文本忽略；readTextFromClipboard 平台缺失时返回 null）。 */
    private pasteClipboardIntoKeyDialog;
    /** /update：对照 npm latest 的只查不装检查（用户看到提示后手动更新；失败不抛）。 */
    private runUpdateCheck;
    /**
     * 键路由（统一 action registry）：布防清扫 → 早段全局动作（overlay 之前——
     * shift_tab/ctrl_n 等在面板打开时先生效）→ overlay 委派 → 阻塞上下文轮询
     * （question > btw > approval）→ 主段动作（esc/ctrl_c/ctrl_o/editorKey/
     * ctrl_t/ctrl_v）→ slash 菜单 → inspect 上下文键 → 尾段动作 → InputLine 兜底。
     */
    private handleKey;
    /** A5：最后一张进行中工具卡（空输入 Enter 展开目标）；无则 undefined。 */
    private latestPendingToolCall;
    /** 动作执行上下文门面（ActionContext）：when/run 只经此触达本类私有方法
     *  （registry 不 import 本类）；confirmMs 原语转发 registry 布防状态。 */
    private createActionContext;
    /**
     * Phase 5.3：glance 一行条的可得数据。model（request header 优先、
     * agentDefaultModel 兜底）、effort（同构）、缓存命中率与上下文占比
     * （最后一条 assistant/message 的 usage 折叠）、上下文窗口
     * （request/context 折叠）、turn 数、本轮耗时。任何数据缺失 → 对应段
     * 省略（glance 段组装按可得段渲染，窄宽渐进 drop）。
     * 无可渲染数据返回 null（不占位）。
     */
    private glanceMetrics;
    /**
     * 历史行渐进落底（任务5，2026-08-27）：大会话 attach 不再单 tick 全量写入。
     * 首片同步 commit（首帧即有内容），余片经 setImmediate 链逐片追加——每片
     * 走原子提交编舞（sync 窗内 erase+append+重绘，无撕裂），事件循环在片间
     * 让位，输入/渲染不再被千行会话冻住一拍。
     *
     * 顺序与代际守卫：replayEpoch 每次 commitRows 递增，快速切换会话时旧链在
     * 下一片前自毁；重放期间 streamFeed 新事件由 mountSession 的 backlog 排队
     * （见 streamFeed 接线注释），最后一片写完置 replayActive=false 并按序回放。
     * dispose/epoch 不匹配即刻停止，不写半截。
     *
     * @param rows - renderHistoryRows 产出的已渲染行（保持时间顺序）。
     */
    private commitRows;
    /** 当前主题变化后，清理终端并用最新颜色重放当前会话历史。 */
    private rerenderHistory;
    /** 生成当前会话历史消息的主题化渲染行。 */
    private renderHistoryRows;
    /**
     * 摄入一段压缩模型流（AssistantStreamRecord 展开后的逐 delta 处理）：
     * text-delta 推进 blockWriter（正文开始即推理段结束点——推理段先于本
     * step 一切 text-delta，此刻 blockWriter 必为空，顺序天然安全）；
     * reasoning-delta 进推理通道（首 delta 记时间戳）。attempt 实时事件与
     * assistant/message 内嵌流的回退渲染共用本管线（#58）。
     * @returns 本次是否摄入过 delta（流为空时调用方需折 message.content 兜底）。
     */
    private ingestAssistantStream;
    /**
     * 流式事件供给：assistant text-delta 推进 blockWriter（节流切块，稳定前缀
     * commit 进 scrollback）；message/turn 边界 flush + finalize 收尾。aborted
     * turn 的残文由 handleAbort discard/reset，不在此 commit。
     * @param event - 当前会话的 session/event（订阅处已按会话过滤）。
     */
    private handleStreamEvent;
    /** tools 服务的 presenter 面（可选服务：未装配返回 undefined → 桥软降级）。 */
    private toolPresenters;
    /**
     * 结算工具卡实时提交：从 transcript 查配对 call 的 name/arguments →
     * presenter 桥 → 卡片渲染 → 串行在流式文本 flush 之后 commit 进
     * scrollback（保证「文本 → 卡」的事件序）。配对缺失（截断/rewind 边界）
     * 无卡可渲染，静默跳过。
     */
    private commitSettledToolCard;
    /**
     * 推理段落底：静态 `✻ 思考 (Ns) · N 行` 折叠头行（对标竞品默认折叠——
     * 正文经 Ctrl+O 展开查看）整块 commit 进 scrollback，清缓冲。空缓冲 no-op。
     * 调用点即段边界：首个 text-delta / tool/call / assistant/message /
     * 非中止 turn/end。
     */
    private commitReasoningBlock;
    /** 丢弃推理缓冲（abort / 会话切换；aborted turn 的推理不落底）。 */
    private discardReasoning;
    /** 流式收尾：吐尽节流缓冲，并把 StreamRenderer 剩余 pending commit 进 scrollback。 */
    private flushStream;
    /**
     * turn 结束摘要行（投影层：turn-summary 模型 → format/turn-summary 渲染半）：
     * `turn N · 读X 改Y · elapsed` 单行 dim 落 scrollback。elapsed 是完整回合
     * 墙钟耗时（含思考与模型响应）；中途挂载错过 turn/start 时回退工具耗时合计。
     * @param summary - 该 turn 的统计快照（fold 于 handleStreamEvent，调用点取定）。
     * @param turn - 轮号（取 turn/end 事件的权威值；中途挂载错过 turn/start 时
     *   快照内轮号是初值 0）。
     */
    private commitTurnSummaryLine;
    /** wrapping-aware display rows（空行计 1）。 */
    private displayRowsFor;
    /** critical 路径同步穿透：用户交互（提交/审批/按键）不等 16ms 帧边界。 */
    private flushLiveRender;
    /** 三类缓存 → 活动带 items（idle key / spinner / snapshot 共用）。 */
    private foldActivityItems;
    /** 转圈源：agent / 活动带 running / 未结算工具 / 推理展开或流式。 */
    private hasVisibleSpinner;
    /** 当前帧 idle key（不含 now/tick）。 */
    private currentIdleKey;
    /** 渲染一帧 live 区：状态行 + 流式尾巴 + 进行中工具卡 + 输入行。 */
    private renderLive;
    /**
     * 卸载当前会话的投影与控制面，并按 opts 处理本层持有的 handle：
     * - keepHandle（P3 side conversation 切换）：所有权让渡 registry——agent
     *   保持 live（可切回复用），退出时由 agent-loop factory 统一 teardown；
     *   modelRef 同步让渡（registry 兜底语义：不可热切）。
     * - 缺省（dispose 退出）：释放本层 handle（create/resume 铸造的）。
     * registry 兜底的裸 agent 非自有，两种情况都不 dispose。会话本身所有权归
     * 持有方，不销毁。
     * @param opts - keepHandle：切换保留模式（默认释放）。
     */
    private detachProjections;
    /**
     * 退出：先 flush 所有 live 会话到持久层（退出恢复 checkpoint）、停止 ticker、
     * 卸载投影、恢复终端 raw-mode。
     * @returns 全部 flush 完成后 resolve。
     */
    dispose(): Promise<void>;
    /**
     * 刷新会话列表（供外部面板查询；本 MVP 的会话面板直接读 store）。
     * @returns 全部会话的摘要列表。
     */
    refreshSessions(): Promise<SessionSummary[]>;
}
