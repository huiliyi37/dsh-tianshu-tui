import type { OverlayKeyResult, OverlayRenderer } from '../engine/overlay-engine.js'
import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { truncateToDisplayWidth } from '../width.js'
import { maskKeyInput } from './key-dialog.js'
import {
  adoptProviderModels,
  apiKeyFailure,
  normalizedApiKey,
  normalizedProviderProfile,
  PI_AI_PROTOCOLS,
  providerString,
  setProviderString,
  validProviderBaseURL,
  validateProviderDraft,
  type DiscoveredProviderModel,
  type ProviderDraft,
} from './provider-profile.js'

export interface ProviderDiscoveryRequest {
  provider?: string
  baseURL?: string
  api?: string
  apiKey?: string
}

export type ProviderSaveResult =
  | { kind: 'saved' }
  | { kind: 'profile-error'; message: string }
  | { kind: 'key-error'; message: string }

export interface ProviderEditorSession {
  mode: 'create' | 'edit'
  title: string
  draft: ProviderDraft
  defaultBaseURL?: string
  taken: readonly string[]
  discover(
    request: ProviderDiscoveryRequest,
    signal: AbortSignal,
  ): Promise<readonly DiscoveredProviderModel[]>
  save(draft: ProviderDraft): Promise<ProviderSaveResult>
}

export interface ProviderEditorOptions {
  getTheme: () => RivetTheme
  onChange?: () => void
}

type Phase = 'editing' | 'model-input' | 'discovering' | 'candidates' | 'saving' | 'key-retry' | 'saved' | 'unavailable'
type Focus = 'route' | 'displayName' | 'baseURL' | 'api' | 'models' | 'key' | 'discover' | 'save'

export class ProviderEditorController implements OverlayRenderer {
  private phase: Phase = 'editing'
  private session: ProviderEditorSession | null = null
  private draft: ProviderDraft | null = null
  private focus: Focus = 'route'
  private modelIndex = 0
  private candidates: readonly DiscoveredProviderModel[] = []
  private candidateIndex = 0
  private picked = new Set<string>()
  private error: string | null = null
  private notice: string | null = null
  private openFlag = false
  private closeRequested = false
  private generation = 0
  private discoveryAbort: AbortController | null = null
  private readonly getTheme: () => RivetTheme
  private readonly onChange: (() => void) | undefined

  constructor(opts: ProviderEditorOptions) {
    this.getTheme = opts.getTheme
    if (opts.onChange !== undefined) this.onChange = opts.onChange
  }

  open(session: ProviderEditorSession): void {
    this.generation += 1
    this.discoveryAbort?.abort()
    this.discoveryAbort = null
    this.session = session
    this.draft = session.draft
    this.phase = 'editing'
    this.focus = session.mode === 'create' ? 'route' : 'baseURL'
    this.modelIndex = 0
    this.candidates = []
    this.candidateIndex = 0
    this.picked = new Set()
    this.error = null
    this.notice = null
    this.openFlag = true
    this.closeRequested = false
  }

  openUnavailable(message: string): void {
    this.generation += 1
    this.session = null
    this.draft = null
    this.phase = 'unavailable'
    this.error = message
    this.notice = null
    this.openFlag = true
    this.closeRequested = false
  }

  isOpen(): boolean {
    return this.openFlag
  }

  wantsClose(): boolean {
    return this.closeRequested
  }

  onDeactivate(): void {
    this.openFlag = false
    this.generation += 1
    this.discoveryAbort?.abort()
    this.discoveryAbort = null
  }

  private fields(): Focus[] {
    const mode = this.session?.mode
    const declared = this.draft?.declared === true
    return [
      ...mode === 'create' ? ['route' as const] : [],
      ...mode === 'create' || declared ? ['displayName' as const] : [],
      'baseURL',
      ...mode === 'create' || declared ? ['api' as const] : [],
      'models', 'key', 'discover', 'save',
    ]
  }

  private moveFocus(delta: number): void {
    const fields = this.fields()
    const current = Math.max(0, fields.indexOf(this.focus))
    this.focus = fields[Math.max(0, Math.min(fields.length - 1, current + delta))] ?? 'save'
  }

