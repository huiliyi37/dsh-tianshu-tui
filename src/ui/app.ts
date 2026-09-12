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

import { randomUUID } from 'node:crypto'
import { gitBranch, gitDirtyCount, isGitRepo } from '../git-status.js'
import {
  FOOTER_INFO_LEVELS,
  GLANCE_HIDEABLE_SEGMENTS,
  prefsEnabled,
  readPrefs,
  writePrefs,
  type GlanceHideableSegment,
  type TuiPrefs,
} from '../prefs.js'
import { appendInputHistory, historyGhostSuffix, inputHistoryEnabled, loadInputHistory, MAX_INPUT_HISTORY } from '../input-history.js'
import { exportCurrentTheme } from '../theme-custom.js'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import type { ReadStream, WriteStream } from 'node:tty'
import type { Context, Events } from '@deepseek-ai/cordis'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolCallId, TokenUsage } from '@deepseek-ai/dsh-llm'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm'
import { installModelSelection, type Agent, type AgentHandle, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
// 空类型导入引入 Context 上 agentDefaultModel 服务的声明合并（headless 同款）。
import type {} from '@deepseek-ai/dsh-agent-default-model'
// 空类型导入引入 'user-questions/request' waterfall 事件的声明合并（rc.1 wire）。
import type {} from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import { CommitEngine } from '../engine/commit-engine.js'
import { ANSI, color, osc52Clipboard } from '../engine/ansi.js'
import {
  LiveEngine, LIVE_TOOL_CARD_MAX, assembleIdleKey, liveHasSpinner, liveMaxRowsFor,
  nextDynamicBudget, padDynamicRegion, shouldSkipIdleAssemble, workingRowsCap,
  type LiveRegionLine,
} from '../engine/live-engine.js'
import { WriteBatcher } from '../engine/write-batcher.js'
import { InputHandler, type KeyPress, type KeyName } from '../engine/input-handler.js'
import { InputLine, inputViewportMaxLines } from '../engine/input-line.js'
import { remapSequences } from '../engine/insert-remap.js'
import { InputController, type SlashHintEntry } from '../engine/input-controller.js'
import { ResizeHandler } from '../engine/resize-handler.js'
import { BlockStreamWriter } from '../block-stream-writer.js'
import { StreamRenderer } from '../engine/stream-renderer.js'
import { TuiPerfMonitor, isTuiPerfEnabled } from '../engine/perf-monitor.js'
import { loadClipboardImageAttachment, loadImageAttachment, looksLikeImagePath, MAX_IMAGES } from '../engine/image-attach.js'
import { readImageFromClipboard, readTextFromClipboard, FOCUS_DEBOUNCE_MS } from '../engine/clipboard-image.js'
import { echoSavedDefault, echoSessionOnly, effortSelection, splitDefaultFlag } from '../startup-defaults.js'
import { joinCreateOrWarn, joinResume } from '../adapter/preset-join.js'
import { scopedService } from '../adapter/agent-scope-service.js'
import { resolvePresetId } from '../preset-surface.js'
import { openEffortPicker, openModelPicker, openThemePicker, type ModelPickerLlm } from './startup-pickers.js'
import {
  parseImageDataUrl,
} from '../engine/term-image.js'
import { createTranscript, type Transcript, type TranscriptToolCall } from '../adapter/transcript.js'
import { resolveToolViews, type ToolPresenterSource } from '../adapter/tool-view.js'
import { trackAgent, type LiveAgent } from '../adapter/live.js'
import { controlsFromHandle, controlsFromRegistry, type AgentControls } from '../adapter/send.js'
import {
  listSessions, loadHistory, flushAll, getSession,
  findMostRecentEmptySession, clearEmptySessionArtifact, type SessionSummary,
} from '../adapter/sessions.js'
import { createForkedAgent } from '../adapter/fork-agent.js'
import { sessionTitleFor } from '../adapter/session-title.js'
import { updateNoticeText, autoRestartNoticeText, updateNoticePackage, readOwnVersion, readOwnChangelog, parseChangelog, simplifyChangelogMarkdown, checkForUpdate as runUpdateCheck, defaultUpdateCachePath, type UpdateCheckResult } from '../self-update.js'
import { kittyKeyboardPopSeq, kittyKeyboardPushSeq, supportsOsc52 } from '../term-caps.js'
import { getTheme, getActiveThemeName, setTheme, type RivetTheme } from '../theme.js'
import { displayWidth, ambiguousWideEnabled } from '../width.js'
import { detectTerminalBackground, autoThemeFor } from '../theme-detect.js'
import { formatSteerMessage } from '../format/steer-message.js'
import { formatToolCardLive, toolCardTitle } from '../format/tool-card.js'
import { formatToolViewCard } from '../format/tool-view-card.js'
import { formatReasoningBlock, formatReasoningLive, reasoningTailBudget } from '../format/reasoning.js'
import { renderKeymapPanel } from '../format/keymap-panel.js'
import { renderSessionExport } from '../format/export.js'
import type { TaskItem } from '../format/task-panel.js'
// T1.2：/status 状态面板渲染函数（status-panel.ts 由 status_panel 维度提供；
// 数据源为投影总线缓存——纯函数只读，不发明事件词汇）。Wave 2：面板行渲染
// 统一由 render/live-panels 的 7 面板纯函数承担，app.ts 只 import 类型做快照组装。
import type { GoalProjectionInput, PlanProjectionInput } from '../status-panel.js'
// 投影层接线（docs/projection-layer.md）：turn 级工具统计（turn/end 摘要行）
// 与会话级汇总（/status 会话段）——纯 fold 模型，输入即 session 事件流。
import { applyTurnEvent, emptyTurnSummary, type TurnSummaryState } from '../turn-summary.js'
import { applySummaryEvent, emptySummaryState, summarizeSession, type SummaryState } from '../summary-state.js'
import { formatTurnSummary as renderTurnSummaryLine } from '../format/turn-summary.js'
import { getToolFamily } from '../format/tool-meta.js'
import {
  delegationSnapshotSlice, foldActivityFromCaches, foldWorkflowViews, formatWorkflowSummary,
  renderActivitySection,
} from './activity-flow.js'
import { WorkflowSurfaceController } from '../controllers/workflow-surface.js'
import { DelegationSurfaceController, type SubagentsFacet } from '../controllers/delegation-surface.js'
import { CommitSurface } from '../controllers/commit-surface.js'
import { AttachmentPreviewController } from '../controllers/attachment-preview.js'
import { ErrorAnnouncer } from '../controllers/error-announcer.js'
import { cancelAndSendInput, formatQueueLine, SubmitQueueController } from '../controllers/submit-queue.js'
import { KeyDialogController } from './key-dialog.js'
import { KeyFlow } from './key-flow.js'
import {
  projectQuestionPanel,
} from '../question-panel.js'
import type { ConfigPanelProjection } from '../config-panel.js'
/** Wave 2：renderLive 8 面板纯函数 + 单帧快照类型（app.ts → render/ 单向依赖）。 */
import {
  renderGlancePanel,
  renderTodosPanel,
  renderTasksPanel,
  renderStatusPanel,
  renderDelegationPanel,
  renderWorkflowPanel,
  renderConfigPanel,
  renderSkillsPanel,
  renderLspPanel,
  renderActivityBand,
} from '../render/live-panels.js'
import type { LiveSnapshot } from '../render/live-snapshot.js'
import {
  createLspBridge,
  selectDiagnosticSource,
  type LspBridge,
  type LspDiagnosticView,
} from '../lsp/lsp-bridge.js'
import type { MultiLspOptions } from '../lsp/multi-manager.js'
import { lspBadgeText } from '../format/lsp-diagnostics.js'
/** T1.1：5 域投影 key（与 sessionProjections 注册表的 wire key 对齐）。 */
type ProjectionKey = 'todos' | 'plan' | 'goal' | 'subagent' | 'subagentTiming'

/** plan 投影的 wire 形状（与 plan-mode 的 PlanProjection 对齐；不引入依赖）。 */
interface PlanProjectionWire {
  active: boolean
  pending: boolean
}

/** T1.1：sessionProjections 5 域最小服务面（不引入 dsh-session-projection 依赖）。 */
interface ProjectionFacet {
  snapshot(session: unknown): { values: Partial<Record<ProjectionKey, unknown>> }
  onChanged(listener: (
    session: { id: SessionId },
    key: string,
    value: unknown,
    seq: number,
  ) => void): () => void
}

/** T2.3：tasks 服务最小面（不引入 dsh-tasks 依赖；id 运行时即 string）。 */
interface TasksFacet {
  list(): TaskSnapshotView[]
  kill(id: string, caller?: unknown, reason?: string): 'requested' | 'already-finished'
  onTaskDone(listener: (snapshot: TaskSnapshotView) => void): () => void
  attachSurface(name: string): () => void
}

/** T2.3：tasks.list() 返回项的最小 wire 形状（status/detail/startedAt 渲染所需）。 */
interface TaskSnapshotView {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  readonly detail?: string
  readonly startedAt: number
}

import { WorkflowStatusLine } from '../statusline.js'
import {
  BUILTIN_COMMAND_NAMES,
  SlashCommandRegistry,
  createBuiltinCommands,
  resolveSlashCommand,
  suggestCommands,
  type ModelFacet,
} from '../commands/registry.js'
import { PickerController } from '../picker.js'
import { accumulateUsage, formatSessionCostReport, type SessionCostBucket } from '../format/session-cost.js'
import { renderTranscript, parseToolArguments, toolResultText, type RenderedRow } from './render.js'
import { CommandPalette } from '../command-palette.js'
import { SkillSurfaceController } from '../controllers/skill-surface.js'
import { OverlayController } from '../engine/overlay-controller.js'
import { MetricsGlanceController } from '../engine/metrics-glance-controller.js'
import type { FormatGlanceBarInput } from '../format/glance-bar.js'
import { commandPrefixForRequest, findApprovalToolCall, formatPermissionDiff } from '../format/permission-diff.js'
import { formatApprovalCard } from '../format/approval-card.js'
import { HistorySearchOverlay } from '../format/history-search-overlay.js'
import { ScrollPagerOverlay } from '../format/scroll-pager-overlay.js'
import { RewindOverlay, collectUserRewindCheckpoints, type RewindMode, type RewindResult } from '../format/rewind-overlay.js'
import { openInEditorDetailed, getEditorCommand } from '../external-editor.js'
import { FluencyTracker } from '../fluency-hook.js'
import { expandMentions } from '../mention-expand.js'
import { applyNotifyOsPref, configTuiFromPrefs, notifyOs, parseConfigNotifyArg, subagentNotifySuppressed } from '../os-notify.js'
import { writeBell } from '../term-bell.js'
import { loadConfigProjection } from './config-flow.js'
import { buildSessionPickerItems, formatSessionAge } from '../restore-session.js'
// 副作用声明合并：让 ctx.on('approval/request') 的 handler 参数由 cordis 事件
// 类型推导（user-approval 的 module augmentation）。不 import 具体类型——
// 该包的 lib 声明带 .ts 后缀相对导入，跨包 tsc 解析会触发 rootDir 冲突。
import type {} from '@deepseek-ai/dsh-user-approval'
// T2.1/T2.2：subagent/workflow 事件从属主 import（module augmentation 同源，
// 避免本地 wire 声明与属主 Events 合并成 union 污染全局 ctx.on 类型；
// handler 参数仍按本地结构子集标注，属主类型逆变兼容）。
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-workflow'
// #39：skills/change 订阅类型（dsh-skill module augmentation；同款副作用导入）。
import type {} from '@deepseek-ai/dsh-skill'

/** Phase 8：审批 answerer 的请求/结果类型由 ApprovalController 持有（单向依赖）。 */
import {
  ApprovalController,
  type PendingApprovalRequest,
  type ApprovalOutcome,
} from '../controllers/approval-controller.js'
import { QuestionController } from '../controllers/question-controller.js'
import { BtwController } from '../controllers/btw-controller.js'
import { SessionManager, resumeModelSelection } from '../controllers/session-manager.js'
import { InspectSurfaceController } from '../controllers/inspect-surface.js'
import { renderBtwPanel } from '../format/btw-panel.js'
import { CHROME_GUTTER, formatBlueWelcomeHero, formatStarWelcomeHero, formatWelcomeHero, type WelcomeEnvCheck, type WelcomeTipItem } from '../format/welcome.js'
import { formatWhaleLogo, WHALE_MIN_ROWS } from '../format/whale.js'
import { formatStarWhaleLogo } from '../format/whale-star.js'
import { formatBlueWhaleLogo } from '../format/whale-blue.js'
import { formatTopBar } from '../format/top-bar.js'
import { livePresetShort } from '../preset-catalog.js'
import { formatTurnStatus } from '../format/turn-status.js'
import { formatFooterInfo, type FooterRightSegment } from '../format/prompt-footer.js'
import { formatWarnWithHint } from '../format/error-recovery.js'
import { pushConfirmHints } from '../format/confirm-hints.js'
import { ActionRegistry, REWIND_DOUBLE_ESC_MS } from '../actions/registry.js'
import { createBuiltinActions } from '../actions/builtin-actions.js'
import {
  createApprovalKeyContext,
  createBtwKeyContext,
  createInspectKeyContext,
  createQuestionKeyContext,
  createSlashMenuKeyContext,
} from '../actions/key-contexts.js'
import { OverlayKeyRouter } from '../actions/overlay-router.js'
import { projectApprovalHints, projectInspectHints } from '../actions/projections.js'
import type { ActionContext, BlockingKeyContext } from '../actions/types.js'
import { formatInputFrame } from '../format/input-frame.js'
import { formatSlashMenu } from '../format/slash-menu.js'
import { formatSubagentDone } from '../format/subagent-line.js'
import { glanceStatusSegments } from '../format/glance-bar.js'
import { buildGlanceMetrics } from '../format/glance-metrics.js'
import { MemoryBrowserOverlay } from '../format/memory-overlay.js'

/**
 * A1：CommandService 的最小消费面（不引入 dsh-commands 依赖）。
 * execute 的返回形状对齐 CommandExecution：undefined = 命令未知名。
 */
interface CommandServiceFacet {
  execute(
    agent: unknown,
    line: string,
    signal: AbortSignal,
  ): Promise<{ result: { kind: 'success' | 'error'; text?: string } } | undefined>
}

/** P2：memory 服务最小消费面（不引入 dsh-memory 依赖；reflect 动态获取）。 */
interface MemoryServiceFacet {
  list(opts?: { scope?: string; limit?: number; offset?: number }): Promise<Array<{
    id: string
    text: string
    tags: string[]
    createdAt: number
    scope: string
  }>>
  delete(id: string): Promise<void>
}

/** credentials.describe 最小面（不引入 dsh-credentials peer；ref 为 POSIX 标识符）。 */
interface CredentialsDescribeFacet {
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable?: boolean }>
}

/** llm.resolveModelInfo 最小面（识图能力取 inputModalities，不引入 dsh-llm peer）。 */
interface LlmModelInfoFacet {
  resolveModelInfo(provider: string, model: string): Promise<{ inputModalities?: readonly string[] }>
}

/** TuiApp 构造选项。 */
export interface TuiAppOptions {
  ctx: Context
  stdout: WriteStream
  stdin: ReadStream
  /** 启动时切入的会话 id；缺省优先恢复最近会话（live store 为空才新建）。 */
  initialSessionId?: SessionId
  /** 主题名；'auto' 走系统终端配色探测。优先级：装配 > prefs.json > 'auto'。 */
  theme?: string
  /** 偏好文件路径（theme/density/常驻面板/glance 段）；null 显式禁用。
   *  缺省：生产 ~/.dsh-tui/prefs.json，VITEST 下 null（测试密封门）。 */
  prefsPath?: string | null
  /** 输入历史文件路径；null 显式禁用。缺省同 prefs 的密封门规则。 */
  inputHistoryPath?: string | null
  /** 输入行为空时 Ctrl+C 的退出回调（raw-mode 下 Ctrl+C 是数据字节非 SIGINT）。 */
  onExit?: () => void
  /** /restart 与更新后自动重启的回调（装配方负责 dispose + spawn 同 argv + 退出）。 */
  onRestart?: () => void
  /** 外部编辑器触发键（KeyName）；缺省 'ctrl_e'（ctrl+o 已恢复为推理展开，Phase 6.4）。 */
  editorKey?: KeyName
  /** 外部编辑器命令；缺省 $VISUAL/$EDITOR/平台缺省（测试注入点）。 */
  editorCommand?: string
  /** 是否启用 Vim 键位（Phase 6.5）；缺省 false。 */
  vimEnabled?: boolean
  /**
   * 禁用 /key 首启自动弹窗（attach 尾缺 key 引导；缺省 false=启用）。
   * 宿主/测试装配可显式关闭——TTY 替身与真实终端无法从 stdin 区分。
   */
  disableKeyAutoPrompt?: boolean
  /** 启动期收集的主题警告（loadCustomThemes 回调路由；attach 后 echoWarn + /theme 指引落 scrollback）。 */
  themeWarnings?: readonly string[]
  /**
   * 主控模型的识图能力与视觉桥状态（图片附件的用户气泡提示数据源；
   * 由装配方按 agent 配置注入——TUI 是纯表现层，不自行查询模型能力）。
   */
  vision?: {
    /** 主控模型是否原生支持识图（图片直发）。 */
    supportsVision?: boolean
    /** 是否配置了独立识图桥模型（主控不识图时经桥转文字描述）。 */
    bridgeEnabled?: boolean
    /** 识图桥来源（configured=显式配置 / auto=自动选用）。 */
    bridgeSource?: 'configured' | 'auto' | 'none'
  }
  /**
   * LSP 诊断桥（本地语言服务；懒启动——首个触碰文件才 spawn server）。
   * 诊断只进 TUI 本地展示缓存，不写会话事件、不注册任何模型面。
   */
  lsp?: {
    /** 是否启用诊断拉取；缺省 true。 */
    enabled?: boolean
    /** 单次诊断拉取超时（毫秒）；缺省 2000。 */
    timeoutMs?: number
    /** 测试注入：语言 server spawn（透传 LspBridgeOptions.spawnFor）。 */
    spawnFor?: MultiLspOptions['spawnFor']
    /** 测试注入：server 可用性探测（透传 LspBridgeOptions.which）。 */
    which?: MultiLspOptions['which']
  }
  activityBand?: boolean
  activityBandMaxRows?: number
  workflowHistoryLimit?: number
}

/** live 区预留行（顶轨 + 输入 + 底轨 + footer）。 */
const LIVE_RESERVED_ROWS = 4

/** 历史渐进重放单片行数（任务5）：首片同步落屏，余片 setImmediate 逐片追加。 */
const REPLAY_CHUNK_ROWS = 100

/** A3：`dsh --profile tui --help` 输出的用法文本。 */
const USAGE_TEXT = `dsh-tianshu-tui — DeepSeek Harness 交互式终端界面 / interactive terminal UI

用法 / Usage:
  dsh --profile tui                   启动交互式 TUI / start the interactive TUI
  dsh --profile tui "<提示词>"        启动并直接发送提示词 / start and send a prompt
  dsh --profile tui --help            显示本帮助 / show this help
  dsh --profile tui --version         输出版本 / print the version

快捷键 / Keys: ctrl+n 新会话 · ctrl+s 恢复 · ctrl+p 命令面板 · / slash 命令 · ctrl+o 展开推理 · shift+tab 模式循环 · ctrl+q / /exit 退出
`

/** dsh launcher 在 boot prepare 里 provide 的 cmdline 面（不是插件纤维）。 */
interface CmdlineArgsService {
  get(): string[]
}

/**
 * 读 launcher 转发的 argv。生产路径是 host `ctx.provide('cmdlineArgs')` 在注入
 * 属性上可见（attach 前 waitForHostServices 已给就绪窗口）；`reflect.get` 兜底
 * （同树 provide 非严格可读；单测走此路径）。两者皆无 → 无参数（降级启动）。
 */
function readCmdlineArgs(ctx: Context): string[] {
  try {
    const injected = (ctx as Context & { cmdlineArgs?: CmdlineArgsService }).cmdlineArgs
    if (injected !== undefined) return injected.get()
  } catch (err) {
    // 只吞 Cordis 的 "without inject"（未声明注入的属性访问）；getter 真实错误上抛。
    if (!(err instanceof Error) || !err.message.includes('without inject')) throw err
  }
  const viaReflect = ctx.reflect.get('cmdlineArgs', false) as CmdlineArgsService | undefined
  return viaReflect?.get() ?? []
}

/** 读 launcher 的退出请求。优先注入属性，其次 reflect（单测 mock）。 */
function readAppExit(ctx: Context): ((code?: number) => void) | undefined {
  try {
    const injected = (ctx as Context & { appExit?: (code?: number) => void }).appExit
    if (typeof injected === 'function') return injected
  } catch (err) {
    // 同上：只吞 "without inject"
    if (!(err instanceof Error) || !err.message.includes('without inject')) throw err
  }
  return ctx.reflect.get('appExit', false) as ((code?: number) => void) | undefined
}

/** C3 项 3：写工具名判定（与 fs-snapshot 的 trackEdit 钩子同一集合）。 */
function isWriteToolCall(name: string): boolean {
  return name === 'write' || name === 'edit' || name === 'str_replace_editor'
}

/**
 * 提交前规范化图片数组：只保留合法 data URL（parseImageDataUrl 校验），
 * 截断到 MAX_IMAGES 上限。空/全非法返回 undefined（与无图提交同形）。
 * @param images - 输入框携带的图片 data URL 列表
 * @returns 规范化后的图片列表；无有效图片时 undefined
 */
function normalizeSubmitImages(images?: string[]): string[] | undefined {
  if (images === undefined || images.length === 0) return undefined
  const valid = images.filter(u => parseImageDataUrl(u) !== null).slice(0, MAX_IMAGES)
  return valid.length === 0 ? undefined : valid
}

/** 判断输入是否更像文件路径而非 slash 命令（移植自本体 looksLikeFilePath）：
 *  /src/main.ts、/tmp/foo bar、~/xxx、Windows 盘符 C:\... 走普通文本流程；
 *  /exit 等已知命令、/h 等命令前缀仍视为命令（触发解析/提示）。
 *  单段绝对路径（/etc、/mnt）依赖 isKnownCommand 谓词区分命令与路径。 */
function looksLikeFilePath(
  input: string,
  isKnownCommand?: (name: string) => boolean,
  isCommandPrefix?: (name: string) => boolean,
): boolean {
  if (input.startsWith('~/')) return true
  // Windows 盘符路径 C:\... 或 C:/...（不是 slash 命令）
  if (/^[a-zA-Z]:[\\/]/.test(input)) return true
  if (!input.startsWith('/')) return false
  const rest = input.slice(1)
  const slashIdx = rest.indexOf('/')
  if (slashIdx !== -1) {
    const spaceIdx = rest.indexOf(' ')
    return spaceIdx === -1 || slashIdx < spaceIdx
  }
  // 单段 /xxx：可能是命令（/exit）也可能是路径（/etc, /mnt）
  if (isKnownCommand) {
    const firstToken = rest.split(/\s/)[0] ?? ''
    if (firstToken === '') return false
    if (isCommandPrefix?.(firstToken)) return false
    return !isKnownCommand(firstToken)
  }
  return false
}

/**
 * 解析 slash 命令（最小唯一前缀匹配，委托 registry 解析核心）。
 * 兼容导出（steer.spec.ts 消费）；TuiApp 内部走实例注册表（含扩展命令）。
 * @param input - 输入行提交的原始文本（已 trim）。
 * @returns 匹配的命令名与剥离后的参数文本；未匹配返回 null。
 */
export function parseSlashCommand(input: string): { kind: string; text: string } | null {
  const parsed = resolveSlashCommand(input, BUILTIN_COMMAND_NAMES)
  return parsed === null ? null : { kind: parsed.command.name, text: parsed.text }
}

/** 命令 → InputController 提示条目的投影（slash hint / Tab 补全数据源）。 */
function toSlashHint(command: { name: string; description: string; argsHint?: string }): SlashHintEntry {
  return {
    name: command.name,
    description: command.description,
    ...(command.argsHint === undefined ? {} : { argsHint: command.argsHint }),
  }
}

/**
 * 会话界面主装配。生命周期：构造 → attach()（接管终端）→ dispose()（恢复终端）。
 * attach 前不写终端；dispose 后终端恢复 raw-mode 前状态。
 */
