/** 像素画宽度（文本列数 = 像素列）。 */
export declare const STAR_WHALE_COLS = 44;
/** 像素画高度（文本行数 = 像素行 / 2）。 */
export declare const STAR_WHALE_ROWS: number;
/** 出画最小终端列数（含两侧呼吸空间）。 */
export declare const STAR_WHALE_MIN_COLS = 56;
/** 出画最小终端行数（画 21 行 + 少量呼吸；整块门槛由 welcome star hero 门禁）。 */
export declare const STAR_WHALE_MIN_ROWS = 24;
/** formatStarWhaleLogo 的渲染输入（同 formatWhaleLogo）。 */
export interface FormatStarWhaleLogoInput {
    /** 终端列数。 */
    width: number;
    /** 终端行数（整块可容纳性门禁）。 */
    rows: number;
    /** 颜色能力等级（缺省 chalk.level）；≥2 走品牌 hex 轨，1 走命名 16 色近似轨，0 不出画。 */
    colorLevel?: number;
}
/**
 * 抱星鲸鱼像素画：返回在 width 内水平居中的 ANSI 行数组（STAR_WHALE_ROWS 行）。
 * 降级矩阵同 formatWhaleLogo：窄屏/矮屏/无色/legacy conhost（full 宽度档）
 * 返回空数组（调用方回落 retro 鲸鱼或纯文字品牌区）。
 * 宽度守恒：任何输出行 displayWidth ≤ width；画不截断，放不下即整体降级。
 * @param input - 终端尺寸与颜色能力等级。
 * @returns 居中 ANSI 行数组；降级时空数组。
 */
export declare function formatStarWhaleLogo(input: FormatStarWhaleLogoInput): string[];
