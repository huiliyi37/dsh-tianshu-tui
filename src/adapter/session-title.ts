/**
 * Session title surface — `/session list` 每行展示的会话标题。
 *
 * 只读纯函数层。数据源是官方 harness 的 log-backed `session/title` 事件
 * （`@deepseek-ai/dsh-session-title` 服务写入；LLM 标题由装配在 dsh-base 的
 * `session-title-llm` provider 在会话活跃时自动生成，first-prompt cadence）。
 * TUI 不做任何生成：不调 API、不写 sidecar、不发明事件——「纯展示层」纪律与
 * 「所有渲染状态派生自会话事件」在本模块保持成立（dsh-base 装配见宿主
 * cordis.patch.yml：session-title + session-title-llm）。
 *
 * 展示优先级：
 * 1. seed 边界（`session/end-seed`，fork/恢复标记）之后本会话自己的标题事件
 *    或首条真人消息——同父 fork 不再撞父标题；
 * 2. 全量折叠的最新 `session/title` 事件（fallback / LLM provider / 用户 rename 源）；
 * 3. 确定性 fallback——首条真人消息的前几个词（与 dsh-base 装配配置
 *    `fallbackMaxWords: 5` / `fallbackMaxBytes: 40` 对齐；历史会话无标题事件
 *    时免费可用，纯函数现算、不落盘）；
 * 4. 无任何真人聊天记录 → {@link EMPTY_TITLE}。
 *
 * @module @deepseek-ai/dsh-tianshu-tui/adapter/session-title
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { fallbackSessionTitle, foldSessionTitle } from '@deepseek-ai/dsh-session-title'

/** 无任何真人聊天记录的会话直接展示的占位标题（状态而非内容）。 */
export const EMPTY_TITLE = '新对话'
/** fallback 词数上限（与 dsh-base 装配的 session-title config 对齐）。 */
export const FALLBACK_MAX_WORDS = 5
/** fallback 字节上限（与 dsh-base 装配的 session-title config 对齐）。 */
export const FALLBACK_MAX_BYTES = 40

/**
 * 计算一个会话在 `/session list` 中的展示标题。
 * 纯函数、同步、无副作用：fold 官方标题事件 → 确定性 fallback → 「新对话」。
 * @param events - 会话事件日志（live 或持久化重放）。
 * @returns 展示标题（恒非空）。
 */
/**
 * 从事件日志折叠展示标题（官方标题 fold → 首条真人消息确定性 fallback）。
 * @param events - 会话事件日志（live 或持久化重放）。
 * @returns 展示标题；无任何可用来源时 undefined。
 */
function titleFromEvents(events: readonly SessionEvent[]): string | undefined {
  const folded = foldSessionTitle(events)
  if (folded !== undefined) return folded.title
  /* v8 ignore next -- firstUserMessageText 恒返回 string | undefined */
  const first = firstUserMessageText(events)
  if (first === undefined) return undefined
  return fallbackSessionTitle(first, FALLBACK_MAX_WORDS, FALLBACK_MAX_BYTES)
}

/**
 * 首条真人消息文本（collectSessionTitleMessages 的本地同语义折叠：rc.1 起
 * dsh-session-title 不再公开该导出）。过滤 user/message 且 source.kind==='user'，
 * 文本块按行拼接，全空白跳过。
 */
function firstUserMessageText(events: readonly SessionEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const text = event.data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    if (text.trim().length === 0) continue
    return text
  }
  return undefined
}

/**
 * 计算一个会话在 `/session list` 中的展示标题。
 * 纯函数、同步、无副作用：seed 边界后的自有标题 → 全量 fold → 确定性
 * fallback → 「新对话」。
 * @param events - 会话事件日志（live 或持久化重放）。
 * @returns 展示标题（恒非空）。
 */
export function sessionTitleFor(events: readonly SessionEvent[]): string {
  // fork/seed 边界（session/end-seed）：边界之后是本会话自己的内容。fork 有
  // 自己的标题或真人消息时优先展示，否则同父 fork 全撞父标题。边界后无自有
  // 内容（未活跃的 fork；恢复会话的边界在日志末尾）回退全量折叠，行为不变。
  const boundary = events.findLastIndex(event => event.type === 'session/end-seed')
  if (boundary >= 0) {
    const own = titleFromEvents(events.slice(boundary + 1))
    if (own !== undefined) return own
  }
  // 全量折叠：无标题事件的历史会话（标题服务上线前创建）或标题尚未生成时，
  // 取首条真人消息的确定性 fallback。
  return titleFromEvents(events) ?? EMPTY_TITLE
}
