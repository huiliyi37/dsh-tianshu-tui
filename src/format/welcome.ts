/**
 * 启动欢迎面（format/welcome.ts）— 纯渲染。
 *
 * blue/star 首屏为左鲸鱼 + 右品牌 / Tips / 环境；像素门禁不满足时
 * 回落紧凑单列左对齐。显式 retro 保留旧双列与居中叠放布局。输入轨
 * 由 format/input-frame 承担，本模块只出欢迎块。
 * 宽度守恒：任何输入下每行显示宽度 ≤ width。
 */
import chalk from 'chalk'
import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { ambiguousWidthMode, displayWidth, truncateToDisplayWidth, wrapToDisplayWidth } from '../width.js'
import { WHALE_COLS } from './whale.js'
import { STAR_WHALE_COLS } from './whale-star.js'
import { BLUE_WHALE_COLS } from './whale-blue.js'
import { BLUE_TITLE_ART, STAR_TITLE_ART, type StarTitleArtVariant } from './welcome-title-frames.js'

function truncateTo(text: string, columns: number): string {
  let out = ''
  for (const ch of text) {
    if (displayWidth(out + ch) > columns) break
    out += ch
  }
  return out
}

/** 在 width 内水平居中（左侧填充；右侧不补，宽度守恒即 ≤ width）。 */
function center(text: string, width: number): string {
  const left = Math.max(0, Math.floor((width - displayWidth(text)) / 2))
  return `${' '.repeat(left)}${text}`
}

/** 右侧空格补到 width；超宽 ANSI 安全截断。 */
function padTo(text: string, width: number): string {
  const w = displayWidth(text)
  if (w >= width) return truncateToDisplayWidth(text, width)
  return `${text}${' '.repeat(width - w)}`
}

/** 鲸鱼行剥离恰好 indent 列居中缩进（居中由 format*WhaleLogo 烘焙进每行）。
 * 只剥缩进、不动画内前导空格——画内空格是构图（星芒/气泡/喷水位置），
 * 一并剥掉会把右侧内容甩到左缘（stripLeadingSpaces 曾把星图撕散）。
 * 仅 star 鲸鱼用；retro 见 stripLeadingSpaces。 */
function stripIndent(line: string, indent: number): string {
  let i = 0
  while (i < line.length && i < indent && line[i] === ' ') i++
  return line.slice(i)
}

/** retro 鲸鱼行全剥前导空格——RELEASE 起 retro 的既有形态（左对齐紧凑），
 * CHANGELOG 承诺 retro 画与此前逐字节一致，不可因 star 修复波及。 */
function stripLeadingSpaces(line: string): string {
  let i = 0
  while (i < line.length && line[i] === ' ') i++
  return line.slice(i)
}

/** formatBrandWelcome 的渲染输入。 */
export interface FormatBrandWelcomeInput {
  width: number
  /** 品牌名（缺省 'dsh-tianshu-tui'）。 */
  brand?: string
  /** 副标题（缺省 'DeepSeek Harness'）。 */
  subtitle?: string
  /** 插件版本号（提供时副标题行追加 ` · v<version>`；缺省不追加）。 */
  version?: string
  /** 水平对齐；hero 左栏用 left，窄屏叠放用 center（缺省）。 */
  align?: 'center' | 'left'
}

/**
 * 欢迎页品牌区：主标 brand（BOLD brandColor）+ 副标题（muted），各一行。
 * @param input - 宽度、品牌名、副标题与对齐。
 * @param theme - 当前主题（主标 brandColor BOLD，副标题 muted）。
 * @returns 两行 ANSI；width ≤ 0 返回空数组。
 */
export function formatBrandWelcome(input: FormatBrandWelcomeInput, theme: RivetTheme): string[] {
  if (input.width <= 0) return []
  const brand = truncateTo(input.brand ?? 'dsh-tianshu-tui', input.width)
  const subtitle = truncateTo(
    `${input.subtitle ?? 'DeepSeek Harness'}${input.version === undefined ? '' : ` · v${input.version}`}`,
    input.width,
  )
  const brandLine = color(brand, theme.brandColor, { bold: true })
  const subLine = color(subtitle, theme.muted)
  if (input.align === 'left') return [brandLine, subLine]
  return [center(brandLine, input.width), center(subLine, input.width)]
}

