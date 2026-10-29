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

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { detectImageMime } from './image-attach.js'

const execFileAsync = promisify(execFile)

/** 焦点防抖窗口 (ms)：编辑器从 overlay 切回后 1s 内的 Ctrl+V 跳过剪贴板读图 */
export const FOCUS_DEBOUNCE_MS = 1_000

// ── Public types ──

/** 剪贴板图片：data URL + MIME + 文件名 + 来源分类（气泡/上屏用）。 */
export interface ClipboardImage {
  /** data:image/...;base64,... */
  dataUrl: string
  mime: string
  name: string
  source: 'png' | 'jpeg' | 'image'
}

/** 剪贴板读图器契约（测试注入与真实实现共用）。 */
export interface ClipboardReader {
  readImage(): Promise<ClipboardImage | null>
  /** 可选：文本读取也走注入（测试密封化——否则文本路径会调真实 pbpaste，
   *  剪贴板有内容时用例被环境扰动）。 */
  readText?(): Promise<string | null>
}

/** tryShellClipboard 的注入参数（测试覆盖各平台 shell 分支）。 */
export interface ShellClipboardOpts {
  execFile?: (bin: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>
  platform?: NodeJS.Platform
  readFile?: (path: string) => Promise<Buffer>
  tmpdir?: string
  randomUUID?: () => string
}

// ── Reader injection (for testing) ──

let _reader: ClipboardReader | null = null

/** 注入/清除测试 reader（null 恢复真实 shell 路径）。
 * @param reader - 剪贴板读图 mock；null 恢复真实 shell 路径
 */
export function setClipboardReader(reader: ClipboardReader | null): void {
  _reader = reader
}

// ── Main entry ──

/**
 * 读系统剪贴板图片；无图或读取失败返回 null（调用方据此 fallback 到文本）。
 * 优先测试注入 reader，否则走平台 shell 命令链。
 * @returns 剪贴板图片；无图/失败/不支持时为 null
 */
export async function readImageFromClipboard(): Promise<ClipboardImage | null> {
  if (_reader) {
    try {
      return await _reader.readImage()
    } catch {
      return null
    }
  }
  return tryShellClipboard()
}

/**
 * 读系统剪贴板文本（Ctrl+V 无图时的 fallback；部分终端不经 bracketed paste
 * 传递粘贴文本）。各平台优先 pbpaste / wl-paste / xclip / PowerShell；
 * Linux 最后尝试 powershell.exe，覆盖 WSL 的 Windows 剪贴板。
 * @param opts - 可选 shell 注入参数（缺省用真实 execFile/平台）
 * @returns 剪贴板文本；无工具或失败时 null
 */
export async function readTextFromClipboard(
  opts?: Pick<ShellClipboardOpts, 'execFile' | 'platform'>,
): Promise<string | null> {
  // 注入路径优先（与 readImageFromClipboard 同款）——测试不落真实剪贴板工具
  if (_reader?.readText) {
    try {
      return await _reader.readText()
    } catch {
      return null
    }
  }
  const ef = opts?.execFile ?? (async (bin, args) => {
    const r = await execFileAsync(bin, args, { timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true })
    return { stdout: r.stdout, stderr: r.stderr }
  })
  const pf = opts?.platform ?? process.platform
  try {
    if (pf === 'darwin') {
      const r = await ef('pbpaste', [])
      return r.stdout
    }
    if (pf === 'linux') {
      // Wayland → X11 → WSL Windows 剪贴板；普通 Linux 无后者时同样安全降级。
      const commands: [string, string[]][] = [
        ['wl-paste', []],
        ['xclip', ['-selection', 'clipboard', '-o']],
        ['powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard']],
      ]
      for (const [bin, args] of commands) {
        try {
          const r = await ef(bin, args)
          return r.stdout
        } catch {
          // 尝试下一条命令
        }
      }
      return null
    }
    if (pf === 'win32') {
      const r = await ef('powershell', ['-NoProfile', '-Command', 'Get-Clipboard'])
      return r.stdout
    }
  } catch {
    // 无剪贴板文本工具 / 命令失败 → 返回 null
  }
  return null
}

// ── Shell fallback (exported for testing) ──

/**
 * 平台 shell 剪贴板读图链：darwin osascript / linux wl-paste+xclip / win32
 * PowerShell。任一步失败静默降级到下一个平台分支；全部失败返回 null。
 * @param opts - 注入参数（缺省用真实 execFile/平台/fs/os）
 * @returns 剪贴板图片；不可用时 null
 */
export async function tryShellClipboard(opts?: ShellClipboardOpts): Promise<ClipboardImage | null> {
  // latin1 解码：execFile 的 stdout 以 latin1 逐字节解码，二进制图（PNG/JPEG）字节
  // 才能经 Buffer.from(stdout, 'latin1') 无损回绕；utf8 解码会替换/丢弃非法字节。
  const ef = opts?.execFile ?? (async (bin, args) => {
    const r = await execFileAsync(bin, args, { timeout: 15_000, maxBuffer: 50 * 1024 * 1024, encoding: 'latin1', windowsHide: true })
    return { stdout: r.stdout, stderr: r.stderr }
  })
  const pf = opts?.platform ?? process.platform
  const rf = opts?.readFile ?? (async (p) => {
    const raw = await readFile(p)
    return Buffer.from(raw)
  })
  const td = opts?.tmpdir ?? tmpdir()
  const uuid = opts?.randomUUID ?? randomUUID

  try {
    if (pf === 'darwin') return await tryMacOSClipboard(ef, rf, td, uuid)
    if (pf === 'linux') return await tryLinuxClipboard(ef)
    if (pf === 'win32') return await tryWindowsClipboard(ef, rf, td, uuid)
  } catch {
    // 平台分支全部失败 / 无工具 → null
  }
  return null
}