export class TuiApp {
  private readonly ctx: Context
  private readonly stdout: WriteStream
  private readonly stdin: ReadStream
  private readonly commit: CommitEngine
  private readonly commitSurface: CommitSurface
  private readonly live: LiveEngine
  private readonly input: InputHandler
  private readonly inputLine: InputLine
  private readonly resize: ResizeHandler
  private readonly blockWriter: BlockStreamWriter
  private readonly streamRenderer: StreamRenderer
  /** 渲染性能监测（--debug-perf / RIVET_DEBUG_TELEMETRY=1 时激活；默认零开销）。 */
  private readonly perfMonitor: TuiPerfMonitor
  /** 输入状态控制器（slash 提示 / Tab 补全数据源，W-B5 提取的输入状态）。 */
  private readonly inputController: InputController
  /** Slash 命令注册表：内置命令 + 'tui.commands' 服务面（外部插件可扩展）。 */
  private readonly slash: SlashCommandRegistry
  /** Ctrl+P 命令面板（overlay 渲染经 OverlayController 进出 alt screen）。 */
  private palette: CommandPalette | null = null
  /** API key 就绪标志（footer 右侧段；attach 时经 credentials.describe 刷新）。 */
  private apiKeyReady = Boolean(process.env.DEEPSEEK_API_KEY)
  /** composer 附件缩略图（半块预览；提取为 controllers/attachment-preview）。 */
  private attachmentPreview = new AttachmentPreviewController({
    getColumns: () => this.stdout.columns,
    getBackground: () => (this.theme as { userMsgBg?: string }).userMsgBg, onChanged: () => { this.flushLiveRender() },
  })
  /** 运行中提交的本地排队（turn/end 投递、↑ 取回；见 controllers/submit-queue）。 */
  private readonly submitQueue = new SubmitQueueController()
  /** /key、/login：API Key 设置对话框（掩码输入 + 联网验证 + 落盘）。 */
  private keyDialog: KeyDialogController | null = null
  /** /key 供应商密钥配置装配层（key-wizard/key-dialog 之上；deps 注入 openKeyDialog）。 */
  private keyFlow!: KeyFlow
  /** /key 首启自动弹窗禁用（宿主/测试装配显式关闭；缺省 false=启用）。 */
  private readonly disableKeyAutoPrompt: boolean
  private readonly themeWarnings: readonly string[]
  private overlay: OverlayController | null = null
  /** C3 项 3：rewind overlay（/rewind 双阶段回退面板）。 */
  private rewindOverlay: RewindOverlay | null = null
  /** P2：memory 浏览器 overlay（/memory 记忆列表/过滤/删除）。 */
  private memoryOverlay: MemoryBrowserOverlay | null = null
  /** #31：交互式选择器 overlay（/model /theme /session 无参打开；上下键选择）。 */
  private picker: PickerController | null = null
  /** 统一 action registry：键路由/快捷键面板/footer 提示的单一事实来源。 */
  private readonly actions: ActionRegistry
  /** 动作执行上下文门面（createActionContext 装配；闭包注入私有方法）。 */
  private readonly actionCtx: ActionContext
  /** 阻塞态键上下文轮询表（现状顺序保持：question > btw > approval）。 */
  private readonly blockingKeys: readonly BlockingKeyContext[]
  /** slash 命令菜单键上下文（轮询位置在主段动作之后、inspect 之前——现状顺序）。 */
  private readonly menuKeys: BlockingKeyContext
  /** inspect 上下文键（轮询位置在 slash 菜单之后——现状顺序保持）。 */
  private readonly inspectKeys: BlockingKeyContext
  /** overlay 键路由器（key-dialog/picker/search/scroll/rewind/memory/palette 委派）。 */
  private readonly overlayRouter: OverlayKeyRouter
  /** footer 检查面板提示段（registry 构造期投影；审批段改由 renderLive 逐帧投影——p 段动态）。 */
  private readonly footerInspectHints: readonly string[]
  /** Phase 9d：流利度追踪（tool 事件 → 渲染策略；stale 提示消费于 renderLive）。 */
  private readonly fluency = new FluencyTracker()
  /** Phase 5.3：底部 glance（状态/错误行派生 + 节流；renderLive 消费 current()）。 */
  private readonly glance: MetricsGlanceController
  /** Phase 5.3：glance metrics 行的 model 名缓存（会话挂载时更新一次；
   *  renderLive 每帧读缓存，不重复查询 agentDefaultModel——模型定路是
   *  mount 时的决策，渲染不该引入额外的 currentSelection 读取）。 */
  private glanceModelName: string | null = null
  /** 推理努力度缓存（挂载时 request/header 优先、currentSelection 兜底；
   *  request/header 事件更新——与 glanceModelName 同生命周期）。 */
  private glanceEffort: string | null = null
  /** 会话内最后一条 assistant/message 的 usage（缓存命中/上下文占比数据源；
   *  streamFeed 折叠，随会话挂载/卸载）。 */
  private usageFold: TokenUsage | null = null
  /** 会话成本累计（assistant/message usage 按模型分桶；/cost 数据源，
   *  随会话卸载复位）。 */
  private sessionCosts = new Map<string, SessionCostBucket>()
  /** 当前模型路由的上下文窗口（request/context 事件折叠；adapter 未报时 null）。 */
  private contextWindow: number | null = null
  /** git 未提交改动文件数（gitDirtyCount 快照；attach + turn/end 刷新，0 = 干净/非仓库）。 */
  private gitDirty = 0
  /** A5：手动展开的进行中工具卡 callId（空输入 Enter 切换；turn/end 复位）。 */
  private expandedToolCallId: string | null = null


  private transcript: Transcript | null = null
  private liveAgent: LiveAgent | null = null
  private controls: AgentControls | null = null
  /** 工作流阶段/活动投影（Phase 5.1/6.2）；随会话挂载/卸载，dispose 时解绑订阅。 */
  private statusLine: WorkflowStatusLine | null = null
  /** 流式提交供给的 session/event 订阅；随会话挂载/卸载。 */
  private streamFeed: (() => void) | null = null
  /** 本层经 create/resume 铸造的 handle；非 registry 兜底的裸 agent。dispose 时释放。 */
  private ownedHandle: AgentHandle | null = null
  private readonly initialSessionId: SessionId | undefined
  private readonly themeName: string
  private readonly onExit: (() => void) | undefined
  private readonly onRestart: (() => void) | undefined
  /** 外部编辑器触发键（Phase 6.4）；缺省 ctrl_e（ctrl+o 已恢复为推理展开）。 */
  private readonly editorKey: KeyName
  /** 外部编辑器命令注入（测试用）；缺省走环境变量/平台缺省。 */
  private readonly editorCommand: string | undefined
  /** T1.1：5 域投影缓存（snapshot 全量 + onChanged 按 key 分流；服务缺失时为 null → 整体降级）。 */
  private projectionCache: Partial<Record<ProjectionKey, unknown>> | null = null
  /** T4：任务窗格——sessionProjections 任务单元投影快照（服务缺失时为 null）。 */
  private taskItems: TaskItem[] | null = null
  /** T2.1：委派树面板显隐（/subagents 切换）。 */
  private subagentsPanelVisible = false
  /** T2.2：workflow 运行中面板显隐（/workflow 切换）。 */
  private workflowPanelVisible = false
  /** T2.1：子代理委派域（树缓存/运行行缓存/他会话投影入口）——提取自本文件，见 controllers/delegation-surface.ts。 */
  private readonly delegationSurface = new DelegationSurfaceController({
    getService: () => this.ctx.reflect.get('subagents', false) as SubagentsFacet | undefined,
    isDisposed: () => this.disposed,
    schedule: () => { this.renderBatcher.schedule() },
    onRunFinished: (done) => {
      this.commitToScrollback({
        text: formatSubagentDone({
          width: this.stdout.columns,
          label: done.label,
          elapsedMs: done.elapsedMs,
          stopReason: done.stopReason,
          stats: done.stats,
        }, this.theme),
        trailingNewline: true,
      })
      // workflow 活跃时子代理逐条完成会连发通知刷屏：静默单条，由 workflow/end 统一汇总。
      if (!subagentNotifySuppressed(this.workflowSurface.runningCount)) {
        notifyOs({ title: 'dsh · 子代理完成', body: done.label }, this.prefs)
        writeBell(this.stdout, process.env, this.prefs)
      }
      this.renderBatcher.schedule()
    },
  })
  private readonly activityBandEnabled: boolean
  private readonly activityBandMaxRows: number
  /** T2.2：workflow 事件域（订阅/运行态缓存/终态折叠）——提取自本文件，见 controllers/workflow-surface.ts。 */
  private readonly workflowSurface = new WorkflowSurfaceController({
    onCompleted: (view, name) => {
      this.commitToScrollback({ text: formatWorkflowSummary(view, this.theme), trailingNewline: true })
      notifyOs({ title: 'dsh · 工作流完成', body: name }, this.prefs)
      writeBell(this.stdout, process.env, this.prefs)
      this.flushLiveRender()
    },
    schedule: () => { this.renderBatcher.schedule() },
    flushLive: () => { this.flushLiveRender() },
  })
  /** T2.3：后台任务同步快照（tasks.list() 每次事件/会话挂载刷新）。 */
  private taskSnapshots: TaskSnapshotView[] = []
  /** T2.3：onTaskDone 完成通知（live 区提示行；一次性，渲染后清空）。 */
  private taskNotice: string | null = null
  /** T3.2：/config 面板投影（打开后恒有终端段；null = 尚未刷新）。 */
  private configProjection: ConfigPanelProjection | null = null
  /** #39：技能展示面控制器（快照缓存 + userInvocable 过滤 + slash 菜单投影 + 手势 MRU）。 */
  private readonly skillSurface: SkillSurfaceController
  /** 检查类面板（/config /skills /status /lsp /tasks）互斥开闭。 */
  private readonly inspect: InspectSurfaceController
  /** LSP：诊断桥（懒创建——首次工具触碰文件或 /lsp 打开时实例化；dispose 销毁）。 */
  private lspBridge: LspBridge | null = null
  /** LSP：装配配置（enabled/timeoutMs/spawnFor/which；缺省启用）。 */
  private readonly lspConfig: {
    enabled: boolean
    timeoutMs: number
    spawnFor?: MultiLspOptions['spawnFor']
    which?: MultiLspOptions['which']
  }
  /** T3.1：userQuestions provider 注册 disposer；attach 注册、dispose 释放。 */
  private interactionDisposer: (() => void) | null = null
  /** T3.1：挂起提问状态机（pendingQuestion + questionFeedbackMode；Wave 1 提取）。 */
  private readonly question: QuestionController
  /** C3 项 4：审批挂起状态机（pendingApproval + alwaysApprove；Wave 1 提取）。 */
  private readonly approval: ApprovalController
  /** P1：/btw 侧问状态机（临时 btw agent 旁路；Esc 折叠答案入 scrollback）。 */
  private readonly btw: BtwController
  /** P3：多会话快照层（live store 派生；tab 栏数据源）。 */
  private readonly sessionManager: SessionManager
  /** T2.1：subagent 生命周期事件订阅 disposer；随会话挂载/卸载。 */
  private subagentDisposer: (() => void) | null = null
  /** T2.2：workflow 事件订阅 disposer；attach 订阅、dispose 释放（跨会话运行）。 */
  private workflowDisposer: (() => void) | null = null
  /** T2.3：tasks onTaskDone 订阅 disposer；随会话挂载/卸载。 */
  private taskDoneDisposer: (() => void) | null = null
  /** T2.3：tasks attachSurface('tui') 控制面 disposer；attach 声明、dispose 释放。 */
  private taskSurfaceDisposer: (() => void) | null = null
  /** T1.4：plan 投影 active 态（驱动 statusline [plan] 徽标；服务缺失时为 false）。 */
  private planState: { active: boolean; pending: boolean } = { active: false, pending: false }
  /** C2 项 4：当前会话的模型选择 ref（newSession/switchSession 挂载；registry 兜底为 null）。 */
  private modelRef: ModelSelectionRef | null = null
  /** C2 项 2：历史搜索 overlay（Ctrl+F；attach 时注册，消息快照激活时提供）。 */
  private searchOverlay: HistorySearchOverlay | null = null
  private scrollPager: ScrollPagerOverlay | null = null
  /** /todos 紧凑待办面板显隐（/todos 切换；数据源为 todos 投影的保留快照）。 */
  private todosPanelVisible = false
  /** /todos all 看全表（false = 默认最多 5 条）。 */
  private todosExpanded = false
  /**
   * todos 保留快照：只吸收非空投影值。todos 投影在 turn/start 时被 fold 重置
   * 为 null（tool-todo 的投影语义：清单随回合开始清空），若面板直接跟随投影，
   * 每回合开始都会闪烁消失——保留快照让已显示的清单跨回合黏滞，null 只在
   * 会话首次写入前出现（渲染「尚无待办」空态）。
   */
  private todosRetained: TaskItem[] | null = null
  /** 本会话仍允许首次非空 todos 自动开面板；关掉或 /clear 后解除。 */
  private todosAutoArmed = true
  /** T4：任务投影变更订阅 disposer；随会话卸载释放。 */
  private projectionDisposer: (() => void) | null = null
  /** T5：紧凑渲染模式（/density 切换）——工具卡仅标题行。 */
  private compactMode = false
  /** reasoning 流缓冲（reasoning-delta 累积）；段结束 commitReasoningBlock 落底清空。 */
  private reasoningText = ''
  /** 当前推理段起点（首个 reasoning-delta 的事件时间，Unix epoch ms）；live/落底耗时数据源。 */
  private reasoningStartedAt: number | null = null
  /** 最近一次已落底推理块（折叠头行 + 保留全文；Ctrl+O 展开查看）。会话切换清理。 */
  private lastReasoningBlock: { text: string; elapsedMs?: number } | null = null
  /** Ctrl+O 展开/收起最近推理块（live 区展示全文；scrollback 保持折叠头行）。 */
  private reasoningExpanded = false
  /** 进行中工具的 presentCall 标题覆盖（callId → title）；result/abort/换会话清理。 */
  private readonly pendingCallTitles = new Map<ToolCallId, string>()
  private activeSessionId: SessionId | null = null
  private history: string[] = []
  /** P1：本地偏好（~/.dsh-tui/prefs.json；prefsPath null = 禁用——VITEST 密封门）。 */
  private prefsPath: string | null = null
  private prefs: TuiPrefs = {}
  private inputHistoryPath: string | null = null
  private tick = 0
  private ticker: ReturnType<typeof setInterval> | null = null
  /** 上一帧 idle key；overlay 退出时置空，强制下一帧组装。 */
  private lastIdleKey: string | null = null
  /** 错误落底/回填控制器（C4 提取；回流 Tianshu lastSubmittedText 语义）。 */
  private readonly errorAnnouncer = new ErrorAnnouncer({
    getTheme: () => this.theme,
    commit: (text) => { this.commitToScrollback({ text, trailingNewline: true }) },
    refillInput: (text) => { this.inputLine.setValue(text, text.length); this.flushLiveRender() },
  })
  /** 历史渐进重放代际（commitRows 每次递增；快速切换会话时旧链自毁）。 */
  private replayEpoch = 0
  /** 历史重放进行中（streamFeed 新事件进 backlog 排队，见 commitRows）。 */
  private replayActive = false
  /** 重放窗口内排队的 stream 事件（重放完按序回放 handleStreamEvent）。 */
  private streamEventBacklog: SessionEvent[] = []
  /** ticker 路径才允许 shouldSkipIdleAssemble；flush/batcher 必须组装。 */
  private renderLiveFromTicker = false
  private disposed = false
  /** attach() 完成后才往 scrollback 写更新提示（避免欢迎页之前的空窗）。 */
  private attached = false
  private pendingUpdateNotice: string | null = null
  /** 自更新失败提示（attach 前排队，attach 后 flush；P1-1）。 */
  private pendingUpdateFailNotice: string | null = null
  /** OSC52 不支持警告：每进程首次触发时提示一次（P1-1；newSession 不重置，避免重复打扰）。 */
  private osc52WarningShown = false
  /** bracketed paste 处理器 disposer（attach 注册，dispose 释放）。 */
  private pasteDisposer: (() => void) | null = null
  /**
   * 动态段高水位（display rows），跨轮保留。回缩会使输入框上跳，并把旧轨线
   * 留在空隙里（重影）。新会话 / 切会话时归零。
   */
  private dynamicRowsHighWater = 0
  /** 渲染帧合并器：事件路径走 schedule（16ms 合并），critical 路径走 flushLiveRender。 */
  private renderBatcher: WriteBatcher
  /** 上次输入框获得焦点的时间戳（Ctrl+V 剪贴板读图防抖；overlay 关闭后
   *  FOCUS_DEBOUNCE_MS 内走文本路径，避免把 overlay 里的图误附进输入框）。 */
  private lastInputFocusAt = 0
  /** 主控模型是否原生支持识图（图片附件气泡提示；装配方经 options.vision 注入）。 */
  private supportsVision = false
  /** 是否配置独立识图桥模型（主控不识图时经桥转文字描述后发送）。
   *  装配方经 options.vision 注入；未注入时提交图片前按 visionBridge 服务
   *  存在性探测补齐（resolveVisionBridge）。 */
  private visionBridgeEnabled = false
  /** 识图桥来源（'configured' / 'auto' / 'none'；气泡提示文案用）。 */
  private visionBridgeSource: 'configured' | 'auto' | 'none' | undefined
  /** 投影层：turn 级工具统计 fold（turn/end 摘要行数据源；mountSession 复位）。 */
  private turnSummary: TurnSummaryState = emptyTurnSummary(0)
  /** 投影层：会话级跨 turn 汇总 fold（/status 会话段数据源；mountSession 重放重建）。 */
  private sessionSummary: SummaryState = emptySummaryState(SessionId(''))

