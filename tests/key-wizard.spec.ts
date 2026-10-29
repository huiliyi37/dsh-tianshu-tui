/**
 * key-wizard.spec.ts — /key 供应商选择步骤纯函数层的单测：引用派生规则
 * （与 web 模型页 store.ts 的 deriveKeyRef 同规则钉死）、profile 声明优先的
 * 解析次序、picker 条目构建（默认置首 + 已配置 ✓ 后缀）。
 * 回流自 tianshu-public（上游 tests/key-wizard.spec.ts）。
 */
import { describe, expect, it } from 'vitest'
import { buildProviderItems, deriveKeyRef, resolveKeyRef, type WizardProviderEntry } from '../src/ui/key-wizard.js'

describe('deriveKeyRef', () => {
  // 与 packages/client/ui-models tests/components.spec.tsx 的钉死用例同形：
  // 两侧规则漂移会在各自套件同时红。
  it('大写并把非字母数字连串折叠为单个下划线', () => {
    expect(deriveKeyRef('anthropic')).toBe('ANTHROPIC_API_KEY')
    expect(deriveKeyRef('minimax-cn')).toBe('MINIMAX_CN_API_KEY')
    expect(deriveKeyRef('openrouter')).toBe('OPENROUTER_API_KEY')
    expect(deriveKeyRef('a--b..c')).toBe('A_B_C_API_KEY')
  })
})

describe('resolveKeyRef', () => {
  it('profile 显式声明的 apiKeyEnv 优先于派生', () => {
    expect(resolveKeyRef('openrouter', 'OPENROUTER_API_KEY')).toBe('OPENROUTER_API_KEY')
    expect(resolveKeyRef('acme-gateway', 'ACME_CUSTOM_REF')).toBe('ACME_CUSTOM_REF')
  })

  it('未声明或空串时落派生规则', () => {
    expect(resolveKeyRef('openrouter', undefined)).toBe('OPENROUTER_API_KEY')
    expect(resolveKeyRef('minimax-cn', '')).toBe('MINIMAX_CN_API_KEY')
  })
})

describe('buildProviderItems', () => {
  const directory: WizardProviderEntry[] = [
    { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
    { provider: 'openrouter', displayName: 'openrouter', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openrouter'] },
    { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'] },
  ]

  it('默认供应商置首带 current，已配置条目带 ✓ 后缀，其余保持目录序', () => {
    const items = buildProviderItems(directory, new Map([['anthropic', true], ['openrouter', false]]), 'openrouter')
    expect(items).toEqual([
      { label: 'openrouter', value: 'openrouter', current: true },
      { label: 'DeepSeek', value: 'deepseek-official' },
      { label: 'anthropic ✓', value: 'anthropic' },
    ])
  })

  it('无默认供应商时不置首；目录为空返回空数组', () => {
    expect(buildProviderItems(directory, new Map(), undefined)[0])
      .toEqual({ label: 'DeepSeek', value: 'deepseek-official' })
    expect(buildProviderItems([], new Map(), 'openrouter')).toEqual([])
  })

  it('默认供应商不在目录中时不追加（目录是唯一事实源）', () => {
    const items = buildProviderItems(directory, new Map(), 'gone-provider')
    expect(items.map(item => item.value)).toEqual(['deepseek-official', 'openrouter', 'anthropic'])
    expect(items.every(item => item.current !== true)).toBe(true)
  })

  it('仅明确官方 DeepSeek 别名归并；同名同 key 的 proxy 独立且 configured 保留 ✓', () => {
    const duplicates: WizardProviderEntry[] = [
      { ...directory[0]!, keyRef: 'DEEPSEEK_API_KEY', officialAlias: 'deepseek' },
      {
        provider: 'deepseek', displayName: 'deepseek', settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'deepseek'], keyRef: 'DEEPSEEK_API_KEY', officialAlias: 'deepseek',
      },
      {
        provider: 'deepseek-proxy', displayName: 'DeepSeek', settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'deepseek-proxy'], keyRef: 'DEEPSEEK_API_KEY', declared: true,
      },
      directory[1]!,
    ]
    const items = buildProviderItems(duplicates, new Map([['deepseek', true]]), undefined)
    expect(items).toEqual([
      { label: 'DeepSeek ✓', value: 'deepseek-official' },
      { label: 'DeepSeek', value: 'deepseek-proxy' },
      { label: 'openrouter', value: 'openrouter' },
    ])
  })

  it('分组同时约束 family 与认证引用，不按显示名字符串误删不同 adapter', () => {
    const entries: WizardProviderEntry[] = [
      { ...directory[0]!, keyRef: 'DEEPSEEK_API_KEY' },
      {
        provider: 'deepseek-custom', displayName: 'deepseek', settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'deepseek-custom'], keyRef: 'DEEPSEEK_CUSTOM_API_KEY',
      },
      {
        provider: 'moonshotai', displayName: 'Moonshot', settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'moonshotai'], keyRef: 'MOONSHOT_API_KEY',
      },
      {
        provider: 'moonshotai-cn', displayName: 'Moonshot CN', settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'moonshotai-cn'], keyRef: 'MOONSHOT_API_KEY',
      },
    ]
    expect(buildProviderItems(entries, new Map(), undefined).map(item => item.value))
      .toEqual(['deepseek-official', 'deepseek-custom', 'moonshotai', 'moonshotai-cn'])
  })

  it('deepseek-account 未证明可用（false 或未知）时过滤', () => {
    const account: WizardProviderEntry = {
      provider: 'deepseek-account', displayName: 'DeepSeek Account',
      settingsNs: 'llm-deepseek-account', settingsPath: [],
    }
    expect(buildProviderItems([account, directory[0]!], new Map(), undefined))
      .toEqual([{ label: 'DeepSeek', value: 'deepseek-official' }])
    expect(buildProviderItems([{ ...account, accountAvailable: false }, directory[0]!], new Map(), undefined))
      .toEqual([{ label: 'DeepSeek', value: 'deepseek-official' }])
  })

  it('deepseek-account 有非空模型组时只显示不可提交的登录状态', () => {
    const account: WizardProviderEntry = {
      provider: 'deepseek-account', displayName: 'DeepSeek Account',
      settingsNs: 'llm-deepseek-account', settingsPath: [], accountAvailable: true,
    }
    expect(buildProviderItems([account, directory[0]!], new Map(), undefined)).toEqual([
      { label: 'DeepSeek Account（已登录，无需 API Key）', value: 'deepseek-account', header: true },
      { label: 'DeepSeek', value: 'deepseek-official' },
    ])
  })

  it('默认路由位于重复组时由默认项代表该组并置首', () => {
    const duplicates: WizardProviderEntry[] = [
      { ...directory[0]!, keyRef: 'DEEPSEEK_API_KEY', officialAlias: 'deepseek' },
      {
        provider: 'deepseek', displayName: 'deepseek', settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'deepseek'], keyRef: 'DEEPSEEK_API_KEY', officialAlias: 'deepseek',
      },
      directory[1]!,
    ]
    expect(buildProviderItems(duplicates, new Map(), 'deepseek')).toEqual([
      { label: 'deepseek', value: 'deepseek', current: true },
      { label: 'openrouter', value: 'openrouter' },
    ])
  })
})
