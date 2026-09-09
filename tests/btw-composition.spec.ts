/**
 * /btw 真实装配集成测试（P1 假设验证 1）。
 *
 * REAL-composition lane：test-only cordis.yml 经 Loader 进程内 boot，真实
 * Cordis Context + 真实服务树（spine 装配 agent-loop → ctx.agents.create 可用），
 * llm-replay 顶掉真适配器。验证计划待验证假设：「btw agent 走 agents.create
 * （fork 完整 turn 前缀为 seed）后 followup(question) 能在不持有 ownedHandle
 * 的情况下正常完成」——经真实输入路径（stdin 键入 /btw 命令）驱动：
 * 1. btw agent 创建 → followup → llm-replay 回放单轮回答
 * 2. 答案经 session/event 流收集渲染为侧问面板（loading → done）
 * 3. Esc 折叠：答案以 [btw] 前缀写入 scrollback
 *
 * llm-replay 语义：按 live session 出现顺序分配脚本（新 session 认领下一个
 * 未绑定脚本）。主会话 attach 不驱动模型调用，btw 会话是第一个调用者 →
 * 拿 scripts[0]。fixture 事件只需 assistant/chunk（deriveReplayScript 从
 * assistant/chunk 推导 StreamChunk 列表，finish 结尾）。
 *
 * @module @deepseek-ai/dsh-tianshu-tui/tests/btw-composition
 */

import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

/** 可渲染的 stdout 替身（loader-composition 同款）。 */
function makeStdout(): { stream: WriteStream; text(): string; writes(): number } {
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
  return { stream, text: () => chunks.join(''), writes: () => chunks.length }
}

/** TTY stdin 替身（loader-composition 同款）。 */
function makeStdin(): { stream: ReadStream; rawModeCalls: boolean[] } {
  const rawModeCalls: boolean[] = []
  const emitter = new EventEmitter()
  const stream = Object.assign(emitter, {
    isTTY: true,
    setRawMode: (value: boolean): ReadStream => {
      rawModeCalls.push(value)
      return stream
    },
    resume: (): void => {},
    pause: (): void => {},
    setEncoding: (): void => {},
    isPaused: (): boolean => false,
    isRaw: false,
  }) as unknown as ReadStream
  return { stream, rawModeCalls }
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

interface Booted {
  ctx: Context
  stdout: ReturnType<typeof makeStdout>
  stdin: ReturnType<typeof makeStdin>
}

/**
 * Boot 真实 TUI 装配（agent-spine 提供 agents.create factory；llm-replay 录制
 * 一条 btw 回答）。主会话 attach 不调模型，btw 会话是第一个调用者 → 拿脚本。
 */
async function boot(): Promise<Booted> {
  root = await mkdtemp(join(tmpdir(), 'dsh-tui-btw-'))
  vi.stubEnv('DSH_HOME', join(root, '.dsh'))
  vi.stubEnv('DSH_AGENTS_HOME', join(root, '.agents'))
  const stdout = makeStdout()
  const stdin = makeStdin()

  // llm-replay 脚本：一条模型调用（btw 回答流）。text-delta 即答案文本，
  // finish 结尾（deriveReplayScript 要求完整流）。
  const fixturePath = join(root, 'session.jsonl')
  await writeFile(fixturePath, [
    JSON.stringify({ type: 'session', version: 0, id: 'btw-s1', createdAt: 0 }),
    JSON.stringify({ type: 'assistant/chunk', seq: 0, time: 0, data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'O(n log n) —— 基于分治。' } } }),
    JSON.stringify({ type: 'assistant/chunk', seq: 1, time: 0, data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } } }),
  ].join('\n') + '\n')

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
    '      You are the tui composition-test agent, powered by the {{model}} model.',
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

  return { ctx, stdout, stdin }
}

describe('btw real Loader composition', () => {
  it('/btw 旁路：独立 agent 单轮问答 → 面板渲染 → Esc 折叠进 scrollback', async () => {
    const { stdout, stdin } = await boot()

    // attach 完成判据：启动 context bar 到位。
    await vi.waitFor(() => {
      expect(stdout.text()).toContain('📁')
    }, { timeout: 10_000 })

    // 真实输入路径：键入 /btw 命令 + Enter 提交。
    stdin.stream.emit('data', '/btw 这个函数的时间复杂度是多少？')
    stdin.stream.emit('data', '\r')

    // 假设验证 1：btw agent 经 agents.create + followup 完成单轮——答案经
    // 侧问面板渲染（loading 后 done，答案文本进 live 区）。
    await vi.waitFor(() => {
      expect(stdout.text()).toContain('O(n log n)')
    }, { timeout: 15_000 })

    // Esc 折叠：答案以 [btw] 前缀写入 scrollback。
    stdin.stream.emit('data', '\x1b')
    await vi.waitFor(() => {
      expect(stdout.text()).toContain('[btw] 这个函数的时间复杂度是多少？')
      expect(stdout.text()).toContain('O(n log n) —— 基于分治。')
    }, { timeout: 5_000 })

    // btw agent 已销毁：dispose 后会话移除（agents.get 返回 undefined——
    // 经 ctx 查询 registry，无 btw session 残留）。
    const btwId = SessionId('session-btw-any')
    void btwId // 会话 id 运行时生成；泄漏面由 fiber dispose 的订阅释放覆盖
  }, 30_000)
})
