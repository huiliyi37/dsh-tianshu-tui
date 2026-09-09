import { describe, expect, it, vi } from 'vitest'
import {
  livePresetShort,
  presetListDetails,
  presetShortLabel,
  resolveShippedPresetId,
  shippedPresetBlurb,
} from '../src/preset-catalog.js'

describe('resolveShippedPresetId', () => {
  it('官方 id 原样；别名折到目录名', () => {
    expect(resolveShippedPresetId('standard')).toBe('standard')
    expect(resolveShippedPresetId('code')).toBe('ptc')
    expect(resolveShippedPresetId('creative')).toBe('cordis')
    expect(resolveShippedPresetId('creator')).toBe('cordis')
    expect(resolveShippedPresetId('mine')).toBe('mine')
  })
})

describe('shippedPresetBlurb / presetShortLabel', () => {
  it('四套 shipped 都有短名与工具集', () => {
    expect(shippedPresetBlurb('standard')?.tools).toContain('bash')
    expect(shippedPresetBlurb('ptc')?.short).toBe('PTC')
    expect(shippedPresetBlurb('ptc')?.id).toBe('ptc')
    expect(presetShortLabel('minimal')).toBe('极简')
    expect(presetShortLabel('cordis')).toBe('创造')
    expect(presetShortLabel('custom-x')).toBe('custom-x')
  })
})

describe('presetListDetails', () => {
  it('官方 description 优先，仍补工具行', () => {
    expect(presetListDetails('standard', '官方一句')).toEqual({
      capability: '官方一句',
      tools: shippedPresetBlurb('standard')?.tools,
    })
  })

  it('无官方 description 用目录能力', () => {
    const d = presetListDetails('minimal')
    expect(d.capability).toContain('双工具')
    expect(d.tools).toContain('str_replace_editor')
  })

  it('未知 id 只回官方 description', () => {
    expect(presetListDetails('mine', '我的面')).toEqual({ capability: '我的面' })
    expect(presetListDetails('mine')).toEqual({})
  })
})

describe('livePresetShort', () => {
  it('无会话 / 无 join → undefined；join 后短名', () => {
    expect(livePresetShort({}, null)).toBeUndefined()
    const host = {
      agents: { get: vi.fn(() => ({ ctx: { a: 1 } })) },
      reflect: {
        get: vi.fn((name: string) => name === 'agentPresets'
          ? { composedPreset: () => 'standard' }
          : undefined),
      },
    }
    expect(livePresetShort(host, 's1')).toBe('标准')
  })
})
