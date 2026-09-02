/**
 * 抱星鲸鱼像素画（format/whale-star.ts）— 纯渲染契约测试。
 *
 * - 降级矩阵：窄屏/矮屏/无色/legacy conhost（full 宽度档）均返回空数组
 * - 半块渲染：仅 ▀▄█ 与空格；每行 RESET 收尾；行尾不补空格
 * - 色深轨：≥2 走品牌 hex，1 走现场最近邻 ANSI16（调色板变更免维护）
 * - 宽度守恒：任何出画宽度下每行显示宽度 ≤ width，且整块水平居中
 */

import chalk from 'chalk'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isColorSuppressed, setColorSuppressed } from '../src/engine/ansi.js'
import {
  formatStarWhaleLogo,
  STAR_WHALE_COLS,
  STAR_WHALE_MIN_COLS,
  STAR_WHALE_MIN_ROWS,
  STAR_WHALE_ROWS,
} from '../src/format/whale-star.js'
import { displayWidth } from '../src/width.js'

// 颜色断言须与运行环境无关：显式解除 NO_COLOR 压制并固定 truecolor 档，
// 全部测试结束后复原（NO_COLOR 语义本身由 theme-contrast.spec 覆盖）。
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
function input(over: Partial<Parameters<typeof formatStarWhaleLogo>[0]> = {}) {
  return { width: 100, rows: 40, colorLevel: 3, ...over }
}

describe('formatStarWhaleLogo（降级矩阵）', () => {
  const savedAmbiguous = process.env.RIVET_AMBIGUOUS_WIDTH

  afterEach(() => {
    if (savedAmbiguous === undefined) delete process.env.RIVET_AMBIGUOUS_WIDTH
    else process.env.RIVET_AMBIGUOUS_WIDTH = savedAmbiguous
  })

  it(`窄屏（width < ${STAR_WHALE_MIN_COLS}）→ 空数组`, () => {
    expect(formatStarWhaleLogo(input({ width: STAR_WHALE_MIN_COLS - 1 }))).toEqual([])
  })

  it(`矮屏（rows < ${STAR_WHALE_MIN_ROWS}）→ 空数组`, () => {
    expect(formatStarWhaleLogo(input({ rows: STAR_WHALE_MIN_ROWS - 1 }))).toEqual([])
  })

  it('无色终端（colorLevel 0）→ 空数组', () => {
    expect(formatStarWhaleLogo(input({ colorLevel: 0 }))).toEqual([])
  })

  it('legacy conhost（ambiguous full 档，块字符按 2 列渲染）→ 空数组', () => {
    process.env.RIVET_AMBIGUOUS_WIDTH = 'full'
    expect(formatStarWhaleLogo(input())).toEqual([])
  })

  it('门禁边界值恰好满足 → 出画', () => {
    const lines = formatStarWhaleLogo(input({ width: STAR_WHALE_MIN_COLS, rows: STAR_WHALE_MIN_ROWS }))
    expect(lines.length).toBe(STAR_WHALE_ROWS)
  })
})

describe('formatStarWhaleLogo（半块渲染与宽度守恒）', () => {
  it('出画 STAR_WHALE_ROWS 行；仅 ▀▄█/空格；行尾 RESET 且不补空格', () => {
    const lines = formatStarWhaleLogo(input())
    expect(lines.length).toBe(STAR_WHALE_ROWS)
    for (const line of lines) {
      const text = plain([line])[0]!
      expect(text).toMatch(/^[ ▀▄█]*$/u)
      expect(text.endsWith(' ')).toBe(false)
      // 全透明行对（画顶部/底部留白）输出空串：无缩进无 RESET（blitPixelGrid 先例）
      if (text === '') continue
      expect(line.endsWith('\x1B[0m')).toBe(true)
    }
  })

  it('宽度守恒 + 居中：width 48–120 全扫，每行 ≤ width 且首列缩进符合居中', () => {
    for (let width = STAR_WHALE_MIN_COLS; width <= 120; width++) {
      const lines = formatStarWhaleLogo(input({ width }))
      const indent = Math.floor((width - STAR_WHALE_COLS) / 2)
      for (const line of lines) {
        expect(displayWidth(line)).toBeLessThanOrEqual(width)
        const text = plain([line])[0]!
        if (text === '') continue
        expect(text.startsWith(' '.repeat(indent))).toBe(true)
      }
    }
  })

  it('构图要素：星核/星金/光晕粉/白肚/身体紫/鳍蓝色族均在渲染中（半块格二色混合，按色族断言）', () => {
    const joined = formatStarWhaleLogo(input()).join('\n')
    const rgb: [number, number, number][] = [...joined.matchAll(/38;2;(\d+);(\d+);(\d+)/g)]
      .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])])
    expect(rgb.length).toBeGreaterThan(0)
    // 半块每格二色（▀ fg/bg），混色边格纯色锚值未必原样出现——断言色族有代表（逐通道 Δ ≤ 40）
    const anchors: [string, number, number, number][] = [
      ['星核心', 254, 245, 209],
      ['星金', 254, 240, 172],
      ['光晕粉', 200, 123, 213],
      ['白肚', 190, 197, 250],
      ['身体紫', 158, 57, 245],
      ['鳍蓝', 84, 167, 253],
    ]
    for (const [label, r, g, b] of anchors) {
      const hit = rgb.some(([pr, pg, pb]) =>
        Math.abs(pr - r) <= 40 && Math.abs(pg - g) <= 40 && Math.abs(pb - b) <= 40)
      expect(hit, label).toBe(true)
    }
  })
})

describe('formatStarWhaleLogo（色深轨）', () => {
  it('level 3：品牌 hex 走 truecolor（38;2），身体紫罗兰 #9e39f5', () => {
    const joined = formatStarWhaleLogo(input({ colorLevel: 3 })).join('\n')
    expect(joined).toContain('\x1B[38;2;')
    expect(joined).toContain('158;57;245')
  })

  it('level 2：现场量化为 xterm-256（38;5）', () => {
    chalk.level = 2
    const joined = formatStarWhaleLogo(input({ colorLevel: 2 })).join('\n')
    expect(joined).toContain('\x1B[38;5;')
    expect(joined).not.toContain('\x1B[38;2;')
  })

  it('level 1：现场最近邻 ANSI16（3x/9x 基本码），无 hex', () => {
    const joined = formatStarWhaleLogo(input({ colorLevel: 1 })).join('\n')
    expect(joined).toMatch(/\x1B\[(?:3[0-7]|9[0-7])m/)
    expect(joined).not.toContain('\x1B[38;2;')
    expect(joined).not.toContain('\x1B[38;5;')
  })
})
