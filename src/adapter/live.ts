/**
 * Live agent projection: derives a TUI-facing view of one agent's live state
 * from the `agent/*` event stream (`agent/status`, `agent/inbox/*`,
 * `agent/error`, `agent/disposed`). No new event vocabulary is invented and no
 * state is written back — the events are the fact source, this is a projection.
 *
 * Two layers mirror the transcript module: a pure fold (`emptyLiveState` /
 * `applyLiveEvent`) and a live subscription wrapper (`trackAgent`).
 *
 * @module @deepseek-ai/dsh-tianshu-tui/adapter/live
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentStatus } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId, UserMessage } from '@deepseek-ai/dsh-session'

/** One surfaced agent error with its in-turn position. */
export interface LiveError {
  readonly turn: number
  readonly step: number
  readonly error: unknown
}

/** The tool call currently executing, projected from `tool/call` until its `tool/result`. */
export interface LiveActivity {
  readonly callId: ToolCallId
  /** Tool name as the model produced it. */
  readonly name: string
  /** Raw arguments JSON string, exactly as the model produced it (unparsed). */
  readonly arguments: string
  readonly turn: number
  readonly step: number
}

/** The derived, read-only live state of one agent. */
export interface LiveAgentState {
  readonly id: SessionId
  /** The agent's lifecycle status (`idle` ⇄ `running`). */
  readonly status: AgentStatus
  /** Messages currently pending in the inbox, in insertion order. */
  readonly inbox: readonly UserMessage[]
  /** The last surfaced error; cleared when the agent next starts running. */
  readonly lastError: LiveError | undefined
  /** Whether the agent is still registered (unset on `agent/disposed`). */
  readonly live: boolean
  /** The tool call currently executing, or undefined when none is in flight. */
  readonly activity: LiveActivity | undefined
}

/**
 * An empty live state for `id`, with no event yet folded.
 * @param id - 被追踪的 agent/会话 id。
 * @returns idle、空 inbox、live=true 的初始状态。
 */
export function emptyLiveState(id: SessionId): LiveAgentState {
  return { id, status: 'idle', inbox: [], lastError: undefined, live: true, activity: undefined }
}

/** Remove a message by identity from the pending inbox list. */
function withoutMessage(inbox: readonly UserMessage[], id: string): readonly UserMessage[] {
  return inbox.filter(message => message.id !== id)
}

/**
 * Fold one agent-scoped event into the derived state. Returns a NEW state.
 * @param state - the previous derived state.
 * @param event - one discriminated agent event: status, inbox mutation,
 *   tool activity, error, or disposal. Payloads for other agents are filtered
 *   by the caller.
 * @returns the folded state.
 */
export function applyLiveEvent(
  state: LiveAgentState,
  event:
    | { type: 'status'; status: AgentStatus }
    | { type: 'inbox-inserted'; message: UserMessage }
    | { type: 'inbox-claimed'; messageId: string }
    | { type: 'inbox-discarded'; messageId: string }
    | { type: 'tool-call'; turn: number; step: number; callId: ToolCallId; name: string; arguments: string }
    | { type: 'tool-result'; callId: ToolCallId }
    | { type: 'error'; turn: number; step: number; error: unknown }
    | { type: 'disposed' },
): LiveAgentState {
  switch (event.type) {
    case 'status':
      // 进入 running 清掉上一轮的错误：错误已在 live 区展示，不随重试残留
      return event.status === 'running'
        ? { ...state, status: event.status, lastError: undefined }
        : { ...state, status: event.status }
    case 'inbox-inserted':
      return { ...state, inbox: [...state.inbox, event.message] }
    case 'inbox-claimed':
    case 'inbox-discarded':
      return { ...state, inbox: withoutMessage(state.inbox, event.messageId) }
    case 'tool-call':
      return {
        ...state,
        activity: { callId: event.callId, name: event.name, arguments: event.arguments, turn: event.turn, step: event.step },
      }
    case 'tool-result':
      return state.activity?.callId === event.callId
        ? { ...state, activity: undefined }
        : state
    case 'error':
      return { ...state, lastError: { turn: event.turn, step: event.step, error: event.error } }
    case 'disposed':
      return { ...state, live: false }
  }
}