  constructor(options: TuiAppOptions) {
    this.disableKeyAutoPrompt = options.disableKeyAutoPrompt === true
    this.themeWarnings = options.themeWarnings ?? []
    this.ctx = options.ctx
    this.stdout = options.stdout
    this.stdin = options.stdin
    this.initialSessionId = options.initialSessionId
    // P1 偏好恢复：装配 theme > prefs.theme > 'auto'；density/常驻面板/输入历史同源。
    // VITEST 下 prefsEnabled/inputHistoryEnabled 默认 null（不碰真实 home，测试密封）。
    this.prefsPath = prefsEnabled(options.prefsPath)
    this.inputHistoryPath = inputHistoryEnabled(options.inputHistoryPath)
    this.prefs = this.prefsPath === null ? {} : readPrefs(this.prefsPath)
    if (this.inputHistoryPath !== null) this.history = loadInputHistory(this.inputHistoryPath)
    this.themeName = options.theme ?? this.prefs.theme ?? 'auto'
    if (this.prefs.compactMode === true) this.compactMode = true
    if (this.prefs.panels?.subagents === true) this.subagentsPanelVisible = true
    if (this.prefs.panels?.workflow === true) this.workflowPanelVisible = true
    this.onExit = options.onExit
    this.onRestart = options.onRestart
    this.editorKey = options.editorKey ?? 'ctrl_e'
    this.editorCommand = options.editorCommand
    this.activityBandEnabled = options.activityBand !== false
    this.activityBandMaxRows = options.activityBandMaxRows ?? 5
    this.supportsVision = options.vision?.supportsVision ?? false
    this.visionBridgeEnabled = options.vision?.bridgeEnabled ?? false
    this.visionBridgeSource = options.vision?.bridgeSource
    this.lspConfig = {
      enabled: options.lsp?.enabled ?? true,
      timeoutMs: options.lsp?.timeoutMs ?? 2_000,
      ...(options.lsp?.spawnFor === undefined ? {} : { spawnFor: options.lsp.spawnFor }),
      ...(options.lsp?.which === undefined ? {} : { which: options.lsp.which }),
    }
    this.commit = new CommitEngine({ stdout: options.stdout, scrollbackMaxLines: this.prefs.scrollbackMaxLines })
    this.live = new LiveEngine({
      stdout: options.stdout,
      reservedRows: LIVE_RESERVED_ROWS,
      maxRows: liveMaxRowsFor(options.stdout.rows),
    })
    // C4 第二波：滚动区提交写入域（原子编舞/overlay 暂存/用户气泡/图片链路）。
    this.commitSurface = new CommitSurface({
      live: this.live,
      commit: this.commit,
      stdout: options.stdout,
      isOverlayActive: () => this.overlay !== null && this.overlay.activeId() !== null,
      flushRender: () => { this.flushLiveRender() },
      getTheme: () => this.theme,
      previewBackground: () => this.attachmentPreview.background(),
      vision: () => ({ supportsVision: this.supportsVision, bridgeEnabled: this.visionBridgeEnabled, bridgeSource: this.visionBridgeSource }),
    })
    this.input = new InputHandler({ stdin: options.stdin, mode: 'input' })
    // vim 键位来源（issue #51）：宿主显式配置 > 本地 prefs（/vim default）> 缺省关。
    const vimResolved = options.vimEnabled ?? this.prefs.vimEnabled ?? false
    this.inputLine = new InputLine({
      history: this.history, vimEnabled: vimResolved,
      insertRemapSequences: remapSequences(this.prefs.vimInsertRemaps),
      onSubmit: (text, images) => { this.handleSubmit(text, images) },
      onTabComplete: () => this.handleTabComplete(),
      // vim NORMAL '/' → 历史搜索 overlay（对齐 CC 键位表注记）。
      onOpenHistorySearch: () => { this.toggleHistorySearchOverlay() },
      // 附件列表变化 → 重算 composer 缩略图（半块预览；装饰性增强，失败静默）。
      onImagesChange: (images) => { void this.attachmentPreview.refresh(images) },
      // slash 菜单状态随输入变化刷新（键入/粘贴/外部 setValue 统一入口；
      // 渲染由各调用路径 flushLiveRender 承担，此处不触发重绘）。输入变化前
      // 先重投影提示快照：注册表可被外部插件经 tui.commands 服务在构造后
      // 扩展（回流 tianshu bc5cec1359），构造期一次性快照会让晚注册的命令
      // 在 / 菜单与 Tab 补全里不可见。
      onChange: (value) => { this.syncSlashHints(); this.inputController.refreshSlash(value) },
    })
    this.resize = new ResizeHandler({ stdout: options.stdout })
    // 渲染帧合并器（T9）：事件路径（流式块）走 schedule 16ms 合并，
    // critical 路径保持同步 renderLive（flushNow 语义）。
    this.renderBatcher = new WriteBatcher(() =>{  this.renderLive() })
    this.blockWriter = new BlockStreamWriter({ minChars: 60, maxChars: 200, idleMs: 180 },
      (block) => {
        /* v8 ignore next -- BlockStreamWriter flush 的 block 恒非空，push 恒返回 true */
        if (!this.streamRenderer.push(block)) this.renderBatcher.schedule()
      },
    )
    this.perfMonitor = new TuiPerfMonitor({ enabled: isTuiPerfEnabled() })
    this.streamRenderer = new StreamRenderer({
      commit: (ansi) => {
        // mid-stream 协议已由 commitToScrollback 统一执行（先清 live 区再写
        // scrollback），重绘在原子编舞内同步完成——不可走 schedule 延迟帧：
        // 擦除即时而重绘延后会让输入框落底后缺席若干帧（闪烁根因）。
        this.commitToScrollback({ text: ansi, trailingNewline: true })
      },
      getColumns: () => this.stdout.columns,
      getTheme: () => getTheme(),
      getThemeKey: () => 'tui-conversation',
      perfMonitor: this.perfMonitor,
    })
    // Phase 6.1：命令注册表 + 内置命令装配。注册即副作用：ctx.provide 把
    // 'tui.commands' 暴露为服务，其他插件经 ctx.get('tui.commands') 扩展命令。
    this.inputController = new InputController()
    this.slash = new SlashCommandRegistry()
    // T2.1/T2.2/T2.3：/tasks（含 kill 子命令）、/subagents、/workflow 的命令定义在
    // createBuiltinCommands（registry 维度），TuiApp 只注入显隐切换 deps。
    for (const command of createBuiltinCommands({
      // #40：/theme 生效后按新主题重放当前会话历史（reset 滚动区重提交）。
      onThemeChanged: () => { this.rerenderHistory() },
      newSession: () => this.newSession(),
      forkSession: opts => this.forkSession(opts),
      switchLiveModel: selection => this.switchLiveModel(selection as ModelSelection),
      // /preset：当前会话 agent（recompose/composedPreset 的 agentCtx 来源）；
      // activeSessionId 为 null（未 attach）时返回 null，命令层拒绝切换。
      currentAgent: (): Agent | null => {
        const id = this.activeSessionId
        if (id === null) return null
        return this.ctx.agents.get(id) ?? null
      },
      // /preset：blank 判定（recompose 调用方契约——换工具集会留下历史
      // tool call 与新组成不匹配）：无消息且无未结算工具调用。
      isBlankSession: () => this.isBlankSession(),
      clearScrollback: () => {
        // 命令切换的 live 信息面板（/config /skills /lsp /tasks /status
        // /todos /subagents /workflow）随清屏一并收起：这些面板渲染在 live 区，
        // 只清 scrollback 不清可见性标志的话，2J 清屏后的全量重绘会把面板
        // 内容原样画回来——用户看到的便是「/clear 清不掉命令输出」（如
        // /config 的配置面板残留）。与既有语义一致：会话切换时 task/status
        // 面板同样被重置（见 mountSession）。
        this.inspect.close()
        this.todosPanelVisible = false
        this.todosAutoArmed = false
        this.subagentsPanelVisible = false
        this.workflowPanelVisible = false
        this.commit.reset()
        // 真实清屏（对齐 README「清空滚动区视图」）：2J 擦可见屏、3J 清终端
        // 滚动缓冲（不支持的终端无害忽略）、光标回顶；live 区状态复位后从
        // 顶部全量重绘（lineCache 清空 → 下一帧按首帧语义绘制）。
        this.live.reset()
        this.stdout.write(`${ANSI.ERASE_SCREEN}\x1b[3J\x1b[H`)
        this.flushLiveRender()
      },
      toggleTaskPanel: () => { void this.inspect.toggle('tasks') },
      toggleSubagentsPanel: () => {
        this.subagentsPanelVisible = !this.subagentsPanelVisible
        if (this.subagentsPanelVisible && this.ctx.reflect.get('subagents', false) === undefined)
          this.echoWarn('⚠ subagents 服务不可用（未装配 subagent 插件），委派树面板无数据', '/doctor 体检')
        // P1：常驻监控面板显隐写透（下次启动恢复）
        this.prefs.panels = { ...this.prefs.panels, subagents: this.subagentsPanelVisible }
        this.persistPrefs()
        this.renderBatcher.schedule()
      },
      toggleWorkflowPanel: () => {
        this.workflowPanelVisible = !this.workflowPanelVisible
        if (this.workflowPanelVisible && scopedService(this.ctx, this.activeSessionId, 'workflowEngine') === undefined)
          this.echoWarn('⚠ workflow 引擎不可用（未装配 workflow 插件），面板无运行数据', '/doctor 体检')
        this.prefs.panels = { ...this.prefs.panels, workflow: this.workflowPanelVisible }
        this.persistPrefs()
        this.renderBatcher.schedule()
      },
      rewindSession: () => this.rewindSession(),
      askBtw: question => this.askBtw(question),
      openMemoryBrowser: () => this.openMemoryBrowser(),
      openScrollPager: () => { this.toggleScrollPager() },
      switchSession: id => this.switchSession(SessionId(id)),
      exportTranscript: path => this.exportTranscript(path),
      requestExit: () => { this.onExit?.() },
      requestRestart: () => { this.onRestart?.() },
      // /help：注册表所有者即 TuiApp（this.slash），经 deps 注入——不暴露为 ctx
      // 服务（Cordis 注入代理对未声明属性抛 without inject，见 #36）。
      listCommands: () => this.slash.list(),
      // /help 无参 → 命令面板（backfill 模式：Enter 回填不执行；palette/overlay
      // 在 attach 装配，命令执行必然发生在 attach 之后，闭包安全）。与 Ctrl+P
      // 键路由同构：open + overlay.activate 两步缺一不渲染。
      openCommandPalette: () => {
        this.palette?.open(false)
        if (this.palette !== null && this.overlay !== null) {
          this.overlay.activate('command-palette')
        }
        this.flushLiveRender()
      },
      setYoloMode: (flag) => { this.setYoloMode(flag) },
      // #31：交互式选择器（/model /theme /session 无参打开）。
      openModelPicker: () => { void this.openModelPicker() },
      openThemePicker: () => { this.openThemePicker() },
      openEffortPicker: () => { this.openEffortPicker() },
      onThemeApplied: (name) => { this.applyThemeAndPersist(name) },
      applyThemeAuto: (persist) => { void this.applyThemeAuto(persist === true) },
      exportTheme: (name) => this.exportTheme(name),
      persistPresetDefault: (id) => { this.prefs.preset = id; this.persistPrefs() },
      currentDefaultPreset: () => this.prefs.preset,
      openSessionPicker: () => { void this.openSessionPicker() },
      // /key、/login：API Key 设置对话框（key-flow 装配层；onSaved 已接刷新就绪标志）。
      openKeyDialog: () => { void this.keyFlow.openKeyDialog() },
      // /update：对照 npm latest 的只查不装检查（结果回显在命令层）。
      checkForUpdate: () => this.runUpdateCheck(),
      // /cost：当前会话累计用量与成本报告（Map 保持首次出现序）。
      sessionCostReport: () => formatSessionCostReport([...this.sessionCosts.values()]),
    })) {
      this.slash.register(command)
    }
    // /steer 复用既有中轮转向入口（Phase 6.2）。
    this.slash.register({
      name: 'steer',
      category: '会话',
      description: '中轮转向（中途纠正方向）',
      argsHint: '<text>',
      run: (args) => { this.handleSteer(args.text) },
    })
    // T1.2：/status 状态面板显隐切换（数据源为投影总线缓存的 goal/todos/plan
    // 三域；渲染函数 import 自 status-panel.ts——registry 条目注册归
    // command_wiring 维度）。subagent/subagentTiming 两域由 /subagents 面板消费。
    this.slash.register({
      name: 'status',
      category: '面板',
      description: '切换状态面板（goal/todos/plan 投影快照）',
      run: () => { void this.inspect.toggle('status') },
    })
    // todos 紧凑待办面板显隐切换：无参切换显隐，all 展开/收起明细。数据源是
    // todos 投影的保留快照（turn/start 清空不回退显示），与 /status 的完整
    // checklist 任务段、/tasks 窗格同源不同呈现——摘要卡服务「一眼当前进度」，
    // 明细行只封顶展示，完整清单仍在 /status。
    this.slash.register({
      name: 'todos',
      category: '面板',
      description: '切换待办面板（无参显隐；all 看全表）',
      argsHint: '[all]',
      run: ({ text }) => {
        const sub = text.trim()
        if (sub !== '' && sub !== 'all') {
          this.echoWarn('用法: /todos [all]')
          return
        }
        if (sub === 'all') {
          this.todosExpanded = !this.todosExpanded
          this.todosPanelVisible = this.todosPanelVisible || this.todosExpanded
        } else {
          this.todosPanelVisible = !this.todosPanelVisible
          if (!this.todosPanelVisible) { this.todosExpanded = false; this.todosAutoArmed = false }
        }
        if (this.todosPanelVisible && this.ctx.reflect.get('sessionProjections', false) === undefined)
          this.echoWarn('⚠ sessionProjections 服务不可用（未装配 session-projection 插件），待办面板无数据', '/doctor 体检')
        this.renderBatcher.schedule()
      },
    })
    // T3.2：/config 设置面板（终端通知可配；宿主段缺失则折叠）。
    this.slash.register({
      name: 'config',
      category: '配置',
      description: '切换设置面板（n 通知 · d 密度）',
      argsHint: '[notify [on|off]]',
      run: async ({ text, echo }) => {
        const action = parseConfigNotifyArg(text)
        if (action === 'usage') {
          echo('用法：/config  或  /config notify [on|off]')
          return
        }
        if (action !== null) {
          this.applyNotifyPref(action, echo)
          return
        }
        await this.inspect.toggle('config')
      },
    })
    // T3.3：/skills 技能浏览面板显隐切换（数据源为 ctx.skills.list 快照；
    // 服务缺失时面板恒空，回显警告）。
    this.slash.register({
      name: 'skills',
      category: '面板',
      description: '切换技能浏览面板',
      run: () => { void this.inspect.toggle('skills') },
    })
    // LSP：/lsp 诊断面板显隐切换（本地语言服务；懒创建 bridge——打开面板
    // 即实例化；server 未安装时回显警告，面板渲染「未安装」空态）。
    this.slash.register({
      name: 'lsp',
      category: '面板',
      description: '切换 LSP 诊断面板（本地语言服务）',
      run: () => { void this.inspect.toggle('lsp') },
    })
    // T5：/density 紧凑渲染开关（grok-build /compact-mode 语义；命令名避开
    // /compact 前缀歧义——resolveSlashCommand 最小唯一前缀会拒掉歧义输入）。
    this.slash.register({
      name: 'density',
      category: '配置',
      description: '切换紧凑渲染（带参 default=设为启动默认）',
      argsHint: '[default]',
      run: ({ text, echo }) => {
        const { persist } = splitDefaultFlag(text)
        if (persist) {
          this.prefs.compactMode = this.compactMode
          this.persistPrefs()
          echo(echoSavedDefault('density', this.compactMode ? '紧凑' : '宽松'))
          return
        }
        this.compactMode = !this.compactMode
        if (this.configProjection !== null) {
          this.configProjection = { ...this.configProjection, tui: { ...configTuiFromPrefs(this.prefs), compactMode: this.compactMode } }
        }
        this.renderBatcher.schedule()
        echo(echoSessionOnly('density', this.compactMode ? '紧凑' : '宽松'))
      },
    })
    // issue #51：vi/vim 编辑键位运行时开关（无参切换；带参 on|off 定向；default
    // 把当前值设为启动默认——对齐 /density 的 default 语义与 CC 的编辑模式配置）。
    this.slash.register({
      name: 'vim',
      category: '配置',
      description: '切换 vi/vim 编辑键位（带参 default=设为启动默认）',
      argsHint: '[on|off|default]',
      run: ({ text, echo }) => {
        const arg = text.trim()
        if (!['', 'on', 'off', 'default'].includes(arg)) {
          echo('用法：/vim 或 /vim [on|off|default]')
          return
        }
        if (arg === 'default') {
          this.prefs.vimEnabled = this.inputLine.vimEnabled
          this.persistPrefs()
          echo(echoSavedDefault('vim', this.inputLine.vimEnabled ? 'on' : 'off'))
          return
        }
        const next = arg === '' ? !this.inputLine.vimEnabled : arg === 'on'
        this.inputLine.setVimEnabled(next)
        this.renderBatcher.schedule()
        echo(echoSessionOnly('vim', next ? 'on' : 'off'))
      },
    })
    // 欢迎页风格：blue 默认（蓝鲸抱星 + ANSI Shadow 艺术字标题）/
    // star 紫鲸举星 / retro 复古小鲸鱼。
    // 欢迎页在启动时已 commit 进 scrollback，运行中不重渲染——落盘下次启动生效。
    this.slash.register({
      name: 'welcome',
      category: '配置',
      description: '切换欢迎页风格（blue 默认 / star 紫鲸 / retro 复古，下次启动生效）',
      argsHint: '[blue|star|retro]',
      run: ({ text, echo }) => {
        const arg = text.trim()
        if (arg === '') {
          echo(`欢迎页风格：${this.prefs.welcomeStyle ?? 'blue'}（blue / star / retro，下次启动生效）`)
          return
        }
        if (arg !== 'blue' && arg !== 'star' && arg !== 'retro') {
          echo('用法：/welcome 或 /welcome [blue|star|retro]')
          return
        }
        this.prefs.welcomeStyle = arg
        this.persistPrefs()
        echo(`欢迎页风格已切换：${arg}（下次启动生效）`)
      },
    })
    // 输入区信息密度档位：full 两行（状态行 + 指标行）/ compact 仅状态行 /
    // off 全关。对齐 kimi-code footer 两行分层；持久化（与 /glance 同源）。
    // 注册在 /glance 前——菜单环绕末项契约测试锚定 /glance。
    this.slash.register({
      name: 'info',
      category: '配置',
      description: '切换输入区信息密度（full 两行 / compact 状态行 / off 全关）',
      run: ({ echo }) => {
        const current = this.prefs.footerInfo ?? 'full'
        const next = FOOTER_INFO_LEVELS[(FOOTER_INFO_LEVELS.indexOf(current) + 1) % FOOTER_INFO_LEVELS.length]
        this.prefs.footerInfo = next
        this.persistPrefs()
        this.renderBatcher.schedule()
        echo(`输入区信息密度：${next}（${FOOTER_INFO_LEVELS.join(' / ')}）`)
      },
    })
    // 版本更新内容（/changelog）：读包内 CHANGELOG.md，默认当前版本条目；
    // 自动更新提示（updateNoticeText）已引导本命令——用户更新后即可知道改了什么。
    this.slash.register({
      name: 'changelog',
      category: '系统',
      description: '查看版本更新内容（默认当前版本；all 全部；N 最近 N 版）',
      argsHint: '[all|N]',
      run: ({ text, echo }) => {
        const arg = text.trim()
        const changelog = readOwnChangelog(fileURLToPath(new URL('.', import.meta.url)))
        if (changelog === null) {
          echo('未找到 CHANGELOG.md（开发安装可能缺失，见仓库根）')
          return
        }
        const entries = parseChangelog(changelog)
        if (entries.length === 0) {
          echo('CHANGELOG 暂无条目')
          return
        }
        let selected: typeof entries
        if (arg === '') {
          const own = readOwnVersion(fileURLToPath(new URL('.', import.meta.url)))
          const hit = own === undefined ? undefined : entries.find(e => e.version === own)
          selected = hit === undefined ? entries.slice(0, 1) : [hit]
        } else if (arg === 'all') {
          selected = entries
        } else if (/^\d+$/.test(arg)) {
          selected = entries.slice(0, Math.min(Number(arg), entries.length))
        } else {
          echo('用法: /changelog（当前版本）  /changelog all（全部）  /changelog N（最近 N 版）')
          return
        }
        for (const entry of selected) {
          const title = entry.date === null ? `## ${entry.version}` : `## ${entry.version}（${entry.date}）`
          echo(title)
          for (const line of simplifyChangelogMarkdown(entry.body)) {
            echo(line === '' ? '' : `  ${line}`)
          }
        }
      },
    })
    this.slash.register({
      name: 'glance',
      category: '配置',
      description: '切换 footer metrics 段显隐（如 /glance cost）',
      argsHint: '[segment]',
      run: ({ text, echo }) => {
        const seg = text.trim()
        const hidden = new Set(this.prefs.glance?.hideSegments ?? [])
        if (seg === '') {
          const hiddenText = hidden.size === 0 ? '无' : [...hidden].join(', ')
          echo(`metrics 段：隐藏 ${hiddenText}；可切换：${GLANCE_HIDEABLE_SEGMENTS.join(', ')}`)
          return
        }
        if (!(GLANCE_HIDEABLE_SEGMENTS as readonly string[]).includes(seg)) {
          echo(`未知段: ${seg}。可切换: ${GLANCE_HIDEABLE_SEGMENTS.join(', ')}`)
          return
        }
        const key = seg as GlanceHideableSegment
        if (hidden.has(key)) hidden.delete(key)
        else hidden.add(key)
        this.prefs.glance = { hideSegments: [...hidden] }
        this.persistPrefs()
        echo(`${key} 段已${hidden.has(key) ? '隐藏' : '恢复'}`)
        this.renderBatcher.schedule()
      },
    })
    // #39：技能展示面控制器装配（技能目录加载后经 refresh → refreshEntries 合并）。
    this.skillSurface = new SkillSurfaceController({
      getService: (name) => this.ctx.reflect.get(name, false),
      listCommandHints: () => this.slash.list().map(toSlashHint),
      setSlashEntries: (entries) => { this.inputController.slashCommands = entries },
      scheduleRender: () => { this.renderBatcher.schedule() },
      isDisposed: () => this.disposed,
      recordSlashUse: (name) => { this.inputController.recordSlashUse(name) },
      onEvent: (event, cb) => this.ctx.on(event as keyof Events, cb),
      // #44：技能发现带会话 cwd——项目级 .dsh/skills 与 .agents/skills 可见
      getSessionCwd: () => this.sessionCwd(),
    })
    // 命令提示数据源投影到 InputController（slash hint / Tab 补全目标）。
    this.skillSurface.refreshEntries()
    this.inspect = new InspectSurfaceController({
      hasService: name => this.ctx.reflect.get(name, false) !== undefined,
      echoWarn: (text, hint) => this.echoWarn(text, hint),
      refreshConfig: () => this.refreshConfigProjection(),
      refreshSkills: () => { this.skillSurface.refresh() },
      ensureLsp: () => { this.ensureLspBridge() },
      schedule: () => { this.renderBatcher.schedule() },
      flush: () => { this.flushLiveRender() },
      toggleNotify: () => {
        this.applyNotifyPref('toggle', text => { this.commitToScrollback({ text, trailingNewline: true }) })
      },
      toggleDensity: () => {
        this.compactMode = !this.compactMode
        this.prefs.compactMode = this.compactMode
        this.persistPrefs()
        if (this.configProjection !== null) {
          this.configProjection = { ...this.configProjection, tui: { ...configTuiFromPrefs(this.prefs), compactMode: this.compactMode } }
        }
      },
      moveSkills: delta => this.skillSurface.moveSelected(delta),
    })
    this.ctx.provide('tui.commands', this.slash)
    // Phase 5.3：glance 数据源是惰性闭包（statusLine/liveAgent 随会话挂载），
    // 构造期只固定取数路径，会话切换后自动读到新投影。throttleMs: 0——
    // TuiApp 渲染节奏由 ticker（120ms）与事件驱动，两次 refresh 间隔恒大于
    // 控制器默认窗口，节流层在这里是冗余的；显式关闭让事件后的 renderLive
    // 立即读到最新派生（与装配前内联派生语义一致）。onChange 不接——
    // renderLive 每帧主动 refresh + current，推送回调只会引入重入。
    this.glance = new MetricsGlanceController({
      getStatusText: () => this.statusLine?.current ?? null,
      getLiveState: () => this.liveAgent?.state,
      getColumns: () => this.stdout.columns,
      throttleMs: 0,
    })
    // T3.1/C3 项 4：挂起状态机控制器（Wave 1 提取）。onEscapeImmediate 保持
    // 挂起态 ESC 语义（挂起期间 ESC 非 CSI 前缀）；onChanged 触发重绘——
    // 状态变化与 renderLive 的绑定收敛在装配点，controller 不碰渲染。
    this.question = new QuestionController({
      onEscapeImmediate: (flag) => { this.input.setEscapeImmediate(flag) },
      onChanged: () => { this.flushLiveRender() },
    })
    this.approval = new ApprovalController({
      getCurrentSessionId: () => this.activeSessionId,
      onChanged: () => { this.flushLiveRender() },
      getCommandPrefix: (req) => commandPrefixForRequest(req, this.transcript?.view),
    })
    // P1：/btw 侧问状态机。activeSessionId 动态读取（attach 前为 null，
    // /btw 命令层拦截回显）；onAnswer 折叠答案进 scrollback（Esc 关闭 done
    // 态时触发——答案持久化在用户确认折叠时，与 grok-build 语义对齐）。
    this.btw = new BtwController({
      ctx: this.ctx,
      activeSessionId: () => this.activeSessionId,
      onChanged: () => { this.flushLiveRender() },
      onAnswer: (entry) => {
        this.commitToScrollback({
          text: `[btw] ${entry.question}\n${entry.answer}`,
          trailingNewline: true,
        })
      },
    })
    // P3：多会话快照层（不持有会话生命周期；tab 栏渲染时 list() 派生）。
    this.sessionManager = new SessionManager(this.ctx)
    // 统一 action registry 装配（键路由数据源）：动作只经 ActionContext 门面触达本类
    // 私有方法。inspect 提示段构造期投影（静态）；审批提示段逐帧投影（p 段动态进出）。
    this.actionCtx = this.createActionContext()
    this.actions = new ActionRegistry(createBuiltinActions({ editorKey: this.editorKey }))
    this.blockingKeys = [
      createQuestionKeyContext({
        question: this.question,
        inputLine: this.inputLine,
        settle: answer => { this.settleQuestion(answer) },
        cancel: () => { this.cancelQuestion() },
        flushLive: () => { this.flushLiveRender() },
      }),
      createBtwKeyContext({ btw: this.btw, flushLive: () => { this.flushLiveRender() } }),
      createApprovalKeyContext({ approval: this.approval, registry: this.actions, ctx: this.actionCtx,
        inputLine: this.inputLine, flushLive: () => { this.flushLiveRender() },
        submitFeedback: (text) => { this.approval.settle('rejected'); this.handleSteer(text) } }),
    ]
    this.inspectKeys = createInspectKeyContext({ inspect: this.inspect, inputLine: this.inputLine })
    this.menuKeys = createSlashMenuKeyContext({
      inputController: this.inputController,
      accept: opts => { this.acceptSlashCompletion(opts) },
      flushLive: () => { this.flushLiveRender() },
    })
    this.overlayRouter = new OverlayKeyRouter({
      overlay: () => this.overlay,
      keyDialog: () => this.keyDialog,
      picker: () => this.picker,
      search: () => this.searchOverlay,
      scroll: () => this.scrollPager,
      rewind: () => this.rewindOverlay,
      memory: () => this.memoryOverlay,
      palette: () => this.palette,
      pasteKeyDialog: dialog => { void this.pasteClipboardIntoKeyDialog(dialog) },
      submit: text => { this.handleSubmit(text) },
      backfill: text => { this.inputLine.setValue(text) },
    })
    this.footerInspectHints = projectInspectHints(this.actions.list())
  }

  /** Phase 8：审批 answerer 订阅的 disposer（dispose 时解绑）。 */
  private approvalDisposer: (() => void) | null = null

