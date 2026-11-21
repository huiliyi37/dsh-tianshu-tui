/**
 * 宿主 stderr 拦截 — TUI 占用 TTY 期间，把宿主诊断日志从终端挪走。
 *
 * 官方 `@deepseek-ai/dsh-llm-deepseek` 在拉取 `/models` 目录时会
 * `console.error('[llm-deepseek-api-key]', message)`：ACP 要保留 stdout
 * 给协议，所以诊断走 stderr。TUI 与宿主共用同一块终端，这些写入会直接
 * 盖在输入框面板上，后台刷新一次就多一行。
 *
 * 本守卫在 TUI 装配期间替换 `process.stderr.write`，把内容追加到
 * `~/.dsh-tui/host-stderr.log`，不进前台。插件卸载时还原。
 * `DSH_TUI_HOST_STDERR=1` 可关闭拦截，让宿主日志仍打到终端。
 *
 * @module @huiliyi37/dsh-tianshu-tui/host-stderr-guard
 */
import type { WriteStream } from 'node:tty';
/** 设为 `1` 时不拦截，宿主 stderr 仍写到终端。 */
export declare const HOST_STDERR_GUARD_DISABLE_ENV = "DSH_TUI_HOST_STDERR";
/** 日志文件超过该大小时轮转到 `*.1`，避免无限增长。 */
export declare const HOST_STDERR_LOG_MAX_BYTES: number;
/** 默认日志路径：`~/.dsh-tui/host-stderr.log`。 */
export declare function defaultHostStderrLogPath(): string;
/**
 * 是否应在当前进程安装拦截。
 * 非 TTY、测试/CI、或显式关闭时都不装，避免吞掉测试输出或调试日志。
 */
export declare function shouldInstallHostStderrGuard(env?: NodeJS.ProcessEnv, stderr?: {
    isTTY?: boolean;
}): boolean;
/** 安装选项（测试可注入流与落盘）。 */
export interface HostStderrGuardOptions {
    /** 日志路径；`null` 表示不写文件（只走 `onChunk`）。缺省默认路径。 */
    logPath?: string | null;
    /** 每次拦截到的文本（已按写入块，不保证整行）。 */
    onChunk?: (text: string) => void;
    /** 可写流；缺省 `process.stderr`。 */
    stderr?: Pick<WriteStream, 'write'>;
}
/**
 * 拦截 `stderr.write`，把内容从终端挪到日志文件。
 * @returns 还原函数（幂等；若期间已被他人替换则不覆盖）。
 */
export declare function installHostStderrGuard(opts?: HostStderrGuardOptions): () => void;
