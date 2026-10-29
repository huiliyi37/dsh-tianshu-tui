import { deriveKeyRef } from './key-wizard.js'

export const PI_AI_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const

export type ProviderProfile = Record<string, unknown>
export type ProviderModel = Record<string, unknown>

export interface ProviderDraft {
  route: string
  declared: boolean
  profile: ProviderProfile
  models: ProviderModel[]
  modelsOverridden: boolean
  keyDraft: string
}

export interface DiscoveredProviderModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: readonly string[]
}

export type ProviderSettingsOp = {
  op: 'set'
  path: readonly string[]
  value: unknown
} | {
  op: 'unset'
  path: readonly string[]
}

const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const LEGAL_API_KEY = /^[\x21-\x7E]+$/
const ENV_LINE = /^[A-Z][A-Z0-9_]*=[^=]/

export function isProviderProfile(value: unknown): value is ProviderProfile {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function providerModels(value: unknown): ProviderModel[] {
  if (!Array.isArray(value)) return []
  return value.map(row => isProviderProfile(row) ? structuredClone(row) : {})
}

export function providerString(profile: ProviderProfile, key: string): string | undefined {
  const value = profile[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

export function setProviderString(draft: ProviderDraft, key: string, value: string): void {
  if (value.length === 0) Reflect.deleteProperty(draft.profile, key)
  else draft.profile[key] = value
}

export function normalizedApiKey(draft: ProviderDraft): string {
  return draft.keyDraft.trim()
}

function quoted(value: string): boolean {
  const first = value[0]
  return (first === '"' || first === "'" || first === '`') && value.length > 1 && value.endsWith(first)
}

export function apiKeyFailure(draft: ProviderDraft): 'blank' | 'illegal' | undefined {
  if (draft.keyDraft.length === 0) return undefined
  const value = normalizedApiKey(draft)
  if (value.length === 0) return 'blank'
  return ENV_LINE.test(value) || quoted(value) || !LEGAL_API_KEY.test(value) ? 'illegal' : undefined
}

export function validProviderBaseURL(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function normalizedModels(models: readonly ProviderModel[]): ProviderModel[] {
  return models.map(model => {
    const next = structuredClone(model)
    if (typeof next.id === 'string') next.id = next.id.trim()
    if (typeof next.name === 'string' && next.name.length === 0) Reflect.deleteProperty(next, 'name')
    return next
  })
}

export function normalizedProviderProfile(draft: ProviderDraft): ProviderProfile {
  const profile = structuredClone(draft.profile)
  for (const key of ['displayName', 'baseURL']) {
    const value = profile[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length === 0) Reflect.deleteProperty(profile, key)
    else profile[key] = trimmed
  }
  if (draft.modelsOverridden) {
    profile.models = normalizedModels(draft.models)
    Reflect.deleteProperty(profile, 'modelOverrides')
  }
  return profile
}

export function profileForSave(
  draft: ProviderDraft,
  keyRef: string,
  resolvedApiKeyEnv: string | undefined,
): ProviderProfile {
  const profile = normalizedProviderProfile(draft)
  if (normalizedApiKey(draft).length > 0
    && resolvedApiKeyEnv === undefined
    && providerString(profile, 'apiKeyEnv') === undefined) {
    profile.apiKeyEnv = keyRef
  }
  return profile
}

export function createProviderProfile(draft: ProviderDraft): ProviderProfile {
  return profileForSave(draft, deriveKeyRef(draft.route), undefined)
}

function validateModels(models: readonly ProviderModel[]): string | undefined {
  const seen = new Set<string>()
  for (const [index, model] of models.entries()) {
    const id = typeof model.id === 'string' ? model.id.trim() : ''
    if (id.length === 0) return `模型 ${index + 1} 缺少 id`
    if (seen.has(id)) return `模型 ${index + 1} 的 id 重复：${id}`
    seen.add(id)
    if (model.name !== undefined && (typeof model.name !== 'string' || model.name.length === 0)) {
      return `模型 ${index + 1} 的 name 无效`
    }
    for (const key of ['contextWindow', 'maxTokens']) {
      const value = model[key]
      if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)) {
        return `模型 ${index + 1} 的 ${key} 必须是正整数`
      }
    }
    if (model.input !== undefined && (!Array.isArray(model.input)
      || model.input.some(value => value !== 'text' && value !== 'image'))) {
      return `模型 ${index + 1} 的 input 只能包含 text/image`
    }
  }
  return undefined
}

export function validateProviderDraft(draft: ProviderDraft, mode: 'create' | 'edit'): string | undefined {
  if (mode === 'create' && !ROUTE_PATTERN.test(draft.route)) {
    return 'Route 需以小写字母开头，只含小写字母、数字和单连字符分段'
  }
  const profile = normalizedProviderProfile(draft)
  const baseURL = providerString(profile, 'baseURL')
  if (mode === 'create' && baseURL === undefined) return '必须填写 baseURL'
  if (baseURL !== undefined && !validProviderBaseURL(baseURL)) return 'baseURL 必须是有效的 http/https URL'
  const api = providerString(profile, 'api')
  if (mode === 'create' && api === undefined) return '必须选择 wire protocol'
  if (api !== undefined && !PI_AI_PROTOCOLS.includes(api as typeof PI_AI_PROTOCOLS[number])) {
    return `不支持的 wire protocol：${api}`
  }
  if (mode === 'create' && draft.models.length === 0) return '至少添加一个模型'
  if (mode === 'create' || draft.modelsOverridden) {
    const failure = validateModels(draft.models)
    if (failure !== undefined) return failure
  }
  return apiKeyFailure(draft) === undefined ? undefined : 'API Key 格式无效'
}

export function providerPathOps(
  base: readonly string[],
  before: unknown,
  after: ProviderProfile,
): ProviderSettingsOp[] {
  const previous = isProviderProfile(before) ? before : {}
  const ops: ProviderSettingsOp[] = []
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(previous[key]) === JSON.stringify(value)) continue
    ops.push({ op: 'set', path: [...base, key], value })
  }
  for (const key of Object.keys(previous)) {
    if (!(key in after)) ops.push({ op: 'unset', path: [...base, key] })
  }
  return ops
}

export function discoveredModel(model: DiscoveredProviderModel): ProviderModel {
  return {
    id: model.id,
    ...model.name === undefined ? {} : { name: model.name },
    ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
    ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    ...model.inputModalities === undefined ? {} : { input: [...model.inputModalities] },
  }
}

export function adoptProviderModels(
  current: readonly ProviderModel[],
  discovered: readonly DiscoveredProviderModel[],
  picked: ReadonlySet<string>,
): ProviderModel[] {
  const byId = new Map(current.map(model => [typeof model.id === 'string' ? model.id.trim() : '', structuredClone(model)]))
  for (const model of discovered) {
    if (!picked.has(model.id) || byId.has(model.id)) continue
    byId.set(model.id, discoveredModel(model))
  }
  return [...byId.values()]
}
