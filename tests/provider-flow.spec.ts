import { describe, expect, it, vi } from 'vitest'
import { ProviderFlow } from '../src/ui/provider-flow.js'
import { ProviderEditorController, type ProviderEditorSession } from '../src/ui/provider-editor.js'
import type { OverlayController } from '../src/engine/overlay-controller.js'
import type { WizardProviderEntry } from '../src/ui/key-wizard.js'
import type { RivetTheme } from '../src/theme.js'

function fakeTheme(): RivetTheme {
  return {
    primary: '#111111', secondary: '#222222', success: '#333333', warning: '#444444', error: '#555555',
    dim: '#666666', muted: '#777777', pulseQuiet: '#888888', pulseActive: '#999999', pulseAlert: '#aaaaaa',
    userColor: '#bbbbbb', assistantColor: '#cccccc', systemColor: '#dddddd', brandColor: '#eeeeee',
    toolColor: () => '#000000', contextColor: () => '#000000',
  }
}

function makeOverlay(): OverlayController {
  let active: string | null = null
  return {
    activeId: () => active,
    activate: (id: string) => { active = id; return true },
    deactivate: () => { active = null },
    rerender: vi.fn(),
  } as unknown as OverlayController
}

const ENTRY: WizardProviderEntry = {
  provider: 'acme-gateway', displayName: 'Acme', settingsNs: 'llm-pi-ai',
  settingsPath: ['providers', 'acme-gateway'], declared: true,
}

function makeFlow(opts: {
  value?: unknown
  user?: unknown
  revision?: number
  settings?: unknown
  credentials?: unknown
  llm?: unknown
} = {}) {
  const editor = new ProviderEditorController({ getTheme: fakeTheme })
  const open = vi.spyOn(editor, 'open')
  const overlay = makeOverlay()
  const settings = opts.settings === undefined ? {
    describe: vi.fn(() => [{
      ns: 'llm-pi-ai',
      value: opts.value ?? { providers: {} },
      user: opts.user ?? { providers: {} },
      revision: opts.revision ?? 7,
    }]),
    mutate: vi.fn(async () => {}),
  } : opts.settings
  const credentials = opts.credentials === undefined ? {
    describe: vi.fn(async () => ({ writable: true })),
    set: vi.fn(async () => {}),
  } : opts.credentials
  const llm = opts.llm === undefined ? {
    listProviders: () => [{ id: 'active-route' }],
    listConfigurableProviders: () => [{ provider: 'dormant-route' }],
    discoverModels: vi.fn(async () => []),
  } : opts.llm
  const onSaved = vi.fn()
  const flow = new ProviderFlow({
    overlay,
    editor,
    reflect: { get: (name: string) => name === 'settings' ? settings : name === 'credentials' ? credentials : name === 'llm' ? llm : undefined },
    isDisposed: () => false,
    onSaved,
  })
  return { flow, editor, open, overlay, settings, credentials, llm, onSaved }
}

function sessionOf(open: ReturnType<typeof vi.spyOn>): ProviderEditorSession {
  const session = open.mock.calls[0]?.[0] as ProviderEditorSession | undefined
  if (session === undefined) throw new Error('editor did not open')
  return session
}

