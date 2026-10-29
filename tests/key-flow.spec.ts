/**
 * key-flow.spec.ts — /key 供应商密钥配置装配层测试（审查修复：装配层零覆盖）。
 *
 * 覆盖：llm 目录解析（缺席降级 DeepSeek 直开 / 在场构建供应商 picker 条目）、
 * profile apiKeyEnv 优先于派生（openKeyDialogForEntry target.ref）、afterSave
 * 激活步条件挂载与落盘后 mutate、probe 分派（llm-deepseek → 真实探测；
 * 其他 → discoverModels 三分类）、首启引导四守卫（TTY/未配置/run 级守护）。
 * 外部边界（reflect/overlay/picker）注入桩；对话框用真实 KeyDialogController。
 */
import { describe, expect, it, vi } from 'vitest'
import { KeyFlow } from '../src/ui/key-flow.js'
import { KeyDialogController, type KeyDialogCredentials } from '../src/ui/key-dialog.js'
import type { OverlayController } from '../src/engine/overlay-controller.js'
import { PickerController } from '../src/picker.js'
import type { RivetTheme } from '../src/theme.js'
import type { ProviderFlow } from '../src/ui/provider-flow.js'

function fakeTheme(): RivetTheme {
  return {
    primary: '#111111', secondary: '#222222', success: '#333333',
    warning: '#444444', error: '#555555', dim: '#666666', muted: '#777777',
    pulseQuiet: '#888888', pulseActive: '#999999', pulseAlert: '#aaaaaa',
    userColor: '#bbbbbb', assistantColor: '#cccccc', systemColor: '#dddddd',
    brandColor: '#eeeeee', toolColor: () => '#000000', contextColor: () => '#000000',
  }
}

interface OverlayStub {
  activeId(): string | null
  activate(id: string): void
  deactivate(): void
  rerender: ReturnType<typeof vi.fn>
}

function makeOverlay(): OverlayStub {
  let active: string | null = null
  return {
    activeId: () => active,
    activate: (id: string) => { active = id },
    deactivate: () => { active = null },
    rerender: vi.fn(),
  }
}

function makeFlow(opts: {
  reflectGet?: (name: string, optional?: boolean) => unknown
  stdinIsTTY?: () => boolean
  apiKeyReady?: () => boolean
  onConfigEntryMissing?: () => void
  providerFlow?: ProviderFlow
  defaultProvider?: string
} = {}) {
  const overlay = makeOverlay() as unknown as OverlayController
  const picker = { open: vi.fn() } as unknown as PickerController & { open: ReturnType<typeof vi.fn> }
  const dialog = new KeyDialogController({ getTheme: fakeTheme })
  const reflect = { get: opts.reflectGet ?? vi.fn(() => undefined) }
  const defaultProvider = opts.defaultProvider
  const flow = new KeyFlow({
    overlay,
    picker,
    keyDialog: dialog,
    providerFlow: opts.providerFlow,
    agentDefaultModel: defaultProvider === undefined
      ? undefined
      : { currentSelection: () => ({ provider: defaultProvider }) },
    reflect,
    isDisposed: () => false,
    stdinIsTTY: opts.stdinIsTTY ?? (() => true),
    apiKeyReady: opts.apiKeyReady ?? (() => false),
    onConfigEntryMissing: opts.onConfigEntryMissing,
  })
  return { flow, overlay, picker, dialog, reflect }
}

/** 可配置供应商目录（llm seam 返回形状）。 */
const DIRECTORY = [
  { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
  { provider: 'openrouter', displayName: 'openrouter', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openrouter'] },
]
const ACCOUNT_ENTRY = {
  provider: 'deepseek-account', displayName: 'DeepSeek Account',
  settingsNs: 'llm-deepseek-account', settingsPath: [],
}

/** 凭据面桩：describe 默认未配置可写；set 记录。 */
function makeCredentials(): KeyDialogCredentials & { set: ReturnType<typeof vi.fn> } {
  return {
    describe: vi.fn(async () => ({ configured: false, writable: true })),
    set: vi.fn(async () => {}),
  } as KeyDialogCredentials & { set: ReturnType<typeof vi.fn> }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 10))
}

