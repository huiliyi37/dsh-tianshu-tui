/**
 * T9 ANSI 转义序列工具库。
 *
 * 提供两个层次的 API：
 * 1. 原始转义序列常量 — 直接拼接到输出字符串中
 * 2. 类型安全的构建器函数 — 防止参数注入
 *
 * 参照：ECMA-48 / ISO 6429 标准，VT100/VT220 兼容。
 */
/** ANSI 转义序列原始常量。直接用模板字面量拼接到输出字符串。 */
export declare const ANSI: {
    /** 保存当前光标位置 */
    readonly SAVE_CURSOR: '\u001B[s';
    /** 恢复之前保存的光标位置 */
    readonly RESTORE_CURSOR: '\u001B[u';
    /** 从光标处擦除到行尾 (Erase to End of Line) */
    readonly ERASE_LINE_END: '\u001B[0K';
    /** 擦除整行 (Erase Entire Line) */
    readonly ERASE_LINE: '\u001B[2K';
    /** 从光标处擦除到屏幕末尾 (Erase to End of Screen) */
    readonly ERASE_SCREEN_END: '\u001B[0J';
    /** 擦除整个屏幕 (Erase Entire Screen) */
    readonly ERASE_SCREEN: '\u001B[2J';
    /** 进入 alternate screen buffer（全屏 overlay 用） */
    readonly ALT_SCREEN_ON: '\u001B[?1049h';
    /** 退出 alternate screen buffer，恢复主屏 */
    readonly ALT_SCREEN_OFF: '\u001B[?1049l';
    /**
     * 开始同步输出（CSI 2026 / DECSET 2026）。
     * 终端会缓冲后续输出，直到 END_SYNC 才一次性原子刷新 → 防止增量重绘撕裂/闪烁。
     * 不支持的终端会静默忽略此私有模式（无副作用）。
     */
    readonly BEGIN_SYNC: '\u001B[?2026h';
    /** 结束同步输出，原子刷新本帧。 */
    readonly END_SYNC: '\u001B[?2026l';
    /** 启用 bracketed paste（DECSET 2004：粘贴文本被 200~/201~ 包裹，
   不触发按键） */
    readonly BRACKETED_PASTE_ON: '\u001B[?2004h';
    /** 关闭 bracketed paste（退出时恢复终端默认） */
    readonly BRACKETED_PASTE_OFF: '\u001B[?2004l';
    /** 隐藏光标 */
    readonly HIDE_CURSOR: '\u001B[?25l';
    /** 显示光标 */
    readonly SHOW_CURSOR: '\u001B[?25h';
    /**
     * DECSCUSR：光标形状设为稳态竖条（不闪）。
     * 终端原生光标闪烁会叠加在应用自管的 DECTCEM 翻转上，导致闪烁频率不稳、
     * 静止光标也在闪——输入类 overlay 激活期间统一切到稳态竖条，
     * 闪烁节奏完全由应用控制。竖条画在字符格左缘，天然落在格子边界上。
     */
    readonly CURSOR_STEADY_BAR: '\u001B[6 q';
    /** DECSCUSR：光标形状恢复终端默认（退出 overlay 时写）。 */
    readonly CURSOR_SHAPE_DEFAULT: '\u001B[0 q';
    /** 重置所有 SGR 属性 */
    readonly RESET: '\u001B[0m';
    /** 粗体 */
    readonly BOLD: '\u001B[1m';
    /** 细体/暗色 */
    readonly DIM: '\u001B[2m';
    /** 斜体 */
    readonly ITALIC: '\u001B[3m';
    /** 下划线 */
    readonly UNDERLINE: '\u001B[4m';
    /** 闪烁（慢） */
    readonly BLINK: '\u001B[5m';
    /** 反色 */
    readonly REVERSE: '\u001B[7m';
    /** 删除线 */
    readonly STRIKETHROUGH: '\u001B[9m';
};
/**
 * 将光标向上移动 n 行。
 * @param n - 移动行数；非正/非整数值被钳到 ≥1 的整数
 * @returns CUU 转义序列
 */
export declare function cursorUp(n: number): string;
/**
 * 将光标向下移动 n 行。
 * @param n - 移动行数；非正/非整数值被钳到 ≥1 的整数
 * @returns CUD 转义序列
 */
export declare function cursorDown(n: number): string;
/**
 * 将光标向右移动 n 列。
 * @param n - 移动列数；非正/非整数值被钳到 ≥1 的整数
 * @returns CUF 转义序列
 */
