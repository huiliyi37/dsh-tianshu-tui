/** 像素画宽度（列数）。 */
export declare const WHALE_COLS = 24;
/** 像素画高度（文本行数 = 像素行 / 2）。 */
export declare const WHALE_ROWS: number;
/** 出画最小终端列数（含两侧呼吸空间）。 */
export declare const WHALE_MIN_COLS = 40;
/** 出画最小终端行数（画 8 行 + 品牌/菜单/环境行整块可容纳）。 */
export declare const WHALE_MIN_ROWS = 22;
/** formatWhaleLogo 的渲染输入。 */
export interface FormatWhaleLogoInput {
    /** 终端列数。 */
    width: number;
    /** 终端行数（整块可容纳性门禁）。 */
    rows: number;
    /** 颜色能力等级（缺省 chalk.level）；≥2 走品牌 hex 轨，1 走命名色轨，0 不出画。 */
    colorLevel?: number;
}
/**
 * 欢迎页鲸鱼像素画：返回在 width 内水平居中的 ANSI 行数组（WHALE_ROWS 行）。
 * 窄屏、矮屏或无色终端返回空数组；双列块字符终端横向成对采样，
 * 以较低横向分辨率保留构图和显示宽度，不再直接丢弃像素画。
 * @param input - 终端尺寸与颜色能力等级。
 * @returns 居中 ANSI 行数组；降级时空数组。
 */
export declare function formatWhaleLogo(input: FormatWhaleLogoInput): string[];
