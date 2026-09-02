/**
 * star 模式欢迎英雄区（format/welcome.ts formatStarWelcomeHero）— 契约测试。
 *
 * - 降级矩阵：窄屏/矮屏/无色/full 宽度档/画已降级 → 空数组（调用方回落 retro）
 * - 布局：左抱星鲸鱼（品牌块锚定对齐）+ 右艺术字标题块（DeepSeek» / < Harness > /
 *   @tianshu·版本 / 环境行 / Tips）zip
 * - 宽度守恒：任何出画宽度下每行显示宽度 ≤ width
 */

import chalk from 'chalk'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isColorSuppressed, setColorSuppressed } from '../src/engine/ansi.js'
import type { RivetTheme } from '../src/theme.js'
import { displayWidth } from '../src/width.js'
import {
  CHROME_GUTTER,
  STAR_HERO_MIN_COLS,
  STAR_HERO_MIN_ROWS,
  STAR_TITLE_MAX_COLS,
  STAR_TITLE_MIN_COLS,
  formatStarWelcomeHero,
  type WelcomeEnvCheck,
  type WelcomeTipItem,
} from '../src/format/welcome.js'
import { formatStarWhaleLogo } from '../src/format/whale-star.js'

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

function starWhale(width: number): string[] {
  // 与生产一致：鲸鱼渲染宽度 = hero 宽度（app.ts 同参调用；宽度不一致时
  // 居中缩进与 hero 剥离量错配，画会被二次挪动）
  return formatStarWhaleLogo({ width, rows: 30, colorLevel: 3 })
}

function input(over: Partial<Parameters<typeof formatStarWelcomeHero>[0]> = {}) {
  const width = over.width ?? 100
  return {
    width, rows: 30, whale: starWhale(width), env, tips: tips(), colorLevel: 3, ...over,
  }
}

describe('formatStarWelcomeHero（降级矩阵）', () => {
  const savedAmbiguous = process.env.RIVET_AMBIGUOUS_WIDTH

  afterEach(() => {
    if (savedAmbiguous === undefined) delete process.env.RIVET_AMBIGUOUS_WIDTH
    else process.env.RIVET_AMBIGUOUS_WIDTH = savedAmbiguous
  })

  it(`窄屏（width < ${STAR_HERO_MIN_COLS}）→ 空数组`, () => {
    expect(formatStarWelcomeHero(input({ width: STAR_HERO_MIN_COLS - 1 }), fakeTheme())).toEqual([])
  })

  it(`矮屏（rows < ${STAR_HERO_MIN_ROWS}）→ 空数组`, () => {
    expect(formatStarWelcomeHero(input({ rows: STAR_HERO_MIN_ROWS - 1 }), fakeTheme())).toEqual([])
  })

  it('无色终端（colorLevel 0）→ 空数组', () => {
    expect(formatStarWelcomeHero(input({ colorLevel: 0 }), fakeTheme())).toEqual([])
  })

  it('画已降级（whale 空数组）→ 空数组', () => {
    expect(formatStarWelcomeHero(input({ whale: [] }), fakeTheme())).toEqual([])
  })

  it('legacy conhost（full 宽度档）→ 空数组', () => {
    process.env.RIVET_AMBIGUOUS_WIDTH = 'full'
    expect(formatStarWelcomeHero(input(), fakeTheme())).toEqual([])
  })

  it('门禁边界值恰好满足 → 出画', () => {
    const lines = formatStarWelcomeHero(input({ width: STAR_HERO_MIN_COLS, rows: STAR_HERO_MIN_ROWS }), fakeTheme())
    expect(lines.length).toBeGreaterThan(0)
  })
})

describe('formatStarWelcomeHero（布局与内容）', () => {
  it('右栏：艺术字标题块 + @tianshu·版本 + 环境行 + Tips，左栏鲸鱼同行 zip', () => {
    // 宽屏（120）：standard 标题档（下划线/斜杠艺术行；mini 档无下划线字形）
    const lines = formatStarWelcomeHero(input({ version: '0.1.2-rc.28', width: 120 }), fakeTheme())
    const text = plain(lines)
    // 标题块为 figlet 艺术字（下划线/斜杠行）；@tianshu 标识行含版本
    expect(text.some(l => l.includes('____'))).toBe(true)
    expect(text.some(l => l.includes('@tianshu · v0.1.2-rc.28'))).toBe(true)
    expect(text.some(l => l.includes('graphite · API Key ✓ · Git ✓'))).toBe(true)
    expect(text.some(l => l.includes('Tips'))).toBe(true)
    expect(text.some(l => l.includes('ctrl+n'))).toBe(true)
    // zip：第 0 行即含标题艺术行（左栏垂直居中垫空行时右栏仍出字）
    expect(text[0]).toContain('____')
    // 鲸鱼为半块像素画（▀▄█），出现在后续行
    expect(text.some(l => /[▀▄█]/.test(l))).toBe(true)
    // gutter：首列留白
    expect(text[0]!.startsWith(' '.repeat(CHROME_GUTTER))).toBe(true)
  })

  it('version 缺省：@tianshu 标识行不带版本', () => {
    const text = plain(formatStarWelcomeHero(input(), fakeTheme()))
    const tag = text.find(l => l.includes('@tianshu'))
    expect(tag).toBeDefined()
    expect(tag).not.toContain('· v')
  })

  it('左栏垂直对齐：以品牌块为锚，鲸鱼首行在画首（顶对齐）', () => {
    const text = plain(formatStarWelcomeHero(input(), fakeTheme()))
    const whaleFirst = text.findIndex(l => /[▀▄█]/.test(l))
    // 品牌块（标题+副标+标识 13 行）恒不高于画（21 行）→ topPad = 0；
    // 画首个文本行对可全透明（星光上方的留白），可见首行最多下延一行
    expect(whaleFirst).toBeLessThanOrEqual(1)
  })

  it('构图保真：星芒/喷水保持在画右侧（左栏只剥居中缩进，不动画内空格）', () => {
    const text = plain(formatStarWelcomeHero(input({ width: 120 }), fakeTheme()))
    const sparkle = text.find(l => /[▀▄]/.test(l))!
    // 星芒在画 cols 34+（gutter 2 后首个块字符 ≥ 32 列）；
    // 若画内前导空格被一并剥掉，星芒会被甩到左缘（stripLeadingSpaces 回归）
    expect(sparkle.search(/[▀▄]/)).toBeGreaterThanOrEqual(32)
  })

  it('标题块宽度常量与生成物实测一致', () => {
    // standard 档 50 / mini 档 34（welcome-title-frames.ts 生成物实测）
    expect(STAR_TITLE_MAX_COLS).toBe(50)
    expect(STAR_TITLE_MIN_COLS).toBe(34)
  })

  it('宽度守恒：92–140 全扫', () => {
    for (let width = STAR_HERO_MIN_COLS; width <= 140; width++) {
      const lines = formatStarWelcomeHero(input({ width }), fakeTheme())
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) {
        expect(displayWidth(line)).toBeLessThanOrEqual(width)
      }
    }
  })

  it('分段配色：标题 brandColor、› secondary、@tianshu muted', () => {
    const joined = formatStarWelcomeHero(input(), fakeTheme()).join('\n')
    expect(joined).toContain('238;238;238') // brandColor #eeeeee
    expect(joined).toContain('34;34;34') // secondary #222222
    expect(joined).toContain('119;119;119') // muted #777777
  })

  it('width ≤ 0 → 空数组', () => {
    expect(formatStarWelcomeHero(input({ width: 0 }), fakeTheme())).toEqual([])
  })
})
