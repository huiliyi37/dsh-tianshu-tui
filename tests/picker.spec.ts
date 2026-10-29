/**
 * picker.spec.ts — 交互式选择器纯函数 + 控制器（Issue #31）。
 *
 * 覆盖：状态机（open 重置 / move 夹紧）、渲染（标题/选中 ▶/当前 ●/空态/
 * 窄宽截断）、控制器（open/move/commit 回调/close）。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  applyPickerEvent,
  emptyPickerState,
  firstSelectableIndex,
  nextSelectableIndex,
  PickerController,
  renderPicker,
  type PickerItem,
} from '../src/picker.js'
import type { RivetTheme } from '../src/theme.js'
import { buildProviderItems } from '../src/ui/key-wizard.js'

function fakeTheme(): RivetTheme {
  return {
    primary: '#111111', secondary: '#222222', success: '#333333',
    warning: '#444444', error: '#555555', dim: '#666666', muted: '#777777',
    pulseQuiet: '#888888', pulseActive: '#999999', pulseAlert: '#aaaaaa',
    userColor: '#bbbbbb', assistantColor: '#cccccc', systemColor: '#dddddd',
    brandColor: '#eeeeee', toolColor: () => '#000000', contextColor: () => '#000000',
  }
}

function plain(lines: readonly string[]): string[] {
  return lines.map(l => l.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, ''))
}

const items: PickerItem[] = [
  { label: 'graphite', value: 'graphite', current: true },
  { label: 'paper', value: 'paper' },
  { label: 'ocean', value: 'ocean' },
]

describe('applyPickerEvent', () => {
  it('open 重置选中与标题', () => {
    const s = applyPickerEvent({ ...emptyPickerState(), selected: 2 }, { type: 'open', title: '选择主题' })
    expect(s).toEqual({ open: true, selected: 0, title: '选择主题' })
  })

  it('close 关闭但保留选中', () => {
    const s = applyPickerEvent({ open: true, selected: 1, title: 't' }, { type: 'close' })
    expect(s.open).toBe(false)
    expect(s.selected).toBe(1)
  })

  it('move 在 [0, count-1] 内夹紧', () => {
    const base = { open: true, selected: 0, title: 't' }
    expect(applyPickerEvent(base, { type: 'move', delta: -1, count: 3 }).selected).toBe(0)
    expect(applyPickerEvent(base, { type: 'move', delta: 1, count: 3 }).selected).toBe(1)
    expect(applyPickerEvent({ ...base, selected: 2 }, { type: 'move', delta: 1, count: 3 }).selected).toBe(2)
    expect(applyPickerEvent(base, { type: 'move', delta: 5, count: 0 }).selected).toBe(0)
  })
})

describe('renderPicker', () => {
  it('标题 + 选中 ▶ 高亮 + 当前 ● 标记 + 键位提示', () => {
    const state = { open: true, selected: 0, title: '选择主题' }
    const rows = plain(renderPicker(state, items, 60, 10, fakeTheme()))
    expect(rows[0]).toBe('选择主题')
    expect(rows[1]).toBe('▶ graphite ●')
    expect(rows[2]).toBe('  paper')
    expect(rows[3]).toBe('  ocean')
    expect(rows[rows.length - 1]).toContain('↑↓ 选择')
  })

  it('选中项跟随移动', () => {
    const state = { open: true, selected: 2, title: 't' }
    const rows = plain(renderPicker(state, items, 60, 10, fakeTheme()))
    expect(rows[1]).toBe('  graphite ●')
    expect(rows[3]).toBe('▶ ocean')
  })

  it('只读账号 header 仍显示默认 ●', () => {
    const accountItems = buildProviderItems([{
      provider: 'deepseek-account', displayName: 'DeepSeek Account',
      settingsNs: 'llm-deepseek-account', settingsPath: [], accountAvailable: true,
    }], new Map(), 'deepseek-account')
    const rows = plain(renderPicker({ open: true, selected: 0, title: 't' }, accountItems, 80, 10, fakeTheme()))
    expect(accountItems[0]?.header).toBe(true)
    expect(rows[1]).toBe('DeepSeek Account（已登录，无需 API Key） ●')
  })

  it('空条目 → 无选项占位', () => {
    const rows = plain(renderPicker({ open: true, selected: 0, title: 't' }, [], 60, 10, fakeTheme()))
    expect(rows).toContain('（无选项）')
  })

  it('窄宽截断（条目行 ≤ width；标题/footer 为 chrome 不截断，同 command-palette）', () => {
    const long: PickerItem[] = [{ label: '这是一个非常长的模型标识符用来测试窄宽截断行为', value: 'x' }]
    for (const width of [20, 12]) {
      const rows = renderPicker({ open: true, selected: 0, title: 't' }, long, width, 10, fakeTheme())
      const entry = plain(rows)[1]
      expect(entry!.length).toBeLessThanOrEqual(width)
    }
  })
})

describe('PickerController', () => {
  it('open 注入条目与回调；commit 以选中项调用并关闭', () => {
    const c = new PickerController({ getTheme: fakeTheme })
    const onCommit = vi.fn()
    c.open('选择主题', items, onCommit, 1)
    expect(c.isOpen()).toBe(true)
    expect(c.selected?.value).toBe('paper')
    c.commit()
    expect(onCommit).toHaveBeenCalledWith(items[1])
    expect(c.isOpen()).toBe(false)
  })

  it('move 移动选中；close 后 commit 不回调', () => {
    const c = new PickerController({ getTheme: fakeTheme })
    const onCommit = vi.fn()
    c.open('t', items, onCommit)
    c.move(1)
    expect(c.selected?.value).toBe('paper')
    c.close()
    c.commit()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('无条目时 commit 不回调（selected undefined）', () => {
    const c = new PickerController({ getTheme: fakeTheme })
    const onCommit = vi.fn()
    c.open('t', [], onCommit)
    expect(c.selected).toBeUndefined()
    c.commit()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('render 委托 renderPicker（OverlayRenderer 契约）', () => {
    const c = new PickerController({ getTheme: fakeTheme })
    c.open('选择主题', items, () => {})
    const rows = plain(c.render(60, 10))
    expect(rows[0]).toBe('选择主题')
  })

  it('move 触发 onPreview（以新选中条目；实时预览钩子）', () => {
    const c = new PickerController({ getTheme: fakeTheme })
    const onPreview = vi.fn()
    c.open('选择主题', items, () => {}, undefined, { onPreview })
    c.move(1)
    expect(onPreview).toHaveBeenCalledWith(items[1])
    c.move(1)
    expect(onPreview).toHaveBeenLastCalledWith(items[2])
    expect(onPreview).toHaveBeenCalledTimes(2)
  })

  it('close 触发 onCancel（Esc/q 关闭路径；还原预览）', () => {
    const c = new PickerController({ getTheme: fakeTheme })
    const onCancel = vi.fn()
    c.open('选择主题', items, () => {}, undefined, { onCancel })
    c.close()
    expect(onCancel).toHaveBeenCalledTimes(1)
    // 幂等：再次 close 不再触发（回调已清空）
    c.close()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('commit 不触发 onCancel（确认路径，预览已落定无需还原）', () => {
    const c = new PickerController({ getTheme: fakeTheme })
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    c.open('选择主题', items, onCommit, undefined, { onCancel })
    c.move(1)
    c.commit()
    expect(onCommit).toHaveBeenCalledWith(items[1])
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('saveDefault 以选中项调用 onSaveDefault，不触发 onCommit / onCancel', () => {
    const c = new PickerController({ getTheme: fakeTheme })
    const onCommit = vi.fn()
    const onSaveDefault = vi.fn()
    const onCancel = vi.fn()
    c.open('选择主题', items, onCommit, 1, { onSaveDefault, onCancel })
    expect(c.canSaveDefault()).toBe(true)
    c.saveDefault()
    expect(onSaveDefault).toHaveBeenCalledWith(items[1])
    expect(onCommit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    expect(c.isOpen()).toBe(false)
  })

  it('未注入 onSaveDefault 时 canSaveDefault 为 false，saveDefault 不动作', () => {
    const c = new PickerController({ getTheme: fakeTheme })
    const onCommit = vi.fn()
    c.open('选择会话', items, onCommit)
    expect(c.canSaveDefault()).toBe(false)
    c.saveDefault()
    expect(onCommit).not.toHaveBeenCalled()
    expect(c.isOpen()).toBe(true)
  })
})

describe('renderPicker 启动默认标记', () => {
  it('isDefault 条目显示 ★；当前项仍是 ●', () => {
    const mixed: PickerItem[] = [
      { label: 'graphite', value: 'graphite', current: true },
      { label: 'paper', value: 'paper', isDefault: true },
    ]
    const rows = plain(renderPicker({ open: true, selected: 1, title: 't' }, mixed, 60, 10, fakeTheme()))
    expect(rows[1]).toBe('  graphite ●')
    expect(rows[2]).toBe('▶ paper ★')
  })

  it('saveDefault 开启时底栏为 Enter 应用（本会话）· S 设为默认', () => {
    const rows = plain(renderPicker(
      { open: true, selected: 0, title: 't' },
      items,
      80,
      10,
      fakeTheme(),
      { saveDefault: true },
    ))
    const footer = rows[rows.length - 1]!
    expect(footer).toContain('Enter 应用（本会话）')
    expect(footer).toContain('S 设为默认')
    expect(footer).not.toContain('Enter 确认')
  })

  it('未开 saveDefault 时底栏保持 Enter 确认（会话选择器）', () => {
    const rows = plain(renderPicker({ open: true, selected: 0, title: 't' }, items, 80, 10, fakeTheme()))
    expect(rows[rows.length - 1]).toContain('Enter 确认')
    expect(rows[rows.length - 1]).not.toContain('S 设为默认')
  })

  it('控制器注入 onSaveDefault 后面栏切换；render 委托带 saveDefault', () => {
    const c = new PickerController({ getTheme: fakeTheme })
    c.open('选择主题', items, () => {}, undefined, { onSaveDefault: () => {} })
    const footer = plain(c.render(80, 10)).at(-1)
    expect(footer).toContain('S 设为默认')
  })
})

const grouped: PickerItem[] = [
  { label: '今天 · 1', value: 'header:today', header: true },
  { label: '#s-now · 新对话 · 刚刚', value: 's-now' },
  { label: '更早 · 1', value: 'header:earlier', header: true },
  { label: '#s-old · 旧会话 · 2023-10-01', value: 's-old', current: true },
]

describe('picker 分组头', () => {
  it('firstSelectableIndex 跳过开头的头', () => {
    expect(firstSelectableIndex(grouped, 0)).toBe(1)
    expect(firstSelectableIndex(grouped, 2)).toBe(3)
    expect(firstSelectableIndex(grouped, 3)).toBe(3)
  })

  it('nextSelectableIndex 按可选项跳，不落在头上', () => {
    expect(nextSelectableIndex(grouped, 1, 1)).toBe(3)
    expect(nextSelectableIndex(grouped, 3, -1)).toBe(1)
    expect(nextSelectableIndex(grouped, 1, -1)).toBe(1)
    expect(nextSelectableIndex(grouped, 3, 1)).toBe(3)
  })

  it('render：分组头无 ▶/●，选中项仍是会话行', () => {
    const rows = plain(renderPicker({ open: true, selected: 1, title: '选择会话' }, grouped, 60, 12, fakeTheme()))
    expect(rows[1]).toBe('今天 · 1')
    expect(rows[2]).toBe('▶ #s-now · 新对话 · 刚刚')
    expect(rows[3]).toBe('更早 · 1')
    expect(rows[4]).toBe('  #s-old · 旧会话 · 2023-10-01 ●')
  })

  it('open 选中若落在头上则吸附到下一项；commit 不提交头', () => {
    const c = new PickerController({ getTheme: fakeTheme })
    const onCommit = vi.fn()
    c.open('选择会话', grouped, onCommit, 0)
    expect(c.selected?.header).not.toBe(true)
    expect(c.selected?.value).toBe('s-now')
    c.commit()
    expect(onCommit).toHaveBeenCalledWith(grouped[1])
  })

  it('move 跨越分组头', () => {
    const c = new PickerController({ getTheme: fakeTheme })
    c.open('选择会话', grouped, () => {}, 1)
    c.move(1)
    expect(c.selected?.value).toBe('s-old')
    c.move(-1)
    expect(c.selected?.value).toBe('s-now')
  })
})