  /** 当前会话 id（null = 尚未 attach）。 */
  get sessionId(): SessionId | null { return this.activeSessionId }

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
  private async waitForServicesReady(names: readonly string[], timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    const stale: string[] = []
    for (const name of names) {
      // 未注册（非严格取不到）：本 profile 无该服务，没有数据可等，直接跳过。
      if (this.ctx.reflect.get(name, false) === undefined) continue
      // 已注册但 fiber 未激活（init 未完成）：有界轮询等待激活完成。
      while (this.ctx.reflect.get(name) === undefined && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      if (this.ctx.reflect.get(name) === undefined) stale.push(name)
    }
    if (stale.length > 0) {
      console.warn(`[tui-runner] timed out waiting for ${stale.join(', ')} after ${String(timeoutMs)}ms; continuing with possibly stale defaults`)
    }
  }

  /**
   * 宿主服务（cmdlineArgs/appExit）就绪窗口：launcher 在 boot prepare 里
   * provide，正常时序下 attach 时已注册（0 等待）；仅当检测到宿主特征
   * （任一服务已注册）时为缺失方做短窗口轮询，覆盖 provide 略晚于装配的
   * 罕见时序。两服务均未注册 = 非宿主环境，立即返回。
   * @param timeoutMs - 最大等待毫秒（缺省 200）。
   */
  private async waitForHostServices(timeoutMs = 200): Promise<void> {
    const reflect = this.ctx.reflect
    if (reflect.get('cmdlineArgs', false) === undefined && reflect.get('appExit', false) === undefined) return
    const deadline = Date.now() + timeoutMs
    for (const name of ['cmdlineArgs', 'appExit']) {
      while (reflect.get(name, false) === undefined && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
  }

  /**
   * 接管终端：切主题（'auto' 探测背景）、装配会话、注册键路由与 resize、启动渲染 ticker。
   * @param initialSessionId - 覆盖构造选项的起始会话；缺省用构造 initialSessionId，
   *   再缺省恢复最近会话（live store 为空才新建）。
   */
  async attach(initialSessionId?: SessionId): Promise<void> {
    if (this.disposed) throw new Error('TuiApp already disposed')
    // 宿主线守卫：本版编译目标即 0.1.2-rc.1 线（Session.events getter 已移除，
    // 投影走 snapshotEvents）。旧宿主（≤0.1.1-rc.2，含 npm latest 旧钉线）上
    // 继续跑只会在会话读取路径深处炸 TypeError——启动即 fail-loud 给出可行动
    // 指引，绝不静默降级。
    if (typeof Session.prototype.snapshotEvents !== 'function') {
      throw new Error(
        'dsh-tianshu-tui 需要 0.1.2-rc.1+ 官方宿主（检测到旧线）。'
        + '请升级官方 CLI：pnpm dlx @deepseek-ai/dsh@latest（或 @next）；'
        + '或回退本插件：dsh plugin --profile tui add @huiliyi37/dsh-tianshu-tui@0.1.2-rc.28',
      )
    }
    // 宿主服务就绪窗口：cmdlineArgs/appExit 由 launcher 在 boot prepare 提供，
    // 正常时序下 attach 时已就绪（0 等待）；个别宿主 provide 略晚时短窗口补读。
    // 宿主特征 = 任一服务已注册（reflect 非严格可读）——两服务均未注册视为
    // 非宿主环境，立即返回（不拖慢测试/其它宿主装配）。读不到按无参数降级，
    // 绝不阻塞 TUI 启动（fail-open，与必选 inject 的静默卡死语义相反）。
    await this.waitForHostServices()
    // A3：处理 dsh launcher 转发的命令行参数（`dsh --profile tui <args>`）：
    // --help/-h 输出用法、--version/-v 输出版本后经 appExit 退出；纯位置参数
    // 作为初始 prompt（attach 完成后发送）。含其它 flag 时不发 prompt（避免
    // 与 --resume 等未实现参数的组合语义冲突）。
    const args = readCmdlineArgs(this.ctx)
    const flags = args.filter(a => a.startsWith('-'))
    const wantHelp = flags.includes('--help') || flags.includes('-h')
    const wantVersion = flags.includes('--version') || flags.includes('-v')
    const initialPrompt = flags.length === 0 ? args.filter(a => !a.startsWith('-')).join(' ') : ''
    if (wantHelp || wantVersion) {
      const exit = readAppExit(this.ctx)
      this.stdout.write(wantHelp
        ? USAGE_TEXT
        : `dsh-tianshu-tui ${readOwnVersion(fileURLToPath(new URL('.', import.meta.url))) ?? 'unknown'}\n`)
      if (exit !== undefined) { exit(0); return }
      // 无 appExit（测试/裸装配）：保持 fail loud，由调用方 dispose 收尾。
      throw new Error('[tui-runner] --help/--version requested but no appExit service provided')
    }
    // A1/A2：终端接管与会话创建之前等 settings/credentials 激活（有界；未注册
    // 跳过）。放在 paste/OSC 11 之前，避免半初始化终端上空等；否则 newSession
    // 快照到 config 默认模型，欢迎页误报 API Key ✗。
    await this.waitForServicesReady(['settings', 'credentials'])
    // bracketed paste + kitty 键盘增强（caps 支持时推送 flag 1：Ctrl+Enter 等修饰键
    // 以 CSI u 上报，不支持则序列被忽略、键位天然静默）：粘贴整段包裹进输入行。
    this.stdout.write(ANSI.BRACKETED_PASTE_ON + kittyKeyboardPushSeq())
    this.pasteDisposer?.()
    this.pasteDisposer = this.input.onPaste((text) => { void this.handlePaste(text) })
    // 目标 6：'auto' 才走系统终端配色探测（OSC 11 → dark/light）；显式主题直接生效。
    if (this.themeName === 'auto') {
      const background = await detectTerminalBackground()
      /* v8 ignore next -- autoThemeFor 恒返回有效主题名，setTheme 恒 true，graphite 兜底不可达 */
      if (!setTheme(autoThemeFor(background))) setTheme('graphite')
    } else if (!setTheme(this.themeName)) {
      // 持久化的主题已不可解析（自定义主题文件被删等）——回落 auto 检测并清掉失效偏好。
      const background = await detectTerminalBackground()
      if (!setTheme(autoThemeFor(background))) setTheme('graphite')
      this.prefs.theme = 'auto'
      this.persistPrefs()
    }

    const target = initialSessionId ?? this.initialSessionId ?? this.ctx.sessions.list()[0]?.id
    if (target !== undefined) await this.switchSession(target)
    else {
      // 启动复用：上一个没有任何内容的新对话（标题折叠为「新对话」）复用其
      // session id 而非铸造新 id——空会话随启动目录迁移（见 newSession）。
      const reuse = await findMostRecentEmptySession(this.ctx).catch(() => undefined)
      await this.newSession(reuse)
    }

    // Phase 9b：会话恢复面板——启动时把可恢复会话列表写进 scrollback
    // （当前会话除外；无其他可恢复会话时静默）。live 标注取 live store。
    await this.renderRestorableSessions()

    this.resize.onResize(() => {
      this.live.setMaxRows(liveMaxRowsFor(this.stdout.rows))
      // overlay 激活时主屏 live 不写；resize 只重绘 alt screen 面板。
      if (this.overlay !== null && this.overlay.activeId() !== null) {
        this.overlay.rerender()
        return
      }
      this.flushLiveRender()
    })
    this.input.onAnyKey((key) => { this.handleKey(key) })
    // Phase 8：审批 answerer——waterfall 必须 next() 委托（非当前会话的
    // 请求交给链上其他 answerer；当前会话的请求挂起等用户 y/N。重复
    // attach 先解绑旧 disposer（与 interactionDisposer 对称）。
    this.approvalDisposer?.()
    this.approvalDisposer = this.ctx.on('approval/request', (req: PendingApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
      return this.handleApprovalRequest(req, next)
    })
    // #39：技能展示面接线（订阅 skills/change + 首刷，首次输入前技能就绪）。
    this.skillSurface.attach()
    // Ctrl+P 命令面板装配：数据源 = 命令实时快照 + userInvocable 技能（#39）；
    // 主题动态读取。
    this.palette = new CommandPalette({
      getCommands: () => this.slash.list(),
      getSkills: () => this.skillSurface.paletteEntries(),
      getTheme: () => this.theme,
    })
    this.overlay = new OverlayController({
      stdout: this.stdout,
      getSize: () => ({ cols: this.stdout.columns, rows: this.stdout.rows }),
      live: this.live,
      onOverlayChange: (active) => {
        if (active) return
        // 退出 alt screen 后：把 overlay 期间暂存的 scrollback 补写回主屏，
        // 再同步重绘 live 区（不能只等 120ms ticker——主屏刚恢复时 live 区是旧帧）。
        this.commitSurface.flushDeferred()
        this.flushLiveRender()
        // 焦点去抖接线（终端 raw mode 无窗口焦点事件，overlay 关闭为最近似）：
        // 此后 FOCUS_DEBOUNCE_MS 内的 Ctrl+V 只走文本——刚关掉的对话框里那次
        // 粘贴不应再把剪贴板图读一次。
        this.lastInputFocusAt = Date.now()
      },
    })
    this.overlay.register('command-palette', this.palette)
    // Ctrl+. 快捷键面板（grok-build 键位清单弹层）：静态两列表，进出 alt screen。
    this.overlay.register('keymap', {
      render: cols => renderKeymapPanel(cols),
    })
    // C2 项 2：历史搜索 overlay（Ctrl+F）——消息快照在激活时由装配方提供。
    this.searchOverlay = new HistorySearchOverlay()
    this.overlay.register('search', this.searchOverlay)
    // /scroll 分页查看器——scrollback 全文快照在激活时由装配方提供。
    this.scrollPager = new ScrollPagerOverlay()
    this.overlay.register('scroll', this.scrollPager)
    // C3 项 3：rewind overlay（/rewind）——消息快照 + 执行回调在激活时提供。
    this.rewindOverlay = new RewindOverlay(undefined, {
      onSettled: () => { this.overlay?.rerender() },
    })
    this.overlay.register('rewind', this.rewindOverlay)
    // P2：memory 浏览器 overlay（/memory）——条目快照 + 数据源在激活时注入。
    this.memoryOverlay = new MemoryBrowserOverlay()
    this.overlay.register('memory', this.memoryOverlay)
    // #31：交互式选择器 overlay（/model /theme /session 无参打开；上下键选择）。
    this.picker = new PickerController({ getTheme: () => this.theme })
    this.overlay.register('picker', this.picker)
    // /key、/login：API Key 设置对话框 + 供应商配置装配层（保存成功刷新就绪标志）。
    this.keyDialog = new KeyDialogController({
      getTheme: () => this.theme,
      onSaved: () => { void this.refreshApiKeyReady() },
    })
    this.overlay.register('key-dialog', this.keyDialog)
    this.keyFlow = new KeyFlow({
      overlay: this.overlay,
      picker: this.picker,
      keyDialog: this.keyDialog,
      reflect: this.ctx.reflect,
      isDisposed: () => this.disposed,
      stdinIsTTY: () => this.stdin.isTTY,
      apiKeyReady: () => this.apiKeyReady,
      ...(this.disableKeyAutoPrompt ? { autoPrompt: false } : {}),
      agentDefaultModel: (this.ctx as unknown as { agentDefaultModel?: { currentSelection?: () => { provider: string } } }).agentDefaultModel,
    })
    this.input.setMode('input')
    this.ticker = setInterval(() => {
      if (this.hasVisibleSpinner()) this.tick++
      this.renderLiveFromTicker = true
      try { this.renderLive() }
      finally { this.renderLiveFromTicker = false }
    }, 120)
    this.ticker.unref()
    // T3.1：userQuestions 结构化提问应答（rc.1 wire：registerProvider 已移除，
    // 改挂 'user-questions/request' waterfall answerer；TUI 是唯一 answerer，
    // 全量 claim，重叠请求沿用 ASK_CANCELLED 语义拒绝）。事件是 scope-filtered
    // （dsh-scope：scoped ask 只派发到 agent 作用域链内的监听者），TUI 插件
    // fiber 不在任何 agent 作用域链上——必须 global 注册才能收到全部请求。
    this.interactionDisposer?.()
    this.interactionDisposer = this.ctx.on('user-questions/request', (request, _next) =>
      this.handleQuestionRequest(request) as Promise<AskUserQuestionAnswer>, { global: true })
    this.attached = true
    if (this.pendingUpdateNotice !== null) {
      this.commitToScrollback({ text: this.pendingUpdateNotice, trailingNewline: true })
      this.pendingUpdateNotice = null
    }
    if (this.pendingUpdateFailNotice !== null) {
      this.echoWarn(this.pendingUpdateFailNotice)
      this.pendingUpdateFailNotice = null
    }
    for (const w of this.themeWarnings) this.echoWarn(`⚠ 主题警告：${w}`, '/theme 检查自定义主题')
    this.flushLiveRender()
    // A3：纯位置参数作为初始 prompt（`dsh --profile tui "修复这个 bug"`）。
    if (initialPrompt !== '') {
      this.handleSubmit(initialPrompt)
    } else {
      // /key 首启引导：TTY 缺 API key 时自动打开一次设置对话框（key-flow
      // 内部 run 级守护；非 TTY/已配置自动跳过；带 prompt 启动不打扰）。
      this.keyFlow.maybeAutoOpenKeyDialog()
    }
  }

  /**
   * 自更新落盘后的用户提示。模块已加载，新代码要重启才生效。
   * attach 完成前调用则排队，完成后写入 scrollback。
   */
  notifyPluginUpdated(version: string): void {
    this.notifyUpdateLine(updateNoticeText(version))
  }

  /** 自更新后将自动重启的提示（装配方随后触发重启）。 */
  notifyAutoRestart(version: string): void {
    this.notifyUpdateLine(autoRestartNoticeText(version))
  }

  /**
   * 当前会话是否 blank：无消息且无未结算工具调用。
   * /preset recompose 与更新后自动重启的守卫共用（非空白不打断会话）。
   */
  isBlankSession(): boolean {
    const view = this.transcript?.view
    return (view?.messages ?? []).length === 0
      && (view?.tools ?? []).every(t => t.result !== undefined)
  }

  /** 更新提示落盘：attach 完成前排队（pendingUpdateNotice），完成后写 scrollback。 */
  private notifyUpdateLine(text: string): void {
    if (this.disposed) return
    if (!this.attached) {
      this.pendingUpdateNotice = text
      return
    }
    this.commitToScrollback({ text, trailingNewline: true })
    this.flushLiveRender()
  }

  /**
   * 自更新失败的用户提示（P1-1；文案 #43 反馈优化）：可操作引导优先——
   * 重试/手动命令/关闭开关，而不是只甩环境变量。attach 完成前调用则排队。
   */
  notifyPluginUpdateFailed(error: string): void {
    if (this.disposed) return
    const text = [
      `⚠ 自更新失败：${error}`,
      '  · 重启 dsh 会自动重试（网络恢复后即可成功）',
      `  · 手动更新：npx -y @deepseek-ai/dsh plugin --profile tui add ${updateNoticePackage}@latest`,
      '  · 不想再看到此提示：启动前设 DSH_TUI_SKIP_UPDATE=1',
    ].join('\n')
    if (!this.attached) {
      this.pendingUpdateFailNotice = text
      return
    }
    this.echoWarn(text)
  }

  /** T3.1：结构化提问 answerer——薄转发 QuestionController（渲染/ESC/重绘由控制器回调承担）。 */
  private handleQuestionRequest(request: unknown): Promise<unknown> {
    return this.question.ask(request)
  }

  /**
   * bracketed paste 文本落地（右键粘贴/终端菜单粘贴）：先尝试剪贴板读图
   * （命中则附图并吞掉这段 paste——粘贴进来的文本是图片字节的乱码，不插图
   * 会污染输入框）；再识别图片路径加载为附件；最后才是普通文本插入。
   * @param text - 终端传来的粘贴文本
   */
  private async handlePaste(text: string): Promise<void> {
    // 剪贴板当前是图片 → 附图并吞掉（与 Ctrl+V 互斥：右键粘贴产生 paste
    // 事件、Ctrl+V 产生 ctrl_v 按键，不会同时触发）。readImageFromClipboard
    // 无图/失败时返回 null（自然落入文本粘贴）；此处 catch 只接管线处理
    // 失败（超限压缩失败等）——回显原因，不把位图乱码插进输入行。
    if (this.inputLine.images.length < MAX_IMAGES) {
      const imgResult = await readImageFromClipboard()
      if (imgResult) {
        try {
          await this.attachClipboardImage(imgResult.dataUrl, imgResult.name)
          return
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          this.commitToScrollback({ text: color(`⚠ 剪贴板图片处理失败: ${message}`, this.theme.warning), trailingNewline: true })
          this.flushLiveRender()
          return
        }
      }
    }
    const trimmed = text.trim()
    // 粘贴内容看起来像图片路径 → 尝试加载为附件；失败回退为普通文本。
    if (trimmed && looksLikeImagePath(trimmed) && !trimmed.includes('\n')) {
      if (this.inputLine.images.length >= MAX_IMAGES) {
        this.commitToScrollback({ text: color(`⚠ 最多附加 ${MAX_IMAGES} 张图片`, this.theme.warning), trailingNewline: true })
        this.flushLiveRender()
        return
      }
      try {
        const attachment = await loadImageAttachment(resolve(trimmed))
        this.inputLine.addImage(attachment.dataUrl)
        this.flushLiveRender()
        return
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.commitToScrollback({ text: color(`⚠ 图片加载失败: ${message}`, this.theme.warning), trailingNewline: true })
        this.flushLiveRender()
        // fallthrough to normal text paste
      }
    }
    this.inputLine.insertText(text)
    this.flushLiveRender()
  }

  /**
   * Ctrl+V 处理：优先读剪贴板图片 → 失败则 fallback 到文本粘贴。
   * 焦点防抖：输入框在最近 FOCUS_DEBOUNCE_MS 内刚「重获焦点」（overlay
   * 关闭近似——终端 raw mode 下无窗口焦点事件）时跳过读图，避免把粘贴进
   * 对话框/选择器的那次 Ctrl+V 再当一次读图。
   */
  private async handleCtrlV(): Promise<void> {
    if (Date.now() - this.lastInputFocusAt < FOCUS_DEBOUNCE_MS) {
      const text = await readTextFromClipboard()
      if (text) {
        this.inputLine.insertText(text)
        this.flushLiveRender()
      }
      return
    }
    try {
      const result = await readImageFromClipboard()
      if (result) {
        if (this.inputLine.images.length >= MAX_IMAGES) {
          this.commitToScrollback({ text: color(`⚠ 最多附加 ${MAX_IMAGES} 张图片`, this.theme.warning), trailingNewline: true })
          this.flushLiveRender()
          return
        }
        await this.attachClipboardImage(result.dataUrl, result.name)
        return
      }
    } catch (err) {
      // 管线处理失败（超限压缩失败等）——回显原因；剪贴板读图本身失败
      // （readImageFromClipboard 内部吞掉返回 null）走下方文本 fallback。
      const message = err instanceof Error ? err.message : String(err)
      this.commitToScrollback({ text: color(`⚠ 剪贴板图片处理失败: ${message}`, this.theme.warning), trailingNewline: true })
      this.flushLiveRender()
      return
    }
    const text = await readTextFromClipboard()
    if (text) {
      this.inputLine.insertText(text)
      this.flushLiveRender()
    } else {
      // P1-1：无图且无文本——回显一行提示。「无内容」覆盖剪贴板为空与读图/读文
      // 失败两种情形，不误指为工具链缺失；括号保留读图工具链的诊断信息。
      this.echoWarn('⚠ 剪贴板无内容可粘贴（读图需 osascript / wl-paste / xclip / PowerShell）')
    }
  }

  /**
   * 剪贴板位图附件化：dataUrl 解回字节后走与文件路径同一条预算管线
   * （magic 校验 + 原样直发 + 三级自适应压缩）——超限大图在此被压缩或
   * 响亮失败，而不是挂上后在提交时被静默丢弃。
   * @param dataUrl - 剪贴板读图结果（data:image/...;base64,...）。
   * @param name - 附件显示名。
   */
  private async attachClipboardImage(dataUrl: string, name: string): Promise<void> {
    const comma = dataUrl.indexOf(',')
    const buf = Buffer.from(comma === -1 ? dataUrl : dataUrl.slice(comma + 1), 'base64')
    const attachment = await loadClipboardImageAttachment(buf, name.length > 0 ? name : 'clipboard.png')
    this.inputLine.addImage(attachment.dataUrl)
    this.flushLiveRender()
  }

  /**
   * 设置当前主控模型的识图能力与桥接状态（图片附件气泡提示数据源）。
   * 由装配方按 agent 配置注入；TUI 是纯表现层，不自行查询模型能力。
   * @param supportsVision - 主控模型是否原生支持识图（图片直发）
   * @param bridgeEnabled - 是否配置了独立识图桥模型（主控不识图时经桥转描述）
   * @param bridgeSource - 识图桥来源（configured/auto/none；气泡提示文案用）
   */
  setVisionInfo(
    supportsVision: boolean,
    bridgeEnabled: boolean,
    bridgeSource?: 'configured' | 'auto' | 'none',
  ): void {
    this.supportsVision = supportsVision
    this.visionBridgeEnabled = bridgeEnabled
    this.visionBridgeSource = bridgeSource
  }

  /**
   * 宿主视觉桥探测：视觉桥插件（dsh-vision-bridge）装配时应 provide('visionBridge')
   * 服务，存在即视为桥可用（来源按 configured 处理，装配方注入过 bridgeSource 时
   * 保留注入值）。显式注入 vision.bridgeEnabled 时短路；否则每次提交图片前补探，
   * 覆盖桥插件晚于 tui-runner 激活的装配时序（reflect.get 是字典读，代价可忽略）。
   * @returns 当前是否有可用识图桥。
   */
  private resolveVisionBridge(): boolean {
    if (this.visionBridgeEnabled) return true
    if (this.ctx.reflect.get('visionBridge', false) !== undefined) {
      this.visionBridgeEnabled = true
      this.visionBridgeSource = this.visionBridgeSource ?? 'configured'
    }
    return this.visionBridgeEnabled
  }

  /** T3.1：结算挂起的提问（用户选择/取消）——薄转发。 */
  private settleQuestion(answer: unknown): void {
    this.question.settle(answer)
  }

  /** T3.1：取消挂起的提问（Esc/Ctrl+C）——薄转发。 */
  private cancelQuestion(): void {
    this.question.cancel()
  }

  /**
   * 查 DEEPSEEK_API_KEY 是否已配置：优先 credentials.describe（含 file / .env 层），
   * 服务缺失或抛错时回退 process.env。欢迎页与 footer 共用，避免只看环境变量的误报。
   */
  private async refreshApiKeyReady(): Promise<void> {
    const credentials = this.ctx.reflect.get('credentials', false) as CredentialsDescribeFacet | undefined
    if (credentials !== undefined) {
      try {
        const info = await credentials.describe('DEEPSEEK_API_KEY')
        this.apiKeyReady = info.configured
        return
      } catch {
        // 服务面不匹配时回退 env
      }
    }
    this.apiKeyReady = Boolean(process.env.DEEPSEEK_API_KEY)
  }

  /**
   * 按当前主控模型刷新识图标志。llm 服务缺失或查询失败时保持原值；
   * inputModalities 含 image 才直发图片，否则走桥或「未发送」。
   */
  private refreshVisionForSelection(selection: { provider: string; model: string }): void {
    const llm = this.ctx.reflect.get('llm', false) as LlmModelInfoFacet | undefined
    if (llm === undefined) return
    void llm.resolveModelInfo(selection.provider, selection.model).then((info) => {
      if (this.disposed) return
      const modalities = info.inputModalities
      this.supportsVision = modalities !== undefined && modalities.includes('image')
    }).catch(() => {
      // 目录查询失败时保持启动时的识图标志
    })
  }

  /** 当前会话工作区：header.cwd 优先，缺省回退启动目录。 */
  private sessionCwd(): string {
    if (this.activeSessionId === null) return process.cwd()
    const cwd = getSession(this.ctx, this.activeSessionId)?.header?.cwd
    return cwd === undefined || cwd === '' ? process.cwd() : cwd
  }

  // —— LSP 诊断桥（本地语言服务；展示层私有状态，不写会话事件）——

  /**
   * 懒创建诊断桥：首次工具触碰文件或 /lsp 打开时实例化（rootUri = 当时
   * 会话 cwd）；缓存更新回调触发 renderLive（WriteBatcher 节流）。
   */
  private ensureLspBridge(): LspBridge {
    if (this.lspBridge !== null) return this.lspBridge
    // 诊断源选择（能力门控见 selectDiagnosticSource，任务6对齐）：
    // 1. 社区/伴生形状（getDiagnostics 函数直接可用）→ 直接采纳；
    // 2. 官方 seam 形状（只有 query）→ 需服务声明 operations 含 getDiagnostics
    //    才采纳——0.6.x seam 只有导航四操作，盲目采纳会让 seam 源顶掉内置
    //    multi-manager 而 query 恒报不可用 → /lsp 面板永久空；
    // 3. 均未命中 → 内置桥（降级路径，诊断照常）。
    const selected = selectDiagnosticSource(this.ctx.reflect.get('lsp', false), this.sessionCwd())
    const source = selected.kind === 'service' ? selected.source : undefined
    this.lspBridge = createLspBridge({
      cwd: this.sessionCwd(),
      ...(this.lspConfig.timeoutMs === undefined ? {} : { timeoutMs: this.lspConfig.timeoutMs }),
      ...(this.lspConfig.spawnFor === undefined ? {} : { spawnFor: this.lspConfig.spawnFor }),
      ...(this.lspConfig.which === undefined ? {} : { which: this.lspConfig.which }),
      ...(source === undefined ? {} : { source }),
    })
    this.lspBridge.onUpdate(() => { this.renderBatcher.schedule() })
    return this.lspBridge
  }

  /**
   * 从工具参数提取文件路径并触发诊断拉取（write/read/edit 族；无 path 参数
   * 的工具如 bash 不触发）。嵌套工具调用（multi_tool_use 的 tool_uses）递归
   * 展开。只读展示：拉取失败/超时静默，不阻塞工具流。
   * @param argumentsRaw - tool/call 事件参数原文。
   */
  private touchLspPaths(argumentsRaw: string): void {
    if (!this.lspConfig.enabled) return
    const args = parseToolArguments(argumentsRaw)
    if (args === undefined) return
    const paths: string[] = []
    for (const key of ['path', 'file_path', 'file'] as const) {
      const value = args[key]
      if (typeof value === 'string' && value !== '') paths.push(value)
    }
    const nested = args.tool_uses
    if (Array.isArray(nested)) {
      for (const use of nested) {
        if (use !== null && typeof use === 'object' && typeof (use as { arguments?: unknown }).arguments === 'string') {
          this.touchLspPaths((use as { arguments: string }).arguments)
        }
      }
    }
    if (paths.length === 0) return
    const bridge = this.ensureLspBridge()
    for (const path of paths) bridge.touchFile(path)
  }

  /** /lsp 面板数据源：桥未创建（从未触碰文件）→ []。 */
  private lspDiagnosticsView(): LspDiagnosticView[] {
    return this.lspBridge === null ? [] : [...this.lspBridge.entries()]
  }

  /**
   * 工具卡标题徽标：参数里的文件有已就绪诊断 → `⚠ 1错 2警`；否则 null
   * （拉取中/无诊断/桥未创建/无 path 参数均不显示，不干扰标题）。
   */
  private lspBadgeFor(args: Record<string, unknown> | undefined): string | null {
    if (!this.lspConfig.enabled || this.lspBridge === null || args === undefined) return null
    const paths = (['path', 'file_path', 'file'] as const)
      .map(key => args[key])
      .filter((v): v is string => typeof v === 'string' && v !== '')
    if (paths.length === 0) return null
    for (const path of paths) {
      const diags = this.lspBridge.diagnosticsFor(path)
      if (diags !== undefined) {
        const badge = lspBadgeText(diags)
        if (badge !== null) return `⚠ ${badge}`
      }
    }
    return null
  }

  /**
   * Ctrl+S / 欢迎「恢复」：切到 listSessions 里最近的非当前会话（含 persistence）。
   * live store 没有时走 switchSession → resume。
   */
  private async restoreRecentOtherSession(): Promise<void> {
    // listSessions 失败静默降级（与 refreshSessionTabs 的 catch 对称）：
    // 调用点为 void 触发（Ctrl+S），无 catch 会成为 unhandled rejection。
    const others = (await listSessions(this.ctx).catch(() => [])).filter(s => s.id !== this.activeSessionId)
    const target = others[0]?.id
    if (target !== undefined) this.switchSessionGuarded(target)
  }

  /**
   * Phase 9b：把可恢复会话列表写进 scrollback（启动时）。
   * 排除当前活跃会话；无其他可恢复会话时静默（不占位）。
   * live 标注取 live store（listSessions 的 header 无 live 字段，
   * 经 ctx.sessions.list() 的 id 集合判定）。
   */
  private async renderRestorableSessions(): Promise<void> {
    await this.refreshApiKeyReady()
    const cols = this.stdout.columns
    const gutter = cols >= CHROME_GUTTER * 2 + 8 ? CHROME_GUTTER : 0
    const commitLine = (text: string): void => {
      // 不加 trailingNewline：CommitEngine 会把 true 理解成「再垫一个空行」，
      // 欢迎每行变成双倍高度，40 行屏上 tips 会被顶出视口。
      this.commitToScrollback({ text })
    }
    // C4 概念稿 A：顶部栏（format/top-bar.ts 纯渲染）——cwd + 模型 + git 分支，
    // 最顶一行（对齐 grok top_bar）；分支经 gitBranch() 一次读取（静默）。
    const current = this.ctx.agentDefaultModel.currentSelection()
    const branch = gitBranch()
    // git 未提交计数快照（footer ●N 数据源）：attach 一次 + 每 turn/end 刷新。
    this.gitDirty = gitDirtyCount()
    const welcomePreset = livePresetShort(this.ctx, this.activeSessionId)
    for (const line of formatTopBar({
      width: cols - gutter,
      cwd: this.sessionCwd(),
      modelName: `${current.provider}/${current.model}`,
      // exactOptionalPropertyTypes：branch 不可显式传 undefined，条件展开
      ...(branch === undefined ? {} : { branch }),
      ...(welcomePreset === undefined ? {} : { preset: welcomePreset }),
    }, this.theme)) {
      commitLine(gutter > 0 ? `${' '.repeat(gutter)}${line}` : line)
    }

    const active = this.activeSessionId
    const summaries = await listSessions(this.ctx)
    const others = summaries.filter(s => s.id !== active)

    // 环境检查结果：唯一来源（首启与有会话统一一行，不重复渲染）。
    const env: WelcomeEnvCheck = {
      hasApiKey: this.apiKeyReady,
      isGitRepo: isGitRepo(),
      themeName: getActiveThemeName(),
      cols,
    }
    // 最近可恢复会话摘要（并入 tips「恢复」项，不单独占屏）。
    const recent = others[0]
    const resumeAvailable = others.length > 0
    const resumeLabel = recent === undefined
      ? '恢复会话'
      : `恢复 · ${formatSessionAge(recent.createdAt, Date.now())}`

    // 品牌鲸鱼像素画（窄屏/矮屏/低色深/legacy conhost 时降级为纯文字品牌区）。
    const whale = formatWhaleLogo({ width: cols, rows: this.stdout.rows })

    // 顶栏与欢迎之间留 1 行。live overlay 不再填剩余视口。
    commitLine('')

    const tips: WelcomeTipItem[] = []
    // 首次运行 onboarding：欢迎页一次性引导（/help 命令帮助面板），展示后
    // 写 prefs.onboarded 落盘，之后启动不再重复。VITEST（prefsPath null）下
    // 不落盘、恒展示（测试密封）。
    if (this.prefs.onboarded !== true) {
      tips.push({ keyHint: '/help', label: '命令帮助面板' })
      this.prefs.onboarded = true
      this.persistPrefs()
    }
    // 环境待办优先：API key 缺失是硬阻塞，排最前引导（/key 配置密钥）。
    if (!this.apiKeyReady) {
      tips.push({ keyHint: '/key', label: '配置 API key' })
    }
    tips.push(
      { keyHint: 'ctrl+n', label: '新会话' },
      { keyHint: 'ctrl+s', label: resumeLabel, available: resumeAvailable },
      { keyHint: 'ctrl+p', label: '命令面板' },
      { keyHint: '/', label: 'slash 命令' },
      { keyHint: 'ctrl+o', label: '展开推理' },
      { keyHint: 'shift+tab', label: '模式循环' },
    )
    const ownVersion = readOwnVersion(fileURLToPath(new URL('.', import.meta.url)))
    // 欢迎页风格分流（prefs.welcomeStyle，缺省 blue）：blue = 蓝鲸抱星 +
    // ANSI Shadow 艺术字标题块；star = 紫鲸举星 + 艺术字标题块；
    // 门禁不满足（窄/矮/无色/full 档）或 retro 配置 → 现行为。
    let hero: string[] = []
    const welcomeStyle = this.prefs.welcomeStyle ?? 'blue'
    if (welcomeStyle === 'blue') {
      const blueWhale = formatBlueWhaleLogo({ width: cols, rows: this.stdout.rows })
      hero = formatBlueWelcomeHero({
        width: cols,
        rows: this.stdout.rows,
        whale: blueWhale,
        env,
        tips,
        ...(ownVersion === undefined ? {} : { version: ownVersion }),
      }, this.theme)
    } else if (welcomeStyle === 'star') {
      const starWhale = formatStarWhaleLogo({ width: cols, rows: this.stdout.rows })
      hero = formatStarWelcomeHero({
        width: cols,
        rows: this.stdout.rows,
        whale: starWhale,
        env,
        tips,
        ...(ownVersion === undefined ? {} : { version: ownVersion }),
      }, this.theme)
    }
    if (hero.length === 0) {
      hero = formatWelcomeHero({ width: cols, whale, env, tips, ...(ownVersion === undefined ? {} : { version: ownVersion }) }, this.theme)
    }
    for (const line of hero) {
      commitLine(line)
    }
    // 空行收尾：命令回显（如「模型已切换」）与欢迎页在视觉上自然分离。
    commitLine('')
  }

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
  async newSession(reuse?: SessionSummary): Promise<SessionId> {
    // P3 side conversation：切换时保留旧会话 agent（keepHandle 让渡 registry）——
    // /session new 后旧会话可切回。退出（dispose）时 detachProjections 默认
    // 释放全部 handle（见 dispose 路径）。
    await this.detachProjections({ keepHandle: true })
    this.dynamicRowsHighWater = 0
    let id = reuse?.id
    if (reuse !== undefined) {
      // 空会话复用统一先清旧 artifact（无论是否跨目录）：同目录走后端 adopt 会
      // 校验存储事件与新 live seed 逐条一致——真实宿主的 meta 事件
      // （permission/preset、sandbox/mode、approval/policy）内容/时间每轮不同，
      // adopt 恒被拒（"already has a persisted log on disk that does not match"）。
      // 清掉后以同 id 全新 materialize，规避前缀校验且 header 恒为当前格式。
      if (!await clearEmptySessionArtifact(this.ctx, reuse)) id = undefined
    }
    const sessionId = id ?? SessionId(`session-${randomUUID()}`)
    const selection = this.ctx.agentDefaultModel.currentSelection()
    // C2 项 4：持有可变 ModelSelectionRef——/model 热切当前会话（改 current，
    // 下一次 agent 步进的 prompt assembly 自动生效）。
    this.modelRef = { current: selection, assembled: undefined }
    const ref = this.modelRef
    // header.cwd 是 Web 会话列表与 workspace 挂载的门槛：缺省会被持久化进
    // `_no-cwd/` 并从 web API 可见列表过滤掉（issue #5）。TUI 工作区 = 启动目录。
    // joinedId 在 setup 回调内赋值：agents.create 的契约是 await 完 setup 才 resolve，
    // 因此下方 append 读到的已是定稿值（预设失败 warn 时保持 undefined，不落切换事件）。
    let joinedId: string | undefined
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentCtx) => {
        installModelSelection(agentCtx, ref)
        joinedId = await joinCreateOrWarn(this.ctx, agentCtx, this.prefs.preset, m => this.echoWarn(m))
      },
    })
    this.ownedHandle = handle
    this.controls = controlsFromHandle(handle)
    this.activeSessionId = sessionId
    if (joinedId !== undefined) {
      handle.agent.session.append('agent-preset/selected', { agentPreset: joinedId })
    }
    this.mountSession(sessionId)
    return sessionId
  }