export declare function cursorForward(n: number): string;
/**
 * 将光标向左移动 n 列。
 * @param n - 移动列数；非正/非整数值被钳到 ≥1 的整数
 * @returns CUB 转义序列
 */
export declare function cursorBack(n: number): string;
/**
 * 移动光标到绝对位置 (row, col)。1-based。
 * @param row - 目标行（1-based）；非正/非整数值被钳到 ≥1 的整数
 * @param col - 目标列（1-based）；非正/非整数值被钳到 ≥1 的整数
 * @returns CUP 转义序列
 */
export declare function cursorTo(row: number, col: number): string;
/**
 * 移动光标到第 col 列（保持当前行）。1-based。
 * @param col - 目标列（1-based）；非正/非整数值被钳到 ≥1 的整数
 * @returns CHA 转义序列
 */
export declare function cursorToCol(col: number): string;
/**
 * hex 颜色字符串 → RGB 元组。
 * 支持 `#rgb`、`#rrggbb` 格式。无法解析时（含 chalk 命名色）返回 null——
 * 调用方以此区分 truecolor 轨主题 token 与 16 色轨命名色（shimmer 降级判定）。
 * @param hex - hex 颜色字符串（`#rgb` / `#rrggbb`）。
 * @returns `[r, g, b]`（0-255）；无法解析时 null。
 */
export declare function hexToRgb(hex: string): [number, number, number] | null;
/**
 * RGB → xterm-256 最近邻索引（256 色中间档量化）。
 * 候选双轨取最优：6×6×6 色立方（16-231，分量档 0/95/135/175/215/255）
 * 与 24 级灰阶（232-255，8+10i）。距离用 RGB 欧氏平方（对量化到 256 档足够）。
 * @param r - 红色分量（0-255）
 * @param g - 绿色分量（0-255）
 * @param b - 蓝色分量（0-255）
 * @returns xterm-256 调色板索引（16-255）
 */
export declare function rgbToXterm256(r: number, g: number, b: number): number;
/**
 * RGB → 最近 ANSI16 chalk 命名色（2:4:3 感知加权；16 色档像素画近似用，
 * 调色板变更无需手维护近似表——whale-star level 1 轨）。
 * @param r - 红色分量（0-255）
 * @param g - 绿色分量（0-255）
 * @param b - 蓝色分量（0-255）
 * @returns chalk 命名色（NAMED_FG_CODES 覆盖的 16 色之一）
 */
export declare function rgbToAnsi16Name(r: number, g: number, b: number): string;
/** 纯函数：给定 env 是否请求无色（便于测试注入）。 */
export declare function noColorRequested(env?: NodeJS.ProcessEnv): boolean;
/**
 * 测试/显式覆写无色开关（只翻本模块旗标；不回改 chalk.level——生产路径由
 * 模块加载时的初始化统一压制）。测试用后应复原。
 */
export declare function setColorSuppressed(v: boolean): void;
/** 当前是否压制颜色输出（NO_COLOR 已显式请求时 fg/bg 输出空串）。 */
export declare function isColorSuppressed(): boolean;
/**
 * 设置前景色。接受 hex（`#a8e6cf`）或 chalk 命名色（`cyan`/`redBright`）。
 * hex 在 truecolor 终端发 38;2，在 256 色终端（chalk.level === 2）量化为 38;5；
 * 命名色发基础 16 色码。无法解析时返回 ''（无着色）。NO_COLOR 请求时恒返回 ''。
 * @param colorValue - hex 颜色字符串或 chalk 命名色
 * @returns SGR 前景色序列；无法解析或无色模式时为空字符串
 */
export declare function fg(colorValue: string): string;
/**
 * 设置背景色。接受 hex 或 chalk 命名色（命名色码 +10 为背景码）。
 * 降级规则同 fg()。
 * @param colorValue - hex 颜色字符串或 chalk 命名色
 * @returns SGR 背景色序列；无法解析时为空字符串
 */
export declare function bg(colorValue: string): string;
/**
 * 用 ANSI 前景色 + 可选 SGR 属性包裹文本。
 * 始终以 ANSI.RESET 结尾，防止颜色泄露。
 * @param text - 要着色的文本
 * @param fgHex - 前景色（hex 或 chalk 命名色，同 fg()）
 * @param opts - 可选 SGR 属性（bold/dim/italic/underline）
 * @returns 着色后的字符串（末尾带 RESET）
 */
