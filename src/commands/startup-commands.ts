/**
 * startup-commands — /theme /model /effort /preset：会话应用 vs 启动默认。
 *
 * 带参无 default = 仅本会话；末尾 default / 选择器 S = 写启动默认。
 *
 * @module @huiliyi37/dsh-tianshu-tui/commands/startup-commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { getActiveThemeName, setTheme, THEME_NAMES } from '../theme.js'
import { parseRouteKey } from '../engine/route-key.js'
import { formatWireSurface, wirePhaseLabel, wireToolNames } from '../preset-surface.js'
import { presetListDetails, presetShortLabel, resolveShippedPresetId } from '../preset-catalog.js'
import { echoSavedDefault, echoSessionOnly, splitDefaultFlag } from '../startup-defaults.js'
import { SPARK_ALIASES, validateModelSelection, type LlmCatalogFacet } from './model-validate.js'
import type { ModelFacet, SlashCommand } from './registry.js'

/** /model 的 effort 白名单（llm 三档：off / high / max）。 */
export const EFFORT_LEVELS = ['off', 'high', 'max'] as const

/** 花名册已有该 id 则原样；否则折官方别名（ptc→code）。 */
function listedId(presets: ReadonlyArray<{ id: string }>, raw: string): string {
  if (presets.some(p => p.id === raw)) return raw
  return resolveShippedPresetId(raw)
}

/** /preset 所需的最小 agent-presets 服务面。 */
interface PresetFacet {
  list(): Promise<Array<{ id: string; name?: string; description?: string }>>
  composedPreset?(agentCtx: Context): string | undefined
  recompose(agentCtx: Context, id: string): Promise<{ id: string; name?: string }>
}

/** 四条启动项命令需要的 deps 子集。 */
export interface StartupCommandDeps {
  switchLiveModel(selection: { provider: string; model: string; reasoningEffort?: string }): boolean
  openModelPicker(): void
  openThemePicker(): void
  openEffortPicker(): void
  onThemeApplied(name: string): void
  onThemeChanged?(): void
  applyThemeAuto(persist?: boolean): void
  exportTheme(name?: string): string
  currentAgent(): Agent | null
  isBlankSession(): boolean
  persistPresetDefault(id: string): void
  currentDefaultPreset(): string | undefined
}

function echoModel(persist: boolean, hot: boolean, label: string): string {
  if (persist) {
    return hot ? echoSavedDefault('model', label) : `${echoSavedDefault('model', label)}（当前会话不可热切）`
  }
  return hot ? echoSessionOnly('model', label) : `模型已切换: ${label}（当前会话不可热切）。选择器按 S 或 /model default 可设为启动默认`
}

function echoEffort(persist: boolean, hot: boolean, label: string): string {
  if (persist) {
    return hot ? echoSavedDefault('effort', label) : `${echoSavedDefault('effort', label)}（当前会话不可热切）`
  }
  return hot ? echoSessionOnly('effort', label) : `推理等级已设为 ${label}（当前会话不可热切）。选择器按 S 或 /effort default 可设为启动默认`
}

export function createThemeCommand(deps: StartupCommandDeps): SlashCommand {
  return {
    name: 'theme',
    category: '配置',
    description: '切换主题（Enter/带参=本会话；S 或末尾 default=启动默认；auto/export 子命令）',
    argsHint: '<name>|auto|export [name]|default',
    run: ({ text, echo }) => {
      const { rest, persist } = splitDefaultFlag(text)
      if (rest === '' && persist) {
        const current = getActiveThemeName()
        deps.onThemeApplied(current)
        echo(echoSavedDefault('theme', current))
        return
      }
      if (rest === '') {
        deps.openThemePicker()
        return
      }
      if (rest === 'auto') {
        deps.applyThemeAuto(persist)
        return
      }
      if (rest === 'export' || rest.startsWith('export ')) {
        echo(deps.exportTheme(rest.slice('export'.length).trim() || undefined))
        return
      }
      if (setTheme(rest)) {
        if (persist) deps.onThemeApplied(rest)
        deps.onThemeChanged?.()
        echo(persist ? echoSavedDefault('theme', rest) : echoSessionOnly('theme', rest))
      } else {
        echo(`未知主题: ${rest}。可用: ${THEME_NAMES.join(', ')} / custom:<name>`)
      }
    },
  }
}

export function createModelCommand(deps: StartupCommandDeps): SlashCommand {
  return {
    name: 'model',
    category: '配置',
    description: '查看或切换模型（带参=本会话；S 或末尾 default=启动默认；spark-flash / spark-pro 映射官方 flash / pro）',
    argsHint: '[provider/model | spark-flash | spark-pro] [effort] [default]',
    run: async ({ text, echo, ctx }) => {
      const facet = (ctx as unknown as { agentDefaultModel?: ModelFacet }).agentDefaultModel
      if (facet === undefined) {
        echo('⚠ agent-default-model 服务不可用')
        return
      }
      const current = facet.currentSelection()
      const { rest, persist } = splitDefaultFlag(text)
      if (rest === '' && persist) {
        await facet.saveSelection(current)
        echo(echoSavedDefault('model', `${current.provider}/${current.model}`))
        return
      }
      if (rest === '') {
        deps.openModelPicker()
        return
      }
      const [target = '', effortRaw] = rest.split(/\s+/)
      if (effortRaw !== undefined
        && !(EFFORT_LEVELS as readonly string[]).includes(effortRaw)) {
        echo(`⚠ 不支持的 effort: ${effortRaw}（可用: off / high / max）`)
        return
      }
      const aliased = SPARK_ALIASES[target]
      const input = aliased === undefined ? target : `${aliased.provider}/${aliased.model}`
      const routed = parseRouteKey(input)
      const next = routed === undefined
        ? { provider: current.provider, model: input }
        : routed
      const llm = ctx.reflect.get('llm', false) as LlmCatalogFacet | undefined
      const invalid = await validateModelSelection(llm, next, current)
      if (invalid !== null) { echo(invalid); return }
      const selection = effortRaw === undefined
        ? next
        : { ...next, reasoningEffort: effortRaw }
      if (persist) await facet.saveSelection(selection)
      const hot = deps.switchLiveModel(selection)
      const effortPart = effortRaw === undefined ? '' : ` (effort: ${effortRaw})`
      echo(echoModel(persist, hot, `${selection.provider}/${selection.model}${effortPart}`))
    },
  }
}

