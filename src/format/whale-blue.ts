/**
 * 欢迎页 blue 模式抱星鲸鱼像素画（format/whale-blue.ts）— 纯渲染。
 *
 * 品牌画：蓝鲸抱星（水面倒影/气泡/腮红构图）。像素资产为生成物
 * （whale-blue-frames.ts，scripts/generate-welcome-blue.mjs 产出），
 * 44×34 索引像素经 format/pixel-grid.ts 半块渲染（1×2 像素一格 → 44×17
 * 文本格）。渐变图用实色双拼而非盲文点阵（同 star 管线结论）。背景透明，
 * 暗色主题还原参考图观感，亮色主题仍可读。固定品牌色（不随主题变），
 * 同 whale.ts / whale-star.ts 先例。
 */
import chalk from 'chalk'
import { hexToRgb, rgbToAnsi16Name } from '../engine/ansi.js'
import { ambiguousWidthMode } from '../width.js'
import { blitPixelGrid } from './pixel-grid.js'
import {
  BLUE_WHALE_FRAME_PALETTE,
  BLUE_WHALE_FRAME_ROWS,
  BLUE_WHALE_PIXEL_COLS,
  BLUE_WHALE_PIXEL_ROWS,
} from './whale-blue-frames.js'

/** 像素画宽度（文本列数 = 像素列）。 */
export const BLUE_WHALE_COLS = BLUE_WHALE_PIXEL_COLS
/** 像素画高度（文本行数 = 像素行 / 2）。 */
export const BLUE_WHALE_ROWS = BLUE_WHALE_PIXEL_ROWS / 2

/** 出画最小终端列数（含两侧呼吸空间）。 */
export const BLUE_WHALE_MIN_COLS = 56
/** 出画最小终端行数（画 17 行 + 少量呼吸；整块门槛由 welcome blue hero 门禁）。 */
export const BLUE_WHALE_MIN_ROWS = 24

/** 图例字符（hex 位）→ 品牌 hex：索引 0 透明，1–F 取生成物调色板（level ≥2 轨）。 */
const PALETTE_HEX: Readonly<Record<string, string>> = Object.fromEntries(
  BLUE_WHALE_FRAME_PALETTE.flatMap((hex, i) => (i === 0 || hex === null ? [] : [[i.toString(16), hex]])),
)

/** level 1 轨：同索引取现场最近邻 ANSI16 命名色（调色板变更免维护近似表）。 */
const PALETTE_ANSI16: Readonly<Record<string, string>> = Object.fromEntries(
  BLUE_WHALE_FRAME_PALETTE.flatMap((hex, i) => {
    if (i === 0 || hex === null) return []
    const rgb = hexToRgb(hex)
    /* v8 ignore next -- 生成物调色板恒为合法 hex；noUncheckedIndexedAccess 收窄防御 */
    return rgb === null ? [] : [[i.toString(16), rgbToAnsi16Name(rgb[0], rgb[1], rgb[2])]]
  }),
)

/** formatBlueWhaleLogo 的渲染输入（同 formatStarWhaleLogo）。 */
export interface FormatBlueWhaleLogoInput {
  /** 终端列数。 */
  width: number
  /** 终端行数（整块可容纳性门禁）。 */
  rows: number
  /** 颜色能力等级（缺省 chalk.level）；≥2 走品牌 hex 轨，1 走命名 16 色近似轨，0 不出画。 */
  colorLevel?: number
}

/**
 * 蓝鲸抱星像素画：返回在 width 内水平居中的 ANSI 行数组（BLUE_WHALE_ROWS 行）。
 * 降级矩阵同 formatStarWhaleLogo：窄屏/矮屏/无色/legacy conhost（full 宽度档）
 * 返回空数组（调用方回落 retro 鲸鱼或纯文字品牌区）。
 * 宽度守恒：任何输出行 displayWidth ≤ width；画不截断，放不下即整体降级。
 * @param input - 终端尺寸与颜色能力等级。
 * @returns 居中 ANSI 行数组；降级时空数组。
 */
export function formatBlueWhaleLogo(input: FormatBlueWhaleLogoInput): string[] {
  const level = input.colorLevel ?? chalk.level
  if (level < 1) return []
  if (input.width < BLUE_WHALE_MIN_COLS || input.rows < BLUE_WHALE_MIN_ROWS) return []
  if (ambiguousWidthMode() === 'full') return []

  const indent = Math.max(0, Math.floor((input.width - BLUE_WHALE_COLS) / 2))
  return blitPixelGrid({
    grid: BLUE_WHALE_FRAME_ROWS,
    cols: BLUE_WHALE_COLS,
    palette: level >= 2 ? PALETTE_HEX : PALETTE_ANSI16,
    indent,
  })
}
