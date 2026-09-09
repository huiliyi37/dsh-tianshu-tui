/**
 * preset-join 真实 spine 装配：能解析官方 presets 包时，新会话 composedPreset 非空。
 * 解不到包则跳过，不让 CI 因缺官方包红。不依赖 CLI 注入的 shipped 根——
 * 测试自备空 composition（[] 合法），只钉 join/mount 接线。
 */
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { ReadStream, WriteStream } from 'node:tty'
import SettingsLocal from '@deepseek-ai/dsh-settings-file'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import UserApproval from '@deepseek-ai/dsh-user-approval'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import * as LlmReplay from '@deepseek-ai/dsh-llm-replay'
import * as AgentSpine from '@deepseek-ai/dsh-agent-spine-demo'
import { installSpineEventsCompat } from './spine-events-compat.js'

// spine-demo 停在 alpha.2：安装 Session.events → snapshotEvents 兼容垫片（见模块头）
installSpineEventsCompat()
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import Subagent from '@deepseek-ai/dsh-subagent'
  import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Tui from '../src/index.js'
import { joinPreset, presetJoinFacet } from '../src/adapter/preset-join.js'

function makeStdout(): { stream: WriteStream; text(): string } {
  const chunks: string[] = []
  const emitter = new EventEmitter()
  const stream = Object.assign(emitter, {
    columns: 100,
    rows: 30,
    isTTY: true,
    write: (chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    },
  }) as unknown as WriteStream
  return { stream, text: () => chunks.join('') }
}

function makeStdin(): { stream: ReadStream } {
  const emitter = new EventEmitter()
  const stream = Object.assign(emitter, {
    isTTY: true,
    setRawMode: (): ReadStream => stream,
    resume: (): void => {},
    pause: (): void => {},
    setEncoding: (): void => {},
    isPaused: (): boolean => false,
    isRaw: false,
  }) as unknown as ReadStream
  return { stream }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

async function tryLoadPresets(): Promise<unknown | undefined> {
  try {
    return (await import('@deepseek-ai/dsh-agent-presets')).default
  } catch {
    return undefined
  }
}

describe('preset-join real spine composition', () => {
  it('能解析 presets 包时新会话 composedPreset 非空（解不到则跳过）', async () => {
    const AgentPresets = await tryLoadPresets()
    if (AgentPresets === undefined) return

    root = await mkdtemp(join(tmpdir(), 'dsh-tui-preset-join-'))
    vi.stubEnv('DSH_HOME', join(root, '.dsh'))
    vi.stubEnv('DSH_AGENTS_HOME', join(root, '.agents'))
    const presetRoot = join(root, 'presets')
    await mkdir(join(presetRoot, 'standard'), { recursive: true })
    await writeFile(join(presetRoot, 'standard', 'agent.cordis.yml'), '[]\n')

    const fixturePath = join(root, 'session.jsonl')
    await writeFile(fixturePath, [
      JSON.stringify({ type: 'session', version: 0, id: 'pj-s1', createdAt: 0 }),
    ].join('\n') + '\n')

    const stdout = makeStdout()
    const stdin = makeStdin()
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: settings',
      "  name: '@deepseek-ai/dsh-settings-file'",
      '- id: credentials',
      "  name: '@deepseek-ai/dsh-credentials-local'",
      '- id: user-approval',
      "  name: '@deepseek-ai/dsh-user-approval'",
      '- id: user-questions',
      "  name: '@deepseek-ai/dsh-user-questions'",
      '- id: llm-replay',
      "  name: '@deepseek-ai/dsh-llm-replay'",
      '  config:',
      `    file: ${JSON.stringify(fixturePath)}`,
      '    providers:',
      '      - id: deepseek-official',
      '        models:',
      '          - id: deepseek-v4-flash',
      '            contextWindow: 128000',
      '- id: agent-n',
      "  name: '@deepseek-ai/dsh-agent-default-model'",
      '  config:',
      '    provider: deepseek-official',
      '    model: deepseek-v4-flash',
      '- id: subagent',
      "  name: '@deepseek-ai/dsh-subagent'",
      '- id: agent-loop',
        "  name: '@deepseek-ai/dsh-agent-loop'",
      '- id: agent-spine',
      "  name: '@deepseek-ai/dsh-agent-spine-demo'",
      '  config:',
      '    agents:',
      '      - id: main',
      '        provider: deepseek-official',
      '        model: deepseek-v4-flash',
      `        cwd: ${JSON.stringify(root)}`,
      '    goals: {}',
      '    workspaceContext:',
      '      maxBytes: 65536',
      '    persona: |',
      '      You are the preset-join composition-test agent.',
      '- id: agent-presets',
      "  name: '@deepseek-ai/dsh-agent-presets'",
      '  config:',
      '    default: standard',
      '    includeUserRoot: false',
      '    includeShippedRoot: false',
      '    roots:',
      `      - path: ${JSON.stringify(presetRoot)}`,
      '        trust: system',
      '- id: tui-runner',
      "  name: '@huiliyi37/dsh-tianshu-tui'",
      '',
    ].join('\n'))

    const wrappedTui: typeof Tui = {
      ...Tui,
      apply: (ctx, config) => {
        Tui.apply(ctx, { ...config, disableKeyAutoPrompt: true, stdin: stdin.stream, stdout: stdout.stream })
      },
    }
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-settings-file', SettingsLocal],
      ['@deepseek-ai/dsh-credentials-local', CredentialsLocal],
      ['@deepseek-ai/dsh-user-approval', UserApproval],
      ['@deepseek-ai/dsh-user-questions', UserQuestions],
      ['@deepseek-ai/dsh-llm-replay', LlmReplay],
      ['@deepseek-ai/dsh-agent-default-model', AgentDefaultModel],
      ['@deepseek-ai/dsh-subagent', Subagent],
  ['@deepseek-ai/dsh-agent-loop', AgentLoop],
      ['@deepseek-ai/dsh-agent-spine-demo', AgentSpine],
      ['@deepseek-ai/dsh-agent-presets', AgentPresets],
      ['@huiliyi37/dsh-tianshu-tui', wrappedTui],
    ])

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()

    await vi.waitFor(() => {
      expect(stdout.text()).toContain('📁')
    }, { timeout: 10_000 })

    const roster = ctx.reflect.get('agentPresets', false) as {
      composedPreset?(agentCtx: unknown): string | undefined
    } | undefined
    expect(roster?.composedPreset).toBeTypeOf('function')

    // spine-demo 启动时已铸 main agent（无 join）；直接 create 才走 setup mount。
    const created = await ctx.agents.create({
      sessionId: SessionId('session-preset-join'),
      meta: { cwd: root },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: async (agentCtx) => {
        await joinPreset({
          facet: presetJoinFacet(ctx),
          agentCtx,
          mode: 'create',
          preferredId: 'standard',
        })
      },
    })
    expect(roster!.composedPreset!(created.agent.ctx)).toBe('standard')

    const before = new Set(ctx.sessions.list().map(s => String(s.id)))
    stdin.stream.emit('data', '/session new')
    stdin.stream.emit('data', '\r')
    await vi.waitFor(() => {
      const added = ctx.sessions.list().map(s => s.id).filter(id => !before.has(String(id)))
      expect(added.length).toBeGreaterThan(0)
      const agent = ctx.agents.get(added[added.length - 1]!)
      expect(agent).toBeDefined()
      expect(roster!.composedPreset!(agent!.ctx)).toBe('standard')
    }, { timeout: 10_000 })
  }, 30_000)
})
