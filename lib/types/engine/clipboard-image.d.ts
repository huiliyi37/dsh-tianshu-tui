/**
 * Clipboard image reader — reads image data from the system clipboard.
 *
 * 平台 shell 命令路径（osascript / wl-paste / xclip / PowerShell）+ 测试注入点。
 * opencode-tui 上游的 native（@mariozechner/clipboard）路径未移植：dsh 未声明该
 * 依赖，动态导入恒失败只会留下死代码；未来引入依赖时按 git 历史恢复即可。
 *
 * 可测试性设计：setClipboardReader() 注入 mock（单元测试）；tryShellClipboard()
 * 接受可注入的 execFile/platform/readFile/tmpdir/randomUUID（shell 路径测试）。
 */
/** 焦点防抖窗口 (ms)：编辑器从 overlay 切回后 1s 内的 Ctrl+V 跳过剪贴板读图 */
export declare const FOCUS_DEBOUNCE_MS = 1000;
/** 剪贴板图片：data URL + MIME + 文件名 + 来源分类（气泡/上屏用）。 */
export interface ClipboardImage {
    /** data:image/...;base64,... */
    dataUrl: string;
    mime: string;
    name: string;
    source: 'png' | 'jpeg' | 'image';
}
/** 剪贴板读图器契约（测试注入与真实实现共用）。 */
export interface ClipboardReader {
    readImage(): Promise<ClipboardImage | null>;
    /** 可选：文本读取也走注入（测试密封化——否则文本路径会调真实 pbpaste，
     *  剪贴板有内容时用例被环境扰动）。 */
    readText?(): Promise<string | null>;
}
/** tryShellClipboard 的注入参数（测试覆盖各平台 shell 分支）。 */
export interface ShellClipboardOpts {
    execFile?: (bin: string, args: string[]) => Promise<{
        stdout: string;
        stderr?: string;
    }>;
    platform?: NodeJS.Platform;
    readFile?: (path: string) => Promise<Buffer>;
    tmpdir?: string;
    randomUUID?: () => string;
}
/** 注入/清除测试 reader（null 恢复真实 shell 路径）。
 * @param reader - 剪贴板读图 mock；null 恢复真实 shell 路径
 */
export declare function setClipboardReader(reader: ClipboardReader | null): void;
/**
 * 读系统剪贴板图片；无图或读取失败返回 null（调用方据此 fallback 到文本）。
 * 优先测试注入 reader，否则走平台 shell 命令链。
 * @returns 剪贴板图片；无图/失败/不支持时为 null
 */
export declare function readImageFromClipboard(): Promise<ClipboardImage | null>;
/**
 * 读系统剪贴板文本（Ctrl+V 无图时的 fallback；部分终端不经 bracketed paste
 * 传递粘贴文本）。各平台优先 pbpaste / wl-paste / xclip / PowerShell；
 * Linux 最后尝试 powershell.exe，覆盖 WSL 的 Windows 剪贴板。
 * @param opts - 可选 shell 注入参数（缺省用真实 execFile/平台）
 * @returns 剪贴板文本；无工具或失败时 null
 */
export declare function readTextFromClipboard(opts?: Pick<ShellClipboardOpts, 'execFile' | 'platform'>): Promise<string | null>;
/**
 * 平台 shell 剪贴板读图链：darwin osascript / linux wl-paste+xclip / win32
 * PowerShell。任一步失败静默降级到下一个平台分支；全部失败返回 null。
 * @param opts - 注入参数（缺省用真实 execFile/平台/fs/os）
 * @returns 剪贴板图片；不可用时 null
 */
export declare function tryShellClipboard(opts?: ShellClipboardOpts): Promise<ClipboardImage | null>;
