/**
 * blue 模式欢迎英雄区（format/welcome.ts formatBlueWelcomeHero）— 契约测试。
 *
 * - 降级与兼容：窄屏/矮屏/无色/画已降级 → 空数组；full 档隔点采样出图
 * - 布局：左蓝鲸抱星（品牌块锚定对齐）+ 右标题块（宽档 ANSI Shadow，
 *   中窄档 DeepSeek / Harness 文字 lockup / @tianshu·版本 / Tips / 环境行）zip
 * - 宽度守恒：任何出画宽度下每行显示宽度 ≤ width
 */

import chalk from 'chalk'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isColorSuppressed, setColorSuppressed } from '../src/engine/ansi.js'
import type { RivetTheme } from '../src/theme.js'
import { displayWidth } from '../src/width.js'
import {
  BLUE_HERO_MIN_COLS,
  BLUE_HERO_MIN_ROWS,
  BLUE_TITLE_MAX_COLS,
  BLUE_TITLE_MIN_COLS,
  CHROME_GUTTER,
  formatBlueWelcomeHero,
  type WelcomeEnvCheck,
  type WelcomeTipItem,
} from '../src/format/welcome.js'
import { BLUE_WHALE_COLS, formatBlueWhaleLogo } from '../src/format/whale-blue.js'
import { BLUE_TITLE_ART } from '../src/format/welcome-title-frames.js'

// 颜色断言须与运行环境无关：显式解除 NO_COLOR 压制并固定 truecolor 档，用后复原。
const savedSuppressed = isColorSuppressed()
const savedLevel = chalk.level
beforeEach(() => {
  setColorSuppressed(false)
  chalk.level = 3
})
afterAll(() => {
  setColorSuppressed(savedSuppressed)
  chalk.level = savedLevel
})

function fakeTheme(): RivetTheme {
  return {
    primary: '#111111', secondary: '#222222', success: '#333333',
    warning: '#444444', error: '#555555', dim: '#666666', muted: '#777777',
    pulseQuiet: '#888888', pulseActive: '#999999', pulseAlert: '#aaaaaa',
    userColor: '#bbbbbb', assistantColor: '#cccccc', systemColor: '#dddddd',
    brandColor: '#eeeeee', toolColor: () => '#000000', contextColor: () => '#000000',
  }
}

function plain(lines: readonly string[]): string[] {
  return lines.map(l => l.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, ''))
}

const env: WelcomeEnvCheck = { hasApiKey: true, isGitRepo: true, themeName: 'graphite', cols: 100 }

function tips(): WelcomeTipItem[] {
  return [
    { keyHint: 'ctrl+n', label: '新会话' },
    { keyHint: 'ctrl+s', label: '恢复会话' },
    { keyHint: 'ctrl+p', label: '命令面板' },
  ]
}

function blueWhale(width: number): string[] {
  // 与生产一致：鲸鱼渲染宽度 = hero 宽度（app.ts 同参调用；宽度不一致时
  // 居中缩进与 hero 剥离量错配，画会被二次挪动）
  return formatBlueWhaleLogo({ width, rows: 30, colorLevel: 3 })
}

function input(over: Partial<Parameters<typeof formatBlueWelcomeHero>[0]> = {}) {
  const width = over.width ?? 100
  return {
    width, rows: 30, whale: blueWhale(width), env, tips: tips(), colorLevel: 3, ...over,
  }
}

