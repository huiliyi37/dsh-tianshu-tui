/**
 * key-dialog — 供应商 API Key 设置对话框（/key、/login；首启缺 key 自动引导）。
 * 回流自 tianshu-public（上游 src/ui/key-dialog.ts）。
 *
 * 掩码输入 overlay，与 picker 同构（OverlayRenderer 契约 + 装配方键路由）：
 * - 配置目标由装配方注入（KeyDialogTarget：供应商路由、显示名、落盘引用、
 *   探测实现）；缺省目标仍是 DeepSeek 官方路由（首启引导与既有调用面）。
 * - 输入态：可打印字符/粘贴进 Key 字段，渲染掩码（≤8 字符全显 •；>8 只露
 *   末 4 位明文，grok 同款）；Enter 提交，Esc/Ctrl+C 取消。
 * - 提交三态流：预检（describe 报 writable=false＝进程环境遮蔽 → 说明态，
 *   文件写入不会生效）→ 探测（目标自带实现，三分类）→ 落盘（credentials.set）。
 *   invalid 回输入态；unknown 进警告确认态（Enter 仍要保存，Esc 取消）；
 *   ok 直接落盘进成功态。
 * - 凭据安全：key 只进 Authorization 头，不进 URL/日志/错误文案；探测错误
 *   一律折叠为 unknown，不外泄 fetch 细节。
 *
 * 本模块不引入 dsh-credentials peer：凭据面是结构最小接口（KeyDialogCredentials），
 * 由装配方经 ctx.reflect.get('credentials') 注入；服务缺席时对话框给降级指引。
 *
 * @module dsh-tui/key-dialog
 */

import type { OverlayKeyResult, OverlayRenderer } from '../engine/overlay-engine.js'
import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { truncateToDisplayWidth } from '../width.js'

/** 对话框管理的凭据引用（credentials 服务层的 POSIX 变量名）。 */
const KEY_REF = 'DEEPSEEK_API_KEY'

/** Key 探测结果三分类：ok（2xx）/ invalid（401·403）/ unknown（网络错误、超时、其他状态码）。 */
export type KeyProbeResult = 'ok' | 'invalid' | 'unknown'

/** key-dialog 消费的最小凭据面（不引入 dsh-credentials peer；reflect.get 动态获取）。 */
export interface KeyDialogCredentials {
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable?: boolean }>
  set(ref: string, value: string): Promise<void>
}

/**
 * 一次配置会话的目标供应商：标题、落盘引用与探测实现由装配方注入——
 * 对话框本身不知道任何具体供应商。
 * @param provider - 供应商路由 id（诊断与向导回链用）。
 * @param displayName - 标题与状态文案里的显示名。
 * @param ref - 落盘的凭据引用（POSIX 变量名）。
 * @param probe - 该供应商的探测实现（三分类）。
 * @param afterSave - 落盘成功后的激活步（如补写 settings profile 让路由注册）；
 *   失败回输入态带错误（key 已存，激活可随重试补齐）。
 */
export interface KeyDialogTarget {
  provider: string
  displayName: string
  ref: string
  probe: (key: string) => Promise<KeyProbeResult>
  afterSave?: () => Promise<void>
}

/** 缺省目标：DeepSeek 官方路由（向后兼容无参 open 与首启自动引导）。 */
export const DEEPSEEK_KEY_TARGET: KeyDialogTarget = {
  provider: 'deepseek-official',
  displayName: 'DeepSeek',
  ref: KEY_REF,
  probe: probeDeepSeekKey,
}

/**
 * 输入行掩码：≤8 字符全显 •；>8 字符显示固定 `••••…` + 末 4 位明文。
 * @param value - 当前输入的明文（不落盘、不入日志）。
 * @returns 掩码后的显示文本。
 */
export function maskKeyInput(value: string): string {
  if (value.length <= 8) return '•'.repeat(value.length)
  return `••••…${value.slice(-4)}`
}

