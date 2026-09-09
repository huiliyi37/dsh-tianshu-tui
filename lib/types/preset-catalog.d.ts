/**
 * 官方 shipped 预设的展示目录：短名、能力、工具集。
 *
 * 花名册 list() 已有 preset.yml 的 name/description；本表补「工具集 + 能力」
 * 给 /preset 列表与 footer/顶栏短名。id 对齐 CLI
 * apps/cli/config/agent-presets/{standard,ptc,minimal,cordis}（rc.1 起 code → ptc）。
 *
 * @module @huiliyi37/dsh-tianshu-tui/preset-catalog
 */
/** 一套 shipped 预设的展示文案。 */
export interface ShippedPresetBlurb {
    /** 目录名，也是 /preset 实参。 */
    id: string;
    /** footer / 顶栏短名。 */
    short: string;
    /** 列表标题（与官方 preset.yml name 对齐）。 */
    name: string;
    /** 一句话能力。 */
    capability: string;
    /** 工具集摘要。 */
    tools: string;
}
/** 把用户输入折成花名册 id（已知别名才改，其余原样）。 */
export declare function resolveShippedPresetId(id: string): string;
/** 按 id 或别名取展示目录；未知 id 返回 undefined。 */
export declare function shippedPresetBlurb(id: string): ShippedPresetBlurb | undefined;
/** footer / 顶栏短名；未知 id 原样。 */
export declare function presetShortLabel(id: string): string;
/**
 * /preset 列表的两行补充：能力 + 工具。
 * 官方 description 优先作能力行；没有再用目录。未知 id 只回官方 description。
 */
export declare function presetListDetails(id: string, officialDescription?: string): {
    capability?: string;
    tools?: string;
};
/** 从 host + 当前会话读 live 预设短名（无 join / 无会话 → undefined）。 */
export declare function livePresetShort(host: {
    reflect?: {
        get(name: string, required?: boolean): unknown;
    };
    agents?: {
        get(id: string): {
            ctx?: unknown;
        } | undefined;
    };
}, sessionId: string | null): string | undefined;
