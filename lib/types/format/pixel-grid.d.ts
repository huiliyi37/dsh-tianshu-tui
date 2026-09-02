/** blitPixelGrid 的渲染输入。 */
export interface BlitPixelGridInput {
    /** 像素网格（偶数行，两行配对成一文本行）；每字符一格。 */
    grid: readonly string[];
    /** 网格列宽（短行按透明补齐，长行截断）。 */
    cols: number;
    /** 图例字符 → 颜色（hex 或 chalk 命名色）；不在表中的字符 = 透明。 */
    palette: Readonly<Record<string, string>>;
    /** 左侧缩进列数（居中由调用方算好传入）。 */
    indent: number;
}
/**
 * 像素网格 → 居中 ANSI 行数组（grid.length / 2 行）。
 * 宽度守恒：输出行 displayWidth ≤ indent + cols；行尾透明段丢弃（右侧不补
 * 空格）；每行 RESET 收尾防颜色泄漏。
 * @param input - 网格、列宽、调色板与缩进。
 * @returns ANSI 行数组（长度 = grid.length / 2）。
 */
export declare function blitPixelGrid(input: BlitPixelGridInput): string[];