/**
 * 真实探测：GET {baseURL}/models（baseURL = DEEPSEEK_BASE_URL ?? 官方端点，
 * 3s 超时）。key 只进 Authorization 头；任何网络/超时异常折叠为 unknown。
 * @param key - 待验证的 API key 明文。
 * @returns 探测三分类。
 */
export async function probeDeepSeekKey(key: string): Promise<KeyProbeResult> {
  const baseURL = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  try {
    const res = await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(3000),
    })
    if (res.status === 401 || res.status === 403) return 'invalid'
    return res.ok ? 'ok' : 'unknown'
  } catch {
    // 网络错误/超时（含 AbortError）——无法证伪 key，交给用户决定（unknown 态可强存）
    return 'unknown'
  }
}

/** 对话框阶段：input 编辑 / probing·saving 瞬时 / confirm-unknown 警告确认 / saved·blocked·unavailable 终态说明。 */
type KeyDialogPhase = 'input' | 'probing' | 'confirm-unknown' | 'saving' | 'saved' | 'blocked' | 'unavailable'

/** KeyDialogController 构造选项。 */
export interface KeyDialogOptions {
  /** 主题读取函数（动态，切主题后 overlay 立即生效）。 */
  getTheme: () => RivetTheme
  /** 异步状态翻转（探测/落盘完成）后的重绘回调（装配方接 overlay.rerender）。 */
  onChange?: () => void
  /** 保存成功回调（装配方刷新 API key 就绪标志——欢迎行与 footer 翻 ✓）。 */
  onSaved?: () => void
  /** 探测实现（缺省真实 fetch；测试注入桩——mock 只许在外部边界）。 */
  probe?: (key: string) => Promise<KeyProbeResult>
}

/**
 * API Key 设置对话框控制器：纯状态机 + 渲染（OverlayRenderer 契约），I/O
 * （describe/set/probe）经构造/open 注入。装配方负责 activate/deactivate 与
 * 键路由；wantsClose() 为 true 时装配方 deactivate。
 */
export class KeyDialogController implements OverlayRenderer {
  private phase: KeyDialogPhase = 'input'
  private value = ''
  private error: string | null = null
  private notice: string | null = null
  private credentials: KeyDialogCredentials | undefined
  private target: KeyDialogTarget = DEEPSEEK_KEY_TARGET
  private openFlag = false
  private closeRequested = false
  private readonly getTheme: () => RivetTheme
  private readonly onChange: (() => void) | undefined
  private readonly onSaved: (() => void) | undefined
  /** 构造期探测覆盖（测试注入）；目标自带探测之上优先。 */
  private readonly probeOverride: ((key: string) => Promise<KeyProbeResult>) | undefined

  constructor(opts: KeyDialogOptions) {
    this.getTheme = opts.getTheme
    if (opts.onChange !== undefined) this.onChange = opts.onChange
    if (opts.onSaved !== undefined) this.onSaved = opts.onSaved
    this.probeOverride = opts.probe
  }

  /**
   * 对话框是否打开（装配方 deactivate 时经 onDeactivate 置假）。
   * @returns 打开返回 true。
   */
  isOpen(): boolean {
    return this.openFlag
  }

  /**
   * 打开对话框并重置状态；凭据服务缺席进降级指引态，否则 describe 预检
   * （writable=false＝进程环境遮蔽 → 说明态）。describe 抛错（面不匹配）时
   * 进入输入态——写不通会在 set 时暴露真实错误（最早可判定处 fails loud）。
   * @param credentials - 凭据服务最小面；undefined = 服务缺席。
   * @param target - 本次配置的供应商目标；缺省 DeepSeek（首启引导与既有调用）。
   */
  async open(credentials: KeyDialogCredentials | undefined, target?: KeyDialogTarget): Promise<void> {
    this.credentials = credentials
    this.target = target ?? DEEPSEEK_KEY_TARGET
    this.value = ''
    this.error = null
    this.notice = null
    this.openFlag = true
    this.closeRequested = false
    if (credentials === undefined) {
      this.phase = 'unavailable'
      return
    }
    try {
      const info = await credentials.describe(this.target.ref)
      // isOpen() 走方法边界：await 期间 onDeactivate 可能已关窗（窄化不跨方法）。
      if (!this.isOpen()) return
      this.phase = info.writable === false ? 'blocked' : 'input'
    } catch {
      if (!this.isOpen()) return
      this.phase = 'input'
    }
    this.onChange?.()
  }