/**
 * 首次启动环境检查结果，供欢迎页环境行使用。
 */
export interface WelcomeEnvCheck {
  /** API key 是否已配置（env / credentials 文件 / .env 分层，非仅环境变量）。 */
  hasApiKey: boolean
  /** 当前目录是否为 git 仓库（git status 可执行）。 */
  isGitRepo: boolean
  /** 当前主题引用名（如 'graphite'，环境行首段展示）。 */
  themeName: string
  /** 终端列数（宽度预算）。 */
  cols: number
  /** 水平对齐；hero 左栏用 left，窄屏叠放用 center（缺省）。 */
  align?: 'center' | 'left'
}

/**
 * 环境检查行：`graphite · API Key ✓ · Git ✓`。
 * 缺 API key 时增加「设 DEEPSEEK_API_KEY 或运行 /key」行动段，warning 色；
 * 超宽按段换行而不是截断行动指引。git ✗ 仅信息性展示。
 * @param env - 环境检查结果（主题名/API key/git/对齐）。
 * @param theme - 当前主题（muted；缺 key 段 warning）。
 * @returns ANSI 行数组；cols ≤ 0 返回空数组。
 */
export function formatEnvCheckLine(env: WelcomeEnvCheck, theme: RivetTheme): string[] {
  if (env.cols <= 0) return []
  interface EnvSegment {
    text: string
    warning?: boolean
  }
  const segments: EnvSegment[] = [
    { text: env.themeName },
    { text: env.hasApiKey ? 'API Key ✓' : 'API Key ✗', ...(!env.hasApiKey ? { warning: true } : {}) },
    ...(!env.hasApiKey ? [{ text: '设 DEEPSEEK_API_KEY 或运行 /key', warning: true }] : []),
    { text: `Git ${env.isGitRepo ? '✓' : '✗'}` },
  ]
  const separator = ' · '
  const separatorWidth = displayWidth(separator)
  const lines: EnvSegment[][] = []
  let current: EnvSegment[] = []
  let currentWidth = 0
  const flush = (): void => {
    if (current.length === 0) return
    lines.push(current)
    current = []
    currentWidth = 0
  }
  for (const segment of segments) {
    const segmentWidth = displayWidth(segment.text)
    const sepWidth = current.length > 0 ? separatorWidth : 0
    if (currentWidth + sepWidth + segmentWidth <= env.cols) {
      current.push(segment)
      currentWidth += sepWidth + segmentWidth
      continue
    }
    flush()
    if (segmentWidth <= env.cols) {
      current = [segment]
      currentWidth = segmentWidth
      continue
    }
    const chunks = wrapToDisplayWidth(segment.text, env.cols)
    for (let i = 0; i < chunks.length - 1; i++) {
      lines.push([{ ...segment, text: chunks[i]! }])
    }
    const last = chunks.at(-1) ?? ''
    current = [{ ...segment, text: last }]
    currentWidth = displayWidth(last)
  }
  flush()
  const sep = color(separator, theme.muted)
  return lines.map(parts => {
    const line = parts.map((part, index) =>
      `${index > 0 ? sep : ''}${color(part.text, part.warning === true ? theme.warning : theme.muted)}`,
    ).join('')
    return env.align === 'left' ? line : center(line, env.cols)
  })
}

/** 欢迎页 Tips 一项（快捷键 + 说明；不可用项整行 muted）。 */
export interface WelcomeTipItem {
  /** 快捷键（如 'ctrl+n'、'/'）。 */
  keyHint: string
  /** 说明（如 '新会话'）。 */
  label: string
  /** 可用性；false 时整行 muted（如无可恢复会话）。 */
  available?: boolean
}

/** formatWelcomeTips 的渲染输入。 */
export interface FormatWelcomeTipsInput {
  width: number
  items: readonly WelcomeTipItem[]
  /** 水平对齐；宽屏右栏 left，窄屏叠放 center（缺省 left）。 */
  align?: 'center' | 'left'
}

