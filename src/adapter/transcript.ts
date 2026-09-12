/**
 * Read-only transcript projection: derives a TUI-facing conversation view from
 * the session log. The session log is the authoritative fact source; this
 * module never appends to it and invents no new event vocabulary — every
 * projected fact traces to one {@link SessionEvent} of the canonical
 * {@link SessionEventMap}.
 *
 * Two layers: a pure, immutable fold (`emptyTranscript` / `applyTranscriptEvent`)
 * that is trivially unit-testable, and a live subscription wrapper
 * (`createTranscript`) that replays the session's existing log and then folds
 * every `session/event` publication for that session.
 *
 * @module @deepseek-ai/dsh-tianshu-tui/adapter/transcript
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallId, ContentBlock } from '@deepseek-ai/dsh-llm'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

/** One completed message row on the TUI surface. */
export interface TranscriptMessage {
  /** The event's seq in the session log (monotonic ordering key). */
  readonly seq: number
  /** Unix epoch milliseconds, from the source event. */
  readonly time: number
  /** Which side of the conversation produced this row. */
  readonly kind: 'user' | 'assistant'
  /** Owning turn; `undefined` only for events outside a turn. */
  readonly turn: number
  /** Owning step; `undefined` outside a step. */
  readonly step: number | undefined
  /** Human-readable text folded from the message's `text` content blocks. */
  readonly text: string
  /** Reasoning folded from the message's `reasoning` blocks; `''` when none (and for user rows). */
  readonly reasoning: string
  /** The exact source event — the durable fact this row projects. */
  readonly event: SessionEvent
}

/** One tool invocation on the TUI surface, paired call → result. */
export interface TranscriptToolCall {
  /** Stable call identity shared by `tool/call` and `tool/result`. */
  readonly callId: ToolCallId
  /** Tool name exactly as the model requested it. */
  readonly name: string
  /** Raw arguments JSON exactly as the model produced it. */
  readonly arguments: string
  readonly turn: number
  readonly step: number
  /** The `tool/call` event's seq — the card's position when interleaving with messages. */
  readonly seq: number
  /** The `tool/call` event's time (Unix epoch ms) — settled-card elapsed derives from `result.time - time`. */
  readonly time: number
  /** The paired `tool/result`, present once the call completed. */
  readonly result: SessionEvent<'tool/result'> | undefined
  /** Internal failure identity carried by the result, when one exists. */
  readonly error: { readonly name: string; readonly code: string } | undefined
}

/** In-progress assistant output being aggregated from `assistant/chunk` events. */
export interface TranscriptStream {
  readonly turn: number
  readonly step: number
  /** Visible text accumulated so far from `text-delta` chunks only. */
  readonly text: string
  /** Reasoning accumulated so far from `reasoning-delta` chunks only. */
  readonly reasoning: string
}

/** The immutable, derived transcript state for one session. */
export interface TranscriptView {
  readonly sessionId: SessionId
  /** Completed user and assistant messages, in log order. */
  readonly messages: readonly TranscriptMessage[]
  /** The chunk stream still awaiting its `assistant/message`, if any. */
  readonly streaming: TranscriptStream | undefined
  /** Tool invocations in the order their `tool/call` appeared. */
  readonly tools: readonly TranscriptToolCall[]
  /** The turn opened by the latest `turn/start`, or -1 before any opens. */
  readonly turn: number
  /** Time of the first message folded under the current turn (glance elapsed
   *  data source; O(1) alternative to scanning `messages` for `turn === turn`).
   *  Reset by `turn/start`, set by the first user/assistant message of the turn. */
  readonly firstInTurnTime: number | undefined
  /** The highest event seq folded so far. */
  readonly seq: number
}

/**
 * An empty transcript view for `sessionId`, before any event is folded.
 * @param sessionId - 视图所属的会话 id。
 * @returns 空消息/空工具、turn 与 seq 均为 -1 的初始视图。
 */
export function emptyTranscript(sessionId: SessionId): TranscriptView {
  return { sessionId, messages: [], streaming: undefined, tools: [], turn: -1, firstInTurnTime: undefined, seq: -1 }
}

/** Fold the text-bearing blocks of a message's content into one display string. */
function foldText(content: readonly ContentBlock[]): string {
  let out = ''
  for (const block of content) {
    if (block.type === 'text') out += block.text
  }
  return out
}

/** Fold the reasoning blocks of a message's content into one display string (kept apart from text). */
function foldReasoning(content: readonly ContentBlock[]): string {
  let out = ''
  for (const block of content) {
    if (block.type === 'reasoning') out += block.text
  }
  return out
}

/**
 * Fold one committed session event into the derived view. Returns a NEW view.
 * @param view - 折叠前的视图（不被就地修改）。
 * @param event - 已提交的会话事件。
 * @returns 折叠后的新视图；与投影无关的事件只推进 seq 水位。
 */