describe('KeyFlow — llm 目录解析与降级', () => {
  it('reflect 无 llm seam（或面缺 listConfigurableProviders）→ 目录空，降级 DeepSeek 直开', async () => {
    const { flow, overlay, picker } = makeFlow()
    await flow.openKeyDialog()
    expect(picker.open).not.toHaveBeenCalled()
    expect(overlay.activeId()).toBe('key-dialog')
  })

  it('目录在场 → 供应商 picker 打开（默认置首 current + 已配置 ✓ 后缀）', async () => {
    const credentials = makeCredentials()
    credentials.describe = vi.fn(async () => ({ configured: true, writable: true }))
    const { flow, overlay, picker } = makeFlow({
      reflectGet: (name) => {
        if (name === 'llm') return { listConfigurableProviders: () => DIRECTORY }
        if (name === 'credentials') return credentials
        return undefined
      },
    })
    await flow.openKeyDialog()
    expect(picker.open).toHaveBeenCalledTimes(1)
    const [title, items] = picker.open.mock.calls[0] as [string, Array<{ label: string; value: string; current?: boolean }>]
    expect(title).toBe('选择供应商（配置 API 密钥）')
    // 默认模型缺省（agentDefaultModel undefined）→ 不置首；已配置 ✓ 后缀
    expect(items.map(i => i.label)).toEqual(['DeepSeek ✓', 'openrouter ✓'])
    expect(overlay.activeId()).toBe('picker')
  })

  it('官方与 pi-ai deepseek 解析到同一 keyRef 时只展示一项', async () => {
    const credentials = makeCredentials()
    const routes = [
      DIRECTORY[0]!,
      {
        provider: 'deepseek', displayName: 'deepseek', settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'deepseek'], declared: false,
      },
      DIRECTORY[1]!,
    ]
    const settings = {
      describe: () => [
        { ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
        { ns: 'llm-pi-ai', value: { providers: { deepseek: {} } } },
      ],
      mutate: vi.fn(async () => {}),
    }
    const { flow, picker } = makeFlow({
      reflectGet: (name) => {
        if (name === 'llm') return { listConfigurableProviders: () => routes }
        if (name === 'credentials') return credentials
        if (name === 'settings') return settings
        return undefined
      },
    })
    await flow.openKeyDialog()
    const [, items] = picker.open.mock.calls[0] as [string, Array<{ label: string; value: string }>]
    expect(items).toEqual([
      { label: 'DeepSeek', value: 'deepseek-official' },
      { label: 'openrouter', value: 'openrouter' },
    ])
  })

  it('仅 modelOverrides 用户覆盖时真实 picker 仍保留官方与自定义 deepseek', async () => {
    const credentials = makeCredentials()
    const customized = {
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      modelOverrides: { 'deepseek-chat': { maxTokens: 8192 } },
    }
    const routes = [
      DIRECTORY[0]!,
      {
        provider: 'deepseek', displayName: 'deepseek', settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'deepseek'], declared: false,
      },
    ]
    const settings = {
      describe: () => [
        { ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
        {
          ns: 'llm-pi-ai',
          value: { providers: { deepseek: customized } },
          user: { providers: { deepseek: customized } },
        },
      ],
      mutate: vi.fn(async () => {}),
    }
    const overlay = makeOverlay() as unknown as OverlayController
    const picker = new PickerController({ getTheme: fakeTheme })
    const flow = new KeyFlow({
      overlay,
      picker,
      keyDialog: new KeyDialogController({ getTheme: fakeTheme }),
      reflect: {
        get: (name) => {
          if (name === 'llm') return { listConfigurableProviders: () => routes }
          if (name === 'credentials') return credentials
          if (name === 'settings') return settings
          return undefined
        },
      },
      isDisposed: () => false,
      stdinIsTTY: () => true,
      apiKeyReady: () => false,
    })
    await flow.openKeyDialog()
    expect(picker.count).toBe(2)
    expect(picker.selected?.value).toBe('deepseek-official')
    picker.move(1)
    expect(picker.selected?.value).toBe('deepseek')
  })

  it('自定义 baseURL/api/models 的同名同 key 三组不合并，创建 sentinel 保持可用', async () => {
    const credentials = makeCredentials()
    const providerFlow = {
      openCreate: vi.fn(async () => {}),
      openEdit: vi.fn(async () => true),
    } as unknown as ProviderFlow
    const customized = {
      baseURL: 'https://pi-custom.example/v1', api: 'openai-responses', models: [{ id: 'pi-custom' }],
    }
    const proxy = {
      baseURL: 'https://proxy.example/v1', api: 'anthropic-messages', models: [{ id: 'proxy-only' }],
    }
    const routes = [
      DIRECTORY[0]!,
      {
        provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'deepseek'], declared: false,
      },
      {
        provider: 'deepseek-proxy', displayName: 'DeepSeek', settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'deepseek-proxy'], declared: true,
      },
    ]
    const settings = {
      describe: () => [
        {
          ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
          user: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
        },
        {
          ns: 'llm-pi-ai',
          value: { providers: {
            deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY', ...customized },
            'deepseek-proxy': { apiKeyEnv: 'DEEPSEEK_API_KEY', ...proxy },
          } },
          user: { providers: {
            deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY', ...customized },
            'deepseek-proxy': { apiKeyEnv: 'DEEPSEEK_API_KEY', ...proxy },
          } },
        },
      ],
      mutate: vi.fn(async () => {}),
    }
    const { flow, picker } = makeFlow({
      providerFlow,
      reflectGet: (name) => {
        if (name === 'llm') return { listConfigurableProviders: () => routes }
        if (name === 'credentials') return credentials
        if (name === 'settings') return settings
        return undefined
      },
    })
    await flow.openKeyDialog()
    const [, items, commit] = picker.open.mock.calls[0] as [
      string, Array<{ label: string; value: string }>, (item: { value: string }) => void,
    ]
    expect(items.map(item => item.value)).toEqual([
      'deepseek-official', 'deepseek', 'deepseek-proxy', '\0create-pi-ai',
    ])
    expect(items.at(-1)?.label).toContain('新增自定义')
    commit(items.at(-1)!)
    await settle()
    expect(providerFlow.openCreate).toHaveBeenCalledOnce()
    expect(providerFlow.openEdit).not.toHaveBeenCalled()
  })

  it('deepseek-account 模型组为空时隐藏，且不探测账号 API Key 引用', async () => {
    const credentials = makeCredentials()
    const listModels = vi.fn(async () => [])
    const { flow, picker } = makeFlow({
      reflectGet: (name) => {
        if (name === 'llm') return {
          listConfigurableProviders: () => [ACCOUNT_ENTRY, ...DIRECTORY],
          listProviders: () => [{ id: 'deepseek-account' }],
          listModels,
          resolveModelInfo: vi.fn(async () => ({})),
        }
        if (name === 'credentials') return credentials
        return undefined
      },
    })
    await flow.openKeyDialog()
    const [, items] = picker.open.mock.calls[0] as [string, Array<{ label: string; value: string }>]
    expect(items.map(item => item.value)).toEqual(['deepseek-official', 'openrouter'])
    expect(listModels).toHaveBeenCalledWith('deepseek-account')
    expect(credentials.describe).toHaveBeenCalledTimes(2)
    expect(credentials.describe).not.toHaveBeenCalledWith('DEEPSEEK_ACCOUNT_API_KEY')
  })

  it('deepseek-account 模型组非空时仅展示只读登录状态', async () => {
    const credentials = makeCredentials()
    const resolveModelInfo = vi.fn(async () => ({}))
    const { flow, picker } = makeFlow({
      reflectGet: (name) => {
        if (name === 'llm') return {
          listConfigurableProviders: () => [ACCOUNT_ENTRY, ...DIRECTORY],
          listProviders: () => [{ id: 'deepseek-account' }],
          listModels: async () => [{ id: 'deepseek-chat' }],
          resolveModelInfo,
        }
        if (name === 'credentials') return credentials
        return undefined
      },
    })
    await flow.openKeyDialog()
    const [, items] = picker.open.mock.calls[0] as [string, Array<{ label: string; value: string; header?: boolean }>]
    expect(items[0]).toEqual({
      label: 'DeepSeek Account（已登录，无需 API Key）', value: 'deepseek-account', header: true,
    })
    expect(resolveModelInfo).toHaveBeenCalledWith('deepseek-account', 'deepseek-chat')
    expect(credentials.describe).toHaveBeenCalledTimes(2)
    expect(credentials.describe).not.toHaveBeenCalledWith('DEEPSEEK_ACCOUNT_API_KEY')
  })

  it('默认账号在只读行显示 ●，即使手动提交也不进入 API Key 对话框', async () => {
    const credentials = makeCredentials()
    const { flow, picker, dialog } = makeFlow({
      defaultProvider: 'deepseek-account',
      reflectGet: (name) => {
        if (name === 'llm') return {
          listConfigurableProviders: () => [DIRECTORY[0]!, ACCOUNT_ENTRY, DIRECTORY[1]!],
          listProviders: () => [{ id: 'deepseek-account' }],
          listModels: async () => [{ id: 'deepseek-chat' }],
          resolveModelInfo: vi.fn(async () => ({})),
        }
        if (name === 'credentials') return credentials
        return undefined
      },
    })
    const open = vi.spyOn(dialog, 'open')
    await flow.openKeyDialog()
    const [, items, commit] = picker.open.mock.calls[0] as [
      string,
      Array<{ label: string; value: string; header?: boolean; current?: boolean }>,
      (item: { value: string }) => void,
    ]
    expect(items[0]).toEqual({
      label: 'DeepSeek Account（已登录，无需 API Key） ●',
      value: 'deepseek-account', header: true, current: true,
    })
    commit(items[0]!)
    await settle()
    expect(open).not.toHaveBeenCalled()
    expect(credentials.set).not.toHaveBeenCalled()
  })

  it('模型目录读取失败时 deepseek-account 按不可用过滤', async () => {
    const credentials = makeCredentials()
    const { flow, picker } = makeFlow({
      reflectGet: (name) => {
        if (name === 'llm') return {
          listConfigurableProviders: () => [ACCOUNT_ENTRY, ...DIRECTORY],
          listProviders: () => [{ id: 'deepseek-account' }],
          listModels: async () => { throw new Error('catalog unavailable') },
          resolveModelInfo: vi.fn(async () => ({})),
        }
        if (name === 'credentials') return credentials
        return undefined
      },
    })
    await flow.openKeyDialog()
    const [, items] = picker.open.mock.calls[0] as [string, Array<{ value: string }>]
    expect(items.map(item => item.value)).toEqual(['deepseek-official', 'openrouter'])
  })

  it('ProviderFlow 在场时追加自定义入口，无碰撞时 sentinel 正常打开创建', async () => {
    const providerFlow = {
      openCreate: vi.fn(async () => {}),
      openEdit: vi.fn(async () => true),
    } as unknown as ProviderFlow
    const credentials = makeCredentials()
    const { flow, picker, dialog } = makeFlow({
      providerFlow,
      reflectGet: name => name === 'llm' ? { listConfigurableProviders: () => DIRECTORY } : name === 'credentials' ? credentials : undefined,
    })
    const open = vi.spyOn(dialog, 'open')
    await flow.openKeyDialog()
    const [, items, commit] = picker.open.mock.calls[0] as [string, Array<{ value: string; label: string }>, (item: { value: string }) => void]
    expect(items.at(-1)?.label).toContain('新增自定义')
    commit(items.at(-1)!)
    await settle()
    expect(providerFlow.openCreate).toHaveBeenCalledOnce()
    expect(providerFlow.openEdit).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('创建 sentinel 与真实 provider id 碰撞时目录条目优先', async () => {
    const colliding = {
      provider: '\0create-pi-ai', displayName: 'Collision', settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', '\0create-pi-ai'], declared: true,
    }
    const providerFlow = {
      openCreate: vi.fn(async () => {}),
      openEdit: vi.fn(async () => true),
    } as unknown as ProviderFlow
    const credentials = makeCredentials()
    const { flow, picker, dialog } = makeFlow({
      providerFlow,
      reflectGet: name => name === 'llm'
        ? { listConfigurableProviders: () => [colliding] }
        : name === 'credentials' ? credentials : undefined,
    })
    const open = vi.spyOn(dialog, 'open')
    await flow.openKeyDialog()
    const [, items, commit] = picker.open.mock.calls[0] as [
      string, Array<{ value: string; label: string }>, (item: { value: string }) => void,
    ]
    const collisionItem = items.find(item => item.label === 'Collision')
    expect(collisionItem?.value).toBe('\0create-pi-ai')
    expect(items.at(-1)?.label).toContain('新增自定义')
    commit(collisionItem!)
    await settle()
    expect(providerFlow.openEdit).toHaveBeenCalledWith(colliding)
    expect(providerFlow.openCreate).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('已有 pi-ai 项进入完整编辑器；settings 不可用时回退 KeyDialog', async () => {
    const credentials = makeCredentials()
    const providerFlow = {
      openCreate: vi.fn(async () => {}),
      openEdit: vi.fn(async () => true),
    } as unknown as ProviderFlow
    const first = makeFlow({
      providerFlow,
      reflectGet: name => name === 'llm' ? { listConfigurableProviders: () => DIRECTORY } : name === 'credentials' ? credentials : undefined,
    })
    await first.flow.openKeyDialog()
    const [, items, commit] = first.picker.open.mock.calls[0] as [string, Array<{ value: string }>, (item: { value: string }) => void]
    commit(items.find(item => item.value === 'openrouter')!)
    await settle()
    expect(providerFlow.openEdit).toHaveBeenCalledWith(DIRECTORY[1])

    const fallbackFlow = { openCreate: vi.fn(), openEdit: vi.fn(async () => false) } as unknown as ProviderFlow
    const second = makeFlow({
      providerFlow: fallbackFlow,
      reflectGet: name => name === 'llm' ? { listConfigurableProviders: () => DIRECTORY, discoverModels: async () => [] } : name === 'credentials' ? credentials : undefined,
    })
    await second.flow.openKeyDialog()
    const [, secondItems, secondCommit] = second.picker.open.mock.calls[0] as [string, Array<{ value: string }>, (item: { value: string }) => void]
    secondCommit(secondItems.find(item => item.value === 'openrouter')!)
    await settle()
    expect(second.overlay.activeId()).toBe('key-dialog')
  })
})

describe('KeyFlow — 供应商参数化 target', () => {
  it('pi-ai 路由 profile 声明 apiKeyEnv → 落盘引用用 profile 值（优先于派生）', async () => {
    const credentials = makeCredentials()
    const settings = {
      describe: () => [
        { ns: 'llm-pi-ai', value: { providers: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' } } } },
      ],
      mutate: vi.fn(async () => {}),
    }
    const { flow, dialog } = makeFlow({
      reflectGet: (name) => {
        if (name === 'llm') return { listConfigurableProviders: () => DIRECTORY, discoverModels: async () => [] }
        if (name === 'credentials') return credentials
        if (name === 'settings') return settings
        return undefined
      },
    })
    const entry = DIRECTORY[1]
    if (entry === undefined) throw new Error('fixture')
    await flow.openKeyDialogForEntry(entry, credentials)
    // 输入 + 提交（probe 桩：openrouter 走 discoverModels → ok 直接落盘）
    dialog.handleKey('unknown', 'k')
    dialog.handleKey('unknown', '1')
    dialog.handleKey('return', '')
    await settle()
    await settle()
    expect(credentials.set).toHaveBeenCalledWith('OPENROUTER_API_KEY', 'k1')
  })

  it('profile 未声明 apiKeyEnv + settings 在场 → afterSave 挂载：保存后 mutate 补写 apiKeyEnv', async () => {
    const credentials = makeCredentials()
    const mutate = vi.fn(async () => {})
    const settings = {
      describe: () => [{ ns: 'llm-pi-ai', value: { providers: { openrouter: {} } } }],
      mutate,
    }
    const { flow, dialog } = makeFlow({
      reflectGet: (name) => {
        if (name === 'llm') return { listConfigurableProviders: () => DIRECTORY, discoverModels: async () => [] }
        if (name === 'credentials') return credentials
        if (name === 'settings') return settings
        return undefined
      },
    })
    const entry = DIRECTORY[1]
    if (entry === undefined) throw new Error('fixture')
    await flow.openKeyDialogForEntry(entry, credentials)
    dialog.handleKey('unknown', 'k')
    dialog.handleKey('return', '')
    await settle()
    await settle()
    expect(credentials.set).toHaveBeenCalled()
    // afterSave：{providers: {openrouter: {apiKeyEnv: 'OPENROUTER_API_KEY'}}}
    expect(mutate).toHaveBeenCalledWith('llm-pi-ai', [{
      op: 'set',
      path: ['providers', 'openrouter', 'apiKeyEnv'],
      value: 'OPENROUTER_API_KEY',
    }])
  })

  it('llm-deepseek 段 → 探测走真实 probeDeepSeekKey（settingsNs 判据，fetch 外部边界打桩）', async () => {
    const credentials = makeCredentials()
    const fetchMock = vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
      // 断言 key 只进 Authorization 头（与 key-dialog.spec 同规则）
      expect(init?.headers?.Authorization).toBe('Bearer k')
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { flow, dialog } = makeFlow({
      reflectGet: (name) => {
        if (name === 'llm') return { listConfigurableProviders: () => DIRECTORY }
        if (name === 'credentials') return credentials
        return undefined
      },
    })
    const entry = DIRECTORY[0]
    if (entry === undefined) throw new Error('fixture')
    await flow.openKeyDialogForEntry(entry, credentials)
    dialog.handleKey('unknown', 'k')
    dialog.handleKey('return', '')
    await settle()
    await settle()
    // probe ok（200）→ 直接落盘；entry 显式传入 → ref 走派生规则
    // （deriveKeyRef('deepseek-official') = DEEPSEEK_OFFICIAL_API_KEY；
    //  无 settings 桩时 profile apiKeyEnv 缺席，落派生——与上游语义一致）
    expect(credentials.set).toHaveBeenCalledWith('DEEPSEEK_OFFICIAL_API_KEY', 'k')
  })

  it('pi-ai catalog 本地目录不能验证 key → unknown 确认态，不直接保存但仍可强存', async () => {
    const credentials = makeCredentials()
    const discoverModels = vi.fn(async () => [{ id: 'local-catalog-model' }])
    const { flow, dialog } = makeFlow({
      reflectGet: (name) => {
        if (name === 'llm') return { listConfigurableProviders: () => DIRECTORY, discoverModels }
        if (name === 'credentials') return credentials
        return undefined
      },
    })
    await flow.openKeyDialogForEntry({ ...DIRECTORY[1]!, declared: false }, credentials)
    dialog.handleKey('unknown', 'k')
    dialog.handleKey('return', '')
    await settle()
    await settle()
    expect(discoverModels).not.toHaveBeenCalled()
    expect(credentials.set).not.toHaveBeenCalled()
    const text = dialog.render(100, 24)
      .map(line => line.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, ''))
      .join('\n')
    expect(text).toContain('无法验证')
    dialog.handleKey('return', '')
    await settle()
    await settle()
    expect(credentials.set).toHaveBeenCalledWith('OPENROUTER_API_KEY', 'k')
  })

  it('pi-ai declared 自定义路由草稿端点发现成功才 ok 并保存', async () => {
    const credentials = makeCredentials()
    const discoverModels = vi.fn(async () => [{ id: 'remote-model' }])
    const settings = {
      describe: () => [{ ns: 'llm-pi-ai', value: { providers: { openrouter: {
        baseURL: 'https://draft.example/v1', api: 'openai-responses',
      } } } }],
      mutate: vi.fn(async () => {}),
    }
    const { flow, dialog } = makeFlow({
      reflectGet: (name) => {
        if (name === 'llm') return { listConfigurableProviders: () => DIRECTORY, discoverModels }
        if (name === 'credentials') return credentials
        if (name === 'settings') return settings
        return undefined
      },
    })
    await flow.openKeyDialogForEntry({ ...DIRECTORY[1]!, declared: true }, credentials)
    dialog.handleKey('unknown', 'k')
    dialog.handleKey('return', '')
    await settle()
    await settle()
    expect(discoverModels).toHaveBeenCalledWith('llm-pi-ai', {
      provider: 'openrouter', apiKey: 'k',
      baseURL: 'https://draft.example/v1', api: 'openai-responses',
    })
    expect(credentials.set).toHaveBeenCalledWith('OPENROUTER_API_KEY', 'k')
  })

  it('非 llm-deepseek 段 → discoverModels 三分类（AUTH → invalid 拒存）', async () => {
    const credentials = makeCredentials()
    const discoverModels = vi.fn(async () => { throw Object.assign(new Error('auth'), { code: 'AUTH' }) })
    const { flow, dialog } = makeFlow({
      reflectGet: (name) => {
        if (name === 'llm') return { listConfigurableProviders: () => DIRECTORY, discoverModels }
        if (name === 'credentials') return credentials
        return undefined
      },
    })
    await flow.openKeyDialogForEntry({ ...DIRECTORY[1]!, declared: true }, credentials)
    dialog.handleKey('unknown', 'k')
    dialog.handleKey('return', '')
    await settle()
    await settle()
    expect(discoverModels).toHaveBeenCalledWith('llm-pi-ai', { provider: 'openrouter', apiKey: 'k' })
    expect(credentials.set).not.toHaveBeenCalled()
  })

  it('deepseek-account 直接入口也不会打开 API Key 保存对话框', async () => {
    const credentials = makeCredentials()
    const { flow, overlay, dialog } = makeFlow()
    const open = vi.spyOn(dialog, 'open')
    await flow.openKeyDialogForEntry(ACCOUNT_ENTRY, credentials)
    expect(open).not.toHaveBeenCalled()
    expect(overlay.activeId()).toBeNull()
    expect(credentials.set).not.toHaveBeenCalled()
  })

  it('/config 的 deepseek-account 凭据入口走 missing 回调而非保存 key', async () => {
    const onConfigEntryMissing = vi.fn()
    const { flow, overlay, dialog } = makeFlow({
      onConfigEntryMissing,
      reflectGet: (name) => name === 'llm'
        ? { listConfigurableProviders: () => [ACCOUNT_ENTRY] }
        : undefined,
    })
    const open = vi.spyOn(dialog, 'open')
    await flow.openCredentialFromConfig('deepseek-account')
    expect(onConfigEntryMissing).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
    expect(overlay.activeId()).toBeNull()
  })
})

describe('KeyFlow — 首启引导四守卫', () => {
  it('TTY + 未配置 → 自动弹一次；run 级守护：第二次不再弹', async () => {
    const { flow } = makeFlow()
    const spy = vi.spyOn(flow, 'openKeyDialog')
    flow.maybeAutoOpenKeyDialog()
    flow.maybeAutoOpenKeyDialog()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('非 TTY（测试/管道）→ 不弹', async () => {
    const { flow } = makeFlow({ stdinIsTTY: () => false })
    const spy = vi.spyOn(flow, 'openKeyDialog')
    flow.maybeAutoOpenKeyDialog()
    expect(spy).not.toHaveBeenCalled()
  })

  it('API key 已就绪 → 不弹', async () => {
    const { flow } = makeFlow({ apiKeyReady: () => true })
    const spy = vi.spyOn(flow, 'openKeyDialog')
    flow.maybeAutoOpenKeyDialog()
    expect(spy).not.toHaveBeenCalled()
  })
})
