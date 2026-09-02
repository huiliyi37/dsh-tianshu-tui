#!/usr/bin/env node
/**
 * 欢迎页标题艺术字生成管线（scripts/generate-welcome-title.mjs）。
 *
 * figlet（devDependency，仅生成期使用）→ src/format/welcome-title-frames.ts：
 * - STAR_TITLE_ART：star 欢迎页（紫鲸），Standard 宽档 / Mini 窄档，
 *   文本 DeepSeek» 主标 + < Harness > 副标（figlet 艺术字）。
 * - BLUE_TITLE_ART：blue 欢迎页（蓝鲸，默认风格），ANSI Shadow 宽档 /
 *   Standard 中档 / Mini 窄档（宽/中档副标为纯文本行：大标题 + 小字副标
 *   的参考观感；字号诉求经实机验证以可辨认为准——同族 ANSI Compact 的
 *   e/k 字形不可辨认，已弃用）。
 * 逐行去尾空格；运行时按右栏宽度选档（伸缩门禁在 format/welcome.ts），
 * 本文件只产静态艺术行。
 *
 * 用法：node scripts/generate-welcome-title.mjs
 */
import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import figlet from 'figlet'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = resolve(ROOT, 'src/format/welcome-title-frames.ts')

/** 各风格标题配置：texts + 档位（宽→窄，运行时取首个放得下的档）。
 * plainSubtitleTiers 列出的档副标不走 figlet（纯文本单行：大标题 + 小字
 * 副标的参考观感，且 ANSI 系全艺术字副标过宽）。 */
const ARTS = [
  {
    exportName: 'STAR_TITLE_ART',
    title: 'DeepSeek»',
    subtitle: '< Harness >',
    tiers: [
      ['standard', 'Standard'],
      ['mini', 'Mini'],
    ],
  },
  {
    exportName: 'BLUE_TITLE_ART',
    title: 'DeepSeek',
    subtitle: '< Harness >',
    tiers: [
      ['wide', 'ANSI Shadow'],
      ['mid', 'Standard'],
      ['mini', 'Mini'],
    ],
    plainSubtitleTiers: ['wide', 'mid'],
  },
]

/** figlet 渲染 → 去尾空格行数组（去纯空尾行，保留行首结构）。 */
function render(text, font) {
  const lines = figlet.textSync(text, { font }).split('\n').map((l) => l.replace(/\s+$/u, ''))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  while (lines.length > 0 && lines[0] === '') lines.shift()
  return lines
}

const arts = []
for (const art of ARTS) {
  const variants = []
  const plainTiers = art.plainSubtitleTiers ?? []
  for (const [key, font] of art.tiers) {
    const title = render(art.title, font)
    const subtitle = plainTiers.includes(key) ? [art.subtitle] : render(art.subtitle, font)
    const width = Math.max(...title.map((l) => l.length), ...subtitle.map((l) => l.length))
    variants.push({ key, font, title, subtitle, width })
    console.log(`${art.exportName} ${key} (${font}): ${width} 列，主标 ${title.length} 行 / 副标 ${subtitle.length} 行`)
  }
  arts.push({ ...art, variants })
}

const emit = (lines) => `[\n${lines.map((l) => `    '${l.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}',`).join('\n')}\n  ]`

const source = `/**
 * 生成物：scripts/generate-welcome-title.mjs 产出，勿手改。
 *
 * 欢迎页标题艺术字（figlet，生成期固化，运行时零依赖）：
 * - STAR_TITLE_ART：star 风格，standard = Standard 字体宽档，mini = Mini 窄档。
 * - BLUE_TITLE_ART：blue 风格（默认），wide = ANSI Shadow 宽档、mid =
 *   Standard 中档（宽/中档副标纯文本），mini = Mini 窄档。
 * welcome.ts 按右栏宽度选档（放不下窄档则整体回落 retro）。换字体/文本改
 * ARTS 后重跑本脚本。
 */

/** 一档标题艺术字。 */
export interface StarTitleArtVariant {
  /** 主标艺术行。 */
  readonly title: readonly string[]
  /** 副标艺术行。 */
  readonly subtitle: readonly string[]
  /** 档宽（主/副标最长行，列）。 */
  readonly width: number
}

${arts.map((a) => `/** ${a.exportName === 'STAR_TITLE_ART' ? 'star 风格标题艺术字（standard 宽档 / mini 窄档）。' : 'blue 风格标题艺术字（wide = ANSI Shadow / mid = Standard / mini = Mini，宽→窄）。'} */
export const ${a.exportName}: { readonly ${a.variants.map((v) => `${v.key}: StarTitleArtVariant`).join('; readonly ')} } = {
${a.variants.map((v) => `  ${v.key}: {\n    title: ${emit(v.title)},\n    subtitle: ${emit(v.subtitle)},\n    width: ${v.width},\n  },`).join('\n')}
}`).join('\n\n')}
`

await writeFile(OUTPUT, source)
console.log(`已生成 ${OUTPUT}`)
