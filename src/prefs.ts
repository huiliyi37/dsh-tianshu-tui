/**
 * 本地偏好持久化层 — ~/.dsh-tui/prefs.json（theme/density/preset/常驻面板/glance/footerInfo/notifyOs）。
 *
 * 设计约束：
 * - 容错优先：损坏/缺失/未知 key 静默降级为空偏好（缺省 = 现行为），绝不阻塞启动。
 * - 原子写：tmp + rename（同 update-cache 模式），写失败 best-effort 静默。
 * - 测试密封门：VITEST 环境默认不落真实 home（沿 self-update 的 env 判定先例）；
 *   显式传 path（测试 tmp 目录）时才启用读写。
 *
 * @module @huiliyi37/dsh-tianshu-tui/prefs
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** glance 可隐藏段（model/stalled 为身份/告警段，永不可隐藏）。 */
export const GLANCE_HIDEABLE_SEGMENTS = ['effort', 'cache', 'context', 'tokens', 'elapsed', 'cost'] as const
export type GlanceHideableSegment = (typeof GLANCE_HIDEABLE_SEGMENTS)[number]

/** 常驻监控面板（可持久化显隐；config/skills 等模态面板不持久化）。 */
export const PERSISTED_PANELS = ['subagents', 'workflow'] as const
export type PersistedPanel = (typeof PERSISTED_PANELS)[number]

/** 输入区信息密度档位（footerInfo）：full 两行 / compact 仅状态行 / off 全关。 */
export const FOOTER_INFO_LEVELS = ['full', 'compact', 'off'] as const
export type FooterInfoLevel = (typeof FOOTER_INFO_LEVELS)[number]

/** 欢迎页风格档位：blue 新版蓝鲸抱星（默认）/ star 紫鲸举星 / retro 复古小鲸鱼。 */
export const WELCOME_STYLES = ['blue', 'star', 'retro'] as const
export type WelcomeStyle = (typeof WELCOME_STYLES)[number]

/** 偏好文件形状（全部可选；未知 key 读取时丢弃，前向兼容）。 */
export interface TuiPrefs {
  /** 主题名（内置名 | custom:<name> | 'auto'）。 */
  theme?: string
  /** 紧凑工具卡渲染（/density）。 */
  compactMode?: boolean
  /** 常驻监控面板启动显隐。 */
  panels?: Partial<Record<PersistedPanel, boolean>>
  /** glance/footer 隐藏段。 */
  glance?: { hideSegments?: GlanceHideableSegment[] }
  /** 输入区信息密度（缺省 full：状态行 + 指标行）。 */
  footerInfo?: FooterInfoLevel
  /** 首次运行 onboarding 已展示（欢迎页一次性引导；缺省未展示）。 */
  onboarded?: boolean
  /** 新会话默认 agent 预设 id（/preset … default）。 */
  preset?: string
  /** 后台完成时发系统通知（缺省开；false 关闭）。 */
  notifyOs?: boolean
  /** vim 编辑键位（/vim default 持久化；缺省 false）。 */
  vimEnabled?: boolean
  /** vim insert 两键序列→Esc 映射（如 {"jj":"esc"}；值仅支持 esc，见 insert-remap.ts）。 */
  vimInsertRemaps?: Record<string, string>
  /** fish 式历史建议 ghost（缺省开；false 关闭；接受手势 →）。 */
  ghostSuggest?: boolean
  /** scrollback 缓冲行数上限（缺省 1000；调高增加内存与 replay 成本）。 */
  scrollbackMaxLines?: number
  /** 欢迎页风格（缺省 blue 蓝鲸新版；star 紫鲸 / retro 复古小鲸鱼；/welcome 切换，下次启动生效）。 */
  welcomeStyle?: WelcomeStyle
}

/** 缺省偏好（= 现行为）。 */
export const DEFAULT_PREFS: Readonly<TuiPrefs> = {}

export function defaultPrefsPath(): string {
  return join(homedir(), '.dsh-tui', 'prefs.json')
}

function isHideableSegment(v: unknown): v is GlanceHideableSegment {
  return typeof v === 'string' && (GLANCE_HIDEABLE_SEGMENTS as readonly string[]).includes(v)
}

