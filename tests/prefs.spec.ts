/**
 * prefs — 本地偏好持久化层纯函数契约。
 *
 * 容错优先：损坏/缺失/形状不对逐项丢弃；原子写往返；VITEST 密封门。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GLANCE_HIDEABLE_SEGMENTS,
  parsePrefs,
  prefsEnabled,
  readPrefs,
  writePrefs,
} from '../src/prefs.js'

function tmpPrefs(): string {
  return join(mkdtempSync(join(tmpdir(), 'dsh-prefs-')), 'prefs.json')
}

describe('parsePrefs 容错', () => {
  it('合法形状全字段解析', () => {
    const p = parsePrefs(JSON.stringify({
      theme: 'custom:mine',
      preset: 'minimal',
      compactMode: true,
      footerInfo: 'compact',
      notifyOs: false,
      panels: { subagents: true, workflow: false },
      glance: { hideSegments: ['cost', 'cache'] },
    }))
    expect(p).toEqual({
      theme: 'custom:mine',
      preset: 'minimal',
      compactMode: true,
      footerInfo: 'compact',
      notifyOs: false,
      panels: { subagents: true, workflow: false },
      glance: { hideSegments: ['cost', 'cache'] },
    })
  })

  it('footerInfo 只收白名单三档（full/compact/off），非法丢弃', () => {
    expect(parsePrefs(JSON.stringify({ footerInfo: 'off' }))).toEqual({ footerInfo: 'off' })
    expect(parsePrefs(JSON.stringify({ footerInfo: 'full' }))).toEqual({ footerInfo: 'full' })
    expect(parsePrefs(JSON.stringify({ footerInfo: 'verbose' }))).toEqual({})
    expect(parsePrefs(JSON.stringify({ footerInfo: 42 }))).toEqual({})
  })

  it('onboarded 布尔解析（非布尔丢弃）', () => {
    expect(parsePrefs(JSON.stringify({ onboarded: true }))).toEqual({ onboarded: true })
    expect(parsePrefs(JSON.stringify({ onboarded: false }))).toEqual({ onboarded: false })
    expect(parsePrefs(JSON.stringify({ onboarded: 'yes' }))).toEqual({})
  })

  it('ghostSuggest 布尔解析（非布尔丢弃）', () => {
    expect(parsePrefs(JSON.stringify({ ghostSuggest: false }))).toEqual({ ghostSuggest: false })
    expect(parsePrefs(JSON.stringify({ ghostSuggest: true }))).toEqual({ ghostSuggest: true })
    expect(parsePrefs(JSON.stringify({ ghostSuggest: 'no' }))).toEqual({})
  })

  it('scrollbackMaxLines 正整数解析（零/负/小数/非数值丢弃）', () => {
    expect(parsePrefs(JSON.stringify({ scrollbackMaxLines: 5000 }))).toEqual({ scrollbackMaxLines: 5000 })
    expect(parsePrefs(JSON.stringify({ scrollbackMaxLines: 1 }))).toEqual({ scrollbackMaxLines: 1 })
    expect(parsePrefs(JSON.stringify({ scrollbackMaxLines: 0 }))).toEqual({})
    expect(parsePrefs(JSON.stringify({ scrollbackMaxLines: -3 }))).toEqual({})
    expect(parsePrefs(JSON.stringify({ scrollbackMaxLines: 2.5 }))).toEqual({})
    expect(parsePrefs(JSON.stringify({ scrollbackMaxLines: '5000' }))).toEqual({})
  })

  it('welcomeStyle 只收白名单两档（star/retro），非法丢弃', () => {
    expect(parsePrefs(JSON.stringify({ welcomeStyle: 'star' }))).toEqual({ welcomeStyle: 'star' })
    expect(parsePrefs(JSON.stringify({ welcomeStyle: 'retro' }))).toEqual({ welcomeStyle: 'retro' })
    expect(parsePrefs(JSON.stringify({ welcomeStyle: 'classic' }))).toEqual({})
    expect(parsePrefs(JSON.stringify({ welcomeStyle: 42 }))).toEqual({})
  })

  it('非法 JSON / 非对象 / 空串主题 → 空偏好', () => {
    expect(parsePrefs('{broken')).toEqual({})
    expect(parsePrefs('"string"')).toEqual({})
    expect(parsePrefs('null')).toEqual({})
    expect(parsePrefs(JSON.stringify({ theme: '' }))).toEqual({})
    expect(parsePrefs(JSON.stringify({ preset: '' }))).toEqual({})
  })

  it('形状不对与未知 key 逐项丢弃（前向兼容）', () => {
    const p = parsePrefs(JSON.stringify({
      theme: 42,                       // 非字符串 → 丢
      preset: '',                      // 空串 → 丢
      compactMode: 'yes',              // 非布尔 → 丢
      notifyOs: 'yes',                 // 非布尔 → 丢
      panels: { config: true, subagents: 'x' }, // config 非白名单 / subagents 非布尔 → 丢
      glance: { hideSegments: ['model', 'nope', 'cost'] }, // model 非可隐藏 / nope 未知 → 只留 cost
      futureField: { anything: true },  // 未知 key → 丢
    }))
    expect(p).toEqual({ glance: { hideSegments: ['cost'] } })
  })

  it('可隐藏段白名单与常驻面板白名单导出稳定', () => {
    expect(GLANCE_HIDEABLE_SEGMENTS).not.toContain('model')
    expect(GLANCE_HIDEABLE_SEGMENTS).not.toContain('stalled')
  })
})

describe('read/write 往返', () => {
  it('写后读回一致（原子写 tmp+rename）', () => {
    const p = tmpPrefs()
    const prefs = { theme: 'paper', compactMode: true, panels: { workflow: true } }
    writePrefs(p, prefs)
    expect(readPrefs(p)).toEqual(prefs)
    // 原子写：不留 tmp 残骸（rename 而非复制）——文件内容即最终态
    expect(readFileSync(p, 'utf-8').endsWith('\n')).toBe(true)
  })

  it('read 缺失/损坏 → 空偏好', () => {
    const dir = join(tmpPrefs(), '..')
    expect(readPrefs(join(dir, 'missing.json'))).toEqual({})
    const corrupt = tmpPrefs()
    writeFileSync(corrupt, 'not json at all')
    expect(readPrefs(corrupt)).toEqual({})
  })

  it('write 到不存在目录自动创建；写失败静默不抛', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'dsh-prefs-')), 'nested', 'deep', 'prefs.json')
    expect(() => writePrefs(p, { compactMode: true })).not.toThrow()
    expect(readPrefs(p)).toEqual({ compactMode: true })
    // 路径是一个已存在的目录 → writeFileSync 抛 EISDIR → 静默
    expect(() => writePrefs(join(p, '..'), { theme: 'x' })).not.toThrow()
  })
})

describe('prefsEnabled 密封门', () => {
  it('显式 path 优先（含 null = 显式禁用）', () => {
    expect(prefsEnabled('/tmp/x/prefs.json')).toBe('/tmp/x/prefs.json')
    expect(prefsEnabled(null)).toBeNull()
  })

  it('VITEST 下未显式指定 → null（不碰真实 home）', () => {
    expect(process.env.VITEST).toBeTruthy() // vitest 运行时注入
    expect(prefsEnabled(undefined)).toBeNull()
  })
})
