import chalk from 'chalk'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { isColorSuppressed, setColorSuppressed } from '../src/engine/ansi.js'
import { blitPixelGrid } from '../src/format/pixel-grid.js'

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

const palette = { B: '#4d6bfe', R: '#fde66f' } as const

function render(row: string, xScale?: 1 | 2): string {
  return blitPixelGrid({
    grid: [row, '.'.repeat(row.length)],
    cols: row.length,
    palette,
    indent: 0,
    ...(xScale === undefined ? {} : { xScale }),
  })[0] ?? ''
}

function plain(line: string): string {
  return line.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('blitPixelGrid（full 双列采样）', () => {
  it('BB..BB 保留两块像素，中间透明采样对占两列', () => {
    expect(plain(render('BB..BB', 2))).toBe('▀  ▀')
  })

  it('奇数列的孤立有色像素由右点兜底保留', () => {
    expect(plain(render('...B..', 2))).toBe('  ▀')
  })

  it('采样对两点都有色时取左点', () => {
    const line = render('BR', 2)
    expect(line).toContain('\x1B[38;2;77;107;254m')
    expect(line).not.toContain('\x1B[38;2;253;230;111m')
  })

  it('xScale=1 与缺省输出完全一致，透明格仍占一列', () => {
    expect(render('...B..', 1)).toBe(render('...B..'))
    expect(plain(render('...B..', 1))).toBe('   ▀')
  })
})
