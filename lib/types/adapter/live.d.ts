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
import type { Context } from '@deepseek-ai/cordis';
import type { AgentStatus } from '@deepseek-ai/dsh-agent';
import type { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session';
/** One surfaced agent error with its in-turn position. */
export interface LiveError {
    readonly turn: number;
    readonly step: number;
    readonly error: unknown;
}
/** The tool call currently executing, projected from `tool/call` until its `tool/result`. */
export interface LiveActivity {
    readonly callId: ToolCallId;
    /** Tool name as the model produced it. */
    readonly name: string;
    /** Raw arguments JSON string, exactly as the model produced it (unparsed). */
    readonly arguments: string;
    readonly turn: number;
    readonly step: number;
}
/** The derived, read-only live state of one agent. */
export interface LiveAgentState {
    readonly id: SessionId;
    /** The agent's lifecycle status (`idle` ⇄ `running`). */
    readonly status: AgentStatus;
    /** Messages currently pending in the inbox, in insertion order. */
    readonly inbox: readonly UserMessage[];
    /** The last surfaced error; cleared when the agent next starts running. */
    readonly lastError: LiveError | undefined;
    /** Whether the agent is still registered (unset on `agent/disposed`). */
    readonly live: boolean;
    /** The tool call currently executing, or undefined when none is in flight. */
    readonly activity: LiveActivity | undefined;
}
/**
 * An empty live state for `id`, with no event yet folded.
 * @param id - 被追踪的 agent/会话 id。
 * @returns idle、空 inbox、live=true 的初始状态。
 */
export declare function emptyLiveState(id: SessionId): LiveAgentState;
/**
 * Fold one agent-scoped event into the derived state. Returns a NEW state.
 * @param state - the previous derived state.
 * @param event - one discriminated agent event: status, inbox mutation,
 *   tool activity, error, or disposal. Payloads for other agents are filtered
 *   by the caller.
 * @returns the folded state.
 */
export declare function applyLiveEvent(state: LiveAgentState, event: {
    type: 'status';
    status: AgentStatus;
} | {
    type: 'inbox-inserted';
    message: UserMessage;
} | {
    type: 'inbox-claimed';
    messageId: string;
} | {
    type: 'inbox-discarded';
    messageId: string;
} | {
    type: 'tool-call';
    turn: number;
    step: number;
    callId: ToolCallId;
    name: string;
    arguments: string;
} | {
    type: 'tool-result';
    callId: ToolCallId;
} | {
    type: 'error';
    turn: number;
    step: number;
    error: unknown;
} | {
    type: 'disposed';
}): LiveAgentState;
/** A live projection bound to one agent id. */
export interface LiveAgent {
    /** The current derived state; refreshed after every folded event. */
    readonly state: LiveAgentState;
    /** Detach the `agent/*` subscriptions. Safe once; idempotent. */
    dispose(): void;
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
export declare function trackAgent(ctx: Context, id: SessionId): LiveAgent;
