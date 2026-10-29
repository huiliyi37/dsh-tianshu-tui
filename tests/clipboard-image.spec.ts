/**
 * clipboard-image 剪贴板读图 — shell 路径与注入点契约测试。
 *
 * - setClipboardReader 注入：readImageFromClipboard 走 mock，覆盖 返回/空/抛错
 * - tryShellClipboard：注入 execFile/readFile/platform 覆盖 darwin/linux/win32
 *   shell 分支（osascript PNG / TIFF→sips / wl-paste+xclip / PowerShell）
 * - 无工具/无图/失败一律静默返回 null（调用方 fallback 文本）
 */

import { describe, expect, it } from 'vitest'
import {
  readImageFromClipboard,
  readTextFromClipboard,
  setClipboardReader,
  tryShellClipboard,
} from '../src/engine/clipboard-image.js'

// 1x1 transparent PNG (valid)
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`
const PNG_BUF = Buffer.from(PNG_B64, 'base64')

// TIFF little-endian magic (II*\0) + 最小填充
const TIFF_BUF = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(16)])

describe('readImageFromClipboard 注入点', () => {
  it('reader 返回图片 → 原样透传', async () => {
    setClipboardReader({
      async readImage() {
        return { dataUrl: PNG_DATA_URL, mime: 'image/png', name: 'clipboard.png', source: 'png' }
      },
    })
    const result = await readImageFromClipboard()
    expect(result).not.toBeNull()
    expect(result?.dataUrl).toBe(PNG_DATA_URL)
    expect(result?.mime).toBe('image/png')
    setClipboardReader(null)
  })

  it('reader 返回 null（剪贴板是文本）→ null', async () => {
    setClipboardReader({ async readImage() { return null } })
    expect(await readImageFromClipboard()).toBeNull()
    setClipboardReader(null)
  })

  it('reader 抛错（osascript 缺失）→ 静默 null，不 crash', async () => {
    setClipboardReader({
      async readImage() { throw new Error('osascript missing') },
    })
    expect(await readImageFromClipboard()).toBeNull()
    setClipboardReader(null)
  })

  it('readText 注入：走 mock 不落真实 pbpaste；抛错静默 null', async () => {
    setClipboardReader({
      async readImage() { return null },
      async readText() { return '剪贴板文本' },
    })
    expect(await readTextFromClipboard()).toBe('剪贴板文本')
    setClipboardReader(null)

    setClipboardReader({
      async readImage() { return null },
      async readText() { throw new Error('pbpaste missing') },
    })
    expect(await readTextFromClipboard()).toBeNull()
    setClipboardReader(null)
  })

  it('无 readText 注入的 reader → 文本路径保持原 shell 链（不抛错）', async () => {
    setClipboardReader({ async readImage() { return null } })
    const r = await readTextFromClipboard()
    expect(r === null || typeof r === 'string').toBe(true)
    setClipboardReader(null)
  })
})

describe('readTextFromClipboard shell fallback', () => {
  it('Linux/WSL：wl-paste、xclip 失败 → powershell.exe 读取 Windows 剪贴板', async () => {
    const calls: [string, string[]][] = []
    const result = await readTextFromClipboard({
      platform: 'linux',
      execFile: async (bin, args) => {
        calls.push([bin, args])
        if (bin === 'powershell.exe') return { stdout: 'sk-wsl-key\r\n' }
        throw new Error(`${bin} unavailable`)
      },
    })
    expect(result).toBe('sk-wsl-key\r\n')
    expect(calls).toEqual([
      ['wl-paste', []],
      ['xclip', ['-selection', 'clipboard', '-o']],
      ['powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard']],
    ])
  })

  it('普通 Linux：所有文本剪贴板工具失败 → null，不抛错', async () => {
    const calls: string[] = []
    const result = await readTextFromClipboard({
      platform: 'linux',
      execFile: async (bin) => {
        calls.push(bin)
        throw new Error('command not found')
      },
    })
    expect(result).toBeNull()
    expect(calls).toEqual(['wl-paste', 'xclip', 'powershell.exe'])
  })

  it('wl-paste 成功 → 保留原路径，不调用 PowerShell', async () => {
    const calls: string[] = []
    const result = await readTextFromClipboard({
      platform: 'linux',
      execFile: async (bin) => {
        calls.push(bin)
        return { stdout: 'wayland text' }
      },
    })
    expect(result).toBe('wayland text')
    expect(calls).toEqual(['wl-paste'])
  })

  it('win32 保持原生 powershell 命令', async () => {
    const calls: [string, string[]][] = []
    const result = await readTextFromClipboard({
      platform: 'win32',
      execFile: async (bin, args) => {
        calls.push([bin, args])
        return { stdout: 'windows text' }
      },
    })
    expect(result).toBe('windows text')
    expect(calls).toEqual([['powershell', ['-NoProfile', '-Command', 'Get-Clipboard']]])
  })
})

describe('tryShellClipboard linux', () => {
  it('无工具（全部命令失败）→ null', async () => {
    const result = await tryShellClipboard({
      execFile: async () => { throw new Error('command not found') },
      platform: 'linux',
      tmpdir: '/tmp',
      randomUUID: () => 'test-uuid',
    })
    expect(result).toBeNull()
  })

  it('wl-paste 返回 PNG 字节 → dataUrl 正确', async () => {
    const result = await tryShellClipboard({
      execFile: async (bin) => {
        if (bin === 'wl-paste') return { stdout: PNG_BUF.toString('latin1') }
        throw new Error(`unexpected exec: ${bin}`)
      },
      platform: 'linux',
      tmpdir: '/tmp',
      randomUUID: () => 'test-uuid',
    })
    expect(result).not.toBeNull()
    expect(result?.mime).toBe('image/png')
    expect(result?.source).toBe('png')
    expect(result?.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('wl-paste 失败 → xclip fallback', async () => {
    const result = await tryShellClipboard({
      execFile: async (bin) => {
        if (bin === 'wl-paste') throw new Error('wayland unavailable')
        if (bin === 'xclip') return { stdout: PNG_BUF.toString('latin1') }
        throw new Error(`unexpected exec: ${bin}`)
      },
      platform: 'linux',
      tmpdir: '/tmp',
      randomUUID: () => 'test-uuid',
    })
    expect(result?.mime).toBe('image/png')
  })

  it('JPEG magic → source jpeg', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
    const result = await tryShellClipboard({
      execFile: async () => ({ stdout: jpeg.toString('latin1') }),
      platform: 'linux',
      tmpdir: '/tmp',
      randomUUID: () => 'test-uuid',
    })
    expect(result?.mime).toBe('image/jpeg')
    expect(result?.source).toBe('jpeg')
  })
})

describe('tryShellClipboard darwin (osascript)', () => {
  it('剪贴板无图（clipboard info 无图片类）→ null', async () => {
    const result = await tryShellClipboard({
      execFile: async () => ({ stdout: '«class utf8»' }),
      platform: 'darwin',
      readFile: async () => PNG_BUF,
      tmpdir: '/tmp',
      randomUUID: () => 'test-uuid',
    })
    expect(result).toBeNull()
  })

  it('PNG 类 → 写临时文件读回 → dataUrl', async () => {
    const execFile = async (bin: string, args: string[]) => {
      const arg0 = args[0] ?? ''
      if (bin === 'osascript' && arg0 === '-e' && args[1]?.includes('clipboard info')) {
        return { stdout: '«class PNG»' }
      }
      if (bin === 'osascript' && arg0 === '-e' && args[1]?.includes('write')) {
        return { stdout: '' }
      }
      throw new Error(`unexpected exec: ${bin} ${args.join(' ')}`)
    }
    const result = await tryShellClipboard({
      execFile,
      platform: 'darwin',
      readFile: async () => PNG_BUF,
      tmpdir: '/tmp',
      randomUUID: () => 'test-uuid',
    })
    expect(result?.mime).toBe('image/png')
    expect(result?.dataUrl).toBe(PNG_DATA_URL)
  })

  it('TIFF 类 → sips 转 PNG', async () => {
    const execFile = async (bin: string, args: string[]) => {
      const arg0 = args[0] ?? ''
      if (bin === 'osascript' && arg0 === '-e' && args[1]?.includes('clipboard info')) {
        return { stdout: 'TIFF picture' }
      }
      if (bin === 'osascript' && arg0 === '-e' && args[1]?.includes('write')) {
        return { stdout: '' }
      }
      if (bin === 'sips') return { stdout: '' }
      throw new Error(`unexpected exec: ${bin} ${args.join(' ')}`)
    }
    const readFile = async (p: string) => (p.includes('tiff') ? TIFF_BUF : PNG_BUF)
    const result = await tryShellClipboard({
      execFile,
      platform: 'darwin',
      readFile,
      tmpdir: '/tmp',
      randomUUID: () => 'test-uuid',
    })
    // TIFF 经 sips 转出 PNG
    expect(result?.mime).toBe('image/png')
    expect(result?.dataUrl).toBe(PNG_DATA_URL)
  })
})

describe('tryShellClipboard win32', () => {
  it('PowerShell 保存剪贴板图 → dataUrl', async () => {
    const result = await tryShellClipboard({
      execFile: async (bin) => {
        if (bin === 'powershell') return { stdout: 'ok' }
        throw new Error(`unexpected exec: ${bin}`)
      },
      platform: 'win32',
      readFile: async () => PNG_BUF,
      tmpdir: 'C:\\temp',
      randomUUID: () => 'test-uuid',
    })
    expect(result?.mime).toBe('image/png')
  })

  it('PowerShell 无图（exit 1）→ null', async () => {
    const result = await tryShellClipboard({
      execFile: async () => { throw new Error('exit 1') },
      platform: 'win32',
      readFile: async () => PNG_BUF,
      tmpdir: 'C:\\temp',
      randomUUID: () => 'test-uuid',
    })
    expect(result).toBeNull()
  })
})