  /**
   * C2 项 4：热切当前会话的模型。改 modelRef.current——下一次 agent 步进
   * （prompt assembly）自动生效，不中断当前步骤。registry 兜底的会话
   * （ref 由其他装配方持有）返回 false，调用方提示不可热切。
   * @param selection - 新的 provider/model。
   * @returns 是否已热切（modelRef 存在）。
   */
  switchLiveModel(selection: ModelSelection): boolean {
    if (this.modelRef === null) return false
    this.modelRef.current = selection
    this.glanceModelName = selection.model
    this.glanceEffort = selection.reasoningEffort ?? null
    this.refreshVisionForSelection(selection)
    return true
  }

  /** A3：create({ seed }) 铸 child；禁止 fork 后再 resume live 会话。 */
  async forkSession(opts?: { directive?: string }): Promise<SessionId> {
    if (this.activeSessionId === null) throw new Error('当前无会话可分叉')
    const parent = this.ctx.sessions.get(this.activeSessionId)
    if (parent === undefined) throw new Error('当前无会话可分叉')
    const forked = await createForkedAgent(this.ctx, parent, this.activeSessionId, process.cwd())
    await this.detachProjections({ keepHandle: true })
    this.dynamicRowsHighWater = 0
    this.modelRef = forked.ref
    this.ownedHandle = forked.handle
    this.controls = controlsFromHandle(forked.handle)
    this.activeSessionId = forked.childId
    this.mountSession(forked.childId)
    if (opts?.directive) await this.controls?.followup(opts.directive)
    return forked.childId
  }

  /**
   * C3 项 3：打开 rewind overlay（/rewind）。检查点 = transcript 里真人用户
   * 说过的非空 `user/message`；执行回调做「文件回退 + 会话截断 + 持久化截断」。
   * @returns 是否已打开（无活跃会话或无可回退用户消息时 false）。
   */
  rewindSession(): boolean {
    const overlay = this.overlay
    const rewind = this.rewindOverlay
    if (overlay === null || rewind === null || this.activeSessionId === null) return false
    const messages = collectUserRewindCheckpoints(this.transcript?.view.messages ?? [])
    if (messages.length === 0) { this.echoWarn('没有可回退的用户消息'); return false }
    rewind.setMessages(messages, (mode, atSeq) => this.executeRewind(mode, atSeq))
    overlay.activate('rewind')
    return true
  }

  /**
   * P1：发起 /btw 侧问——BtwController 旁路（临时 btw agent，不持 ownedHandle、
   * 不经过 switchSession）。返回是否已发起：无活跃会话或已有挂起侧问时 false
   * （命令分发层回显提示）；创建/提问失败抛错由 runSlash 统一回显。
   * @param question - 侧问文本（已 trim）。
   * @returns 是否已发起。
   */
  private async askBtw(question: string): Promise<boolean> {
    if (this.activeSessionId === null) return false
    if (this.btw.isActive) return false
    await this.btw.ask(question)
    return true
  }

  /**
   * T3：/export 会话导出——把当前会话完整事件日志渲染为 Markdown 并写盘。
   * 数据源是 session.events（权威事件流，非渲染视图）：完整内容、无折叠截断。
   * path 缺省 = 会话创建目录下 `dsh-export-<id>.md`（header.cwd 缺失时回退
   * 当前进程 cwd）。无活跃会话或写盘失败抛错——命令分发层回显失败（fails loud）。
   * @param path - 目标文件路径；缺省由会话 cwd 决定。
   * @returns 实际写入的导出文件路径。
   */
  private async exportTranscript(path?: string): Promise<string> {
    if (this.activeSessionId === null) {
      throw new Error('当前无会话，无法导出')
    }
    const session = this.ctx.sessions.get(this.activeSessionId)
    if (session === undefined) {
      throw new Error('会话不存在，无法导出')
    }
    const target = path ?? join(session.header.cwd ?? process.cwd(), `dsh-export-${session.id}.md`)
    const markdown = renderSessionExport(session.snapshotEvents(), {
      sessionId: session.id,
      // exactOptionalPropertyTypes：undefined 显式展开（条件展开是正确形态）。
      ...(session.header.cwd !== undefined ? { cwd: session.header.cwd } : {}),
    })
    await writeFile(target, markdown, 'utf8')
    return target
  }

  /**
   * P2：打开 memory 浏览器 overlay。条目快照 + 删除回调在激活时经 memory
   * 服务注入（reflect 动态获取；服务缺失返回 false，命令层回显不可用）。
   * @returns 是否已打开。
   */
  private async openMemoryBrowser(): Promise<boolean> {
    const overlay = this.overlay
    const browser = this.memoryOverlay
    if (overlay === null || browser === null) return false
    const memory = this.ctx.reflect.get('memory', false) as MemoryServiceFacet | undefined
    if (memory === undefined) return false
    const PAGE_SIZE = 20
    const items = await memory.list({ limit: PAGE_SIZE, offset: 0 })
    const hasMore = items.length >= PAGE_SIZE
    browser.setItems(items, {
      refetch: async () => memory.list(),
      onDelete: async (id) => { await memory.delete(id) },
      fetchPage: async (offset, limit) => memory.list({ offset, limit }),
    }, hasMore)
    overlay.activate('memory')
    return true
  }

  /** #31：打开模型选择器（Enter 本会话 / S 写默认）。 */
  private async openModelPicker(): Promise<void> {
    const saved = (this.ctx as unknown as { agentDefaultModel?: ModelFacet }).agentDefaultModel
      ?.currentSelection()
    const live = this.modelRef?.current ?? saved
    await openModelPicker({
      overlay: this.overlay,
      picker: this.picker,
      echoWarn: (text, hint) => { this.echoWarn(text, hint) },
      commit: (text) => { this.commitToScrollback({ text, trailingNewline: true }) },
      ...(live === undefined ? {} : { current: live }),
      savedKey: saved === undefined ? null : `${saved.provider}/${saved.model}`,
      llm: this.ctx.reflect.get('llm', false) as ModelPickerLlm | undefined,
      applySession: (selection) => this.switchLiveModel(selection),
      applyDefault: (selection) => {
        void (this.ctx as unknown as { agentDefaultModel?: ModelFacet }).agentDefaultModel
          ?.saveSelection(selection)
      },
    })
  }

  /**
   * C2 项 2：历史搜索 overlay 开关（Ctrl+F 与 vim NORMAL '/' 共用入口）。
   * 打开时快照 transcript 消息；已打开则关闭。
   */
  private toggleHistorySearchOverlay(): void {
    const overlay = this.overlay
    const search = this.searchOverlay
    /* v8 ignore next -- overlay/searchOverlay 在 attach 时恒创建，null 仅类型收窄 */
    if (overlay !== null && search !== null) {
      if (overlay.activeId() === 'search') {
        overlay.deactivate()
      } else {
        search.setMessages(this.transcript?.view.messages ?? [])
        overlay.activate('search')
      }
    }
  }

  /** /scroll 分页查看器开关：打开时快照 CommitEngine 全文，已打开则关闭。 */
  private toggleScrollPager(): void {
    const overlay = this.overlay
    const pager = this.scrollPager
    /* v8 ignore next 2 -- overlay/scrollPager 在 attach 时恒创建，null 仅类型收窄 */
    if (overlay === null || pager === null) return
    if (overlay.activeId() === 'scroll') overlay.deactivate()
    else {
      pager.setContent(this.commit.getContent())
      overlay.activate('scroll')
    }
  }

  /** P1：偏好原子落盘（禁用态 no-op；prefs 已就地变更）。 */
  private persistPrefs(): void {
    if (this.prefsPath === null) return
    writePrefs(this.prefsPath, this.prefs)
  }

  /** P1.5：提交文本进输入历史——内存（Ctrl+P/N 即时可用）+ 磁盘异步追加（重启恢复）。 */
  private pushHistory(trimmed: string): void {
    this.history = [trimmed, ...this.history.filter(h => h !== trimmed)].slice(0, MAX_INPUT_HISTORY)
    this.inputLine.setHistory(this.history)
    if (this.inputHistoryPath !== null) void appendInputHistory(this.inputHistoryPath, trimmed)
  }

  /** P1：应用主题并持久化（/theme 与 picker 确认共用的写透点；未知主题 no-op）。 */
  private applyThemeAndPersist(name: string): boolean {
    if (!setTheme(name)) return false
    this.prefs.theme = name
    this.persistPrefs()
    return true
  }

  /** /theme auto：探测明暗；persist 时才写 prefs。 */
  private async applyThemeAuto(persist = false): Promise<void> {
    const background = await detectTerminalBackground()
    setTheme(autoThemeFor(background))
    if (persist) {
      this.prefs.theme = 'auto'
      this.persistPrefs()
    }
    this.commitToScrollback({
      text: persist ? echoSavedDefault('theme', 'auto') : echoSessionOnly('theme', 'auto'),
      trailingNewline: true,
    })
  }

  /** P1：/theme export——委托 theme-custom（模板构建 + 就地注册属于主题域）。 */
  private exportTheme(nameArg?: string): string {
    return exportCurrentTheme(nameArg)
  }

  /** #31/#33：主题选择器（Enter 本会话 / S 写默认；↑↓ 预览，Esc 还原）。 */
  private openThemePicker(): void {
    openThemePicker({
      overlay: this.overlay,
      picker: this.picker,
      savedTheme: this.prefs.theme,
      applyDefault: (name) => { this.applyThemeAndPersist(name) },
      rerenderHistory: () => { this.rerenderHistory() },
      flushLiveRender: () => { this.flushLiveRender() },
      commit: (text) => { this.commitToScrollback({ text, trailingNewline: true }) },
    })
  }

  /** /effort 无参：推理等级选择器。 */
  private openEffortPicker(): void {
    const facet = (this.ctx as unknown as { agentDefaultModel?: ModelFacet }).agentDefaultModel
    const saved = facet?.currentSelection()
    const live = this.modelRef?.current ?? saved
    openEffortPicker({
      overlay: this.overlay, picker: this.picker,
      currentEffort: live?.reasoningEffort ?? 'auto',
      savedEffort: saved?.reasoningEffort ?? 'auto',
      apply: (level, persist) => {
        const base = persist ? saved : (live ?? saved)
        if (base === undefined) return
        const selection = effortSelection(base, level)
        if (persist) void facet?.saveSelection(selection)
        const hot = this.switchLiveModel(selection as ModelSelection)
        const text = persist
          ? (hot ? echoSavedDefault('effort', level) : `${echoSavedDefault('effort', level)}（当前会话不可热切）`)
          : (hot ? echoSessionOnly('effort', level) : `推理等级已设为 ${level}（当前会话不可热切）。选择器按 S 或 /effort default 可设为启动默认`)
        this.commitToScrollback({ text, trailingNewline: true })
      },
    })
  }

  /** #31：打开会话选择器（今天/昨天/本周/更早分组；当前 ● 高亮）。 */
  private async openSessionPicker(): Promise<void> {
    const overlay = this.overlay
    const picker = this.picker
    if (overlay === null || picker === null) return
    const rows = await listSessions(this.ctx)
    if (rows.length === 0) {
      this.echoWarn('⚠ 当前无会话，会话选择器不可用')
      return
    }
    const titled = []
    for (const row of rows) {
      const events = await loadHistory(this.ctx, row.id)
      titled.push({ id: row.id, createdAt: row.createdAt, title: sessionTitleFor(events) })
    }
    const { items, selectedIndex } = buildSessionPickerItems(titled, {
      now: Date.now(),
      ...(this.activeSessionId === null ? {} : { activeId: this.activeSessionId }),
    })
    picker.open('选择会话', items, (item) => {
      this.switchSessionGuarded(SessionId(item.value))
    }, selectedIndex)
    overlay.activate('picker')
  }

  /**
   * C3 项 3：执行回退。mode 决定范围：
   * - convo：仅截断会话（内存 + 持久化）
   * - code：仅文件回退（FileHistory.rewindToBoundary）
   * - both：两者
   * 持久化失败向上抛（RewindOverlay 显示错误）；文件快照缺失计入 filesSkipped。
   * @returns 文件变更数/缺口数与截断 seq。
   */
  private async executeRewind(mode: RewindMode, atSeq: number): Promise<RewindResult> {
    let filesChanged = 0
    let filesSkipped: number | undefined
    if (mode !== 'convo') {
      const r = await this.rewindFiles(atSeq)
      filesChanged = r.changed
      filesSkipped = r.skipped
    }
    const result: RewindResult = { filesChanged }
    // exactOptionalPropertyTypes：undefined 时省略字段（缺省 = 无缺口）
    if (filesSkipped !== undefined) result.filesSkipped = filesSkipped
    if (mode === 'convo' || mode === 'both') {
      await this.truncateSession(atSeq)
      result.truncatedTo = atSeq
    }
    return result
  }

  /** 文件回退：收集 atSeq 之后的写工具 callId，经 fs-snapshot FileHistory 恢复。 */
  private async rewindFiles(atSeq: number): Promise<{ changed: number; skipped: number }> {
    if (this.activeSessionId === null) return { changed: 0, skipped: 0 }
    const session = this.ctx.sessions.get(this.activeSessionId)
    if (session === undefined) return { changed: 0, skipped: 0 }
    // fs-snapshot 快照索引经 reflect 获取（tui 不静态依赖该包；未装配时 fail loud）
    const histories = this.ctx.reflect.get('fsSnapshot.histories', false) as
      | Map<string, { rewindToBoundary(ids: Set<string>): Promise<{ changed: string[]; skipped: number }> }> | undefined
    if (histories === undefined) {
      throw new Error('rewind 文件快照不可用（fs-snapshot 未装配）')
    }
    const fh = histories.get(this.activeSessionId)
    if (fh === undefined) return { changed: 0, skipped: 0 } // 该会话无快照记录（无写工具调用）
    // 边界后写工具 callId：扫事件日志中 seq > atSeq 的 tool/call
    const postBoundaryIds = new Set<string>()
    for (const e of session.snapshotEvents()) {
      if (e.seq <= atSeq) continue
      if (e.type === 'tool/call' && isWriteToolCall(e.data.name)) {
        postBoundaryIds.add(e.data.callId)
      }
    }
    const { changed, skipped } = await fh.rewindToBoundary(postBoundaryIds)
    return { changed: changed.length, skipped }
  }

  /**
   * 会话截断：先持久化后内存——truncateStored 失败时内存不动（状态一致、
   * 可重试），成功后再截内存态（同步纯内存操作，不抛错）。
   * 公开版 dsh-session 以 fork 派生代替内存截断，Session 无 truncate 能力
   * 时 fails loud（rewind 的 convo/both 模式在无截断能力的宿主上不可用）。
   * @param atSeq - 截断到的 seq（含）。
   */
  private async truncateSession(atSeq: number): Promise<void> {
    if (this.activeSessionId === null) return
    const persistence = this.ctx.reflect.get('sessionPersistence', false) as
      | { truncateStored(id: unknown, atSeq: number): Promise<void> } | undefined
    if (persistence !== undefined) {
      await persistence.truncateStored(this.activeSessionId, atSeq)
    }
    const session = this.ctx.sessions.get(this.activeSessionId)
    if (session === undefined) return
    const truncate = (session as { truncate?: (atSeq: number) => void }).truncate
    if (truncate === undefined) {
      throw new Error('会话截断不可用：宿主 dsh-session 不支持 truncate（rewind 请改用 fork 派生）')
    }
    truncate.call(session, atSeq)
  }

  /**
   * 切换到既有会话：卸载旧投影/控制面（并释放本层持有的旧 handle），
   * 再 agent-ensure 目标会话——registry 有 live agent 走 controlsFromRegistry 兜底
   * （非自有，不 dispose）；无则 resume 拿 handle（本层持有并 dispose）。
   * resume 的模型定路沿用会话持久化的 request header（跨重启续模），
   * 无 header（从未成功发起请求的会话）才落 agentDefaultModel 当前选择。
   * 恢复先于任何切换状态提交：目标不可恢复时在此抛错，应用停留在原会话（不进入半切换态）。
   * @param id - 目标会话 id；live 会话或可恢复的持久化会话。
   */
  async switchSession(id: SessionId): Promise<void> {
    const agent = this.ctx.agents.get(id)
    const persisted = agent === undefined ? getSession(this.ctx, id)?.requestHeader()?.config : undefined
    const selection = resumeModelSelection(persisted, () => this.ctx.agentDefaultModel.currentSelection())
    // C2 项 4：持有可变 ref（resume 续模的 selection 也进 ref.current）
    const ref: ModelSelectionRef = { current: selection, assembled: undefined }
    const handle = agent !== undefined
      ? undefined
      : await this.ctx.agents.resume({
        resumeSessionId: id,
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: async (agentCtx) => {
          installModelSelection(agentCtx, ref)
          const live = getSession(this.ctx, id)
          await joinResume(this.ctx, agentCtx, resolvePresetId(live?.header.agentPreset, live?.snapshotEvents()))
        },
      })
    // P3 side conversation：切走时保留旧会话 agent（keepHandle 让渡 registry；
    // 切回时走上方 agents.get 兜底分支——不 create 不 resume，transcript 重放）。
    await this.detachProjections({ keepHandle: true })
    this.dynamicRowsHighWater = 0
    this.activeSessionId = id
    if (agent !== undefined) {
      /* v8 ignore next -- agent 已确认存在（if 分支外），controlsFromRegistry 恒返回非空 */
      this.controls = controlsFromRegistry(this.ctx, id) ?? null
      // registry 兜底：ref 由其他装配方持有，本层不可热切
      this.modelRef = null
    } else if (handle !== undefined) {
      this.modelRef = ref
      this.ownedHandle = handle
      this.controls = controlsFromHandle(handle)
    }
    this.mountSession(id)
  }

  /** 按键面切换：失败回显 ⚠ 并停留原会话（rejection 不逃逸成 unhandled）。 */
  private switchSessionGuarded(id: SessionId): void {
    void this.switchSession(id).catch((error: unknown) => { this.echoWarn(`⚠ 会话切换失败: ${error instanceof Error ? error.message : String(error)}`, '/session 重新选择') })
  }

  /** 首次非空 todos 打开紧凑卡；关掉或 /clear 后本会话不再自动开。 */
  private tryAutoOpenTodos(items: TaskItem[] | null): void {
    if (!this.todosAutoArmed || items === null || items.length === 0) return
    this.todosPanelVisible = true
    this.todosAutoArmed = false
  }

  /**
   * 挂载当前会话的投影与控制面：transcript/live/controls 就位后，
   * 将已提交的历史渲染进 scrollback。
   * @param id - 目标会话 id（activeSessionId 已在调用方设置）。
   */
  private mountSession(id: SessionId): void {
    const session = getSession(this.ctx, id)
    if (session === undefined) throw new Error(`unknown session: ${id}`)
    // 投影层 fold 接线：turn 统计复位（live 事件驱动）；会话汇总从事件日志
    // 重放重建（summarizeSession 即 replay 入口），恢复会话的 /status 立即可用。
    this.turnSummary = emptyTurnSummary(0)
    this.sessionSummary = summarizeSession(id, session.snapshotEvents())
    this.transcript = createTranscript(this.ctx, session)
    this.liveAgent = trackAgent(this.ctx, id)
    // Phase 6.2：工作流阶段指示器接入生产消费端——订阅 agent/status + session/event，
    // 折叠结果经 onUpdate 触发重绘，renderLive 优先取 statusLine.current 作状态行。
    this.statusLine = new WorkflowStatusLine(this.ctx, id, () => { this.renderBatcher.schedule() })
    // Phase 5.3：glance metrics 行的 model 名随会话挂载快照（渲染不重复查询）。
    // 定路与 switchSession 同构：持久化 request header 优先，无 header 才落
    // agentDefaultModel 当前选择——渲染不引入额外的 currentSelection 读取。
    // 推理努力度同构：实际请求 header 优先（adapterDefaults 折叠后的生效值），
    // 无 header 才落当前默认选择；request/header 事件随后保持新鲜。
    // header 完整存在时零查询（持久化路由存在不读默认选择——路由测试断言）。
    const headerConfig = session.requestHeader()?.config
    if (headerConfig !== undefined) {
      this.glanceModelName = headerConfig.model
      this.glanceEffort = headerConfig.reasoningEffort ?? null
    } else {
      const selection = this.ctx.agentDefaultModel.currentSelection()
      this.glanceModelName = selection.model
      this.glanceEffort = selection.reasoningEffort ?? null
    }
    const visionSelection = headerConfig !== undefined
      ? { provider: headerConfig.provider, model: headerConfig.model }
      : this.ctx.agentDefaultModel.currentSelection()
    this.refreshVisionForSelection(visionSelection)
    // 上下文窗口：路由元数据折叠（request/context 只在路由变化时记录；热切换经
    // request/context 事件更新，见 handleStreamEvent）。
    this.contextWindow = session.requestContext()?.contextWindow ?? null
    // 流式提交供给：assistant text-delta 经 blockWriter 节流喂给 StreamRenderer
    // commit 进 scrollback（此前只构造未接线，回复只活在 live 区尾部、turn 结束即消失）。
    // 历史重放窗口内（任务5 渐进重放）新事件进 backlog 排队，重放完按序回放——
    // 否则新结算卡会插到尚未写完的旧历史前面，破坏 scrollback append-only 顺序。
    this.streamEventBacklog = []
    this.replayActive = false
    this.streamFeed = this.ctx.on('session/event', (owner: { id: SessionId }, event: SessionEvent) => {
      if (owner.id !== id) return
      if (this.replayActive) {
        this.streamEventBacklog.push(event)
        return
      }
      this.handleStreamEvent(event)
    })
    // T1.1：投影总线（5 域：todos/plan/goal/subagent/subagentTiming）——全量快照 +
    // onChanged 按 key 分流缓存。经 ctx.reflect.get 读取（Cordis 4 注入代理：
    // 属性访问未注册服务抛 "without inject"——真实装配已复现）；服务缺失时
    // 整体降级：任务窗格/status 面板在切换时回显警告（fails loud），plan 徽标不显示。
    this.inspect.hide('tasks')
    this.inspect.hide('status')
    this.todosPanelVisible = false
    this.todosAutoArmed = true
    this.taskItems = null
    this.planState = { active: false, pending: false }
    this.projectionCache = null
    const projections = this.ctx.reflect.get('sessionProjections', false) as ProjectionFacet | undefined
    if (projections !== undefined) {
      const snap = projections.snapshot(session)
      this.projectionCache = { ...snap.values }
      // 保留快照同源初始化（重放/重挂载时已写入的清单直接可见）。
      const snapTodos = snap.values.todos as TaskItem[] | null | undefined
      this.taskItems = snapTodos ?? null
      this.todosRetained = snapTodos ?? null
      this.tryAutoOpenTodos(this.todosRetained)
      const plan = snap.values.plan as PlanProjectionWire | undefined
      this.planState = { active: plan?.active ?? false, pending: plan?.pending ?? false }
      const statusLine = this.statusLine as WorkflowStatusLine | null
      statusLine?.setPlanState(this.planState)
      this.projectionDisposer = projections.onChanged((s, key, value) => {
        if (s.id !== id) {
          if (this.delegationSurface.handleForeignProjection(
            { sessionId: String(s.id), key, value },
            { panelVisible: this.subagentsPanelVisible, rootSessionId: id },
          )) this.renderBatcher.schedule()
          return
        }
        // 按 key 分流缓存（5 域总线）；todos/plan 有专有消费，其余域仅进缓存。
        /* v8 ignore next -- projectionCache 在快照后恒非 null（L766 赋值），null 仅类型收窄 */
        if (this.projectionCache !== null) {
          this.projectionCache[key as ProjectionKey] = value
        }
        if (key === 'todos') {
          const items = value as TaskItem[] | null
          this.taskItems = items
          // 黏滞保留快照：turn/start 会把 todos 投影 fold 重置为 null，面板
          // 若直接跟随投影每回合开头都会闪烁消失——只吸收非空值（null 不回
          // 退显示；黏滞语义见 todosRetained 字段注释）。
          if (items !== null) { this.todosRetained = items; this.tryAutoOpenTodos(items) }
          this.renderBatcher.schedule()
        } else if (key === 'plan') {
          const plan = value as PlanProjectionWire | null
          this.planState = { active: plan?.active ?? false, pending: plan?.pending ?? false }
          this.statusLine?.setPlanState(this.planState)
          this.renderBatcher.schedule()
        } else {
          // goal/subagent/subagentTiming：仅更新缓存（/status 面板渲染时读取）
          this.renderBatcher.schedule()
        }
      })
    }
    // 跨会话残留清理：推理缓冲、最近推理块与进行中卡标题缓存都是会话内状态。
    this.discardReasoning()
    this.lastReasoningBlock = null
    this.reasoningExpanded = false
    this.pendingCallTitles.clear()
    // 会话级授权（t 键工具白名单 + p 键命令前缀白名单）同为会话内状态——切换即复位。
    this.approval.clearSessionGrants()
    // 历史加载：重放会话事件日志（live store 为权威来源，persisted-only 走
    // loadHistory——见 adapter/sessions；此处 live store 已含全部事件）。
    // 工具卡走同一 presenter 桥（presenter 为 args 纯函数、桥软降级，replay 安全）。
    this.commitRows(this.renderHistoryRows())
    this.inputLine.setHistory(this.history)
    // T2.1：委派域订阅（树预取 + 对话流运行行；listDescendants 是 async——
    // 首次 await 入缓存，subagent/start|end 事件触发 re-await + renderLive 刷新）。
    // start/end 各注册两处 handler（树刷新 + 运行行），disposer 全部收集。
    this.subagentDisposer = this.delegationSurface.attach(id, (event, cb) => this.ctx.on(event, cb))
    // T2.2：workflow 事件订阅（start/phase/log/agent-start/agent-end/end → 缓存；
    // 跨会话运行，attach 订阅 dispose 释放）。六个 disposer 全部收集——
    // 只存 start 会让其余五个在每次挂载时泄漏。
    this.workflowDisposer = this.workflowSurface.attach((event, cb) => this.ctx.on(event, cb))
    // T2.3：后台任务同步快照 + 完成通知 + 控制面。
    this.taskDoneDisposer?.()
    this.taskSurfaceDisposer?.()
    this.taskSnapshots = []
    this.taskNotice = null
    // 切会话清空运行中排队：待发消息属于原会话上下文，不跨会话投递（行数回显）。
    if (this.submitQueue.size() > 0) {
      this.commitToScrollback({ text: `⚠ 切换会话：丢弃 ${this.submitQueue.size()} 条未发送的排队消息`, trailingNewline: true })
    }
    this.submitQueue.clear(); this.errorAnnouncer.reset()
    const tasks = this.ctx.reflect.get('tasks', false) as TasksFacet | undefined
    if (tasks !== undefined) {
      this.taskSnapshots = tasks.list()
      this.taskDoneDisposer = tasks.onTaskDone((snapshot) => {
        this.taskNotice = `✓ 任务完成: ${snapshot.label}`
        this.taskSnapshots = tasks.list()
        notifyOs({ title: 'dsh · 任务完成', body: snapshot.label }, this.prefs)
        writeBell(this.stdout, process.env, this.prefs)
        this.flushLiveRender()
      })
      this.taskSurfaceDisposer = tasks.attachSurface('tui')
    }
    this.flushLiveRender()
  }

