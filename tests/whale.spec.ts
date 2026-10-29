/**
 * 欢迎页鲸鱼像素画（format/whale.ts）— 纯渲染契约测试。
 *
 * - 降级与兼容：窄屏/矮屏/无色返回空数组；full 档横向成对采样出图
 * - 半块渲染：仅 ▀▄█ 与空格；每行 RESET 收尾（无颜色泄漏）；行尾不补空格
 * - 色深轨：≥2 走品牌 hex（truecolor/256 量化），1 走命名 16 色
 * - 宽度守恒：任何出画宽度下每行显示宽度 ≤ width，且整块水平居中
 */

import chalk from 'chalk'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isColorSuppressed, setColorSuppressed } from '../src/engine/ansi.js'
import {
  formatWhaleLogo,
  WHALE_COLS,
  WHALE_MIN_COLS,
  WHALE_MIN_ROWS,
  WHALE_ROWS,
} from '../src/format/whale.js'
import { displayWidth } from '../src/width.js'

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

function plain(lines: readonly string[]): string[] {
  return lines.map(l => l.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, ''))
}

/** 出画基准输入（宽敞终端 + truecolor）。 */
function input(over: Partial<Parameters<typeof formatWhaleLogo>[0]> = {}) {
  return { width: 80, rows: 40, colorLevel: 3, ...over }
}

describe('formatWhaleLogo（降级矩阵）', () => {
  const savedAmbiguous = process.env.RIVET_AMBIGUOUS_WIDTH

  afterEach(() => {
    if (savedAmbiguous === undefined) delete process.env.RIVET_AMBIGUOUS_WIDTH
    else process.env.RIVET_AMBIGUOUS_WIDTH = savedAmbiguous
  })

  it(`窄屏（width < ${WHALE_MIN_COLS}）→ 空数组`, () => {
    expect(formatWhaleLogo(input({ width: WHALE_MIN_COLS - 1 }))).toEqual([])
  })

  it(`矮屏（rows < ${WHALE_MIN_ROWS}）→ 空数组`, () => {
    expect(formatWhaleLogo(input({ rows: WHALE_MIN_ROWS - 1 }))).toEqual([])
  })

  it('无色终端（colorLevel 0）→ 空数组', () => {
    expect(formatWhaleLogo(input({ colorLevel: 0 }))).toEqual([])
  })

  it('legacy conhost（ambiguous full 档）→ 横向成对采样出图且宽度守恒', () => {
    process.env.RIVET_AMBIGUOUS_WIDTH = 'full'
    const lines = formatWhaleLogo(input())
    expect(lines).toHaveLength(WHALE_ROWS)
    expect(lines.some(line => /[▀▄█]/.test(line))).toBe(true)
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(100)
  })

  it('full 档保留 BB..BB 尾鳍的构图坐标', () => {
    process.env.RIVET_AMBIGUOUS_WIDTH = 'full'
    const indent = Math.floor((80 - WHALE_COLS) / 2)
    expect(plain(formatWhaleLogo(input()))[0]).toBe(`${' '.repeat(indent + 16)}████`)
  })

  it('门禁边界值恰好满足 → 出画', () => {
    const lines = formatWhaleLogo(input({ width: WHALE_MIN_COLS, rows: WHALE_MIN_ROWS }))
    expect(lines.length).toBe(WHALE_ROWS)
  })
})

describe('formatWhaleLogo（半块渲染与宽度守恒）', () => {
  it('出画 WHALE_ROWS 行；仅 ▀▄█/空格；行尾 RESET 且不补空格', () => {
    const lines = formatWhaleLogo(input())
    expect(lines.length).toBe(WHALE_ROWS)
    for (const line of lines) {
      const text = plain([line])[0]!
      expect(text).toMatch(/^[ ▀▄█]*$/u)
      expect(text.endsWith(' ')).toBe(false) // 行尾透明段丢弃，不补空格
      expect(line.endsWith('\x1B[0m')).toBe(true)
    }
  })

  it('宽度守恒 + 居中：width 40–120 全扫，每行 ≤ width 且首列缩进符合居中', () => {
    for (let width = WHALE_MIN_COLS; width <= 120; width++) {
      const lines = formatWhaleLogo(input({ width }))
      const indent = Math.floor((width - WHALE_COLS) / 2)
      for (const line of lines) {
        expect(displayWidth(line)).toBeLessThanOrEqual(width)
        expect(plain([line])[0]!.startsWith(' '.repeat(indent))).toBe(true)
      }
    }
  })

  it('半块混色格出现（▀ 带前景+背景：白肚与蓝身边界）', () => {
    const lines = formatWhaleLogo(input())
    // 边界行应同时有 38（前景）与 48（背景）SGR
    const hasMixedCell = lines.some(l => l.includes('\x1B[38;2;') && l.includes('\x1B[48;2;'))
    expect(hasMixedCell).toBe(true)
  })

  it('透明格不携带背景色（避免半块 bg 泄漏成色带）', () => {
    const lines = formatWhaleLogo(input())
    for (const line of lines) {
      // 背景 SGR 后允许若干可见字符，但空格出现前必须先回默认背景（49）
      const bgSpans = line.split('\x1B[48;2;').slice(1)
      for (const span of bgSpans) {
        const spaceAt = span.indexOf(' ')
        if (spaceAt === -1) continue
        const before = span.slice(0, spaceAt)
        expect(before).toContain('\x1B[49m')
      }
    }
  })
})

describe('formatWhaleLogo（色深轨）', () => {
  const savedLevel = chalk.level

  afterEach(() => {
    chalk.level = savedLevel
  })

  it('level 3：品牌 hex 走 truecolor（38;2）', () => {
    const joined = formatWhaleLogo(input({ colorLevel: 3 })).join('\n')
    expect(joined).toContain('\x1B[38;2;')
    // 品牌蓝 #4d6bfe = 77,107,254
    expect(joined).toContain('\x1B[38;2;77;107;254m')
  })

  it('level 2：现场量化为 xterm-256（38;5）', () => {
    chalk.level = 2
    const joined = formatWhaleLogo(input({ colorLevel: 2 })).join('\n')
    expect(joined).toContain('\x1B[38;5;')
    expect(joined).not.toContain('\x1B[38;2;')
  })

  it('level 1：命名 16 色（身体 blueBright=94）', () => {
    const joined = formatWhaleLogo(input({ colorLevel: 1 })).join('\n')
    expect(joined).toContain('\x1B[94m')
    expect(joined).not.toContain('\x1B[38;2;')
    expect(joined).not.toContain('\x1B[38;5;')
  })

  it('眼睛/白肚/腮红品牌色在 truecolor 轨出现', () => {
    const joined = formatWhaleLogo(input({ colorLevel: 3 })).join('\n')
    expect(joined).toContain('\x1B[38;2;20;32;74m') // 眼 #14204a
    expect(joined).toContain('242;245;250') // 白肚 #f2f5fa（前景或背景）
    expect(joined).toContain('245;168;184') // 腮红 #f5a8b8
  })
})
