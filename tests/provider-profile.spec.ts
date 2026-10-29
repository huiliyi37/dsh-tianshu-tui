import { describe, expect, it } from 'vitest'
import {
  adoptProviderModels,
  createProviderProfile,
  profileForSave,
  providerPathOps,
  validateProviderDraft,
  type ProviderDraft,
} from '../src/ui/provider-profile.js'

function draft(overrides: Partial<ProviderDraft> = {}): ProviderDraft {
  return {
    route: 'acme-gateway',
    declared: true,
    profile: {
      displayName: 'Acme Gateway',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:8317/v1',
    },
    models: [{ id: 'acme-large' }],
    modelsOverridden: true,
    keyDraft: '',
    ...overrides,
  }
}

describe('provider-profile — 创建与校验', () => {
  it('创建带端口 profile，key 只派生 apiKeyEnv，不写明文', () => {
    const profile = createProviderProfile(draft({ keyDraft: ' sk-secret\n' }))
    expect(profile).toEqual({
      displayName: 'Acme Gateway',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:8317/v1',
      models: [{ id: 'acme-large' }],
      apiKeyEnv: 'ACME_GATEWAY_API_KEY',
    })
    expect(JSON.stringify(profile)).not.toContain('sk-secret')
  })

  it('无 key/空 displayName 时省略对应字段，三种协议均可保存', () => {
    for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages']) {
      const value = draft({ profile: { api, baseURL: ' https://gateway.example:8443/v1 ' } })
      expect(createProviderProfile(value)).toEqual({ api, baseURL: 'https://gateway.example:8443/v1', models: [{ id: 'acme-large' }] })
      expect(validateProviderDraft(value, 'create')).toBeUndefined()
    }
  })

  it('拒绝非法 route、非 HTTP URL、空模型、重复模型和非法 key', () => {
    expect(validateProviderDraft(draft({ route: '9acme' }), 'create')).toMatch(/Route/)
    expect(validateProviderDraft(draft({ profile: { api: 'openai-completions', baseURL: 'file:///tmp/x' } }), 'create')).toMatch(/http/)
    expect(validateProviderDraft(draft({ models: [] }), 'create')).toMatch(/至少/)
    expect(validateProviderDraft(draft({ models: [{ id: 'm' }, { id: ' m ' }] }), 'create')).toMatch(/重复/)
    expect(validateProviderDraft(draft({ keyDraft: 'ACME=value' }), 'create')).toMatch(/Key/)
    expect(validateProviderDraft(draft({ keyDraft: 'sk-\u{1F600}' }), 'create')).toMatch(/Key/)
  })
})

describe('provider-profile — 最小编辑与模型采纳', () => {
  it('编辑保留未知字段，只 set 变化字段并 unset 清空字段', () => {
    const original = {
      baseURL: 'https://old.example/v1',
      displayName: 'Old',
      headers: { 'X-Tenant': 'private' },
      models: [{ id: 'old', compat: { thinkingFormat: 'deepseek' } }],
    }
    const value = draft({
      profile: { ...original, baseURL: 'http://127.0.0.1:9000/v1', displayName: ' ' },
      models: [{ id: 'new', compat: { thinkingFormat: 'deepseek' } }],
    })
    const next = profileForSave(value, 'ACME_GATEWAY_API_KEY', undefined)
    expect(next.headers).toEqual({ 'X-Tenant': 'private' })
    expect(providerPathOps(['providers', 'acme-gateway'], original, next)).toEqual([
      { op: 'set', path: ['providers', 'acme-gateway', 'baseURL'], value: 'http://127.0.0.1:9000/v1' },
      { op: 'set', path: ['providers', 'acme-gateway', 'models'], value: [{ id: 'new', compat: { thinkingFormat: 'deepseek' } }] },
      { op: 'unset', path: ['providers', 'acme-gateway', 'displayName'] },
    ])
  })

  it('显式 models 与 modelOverrides 互斥：set models 同时 unset modelOverrides，保留其他字段', () => {
    const original = {
      modelOverrides: { old: { name: 'Overridden', contextWindow: 12345 } },
      headers: { 'X-Tenant': 'private' },
    }
    const next = profileForSave(draft({ profile: original, models: [{ id: 'new', name: 'New' }] }), 'ACME_GATEWAY_API_KEY', undefined)
    expect(next).toEqual({ headers: { 'X-Tenant': 'private' }, models: [{ id: 'new', name: 'New' }] })
    expect(providerPathOps(['providers', 'acme-gateway'], original, next)).toEqual([
      { op: 'set', path: ['providers', 'acme-gateway', 'models'], value: [{ id: 'new', name: 'New' }] },
      { op: 'unset', path: ['providers', 'acme-gateway', 'modelOverrides'] },
    ])
  })

  it('已有 resolved apiKeyEnv 时不因新 key 重写引用', () => {
    const profile = profileForSave(draft({ keyDraft: 'new-key' }), 'DERIVED_API_KEY', 'CUSTOM_REF')
    expect(profile.apiKeyEnv).toBeUndefined()
  })

  it('发现采纳保留已有行并映射元数据', () => {
    const models = adoptProviderModels(
      [{ id: 'm', contextWindow: 123 }],
      [
        { id: 'm', contextWindow: 999 },
        { id: 'vision', name: 'Vision', contextWindow: 65536, maxTokens: 4096, inputModalities: ['text', 'image'] },
      ],
      new Set(['m', 'vision']),
    )
    expect(models).toEqual([
      { id: 'm', contextWindow: 123 },
      { id: 'vision', name: 'Vision', contextWindow: 65536, maxTokens: 4096, input: ['text', 'image'] },
    ])
  })
})
