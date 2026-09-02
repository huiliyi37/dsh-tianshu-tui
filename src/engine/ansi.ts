/**
 * T9 ANSI 转义序列工具库。
 *
 * 提供两个层次的 API：
 * 1. 原始转义序列常量 — 直接拼接到输出字符串中
 * 2. 类型安全的构建器函数 — 防止参数注入
 *
 * 参照：ECMA-48 / ISO 6429 标准，VT100/VT220 兼容。
 */

import chalk from 'chalk'

// ── 原始转义序列常量 ──────────────────────────────────────────

/** ANSI 转义序列原始常量。直接用模板字面量拼接到输出字符串。 */
export const ANSI = {
  /** 保存当前光标位置 */
  SAVE_CURSOR: '\x1B[s',
  /** 恢复之前保存的光标位置 */
  RESTORE_CURSOR: '\x1B[u',
  /** 从光标处擦除到行尾 (Erase to End of Line) */
  ERASE_LINE_END: '\x1B[0K',
  /** 擦除整行 (Erase Entire Line) */
  ERASE_LINE: '\x1B[2K',
  /** 从光标处擦除到屏幕末尾 (Erase to End of Screen) */
  ERASE_SCREEN_END: '\x1B[0J',
  /** 擦除整个屏幕 (Erase Entire Screen) */
  ERASE_SCREEN: '\x1B[2J',
  /** 进入 alternate screen buffer（全屏 overlay 用） */
  ALT_SCREEN_ON: '\x1B[?1049h',
  /** 退出 alternate screen buffer，恢复主屏 */
  ALT_SCREEN_OFF: '\x1B[?1049l',
  /**
   * 开始同步输出（CSI 2026 / DECSET 2026）。
   * 终端会缓冲后续输出，直到 END_SYNC 才一次性原子刷新 → 防止增量重绘撕裂/闪烁。
   * 不支持的终端会静默忽略此私有模式（无副作用）。
   */
  BEGIN_SYNC: '\x1B[?2026h',
  /** 结束同步输出，原子刷新本帧。 */
  END_SYNC: '\x1B[?2026l',
  /** 启用 bracketed paste（DECSET 2004：粘贴文本被 200~/201~ 包裹，
 不触发按键） */
  BRACKETED_PASTE_ON: '\x1B[?2004h',
  /** 关闭 bracketed paste（退出时恢复终端默认） */
  BRACKETED_PASTE_OFF: '\x1B[?2004l',
  /** 隐藏光标 */
  HIDE_CURSOR: '\x1B[?25l',
  /** 显示光标 */
  SHOW_CURSOR: '\x1B[?25h',
  /**
   * DECSCUSR：光标形状设为稳态竖条（不闪）。
   * 终端原生光标闪烁会叠加在应用自管的 DECTCEM 翻转上，导致闪烁频率不稳、
   * 静止光标也在闪——输入类 overlay 激活期间统一切到稳态竖条，
   * 闪烁节奏完全由应用控制。竖条画在字符格左缘，天然落在格子边界上。
   */
  CURSOR_STEADY_BAR: '\x1B[6 q',
  /** DECSCUSR：光标形状恢复终端默认（退出 overlay 时写）。 */
  CURSOR_SHAPE_DEFAULT: '\x1B[0 q',
  /** 重置所有 SGR 属性 */
  RESET: '\x1B[0m',
  /** 粗体 */
  BOLD: '\x1B[1m',
  /** 细体/暗色 */
  DIM: '\x1B[2m',
  /** 斜体 */
  ITALIC: '\x1B[3m',
  /** 下划线 */
  UNDERLINE: '\x1B[4m',
  /** 闪烁（慢） */
  BLINK: '\x1B[5m',
  /** 反色 */
  REVERSE: '\x1B[7m',
  /** 删除线 */
  STRIKETHROUGH: '\x1B[9m',
} as const

// ── 类型安全的构建器 ──────────────────────────────────────────

/**
 * 将光标向上移动 n 行。
 * @param n - 移动行数；非正/非整数值被钳到 ≥1 的整数
 * @returns CUU 转义序列
 */
export function cursorUp(n: number): string {
  return `\x1B[${Math.max(1, Math.floor(n))}A`
}