  /** T3.2：刷新 /config 投影（宿主服务可缺；终端段始终带上）。 */
  private async refreshConfigProjection(): Promise<void> {
    const next = await loadConfigProjection({
      reflect: this.ctx.reflect,
      prefs: this.prefs,
      compactMode: this.compactMode,
      shouldAbort: () => this.disposed || !this.inspect.is('config'),
    })
    if (this.disposed || !this.inspect.is('config')) return
    this.configProjection = next
  }

  /** /config notify 与空输入 n：写 prefs 并刷新终端段。 */
  private applyNotifyPref(action: 'on' | 'off' | 'toggle', echo: (text: string) => void): void {
    const r = applyNotifyOsPref(this.prefs, action)
    if (r.warn !== undefined) this.echoWarn(r.warn)
    else { this.persistPrefs(); echo(r.echo as string) }
    if (this.configProjection !== null) {
      this.configProjection = { ...this.configProjection, tui: { ...configTuiFromPrefs(this.prefs), compactMode: this.compactMode } }
    }
    this.renderBatcher.schedule()
  }

  /** 回显警告行到 scrollback（fails-loud 提示共用出口）；hint 给 dim 色 `  ↳ ` 恢复指引尾随行。 */
  private echoWarn(text: string, hint?: string): void {
    this.commitToScrollback({ text: formatWarnWithHint(text, hint, this.theme), trailingNewline: true })
    this.flushLiveRender()
  }

  /** 当前主题（动态读取，切主题后立即生效）。 */
  private get theme(): RivetTheme { return getTheme() }

  /**
   * 统一 scrollback 写入委托（C4 第二波：实现已抽至 controllers/commit-surface——
   * 原子提交编舞 / overlay 暂存补写 / 用户气泡与图片链路，详见该模块 docstring）。
   * 全仓 ~28 个调用点保留本薄委托，签名不变。
   */
  private commitToScrollback(entry: { text: string; trailingNewline?: boolean }): void {
    this.commitSurface.text(entry)
  }