// ── macOS: osascript ──

async function tryMacOSClipboard(
  ef: (bin: string, args: string[]) => Promise<{ stdout: string }>,
  rf: (path: string) => Promise<Buffer>,
  td: string,
  uuid: () => string,
): Promise<ClipboardImage | null> {
  // 1. 剪贴板是否含图片（PNG/TIFF/GIF）
  let info: string
  try {
    const r = await ef('osascript', ['-e', 'clipboard info'])
    info = r.stdout
  } catch {
    return null
  }
  if (!info.includes('«class PNG»') && !info.includes('«class jp2»') && !info.includes('TIFF picture') && !info.includes('GIF picture')) {
    return null
  }

  // 2. 按剪贴板可用类读图（PNG 优先）
  let imageClass = '«class PNG»'
  if (info.includes('«class PNG»')) imageClass = '«class PNG»'
  else if (info.includes('TIFF picture')) imageClass = 'TIFF picture'
  else if (info.includes('GIF picture')) imageClass = 'GIF picture'

  // 3. 剪贴板图片写入临时文件后读回
  const tmpPath = `${td}/rivet-clip-${uuid()}.png`
  try {
    await ef('osascript', [
      '-e',
      `set theFile to (open for access POSIX file "${tmpPath}" with write permission)`,
      '-e',
      'set eof of theFile to 0',
      '-e',
      `write (the clipboard as ${imageClass}) to theFile`,
      '-e',
      'close access theFile',
    ])

    const buf = await rf(tmpPath)
    if (buf.length === 0) return null

    // TIFF → PNG 自动转换：macOS 剪贴板原生格式是 TIFF，截图工具粘贴时若
    // 无可选 PNG 类会直接写 TIFF 数据；多数视觉模型 API 不支持 TIFF，用 sips 转 PNG。
    const mime = detectImageMime(buf, 'clipboard.png')
    if (mime === 'image/tiff' || mime === 'image/bmp') {
      const pngBuf = await convertToPng(tmpPath, ef, td, uuid)
      if (pngBuf) return bufToClipboardImage(pngBuf, 'clipboard.png')
    }
    return bufToClipboardImage(buf, 'clipboard.png')
  } catch {
    return null
  } finally {
    await unlink(tmpPath).catch(() => { /* best-effort */ })
  }
}

// ── Linux: xclip / wl-paste ──

async function tryLinuxClipboard(
  ef: (bin: string, args: string[]) => Promise<{ stdout: string }>,
): Promise<ClipboardImage | null> {
  // Wayland 优先（现代桌面更常见）
  const commands: [string, string[]][] = [
    ['wl-paste', ['-t', 'image/png']],
    ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
  ]
  for (const [bin, args] of commands) {
    try {
      const r = await ef(bin, args)
      if (!r.stdout || r.stdout.length === 0) continue
      // stdout 以 latin1 解码（默认 ef 用 encoding:'latin1'），latin1 重编码即无损回绕字节。
      const buf = Buffer.from(r.stdout, 'latin1')
      if (buf.length === 0) continue
      return bufToClipboardImage(buf, 'clipboard.png')
    } catch {
      // 尝试下一条命令
    }
  }
  return null
}

// ── Windows: PowerShell ──

async function tryWindowsClipboard(
  ef: (bin: string, args: string[]) => Promise<{ stdout: string }>,
  rf: (path: string) => Promise<Buffer>,
  td: string,
  uuid: () => string,
): Promise<ClipboardImage | null> {
  const tmpPath = `${td}\\rivet-clip-${uuid()}.png`
  try {
    const script = `
Add-Type -AssemblyName System.Windows.Forms
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img) { $img.Save('${tmpPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' }
else { exit 1 }
`.trim()
    await ef('powershell', ['-NoProfile', '-Command', script])
    const buf = await rf(tmpPath)
    if (buf.length === 0) return null
    return bufToClipboardImage(buf, 'clipboard.png')
  } catch {
    return null
  } finally {
    await unlink(tmpPath).catch(() => { /* best-effort */ })
  }
}

// ── Helpers ──

/** TIFF/BMP 经 macOS sips 转 PNG；失败返回 null。 */
async function convertToPng(
  srcPath: string,
  ef: (bin: string, args: string[]) => Promise<{ stdout: string }>,
  td: string,
  uuid: () => string,
): Promise<Buffer | null> {
  if (process.platform !== 'darwin') return null
  const pngPath = `${td}/rivet-clip-${uuid()}.png`
  try {
    await ef('sips', ['-s', 'format', 'png', srcPath, '--out', pngPath])
    const { readFile } = await import('node:fs/promises')
    const pngBuf = await readFile(pngPath)
    return pngBuf.length > 0 ? pngBuf : null
  } catch {
    return null
  } finally {
    const { unlink } = await import('node:fs/promises')
    await unlink(pngPath).catch(() => {})
  }
}

function bufToClipboardImage(buf: Buffer, name: string): ClipboardImage {
  const mime = detectImageMime(buf, name) ?? 'image/png'
  const b64 = buf.toString('base64')
  return {
    dataUrl: `data:${mime};base64,${b64}`,
    mime,
    name,
    source: mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpeg' : 'image',
  }
}