  private selectedModel(): Record<string, unknown> | undefined {
    return this.draft?.models[this.modelIndex]
  }

  private updateTextAt(draft: ProviderDraft, focus: Focus, char: string, backspace: boolean): void {
    if (focus === 'route') {
      draft.route = backspace ? draft.route.slice(0, -1) : draft.route + char
      return
    }
    if (focus === 'key') {
      draft.keyDraft = backspace ? draft.keyDraft.slice(0, -1) : draft.keyDraft + char
      return
    }
    if (focus === 'displayName' || focus === 'baseURL') {
      const current = typeof draft.profile[focus] === 'string' ? draft.profile[focus] as string : ''
      setProviderString(draft, focus, backspace ? current.slice(0, -1) : current + char)
    }
  }

  private updateText(char: string, backspace: boolean): void {
    if (this.draft !== null) this.updateTextAt(this.draft, this.focus, char, backspace)
  }

  private cycleProtocol(delta: number): void {
    const draft = this.draft
    if (draft === null) return
    const current = providerString(draft.profile, 'api') ?? PI_AI_PROTOCOLS[0]
    const index = PI_AI_PROTOCOLS.indexOf(current as typeof PI_AI_PROTOCOLS[number])
    const base = index < 0 ? 0 : index
    const next = (base + delta + PI_AI_PROTOCOLS.length) % PI_AI_PROTOCOLS.length
    draft.profile.api = PI_AI_PROTOCOLS[next]
  }

  private addModel(): void {
    const draft = this.draft
    if (draft === null) return
    draft.models.push({ id: '' })
    draft.modelsOverridden = true
    this.modelIndex = draft.models.length - 1
    this.phase = 'model-input'
  }

  private removeModel(): void {
    const draft = this.draft
    if (draft === null || draft.models.length === 0) return
    draft.models.splice(this.modelIndex, 1)
    draft.modelsOverridden = true
    this.modelIndex = Math.max(0, Math.min(this.modelIndex, draft.models.length - 1))
  }

  private discoveryRequest(): ProviderDiscoveryRequest | { error: string } {
    const draft = this.draft
    const session = this.session
    if (draft === null || session === null) return { error: '编辑器未打开' }
    const keyFailure = apiKeyFailure(draft)
    if (keyFailure !== undefined) return { error: keyFailure === 'blank' ? 'API Key 只有空白字符' : 'API Key 含非法字符或包裹格式' }
    const profile = normalizedProviderProfile(draft)
    const baseURL = providerString(profile, 'baseURL') ?? session.defaultBaseURL
    if (baseURL === undefined) return { error: '发现模型前必须填写 baseURL' }
    if (!validProviderBaseURL(baseURL)) return { error: 'baseURL 必须是有效的 http/https URL' }
    const api = providerString(profile, 'api')
    const apiKey = normalizedApiKey(draft)
    return {
      ...session.mode === 'edit' ? { provider: draft.route } : {},
      baseURL,
      ...api === undefined ? {} : { api },
      ...apiKey.length === 0 ? {} : { apiKey },
    }
  }

  private discover(): void {
    const request = this.discoveryRequest()
    if ('error' in request) {
      this.error = request.error
      return
    }
    const session = this.session
    if (session === null) return
    this.discoveryAbort?.abort()
    const controller = new AbortController()
    this.discoveryAbort = controller
    const generation = ++this.generation
    this.phase = 'discovering'
    this.error = null
    this.onChange?.()
    void session.discover(request, controller.signal).then(models => {
      if (!this.openFlag || generation !== this.generation) return
      if (models.length === 0) {
        this.phase = 'editing'
        this.error = '端点未返回可用模型，可继续手输'
      } else {
        const known = new Set((this.draft?.models ?? []).map(model => typeof model.id === 'string' ? model.id.trim() : ''))
        this.candidates = models
        this.candidateIndex = 0
        this.picked = new Set(models.filter(model => !known.has(model.id)).map(model => model.id))
        this.phase = 'candidates'
      }
      this.onChange?.()
    }, (error: unknown) => {
      if (!this.openFlag || generation !== this.generation || controller.signal.aborted) return
      this.phase = 'editing'
      this.error = error instanceof Error ? error.message : String(error)
      this.onChange?.()
    }).finally(() => {
      if (generation === this.generation) this.discoveryAbort = null
    })
  }