/** 欢迎页行动项上限（动态 /key、/help 也计入）。 */
export const WELCOME_TIPS_MAX_ITEMS = 4

/**
 * 欢迎页 Tips：普通字重 muted 标题 + 快捷键列对齐 + 说明，最多四项。
 * 不可用项整行 muted 且仍显示 keyHint（与旧菜单不同：tips 要让用户知道键还在）。
 * 空 items 仍渲染标题（调用方恒有一组默认 tips）。
 * @param input - 宽度、tips 项与对齐。
 * @param theme - 当前主题（标题/说明 muted，hint secondary）。
 * @returns ANSI 行数组。
 */
export function formatWelcomeTips(input: FormatWelcomeTipsInput, theme: RivetTheme): string[] {
  const { width } = input
  const items = input.items.slice(0, WELCOME_TIPS_MAX_ITEMS)
  if (width <= 0) return []
  const budget = Math.max(0, width - 1)
  let hintCol = 0
  for (const item of items) {
    hintCol = Math.max(hintCol, displayWidth(item.keyHint))
  }
  const rows: string[] = []
  rows.push(color('Tips', theme.muted))
  for (const item of items) {
    const hintPad = Math.max(0, hintCol - displayWidth(item.keyHint))
    const hintText = `${item.keyHint}${' '.repeat(hintPad)}`
    const body = `${hintText}  ${item.label}`
    const truncated = truncateTo(body, budget)
    if (item.available === false) {
      rows.push(color(truncated, theme.muted))
      continue
    }
    const hintPart = color(hintText, theme.secondary)
    const labelPart = color(`  ${truncateTo(item.label, Math.max(0, budget - hintCol - 2))}`, theme.muted)
    rows.push(displayWidth(body) > budget ? color(truncated, theme.muted) : `${hintPart}${labelPart}`)
  }
  if (input.align === 'center') {
    let blockW = 0
    for (const row of rows) blockW = Math.max(blockW, displayWidth(row))
    blockW = Math.min(blockW, budget)
    const indent = ' '.repeat(Math.max(0, Math.floor((width - blockW) / 2)))
    return rows.map(row => truncateToDisplayWidth(`${indent}${row}`, budget))
  }
  return rows.map(row => truncateToDisplayWidth(row, budget))
}

/** 宽屏左品牌 / 右 tips 的最小列数。 */
export const WELCOME_HERO_WIDE_MIN = 72

/** 欢迎区 / live chrome 左侧留白（列）。避免鲸鱼、品牌、输入轨贴边。 */
export const CHROME_GUTTER = 2

/** 左右栏间隙列数。 */
const HERO_GAP = 3

/** 右栏 tips 放不下时回落叠放的最小宽度。 */
const TIPS_MIN_WIDTH = 18

/** formatWelcomeHero 的渲染输入。 */
export interface FormatWelcomeHeroInput {
  width: number
  /** 已渲染的鲸鱼行（可能为空：窄屏/无色/legacy 降级）。 */
  whale: readonly string[]
  env: WelcomeEnvCheck
  tips: readonly WelcomeTipItem[]
  /** 插件版本号（透传 formatBrandWelcome 副标题行）。 */
  version?: string
}

/**
 * 欢迎英雄区：宽屏左鲸鱼/品牌/环境 + 右 Tips zip；窄屏垂直居中叠放。
 * @param input - 终端宽、鲸鱼行、环境检查、tips 项。
 * @param theme - 当前主题。
 * @returns ANSI 行数组；width ≤ 0 返回空数组。
 */