/** 解析偏好文本：非法 JSON / 非对象 / 字段形状不对 → 逐项丢弃，永不抛。 */
export function parsePrefs(text: string): TuiPrefs {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return {}
  }
  if (typeof raw !== 'object' || raw === null) return {}
  const obj = raw as Record<string, unknown>
  const prefs: TuiPrefs = {}
  if (typeof obj.theme === 'string' && obj.theme !== '') prefs.theme = obj.theme
  if (typeof obj.preset === 'string' && obj.preset !== '') prefs.preset = obj.preset
  if (typeof obj.compactMode === 'boolean') prefs.compactMode = obj.compactMode
  if (typeof obj.onboarded === 'boolean') prefs.onboarded = obj.onboarded
  if (typeof obj.footerInfo === 'string' && (FOOTER_INFO_LEVELS as readonly string[]).includes(obj.footerInfo)) {
    prefs.footerInfo = obj.footerInfo as FooterInfoLevel
  }
  if (typeof obj.notifyOs === 'boolean') prefs.notifyOs = obj.notifyOs
  if (typeof obj.ghostSuggest === 'boolean') prefs.ghostSuggest = obj.ghostSuggest
  if (typeof obj.welcomeStyle === 'string' && (WELCOME_STYLES as readonly string[]).includes(obj.welcomeStyle)) {
    prefs.welcomeStyle = obj.welcomeStyle as WelcomeStyle
  }
  if (typeof obj.scrollbackMaxLines === 'number'
    && Number.isInteger(obj.scrollbackMaxLines)
    && obj.scrollbackMaxLines >= 1) {
    prefs.scrollbackMaxLines = obj.scrollbackMaxLines
  }
  if (typeof obj.vimEnabled === 'boolean') prefs.vimEnabled = obj.vimEnabled
  if (typeof obj.vimInsertRemaps === 'object' && obj.vimInsertRemaps !== null && !Array.isArray(obj.vimInsertRemaps)) {
    const remaps: Record<string, string> = {}
    for (const [key, value] of Object.entries(obj.vimInsertRemaps as Record<string, unknown>)) {
      if (value === 'esc' && [...key].length === 2) remaps[key] = 'esc'
    }
    if (Object.keys(remaps).length > 0) prefs.vimInsertRemaps = remaps
  }
  if (typeof obj.panels === 'object' && obj.panels !== null) {
    const p = obj.panels as Record<string, unknown>
    const panels: Partial<Record<PersistedPanel, boolean>> = {}
    for (const k of PERSISTED_PANELS) {
      if (typeof p[k] === 'boolean') panels[k] = p[k] as boolean
    }
    if (Object.keys(panels).length > 0) prefs.panels = panels
  }
  if (typeof obj.glance === 'object' && obj.glance !== null) {
    const g = obj.glance as Record<string, unknown>
    if (Array.isArray(g.hideSegments)) {
      const segs = g.hideSegments.filter(isHideableSegment)
      if (segs.length > 0) prefs.glance = { hideSegments: segs }
    }
  }
  return prefs
}

/** 读偏好；缺失/损坏 → 空偏好。 */
export function readPrefs(path: string): TuiPrefs {
  try {
    return parsePrefs(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

/** 原子写偏好（tmp + rename）；失败静默（偏好是优化不是正确性依赖）。 */
export function writePrefs(path: string, prefs: TuiPrefs): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`)
    renameSync(tmp, path)
  } catch {
    // best-effort：磁盘不可写时保持会话态（不持久化但功能不受影响）
  }
}

/**
 * 测试密封门：VITEST 下默认不读写真实 home——显式 path（测试 tmp）优先，
 * 其次 env 未设 VITEST（生产），否则 null（禁用）。
 * 调用方以 `resolvePrefsPath(explicit)` 归一：undefined+VITEST → null。
 */
export function prefsEnabled(explicitPath: string | null | undefined): string | null {
  if (explicitPath !== undefined) return explicitPath
  const env = process.env
  if (env.VITEST === 'true' || env.VITEST === '1') return null
  return defaultPrefsPath()
}