describe('ProviderFlow — 创建、发现与两段保存', () => {
  it('创建写整个 providers.<route>，带 revision，settings 先于 credentials；key 失败只重试 key', async () => {
    const order: string[] = []
    const mutate = vi.fn(async () => { order.push('settings') })
    const settings = {
      describe: () => [{ ns: 'llm-pi-ai', value: { providers: {} }, user: { providers: {} }, revision: 11 }],
      mutate,
    }
    const credentials = {
      describe: vi.fn(async () => ({ writable: true })),
      set: vi.fn(async () => {
        order.push('credentials')
        if (credentials.set.mock.calls.length === 1) throw new Error('key refused')
      }),
    }
    const { flow, open, onSaved } = makeFlow({ settings, credentials })
    await flow.openCreate()
    const session = sessionOf(open)
    expect(session.taken).toEqual(['active-route', 'dormant-route'])
    Object.assign(session.draft, {
      route: 'acme-gateway',
      models: [{ id: 'm' }],
      keyDraft: 'sk-secret',
    })
    session.draft.profile.displayName = 'Acme'
    session.draft.profile.baseURL = 'http://127.0.0.1:8317/v1'

    expect(await session.save(session.draft)).toEqual({ kind: 'key-error', message: 'key refused' })
    session.draft.keyDraft = ''
    expect(await session.save(session.draft)).toEqual({
      kind: 'key-error', message: 'Profile 已保存；重试 API Key 时仍需输入非空 key。',
    })
    expect(onSaved).not.toHaveBeenCalled()
    session.draft.keyDraft = 'sk-secret'
    expect(await session.save(session.draft)).toEqual({ kind: 'saved' })
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(mutate).toHaveBeenCalledWith('llm-pi-ai', [{
      op: 'set', path: ['providers', 'acme-gateway'],
      value: {
        api: 'openai-completions', displayName: 'Acme', baseURL: 'http://127.0.0.1:8317/v1',
        models: [{ id: 'm' }], apiKeyEnv: 'ACME_GATEWAY_API_KEY',
      },
    }], 11)
    expect(credentials.set).toHaveBeenCalledTimes(2)
    expect(credentials.set).toHaveBeenCalledWith('ACME_GATEWAY_API_KEY', 'sk-secret')
    expect(order).toEqual(['settings', 'credentials', 'credentials'])
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('目录读取异常 fail-closed：不打开可保存表单，也不写 profile', async () => {
    const mutate = vi.fn(async () => {})
    const settings = {
      describe: () => [{ ns: 'llm-pi-ai', value: { providers: {} }, user: { providers: {} }, revision: 2 }],
      mutate,
    }
    const { flow, open, editor, overlay } = makeFlow({
      settings,
      llm: {
        listProviders: () => [{ id: 'active' }],
        listConfigurableProviders: () => { throw new Error('directory unavailable') },
      },
    })
    await flow.openCreate()
    expect(open).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
    expect(overlay.activeId()).toBe('provider-editor')
    expect(editor.render(100, 24).join('\n')).toContain('为避免覆盖已有 profile')
  })

  it('settings raw/base providers 键合并进冲突集，整棵 set 不得覆盖原 profile', async () => {
    const raw = { providers: { acme: { baseURL: 'https://keep.example/v1', headers: { 'X-Keep': 'yes' } } } }
    const mutate = vi.fn(async () => {})
    const settings = {
      describe: () => [{
        ns: 'llm-pi-ai', value: { providers: {} }, base: { providers: { 'base-route': {} } }, user: raw, revision: 4,
      }],
      mutate,
    }
    const { flow, open } = makeFlow({ settings, llm: { listProviders: () => [], listConfigurableProviders: () => [] } })
    await flow.openCreate()
    const session = sessionOf(open)
    expect(session.taken).toEqual(expect.arrayContaining(['acme', 'base-route']))
    Object.assign(session.draft, { route: 'acme', models: [{ id: 'replacement' }] })
    session.draft.profile.baseURL = 'https://replacement.example/v1'
    expect(await session.save(session.draft)).toEqual({
      kind: 'profile-error', message: 'Route 已存在，未覆盖原 profile：acme',
    })
    expect(mutate).not.toHaveBeenCalled()
    expect(raw.providers.acme).toEqual({ baseURL: 'https://keep.example/v1', headers: { 'X-Keep': 'yes' } })
  })

  it('无 key 时即使没有 credentials 也可创建，发现请求带 signal 并走草稿 seam', async () => {
    const discoverModels = vi.fn(async () => [{ id: 'm' }])
    const { flow, open } = makeFlow({ credentials: null, llm: { discoverModels } })
    await flow.openCreate()
    const session = sessionOf(open)
    const controller = new AbortController()
    await session.discover({ baseURL: 'http://127.0.0.1:8000/v1', api: 'openai-responses' }, controller.signal)
    expect(discoverModels).toHaveBeenCalledWith('llm-pi-ai', {
      baseURL: 'http://127.0.0.1:8000/v1', api: 'openai-responses',
    }, controller.signal)
    Object.assign(session.draft, { route: 'local', models: [{ id: 'm' }] })
    session.draft.profile.baseURL = 'http://127.0.0.1:8000/v1'
    expect(await session.save(session.draft)).toEqual({ kind: 'saved' })
  })

  it('环境遮蔽在 settings 写入前阻断；settings 冲突不写 key', async () => {
    const shadowedMutate = vi.fn(async () => {})
    const shadowed = makeFlow({
      settings: {
        describe: () => [{ ns: 'llm-pi-ai', value: { providers: {} }, user: { providers: {} }, revision: 3 }],
        mutate: shadowedMutate,
      },
      credentials: { describe: vi.fn(async () => ({ writable: false })), set: vi.fn(async () => {}) },
    })
    await shadowed.flow.openCreate()
    const first = sessionOf(shadowed.open)
    Object.assign(first.draft, { route: 'acme', models: [{ id: 'm' }], keyDraft: 'secret' })
    first.draft.profile.baseURL = 'https://acme.test/v1'
    expect((await first.save(first.draft)).kind).toBe('profile-error')
    expect(shadowedMutate).not.toHaveBeenCalled()

    const credentialSet = vi.fn(async () => {})
    const conflict = makeFlow({
      settings: {
        describe: () => [{ ns: 'llm-pi-ai', value: { providers: {} }, user: { providers: {} }, revision: 3 }],
        mutate: vi.fn(async () => { throw new Error('settings conflict') }),
      },
      credentials: { describe: vi.fn(async () => ({ writable: true })), set: credentialSet },
    })
    await conflict.flow.openCreate()
    const second = sessionOf(conflict.open)
    Object.assign(second.draft, { route: 'acme', models: [{ id: 'm' }], keyDraft: 'secret' })
    second.draft.profile.baseURL = 'https://acme.test/v1'
    expect(await second.save(second.draft)).toEqual({ kind: 'profile-error', message: 'settings conflict' })
    expect(credentialSet).not.toHaveBeenCalled()
  })
})

describe('ProviderFlow — 已有 profile 最小编辑', () => {
  it('保留未知字段，仅 set/unset 变化路径并保留 revision', async () => {
    const original = {
      displayName: 'Old', baseURL: 'https://old.example/v1',
      headers: { 'X-Tenant': 'private' }, models: [{ id: 'old', compat: { thinkingFormat: 'deepseek' } }],
    }
    const mutate = vi.fn(async () => {})
    const settings = {
      describe: () => [{
        ns: 'llm-pi-ai', revision: 19,
        value: { providers: { 'acme-gateway': { ...original, defaultInput: ['text'] } } },
        user: { providers: { 'acme-gateway': original } },
      }],
      mutate,
    }
    const { flow, open } = makeFlow({ settings })
    expect(await flow.openEdit(ENTRY)).toBe(true)
    const session = sessionOf(open)
    session.draft.profile.baseURL = 'http://127.0.0.1:9000/v1'
    session.draft.profile.displayName = ' '
    session.draft.models = [{ id: 'new', compat: { thinkingFormat: 'deepseek' } }]
    expect(await session.save(session.draft)).toEqual({ kind: 'saved' })
    expect(mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'acme-gateway', 'baseURL'], value: 'http://127.0.0.1:9000/v1' },
      { op: 'set', path: ['providers', 'acme-gateway', 'models'], value: [{ id: 'new', compat: { thinkingFormat: 'deepseek' } }] },
      { op: 'unset', path: ['providers', 'acme-gateway', 'displayName'] },
    ], 19)
  })

  it('继承模型直接 Enter 编辑即物化 models override，保存保留未知模型字段', async () => {
    const inherited = { id: 'inherited', contextWindow: 65536, compat: { thinkingFormat: 'deepseek' } }
    const mutate = vi.fn(async () => {})
    const settings = {
      describe: () => [{
        ns: 'llm-pi-ai', revision: 8,
        value: { providers: { 'acme-gateway': { baseURL: 'https://acme.test/v1', models: [inherited] } } },
        user: { providers: { 'acme-gateway': { baseURL: 'https://acme.test/v1' } } },
      }],
      mutate,
    }
    const { flow, open, editor } = makeFlow({ settings })
    await flow.openEdit(ENTRY)
    const session = sessionOf(open)
    expect(session.draft.modelsOverridden).toBe(false)
    editor.handleKey('down', '')
    editor.handleKey('down', '')
    editor.handleKey('return', '')
    expect(session.draft.modelsOverridden).toBe(true)
    expect(await session.save(session.draft)).toEqual({ kind: 'saved' })
    expect(mutate).toHaveBeenCalledWith('llm-pi-ai', [{
      op: 'set', path: ['providers', 'acme-gateway', 'models'], value: [inherited],
    }], 8)
  })

  it('继承模型粘贴 id 同样物化 override，实际写入编辑后的完整模型行', async () => {
    const inherited = { id: 'inherited', maxTokens: 4096, reasoningEfforts: { high: 'high' } }
    const mutate = vi.fn(async () => {})
    const settings = {
      describe: () => [{
        ns: 'llm-pi-ai', revision: 9,
        value: { providers: { 'acme-gateway': { baseURL: 'https://acme.test/v1', models: [inherited] } } },
        user: { providers: { 'acme-gateway': { baseURL: 'https://acme.test/v1' } } },
      }],
      mutate,
    }
    const { flow, open, editor } = makeFlow({ settings })
    await flow.openEdit(ENTRY)
    const session = sessionOf(open)
    editor.handleKey('down', '')
    editor.handleKey('down', '')
    editor.handleKey('return', '')
    editor.pasteText('-edited')
    expect(session.draft.modelsOverridden).toBe(true)
    expect(await session.save(session.draft)).toEqual({ kind: 'saved' })
    expect(mutate).toHaveBeenCalledWith('llm-pi-ai', [{
      op: 'set', path: ['providers', 'acme-gateway', 'models'],
      value: [{ id: 'inherited-edited', maxTokens: 4096, reasoningEfforts: { high: 'high' } }],
    }], 9)
  })

  it('modelOverrides-only profile 添加模型：保存 set models 并 unset modelOverrides', async () => {
    const original = {
      baseURL: 'https://acme.test/v1',
      modelOverrides: { old: { name: 'Overridden', contextWindow: 12345 } },
      headers: { 'X-Tenant': 'private' },
    }
    const mutate = vi.fn(async () => {})
    const settings = {
      describe: () => [{
        ns: 'llm-pi-ai', revision: 21,
        value: { providers: { 'acme-gateway': original } },
        user: { providers: { 'acme-gateway': original } },
      }],
      mutate,
    }
    const { flow, open, editor } = makeFlow({ settings })
    await flow.openEdit(ENTRY)
    const session = sessionOf(open)
    editor.handleKey('down', '')
    editor.handleKey('down', '')
    editor.handleKey('unknown', 'a')
    for (const char of 'added') editor.handleKey('unknown', char)
    editor.handleKey('return', '')
    expect(await session.save(session.draft)).toEqual({ kind: 'saved' })
    expect(mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'acme-gateway', 'models'], value: [{ id: 'added' }] },
      { op: 'unset', path: ['providers', 'acme-gateway', 'modelOverrides'] },
    ], 21)
  })

  it('modelOverrides-only 继承行编辑：保留模型未知字段且解除互斥', async () => {
    const inherited = { id: 'inherited', contextWindow: 65536, compat: { thinkingFormat: 'deepseek' } }
    const original = {
      baseURL: 'https://acme.test/v1',
      modelOverrides: { inherited: { contextWindow: 65536, compat: { thinkingFormat: 'deepseek' } } },
      headers: { 'X-Tenant': 'private' },
    }
    const mutate = vi.fn(async () => {})
    const settings = {
      describe: () => [{
        ns: 'llm-pi-ai', revision: 22,
        value: { providers: { 'acme-gateway': { ...original, models: [inherited] } } },
        user: { providers: { 'acme-gateway': original } },
      }],
      mutate,
    }
    const { flow, open, editor } = makeFlow({ settings })
    await flow.openEdit(ENTRY)
    const session = sessionOf(open)
    editor.handleKey('down', '')
    editor.handleKey('down', '')
    editor.handleKey('return', '')
    editor.pasteText('-edited')
    expect(await session.save(session.draft)).toEqual({ kind: 'saved' })
    expect(mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'acme-gateway', 'models'], value: [{ id: 'inherited-edited', contextWindow: 65536, compat: { thinkingFormat: 'deepseek' } }] },
      { op: 'unset', path: ['providers', 'acme-gateway', 'modelOverrides'] },
    ], 22)
  })

  it('settings 缺席时 openEdit 返回 false，供 KeyFlow 回退原 key 对话框', async () => {
    const { flow, open } = makeFlow({ settings: null })
    expect(await flow.openEdit(ENTRY)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})