/** A live projection bound to one agent id. */
export interface LiveAgent {
  /** The current derived state; refreshed after every folded event. */
  readonly state: LiveAgentState
  /** Detach the `agent/*` subscriptions. Safe once; idempotent. */
  dispose(): void
}

/**
 * Track one agent's live state. Seeds from the registry when the agent is
 * already live; thereafter folds every matching `agent/*` event. The caller
 * owns the agent handle it may hold — this projection never disposes it.
 * @param ctx - any context of the app; used to subscribe to `agent/*` events
 *   (globally dispatched, so events are filtered by agent id here).
 * @param id - the agent/session id to track.
 * @returns the live projection; call `dispose()` to detach.
 */
export function trackAgent(ctx: Context, id: SessionId): LiveAgent {
  const seeded = ctx.agents.get(id)
  let state: LiveAgentState = {
    ...emptyLiveState(id),
    status: seeded?.status ?? 'idle',
    live: seeded !== undefined,
    inbox: seeded === undefined
      ? []
      : [...seeded.inbox.nextTurn, ...seeded.inbox.nextStep],
  }

  const onStatus = ({ agent, status }: { agent: { id: SessionId }; status: AgentStatus }): void => {
    if (agent.id !== id) return
    state = applyLiveEvent(state, { type: 'status', status })
  }
  const onInserted = ({ agent, message }: { agent: { id: SessionId }; message: UserMessage }): void => {
    if (agent.id !== id) return
    state = applyLiveEvent(state, { type: 'inbox-inserted', message })
  }
  const onClaimed = ({ agent, message }: { agent: { id: SessionId }; message: UserMessage }): void => {
    if (agent.id !== id) return
    state = applyLiveEvent(state, { type: 'inbox-claimed', messageId: message.id })
  }
  const onDiscarded = ({ agent, message }: { agent: { id: SessionId }; message: UserMessage }): void => {
    if (agent.id !== id) return
    state = applyLiveEvent(state, { type: 'inbox-discarded', messageId: message.id })
  }
  const onError = ({ agent, turn, step, error }: { agent: { id: SessionId }; turn: number; step: number; error: unknown }): void => {
    if (agent.id !== id) return
    state = applyLiveEvent(state, { type: 'error', turn, step, error })
  }
  const onDisposed = ({ agent }: { agent: { id: SessionId } }): void => {
    if (agent.id !== id) return
    state = applyLiveEvent(state, { type: 'disposed' })
  }
  const onSessionEvent = (owner: { id: SessionId }, event: SessionEvent): void => {
    if (owner.id !== id) return
    switch (event.type) {
      case 'tool/call':
        state = applyLiveEvent(state, {
          type: 'tool-call',
          turn: event.data.turn,
          step: event.data.step,
          callId: event.data.callId,
          name: event.data.name,
          arguments: event.data.arguments,
        })
        break
      case 'tool/result':
        // ToolResultMessage 的 source 恒为 tool 源，callId 直接可取。
        state = applyLiveEvent(state, { type: 'tool-result', callId: event.data.message.source.callId })
        break
      default:
        // 其余 session 事件与活动投影无关。
        break
    }
  }

  const disposers = [
    ctx.on('agent/status', onStatus),
    ctx.on('agent/inbox/inserted', onInserted),
    ctx.on('agent/inbox/claimed', onClaimed),
    ctx.on('agent/inbox/discarded', onDiscarded),
    ctx.on('agent/error', onError),
    ctx.on('agent/disposed', onDisposed),
    ctx.on('session/event', onSessionEvent),
  ]

  return {
    get state(): LiveAgentState { return state },
    dispose(): void {
      for (const dispose of disposers) dispose()
    },
  }
}
