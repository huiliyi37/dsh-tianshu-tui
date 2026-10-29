/**
 * star 模式欢迎英雄区（format/welcome.ts formatStarWelcomeHero）— 契约测试。
 *
 * - 降级与兼容：窄屏/矮屏/无色/画已降级 → 空数组；full 档隔点采样出图
 * - 布局：左抱星鲸鱼（品牌块锚定对齐）+ 右艺术字标题块（DeepSeek» / < Harness > /
 *   @tianshu·版本 / Tips / 环境行）zip
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
import { STAR_TITLE_ART } from '../src/format/welcome-title-frames.js'

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

  it('legacy conhost（full 宽度档）→ 完整 mini 标题 + 隔点像素，宽度守恒', () => {
    process.env.RIVET_AMBIGUOUS_WIDTH = 'full'
    const lines = formatStarWelcomeHero(input(), fakeTheme())
    const text = plain(lines)
    expect(lines.length).toBeGreaterThan(0)
    expect(text.some(line => /[▀▄█]/.test(line))).toBe(true)
    for (const artLine of [...STAR_TITLE_ART.mini.title, ...STAR_TITLE_ART.mini.subtitle]) {
      expect(text.some(line => line.includes(artLine))).toBe(true)
    }
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(100)
  })

  it('门禁边界满足且 mini 右栏 + 11 行预算可容纳 → 出画', () => {
    const lines = formatStarWelcomeHero(input({ width: STAR_HERO_MIN_COLS, rows: 26 }), fakeTheme())
    expect(lines.length).toBeGreaterThan(0)
    expect(plain(lines).some(line => line.includes('|_'))).toBe(true)
  })
})

describe('formatStarWelcomeHero（布局与内容）', () => {
  it('右栏：完整艺术标题 + @tianshu·版本 + Tips + 环境，左栏鲸鱼同行 zip', () => {
    const lines = formatStarWelcomeHero(input({ version: '0.1.2-rc.28', width: 120, rows: 31 }), fakeTheme())
    const text = plain(lines)
    for (const artLine of [...STAR_TITLE_ART.standard.title, ...STAR_TITLE_ART.standard.subtitle]) {
      expect(text.some(line => line.includes(artLine))).toBe(true)
    }
    expect(text.some(l => l.includes('@tianshu · v0.1.2-rc.28'))).toBe(true)
    expect(text.some(l => l.includes('graphite · API Key ✓ · Git ✓'))).toBe(true)
    expect(text.some(l => l.includes('Tips'))).toBe(true)
    expect(text.some(l => l.includes('ctrl+n'))).toBe(true)
    expect(text.findIndex(l => l.includes('API Key'))).toBeGreaterThan(text.findIndex(l => l.includes('Tips')))
    expect(text[0]).toContain('____')
    expect(text.some(l => /[▀▄█]/.test(l))).toBe(true)
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

  it('宽高选档：standard 高超预算时完整回落 mini，高度足够再选 standard', () => {
    const mini = plain(formatStarWelcomeHero(input({ width: 120, rows: 30 }), fakeTheme()))
    for (const artLine of [...STAR_TITLE_ART.mini.title, ...STAR_TITLE_ART.mini.subtitle]) {
      expect(mini.some(line => line.includes(artLine))).toBe(true)
    }
    expect(mini.join('\n')).not.toContain('____')
    const standard = plain(formatStarWelcomeHero(input({ width: 120, rows: 31 }), fakeTheme()))
    for (const artLine of [...STAR_TITLE_ART.standard.title, ...STAR_TITLE_ART.standard.subtitle]) {
      expect(standard.some(line => line.includes(artLine))).toBe(true)
    }
  })

  it('缺 key 时环境在 Tips 后且完整保留行动指引', () => {
    const lines = formatStarWelcomeHero(input({
      env: { ...env, hasApiKey: false },
    }), fakeTheme())
    const text = plain(lines).join('\n')
    expect(text).toContain('DEEPSEEK_API_KEY')
    expect(text).toContain('/key')
    expect(text.indexOf('Tips')).toBeLessThan(text.indexOf('API Key'))
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