/**
 * 将光标向下移动 n 行。
 * @param n - 移动行数；非正/非整数值被钳到 ≥1 的整数
 * @returns CUD 转义序列
 */
export function cursorDown(n: number): string {
  return `\x1B[${Math.max(1, Math.floor(n))}B`
}

/**
 * 将光标向右移动 n 列。
 * @param n - 移动列数；非正/非整数值被钳到 ≥1 的整数
 * @returns CUF 转义序列
 */
export function cursorForward(n: number): string {
  return `\x1B[${Math.max(1, Math.floor(n))}C`
}

/**
 * 将光标向左移动 n 列。
 * @param n - 移动列数；非正/非整数值被钳到 ≥1 的整数
 * @returns CUB 转义序列
 */
export function cursorBack(n: number): string {
  return `\x1B[${Math.max(1, Math.floor(n))}D`
}

/**
 * 移动光标到绝对位置 (row, col)。1-based。
 * @param row - 目标行（1-based）；非正/非整数值被钳到 ≥1 的整数
 * @param col - 目标列（1-based）；非正/非整数值被钳到 ≥1 的整数
 * @returns CUP 转义序列
 */
export function cursorTo(row: number, col: number): string {
  return `\x1B[${Math.max(1, Math.floor(row))};${Math.max(1, Math.floor(col))}H`
}

/**
 * 移动光标到第 col 列（保持当前行）。1-based。
 * @param col - 目标列（1-based）；非正/非整数值被钳到 ≥1 的整数
 * @returns CHA 转义序列
 */
export function cursorToCol(col: number): string {
  return `\x1B[${Math.max(1, Math.floor(col))}G`
}

// ── SGR (Select Graphic Rendition) 颜色构建器 ──────────────────

/**
 * hex 颜色字符串 → RGB 元组。
 * 支持 `#rgb`、`#rrggbb` 格式。无法解析时（含 chalk 命名色）返回 null——
 * 调用方以此区分 truecolor 轨主题 token 与 16 色轨命名色（shimmer 降级判定）。
 * @param hex - hex 颜色字符串（`#rgb` / `#rrggbb`）。
 * @returns `[r, g, b]`（0-255）；无法解析时 null。
 */
export function hexToRgb(hex: string): [number, number, number] | null {
  const match = hex.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
  if (!match) return null
  const h = match[1]
  /* v8 ignore next -- 正则 ^#(...)$ 匹配成功时捕获组必存在；noUncheckedIndexedAccess 收窄防御 */
  if (h === undefined) return null
  if (h.length === 3) {
    /* v8 ignore next -- h.length === 3 时下标 0/1/2 恒存在；noUncheckedIndexedAccess 收窄防御 */
    const r = h[0] ?? '', g = h[1] ?? '', b = h[2] ?? ''
    return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16)]
  }
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/**
 * chalk 命名色 → 基础 16 色 SGR 前景码。
 * fallback 主题轨（theme-palettes.ts）用命名色表达 16 色语义；此前 fg() 只认
 * hex，命名色被静默丢弃成无色 —— 现在映射为标准 30-37/90-97。
 */
const NAMED_FG_CODES: Record<string, number> = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
  gray: 90, grey: 90,
  blackBright: 90, redBright: 91, greenBright: 92, yellowBright: 93,
  blueBright: 94, magentaBright: 95, cyanBright: 96, whiteBright: 97,
}

/**
 * RGB → xterm-256 最近邻索引（256 色中间档量化）。
 * 候选双轨取最优：6×6×6 色立方（16-231，分量档 0/95/135/175/215/255）
 * 与 24 级灰阶（232-255，8+10i）。距离用 RGB 欧氏平方（对量化到 256 档足够）。
 * @param r - 红色分量（0-255）
 * @param g - 绿色分量（0-255）
 * @param b - 蓝色分量（0-255）
 * @returns xterm-256 调色板索引（16-255）
 */