describe('formatBlueWelcomeHero（降级矩阵）', () => {
  const savedAmbiguous = process.env.RIVET_AMBIGUOUS_WIDTH

  afterEach(() => {
    if (savedAmbiguous === undefined) delete process.env.RIVET_AMBIGUOUS_WIDTH
    else process.env.RIVET_AMBIGUOUS_WIDTH = savedAmbiguous
  })

  it(`窄屏（width < ${BLUE_HERO_MIN_COLS}）→ 空数组`, () => {
    expect(formatBlueWelcomeHero(input({ width: BLUE_HERO_MIN_COLS - 1 }), fakeTheme())).toEqual([])
  })

  it(`矮屏（rows < ${BLUE_HERO_MIN_ROWS}）→ 空数组`, () => {
    expect(formatBlueWelcomeHero(input({ rows: BLUE_HERO_MIN_ROWS - 1 }), fakeTheme())).toEqual([])
  })

  it('无色终端（colorLevel 0）→ 空数组', () => {
    expect(formatBlueWelcomeHero(input({ colorLevel: 0 }), fakeTheme())).toEqual([])
  })

  it('画已降级（whale 空数组）→ 空数组', () => {
    expect(formatBlueWelcomeHero(input({ whale: [] }), fakeTheme())).toEqual([])
  })

  it('legacy conhost（full 宽度档）→ 文字标题 + 隔点像素，坐标与宽度守恒', () => {
    process.env.RIVET_AMBIGUOUS_WIDTH = 'full'
    const width = 120
    const whale = blueWhale(width)
    const lines = formatBlueWelcomeHero(input({ width, whale }), fakeTheme())
    const text = plain(lines)
    expect(lines.length).toBeGreaterThan(0)
    expect(text.some(line => /[▀▄█]/.test(line))).toBe(true)
    expect(text.some(line => line.includes('DeepSeek'))).toBe(true)
    expect(text.some(line => line.includes('Harness'))).toBe(true)
    expect(text.join('\n')).not.toContain('╗')
    const title = text.find(line => line.includes('DeepSeek'))!
    const indent = Math.max(0, Math.floor((width - BLUE_WHALE_COLS) / 2))
    const leftW = Math.max(0, ...whale.map(line => {
      const leading = line.match(/^ */)?.[0].length ?? 0
      return displayWidth(line.slice(Math.min(indent, leading)))
    }))
    expect(title.startsWith(' '.repeat(CHROME_GUTTER))).toBe(true)
    expect(displayWidth(title.slice(0, title.indexOf('DeepSeek')))).toBe(CHROME_GUTTER + leftW + 3)
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(width)
  })

  it('门禁边界值恰好满足 → 出画', () => {
    const lines = formatBlueWelcomeHero(input({ width: BLUE_HERO_MIN_COLS, rows: BLUE_HERO_MIN_ROWS }), fakeTheme())
    expect(lines.length).toBeGreaterThan(0)
  })
})