export function formatWelcomeHero(input: FormatWelcomeHeroInput, theme: RivetTheme): string[] {
  const { width, whale, tips } = input
  if (width <= 0) return []
  const env = { ...input.env, cols: width }

  const stacked = (): string[] => {
    const out: string[] = []
    if (whale.length > 0) {
      out.push(...whale)
      out.push('')
    }
    out.push(...formatBrandWelcome({ width, align: 'center', ...(input.version === undefined ? {} : { version: input.version }) }, theme))
    out.push('')
    out.push(...formatEnvCheckLine({ ...env, cols: width, align: 'center' }, theme))
    out.push('')
    out.push(...formatWelcomeTips({ width, items: tips, align: 'center' }, theme))
    return out
  }

  if (width < WELCOME_HERO_WIDE_MIN) return stacked()

  const gutter = width >= CHROME_GUTTER * 2 + TIPS_MIN_WIDTH ? CHROME_GUTTER : 0
  const inner = width - gutter
  const brand = formatBrandWelcome({ width: inner, align: 'left', ...(input.version === undefined ? {} : { version: input.version }) }, theme)
  const envLeft = formatEnvCheckLine({ ...env, cols: inner, align: 'left' }, theme)
  const whaleStripped = whale.map(stripLeadingSpaces)
  let leftW = WHALE_COLS
  for (const line of [...whaleStripped, ...brand, ...envLeft]) {
    leftW = Math.max(leftW, displayWidth(line))
  }
  const rightW = inner - leftW - HERO_GAP
  if (rightW < TIPS_MIN_WIDTH) return stacked()

  const leftCol: string[] = []
  if (whaleStripped.length > 0) {
    leftCol.push(...whaleStripped)
    leftCol.push('')
  }
  leftCol.push(...brand)
  leftCol.push(...envLeft)

  const rightCol = formatWelcomeTips({ width: rightW, items: tips, align: 'left' }, theme)
  const rows = Math.max(leftCol.length, rightCol.length)
  const gap = ' '.repeat(HERO_GAP)
  const pad = ' '.repeat(gutter)
  const out: string[] = []
  for (let i = 0; i < rows; i++) {
    const left = padTo(leftCol[i] ?? '', leftW)
    const right = rightCol[i] ?? ''
    out.push(truncateToDisplayWidth(`${pad}${left}${gap}${right}`, width))
  }
  return out
}

/**
 * blue/star 像素门禁不满足时的紧凑单列：文字品牌 → Tips → 环境，整体左对齐。
 * 不携带鲸鱼，也不改变显式 retro 的居中/双列旧布局。
 */
export function formatCompactWelcomeHero(input: Omit<FormatWelcomeHeroInput, 'whale'>, theme: RivetTheme): string[] {
  const { width } = input
  if (width <= 0) return []
  const gutter = width >= CHROME_GUTTER * 2 + TIPS_MIN_WIDTH ? CHROME_GUTTER : 0
  const inner = width - gutter
  const pad = ' '.repeat(gutter)
  const out = [
    ...formatBrandWelcome({ width: inner, align: 'left', ...(input.version === undefined ? {} : { version: input.version }) }, theme),
    '',
    ...formatWelcomeTips({ width: inner, items: input.tips, align: 'left' }, theme),
    '',
    ...formatEnvCheckLine({ ...input.env, cols: inner, align: 'left' }, theme),
  ]
  return out.map(line => truncateToDisplayWidth(`${pad}${line}`, width))
}

/** star 标题块宽度：standard 宽档 / mini 窄档（生成物实测，welcome-title-frames.ts）。 */
export const STAR_TITLE_MAX_COLS = STAR_TITLE_ART.standard.width
export const STAR_TITLE_MIN_COLS = STAR_TITLE_ART.mini.width

/** star hero 宽屏门禁最小列数（gutter + 画 + 间隙 + 标题窄档）。 */
export const STAR_HERO_MIN_COLS = CHROME_GUTTER + STAR_WHALE_COLS + HERO_GAP + STAR_TITLE_MIN_COLS

/** star hero 静态矮屏门禁；选档另校验右栏高度 + 11 的整页预算。 */
export const STAR_HERO_MIN_ROWS = 24

/** blue 生成物标题宽度常量；运行时中窄档改用 DeepSeek / Harness 文字 lockup。 */
export const BLUE_TITLE_MAX_COLS = BLUE_TITLE_ART.wide.width
export const BLUE_TITLE_MIN_COLS = BLUE_TITLE_ART.mini.width

/** blue hero 宽屏门禁最小列数（沿用既有像素布局门禁）。 */
export const BLUE_HERO_MIN_COLS = CHROME_GUTTER + BLUE_WHALE_COLS + HERO_GAP + BLUE_TITLE_MIN_COLS

