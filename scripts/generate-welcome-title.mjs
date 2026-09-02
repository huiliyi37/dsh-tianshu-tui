#!/usr/bin/env node
/**
 * star 欢迎页标题艺术字生成管线（scripts/generate-welcome-title.mjs）。
 *
 * figlet（devDependency，仅生成期使用）→ src/format/welcome-title-frames.ts：
 * 两档字体（Standard 宽档 / Mini 窄档）× 两条文本（DeepSeek» 主标 /
 * < Harness > 副标），逐行去尾空格；运行时按右栏宽度选档（伸缩门禁在
 * format/welcome.ts），本文件只产静态艺术行。
 *
 * 用法：node scripts/generate-welcome-title.mjs
 */
import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import figlet from 'figlet'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = resolve(ROOT, 'src/format/welcome-title-frames.ts')

const TITLE = 'DeepSeek»'
const SUBTITLE = '< Harness >'
const FONTS = [
  ['standard', 'Standard'],
  ['mini', 'Mini'],
]

/** figlet 渲染 → 去尾空格行数组（去纯空尾行，保留行首结构）。 */
function render(text, font) {
  const lines = figlet.textSync(text, { font }).split('\n').map((l) => l.replace(/\s+$/u, ''))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  while (lines.length > 0 && lines[0] === '') lines.shift()
  return lines
}

const variants = []
for (const [key, font] of FONTS) {
  const title = render(TITLE, font)
  const subtitle = render(SUBTITLE, font)
  const width = Math.max(...title.map((l) => l.length), ...subtitle.map((l) => l.length))
  variants.push({ key, font, title, subtitle, width })
  console.log(`${key} (${font}): ${width} 列，主标 ${title.length} 行 / 副标 ${subtitle.length} 行`)
}

const emit = (lines) => `[\n${lines.map((l) => `    '${l.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}',`).join('\n')}\n  ]`

const source = `/**
 * 生成物：scripts/generate-welcome-title.mjs 产出，勿手改。
 *
 * star 欢迎页标题艺术字（figlet，生成期固化，运行时零依赖）：
 * standard = Standard 字体宽档，mini = Mini 字体窄档；welcome.ts 按右栏
 * 宽度选档（放不下 mini 档则整体回落 retro）。换字体改 FONTS 后重跑本脚本。
 */

/** 一档标题艺术字。 */
export interface StarTitleArtVariant {
  /** 主标艺术行（DeepSeek»）。 */
  readonly title: readonly string[]
  /** 副标艺术行（< Harness >）。 */
  readonly subtitle: readonly string[]
  /** 档宽（主/副标最长行，列）。 */
  readonly width: number
}

/** 两档标题艺术字（standard 宽档 / mini 窄档）。 */
export const STAR_TITLE_ART: { readonly standard: StarTitleArtVariant; readonly mini: StarTitleArtVariant } = {
${variants.map((v) => `  ${v.key}: {\n    title: ${emit(v.title)},\n    subtitle: ${emit(v.subtitle)},\n    width: ${v.width},\n  },`).join('\n')}
}
`

await writeFile(OUTPUT, source)
console.log(`已生成 ${OUTPUT}`)
