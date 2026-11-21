/**
 * LiveSnapshot 组装器 — 把 renderLive 每帧读取的 TuiApp 状态折叠成一次调用。
 *
 * 抽取动机：`renderLive` 曾内联 ~45 行对象字面量 + 三处派生（状态行格式、
 * workflow 视图 fold、委派切片）。派生逻辑藏在 UI 方法里既不可单测，也让
 * 那个方法继续膨胀。本模块只做「原始状态 → 快照」的纯变换：无 I/O、不持有
 * 状态，给定输入必得同一输出。
 *
 * 依赖方向刻意放在 ui/ 侧：`activity-flow`（委派切片 / workflow fold）与
 * `format/turn-status` 都在 ui/format 层，放到 render/ 会形成 render→ui 的
 * 反向依赖，而 `render/live-snapshot` 只保留类型。
 *
 * @module @deepseek-ai/dsh-tianshu-tui/ui/live-composition
 */

import type { ActivityItem } from '../format/activity-band.js'
import type { TaskItem } from '../format/task-panel.js'
import type { ConfigPanelProjection } from '../config-panel.js'
import type { DelegationTreeEntry, ExternalRunEntry } from '../delegation-panel.js'
import type { LspDiagnosticView } from '../lsp/lsp-bridge.js'
import type { LiveSnapshot, TaskSnapshotView } from '../render/live-snapshot.js'
import type { SkillSummaryInput } from '../skill-panel.js'
import type { RivetTheme } from '../theme.js'
import type { WorkflowRunView } from '../workflow-panel.js'
import { formatTurnStatus } from '../format/turn-status.js'
import { delegationSnapshotSlice, foldWorkflowViews, runningWorkflowView } from './activity-flow.js'

/** 运行中 workflow 的缓存形态（与 activity-flow 内部视图同源）。 */
export type RunningWorkflowState = Parameters<typeof runningWorkflowView>[0]

/** buildLiveSnapshot 的全部输入：renderLive 每帧从 TuiApp 读到的原始状态。 */
export interface LiveCompositionInput {
  /** 终端列数（行截断预算）。 */
  cols: number
  /** 当前主题。 */
  theme: RivetTheme
  /** glance 状态行文本（未格式化；派生交给 formatTurnStatus）。 */
  glanceStatus: string | null
  /** glance 错误行（已折好的错误文本）。 */
  glanceError: string | null
  /** ticker 帧。 */
  tick: number
  /** 当前 agent 是否 running（决定状态行 spinner/pulsing 形态）。 */
  agentRunning: boolean
  /** 墙钟（epoch 毫秒；本帧统一取值，避免同帧多次 Date.now）。 */
  now: number

  taskPanelVisible: boolean
  taskItems: TaskItem[] | null
  taskSnapshots: TaskSnapshotView[]
  taskNotice: string | null

  statusPanelVisible: boolean
  /** 宿主投影缓存（goal/todos/plan/subagent 四域；缺失时各段降级）。 */
  projectionCache: Partial<Record<string, unknown>> | null
  /** 会话级汇总（本地 fold）。 */
  sessionTotals: LiveSnapshot['sessionTotals']

  todosPanelVisible: boolean
  todosExpanded: boolean
  todosRetained: TaskItem[] | null

  subagentsPanelVisible: boolean
  delegationEntries: DelegationTreeEntry[] | null
  externalRuns: ExternalRunEntry[]

  workflowPanelVisible: boolean
  /** 运行中 workflow 缓存（fold 为视图）。 */
  runningWorkflows: Iterable<RunningWorkflowState>
  /** 已结算 workflow 视图。 */
  completedWorkflows: Iterable<WorkflowRunView>

  configPanelVisible: boolean
  configProjection: ConfigPanelProjection | null

  skillsPanelVisible: boolean
  skillItems: SkillSummaryInput[]
  skillSelected: string | undefined

  lspPanelVisible: boolean
  lspDiagnostics: LspDiagnosticView[]
  lspAvailable: boolean

  activityBandEnabled: boolean
  activityItems: ActivityItem[]
  activityBandMaxRows: number
}

/**
 * 组装一帧 LiveSnapshot。
 *
 * 三处派生在此收口：状态行（formatTurnStatus 取首行）、workflow 视图
 * （running + completed fold）、委派切片（identities/timings 从投影缓存取）。
 * @param input - renderLive 本帧读到的原始状态。
 * @returns 面板纯函数可直接消费的快照。
 */
export function buildLiveSnapshot(input: LiveCompositionInput): LiveSnapshot {
  const statusLine = formatTurnStatus({
    statusText: input.glanceStatus,
    tick: input.tick,
    active: input.agentRunning,
    width: input.cols,
  }, input.theme)[0] ?? null

  const workflowRuns = foldWorkflowViews(input.runningWorkflows, input.completedWorkflows, input.now)

  return {
    cols: input.cols,
    theme: input.theme,
    glanceStatus: statusLine,
    glanceError: input.glanceError,
    taskPanelVisible: input.taskPanelVisible,
    taskItems: input.taskItems,
    taskSnapshots: input.taskSnapshots,
    taskNotice: input.taskNotice,
    statusPanelVisible: input.statusPanelVisible,
    goal: (input.projectionCache?.goal as LiveSnapshot['goal'] | undefined) ?? null,
    todos: (input.projectionCache?.todos as LiveSnapshot['todos'] | undefined) ?? null,
    plan: (input.projectionCache?.plan as LiveSnapshot['plan'] | undefined) ?? null,
    sessionTotals: input.sessionTotals,
    todosPanelVisible: input.todosPanelVisible,
    todosExpanded: input.todosExpanded,
    todosItems: input.todosRetained,
    ...delegationSnapshotSlice({
      subagentsPanelVisible: input.subagentsPanelVisible,
      delegationEntries: input.delegationEntries,
      projectionCache: input.projectionCache,
      externalRuns: input.externalRuns,
      now: input.now,
    }),
    workflowPanelVisible: input.workflowPanelVisible,
    workflowRuns,
    configPanelVisible: input.configPanelVisible,
    configProjection: input.configProjection,
    skillsPanelVisible: input.skillsPanelVisible,
    skillItems: input.skillItems,
    skillSelected: input.skillSelected,
    lspPanelVisible: input.lspPanelVisible,
    lspDiagnostics: input.lspDiagnostics,
    lspAvailable: input.lspAvailable,
    tick: input.tick,
    activityBandEnabled: input.activityBandEnabled,
    activityItems: input.activityItems,
    activityBandMaxRows: input.activityBandMaxRows,
  }
}
