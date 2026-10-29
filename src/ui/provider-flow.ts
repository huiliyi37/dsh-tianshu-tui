import type { OverlayController } from '../engine/overlay-controller.js'
import type { ProviderEditorController, ProviderEditorSession } from './provider-editor.js'
import type { WizardProviderEntry } from './key-wizard.js'
import { resolveKeyRef } from './key-wizard.js'
import {
  createProviderProfile,
  isProviderProfile,
  normalizedApiKey,
  profileForSave,
  providerModels,
  providerPathOps,
  providerString,
  type ProviderSettingsOp,
} from './provider-profile.js'

export interface ProviderFlowReflect {
  get(name: string, optional?: boolean): unknown
}

interface ProviderSettingsDescriptor {
  ns: string
  value: unknown
  base?: unknown
  user?: unknown
  revision?: number
}

interface ProviderSettingsFacet {
  writable?: boolean
  describe(options?: { redactSecrets?: boolean }): ProviderSettingsDescriptor[]
  mutate(ns: string, ops: readonly ProviderSettingsOp[], expectedRevision?: number): Promise<void>
}

interface ProviderCredentialsFacet {
  describe(ref: string): Promise<{ writable?: boolean }>
  set(ref: string, value: string): Promise<void>
}

interface ProviderLlmFacet {
  listProviders?(): readonly { id: string }[]
  listConfigurableProviders?(): readonly { provider: string }[]
  discoverModels?(
    settingsNs: string,
    request: { provider?: string; baseURL?: string; api?: string; apiKey?: string },
    signal?: AbortSignal,
  ): Promise<readonly { id: string; name?: string; contextWindow?: number; maxTokens?: number; inputModalities?: readonly string[] }[]>
}

export interface ProviderFlowDeps {
  overlay: OverlayController | null
  editor: ProviderEditorController | null
  reflect: ProviderFlowReflect
  isDisposed: () => boolean
  onSaved: () => void
}

function atPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    if (!isProviderProfile(current)) return undefined
    current = current[key]
  }
  return current
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ProviderFlow {
  private readonly deps: ProviderFlowDeps

  constructor(deps: ProviderFlowDeps) {
    this.deps = deps
  }

  private settings(): ProviderSettingsFacet | undefined {
    const settings = this.deps.reflect.get('settings', false) as ProviderSettingsFacet | null | undefined
    return settings !== undefined && settings !== null && typeof settings.describe === 'function' && typeof settings.mutate === 'function'
      ? settings
      : undefined
  }

  private namespace(settingsNs: string): { settings: ProviderSettingsFacet; descriptor: ProviderSettingsDescriptor } | undefined {
    const settings = this.settings()
    if (settings === undefined || settings.writable === false) return undefined
    try {
      const descriptor = settings.describe({ redactSecrets: true }).find(row => row.ns === settingsNs)
      return descriptor === undefined ? undefined : { settings, descriptor }
    } catch {
      return undefined
    }
  }

  private takenRoutes(descriptor: ProviderSettingsDescriptor): string[] | undefined {
    const llm = this.deps.reflect.get('llm', false) as ProviderLlmFacet | undefined
    const routes = new Set<string>()
    try {
      for (const provider of llm?.listProviders?.() ?? []) routes.add(provider.id)
      for (const entry of llm?.listConfigurableProviders?.() ?? []) routes.add(entry.provider)
      for (const section of [descriptor.value, descriptor.base, descriptor.user]) {
        const providers = atPath(section, ['providers'])
        if (isProviderProfile(providers)) {
          for (const route of Object.keys(providers)) routes.add(route)
        }
      }
    } catch {
      return undefined
    }
    return [...routes]
  }

  private unavailable(text: string): void {
    const { overlay, editor } = this.deps
    if (overlay === null || editor === null || this.deps.isDisposed()) return
    editor.openUnavailable(text)
    overlay.activate('provider-editor')
  }

  async openCreate(): Promise<void> {
    const prepared = this.namespace('llm-pi-ai')
    if (prepared === undefined) {
      this.unavailable('当前部署的 llm-pi-ai settings 不可用或只读，无法新建供应商。')
      return
    }
    const taken = this.takenRoutes(prepared.descriptor)
    if (taken === undefined) {
      this.unavailable('无法读取供应商目录；为避免覆盖已有 profile，已停止新建。')
      return
    }
    const opened = this.openSession('llm-pi-ai', [], prepared, undefined, new Set(taken))
    if (!opened) this.unavailable('供应商编辑器未装配。')
  }

  async openEdit(entry: WizardProviderEntry): Promise<boolean> {
    if (entry.settingsNs !== 'llm-pi-ai') return false
    const prepared = this.namespace(entry.settingsNs)
    if (prepared === undefined) return false
    return this.openSession(entry.settingsNs, entry.settingsPath, prepared, entry, new Set())
  }

  private openSession(
    settingsNs: string,
    settingsPath: readonly string[],
    prepared: { settings: ProviderSettingsFacet; descriptor: ProviderSettingsDescriptor },
    entry: WizardProviderEntry | undefined,
    taken: ReadonlySet<string>,
  ): boolean {
    const { overlay, editor } = this.deps
    if (overlay === null || editor === null || this.deps.isDisposed()) return false
    if (overlay.activeId() === 'provider-editor') return true
    const mode = entry === undefined ? 'create' : 'edit'
    const route = entry?.provider ?? ''
    const resolvedValue = mode === 'create' ? undefined : atPath(prepared.descriptor.value, settingsPath)
    const resolved = isProviderProfile(resolvedValue) ? resolvedValue : {}
    const originalValue = mode === 'create' ? undefined : atPath(prepared.descriptor.user, settingsPath)
    const original = isProviderProfile(originalValue) ? structuredClone(originalValue) : undefined
    const modelsOverridden = mode === 'create' || (original !== undefined && Object.hasOwn(original, 'models'))
    const profile = original === undefined ? {} : structuredClone(original)
    if (mode === 'create') profile.api = 'openai-completions'
    const resolvedApiKeyEnv = providerString(resolved, 'apiKeyEnv')
    const initialKeyRef = resolveKeyRef(route, resolvedApiKeyEnv)
    const defaultBaseURL = providerString(resolved, 'baseURL') ?? entry?.defaultBaseURL
    let profileCommitted = false
    const save: ProviderEditorSession['save'] = async draft => {
      const key = normalizedApiKey(draft)
      if (mode === 'create' && taken.has(draft.route)) {
        return { kind: 'profile-error', message: `Route 已存在，未覆盖原 profile：${draft.route}` }
      }
      if (profileCommitted && key.length === 0) {
        return { kind: 'key-error', message: 'Profile 已保存；重试 API Key 时仍需输入非空 key。' }
      }
      const credentials = this.deps.reflect.get('credentials', false) as ProviderCredentialsFacet | null | undefined
      const keyRef = mode === 'create' ? resolveKeyRef(draft.route, undefined) : initialKeyRef
      if (!profileCommitted) {
        if (key.length > 0) {
          if (credentials === undefined || credentials === null || typeof credentials.set !== 'function') {
            return { kind: 'profile-error', message: '当前部署无凭据存储；请留空 API Key 或配置 credentials 服务。' }
          }
          try {
            const info = await credentials.describe(keyRef)
            if (info.writable === false) {
              return { kind: 'profile-error', message: `进程环境已提供 ${keyRef}，文件写入不会生效。` }
            }
          } catch {
            // Match KeyDialog: an incompatible describe facet defers the real failure to set.
          }
        }
        const profile = mode === 'create'
          ? createProviderProfile(draft)
          : profileForSave(draft, initialKeyRef, resolvedApiKeyEnv)
        const ops: ProviderSettingsOp[] = mode === 'create'
          ? [{ op: 'set', path: ['providers', draft.route], value: profile }]
          : providerPathOps(settingsPath, original, profile)
        try {
          if (ops.length > 0) await prepared.settings.mutate(settingsNs, ops, prepared.descriptor.revision)
          profileCommitted = true
        } catch (error) {
          return { kind: 'profile-error', message: message(error) }
        }
      }
      if (key.length > 0) {
        try {
          if (credentials === undefined || credentials === null) return { kind: 'key-error', message: 'Profile 已保存，但凭据服务不可用。' }
          await credentials.set(keyRef, key)
        } catch (error) {
          return { kind: 'key-error', message: message(error) }
        }
      }
      this.deps.onSaved()
      return { kind: 'saved' }
    }
    const session: ProviderEditorSession = {
      mode,
      title: mode === 'create' ? '新增自定义 pi-ai 供应商' : `编辑 ${entry?.displayName ?? route}`,
      draft: {
        route,
        declared: mode === 'create' || entry?.declared === true,
        profile,
        models: providerModels(modelsOverridden ? original?.models : resolved.models),
        modelsOverridden,
        keyDraft: '',
      },
      ...defaultBaseURL === undefined ? {} : { defaultBaseURL },
      taken: [...taken],
      discover: async (request, signal) => {
        const llm = this.deps.reflect.get('llm', false) as ProviderLlmFacet | undefined
        if (llm === undefined || typeof llm.discoverModels !== 'function') {
          throw new Error('当前部署不支持模型发现，可继续手输模型。')
        }
        return llm.discoverModels(settingsNs, request, signal)
      },
      save,
    }
    editor.open(session)
    overlay.activate('provider-editor')
    return true
  }
}
