/**
 * 生成物：scripts/generate-welcome-title.mjs 产出，勿手改。
 *
 * star 欢迎页标题艺术字（figlet，生成期固化，运行时零依赖）：
 * standard = Standard 字体宽档，mini = Mini 字体窄档；welcome.ts 按右栏
 * 宽度选档（放不下 mini 档则整体回落 retro）。换字体改 FONTS 后重跑本脚本。
 */
/** 一档标题艺术字。 */
export interface StarTitleArtVariant {
    /** 主标艺术行（DeepSeek»）。 */
    readonly title: readonly string[];
    /** 副标艺术行（< Harness >）。 */
    readonly subtitle: readonly string[];
    /** 档宽（主/副标最长行，列）。 */
    readonly width: number;
}
/** 两档标题艺术字（standard 宽档 / mini 窄档）。 */
export declare const STAR_TITLE_ART: {
    readonly standard: StarTitleArtVariant;
    readonly mini: StarTitleArtVariant;
};
