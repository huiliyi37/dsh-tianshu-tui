/**
 * 生成物：scripts/generate-welcome-blue.mjs 由 assets/welcome-blue-source.png 产出，勿手改。
 *
 * blue 欢迎页抱星鲸鱼索引像素资产：44×34 像素网格（贴合原图内容
 * 宽高比），half-block 渲染 1×2 像素一格 → 44×17 文本格。索引为单 hex 位：
 * 0 = 透明，1–F = BLUE_WHALE_FRAME_PALETTE 下标。调色板 15 色 =
 * median-cut 9 主色 + 锚定 6 关键色（星核/星金/腮红粉/白肚/身体主蓝/高光蓝）。
 * 换图重跑：node scripts/generate-welcome-blue.mjs
 */

/** 像素网格列数（half-block 渲染文本列 = 本值）。 */
export const BLUE_WHALE_PIXEL_COLS = 44
/** 像素网格行数（half-block 渲染文本行 = 本值 / 2）。 */
export const BLUE_WHALE_PIXEL_ROWS = 34

/** 索引调色板（下标 0 恒为 null = 透明；1–15 为 hex 色）。 */
export const BLUE_WHALE_FRAME_PALETTE: readonly (`#${string}` | null)[] = [
  null,
  '#102967',
  '#adc5ef',
  '#2c7ef6',
  '#0f3088',
  '#1255ce',
  '#314e85',
  '#2670eb',
  '#d9ab4d',
  '#fde66f',
  '#fdfdfd',
  '#fdf4b2',
  '#fd8cb2',
  '#c8dbfd',
  '#1048bf',
  '#479aff',
]

/** 索引像素行（34 行 × 44 列，单 hex 位/像素，0 = 透明）。 */
export const BLUE_WHALE_FRAME_ROWS: readonly string[] = [
  '0000000000000000000000000000000000000f300000',
  '00000000000000000000000000000000000034470000',
  '00000000000000000000000ffffffff0000007700000',
  '00000000000000000000f355eeeeeee55f0000000000',
  '000000000000000000f3eeeeeeeeeeeeee7300003f00',
  '0000000000000000035eeeeeeeeeeeeeeee570005e00',
  '00000000000000003e577ee7eeeeeeeeeeeee7005000',
  '0000000000000003ee7e77e7eeeeeeeeeeeeee000000',
  '000000000000007ee7eee77eeeeeeeeeeeeeeee00000',
  '000000000000007eee7e7eeeeeeeeeeeeeeeeee10000',
  '00000000000007eeeee7eeeeeeeeeeeeeeeeeee4005e',
  '00000000000005e77ee7eeeeeeeeeeeeeeeeeee40055',
  '00000000000005575777eeeeea1eeeeeeeeeeee40000',
  '0000000000007e7e5e7eeeee111eeeeeeeee11140000',
  '0000000000007ee7e5eeeeecc11eeeeee42dd2de0000',
  'ff000000ff007ee77eeeeeccceeeeee4dddddd220000',
  '5eff000fe7007eeeeeeeeeeeee3daddddddddd200000',
  'eeeef0feee007eeeeeeeeee5fdddd8bbdbddddd00000',
  '4eeee7eeee007eeeeeeeee32d2bb9b9bbbaddd000000',
  '04eeeeee4e007eeeeeeee32d2bb99b9bbbadd0000000',
  '0044eee44007eeeeeeeee2229889bbb9882de0000000',
  '00044eee4475eeee4ee752f29bbbbabbbb81e7000000',
  '000044ee57eeeeee4eee76f2899aaaab991155000000',
  '0000044eeeeeeee44eee77511899aaa991135e000000',
  '00000044eeeeee4444eee57ff689b9b983f5ee000000',
  '0000003344444447f44eeeee73f99998f75eee001110',
  '00110003ff444ff22f14eeeee576989875eee0011100',
  '000000000fff2fff222444eee4181168844400011100',
  '00011110003ffff22ff2f22270000000000001111000',
  '0001111000007ffffff2222000000000000100000000',
  '00000141111000000000000000100000001111100000',
  '00000000000000000000000041111111111111100000',
  '00000000000001441440001100011111111100000000',
  '00000000000000001441110000014114000000000000',
]
