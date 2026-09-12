/**
 * restore-session — 可恢复会话投影（纯函数）。
 *
 * 输入 adapter/sessions.ts 的 SessionSummary[] → 可恢复会话视图。
 * 不接管启动流程、不读 ctx——读取由装配层调 listSessions 后喂入。
 */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSummary } from './adapter/sessions.js'
import type { PickerItem } from './picker.js'
import { shortSessionLabel } from './session-label.js'

/** 可恢复会话视图行（live = 当前进程内仍活跃）。 */
export interface RestorableSession {
  id: SessionId
  createdAt: number
  cwd: string | undefined
  parentSession: SessionId | undefined
  /** Agent preset id（创建值 + 切换值 fold；未记录时 undefined）。 */
  agentPreset: string | undefined
  live: boolean
}

/** 投影/格式化选项。 */
export interface RestorableOptions {
  /** 当前时间戳（缺省 Date.now()）。 */
  now?: number
  /** 活跃会话 id 集合（live 标注）。 */
  liveIds?: ReadonlySet<SessionId>
  /** 展示行数上限；超出部分折叠为「… 还有 N 个会话」提示行（缺省或 ≤0 不限制）。 */
  maxRows?: number
}

/**
 * SessionSummary → 可恢复会话视图（顺序保持；liveIds 命中者标 live）。
 * @param sessions - 会话摘要列表（adapter/sessions.ts 输出）。
 * @param opts - 投影选项（取 liveIds）。
 * @returns 可恢复会话视图行。
 */
export function projectRestorableSessions(
  sessions: readonly SessionSummary[],
  opts: RestorableOptions = {},
): RestorableSession[] {
  const liveIds = opts.liveIds
  return sessions.map(s => ({
    id: s.id,
    createdAt: s.createdAt,
    cwd: s.cwd,
    parentSession: s.parentSession,
    agentPreset: s.agentPreset,
    live: liveIds !== undefined && liveIds.has(s.id),
  }))
}

const DAY_MS = 86_400_000

/**
 * 相对时间：<60s 刚刚 / <1h N 分钟前 / <24h N 小时前 / <7d N 天前 / ≥7d 日期。
 * @param createdAt - 会话创建时间戳（毫秒）。
 * @param now - 当前时间戳（毫秒）。
 * @returns 相对时间文本（≥7 天为 `YYYY-MM-DD`）。
 */
export function formatSessionAge(createdAt: number, now: number): string {
  // 宿主升级跨存储格式（如 0.1.5 起 v3/zstd）后，遗留会话目录可能列出
  // createdAt 缺失的摘要——渲染「未知时间」，绝不输出 NaN-NaN-NaN。
  if (!Number.isFinite(createdAt)) return '未知时间'
  const diff = now - createdAt
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < DAY_MS) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)} 天前`
  const d = new Date(createdAt)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 会话 id 的 8 位短引用（`#` 前缀，`session-` 前缀已剥离），欢迎页行用可读短 id 替代裸 UUID。 */
function shortId(id: SessionId): string {
  return shortSessionLabel(id)
}

/** cwd 的目录 basename（无尾斜杠）；空/根路径（无 basename）返回 undefined。 */
function basename(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd === '') return undefined
  const base = cwd.split('/').filter(Boolean).pop()
  return base === undefined || base === '' ? undefined : base
}

/**
 * 展示行：live ● / persisted ○ + 相对年龄 + cwd basename + 短 id + fork 短父 id
 * + agent preset（未记录不显示）；空列表占位提示。maxRows 限高时超出部分
 * 折叠为一行提示（「… 还有 N 个会话」）。
 * @param rows - 可恢复会话视图行。
 * @param opts - 格式化选项（取 now 与 maxRows）。
 * @returns 每会话一行的展示文本。
 */
export function formatRestorableSessions(
  rows: readonly RestorableSession[],
  opts: RestorableOptions = {},
): string[] {
  if (rows.length === 0) return ['（无可恢复会话）']
  const now = opts.now ?? Date.now()
  const maxRows = opts.maxRows !== undefined && opts.maxRows > 0 ? opts.maxRows : undefined
  const shown = maxRows !== undefined ? rows.slice(0, maxRows) : rows
  const out = shown.map((r) => {
    const parts: string[] = [`${r.live ? '●' : '○'} ${formatSessionAge(r.createdAt, now)}`]
    const base = basename(r.cwd)
    if (base !== undefined) parts.push(base)
    parts.push(`#${shortId(r.id)}`)
    if (!r.live && r.parentSession !== undefined) parts.push(`fork #${shortId(r.parentSession)}`)
    // agent preset 标注（恢复语义：preset 决定会话工具面，恢复时需知情）。
    if (r.agentPreset !== undefined && r.agentPreset !== '') parts.push(`preset:${r.agentPreset}`)
    return parts.join(' · ')
  })
  const hidden = rows.length - shown.length
  if (hidden > 0) out.push(`… 还有 ${hidden} 个会话`)
  return out
}

