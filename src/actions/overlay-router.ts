/**
 * actions/overlay-router — overlay 键路由委派（scroll-pager 范式收敛）。
 *
 * 原 TuiApp.handleKey 里六段 overlay 分支的表驱动化：各 overlay 自持
 * handleKey（统一返回词表 'close'|'handled'，Esc/Ctrl+C 关闭判定在类内），
 * 本路由器只做「activeId → 键目标」委派与结果收尾（close → deactivate、
 * handled → rerender）。委派顺序对齐原 if 链：key-dialog/provider-editor
 * （Ctrl+V 粘贴拦截在先）→ picker → search → scroll → rewind → memory → palette（以 isOpen
 * 判定；commit 分流 execute 直接执行 / backfill 回填输入行）。
 *
 * 键目标缺席（控制器未装配）时不吞键、落后续路由——对齐原分支条件
 * `activeId === x && controller !== null` 为 false 的穿透语义。keymap 等
 * 静态面板不在表内（键位本就穿透给后续路由——现状语义）。
 *
 * @module @deepseek-ai/dsh-tianshu-tui/actions/overlay-router
 */

import type { KeyPress } from '../engine/input-handler.js'
import type { OverlayController } from '../engine/overlay-controller.js'
import type { OverlayId, OverlayKeyResult } from '../engine/overlay-engine.js'
import type { CommandPalette } from '../command-palette.js'
import type { PickerController } from '../picker.js'
import type { KeyDialogController } from '../ui/key-dialog.js'
import type { ProviderEditorController } from '../ui/provider-editor.js'
import type { HistorySearchOverlay } from '../format/history-search-overlay.js'
import type { ScrollPagerOverlay } from '../format/scroll-pager-overlay.js'
import type { RewindOverlay } from '../format/rewind-overlay.js'
import type { MemoryBrowserOverlay } from '../format/memory-overlay.js'

/** 键目标最小面（各 overlay 控制器结构满足）。 */
export interface OverlayKeyTarget {
  handleKey(name: string, char: string): OverlayKeyResult
}

/** OverlayKeyRouter 的依赖注入（getter 现取——控制器在 attach 时才装配）。 */
export interface OverlayKeyRouterDeps {
  overlay(): OverlayController | null
  keyDialog(): KeyDialogController | null
  providerEditor(): ProviderEditorController | null
  picker(): PickerController | null
  search(): HistorySearchOverlay | null
  scroll(): ScrollPagerOverlay | null
  rewind(): RewindOverlay | null
  memory(): MemoryBrowserOverlay | null
  palette(): CommandPalette | null
  /** 文本 overlay Ctrl+V：读剪贴板文本进当前字段（异步；内部 rerender）。 */
  pasteKeyDialog(dialog: KeyDialogController): void
  pasteProviderEditor(editor: ProviderEditorController): void
  /** palette commit execute 模式分流：直接执行 `/name`（TuiApp.handleSubmit）。 */
  submit(text: string): void
  /** palette commit backfill 模式分流：回填 `/name ` 到输入行。 */
  backfill(text: string): void
}

/**
 * overlay 键路由器：route(key) 返回 true = 键已被 overlay 消费。
 * 表驱动委派 + 结果收尾；行为逐分支对齐原 handleKey overlay 段。
 */
export class OverlayKeyRouter {
  private readonly deps: OverlayKeyRouterDeps
  /** 委派表（顺序即优先级；key-dialog 有 Ctrl+V 前置拦截，单独分支）。 */
  private readonly routes: ReadonlyArray<readonly [OverlayId, () => OverlayKeyTarget | null]>

  constructor(deps: OverlayKeyRouterDeps) {
    this.deps = deps
    this.routes = [
      ['picker', () => deps.picker()],
      ['search', () => deps.search()],
      ['scroll', () => deps.scroll()],
      ['rewind', () => deps.rewind()],
      ['memory', () => deps.memory()],
    ]
  }

  /**
   * 键路由委派：activeId 命中且控制器在装 → 消费；palette 以 isOpen 兜底判定。
   * @param key - 按键事件。
   * @returns true = 已消费（终止 handleKey 后续路由）。
   */
  route(key: KeyPress): boolean {
    const overlay = this.deps.overlay()
    if (overlay !== null) {
      const active = overlay.activeId()
      // /key：Ctrl+V 读剪贴板文本进 Key 字段；其余键交给对话框状态机。
      if (active === 'key-dialog') {
        const dialog = this.deps.keyDialog()
        if (dialog !== null) {
          if (key.name === 'ctrl_v') this.deps.pasteKeyDialog(dialog)
          else this.closeOrRerender(overlay, dialog.handleKey(key.name, key.char))
          return true
        }
      }
      if (active === 'provider-editor') {
        const editor = this.deps.providerEditor()
        if (editor !== null) {
          if (key.name === 'ctrl_v') this.deps.pasteProviderEditor(editor)
          else this.closeOrRerender(overlay, editor.handleKey(key.name, key.char))
          return true
        }
      }
      for (const [id, get] of this.routes) {
        if (active !== id) continue
        const target = get()
        // 控制器缺席（未装配）：不吞键，落后续路由（对齐原分支条件 false 语义）。
        if (target === null) break
        this.closeOrRerender(overlay, target.handleKey(key.name, key.char))
        return true
      }
    }
    // 命令面板：真机 A6——Esc/Ctrl+C 关闭不提交、不回填输入行；Enter commit
    // 分流 execute 模式（Tab 命令菜单，#31）直接执行 / backfill（Ctrl+P）回填。
    // type/move 后 rerender——overlay 无自动 ticker，不重绘则过滤/选中不刷新。
    const palette = this.deps.palette()
    if (palette?.isOpen() === true) {
      if (palette.handleKey(key.name, key.char) === 'close') {
        this.deps.overlay()?.deactivate()
        const committed = palette.takeCommit()
        if (committed !== null) {
          if (committed.execute) this.deps.submit(committed.text)
          else this.deps.backfill(committed.text)
        }
      } else {
        this.deps.overlay()?.rerender()
      }
      return true
    }
    return false
  }

  /** overlay 键结果收尾：'close' → deactivate；'handled' → rerender。 */
  private closeOrRerender(overlay: OverlayController, result: OverlayKeyResult): void {
    if (result === 'close') overlay.deactivate()
    else overlay.rerender()
  }
}
