/**
 * 宿主 stderr 拦截：TTY 前台不落盘到终端，卸载后还原。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HOST_STDERR_GUARD_DISABLE_ENV,
  HOST_STDERR_LOG_MAX_BYTES,
  defaultHostStderrLogPath,
  installHostStderrGuard,
  shouldInstallHostStderrGuard,
} from '../src/host-stderr-guard.js'

describe('shouldInstallHostStderrGuard', () => {
  const tty = { isTTY: true }
  const clean = { PATH: '/usr/bin' }

  it('TTY 且干净环境则安装', () => {
    expect(shouldInstallHostStderrGuard(clean, tty)).toBe(true)
  })

  it('非 TTY / 显式关闭 / VITEST / CI 不安装', () => {
    expect(shouldInstallHostStderrGuard(clean, { isTTY: false })).toBe(false)
    expect(shouldInstallHostStderrGuard(clean, {})).toBe(false)
    expect(shouldInstallHostStderrGuard({ ...clean, [HOST_STDERR_GUARD_DISABLE_ENV]: '1' }, tty)).toBe(false)
    expect(shouldInstallHostStderrGuard({ ...clean, VITEST: '1' }, tty)).toBe(false)
    expect(shouldInstallHostStderrGuard({ ...clean, CI: 'true' }, tty)).toBe(false)
  })
})

describe('installHostStderrGuard', () => {
  function fakeStderr() {
    const passed: string[] = []
    const stream = {
      write(chunk: unknown, encoding?: unknown, cb?: unknown) {
        passed.push(String(chunk))
        const callback = typeof encoding === 'function' ? encoding : cb
        if (typeof callback === 'function') callback()
        return true
      },
    }
    return { stream, passed }
  }

  it('拦截写入：不进原流，回调 onChunk，并写入日志文件', () => {
    const { stream, passed } = fakeStderr()
    const chunks: string[] = []
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-stderr-'))
    const logPath = join(dir, 'host-stderr.log')
    const restore = installHostStderrGuard({
      stderr: stream,
      logPath,
      onChunk: (text) => { chunks.push(text) },
    })
    const line = '[llm-deepseek-api-key] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)\n'
    const ok = stream.write(line)
    expect(ok).toBe(true)
    expect(passed).toEqual([])
    expect(chunks).toEqual([line])
    expect(readFileSync(logPath, 'utf8')).toBe(line)
    restore()
    stream.write('after\n')
    expect(passed).toEqual(['after\n'])
  })

  it('Buffer 写入同样拦截；卸载后还原；重复卸载不覆盖他人补丁', () => {
    const { stream, passed } = fakeStderr()
    const chunks: string[] = []
    const restore = installHostStderrGuard({
      stderr: stream,
      logPath: null,
      onChunk: (text) => { chunks.push(text) },
    })
    stream.write(Buffer.from('hello'))
    expect(chunks).toEqual(['hello'])
    expect(passed).toEqual([])
    restore()
    const replaced = (chunk: unknown) => {
      passed.push(`other:${String(chunk)}`)
      return true
    }
    stream.write = replaced
    restore()
    stream.write('x')
    expect(passed).toEqual(['other:x'])
  })

  it('日志过大时轮转再追加', () => {
    const { stream } = fakeStderr()
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-stderr-'))
    const logPath = join(dir, 'host-stderr.log')
    writeFileSync(logPath, 'a'.repeat(HOST_STDERR_LOG_MAX_BYTES))
    const restore = installHostStderrGuard({ stderr: stream, logPath })
    stream.write('fresh\n')
    restore()
    expect(readFileSync(`${logPath}.1`, 'utf8')).toHaveLength(HOST_STDERR_LOG_MAX_BYTES)
    expect(readFileSync(logPath, 'utf8')).toBe('fresh\n')
  })
})

describe('defaultHostStderrLogPath', () => {
  it('落在 ~/.dsh-tui/host-stderr.log', () => {
    expect(defaultHostStderrLogPath()).toMatch(/\.dsh-tui[/\\]host-stderr\.log$/)
  })
})