export function rgbToXterm256(r: number, g: number, b: number): number {
  const toCubeIdx = (v: number): number => {
    if (v < 48) return 0
    if (v < 115) return 1
    return Math.min(5, Math.floor((v - 35) / 40))
  }
  const CUBE = [0, 95, 135, 175, 215, 255] as const
  const ci = toCubeIdx(r), gi = toCubeIdx(g), bi = toCubeIdx(b)
  /* v8 ignore next -- toCubeIdx 返回 0..5 恒在 CUBE（长 6）界内；noUncheckedIndexedAccess 收窄防御 */
  const cr = CUBE[ci] ?? 0, cg = CUBE[gi] ?? 0, cb = CUBE[bi] ?? 0
  const cubeDist = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2

  // 最近灰阶：232 + i，亮度 8 + 10i (i ∈ [0, 23])
  const gray = Math.round((r + g + b) / 3)
  const gi24 = Math.max(0, Math.min(23, Math.round((gray - 8) / 10)))
  const gv = 8 + 10 * gi24
  const grayDist = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2

  return grayDist < cubeDist ? 232 + gi24 : 16 + 36 * ci + 6 * gi + bi
}

/** 当前是否应量化到 256 色（chalk 检测到 256 色但非 truecolor 终端）。 */
function use256(): boolean {
  return chalk.level === 2
}

/** 标准 ANSI16 调色板 RGB（与 NAMED_FG_CODES 码序一致：30-37、90-97）。 */
const ANSI16_RGB: readonly (readonly [number, number, number])[] = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0],
  [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0],
  [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
]

/** 码序 → chalk 命名色（与 NAMED_FG_CODES 互逆）。 */
const ANSI16_NAMES = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'blackBright', 'redBright', 'greenBright', 'yellowBright',
  'blueBright', 'magentaBright', 'cyanBright', 'whiteBright',
] as const

/**
 * RGB → 最近 ANSI16 chalk 命名色（2:4:3 感知加权；16 色档像素画近似用，
 * 调色板变更无需手维护近似表——whale-star level 1 轨）。
 * @param r - 红色分量（0-255）
 * @param g - 绿色分量（0-255）
 * @param b - 蓝色分量（0-255）
 * @returns chalk 命名色（NAMED_FG_CODES 覆盖的 16 色之一）
 */
export function rgbToAnsi16Name(r: number, g: number, b: number): string {
  let best = 0
  let bestDist = Number.POSITIVE_INFINITY
  for (let i = 0; i < ANSI16_RGB.length; i++) {
    /* v8 ignore next -- 常量表长 16，下标 0..15 恒在界内；noUncheckedIndexedAccess 收窄防御 */
    const c = ANSI16_RGB[i] ?? [0, 0, 0]
    const d = 2 * (r - c[0]) ** 2 + 4 * (g - c[1]) ** 2 + 3 * (b - c[2]) ** 2
    if (d < bestDist) { best = i; bestDist = d }
  }
  /* v8 ignore next -- 常量表长 16，best ∈ 0..15 恒在界内 */
  return ANSI16_NAMES[best] ?? 'white'
}

// ── NO_COLOR（no-color.org 规范：环境变量存在且非空字符串 → 禁用颜色）──

/** 纯函数：给定 env 是否请求无色（便于测试注入）。 */
export function noColorRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.NO_COLOR
  return v !== undefined && v !== ''
}

let colorSuppressed = noColorRequested()
/* v8 ignore next -- 测试环境不设 NO_COLOR；生产设了才走本行 */
if (colorSuppressed) chalk.level = 0

/**
 * 测试/显式覆写无色开关（只翻本模块旗标；不回改 chalk.level——生产路径由
 * 模块加载时的初始化统一压制）。测试用后应复原。
 */
export function setColorSuppressed(v: boolean): void {
  colorSuppressed = v
}

/** 当前是否压制颜色输出（NO_COLOR 已显式请求时 fg/bg 输出空串）。 */
export function isColorSuppressed(): boolean {
  return colorSuppressed
}

/**
 * 设置前景色。接受 hex（`#a8e6cf`）或 chalk 命名色（`cyan`/`redBright`）。
 * hex 在 truecolor 终端发 38;2，在 256 色终端（chalk.level === 2）量化为 38;5；
 * 命名色发基础 16 色码。无法解析时返回 ''（无着色）。NO_COLOR 请求时恒返回 ''。
 * @param colorValue - hex 颜色字符串或 chalk 命名色
 * @returns SGR 前景色序列；无法解析或无色模式时为空字符串
 */
