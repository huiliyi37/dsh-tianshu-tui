/**
 * 生成物：scripts/generate-welcome-title.mjs 产出，勿手改。
 *
 * 欢迎页标题艺术字（figlet，生成期固化，运行时零依赖）：
 * - STAR_TITLE_ART：star 风格，standard = Standard 字体宽档，mini = Mini 窄档。
 * - BLUE_TITLE_ART：blue 风格（默认），wide = ANSI Shadow 宽档、mid =
 *   Standard 中档（宽/中档副标纯文本），mini = Mini 窄档。
 * welcome.ts 按右栏宽度选档（放不下窄档则整体回落 retro）。换字体/文本改
 * ARTS 后重跑本脚本。
 */
/** 一档标题艺术字。 */
export interface StarTitleArtVariant {
    /** 主标艺术行。 */
    readonly title: readonly string[];
    /** 副标艺术行。 */
    readonly subtitle: readonly string[];
    /** 档宽（主/副标最长行，列）。 */
    readonly width: number;
}
/** star 风格标题艺术字（standard 宽档 / mini 窄档）。 */
export declare const STAR_TITLE_ART: {
    readonly standard: StarTitleArtVariant;
    readonly mini: StarTitleArtVariant;
};
/** blue 风格标题艺术字（wide = ANSI Shadow / mid = Standard / mini = Mini，宽→窄）。 */
export declare const BLUE_TITLE_ART: {
    readonly wide: StarTitleArtVariant;
    readonly mid: StarTitleArtVariant;
    readonly mini: StarTitleArtVariant;
};
