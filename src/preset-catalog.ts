/**
 * 官方 shipped 预设的展示目录：短名、能力、工具集。
 *
 * 花名册 list() 已有 preset.yml 的 name/description；本表补「工具集 + 能力」
 * 给 /preset 列表与 footer/顶栏短名。id 对齐 CLI
 * apps/cli/config/agent-presets/{standard,ptc,minimal,cordis}（rc.1 起 code → ptc）。
 *
 * @module @huiliyi37/dsh-tianshu-tui/preset-catalog
 */

/** 一套 shipped 预设的展示文案。 */
export interface ShippedPresetBlurb {
  /** 目录名，也是 /preset 实参。 */
  id: string
  /** footer / 顶栏短名。 */
  short: string
  /** 列表标题（与官方 preset.yml name 对齐）。 */
  name: string
  /** 一句话能力。 */
  capability: string
  /** 工具集摘要。 */
  tools: string
}

const BLURBS: readonly ShippedPresetBlurb[] = [
  {
    id: 'standard',
    short: '标准',
    name: '标准模式',
    capability: '完整编码 Agent：改文件、Shell、检索、网页、Skills、计划、目标、子代理、工作流',
    tools: 'bash · 编辑 · 检索 · web · skills · 计划 · 目标 · 子代理 · 工作流',
  },
  {
    id: 'ptc',
    short: 'PTC',
    name: 'PTC 模式',
    capability: '标准能力 + PTC：用一个 TypeScript 程序组合多步工具',
    tools: '标准工具面 + run_code（PTC SDK）',
  },
  {
    id: 'minimal',
    short: '极简',
    name: '极简模式',
    capability: '少干扰双工具编码面，适合评测与只要 shell + 改文件的任务',
    tools: 'bash · str_replace_editor',
  },
  {
    id: 'cordis',
    short: '创造',
    name: '创造模式',
    capability: '标准能力 + 做自定义 preset：运行时检查、插件实验、创作指导',
    tools: '标准工具面 + 运行时检查 · 插件实验 · preset 创作',
  },
]

const BY_ID = new Map(BLURBS.map(b => [b.id, b]))

/** 用户口误 / 旧文档别名 → 官方目录 id（rc.1 起 Code Mode 正式更名 PTC mode）。 */
const ALIASES: Readonly<Record<string, string>> = {
  code: 'ptc',
  creative: 'cordis',
  creator: 'cordis',
}

/** 把用户输入折成花名册 id（已知别名才改，其余原样）。 */
export function resolveShippedPresetId(id: string): string {
  return ALIASES[id] ?? id
}

/** 按 id 或别名取展示目录；未知 id 返回 undefined。 */
export function shippedPresetBlurb(id: string): ShippedPresetBlurb | undefined {
  return BY_ID.get(resolveShippedPresetId(id))
}

/** footer / 顶栏短名；未知 id 原样。 */
export function presetShortLabel(id: string): string {
  return shippedPresetBlurb(id)?.short ?? id
}

/**
 * /preset 列表的两行补充：能力 + 工具。
 * 官方 description 优先作能力行；没有再用目录。未知 id 只回官方 description。
 */
export function presetListDetails(
  id: string,
  officialDescription?: string,
): { capability?: string; tools?: string } {
  const blurb = shippedPresetBlurb(id)
  const capability = officialDescription !== undefined && officialDescription !== ''
    ? officialDescription
    : blurb?.capability
  return {
    ...(capability === undefined ? {} : { capability }),
    ...(blurb === undefined ? {} : { tools: blurb.tools }),
  }
}

/** 从 host + 当前会话读 live 预设短名（无 join / 无会话 → undefined）。 */
export function livePresetShort(
  host: {
    reflect?: { get(name: string, required?: boolean): unknown }
    agents?: { get(id: string): { ctx?: unknown } | undefined }
  },
  sessionId: string | null,
): string | undefined {
  if (sessionId === null || host.agents === undefined) return undefined
  const agent = host.agents.get(sessionId)
  if (agent === undefined) return undefined
  const roster = host.reflect?.get('agentPresets', false) as
    | { composedPreset?(agentCtx: unknown): string | undefined }
    | undefined
  const id = roster?.composedPreset?.(agent.ctx)
  return id === undefined || id === '' ? undefined : presetShortLabel(id)
}