/** blue hero 静态矮屏门禁；选档另校验右栏高度 + 11 的整页预算。 */
export const BLUE_HERO_MIN_ROWS = 24

/** formatStarWelcomeHero / formatBlueWelcomeHero 的渲染输入。 */
export interface FormatStarWelcomeHeroInput {
  width: number
  /** 终端行数（矮屏门禁）。 */
  rows: number
  /** 已渲染的抱星鲸鱼行（空数组 = 画已降级，由调用方走紧凑单列）。 */
  whale: readonly string[]
  env: WelcomeEnvCheck
  tips: readonly WelcomeTipItem[]
  /** 插件版本号（附在 @tianshu 标识行尾）。 */
  version?: string
  /** 颜色能力等级（缺省 chalk.level）；0 不出画（艺术字/像素画无色无层次）。 */
  colorLevel?: number
}

/** formatBlueWelcomeHero 的渲染输入（与 star 同形）。 */
export type FormatBlueWelcomeHeroInput = FormatStarWelcomeHeroInput

const BLUE_TEXT_TITLE_ART: StarTitleArtVariant = {
  title: ['DeepSeek'],
  subtitle: ['Harness'],
  width: 8,
}

/** 顶栏、间距、输入轨等非 hero 行预算。 */
const PIXEL_HERO_PAGE_CHROME_ROWS = 11

/** 像素画 hero 规格：画宽 + 标题档位 + 门禁（star/blue 共用布局）。 */
interface PixelHeroSpec {
  /** 像素画文本列数（居中缩进计算基准）。 */
  readonly whaleCols: number
  /** 标题档位（宽→窄；逐行实测 displayWidth，并校验右栏整页高度）。 */
  readonly artTiers: readonly StarTitleArtVariant[]
  /** full 宽度档可用标题；blue 借此排除双宽块字符的 ANSI Shadow。 */
  readonly fullArtTiers?: readonly StarTitleArtVariant[]
  /** 宽屏门禁最小列数。 */
  readonly minCols: number
  /** 矮屏门禁最小行数。 */
  readonly minRows: number
}

/**
 * 像素画欢迎英雄区（star/blue 共用布局）：左鲸鱼 + 右标题块
 * （主标 / 副标 / @tianshu·版本 / Tips / 环境行）zip。左栏相对右栏
 * 以品牌块为锚垂直居中。标题按当前宽度模式的逐行 displayWidth 与
 * 「右栏高度 + 11 ≤ rows」宽→窄选首个合适档；无合适档返回空数组，
 * 由调用方选择紧凑单列。full 档保留隔点采样像素画。
 * 宽度守恒：任何输出行 displayWidth ≤ width。
 */