  /**
   * 提交用户输入：追加输入历史、将用户消息渲染进 scrollback、
   * 走 adapter.send 的 followup 驱动 agent。slash 命令（/steer）分流到 handleSteer。
   * @param text - 输入框提交的文本；空文本但无图时 no-op
   * @param images - 输入框携带的图片附件 data URL 列表（可省略）
   */
  handleSubmit(text: string, images?: string[]): void {
    // 入口先规范化图片数组：只保留合法 data URL，上限 MAX_IMAGES。
    images = normalizeSubmitImages(images)
    let trimmed = text.trim()
    const hasImages = images !== undefined && images.length > 0
    // 图片是否可达主控：识图主控直发；不识图但有视觉桥时经 agent/pre-step 转描述；
    // 两者皆无时图片不发送（气泡警告「图片未发送」）。桥状态优先取注入配置，
    // 未注入时按 visionBridge 服务存在性探测（见 resolveVisionBridge）。
    const imagesReachable = this.supportsVision || this.resolveVisionBridge()
    // 只发图片：可达时补占位 prompt，让后端能触发 run；不可达时无有效内容可发。
    if (!trimmed && hasImages) {
      if (imagesReachable) {
        text = '📎 图片消息'
        trimmed = text
      } else {
        // 有图但不可发送：只回显附件气泡+警告，不触发 followup。
        this.commitSurface.userPrompt('', images)
        this.inputLine.clearImages()
        this.flushLiveRender()
        return
      }
    }
    if (!trimmed) return
    // 任何 / 前缀输入都进命令通道……但以 / 开头的文件路径（/src/main.ts、
    // /tmp/foo bar、/etc 等非命令单段）不是命令——走普通文本流程，避免被
    // 当作未知 slash 命令报失败（参考本体 looksLikeFilePath；命令集取注册表
    // 现值——/lsp 等动态注册命令不误判为路径）。
    if (trimmed.startsWith('/') && !looksLikeFilePath(trimmed, n => this.isKnownCommand(n), n => this.isCommandPrefix(n))) {
      void this.runSlash(trimmed)
      return
    }
    // Phase 9a：@mention 用户侧摘要展开（cwd 边界/截断/降级见 mention-expand）。
    // 展开后的文本进用户消息与 followup——agent 看到的是摘要而非裸路径。
    const expanded = expandMentions(trimmed, this.sessionCwd())
    // #39：技能手势 MRU（slash 菜单下次打开技能条目排前）；提交路由不变——
    // /name 经 looksLikeFilePath 走文本流，host 的 pre-step 手势注入技能体。
    this.skillSurface.recordGesture(trimmed)
    this.pushHistory(trimmed)
    // 运行中排队（对标 CC）：本地队列让 ↑ 取回不惊动宿主（取舍见 submit-queue 模块头）；turn/end 按序投递。
    if (this.liveAgent?.state.status === 'running') {
      this.submitQueue.push(expanded, images)
      this.flushLiveRender()
      return
    }
    // 用户气泡：正文 + 📎 附件行 + 识图能力提示；有图且终端支持图形协议时
    // 异步 prepare 后在同一写窗口追加终端图片（时序说明见 commit-surface）。
    this.commitSurface.userPrompt(expanded, images)
    this.inputLine.clearImages(); this.errorAnnouncer.recordSubmitted(expanded)
    // 图片不可达时不发送（气泡已警告「图片未发送」）；可达时直发或经视觉桥转描述。
    // followup 异步（图片经 attachments 服务持久化后投递）；失败回显警告，不静默吞。
    void this.controls?.followup(expanded, imagesReachable ? images : undefined).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      // B1：投递失败回填（输入空时）——失败→改→重发闭环；echoWarn 语义由 announcer 承担
      this.errorAnnouncer.notifyDeliveryFailure(expanded, message, this.inputLine.value === '')
      this.flushLiveRender()
    })
    this.flushLiveRender()
  }

  /** turn/end → 本地队列按序投递（气泡 → followup）；aborted 不 flush——打断后可能想 ↑ 取回。 */
  private flushSubmitQueue(reason: 'completed' | 'aborted'): void {
    if (reason === 'aborted') return
    this.errorAnnouncer.clearSubmitted()
    const items = this.submitQueue.drain()
    for (const item of items) {
      this.commitSurface.userPrompt(item.text, item.images); this.errorAnnouncer.recordSubmitted(item.text)
      void this.controls?.followup(item.text, item.images).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        this.errorAnnouncer.notifyDeliveryFailure(item.text, message, this.inputLine.value === '', '排队消息发送失败')
        this.flushLiveRender()
      })
    }
    if (items.length > 0) this.flushLiveRender()
  }

  /**
   * 执行一条 slash 命令：注册表解析 → handler 运行 → 回显/错误提示。
   * 命令回显写 scrollback（用户可见），但不写回 session log（dsh 纪律：
   * 命令执行是 UI 层副作用，session 事件词汇不变）。
   * @param input - 输入行提交的原始文本（已 trim，以 / 开头）。
   */
  private async runSlash(input: string): Promise<void> {
    const echo = (text: string): void => {
      this.commitToScrollback({ text, trailingNewline: true })
    }
    const parsed = this.slash.resolve(input)
    if (parsed === null) {
      // A1：registry 未命中时 fallback 到 CommandService（cordis 命令通道）。
      // /plan 等由插件（plan-mode 等）注册在 CommandService 的命令由此可达，
      // 且 command/run 生命周期事件驱动 plan 投影的 pending 状态。
      // 经 reflect.get 读取：TuiApp 的 runtimeCtx 未 inject commands，属性访问
      // 在 Cordis 4 抛 "without inject"；服务未装配时返回 undefined → 降级。
      if (await this.runCordisCommand(input, echo)) {
        this.flushLiveRender()
        return
      }
      // 闭环引导：未知命令不刷 40+ 命令列表，给相近建议（编辑距离/公共前缀）；
      // 无相近命令时引导 /help，避免信息过载。
      const suggestions = suggestCommands(input, this.slash.list())
      const hint = suggestions.length > 0
        ? `你是要找: ${suggestions.map(c => `/${c.name}`).join(' ')}?`
        : '试试 /help 查看全部命令'
      echo(`未知命令: ${input}。${hint}`)
      this.flushLiveRender()
      return
    }
    try {
      await parsed.command.run({
        text: parsed.text,
        ctx: this.ctx,
        sessionId: this.activeSessionId,
        echo,
        /* v8 ignore next -- 内置命令 run 均不消费 rerender（死回调，无调用方） */
        rerender: () => { this.flushLiveRender() },
      })
      // 阶段 2：命令执行成功 → MRU 排序数据源（菜单下次打开最近使用优先）。
      this.inputController.recordSlashUse(parsed.command.name)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      echo(`⚠ 命令执行失败: ${message}`)
    }
    this.flushLiveRender()
  }

  /**
   * A1：把未命中的 slash 输入委托给 CommandService（cordis 命令通道）。
   * 无会话、commands 服务未装配、或命令未知名（execute 返回 undefined）时
   * 返回 false，由调用方维持「未知命令」回显；成功/失败回显在此完成。
   * @param input - 完整 slash 输入（含 / 前缀）。
   * @param echo - scrollback 回显回调。
   * @returns 命令是否被 CommandService 受理（true 时调用方不再回显未知命令）。
   */
  private async runCordisCommand(input: string, echo: (text: string) => void): Promise<boolean> {
    if (this.activeSessionId === null) return false
    const commands = this.ctx.reflect.get('commands', false) as CommandServiceFacet | undefined
    if (commands === undefined) return false
    const agent = this.ctx.agents.get(this.activeSessionId)
    if (agent === undefined) return false
    try {
      const execution = await commands.execute(agent, input, new AbortController().signal)
      if (execution === undefined) return false
      if (execution.result.kind === 'success') {
        echo(execution.result.text ?? '已执行')
      } else {
        echo(`⚠ 命令执行失败: ${execution.result.text}`)
      }
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      echo(`⚠ 命令执行失败: ${message}`)
      return true
    }
  }

  /**
   * 提交中轮转向：渲染差异化 steer 消息（marker/颜色区分 user）进 scrollback，
   * 走 adapter.send 的 steer API。空文本 no-op（/steer 无参数、Ctrl+T 空输入）。
   * @param text - 转向文本。
   */
  private handleSteer(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    this.pushHistory(trimmed)
    this.commitToScrollback({ text: formatSteerMessage({ content: trimmed, width: this.stdout.columns }, this.theme).join('\n'), trailingNewline: true })
    this.controls?.steer(trimmed)
    this.flushLiveRender()
  }

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
  private handleApprovalRequest(
    req: PendingApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    return this.approval.handle(req, next)
  }

  /** 取消当前运行（Esc/Ctrl+C）：cancel agent（keepInbox——宿主 inbox 未消费的 steer/排队残留保留）、丢弃未发出的流式/推理缓冲并重置流渲染。 */
  /** 最近一次 Ctrl+C 字节（0x03）处理时间戳；0 = 未处理过（SIGINT 防抖用）。 */
  private lastCtrlCAt = 0
  /** 最近一次 handleAbort 时间戳；0 = 未打断过（双击 Esc rewind 的 grace 守卫数据源）。 */
  private lastAbortAt = 0

  /**
   * Windows 双触发防护：最近 800ms 内 Ctrl+C 字节（0x03）已处理（打断/退出）时，
   * 紧随的 SIGINT 应被忽略——否则刚打断的 TUI 被 teardown 拆掉（输入框消失、
   * 进程存活）。装配层（index.ts）的 SIGINT handler 先查此门再决定是否退出。
   * @param now - 当前时间戳（注入便于测试）。
   * @returns true = SIGINT 应忽略（0x03 刚处理过）。
   */
  shouldDeferSigint(now: number): boolean {
    return now - this.lastCtrlCAt < 800
  }

  /** slash 注册表当前命令名集合（现取——/lsp 等动态注册命令不误判为路径）。 */
  private isKnownCommand(name: string): boolean {
    return this.slash.list().some(c => c.name === name)
  }

  /** name 是否为某个已注册命令的前缀（/h → help；模糊输入仍视为命令）。 */
  private isCommandPrefix(name: string): boolean {
    return this.slash.list().some(c => c.name.startsWith(name))
  }

  handleAbort(): void {
    // grace 守卫数据源：打断在途后 isRunning 异步落定，落定后一个双击窗口内
    // Esc 不布防/触发 rewind（when 经 inAbortGrace 判定）；已布防的随之撤防
    //（对齐 inspect.close 的 disarm）。
    this.lastAbortAt = Date.now()
    this.actions.confirmDisarm('session.rewind')
    // 防御：打断优先于 overlay——释放激活的全屏 overlay（palette/search/rewind/picker），
    // 保证主屏（含输入轨）下一帧必然恢复（覆盖未来新增路径在 overlay 激活时调 abort）。
    this.overlay?.deactivate()
    this.palette?.close()
    this.picker?.close()
    // keepInbox：手动打断不清宿主 inbox——未消费的 steer/排队残留留到下一轮（与本地队列不清队一致）。
    this.controls?.cancel({ kind: 'user' }, { keepInbox: true })
    // 先丢弃流式残文再提交中止提示：提交编舞会同步重绘一帧，残尾若还留在
    // peek/pending 里就会把上一个 run 的残留画进那一帧（提交与丢弃的次序
    // 曾被延迟重绘掩盖，同步化后必须理顺）。
    this.blockWriter.discard()
    this.streamRenderer.reset()
    this.discardReasoning()
    this.pendingCallTitles.clear()
    this.commitToScrollback({ text: '⏹ 已取消', trailingNewline: true })
    this.flushLiveRender()
  }

  /**
   * Phase 6.4：打开外部编辑器编辑当前输入行。编辑器是外部进程，必须暂时退出
   * raw-mode（spawnSync 阻塞期间 ticker 暂停），任何路径（含失败）都恢复。编辑结果回填输入行。
   */
  private openExternalEditor(): void {
    // 编辑器接管终端前退出 raw-mode；spawn 结束（含失败）恢复。
    try { this.stdin.setRawMode(false) } catch { /* best-effort：非 TTY 无 raw-mode */ }
    let content: string | null = null
    let editorError: string | null = null
    try {
      const r = openInEditorDetailed(this.inputLine.value, this.editorCommand)
      content = r.content
      editorError = r.error
    } finally {
      try { this.stdin.setRawMode(true) } catch { /* best-effort */ }
    }
    if (content !== null) {
      this.inputLine.setValue(content)
    } else if (editorError !== null) {
      // P1-1：编辑器启动失败不再静默——回显实际生效命令与 spawn 原因
      this.echoWarn(`⚠ 外部编辑器启动失败（${this.editorCommand ?? getEditorCommand()}）：${editorError}`)
    }
    this.flushLiveRender()
  }

  /**
   * Tab 补全（Phase 6.3）：委托 InputController 状态机——首次 Tab 解析
   * 光标前 @ 路径 token 的候选并应用首项，再次 Tab 循环。无 @ token 时
   * 返回 false，Tab 保持原行为（InputLine 照常发出 'tab' 事件）。
   */
  private handleTabComplete(): boolean {
    const result = this.inputController.tabComplete(
      this.inputLine.value,
      this.inputLine.cursor,
      this.sessionCwd(),
    )
    if (result === null) return false
    this.inputLine.setValue(result.text, result.cursor)
    this.flushLiveRender()
    return true
  }

  /** 把 slash 注册表投影到 InputController（菜单 / Tab 补全数据源）。
   * 注册表可被外部插件经 tui.commands 服务在构造后扩展（回流 tianshu
   * bc5cec1359：bundle 行序使插件 apply 晚于 TUI 构造），故每次输入变化前
   * 重投影一次；#39 技能条目由 skillSurface 缓存合并，重投影不会丢。
   * 列表很小，成本可忽略。
   */
  private syncSlashHints(): void {
    this.skillSurface.refreshEntries()
  }

  /** slash ghost 预览：菜单选中命令补全剩余（/th→eme）；完整命令名+尾空格 → 参数占位。
   *  菜单关闭/光标不在末尾/无补全关系 → null。 */
  private slashGhostText(): string | null {
    const menu = this.inputController.slashMenu
    if (!menu.open) return null
    const selected = menu.matches[menu.selected]
    if (selected === undefined) return null
    const value = this.inputLine.value
    if (this.inputLine.cursor !== value.length || value === '') return null
    const name = `/${selected.name}`
    if (value === `${name} ` && selected.argsHint !== undefined) return selected.argsHint
    if (value === name) return null
    if (name.startsWith(value)) return name.slice(value.length)
    return null
  }

  /** fish 式历史建议 ghost：prefs 关 / `/` 开头 / 光标不在末尾 / 有选区 / vim normal → null。 */
  private historyGhostText(): string | null {
    const value = this.inputLine.value
    if (this.prefs.ghostSuggest === false || value.startsWith('/')) return null
    if (this.inputLine.cursor !== value.length || this.inputLine.selectionRange !== null) return null
    if (this.inputLine.vimEnabled && this.inputLine.vimMode === 'normal') return null
    return historyGhostSuffix(this.history, value)
  }

  /** 接受 slash 菜单当前选中项（Tab / Enter）：Enter 且输入已是完整命令名 →
   *  关菜单直接提交（opts.submit）；否则补全命令名（有 argsHint 补到 `cmd `
   *  留参数位，参数建议留待下一批）后关菜单。 */
  private acceptSlashCompletion(opts?: { submit?: boolean }): void {
    const menu = this.inputController.slashMenu
    const selected = menu.matches[menu.selected]
    if (selected === undefined) {
      this.inputController.closeSlash()
      this.flushLiveRender()
      return
    }
    const name = `/${selected.name}`
    const current = this.inputLine.value
    // 参数模式（`/cmd ` 尾空格）：Enter 提交完整输入行（trim 由 handleSubmit 承担）。
    if (opts?.submit === true && (current === name || current === `${name} `)) {
      this.inputController.closeSlash()
      // 清空输入行（对齐 InputLine 正常提交路径的 clearAfterSubmit；否则
      // 命令文本残留，后续键入会拼出 /cmd/xxx 无效命令）。
      this.inputLine.setValue('')
      this.handleSubmit(current)
      return
    }
    // setValue 触发 onChange → refreshSlash 会重开菜单；此处随后关闭收敛。
    this.inputLine.setValue(selected.argsHint !== undefined ? `${name} ` : name)
    this.inputController.closeSlash()
    this.flushLiveRender()
  }

  /**
   * C3 项 4：Shift+Tab 三态循环（对齐 grok 的两轴模型，plan 与 permission 正交）：
   * Normal → Plan（planMode.set(true)）→ Always-Approve（plan off + 本地短路）→ Normal。
   * plan 切换经 planMode 服务（投影总线驱动 planState 徽标）；always-approve 是
   * 纯 TUI 本地标志（不持久化，退出即失），对审批 answerer 短路放行。
   * alwaysApprove 优先判断：它是同步本地态；planState 经投影异步更新，
   * 若按投影判断会在 Always-Approve 态误走回 Plan 分支。
   */
  private cycleMode(): void {
    if (this.approval.alwaysApprove) {
      // Always-Approve → Normal
      this.approval.setAlwaysApprove(false)
      this.statusLine?.setAlwaysApprove(false)
      this.flushLiveRender()
    } else if (this.planState.active) {
      // Plan → Always-Approve
      this.setPlanMode(false)
      this.approval.setAlwaysApprove(true)
      this.statusLine?.setAlwaysApprove(true)
      this.flushLiveRender()
    } else {
      // Normal → Plan
      this.setPlanMode(true)
    }
  }

  /**
   * /yolo：全放行模式快捷入口（approval always-approve 的显式开关）。
   * 与 Shift+Tab 循环进 always-approve 同语义（allowed-once 短路），但提供
   * 命令入口；退出会话时 app 侧复位逻辑（setAlwaysApprove(false)）同样覆盖。
   * @param flag - true 开启全放行（后续审批自动放行）；false 关闭。
   */
  private setYoloMode(flag: boolean): void {
    this.approval.setAlwaysApprove(flag)
    this.statusLine?.setAlwaysApprove(flag)
    this.flushLiveRender()
  }

  /** C3 项 4：经 planMode 服务切换 plan 状态（服务缺失时回显警告，不再静默）。 */
  private setPlanMode(active: boolean): void {
    const planMode = scopedService(this.ctx, this.activeSessionId, 'planMode') as
      | { set(agent: unknown, active: boolean): string } | undefined
    if (planMode === undefined) {
      // 只在进入 plan 时提示（退出分支由 Always-Approve 本地态驱动，无需服务）。
      if (active) this.echoWarn('⚠ planMode 服务不可用（未装配 plan 插件），无法进入 plan 模式', '/doctor 体检')
      return
    }
    if (this.activeSessionId === null) return
    const agent = this.ctx.agents.get(this.activeSessionId)
    if (agent === undefined) return
    planMode.set(agent, active)
    // 任务4b 本地兜底：服务切换成功即乐观更新徽标——planState 原本只读投影
    // 总线，宿主未装配 sessionProjections 时 Shift+Tab 进出 plan 徽标纹丝不动。
    // 总线在场时随后的 plan 投影回调会用权威值覆盖（pending 未知则保持现值）。
    this.planState = { active, pending: this.planState.pending }
    this.statusLine?.setPlanState(this.planState)
    this.renderBatcher.schedule()
  }

  /** /key：Ctrl+V 读剪贴板文本进 Key 字段（空文本忽略；readTextFromClipboard 平台缺失时返回 null）。 */
  private async pasteClipboardIntoKeyDialog(dialog: KeyDialogController): Promise<void> {
    const text = await readTextFromClipboard()
    if (text === undefined || text === null || text === '') return
    dialog.pasteText(text)
    this.overlay?.rerender()
  }

  /** /update：对照 npm latest 的只查不装检查（用户看到提示后手动更新；失败不抛）。 */
  private async runUpdateCheck(): Promise<UpdateCheckResult> {
    return runUpdateCheck({ cachePath: defaultUpdateCachePath() })
  }

  /**
   * 键路由（统一 action registry）：布防清扫 → 早段全局动作（overlay 之前——
   * shift_tab/ctrl_n 等在面板打开时先生效）→ overlay 委派 → 阻塞上下文轮询
   * （question > btw > approval）→ 主段动作（esc/ctrl_c/ctrl_o/editorKey/
   * ctrl_t/ctrl_v）→ slash 菜单 → inspect 上下文键 → 尾段动作 → InputLine 兜底。
   */
  private handleKey(key: KeyPress): void {
    // 双击布防清扫：非某 confirmMs 动作触发键的键到达即撤防（对齐原
    // ctrlCPendingSince/escRewindPendingSince 两处的「非同键打断」清理）。
    this.actions.sweepConfirms(key)
    const ctx = this.actionCtx
    const early = this.actions.match(key, ctx, { phase: 'early', context: 'global' })
    if (early !== null && early.run(ctx, key) !== false) return
    // overlay 独占焦点（key-dialog/picker/search/scroll/rewind/memory/palette）。
    if (this.overlayRouter.route(key)) return
    // 阻塞态轮询：挂起交互独占键盘（T3.1 提问 → P1 侧问 → Phase 8 审批）。
    for (const blocking of this.blockingKeys) {
      if (blocking.isActive() && blocking.handleKey(key)) return
    }
    const main = this.actions.match(key, ctx, { phase: 'main', context: 'global' })
    if (main !== null && main.run(ctx, key) !== false) return
    // slash 命令菜单打开：导航/接受/关闭键（轮询位置保持：主段动作之后）。
    if (this.menuKeys.isActive() && this.menuKeys.handleKey(key)) return
    // inspect 上下文键（/config n 通知、d 密度；/skills j/k 移动选中）。
    if (this.inspectKeys.isActive() && this.inspectKeys.handleKey(key)) return
    const tail = this.actions.match(key, ctx, { phase: 'tail', context: 'global' })
    if (tail !== null && tail.run(ctx, key) !== false) return
    const event = this.inputLine.handleKey(key.name, key.char, key.ctrl, key.meta, key.shift, key.inline === true)
    // 选区剪切/复制的 OSC52 drain：Ctrl+K 剪切 / Alt+W 复制写系统剪贴板
    // （终端支持 OSC52 时生效，不支持者无害忽略）。vim yank（p/P、Alt+Y）走
    // 内部剪贴板，不经此通道。
    const clip = this.inputLine.takeClipboardOut()
    if (clip != null) {
      // P1-1：终端不支持 OSC52 时每进程首次提示一次；序列仍写出（保持无害忽略降级）
      if (!supportsOsc52() && !this.osc52WarningShown) {
        this.osc52WarningShown = true
        this.echoWarn('⚠ 终端不支持 OSC52 复制（Ctrl+K/Alt+W 无法写入系统剪贴板，请用终端原生复制）')
      }
      this.stdout.write(osc52Clipboard(clip))
    }
    if (event !== null) this.flushLiveRender()
  }

  /** A5：最后一张进行中工具卡（空输入 Enter 展开目标）；无则 undefined。 */
  private latestPendingToolCall(): TranscriptToolCall | undefined {
    const pending = this.transcript?.view.tools.filter(t => t.result === undefined) ?? []
    return pending[pending.length - 1]
  }

  /** 动作执行上下文门面（ActionContext）：when/run 只经此触达本类私有方法
   *  （registry 不 import 本类）；confirmMs 原语转发 registry 布防状态。 */
  private createActionContext(): ActionContext {
    return {
      hasExit: this.onExit !== undefined,
      isRunning: () => this.liveAgent?.state.status === 'running',
      inputEmpty: () => this.inputLine.value === '',
      slashMenuOpen: () => this.inputController.slashMenu.open,
      inspectAny: () => this.inspect.any(),
      vimNormalEsc: () => this.inputLine.vimEnabled && this.inputLine.vimMode === 'normal',
      inAbortGrace: (now) => now - this.lastAbortAt < REWIND_DOUBLE_ESC_MS,
      hasReasoning: () => this.reasoningText !== '' || this.lastReasoningBlock !== null,
      hasPendingToolCard: () => this.latestPendingToolCall() !== undefined,
      hasImages: () => this.inputLine.images.length > 0,
      hasQueuedSubmits: () => this.submitQueue.size() > 0,
      paletteOpen: () => this.palette?.isOpen() === true,
      approvalPending: () => this.approval.isPending,
      confirmArm: (id, now) => { this.actions.confirmArm(id, now) },
      confirmWithin: (id, now) => this.actions.confirmWithin(id, now),
      confirmDisarm: (id) => { this.actions.confirmDisarm(id) },
      cycleMode: () => { this.cycleMode() },
      newSession: () => { void this.newSession() },
      restoreRecentSession: () => { void this.restoreRecentOtherSession() },
      requestExit: () => { this.onExit?.() },
      // Ctrl+P 命令面板开关（再按一次关闭）。
      togglePalette: () => {
        const palette = this.palette
        const overlay = this.overlay
        /* v8 ignore next 3 -- palette/overlay 在 attach 时恒创建（键路由仅 attach 后可达），null 仅类型收窄 */
        if (palette !== null && overlay !== null) {
          if (palette.isOpen()) {
            palette.close()
            overlay.deactivate()
          } else {
            palette.open()
            overlay.activate('command-palette')
          }
        }
      },
      // 空输入框 Tab → 命令菜单（palette execute 模式，#31 参考 Claude Code）。
      openPaletteMenu: () => {
        const palette = this.palette
        const overlay = this.overlay
        /* v8 ignore next 3 -- palette/overlay 在 attach 时恒创建，null 仅类型收窄 */
        if (palette !== null && overlay !== null) {
          palette.open(true)
          overlay.activate('command-palette')
          this.flushLiveRender()
        }
      },
      // Ctrl+. 快捷键面板开关（grok-build 同款键位清单；再按一次关闭）。
      toggleKeymap: () => {
        const overlay = this.overlay
        /* v8 ignore next 2 -- overlay 在 attach 时恒创建，null 仅类型收窄 */
        if (overlay !== null) {
          if (overlay.activeId() === 'keymap') overlay.deactivate()
          else overlay.activate('keymap')
        }
      },
      toggleHistorySearch: () => { this.toggleHistorySearchOverlay() },
      toggleLatestToolCard: () => {
        const latest = this.latestPendingToolCall()
        /* v8 ignore next -- when 守卫（hasPendingToolCard）已保证有进行中工具卡；防御 */
        if (latest === undefined) return
        this.expandedToolCallId = this.expandedToolCallId === latest.callId ? null : latest.callId
        this.flushLiveRender()
      },
      abort: () => { this.handleAbort() },
      inspectClose: () => { this.inspect.dispatch({ type: 'close' }) },
      rewindSession: () => { this.rewindSession() },
      toggleReasoning: () => {
        this.reasoningExpanded = !this.reasoningExpanded
        this.renderBatcher.schedule()
      },
      openExternalEditor: () => { this.openExternalEditor() },
      steerInput: () => {
        const text = this.inputLine.value.trim()
        if (text !== '') {
          this.inputLine.setValue('')
          this.handleSteer(text)
        }
      },
      cancelAndSend: () => {
        cancelAndSendInput({ input: this.inputLine, controls: this.controls ?? undefined, abort: () => { this.handleAbort() }, submit: (t, i) => { this.handleSubmit(t, i) } })
      },
      pasteClipboard: () => { void this.handleCtrlV() },
      removeLastImage: () => {
        this.inputLine.removeImage(this.inputLine.images.length - 1)
        this.flushLiveRender()
      },
      recallQueuedSubmit: () => {
        const first = this.submitQueue.takeFirst()
        if (first !== undefined) this.inputLine.setValue(first.text, first.text.length)
        this.flushLiveRender()
      },
      ghostAcceptable: () => this.historyGhostText() !== null,
      acceptGhost: () => {
        const ghost = this.historyGhostText()
        if (ghost !== null) { this.inputLine.append(ghost); this.flushLiveRender() }
      },
      passHistoryKey: (key) => {
        this.inputLine.handleKey(key.name, key.char, key.ctrl, key.meta, key.shift, key.inline === true)
        this.flushLiveRender()
      },
      clearInput: () => { this.inputLine.setValue('') },
      markCtrlC: (now) => { this.lastCtrlCAt = now },
      flushLive: () => { this.flushLiveRender() },
      settleApproval: (outcome) => { this.approval.settle(outcome) },
      approveAlways: () => {
        this.approval.setAlwaysApprove(true)
        this.statusLine?.setAlwaysApprove(true)
        this.approval.settle('allowed-once')
      },
      approveToolSession: () => { this.approval.approveWithTool() },
      approvalCommandPrefix: () => this.approval.pendingCommandPrefix,
      approveCommandPrefix: () => { this.approval.approveWithPrefix() },
      startApprovalFeedback: () => {
        this.approval.setFeedbackMode(true); this.inputLine.setValue(''); this.flushLiveRender()
      },
    }
  }

  /**
   * Phase 5.3：glance 一行条的可得数据。model（request header 优先、
   * agentDefaultModel 兜底）、effort（同构）、缓存命中率与上下文占比
   * （最后一条 assistant/message 的 usage 折叠）、上下文窗口
   * （request/context 折叠）、turn 数、本轮耗时。任何数据缺失 → 对应段
   * 省略（glance 段组装按可得段渲染，窄宽渐进 drop）。
   * 无可渲染数据返回 null（不占位）。
   */
  private glanceMetrics(): FormatGlanceBarInput | null {
    // C4：投影逻辑提取至 format/glance-metrics（时间注入；此处只喂缓存字段）。
    const view = this.transcript?.view
    const preset = livePresetShort(this.ctx, this.activeSessionId)
    const built = buildGlanceMetrics({
      transcript: view === undefined ? undefined : { turn: view.turn, firstInTurnTime: view.firstInTurnTime },
      modelName: this.glanceModelName,
      effort: this.glanceEffort,
      usage: this.usageFold,
      contextWindow: this.contextWindow,
      columns: this.stdout.columns,
      preset: preset ?? null,
    })
    if (built !== null || preset === undefined) return built
    return { width: this.stdout.columns, preset }
  }

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
  private commitRows(rows: readonly RenderedRow[]): void {
    if (rows.length === 0) return
    const epoch = ++this.replayEpoch
    const texts = rows.map(r => r.ansi)
    const firstTo = Math.min(REPLAY_CHUNK_ROWS, texts.length)
    this.commitToScrollback({ text: texts.slice(0, firstTo).join('\n'), trailingNewline: true })
    let i = firstTo
    if (i >= texts.length) return
    this.replayActive = true
    const step = (): void => {
      if (this.disposed || epoch !== this.replayEpoch) {
        this.replayActive = false
        this.streamEventBacklog = []
        return
      }
      const to = Math.min(i + REPLAY_CHUNK_ROWS, texts.length)
      this.commitToScrollback({ text: texts.slice(i, to).join('\n'), trailingNewline: true })
      i = to
      if (i < texts.length) {
        setImmediate(step)
        return
      }
      // 最后一片落底：结束重放窗口，按序回放排队期间的新流事件（turn 统计
      // 与会话汇总 fold 随 handleStreamEvent 一并补齐）。
      this.replayActive = false
      const backlog = this.streamEventBacklog
      this.streamEventBacklog = []
      for (const event of backlog) this.handleStreamEvent(event)
    }
    setImmediate(step)
  }

  /** 当前主题变化后，清理终端并用最新颜色重放当前会话历史。 */
  private rerenderHistory(): void {
    if (this.disposed || (this.overlay !== null && this.overlay.activeId() !== null)) return
    // 主题切换重建屏幕期间，不得把此前已折叠的 live 推理块带回全文展开态。
    this.reasoningExpanded = false
    this.commit.reset()
    this.live.reset()
    this.stdout.write(`${ANSI.ERASE_SCREEN}\x1b[3J\x1b[H`)
    this.commitRows(this.renderHistoryRows())
    this.flushLiveRender()
  }

  /** 生成当前会话历史消息的主题化渲染行。 */
  private renderHistoryRows(): RenderedRow[] {
    const transcript = this.transcript
    if (transcript === null) return []
    return renderTranscript(transcript.view, this.theme, this.stdout.columns, {
      compact: this.compactMode,
      resolveViews: (tool: TranscriptToolCall) => resolveToolViews(this.toolPresenters(), {
        name: tool.name,
        argumentsRaw: tool.arguments,
        ...(tool.result === undefined ? {} : {
          result: {
            content: tool.result.data.message.content[0].content,
            isError: toolResultText(tool.result).isError,
            ...(tool.result.data.meta === undefined ? {} : { meta: tool.result.data.meta }),
          },
        }),
      }),
    })
  }

  /**
   * 流式事件供给：assistant text-delta 推进 blockWriter（节流切块，稳定前缀
   * commit 进 scrollback）；message/turn 边界 flush + finalize 收尾。aborted
   * turn 的残文由 handleAbort discard/reset，不在此 commit。
   * @param event - 当前会话的 session/event（订阅处已按会话过滤）。
   */
  private handleStreamEvent(event: SessionEvent): void {
    // 投影层 fold（turn 统计 + 会话汇总）：先于 switch 折叠每条事件——fold 内部
    // 对无关事件原样返回，代价可忽略；两模型只读事件，不写回任何状态。
    this.turnSummary = applyTurnEvent(this.turnSummary, event)
    this.sessionSummary = applySummaryEvent(this.sessionSummary, event)
    switch (event.type) {
      case 'assistant/attempt': {
        // 0.1.5：text/reasoning delta 批量打包进 attempt（压缩流记录展开）
        for (const { time: chunkTime, chunk } of expandAssistantStream(event.data.stream)) {
          if (chunk.type === 'text-delta') {
            // 正文开始即推理段结束点：先整块落底（此刻 blockWriter 必为空——
            // 推理段先于本 step 一切 text-delta，顺序天然安全）。
            this.commitReasoningBlock()
            this.blockWriter.push(chunk.text)
          } else if (chunk.type === 'reasoning-delta') {
            if (this.reasoningText === '') this.reasoningStartedAt = chunkTime
            this.reasoningText += chunk.text
            this.renderBatcher.schedule()
          }
        }
        break
      }
      case 'assistant/message': {
        // reasoning-only step（无 text-delta 的推理段）在消息组装点落底。
        this.commitReasoningBlock()
        // 最后一次请求的 token 计量（缓存命中率/上下文占比数据源；适配器未报
        // usage 时保持上一次折叠——同一会话内后续段仍可用）。
        if (event.data.usage !== undefined) {
          this.usageFold = event.data.usage
          // /cost 会话累计：按最近一次 request/header 的模型分桶累加。
          const model = this.glanceModelName ?? 'unknown'
          this.sessionCosts.set(model, accumulateUsage(this.sessionCosts.get(model), event.data.usage, model))
        }
        void this.flushStream()
        break
      }
      case 'request/header':
        // effort / 模型名随实际请求更新（header 记录 adapterDefaults 折叠后的生效值）。
        this.glanceEffort = event.data.header.config.reasoningEffort ?? null
        this.glanceModelName = event.data.header.config.model
        break
      case 'request/context':
        this.contextWindow = event.data.contextWindow ?? null
        break
      case 'tool/call': {
        // 推理后直接发工具（无正文 step）的段边界。
        this.commitReasoningBlock()
        // live 进行中卡标题接 presentCall（意图缺省回落 toolArgSummary 启发式）。
        const { call } = resolveToolViews(this.toolPresenters(), {
          name: event.data.name,
          argumentsRaw: event.data.arguments,
        })
        if (call !== undefined) this.pendingCallTitles.set(event.data.callId, call.title)
        // LSP：agent 触碰文件 → 异步拉取该文件诊断（本地展示缓存，纯只读）。
        this.touchLspPaths(event.data.arguments)
        // Phase 9d：工具开始 → 阶段推进（静默计时从工具起算）
        this.fluency.setPhase('tool')
        break
      }
      case 'tool/result': {
        // Phase 9d：工具结果 → 追踪 routine 链 / 输出速率 / 错误信号。
        // resultLength 取结果消息文本长度（tool-result 块内 text 折叠）。
        const { message, error } = event.data
        const resultBlock = message.content[0]
        const resultLength = resultBlock.content.reduce(
          (acc, block) => acc + (block.type === 'text' ? block.text.length : 0),
          0,
        )
        const callId = message.source.callId
        const name = this.transcript?.view.tools.findLast(t => t.callId === callId)?.name ?? 'tool'
        this.fluency.recordToolResult({
          name,
          isError: error !== undefined || resultBlock.isError === true,
          resultLength,
        })
        this.pendingCallTitles.delete(callId)
        this.commitSettledToolCard(event)
        break
      }
      case 'turn/start':
        // A5：回合开始 → 标记请求在途，静默提示生效（turn/end 由 onTurnComplete 复位）。
        this.fluency.onTurnStart()
        break
      case 'turn/end': {
        // Phase 9d：turn 边界复位流利度信号
        this.fluency.onTurnComplete()
        // 运行中排队 → turn 边界按序投递（中止轮不 flush，见 flushSubmitQueue）。
        this.flushSubmitQueue(event.data.reason.kind === 'aborted' ? 'aborted' : 'completed')
        // A3：回合边界刷新 git 未提交计数（footer ●N；不逐帧 spawn）。
        this.gitDirty = gitDirtyCount()
        // A5：回合结束复位工具卡展开态（工具已结算，展开无意义）。
        this.expandedToolCallId = null
        if (event.data.reason.kind !== 'aborted') {
          // 错误终止的 turn 可能没有 assistant/message——落底已累积的推理
          //（durable log 已含这些 chunk，与「模型可见 ⟺ 已记录」一致）。
          this.commitReasoningBlock()
          // 投影层：turn 摘要行接在流式收尾之后（flushStream 异步吐尽节流缓冲，
          // 同步 commit 会抢在正文尾巴前）。内容快照此刻取定；回调只认未
          // dispose 且仍在同一会话（切会话后旧 turn 的行不写进新会话视图）。
          const summary = this.turnSummary
          const sid = this.activeSessionId
          if (summary.toolCount > 0) {
            void this.flushStream().then(() => {
              if (this.disposed || this.activeSessionId !== sid) return
              // 轮号取事件的权威值而非 fold 状态：中途挂载运行中会话（错过了
              // 本turn的 turn/start）时 summary.turn 仍是初值 0，会误显 turn 0。
              this.commitTurnSummaryLine(summary, event.data.turn)
            })
          } else {
            void this.flushStream()
          }
        } else {
          this.discardReasoning()
        }
        this.pendingCallTitles.clear()
        break
      }
      default:
        break
    }
  }

  /** tools 服务的 presenter 面（可选服务：未装配返回 undefined → 桥软降级）。 */
  private toolPresenters(): ToolPresenterSource | undefined {
    return this.ctx.reflect.get('tools', false) as ToolPresenterSource | undefined
  }

  /**
   * 结算工具卡实时提交：从 transcript 查配对 call 的 name/arguments →
   * presenter 桥 → 卡片渲染 → 串行在流式文本 flush 之后 commit 进
   * scrollback（保证「文本 → 卡」的事件序）。配对缺失（截断/rewind 边界）
   * 无卡可渲染，静默跳过。
   */
  private commitSettledToolCard(event: SessionEvent<'tool/result'>): void {
    const callId = event.data.message.source.callId
    const tool = this.transcript?.view.tools.findLast(t => t.callId === callId)
    if (tool === undefined) return
    const { content, isError } = toolResultText(event)
    const views = resolveToolViews(this.toolPresenters(), {
      name: tool.name,
      argumentsRaw: tool.arguments,
      result: {
        content: event.data.message.content[0].content,
        isError,
        ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
      },
    })
    const rows = formatToolViewCard({
      toolName: tool.name,
      argumentsRaw: tool.arguments,
      content,
      isError,
      ...(views.call === undefined ? {} : { callView: views.call }),
      ...(views.result === undefined ? {} : { resultView: views.result }),
      elapsedMs: Math.max(0, event.time - tool.time),
      compact: this.compactMode,
    }, this.theme)
    // 串行链：先吐尽本 step 的流式文本（flushStream 幂等），卡片紧随其后
    // ——live 区进行中卡的消失与 scrollback 结算卡的出现衔接为一次提交。
    void this.flushStream().then(() => {
      if (this.disposed) return
      this.commitToScrollback({ text: rows.join('\n'), trailingNewline: true })
      this.renderBatcher.schedule()
    })
  }

  /**
   * 推理段落底：静态 `✻ 思考 (Ns) · N 行` 折叠头行（对标竞品默认折叠——
   * 正文经 Ctrl+O 展开查看）整块 commit 进 scrollback，清缓冲。空缓冲 no-op。
   * 调用点即段边界：首个 text-delta / tool/call / assistant/message /
   * 非中止 turn/end。
   */
  private commitReasoningBlock(): void {
    if (this.reasoningText === '') return
    const elapsedMs = this.reasoningStartedAt === null ? undefined : Math.max(0, Date.now() - this.reasoningStartedAt)
    const lines = formatReasoningBlock({
      text: this.reasoningText,
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
      compact: this.compactMode,
    }, this.theme)
    // 折叠头行已落底；全文留存供 Ctrl+O 展开查看（滚动区 append-only，不可改写）。
    this.lastReasoningBlock = { text: this.reasoningText, ...(elapsedMs === undefined ? {} : { elapsedMs }) }
    this.reasoningExpanded = false
    this.discardReasoning()
    // commitToScrollback 原子编舞内同步重绘（旧 schedule 尾沿是推理段落底时
    // 输入框缺席数帧的闪烁根因之一）。
    this.commitToScrollback({ text: lines.join('\n'), trailingNewline: true })
  }

  /** 丢弃推理缓冲（abort / 会话切换；aborted turn 的推理不落底）。 */
  private discardReasoning(): void {
    this.reasoningText = ''
    this.reasoningStartedAt = null
  }

  /** 流式收尾：吐尽节流缓冲，并把 StreamRenderer 剩余 pending commit 进 scrollback。 */
  private async flushStream(): Promise<void> {
    await this.blockWriter.flush()
    this.streamRenderer.finalize()
  }

  /**
   * turn 结束摘要行（投影层：turn-summary 模型 → format/turn-summary 渲染半）：
   * `turn N · 读X 改Y · elapsed` 单行 dim 落 scrollback。读/改计数复用
   * tool-meta 的 read|find/write 家族（投影不重复造「工具名 → 域」映射）。
   * @param summary - 该 turn 的统计快照（fold 于 handleStreamEvent，调用点取定）。
   * @param turn - 轮号（取 turn/end 事件的权威值；中途挂载错过 turn/start 时
   *   快照内轮号是初值 0）。
   */
  private commitTurnSummaryLine(summary: TurnSummaryState, turn: number): void {
    const reads = summary.calls.filter(c => {
      const family = getToolFamily(c.name).family
      return family === 'read' || family === 'find'
    }).length
    const writes = summary.calls.filter(c => getToolFamily(c.name).family === 'write').length
    const lines = renderTurnSummaryLine({
      turnNumber: turn,
      segments: [],
      filesRead: reads,
      filesModified: writes,
      ...(summary.totalElapsedMs > 0 ? { elapsedMs: summary.totalElapsedMs } : {}),
      width: this.stdout.columns,
    }, this.theme)
    for (const line of lines) this.commitToScrollback({ text: line, trailingNewline: true })
  }

  /** wrapping-aware display rows（空行计 1）。 */
  private displayRowsFor(text: string): number {
    const cols = this.stdout.columns
    if (cols <= 0) return 1
    const dw = displayWidth(text, { ambiguousAsWide: ambiguousWideEnabled() })
    if (dw === 0) return 1
    return Math.ceil(dw / cols)
  }

  /** critical 路径同步穿透：用户交互（提交/审批/按键）不等 16ms 帧边界。 */
  private flushLiveRender(): void {
    this.renderBatcher.flushNow()
  }

  /** 三类缓存 → 活动带 items（idle key / spinner / snapshot 共用）。 */
  private foldActivityItems() {
    return foldActivityFromCaches({
      subagentRuns: this.delegationSurface.runningEntries(),
      childProgress: this.delegationSurface.progressView(),
      workflowRuns: this.workflowSurface.runningViews(),
      tasks: this.taskSnapshots,
    })
  }

  /** 转圈源：agent / 活动带 running / 未结算工具 / 推理展开或流式。 */
  private hasVisibleSpinner(activityItems = this.foldActivityItems()): boolean {
    return liveHasSpinner({
      agentRunning: this.liveAgent?.state.status === 'running',
      activityRunning: activityItems.some(item => item.status === 'running'),
      pendingTools: this.transcript?.view.tools.some(tool => tool.result === undefined) ?? false,
      reasoningLive: this.reasoningText !== '' || this.reasoningExpanded,
    })
  }

  /** 当前帧 idle key（不含 now/tick）。 */
  private currentIdleKey(activityItems = this.foldActivityItems()): string {
    const pending = this.transcript?.view.tools.filter(tool => tool.result === undefined) ?? []
    const slash = this.inputController.slashMenu
    const approval = this.approval.peek()
    return assembleIdleKey({
      agentStatus: this.liveAgent?.state.status ?? '',
      activity: activityItems,
      pendingCallIds: pending.map(tool => tool.callId),
      activityBandEnabled: this.activityBandEnabled,
      compactMode: this.compactMode,
      rows: this.stdout.rows,
      columns: this.stdout.columns,
      panelFlags: [
        this.todosPanelVisible ? 'todos' : '',
        this.inspect.is('tasks') ? 'tasks' : '',
        this.inspect.is('status') ? 'status' : '',
        this.subagentsPanelVisible ? 'subagents' : '',
        this.workflowPanelVisible ? 'workflow' : '',
        this.inspect.is('skills') ? 'skills' : '',
        this.inspect.is('lsp') ? 'lsp' : '',
        this.inspect.is('config') ? 'config' : '',
      ].join(','),
      btwActive: this.btw.peek() !== null,
      taskNotice: this.taskNotice ?? '',
      gitDirty: this.gitDirty,
      apiKeyReady: this.apiKeyReady,
      reasoningChars: this.reasoningText.length,
      reasoningExpanded: this.reasoningExpanded,
      streamPeekChars: this.blockWriter.peek().length,
      inputValue: this.inputLine.value,
      questionPending: this.question.peek() !== null,
      approvalPending: approval !== null,
      approvalTool: approval?.req.toolName ?? '',
      alwaysApprove: this.approval.alwaysApprove,
      newlineMode: this.inputLine.newlineMode,
      slashKey: `${slash.open ? 1 : 0}:${slash.query}:${slash.selected}:${slash.matches.length}`,
    })
  }

  /** 渲染一帧 live 区：状态行 + 流式尾巴 + 进行中工具卡 + 输入行。 */
  private renderLive(): void {
    if (this.disposed) return
    // A6：全屏 overlay（命令面板/快捷键/搜索/rewind/memory）激活时处于
    // alternate screen buffer——跳过主屏 live 写屏，避免流式帧逐帧盖住面板；
    // overlay 退出后 120ms ticker 下一帧自然重绘，内部状态由事件驱动照常更新。
    if (this.overlay !== null && this.overlay.activeId() !== null) {
      this.lastIdleKey = null
      return
    }
    const activityItems = this.foldActivityItems()
    const idleKey = this.currentIdleKey(activityItems)
    if (this.renderLiveFromTicker && shouldSkipIdleAssemble({
      prevKey: this.lastIdleKey,
      nextKey: idleKey,
      hasSpinner: this.hasVisibleSpinner(activityItems),
    })) return
    this.lastIdleKey = idleKey
    const renderStart = performance.now()
    const theme = this.theme
    const termCols = this.stdout.columns
    const gutter = termCols >= CHROME_GUTTER * 2 + 8 ? CHROME_GUTTER : 0
    const cols = Math.max(1, termCols - gutter * 2)
    const tightViewport = this.stdout.rows < WHALE_MIN_ROWS
    const compactLive = this.compactMode || tightViewport
    const lines: LiveRegionLine[] = []

    // ── 组装 LiveSnapshot（Wave 2）：renderLive 读取字段子集（控制面/面板
    // 显隐/投影源/输入行五组），交给 render/live-panels 的 7 面板纯函数；
    // 非面板段（提问/审批/流利度/流式尾巴/工具卡/输入行）仍由组合器直渲染。──
    // Phase 5.3：glance 控制器统一派生（首推同步 + 窗口内节流）。
    this.glance.refresh()
    const glance = this.glance.current()
    // 错误落底/回填（C4 提取 controllers/error-announcer）：新错误完整落底 + 指引尾注；
    // 输入行空时回填最近一条已投递消息（错误时刻可行动，语义见该模块注释）。
    this.errorAnnouncer.announce(glance.errorFull, this.inputLine.value === '')
    // C4 概念稿 A：turn_status 形态——glance 状态行升级为 spinner（运行中
    // braille 帧循环 / 等待输入 pulsing ◆）+ 阶段文本；null 不占位。
    const turnStatusLines = formatTurnStatus({
      statusText: glance.status,
      tick: this.tick,
      active: this.liveAgent?.state.status === 'running',
      width: cols,
    }, theme)
    const now = Date.now()
    const workflowRuns = foldWorkflowViews(this.workflowSurface.runningViews(), this.workflowSurface.completedViews(), now)
    const snapshot: LiveSnapshot = {
      cols,
      theme,
      glanceStatus: turnStatusLines[0] ?? null,
      glanceError: glance.error,
      taskPanelVisible: this.inspect.is('tasks'),
      taskItems: this.taskItems,
      taskSnapshots: this.taskSnapshots,
      taskNotice: this.taskNotice,
      statusPanelVisible: this.inspect.is('status'),
      goal: (this.projectionCache?.goal as GoalProjectionInput | undefined) ?? null,
      todos: (this.projectionCache?.todos as TaskItem[] | null | undefined) ?? null,
      plan: (this.projectionCache?.plan as PlanProjectionInput | undefined) ?? null,
      // 投影层：会话级汇总段（本地 fold，宿主投影总线缺失时仍有数据）。
      sessionTotals: {
        turns: this.sessionSummary.totalTurns,
        toolCalls: this.sessionSummary.totalToolCalls,
        elapsedMs: this.sessionSummary.totalElapsedMs,
      },
      // todos 紧凑面板（/todos；与 /status 任务段、/tasks 窗格同源不同呈现）
      todosPanelVisible: this.todosPanelVisible,
      todosExpanded: this.todosExpanded,
      todosItems: this.todosRetained,
      ...delegationSnapshotSlice({
        subagentsPanelVisible: this.subagentsPanelVisible, delegationEntries: this.delegationSurface.entries,
        projectionCache: this.projectionCache, externalRuns: this.delegationSurface.externalRuns(), now,
      }),
      workflowPanelVisible: this.workflowPanelVisible,
      workflowRuns,
      configPanelVisible: this.inspect.is('config'),
      configProjection: this.configProjection,
      skillsPanelVisible: this.inspect.is('skills'),
      skillItems: this.skillSurface.all(),
      skillSelected: this.skillSurface.selectedName(),
      // LSP 面板（本地语言服务诊断；bridge 缓存折叠——桥未创建时视为无诊断）
      lspPanelVisible: this.inspect.is('lsp'),
      lspDiagnostics: this.lspDiagnosticsView(),
      lspAvailable: this.lspBridge === null ? true : this.lspBridge.isAvailable(),
      tick: this.tick,
      activityBandEnabled: this.activityBandEnabled,
      activityItems,
      activityBandMaxRows: this.activityBandMaxRows,
    }

    // ── 面板段（8 面板纯函数；组合器负责 { text } 包装与 theme 着色）。──
    // glance 段：状态行 + 错误行（metrics 已并入输入轨下方 footer，避免双份）。
    for (const line of renderGlancePanel(snapshot)) lines.push({ text: line })
    // T4 + T2.3：任务窗格 + 后台任务区（/tasks 面板内；taskPanelVisible 门控
    // 在 renderTasksPanel 内，窗格行在前、后台任务区行在后）。
    for (const line of renderTasksPanel(snapshot)) lines.push({ text: line })
    // T1.2：/status 状态面板——goal/todos/plan 段在投影缓存缺失时折叠为 null
    // 由纯函数逐段降级（切换时已回显警告）；会话汇总段是 TUI 本地 fold
    // （summary-state），不依赖投影总线，总线缺失时仍有数据。
    if (this.inspect.is('status')) {
      for (const line of renderStatusPanel(snapshot)) lines.push({ text: line })
    }
    // T2.1：委派树面板（delegationEntries null 降级在 renderDelegationPanel 内）。
    for (const line of renderDelegationPanel(snapshot)) lines.push({ text: line })
    // T2.2：workflow 面板（列表行 + 终态汇总；cancelled 置灰由纯函数承担）。
    for (const line of renderWorkflowPanel(snapshot)) lines.push({ text: line })
    // T3.2：/config 设置面板（projection null 降级在 renderConfigPanel 内）。
    for (const line of renderConfigPanel(snapshot)) lines.push({ text: line })
    // T3.3：/skills 技能浏览面板。
    for (const line of renderSkillsPanel(snapshot)) lines.push({ text: line })
    // LSP：/lsp 诊断面板（本地语言服务；bridge 缓存折叠，纯展示）。
    for (const line of renderLspPanel(snapshot)) lines.push({ text: line })

    // P1：/btw 侧问面板——live 区顶部浮动段（glance 之后；不抢占输入焦点）。
    // loading 用 secondary 色、error 用 warning 色、done 不着色（答案原样）。
    const btwPeek = this.btw.peek()
    if (btwPeek !== null) {
      const btwColor = btwPeek.status === 'error'
        ? theme.warning
        : btwPeek.status === 'loading' ? theme.secondary : null
      for (const line of renderBtwPanel(btwPeek, { width: cols })) {
        lines.push({ text: btwColor === null ? line : color(line, btwColor) })
      }
    }

    // T2.3：任务完成通知（onTaskDone 一次性提示行；组合器副作用——渲染后
    // 清空，面板纯函数不承担可变状态）。
    if (snapshot.taskNotice !== null) {
      lines.push({ text: color(snapshot.taskNotice, theme.muted) })
      this.taskNotice = null
    }

    // Phase 9d 流利度：长静默/高负载的策略提示（stale 档：等待太久时给出
    // 分级提示，action 档明示 Ctrl+C；吞吐折叠不在此渲染，折叠由
    // format/tool-group 纯 fold 承担）
    const policy = this.fluency.getPolicy()
    if (policy.staleMessage !== undefined && policy.staleLevel !== undefined) {
      const staleColor = policy.staleLevel === 'action'
        ? theme.error
        : policy.staleLevel === 'warn' ? theme.warning : theme.secondary
      lines.push({ text: color(`⏳ ${policy.staleMessage}`, staleColor) })
    }
    // 双击布防提示行（registry confirmMs 集中管理；投影含过期自清——format/confirm-hints）。
    pushConfirmHints(this.actions, lines, theme)

    // 推理展开视图（Ctrl+O 切换；scrollback append-only，全文在 live 区展示）：
    // - 流式进行中：shimmer 头行 + 推理全文（替代折叠态的尾 N 行）；
    // - 已落底块：静态头行 + 全文（scrollback 只留折叠头行，展开不重复落底）。
    if (this.reasoningExpanded) {
      if (this.reasoningText !== '') {
        const reasoningLines = formatReasoningLive({
          text: this.reasoningText,
          ...(this.reasoningStartedAt === null ? {} : { elapsedMs: Math.max(0, Date.now() - this.reasoningStartedAt) }),
          tick: this.tick,
          columns: cols,
          expanded: true,
        }, theme)
        for (const line of reasoningLines) lines.push({ text: line })
        lines.push({ text: color('— ctrl+o 收起', theme.dim) })
      } else if (this.lastReasoningBlock !== null) {
        const blockLines = formatReasoningBlock({
          text: this.lastReasoningBlock.text,
          ...(this.lastReasoningBlock.elapsedMs === undefined ? {} : { elapsedMs: this.lastReasoningBlock.elapsedMs }),
          expanded: true,
        }, theme)
        for (const line of blockLines) lines.push({ text: line })
        lines.push({ text: color('— ctrl+o 收起', theme.dim) })
      }
    }

    // 流式推理段（reasoning-delta 累积中）：shimmer 头行 + 尾 N 行暗色思考
    // ——渲染在流式文本尾巴上方（推理先于正文的事件序）。段结束由
    // handleStreamEvent 落底进 scrollback 并清缓冲，live 区随之消失。
    // 展开态已在上面渲染全文，此处跳过（避免上下双份）。
    if (this.reasoningText !== '' && !this.reasoningExpanded) {
      const reasoningLines = formatReasoningLive({
        text: this.reasoningText,
        ...(this.reasoningStartedAt === null ? {} : { elapsedMs: Math.max(0, Date.now() - this.reasoningStartedAt) }),
        tick: this.tick,
        columns: cols,
        compact: compactLive,
        maxRows: reasoningTailBudget(this.stdout.rows),
      }, theme)
      for (const line of reasoningLines) lines.push({ text: line })
    }

    // 流式尾巴：StreamRenderer pending + blockWriter 未吐缓冲（原始文本防围栏闪烁）。
    // 已 commit 的稳定块在 scrollback，不进 live 区——避免同段文字上下双份。
    for (const line of this.streamRenderer.getLiveTailLines(tightViewport ? 2 : 6, this.blockWriter.peek())) {
      lines.push({ text: line })
    }

    // 进行中的工具卡（无 result 的 tool/call）；标题优先 presentCall 意图
    //（tool/call 时解析缓存），缺省回落 toolArgSummary 启发式。
    const pendingTools = this.transcript?.view.tools.filter(t => t.result === undefined) ?? []
    const overflow = Math.max(0, pendingTools.length - LIVE_TOOL_CARD_MAX)
    const shownTools = overflow > 0 ? pendingTools.slice(-LIVE_TOOL_CARD_MAX) : pendingTools
    for (const [i, tool] of shownTools.entries()) {
      const args = parseToolArguments(tool.arguments)
      const titleOverride = this.pendingCallTitles.get(tool.callId)
      const latest = i === shownTools.length - 1
      // LSP 徽标：工具触碰的文件有诊断缓存时标题追加「⚠ N错 M警」
      // （诊断已就绪才显示；拉取中/无诊断不干扰标题）。
      const lspBadge = this.lspBadgeFor(args)
      const title = lspBadge === null
        ? (titleOverride ?? toolCardTitle(tool.name, args))
        : `${titleOverride ?? toolCardTitle(tool.name, args)} ${lspBadge}`
      const rows = formatToolCardLive({
        toolName: tool.name,
        ...(args === undefined ? {} : { toolInput: args }),
        title,
        columns: cols,
        elapsedMs: Math.max(0, Date.now() - tool.time),
        tailLines: compactLive || !latest ? 0 : (tightViewport ? 1 : 3),
        tick: this.tick,
        compact: compactLive,
        expanded: this.expandedToolCallId === tool.callId,
      }, theme)
      for (const line of rows) lines.push({ text: line })
    }
    if (overflow > 0) {
      lines.push({ text: color(` …(+${overflow}) 个工具进行中`, theme.muted) })
    }

    if (this.activityBandEnabled) {
      for (const line of renderActivityBand(snapshot)) lines.push({ text: line })
    } else {
      for (const line of renderActivitySection({
        enabled: false, subagentRuns: this.delegationSurface.runningEntries(),
        childProgress: this.delegationSurface.progressView(), workflowRuns: this.workflowSurface.runningViews(),
        tasks: this.taskSnapshots,
        width: cols, maxRows: this.activityBandMaxRows, now, tick: this.tick, theme,
      })) lines.push({ text: line })
    }

    // chrome 起点：todos/提问/审批/slash 贴输入轨（列入 chrome，小窗口不被从顶
    // 裁掉），其后是 vim / 图片 / 排队 / 输入轨 / footer。溢出裁剪只作用在动态段；
    // 该 chrome 前缀是「开合变高」吸收段——行数计入动态段高水位记账，开合由垫高吸收。
    const chromeStart = lines.length

    // 待办卡贴输入轨上方（活动带之下）：不跟思考抢 live 上半，小窗口也不被裁掉。
    for (const line of renderTodosPanel(snapshot)) lines.push({ text: line })

    // 提问 / 审批紧挨输入轨。
    const questionPeek = this.question.peek()
    if (questionPeek !== null) {
      for (const line of projectQuestionPanel(questionPeek.request, { width: cols, theme })) {
        lines.push({ text: line })
      }
      if (questionPeek.feedbackMode) {
        lines.push({ text: color('📝 反馈输入中（Enter 提交 / Esc / Ctrl+C 返回选项）', theme.muted) })
      }
    }
    // 审批键位提示段：registry 逐帧投影（p 段随前缀可得性进出）；footer 与审批卡键位行同消费（同源）。
    const approvalHintSegs = projectApprovalHints(this.actions.list(), this.actionCtx)
    const approvalPeek = this.approval.peek()
    if (approvalPeek !== null) {
      const toolCall = findApprovalToolCall(approvalPeek.req, this.transcript?.view)
      const diff = toolCall === undefined
        ? null
        : formatPermissionDiff({ toolName: toolCall.name, arguments: toolCall.arguments }, this.theme)
      for (const line of formatApprovalCard({
        columns: cols,
        toolName: approvalPeek.req.toolName,
        ...(approvalPeek.req.reason === undefined ? {} : { reason: approvalPeek.req.reason }),
        diffLines: diff,
        compact: compactLive,
        keyHintSegments: approvalHintSegs,
        feedback: approvalPeek.feedbackMode,
      }, theme)) {
        lines.push({ text: line })
      }
    }

    // slash 命令菜单（grok slash_dropdown 移植）：/ 开头有匹配时渲染可滚动
    // 列表，无匹配退回一行内联提示。行数随过滤实时变化，属吸收段（见 chromeStart）。
    const inputValue = this.inputLine.value
    const slashLines: string[] = []
    if (this.inputController.slashMenu.open) {
      for (const line of formatSlashMenu({
        width: cols,
        items: this.inputController.slashMenu.matches,
        selected: this.inputController.slashMenu.selected,
      }, theme)) {
        slashLines.push(line)
      }
    } else {
      const hint = this.slash.hint(inputValue)
      if (hint !== null) slashLines.push(hint)
    }
    for (const line of slashLines) lines.push({ text: line })
    // 吸收段终点（原 slashRows 记账先例推广到 todos/提问/审批/slash）；其后的
    // vim 标签/附件摘要与预览/排队行为单行或用户主动动作，纳入反而留常驻空行。
    const absorbTo = lines.length

    // 输入行；vim 模式标签（Phase 6.5：normal/visual 态可见，insert 态隐藏）
    if (this.inputLine.vimEnabled && this.inputLine.vimMode !== 'insert') {
      const modeLabel = this.inputLine.vimMode === 'visual'
        ? (this.inputLine.visualLineWise ? '-- VISUAL LINE --' : '-- VISUAL --')
        : '-- NORMAL --'
      lines.push({ text: color(modeLabel, theme.secondary) })
    }
    // 图片附件标记（📎 N images）显示在输入行上方；dim 色弱化不干扰输入。
    for (const summary of this.inputLine.imageSummary(cols)) {
      lines.push({ text: color(summary, theme.muted) })
    }
    // 附件半块预览（composer 缩略图）：最后一张附件的降采样真彩行（装饰性
    // 增强——解码失败/无附件时预览为空数组不占位，计数行仍在）。
    for (const line of this.attachmentPreview.lines) {
      lines.push({ text: line })
    }
    // 运行中排队行（对标 CC：待发消息显示在输入上方；↑ 取回队首）。
    if (this.submitQueue.size() > 0) {
      lines.push({ text: formatQueueLine(cols, this.submitQueue.peekAll()) })
    }
    // ghost 槽位汇合：slash 补全（补全剩余/参数占位）优先，fish 式历史建议其次。
    // 提问/审批挂起时抑制 ghost：该上下文吞掉全部未匹配键（→ 无法 accept-ghost），
    // 可见但不可用的建议会误导用户；btw 侧问放行键入（不吞键），不在此列。
    const ghostBlocked = this.question.isPending || this.approval.isPending
    this.inputLine.setGhost(ghostBlocked ? null : (this.slashGhostText() ?? this.historyGhostText()))
    // CC PromptInput marginTop={1}：轨前 1 行呼吸，不填视口。
    lines.push({ text: '' })
    // 输入轨（Claude Code 形态）：上下圆角横线、左右不封。轨线色
    // normal 雾蓝 / plan warning / auto error。caret 行 +1、列不修正。
    const planProj = this.projectionCache?.plan as PlanProjectionWire | undefined
    const modeColor = planProj?.pending === true || planProj?.active === true
      ? theme.warning
      : this.approval.alwaysApprove ? theme.error : theme.secondary
    const promptColor = this.liveAgent?.state.status === 'running' ? theme.dim : modeColor
    const inputView = this.inputLine.displayLinesWithCaret({
      maxWidth: cols,
      // 长草稿视窗裁剪（3..16 行随终端高度；超出折叠为「… 上/下 N 行」）
      maxLines: inputViewportMaxLines(this.stdout.rows),
    })
    const framedLines = inputView.lines.map((line) => (
      line.startsWith('❯ ') ? `${color('❯', promptColor)}${line.slice(1)}` : line
    ))
    const frame = formatInputFrame({
      columns: cols,
      lines: framedLines,
      caretLine: inputView.caret.line,
      caretCol: inputView.caret.col,
      planActive: planProj?.active === true,
      planPending: planProj?.pending === true,
      alwaysApprove: this.approval.alwaysApprove,
    }, theme)
    for (const [i, line] of frame.lines.entries()) {
      lines.push(i === frame.caretLine ? { text: line, caretCol: frame.caretCol } : { text: line })
    }

    // C4：footer 分层两行（对齐 kimi-code）——行 1 状态行：左 mode/快捷键、
    // 右状态段（预设/model/API/git；priority 大者先丢：●N 200 最先 → API 100
    // → glance 段字符串缺省下标序即从后丢）；行 2 指标行：context/tokens/cost
    // 等（full 档；compact 仅行 1，off 全关）。
    const bottomMetrics = this.glanceMetrics()
    const apiSeg: FooterRightSegment = { text: `API ${this.apiKeyReady ? '✓' : '✗'}`, priority: 100 }
    const dirtySeg: FooterRightSegment[] = this.gitDirty > 0 ? [{ text: `●${this.gitDirty}`, priority: 200 }] : []
    const rightSegments: (string | FooterRightSegment)[] | undefined = bottomMetrics === null
      ? (dirtySeg.length === 0 ? undefined : [apiSeg, ...dirtySeg])
      : [...glanceStatusSegments({ ...bottomMetrics, hideSegments: this.prefs.glance?.hideSegments }), apiSeg, ...dirtySeg]
    const footerLines = formatFooterInfo({
      width: cols,
      planActive: planProj?.active === true,
      planPending: planProj?.pending === true,
      alwaysApprove: this.approval.alwaysApprove,
      approvalPending: this.approval.isPending,
      inspectOpen: this.inspect.any(),
      // 上下文提示段由 action registry 投影（actions/projections；同源动作表）。
      approvalHints: approvalHintSegs,
      inspectHints: this.footerInspectHints,
      level: this.prefs.footerInfo ?? 'full',
      ...(rightSegments !== undefined ? { rightSegments } : {}),
      ...(bottomMetrics !== null ? { metrics: { ...bottomMetrics, hideSegments: this.prefs.glance?.hideSegments } } : {}),
    }, theme)
    for (const line of footerLines) lines.push({ text: line })

    if (gutter > 0) {
      const pad = ' '.repeat(gutter)
      for (const line of lines) {
        line.text = `${pad}${line.text}`
        if (line.caretCol !== undefined) line.caretCol += gutter
      }
    }

    const rowsForLine = (text: string): number => this.displayRowsFor(text)
    let chromeRows = 0
    for (let i = chromeStart; i < lines.length; i++) {
      const row = lines[i]
      if (row === undefined) continue
      chromeRows += rowsForLine(row.text)
    }
    let dynamicRows = 0
    for (let i = 0; i < chromeStart; i++) {
      const row = lines[i]
      if (row === undefined) continue
      dynamicRows += rowsForLine(row.text)
    }
    // 定高视口：动态段按高水位垫到恰好 budget，live region 只涨不缩 →
    // 输入框钉住、回缩黑洞与旧轨线重影一并消除。欢迎首帧（无消息且非运行、
    // 吸收段未打开）不垫，但仍按 Working 封顶从顶裁。
    // 吸收段行数计入被跟踪总量：ceiling 已含 chromeRows（含 absorbedRows），传
    // ceiling + absorbedRows 使上限与这些段高度无关 → 开合只改垫高行数，输入轨
    // 行位恒定（短内容期高水位无余量时首次打开向下落定一次，此后不再漂移）。
    const terminalRows = this.stdout.rows || 24
    // 底部 slack 常数 2：整帧（动态段 + chrome 尾部）预算至多 terminalRows - 2
    // 行，输入轨与 footer 不贴终端最底两行（底行留白防尾行换行触发滚屏与帧重
    // 铺错位；live-engine 另有 min(28, rows-1) 封顶兜底）。注意呼吸行与输入轨
    // 行已计入 chromeRows，不属此 -2 的构成。
    const raw = terminalRows - chromeRows - 2
    const ceiling = Math.max(0, Math.min(raw, workingRowsCap(terminalRows, chromeRows)))
    let absorbedRows = 0
    for (let i = chromeStart; i < absorbTo; i++) {
      const row = lines[i]
      if (row === undefined) continue
      absorbedRows += rowsForLine(row.text)
    }
    const skipPad = (this.transcript?.view.messages ?? []).length === 0
      && this.liveAgent?.state.status !== 'running'
      && absorbedRows === 0
      && this.dynamicRowsHighWater === 0
    const next = nextDynamicBudget(
      this.dynamicRowsHighWater,
      dynamicRows + absorbedRows,
      ceiling + absorbedRows,
      skipPad,
      this.reasoningExpanded,
    )
    this.dynamicRowsHighWater = next.highWater
    const padded = padDynamicRegion(lines, chromeStart, Math.max(0, next.budget - absorbedRows), rowsForLine, { pad: !skipPad })
    const chromeTail = padded.lines.length - padded.chromeStart
    this.live.render(padded.lines, chromeTail > 0 ? { reservedTail: chromeTail } : undefined)
    this.perfMonitor.record('renderLive', performance.now() - renderStart)
  }

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
  private async detachProjections(opts?: { keepHandle?: boolean }): Promise<void> {
    this.transcript?.dispose()
    this.liveAgent?.dispose()
    this.statusLine?.dispose()
    this.streamFeed?.()
    this.streamFeed = null
    // T1.1/T4：投影订阅随会话卸载释放，缓存与显隐复位（整体降级回默认态）。
    this.projectionDisposer?.()
    this.projectionDisposer = null
    // T2.1/T2.2：subagent/workflow 事件订阅同样随会话卸载释放（否则每次挂载泄漏）。
    this.subagentDisposer?.()
    this.subagentDisposer = null
    this.workflowDisposer?.()
    this.workflowDisposer = null
    // T2.3：tasks onTaskDone 订阅随会话卸载释放（注释语义『随会话挂载/卸载』；
    // 否则单次挂载后 dispose/切会话时订阅残留，回调闭包持有 App 无法回收。
    // mountSession 末尾的预释放只覆盖重挂载路径，不覆盖最后一次挂载）。
    this.taskDoneDisposer?.()
    this.taskDoneDisposer = null
    this.taskSnapshots = []
    this.taskNotice = null
    // glance 数据（usage/effort/contextWindow）随会话卸载复位——新会话重挂载重折叠。
    this.usageFold = null
    this.sessionCosts.clear()
    this.glanceEffort = null
    this.contextWindow = null
    this.projectionCache = null
    this.taskItems = null
    this.planState = { active: false, pending: false }
    // C3 项 4：always-approve 是会话级本地态——切会话/退出时复位，
    // 防止残留到新会话（planState 同上复位；徽章由 statusLine 重建）。
    this.approval.setAlwaysApprove(false)
    // Phase 8：卸载会话时清挂起审批——否则旧审批仍可被 y/N 结算且阻塞
    // 新会话请求（跨会话残留 bug；fail-closed 结算为 cancelled）。
    if (this.approval.isPending) this.approval.settle('cancelled')
    // T3.1：卸载会话时清挂起提问——否则会话 A 的 plan-review 卡残留在会话
    // B 仍渲染，B 的按键决定 A 的 ask promise（跨会话残留 bug；与 approval
    // settle('cancelled') 对称，cancel 按 provider 契约 reject ASK_CANCELLED）。
    if (this.question.isPending) this.question.cancel()
    this.inspect.hide('tasks')
    this.inspect.hide('status')
    // 切会话/退出共用：旧会话的流式残文不得带进下一段输出
    this.blockWriter.discard()
    this.streamRenderer.reset()
    if (this.ownedHandle !== null) {
      if (opts?.keepHandle === true) {
        // P3：切换保留——让渡 registry（agent 保持 live；退出时 factory 统一清理）。
        this.ownedHandle = null
        this.modelRef = null
      } else {
        const handle = this.ownedHandle
        this.ownedHandle = null
        await handle.dispose()
      }
    }
    this.transcript = null
    this.liveAgent = null
    this.statusLine = null
    this.controls = null
  }

  /**
   * 退出：先 flush 所有 live 会话到持久层（退出恢复 checkpoint）、停止 ticker、
   * 卸载投影、恢复终端 raw-mode。
   * @returns 全部 flush 完成后 resolve。
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.ticker !== null) { clearInterval(this.ticker); this.ticker = null }
    // 先 flush 再释放本层持有的 handle：flushAll 依赖 live store 未拆，
    // 而 dispose owned handle 会卸载投影/释放 agent，先拆会让 flush 无物可刷。
    try { await flushAll(this.ctx) } catch { /* flush 失败不阻塞退出 */ }
    // Phase 8：解绑 answerer；未决审批 settle 为 cancelled（fail-closed 语义；
    // detachProjections 已清挂起，此处幂等兜底）
    this.approvalDisposer?.()
    this.approvalDisposer = null
    if (this.approval.isPending) this.approval.settle('cancelled')
    // T3.1：释放 userQuestions provider 注册（否则服务侧再次 registerProvider
    // 抛 DUPLICATE_PROVIDER）；挂起提问 reject ASK_CANCELLED（detachProjections
    // 已清挂起，此处幂等兜底）。
    this.interactionDisposer?.()
    this.interactionDisposer = null
    if (this.question.isPending) this.question.cancel()
    // #39：技能展示面随 dispose 解绑订阅（防止 dispose 后事件回调泄漏）。
    this.skillSurface.dispose()
    // overlay 打开期间暂存的 scrollback 条目：退出前按同一协议补写主屏
    // （会话日志是权威数据，scrollback 是展示层——丢条目只影响本次显示，
    // 补写成本低且避免"发了消息但屏上不见"的观感）。
    this.commitSurface.flushDeferred()
    await this.detachProjections()
    // P1：/btw 侧问收尾——未决侧问直接销毁 btw agent（done 态答案未折叠则
    // 丢弃，退出即弃；订阅随 teardown 释放，防 dispose 后事件回调泄漏）。
    this.btw.dispose()
    // T2.3：tasks attachSurface('tui') 控制面随 dispose 释放（注释语义『attach
    // 声明、dispose 释放』；切会话场景由 mountSession 预释放兜底，此处覆盖
    // 最后一次挂载后直接退出的路径）。
    this.taskSurfaceDisposer?.()
    this.taskSurfaceDisposer = null
    // LSP：诊断桥销毁（kill 全部语言 server、清缓存与回调；幂等）。
    this.lspBridge?.dispose()
    this.lspBridge = null
    // overlay 若仍在 alt screen，先退回主屏（1049l），否则进程退出后部分
    // 终端会把用户留在备用屏。
    this.overlay?.deactivate()
    this.stdout.write(kittyKeyboardPopSeq() + ANSI.BRACKETED_PASTE_OFF)
    this.pasteDisposer?.()
    this.pasteDisposer = null
    this.input.dispose()
    this.resize.dispose()
    this.glance.dispose()
    this.perfMonitor.stop()
    this.live.clear()
    // live.clear / 每帧渲染都会 HIDE_CURSOR；必须在全部写屏之后恢复，
    // 否则 Ctrl+Q / /exit 把 TTY 还给 shell 时硬件光标仍隐藏（#22）。
    this.stdout.write(ANSI.SHOW_CURSOR)
  }

  /**
   * 刷新会话列表（供外部面板查询；本 MVP 的会话面板直接读 store）。
   * @returns 全部会话的摘要列表。
   */
  async refreshSessions(): Promise<SessionSummary[]> {
    return listSessions(this.ctx)
  }
}