describe('formatBlueWelcomeHero（布局与内容）', () => {
  it('右栏：完整艺术标题 + @tianshu·版本 + Tips + 环境，左栏鲸鱼同行 zip', () => {
    const lines = formatBlueWelcomeHero(input({ version: '0.1.2-rc.28', width: 120 }), fakeTheme())
    const text = plain(lines)
    for (const artLine of [...BLUE_TITLE_ART.wide.title, ...BLUE_TITLE_ART.wide.subtitle]) {
      expect(text.some(line => line.includes(artLine))).toBe(true)
    }
    expect(text.some(l => l.includes('@tianshu · v0.1.2-rc.28'))).toBe(true)
    expect(text.some(l => l.includes('graphite · API Key ✓ · Git ✓'))).toBe(true)
    expect(text.some(l => l.includes('Tips'))).toBe(true)
    expect(text.some(l => l.includes('ctrl+n'))).toBe(true)
    expect(text.findIndex(l => l.includes('API Key'))).toBeGreaterThan(text.findIndex(l => l.includes('Tips')))
    // zip：第 0 行即含标题艺术行（左栏垂直居中垫空行时右栏仍出字）
    expect(text[0]).toContain('██')
    expect(text.some(l => /[▀▄]/.test(l))).toBe(true)
    expect(text[0]!.startsWith(' '.repeat(CHROME_GUTTER))).toBe(true)
  })

  it('version 缺省：@tianshu 标识行不带版本', () => {
    const text = plain(formatBlueWelcomeHero(input(), fakeTheme()))
    const tag = text.find(l => l.includes('@tianshu'))
    expect(tag).toBeDefined()
    expect(tag).not.toContain('· v')
  })

  it('左栏垂直对齐：以品牌块为锚，鲸鱼首行在画首（顶对齐）', () => {
    const text = plain(formatBlueWelcomeHero(input(), fakeTheme()))
    const whaleFirst = text.findIndex(l => /[▀▄]/.test(l))
    // 品牌块（标题 6+1+副标 1+标识 1 = 9 行）恒不高于画（17 行）→ topPad = 0；
    // 画首个文本行可含全透明对（气泡上方留白），可见首行最多下延一行
    expect(whaleFirst).toBeLessThanOrEqual(1)
  })

  it('构图保真：气泡/喷水保持在画右侧（左栏只剥居中缩进，不动画内空格）', () => {
    const text = plain(formatBlueWelcomeHero(input({ width: 120 }), fakeTheme()))
    const sparkle = text.find(l => /[▀▄]/.test(l))!
    // 画首行内容为右上角气泡（画内 col 36+，gutter 2 后首个块字符 ≥ 32 列）；
    // 若画内前导空格被一并剥掉，气泡会被甩到左缘（stripLeadingSpaces 回归）
    expect(sparkle.search(/[▀▄]/)).toBeGreaterThanOrEqual(32)
  })

  it('标题块宽度常量与生成物实测一致', () => {
    // wide 档 64（ANSI Shadow）/ mini 档 33（welcome-title-frames.ts 生成物实测）
    expect(BLUE_TITLE_MAX_COLS).toBe(64)
    expect(BLUE_TITLE_MIN_COLS).toBe(33)
  })

  it('标题选档：wide 放不下时用完整 DeepSeek / Harness 文字 lockup', () => {
    const wide = plain(formatBlueWelcomeHero(input({ width: 120, rows: 27 }), fakeTheme()))
    expect(wide.some(l => l.includes('╗'))).toBe(true)
    for (const width of [99, BLUE_HERO_MIN_COLS]) {
      const text = plain(formatBlueWelcomeHero(input({ width }), fakeTheme()))
      expect(text.some(l => l.includes('DeepSeek'))).toBe(true)
      expect(text.some(l => l.includes('Harness'))).toBe(true)
      expect(text.join('\n')).not.toContain('____')
      expect(text.join('\n')).not.toContain('|_')
      expect(text.join('\n')).not.toContain('╗')
    }
  })

  it('高度选档：wide 右栏 + 11 超预算时落文字档，足够时保留 wide', () => {
    const compactTitle = plain(formatBlueWelcomeHero(input({ width: 120, rows: 26 }), fakeTheme()))
    expect(compactTitle.some(l => l.includes('DeepSeek'))).toBe(true)
    expect(compactTitle.join('\n')).not.toContain('╗')
    const wideTitle = plain(formatBlueWelcomeHero(input({ width: 120, rows: 27 }), fakeTheme()))
    expect(wideTitle.join('\n')).toContain('╗')
  })

  it('缺 key 时窄右栏换行仍保留完整行动指引', () => {
    const lines = formatBlueWelcomeHero(input({
      width: BLUE_HERO_MIN_COLS,
      env: { ...env, hasApiKey: false },
    }), fakeTheme())
    const text = plain(lines).join('\n')
    expect(text).toContain('DEEPSEEK_API_KEY')
    expect(text).toContain('/key')
    expect(text.indexOf('Tips')).toBeLessThan(text.indexOf('API Key'))
  })

  it('宽度守恒：82–140 全扫', () => {
    for (let width = BLUE_HERO_MIN_COLS; width <= 140; width++) {
      const lines = formatBlueWelcomeHero(input({ width }), fakeTheme())
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) {
        expect(displayWidth(line)).toBeLessThanOrEqual(width)
      }
    }
  })

  it('分段配色：标题 brandColor、副标 secondary、@tianshu muted', () => {
    const joined = formatBlueWelcomeHero(input(), fakeTheme()).join('\n')
    expect(joined).toContain('238;238;238') // brandColor #eeeeee
    expect(joined).toContain('34;34;34') // secondary #222222
    expect(joined).toContain('119;119;119') // muted #777777
  })

  it('width ≤ 0 → 空数组', () => {
    expect(formatBlueWelcomeHero(input({ width: 0 }), fakeTheme())).toEqual([])
  })
})