export declare function color(text: string, fgHex: string, opts?: {
    bold?: boolean;
    dim?: boolean;
    italic?: boolean;
    underline?: boolean;
}): string;
/**
 * OSC 52 写系统剪贴板（终端支持时；不支持者无害忽略——内部剪贴板 Alt+Y 兜底）。
 * 剪贴选区/复制后由 app 在渲染循环 drain 写出。
 * @param text - 要写入剪贴板的文本（内部 base64 编码，控制字符无注入风险）
 * @returns OSC 52 转义序列
 */
export declare function osc52Clipboard(text: string): string;
/**
 * 测试/配置钩子：强制开/关超链接（null 恢复自动检测）。
 * @param value - true 强制开、false 强制关、null 恢复自动检测
 */
export declare function setHyperlinksEnabled(value: boolean | null): void;
/**
 * OSC 8 支持启发式检测。终端无标准能力查询协议，按主流终端约定判断：
 * - 环境开关优先：`RIVET_HYPERLINKS=0/1`、`FORCE_HYPERLINK`
 * - 已知支持的 TERM_PROGRAM：iTerm2 / WezTerm / VS Code / Hyper / ghostty / Tabby
 * - kitty（TERM 前缀）、VTE ≥ 0.50（GNOME Terminal 系）、Windows Terminal（WT_SESSION）
 * - tmux/screen 与 dumb 终端保守降级（tmux 需 passthrough 配置，默认关闭）
 * @param env - 参与检测的环境变量集合（默认 process.env，可注入用于测试）
 * @returns 终端是否支持 OSC 8 超链接
 */
export declare function detectHyperlinkSupport(env?: NodeJS.ProcessEnv): boolean;
/**
 * 把文本包装为 OSC 8 可点击超链接；不支持的终端返回纯文本（零污染降级）。
 * url 中的控制字符会被剥离（OSC 序列注入防护）。
 * @param text - 链接显示文本
 * @param url - 链接目标；控制字符剥离后为空时返回纯文本
 * @returns OSC 8 序列包裹的文本，或降级后的纯文本
 */
export declare function hyperlink(text: string, url: string): string;
/**
 * 文件路径 → file:// 超链接（相对路径基于 cwd 归一为绝对路径）。
 * @param text - 链接显示文本
 * @param filePath - 文件路径（绝对或相对）
 * @param cwd - 相对路径的基准目录（默认 process.cwd()）
 * @returns OSC 8 file:// 超链接，或降级后的纯文本
 */
export declare function fileLink(text: string, filePath: string, cwd?: string): string;
/** 支持的终端内联图片协议。'none' 表示降级为文本占位。 */
export type ImageProtocol = 'kitty' | 'iterm2' | 'none';
/**
 * 测试/配置钩子：强制指定图片协议（null 恢复自动检测）。
 * @param value - 强制使用的协议；null 恢复自动检测
 */
export declare function setImageProtocol(value: ImageProtocol | null): void;
/**
 * 内联图片协议启发式检测，与 detectHyperlinkSupport 同构：
 * - 环境开关优先：`RIVET_IMAGES=0/off` 关闭，`kitty`/`iterm2` 强制指定
 * - kitty 协议：kitty（TERM 前缀）、ghostty、WezTerm、Warp、Konsole
 * - iTerm2 协议：iTerm.app
 * - tmux/screen 与 dumb 终端保守降级（图形序列需 passthrough，默认关闭）
 * @param env - 参与检测的环境变量集合（默认 process.env，可注入用于测试）
 * @param isTTY - stdout 是否为 TTY（缺省取 process.stdout.isTTY）
 * @returns 检测到的图片协议；不支持时为 'none'
 */
export declare function detectImageProtocol(env?: NodeJS.ProcessEnv, isTTY?: boolean): ImageProtocol;
/**
 * 当前生效的图片协议（带缓存 + override 钩子）。
 * @returns override 优先，否则首次调用时检测并缓存的协议
 */
export declare function imageProtocol(): ImageProtocol;
/** 查询光标位置。终端会通过 stdin 返回 `\x1B[row;colR`。 */
export declare const QUERY_CURSOR_POS = "\u001B[6n";
/** 查询终端尺寸（备用方案）。某些终端不支持 stdout.columns。 */
export declare const QUERY_TERMINAL_SIZE = "\u001B[18t";