  /**
   * 处理按键（装配方在 overlay 激活时全量转发；本方法总是消费）。
   * 输入态：字符/退格编辑、Enter 提交（空值不提交）、Esc/Ctrl+C 取消；
   * confirm-unknown 态：Enter 强存、Esc/Ctrl+C 取消；终态说明态：Enter/Esc 关闭；
   * 瞬时态（probing/saving）：Esc/Ctrl+C 关闭（迟到结果按 openFlag 守卫丢弃），其余忽略。
   * 返回 'close' 时同时置 wantsClose（装配方 deactivate；统一返回词表后
   * 装配方直接消费返回值，wantsClose 保留给既有调用面/测试）。
   * @param name - 按键名（return/escape/backspace/ctrl_c 等）。
   * @param char - 可打印字符（控制键为 ''）。
   * @returns close = 请求关闭；handled = 已消费。
   */
  handleKey(name: string, char: string): OverlayKeyResult {
    if (!this.openFlag) return 'handled'
    switch (this.phase) {
      case 'input':
        if (name === 'escape' || name === 'ctrl_c') {
          this.closeRequested = true
        } else if (name === 'return') {
          if (this.value !== '') this.submit()
        } else if (name === 'backspace') {
          this.value = this.value.slice(0, -1)
          this.error = null
        } else if (char !== '') {
          this.value += char
          this.error = null
        }
        break
      case 'confirm-unknown':
        if (name === 'return') void this.persist(this.value)
        else if (name === 'escape' || name === 'ctrl_c') this.closeRequested = true
        break
      case 'probing':
      case 'saving':
        if (name === 'escape' || name === 'ctrl_c') this.closeRequested = true
        break
      case 'saved':
      case 'blocked':
      case 'unavailable':
        if (name === 'return' || name === 'escape' || name === 'ctrl_c') this.closeRequested = true
        break
    }
    return this.closeRequested ? 'close' : 'handled'
  }

  /**
   * bracketed paste / Ctrl+V 文本落地：只进输入态；Key 是单行令牌，
   * 剥掉全部空白字符（粘贴来源可能带换行/空格）。
   * @param text - 终端/剪贴板传来的粘贴文本。
   */
  pasteText(text: string): void {
    if (!this.openFlag || this.phase !== 'input') return
    this.value += text.replace(/\s+/g, '')
    this.error = null
  }

  showNotice(text: string): void {
    if (!this.openFlag) return
    this.notice = text
    this.onChange?.()
  }

  /**
   * 装配方查询：用户已请求关闭（Esc/Ctrl+C/终态 Enter）——deactivate overlay。
   * @returns 请求关闭返回 true。
   */
  wantsClose(): boolean {
    return this.closeRequested
  }

  /** OverlayRenderer 契约：失活时关旗标，迟到的探测/落盘结果不再改状态。 */
  onDeactivate(): void {
    this.openFlag = false
  }

