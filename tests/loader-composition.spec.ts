// REAL-composition lane（packages/AGENTS.md 契约）：test-only cordis.yml 经
// Loader 进程内 boot，真实 Cordis Context 与真实服务树（spine + 审批/提问服务），
// 只在终端边界造假（fake TTY 流）、llm-replay 顶掉真适配器。断言用行为判据：
// 挂载后事件驱动渲染、tui-runner fiber dispose 后监听器全释放（写静默）、
// raw-mode 对称恢复。C4 认领的 disposer 缺陷以 it.todo 立线（见文末）。
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
import Subagent, { SubagentRunId } from '@deepseek-ai/dsh-subagent'
    import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Tui from '../src/index.js'

interface FakeStdout {
  stream: WriteStream
  /** 全部写入的拼接文本（ANSI 原样）。 */
  text(): string
  /** write() 被调用的次数（渲染调度探针）。 */
  writes(): number
}

/** 可渲染的 stdout 替身：记录每次写入，宽 100 高 30。 */
function makeStdout(): FakeStdout {
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

interface FakeStdin {
  stream: ReadStream
  /** setRawMode 实参序列（true=接管 / false=恢复）。 */
  rawModeCalls: boolean[]
}

/** TTY stdin 替身：EventEmitter 承载按键/SIGINT，raw-mode 调用可查。 */
function makeStdin(): FakeStdin {
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
  stdout: FakeStdout
  stdin: FakeStdin
  /** tui-runner 插件自己的 ctx（选择性 dispose 该 fiber 用）。 */
  tuiCtx: () => Context
  /** 重挂载 tui-runner（同 fake 流；验证 dispose 后重装配不抛 DUPLICATE_PROVIDER）。 */
  remount: () => Promise<void>
}

/**
 * Boot the real tui composition (example cordis.yml minus the real adapter)
 * through an in-process Loader. Does not provide launcher cmdlineArgs/appExit —
 * tui-runner must activate without those host services.
 * @param opts.withGoalSubagent - false 时省略 subagent 插件与 spine 的 goals
 *   配置（goals/subagents 服务缺席）：tui-runner 只把二者当可选服务，缺省 true。
 * @returns the booted root context, fake streams, and the tui plugin fiber handle.
 */
async function boot(opts?: { withGoalSubagent?: boolean }): Promise<Booted> {
  const withGoalSubagent = opts?.withGoalSubagent ?? true
  root = await mkdtemp(join(tmpdir(), 'dsh-tui-loader-'))
  vi.stubEnv('DSH_HOME', join(root, '.dsh'))
  vi.stubEnv('DSH_AGENTS_HOME', join(root, '.agents'))
  const stdout = makeStdout()
  const stdin = makeStdin()
  let tuiCtx: Context | undefined

  // 场景不驱动任何模型调用：fixture 带 session 头、0 条录制脚本即合法，真调用会 fail loud。
  // （rc.2 起 llm-replay 拒绝空文件：快照必须以 session header 开头。）
  const fixturePath = join(root, 'session.jsonl')
  await writeFile(fixturePath, JSON.stringify({ type: 'session', version: 0, id: 'loader-comp-1', createdAt: 0 }) + '\n')

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
    // goals/subagents 是 tui-runner 的可选服务（不进 inject，缺失时经 reflect
    // 读 undefined 后降级）：本组合覆盖 /goal 与委派树，故装配 subagent 插件与
    // spine 的 goals 配置；withGoalSubagent=false 的场景验证缺席时仍能激活。
    '- id: agent-n',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    '    provider: deepseek-official',
    '    model: deepseek-v4-flash',
    ...(withGoalSubagent ? [
      '- id: subagent',
      "  name: '@deepseek-ai/dsh-subagent'",
    ] : []),
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
    ...(withGoalSubagent ? ['    goals: {}'] : []),
    '    workspaceContext:',
    '      maxBytes: 65536',
    '    persona: |',
    '      You are the tui composition-test agent, powered by the {{model}} model.',
    '- id: tui-runner',
    "  name: '@huiliyi37/dsh-tianshu-tui'",
    '',
  ].join('\n'))

  // 终端边界替换发生在模块面：真实 apply 收到注入的 fake 流（TuiRunnerConfig
  // 本就为测试替身预留了 stdin/stdout 字段），其余装配原样走 Loader。
  const wrappedTui: typeof Tui = {
    ...Tui,
    apply: (ctx, config) => {
      tuiCtx = ctx
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

  return {
    ctx,
    stdout,
    stdin,
    tuiCtx: () => {
      if (tuiCtx === undefined) throw new Error('tui-runner never mounted through the Loader')
      return tuiCtx
    },
    remount: async () => { await ctx.plugin(wrappedTui) },
  }
}

describe('tui real Loader composition through cordis.yml', () => {
  it('tui-runner fiber activates without launcher cmdlineArgs/appExit', async () => {
    const { stdout } = await boot()
    await vi.waitFor(() => {
      expect(stdout.text()).toContain('📁')
    }, { timeout: 10_000 })
  }, 15_000)

  // goals/subagents 是可选服务（不进 inject）：修复前 inject 全量语义下缺席会
  // 让 tui-runner fiber 静默永不激活（无报错、无 TUI），本条是回归拦截。
  it('tui-runner activates without optional goals/subagents services', async () => {
    const { stdout } = await boot({ withGoalSubagent: false })
    await vi.waitFor(() => {
      expect(stdout.text()).toContain('📁')
    }, { timeout: 10_000 })
  }, 15_000)

  it('mounts over the real spine, renders on events, and releases every listener on fiber dispose', async () => {
    const { ctx, stdout, stdin, tuiCtx } = await boot()

    // attach 是 runner 内的异步路径：以首帧渲染为完成判据（启动 context bar +
    // 输入行都到 fake stdout）。
    await vi.waitFor(() => {
      expect(stdout.text()).toContain('📁')
      expect(stdout.text()).toContain('❯')
    }, { timeout: 10_000 })

    // 终端接管：raw-mode 已开启。
    expect(stdin.rawModeCalls).toContain(true)

    // 控制断言：挂载期间真实键入经 InputHandler → 输入行回显 → 渲染调度
    // 产生新写入（写批合并 16ms，故 waitFor）——证明渲染链路真实在线，
    // 后面的"写静默"才有判别力。workflow/start 同时喂入（面板隐藏时不渲染，
    // 仅进状态缓存），供 dispose 后对照同一事件不再有任何监听器消费。
    const beforeLive = stdout.writes()
    stdin.stream.emit('data', 'a')
    ctx.emit('workflow/start', { id: WorkflowRunId('wf-live'), meta: { name: 'wf', description: 'wf' } })
    await vi.waitFor(() => {
      expect(stdout.writes()).toBeGreaterThan(beforeLive)
    }, { timeout: 5_000 })

    // 选择性 dispose：只拆 tui-runner fiber，服务树保持运行。
    await tuiCtx().fiber.dispose()

    // raw-mode 对称恢复（InputHandler.dispose 的 isTTY 分支）。
    expect(stdin.rawModeCalls.at(-1)).toBe(false)

    // 写静默：dispose 后键入与 subagent/workflow 事件都不再触发渲染调度，
    // ticker 已停（窗口 > 120ms ticker 周期 + 16ms 批合并）。subagent/start
    // 是 scope 过滤事件——按 wire 契约带 scope 载体分发（未键定的广播载体）。
    // 事件 map 的 merge-extensible fallback 重载使类型化 emit 推不出真实
    // payload 形状（同 dsh-subagent invariant.spec 的 emitRun），显式断言到
    // 宽松派发签名（SubagentRunInfo 字面量保证形状正确）。
    const afterDispose = stdout.writes()
    stdin.stream.emit('data', 'b')
    ctx.emit('workflow/start', { id: WorkflowRunId('wf-after'), meta: { name: 'wf', description: 'wf' } })
    // 直接按 Scoped 重载派发（scopeTarget 返回 phantom Scoped，结构兼容）。
    // @ts-expect-error -- 重载 2 的 thisArg 为 NoInfer<ThisType<...>>，Scoped 泛型不匹配
    ctx.emit(scopeTarget(ctx, undefined), 'subagent/start', {
      runId: SubagentRunId('run-after'),
      provider: 'spawn',
      id: SessionId('child-after'),
      local: true,
    })
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(stdout.writes()).toBe(afterDispose)
  }, 30_000)

  // C4 认领的 disposer 缺陷（dsh-tui-拆分方案-c4.md Wave 1 #6 / Wave 3）——
  // 已落地，以下两条是组合拦截层（翻绿自 it.todo）。
  it('fiber dispose 后重挂载 tui-runner 不抛 DUPLICATE_PROVIDER（interactionDisposer 随 dispose 释放）', async () => {
    const { stdout, tuiCtx, remount } = await boot()
    await vi.waitFor(() => {
      expect(stdout.text()).toContain('📁')
    }, { timeout: 10_000 })

    // 选择性 dispose：只拆 tui-runner fiber（userQuestions 等服务树保持运行）。
    await tuiCtx().fiber.dispose()
    // attach 失败被 index.ts 吞为 console.error——插探针判别重挂载是否真成功。
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    await remount()
    // dispose 后写静默（ticker 已停）；重挂载成功的判据是恢复产生新写入
    // （新一轮 attach 的首帧渲染/ticker 帧）。
    const frozenWrites = stdout.writes()
    await vi.waitFor(() => {
      expect(stdout.writes()).toBeGreaterThan(frozenWrites)
    }, { timeout: 10_000 })
    // interactionDisposer 若未随 dispose 释放，重挂载的 registerProvider 会抛
    // DUPLICATE_PROVIDER 并走到 attach 失败的 console.error 分支。
    expect(errors).not.toHaveBeenCalled()
  }, 30_000)

  it('切会话结算挂起审批/提问（跨会话残留归零，approval fail-closed / question ASK_CANCELLED）', async () => {
    const { ctx, stdout } = await boot()
    await vi.waitFor(() => {
      expect(stdout.text()).toContain('📁')
    }, { timeout: 10_000 })

    const sessionId = ctx.sessions.list()[0]!.id
    const agent = ctx.agents.get(sessionId)!
    // 提问走真实 userQuestions 服务（provider 是 TUI）；审批直接派发 waterfall
    // 到 TUI answerer（真实 ApprovalService.request 要求开着的回合，组合线会话
    // 空闲——绕过服务策略层，直测 TUI 的挂起/结算行为）。scope 不变量要求载体
    // 键与事件主体同对象（dsh-scope 强制）：载体键到 req.agent。
    // rc.1 wire：ask 必须携带 live agent（scope-filtered 派发的载体），answerer
    // 由 TUI global 注册接收。
    const question = ctx.userQuestions.ask({
      questions: [{ id: 'q1', question: '继续？', options: [{ label: '是' }, { label: '否' }] }],
      agent,
    })
    // 立即挂接断言（reject 发生在切会话/dispose 时）——晚挂接会留未处理
    // rejection 窗口（afterEach 的 fiber dispose 也会 cancel 挂起提问）。
    const questionSettled = expect(question).rejects.toThrow(/cancelled/i)
    const approval = (ctx as unknown as {
      waterfall: (scope: unknown, event: string, req: unknown, next: () => Promise<string>) => Promise<string>
    }).waterfall(scopeTarget(ctx, agent), 'approval/request',
      { agent, toolName: 'bash' }, () => Promise.resolve('unavailable'))
    const approvalSettled = expect(approval).resolves.toBe('cancelled')
    // 等两卡真正挂起（渲染进帧）再切会话——否则 detach 先跑、挂起落空。
    await vi.waitFor(() => {
      expect(stdout.text()).toContain('继续？')
      expect(stdout.text()).toContain('审批 · bash')
    }, { timeout: 10_000 })

    // 经真实命令面（tui.commands 服务）切会话：newSession → detachProjections。
    const registry = ctx.get('tui.commands') as {
      list(): { name: string; run(args: unknown): void | Promise<void> }[]
    }
    const session = registry.list().find(c => c.name === 'session')!
    await session.run({ text: 'new', ctx, sessionId, echo: () => {}, rerender: () => {} })

    // 提问 reject ASK_CANCELLED（provider 契约）；审批 fail-closed 结算 cancelled。
    await questionSettled
    await approvalSettled
  }, 30_000)
})
