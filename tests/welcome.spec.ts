/**
 * 启动欢迎面（format/welcome.ts）— 纯渲染契约测试。
 *
 * - 品牌区 formatBrandWelcome：主标/副标；缺省居中，align=left 贴左
 * - Tips formatWelcomeTips：标题 + 快捷键列对齐；不可用项 muted
 * - 环境行 formatEnvCheckLine：单行主题名/API/Git；缺 key 段 warning 色
 * - Hero formatWelcomeHero：宽屏左品牌右 tips zip，窄屏垂直居中叠放
 * - 宽度守恒：任何输入下每行显示宽度 ≤ width
 */

import { describe, expect, it } from 'vitest'
import type { RivetTheme } from '../src/theme.js'
import { displayWidth } from '../src/width.js'
import {
  WELCOME_HERO_WIDE_MIN,
  CHROME_GUTTER,
  formatBrandWelcome,
  formatEnvCheckLine,
  formatWelcomeHero,
  formatWelcomeTips,
  type WelcomeEnvCheck,
  type WelcomeTipItem,
} from '../src/format/welcome.js'

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

function tips(over: Partial<WelcomeTipItem>[] = []): WelcomeTipItem[] {
  const base: WelcomeTipItem[] = [
    { keyHint: 'ctrl+n', label: '新会话' },
    { keyHint: 'ctrl+s', label: '恢复会话' },
    { keyHint: 'ctrl+p', label: '命令面板' },
  ]
  return over.length === 0 ? base : over.map((o, i) => ({ ...base[i]!, ...o }))
}

describe('formatBrandWelcome（欢迎页品牌区）', () => {
  it('version 提供时副标题行追加 · v<version>', () => {
    const lines = formatBrandWelcome({ width: 80, version: '0.1.2-rc.9' }, fakeTheme())
    const [brand, sub] = plain(lines)
    expect(brand!.trim()).toBe('dsh-tianshu-tui')
    expect(sub!.trim()).toBe('DeepSeek Harness · v0.1.2-rc.9')
  })

  it('两行：主标 dsh-tianshu-tui 居中 BOLD + 副标居中 muted，宽度守恒', () => {
    const lines = formatBrandWelcome({ width: 80 }, fakeTheme())
    expect(lines.length).toBe(2)
    const [brand, sub] = plain(lines)
    expect(brand!.trim()).toBe('dsh-tianshu-tui')
    expect(brand!.indexOf('dsh-tianshu-tui')).toBeGreaterThan(0) // 居中（前导空格）
    expect(sub!.trim()).toBe('DeepSeek Harness')
    expect(lines[0]).toContain('\x1B[1m') // 主标 BOLD
    expect(displayWidth(lines[0]!)).toBeLessThanOrEqual(80)
    expect(displayWidth(lines[1]!)).toBeLessThanOrEqual(80)
  })

  it('align=left：主标贴左，无前导空格', () => {
    const [brand] = plain(formatBrandWelcome({ width: 80, align: 'left' }, fakeTheme()))
    expect(brand!.startsWith('dsh-tianshu-tui')).toBe(true)
  })

  it('自定义 brand/subtitle 生效', () => {
    const lines = formatBrandWelcome({ width: 40, brand: 'X', subtitle: 'Hello' }, fakeTheme())
    const [brand, sub] = plain(lines)
    expect(brand!.trim()).toBe('X')
    expect(sub!.trim()).toBe('Hello')
  })

  it('窄宽：主标/副标截断，宽度守恒', () => {
    const lines = formatBrandWelcome({ width: 6, subtitle: 'Very Long Subtitle' }, fakeTheme())
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(6)
    }
    expect(plain(lines)[1]).toBe('Very L') // 副标截断到 6 列
  })

  it('width ≤ 0 → 空数组', () => {
    expect(formatBrandWelcome({ width: 0 }, fakeTheme())).toEqual([])
  })
})

describe('formatWelcomeTips（欢迎页右栏 tips）', () => {
  it('标题 Tips + 快捷键列对齐、说明在右', () => {
    const lines = plain(formatWelcomeTips({ width: 40, items: tips() }, fakeTheme()))
    expect(lines[0]!.trim()).toBe('Tips')
    expect(lines[1]).toContain('ctrl+n')
    expect(lines[1]).toContain('新会话')
    expect(lines[2]).toContain('ctrl+s')
    expect(lines[3]).toContain('ctrl+p')
  })

  it('available=false：整行 muted，keyHint 仍在', () => {
    const items: WelcomeTipItem[] = [
      { keyHint: 'ctrl+s', label: '恢复会话', available: false },
    ]
    const raw = formatWelcomeTips({ width: 40, items }, fakeTheme())
    const row = plain(raw)[1]
    expect(row).toContain('恢复会话')
    expect(row).toContain('ctrl+s')
    expect(raw[1]).toContain('\x1B[38;2;119;119;119m') // muted #777777
  })

  it('align=center：整块前导空格 > 0', () => {
    const lines = plain(formatWelcomeTips({ width: 80, items: tips(), align: 'center' }, fakeTheme()))
    expect(lines[0]!.indexOf('Tips')).toBeGreaterThan(0)
  })

  it('宽度守恒：任意宽度下每行显示宽度 ≤ width', () => {
    for (const width of [80, 40, 20, 8]) {
      const lines = formatWelcomeTips({ width, items: tips() }, fakeTheme())
      for (const line of lines) {
        expect(displayWidth(line)).toBeLessThanOrEqual(width)
      }
    }
  })

  it('width ≤ 0 → 空数组', () => {
    expect(formatWelcomeTips({ width: 0, items: tips() }, fakeTheme())).toEqual([])
  })
})