  private save(): void {
    const draft = this.draft
    const session = this.session
    if (draft === null || session === null) return
    const retrying = this.phase === 'key-retry'
    if (retrying && normalizedApiKey(draft).length === 0) {
      this.phase = 'key-retry'
      this.error = '重试 API Key 时必须输入非空 key'
      return
    }
    if (session.mode === 'create' && session.taken.includes(draft.route)) {
      this.phase = retrying ? 'key-retry' : 'editing'
      this.error = `Route 已存在：${draft.route}`
      return
    }
    const failure = validateProviderDraft(draft, session.mode)
    if (failure !== undefined) {
      this.phase = retrying ? 'key-retry' : 'editing'
      this.error = failure
      return
    }
    const generation = ++this.generation
    this.phase = 'saving'
    this.error = null
    this.onChange?.()
    void session.save(draft).then(result => {
      if (!this.openFlag || generation !== this.generation) return
      if (result.kind === 'saved') {
        this.phase = 'saved'
      } else {
        this.phase = result.kind === 'key-error' ? 'key-retry' : 'editing'
        if (result.kind === 'key-error') this.focus = 'key'
        this.error = result.message
      }
      this.onChange?.()
    }, (error: unknown) => {
      if (!this.openFlag || generation !== this.generation) return
      this.phase = 'editing'
      this.error = error instanceof Error ? error.message : String(error)
      this.onChange?.()
    })
  }

  private handleCandidate(name: string, char: string): void {
    if (name === 'escape' || name === 'ctrl_c') {
      this.phase = 'editing'
      return
    }
    if (name === 'up') this.candidateIndex = Math.max(0, this.candidateIndex - 1)
    else if (name === 'down') this.candidateIndex = Math.min(this.candidates.length - 1, this.candidateIndex + 1)
    else if (char === ' ') {
      const id = this.candidates[this.candidateIndex]?.id
      if (id !== undefined) {
        if (!this.picked.delete(id)) this.picked.add(id)
      }
    } else if ((char === 'a' || char === 'A')) {
      this.picked = this.picked.size === this.candidates.length
        ? new Set()
        : new Set(this.candidates.map(model => model.id))
    } else if (name === 'return') {
      const draft = this.draft
      if (draft !== null) {
        draft.models = adoptProviderModels(draft.models, this.candidates, this.picked)
        draft.modelsOverridden = true
        this.modelIndex = Math.max(0, draft.models.length - 1)
      }
      this.phase = 'editing'
    }
  }