export function applyTranscriptEvent(view: TranscriptView, event: SessionEvent): TranscriptView {
  const base = { ...view, seq: event.seq }
  switch (event.type) {
    case 'user/message': {
      const row: TranscriptMessage = {
        seq: event.seq,
        time: event.time,
        kind: 'user',
        turn: view.turn,
        step: undefined,
        text: foldText(event.data.content),
        reasoning: '',
        event,
      }
      return {
        ...base,
        messages: [...base.messages, row],
        // 当前 turn 的首条消息（user 恒折叠在 view.turn 下）：记录时间供
        // glance elapsed 使用；同 turn 后续消息不覆盖。
        ...(base.firstInTurnTime === undefined ? { firstInTurnTime: event.time } : {}),
      }
    }
    case 'assistant/attempt': {
      // 0.1.5：逐 delta 的 assistant/chunk 改为批量 attempt（压缩流记录），
      // 经官方 expandAssistantStream 展开后按同款语义折叠。
      const { turn, step } = event.data
      // Visible text and reasoning accumulate on separate lanes: mixing them
      // would leak the model's draft stream into the rendered answer.
      // A batch for a different step opens a fresh aggregation; same step accumulates.
      let acc = base.streaming !== undefined && base.streaming.turn === turn && base.streaming.step === step
        ? { ...base.streaming }
        : { turn, step, text: '', reasoning: '' }
      for (const { chunk } of expandAssistantStream(event.data.stream)) {
        if (chunk.type === 'text-delta') acc = { ...acc, text: acc.text + chunk.text }
        else if (chunk.type === 'reasoning-delta') acc = { ...acc, reasoning: acc.reasoning + chunk.text }
      }
      return { ...base, streaming: acc }
    }
    case 'assistant/message': {
      const { turn, step, message } = event.data
      const row: TranscriptMessage = {
        seq: event.seq,
        time: event.time,
        kind: 'assistant',
        turn,
        step,
        text: foldText(message.content),
        reasoning: foldReasoning(message.content),
        event,
      }
      // The matching chunk stream is closed by its assembled message.
      const streaming = base.streaming !== undefined && base.streaming.turn === turn && base.streaming.step === step
        ? undefined
        : base.streaming
      return {
        ...base,
        messages: [...base.messages, row],
        streaming,
        // 当前 turn 的首条 assistant 消息（turn 与 view.turn 对齐时）：
        // 记录时间供 glance elapsed 使用；跨 turn 迟到的消息不记录。
        ...(row.turn === base.turn && base.firstInTurnTime === undefined ? { firstInTurnTime: event.time } : {}),
      }
    }
    case 'tool/call': {
      const { callId, name, arguments: raw, turn, step } = event.data
      const tool: TranscriptToolCall = {
        callId, name, arguments: raw, turn, step,
        seq: event.seq, time: event.time,
        result: undefined, error: undefined,
      }
      return { ...base, tools: [...base.tools, tool] }
    }
    case 'tool/result': {
      // The paired block carries the call identity as `toolCallId`.
      const { toolCallId: callId } = event.data.message.content[0]
      const tools = base.tools.map((tool) => {
        if (tool.callId !== callId) return tool
        return {
          ...tool,
          result: event,
          ...(event.data.error === undefined ? {} : { error: event.data.error }),
        }
      })
      return { ...base, tools }
    }
    case 'turn/start':
      // Open the turn so a following `user/message` folds under its number.
      // 新 turn 的首条消息时间从零重新计时（glance elapsed 数据源）。
      return { ...base, turn: event.data.turn, firstInTurnTime: undefined }
    // Boundary markers and log-only bookkeeping advance the fold watermark only.
    default:
      return base
  }
}

/**
 * A live transcript projection bound to one session: replays the session's
 * existing log, then folds each `session/event` publication for that session.
 * Read-only — never appends to the log and never disposes the session.
 */
export interface Transcript {
  /** The current derived view; refreshed after every folded event. */
  readonly view: TranscriptView
  /** Detach the `session/event` subscription. Safe to call once; idempotent. */
  dispose(): void
}

/**
 * Create a live transcript projection for one session.
 * @param ctx - any context of the app; used to subscribe to `session/event`.
 * @param session - the live session whose log is projected. Its existing
 *   `events` are folded at creation (replay); later appends arrive via the
 *   `session/event` firehose, filtered by session id.
 * @returns the live projection; call `dispose()` to detach its subscription.
 */
export function createTranscript(ctx: Context, session: Session): Transcript {
  let view = emptyTranscript(session.id)
  for (const event of session.snapshotEvents()) view = applyTranscriptEvent(view, event)
  const handler = (owner: Session, event: SessionEvent): void => {
    if (owner.id !== session.id) return
    view = applyTranscriptEvent(view, event)
  }
  const dispose = ctx.on('session/event', handler)
  return {
    get view(): TranscriptView { return view },
    dispose(): void { dispose() },
  }
}