describe('formatEnvCheckLine（环境检查紧凑行）', () => {
  function env(over: Partial<WelcomeEnvCheck> = {}): WelcomeEnvCheck {
    return { hasApiKey: true, isGitRepo: true, themeName: 'graphite', cols: 100, ...over }
  }

  it('单行：主题名 · API Key ✓ · Git ✓，居中且宽度守恒', () => {
    const [line] = formatEnvCheckLine(env(), fakeTheme())
    const text = plain([line!])[0]
    expect(text!.trim()).toBe('graphite · API Key ✓ · Git ✓')
    expect(text!.indexOf('graphite')).toBeGreaterThan(0) // 居中（前导空格）
    expect(displayWidth(line!)).toBeLessThanOrEqual(100)
  })

  it('align=left：贴左', () => {
    const [line] = plain(formatEnvCheckLine(env({ align: 'left' }), fakeTheme()))
    expect(line!.startsWith('graphite')).toBe(true)
  })

  it('缺 API key：✗ + 可行动提示，该段 warning 色', () => {
    const [line] = formatEnvCheckLine(env({ hasApiKey: false }), fakeTheme())
    expect(plain([line!])[0]).toContain('API Key ✗（设 DEEPSEEK_API_KEY）')
    expect(line).toContain('\x1B[38;2;68;68;68m')
  })

  it('非 git → Git ✗ 信息性展示，无 warning 色', () => {
    const [line] = formatEnvCheckLine(env({ isGitRepo: false }), fakeTheme())
    expect(plain([line!])[0]).toContain('Git ✗')
    expect(line).not.toContain('\x1B[38;2;68;68;68m')
  })

  it('窄宽截断：宽度守恒（ANSI 安全）', () => {
    for (const cols of [24, 12, 5]) {
      const [line] = formatEnvCheckLine(env({ cols }), fakeTheme())
      expect(displayWidth(line!)).toBeLessThanOrEqual(cols)
    }
  })

  it('cols ≤ 0 → 空数组', () => {
    expect(formatEnvCheckLine(env({ cols: 0 }), fakeTheme())).toEqual([])
  })
})

describe('formatWelcomeHero（左品牌 + 右 tips）', () => {
  const env: WelcomeEnvCheck = {
    hasApiKey: true, isGitRepo: true, themeName: 'graphite', cols: 100,
  }
  const whale = [
    '        ████▄▄██',
    '     ▄██████████',
  ]

  it('宽屏：Tips 与鲸鱼同行（zip），品牌在左栏', () => {
    const lines = plain(formatWelcomeHero({
      width: 100, whale, env, tips: tips(),
    }, fakeTheme()))
    expect(lines.some(l => l.includes('Tips'))).toBe(true)
    expect(lines.some(l => l.includes('dsh-tianshu-tui'))).toBe(true)
    expect(lines.some(l => l.includes('ctrl+n'))).toBe(true)
    // zip：含块字符的行同时含 Tips 或后续 tips 行在右
    const first = lines[0]!
    expect(first).toMatch(/█/)
    expect(first.indexOf('Tips')).toBeGreaterThan(first.indexOf('█'))
    expect(first.indexOf('█')).toBe(CHROME_GUTTER)
  })

  it(`窄于 ${WELCOME_HERO_WIDE_MIN}：垂直叠放，Tips 在品牌下方`, () => {
    const lines = plain(formatWelcomeHero({
      width: 60, whale, env, tips: tips(),
    }, fakeTheme()))
    const dsh = lines.findIndex(l => l.includes('dsh-tianshu-tui'))
    const tipsIdx = lines.findIndex(l => l.trim() === 'Tips' || l.includes('Tips'))
    expect(dsh).toBeGreaterThanOrEqual(0)
    expect(tipsIdx).toBeGreaterThan(dsh)
    // 窄屏不 zip：鲸鱼行不含 Tips
    expect(lines[0]!).not.toContain('Tips')
  })

  it('retro 鲸鱼行全剥前导空格（RELEASE 形态锁定：indent + 画内空格一并剥）', () => {
    // 48 列居中缩进 + 2 列画内空格：retro 历史行为是全剥（块字符落到画首），
    // star 才按 stripIndent 只剥缩进——两路径分离，互不受波。
    const whaleWithIndent = [
      `${' '.repeat(50)}  ██`,
      `${' '.repeat(50)}▄████`,
    ]
    const lines = plain(formatWelcomeHero({
      width: 100, whale: whaleWithIndent, env, tips: tips(),
    }, fakeTheme()))
    const first = lines.find(l => /[█▄]/.test(l))!
    expect(first.indexOf('█')).toBeLessThanOrEqual(CHROME_GUTTER + 1)
  })

  it('宽度守恒', () => {
    for (const width of [100, 80, 72, 40, 20]) {
      const lines = formatWelcomeHero({ width, whale, env, tips: tips() }, fakeTheme())
      for (const line of lines) {
        expect(displayWidth(line)).toBeLessThanOrEqual(width)
      }
    }
  })

  it('无鲸鱼时宽屏仍出品牌 + tips', () => {
    const lines = plain(formatWelcomeHero({
      width: 100, whale: [], env, tips: tips(),
    }, fakeTheme()))
    expect(lines.some(l => l.includes('dsh-tianshu-tui'))).toBe(true)
    expect(lines.some(l => l.includes('Tips'))).toBe(true)
    const dsh = lines.find(l => l.includes('dsh-tianshu-tui'))!
    expect(dsh.indexOf('dsh-tianshu-tui')).toBe(CHROME_GUTTER)
  })

  it('width ≤ 0 → 空数组', () => {
    expect(formatWelcomeHero({ width: 0, whale, env, tips: tips() }, fakeTheme())).toEqual([])
  })
})