  handleKey(name: string, char: string): OverlayKeyResult {
    if (!this.openFlag) return 'handled'
    if (this.phase === 'candidates') {
      this.handleCandidate(name, char)
      return 'handled'
    }
    if (this.phase === 'model-input') {
      if (name === 'escape' || name === 'ctrl_c' || name === 'return') this.phase = 'editing'
      else if (name === 'backspace') {
        const model = this.selectedModel()
        if (model !== undefined && typeof model.id === 'string') model.id = model.id.slice(0, -1)
      } else if (char !== '') {
        const model = this.selectedModel()
        if (model !== undefined) model.id = `${typeof model.id === 'string' ? model.id : ''}${char}`
      }
      return 'handled'
    }
    if (this.phase === 'discovering') {
      if (name === 'escape' || name === 'ctrl_c') {
        this.discoveryAbort?.abort()
        this.generation += 1
        this.phase = 'editing'
      }
      return 'handled'
    }
    if (this.phase === 'saved' || this.phase === 'unavailable') {
      if (name === 'return' || name === 'escape' || name === 'ctrl_c') this.closeRequested = true
      return this.closeRequested ? 'close' : 'handled'
    }
    if (name === 'escape' || name === 'ctrl_c') {
      this.closeRequested = true
      return 'close'
    }
    if (this.phase === 'key-retry') {
      if (name === 'return') this.save()
      else if (name === 'backspace') this.updateText('', true)
      else if (char !== '') this.updateText(char, false)
      return 'handled'
    }
    if (this.phase === 'saving') return 'handled'
    if (name === 'up') this.moveFocus(-1)
    else if (name === 'down') this.moveFocus(1)
    else if ((name === 'left' || name === 'right') && this.focus === 'api') this.cycleProtocol(name === 'left' ? -1 : 1)
    else if ((name === 'left' || name === 'right') && this.focus === 'models') {
      const count = this.draft?.models.length ?? 0
      if (count > 0) this.modelIndex = Math.max(0, Math.min(count - 1, this.modelIndex + (name === 'left' ? -1 : 1)))
    } else if (this.focus === 'models' && (char === 'a' || char === 'A')) this.addModel()
    else if (this.focus === 'models' && (char === 'd' || char === 'D')) this.removeModel()
    else if (this.focus === 'models' && (char === 'f' || char === 'F')) this.discover()
    else if (name === 'return' && this.focus === 'save') this.save()
    else if (name === 'return' && this.focus === 'discover') this.discover()
    else if (name === 'return' && this.focus === 'models') {
      if ((this.draft?.models.length ?? 0) === 0) this.addModel()
      else {
        if (this.draft !== null) this.draft.modelsOverridden = true
        this.phase = 'model-input'
      }
    } else if (name === 'return') this.moveFocus(1)
    else if (name === 'backspace') this.updateText('', true)
    else if (char !== '' && this.focus !== 'api' && this.focus !== 'discover' && this.focus !== 'save') this.updateText(char, false)
    return 'handled'
  }

  beginPaste(): (text: string) => void {
    const generation = this.generation
    const phase = this.phase
    const focus = this.focus
    const draft = this.draft
    const model = this.selectedModel()
    return text => {
      if (!this.openFlag || generation !== this.generation || draft === null || this.draft !== draft) return
      if (phase === 'model-input') {
        if (model !== undefined) {
          draft.modelsOverridden = true
          model.id = `${typeof model.id === 'string' ? model.id : ''}${text.replace(/\s+/g, '')}`
        }
        return
      }
      if (phase !== 'editing' && phase !== 'key-retry') return
      const normalized = focus === 'displayName' ? text.replace(/\s+/g, ' ') : text.replace(/\s+/g, '')
      this.updateTextAt(draft, focus, normalized, false)
      this.error = null
    }
  }

  pasteText(text: string): void {
    this.beginPaste()(text)
  }

  showNotice(text: string): void {
    if (!this.openFlag) return
    this.notice = text
    this.onChange?.()
  }

  private withNotice(lines: string[]): string[] {
    if (this.notice !== null) lines.push(color(`⚠ ${this.notice}`, this.getTheme().warning))
    return lines
  }

  private field(label: string, value: string, focus: Focus, placeholder = ''): string {
    const shown = value.length > 0 ? value : placeholder
    return `${this.focus === focus && (this.phase === 'editing' || this.phase === 'key-retry') ? '▶' : ' '} ${label}: ${shown}`
  }

  private renderCandidates(width: number, height: number): string[] {
    const theme = this.getTheme()
    const lines = [color('选择要加入草稿的模型', theme.brandColor, { bold: true }), '']
    const bodyHeight = Math.max(1, height - 5)
    const start = Math.max(0, Math.min(this.candidateIndex - bodyHeight + 1, this.candidates.length - bodyHeight))
    for (const [offset, model] of this.candidates.slice(start, start + bodyHeight).entries()) {
      const index = start + offset
      lines.push(color(`${index === this.candidateIndex ? '▶' : ' '} [${this.picked.has(model.id) ? 'x' : ' '}] ${model.id}`, index === this.candidateIndex ? theme.primary : theme.dim))
    }
    lines.push('')
    lines.push(color('↑↓ 选择 · Space 切换 · A 全选/清空 · Enter 采纳 · Esc 取消', theme.muted))
    return this.withNotice(lines.map(line => truncateToDisplayWidth(line, width)))
  }

