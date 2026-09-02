/**
 * 欢迎页 star 模式抱星鲸鱼像素画（format/whale-star.ts）— 纯渲染。
 *
 * 品牌画：紫罗兰鲸鱼托举光晕金星（8-22 品牌原图，字幕带已切除）。像素资产
 * 为生成物（whale-star-frames.ts，scripts/generate-welcome-star.mjs 产出），
 * 44×34 索引像素经 format/pixel-grid.ts 半块渲染（1×2 像素一格 → 44×17
 * 文本格）。渐变图用实色双拼而非盲文点阵：渐变区盲文格全混色，亮点归前景
 * 点/暗点归背景即成麻点（omts 渲染默认 half 档同理）。背景透明，暗色主题
 * 还原参考图观感，亮色主题仍可读。固定品牌色（不随主题变），同 whale.ts 先例。
 */
import chalk from 'chalk'
import { hexToRgb, rgbToAnsi16Name } from '../engine/ansi.js'
import { ambiguousWidthMode } from '../width.js'
import { blitPixelGrid } from './pixel-grid.js'
import {
  STAR_WHALE_FRAME_PALETTE,
  STAR_WHALE_FRAME_ROWS,
  STAR_WHALE_PIXEL_COLS,
  STAR_WHALE_PIXEL_ROWS,
} from './whale-star-frames.js'

/** 像素画宽度（文本列数 = 像素列）。 */
export const STAR_WHALE_COLS = STAR_WHALE_PIXEL_COLS
/** 像素画高度（文本行数 = 像素行 / 2）。 */
export const STAR_WHALE_ROWS = STAR_WHALE_PIXEL_ROWS / 2

/** 出画最小终端列数（含两侧呼吸空间）。 */
export const STAR_WHALE_MIN_COLS = 56
/** 出画最小终端行数（画 21 行 + 少量呼吸；整块门槛由 welcome star hero 门禁）。 */
export const STAR_WHALE_MIN_ROWS = 24

/** 图例字符（hex 位）→ 品牌 hex：索引 0 透明，1–F 取生成物调色板（level ≥2 轨）。 */
const PALETTE_HEX: Readonly<Record<string, string>> = Object.fromEntries(
  STAR_WHALE_FRAME_PALETTE.flatMap((hex, i) => (i === 0 || hex === null ? [] : [[i.toString(16), hex]])),
)

/** level 1 轨：同索引取现场最近邻 ANSI16 命名色（调色板变更免维护近似表）。 */
const PALETTE_ANSI16: Readonly<Record<string, string>> = Object.fromEntries(
  STAR_WHALE_FRAME_PALETTE.flatMap((hex, i) => {
    if (i === 0 || hex === null) return []
    const rgb = hexToRgb(hex)
    /* v8 ignore next -- 生成物调色板恒为合法 hex；noUncheckedIndexedAccess 收窄防御 */
    return rgb === null ? [] : [[i.toString(16), rgbToAnsi16Name(rgb[0], rgb[1], rgb[2])]]
  }),
)

/** formatStarWhaleLogo 的渲染输入（同 formatWhaleLogo）。 */
export interface FormatStarWhaleLogoInput {
  /** 终端列数。 */
  width: number
  /** 终端行数（整块可容纳性门禁）。 */
  rows: number
  /** 颜色能力等级（缺省 chalk.level）；≥2 走品牌 hex 轨，1 走命名 16 色近似轨，0 不出画。 */
  colorLevel?: number
}

/**
 * 抱星鲸鱼像素画：返回在 width 内水平居中的 ANSI 行数组（STAR_WHALE_ROWS 行）。
 * 降级矩阵同 formatWhaleLogo：窄屏/矮屏/无色/legacy conhost（full 宽度档）
 * 返回空数组（调用方回落 retro 鲸鱼或纯文字品牌区）。
 * 宽度守恒：任何输出行 displayWidth ≤ width；画不截断，放不下即整体降级。
 * @param input - 终端尺寸与颜色能力等级。
 * @returns 居中 ANSI 行数组；降级时空数组。
 */
export function formatStarWhaleLogo(input: FormatStarWhaleLogoInput): string[] {
  const level = input.colorLevel ?? chalk.level
  if (level < 1) return []
  if (input.width < STAR_WHALE_MIN_COLS || input.rows < STAR_WHALE_MIN_ROWS) return []
  if (ambiguousWidthMode() === 'full') return []

  const indent = Math.max(0, Math.floor((input.width - STAR_WHALE_COLS) / 2))
  return blitPixelGrid({
    grid: STAR_WHALE_FRAME_ROWS,
    cols: STAR_WHALE_COLS,
    palette: level >= 2 ? PALETTE_HEX : PALETTE_ANSI16,
    indent,
  })
}