  /** 提交：探测三分类——invalid 回输入态带错误，unknown 进确认态，ok 直接落盘。 */
  private submit(): void {
    const key = this.value
    this.phase = 'probing'
    this.error = null
    void Promise.resolve()
      .then(() => (this.probeOverride ?? this.target.probe)(key))
      .then((result) => {
        if (!this.openFlag || this.phase !== 'probing') return
        if (result === 'invalid') {
          this.phase = 'input'
          this.error = 'Key 无效（401/403），请检查后重试'
          this.onChange?.()
          return
        }
        if (result === 'unknown') {
          this.phase = 'confirm-unknown'
          this.onChange?.()
          return
        }
        void this.persist(key)
      }, () => {
        // 注入的 probe 抛错按 unknown 折叠（真实实现已内部分类，此为测试桩兜底）
        if (!this.openFlag || this.phase !== 'probing') return
        this.phase = 'confirm-unknown'
        this.onChange?.()
      })
  }

  /** 落盘：set 成功进成功态并回调 onSaved（即使用户中途 Esc 关闭，写已提交也要刷新就绪标志）；失败回输入态带 message。 */
  private async persist(key: string): Promise<void> {
    const credentials = this.credentials
    if (credentials === undefined) return
    this.phase = 'saving'
    this.onChange?.()
    try {
      await credentials.set(this.target.ref, key)
      await this.target.afterSave?.()
    } catch (err) {
      if (!this.openFlag) return
      this.phase = 'input'
      this.error = err instanceof Error ? err.message : String(err)
      this.onChange?.()
      return
    }
    this.onSaved?.()
    if (!this.openFlag) return
    this.phase = 'saved'
    this.onChange?.()
  }

  /**
   * OverlayRenderer 契约：render(width, height) → string[]。内容短而静态，
   * 高度不参与（对齐 keymap 静态面板）；每行 ANSI 安全截断到 width。
   * @param width - 可用显示宽度。
   * @param _height - 可用行数（本对话框不使用）。
   * @returns 渲染行数组（含 ANSI）。
   */
  render(width: number, _height: number): string[] {
    const theme = this.getTheme()
    const lines: string[] = [color(`设置 ${this.target.displayName} API Key`, theme.brandColor, { bold: true })]
    switch (this.phase) {
      case 'blocked':
        lines.push('')
        lines.push(color(`进程环境已提供 ${this.target.ref}，文件写入不会生效（环境变量优先）。`, theme.warning))
        lines.push(color('请 unset 后重试，或改用环境变量管理。', theme.muted))
        lines.push('')
        lines.push(color('Enter / Esc 关闭', theme.muted))
        break
      case 'unavailable':
        lines.push('')
        lines.push(color(`当前部署无凭据存储，请设置环境变量 ${this.target.ref}。`, theme.warning))
        lines.push('')
        lines.push(color('Enter / Esc 关闭', theme.muted))
        break
      case 'saved':
        lines.push('')
        lines.push(color('✓ 已保存并生效，无需重启。', theme.success))
        lines.push('')
        lines.push(color('Enter / Esc 关闭', theme.muted))
        break
        // input / probing / saving / confirm-unknown：说明 + 掩码输入行 + 状态/错误行 + 键位提示
      default: {
        lines.push(color(`用于 ${this.target.displayName} API 请求认证。`, theme.muted))
        lines.push(color('保存到 $DSH_HOME/.credentials.yaml（0600）；进程环境同名变量优先。', theme.muted))
        lines.push('')
        lines.push(color(`Key: ${maskKeyInput(this.value)}`, theme.primary))
        if (this.phase === 'probing') lines.push(color('正在验证 Key…', theme.muted))
        if (this.phase === 'saving') lines.push(color('正在保存…', theme.muted))
        if (this.phase === 'confirm-unknown') lines.push(color('⚠ 无法验证 Key（网络错误或超时）。', theme.warning))
        if (this.error !== null) lines.push(color(`✗ ${this.error}`, theme.error))
        lines.push('')
        lines.push(color(this.phase === 'confirm-unknown' ? 'Enter 仍要保存 · Esc 取消' : 'Enter 提交 · Esc 取消', theme.muted))
        break
      }
    }
    if (this.notice !== null) lines.push(color(`⚠ ${this.notice}`, theme.warning))
    return lines.map(line => truncateToDisplayWidth(line, width))
  }
}