function formatPixelWelcomeHero(input: FormatStarWelcomeHeroInput, theme: RivetTheme, spec: PixelHeroSpec): string[] {
  const { width, whale, tips } = input
  if (width <= 0) return []
  if (width < spec.minCols || input.rows < spec.minRows) return []
  if (whale.length === 0) return []
  const level = input.colorLevel ?? chalk.level
  if (level < 1) return []

  const env = { ...input.env, cols: width }
  const gutter = CHROME_GUTTER
  const inner = width - gutter
  const whaleIndent = Math.max(0, Math.floor((width - spec.whaleCols) / 2))
  const whaleStripped = whale.map(l => stripIndent(l, whaleIndent))
  let leftW = 0
  for (const line of whaleStripped) leftW = Math.max(leftW, displayWidth(line))
  const rightW = inner - leftW - HERO_GAP
  const tiers = ambiguousWidthMode() === 'full' ? (spec.fullArtTiers ?? spec.artTiers) : spec.artTiers
  let art: StarTitleArtVariant | undefined
  let rightCol: string[] = []
  for (const candidate of tiers) {
    const artWidth = Math.max(0, ...[...candidate.title, ...candidate.subtitle].map(line => displayWidth(line)))
    if (artWidth > rightW) continue
    const candidateCol: string[] = []
    for (const line of candidate.title) candidateCol.push(color(line, theme.brandColor, { bold: true }))
    candidateCol.push('')
    for (const line of candidate.subtitle) candidateCol.push(color(line, theme.secondary))
    const tag = `@tianshu${input.version === undefined ? '' : ` · v${input.version}`}`
    candidateCol.push(color(truncateTo(tag, rightW), theme.muted))
    candidateCol.push('')
    candidateCol.push(...formatWelcomeTips({ width: rightW, items: tips, align: 'left' }, theme))
    candidateCol.push('')
    candidateCol.push(...formatEnvCheckLine({ ...env, cols: rightW, align: 'left' }, theme))
    if (candidateCol.length + PIXEL_HERO_PAGE_CHROME_ROWS > input.rows) continue
    art = candidate
    rightCol = candidateCol
    break
  }
  if (art === undefined) return []

  // 左栏垂直对齐：以品牌块（标题 + 副标 + 标识行）为锚居中——按整根右栏
  // （含 Tips / 环境）居中会让画明显低于标题视觉中心，观感「歪」。画比品牌块高时
  // topPad=0，画顶对齐标题顶。
  const rows = Math.max(whaleStripped.length, rightCol.length)
  const brandRows = art.title.length + 1 + art.subtitle.length + 1
  const topPad = Math.max(0, Math.floor((brandRows - whaleStripped.length) / 2))
  const leftCol: string[] = []
  for (let i = 0; i < topPad; i++) leftCol.push('')
  leftCol.push(...whaleStripped)

  const gap = ' '.repeat(HERO_GAP)
  const pad = ' '.repeat(gutter)
  const out: string[] = []
  for (let i = 0; i < rows; i++) {
    const left = padTo(leftCol[i] ?? '', leftW)
    const right = rightCol[i] ?? ''
    out.push(truncateToDisplayWidth(`${pad}${left}${gap}${right}`, width))
  }
  return out
}

/**
 * star 模式欢迎英雄区：左抱星鲸鱼（紫）+ 右艺术字标题块（DeepSeek» /
 * < Harness > / @tianshu·版本 / Tips / 环境行）zip。布局/降级矩阵见
 * formatPixelWelcomeHero；门禁常量 STAR_HERO_MIN_COLS / STAR_HERO_MIN_ROWS。
 * @param input - 终端尺寸、鲸鱼行、环境检查、tips 项。
 * @param theme - 当前主题（标题 brandColor BOLD、副标 secondary、标识/环境 muted）。
 * @returns ANSI 行数组；降级时空数组。
 */
export function formatStarWelcomeHero(input: FormatStarWelcomeHeroInput, theme: RivetTheme): string[] {
  return formatPixelWelcomeHero(input, theme, {
    whaleCols: STAR_WHALE_COLS,
    artTiers: [STAR_TITLE_ART.standard, STAR_TITLE_ART.mini],
    minCols: STAR_HERO_MIN_COLS,
    minRows: STAR_HERO_MIN_ROWS,
  })
}

/**
 * blue 模式欢迎英雄区（默认风格）：左蓝鲸抱星 + 右标题块
 * （DeepSeek / Harness / @tianshu·版本 / Tips / 环境行）zip。
 * 宽档使用 ANSI Shadow；中窄档使用简洁 DeepSeek / Harness 文字 lockup，
 * full 宽度档不用双宽块字符 ANSI Shadow。布局/降级矩阵见
 * formatPixelWelcomeHero；门禁常量 BLUE_HERO_MIN_COLS / BLUE_HERO_MIN_ROWS。
 * @param input - 终端尺寸、鲸鱼行、环境检查、tips 项。
 * @param theme - 当前主题（标题 brandColor BOLD、副标 secondary、标识/环境 muted）。
 * @returns ANSI 行数组；降级时空数组。
 */
export function formatBlueWelcomeHero(input: FormatBlueWelcomeHeroInput, theme: RivetTheme): string[] {
  return formatPixelWelcomeHero(input, theme, {
    whaleCols: BLUE_WHALE_COLS,
    artTiers: [BLUE_TITLE_ART.wide, BLUE_TEXT_TITLE_ART],
    fullArtTiers: [BLUE_TEXT_TITLE_ART],
    minCols: BLUE_HERO_MIN_COLS,
    minRows: BLUE_HERO_MIN_ROWS,
  })
}
