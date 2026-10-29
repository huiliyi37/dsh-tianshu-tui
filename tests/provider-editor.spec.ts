import { describe, expect, it, vi } from 'vitest'
import { ProviderEditorController, type ProviderEditorSession } from '../src/ui/provider-editor.js'
import type { RivetTheme } from '../src/theme.js'

function fakeTheme(): RivetTheme {
  return {
    primary: '#111111', secondary: '#222222', success: '#333333', warning: '#444444', error: '#555555',
    dim: '#666666', muted: '#777777', pulseQuiet: '#888888', pulseActive: '#999999', pulseAlert: '#aaaaaa',
    userColor: '#bbbbbb', assistantColor: '#cccccc', systemColor: '#dddddd', brandColor: '#eeeeee',
    toolColor: () => '#000000', contextColor: () => '#000000',
  }
}

function makeSession(overrides: Partial<ProviderEditorSession> = {}): ProviderEditorSession {
  return {
    mode: 'create',
    title: '新增自定义 pi-ai 供应商',
    draft: {
      route: 'acme', declared: true,
      profile: { api: 'openai-completions', baseURL: 'http://127.0.0.1:8317/v1' },
      models: [{ id: 'm' }], modelsOverridden: true, keyDraft: '',
    },
    taken: [],
    discover: vi.fn(async () => []),
    save: vi.fn(async () => ({ kind: 'saved' as const })),
    ...overrides,
  }
}

function makeEditor(session: ProviderEditorSession) {
  const editor = new ProviderEditorController({ getTheme: fakeTheme })
  editor.open(session)
  return editor
}

function type(editor: ProviderEditorController, text: string): void {
  for (const char of text) editor.handleKey('unknown', char)
}