/** 会话时间线分组（本地日历日界）。 */
export type SessionAgeGroup = 'today' | 'yesterday' | 'week' | 'earlier'

/** 分组输出顺序：近 → 远。 */
export const SESSION_AGE_GROUP_ORDER = ['today', 'yesterday', 'week', 'earlier'] as const

const SESSION_AGE_GROUP_LABEL: Readonly<Record<SessionAgeGroup, string>> = {
  today: '今天',
  yesterday: '昨天',
  week: '本周',
  earlier: '更早',
}

/** 本地日 00:00（与分组同一日界）。 */
function startOfLocalDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 按本地日历把会话分到今天 / 昨天 / 本周 / 更早。
 * 本周 = 2–6 天前；未来时间（时钟偏移）归今天。
 */
export function sessionAgeGroup(createdAt: number, now: number): SessionAgeGroup {
  const dayDiff = Math.round((startOfLocalDay(now) - startOfLocalDay(createdAt)) / DAY_MS)
  if (dayDiff <= 0) return 'today'
  if (dayDiff === 1) return 'yesterday'
  if (dayDiff < 7) return 'week'
  return 'earlier'
}

/** 分组中文标签。 */
export function sessionAgeGroupLabel(group: SessionAgeGroup): string {
  return SESSION_AGE_GROUP_LABEL[group]
}

/** 一组同龄会话（空桶由 groupSessionsByAge 省略）。 */
export interface SessionAgeBucket<T> {
  group: SessionAgeGroup
  label: string
  items: T[]
}

/**
 * 按今天→昨天→本周→更早分桶；空桶省略；组内保持输入顺序。
 */
export function groupSessionsByAge<T extends { createdAt: number }>(
  rows: readonly T[],
  now: number,
): SessionAgeBucket<T>[] {
  const buckets = new Map<SessionAgeGroup, T[]>()
  for (const group of SESSION_AGE_GROUP_ORDER) buckets.set(group, [])
  for (const row of rows) {
    buckets.get(sessionAgeGroup(row.createdAt, now))!.push(row)
  }
  const out: SessionAgeBucket<T>[] = []
  for (const group of SESSION_AGE_GROUP_ORDER) {
    const items = buckets.get(group) ?? []
    if (items.length === 0) continue
    out.push({ group, label: sessionAgeGroupLabel(group), items })
  }
  return out
}

/** 选择器 / list 共用的会话摘要行。 */
export interface SessionPickerRow {
  id: string
  createdAt: number
  title: string
}

/**
 * 会话选择器条目：每组先不可选头（`今天 · N`），再会话行。
 * 当前会话只靠 `current`（●），标签不再写「（当前）」。
 */
export function buildSessionPickerItems(
  rows: readonly SessionPickerRow[],
  opts: { now: number; activeId?: string },
): { items: PickerItem[]; selectedIndex: number } {
  const items: PickerItem[] = []
  let selectedIndex = 0
  for (const bucket of groupSessionsByAge(rows, opts.now)) {
    items.push({
      label: `${bucket.label} · ${bucket.items.length}`,
      value: `header:${bucket.group}`,
      header: true,
    })
    for (const row of bucket.items) {
      const current = row.id === opts.activeId
      if (current) selectedIndex = items.length
      items.push({
        label: `#${shortSessionLabel(row.id)} · ${row.title} · ${formatSessionAge(row.createdAt, opts.now)}`,
        value: row.id,
        current,
      })
    }
  }
  return { items, selectedIndex }
}

/**
 * `/session list` 旧版打印：分组头 + `id · 标题 · ISO`。
 */
export function formatSessionListLines(
  rows: readonly SessionPickerRow[],
  now: number,
): string[] {
  const out: string[] = []
  for (const bucket of groupSessionsByAge(rows, now)) {
    out.push(`${bucket.label} · ${bucket.items.length}`)
    for (const row of bucket.items) {
      out.push(`${row.id} · ${row.title} · ${isoTimeOrUnknown(row.createdAt)}`)
    }
  }
  return out
}

/**
 * ISO 时间或「未知时间」。宿主升级跨存储格式（0.1.5 起 v3/zstd）后，遗留
 * 会话目录可能列出 createdAt 缺失的行——无效值绝不让整条 /session list
 * 崩在 `toISOString()` 的 RangeError 上（真机 0.1.5 实测）。
 */
function isoTimeOrUnknown(createdAt: number): string {
  if (!Number.isFinite(createdAt)) return '未知时间'
  const d = new Date(createdAt)
  return Number.isFinite(d.getTime()) ? d.toISOString() : '未知时间'
}
