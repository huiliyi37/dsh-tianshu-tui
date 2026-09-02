/**
 * 半块像素画共享 blitter（format/pixel-grid.ts）— 纯渲染。
 *
 * 半块字符像素画：每个字符格用 `▀`（fg=上像素 + bg=下像素）表达 2 个纵向
 * 像素；单色格用 `█`、半透明格用 `▀`/`▄` 仅设前景，全透明格纯空格（不涂
 * 背景，终端底色透出）。块字符（U+2580–259F）在 narrow/wide 宽度档均按
 * 1 列计（width.ts isBoxOrBlock），居中数学与宽度守恒成立；legacy CJK
 * conhost（full 档）把块字符渲染成 2 列会拉伸错位——由调用方门禁降级。
 *
 * 本模块只做「像素网格 → ANSI 行」的转换；尺寸/色深/宽度档门禁与各画的
 * 调色板由调用方（whale.ts / whale-star.ts）自持。
 */
import { ANSI, bg, fg } from '../engine/ansi.js'

/** SGR 背景回默认（49）：透明格前清背景，防止半块 bg 泄漏到空格。 */
const BG_DEFAULT = '\x1B[49m'

/** blitPixelGrid 的渲染输入。 */
export interface BlitPixelGridInput {
  /** 像素网格（偶数行，两行配对成一文本行）；每字符一格。 */
  grid: readonly string[]
  /** 网格列宽（短行按透明补齐，长行截断）。 */
  cols: number
  /** 图例字符 → 颜色（hex 或 chalk 命名色）；不在表中的字符 = 透明。 */
  palette: Readonly<Record<string, string>>
  /** 左侧缩进列数（居中由调用方算好传入）。 */
  indent: number
}

/**
 * 像素网格 → 居中 ANSI 行数组（grid.length / 2 行）。
 * 宽度守恒：输出行 displayWidth ≤ indent + cols；行尾透明段丢弃（右侧不补
 * 空格）；每行 RESET 收尾防颜色泄漏。
 * @param input - 网格、列宽、调色板与缩进。
 * @returns ANSI 行数组（长度 = grid.length / 2）。
 */
export function blitPixelGrid(input: BlitPixelGridInput): string[] {
  const { grid, cols, palette } = input
  const indent = ' '.repeat(Math.max(0, input.indent))
  const out: string[] = []
  for (let y = 0; y < grid.length; y += 2) {
    const top = grid[y] ?? ''
    const bottom = grid[y + 1] ?? ''
    let line = ''
    let curFg: string | null = null
    let curBg: string | null = null
    // 透明格先攒着：行尾透明段直接丢弃（右侧不补空格，宽度守恒），
    // 行中透明段在下一个可见格前一次性落盘。
    let pendingSpaces = 0
    for (let x = 0; x < cols; x++) {
      const t = palette[top[x] ?? '.'] ?? null
      const b = palette[bottom[x] ?? '.'] ?? null
      let ch: string
      let wantFg: string
      let wantBg: string | null = null
      if (t === null) {
        if (b === null) {
          pendingSpaces++
          continue
        }
        ch = '▄'
        wantFg = b
      } else if (b === null) {
        ch = '▀'
        wantFg = t
      } else if (t === b) {
        ch = '█'
        wantFg = t
      } else {
        ch = '▀'
        wantFg = t
        wantBg = b
      }
      if (pendingSpaces > 0) {
        // 空格前必须清背景：上一格若有 bg，空格会被涂成色块。
        if (curBg !== null) {
          line += BG_DEFAULT
          curBg = null
        }
        line += ' '.repeat(pendingSpaces)
        pendingSpaces = 0
      }
      if (wantBg !== curBg) {
        line += wantBg === null ? BG_DEFAULT : bg(wantBg)
        curBg = wantBg
      }
      if (wantFg !== curFg) {
        line += fg(wantFg)
        curFg = wantFg
      }
      line += ch
    }
    out.push(line === '' ? '' : `${indent}${line}${ANSI.RESET}`)
  }
  return out
}