  render(width: number, height: number): string[] {
    if (this.phase === 'candidates') return this.renderCandidates(width, height)
    const theme = this.getTheme()
    const draft = this.draft
    const session = this.session
    if (draft === null || session === null) {
      return this.withNotice([color('供应商设置不可用', theme.warning), '', color(this.error ?? '缺少 settings 服务', theme.error), '', color('Enter / Esc 关闭', theme.muted)]
        .map(line => truncateToDisplayWidth(line, width)))
    }
    const lines = [color(session.title, theme.brandColor, { bold: true })]
    if (session.mode === 'edit') lines.push(color(`Route: ${draft.route}`, theme.muted))
    if (this.phase === 'key-retry') lines.push(color('Profile 已保存；仅重试 API Key，不会重复写 profile。', theme.warning))
    if (this.phase === 'saved') {
      lines.push('', color('✓ 已保存；新路由可在 /model 中选择。', theme.success), '', color('Enter / Esc 关闭', theme.muted))
      return this.withNotice(lines.map(line => truncateToDisplayWidth(line, width)))
    }
    lines.push('')
    if (session.mode === 'create') lines.push(this.field('Route', draft.route, 'route', 'acme-gateway'))
    if (session.mode === 'create' || draft.declared) {
      lines.push(this.field('Display name', typeof draft.profile.displayName === 'string' ? draft.profile.displayName : '', 'displayName', draft.route || 'acme-gateway'))
    }
    lines.push(this.field('Base URL', typeof draft.profile.baseURL === 'string' ? draft.profile.baseURL : '', 'baseURL', session.defaultBaseURL ?? 'http://127.0.0.1:8317/v1'))
    if (session.mode === 'create' || draft.declared) {
      lines.push(this.field('Protocol', providerString(draft.profile, 'api') ?? PI_AI_PROTOCOLS[0], 'api', ''))
    }
    lines.push(this.field('Models', `${draft.models.length} 项${draft.modelsOverridden ? '（自定义）' : '（继承）'}`, 'models'))
    const modelLimit = Math.max(1, Math.min(5, height - lines.length - 7))
    const modelStart = Math.max(0, Math.min(this.modelIndex - modelLimit + 1, draft.models.length - modelLimit))
    for (const [offset, model] of draft.models.slice(modelStart, modelStart + modelLimit).entries()) {
      const index = modelStart + offset
      const id = typeof model.id === 'string' && model.id.length > 0 ? model.id : '<未填写>'
      lines.push(color(`  ${this.focus === 'models' && index === this.modelIndex ? '▶' : '·'} ${id}`, this.focus === 'models' && index === this.modelIndex ? theme.primary : theme.dim))
    }
    lines.push(this.field('API Key（可选）', maskKeyInput(draft.keyDraft), 'key'))
    if (this.phase !== 'key-retry') {
      lines.push(this.field('[发现模型]', '', 'discover'))
      lines.push(this.field('[保存]', '', 'save'))
    }
    if (this.phase === 'discovering') lines.push(color('正在发现模型… Esc 取消', theme.muted))
    if (this.phase === 'saving') lines.push(color('正在保存 profile / API Key…', theme.muted))
    if (this.error !== null) lines.push(color(`✗ ${this.error}`, theme.error))
    lines.push('')
    const footer = this.phase === 'key-retry'
      ? '输入新 Key · Enter 仅重试 Key · Esc 关闭（profile 已保存）'
      : this.focus === 'models'
        ? '↑↓ 字段 · ←→ 模型 · Enter 编辑 id · A 添加 · D 删除 · F 发现 · Esc 取消'
        : '↑↓ 字段 · Enter 下一项/确认 · ←→ 协议/模型 · Esc 取消'
    lines.push(color(footer, theme.muted))
    return this.withNotice(lines.map(line => truncateToDisplayWidth(line, width)))
  }
}