function down(editor: ProviderEditorController, count: number): void {
  for (let index = 0; index < count; index++) editor.handleKey('down', '')
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('ProviderEditorController — 完整创建与编辑按键', () => {
  it('从空表单经 route/baseURL/手输模型走到保存成功', async () => {
    const session = makeSession({
      draft: { route: '', declared: true, profile: { api: 'openai-completions' }, models: [], modelsOverridden: true, keyDraft: '' },
    })
    const editor = makeEditor(session)
    type(editor, 'acme')
    editor.handleKey('return', '')
    editor.handleKey('return', '')
    type(editor, 'http://127.0.0.1:8317/v1')
    editor.handleKey('return', '')
    editor.handleKey('right', '')
    expect(session.draft.profile.api).toBe('openai-responses')
    editor.handleKey('return', '')
    editor.handleKey('unknown', 'a')
    type(editor, 'm')
    editor.handleKey('return', '')
    down(editor, 3)
    editor.handleKey('return', '')
    await settle()
    expect(session.save).toHaveBeenCalledOnce()
    expect(session.draft.route).toBe('acme')
    expect(session.draft.models).toEqual([{ id: 'm' }])
    expect(editor.render(100, 24).join('\n')).toContain('/model')
  })

  it('非法 route 不进入保存；key 明文不出现在渲染帧', () => {
    const session = makeSession({ draft: {
      route: '9invalid', declared: true,
      profile: { api: 'openai-completions', baseURL: 'https://acme.test/v1' },
      models: [{ id: 'm' }], modelsOverridden: true, keyDraft: 'sk-secret-value',
    } })
    const editor = makeEditor(session)
    down(editor, 7)
    editor.handleKey('return', '')
    expect(session.save).not.toHaveBeenCalled()
    const text = editor.render(100, 24).join('\n')
    expect(text).toContain('Route')
    expect(text).not.toContain('sk-secret-value')
    expect(text).toContain('••••…alue')
  })

  it('key 保存失败进入 key-only retry，粘贴后重试成功', async () => {
    const save = vi.fn()
      .mockResolvedValueOnce({ kind: 'key-error', message: 'credential refused' })
      .mockResolvedValueOnce({ kind: 'saved' })
    const session = makeSession({ save, draft: {
      route: 'acme', declared: true,
      profile: { api: 'openai-completions', baseURL: 'https://acme.test/v1' },
      models: [{ id: 'm' }], modelsOverridden: true, keyDraft: 'old-key',
    } })
    const editor = makeEditor(session)
    down(editor, 7)
    editor.handleKey('return', '')
    await settle()
    expect(editor.render(100, 24).join('\n')).toContain('仅重试 API Key')
    type(editor, ' bad key')
    editor.handleKey('return', '')
    expect(save).toHaveBeenCalledTimes(1)
    expect(editor.render(100, 24).join('\n')).toContain('仅重试 API Key')
    session.draft.keyDraft = ''
    editor.handleKey('return', '')
    expect(save).toHaveBeenCalledTimes(1)
    expect(editor.render(100, 24).join('\n')).toContain('必须输入非空 key')
    expect(editor.render(100, 24).join('\n')).not.toContain('✓ 已保存')
    editor.pasteText('new-key')
    editor.handleKey('return', '')
    await settle()
    expect(save).toHaveBeenCalledTimes(2)
    expect(session.draft.keyDraft).toBe('new-key')
    expect(editor.render(100, 24).join('\n')).toContain('已保存')
  })
})

describe('ProviderEditorController — 草稿模型发现', () => {
  it('发现携带未保存 baseURL/api/key，采纳候选后落入模型草稿', async () => {
    let resolve: ((models: readonly { id: string; name?: string }[]) => void) | undefined
    const discover = vi.fn(() => new Promise<readonly { id: string; name?: string }[]>(resolvePromise => { resolve = resolvePromise }))
    const session = makeSession({ discover, draft: {
      route: 'acme', declared: true,
      profile: { api: 'anthropic-messages', baseURL: 'https://gateway.example:8443' },
      models: [], modelsOverridden: true, keyDraft: 'sk-secret',
    } })
    const editor = makeEditor(session)
    down(editor, 4)
    editor.handleKey('unknown', 'f')
    expect(discover).toHaveBeenCalledWith({
      baseURL: 'https://gateway.example:8443', api: 'anthropic-messages', apiKey: 'sk-secret',
    }, expect.any(AbortSignal))
    resolve?.([{ id: 'claude', name: 'Claude' }])
    await settle()
    expect(editor.render(100, 24).join('\n')).toContain('claude')
    editor.handleKey('return', '')
    expect(session.draft.models).toEqual([{ id: 'claude', name: 'Claude' }])
  })

  it('编辑已有路由发现带 provider；Esc 取消后迟到结果不改草稿', async () => {
    let resolve: ((models: readonly { id: string }[]) => void) | undefined
    const discover = vi.fn(() => new Promise<readonly { id: string }[]>(resolvePromise => { resolve = resolvePromise }))
    const session = makeSession({ mode: 'edit', discover, draft: {
      route: 'acme', declared: true,
      profile: { api: 'openai-completions', baseURL: 'https://acme.test/v1' },
      models: [{ id: 'manual' }], modelsOverridden: true, keyDraft: '',
    } })
    const editor = makeEditor(session)
    down(editor, 2)
    editor.handleKey('unknown', 'f')
    expect(discover).toHaveBeenCalledWith(expect.objectContaining({ provider: 'acme' }), expect.any(AbortSignal))
    editor.handleKey('escape', '')
    resolve?.([{ id: 'late' }])
    await settle()
    expect(session.draft.models).toEqual([{ id: 'manual' }])
    expect(editor.render(100, 24).join('\n')).not.toContain('选择要加入')
  })

  it('发现失败保留手输模型和编辑态', async () => {
    const session = makeSession({ discover: vi.fn(async () => { throw new Error('endpoint unreachable') }) })
    const editor = makeEditor(session)
    down(editor, 4)
    editor.handleKey('unknown', 'f')
    await settle()
    expect(session.draft.models).toEqual([{ id: 'm' }])
    expect(editor.render(100, 24).join('\n')).toContain('endpoint unreachable')
    editor.handleKey('unknown', 'a')
    type(editor, 'manual')
    expect(session.draft.models[1]?.id).toBe('manual')
  })
})

describe('ProviderEditorController — 粘贴目标与保存代次', () => {
  it('粘贴发起后焦点移动仍写原 key；关闭重开后旧动作失效', () => {
    const session = makeSession()
    const editor = makeEditor(session)
    down(editor, 5)
    const paste = editor.beginPaste()
    for (let index = 0; index < 5; index++) editor.handleKey('up', '')
    paste('sk-bound-key')
    expect(session.draft.keyDraft).toBe('sk-bound-key')
    expect(session.draft.route).toBe('acme')

    down(editor, 5)
    const stale = editor.beginPaste()
    editor.onDeactivate()
    const reopened = makeSession({ title: '新会话', draft: {
      route: 'fresh', declared: true,
      profile: { api: 'openai-completions', baseURL: 'https://fresh.test/v1' },
      models: [{ id: 'fresh-model' }], modelsOverridden: true, keyDraft: '',
    } })
    editor.open(reopened)
    stale('sk-stale-key')
    expect(reopened.draft.keyDraft).toBe('')
    expect(reopened.draft.route).toBe('fresh')
  })

  it('保存中关闭重开后，迟到 resolve 不把新会话置为 saved', async () => {
    let resolveSave!: (result: Awaited<ReturnType<ProviderEditorSession['save']>>) => void
    const pending = makeSession({ title: '旧会话', save: () => new Promise(resolve => { resolveSave = resolve }) })
    const editor = makeEditor(pending)
    down(editor, 7)
    editor.handleKey('return', '')
    editor.onDeactivate()
    const reopened = makeSession({ title: '新会话' })
    editor.open(reopened)
    resolveSave({ kind: 'saved' })
    await settle()
    const text = editor.render(100, 24).join('\n')
    expect(text).toContain('新会话')
    expect(text).not.toContain('✓ 已保存')
    expect(reopened.save).not.toHaveBeenCalled()
  })

  it('保存中关闭重开后，迟到 reject 不污染新会话错误态', async () => {
    let rejectSave!: (error: unknown) => void
    const pending = makeSession({ title: '旧会话', save: () => new Promise((_, reject) => { rejectSave = reject }) })
    const editor = makeEditor(pending)
    down(editor, 7)
    editor.handleKey('return', '')
    editor.onDeactivate()
    const reopened = makeSession({ title: '新会话' })
    editor.open(reopened)
    rejectSave(new Error('stale save failure'))
    await settle()
    const text = editor.render(100, 24).join('\n')
    expect(text).toContain('新会话')
    expect(text).not.toContain('stale save failure')
    expect(text).not.toContain('✓ 已保存')
    expect(reopened.save).not.toHaveBeenCalled()
  })
})
