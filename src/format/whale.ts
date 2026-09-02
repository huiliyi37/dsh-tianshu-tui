/**
 * 欢迎页鲸鱼品牌像素画（format/whale.ts）— 纯渲染。
 *
 * 半块字符像素画（渲染细节见 format/pixel-grid.ts 共享 blitter）。
 * 品牌资产用固定色（不随主题变）：DeepSeek 品牌蓝身体 + 白肚 + 深色眼。
 * 白肚在亮色主题下与终端底色融合，恰好还原 logo 在白纸上的原始观感。
 */
import chalk from 'chalk'
import { ambiguousWidthMode } from '../width.js'
import { blitPixelGrid } from './pixel-grid.js'

/**
 * 像素网格（16 行 × 24 列 → 8 文本行）。图例：
 * `.` 透明 / `B` 身体蓝 / `W` 白肚 / `E` 眼睛 / `P` 腮红。
 * 形状对照品牌手绘鲸鱼：圆润身体、左下白肚、上中深色眼 + 腮红、右上翘尾。
 */
const GRID: readonly string[] = [
  '.................BB..BB.',
  '.................BBBBBB.',
  '......BBBBBBB....BBBB...',
  '....BBBBBBBBBBB..BBB....',
  '..BBBBBBBBBBBBBBBBBB....',
  '.BBBBBBBBBBBBBBBBBBB....',
  '.BBBBBBBBEEBBBBBBBBB....',
  'BBWWWWBBBEEBBBBBBBBB....',
  'BWWWWWWPPBBBBBBBBBB.....',
  'BWWWWWWPPBBBBBBBBBB.....',
  'BWWWWWWWWWWWBBBBBB......',
  'BWWWWWWWWWWWWWBBBB......',
  '.BWWWWWWWWWWWWWBBB......',
  '..BWWWWWWWWWWWBBB.......',
  '....BBWWWWWWWBBB........',
  '.......BBBBBBBB.........',
]

/** 像素画宽度（列数）。 */
export const WHALE_COLS = 24
/** 像素画高度（文本行数 = 像素行 / 2）。 */
export const WHALE_ROWS = GRID.length / 2

/** 出画最小终端列数（含两侧呼吸空间）。 */
export const WHALE_MIN_COLS = 40
/** 出画最小终端行数（画 8 行 + 品牌/菜单/环境行整块可容纳）。 */
export const WHALE_MIN_ROWS = 22

/** truecolor/256 轨：DeepSeek 品牌蓝 + 近白肚（纯白在暗底刺眼）+ 深藏青眼。 */
const TRUECOLOR_PALETTE: Readonly<Record<string, string>> = {
  B: '#4d6bfe',
  W: '#f2f5fa',
  E: '#14204a',
  P: '#f5a8b8',
}

/** 16 色轨：命名色近似；腮红细节该档不表达（映射回身体色）。 */
const ANSI16_PALETTE: Readonly<Record<string, string>> = {
  B: 'blueBright',
  W: 'whiteBright',
  E: 'blue',
  P: 'blueBright',
}

/** formatWhaleLogo 的渲染输入。 */
export interface FormatWhaleLogoInput {
  /** 终端列数。 */
  width: number
  /** 终端行数（整块可容纳性门禁）。 */
  rows: number
  /** 颜色能力等级（缺省 chalk.level）；≥2 走品牌 hex 轨，1 走命名色轨，0 不出画。 */
  colorLevel?: number
}

/**
 * 欢迎页鲸鱼像素画：返回在 width 内水平居中的 ANSI 行数组（WHALE_ROWS 行）。
 * 降级矩阵（任一不满足返回空数组，调用方回落纯文字品牌区）：
 * - `width ≥ WHALE_MIN_COLS` 且 `rows ≥ WHALE_MIN_ROWS`
 * - `colorLevel ≥ 1`（无色终端画不出品牌色，纯剪影无识别度）
 * - `ambiguousWidthMode() !== 'full'`（legacy conhost 块字符按 2 列渲染）
 * 宽度守恒：任何输出行 displayWidth ≤ width；画不截断，放不下即整体降级。
 * @param input - 终端尺寸与颜色能力等级。
 * @returns 居中 ANSI 行数组；降级时空数组。
 */
export function formatWhaleLogo(input: FormatWhaleLogoInput): string[] {
  const level = input.colorLevel ?? chalk.level
  if (level < 1) return []
  if (input.width < WHALE_MIN_COLS || input.rows < WHALE_MIN_ROWS) return []
  if (ambiguousWidthMode() === 'full') return []

  const palette = level >= 2 ? TRUECOLOR_PALETTE : ANSI16_PALETTE
  const indent = Math.max(0, Math.floor((input.width - WHALE_COLS) / 2))
  return blitPixelGrid({ grid: GRID, cols: WHALE_COLS, palette, indent })
}