export function createEffortCommand(deps: StartupCommandDeps): SlashCommand {
  return {
    name: 'effort',
    category: '配置',
    description: '设置推理等级（带参=本会话；S 或末尾 default=启动默认；auto 回模型默认）',
    argsHint: '[off|high|max|auto|default]',
    run: async ({ text, echo, ctx }) => {
      const facet = (ctx as unknown as { agentDefaultModel?: ModelFacet }).agentDefaultModel
      if (facet === undefined) {
        echo('⚠ agent-default-model 服务不可用')
        return
      }
      const current = facet.currentSelection()
      const { rest, persist } = splitDefaultFlag(text)
      if (rest === '' && persist) {
        await facet.saveSelection(current)
        const label = current.reasoningEffort ?? 'auto'
        echo(echoSavedDefault('effort', label))
        return
      }
      if (rest === '') {
        deps.openEffortPicker()
        return
      }
      if (rest === 'auto') {
        const selection = { provider: current.provider, model: current.model }
        if (persist) await facet.saveSelection(selection)
        const hot = deps.switchLiveModel(selection)
        echo(echoEffort(persist, hot, 'auto'))
        return
      }
      if (!(EFFORT_LEVELS as readonly string[]).includes(rest)) {
        echo(`⚠ 不支持的推理等级: ${rest}（可用: off / high / max / auto）`)
        return
      }
      const selection = { provider: current.provider, model: current.model, reasoningEffort: rest }
      if (persist) await facet.saveSelection(selection)
      const hot = deps.switchLiveModel(selection)
      echo(echoEffort(persist, hot, rest))
    },
  }
}

export function createPresetCommand(deps: StartupCommandDeps): SlashCommand {
  return {
    name: 'preset',
    category: '配置',
    description: '查看/切换 agent 预设（带参=本会话；末尾 default=启动默认；仅空白会话可换）',
    argsHint: '[id] [default]',
    run: async ({ text, echo, ctx }) => {
      const facet = ctx.reflect.get('agentPresets', false) as PresetFacet | undefined
      if (facet === undefined) {
        echo('⚠ agent-presets 服务不可用（host 未装配 agent 预设）')
        return
      }
      const { rest, persist } = splitDefaultFlag(text)
      if (rest === '' && persist) {
        const agent = deps.currentAgent()
        const current = agent === null ? undefined : facet.composedPreset?.(agent.ctx)
        if (current === undefined) {
          echo('⚠ 当前无预设可设为启动默认')
          return
        }
        deps.persistPresetDefault(current)
        echo(echoSavedDefault('preset', current))
        return
      }
      if (rest === '') {
        const presets = await facet.list()
        const agent = deps.currentAgent()
        const current = agent === null ? undefined : facet.composedPreset?.(agent.ctx)
        const saved = deps.currentDefaultPreset()
        echo(`agent 预设 (${presets.length}):`)
        for (const preset of presets) {
          const mark = preset.id === current ? '*' : ' '
          const star = preset.id === saved ? '★' : ' '
          const name = preset.name ?? preset.id
          echo(` ${mark}${star}${name} (${preset.id})`)
          const details = presetListDetails(preset.id, preset.description)
          if (details.capability !== undefined) echo(`    ${details.capability}`)
          if (details.tools !== undefined) echo(`    工具: ${details.tools}`)
        }
        let currentLine = current === undefined
          ? '当前: 未装配（host 默认）'
          : `当前: ${current} · ${presetShortLabel(current)}`
        if (saved !== undefined) currentLine += ` · 启动默认: ${saved}`
        if (agent !== null) {
          const wire = wireToolNames(agent.session.snapshotEvents())
          const surface = formatWireSurface(wire)
          if (surface !== undefined) {
            const phase = wirePhaseLabel(wire)
            currentLine += ` · wire: ${surface}${phase === undefined ? '' : `（${phase}）`}`
          }
        }
        echo(currentLine)
        return
      }
      const agent = deps.currentAgent()
      if (agent === null) {
        echo('当前无会话，无法切换预设')
        return
      }
      if (!deps.isBlankSession()) {
        echo('⚠ 会话已产生内容，无法切换预设（仅空白会话可换；新会话默认仍用当前预设）')
        return
      }
      try {
        const wanted = listedId(await facet.list(), rest)
        const preset = await facet.recompose(agent.ctx, wanted)
        agent.session.append('agent-preset/selected', { agentPreset: preset.id })
        if (persist) deps.persistPresetDefault(preset.id)
        const label = `${preset.name ?? preset.id} (${preset.id})`
        echo(persist ? echoSavedDefault('preset', label) : echoSessionOnly('preset', label))
      } catch (error) {
        echo(`切换失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}