export function fg(colorValue: string): string {
  if (colorSuppressed) return ''
  const rgb = hexToRgb(colorValue)
  if (!rgb) {
    const code = NAMED_FG_CODES[colorValue]
    return code === undefined ? '' : `\x1B[${code}m`
  }
  if (use256()) return `\x1B[38;5;${rgbToXterm256(rgb[0], rgb[1], rgb[2])}m`
  return `\x1B[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
}

/**
 * 设置背景色。接受 hex 或 chalk 命名色（命名色码 +10 为背景码）。
 * 降级规则同 fg()。
 * @param colorValue - hex 颜色字符串或 chalk 命名色
 * @returns SGR 背景色序列；无法解析时为空字符串
 */
export function bg(colorValue: string): string {
  if (colorSuppressed) return ''
  const rgb = hexToRgb(colorValue)
  if (!rgb) {
    const code = NAMED_FG_CODES[colorValue]
    return code === undefined ? '' : `\x1B[${code + 10}m`
  }
  if (use256()) return `\x1B[48;5;${rgbToXterm256(rgb[0], rgb[1], rgb[2])}m`
  return `\x1B[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
}

/**
 * 用 ANSI 前景色 + 可选 SGR 属性包裹文本。
 * 始终以 ANSI.RESET 结尾，防止颜色泄露。
 * @param text - 要着色的文本
 * @param fgHex - 前景色（hex 或 chalk 命名色，同 fg()）
 * @param opts - 可选 SGR 属性（bold/dim/italic/underline）
 * @returns 着色后的字符串（末尾带 RESET）
 */
export function color(
  text: string,
  fgHex: string,
  opts?: { bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean },
): string {
  let prefix = fg(fgHex)
  if (opts?.bold) prefix += ANSI.BOLD
  if (opts?.dim) prefix += ANSI.DIM
  if (opts?.italic) prefix += ANSI.ITALIC
  if (opts?.underline) prefix += ANSI.UNDERLINE
  return `${prefix}${text}${ANSI.RESET}`
}

// ── OSC 52 剪贴板 ─────────────────────────────────────────────

/**
 * OSC 52 写系统剪贴板（终端支持时；不支持者无害忽略——内部剪贴板 Alt+Y 兜底）。
 * 剪贴选区/复制后由 app 在渲染循环 drain 写出。
 * @param text - 要写入剪贴板的文本（内部 base64 编码，控制字符无注入风险）
 * @returns OSC 52 转义序列
 */
export function osc52Clipboard(text: string): string {
  return `\x1B]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`
}

// ── OSC 8 超链接 ──────────────────────────────────────────────

let hyperlinkOverride: boolean | null = null

/**
 * 测试/配置钩子：强制开/关超链接（null 恢复自动检测）。
 * @param value - true 强制开、false 强制关、null 恢复自动检测
 */
export function setHyperlinksEnabled(value: boolean | null): void {
  hyperlinkOverride = value
}

/**
 * OSC 8 支持启发式检测。终端无标准能力查询协议，按主流终端约定判断：
 * - 环境开关优先：`RIVET_HYPERLINKS=0/1`、`FORCE_HYPERLINK`
 * - 已知支持的 TERM_PROGRAM：iTerm2 / WezTerm / VS Code / Hyper / ghostty / Tabby
 * - kitty（TERM 前缀）、VTE ≥ 0.50（GNOME Terminal 系）、Windows Terminal（WT_SESSION）
 * - tmux/screen 与 dumb 终端保守降级（tmux 需 passthrough 配置，默认关闭）
 * @param env - 参与检测的环境变量集合（默认 process.env，可注入用于测试）
 * @returns 终端是否支持 OSC 8 超链接
 */
export function detectHyperlinkSupport(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.RIVET_HYPERLINKS === '0') return false
  if (env.RIVET_HYPERLINKS === '1' || env.FORCE_HYPERLINK) return true
  const term = env.TERM ?? ''
  if (term === 'dumb' || !process.stdout.isTTY) return false
  if (env.TMUX || term.startsWith('screen')) return false
  const program = env.TERM_PROGRAM ?? ''
  if (['iTerm.app', 'WezTerm', 'vscode', 'Hyper', 'ghostty', 'Tabby'].includes(program)) return true
  if (term.startsWith('xterm-kitty')) return true
  if (env.WT_SESSION) return true
  const vte = Number.parseInt(env.VTE_VERSION ?? '', 10)
  if (Number.isFinite(vte) && vte >= 5000) return true
  return false
}

let detectedSupport: boolean | null = null

function hyperlinksSupported(): boolean {
  if (hyperlinkOverride !== null) return hyperlinkOverride
  if (detectedSupport === null) detectedSupport = detectHyperlinkSupport()
  return detectedSupport
}

/**
 * 把文本包装为 OSC 8 可点击超链接；不支持的终端返回纯文本（零污染降级）。
 * url 中的控制字符会被剥离（OSC 序列注入防护）。
 * @param text - 链接显示文本
 * @param url - 链接目标；控制字符剥离后为空时返回纯文本
 * @returns OSC 8 序列包裹的文本，或降级后的纯文本
 */
export function hyperlink(text: string, url: string): string {
  if (!hyperlinksSupported()) return text
  const safeUrl = url.replace(/[\x00-\x1F\x7F]/g, '')
  if (!safeUrl) return text
  return `\x1B]8;;${safeUrl}\x07${text}\x1B]8;;\x07`
}

/**
 * 文件路径 → file:// 超链接（相对路径基于 cwd 归一为绝对路径）。
 * @param text - 链接显示文本
 * @param filePath - 文件路径（绝对或相对）
 * @param cwd - 相对路径的基准目录（默认 process.cwd()）
 * @returns OSC 8 file:// 超链接，或降级后的纯文本
 */
export function fileLink(text: string, filePath: string, cwd = process.cwd()): string {
  const abs = filePath.startsWith('/') ? filePath : `${cwd}/${filePath}`
  return hyperlink(text, `file://${abs}`)
}

// ── 终端内联图片协议 ──────────────────────────────────────────

/** 支持的终端内联图片协议。'none' 表示降级为文本占位。 */
export type ImageProtocol = 'kitty' | 'iterm2' | 'none'

let imageProtocolOverride: ImageProtocol | null = null

/**
 * 测试/配置钩子：强制指定图片协议（null 恢复自动检测）。
 * @param value - 强制使用的协议；null 恢复自动检测
 */
export function setImageProtocol(value: ImageProtocol | null): void {
  imageProtocolOverride = value
}

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
export function detectImageProtocol(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = process.stdout.isTTY,
): ImageProtocol {
  const override = env.RIVET_IMAGES?.toLowerCase()
  if (override === '0' || override === 'off' || override === 'none') return 'none'
  if (override === 'kitty' || override === 'iterm2') return override
  const term = env.TERM ?? ''
  if (term === 'dumb' || !isTTY) return 'none'
  if (env.TMUX || term.startsWith('screen')) return 'none'
  const program = env.TERM_PROGRAM ?? ''
  if (program === 'iTerm.app') return 'iterm2'
  if (term.startsWith('xterm-kitty')) return 'kitty'
  if (['ghostty', 'WezTerm', 'WarpTerminal', 'konsole'].includes(program)) return 'kitty'
  if (env.KONSOLE_VERSION) return 'kitty'
  return 'none'
}

let detectedImageProtocol: ImageProtocol | null = null

/**
 * 当前生效的图片协议（带缓存 + override 钩子）。
 * @returns override 优先，否则首次调用时检测并缓存的协议
 */
export function imageProtocol(): ImageProtocol {
  if (imageProtocolOverride !== null) return imageProtocolOverride
  if (detectedImageProtocol === null) detectedImageProtocol = detectImageProtocol()
  return detectedImageProtocol
}

// ── 终端查询 ──────────────────────────────────────────────────

/** 查询光标位置。终端会通过 stdin 返回 `\x1B[row;colR`。 */
export const QUERY_CURSOR_POS = '\x1B[6n'

/** 查询终端尺寸（备用方案）。某些终端不支持 stdout.columns。 */
export const QUERY_TERMINAL_SIZE = '\x1B[18t'
