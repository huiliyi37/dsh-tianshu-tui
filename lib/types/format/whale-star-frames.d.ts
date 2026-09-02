/**
 * 生成物：scripts/generate-welcome-star.mjs 由 assets/welcome-star-source.png 产出，勿手改。
 *
 * star 欢迎页抱星鲸鱼索引像素资产：44×34 像素网格（贴合原图内容
 * 宽高比），half-block 渲染 1×2 像素一格 → 44×17 文本格。索引为单 hex 位：
 * 0 = 透明，1–F = STAR_WHALE_FRAME_PALETTE 下标。调色板 15 色 =
 * median-cut 9 主色 + 锚定 6 关键色（星核/星金/光晕粉/白肚/身体紫/鳍蓝）。
 * 换图重跑：node scripts/generate-welcome-star.mjs
 */
/** 像素网格列数（half-block 渲染文本列 = 本值）。 */
export declare const STAR_WHALE_PIXEL_COLS = 44;
/** 像素网格行数（half-block 渲染文本行 = 本值 / 2）。 */
export declare const STAR_WHALE_PIXEL_ROWS = 34;
/** 索引调色板（下标 0 恒为 null = 透明；1–15 为 hex 色）。 */
export declare const STAR_WHALE_FRAME_PALETTE: readonly (`#${string}` | null)[];
/** 索引像素行（34 行 × 44 列，单 hex 位/像素，0 = 透明）。 */
export declare const STAR_WHALE_FRAME_ROWS: readonly string[];
