/**
 * LiveSnapshot 组装器（`ui/live-composition`）契约测试。
 *
 * 这个模块从 `app.ts` 的 `renderLive` 抽出来，价值不在搬运行数，而在把三处
 * 派生收口成可测单元：状态行（`formatTurnStatus` 首行）、workflow 视图 fold、
 * 委派切片（identities/timings 从投影缓存取）。其余字段是 1:1 透传。
 */
import { describe, expect, it } from 'vitest'
import type { RivetTheme } from '../src/theme.js'
import type { TaskItem } from '../src/format/task-panel.js'
import type { WorkflowRunView } from '../src/workflow-panel.js'
import { buildLiveSnapshot, type LiveCompositionInput } from '../src/ui/live-composition.js'

/** 假主题（与 live-panels.spec 同构：每个 token 一个独特 hex）。 */
const THEME = {
  primary: '#111111',
  secondary: '#222222',
  success: '#333333',
  warning: '#444444',
  error: '#555555',
  dim: '#666666',
  muted: '#777777',
  pulseQuiet: '#888888',
  pulseActive: '#999999',
  pulseAlert: '#aaaaaa',
  userColor: '#bbbbbb',
  assistantColor: '#cccccc',
  systemColor: '#dddddd',
  brandColor: '#eeeeee',
  toolColor: () => '#000000',
  contextColor: () => '#000000',
} as RivetTheme

/** 全默认输入：面板隐藏、投影缺失、无活动项。 */
function baseInput(over: Partial<LiveCompositionInput> = {}): LiveCompositionInput {
  return {
    cols: 100,
    theme: THEME,
    glanceStatus: null,
    glanceError: null,
    tick: 0,
    agentRunning: false,
    now: 1_000,
    taskPanelVisible: false,
    taskItems: null,
    taskSnapshots: [],
    taskNotice: null,
    statusPanelVisible: false,
    projectionCache: null,
    sessionTotals: { turns: 0, toolCalls: 0, elapsedMs: 0 },
    todosPanelVisible: false,
    todosExpanded: false,
    todosRetained: null,
    subagentsPanelVisible: false,
    delegationEntries: null,
    externalRuns: [],
    workflowPanelVisible: false,
    runningWorkflows: [],
    completedWorkflows: [],
    configPanelVisible: false,
    configProjection: null,
    skillsPanelVisible: false,
    skillItems: [],
    skillSelected: undefined,
    lspPanelVisible: false,
    lspDiagnostics: [],
    lspAvailable: true,
    activityBandEnabled: true,
    activityItems: [],
    activityBandMaxRows: 5,
    ...over,
  }
}

function completedView(id: string): WorkflowRunView {
  return { info: { id, meta: {} }, agents: [] } as unknown as WorkflowRunView
}

describe('buildLiveSnapshot', () => {
  it('透传：面板显隐、投影、活动带与会话汇总原样带出', () => {
    const todos = [{ id: 't1', label: '做事', status: 'pending' }] as unknown as TaskItem[]
    const snapshot = buildLiveSnapshot(baseInput({
      cols: 77,
      taskPanelVisible: true,
      statusPanelVisible: true,
      todosPanelVisible: true,
      todosRetained: todos,
      lspAvailable: false,
      activityBandMaxRows: 9,
      sessionTotals: { turns: 3, toolCalls: 7, elapsedMs: 12_000 },
    }))
    expect(snapshot.cols).toBe(77)
    expect(snapshot.theme).toBe(THEME)
    expect(snapshot.taskPanelVisible).toBe(true)
    expect(snapshot.statusPanelVisible).toBe(true)
    expect(snapshot.todosPanelVisible).toBe(true)
    expect(snapshot.todosItems).toEqual(todos)
    expect(snapshot.lspAvailable).toBe(false)
    expect(snapshot.activityBandMaxRows).toBe(9)
    expect(snapshot.sessionTotals).toEqual({ turns: 3, toolCalls: 7, elapsedMs: 12_000 })
  })

  it('状态行是派生值：无状态文本时不占位，有文本时经 formatTurnStatus 产出首行', () => {
    expect(buildLiveSnapshot(baseInput({ glanceStatus: null })).glanceStatus).toBeNull()
    const running = buildLiveSnapshot(baseInput({ glanceStatus: '思考中', agentRunning: true }))
    expect(running.glanceStatus).not.toBeNull()
    expect(typeof running.glanceStatus).toBe('string')
  })

  it('workflow 视图：已结算 run 原样进入 workflowRuns', () => {
    const done = completedView('w-done')
    const snapshot = buildLiveSnapshot(baseInput({ completedWorkflows: [done] }))
    expect(snapshot.workflowRuns).toHaveLength(1)
    expect(snapshot.workflowRuns[0]?.info.id).toBe('w-done')
  })

  it('workflow 视图：运行中 run 被 fold 成带 elapsedMs 的视图', () => {
    const snapshot = buildLiveSnapshot(baseInput({
      now: 5_000,
      runningWorkflows: [
        { id: 'w-run', meta: {}, agents: [], startedAt: 1_000, logs: [] },
      ] as unknown as LiveCompositionInput['runningWorkflows'],
    }))
    expect(snapshot.workflowRuns).toHaveLength(1)
    expect(snapshot.workflowRuns[0]?.info.id).toBe('w-run')
    expect(snapshot.workflowRuns[0]?.elapsedMs).toBe(4_000)
  })

  it('委派切片：identities/timings 从投影缓存取，缺失时降级为空 Map', () => {
    const identities = new Map([['a1', { label: '子代理' }]])
    const withCache = buildLiveSnapshot(baseInput({
      projectionCache: { subagent: identities },
      externalRuns: [{ id: 'ext1' } as never],
    }))
    expect(withCache.subagentIdentities).toBe(identities)
    expect(withCache.subagentTimings.size).toBe(0)
    expect(withCache.externalRuns).toHaveLength(1)

    const noCache = buildLiveSnapshot(baseInput({ projectionCache: null }))
    expect(noCache.subagentIdentities.size).toBe(0)
    expect(noCache.subagentTimings.size).toBe(0)
  })

  it('goal/todos/plan 从投影缓存取，缺失时为 null（面板逐段降级）', () => {
    const goal = { text: '目标' }
    const plan = { steps: [] }
    const cached = buildLiveSnapshot(baseInput({
      projectionCache: { goal, plan, todos: [{ id: 't', label: 'x', status: 'pending' }] },
    }))
    expect(cached.goal).toBe(goal)
    expect(cached.plan).toBe(plan)
    expect(cached.todos).toHaveLength(1)

    const empty = buildLiveSnapshot(baseInput({ projectionCache: null }))
    expect(empty.goal).toBeNull()
    expect(empty.plan).toBeNull()
    expect(empty.todos).toBeNull()
  })
})
