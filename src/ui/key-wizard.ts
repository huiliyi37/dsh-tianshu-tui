/**
 * key-wizard — /key 供应商选择步骤的纯函数层：目录 → 带状态的 picker 条目、
 * 供应商 → 凭据引用的解析次序。I/O（describe/settings/凭据）全部在装配方
 * （app.ts 的 openKeyDialog 流程）里；本模块只做可单测的形状决定。
 * 回流自 tianshu-public（上游 src/ui/key-wizard.ts）。
 *
 * @module dsh-tui/key-wizard
 */

import type { PickerItem } from '../picker.js'

/** 可配置供应商目录条目（llm seam 的最小形状；装配方经 reflect.get 现取）。 */
export interface WizardProviderEntry {
  /** 供应商路由 id。 */
  provider: string
  /** 配置界面显示名。 */
  displayName: string
  /** 该 profile 所属的 settings 命名空间（决定引用解析与落盘激活的写入面）。 */
  settingsNs: string
  /** 命名空间段根到 profile 对象的路径（空 = 整段即 profile）。 */
  settingsPath: readonly string[]
  /** 是否为宿主内置 catalog 之外的手写路由。 */
  declared?: boolean
  /** profile 未覆盖 baseURL 时 adapter 报告的缺省端点。 */
  defaultBaseURL?: string
  /** 构造缺省端点所读的环境变量（仅展示）。 */
  baseURLEnv?: readonly string[]
  /** 已解析的 API Key 引用；仅用于识别同认证路由，不改变落盘引用。 */
  keyRef?: string
  /** 装配方验证过的官方别名组；自定义或无法验证目录语义时缺省。 */
  officialAlias?: 'deepseek'
  /** 账号路由是否有可用模型；仅 deepseek-account 使用，缺省按不可用过滤。 */
  accountAvailable?: boolean
}

/**
 * 从供应商路由派生缺省凭据引用：大写、非 `[A-Z0-9]` 连串折叠为单个 `_`、
 * 后缀 `_API_KEY`。与 web 模型页（packages/client/ui-models store.ts 的
 * deriveKeyRef）同一规则的双侧实现——规则由两侧测试钉死，改动必须同步
 * （TUI 不引入 client 包依赖，presentation 层各自持有最小面）。
 * @param provider - 供应商路由 id。
 * @returns POSIX 变量名形状的凭据引用。
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/**
 * 供应商 → 本次落盘引用的解析次序：profile 显式声明的 `apiKeyEnv` 优先
 * （组合层下发的 openrouter profile 就带着 OPENROUTER_API_KEY），未声明再
 * 派生。profile 由装配方从 settings.describe 读出传入——纯函数不做 I/O。
 * @param provider - 供应商路由 id。
 * @param profileApiKeyEnv - 已解析 profile 的 apiKeyEnv（无 profile 或未声明为 undefined）。
 * @returns 凭据引用。
 */
export function resolveKeyRef(provider: string, profileApiKeyEnv: string | undefined): string {
  return profileApiKeyEnv !== undefined && profileApiKeyEnv.length > 0
    ? profileApiKeyEnv
    : deriveKeyRef(provider)
}

/**
 * 构建 /key 供应商 picker 条目。只有装配方明确验证过的官方别名且解析到
 * 同一 keyRef 时才归并；其他路由即使同名同 key 也各自保留。默认供应商
 * 所在组置首，并由默认路由本身代表该组（current）；已配置组带 ✓。
 * deepseek-account 只在模型目录证明可用时显示为不可提交的登录状态行，
 * 默认账号的 ● 直接写入 label，避免 header 渲染分支忽略 current。
 * @param directory - 可配置供应商目录及展示期认证信息。
 * @param configured - 各供应商的 credentials.describe configured 标志。
 * @param defaultProvider - 当前默认模型所在的供应商路由；undefined = 无默认不置首。
 * @returns picker 条目（可选行 value = 供应商路由 id）。
 */
export function buildProviderItems(
  directory: readonly WizardProviderEntry[],
  configured: ReadonlyMap<string, boolean>,
  defaultProvider: string | undefined,
): PickerItem[] {
  const groups: WizardProviderEntry[][] = []
  const officialAliasGroups = new Map<string, WizardProviderEntry[]>()
  for (const entry of directory) {
    if (entry.provider === 'deepseek-account') {
      if (entry.accountAvailable === true) groups.push([entry])
      continue
    }
    if (entry.officialAlias === undefined) {
      groups.push([entry])
      continue
    }
    const key = `${entry.officialAlias}\0${entry.keyRef ?? deriveKeyRef(entry.provider)}`
    const group = officialAliasGroups.get(key)
    if (group === undefined) {
      const created = [entry]
      officialAliasGroups.set(key, created)
      groups.push(created)
    } else {
      group.push(entry)
    }
  }

  const defaultGroup = defaultProvider === undefined
    ? undefined
    : groups.find(group => group.some(entry => entry.provider === defaultProvider))
  const ordered = defaultGroup === undefined
    ? groups
    : [defaultGroup, ...groups.filter(group => group !== defaultGroup)]
  const items: PickerItem[] = []
  for (const group of ordered) {
    const entry = group.find(candidate => candidate.provider === defaultProvider) ?? group[0]
    if (entry === undefined) continue
    const current = entry.provider === defaultProvider
    if (entry.provider === 'deepseek-account') {
      items.push({
        label: `${entry.displayName}（已登录，无需 API Key）${current ? ' ●' : ''}`,
        value: entry.provider,
        header: true,
        ...current ? { current: true } : {},
      })
      continue
    }
    const suffix = group.some(candidate => configured.get(candidate.provider) === true) ? ' ✓' : ''
    items.push({
      label: `${entry.displayName}${suffix}`,
      value: entry.provider,
      ...current ? { current: true } : {},
    })
  }
  return items
}
